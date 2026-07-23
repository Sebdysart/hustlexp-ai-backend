import { createHash } from 'node:crypto';
import { db, type QueryFn } from '../db.js';
import type { ServiceResult, Task } from '../types.js';
import { TaskCreateService } from './TaskCreateService.js';
import {
  buildScopeChecklist,
  buildTaskScopeHash,
  type TaskRiskLevel,
} from './TaskServiceShared.js';
import {
  buildWorkerCounterCorridor,
  evaluateWorkerCounter,
  WORKER_COUNTER_LIMITS,
  WORKER_COUNTER_POLICY_VERSION,
  type WorkerCounterCorridor,
} from './WorkerCounterOfferPolicy.js';

type CounterStatus = 'PENDING_POSTER' | 'REJECTED' | 'APPROVED_REAUTH_REQUIRED' | 'MATERIALIZED' | 'EXPIRED';

interface CounterRow {
  id: string;
  task_id: string;
  worker_id: string;
  offer_decision_id: string;
  source_scope_version_id: string;
  proposed_scope_hash: string;
  policy_version: string;
  request_hash: string;
  idempotency_key: string;
  status: CounterStatus;
  current_customer_total_cents: number;
  current_payout_cents: number;
  platform_margin_cents: number;
  minimum_counter_payout_cents: number;
  maximum_counter_payout_cents: number;
  customer_maximum_cents: number;
  margin_floor_bps: number;
  proposed_payout_cents: number;
  proposed_customer_total_cents: number;
  reason: string;
  reviewed_by: string | null;
  review_reason: string | null;
  reviewed_at: string | Date | null;
  replacement_task_id: string | null;
  expires_at: string | Date;
}

interface CounterTaskRow {
  id: string;
  poster_id: string;
  state: string;
  title: string;
  description: string;
  requirements: string | null;
  price: number;
  hustler_payout_cents: number | null;
  platform_margin_cents: number | null;
  scope_hash: string | null;
  active_scope_version_id: string | null;
  clarification_state: string | null;
}

interface CounterOfferRow {
  id: string;
  customer_total_cents: number;
  payout_cents: number;
  scope_hash: string;
  expires_at: string | Date;
}

interface ScopeRow {
  id: string;
  checklist: string[];
}

interface CounterSourceRow {
  id: string;
  poster_id: string;
  state: string;
  title: string;
  description: string;
  requirements: string | null;
  price: number;
  hustler_payout_cents: number | null;
  platform_margin_cents: number | null;
  rough_location: string | null;
  category: string | null;
  trade_type: string | null;
  requires_proof: boolean;
  risk_level: TaskRiskLevel;
  template_slug: string | null;
  estimated_duration_minutes: number | null;
  required_tools: string[] | null;
  region_code: string | null;
  automation_classification: 'PRODUCTION' | 'CONTROLLED_TEST';
  checklist: string[];
}

interface CounterEventRow {
  event_type: string;
  request_hash: string;
}

export interface WorkerCounterOfferResult {
  id: string;
  taskId: string;
  workerId: string;
  status: CounterStatus;
  currentCustomerTotalCents: number;
  currentPayoutCents: number;
  platformMarginCents: number;
  minimumCounterPayoutCents: number;
  maximumCounterPayoutCents: number;
  customerMaximumCents: number;
  marginFloorBps: number;
  proposedPayoutCents: number;
  proposedCustomerTotalCents: number;
  reason: string;
  replacementTaskId: string | null;
  expiresAt: string;
  requiresPaymentReauthorization: boolean;
  replayed: boolean;
}

export interface WorkerCounterContext {
  corridor: WorkerCounterCorridor | null;
  activeCounter: WorkerCounterOfferResult | null;
  counterOffers: WorkerCounterOfferResult[];
  viewerRole: 'POSTER' | 'ELIGIBLE_CANDIDATE';
}

class CounterFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function fail(code: string, message: string): never {
  throw new CounterFailure(code, message);
}

function failure<T>(error: unknown): ServiceResult<T> {
  if (error instanceof CounterFailure) return { success: false, error: { code: error.code, message: error.message } };
  return { success: false, error: { code: 'DB_ERROR', message: 'The worker counter could not be persisted safely.' } };
}

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

