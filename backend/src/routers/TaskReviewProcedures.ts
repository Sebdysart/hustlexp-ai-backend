import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { invalidateTask } from '../cache/db-cache.js';
import { db } from '../db.js';
import { notifyProofRejected, notifyTaskCompleted } from '../lib/task-lifecycle-notifications.js';
import { ProofService } from '../services/ProofService.js';
import { TaskService } from '../services/TaskService.js';
import { posterProcedure, Schemas, type AuthedContext } from '../trpc.js';
import { ErrorCodes } from '../types.js';

const reviewProofInput = z.object({
  proofId: z.string().uuid().optional(),
  decision: z.enum(['ACCEPTED', 'REJECTED']).optional(),
  reason: z.string().trim().max(1000).optional(),
  taskId: z.string().uuid().optional(),
  approved: z.boolean().optional(),
  feedback: z.string().trim().max(1000).optional(),
});

type ReviewProofInput = z.infer<typeof reviewProofInput>;
type ReviewDecision = 'ACCEPTED' | 'REJECTED';

function reviewDecision(input: ReviewProofInput): { decision: ReviewDecision; reason?: string } {
  const decision = input.decision ?? (input.approved === true
    ? 'ACCEPTED'
    : input.approved === false ? 'REJECTED' : undefined);
  if (!decision) throw new TRPCError({ code: 'BAD_REQUEST', message: 'decision or approved is required' });
  const reason = input.reason ?? input.feedback;
  if (decision === 'REJECTED' && !reason) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'A reason is required when rejecting proof' });
  }
  return { decision, reason };
}

async function verifyTaskReview(taskId: string, posterId: string): Promise<void> {
  const result = await TaskService.getById(taskId);
  if (!result.success) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
  if (result.data.poster_id !== posterId) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the task poster can review proof' });
  }
  if (result.data.state !== 'PROOF_SUBMITTED') {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Cannot review proof: task is in ${result.data.state} state, expected PROOF_SUBMITTED`,
    });
  }
}

async function latestSubmittedProofId(taskId: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM proofs WHERE task_id = $1 AND state = 'SUBMITTED' ORDER BY created_at DESC LIMIT 1`,
    [taskId],
  );
  if (!result.rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'No proof found for this task' });
  return result.rows[0].id;
}

async function verifyDirectProofOwner(proofId: string, posterId: string): Promise<void> {
  const result = await db.query<{ poster_id: string }>(
    'SELECT t.poster_id FROM proofs p JOIN tasks t ON t.id = p.task_id WHERE p.id = $1',
    [proofId],
  );
  if (!result.rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'Proof not found' });
  if (result.rows[0].poster_id !== posterId) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the task poster can review proof' });
  }
}

async function resolveReviewProofId(input: ReviewProofInput, posterId: string): Promise<string> {
  if (input.taskId) await verifyTaskReview(input.taskId, posterId);
  const proofId = input.proofId ?? (input.taskId ? await latestSubmittedProofId(input.taskId) : undefined);
  if (!proofId) throw new TRPCError({ code: 'BAD_REQUEST', message: 'proofId or taskId is required' });
  if (!input.taskId) await verifyDirectProofOwner(proofId, posterId);
  return proofId;
}

async function loadSubmittedProof(proofId: string) {
  const state = await db.query<{ state: string }>('SELECT state FROM proofs WHERE id = $1', [proofId]);
  if (state.rows[0]?.state !== 'SUBMITTED') {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Proof is not in SUBMITTED state' });
  }
  const proof = await ProofService.getById(proofId);
  if (!proof.success) throw new TRPCError({ code: 'NOT_FOUND', message: proof.error.message });
  return proof.data;
}

async function verifyProofTaskContext(input: ReviewProofInput, taskId: string, posterId: string): Promise<void> {
  if (input.taskId && input.proofId && taskId !== input.taskId) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Proof does not belong to the specified task' });
  }
  if (!input.taskId) await verifyTaskReview(taskId, posterId);
}

async function handleRejectedProof(
  decision: ReviewDecision,
  taskId: string,
  reason: string | undefined,
): Promise<void> {
  if (decision !== 'REJECTED') return;
  const result = await TaskService.rejectProof(taskId, reason ?? 'Proof rejected by poster');
  if (!result.success) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `Proof marked rejected but task state could not be reverted: ${result.error.message}`,
    });
  }
  const task = result.data as { worker_id?: string | null; title?: string | null };
  if (task.worker_id) await notifyProofRejected(task.worker_id, taskId, task.title ?? 'your task', reason);
}

async function reviewProof(ctx: AuthedContext, input: ReviewProofInput) {
  const { decision, reason } = reviewDecision(input);
  const proofId = await resolveReviewProofId(input, ctx.user.id);
  const proof = await loadSubmittedProof(proofId);
  await verifyProofTaskContext(input, proof.task_id, ctx.user.id);
  const reviewed = await ProofService.review({ proofId, reviewerId: ctx.user.id, decision, reason });
  if (!reviewed.success) throw new TRPCError({ code: 'BAD_REQUEST', message: reviewed.error.message });
  await handleRejectedProof(decision, proof.task_id, reason);
  await invalidateTask(proof.task_id);
  return reviewed.data;
}

function completeErrorCode(code: string): 'NOT_FOUND' | 'FORBIDDEN' | 'PRECONDITION_FAILED' | 'BAD_REQUEST' {
  if (code === ErrorCodes.NOT_FOUND) return 'NOT_FOUND';
  if (code === ErrorCodes.FORBIDDEN) return 'FORBIDDEN';
  if (code === 'HX301' || code === ErrorCodes.INV_3_VIOLATION) return 'PRECONDITION_FAILED';
  return 'BAD_REQUEST';
}

async function completeTask(ctx: AuthedContext, taskId: string) {
  const result = await TaskService.complete(taskId, ctx.user.id);
  if (!result.success) {
    throw new TRPCError({ code: completeErrorCode(result.error.code), message: result.error.message });
  }
  await invalidateTask(taskId);
  const task = result.data as { worker_id?: string | null; title?: string | null };
  if (task.worker_id) await notifyTaskCompleted(task.worker_id, taskId, task.title ?? 'your task');
  return result.data;
}

function cancelErrorCode(code: string): 'NOT_FOUND' | 'FORBIDDEN' | 'BAD_REQUEST' {
  if (code === ErrorCodes.NOT_FOUND) return 'NOT_FOUND';
  return code === ErrorCodes.FORBIDDEN ? 'FORBIDDEN' : 'BAD_REQUEST';
}

async function cancelTask(ctx: AuthedContext, taskId: string) {
  const result = await TaskService.cancel(taskId, ctx.user.id);
  if (!result.success) {
    throw new TRPCError({ code: cancelErrorCode(result.error.code), message: result.error.message });
  }
  await invalidateTask(taskId);
  return result.data;
}

export const TaskReviewProcedures = {
  reviewProof: posterProcedure
    .input(reviewProofInput)
    .mutation(async ({ ctx, input }) => reviewProof(ctx, input)),
  complete: posterProcedure
    .input(z.object({ taskId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => completeTask(ctx, input.taskId)),
  cancel: posterProcedure
    .input(z.object({ taskId: Schemas.uuid, reason: z.string().trim().max(1000).optional() }))
    .mutation(async ({ ctx, input }) => cancelTask(ctx, input.taskId)),
};
