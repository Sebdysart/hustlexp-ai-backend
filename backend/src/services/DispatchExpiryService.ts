import { createHash } from 'node:crypto';
import { db, type QueryFn } from '../db.js';
import { writeToOutbox } from '../lib/outbox-helpers.js';
import { logger } from '../logger.js';
import type { ServiceResult } from '../types.js';
import type { RefundState } from './AutomationLifecycleReadService.js';

const log = logger.child({ module: 'automation', service: 'DispatchExpiryService' });

export interface ExpireUnfilledParams {
  engineTaskId: string;
  idempotencyKey: string;
}

export interface ExpireUnfilledResult {
  engineTaskId: string;
  lifecycleState: 'EXPIRED_UNFILLED';
  refundState: RefundState;
  blockerCode: string | null;
  idempotencyReplayed: boolean;
}

interface PriorRequestRow {
  request_hash: string;
  task_id: string;
  result_code: string;
  refund_state: RefundState;
  blocker_code: string | null;
}

interface ExpiryTaskRow {
  id: string;
  state: string;
  worker_id: string | null;
  dispatch_expires_at: Date | string | null;
  expiration_reason: string | null;
  refund_state: RefundState;
  refund_blocker: string | null;
  active_reservation: boolean;
  escrow_state: string | null;
  stripe_refund_id: string | null;
  payment_intent_canceled_at: Date | string | null;
}

interface RefundPlan {
  refundState: RefundState;
  blockerCode: string | null;
}

export function buildDispatchExpiryRequestHash(params: ExpireUnfilledParams): string {
  return createHash('sha256')
    .update(JSON.stringify({ engineTaskId: params.engineTaskId }))
    .digest('hex');
}

function failure<T>(code: string, message: string, details?: Record<string, unknown>): ServiceResult<T> {
  return { success: false, error: { code, message, details } };
}

async function findPrior(query: QueryFn, idempotencyKey: string): Promise<PriorRequestRow | undefined> {
  const result = await query<PriorRequestRow>(
    `SELECT r.request_hash, r.task_id, r.result_code,
            CASE WHEN e.state = 'REFUNDED' OR e.stripe_refund_id IS NOT NULL
                 THEN 'REFUNDED'
                 WHEN e.payment_intent_canceled_at IS NOT NULL THEN 'NOT_REQUIRED'
                 ELSE r.refund_state END AS refund_state,
            CASE WHEN e.state = 'REFUNDED' OR e.stripe_refund_id IS NOT NULL
                       OR e.payment_intent_canceled_at IS NOT NULL
                 THEN NULL ELSE r.blocker_code END AS blocker_code
     FROM task_dispatch_expiry_requests r
     LEFT JOIN LATERAL (
       SELECT state, stripe_refund_id, payment_intent_canceled_at FROM escrows
       WHERE task_id = r.task_id ORDER BY created_at DESC LIMIT 1
     ) e ON TRUE
     WHERE r.idempotency_key = $1`,
    [idempotencyKey]
  );
  return result.rows[0];
}

function priorResult(prior: PriorRequestRow, requestHash: string): ServiceResult<ExpireUnfilledResult> {
  if (prior.request_hash !== requestHash) {
    return failure('IDEMPOTENCY_CONFLICT', 'Idempotency key was used for a different task.');
  }
  return {
    success: true,
    data: {
      engineTaskId: prior.task_id,
      lifecycleState: 'EXPIRED_UNFILLED',
      refundState: prior.refund_state,
      blockerCode: prior.blocker_code,
      idempotencyReplayed: true,
    },
  };
}

async function lockTask(query: QueryFn, taskId: string): Promise<ExpiryTaskRow | undefined> {
  const result = await query<ExpiryTaskRow>(
    `SELECT t.id, t.state, t.worker_id, t.dispatch_expires_at,
            t.expiration_reason, t.refund_state, t.refund_blocker,
            EXISTS (
              SELECT 1 FROM task_reservations r
              WHERE r.task_id = t.id AND r.status = 'ACTIVE'
            ) AS active_reservation,
            (SELECT e.state FROM escrows e WHERE e.task_id = t.id ORDER BY e.created_at DESC LIMIT 1) AS escrow_state,
            (SELECT e.stripe_refund_id FROM escrows e WHERE e.task_id = t.id ORDER BY e.created_at DESC LIMIT 1) AS stripe_refund_id,
            (SELECT e.payment_intent_canceled_at FROM escrows e WHERE e.task_id = t.id ORDER BY e.created_at DESC LIMIT 1) AS payment_intent_canceled_at
     FROM tasks t WHERE t.id = $1 FOR UPDATE OF t`,
    [taskId]
  );
  return result.rows[0];
}