function result(row: CounterRow, replayed: boolean): WorkerCounterOfferResult {
  return {
    id: row.id,
    taskId: row.task_id,
    workerId: row.worker_id,
    status: row.status,
    currentCustomerTotalCents: Number(row.current_customer_total_cents),
    currentPayoutCents: Number(row.current_payout_cents),
    platformMarginCents: Number(row.platform_margin_cents),
    minimumCounterPayoutCents: Number(row.minimum_counter_payout_cents),
    maximumCounterPayoutCents: Number(row.maximum_counter_payout_cents),
    customerMaximumCents: Number(row.customer_maximum_cents),
    marginFloorBps: Number(row.margin_floor_bps),
    proposedPayoutCents: Number(row.proposed_payout_cents),
    proposedCustomerTotalCents: Number(row.proposed_customer_total_cents),
    reason: row.reason,
    replacementTaskId: row.replacement_task_id,
    expiresAt: iso(row.expires_at),
    requiresPaymentReauthorization: ['APPROVED_REAUTH_REQUIRED', 'MATERIALIZED'].includes(row.status),
    replayed,
  };
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizedReason(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

function validKey(value: string): boolean {
  return value.length >= 8 && value.length <= 128;
}

async function priorEvent(query: QueryFn, actorId: string, idempotencyKey: string, requestHash: string) {
  const prior = await query<CounterEventRow>(
    `SELECT event_type,request_hash FROM worker_counter_offer_events
      WHERE actor_id=$1 AND idempotency_key=$2`,
    [actorId, idempotencyKey],
  );
  if (prior.rows[0] && prior.rows[0].request_hash !== requestHash) {
    fail('CONFLICT', 'This counter idempotency key was already used with a different payload.');
  }
  return prior.rows[0];
}

async function appendEvent(query: QueryFn, input: {
  counterId: string;
  eventType: 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'MATERIALIZED';
  actorId: string;
  idempotencyKey: string;
  requestHash: string;
  details?: Record<string, unknown>;
}) {
  await query(
    `INSERT INTO worker_counter_offer_events
       (counter_offer_id,event_type,actor_id,idempotency_key,request_hash,details)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [input.counterId, input.eventType, input.actorId, input.idempotencyKey,
      input.requestHash, JSON.stringify(input.details ?? {})],
  );
}

async function submit(params: {
  taskId: string;
  workerId: string;
  proposedPayoutCents: number;
  reason: string;
  idempotencyKey: string;
}): Promise<ServiceResult<WorkerCounterOfferResult>> {
  const reason = normalizedReason(params.reason);
  if (!validKey(params.idempotencyKey) || reason.length < 10 || reason.length > 500
      || !Number.isInteger(params.proposedPayoutCents)) {
    return { success: false, error: { code: 'INVALID_INPUT', message: 'A valid bounded payout, reason, and idempotency key are required.' } };
  }
  const requestHash = hash({
    action: 'SUBMITTED', taskId: params.taskId, workerId: params.workerId,
    proposedPayoutCents: params.proposedPayoutCents, reason,
  });
  try {
    const data = await db.transaction(async (query) => {
      await query('SELECT pg_advisory_xact_lock(hashtext($1))', [`worker-counter:${params.taskId}:${params.workerId}`]);
      const replay = await query<CounterRow>(
        `SELECT * FROM worker_counter_offers WHERE worker_id=$1 AND idempotency_key=$2`,
        [params.workerId, params.idempotencyKey],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash !== requestHash) fail('CONFLICT', 'Counter replay payload conflicts with the original.');
        return result(replay.rows[0], true);
      }
      const taskResult = await query<CounterTaskRow>(
        `SELECT id,poster_id,state,title,description,requirements,price,hustler_payout_cents,
                platform_margin_cents,scope_hash,active_scope_version_id,clarification_state
           FROM tasks WHERE id=$1 FOR UPDATE`,
        [params.taskId],
      );
      const task = taskResult.rows[0] ?? fail('NOT_FOUND', 'Task not found.');
      if (!['OPEN', 'MATCHING'].includes(task.state) || task.poster_id === params.workerId) {
        fail('INVALID_STATE', 'This task is not open for a worker counter.');
      }
      const authorized = await query<{ id: string }>(
        `SELECT id FROM worker_counter_offers
          WHERE task_id=$1 AND status IN ('APPROVED_REAUTH_REQUIRED','MATERIALIZED')
          LIMIT 1`,
        [task.id],
      );
      if (authorized.rows[0]) {
        fail('COUNTER_ALREADY_AUTHORIZED', 'This task already has an authorized replacement path.');
      }
      const pending = await query<{ id: string }>(
        `SELECT id FROM worker_counter_offers
          WHERE task_id=$1 AND worker_id=$2 AND status='PENDING_POSTER'
          LIMIT 1`,
        [task.id, params.workerId],
      );
      if (pending.rows[0]) {
        fail('COUNTER_ALREADY_PENDING', 'This worker already has a counter awaiting Poster review.');
      }
      if (!task.active_scope_version_id || !task.scope_hash
          || task.hustler_payout_cents == null || task.platform_margin_cents == null) {
        fail('INVALID_STATE', 'The current task has no complete executable offer economics.');
      }
      const escrow = await query<{ state: string }>(
        `SELECT state FROM escrows WHERE task_id=$1 FOR SHARE`, [params.taskId],
      );
      if (escrow.rows[0]?.state !== 'FUNDED') fail('INVALID_STATE', 'A worker counter requires the customer-funded offer.');
      const offerResult = await query<CounterOfferRow>(
        `SELECT id,customer_total_cents,payout_cents,scope_hash,expires_at
           FROM worker_offer_decisions
          WHERE task_id=$1 AND worker_id=$2 AND decision_ready=TRUE AND expires_at>NOW()
            AND customer_total_cents=$3 AND payout_cents=$4 AND scope_hash=$5
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [params.taskId, params.workerId, task.price, task.hustler_payout_cents, task.scope_hash],
      );
      const offer = offerResult.rows[0] ?? fail('FORBIDDEN', 'A current decision-complete offer is required.');
      const scopeResult = await query<ScopeRow>(
        `SELECT id,checklist FROM task_scope_versions WHERE id=$1 AND task_id=$2 FOR SHARE`,
        [task.active_scope_version_id, task.id],
      );
      const scope = scopeResult.rows[0] ?? fail('INVALID_STATE', 'The current scope version is unavailable.');
      const decision = evaluateWorkerCounter({
        customerTotalCents: task.price,
        payoutCents: task.hustler_payout_cents,
        platformMarginCents: task.platform_margin_cents,
        proposedPayoutCents: params.proposedPayoutCents,
      });
      if (!decision.accepted) fail('COUNTER_OUT_OF_BOUNDS', 'The proposed payout is outside the deterministic counter corridor.');
      const proposedScopeHash = buildTaskScopeHash({
        title: task.title,
        description: task.description,
        requirements: task.requirements,
        checklist: scope.checklist,
        customerTotalCents: decision.proposedCustomerTotalCents,
        hustlerPayoutCents: params.proposedPayoutCents,
      });
      const offerExpiry = new Date(offer.expires_at).getTime();
      const expiresAt = new Date(Math.min(
        offerExpiry,
        Date.now() + WORKER_COUNTER_LIMITS.expiresMinutes * 60_000,
      ));
      const inserted = await query<CounterRow>(
        `INSERT INTO worker_counter_offers (
           task_id,worker_id,offer_decision_id,source_scope_version_id,proposed_scope_hash,
           policy_version,request_hash,idempotency_key,status,current_customer_total_cents,
           current_payout_cents,platform_margin_cents,minimum_counter_payout_cents,
           maximum_counter_payout_cents,customer_maximum_cents,margin_floor_bps,
           proposed_payout_cents,proposed_customer_total_cents,reason,expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING_POSTER',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         RETURNING *`,
        [task.id, params.workerId, offer.id, scope.id, proposedScopeHash,
          WORKER_COUNTER_POLICY_VERSION, requestHash, params.idempotencyKey,
          decision.currentCustomerTotalCents, decision.currentPayoutCents,
          decision.platformMarginCents, decision.minimumCounterPayoutCents,
          decision.maximumCounterPayoutCents, decision.customerMaximumCents,
          decision.marginFloorBps, params.proposedPayoutCents,
          decision.proposedCustomerTotalCents, reason, expiresAt.toISOString()],
      );
      const counter = inserted.rows[0] ?? fail('INTERNAL_ERROR', 'Counter was not persisted.');
      await appendEvent(query, {
        counterId: counter.id, eventType: 'SUBMITTED', actorId: params.workerId,
        idempotencyKey: params.idempotencyKey, requestHash,
        details: { proposedPayoutCents: params.proposedPayoutCents },
      });
      return result(counter, false);
    });
    return { success: true, data };
  } catch (error) {
    return failure(error);
  }
}

