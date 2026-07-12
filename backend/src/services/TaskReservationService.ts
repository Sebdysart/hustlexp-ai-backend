import { createHash } from 'node:crypto';
import { db, type QueryFn } from '../db.js';
import { logger } from '../logger.js';
import type { ServiceResult } from '../types.js';

const log = logger.child({ module: 'task', service: 'TaskReservationService' });

export interface ReserveTaskParams {
  engineTaskId: string;
  hustlerRef: string;
  idempotencyKey: string;
  actorId: string;
}

export interface EngineReservationResult {
  reservationId: string;
  engineTaskId: string;
  hustlerRef: string;
  state: 'ENGINE_RESERVED';
  idempotencyReplayed: boolean;
}

interface TaskReservationRow {
  id: string;
  state: string;
  worker_id: string | null;
  poster_id: string;
  risk_level: string;
  sensitive: boolean | null;
  price: number;
  trust_tier_required: number | null;
  escrow_state: string | null;
}

interface WorkerReservationRow {
  id: string;
  default_mode: string;
  trust_tier: number;
  trust_hold: boolean;
  is_banned: boolean | null;
  account_status: string;
  plan: string;
  stripe_connect_id: string | null;
  payouts_enabled: boolean;
}

interface ExistingRequestRow {
  request_hash: string;
  reservation_id: string;
  task_id: string;
  hustler_id: string;
  reservation_status: string;
}

export function buildReservationRequestHash(
  params: Pick<ReserveTaskParams, 'engineTaskId' | 'hustlerRef'>
): string {
  return createHash('sha256')
    .update(JSON.stringify({ engineTaskId: params.engineTaskId, hustlerRef: params.hustlerRef }))
    .digest('hex');
}

function requiredTrustTier(task: TaskReservationRow): number | null {
  if (task.risk_level === 'IN_HOME') return null;
  const riskFloor = task.risk_level === 'HIGH' ? 3 : 2;
  const sensitiveFloor = task.sensitive ? 3 : 1;
  return Math.max(task.trust_tier_required ?? 1, riskFloor, sensitiveFloor);
}

function error(code: string, message: string, details?: Record<string, unknown>) {
  return { kind: 'error' as const, code, message, details };
}

type ReservationError = ReturnType<typeof error>;
type ReservationSuccess = {
  kind: 'success';
  reservationId: string;
  replayed: boolean;
};
type LoadedTask = { kind: 'task'; task: TaskReservationRow };
type LoadedWorker = { kind: 'worker'; worker: WorkerReservationRow };

async function findExistingReservation(
  query: QueryFn,
  params: ReserveTaskParams,
  requestHash: string,
): Promise<ReservationError | ReservationSuccess | null> {
  const result = await query<ExistingRequestRow>(
    `SELECT rr.request_hash, rr.reservation_id, rr.task_id, rr.hustler_id,
            r.status AS reservation_status
     FROM task_reservation_requests rr
     JOIN task_reservations r ON r.id = rr.reservation_id
     WHERE rr.idempotency_key = $1`,
    [params.idempotencyKey],
  );
  const existing = result.rows[0];
  if (!existing) return null;
  if (existing.request_hash !== requestHash) {
    return error(
      'IDEMPOTENCY_CONFLICT',
      'Idempotency key was already used for a different reservation.',
      { reservationId: existing.reservation_id },
    );
  }
  return { kind: 'success', reservationId: existing.reservation_id, replayed: true };
}

async function loadTaskForReservation(
  query: QueryFn,
  params: ReserveTaskParams,
): Promise<LoadedTask | ReservationError> {
  const result = await query<TaskReservationRow>(
    `SELECT t.id, t.state, t.worker_id, t.poster_id, t.risk_level, t.price,
            t.sensitive, t.trust_tier_required,
            (SELECT e.state FROM escrows e WHERE e.task_id = t.id ORDER BY e.created_at DESC LIMIT 1) AS escrow_state
     FROM tasks t
     WHERE t.id = $1
     FOR UPDATE`,
    [params.engineTaskId],
  );
  const task = result.rows[0];
  if (!task) return error('NOT_FOUND', 'Engine task not found.');
  if (!['OPEN', 'MATCHING'].includes(task.state) || task.worker_id) {
    return error('RESERVATION_CONFLICT', 'Task is no longer available for reservation.', {
      taskState: task.state,
    });
  }
  if (task.escrow_state !== 'FUNDED') {
    return error('TASK_NOT_FUNDED', 'Task must be funded before reservation.');
  }
  if (task.poster_id === params.hustlerRef) {
    return error('SELF_ASSIGNMENT_FORBIDDEN', 'A poster cannot be reserved for their own task.');
  }
  return { kind: 'task', task };
}

