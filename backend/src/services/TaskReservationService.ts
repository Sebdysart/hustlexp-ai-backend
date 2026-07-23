import { db, type QueryFn } from '../db.js';
import { logger } from '../logger.js';
import type { ServiceResult } from '../types.js';
import { controlledTestLiquidityEnabled } from './ControlledTestLiquidityService.js';
import { localCertificationPayoutEnabled } from './LocalCertificationPayoutProvider.js';
import { localCertificationScreeningEnabled } from './LocalCertificationScreeningProvider.js';
import {
  buildReservationRequestHash,
  commitReservation,
  findExistingReservation,
  loadTaskForReservation,
  loadWorkerForReservation,
  validateNoActiveCommitment,
} from './TaskReservationRepository.js';
import {
  validateEntitlements,
  validateLiquidityPolicy,
  validateScreeningPolicy,
  validateTrustPolicy,
} from './TaskReservationPolicy.js';
import {
  reservationError,
  type EngineReservationResult,
  type ReservationError,
  type ReservationSuccess,
  type ReserveTaskParams,
  type TaskReservationRow,
  type WorkerReservationRow,
} from './TaskReservationTypes.js';

export { buildReservationRequestHash } from './TaskReservationRepository.js';
export type {
  EngineReservationResult,
  ReserveTaskParams,
  ServiceBusinessReservationContext,
} from './TaskReservationTypes.js';

const log = logger.child({ module: 'task', service: 'TaskReservationService' });

interface BusinessEvaluation {
  ready: boolean;
  blockers: string[];
  payout_recipient_user_id: string;
  fulfiller_user_id: string;
}

async function validateServiceBusiness(
  query: QueryFn,
  params: ReserveTaskParams,
): Promise<ReservationError | null> {
  const business = params.serviceBusiness;
  if (!business) return null;
  const result = await query<BusinessEvaluation>(
    `SELECT ready,blockers,payout_recipient_user_id,fulfiller_user_id
       FROM evaluate_service_business_assignment($1,$2,$3,$4,$5,$6)`,
    [business.organizationId,params.actorId,business.serviceProfileId,
      business.crewAssignmentId,params.engineTaskId,business.offerDecisionId],
  );
  const evaluation = result.rows[0];
  if (!evaluation || !evaluation.ready) {
    return reservationError(
      'SERVICE_BUSINESS_INELIGIBLE',
      'Resolve Service Business assignment requirements before accepting.',
      { blockers: evaluation?.blockers ?? ['ASSIGNMENT_EVIDENCE_MISSING'] },
    );
  }
  return evaluation.fulfiller_user_id === params.hustlerRef
    ? null
    : reservationError(
        'SERVICE_BUSINESS_FULFILLER_MISMATCH',
        'The selected fulfiller no longer matches the verified crew assignment.',
      );
}

async function enableControlledTestPayout(
  query: QueryFn,
  task: TaskReservationRow,
  worker: WorkerReservationRow,
  params: ReserveTaskParams,
): Promise<void> {
  if (params.serviceBusiness || task.automation_classification !== 'CONTROLLED_TEST') return;
  const destinationMissing = !worker.stripe_connect_id || !worker.payouts_enabled;
  if (localCertificationPayoutEnabled() && worker.local_test_payout_ready && destinationMissing) {
    await query(`SELECT set_config('hustlexp.local_test_payout_enabled', 'true', true)`);
  }
}

async function enableControlledTestLiquidity(
  query: QueryFn,
  task: TaskReservationRow,
): Promise<void> {
  if (task.automation_classification !== 'CONTROLLED_TEST') return;
  if (task.local_test_liquidity_ready && controlledTestLiquidityEnabled()) {
    await query(`SELECT set_config('hustlexp.local_test_liquidity_enabled', 'true', true)`);
  }
}