async function review(params: {
  counterOfferId: string;
  posterId: string;
  decision: 'APPROVED' | 'REJECTED';
  reason: string;
  idempotencyKey: string;
}): Promise<ServiceResult<WorkerCounterOfferResult>> {
  const reason = normalizedReason(params.reason);
  if (!validKey(params.idempotencyKey) || reason.length < 10 || reason.length > 500) {
    return { success: false, error: { code: 'INVALID_INPUT', message: 'A review reason and idempotency key are required.' } };
  }
  const requestHash = hash({ action: params.decision, counterOfferId: params.counterOfferId, posterId: params.posterId, reason });
  try {
    const data = await db.transaction(async (query) => {
      const replay = await priorEvent(query, params.posterId, params.idempotencyKey, requestHash);
      const counterResult = await query<CounterRow>(
        'SELECT * FROM worker_counter_offers WHERE id=$1 FOR UPDATE', [params.counterOfferId],
      );
      let counter = counterResult.rows[0] ?? fail('NOT_FOUND', 'Counter offer not found.');
      const taskResult = await query<CounterTaskRow>(
        `SELECT id,poster_id,state,title,description,requirements,price,hustler_payout_cents,
                platform_margin_cents,scope_hash,active_scope_version_id,clarification_state
           FROM tasks WHERE id=$1 FOR UPDATE`, [counter.task_id],
      );
      const task = taskResult.rows[0] ?? fail('NOT_FOUND', 'Task not found.');
      if (task.poster_id !== params.posterId) fail('FORBIDDEN', 'Only the task Poster can review this counter.');
      if (replay) return result(counter, true);
      if (counter.status !== 'PENDING_POSTER' || new Date(counter.expires_at).getTime() <= Date.now()) {
        fail('INVALID_STATE', 'This counter is no longer pending review.');
      }
      if (!['OPEN', 'MATCHING'].includes(task.state)
          || task.price !== Number(counter.current_customer_total_cents)
          || task.hustler_payout_cents !== Number(counter.current_payout_cents)
          || task.platform_margin_cents !== Number(counter.platform_margin_cents)
          || task.active_scope_version_id !== counter.source_scope_version_id) {
        fail('CONFLICT', 'The task changed after this counter was submitted.');
      }
      if (params.decision === 'APPROVED') {
        const authorized = await query<{ id: string }>(
          `SELECT id FROM worker_counter_offers
            WHERE task_id=$1 AND id<>$2
              AND status IN ('APPROVED_REAUTH_REQUIRED','MATERIALIZED')
            LIMIT 1`,
          [task.id, counter.id],
        );
        if (authorized.rows[0]) {
          fail('COUNTER_ALREADY_AUTHORIZED', 'This task already has an authorized replacement path.');
        }
      }
      const nextStatus = params.decision === 'APPROVED' ? 'APPROVED_REAUTH_REQUIRED' : 'REJECTED';
      const updated = await query<CounterRow>(
        `UPDATE worker_counter_offers SET status=$2,reviewed_by=$3,review_reason=$4,
                reviewed_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *`,
        [counter.id, nextStatus, params.posterId, reason],
      );
      counter = updated.rows[0] ?? fail('INTERNAL_ERROR', 'Counter review was not persisted.');
      await appendEvent(query, {
        counterId: counter.id,
        eventType: params.decision,
        actorId: params.posterId,
        idempotencyKey: params.idempotencyKey,
        requestHash,
        details: { requiresPaymentReauthorization: params.decision === 'APPROVED' },
      });
      return result(counter, false);
    });
    return { success: true, data };
  } catch (error) {
    return failure(error);
  }
}

