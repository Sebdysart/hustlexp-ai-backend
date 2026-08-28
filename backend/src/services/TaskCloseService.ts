import { db } from '../db.js';
import { writeToOutbox } from '../lib/outbox-helpers.js';
import { taskLogger } from '../logger.js';
import type { ServiceError, ServiceResult, Task, TaskState } from '../types.js';
import { ErrorCodes } from '../types.js';
import { isTerminalState } from './TaskServiceShared.js';

const log = taskLogger.child({ service: 'TaskCloseService' });
type Query = Parameters<Parameters<typeof db.transaction>[0]>[0];
type CancelRow = {
  state: string;
  poster_id: string;
  late_cancel_pct: number | null;
  cancellation_window_hours: number | null;
  accepted_at: Date | null;
};

class CloseFailure extends Error {
  constructor(readonly serviceError: ServiceError) {
    super(serviceError.message);
  }
}

function fail(code: string, message: string): never {
  throw new CloseFailure({ code, message });
}

async function lockCancelableTask(query: Query, taskId: string, posterId?: string): Promise<CancelRow> {
  const result = await query<CancelRow>(
    `SELECT state, poster_id, late_cancel_pct, cancellation_window_hours, accepted_at
     FROM tasks WHERE id = $1 FOR UPDATE`,
    [taskId]
  );
  const row = result.rows[0];
  if (!row) fail(ErrorCodes.NOT_FOUND, `Task ${taskId} not found`);
  if (posterId !== undefined && row.poster_id !== posterId) fail(ErrorCodes.FORBIDDEN, 'Not task owner');
  if (isTerminalState(row.state as TaskState)) {
    fail(ErrorCodes.TASK_TERMINAL, `Task ${taskId} is in terminal state ${row.state}`);
  }
  if (!['OPEN', 'MATCHING', 'ACCEPTED'].includes(row.state)) {
    fail(ErrorCodes.INVALID_STATE, `Cannot cancel task: current state is ${row.state}`);
  }
  return row;
}

async function markCancelled(query: Query, taskId: string): Promise<Task> {
  const result = await query<Task>(
    `UPDATE tasks SET state = 'CANCELLED', cancelled_at = NOW()
     WHERE id = $1 AND state IN ('OPEN', 'MATCHING', 'ACCEPTED') RETURNING *`,
    [taskId]
  );
  if (!result.rows[0]) fail(ErrorCodes.INVALID_STATE, 'Cannot cancel task: state changed unexpectedly');
  return result.rows[0];
}

function isLateAcceptedCancellation(row: CancelRow): boolean {
  if (row.state !== 'ACCEPTED' || !row.accepted_at) return false;
  const percentage = row.late_cancel_pct ?? 0;
  const hours = row.cancellation_window_hours ?? 0;
  return percentage > 0
    && hours > 0
    && Date.now() - new Date(row.accepted_at).getTime() > hours * 60 * 60 * 1000;
}

async function emitPartialRefund(query: Query, taskId: string, escrowId: string, percentage: number): Promise<void> {
  await writeToOutbox({
    eventType: 'escrow.partial_refund_requested',
    aggregateType: 'escrow',
    aggregateId: escrowId,
    eventVersion: 1,
    payload: { escrowId, reason: 'task_cancelled_late', taskId, workerPercent: percentage },
    queueName: 'critical_payments',
    idempotencyKey: `escrow.partial_refund_on_late_cancel:${escrowId}:${taskId}`,
  }, query);
  log.info({ escrowId, taskId, lateCancelPct: percentage }, 'Partial refund requested after late cancellation');
}

async function emitFullRefund(query: Query, taskId: string, escrowId: string, reason: string): Promise<void> {
  await writeToOutbox({
    eventType: 'escrow.refund_requested',
    aggregateType: 'escrow',
    aggregateId: escrowId,
    eventVersion: 1,
    payload: { escrowId, reason, taskId },
    queueName: 'critical_payments',
    idempotencyKey: `escrow.refund_on_${reason === 'task_expired' ? 'expire' : 'cancel'}:${escrowId}:${taskId}`,
  }, query);
}

async function requestCancellationRefund(query: Query, taskId: string, row: CancelRow): Promise<void> {
  const result = await query<{ id: string }>(
    `SELECT id FROM escrows WHERE task_id = $1 AND state = 'FUNDED'`,
    [taskId]
  );
  const escrowId = result.rows[0]?.id;
  if (!escrowId) return;
  if (isLateAcceptedCancellation(row)) {
    await emitPartialRefund(query, taskId, escrowId, row.late_cancel_pct ?? 0);
    return;
  }
  await emitFullRefund(query, taskId, escrowId, 'task_cancelled');
  log.info({ escrowId, taskId }, 'Escrow refund requested on task cancellation');
}

async function cancelTransaction(query: Query, taskId: string, posterId?: string): Promise<ServiceResult<Task>> {
  const row = await lockCancelableTask(query, taskId, posterId);
  const task = await markCancelled(query, taskId);
  await requestCancellationRefund(query, taskId, row);
  return { success: true, data: task };
}

async function cancel(taskId: string, posterId?: string): Promise<ServiceResult<Task>> {
  try {
    return await db.transaction((query) => cancelTransaction(query, taskId, posterId));
  } catch (error) {
    if (error instanceof CloseFailure) return { success: false, error: error.serviceError };
    log.error({ err: error }, 'Task cancellation DB error');
    return { success: false, error: { code: 'DB_ERROR', message: 'A database error occurred. Please try again.' } };
  }
}

async function refundExpiredOpenTask(query: Query, taskId: string, priorState: string): Promise<void> {
  if (priorState !== 'MATCHING' && priorState !== 'OPEN') return;
  const result = await query<{ id: string }>(
    `SELECT id FROM escrows WHERE task_id = $1 AND state = 'FUNDED'`,
    [taskId]
  );
  const escrowId = result.rows[0]?.id;
  if (!escrowId) return;
  await emitFullRefund(query, taskId, escrowId, 'task_expired');
  log.info({ escrowId, taskId }, `Escrow refund requested on ${priorState} task expiry`);
}

async function expireTransaction(query: Query, taskId: string): Promise<ServiceResult<Task>> {
  const locked = await query<{ state: string }>('SELECT state FROM tasks WHERE id = $1 FOR UPDATE', [taskId]);
  if (!locked.rows[0]) fail(ErrorCodes.INVALID_STATE, 'Task cannot be expired (already terminal or deadline not passed)');
  const result = await query<Task>(
    `UPDATE tasks SET state = 'EXPIRED', expired_at = NOW()
     WHERE id = $1
       AND state NOT IN ('COMPLETED','CANCELLED','EXPIRED','PROOF_SUBMITTED','DISPUTED','IN_REVIEW')
       AND deadline < NOW() RETURNING *`,
    [taskId]
  );
  if (!result.rows[0]) fail(ErrorCodes.INVALID_STATE, 'Task cannot be expired (already terminal or deadline not passed)');
  await refundExpiredOpenTask(query, taskId, locked.rows[0].state);
  return { success: true, data: result.rows[0] };
}

async function expire(taskId: string): Promise<ServiceResult<Task>> {
  try {
    return await db.transaction((query) => expireTransaction(query, taskId));
  } catch (error) {
    if (error instanceof CloseFailure) return { success: false, error: error.serviceError };
    log.error({ err: error }, 'Task expiry DB error');
    return { success: false, error: { code: 'DB_ERROR', message: 'A database error occurred. Please try again.' } };
  }
}

export const TaskCloseService = { cancel, expire };
