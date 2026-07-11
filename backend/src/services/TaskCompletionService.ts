import { createHash } from 'node:crypto';
import { db, getErrorMessage, isInvariantViolation, type QueryFn } from '../db.js';
import { taskLogger } from '../logger.js';
import type { ServiceResult, Task } from '../types.js';
import { ErrorCodes, TERMINAL_TASK_STATES } from '../types.js';

const log = taskLogger.child({ service: 'TaskCompletionService' });

export interface CompleteTaskOptions {
  mode?: 'POSTER_CONFIRMED' | 'UNATTENDED';
  idempotencyKey?: string;
  actorId?: string;
}

export interface CompletionDeliveryParams {
  taskId: string;
  providerDeliveryId: string;
  channel: 'SMS' | 'EMAIL' | 'PUSH';
  deliveredAt: Date;
  actorId: string;
}

interface CompletionContext {
  state: string;
  poster_id: string;
  payout_ready_at: Date | null;
  completion_message_delivered_at: Date | null;
  price: number;
}

interface CompletionTransactionParams {
  taskId: string;
  posterId?: string;
  options: CompleteTaskOptions;
  mode: 'POSTER_CONFIRMED' | 'UNATTENDED';
  requestHash: string;
}

function failure<T>(code: string, message: string, details?: Record<string, unknown>): ServiceResult<T> {
  return { success: false, error: { code, message, details } };
}

function completionHash(taskId: string, mode: string): string {
  return createHash('sha256').update(JSON.stringify({ taskId, mode })).digest('hex');
}

async function replayUnattended(
  query: QueryFn,
  taskId: string,
  options: CompleteTaskOptions,
  requestHash: string
): Promise<ServiceResult<Task> | null> {
  if (!options.idempotencyKey) {
    return failure('IDEMPOTENCY_KEY_REQUIRED', 'Unattended completion requires an idempotency key');
  }
  await query(`SELECT pg_advisory_xact_lock(hashtext('unattended-completion'), hashtext($1))`, [options.idempotencyKey]);
  const prior = await query<{ request_hash: string; task_id: string }>(
    `SELECT request_hash, task_id FROM task_unattended_completion_requests WHERE idempotency_key = $1`,
    [options.idempotencyKey]
  );
  if (!prior.rows[0]) return null;
  if (prior.rows[0].request_hash !== requestHash) {
    return failure('IDEMPOTENCY_CONFLICT', 'Idempotency key was used for a different completion request');
  }
  const replay = await query<Task>('SELECT * FROM tasks WHERE id = $1', [taskId]);
  return { success: true, data: { ...replay.rows[0], completion_idempotency_replayed: true } };
}

async function lockCompletionContext(query: QueryFn, taskId: string): Promise<CompletionContext | undefined> {
  const result = await query<CompletionContext>(
    `SELECT state, poster_id, payout_ready_at, completion_message_delivered_at, price
     FROM tasks WHERE id = $1 FOR UPDATE`,
    [taskId]
  );
  return result.rows[0];
}

function validateContext(
  taskId: string,
  context: CompletionContext | undefined,
  posterId: string | undefined
): ServiceResult<'READY' | 'REPLAY'> {
  if (!context) return failure(ErrorCodes.NOT_FOUND, `Task ${taskId} not found`);
  if (posterId && context.poster_id !== posterId) {
    return failure(ErrorCodes.FORBIDDEN, 'Only the task poster can mark it complete');
  }
  if (context.state === 'COMPLETED' && context.payout_ready_at) return { success: true, data: 'REPLAY' };
  if (TERMINAL_TASK_STATES.includes(context.state as never)) {
    return failure(ErrorCodes.TASK_TERMINAL, `Task ${taskId} is in terminal state ${context.state}`);
  }
  if (context.state !== 'PROOF_SUBMITTED') {
    return failure(ErrorCodes.INVALID_STATE, `Cannot complete task: current state is ${context.state}, expected PROOF_SUBMITTED`);
  }
  return { success: true, data: 'READY' };
}

async function validateProofAndFunding(query: QueryFn, taskId: string): Promise<ServiceResult<true>> {
  const proof = await query<{ state: string }>(
    `SELECT state FROM proofs WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [taskId]
  );
  if (proof.rows[0]?.state !== 'ACCEPTED') {
    return failure(ErrorCodes.INV_3_VIOLATION, 'Cannot complete task until the latest proof is accepted');
  }
  const escrow = await query<{ state: string }>(
    `SELECT state FROM escrows WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [taskId]
  );
  if (escrow.rows[0]?.state !== 'FUNDED') {
    return failure('PAYOUT_NOT_FUNDED', 'Cannot mark payout ready without a funded escrow');
  }
  return { success: true, data: true };
}

