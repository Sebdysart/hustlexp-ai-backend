import type { QueryFn } from '../db.js';
import { controlledTestLiquidityEnabled } from './ControlledTestLiquidityService.js';
import { localCertificationScreeningEnabled } from './LocalCertificationScreeningProvider.js';
import {
  reservationError,
  type ReservationError,
  type TaskReservationRow,
  type WorkerReservationRow,
} from './TaskReservationTypes.js';

function requiredTrustTier(task: TaskReservationRow): number | null {
  if (task.risk_level === 'IN_HOME') return null;
  const riskFloor = task.risk_level === 'HIGH' ? 3 : task.risk_level === 'MEDIUM' ? 2 : 1;
  return Math.max(task.trust_tier_required ?? 1, riskFloor, task.sensitive ? 3 : 1);
}

export function validateTrustPolicy(
  task: TaskReservationRow,
  worker: WorkerReservationRow,
): ReservationError | null {
  const requiredTier = requiredTrustTier(task);
  if (requiredTier === null) {
    return reservationError('TASK_RISK_BLOCKED', 'In-home tasks are not eligible for automated reservation.');
  }
  return worker.trust_tier < requiredTier
    ? reservationError('TRUST_TIER_INSUFFICIENT', 'Hustler trust tier does not meet task policy.', {
        requiredTier,
        workerTier: worker.trust_tier,
      })
    : null;
}

export function validateScreeningPolicy(
  task: TaskReservationRow,
  worker: WorkerReservationRow,
): ReservationError | null {
  const required = task.background_check_required ? true : task.price > 50000;
  if (!required) return null;
  if (!screeningIsCurrent(worker)) {
    return reservationError('BACKGROUND_CHECK_REQUIRED', 'Task policy requires a current clear background check.');
  }
  if (worker.background_check_is_test) return validateTestScreening(task,worker);
  return worker.background_check_environment === 'PRODUCTION'
    ? null
    : reservationError('BACKGROUND_CHECK_REQUIRED', 'Production screening provenance is invalid.');
}

function screeningIsCurrent(worker: WorkerReservationRow): boolean {
  if (!worker.background_check_valid) return false;
  if (!worker.background_check_source_ready) return false;
  if (worker.background_check_expires_at == null) return true;
  return new Date(worker.background_check_expires_at).getTime() > Date.now();
}

function validateTestScreening(
  task: TaskReservationRow,
  worker: WorkerReservationRow,
): ReservationError | null {
  if (task.automation_classification !== 'CONTROLLED_TEST') {
    return reservationError(
      'TEST_SCREENING_PRODUCTION_FORBIDDEN',
      'Controlled-TEST screening cannot authorize production work.',
    );
  }
  if (worker.background_check_environment !== 'CONTROLLED_TEST') {
    return reservationError('LOCAL_TEST_SCREENING_REQUIRED', 'Controlled-TEST screening provenance is invalid.');
  }
  return localCertificationScreeningEnabled()
    ? null
    : reservationError(
        'LOCAL_TEST_SCREENING_REQUIRED',
        'Controlled-TEST screening evidence is not enabled or valid.',
      );
}

export function validateLiquidityPolicy(task: TaskReservationRow): ReservationError | null {
  if (!task.liquidity_cell_id) {
    return reservationError(
      'LIQUIDITY_CELL_REQUIRED',
      'Task requires an authoritative liquidity cell before reservation.',
    );
  }
  if (task.automation_classification === 'CONTROLLED_TEST') {
    const ready = task.liquidity_environment === 'CONTROLLED_TEST'
      && task.liquidity_is_test === true
      && task.local_test_liquidity_ready === true
      && controlledTestLiquidityEnabled();
    return ready ? null : reservationError(
      'LOCAL_TEST_LIQUIDITY_REQUIRED',
      'Controlled TEST reservation requires a current matching TEST liquidity witness.',
    );
  }
  const production = task.automation_classification === 'PRODUCTION'
    && task.liquidity_environment === 'PRODUCTION'
    && task.liquidity_is_test === false;
  return production ? null : reservationError(
    'TEST_LIQUIDITY_PRODUCTION_FORBIDDEN',
    'TEST or unclassified liquidity cannot authorize production reservation.',
  );
}

export async function validateEntitlements(
  query: QueryFn,
  task: TaskReservationRow,
  worker: WorkerReservationRow,
  hustlerRef: string,
): Promise<ReservationError | null> {
  if (task.risk_level !== 'HIGH' || worker.plan === 'pro') return null;
  const entitlement = await query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM plan_entitlements
       WHERE user_id = $1 AND risk_level = 'HIGH' AND expires_at > NOW()
     ) AS exists`,
    [hustlerRef],
  );
  return entitlement.rows[0]?.exists
    ? null
    : reservationError('PLAN_REQUIRED', 'High-risk tasks require a Pro plan or active entitlement.');
}
