import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { invalidateTask } from '../cache/db-cache.js';
import { db, type QueryFn } from '../db.js';
import { localCertificationAuthEnabled } from '../auth/local-certification-token.js';
import { notifyWorkerAssigned } from '../lib/task-lifecycle-notifications.js';
import { assertTaskMutationEligibility } from '../services/TaskEligibilityPolicy.js';
import { hustlerProcedure, posterProcedure, Schemas, type AuthedContext } from '../trpc.js';

interface AssignmentInput { taskId: string; workerId: string }
const LOCAL_CERTIFICATION_POSTER_RE = /^hxos-local-poster-[a-z0-9_-]{8,64}$/;
interface TaskRow {
  id: string;
  state: string;
  poster_id: string;
  trust_tier_required: number | null;
  template_slug: string | null;
  mutual_consent_required: boolean;
  title: string;
}

async function ownedOpenTask(txn: QueryFn, taskId: string, posterId: string): Promise<TaskRow> {
  const result = await txn<TaskRow>(
    `SELECT id, state, poster_id, trust_tier_required, template_slug,
            mutual_consent_required, title
       FROM tasks WHERE id = $1 FOR UPDATE`,
    [taskId],
  );
  const task = result.rows[0];
  if (!task || task.poster_id !== posterId) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the task poster can assign workers' });
  }
  if (task.state !== 'OPEN') {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `Task must be OPEN to assign a worker, current: ${task.state}` });
  }
  if (task.mutual_consent_required) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'This task requires the worker consent acceptance flow.',
    });
  }
  return task;
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
    await verifyWorkerTrust(txn, input.workerId, task.trust_tier_required);
    const applicationId = await pendingApplicationId(txn, input);
    await assertTaskMutationEligibility(txn, input.taskId, input.workerId, {
      requireCurrentOffer: true,
    });
    await verifyFunded(txn, input.taskId);
    return { ...await commitAssignment(txn, input, applicationId), taskTitle: task.title };
  });
  await invalidateTask(input.taskId);
  if (result.worker_id) await notifyWorkerAssigned(result.worker_id, input.taskId, result.taskTitle);
  const { taskTitle: _taskTitle, ...assignedTask } = result;
  return assignedTask;
}

async function shortlistApplicant(ctx: AuthedContext, input: AssignmentInput) {
  if (input.workerId === ctx.user.id) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot shortlist yourself' });
  }
  const shortlist = await db.transaction(async (query) => {
    const task = await query<{ id: string; poster_id: string; worker_id: string | null; state: string }>(
      'SELECT id,poster_id,worker_id,state FROM tasks WHERE id=$1 FOR UPDATE',
      [input.taskId],
    );
    const currentTask = task.rows[0];
    if (!currentTask || currentTask.poster_id !== ctx.user.id) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the task poster can shortlist a provider' });
    }
    if (!['OPEN', 'MATCHING'].includes(currentTask.state) || currentTask.worker_id) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Quote shortlisting requires an unassigned open task' });
    }
    const application = await query<{ id: string }>(
      `SELECT id FROM task_applications
        WHERE task_id=$1 AND hustler_id=$2 AND status IN ('pending','countered')`,
      [input.taskId, input.workerId],
    );
    if (!application.rows[0]) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'No active provider application can be shortlisted' });
    }
    const allowControlledTest = localCertificationAuthEnabled()
      && LOCAL_CERTIFICATION_POSTER_RE.test(ctx.firebaseUid ?? '');
    await assertTaskMutationEligibility(query, input.taskId, input.workerId, {
      requireCurrentOffer: true,
      ...(allowControlledTest ? { allowControlledTest: true } : {}),
    });
    const active = await query<{ id: string; worker_id: string; created_at: string | Date }>(
      `SELECT id,worker_id,created_at FROM task_quote_shortlists
        WHERE task_id=$1 AND status='ACTIVE' FOR UPDATE`,
      [input.taskId],
    );
    if (active.rows[0]?.worker_id === input.workerId) {
      return { ...active.rows[0], task_id: input.taskId, status: 'ACTIVE', replayed: true };
    }
    if (active.rows[0]) {
      await query(
        `UPDATE task_quote_shortlists
            SET status='REVOKED',closed_at=NOW(),updated_at=NOW()
          WHERE id=$1 AND status='ACTIVE'`,
        [active.rows[0].id],
      );
    }
    const inserted = await query<{ id: string; task_id: string; worker_id: string; status: string; created_at: string | Date }>(
      `INSERT INTO task_quote_shortlists(task_id,worker_id,shortlisted_by,status)
       VALUES ($1,$2,$3,'ACTIVE')
       RETURNING id,task_id,worker_id,status,created_at`,
      [input.taskId, input.workerId, ctx.user.id],
    );
    return { ...inserted.rows[0], replayed: false };
  });
  await invalidateTask(input.taskId);
  return shortlist;
}

async function revokeShortlist(ctx: AuthedContext, input: AssignmentInput) {
  const result = await db.transaction(async (query) => {
    const task = await query<{ poster_id: string; state: string }>(
      'SELECT poster_id,state FROM tasks WHERE id=$1 FOR UPDATE',
      [input.taskId],
    );
    if (!task.rows[0] || task.rows[0].poster_id !== ctx.user.id) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the task poster can close quote chat' });
    }
    const revoked = await query<{ id: string }>(
      `UPDATE task_quote_shortlists
          SET status='REVOKED',closed_at=NOW(),updated_at=NOW()
        WHERE task_id=$1 AND worker_id=$2 AND status='ACTIVE'
        RETURNING id`,
      [input.taskId, input.workerId],
    );
    if (!revoked.rows[0]) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'No active quote chat exists for this provider' });
    }
    return { success: true, shortlistId: revoked.rows[0].id };
  });
  await invalidateTask(input.taskId);
  return result;
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
  shortlistApplicant: posterProcedure
    .input(z.object({ taskId: Schemas.uuid, workerId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => shortlistApplicant(ctx, input)),
  revokeShortlist: posterProcedure
    .input(z.object({ taskId: Schemas.uuid, workerId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => revokeShortlist(ctx, input)),
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
