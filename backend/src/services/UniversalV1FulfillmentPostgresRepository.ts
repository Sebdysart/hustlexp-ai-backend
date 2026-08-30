import { db, type Database, type QueryFn } from '../db.js';
import { consumeFinalizedMediaReceipt } from './MediaUploadReceiptService.js';
import {
  type CompleteFakeFinancialLifecyclePublic,
  type DecideCompletionPublic,
  type RecordExecutionEvidencePublic,
  type SubmitCompletionEvidencePublic,
  UniversalV1FulfillmentError,
  universalV1FulfillmentCommandHash,
} from './UniversalV1FulfillmentContracts.js';
import { deterministicUuid } from './UniversalV1WorkOrderPostgresRepository.js';
import type { UniversalV1FakeFinancialApplicationService } from './payment/UniversalV1FinancialApplicationService.js';
import {
  PostgresUniversalV1FakeProviderAccountRepository,
  type UniversalV1FakeProviderAccountSubject,
  type UniversalV1FakeProviderAccountRepository,
} from './payment/UniversalV1FakeProviderAccountRepository.js';

type FinancePort = Pick<
  UniversalV1FakeFinancialApplicationService,
  'executeFinancialEvent' | 'reconcile'
>;

interface FulfillmentContext {
  work_order_id: string;
  task_draft_id: string;
  task_id: string;
  scope_version_id: string;
  scope_version: number;
  scope_hash: string;
  customer_total_cents: number;
  provider_payout_cents: number;
  currency: string;
  poster_user_id: string;
  provider_user_id: string;
  provider_organization_id: string | null;
  eligibility_decision_id: string;
  financial_security_event_id: string;
  provider_authority_current: boolean;
  incident_blocked: boolean;
  execution_fact_id: string;
  execution_version: number;
  execution_state:
    | 'MATERIALIZED'
    | 'ACKNOWLEDGED'
    | 'EN_ROUTE'
    | 'ARRIVED'
    | 'IN_PROGRESS'
    | 'PAUSED'
    | 'COMPLETION_SUBMITTED'
    | 'REWORK_REQUIRED'
    | 'COMPLETED';
}

interface ProofReplay {
  proof_id: string;
  evidence_kind: 'BEFORE' | 'PROGRESS' | 'COMPLETION';
  submission_hash: string;
  scope_version_id: string;
  completion_fact_id: string | null;
  completion_version: number | null;
  incident_gate: 'CLEAR' | 'BLOCKED' | null;
}

interface ProofInsert {
  id: string;
  submitted_at: Date | string;
}

interface CompletionRow {
  id: string;
  work_order_id: string;
  task_id: string;
  scope_version_id: string;
  proof_id: string;
  completion_version: number;
  supersedes_fact_id: string | null;
  fact_kind: 'SUBMITTED' | 'APPROVED' | 'REJECTED';
  incident_gate: 'CLEAR' | 'BLOCKED';
  amount_approved_cents: number | null;
  delivery_event_id: string | null;
  actor_id: string;
  decision_reason: string;
  idempotency_key: string;
}

interface DeliveryRow {
  id: string;
  delivered_at: string;
}

interface FinancialRow {
  id: string;
  operation_id: string;
  event_kind: string;
  status: string;
  expected_version: number;
  amount_cents: number | null;
  currency: string | null;
  scope_version_id: string | null;
}

interface ReconciliationReplay {
  id: string;
  work_order_id: string;
  reconciliation_version: number;
  capture_event_id: string | null;
  refund_event_id: string | null;
  settlement_event_id: string | null;
  funding_event_id: string | null;
  provider_release_event_id: string | null;
  payout_event_id: string | null;
  bank_settlement_event_id: string | null;
  reconciliation_state: string;
  recorded_by: string;
  capture_completion_fact_id: string | null;
  capture_expected_version: number | null;
  terminal_intent_id: string;
  terminal_intent_request_sha256: string;
}

interface TerminalLifecycleIntentRow {
  terminal_intent_id: string;
  idempotency_key: string;
  request_sha256: string;
  terminal_path: 'SETTLED' | 'FULL_REFUND';
  work_order_id: string;
  task_draft_id: string;
  task_id: string;
  eligibility_decision_id: string;
  scope_version_id: string;
  scope_version: number;
  scope_hash: string;
  completion_execution_fact_id: string;
  execution_version: number;
  completion_fact_id: string;
  completion_version: number;
  starting_financial_event_id: string;
  starting_financial_operation_id: string;
  starting_financial_event_kind: string;
  starting_financial_status: string;
  starting_financial_amount_cents: number | null;
  starting_financial_currency: string | null;
  expected_financial_version: number;
  expected_reconciliation_version: number;
  prior_reconciliation_fact_id: string | null;
  starting_financial_version: number;
  starting_reconciliation_version: number;
  customer_amount_cents: number;
  provider_amount_cents: number;
  currency: string;
  provider_subject_kind: 'USER' | 'ORGANIZATION';
  provider_subject_id: string;
  provider_account_fact_id: string | null;
  requested_by: string;
  authority_context_sha256: string;
  materialized_at: Date | string;
}

export interface UniversalV1EvidenceResult {
  proof_id: string;
  evidence_kind: 'BEFORE' | 'PROGRESS' | 'COMPLETION';
  scope_version_id: string;
  completion_fact_id: string | null;
  completion_version: number | null;
  incident_gate: 'CLEAR' | 'BLOCKED' | null;
  replayed: boolean;
  hard_assignment_created: false;
}

export interface UniversalV1CompletionDecisionResult {
  completion_fact_id: string;
  completion_version: number;
  decision: 'APPROVED' | 'REJECTED';
  replayed: boolean;
  payment_creation_performed: false;
}

export interface UniversalV1FakeLifecycleResult {
  reconciliation_id: string;
  reconciliation_version: number;
  capture_event_id: string;
  settlement_event_id: string | null;
  funding_event_id: string | null;
  provider_release_event_id: string | null;
  payout_event_id: string | null;
  bank_settlement_event_id: string | null;
  refund_event_id: string | null;
  path: 'SETTLED' | 'FULL_REFUND';
  replayed: boolean;
  provider_kind: 'FAKE';
  payment_creation_performed: false;
  hard_assignment_created: false;
}

