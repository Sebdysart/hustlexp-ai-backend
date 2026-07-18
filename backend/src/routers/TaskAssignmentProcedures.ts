import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { invalidateTask } from '../cache/db-cache.js';
import { db, type QueryFn } from '../db.js';
import { notifyWorkerAssigned } from '../lib/task-lifecycle-notifications.js';
import { getTemplate } from '../services/TaskTemplateRegistry.js';
import { hustlerProcedure, posterProcedure, Schemas, type AuthedContext } from '../trpc.js';

interface AssignmentInput { taskId: string; workerId: string }
interface TaskRow {
  id: string;
  state: string;
  poster_id: string;
  trust_tier_required: number | null;
  template_slug: string | null;
  title: string;
}

const TRUST_TIER_ORDER = ['rookie', 'verified', 'trusted'];
const TRUST_TIER_NAMES: Record<number, string> = { 1: 'rookie', 2: 'verified', 3: 'trusted', 4: 'trusted' };

async function ownedOpenTask(txn: QueryFn, taskId: string, posterId: string): Promise<TaskRow> {
  const result = await txn<TaskRow>(
    'SELECT id, state, poster_id, trust_tier_required, template_slug, title FROM tasks WHERE id = $1 FOR UPDATE',
    [taskId],
  );
  const task = result.rows[0];
  if (!task || task.poster_id !== posterId) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the task poster can assign workers' });
  }
  if (task.state !== 'OPEN') {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `Task must be OPEN to assign a worker, current: ${task.state}` });
  }
  return task;
}

function verifyPosterTemplateTrust(task: TaskRow, trustTier: number | null | undefined): void {
  const template = getTemplate(task.template_slug ?? 'standard_physical');
  if (!template) return;
  const currentName = TRUST_TIER_NAMES[trustTier ?? 1] ?? 'rookie';
  const current = TRUST_TIER_ORDER.indexOf(currentName);
  const required = TRUST_TIER_ORDER.indexOf(template.requiredTrustTier ?? 'rookie');
  if (current < required) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Your trust level (${currentName}) no longer meets the requirement (${template.requiredTrustTier}) for this task type.`,
    });
  }
}

async function verifyWorkerTrust(txn: QueryFn, workerId: string, required: number | null): Promise<void> {
  if (required == null) return;
  const result = await txn<{ trust_tier: number }>('SELECT trust_tier FROM users WHERE id = $1', [workerId]);
  if (!result.rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'Worker not found' });
  if (result.rows[0].trust_tier < required) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `Task requires trust tier ${required}. Worker's tier: ${result.rows[0].trust_tier}`,
    });
  }
}

async function pendingApplicationId(txn: QueryFn, input: AssignmentInput): Promise<string> {
  const result = await txn<{ id: string; is_minor: boolean }>(
    `SELECT ta.id, u.is_minor
       FROM task_applications ta
       JOIN users u ON u.id = ta.hustler_id
      WHERE ta.task_id = $1 AND ta.hustler_id = $2 AND ta.status = 'pending'`,
    [input.taskId, input.workerId],
  );
  if (!result.rows[0]) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'No pending application found for this worker' });
  }
  if (result.rows[0].is_minor) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Hustlers must be at least 18 years old' });
  }
  return result.rows[0].id;
}

async function verifyFunded(txn: QueryFn, taskId: string): Promise<void> {
  const result = await txn<{ state: string }>(
    'SELECT state FROM escrows WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1',
    [taskId],
  );
  if (result.rows[0]?.state !== 'FUNDED') {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'This task is not funded yet. Complete payment before assigning a worker.',
    });
  }
}

async function commitAssignment(txn: QueryFn, input: AssignmentInput, applicationId: string) {
  await txn("UPDATE task_applications SET status = 'accepted', updated_at = NOW() WHERE id = $1", [applicationId]);
  await txn(
    "UPDATE task_applications SET status = 'rejected', rejection_reason = 'Another applicant was selected', updated_at = NOW() WHERE task_id = $1 AND status = 'pending' AND id != $2",
    [input.taskId, applicationId],
  );
  const result = await txn<{ id: string; state: string; worker_id: string | null }>(
    "UPDATE tasks SET state = 'ACCEPTED', worker_id = $2, accepted_at = NOW() WHERE id = $1 AND state = 'OPEN' RETURNING id, state, worker_id",
    [input.taskId, input.workerId],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Task is no longer in OPEN state — concurrent assignment detected' });
  }
  return result.rows[0];
}

async function assignWorker(ctx: AuthedContext, input: AssignmentInput) {
  if (input.workerId === ctx.user.id) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot assign yourself as worker' });
  }
  const result = await db.transaction(async (txn) => {
    const task = await ownedOpenTask(txn, input.taskId, ctx.user.id);
    verifyPosterTemplateTrust(task, ctx.user.trust_tier);
    await verifyWorkerTrust(txn, input.workerId, task.trust_tier_required);
    const applicationId = await pendingApplicationId(txn, input);
    await verifyFunded(txn, input.taskId);
    return { ...await commitAssignment(txn, input, applicationId), taskTitle: task.title };
  });
  await invalidateTask(input.taskId);
  if (result.worker_id) await notifyWorkerAssigned(result.worker_id, input.taskId, result.taskTitle);
  const { taskTitle: _taskTitle, ...assignedTask } = result;
  return assignedTask;
}

async function rejectApplicant(ctx: AuthedContext, input: AssignmentInput & { reason?: string }) {
  const task = await db.query<{ poster_id: string; state: string }>('SELECT poster_id, state FROM tasks WHERE id = $1', [input.taskId]);
  if (!task.rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
  if (task.rows[0].poster_id !== ctx.user.id) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the task poster can reject applicants' });
  }
  const invalidStates = ['IN_PROGRESS', 'PROOF_SUBMITTED', 'COMPLETED', 'CANCELLED', 'DISPUTED'];
  if (invalidStates.includes(task.rows[0].state)) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Cannot manage applicants once the task is in progress or finalised' });
  }
  const result = await db.query(
    "UPDATE task_applications SET status = 'rejected', rejection_reason = $3, updated_at = NOW() WHERE task_id = $1 AND hustler_id = $2 AND status = 'pending' RETURNING id",
    [input.taskId, input.workerId, input.reason || null],
  );
  if (!result.rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'No pending application found for this worker' });
  await invalidateTask(input.taskId);
  return { success: true };
}

async function withdrawApplication(ctx: AuthedContext, taskId: string) {
  const result = await db.query(
    "UPDATE task_applications SET status = 'withdrawn', updated_at = NOW() WHERE task_id = $1 AND hustler_id = $2 AND status IN ('pending', 'countered') RETURNING id",
    [taskId, ctx.user.id],
  );
  if (!result.rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'No active application found to withdraw' });
  return { success: true };
}

export const TaskAssignmentProcedures = {
  assignWorker: posterProcedure
    .input(z.object({ taskId: Schemas.uuid, workerId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => assignWorker(ctx, input)),
  rejectApplicant: posterProcedure
    .input(z.object({ taskId: Schemas.uuid, workerId: Schemas.uuid, reason: z.string().trim().max(500).optional() }))
    .mutation(async ({ ctx, input }) => rejectApplicant(ctx, input)),
  withdrawApplication: hustlerProcedure
    .input(z.object({ taskId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => withdrawApplication(ctx, input.taskId)),
};