function validateUnattended(context: CompletionContext): ServiceResult<true> {
  const deliveredAt = context.completion_message_delivered_at;
  if (!deliveredAt) return failure('COMPLETION_DELIVERY_REQUIRED', 'Unattended completion requires delivered-message evidence');
  if (Date.now() - new Date(deliveredAt).getTime() < 24 * 60 * 60 * 1000) {
    return failure('COMPLETION_WAIT_ACTIVE', 'Unattended completion wait period has not elapsed');
  }
  if (Number(context.price) > 50_000) {
    return failure('COMPLETION_VALUE_CAP', 'Task value exceeds unattended completion policy');
  }
  return { success: true, data: true };
}

function validateCompletionMode(
  mode: 'POSTER_CONFIRMED' | 'UNATTENDED',
  posterId: string | undefined
): ServiceResult<true> {
  if (mode === 'POSTER_CONFIRMED' && !posterId) {
    return failure(ErrorCodes.FORBIDDEN, 'Poster-confirmed completion requires poster identity');
  }
  return { success: true, data: true };
}

async function unattendedPreflight(
  query: QueryFn,
  params: CompletionTransactionParams
): Promise<ServiceResult<Task> | null> {
  if (params.mode !== 'UNATTENDED') return null;
  return replayUnattended(query, params.taskId, params.options, params.requestHash);
}

function validateModePolicy(
  mode: 'POSTER_CONFIRMED' | 'UNATTENDED',
  context: CompletionContext
): ServiceResult<true> {
  return mode === 'UNATTENDED' ? validateUnattended(context) : { success: true, data: true };
}

async function persistCompletion(query: QueryFn, taskId: string, mode: string): Promise<ServiceResult<Task>> {
  const result = await query<Task>(
    `UPDATE tasks
     SET state = 'COMPLETED', progress_state = 'COMPLETED', progress_updated_at = NOW(),
         completed_at = NOW(),
         completion_confirmed_at = CASE WHEN $2 = 'POSTER_CONFIRMED' THEN NOW() ELSE completion_confirmed_at END,
         payout_ready_at = NOW(),
         payout_ready_reason = CASE WHEN $2 = 'POSTER_CONFIRMED' THEN 'poster_confirmed' ELSE 'unattended_policy' END,
         updated_at = NOW()
     WHERE id = $1 AND state = 'PROOF_SUBMITTED'
     RETURNING *`,
    [taskId, mode]
  );
  if ((result.rowCount ?? 0) === 0) return failure(ErrorCodes.INVALID_STATE, 'Cannot complete task: state changed unexpectedly');
  return { success: true, data: result.rows[0] };
}