async function loadWorkerForReservation(
  query: QueryFn,
  hustlerRef: string,
): Promise<LoadedWorker | ReservationError> {
  const result = await query<WorkerReservationRow>(
    `SELECT id, default_mode, trust_tier, trust_hold, is_banned, account_status, plan,
            stripe_connect_id, payouts_enabled
     FROM users
     WHERE id = $1
     FOR UPDATE`,
    [hustlerRef],
  );
  const worker = result.rows[0];
  if (!worker || worker.default_mode !== 'worker') {
    return error('HUSTLER_NOT_FOUND', 'Eligible hustler not found.');
  }
  if (worker.is_banned || worker.trust_hold || worker.account_status !== 'ACTIVE') {
    return error('HUSTLER_INELIGIBLE', 'Hustler account is not eligible for reservation.');
  }
  if (!worker.stripe_connect_id || !worker.payouts_enabled) {
    return error(
      'PAYOUT_ACCOUNT_REQUIRED',
      'Hustler must complete payout onboarding before reservation.'
    );
  }
  return { kind: 'worker', worker };
}

function validateTrustPolicy(
  task: TaskReservationRow,
  worker: WorkerReservationRow,
): ReservationError | null {
  const requiredTier = requiredTrustTier(task);
  if (requiredTier === null) {
    return error('TASK_RISK_BLOCKED', 'In-home tasks are not eligible for automated reservation.');
  }
  if (worker.trust_tier < requiredTier) {
    return error('TRUST_TIER_INSUFFICIENT', 'Hustler trust tier does not meet task policy.', {
      requiredTier,
      workerTier: worker.trust_tier,
    });
  }
  return null;
}

async function validateEntitlements(
  query: QueryFn,
  task: TaskReservationRow,
  worker: WorkerReservationRow,
  hustlerRef: string,
): Promise<ReservationError | null> {
  if (task.risk_level === 'HIGH' && worker.plan !== 'pro') {
    const entitlement = await query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM plan_entitlements
         WHERE user_id = $1 AND risk_level = 'HIGH' AND expires_at > NOW()
       ) AS exists`,
      [hustlerRef],
    );
    if (!entitlement.rows[0]?.exists) {
      return error('PLAN_REQUIRED', 'High-risk tasks require a Pro plan or active entitlement.');
    }
  }
  if (task.price <= 50000) return null;
  const backgroundCheck = await query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM background_checks
       WHERE user_id = $1
         AND status = 'CLEAR'
         AND (expires_at IS NULL OR expires_at > CURRENT_DATE)
     ) AS exists`,
    [hustlerRef],
  );
  return backgroundCheck.rows[0]?.exists
    ? null
    : error('BACKGROUND_CHECK_REQUIRED', 'High-value tasks require a current clear background check.');
}

async function validateNoActiveCommitment(
  query: QueryFn,
  params: ReserveTaskParams,
): Promise<ReservationError | null> {
  const result = await query<{ id: string }>(
    `SELECT id FROM tasks
     WHERE worker_id = $1
       AND id <> $2
       AND state IN ('ACCEPTED', 'PROOF_SUBMITTED', 'DISPUTED')
     LIMIT 1`,
    [params.hustlerRef, params.engineTaskId],
  );
  const conflictingTask = result.rows[0];
  return conflictingTask
    ? error('HUSTLER_ALREADY_COMMITTED', 'Hustler already has an active task.', {
        conflictingTaskId: conflictingTask.id,
      })
    : null;
}