const LOCK_CONTEXT_SQL = `
  SELECT work_order.id AS work_order_id,
         work_order.task_draft_id,
         work_order.task_id,
         scope.id AS scope_version_id,
         scope.version AS scope_version,
         scope.scope_hash,
         scope.customer_total_cents,
         scope.hustler_payout_cents AS provider_payout_cents,
         scope.currency,
         task.poster_id AS poster_user_id,
         work_order.provider_user_id,
         work_order.provider_organization_id,
         work_order.eligibility_decision_id,
         work_order.financial_security_event_id,
         public.universal_v1_invited_provider_authority_is_current(
           eligibility.provider_user_id,
           eligibility.provider_organization_id,
           eligibility.provider_class,
           eligibility.trade_credential_id,
           task.category,
           task.region_code
          ) AS provider_authority_current,
         EXISTS (
           SELECT 1 FROM task_safety_incidents incident
           WHERE incident.task_id = task.id
             AND incident.status NOT IN ('resolved','closed')
          ) AS incident_blocked,
          execution.id AS execution_fact_id,
          execution.execution_version,
          execution.state AS execution_state
    FROM task_work_orders work_order
    JOIN tasks task ON task.id = work_order.task_id
    JOIN task_drafts draft ON draft.id = work_order.task_draft_id
    JOIN task_provider_eligibility_decisions eligibility
      ON eligibility.id = work_order.eligibility_decision_id
    JOIN users actor ON actor.id = $2
    JOIN LATERAL (
      SELECT COALESCE(
        (
          SELECT amendment.scope_version_id
          FROM task_work_order_amendments amendment
          WHERE amendment.work_order_id = work_order.id
          ORDER BY amendment.amendment_version DESC
          LIMIT 1
        ),
        work_order.scope_version_id
      ) AS id
    ) effective_scope ON TRUE
    JOIN task_scope_versions scope ON scope.id = effective_scope.id
    JOIN task_work_order_execution_facts execution
      ON execution.work_order_id = work_order.id
     AND execution.scope_version_id = scope.id
     AND NOT EXISTS (
       SELECT 1
       FROM task_work_order_execution_facts newer_execution
       WHERE newer_execution.work_order_id = execution.work_order_id
         AND newer_execution.execution_version > execution.execution_version
     )
   WHERE work_order.id = $1
     AND work_order.execution_contract_version = 1
     AND task.work_order_id = work_order.id
     AND task.active_scope_version_id = scope.id
     AND task.universal_contract_version = 1
     AND draft.universal_contract_version = 1
     AND task.automation_classification = 'CONTROLLED_TEST'
     AND task.worker_id IS NULL
     AND actor.account_status = 'ACTIVE'
     AND actor.is_minor IS FALSE
     AND COALESCE(actor.is_banned, FALSE) IS FALSE
   FOR UPDATE OF work_order, task, draft, eligibility, actor, scope, execution`;

function requireContext(row: FulfillmentContext | undefined): FulfillmentContext {
  if (!row) {
    throw new UniversalV1FulfillmentError(
      'FULFILLMENT_CONTEXT_UNAVAILABLE',
      'The exact unassigned controlled-test Work Order is unavailable.'
    );
  }
  return row;
}

function providerAccountSubject(
  context: FulfillmentContext
): UniversalV1FakeProviderAccountSubject {
  return context.provider_organization_id === null
    ? { kind: 'USER', userId: context.provider_user_id }
    : { kind: 'ORGANIZATION', organizationId: context.provider_organization_id };
}

function assertScopeVersion(context: FulfillmentContext, expected: number): void {
  if (Number(context.scope_version) !== expected) {
    throw new UniversalV1FulfillmentError(
      'FULFILLMENT_VERSION_CONFLICT',
      'The active Work Order scope changed.'
    );
  }
}

function assertExecutionVersion(context: FulfillmentContext, expected: number): void {
  if (Number(context.execution_version) !== expected) {
    throw new UniversalV1FulfillmentError(
      'FULFILLMENT_VERSION_CONFLICT',
      'The Work Order execution state changed.'
    );
  }
}

function assertProviderActor(context: FulfillmentContext, actorId: string): void {
  if (!context.provider_authority_current) {
    throw new UniversalV1FulfillmentError(
      'FULFILLMENT_PROVIDER_AUTHORITY_REVOKED',
      'The Work Order provider authority is no longer current.'
    );
  }
  // The row is locked before this membership read, and SERIALIZABLE isolation
  // makes a concurrent revocation conflict instead of silently authorizing it.
  // Direct provider identity is always allowed; organization actors are checked
  // in the explicit query below.
  if (context.provider_user_id === actorId) return;
}

async function assertOrganizationProviderActor(
  query: QueryFn,
  context: FulfillmentContext,
  actorId: string
): Promise<void> {
  assertProviderActor(context, actorId);
  if (context.provider_user_id === actorId) return;
  if (!context.provider_organization_id) {
    throw new UniversalV1FulfillmentError(
      'FULFILLMENT_PROVIDER_AUTHORITY_REVOKED',
      'Only the Work Order provider can record provider evidence.'
    );
  }
  const membership = await query<{ authorized: boolean }>(
    `SELECT TRUE AS authorized
       FROM business_memberships membership
       JOIN business_organizations organization
         ON organization.id = membership.organization_id
      WHERE membership.organization_id = $1
        AND membership.user_id = $2
        AND membership.status = 'ACTIVE'
        AND membership.role IN ('OWNER','ADMIN','DISPATCHER','CREW')
        AND organization.status = 'ACTIVE'
        AND organization.provider_enabled IS TRUE
      FOR SHARE OF membership, organization`,
    [context.provider_organization_id, actorId]
  );
  if (!membership.rows[0]?.authorized) {
    throw new UniversalV1FulfillmentError(
      'FULFILLMENT_PROVIDER_AUTHORITY_REVOKED',
      'The actor no longer has Work Order provider authority.'
    );
  }
}

function assertCustomerActor(context: FulfillmentContext, actorId: string): void {
  if (context.poster_user_id !== actorId) {
    throw new UniversalV1FulfillmentError(
      'FULFILLMENT_CUSTOMER_AUTHORITY_REQUIRED',
      'Only the Work Order customer can perform this action.'
    );
  }
}

async function lockContext(
  query: QueryFn,
  workOrderId: string,
  actorId: string
): Promise<FulfillmentContext> {
  const result = await query<FulfillmentContext>(LOCK_CONTEXT_SQL, [workOrderId, actorId]);
  return requireContext(result.rows[0]);
}

async function lockTerminalLifecycleIntents(
  query: QueryFn,
  idempotencyKey: string,
  workOrderId: string
): Promise<TerminalLifecycleIntentRow[]> {
  const result = await query<TerminalLifecycleIntentRow>(
    `SELECT intent.terminal_intent_id,
            intent.idempotency_key,
            intent.request_sha256,
            intent.terminal_path,
            intent.work_order_id,
            intent.task_draft_id,
            intent.task_id,
            intent.eligibility_decision_id,
            intent.scope_version_id,
            scope.version AS scope_version,
            scope.scope_hash,
            intent.completion_execution_fact_id,
            execution.execution_version,
            intent.completion_fact_id,
            completion.completion_version,
            intent.starting_financial_event_id,
            starting.operation_id AS starting_financial_operation_id,
            starting.event_kind AS starting_financial_event_kind,
            starting.status AS starting_financial_status,
            starting.amount_cents AS starting_financial_amount_cents,
            starting.currency AS starting_financial_currency,
            intent.expected_financial_version,
            intent.expected_reconciliation_version,
            intent.prior_reconciliation_fact_id,
            intent.starting_financial_version,
            intent.starting_reconciliation_version,
            intent.customer_amount_cents,
            intent.provider_amount_cents,
            intent.currency,
            intent.provider_subject_kind,
            intent.provider_subject_id,
            intent.provider_account_fact_id,
            intent.requested_by,
            intent.authority_context_sha256,
            intent.materialized_at
       FROM public.universal_v1_fake_terminal_lifecycle_intents intent
       JOIN public.task_scope_versions scope
         ON scope.id = intent.scope_version_id
       JOIN public.task_work_order_execution_facts execution
         ON execution.id = intent.completion_execution_fact_id
       JOIN public.task_completion_facts completion
         ON completion.id = intent.completion_fact_id
       JOIN public.task_financial_security_events starting
         ON starting.id = intent.starting_financial_event_id
      WHERE intent.idempotency_key = $1
         OR intent.work_order_id = $2
      ORDER BY intent.terminal_intent_id
      FOR UPDATE OF intent`,
    [idempotencyKey, workOrderId]
  );
  return result.rows;
}