async function writeCompletionEvidence(
  query: QueryFn,
  taskId: string,
  mode: string,
  options: CompleteTaskOptions,
  requestHash: string
): Promise<void> {
  await query(
    `INSERT INTO engine_automation_events (task_id, event_type, idempotency_key, payload)
     VALUES ($1, 'PAYOUT_READY', $2, $3::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [taskId, `payout-ready:${taskId}`, JSON.stringify({ mode })]
  );
  if (mode !== 'UNATTENDED' || !options.idempotencyKey) return;
  await query(
    `INSERT INTO task_unattended_completion_requests
       (idempotency_key, request_hash, task_id, result_code, blocker_code)
     VALUES ($1, $2, $3, 'PAYOUT_READY', NULL)`,
    [options.idempotencyKey, requestHash, taskId]
  );
}

async function completeTransaction(
  query: QueryFn,
  params: CompletionTransactionParams
): Promise<ServiceResult<Task>> {
  const { taskId, posterId, options, mode, requestHash } = params;
  const validMode = validateCompletionMode(mode, posterId);
  if (!validMode.success) return validMode;
  const replay = await unattendedPreflight(query, params);
  if (replay) return replay;
  const context = await lockCompletionContext(query, taskId);
  const contextResult = validateContext(taskId, context, posterId);
  if (!contextResult.success) return contextResult;
  if (contextResult.data === 'REPLAY') {
    const existing = await query<Task>('SELECT * FROM tasks WHERE id = $1', [taskId]);
    return { success: true, data: existing.rows[0] };
  }
  const prerequisites = await validateProofAndFunding(query, taskId);
  if (!prerequisites.success) return prerequisites;
  const policy = validateModePolicy(mode, context!);
  if (!policy.success) return policy;
  const completed = await persistCompletion(query, taskId, mode);
  if (!completed.success) return completed;
  await writeCompletionEvidence(query, taskId, mode, options, requestHash);
  return completed;
}

async function deliveryReplayState(
  query: QueryFn,
  params: CompletionDeliveryParams,
  inserted: boolean
): Promise<ServiceResult<boolean>> {
  if (inserted) return { success: true, data: false };
  const existing = await query<{ task_id: string }>(
    `SELECT task_id FROM task_completion_delivery_events WHERE provider_delivery_id = $1`,
    [params.providerDeliveryId]
  );
  if (existing.rows[0]?.task_id !== params.taskId) {
    return failure('IDEMPOTENCY_CONFLICT', 'Provider delivery ID belongs to another task');
  }
  return { success: true, data: true };
}

async function recordDeliveryTransaction(
  query: QueryFn,
  params: CompletionDeliveryParams
): Promise<ServiceResult<{ taskId: string; providerDeliveryId: string; idempotencyReplayed: boolean }>> {
  const task = await query<{ state: string }>('SELECT state FROM tasks WHERE id = $1 FOR UPDATE', [params.taskId]);
  if (!task.rows[0]) return failure(ErrorCodes.NOT_FOUND, 'Task not found');
  if (task.rows[0].state !== 'PROOF_SUBMITTED') {
    return failure(ErrorCodes.INVALID_STATE, 'Completion delivery evidence requires PROOF_SUBMITTED state');
  }
  const insert = await query<{ task_id: string }>(
    `INSERT INTO task_completion_delivery_events
       (task_id, provider_delivery_id, channel, delivered_at, recorded_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider_delivery_id) DO NOTHING RETURNING task_id`,
    [params.taskId, params.providerDeliveryId, params.channel, params.deliveredAt, params.actorId]
  );
  const replay = await deliveryReplayState(query, params, (insert.rowCount ?? 0) > 0);
  if (!replay.success) return replay;
  await query(
    `UPDATE tasks
     SET completion_message_delivered_at = COALESCE(completion_message_delivered_at, $2),
         completion_message_delivery_id = COALESCE(completion_message_delivery_id, $3), updated_at = NOW()
     WHERE id = $1`,
    [params.taskId, params.deliveredAt, params.providerDeliveryId]
  );
  await query(
    `INSERT INTO engine_automation_events (task_id, event_type, idempotency_key, payload)
     VALUES ($1, 'COMPLETION_MESSAGE_DELIVERED', $2, $3::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [params.taskId, `completion-delivered:${params.providerDeliveryId}`, JSON.stringify({ channel: params.channel })]
  );
  return {
    success: true,
    data: { taskId: params.taskId, providerDeliveryId: params.providerDeliveryId, idempotencyReplayed: replay.data },
  };
}

export const TaskCompletionService = {
  complete: async (
    taskId: string,
    posterId?: string,
    options: CompleteTaskOptions = {}
  ): Promise<ServiceResult<Task>> => {
    const mode = options.mode ?? (posterId ? 'POSTER_CONFIRMED' : 'UNATTENDED');
    const requestHash = completionHash(taskId, mode);
    try {
      return await db.transaction((query) => completeTransaction(query, {
        taskId,
        posterId,
        options,
        mode,
        requestHash,
      }));
    } catch (error) {
      if (isInvariantViolation(error) && (error as { code?: string }).code === 'HX301') {
        return failure(ErrorCodes.INV_3_VIOLATION, getErrorMessage('HX301'), { taskId });
      }
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'Task completion failed');
      return failure('DB_ERROR', 'A database error occurred. Please try again.');
    }
  },

  recordDelivery: async (
    params: CompletionDeliveryParams
  ): Promise<ServiceResult<{ taskId: string; providerDeliveryId: string; idempotencyReplayed: boolean }>> => {
    try {
      return await db.transaction((query) => recordDeliveryTransaction(query, params));
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'Completion delivery recording failed');
      return failure('DB_ERROR', 'A database error occurred. Please try again.');
    }
  },
};

export default TaskCompletionService;