function validateExpirable(task: ExpiryTaskRow): ServiceResult<true> {
  if (!['OPEN', 'MATCHING'].includes(task.state) || task.worker_id || task.active_reservation) {
    return failure('TASK_NOT_UNFILLED', 'Only an unreserved OPEN or MATCHING task can expire unfilled.');
  }
  if (!task.dispatch_expires_at) return failure('DISPATCH_EXPIRY_MISSING', 'Task has no dispatch expiry.');
  if (new Date(task.dispatch_expires_at) > new Date()) {
    return failure('DISPATCH_NOT_EXPIRED', 'Dispatch window has not expired.');
  }
  return { success: true, data: true };
}

function reconciledRefund(task: ExpiryTaskRow): RefundPlan {
  const refunded = task.escrow_state === 'REFUNDED' || task.stripe_refund_id;
  const canceled = Boolean(task.payment_intent_canceled_at);
  return {
    refundState: refunded ? 'REFUNDED' : canceled ? 'NOT_REQUIRED' : task.refund_state,
    blockerCode: refunded || canceled ? null : task.refund_blocker,
  };
}

async function writeRequest(
  query: QueryFn,
  params: ExpireUnfilledParams,
  requestHash: string,
  plan: RefundPlan
): Promise<void> {
  await query(
    `INSERT INTO task_dispatch_expiry_requests
       (idempotency_key, request_hash, task_id, result_code, refund_state, blocker_code)
     VALUES ($1, $2, $3, 'EXPIRED_UNFILLED', $4, $5)`,
    [params.idempotencyKey, requestHash, params.engineTaskId, plan.refundState, plan.blockerCode]
  );
}

