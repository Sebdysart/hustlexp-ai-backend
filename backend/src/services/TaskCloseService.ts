import { db } from '../db.js';
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

async function persistBlockedTaskCloseRefund(input: {
  query: Query;
  taskId: string;
  escrowId: string;
  reason: 'task_cancelled' | 'task_cancelled_late' | 'task_expired';
  workerPercent: number | null;
}): Promise<void> {
  const metadata = {
    event_type: 'task_close_refund_reconciliation_required_v1',
    task_id: input.taskId,
    reason: input.reason,
    requested_action: input.workerPercent === null ? 'FULL_REFUND' : 'PARTIAL_REFUND',
    worker_percent: input.workerPercent,
    producer_disabled: true,
    reconciliation_required: true,
    required_consumer_state: 'LOCKED_DISPUTE',
    required_payload_contract: 'snake_case_v1',
  };
  const idempotencyKey = [
    'task-close-refund-reconciliation-required-v1',
    input.escrowId,
    input.taskId,
    input.reason,
  ].join(':');
  const evidence = await input.query<{ metadata: unknown }>(
    `WITH attempted AS (
       INSERT INTO escrow_events
         (escrow_id,from_state,to_state,actor_id,actor_type,metadata,idempotency_key)
       VALUES ($1,'FUNDED','FUNDED',NULL,'system',$2::jsonb,$3)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING metadata
     )
     SELECT metadata FROM attempted
     UNION ALL
     SELECT metadata FROM escrow_events
      WHERE escrow_id=$1
        AND from_state='FUNDED' AND to_state='FUNDED'
        AND actor_id IS NULL AND actor_type='system'
        AND metadata::jsonb=$2::jsonb
        AND idempotency_key=$3
        AND NOT EXISTS (SELECT 1 FROM attempted)`,
    [input.escrowId, JSON.stringify(metadata), idempotencyKey],
  );
  if (evidence.rows.length !== 1) {
    fail(
      'REFUND_RECONCILIATION_REQUIRED',
      `Task ${input.taskId} close aborted: exact refund-reconciliation evidence conflicts for escrow ${input.escrowId}`,
    );
  }
  log.warn({
    escrowId:input.escrowId,
    taskId:input.taskId,
    reason:input.reason,
    workerPercent:input.workerPercent,
  }, 'Task close refund producer is disabled; durable reconciliation evidence recorded');
}

async function requestCancellationRefund(query: Query, taskId: string, row: CancelRow): Promise<void> {
  const result = await query<{ id: string }>(
    `SELECT id FROM escrows WHERE task_id = $1 AND state = 'FUNDED'`,
    [taskId]
  );
  const escrowId = result.rows[0]?.id;
  if (!escrowId) return;
  if (isLateAcceptedCancellation(row)) {
    await persistBlockedTaskCloseRefund({
      query,
      taskId,
      escrowId,
      reason:'task_cancelled_late',
      workerPercent:row.late_cancel_pct ?? 0,
    });
    return;
  }
  await persistBlockedTaskCloseRefund({
    query,
    taskId,
    escrowId,
    reason:'task_cancelled',
    workerPercent:null,
  });
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
  await persistBlockedTaskCloseRefund({
    query,
    taskId,
    escrowId,
    reason:'task_expired',
    workerPercent:null,
  });
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
