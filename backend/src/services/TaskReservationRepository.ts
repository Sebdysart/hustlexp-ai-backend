import { createHash } from 'node:crypto';
import type { QueryFn } from '../db.js';
import { localCertificationPayoutEnabled } from './LocalCertificationPayoutProvider.js';
import {
  reservationError,
  type ReservationError,
  type ReservationSuccess,
  type ReserveTaskParams,
  type TaskReservationRow,
  type WorkerReservationRow,
} from './TaskReservationTypes.js';

interface ExistingRequestRow {
  request_hash: string;
  reservation_id: string;
}

export function buildReservationRequestHash(params: ReserveTaskParams): string {
  const payload = params.serviceBusiness
    ? {
        engineTaskId: params.engineTaskId,
        hustlerRef: params.hustlerRef,
        serviceBusiness: params.serviceBusiness,
      }
    : { engineTaskId: params.engineTaskId, hustlerRef: params.hustlerRef };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export async function findExistingReservation(
  query: QueryFn,
  params: ReserveTaskParams,
  requestHash: string,
): Promise<ReservationError | ReservationSuccess | null> {
  const result = await query<ExistingRequestRow>(
    `SELECT rr.request_hash,rr.reservation_id
       FROM task_reservation_requests rr
       JOIN task_reservations reservation ON reservation.id=rr.reservation_id
      WHERE rr.idempotency_key=$1`,
    [params.idempotencyKey],
  );
  const existing = result.rows[0];
  if (!existing) return null;
  return existing.request_hash === requestHash
    ? { kind: 'success', reservationId: existing.reservation_id, replayed: true }
    : reservationError(
        'IDEMPOTENCY_CONFLICT',
        'Idempotency key was already used for a different reservation.',
        { reservationId: existing.reservation_id },
      );
}

async function fetchTaskForReservation(
  query: QueryFn,
  params: ReserveTaskParams,
): Promise<TaskReservationRow | undefined> {
  const business = params.serviceBusiness ?? {
    offerDecisionId: null,
    organizationId: null,
    serviceProfileId: null,
    crewAssignmentId: null,
  };
  const result = await query<TaskReservationRow>(
    `SELECT task.id,task.state,task.worker_id,task.poster_id,task.risk_level,task.price,
            task.sensitive,task.trust_tier_required,task.automation_classification,
            task.background_check_required,task.liquidity_cell_id,
            (SELECT cell.environment FROM zone_category_cells cell
              WHERE cell.id=task.liquidity_cell_id) AS liquidity_environment,
            (SELECT cell.is_test FROM zone_category_cells cell
              WHERE cell.id=task.liquidity_cell_id) AS liquidity_is_test,
            COALESCE(hxos_local_test_liquidity_witness_current_v2(task.id,$2,task.liquidity_cell_id),FALSE)
              AS local_test_liquidity_ready,
            EXISTS (
              SELECT 1 FROM worker_offer_decisions offer
               WHERE offer.task_id=task.id AND offer.worker_id=$2
                 AND offer.decision_ready IS TRUE AND offer.expires_at>NOW()
                 AND offer.customer_total_cents=task.price
                 AND offer.payout_cents IS NOT DISTINCT FROM task.hustler_payout_cents
                 AND offer.scope_hash IS NOT DISTINCT FROM task.scope_hash
                 AND offer.cancellation_policy_version IS NOT DISTINCT FROM task.cancellation_policy_version
                 AND offer.estimated_duration_minutes IS NOT DISTINCT FROM task.estimated_duration_minutes
                 AND (($3::UUID IS NULL AND offer.provider_organization_id IS NULL
                       AND (task.automation_classification<>'CONTROLLED_TEST'
                         OR hxos_local_test_offer_action_current(task.id,$2,offer.id,'ACCEPTED')))
                   OR ($3::UUID IS NOT NULL AND offer.id=$3
                       AND offer.provider_organization_id=$4
                       AND offer.provider_service_profile_id=$5
                       AND offer.provider_crew_assignment_id=$6))
            ) AS offer_decision_ready,
            (SELECT escrow.state FROM escrows escrow WHERE escrow.task_id=task.id
              ORDER BY escrow.created_at DESC LIMIT 1) AS escrow_state
       FROM tasks task WHERE task.id=$1 FOR UPDATE`,
    [params.engineTaskId,params.hustlerRef,business.offerDecisionId,
      business.organizationId,business.serviceProfileId,business.crewAssignmentId],
  );
  return result.rows[0];
}

function validateTaskForReservation(
  task: TaskReservationRow | undefined,
  params: ReserveTaskParams,
): TaskReservationRow | ReservationError {
  if (!task) return reservationError('NOT_FOUND', 'Engine task not found.');
  const availableState = ['OPEN','MATCHING'].includes(task.state);
  if (!availableState || task.worker_id) {
    return reservationError('RESERVATION_CONFLICT', 'Task is no longer available for reservation.', {
      taskState: task.state,
    });
  }
  if (task.escrow_state !== 'FUNDED') {
    return reservationError('TASK_NOT_FUNDED', 'Task must be funded before reservation.');
  }
  if (task.poster_id === params.hustlerRef) {
    return reservationError('SELF_ASSIGNMENT_FORBIDDEN', 'A poster cannot be reserved for their own task.');
  }
  return task.offer_decision_ready
    ? task
    : reservationError(
        'WORKER_OFFER_REQUIRED',
        'The worker or Service Business must review a current complete offer before reservation.',
      );
}

export async function loadTaskForReservation(
  query: QueryFn,
  params: ReserveTaskParams,
): Promise<TaskReservationRow | ReservationError> {
  return validateTaskForReservation(await fetchTaskForReservation(query,params),params);
}

async function fetchWorkerForReservation(
  query: QueryFn,
  hustlerRef: string,
): Promise<WorkerReservationRow | undefined> {
  const result = await query<WorkerReservationRow>(
    `SELECT users.id,users.default_mode,users.trust_tier,users.trust_hold,
            COALESCE(users.trust_hold AND (users.trust_hold_until IS NULL OR users.trust_hold_until>NOW()),FALSE)
              AS active_trust_hold,
            users.is_banned,users.is_minor,users.account_status,users.plan,
            users.stripe_connect_id,users.payouts_enabled,
            COALESCE(profile.background_check_valid,FALSE) AS background_check_valid,
            profile.background_check_expires_at,profile.background_check_environment,
            COALESCE(profile.background_check_is_test,FALSE) AS background_check_is_test,
            EXISTS (SELECT 1 FROM background_checks background
              WHERE background.id=profile.background_check_source_id AND background.user_id=users.id
                AND background.status='CLEAR'
                AND (background.expires_at IS NULL OR background.expires_at>NOW())
                AND background.provider_environment=profile.background_check_environment
                AND background.is_test=profile.background_check_is_test) AS background_check_source_ready,
            EXISTS (SELECT 1 FROM hxos_local_test_payout_destinations destination
              WHERE destination.worker_id=users.id AND destination.status='ACTIVE'
                AND destination.is_test IS TRUE) AS local_test_payout_ready
       FROM users LEFT JOIN capability_profiles profile ON profile.user_id=users.id
      WHERE users.id=$1 FOR UPDATE OF users`,
    [hustlerRef],
  );
  return result.rows[0];
}

function workerAccountError(
  worker: WorkerReservationRow | undefined,
): ReservationError | null {
  if (!worker || worker.default_mode !== 'worker') {
    return reservationError('HUSTLER_NOT_FOUND', 'Eligible fulfiller not found.');
  }
  if (worker.is_banned) {
    return reservationError('HUSTLER_INELIGIBLE', 'Fulfiller account is not eligible for reservation.');
  }
  if (worker.active_trust_hold) {
    return reservationError('HUSTLER_INELIGIBLE', 'Fulfiller account is not eligible for reservation.');
  }
  if (worker.account_status !== 'ACTIVE') {
    return reservationError('HUSTLER_INELIGIBLE', 'Fulfiller account is not eligible for reservation.');
  }
  if (worker.is_minor) {
    return reservationError('ADULT_AGE_REQUIRED', 'Fulfiller must be at least 18 years old for reservation.');
  }
  return null;
}

function localTestPayoutReady(
  worker: WorkerReservationRow,
  task: TaskReservationRow,
): boolean {
  if (task.automation_classification !== 'CONTROLLED_TEST') return false;
  if (!localCertificationPayoutEnabled()) return false;
  return worker.local_test_payout_ready === true;
}

function payoutError(
  worker: WorkerReservationRow,
  params: ReserveTaskParams,
  task: TaskReservationRow,
): ReservationError | null {
  if (params.serviceBusiness) return null;
  if (worker.stripe_connect_id && worker.payouts_enabled) return null;
  if (localTestPayoutReady(worker,task)) return null;
  return reservationError(
    'PAYOUT_ACCOUNT_REQUIRED',
    'Hustler must complete payout onboarding before reservation.',
  );
}

function validateWorkerForReservation(
  worker: WorkerReservationRow | undefined,
  params: ReserveTaskParams,
  task: TaskReservationRow,
): WorkerReservationRow | ReservationError {
  const accountError = workerAccountError(worker);
  if (accountError) return accountError;
  const eligibleWorker = worker as WorkerReservationRow;
  return payoutError(eligibleWorker,params,task) ?? eligibleWorker;
}

export async function loadWorkerForReservation(
  query: QueryFn,
  params: ReserveTaskParams,
  task: TaskReservationRow,
): Promise<WorkerReservationRow | ReservationError> {
  const worker = await fetchWorkerForReservation(query,params.hustlerRef);
  return validateWorkerForReservation(worker,params,task);
}

export async function validateNoActiveCommitment(
  query: QueryFn,
  params: ReserveTaskParams,
): Promise<ReservationError | null> {
  const result = await query<{ id: string }>(
    `SELECT id FROM tasks WHERE worker_id=$1 AND id<>$2
      AND state IN ('ACCEPTED','PROOF_SUBMITTED','DISPUTED') LIMIT 1`,
    [params.hustlerRef,params.engineTaskId],
  );
  return result.rows[0]
    ? reservationError('HUSTLER_ALREADY_COMMITTED', 'Fulfiller already has an active task.', {
        conflictingTaskId: result.rows[0].id,
      })
    : null;
}

async function insertReservationWitness(
  query: QueryFn,
  params: ReserveTaskParams,
  requestHash: string,
): Promise<ReservationSuccess> {
  const reservation = await query<{ id: string }>(
    `INSERT INTO task_reservations(task_id,hustler_id,status,reserved_by)
     VALUES ($1,$2,'ACTIVE',$3) RETURNING id`,
    [params.engineTaskId,params.hustlerRef,params.actorId],
  );
  const reservationId = reservation.rows[0].id;
  await query(
    `INSERT INTO task_reservation_requests(
       idempotency_key,request_hash,task_id,hustler_id,reservation_id,requested_by
     ) VALUES ($1,$2,$3,$4,$5,$6)`,
    [params.idempotencyKey,requestHash,params.engineTaskId,params.hustlerRef,reservationId,params.actorId],
  );
  return { kind: 'success', reservationId, replayed: false };
}

export async function commitReservation(
  query: QueryFn,
  params: ReserveTaskParams,
  requestHash: string,
): Promise<ReservationSuccess | ReservationError> {
  const business = params.serviceBusiness;
  if (business) {
    const assignment = await query<{ assignment_id: string; fulfiller_user_id: string }>(
      `SELECT assignment_id,fulfiller_user_id,payout_recipient_user_id
         FROM commit_service_business_task_assignment($1,$2,$3,$4,$5,$6,$7,$8)`,
      [params.engineTaskId,business.organizationId,params.actorId,business.serviceProfileId,
        business.crewAssignmentId,business.offerDecisionId,params.idempotencyKey,requestHash],
    );
    const assigned = assignment.rows[0];
    if (!assigned || assigned.fulfiller_user_id !== params.hustlerRef) {
      return reservationError('SERVICE_BUSINESS_ASSIGNMENT_FAILED', 'The verified crew assignment was not committed.');
    }
    const witness = await insertReservationWitness(query,params,requestHash);
    await query(
      `SELECT event_id,replayed FROM record_business_service_offer_response(
        $1,$2,$3,'ACCEPTED',$4,$5,$6::JSONB)`,
      [business.offerDecisionId,business.organizationId,params.actorId,params.idempotencyKey,
        requestHash,JSON.stringify({ assignmentId: assigned.assignment_id, reservationId: witness.reservationId })],
    );
    return witness;
  }
  const taskUpdate = await query(
    `UPDATE tasks SET state = 'ACCEPTED',progress_state='ACCEPTED',progress_updated_at=NOW(),
       progress_by=NULL,worker_id=$2,accepted_at=NOW(),updated_at=NOW()
     WHERE id=$1 AND state IN ('OPEN','MATCHING') AND worker_id IS NULL RETURNING id`,
    [params.engineTaskId,params.hustlerRef],
  );
  return (taskUpdate.rowCount ?? 0) === 0
    ? reservationError('RESERVATION_CONFLICT', 'Concurrent reservation won before this request.')
    : insertReservationWitness(query,params,requestHash);
}
