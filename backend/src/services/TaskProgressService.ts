import { db } from '../db.js';
import { writeToOutbox } from '../lib/outbox-helpers.js';
import type { ServiceResult, Task, TaskProgressState } from '../types.js';
import { ErrorCodes, VALID_PROGRESS_TRANSITIONS } from '../types.js';
import type { AdvanceProgressParams } from './TaskServiceShared.js';

type Query = Parameters<Parameters<typeof db.transaction>[0]>[0];
type LockedTask = {
  id: string;
  poster_id: string;
  worker_id: string | null;
  progress_state: string;
  state: string;
  scope_change_pending: boolean;
};
type ProgressResult = {
  task: Task;
  from: TaskProgressState;
  progressUpdatedAt?: Date;
};

async function lockTask(query: Query, taskId: string): Promise<LockedTask> {
  const result = await query<LockedTask>(
    `SELECT t.id, t.poster_id, t.worker_id, t.progress_state, t.state,
            EXISTS (
              SELECT 1 FROM task_scope_change_proposals p
              WHERE p.task_id = t.id AND p.status = 'PENDING'
            ) AS scope_change_pending
     FROM tasks t WHERE t.id = $1 FOR UPDATE OF t`,
    [taskId]
  );
  if (!result.rows[0]) throw new Error(`Task ${taskId} not found`);
  return result.rows[0];
}

function assertTransition(from: TaskProgressState, to: TaskProgressState): void {
  const valid = VALID_PROGRESS_TRANSITIONS[from];
  if (!valid.includes(to)) {
    throw new Error(`Invalid progress transition: ${from} → ${to}. Valid transitions: ${valid.join(', ')}`);
  }
}

function assertWorkerActor(task: LockedTask, params: AdvanceProgressParams): void {
  const workerTransitions: TaskProgressState[] = ['TRAVELING', 'WORKING', 'COMPLETED'];
  if (!workerTransitions.includes(params.to)) return;
  if (params.actor.type !== 'worker' || !params.actor.userId) {
    throw new Error(`Transition to ${params.to} requires worker actor`);
  }
  if (task.worker_id !== params.actor.userId) {
    throw new Error(`Worker ${params.actor.userId} does not own task ${params.taskId}`);
  }
}

function assertSystemActor(params: AdvanceProgressParams): void {
  const systemTransitions: TaskProgressState[] = ['ACCEPTED', 'CLOSED'];
  if (!systemTransitions.includes(params.to)) return;
  if (params.actor.type !== 'system') throw new Error(`Transition to ${params.to} requires system actor`);
}

async function assertNoActiveDispute(query: Query, taskId: string): Promise<void> {
  const visible = await query<{ state: string }>(
    `SELECT state FROM disputes WHERE task_id = $1 AND state NOT IN ('RESOLVED')
     ORDER BY created_at DESC LIMIT 1 FOR UPDATE SKIP LOCKED`,
    [taskId]
  );
  if (visible.rows[0]) {
    throw new Error(`Cannot advance progress: task ${taskId} has active dispute (state: ${visible.rows[0].state})`);
  }
  const any = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM disputes WHERE task_id = $1 AND state NOT IN ('RESOLVED')`,
    [taskId]
  );
  if (parseInt(any.rows[0]?.count ?? '0', 10) > 0) {
    throw new Error(`Cannot advance progress: task ${taskId} has active dispute (locked by concurrent transaction)`);
  }
}

async function assertEscrowMutable(query: Query, taskId: string, to: TaskProgressState): Promise<void> {
  const result = await query<{ state: string }>(
    'SELECT state FROM escrows WHERE task_id = $1 FOR SHARE',
    [taskId]
  );
  const state = result.rows[0]?.state;
  // CLOSED is the system's convergence step after escrow terminalization. Every
  // other progress mutation remains forbidden once money reaches a terminal state.
  if (state && ['RELEASED', 'REFUNDED', 'REFUND_PARTIAL'].includes(state) && to !== 'CLOSED') {
    throw new Error(`Cannot advance progress: escrow is in terminal state ${state}`);
  }
}

async function currentTask(query: Query, taskId: string, from: TaskProgressState): Promise<ProgressResult> {
  const result = await query<Task>('SELECT * FROM tasks WHERE id = $1', [taskId]);
  return { task: result.rows[0], from };
}

async function updateProgress(
  query: Query,
  params: AdvanceProgressParams,
  from: TaskProgressState
): Promise<ProgressResult> {
  const result = await query<Task & { progress_updated_at: Date }>(
    `UPDATE tasks SET progress_state = $1, progress_updated_at = NOW(), progress_by = $2, updated_at = NOW()
     WHERE id = $3 RETURNING *`,
    [params.to, params.actor.userId || null, params.taskId]
  );
  if (!result.rows[0]) throw new Error(`Failed to update task ${params.taskId}`);
  return { task: result.rows[0], from, progressUpdatedAt: result.rows[0].progress_updated_at };
}

async function progressTransaction(query: Query, params: AdvanceProgressParams): Promise<ProgressResult> {
  const task = await lockTask(query, params.taskId);
  const from = task.progress_state as TaskProgressState;
  if (from === params.to) return currentTask(query, params.taskId, from);
  assertTransition(from, params.to);
  assertWorkerActor(task, params);
  assertSystemActor(params);
  if (params.actor.type === 'worker' && task.scope_change_pending) {
    throw new Error(`Cannot advance progress: task ${params.taskId} has a pending scope change`);
  }
  await assertNoActiveDispute(query, params.taskId);
  await assertEscrowMutable(query, params.taskId, params.to);
  return updateProgress(query, params, from);
}

async function emitProgress(params: AdvanceProgressParams, result: ProgressResult): Promise<void> {
  // A same-state retry returns the canonical task but is not a material state
  // change. Do not manufacture a visible timeline/outbox event for transport
  // retries or repeated worker actions.
  if (result.from === params.to) return;
  await writeToOutbox({
    eventType: 'task.progress_updated',
    aggregateType: 'task',
    aggregateId: params.taskId,
    eventVersion: 1,
    idempotencyKey: `task.progress_updated:${params.taskId}:${result.from ?? 'null'}:${params.to}`,
    payload: {
      taskId: params.taskId,
      from: result.from,
      to: params.to,
      actor: { type: params.actor.type, userId: params.actor.userId || null },
      occurredAt: result.progressUpdatedAt?.toISOString() ?? new Date().toISOString(),
    },
    queueName: 'user_notifications',
  });
}

function progressError(error: unknown): ServiceResult<Task> {
  const message = error instanceof Error ? error.message : 'Unknown error';
  if (message.includes('Invalid progress transition')) {
    return { success: false, error: { code: ErrorCodes.INVALID_TRANSITION, message } };
  }
  if (message.includes('does not own task') || message.includes('requires')) {
    return { success: false, error: { code: ErrorCodes.FORBIDDEN, message } };
  }
  if (message.includes('not found')) return { success: false, error: { code: ErrorCodes.NOT_FOUND, message } };
  if (message.includes('active dispute') || message.includes('terminal state') || message.includes('pending scope change')) {
    return { success: false, error: { code: ErrorCodes.INVALID_STATE, message } };
  }
  return { success: false, error: { code: 'INTERNAL_ERROR', message } };
}

async function advanceProgress(params: AdvanceProgressParams): Promise<ServiceResult<Task>> {
  try {
    const result = await db.transaction((query) => progressTransaction(query, params));
    await emitProgress(params, result);
    return { success: true, data: result.task };
  } catch (error) {
    return progressError(error);
  }
}

export const TaskProgressService = { advanceProgress };