async function commitReservation(
  query: QueryFn,
  params: ReserveTaskParams,
  requestHash: string,
): Promise<ReservationSuccess | ReservationError> {
  const taskUpdate = await query<{ id: string; state: string; worker_id: string }>(
    `UPDATE tasks
     SET state = 'ACCEPTED',
         progress_state = 'ACCEPTED',
         progress_updated_at = NOW(),
         progress_by = NULL,
         worker_id = $2,
         accepted_at = NOW(),
         updated_at = NOW()
     WHERE id = $1 AND state IN ('OPEN', 'MATCHING') AND worker_id IS NULL
     RETURNING id, state, worker_id`,
    [params.engineTaskId, params.hustlerRef],
  );
  if ((taskUpdate.rowCount ?? 0) === 0) {
    return error('RESERVATION_CONFLICT', 'Concurrent reservation won before this request.');
  }
  const reservation = await query<{ id: string }>(
    `INSERT INTO task_reservations (task_id, hustler_id, status, reserved_by)
     VALUES ($1, $2, 'ACTIVE', $3)
     RETURNING id`,
    [params.engineTaskId, params.hustlerRef, params.actorId],
  );
  const reservationId = reservation.rows[0].id;
  await query(
    `INSERT INTO task_reservation_requests
       (idempotency_key, request_hash, task_id, hustler_id, reservation_id, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      params.idempotencyKey,
      requestHash,
      params.engineTaskId,
      params.hustlerRef,
      reservationId,
      params.actorId,
    ],
  );
  return { kind: 'success', reservationId, replayed: false };
}

export const TaskReservationService = {
  reserve: async (params: ReserveTaskParams): Promise<ServiceResult<EngineReservationResult>> => {
    const requestHash = buildReservationRequestHash(params);

    try {
      const outcome = await db.transaction(async (query) => {
        await query(
          `SELECT pg_advisory_xact_lock(hashtext('task-reservation'), hashtext($1))`,
          [params.idempotencyKey]
        );

        const existing = await findExistingReservation(query, params, requestHash);
        if (existing) return existing;

        const taskResult = await loadTaskForReservation(query, params);
        if (taskResult.kind === 'error') return taskResult;
        const workerResult = await loadWorkerForReservation(query, params.hustlerRef);
        if (workerResult.kind === 'error') return workerResult;

        const trustError = validateTrustPolicy(taskResult.task, workerResult.worker);
        if (trustError) return trustError;
        const entitlementError = await validateEntitlements(
          query,
          taskResult.task,
          workerResult.worker,
          params.hustlerRef,
        );
        if (entitlementError) return entitlementError;
        const activeConflict = await validateNoActiveCommitment(query, params);
        if (activeConflict) return activeConflict;
        return commitReservation(query, params, requestHash);
      });

      if (outcome.kind === 'error') {
        log.warn(
          {
            engineTaskId: params.engineTaskId,
            hustlerRef: params.hustlerRef,
            actorId: params.actorId,
            code: outcome.code,
          },
          'Engine reservation denied'
        );
        return {
          success: false,
          error: { code: outcome.code, message: outcome.message, details: outcome.details },
        };
      }

      log.info(
        {
          engineTaskId: params.engineTaskId,
          hustlerRef: params.hustlerRef,
          actorId: params.actorId,
          reservationId: outcome.reservationId,
          idempotencyReplayed: outcome.replayed,
        },
        'Engine reservation committed'
      );
      return {
        success: true,
        data: {
          reservationId: outcome.reservationId,
          engineTaskId: params.engineTaskId,
          hustlerRef: params.hustlerRef,
          state: 'ENGINE_RESERVED',
          idempotencyReplayed: outcome.replayed,
        },
      };
    } catch (cause) {
      log.error(
        {
          engineTaskId: params.engineTaskId,
          hustlerRef: params.hustlerRef,
          actorId: params.actorId,
          err: cause instanceof Error ? cause.message : String(cause),
        },
        'Engine reservation failed'
      );
      return {
        success: false,
        error: { code: 'DB_ERROR', message: 'A database error occurred. Please try again.' },
      };
    }
  },
};