function optional<T>(value: T | null): T | undefined {
  return value ?? undefined;
}

async function materialize(params: {
  counterOfferId: string;
  posterId: string;
  replacementLocation: string;
  idempotencyKey: string;
}): Promise<ServiceResult<WorkerCounterOfferResult>> {
  const replacementLocation = params.replacementLocation.trim();
  if (!validKey(params.idempotencyKey) || replacementLocation.length < 5 || replacementLocation.length > 500) {
    return { success: false, error: { code: 'INVALID_INPUT', message: 'A fresh service address and materialization idempotency key are required.' } };
  }
  const requestHash = hash({
    action: 'MATERIALIZED', counterOfferId: params.counterOfferId,
    posterId: params.posterId, replacementLocation,
  });
  try {
    const data = await db.transaction(async (query) => {
      const replay = await priorEvent(query, params.posterId, params.idempotencyKey, requestHash);
      const counterResult = await query<CounterRow>(
        'SELECT * FROM worker_counter_offers WHERE id=$1 FOR UPDATE', [params.counterOfferId],
      );
      let counter = counterResult.rows[0] ?? fail('NOT_FOUND', 'Counter offer not found.');
      if (counter.reviewed_by !== params.posterId) fail('FORBIDDEN', 'Only the approving Poster can materialize this counter.');
      if (replay || counter.status === 'MATERIALIZED') return result(counter, true);
      if (counter.status !== 'APPROVED_REAUTH_REQUIRED') fail('INVALID_STATE', 'Counter is not approved for reauthorization.');

      const sourceResult = await query<CounterSourceRow>(
        `SELECT t.id,t.poster_id,t.state,t.title,t.description,t.requirements,t.price,
                t.hustler_payout_cents,t.platform_margin_cents,t.rough_location,t.category,
                t.trade_type,t.requires_proof,t.risk_level,t.template_slug,
                t.estimated_duration_minutes,t.required_tools,t.region_code,
                t.automation_classification,
                s.checklist
           FROM tasks t
           JOIN task_scope_versions s ON s.id=t.active_scope_version_id
          WHERE t.id=$1 FOR UPDATE`,
        [counter.task_id],
      );
      const source = sourceResult.rows[0] ?? fail('NOT_FOUND', 'Counter source task not found.');
      if (source.poster_id !== params.posterId || source.state !== 'CANCELLED') {
        fail('REFUND_REQUIRED', 'Cancel the original task after its provider-confirmed refund.');
      }
      const escrow = await query<{ state: string; stripe_refund_id: string | null }>(
        'SELECT state,stripe_refund_id FROM escrows WHERE task_id=$1 FOR UPDATE', [source.id],
      );
      if (escrow.rows[0]?.state !== 'REFUNDED' || !escrow.rows[0].stripe_refund_id) {
        fail('REFUND_REQUIRED', 'Provider-confirmed refund evidence is required before replacement.');
      }
      const created = await TaskCreateService.createInTransaction(query, {
        posterId: params.posterId,
        title: source.title,
        description: source.description,
        price: Number(counter.proposed_customer_total_cents),
        hustlerPayoutCents: Number(counter.proposed_payout_cents),
        platformMarginCents: Number(counter.platform_margin_cents),
        requirements: optional(source.requirements),
        location: replacementLocation,
        roughArea: optional(source.rough_location),
        regionCode: source.region_code ?? fail('REGION_POLICY_UNAVAILABLE', 'Source region policy is unavailable.'),
        category: source.trade_type || source.category || fail('REGION_POLICY_UNAVAILABLE', 'Source category is unavailable.'),
        requiresProof: source.requires_proof,
        riskLevel: source.risk_level,
        mode: 'STANDARD',
        instantMode: false,
        templateSlug: optional(source.template_slug),
        clientIdempotencyKey: `counter-replacement:${counter.id}`,
        automationClassification: source.automation_classification,
        proofSteps: Array.isArray(source.checklist) ? source.checklist : buildScopeChecklist({
          title: source.title, requirements: optional(source.requirements), requiresProof: source.requires_proof,
        }),
        estimatedDurationMinutes: optional(source.estimated_duration_minutes),
        requiredTools: optional(source.required_tools),
        counterSourceTaskId: source.id,
        counterOfferId: counter.id,
        counterCandidateId: counter.worker_id,
      });
      if (!created.success) fail(created.error.code, created.error.message);
      const task = created.data as Task;
      if (task.scope_hash !== counter.proposed_scope_hash) fail('CONFLICT', 'Replacement scope hash did not match the approved counter.');
      const replacementEscrow = await query<{ state: string; amount: number }>(
        'SELECT state,amount FROM escrows WHERE task_id=$1', [task.id],
      );
      if (replacementEscrow.rows[0]?.state !== 'PENDING'
          || Number(replacementEscrow.rows[0]?.amount) !== Number(counter.proposed_customer_total_cents)) {
        fail('INVARIANT_VIOLATION', 'Replacement payment state is not pending at the approved amount.');
      }
      const updated = await query<CounterRow>(
        `UPDATE worker_counter_offers SET status='MATERIALIZED',replacement_task_id=$2,
                updated_at=NOW() WHERE id=$1 RETURNING *`,
        [counter.id, task.id],
      );
      counter = updated.rows[0] ?? fail('INTERNAL_ERROR', 'Counter materialization was not persisted.');
      await appendEvent(query, {
        counterId: counter.id,
        eventType: 'MATERIALIZED',
        actorId: params.posterId,
        idempotencyKey: params.idempotencyKey,
        requestHash,
        details: { replacementTaskId: task.id, paymentState: 'PENDING' },
      });
      return result(counter, false);
    });
    return { success: true, data };
  } catch (error) {
    return failure(error);
  }
}