function assertTerminalLifecycleIntentIdentity(
  intent: TerminalLifecycleIntentRow,
  context: FulfillmentContext,
  actorId: string,
  input: CompleteFakeFinancialLifecyclePublic,
  requestSha256: string
): void {
  const expectedSubjectKind = context.provider_organization_id === null ? 'USER' : 'ORGANIZATION';
  const expectedSubjectId = context.provider_organization_id ?? context.provider_user_id;
  const materializedAt = new Date(intent.materialized_at);
  if (
    intent.idempotency_key !== input.idempotency_key ||
    intent.request_sha256 !== requestSha256 ||
    intent.terminal_path !== input.path ||
    intent.work_order_id !== context.work_order_id ||
    intent.task_draft_id !== context.task_draft_id ||
    intent.task_id !== context.task_id ||
    intent.eligibility_decision_id !== context.eligibility_decision_id ||
    intent.scope_version_id !== context.scope_version_id ||
    Number(intent.scope_version) !== Number(context.scope_version) ||
    intent.scope_hash !== context.scope_hash ||
    intent.completion_execution_fact_id !== context.execution_fact_id ||
    Number(intent.execution_version) !== input.expected_execution_version ||
    intent.completion_fact_id !== input.approved_completion_fact_id ||
    (intent.starting_financial_event_kind !== 'SECURED' &&
      intent.starting_financial_event_kind !== 'ADJUSTMENT_AUTHORIZED') ||
    intent.starting_financial_status !== 'SUCCEEDED' ||
    Number(intent.starting_financial_amount_cents) !== Number(context.customer_total_cents) ||
    intent.starting_financial_currency !== context.currency ||
    Number(intent.expected_financial_version) !== input.expected_financial_version ||
    Number(intent.starting_financial_version) !== input.expected_financial_version ||
    Number(intent.expected_reconciliation_version) !== input.expected_reconciliation_version ||
    Number(intent.starting_reconciliation_version) !== input.expected_reconciliation_version ||
    Number(intent.customer_amount_cents) !== Number(context.customer_total_cents) ||
    Number(intent.provider_amount_cents) !== Number(context.provider_payout_cents) ||
    intent.currency !== context.currency ||
    intent.provider_subject_kind !== expectedSubjectKind ||
    intent.provider_subject_id !== expectedSubjectId ||
    (input.path === 'SETTLED') !== (intent.provider_account_fact_id !== null) ||
    intent.requested_by !== actorId ||
    !/^[0-9a-f]{64}$/u.test(intent.authority_context_sha256) ||
    Number.isNaN(materializedAt.getTime())
  ) {
    throw new UniversalV1FulfillmentError(
      'FULFILLMENT_IDEMPOTENCY_CONFLICT',
      'The terminal lifecycle intent is occupied by a different immutable authority claim.'
    );
  }
}

function startingFinancialEventFromIntent(intent: TerminalLifecycleIntentRow): FinancialRow {
  return {
    id: intent.starting_financial_event_id,
    operation_id: intent.starting_financial_operation_id,
    event_kind: intent.starting_financial_event_kind,
    status: intent.starting_financial_status,
    expected_version: Number(intent.starting_financial_version),
    amount_cents:
      intent.starting_financial_amount_cents === null
        ? null
        : Number(intent.starting_financial_amount_cents),
    currency: intent.starting_financial_currency,
    scope_version_id: intent.scope_version_id,
  };
}

async function proofReplay(
  query: QueryFn,
  context: FulfillmentContext,
  actorId: string,
  idempotencyKey: string
): Promise<ProofReplay | null> {
  const result = await query<ProofReplay>(
    `SELECT proof.id AS proof_id,
            proof.evidence_kind,
            proof.submission_hash,
            proof.scope_version_id,
            completion.id AS completion_fact_id,
            completion.completion_version,
            completion.incident_gate
       FROM proofs proof
       LEFT JOIN task_completion_facts completion
         ON completion.proof_id = proof.id
        AND completion.fact_kind = 'SUBMITTED'
      WHERE proof.task_id = $1
        AND proof.client_submission_id = $2
        AND proof.submitter_id = $3
      FOR UPDATE OF proof`,
    [context.task_id, idempotencyKey, actorId]
  );
  return result.rows[0] ?? null;
}

function replayEvidence(
  replay: ProofReplay,
  requestHash: string,
  expectedKind: ProofReplay['evidence_kind']
): UniversalV1EvidenceResult {
  if (replay.submission_hash !== requestHash || replay.evidence_kind !== expectedKind) {
    throw new UniversalV1FulfillmentError(
      'FULFILLMENT_IDEMPOTENCY_CONFLICT',
      'The evidence idempotency key was already used for different evidence.'
    );
  }
  return {
    proof_id: replay.proof_id,
    evidence_kind: replay.evidence_kind,
    scope_version_id: replay.scope_version_id,
    completion_fact_id: replay.completion_fact_id,
    completion_version:
      replay.completion_version == null ? null : Number(replay.completion_version),
    incident_gate: replay.incident_gate,
    replayed: true,
    hard_assignment_created: false,
  };
}