async function enableControlledTestScreening(
  query: QueryFn,
  task: TaskReservationRow,
  worker: WorkerReservationRow,
): Promise<void> {
  if (task.automation_classification !== 'CONTROLLED_TEST') return;
  const screeningRequired = task.background_check_required || task.price > 50000;
  if (screeningRequired && worker.background_check_is_test && localCertificationScreeningEnabled()) {
    await query(`SELECT set_config('hustlexp.local_test_screening_enabled', 'true', true)`);
  }
}

async function enableControlledTestEvidence(
  query: QueryFn,
  task: TaskReservationRow,
  worker: WorkerReservationRow,
  params: ReserveTaskParams,
): Promise<void> {
  await enableControlledTestPayout(query,task,worker,params);
  await enableControlledTestLiquidity(query,task);
  await enableControlledTestScreening(query,task,worker);
}

async function reserveTransaction(
  query: QueryFn,
  params: ReserveTaskParams,
  requestHash: string,
): Promise<ReservationError | ReservationSuccess> {
  await query(
    `SELECT pg_advisory_xact_lock(hashtext('task-reservation'),hashtext($1))`,
    [params.idempotencyKey],
  );
  const existing = await findExistingReservation(query,params,requestHash);
  if (existing) return existing;
  const task = await loadTaskForReservation(query,params);
  if ('kind' in task) return task;
  const worker = await loadWorkerForReservation(query,params,task);
  if ('kind' in worker) return worker;
  await enableControlledTestEvidence(query,task,worker,params);
  const liquidityError = validateLiquidityPolicy(task);
  if (liquidityError) return liquidityError;
  const trustError = validateTrustPolicy(task,worker);
  if (trustError) return trustError;
  const screeningError = validateScreeningPolicy(task,worker);
  if (screeningError) return screeningError;
  const entitlementError = await validateEntitlements(query,task,worker,params.hustlerRef);
  if (entitlementError) return entitlementError;
  const businessError = await validateServiceBusiness(query,params);
  if (businessError) return businessError;
  const activeConflict = await validateNoActiveCommitment(query,params);
  if (activeConflict) return activeConflict;
  return commitReservation(query,params,requestHash);
}

function denied(
  params: ReserveTaskParams,
  outcome: ReservationError,
): ServiceResult<EngineReservationResult> {
  log.warn({
    engineTaskId: params.engineTaskId,
    hustlerRef: params.hustlerRef,
    actorId: params.actorId,
    providerOrganizationId: params.serviceBusiness?.organizationId,
    code: outcome.code,
  }, 'Engine reservation denied');
  return {
    success: false,
    error: { code: outcome.code, message: outcome.message, details: outcome.details },
  };
}

export const TaskReservationService = {
  reserve: async (params: ReserveTaskParams): Promise<ServiceResult<EngineReservationResult>> => {
    const requestHash = buildReservationRequestHash(params);
    try {
      const outcome = await db.transaction((query) => reserveTransaction(query,params,requestHash));
      if (outcome.kind === 'error') return denied(params,outcome);
      log.info({
        engineTaskId: params.engineTaskId,
        hustlerRef: params.hustlerRef,
        actorId: params.actorId,
        providerOrganizationId: params.serviceBusiness?.organizationId,
        reservationId: outcome.reservationId,
        idempotencyReplayed: outcome.replayed,
      }, 'Engine reservation committed');
      return { success: true, data: {
        reservationId: outcome.reservationId,
        engineTaskId: params.engineTaskId,
        hustlerRef: params.hustlerRef,
        state: 'ENGINE_RESERVED',
        idempotencyReplayed: outcome.replayed,
      } };
    } catch (cause) {
      log.error({
        engineTaskId: params.engineTaskId,
        hustlerRef: params.hustlerRef,
        actorId: params.actorId,
        providerOrganizationId: params.serviceBusiness?.organizationId,
        err: cause instanceof Error ? cause.message : String(cause),
      }, 'Engine reservation failed');
      return {
        success: false,
        error: { code: 'DB_ERROR', message: 'A database error occurred. Please try again.' },
      };
    }
  },
};