async function planRefund(query: QueryFn, taskId: string): Promise<ServiceResult<RefundPlan>> {
  const escrowResult = await query<{
    id: string;
    state: string;
    stripe_payment_intent_id: string | null;
    stripe_refund_id: string | null;
    payment_intent_canceled_at: Date | string | null;
  }>(
    `SELECT id, state, stripe_payment_intent_id, stripe_refund_id, payment_intent_canceled_at
     FROM escrows WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [taskId]
  );
  const escrow = escrowResult.rows[0];
  if (!escrow) return { success: true, data: { refundState: 'NOT_REQUIRED', blockerCode: null } };
  if (escrow.state === 'REFUNDED' || escrow.stripe_refund_id) {
    return { success: true, data: { refundState: 'REFUNDED', blockerCode: null } };
  }
  if (escrow.payment_intent_canceled_at) {
    return { success: true, data: { refundState: 'NOT_REQUIRED', blockerCode: null } };
  }
  if (escrow.state === 'PENDING') {
    if (!escrow.stripe_payment_intent_id) {
      return { success: true, data: { refundState: 'NOT_REQUIRED', blockerCode: null } };
    }
    await writeToOutbox({
      eventType: 'escrow.refund_requested',
      aggregateType: 'escrow',
      aggregateId: escrow.id,
      payload: {
        escrow_id: escrow.id,
        task_id: taskId,
        reason: 'dispatch_expired_unfilled',
        financial_action: 'cancel_pending_payment_intent',
      },
      queueName: 'critical_payments',
      idempotencyKey: `dispatch-expiry-cancel:${taskId}`,
    }, query);
    return { success: true, data: { refundState: 'PENDING', blockerCode: null } };
  }
  if (escrow.state !== 'FUNDED') {
    return { success: true, data: { refundState: 'BLOCKED', blockerCode: `BLOCKED_ESCROW_STATE_${escrow.state}` } };
  }

  const lock = await query<{ id: string }>(
    `UPDATE escrows
     SET state = 'LOCKED_DISPUTE', version = version + 1, updated_at = NOW()
     WHERE id = $1 AND state = 'FUNDED' RETURNING id`,
    [escrow.id]
  );
  if ((lock.rowCount ?? 0) === 0) return failure('REFUND_LOCK_CONFLICT', 'Escrow changed before refund could be requested.');
  await writeToOutbox({
    eventType: 'escrow.refund_requested',
    aggregateType: 'escrow',
    aggregateId: escrow.id,
    payload: { escrow_id: escrow.id, task_id: taskId, reason: 'dispatch_expired_unfilled' },
    queueName: 'critical_payments',
    idempotencyKey: `dispatch-expiry-refund:${taskId}`,
  }, query);
  return { success: true, data: { refundState: 'PENDING', blockerCode: null } };
}

async function persistExpiry(query: QueryFn, taskId: string, plan: RefundPlan): Promise<boolean> {
  const result = await query<{ id: string }>(
    `UPDATE tasks
     SET state = 'EXPIRED', expired_at = NOW(), expiration_reason = 'UNFILLED',
         refund_state = $2, refund_blocker = $3,
         refund_requested_at = CASE WHEN $2 = 'PENDING' THEN NOW() ELSE refund_requested_at END,
         updated_at = NOW()
     WHERE id = $1 AND state IN ('OPEN', 'MATCHING') AND worker_id IS NULL
     RETURNING id`,
    [taskId, plan.refundState, plan.blockerCode]
  );
  return (result.rowCount ?? 0) > 0;
}

async function writeExpiryEvent(query: QueryFn, taskId: string, plan: RefundPlan): Promise<void> {
  await query(
    `INSERT INTO engine_automation_events (task_id, event_type, idempotency_key, payload)
     VALUES ($1, 'TASK_EXPIRED_UNFILLED', $2, $3::jsonb)`,
    [taskId, `dispatch-expiry:${taskId}`, JSON.stringify(plan)]
  );
}

async function expireTransaction(
  query: QueryFn,
  params: ExpireUnfilledParams,
  requestHash: string
): Promise<ServiceResult<ExpireUnfilledResult>> {
  await query(`SELECT pg_advisory_xact_lock(hashtext('dispatch-expiry'), hashtext($1))`, [params.idempotencyKey]);
  const prior = await findPrior(query, params.idempotencyKey);
  if (prior) return priorResult(prior, requestHash);

  const task = await lockTask(query, params.engineTaskId);
  if (!task) return failure('NOT_FOUND', 'Engine task not found.');
  if (task.state === 'EXPIRED' && task.expiration_reason === 'UNFILLED') {
    const plan = reconciledRefund(task);
    await writeRequest(query, params, requestHash, plan);
    return { success: true, data: { engineTaskId: task.id, lifecycleState: 'EXPIRED_UNFILLED', ...plan, idempotencyReplayed: true } };
  }

  const valid = validateExpirable(task);
  if (!valid.success) return valid;
  const planned = await planRefund(query, task.id);
  if (!planned.success) return planned;
  if (!await persistExpiry(query, task.id, planned.data)) return failure('EXPIRY_CONFLICT', 'Task changed before expiry could be committed.');
  await writeExpiryEvent(query, task.id, planned.data);
  await writeRequest(query, params, requestHash, planned.data);
  return {
    success: true,
    data: { engineTaskId: task.id, lifecycleState: 'EXPIRED_UNFILLED', ...planned.data, idempotencyReplayed: false },
  };
}

export const DispatchExpiryService = {
  expireUnfilled: async (params: ExpireUnfilledParams): Promise<ServiceResult<ExpireUnfilledResult>> => {
    const requestHash = buildDispatchExpiryRequestHash(params);
    try {
      return await db.transaction((query) => expireTransaction(query, params, requestHash));
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'Unfilled expiry failed');
      return failure('DB_ERROR', 'Could not expire task safely.');
    }
  },

  expireDue: async (params: { limit: number }): Promise<ServiceResult<{
    inspected: number;
    expired: number;
    blocked: number;
    results: Array<ExpireUnfilledResult | { engineTaskId: string; blockerCode: string }>;
  }>> => {
    const limit = Math.max(1, Math.min(params.limit, 100));
    try {
      const due = await db.query<{ id: string }>(
        `SELECT t.id FROM tasks t
         WHERE t.state IN ('OPEN', 'MATCHING') AND t.worker_id IS NULL
           AND t.dispatch_expires_at IS NOT NULL AND t.dispatch_expires_at <= NOW()
           AND NOT EXISTS (
             SELECT 1 FROM task_reservations r WHERE r.task_id = t.id AND r.status = 'ACTIVE'
           )
         ORDER BY t.dispatch_expires_at, t.id LIMIT $1`,
        [limit]
      );
      const results: Array<ExpireUnfilledResult | { engineTaskId: string; blockerCode: string }> = [];
      let expired = 0;
      let blocked = 0;
      for (const task of due.rows) {
        const outcome = await DispatchExpiryService.expireUnfilled({
          engineTaskId: task.id,
          idempotencyKey: `dispatch-expiry:${task.id}`,
        });
        if (outcome.success) {
          expired += 1;
          results.push(outcome.data);
        } else {
          blocked += 1;
          results.push({ engineTaskId: task.id, blockerCode: outcome.error.code });
        }
      }
      return { success: true, data: { inspected: due.rows.length, expired, blocked, results } };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'Expiry batch failed');
      return failure('DB_ERROR', 'Could not run dispatch expiry batch.');
    }
  },
};

export default DispatchExpiryService;
