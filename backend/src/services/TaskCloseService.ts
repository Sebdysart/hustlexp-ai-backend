import { db } from '../db.js';
import { writeToOutbox } from '../lib/outbox-helpers.js';
import { taskLogger } from '../logger.js';
import type { ServiceError, ServiceResult, Task, TaskState } from '../types.js';
import { ErrorCodes } from '../types.js';
import { isTerminalState } from './TaskServiceShared.js';
import { canonicalTaskVersion, normalizeTaskVersion, type DatabaseTaskRow } from './TaskVersion.js';

const log = taskLogger.child({ service: 'TaskCloseService' });
type Query = Parameters<Parameters<typeof db.transaction>[0]>[0];
type CancelRow = {
  state: string;
  poster_id: string;
  version: number | string | bigint;
  work_order_id: string | null;
  universal_contract_version: number | string | bigint | null;
  late_cancel_pct: number | null;
  cancellation_window_hours: number | null;
  accepted_at: Date | null;
};

export const TASK_CANCEL_VERSION_CONFLICT_CODE = 'TASK_CANCEL_VERSION_CONFLICT';
export const TASK_CANCEL_WORK_ORDER_AUTHORITY_REQUIRED_CODE =
  'TASK_CANCEL_WORK_ORDER_AUTHORITY_REQUIRED';
export const TASK_CANCEL_UNIVERSAL_AUTHORITY_REQUIRED_CODE =
  'TASK_CANCEL_UNIVERSAL_AUTHORITY_REQUIRED';

export interface PosterTaskCancellationCommand {
  taskId: string;
  posterId: string;
  expectedVersion: number;
}

export type InternalTaskCancellationPurpose = 'GDPR_ERASURE' | 'SQUAD_CREATE_COMPENSATION';

export interface InternalTaskCancellationCommand {
  taskId: string;
  expectedVersion: number;
  purpose: InternalTaskCancellationPurpose;
}

interface LockedCancellationCommand {
  taskId: string;
  expectedVersion: number;
  posterId?: string;
}

const INTERNAL_CANCELLATION_PURPOSES = new Set<InternalTaskCancellationPurpose>([
  'GDPR_ERASURE',
  'SQUAD_CREATE_COMPENSATION',
]);

class CloseFailure extends Error {
  constructor(readonly serviceError: ServiceError) {
    super(serviceError.message);
  }
}

function fail(code: string, message: string): never {
  throw new CloseFailure({ code, message });
}

async function lockCancelableTask(
  query: Query,
  command: LockedCancellationCommand
): Promise<CancelRow> {
  const { taskId, posterId, expectedVersion } = command;
  const result = await query<CancelRow>(
    `SELECT state, poster_id, version, work_order_id, universal_contract_version,
            late_cancel_pct, cancellation_window_hours, accepted_at
     FROM tasks WHERE id = $1 FOR UPDATE`,
    [taskId]
  );
  const row = result.rows[0];
  if (!row) fail(ErrorCodes.NOT_FOUND, `Task ${taskId} not found`);
  if (posterId !== undefined && row.poster_id !== posterId)
    fail(ErrorCodes.FORBIDDEN, 'Not task owner');
  if (row.work_order_id !== null && row.work_order_id !== undefined) {
    fail(
      TASK_CANCEL_WORK_ORDER_AUTHORITY_REQUIRED_CODE,
      'This task is governed by a Work Order and cannot be cancelled through the legacy task endpoint.'
    );
  }
  if (Number(row.universal_contract_version) === 1) {
    fail(
      TASK_CANCEL_UNIVERSAL_AUTHORITY_REQUIRED_CODE,
      'Universal V1 tasks cannot be cancelled through the legacy task lifecycle.'
    );
  }
  if (canonicalTaskVersion(row.version) !== expectedVersion) {
    fail(
      TASK_CANCEL_VERSION_CONFLICT_CODE,
      `Task ${taskId} changed before cancellation. Reload it and review the current state.`
    );
  }
  if (isTerminalState(row.state as TaskState)) {
    fail(ErrorCodes.TASK_TERMINAL, `Task ${taskId} is in terminal state ${row.state}`);
  }
  if (!['OPEN', 'MATCHING', 'ACCEPTED'].includes(row.state)) {
    fail(ErrorCodes.INVALID_STATE, `Cannot cancel task: current state is ${row.state}`);
  }
  return row;
}

async function markCancelled(query: Query, taskId: string, lockedVersion: number): Promise<Task> {
  const result = await query<DatabaseTaskRow>(
    `UPDATE tasks SET state = 'CANCELLED', cancelled_at = NOW()
     WHERE id = $1
       AND version = $2
       AND work_order_id IS NULL
       AND COALESCE(universal_contract_version, 0) <> 1
       AND state IN ('OPEN', 'MATCHING', 'ACCEPTED')
     RETURNING *`,
    [taskId, lockedVersion]
  );
  if (!result.rows[0]) {
    fail(
      TASK_CANCEL_VERSION_CONFLICT_CODE,
      'Task changed or entered Work Order authority before cancellation could be committed.'
    );
  }
  return normalizeTaskVersion(result.rows[0]);
}

