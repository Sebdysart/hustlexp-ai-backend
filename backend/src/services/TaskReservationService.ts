import { createHash } from 'node:crypto';
import { db, type QueryFn } from '../db.js';
import { logger } from '../logger.js';
import type { ServiceResult } from '../types.js';
import { localCertificationPayoutEnabled } from './LocalCertificationPayoutProvider.js';
import { localCertificationScreeningEnabled } from './LocalCertificationScreeningProvider.js';
import { controlledTestLiquidityEnabled } from './ControlledTestLiquidityService.js';

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
  automation_classification: string | null;
  background_check_required: boolean;
  liquidity_cell_id: string | null;
  liquidity_environment: 'PRODUCTION' | 'CONTROLLED_TEST' | null;
  liquidity_is_test: boolean | null;
  local_test_liquidity_ready: boolean;
  offer_decision_ready: boolean;
}

interface WorkerReservationRow {
  id: string;
  default_mode: string;
  trust_tier: number;
  trust_hold: boolean;
  active_trust_hold: boolean;
  is_banned: boolean | null;
  is_minor: boolean;
  account_status: string;
  plan: string;
  stripe_connect_id: string | null;
  payouts_enabled: boolean;
  local_test_payout_ready: boolean;
  background_check_valid: boolean;
  background_check_expires_at: Date | string | null;
  background_check_environment: 'PRODUCTION' | 'CONTROLLED_TEST' | null;
  background_check_is_test: boolean;
  background_check_source_ready: boolean;
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
  const riskFloor = task.risk_level === 'HIGH'
    ? 3
    : task.risk_level === 'MEDIUM'
      ? 2
      : 1;
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
            t.sensitive, t.trust_tier_required, t.automation_classification,
            t.background_check_required,t.liquidity_cell_id,
            (SELECT cell.environment FROM zone_category_cells cell
              WHERE cell.id=t.liquidity_cell_id) AS liquidity_environment,
            (SELECT cell.is_test FROM zone_category_cells cell
              WHERE cell.id=t.liquidity_cell_id) AS liquidity_is_test,
            COALESCE(hxos_local_test_liquidity_witness_current_v2(t.id,$2,t.liquidity_cell_id),FALSE)
              AS local_test_liquidity_ready,
            EXISTS (
              SELECT 1 FROM worker_offer_decisions offer
              WHERE offer.task_id=t.id AND offer.worker_id=$2
                AND offer.decision_ready IS TRUE AND offer.expires_at>NOW()
                AND offer.customer_total_cents=t.price
                AND offer.payout_cents IS NOT DISTINCT FROM t.hustler_payout_cents
                AND offer.scope_hash IS NOT DISTINCT FROM t.scope_hash
                AND offer.cancellation_policy_version IS NOT DISTINCT FROM t.cancellation_policy_version
                AND offer.estimated_duration_minutes IS NOT DISTINCT FROM t.estimated_duration_minutes
                AND (
                  t.automation_classification<>'CONTROLLED_TEST'
                  OR hxos_local_test_offer_action_current(t.id,$2,offer.id,'ACCEPTED')
                )
            ) AS offer_decision_ready,
            (SELECT e.state FROM escrows e WHERE e.task_id = t.id ORDER BY e.created_at DESC LIMIT 1) AS escrow_state
     FROM tasks t
     WHERE t.id = $1
     FOR UPDATE`,
    [params.engineTaskId, params.hustlerRef],
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
  if (!task.offer_decision_ready) {
    return error(
      'WORKER_OFFER_REQUIRED',
      'The worker must review a current complete offer before reservation.',
    );
  }
  return { kind: 'task', task };
}

async function loadWorkerForReservation(
  query: QueryFn,
  hustlerRef: string,
  task: TaskReservationRow,
): Promise<LoadedWorker | ReservationError> {
  const result = await query<WorkerReservationRow>(
    `SELECT users.id, users.default_mode, users.trust_tier, users.trust_hold,
            COALESCE(users.trust_hold AND (users.trust_hold_until IS NULL OR users.trust_hold_until > NOW()), FALSE) AS active_trust_hold,
            users.is_banned, users.is_minor, users.account_status, users.plan,
            users.stripe_connect_id, users.payouts_enabled,
            COALESCE(profile.background_check_valid, FALSE) AS background_check_valid,
            profile.background_check_expires_at,
            profile.background_check_environment,
            COALESCE(profile.background_check_is_test, FALSE) AS background_check_is_test,
            EXISTS (
              SELECT 1
              FROM background_checks background
              WHERE background.id = profile.background_check_source_id
                AND background.user_id = users.id
                AND background.status = 'CLEAR'
                AND (background.expires_at IS NULL OR background.expires_at > NOW())
                AND background.provider_environment = profile.background_check_environment
                AND background.is_test = profile.background_check_is_test
            ) AS background_check_source_ready,
            EXISTS (
              SELECT 1 FROM hxos_local_test_payout_destinations destination
              WHERE destination.worker_id = users.id
                AND destination.status = 'ACTIVE'
                AND destination.is_test IS TRUE
            ) AS local_test_payout_ready
     FROM users
     LEFT JOIN capability_profiles profile ON profile.user_id = users.id
     WHERE users.id = $1
     FOR UPDATE OF users`,
    [hustlerRef],
  );
  const worker = result.rows[0];
  if (!worker || worker.default_mode !== 'worker') {
    return error('HUSTLER_NOT_FOUND', 'Eligible hustler not found.');
  }
  if (worker.is_banned || worker.active_trust_hold || worker.account_status !== 'ACTIVE') {
    return error('HUSTLER_INELIGIBLE', 'Hustler account is not eligible for reservation.');
  }
  if (worker.is_minor) {
    return error('ADULT_AGE_REQUIRED', 'Hustler must be at least 18 years old for reservation.');
  }
  const localTestPayoutReady = task.automation_classification === 'CONTROLLED_TEST'
    && localCertificationPayoutEnabled()
    && worker.local_test_payout_ready === true;
  if ((!worker.stripe_connect_id || !worker.payouts_enabled) && !localTestPayoutReady) {
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

function validateScreeningPolicy(
  task: TaskReservationRow,
  worker: WorkerReservationRow,
): ReservationError | null {
  const screeningRequired = task.background_check_required || task.price > 50000;
  if (!screeningRequired) return null;
  const current = worker.background_check_valid === true
    && worker.background_check_source_ready === true
    && (
      worker.background_check_expires_at == null
      || new Date(worker.background_check_expires_at).getTime() > Date.now()
    );
  if (!current) {
    return error(
      'BACKGROUND_CHECK_REQUIRED',
      'Task policy requires a current clear background check.',
    );
  }
  if (worker.background_check_is_test) {
    if (task.automation_classification !== 'CONTROLLED_TEST') {
      return error(
        'TEST_SCREENING_PRODUCTION_FORBIDDEN',
        'Controlled-TEST screening cannot authorize production work.',
      );
    }
    if (
      worker.background_check_environment !== 'CONTROLLED_TEST'
      || !localCertificationScreeningEnabled()
    ) {
      return error(
        'LOCAL_TEST_SCREENING_REQUIRED',
        'Controlled-TEST screening evidence is not enabled or valid.',
      );
    }
    return null;
  }
  return worker.background_check_environment === 'PRODUCTION'
    ? null
    : error('BACKGROUND_CHECK_REQUIRED', 'Production screening provenance is invalid.');
}

function validateLiquidityPolicy(task: TaskReservationRow): ReservationError | null {
  if (!task.liquidity_cell_id) {
    return error('LIQUIDITY_CELL_REQUIRED', 'Task requires an authoritative liquidity cell before reservation.');
  }
  if (task.automation_classification === 'CONTROLLED_TEST') {
    if (
      task.liquidity_environment !== 'CONTROLLED_TEST'
      || task.liquidity_is_test !== true
      || task.local_test_liquidity_ready !== true
      || !controlledTestLiquidityEnabled()
    ) {
      return error(
        'LOCAL_TEST_LIQUIDITY_REQUIRED',
        'Controlled TEST reservation requires a current matching TEST liquidity witness.',
      );
    }
    return null;
  }
  if (
    task.automation_classification !== 'PRODUCTION'
    || task.liquidity_environment !== 'PRODUCTION'
    || task.liquidity_is_test !== false
  ) {
    return error(
      'TEST_LIQUIDITY_PRODUCTION_FORBIDDEN',
      'TEST or unclassified liquidity cannot authorize production reservation.',
    );
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
  return null;
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
        const workerResult = await loadWorkerForReservation(
          query,
          params.hustlerRef,
          taskResult.task,
        );
        if (workerResult.kind === 'error') return workerResult;

        if (
          taskResult.task.automation_classification === 'CONTROLLED_TEST'
          && localCertificationPayoutEnabled()
          && workerResult.worker.local_test_payout_ready === true
          && (!workerResult.worker.stripe_connect_id || !workerResult.worker.payouts_enabled)
        ) {
          await query(
            `SELECT set_config('hustlexp.local_test_payout_enabled', 'true', true)`,
          );
        }

        const liquidityError = validateLiquidityPolicy(taskResult.task);
        if (liquidityError) return liquidityError;
        if (
          taskResult.task.automation_classification === 'CONTROLLED_TEST'
          && taskResult.task.local_test_liquidity_ready === true
          && controlledTestLiquidityEnabled()
        ) {
          await query(
            `SELECT set_config('hustlexp.local_test_liquidity_enabled', 'true', true)`,
          );
        }

        const trustError = validateTrustPolicy(taskResult.task, workerResult.worker);
        if (trustError) return trustError;
        const screeningError = validateScreeningPolicy(taskResult.task, workerResult.worker);
        if (screeningError) return screeningError;
        if (
          (taskResult.task.background_check_required || taskResult.task.price > 50000)
          && workerResult.worker.background_check_is_test
          && taskResult.task.automation_classification === 'CONTROLLED_TEST'
          && localCertificationScreeningEnabled()
        ) {
          await query(
            `SELECT set_config('hustlexp.local_test_screening_enabled', 'true', true)`,
          );
        }
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