async function insertProof(
  query: QueryFn,
  context: FulfillmentContext,
  actorId: string,
  input: RecordExecutionEvidencePublic | SubmitCompletionEvidencePublic,
  evidenceKind: ProofReplay['evidence_kind'],
  requestHash: string
): Promise<ProofInsert> {
  const inserted = await query<ProofInsert>(
    `INSERT INTO proofs (
       task_id, submitter_id, state, description,
       scope_version_id, scope_version_hash,
       client_submission_id, submission_hash,
       work_order_id, evidence_kind, execution_fact_id, submitted_at
     ) VALUES ($1,$2,'SUBMITTED',$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp())
     RETURNING id, submitted_at`,
    [
      context.task_id,
      actorId,
      input.description ?? null,
      context.scope_version_id,
      context.scope_hash,
      input.idempotency_key,
      requestHash,
      context.work_order_id,
      evidenceKind,
      context.execution_fact_id,
    ]
  );
  const proof = inserted.rows[0];
  if (!proof) {
    throw new UniversalV1FulfillmentError(
      'FULFILLMENT_EVIDENCE_STATE_CONFLICT',
      'The evidence fact was not created.'
    );
  }

  for (const [index, photo] of input.photo_evidence.entries()) {
    const consumed = await consumeFinalizedMediaReceipt(query, {
      evidence: photo,
      taskId: context.task_id,
      uploaderId: actorId,
      purpose: 'PROOF',
      consumerId: proof.id,
    });
    await query(
      `INSERT INTO proof_photos (
         proof_id, storage_key, content_type, file_size_bytes,
         checksum_sha256, capture_time, sequence_number
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        proof.id,
        consumed.storageKey,
        consumed.contentType,
        consumed.fileSizeBytes,
        consumed.checksumSha256,
        photo.capturedAt ?? null,
        index + 1,
      ]
    );
  }
  return proof;
}

export class PostgresUniversalV1FulfillmentRepository {
  constructor(
    private readonly database: Database = db,
    private readonly providerAccounts: UniversalV1FakeProviderAccountRepository = new PostgresUniversalV1FakeProviderAccountRepository(
      database
    )
  ) {}

  async recordExecutionEvidence(
    actorId: string,
    input: RecordExecutionEvidencePublic
  ): Promise<UniversalV1EvidenceResult> {
    const requestHash = universalV1FulfillmentCommandHash(input);
    return this.database.serializableTransaction(async (query) => {
      await query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
        `fulfillment:${input.work_order_id}`,
      ]);
      const context = await lockContext(query, input.work_order_id, actorId);
      const replay = await proofReplay(query, context, actorId, input.idempotency_key);
      if (replay) return replayEvidence(replay, requestHash, input.evidence_kind);
      assertScopeVersion(context, input.expected_scope_version);
      assertExecutionVersion(context, input.expected_execution_version);
      await assertOrganizationProviderActor(query, context, actorId);
      const evidenceStateAllowed =
        input.evidence_kind === 'BEFORE'
          ? ['ACKNOWLEDGED', 'EN_ROUTE', 'ARRIVED'].includes(context.execution_state)
          : ['IN_PROGRESS', 'PAUSED'].includes(context.execution_state);
      if (!evidenceStateAllowed) {
        throw new UniversalV1FulfillmentError(
          'FULFILLMENT_EVIDENCE_STATE_CONFLICT',
          'Evidence kind is unavailable in the current execution state.'
        );
      }
      const completionState = await query<{ fact_kind: CompletionRow['fact_kind'] }>(
        `SELECT fact_kind
           FROM task_completion_facts
          WHERE work_order_id = $1
          ORDER BY completion_version DESC
          LIMIT 1
          FOR UPDATE`,
        [context.work_order_id]
      );
      const terminalReconciliation = await query<{ id: string }>(
        `SELECT id FROM task_reconciliation_facts
          WHERE work_order_id = $1
          LIMIT 1
          FOR UPDATE`,
        [context.work_order_id]
      );
      if (
        completionState.rows[0]?.fact_kind === 'SUBMITTED' ||
        completionState.rows[0]?.fact_kind === 'APPROVED' ||
        terminalReconciliation.rows[0]
      ) {
        throw new UniversalV1FulfillmentError(
          'FULFILLMENT_EVIDENCE_STATE_CONFLICT',
          'Execution evidence cannot be added after completion review begins.'
        );
      }
      const proof = await insertProof(
        query,
        context,
        actorId,
        input,
        input.evidence_kind,
        requestHash
      );
      return {
        proof_id: proof.id,
        evidence_kind: input.evidence_kind,
        scope_version_id: context.scope_version_id,
        completion_fact_id: null,
        completion_version: null,
        incident_gate: null,
        replayed: false,
        hard_assignment_created: false,
      };
    });
  }

  async submitCompletionEvidence(
    actorId: string,
    input: SubmitCompletionEvidencePublic
  ): Promise<UniversalV1EvidenceResult> {
    const requestHash = universalV1FulfillmentCommandHash(input);
    return this.database.serializableTransaction(async (query) => {
      await query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
        `fulfillment:${input.work_order_id}`,
      ]);
      const context = await lockContext(query, input.work_order_id, actorId);
      const replay = await proofReplay(query, context, actorId, input.idempotency_key);
      if (replay) return replayEvidence(replay, requestHash, 'COMPLETION');
      assertScopeVersion(context, input.expected_scope_version);
      assertExecutionVersion(context, input.expected_execution_version);
      await assertOrganizationProviderActor(query, context, actorId);
      if (context.execution_state !== 'IN_PROGRESS') {
        throw new UniversalV1FulfillmentError(
          'FULFILLMENT_COMPLETION_STATE_CONFLICT',
          'Completion can be submitted only from active work.'
        );
      }

      const priorResult = await query<CompletionRow>(
        `SELECT * FROM task_completion_facts
          WHERE work_order_id = $1
          ORDER BY completion_version DESC
          LIMIT 1
          FOR UPDATE`,
        [context.work_order_id]
      );
      const prior = priorResult.rows[0];
      if (prior && prior.fact_kind !== 'REJECTED') {
        throw new UniversalV1FulfillmentError(
          'FULFILLMENT_COMPLETION_STATE_CONFLICT',
          'A current completion submission or approval already exists.'
        );
      }

      const proof = await insertProof(query, context, actorId, input, 'COMPLETION', requestHash);
      const completionVersion = prior ? Number(prior.completion_version) + 1 : 1;
      const completion = await query<{ id: string }>(
        `INSERT INTO task_completion_facts (
           work_order_id, task_id, scope_version_id, proof_id,
           proof_snapshot_hash, completion_version, supersedes_fact_id,
           fact_kind, amount_approved_cents, incident_gate,
           actor_role, decision_reason, actor_id, idempotency_key
         ) VALUES (
           $1,$2,$3,$4,repeat('0',64),$5,$6,
           'SUBMITTED',NULL,$7,'PROVIDER',$8,$9,$10
         ) RETURNING id`,
        [
          context.work_order_id,
          context.task_id,
          context.scope_version_id,
          proof.id,
          completionVersion,
          prior?.id ?? null,
          context.incident_blocked ? 'BLOCKED' : 'CLEAR',
          input.decision_reason,
          actorId,
          `${input.idempotency_key}:fact`,
        ]
      );
      const completionId = completion.rows[0]?.id;
      if (!completionId) {
        throw new UniversalV1FulfillmentError(
          'FULFILLMENT_COMPLETION_STATE_CONFLICT',
          'The completion submission fact was not created.'
        );
      }
      const executionKey = `${input.idempotency_key}:execution`;
      const completionExecution = await query<{ id: string }>(
        `INSERT INTO task_work_order_execution_facts (
           work_order_id, task_id, scope_version_id, execution_version,
           supersedes_fact_id, state, transition_kind, completion_fact_id,
           work_order_amendment_id, actor_role, actor_user_id, reason,
           idempotency_key, request_sha256, client_occurred_at,
           policy_version
         ) VALUES (
           $1,$2,$3,$4,$5,'COMPLETION_SUBMITTED','COMPLETION_SUBMITTED',$6,
           NULL,'PROVIDER',$7,$8,$9,
           public.universal_v1_execution_internal_request_sha256(
             $7,$1,'COMPLETION_SUBMITTED','COMPLETION_SUBMITTED',$10,$3,$6,
             NULL,$9,$11::timestamptz,$8
           ),$11::timestamptz,'universal-v1-work-order-execution-1.0.0'
         ) RETURNING id`,
        [
          context.work_order_id,
          context.task_id,
          context.scope_version_id,
          Number(context.execution_version) + 1,
          context.execution_fact_id,
          completionId,
          actorId,
          input.decision_reason,
          executionKey,
          Number(context.execution_version),
          input.client_ts,
        ]
      );
      if (!completionExecution.rows[0]) {
        throw new UniversalV1FulfillmentError(
          'FULFILLMENT_COMPLETION_STATE_CONFLICT',
          'The completion execution transition was not created.'
        );
      }
      return {
        proof_id: proof.id,
        evidence_kind: 'COMPLETION',
        scope_version_id: context.scope_version_id,
        completion_fact_id: completionId,
        completion_version: completionVersion,
        incident_gate: context.incident_blocked ? 'BLOCKED' : 'CLEAR',
        replayed: false,
        hard_assignment_created: false,
      };
    });
  }

  async decideCompletion(
    actorId: string,
    input: DecideCompletionPublic
  ): Promise<UniversalV1CompletionDecisionResult> {
    return this.database.serializableTransaction(async (query) => {
      await query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
        `fulfillment:${input.work_order_id}`,
      ]);
      const context = await lockContext(query, input.work_order_id, actorId);
      assertCustomerActor(context, actorId);

      const replay = await query<CompletionRow>(
        `SELECT * FROM task_completion_facts WHERE idempotency_key = $1`,
        [`${input.idempotency_key}:fact`]
      );
      if (replay.rows[0]) {
        const row = replay.rows[0];
        if (
          row.work_order_id !== context.work_order_id ||
          row.fact_kind !== input.decision ||
          row.actor_id !== actorId ||
          row.supersedes_fact_id !== input.submitted_completion_fact_id ||
          Number(row.completion_version) !== input.expected_completion_version + 1 ||
          row.delivery_event_id !== (input.delivery_event_id ?? null) ||
          row.decision_reason !== input.decision_reason
        ) {
          throw new UniversalV1FulfillmentError(
            'FULFILLMENT_IDEMPOTENCY_CONFLICT',
            'The completion-decision idempotency key was already used differently.'
          );
        }
        return {
          completion_fact_id: row.id,
          completion_version: Number(row.completion_version),
          decision: input.decision,
          replayed: true,
          payment_creation_performed: false,
        };
      }

      assertExecutionVersion(context, input.expected_execution_version);
      if (context.execution_state !== 'COMPLETION_SUBMITTED') {
        throw new UniversalV1FulfillmentError(
          'FULFILLMENT_COMPLETION_STATE_CONFLICT',
          'Completion review requires the current submitted execution state.'
        );
      }

      const currentResult = await query<CompletionRow & { proof_state: string }>(
        `SELECT completion.*, proof.state AS proof_state
           FROM task_completion_facts completion
           JOIN proofs proof ON proof.id = completion.proof_id
          WHERE completion.work_order_id = $1
          ORDER BY completion.completion_version DESC
          LIMIT 1
          FOR UPDATE OF completion, proof`,
        [context.work_order_id]
      );
      const current = currentResult.rows[0];
      if (
        !current ||
        current.id !== input.submitted_completion_fact_id ||
        Number(current.completion_version) !== input.expected_completion_version ||
        current.fact_kind !== 'SUBMITTED' ||
        current.proof_state !== 'SUBMITTED' ||
        current.scope_version_id !== context.scope_version_id
      ) {
        throw new UniversalV1FulfillmentError(
          'FULFILLMENT_VERSION_CONFLICT',
          'The submitted completion fact is no longer current.'
        );
      }
      if (input.decision === 'APPROVED' && context.incident_blocked) {
        throw new UniversalV1FulfillmentError(
          'FULFILLMENT_INCIDENT_BLOCKED',
          'Completion cannot be approved while a safety incident remains open.'
        );
      }

      let delivery: DeliveryRow | null = null;
      if (input.delivery_event_id) {
        const deliveryResult = await query<DeliveryRow>(
          `SELECT id, delivered_at::text AS delivered_at
             FROM task_completion_delivery_events
            WHERE id = $1 AND task_id = $2
            FOR SHARE`,
          [input.delivery_event_id, context.task_id]
        );
        delivery = deliveryResult.rows[0] ?? null;
        if (!delivery) {
          throw new UniversalV1FulfillmentError(
            'FULFILLMENT_COMPLETION_STATE_CONFLICT',
            'The provider-authenticated delivery fact is unavailable.'
          );
        }
      }

      const proofState = input.decision === 'APPROVED' ? 'ACCEPTED' : 'REJECTED';
      const proofUpdate = await query(
        `UPDATE proofs
            SET state = $2,
                reviewed_by = $3,
                reviewed_at = clock_timestamp(),
                rejection_reason = $4,
                updated_at = clock_timestamp()
          WHERE id = $1 AND state = 'SUBMITTED'`,
        [
          current.proof_id,
          proofState,
          actorId,
          input.decision === 'REJECTED' ? input.decision_reason : null,
        ]
      );
      if (proofUpdate.rowCount !== 1) {
        throw new UniversalV1FulfillmentError(
          'FULFILLMENT_COMPLETION_STATE_CONFLICT',
          'The completion proof changed before the decision committed.'
        );
      }

      const nextVersion = Number(current.completion_version) + 1;
      const inserted = await query<{ id: string }>(
        `INSERT INTO task_completion_facts (
           work_order_id, task_id, scope_version_id, proof_id,
           proof_snapshot_hash, completion_version, supersedes_fact_id,
           fact_kind, amount_approved_cents, incident_gate,
           customer_notice_at, delivery_event_id, actor_role,
           decision_reason, actor_id, idempotency_key
         ) VALUES (
           $1,$2,$3,$4,repeat('0',64),$5,$6,$7,$8,$9,$10,$11,
           'CUSTOMER',$12,$13,$14
         ) RETURNING id`,
        [
          context.work_order_id,
          context.task_id,
          context.scope_version_id,
          current.proof_id,
          nextVersion,
          current.id,
          input.decision,
          input.decision === 'APPROVED' ? context.customer_total_cents : null,
          context.incident_blocked ? 'BLOCKED' : 'CLEAR',
          delivery?.delivered_at ?? null,
          delivery?.id ?? null,
          input.decision_reason,
          actorId,
          `${input.idempotency_key}:fact`,
        ]
      );
      const completionId = inserted.rows[0]?.id;
      if (!completionId) {
        throw new UniversalV1FulfillmentError(
          'FULFILLMENT_COMPLETION_STATE_CONFLICT',
          'The completion decision fact was not created.'
        );
      }
      const executionState = input.decision === 'APPROVED' ? 'COMPLETED' : 'REWORK_REQUIRED';
      const executionTransition =
        input.decision === 'APPROVED' ? 'COMPLETION_APPROVED' : 'COMPLETION_REJECTED';
      const executionKey = `${input.idempotency_key}:execution`;
      const decisionExecution = await query<{ id: string }>(
        `INSERT INTO task_work_order_execution_facts (
           work_order_id, task_id, scope_version_id, execution_version,
           supersedes_fact_id, state, transition_kind, completion_fact_id,
           work_order_amendment_id, actor_role, actor_user_id, reason,
           idempotency_key, request_sha256, client_occurred_at,
           policy_version
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,NULL,'CUSTOMER',$9,$10,$11,
           public.universal_v1_execution_internal_request_sha256(
             $9,$1,$7,$6,$12,$3,$8,NULL,$11,$13::timestamptz,$10
           ),$13::timestamptz,'universal-v1-work-order-execution-1.0.0'
         ) RETURNING id`,
        [
          context.work_order_id,
          context.task_id,
          context.scope_version_id,
          Number(context.execution_version) + 1,
          context.execution_fact_id,
          executionState,
          executionTransition,
          completionId,
          actorId,
          input.decision_reason,
          executionKey,
          Number(context.execution_version),
          input.client_ts,
        ]
      );
      if (!decisionExecution.rows[0]) {
        throw new UniversalV1FulfillmentError(
          'FULFILLMENT_COMPLETION_STATE_CONFLICT',
          'The completion-review execution transition was not created.'
        );
      }
      return {
        completion_fact_id: completionId,
        completion_version: nextVersion,
        decision: input.decision,
        replayed: false,
        payment_creation_performed: false,
      };
    });
  }

  async completeFakeFinancialLifecycle(
    actorId: string,
    input: CompleteFakeFinancialLifecyclePublic,
    finance: FinancePort
  ): Promise<UniversalV1FakeLifecycleResult> {
    const intentRequest = {
      schemaVersion: 1,
      workOrderId: input.work_order_id,
      approvedCompletionFactId: input.approved_completion_fact_id,
      path: input.path,
      expectedExecutionVersion: input.expected_execution_version,
      startingFinancialVersion: input.expected_financial_version,
      startingReconciliationVersion: input.expected_reconciliation_version,
      idempotencyKey: input.idempotency_key,
      actorId,
    } as const;
    const intentRequestSha256 = universalV1FulfillmentCommandHash(intentRequest);
    const prepared = await this.database.serializableTransaction(async (query) => {
      await query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
        `fulfillment:${input.work_order_id}`,
      ]);
      const context = await lockContext(query, input.work_order_id, actorId);
      assertCustomerActor(context, actorId);
      assertExecutionVersion(context, input.expected_execution_version);
      if (context.execution_state !== 'COMPLETED') {
        throw new UniversalV1FulfillmentError(
          'FULFILLMENT_COMPLETION_STATE_CONFLICT',
          'Fake capture requires the exact completed execution state.'
        );
      }
      const replay = await query<ReconciliationReplay>(
        `SELECT reconciliation.id, reconciliation.work_order_id,
                reconciliation.reconciliation_version,
                reconciliation.capture_event_id,
                reconciliation.refund_event_id,
                reconciliation.settlement_event_id,
                reconciliation.funding_event_id,
                reconciliation.provider_release_event_id,
                reconciliation.payout_event_id,
                reconciliation.bank_settlement_event_id,
                reconciliation_state, reconciliation.recorded_by,
                capture.completion_fact_id AS capture_completion_fact_id,
                capture.expected_version AS capture_expected_version,
                terminal_intent.terminal_intent_id AS terminal_intent_id,
                terminal_intent.request_sha256 AS terminal_intent_request_sha256
           FROM task_reconciliation_facts reconciliation
           LEFT JOIN task_financial_security_events capture
             ON capture.id = reconciliation.capture_event_id
           JOIN public.universal_v1_fake_reconciliation_bridges reconciliation_bridge
             ON reconciliation_bridge.reconciliation_fact_id = reconciliation.id
           JOIN public.universal_v1_fake_terminal_lifecycle_intents terminal_intent
             ON terminal_intent.terminal_intent_id = reconciliation_bridge.terminal_intent_id
          WHERE reconciliation.idempotency_key = $1
          FOR UPDATE OF reconciliation`,
        [`${input.idempotency_key}:reconciliation`]
      );
      if (replay.rows[0]) {
        const row = replay.rows[0];
        const samePath =
          input.path === 'SETTLED'
            ? row.capture_event_id != null &&
              row.settlement_event_id != null &&
              row.funding_event_id != null &&
              row.provider_release_event_id != null &&
              row.payout_event_id != null &&
              row.bank_settlement_event_id != null &&
              row.refund_event_id == null
            : row.capture_event_id != null &&
              row.refund_event_id != null &&
              row.settlement_event_id == null &&
              row.funding_event_id == null &&
              row.provider_release_event_id == null &&
              row.payout_event_id == null &&
              row.bank_settlement_event_id == null;
        if (
          row.work_order_id !== context.work_order_id ||
          !samePath ||
          row.recorded_by !== actorId ||
          row.capture_completion_fact_id !== input.approved_completion_fact_id ||
          Number(row.capture_expected_version) !== input.expected_financial_version + 1 ||
          Number(row.reconciliation_version) !== input.expected_reconciliation_version + 1 ||
          row.terminal_intent_request_sha256 !== intentRequestSha256
        ) {
          throw new UniversalV1FulfillmentError(
            'FULFILLMENT_IDEMPOTENCY_CONFLICT',
            'The lifecycle idempotency key was already used for a different terminal path.'
          );
        }
        return {
          completed: true as const,
          result: {
            reconciliation_id: row.id,
            reconciliation_version: Number(row.reconciliation_version),
            capture_event_id: row.capture_event_id!,
            settlement_event_id: row.settlement_event_id,
            funding_event_id: row.funding_event_id,
            provider_release_event_id: row.provider_release_event_id,
            payout_event_id: row.payout_event_id,
            bank_settlement_event_id: row.bank_settlement_event_id,
            refund_event_id: row.refund_event_id,
            path: input.path,
            replayed: true,
            provider_kind: 'FAKE' as const,
            payment_creation_performed: false as const,
            hard_assignment_created: false as const,
          },
        };
      }

      const occupiedIntents = await lockTerminalLifecycleIntents(
        query,
        input.idempotency_key,
        context.work_order_id
      );
      if (occupiedIntents.length > 1) {
        throw new UniversalV1FulfillmentError(
          'FULFILLMENT_IDEMPOTENCY_CONFLICT',
          'The Work Order and lifecycle key are occupied by different terminal intents.'
        );
      }
      const occupiedIntent = occupiedIntents[0];
      if (occupiedIntent) {
        assertTerminalLifecycleIntentIdentity(
          occupiedIntent,
          context,
          actorId,
          input,
          intentRequestSha256
        );
        const providerAccount =
          occupiedIntent.provider_account_fact_id === null
            ? null
            : await this.providerAccounts.findPinnedPayoutReadyInTransaction(query, {
                providerAccountFactId: occupiedIntent.provider_account_fact_id,
                providerSubject: providerAccountSubject(context),
              });
        if (input.path === 'SETTLED' && !providerAccount) {
          throw new UniversalV1FulfillmentError(
            'FULFILLMENT_PROVIDER_ACCOUNT_UNAVAILABLE',
            'The exact fake provider-account authority pinned by the terminal intent is unavailable.'
          );
        }
        return {
          completed: false as const,
          context,
          terminalIntent: occupiedIntent,
          predecessor: startingFinancialEventFromIntent(occupiedIntent),
          prior:
            occupiedIntent.prior_reconciliation_fact_id === null
              ? undefined
              : {
                  id: occupiedIntent.prior_reconciliation_fact_id,
                  reconciliation_version: Number(occupiedIntent.starting_reconciliation_version),
                },
          priorVersion: Number(occupiedIntent.starting_reconciliation_version),
          providerAccount,
        };
      }

      if (input.path === 'SETTLED' && !context.provider_authority_current) {
        throw new UniversalV1FulfillmentError(
          'FULFILLMENT_PROVIDER_AUTHORITY_REVOKED',
          'Settlement is unavailable because provider authority was revoked.'
        );
      }
      if (context.incident_blocked) {
        throw new UniversalV1FulfillmentError(
          'FULFILLMENT_INCIDENT_BLOCKED',
          'Financial completion is blocked while a safety incident remains open.'
        );
      }

      const completionResult = await query<CompletionRow & { proof_state: string }>(
        `SELECT completion.*, proof.state AS proof_state
           FROM task_completion_facts completion
           JOIN proofs proof ON proof.id = completion.proof_id
          WHERE completion.work_order_id = $1
          ORDER BY completion.completion_version DESC
          LIMIT 1
          FOR UPDATE OF completion, proof`,
        [context.work_order_id]
      );
      const completion = completionResult.rows[0];
      if (
        !completion ||
        completion.id !== input.approved_completion_fact_id ||
        completion.fact_kind !== 'APPROVED' ||
        completion.incident_gate !== 'CLEAR' ||
        completion.proof_state !== 'ACCEPTED' ||
        completion.scope_version_id !== context.scope_version_id ||
        Number(completion.amount_approved_cents) !== Number(context.customer_total_cents)
      ) {
        throw new UniversalV1FulfillmentError(
          'FULFILLMENT_COMPLETION_STATE_CONFLICT',
          'The exact current approved completion fact is required.'
        );
      }

      const predecessorResult = await query<FinancialRow>(
        `SELECT id, operation_id, event_kind, status, expected_version,
                amount_cents, currency, scope_version_id
           FROM task_financial_security_events
          WHERE task_draft_id = $1
            AND expected_version = $2
          FOR UPDATE`,
        [context.task_draft_id, input.expected_financial_version]
      );
      const predecessor = predecessorResult.rows[0];
      if (
        !predecessor ||
        !['SECURED', 'ADJUSTMENT_AUTHORIZED'].includes(predecessor.event_kind) ||
        predecessor.status !== 'SUCCEEDED' ||
        Number(predecessor.expected_version) !== input.expected_financial_version ||
        predecessor.scope_version_id !== context.scope_version_id ||
        Number(predecessor.amount_cents) !== Number(context.customer_total_cents) ||
        predecessor.currency !== context.currency
      ) {
        throw new UniversalV1FulfillmentError(
          'FULFILLMENT_VERSION_CONFLICT',
          'The financial authority chain changed or is not ready for capture.'
        );
      }

      const priorReconciliation = await query<{ id: string; reconciliation_version: number }>(
        `SELECT id, reconciliation_version
           FROM task_reconciliation_facts
          WHERE work_order_id = $1
          ORDER BY reconciliation_version DESC
          LIMIT 1
          FOR UPDATE`,
        [context.work_order_id]
      );
      const prior = priorReconciliation.rows[0];
      const priorVersion = prior ? Number(prior.reconciliation_version) : 0;
      if (priorVersion !== input.expected_reconciliation_version) {
        throw new UniversalV1FulfillmentError(
          'FULFILLMENT_VERSION_CONFLICT',
          'The reconciliation snapshot changed.'
        );
      }
      const providerAccount =
        input.path === 'SETTLED'
          ? await this.providerAccounts.findLatestPayoutReadyInTransaction(query, {
              providerSubject: providerAccountSubject(context),
            })
          : null;
      if (input.path === 'SETTLED' && !providerAccount) {
        throw new UniversalV1FulfillmentError(
          'FULFILLMENT_PROVIDER_ACCOUNT_UNAVAILABLE',
          "Settlement requires the provider's exact latest enabled fake account fact."
        );
      }
      const insertedIntent = await query<{ terminal_intent_id: string }>(
        `INSERT INTO public.universal_v1_fake_terminal_lifecycle_intents (
           terminal_path,
           work_order_id,
           completion_fact_id,
           starting_financial_event_id,
           provider_account_fact_id,
           expected_financial_version,
           expected_reconciliation_version,
           idempotency_key,
           request_sha256,
           requested_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING terminal_intent_id`,
        [
          input.path,
          context.work_order_id,
          completion.id,
          predecessor.id,
          providerAccount?.providerAccountFactId ?? null,
          input.expected_financial_version,
          input.expected_reconciliation_version,
          input.idempotency_key,
          intentRequestSha256,
          actorId,
        ]
      );
      const terminalIntentId = insertedIntent.rows[0]?.terminal_intent_id;
      if (!terminalIntentId) {
        throw new UniversalV1FulfillmentError(
          'FULFILLMENT_COMPLETION_STATE_CONFLICT',
          'The durable terminal lifecycle intent was not created.'
        );
      }
      const insertedIntents = await lockTerminalLifecycleIntents(
        query,
        input.idempotency_key,
        context.work_order_id
      );
      const terminalIntent = insertedIntents[0];
      if (
        insertedIntents.length !== 1 ||
        !terminalIntent ||
        terminalIntent.terminal_intent_id !== terminalIntentId
      ) {
        throw new UniversalV1FulfillmentError(
          'FULFILLMENT_COMPLETION_STATE_CONFLICT',
          'The durable terminal lifecycle intent identity was not preserved.'
        );
      }
      assertTerminalLifecycleIntentIdentity(
        terminalIntent,
        context,
        actorId,
        input,
        intentRequestSha256
      );
      return {
        completed: false as const,
        context,
        terminalIntent,
        predecessor,
        prior,
        priorVersion,
        providerAccount,
      };
    });

    if (prepared.completed) return prepared.result;
    const { terminalIntent, predecessor, prior, priorVersion, providerAccount } = prepared;
    const occurredAt = new Date(terminalIntent.materialized_at).toISOString();
    const common = {
      providerKind: 'FAKE' as const,
      providerExpectedVersion: 0,
      taskDraftId: terminalIntent.task_draft_id,
      taskId: terminalIntent.task_id,
      eligibilityDecisionId: terminalIntent.eligibility_decision_id,
      scopeVersionId: terminalIntent.scope_version_id,
      recordedBy: actorId,
      scenario: 'SUCCESS' as const,
    };
    const capture = await finance.executeFinancialEvent({
      ...common,
      operationKind: 'CAPTURE',
      operationId: deterministicUuid(input.idempotency_key, 'capture'),
      idempotencyKey: `${input.idempotency_key}:capture`,
      lifecycleExpectedVersion: Number(terminalIntent.starting_financial_version) + 1,
      occurredAt,
      predecessorEventId: predecessor.id,
      relatedOperationId: predecessor.operation_id,
      amountCents: Number(terminalIntent.customer_amount_cents),
      currency: terminalIntent.currency.toLowerCase(),
      completionFactId: terminalIntent.completion_fact_id,
    });

    let settlement: Awaited<ReturnType<typeof finance.executeFinancialEvent>> | null = null;
    let funding: Awaited<ReturnType<typeof finance.executeFinancialEvent>> | null = null;
    let providerRelease: Awaited<ReturnType<typeof finance.executeFinancialEvent>> | null = null;
    let payout: Awaited<ReturnType<typeof finance.executeFinancialEvent>> | null = null;
    let bankSettlement: Awaited<ReturnType<typeof finance.executeFinancialEvent>> | null = null;
    let refund: Awaited<ReturnType<typeof finance.executeFinancialEvent>> | null = null;
    if (input.path === 'SETTLED') {
      if (!providerAccount) {
        throw new UniversalV1FulfillmentError(
          'FULFILLMENT_PROVIDER_ACCOUNT_UNAVAILABLE',
          'The exact provider account authority was not preserved for settlement.'
        );
      }
      settlement = await finance.executeFinancialEvent({
        ...common,
        operationKind: 'SETTLE',
        operationId: deterministicUuid(input.idempotency_key, 'settle'),
        idempotencyKey: `${input.idempotency_key}:settle`,
        lifecycleExpectedVersion: Number(terminalIntent.starting_financial_version) + 2,
        occurredAt: new Date(Date.parse(occurredAt) + 1).toISOString(),
        predecessorEventId: capture.id,
        relatedOperationId: capture.operationId,
        amountCents: Number(terminalIntent.customer_amount_cents),
        currency: terminalIntent.currency.toLowerCase(),
      });
      funding = await finance.executeFinancialEvent({
        ...common,
        operationKind: 'FUND',
        operationId: deterministicUuid(input.idempotency_key, 'fund'),
        idempotencyKey: `${input.idempotency_key}:fund`,
        lifecycleExpectedVersion: Number(terminalIntent.starting_financial_version) + 3,
        occurredAt: new Date(Date.parse(occurredAt) + 2).toISOString(),
        predecessorEventId: settlement.id,
        relatedOperationId: settlement.operationId,
        amountCents: Number(terminalIntent.customer_amount_cents),
        currency: terminalIntent.currency.toLowerCase(),
      });
      providerRelease = await finance.executeFinancialEvent({
        ...common,
        operationKind: 'PROVIDER_RELEASE',
        operationId: deterministicUuid(input.idempotency_key, 'provider-release'),
        idempotencyKey: `${input.idempotency_key}:provider-release`,
        lifecycleExpectedVersion: Number(terminalIntent.starting_financial_version) + 4,
        occurredAt: new Date(Date.parse(occurredAt) + 3).toISOString(),
        predecessorEventId: funding.id,
        relatedOperationId: funding.operationId,
        amountCents: Number(terminalIntent.provider_amount_cents),
        currency: terminalIntent.currency.toLowerCase(),
      });
      payout = await finance.executeFinancialEvent({
        ...common,
        operationKind: 'PAYOUT',
        operationId: deterministicUuid(input.idempotency_key, 'payout'),
        idempotencyKey: `${input.idempotency_key}:payout`,
        lifecycleExpectedVersion: Number(terminalIntent.starting_financial_version) + 5,
        occurredAt: new Date(Date.parse(occurredAt) + 4).toISOString(),
        predecessorEventId: providerRelease.id,
        relatedOperationId: providerRelease.operationId,
        amountCents: Number(terminalIntent.provider_amount_cents),
        currency: terminalIntent.currency.toLowerCase(),
        providerAccountReference: providerAccount.providerAccountReference,
      });
      bankSettlement = await finance.executeFinancialEvent({
        ...common,
        operationKind: 'OBSERVE_BANK_SETTLEMENT',
        operationId: deterministicUuid(input.idempotency_key, 'bank-settlement'),
        idempotencyKey: `${input.idempotency_key}:bank-settlement`,
        lifecycleExpectedVersion: Number(terminalIntent.starting_financial_version) + 6,
        occurredAt: new Date(Date.parse(occurredAt) + 5).toISOString(),
        predecessorEventId: payout.id,
        relatedOperationId: payout.operationId,
        amountCents: Number(terminalIntent.provider_amount_cents),
        currency: terminalIntent.currency.toLowerCase(),
      });
    } else {
      refund = await finance.executeFinancialEvent({
        ...common,
        operationKind: 'REFUND',
        operationId: deterministicUuid(input.idempotency_key, 'full-refund'),
        idempotencyKey: `${input.idempotency_key}:refund`,
        lifecycleExpectedVersion: Number(terminalIntent.starting_financial_version) + 2,
        occurredAt: new Date(Date.parse(occurredAt) + 1).toISOString(),
        predecessorEventId: capture.id,
        relatedOperationId: capture.operationId,
        amountCents: Number(terminalIntent.customer_amount_cents),
        originalAmountCents: Number(terminalIntent.customer_amount_cents),
        currency: terminalIntent.currency.toLowerCase(),
      });
    }

    const reconciliationVersion = priorVersion + 1;
    const reconciliation = await finance.reconcile({
      providerKind: 'FAKE',
      operationId: deterministicUuid(input.idempotency_key, 'reconciliation'),
      idempotencyKey: `${input.idempotency_key}:reconciliation`,
      providerExpectedVersion: 0,
      relatedOperationId: (bankSettlement ?? refund ?? capture).operationId,
      terminalIntentId: terminalIntent.terminal_intent_id,
      scenario: 'SUCCESS',
      snapshot: {
        workOrderId: terminalIntent.work_order_id,
        reconciliationVersion,
        ...(prior ? { supersedesFactId: prior.id } : {}),
        captureEventId: capture.id,
        ...(settlement ? { settlementEventId: settlement.id } : {}),
        ...(funding ? { fundingEventId: funding.id } : {}),
        ...(providerRelease ? { providerReleaseEventId: providerRelease.id } : {}),
        ...(payout ? { payoutEventId: payout.id } : {}),
        ...(bankSettlement ? { bankSettlementEventId: bankSettlement.id } : {}),
        ...(refund ? { refundEventId: refund.id } : {}),
        voidState: 'NOT_APPLICABLE',
        captureState: 'CAPTURED',
        refundState: refund ? 'REFUNDED' : 'NOT_APPLICABLE',
        reversalState: 'NOT_APPLICABLE',
        settlementState: settlement ? 'SETTLED' : 'NOT_APPLICABLE',
        fundingState: funding ? 'FUNDED' : 'NOT_APPLICABLE',
        providerReleaseState: providerRelease ? 'RELEASED' : 'NOT_APPLICABLE',
        payoutState: payout ? 'PAID' : 'NOT_APPLICABLE',
        bankSettlementState: bankSettlement ? 'SETTLED' : 'NOT_APPLICABLE',
        ledgerState: 'MATCHED',
        reconciliationState: refund ? 'CLOSED' : 'MATCHED',
        mismatchCodes: [],
        customerLedgerAmountCents: refund ? 0 : Number(terminalIntent.customer_amount_cents),
        providerLedgerAmountCents: refund ? 0 : Number(terminalIntent.provider_amount_cents),
        currency: terminalIntent.currency,
        expectedVersion: priorVersion,
        recordedBy: actorId,
      },
    });

    return {
      reconciliation_id: reconciliation.id,
      reconciliation_version: reconciliation.reconciliationVersion,
      capture_event_id: capture.id,
      settlement_event_id: settlement?.id ?? null,
      funding_event_id: funding?.id ?? null,
      provider_release_event_id: providerRelease?.id ?? null,
      payout_event_id: payout?.id ?? null,
      bank_settlement_event_id: bankSettlement?.id ?? null,
      refund_event_id: refund?.id ?? null,
      path: input.path,
      replayed: false,
      provider_kind: 'FAKE',
      payment_creation_performed: false,
      hard_assignment_created: false,
    };
  }
}