function isLateAcceptedCancellation(row: CancelRow): boolean {
  if (row.state !== 'ACCEPTED' || !row.accepted_at) return false;
  const percentage = row.late_cancel_pct ?? 0;
  const hours = row.cancellation_window_hours ?? 0;
  return (
    percentage > 0 &&
    hours > 0 &&
    Date.now() - new Date(row.accepted_at).getTime() > hours * 60 * 60 * 1000
  );
}

async function emitPartialRefund(
  query: Query,
  taskId: string,
  escrowId: string,
  percentage: number
): Promise<void> {
  await writeToOutbox(
    {
      eventType: 'escrow.partial_refund_requested',
      aggregateType: 'escrow',
      aggregateId: escrowId,
      eventVersion: 1,
      payload: { escrowId, reason: 'task_cancelled_late', taskId, workerPercent: percentage },
      queueName: 'critical_payments',
      idempotencyKey: `escrow.partial_refund_on_late_cancel:${escrowId}:${taskId}`,
    },
    query
  );
  log.info(
    { escrowId, taskId, lateCancelPct: percentage },
    'Partial refund requested after late cancellation'
  );
}

async function emitFullRefund(
  query: Query,
  taskId: string,
  escrowId: string,
  reason: string
): Promise<void> {
  await writeToOutbox(
    {
      eventType: 'escrow.refund_requested',
      aggregateType: 'escrow',
      aggregateId: escrowId,
      eventVersion: 1,
      payload: { escrowId, reason, taskId },
      queueName: 'critical_payments',
      idempotencyKey: `escrow.refund_on_${reason === 'task_expired' ? 'expire' : 'cancel'}:${escrowId}:${taskId}`,
    },
    query
  );
}

async function requestCancellationRefund(
  query: Query,
  taskId: string,
  row: CancelRow
): Promise<void> {
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

async function cancelTransaction(
  query: Query,
  command: LockedCancellationCommand
): Promise<ServiceResult<Task>> {
  const row = await lockCancelableTask(query, command);
  const lockedVersion = canonicalTaskVersion(row.version);
  const task = await markCancelled(query, command.taskId, lockedVersion);
  await requestCancellationRefund(query, command.taskId, row);
  return { success: true, data: task };
}

function validExpectedVersion(expectedVersion: number): boolean {
  return Number.isSafeInteger(expectedVersion) && expectedVersion > 0;
}

async function executeCancellation(
  command: LockedCancellationCommand
): Promise<ServiceResult<Task>> {
  try {
    return await db.transaction((query) => cancelTransaction(query, command));
  } catch (error) {
    if (error instanceof CloseFailure) return { success: false, error: error.serviceError };
    log.error({ err: error }, 'Task cancellation DB error');
    return {
      success: false,
      error: { code: 'DB_ERROR', message: 'A database error occurred. Please try again.' },
    };
  }
}

async function cancelByPoster(
  command: PosterTaskCancellationCommand
): Promise<ServiceResult<Task>> {
  if (!validExpectedVersion(command.expectedVersion)) {
    return {
      success: false,
      error: {
        code: ErrorCodes.INVALID_INPUT,
        message: 'expectedVersion must be a positive safe integer.',
      },
    };
  }
  return executeCancellation(command);
}

async function cancelForInternalPurpose(
  command: InternalTaskCancellationCommand
): Promise<ServiceResult<Task>> {
  if (!validExpectedVersion(command.expectedVersion)) {
    return {
      success: false,
      error: {
        code: ErrorCodes.INVALID_INPUT,
        message: 'expectedVersion must be a positive safe integer.',
      },
    };
  }
  if (!INTERNAL_CANCELLATION_PURPOSES.has(command.purpose)) {
    return {
      success: false,
      error: {
        code: ErrorCodes.INVALID_INPUT,
        message: 'Internal cancellation purpose is not authorized.',
      },
    };
  }
  return executeCancellation(command);
}

async function refundExpiredOpenTask(
  query: Query,
  taskId: string,
  priorState: string
): Promise<void> {
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
  const locked = await query<{ state: string }>(
    'SELECT state FROM tasks WHERE id = $1 FOR UPDATE',
    [taskId]
  );
  if (!locked.rows[0])
    fail(
      ErrorCodes.INVALID_STATE,
      'Task cannot be expired (already terminal or deadline not passed)'
    );
  const result = await query<Task>(
    `UPDATE tasks SET state = 'EXPIRED', expired_at = NOW()
     WHERE id = $1
       AND state NOT IN ('COMPLETED','CANCELLED','EXPIRED','PROOF_SUBMITTED','DISPUTED','IN_REVIEW')
       AND deadline < NOW() RETURNING *`,
    [taskId]
  );
  if (!result.rows[0])
    fail(
      ErrorCodes.INVALID_STATE,
      'Task cannot be expired (already terminal or deadline not passed)'
    );
  await refundExpiredOpenTask(query, taskId, locked.rows[0].state);
  return { success: true, data: result.rows[0] };
}

async function expire(taskId: string): Promise<ServiceResult<Task>> {
  try {
    return await db.transaction((query) => expireTransaction(query, taskId));
  } catch (error) {
    if (error instanceof CloseFailure) return { success: false, error: error.serviceError };
    log.error({ err: error }, 'Task expiry DB error');
    return {
      success: false,
      error: { code: 'DB_ERROR', message: 'A database error occurred. Please try again.' },
    };
  }
}

export const TaskCloseService = { cancelByPoster, cancelForInternalPurpose, expire };