async function getContext(params: {
  taskId: string;
  viewerId: string;
}): Promise<ServiceResult<WorkerCounterContext>> {
  try {
    const taskResult = await db.query<CounterTaskRow>(
      `SELECT id,poster_id,state,title,description,requirements,price,hustler_payout_cents,
              platform_margin_cents,scope_hash,active_scope_version_id,clarification_state
         FROM tasks WHERE id=$1`, [params.taskId],
    );
    const task = taskResult.rows[0] ?? fail('NOT_FOUND', 'Task not found.');
    const viewerRole = task.poster_id === params.viewerId ? 'POSTER' as const : 'ELIGIBLE_CANDIDATE' as const;
    if (viewerRole === 'ELIGIBLE_CANDIDATE') {
      const offer = await db.query<{ id: string }>(
        `SELECT id FROM worker_offer_decisions
          WHERE task_id=$1 AND worker_id=$2 AND decision_ready=TRUE AND expires_at>NOW()
            AND customer_total_cents=$3 AND payout_cents=$4 AND scope_hash=$5
          ORDER BY created_at DESC LIMIT 1`,
        [task.id, params.viewerId, task.price, task.hustler_payout_cents, task.scope_hash],
      );
      if (!offer.rows[0]) fail('FORBIDDEN', 'Only an eligible candidate can view this counter corridor.');
    }
    const counters = await db.query<CounterRow>(
      `SELECT counter.* FROM worker_counter_offers counter
        JOIN tasks task ON task.id=counter.task_id
       WHERE counter.task_id=$1 AND (task.poster_id=$2 OR counter.worker_id=$2)
         AND counter.status IN ('PENDING_POSTER','APPROVED_REAUTH_REQUIRED','MATERIALIZED')
       ORDER BY CASE counter.status
         WHEN 'APPROVED_REAUTH_REQUIRED' THEN 0
         WHEN 'MATERIALIZED' THEN 1
         ELSE 2 END,
         counter.created_at DESC`,
      [task.id, params.viewerId],
    );
    const corridor = task.hustler_payout_cents == null || task.platform_margin_cents == null
      ? null
      : buildWorkerCounterCorridor({
        customerTotalCents: task.price,
        payoutCents: task.hustler_payout_cents,
        platformMarginCents: task.platform_margin_cents,
      });
    return {
      success: true,
      data: {
        viewerRole,
        corridor,
        activeCounter: counters.rows[0] ? result(counters.rows[0], false) : null,
        counterOffers: counters.rows.map((row) => result(row, false)),
      },
    };
  } catch (error) {
    return failure(error);
  }
}

export const WorkerCounterOfferService = { submit, review, materialize, getContext };
