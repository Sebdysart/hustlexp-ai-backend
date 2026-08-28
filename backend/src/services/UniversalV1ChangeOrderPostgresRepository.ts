import { db, type Database, type QueryFn } from '../db.js';
import {
  type AuthorizeAndMaterializeUniversalV1ChangeOrderPublic,
  type DecidedUniversalV1ChangeOrder,
  type DecideUniversalV1ChangeOrderPublic,
  type MaterializedUniversalV1ChangeOrder,
  type ProposedUniversalV1ChangeOrder,
  type ProposeUniversalV1ChangeOrderPublic,
  type UniversalV1ChangeOrderKind,
  type UniversalV1ChangeOrderParty,
  UniversalV1ChangeOrderError,
} from './UniversalV1ChangeOrderContracts.js';
import {
  deterministicUuid,
  transactionBoundDatabase,
} from './UniversalV1WorkOrderPostgresRepository.js';
import type { UniversalV1FakeFinancialApplicationService } from './payment/UniversalV1FinancialApplicationService.js';

type StoredChangeOrderKind = UniversalV1ChangeOrderKind | 'SCHEDULE_AND_SCOPE';
type FinancePort = Pick<UniversalV1FakeFinancialApplicationService, 'executeFinancialEvent'>;
export type UniversalV1ChangeOrderFinanceFactory = (database: Database) => FinancePort;

export interface UniversalV1ChangeOrderRepository {
  proposeChangeOrder(
    actorId: string,
    input: ProposeUniversalV1ChangeOrderPublic
  ): Promise<ProposedUniversalV1ChangeOrder>;
  decideChangeOrder(
    actorId: string,
    input: DecideUniversalV1ChangeOrderPublic
  ): Promise<DecidedUniversalV1ChangeOrder>;
  readFinalizationKind(actorId: string, proposalId: string): Promise<StoredChangeOrderKind | null>;
  authorizeAndMaterializeFakeChangeOrder(
    actorId: string,
    input: AuthorizeAndMaterializeUniversalV1ChangeOrderPublic,
    financeFactory?: UniversalV1ChangeOrderFinanceFactory
  ): Promise<MaterializedUniversalV1ChangeOrder>;
}

interface EffectiveScopeRow {
  scope_version_id: string;
  scope_version: number;
  scope_hash: string;
  title: string;
  description: string;
  requirements: string | null;
  checklist: unknown;
  customer_total_cents: string | number;
  provider_payout_cents: string | number;
  currency: string;
}

interface ProposalContextRow extends EffectiveScopeRow {
  work_order_id: string;
  task_id: string;
  task_draft_id: string;
  poster_user_id: string;
  provider_user_id: string;
  provider_organization_id: string | null;
  latest_amendment_id: string | null;
  latest_amendment_version: number | null;
  latest_proposal_id: string | null;
  latest_proposal_version: number | null;
  latest_proposal_status: string | null;
  actor_is_customer: boolean;
  actor_is_provider: boolean;
  provider_authority_current: boolean;
}

interface ProposalRow {
  id: string;
  task_id: string;
  base_version_id: string;
  proposal_version: number;
  supersedes_proposal_id: string | null;
  change_order_kind: StoredChangeOrderKind;
  proposed_by: string;
  proposer_role: 'POSTER' | 'HUSTLER';
  observed_scope_summary: string;
  proposed_checklist: unknown;
  proposed_customer_total_cents: string | number | null;
  proposed_provider_payout_cents: string | number | null;
  proposed_title: string;
  proposed_description: string;
  proposed_requirements: string | null;
  proposed_scope_sha256: string;
  request_sha256: string;
  idempotency_key: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELED';
  replay_base_scope_version: number;
  replay_base_customer_total_cents: string | number;
  replay_base_provider_payout_cents: string | number;
  replay_base_currency: string;
  replay_base_amendment_version: number;
}

interface DecisionContextRow extends EffectiveScopeRow {
  proposal_id: string;
  proposal_version: number;
  proposal_status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELED';
  proposal_request_sha256: string;
  base_version_id: string;
  work_order_id: string;
  task_id: string;
  poster_user_id: string;
  provider_user_id: string;
  provider_organization_id: string | null;
  customer_approval_actor_id: string | null;
  provider_approval_actor_id: string | null;
  actor_is_customer: boolean;
  actor_is_provider: boolean;
  provider_authority_current: boolean;
}

interface ApprovalRow {
  id: string;
  proposal_id: string;
  approver_role: UniversalV1ChangeOrderParty;
  decision: 'APPROVED' | 'REJECTED';
  actor_id: string;
  expected_proposal_version: number;
  reason: string;
  idempotency_key: string;
  request_sha256: string;
}

interface FinalizationContextRow extends EffectiveScopeRow {
  proposal_id: string;
  proposal_version: number;
  proposal_status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELED';
  proposal_request_sha256: string;
  base_version_id: string;
  change_order_kind: StoredChangeOrderKind;
  observed_scope_summary: string;
  proposed_title: string | null;
  proposed_description: string | null;
  proposed_requirements: string | null;
  proposed_checklist: unknown;
  proposed_customer_total_cents: string | number | null;
  proposed_provider_payout_cents: string | number | null;
  proposed_scope_sha256: string | null;
  financial_adjustment_required: boolean;
  work_order_id: string;
  task_id: string;
  task_draft_id: string;
  poster_user_id: string;
  provider_user_id: string;
  provider_organization_id: string | null;
  eligibility_decision_id: string;
  latest_amendment_id: string | null;
  latest_amendment_version: number | null;
  customer_approval_actor_id: string | null;
  customer_approval_decision: string | null;
  provider_approval_actor_id: string | null;
  provider_approval_decision: string | null;
  provider_approval_current: boolean;
  customer_approval_current: boolean;
  provider_authority_current: boolean;
  latest_financial_event_id: string;
  latest_financial_operation_id: string;
  latest_financial_event_kind: string;
  latest_financial_status: string;
  latest_financial_version: number;
  latest_financial_occurred_at: Date | string;
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

interface FinalizationReplayRow {
  amendment_id: string;
  amendment_version: number;
  change_order_id: string;
  proposal_version: number;
  scope_version_id: string;
  scope_version: number;
  adjustment_event_id: string | null;
  adjustment_expected_version: number | null;
  expected_financial_version: number;
  change_order_kind: StoredChangeOrderKind;
  proposal_request_sha256: string;
  request_sha256: string;
  materialized_by: string;
  adjustment_event_kind: string | null;
  adjustment_status: string | null;
  adjustment_provider_kind: string | null;
  execution_fact_id: string;
  execution_version: number;
  execution_state: string;
  execution_actor_user_id: string;
}

function fail(
  code: ConstructorParameters<typeof UniversalV1ChangeOrderError>[0],
  message: string
): never {
  throw new UniversalV1ChangeOrderError(code, message);
}

function number(value: string | number | null, code: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return fail('CHANGE_ORDER_CONTEXT_UNAVAILABLE', code);
  }
  return parsed;
}

function nonnegativeVersion(value: number | null): number {
  if (value === null) return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return fail('CHANGE_ORDER_CONTEXT_UNAVAILABLE', 'Stored version is invalid.');
  }
  return parsed;
}

function exactParty(row: {
  actor_is_customer: boolean;
  actor_is_provider: boolean;
}): UniversalV1ChangeOrderParty {
  if (row.actor_is_customer === row.actor_is_provider) {
    return fail(
      'CHANGE_ORDER_AUTHORITY_REVOKED',
      'The actor must represent exactly one independent Work Order party.'
    );
  }
  return row.actor_is_customer ? 'CUSTOMER' : 'PROVIDER';
}

function checklist(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== 'string' || !entry.trim())
  ) {
    return fail('CHANGE_ORDER_CONTEXT_UNAVAILABLE', 'Stored scope checklist is invalid.');
  }
  return value as string[];
}

function sameNullable(left: string | null, right: string | null): boolean {
  return left === right;
}

function scopeContentChanged(
  current: EffectiveScopeRow,
  proposed: {
    title: string;
    description: string;
    requirements: string | null;
    checklist: readonly string[];
  }
): boolean {
  return (
    current.title !== proposed.title ||
    current.description !== proposed.description ||
    !sameNullable(current.requirements, proposed.requirements) ||
    JSON.stringify(checklist(current.checklist)) !== JSON.stringify(proposed.checklist)
  );
}

async function databaseScopeHash(
  query: QueryFn,
  scope: {
    title: string;
    description: string;
    requirements: string | null;
    checklist: readonly string[];
  },
  customerTotalCents: number,
  providerPayoutCents: number,
  currency: string
): Promise<string> {
  const result = await query<{ scope_sha256: string }>(
    `SELECT public.universal_v1_change_scope_sha256(
       $1::text, $2::text, $3::text, $4::jsonb, $5::integer, $6::integer, $7::char(3)
     ) AS scope_sha256`,
    [
      scope.title,
      scope.description,
      scope.requirements,
      JSON.stringify(scope.checklist),
      customerTotalCents,
      providerPayoutCents,
      currency,
    ]
  );
  const hash = result.rows[0]?.scope_sha256;
  if (!hash || !/^[a-f0-9]{64}$/u.test(hash)) {
    return fail(
      'CHANGE_ORDER_SCOPE_HASH_MISMATCH',
      'PostgreSQL did not return the authoritative change-scope digest.'
    );
  }
  return hash;
}

async function databaseRequestHash(
  query: QueryFn,
  sql: string,
  parameters: unknown[]
): Promise<string> {
  const result = await query<{ request_sha256: string }>(sql, parameters);
  const hash = result.rows[0]?.request_sha256;
  if (!hash || !/^[a-f0-9]{64}$/u.test(hash)) {
    return fail(
      'CHANGE_ORDER_IDEMPOTENCY_CONFLICT',
      'PostgreSQL did not return the authoritative command digest.'
    );
  }
  return hash;
}

const EFFECTIVE_SCOPE_SELECT = `
  scope.id AS scope_version_id,
  scope.version AS scope_version,
  scope.scope_hash,
  scope.title,
  scope.description,
  scope.requirements,
  scope.checklist,
  scope.customer_total_cents,
  scope.hustler_payout_cents AS provider_payout_cents,
  scope.currency`;

const PROPOSAL_CONTEXT_SQL = `
  SELECT work_order.id AS work_order_id,
         work_order.task_id,
         work_order.task_draft_id,
         task.poster_id AS poster_user_id,
         work_order.provider_user_id,
         work_order.provider_organization_id,
         ${EFFECTIVE_SCOPE_SELECT},
         latest_amendment.id AS latest_amendment_id,
         latest_amendment.amendment_version AS latest_amendment_version,
         latest_proposal.id AS latest_proposal_id,
         latest_proposal.proposal_version AS latest_proposal_version,
         latest_proposal.status AS latest_proposal_status,
         (
           (
             task.business_organization_id IS NULL
             AND task.poster_id = $2::uuid
           )
           OR (
             task.business_organization_id IS NOT NULL
             AND customer_organization.status = 'ACTIVE'
             AND customer_organization.client_enabled IS TRUE
             AND public.business_membership_has_action(
               task.business_organization_id,
               $2::uuid,
               'CREATE_WORK_ORDER'
             )
           )
         ) AS actor_is_customer,
         (
           work_order.provider_user_id = $2::uuid
           OR (
             work_order.provider_organization_id IS NOT NULL
             AND organization.status = 'ACTIVE'
             AND organization.provider_enabled IS TRUE
             AND public.business_membership_has_action(
               work_order.provider_organization_id,
               $2::uuid,
               'CREATE_WORK_ORDER'
             )
           )
         ) AS actor_is_provider,
         public.universal_v1_invited_provider_authority_is_current(
           eligibility.provider_user_id,
           eligibility.provider_organization_id,
           eligibility.provider_class,
           eligibility.trade_credential_id,
           task.category,
           task.region_code
         ) AS provider_authority_current
    FROM task_work_orders work_order
    JOIN tasks task ON task.id = work_order.task_id
    JOIN task_drafts draft ON draft.id = work_order.task_draft_id
    JOIN task_provider_eligibility_decisions eligibility
      ON eligibility.id = work_order.eligibility_decision_id
    JOIN users actor ON actor.id = $2::uuid
    JOIN users provider ON provider.id = work_order.provider_user_id
    LEFT JOIN business_organizations organization
      ON organization.id = work_order.provider_organization_id
    LEFT JOIN business_organizations customer_organization
      ON customer_organization.id = task.business_organization_id
    LEFT JOIN LATERAL (
      SELECT amendment.id, amendment.amendment_version, amendment.scope_version_id
        FROM task_work_order_amendments amendment
       WHERE amendment.work_order_id = work_order.id
       ORDER BY amendment.amendment_version DESC
       LIMIT 1
    ) latest_amendment ON TRUE
    JOIN task_scope_versions scope
      ON scope.id = COALESCE(latest_amendment.scope_version_id, work_order.scope_version_id)
    LEFT JOIN LATERAL (
      SELECT proposal.id, proposal.proposal_version, proposal.status
        FROM task_scope_change_proposals proposal
       WHERE proposal.task_id = task.id
         AND proposal.universal_contract_version = 1
       ORDER BY proposal.proposal_version DESC
       LIMIT 1
    ) latest_proposal ON TRUE
   WHERE work_order.id = $1::uuid
     AND task.work_order_id = work_order.id
     AND task.active_scope_version_id = scope.id
     AND task.universal_contract_version = 1
     AND draft.universal_contract_version = 1
     AND task.automation_classification = 'CONTROLLED_TEST'
     AND task.worker_id IS NULL
     AND task.universal_payment_posture = 'PAYMENT_CREATION_FROZEN'
     AND actor.account_status = 'ACTIVE'
     AND actor.is_minor IS FALSE
     AND COALESCE(actor.is_banned, FALSE) IS FALSE
     AND provider.account_status = 'ACTIVE'
     AND provider.is_minor IS FALSE
     AND COALESCE(provider.is_banned, FALSE) IS FALSE
     AND NOT EXISTS (
       SELECT 1 FROM task_completion_facts completion
        WHERE completion.work_order_id = work_order.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM task_reconciliation_facts reconciliation
        WHERE reconciliation.work_order_id = work_order.id
     )
   FOR UPDATE OF work_order, task, draft, eligibility, actor, provider, scope`;

function proposedResult(row: ProposalRow, replayed: boolean): ProposedUniversalV1ChangeOrder {
  return {
    proposal_id: row.id,
    proposal_version: Number(row.proposal_version),
    change_order_kind: row.change_order_kind as UniversalV1ChangeOrderKind,
    proposer_party: row.proposer_role === 'POSTER' ? 'CUSTOMER' : 'PROVIDER',
    proposed_scope_sha256: row.proposed_scope_sha256,
    replayed,
    payment_creation_performed: false,
    hard_assignment_created: false,
  };
}

function decisionResult(row: ApprovalRow, status: 'PENDING' | 'REJECTED', replayed: boolean) {
  return {
    approval_id: row.id,
    proposal_id: row.proposal_id,
    proposal_version: Number(row.expected_proposal_version),
    approver_party: row.approver_role,
    decision: row.decision,
    proposal_status: status,
    replayed,
    payment_creation_performed: false as const,
    hard_assignment_created: false as const,
  };
}

export class PostgresUniversalV1ChangeOrderRepository implements UniversalV1ChangeOrderRepository {
  constructor(private readonly database: Database = db) {}

  async proposeChangeOrder(
    actorId: string,
    input: ProposeUniversalV1ChangeOrderPublic
  ): Promise<ProposedUniversalV1ChangeOrder> {
    return this.database.serializableTransaction(async (query) => {
      await query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended('universal-v1-change-order:' || $1::text, 0)
         )`,
        [input.work_order_id]
      );
      const contextResult = await query<ProposalContextRow>(PROPOSAL_CONTEXT_SQL, [
        input.work_order_id,
        actorId,
      ]);
      const context = contextResult.rows[0];
      if (!context || !context.provider_authority_current) {
        return fail(
          'CHANGE_ORDER_CONTEXT_UNAVAILABLE',
          'The exact current Work Order change context is unavailable.'
        );
      }
      const party = exactParty(context);
      const proposerRole = party === 'CUSTOMER' ? 'POSTER' : 'HUSTLER';
      const replay = await query<ProposalRow>(
        `SELECT proposal.id,
                proposal.task_id,
                proposal.base_version_id,
                proposal.proposal_version,
                proposal.supersedes_proposal_id,
                proposal.change_order_kind,
                proposal.proposed_by,
                proposal.proposer_role,
                proposal.observed_scope_summary,
                proposal.proposed_checklist,
                proposal.proposed_customer_total_cents,
                proposal.proposed_provider_payout_cents,
                proposal.proposed_title,
                proposal.proposed_description,
                proposal.proposed_requirements,
                proposal.proposed_scope_sha256,
                proposal.request_sha256,
                proposal.idempotency_key,
                proposal.status,
                base_scope.version AS replay_base_scope_version,
                base_scope.customer_total_cents AS replay_base_customer_total_cents,
                base_scope.hustler_payout_cents AS replay_base_provider_payout_cents,
                base_scope.currency AS replay_base_currency,
                CASE
                  WHEN proposal.base_version_id = replay_work_order.scope_version_id THEN 0
                  ELSE COALESCE(replay_base_amendment.amendment_version, -1)
                END AS replay_base_amendment_version
           FROM task_scope_change_proposals proposal
           JOIN task_scope_versions base_scope
             ON base_scope.id = proposal.base_version_id
            AND base_scope.task_id = proposal.task_id
           JOIN task_work_orders replay_work_order
             ON replay_work_order.task_id = proposal.task_id
           LEFT JOIN LATERAL (
             SELECT amendment.amendment_version
               FROM task_work_order_amendments amendment
              WHERE amendment.work_order_id = replay_work_order.id
                AND amendment.scope_version_id = proposal.base_version_id
              ORDER BY amendment.amendment_version DESC
              LIMIT 1
           ) replay_base_amendment ON TRUE
          WHERE proposal.idempotency_key = $1
            AND proposal.universal_contract_version = 1
            AND proposal.application_contract_version = 1
          FOR UPDATE OF proposal`,
        [input.idempotency_key]
      );
      if (replay.rows[0]) {
        const row = replay.rows[0];
        const replayChecklist = checklist(row.proposed_checklist);
        const exactStoredCommand =
          row.task_id === context.task_id &&
          row.proposed_by === actorId &&
          row.proposer_role === proposerRole &&
          Number(row.proposal_version) === input.expected_latest_proposal_version + 1 &&
          Number(row.replay_base_scope_version) === input.expected_scope_version &&
          Number(row.replay_base_amendment_version) === input.expected_amendment_version &&
          row.change_order_kind === input.change_order_kind &&
          row.observed_scope_summary === input.observed_scope_summary &&
          row.proposed_title === input.proposed_scope.title &&
          row.proposed_description === input.proposed_scope.description &&
          row.proposed_requirements === input.proposed_scope.requirements &&
          JSON.stringify(replayChecklist) === JSON.stringify(input.proposed_scope.checklist) &&
          (input.change_order_kind === 'PRICE_AND_SCOPE'
            ? Number(row.proposed_customer_total_cents) === input.proposed_customer_total_cents &&
              Number(row.proposed_provider_payout_cents) === input.proposed_provider_payout_cents
            : row.proposed_customer_total_cents === null &&
              row.proposed_provider_payout_cents === null);
        if (!exactStoredCommand) {
          return fail(
            'CHANGE_ORDER_IDEMPOTENCY_CONFLICT',
            'The proposal idempotency key was already used differently.'
          );
        }
        const replayCustomerTotal =
          input.change_order_kind === 'PRICE_AND_SCOPE'
            ? input.proposed_customer_total_cents
            : number(
                row.replay_base_customer_total_cents,
                'The replay base customer total is invalid.'
              );
        const replayProviderPayout =
          input.change_order_kind === 'PRICE_AND_SCOPE'
            ? input.proposed_provider_payout_cents
            : number(
                row.replay_base_provider_payout_cents,
                'The replay base provider payout is invalid.'
              );
        const replayScopeSha256 = await databaseScopeHash(
          query,
          input.proposed_scope,
          replayCustomerTotal,
          replayProviderPayout,
          row.replay_base_currency
        );
        const replayRequestSha256 = await databaseRequestHash(
          query,
          `SELECT public.universal_v1_change_proposal_request_sha256(
             $1::uuid, $2::uuid, $3::uuid, $4::text, $5::integer,
             $6::uuid, $7::text, $8::text, $9::char(64), $10::text
           ) AS request_sha256`,
          [
            row.task_id,
            row.base_version_id,
            actorId,
            proposerRole,
            Number(row.proposal_version),
            row.supersedes_proposal_id,
            input.change_order_kind,
            input.observed_scope_summary,
            replayScopeSha256,
            input.idempotency_key,
          ]
        );
        if (
          row.proposed_scope_sha256 !== replayScopeSha256 ||
          row.request_sha256 !== replayRequestSha256
        ) {
          return fail(
            'CHANGE_ORDER_IDEMPOTENCY_CONFLICT',
            'The proposal idempotency key was already used differently.'
          );
        }
        return proposedResult(row, true);
      }

      const amendmentVersion = nonnegativeVersion(context.latest_amendment_version);
      const latestProposalVersion = nonnegativeVersion(context.latest_proposal_version);
      if (
        Number(context.scope_version) !== input.expected_scope_version ||
        amendmentVersion !== input.expected_amendment_version ||
        latestProposalVersion !== input.expected_latest_proposal_version
      ) {
        return fail('CHANGE_ORDER_VERSION_CONFLICT', 'The Work Order changed.');
      }
      if (context.latest_proposal_status === 'PENDING') {
        return fail(
          'CHANGE_ORDER_STATE_CONFLICT',
          'The Work Order already has a pending change order.'
        );
      }
      if (!scopeContentChanged(context, input.proposed_scope)) {
        return fail(
          'CHANGE_ORDER_STATE_CONFLICT',
          'A change order must change the exact execution scope.'
        );
      }

      const currentCustomerTotal = number(
        context.customer_total_cents,
        'Current customer total is invalid.'
      );
      const currentProviderPayout = number(
        context.provider_payout_cents,
        'Current provider payout is invalid.'
      );
      const customerTotal =
        input.change_order_kind === 'PRICE_AND_SCOPE'
          ? input.proposed_customer_total_cents
          : currentCustomerTotal;
      const providerPayout =
        input.change_order_kind === 'PRICE_AND_SCOPE'
          ? input.proposed_provider_payout_cents
          : currentProviderPayout;
      if (input.change_order_kind === 'PRICE_AND_SCOPE' && customerTotal === currentCustomerTotal) {
        return fail(
          'CHANGE_ORDER_STATE_CONFLICT',
          'A price-and-scope change must change the exact economics.'
        );
      }
      if (providerPayout > customerTotal) {
        return fail(
          'CHANGE_ORDER_STATE_CONFLICT',
          'Provider payout cannot exceed the customer total.'
        );
      }

      const scopeSha256 = await databaseScopeHash(
        query,
        input.proposed_scope,
        customerTotal,
        providerPayout,
        context.currency
      );
      const proposalVersion = latestProposalVersion + 1;
      const predecessorProposalId = proposalVersion === 1 ? null : context.latest_proposal_id;
      const requestSha256 = await databaseRequestHash(
        query,
        `SELECT public.universal_v1_change_proposal_request_sha256(
           $1::uuid, $2::uuid, $3::uuid, $4::text, $5::integer,
           $6::uuid, $7::text, $8::text, $9::char(64), $10::text
         ) AS request_sha256`,
        [
          context.task_id,
          context.scope_version_id,
          actorId,
          proposerRole,
          proposalVersion,
          predecessorProposalId,
          input.change_order_kind,
          input.observed_scope_summary,
          scopeSha256,
          input.idempotency_key,
        ]
      );
      const inserted = await query<ProposalRow>(
        `INSERT INTO task_scope_change_proposals (
           task_id, base_version_id, proposed_by, proposer_role,
           observed_scope_summary, proposed_checklist, status,
           universal_contract_version, application_contract_version,
           proposal_version, supersedes_proposal_id, change_order_kind,
           proposed_customer_total_cents, proposed_provider_payout_cents,
           proposed_title, proposed_description, proposed_requirements,
           proposed_scope_sha256, schedule_effect,
           financial_adjustment_required, idempotency_key, request_sha256
         ) VALUES (
           $1, $2, $3, $4, $5, $6::jsonb, 'PENDING', 1, 1,
           $7, $8, $9, $10, $11, $12, $13, $14, $15,
           NULL, $16, $17, $18
         )
         RETURNING id, proposal_version, change_order_kind, proposed_by,
                   proposer_role, proposed_scope_sha256, request_sha256,
                   idempotency_key, status`,
        [
          context.task_id,
          context.scope_version_id,
          actorId,
          proposerRole,
          input.observed_scope_summary,
          JSON.stringify(input.proposed_scope.checklist),
          proposalVersion,
          predecessorProposalId,
          input.change_order_kind,
          input.change_order_kind === 'PRICE_AND_SCOPE' ? customerTotal : null,
          input.change_order_kind === 'PRICE_AND_SCOPE' ? providerPayout : null,
          input.proposed_scope.title,
          input.proposed_scope.description,
          input.proposed_scope.requirements,
          scopeSha256,
          input.change_order_kind === 'PRICE_AND_SCOPE',
          input.idempotency_key,
          requestSha256,
        ]
      );
      const proposal = inserted.rows[0];
      if (!proposal) {
        return fail(
          'CHANGE_ORDER_MATERIALIZATION_FAILED',
          'The immutable change-order proposal was not created.'
        );
      }
      return proposedResult(proposal, false);
    });
  }

  async decideChangeOrder(
    actorId: string,
    input: DecideUniversalV1ChangeOrderPublic
  ): Promise<DecidedUniversalV1ChangeOrder> {
    return this.database.serializableTransaction(async (query) => {
      await query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended('universal-v1-change-order-proposal:' || $1::text, 0)
         )`,
        [input.proposal_id]
      );
      const contextResult = await query<DecisionContextRow>(
        `SELECT proposal.id AS proposal_id,
                proposal.proposal_version,
                proposal.status AS proposal_status,
                proposal.request_sha256 AS proposal_request_sha256,
                proposal.base_version_id,
                work_order.id AS work_order_id,
                work_order.task_id,
                task.poster_id AS poster_user_id,
                work_order.provider_user_id,
                work_order.provider_organization_id,
                ${EFFECTIVE_SCOPE_SELECT},
                customer_approval.actor_id AS customer_approval_actor_id,
                provider_approval.actor_id AS provider_approval_actor_id,
                (
                  (
                    task.business_organization_id IS NULL
                    AND task.poster_id = $2::uuid
                  )
                  OR (
                    task.business_organization_id IS NOT NULL
                    AND customer_organization.status = 'ACTIVE'
                    AND customer_organization.client_enabled IS TRUE
                    AND public.business_membership_has_action(
                      task.business_organization_id,
                      $2::uuid,
                      'APPROVE_SPEND'
                    )
                  )
                ) AS actor_is_customer,
                (
                  work_order.provider_user_id = $2::uuid
                  OR (
                    work_order.provider_organization_id IS NOT NULL
                    AND organization.status = 'ACTIVE'
                    AND organization.provider_enabled IS TRUE
                    AND public.business_membership_has_action(
                      work_order.provider_organization_id,
                      $2::uuid,
                      'APPROVE_SPEND'
                    )
                  )
                ) AS actor_is_provider,
                public.universal_v1_invited_provider_authority_is_current(
                  eligibility.provider_user_id,
                  eligibility.provider_organization_id,
                  eligibility.provider_class,
                  eligibility.trade_credential_id,
                  task.category,
                  task.region_code
                ) AS provider_authority_current
           FROM task_scope_change_proposals proposal
           JOIN tasks task ON task.id = proposal.task_id
           JOIN task_work_orders work_order ON work_order.task_id = task.id
           JOIN task_provider_eligibility_decisions eligibility
             ON eligibility.id = work_order.eligibility_decision_id
           JOIN users actor ON actor.id = $2::uuid
           JOIN users provider ON provider.id = work_order.provider_user_id
           LEFT JOIN business_organizations organization
             ON organization.id = work_order.provider_organization_id
           LEFT JOIN business_organizations customer_organization
             ON customer_organization.id = task.business_organization_id
           LEFT JOIN LATERAL (
             SELECT amendment.scope_version_id
               FROM task_work_order_amendments amendment
              WHERE amendment.work_order_id = work_order.id
              ORDER BY amendment.amendment_version DESC
              LIMIT 1
           ) latest_amendment ON TRUE
           JOIN task_scope_versions scope
             ON scope.id = COALESCE(latest_amendment.scope_version_id, work_order.scope_version_id)
           LEFT JOIN task_scope_change_approvals customer_approval
             ON customer_approval.proposal_id = proposal.id
            AND customer_approval.approver_role = 'CUSTOMER'
           LEFT JOIN task_scope_change_approvals provider_approval
             ON provider_approval.proposal_id = proposal.id
            AND provider_approval.approver_role = 'PROVIDER'
          WHERE proposal.id = $1::uuid
            AND proposal.universal_contract_version = 1
            AND proposal.application_contract_version = 1
            AND task.work_order_id = work_order.id
            AND task.universal_contract_version = 1
            AND task.automation_classification = 'CONTROLLED_TEST'
            AND task.worker_id IS NULL
            AND task.universal_payment_posture = 'PAYMENT_CREATION_FROZEN'
            AND actor.account_status = 'ACTIVE'
            AND actor.is_minor IS FALSE
            AND COALESCE(actor.is_banned, FALSE) IS FALSE
            AND provider.account_status = 'ACTIVE'
            AND provider.is_minor IS FALSE
            AND COALESCE(provider.is_banned, FALSE) IS FALSE
          FOR UPDATE OF proposal, task, work_order, eligibility, actor, provider, scope`,
        [input.proposal_id, actorId]
      );
      const context = contextResult.rows[0];
      if (!context || !context.provider_authority_current) {
        return fail(
          'CHANGE_ORDER_CONTEXT_UNAVAILABLE',
          'The exact change-order decision context is unavailable.'
        );
      }
      const party = exactParty(context);
      const requestSha256 = await databaseRequestHash(
        query,
        `SELECT public.universal_v1_change_decision_request_sha256(
           $1::uuid, $2::integer, $3::text, $4::text,
           $5::uuid, $6::text, $7::text
         ) AS request_sha256`,
        [
          input.proposal_id,
          input.expected_proposal_version,
          party,
          input.decision,
          actorId,
          input.reason,
          input.idempotency_key,
        ]
      );
      const replay = await query<ApprovalRow>(
        `SELECT id, proposal_id, approver_role, decision, actor_id,
                expected_proposal_version, reason, idempotency_key, request_sha256
           FROM task_scope_change_approvals
          WHERE idempotency_key = $1
            AND proposal_id = $2::uuid
          FOR UPDATE`,
        [input.idempotency_key, input.proposal_id]
      );
      if (replay.rows[0]) {
        if (replay.rows[0].request_sha256 !== requestSha256) {
          return fail(
            'CHANGE_ORDER_IDEMPOTENCY_CONFLICT',
            'The decision idempotency key was already used differently.'
          );
        }
        return decisionResult(
          replay.rows[0],
          replay.rows[0].decision === 'REJECTED' ? 'REJECTED' : 'PENDING',
          true
        );
      }
      if (
        Number(context.proposal_version) !== input.expected_proposal_version ||
        context.proposal_status !== 'PENDING' ||
        context.base_version_id !== context.scope_version_id
      ) {
        return fail(
          'CHANGE_ORDER_VERSION_CONFLICT',
          'The change-order proposal or active scope changed.'
        );
      }
      const samePartyActor =
        party === 'CUSTOMER'
          ? context.customer_approval_actor_id
          : context.provider_approval_actor_id;
      const otherPartyActor =
        party === 'CUSTOMER'
          ? context.provider_approval_actor_id
          : context.customer_approval_actor_id;
      if (samePartyActor) {
        return fail('CHANGE_ORDER_STATE_CONFLICT', 'This party already decided the change order.');
      }
      if (otherPartyActor === actorId) {
        return fail(
          'CHANGE_ORDER_INDEPENDENT_APPROVAL_REQUIRED',
          'Customer and provider approvals require different authenticated principals.'
        );
      }

      const inserted = await query<ApprovalRow>(
        `INSERT INTO task_scope_change_approvals (
           proposal_id, approver_role, decision, actor_id,
           expected_proposal_version, reason, idempotency_key, request_sha256
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, proposal_id, approver_role, decision, actor_id,
                   expected_proposal_version, reason, idempotency_key, request_sha256`,
        [
          context.proposal_id,
          party,
          input.decision,
          actorId,
          input.expected_proposal_version,
          input.reason,
          input.idempotency_key,
          requestSha256,
        ]
      );
      const approval = inserted.rows[0];
      if (!approval) {
        return fail(
          'CHANGE_ORDER_MATERIALIZATION_FAILED',
          'The immutable party decision was not created.'
        );
      }
      if (input.decision === 'REJECTED') {
        const rejected = await query(
          `UPDATE task_scope_change_proposals
              SET status = 'REJECTED',
                  reviewed_by = $2,
                  reviewed_at = clock_timestamp(),
                  decision_reason = $3,
                  updated_at = clock_timestamp()
            WHERE id = $1
              AND status = 'PENDING'`,
          [context.proposal_id, actorId, input.reason]
        );
        if (rejected.rowCount !== 1) {
          return fail(
            'CHANGE_ORDER_VERSION_CONFLICT',
            'The rejected proposal did not terminalize exactly once.'
          );
        }
      }
      return decisionResult(
        approval,
        input.decision === 'REJECTED' ? 'REJECTED' : 'PENDING',
        false
      );
    });
  }

  async readFinalizationKind(
    actorId: string,
    proposalId: string
  ): Promise<StoredChangeOrderKind | null> {
    const result = await this.database.readQuery<{ change_order_kind: StoredChangeOrderKind }>(
      `SELECT proposal.change_order_kind
         FROM task_scope_change_proposals proposal
         JOIN tasks task ON task.id = proposal.task_id
         JOIN task_work_orders work_order ON work_order.task_id = task.id
         JOIN users actor ON actor.id = $2::uuid
         LEFT JOIN business_organizations customer_organization
           ON customer_organization.id = task.business_organization_id
        WHERE proposal.id = $1::uuid
          AND proposal.universal_contract_version = 1
          AND proposal.application_contract_version = 1
          AND task.work_order_id = work_order.id
          AND (
            (
              task.business_organization_id IS NULL
              AND task.poster_id = $2::uuid
            )
            OR (
              task.business_organization_id IS NOT NULL
              AND customer_organization.status = 'ACTIVE'
              AND customer_organization.client_enabled IS TRUE
              AND public.business_membership_has_action(
                task.business_organization_id,
                $2::uuid,
                'APPROVE_SPEND'
              )
            )
          )
          AND task.universal_contract_version = 1
          AND task.automation_classification = 'CONTROLLED_TEST'
          AND task.worker_id IS NULL
          AND task.universal_payment_posture = 'PAYMENT_CREATION_FROZEN'
          AND actor.account_status = 'ACTIVE'
          AND actor.is_minor IS FALSE
          AND COALESCE(actor.is_banned, FALSE) IS FALSE`,
      [proposalId, actorId]
    );
    return result.rows[0]?.change_order_kind ?? null;
  }

  async authorizeAndMaterializeFakeChangeOrder(
    actorId: string,
    input: AuthorizeAndMaterializeUniversalV1ChangeOrderPublic,
    financeFactory?: UniversalV1ChangeOrderFinanceFactory
  ): Promise<MaterializedUniversalV1ChangeOrder> {
    return this.database.serializableTransaction(async (query) => {
      await query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended('universal-v1-change-order-proposal:' || $1::text, 0)
         )`,
        [input.proposal_id]
      );

      const executionLockContext = await query<{ work_order_id: string }>(
        `SELECT work_order.id AS work_order_id
           FROM task_scope_change_proposals proposal
           JOIN task_work_orders work_order ON work_order.task_id = proposal.task_id
          WHERE proposal.id = $1::uuid`,
        [input.proposal_id]
      );
      const lockedWorkOrderId = executionLockContext.rows[0]?.work_order_id;
      if (!lockedWorkOrderId) {
        return fail(
          'CHANGE_ORDER_CONTEXT_UNAVAILABLE',
          'The change order is not bound to a Work Order.'
        );
      }
      await query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `fulfillment:${lockedWorkOrderId}`,
      ]);

      const replay = await query<FinalizationReplayRow>(
        `SELECT amendment.id AS amendment_id,
                amendment.amendment_version,
                amendment.change_order_id,
                proposal.proposal_version,
                amendment.scope_version_id,
                scope.version AS scope_version,
                amendment.adjustment_event_id,
                amendment.expected_financial_version,
                adjustment.expected_version AS adjustment_expected_version,
                proposal.change_order_kind,
                proposal.request_sha256 AS proposal_request_sha256,
                amendment.request_sha256,
                amendment.materialized_by,
                adjustment.event_kind AS adjustment_event_kind,
                adjustment.status AS adjustment_status,
                adjustment.provider_kind AS adjustment_provider_kind,
                execution.id AS execution_fact_id,
                execution.execution_version,
                execution.state AS execution_state,
                execution.actor_user_id AS execution_actor_user_id
           FROM task_work_order_amendments amendment
           JOIN task_scope_change_proposals proposal
             ON proposal.id = amendment.change_order_id
           JOIN task_scope_versions scope ON scope.id = amendment.scope_version_id
           JOIN task_work_orders work_order ON work_order.id = amendment.work_order_id
           JOIN tasks task ON task.id = work_order.task_id
           JOIN users actor ON actor.id = $3::uuid
           LEFT JOIN business_organizations customer_organization
             ON customer_organization.id = task.business_organization_id
           LEFT JOIN task_financial_security_events adjustment
              ON adjustment.id = amendment.adjustment_event_id
           JOIN task_work_order_execution_facts execution
              ON execution.work_order_amendment_id = amendment.id
             AND execution.transition_kind = 'APPLY_AMENDMENT'
          WHERE amendment.idempotency_key = $1
            AND amendment.change_order_id = $2::uuid
            AND proposal.universal_contract_version = 1
            AND proposal.application_contract_version = 1
            AND (
              (
                task.business_organization_id IS NULL
                AND task.poster_id = $3::uuid
              )
              OR (
                task.business_organization_id IS NOT NULL
                AND customer_organization.status = 'ACTIVE'
                AND customer_organization.client_enabled IS TRUE
                AND public.business_membership_has_action(
                  task.business_organization_id,
                  $3::uuid,
                  'APPROVE_SPEND'
                )
              )
            )
            AND actor.account_status = 'ACTIVE'
            AND actor.is_minor IS FALSE
            AND COALESCE(actor.is_banned, FALSE) IS FALSE
          FOR UPDATE OF amendment, proposal, scope, work_order, task, actor`,
        [input.idempotency_key, input.proposal_id, actorId]
      );
      if (replay.rows[0]) {
        const row = replay.rows[0];
        const priceReplayValid =
          row.change_order_kind !== 'PRICE_AND_SCOPE' ||
          (row.adjustment_event_id !== null &&
            Number(row.adjustment_expected_version) === input.expected_financial_version + 1 &&
            row.adjustment_event_kind === 'ADJUSTMENT_AUTHORIZED' &&
            row.adjustment_status === 'SUCCEEDED' &&
            row.adjustment_provider_kind === 'FAKE');
        if (
          !/^[a-f0-9]{64}$/u.test(row.request_sha256) ||
          row.materialized_by !== actorId ||
          Number(row.expected_financial_version) !== input.expected_financial_version ||
          Number(row.proposal_version) !== input.expected_proposal_version ||
          Number(row.scope_version) !== input.expected_scope_version + 1 ||
          Number(row.amendment_version) !== input.expected_amendment_version + 1 ||
          Number(row.execution_version) !== input.expected_execution_version + 1 ||
          row.execution_actor_user_id !== actorId ||
          !priceReplayValid
        ) {
          return fail(
            'CHANGE_ORDER_IDEMPOTENCY_CONFLICT',
            'The amendment idempotency key has conflicting or incomplete authority.'
          );
        }
        return {
          amendment_id: row.amendment_id,
          amendment_version: Number(row.amendment_version),
          proposal_id: row.change_order_id,
          scope_version_id: row.scope_version_id,
          scope_version: Number(row.scope_version),
          adjustment_event_id: row.adjustment_event_id,
          provider_kind: row.adjustment_event_id ? 'FAKE' : null,
          replayed: true,
          payment_creation_performed: false,
          hard_assignment_created: false,
        };
      }

      const contextResult = await query<FinalizationContextRow>(
        `SELECT proposal.id AS proposal_id,
                proposal.proposal_version,
                proposal.status AS proposal_status,
                proposal.request_sha256 AS proposal_request_sha256,
                proposal.base_version_id,
                proposal.change_order_kind,
                proposal.observed_scope_summary,
                proposal.proposed_title,
                proposal.proposed_description,
                proposal.proposed_requirements,
                proposal.proposed_checklist,
                proposal.proposed_customer_total_cents,
                proposal.proposed_provider_payout_cents,
                proposal.proposed_scope_sha256,
                proposal.financial_adjustment_required,
                work_order.id AS work_order_id,
                work_order.task_id,
                work_order.task_draft_id,
                task.poster_id AS poster_user_id,
                work_order.provider_user_id,
                work_order.provider_organization_id,
                work_order.eligibility_decision_id,
                ${EFFECTIVE_SCOPE_SELECT},
                latest_amendment.id AS latest_amendment_id,
                latest_amendment.amendment_version AS latest_amendment_version,
                customer_approval.actor_id AS customer_approval_actor_id,
                customer_approval.decision AS customer_approval_decision,
                provider_approval.actor_id AS provider_approval_actor_id,
                provider_approval.decision AS provider_approval_decision,
                (
                  (
                    task.business_organization_id IS NULL
                    AND customer_approval.actor_id = task.poster_id
                  )
                  OR (
                    task.business_organization_id IS NOT NULL
                    AND customer_organization.status = 'ACTIVE'
                    AND customer_organization.client_enabled IS TRUE
                    AND public.business_membership_has_action(
                      task.business_organization_id,
                      customer_approval.actor_id,
                      'APPROVE_SPEND'
                    )
                  )
                ) AS customer_approval_current,
                (
                  provider_approval.actor_id = work_order.provider_user_id
                  OR (
                    work_order.provider_organization_id IS NOT NULL
                    AND organization.status = 'ACTIVE'
                    AND organization.provider_enabled IS TRUE
                    AND public.business_membership_has_action(
                      work_order.provider_organization_id,
                      provider_approval.actor_id,
                      'APPROVE_SPEND'
                    )
                  )
                ) AS provider_approval_current,
                public.universal_v1_invited_provider_authority_is_current(
                  eligibility.provider_user_id,
                  eligibility.provider_organization_id,
                  eligibility.provider_class,
                  eligibility.trade_credential_id,
                  task.category,
                  task.region_code
                ) AS provider_authority_current,
                latest_financial.id AS latest_financial_event_id,
                latest_financial.operation_id AS latest_financial_operation_id,
                latest_financial.event_kind AS latest_financial_event_kind,
                latest_financial.status AS latest_financial_status,
                latest_financial.expected_version AS latest_financial_version,
                latest_financial.occurred_at AS latest_financial_occurred_at,
                execution.id AS execution_fact_id,
                execution.execution_version,
                execution.state AS execution_state
           FROM task_scope_change_proposals proposal
           JOIN tasks task ON task.id = proposal.task_id
           JOIN task_work_orders work_order ON work_order.task_id = task.id
           JOIN task_drafts draft ON draft.id = work_order.task_draft_id
           JOIN task_provider_eligibility_decisions eligibility
             ON eligibility.id = work_order.eligibility_decision_id
           JOIN users actor ON actor.id = $2::uuid
           JOIN users provider ON provider.id = work_order.provider_user_id
           LEFT JOIN business_organizations organization
             ON organization.id = work_order.provider_organization_id
           LEFT JOIN business_organizations customer_organization
             ON customer_organization.id = task.business_organization_id
           LEFT JOIN LATERAL (
             SELECT amendment.id, amendment.amendment_version, amendment.scope_version_id
               FROM task_work_order_amendments amendment
              WHERE amendment.work_order_id = work_order.id
              ORDER BY amendment.amendment_version DESC
              LIMIT 1
           ) latest_amendment ON TRUE
           JOIN task_scope_versions scope
             ON scope.id = COALESCE(latest_amendment.scope_version_id, work_order.scope_version_id)
           JOIN task_work_order_execution_facts execution
             ON execution.work_order_id = work_order.id
            AND execution.scope_version_id = scope.id
            AND NOT EXISTS (
              SELECT 1
              FROM task_work_order_execution_facts newer_execution
              WHERE newer_execution.work_order_id = execution.work_order_id
                AND newer_execution.execution_version > execution.execution_version
            )
           JOIN task_scope_change_approvals customer_approval
             ON customer_approval.proposal_id = proposal.id
            AND customer_approval.approver_role = 'CUSTOMER'
           JOIN task_scope_change_approvals provider_approval
             ON provider_approval.proposal_id = proposal.id
            AND provider_approval.approver_role = 'PROVIDER'
           JOIN LATERAL (
             SELECT financial.id, financial.operation_id, financial.event_kind,
                    financial.status, financial.expected_version, financial.occurred_at
               FROM task_financial_security_events financial
              WHERE financial.task_draft_id = work_order.task_draft_id
              ORDER BY financial.expected_version DESC
              LIMIT 1
              FOR UPDATE
           ) latest_financial ON TRUE
          WHERE proposal.id = $1::uuid
            AND proposal.universal_contract_version = 1
            AND proposal.application_contract_version = 1
            AND task.work_order_id = work_order.id
            AND work_order.execution_contract_version = 1
            AND task.active_scope_version_id = scope.id
            AND (
              (
                task.business_organization_id IS NULL
                AND task.poster_id = $2::uuid
              )
              OR (
                task.business_organization_id IS NOT NULL
                AND customer_organization.status = 'ACTIVE'
                AND customer_organization.client_enabled IS TRUE
                AND public.business_membership_has_action(
                  task.business_organization_id,
                  $2::uuid,
                  'APPROVE_SPEND'
                )
              )
            )
            AND task.universal_contract_version = 1
            AND draft.universal_contract_version = 1
            AND task.automation_classification = 'CONTROLLED_TEST'
            AND task.worker_id IS NULL
            AND task.universal_payment_posture = 'PAYMENT_CREATION_FROZEN'
            AND actor.account_status = 'ACTIVE'
            AND actor.is_minor IS FALSE
            AND COALESCE(actor.is_banned, FALSE) IS FALSE
            AND provider.account_status = 'ACTIVE'
            AND provider.is_minor IS FALSE
            AND COALESCE(provider.is_banned, FALSE) IS FALSE
            AND NOT EXISTS (
              SELECT 1 FROM task_completion_facts completion
               WHERE completion.work_order_id = work_order.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM task_reconciliation_facts reconciliation
               WHERE reconciliation.work_order_id = work_order.id
            )
          FOR UPDATE OF proposal, task, work_order, draft, eligibility,
                        actor, provider, scope, customer_approval,
                        provider_approval, execution`,
        [input.proposal_id, actorId]
      );
      const context = contextResult.rows[0];
      if (!context || !context.provider_authority_current) {
        return fail(
          'CHANGE_ORDER_CONTEXT_UNAVAILABLE',
          'The exact approved change-order context is unavailable.'
        );
      }
      if (context.change_order_kind === 'SCHEDULE_AND_SCOPE') {
        return fail(
          'CHANGE_ORDER_SCHEDULE_UNSUPPORTED',
          'Structured Work Order schedule amendments are not yet authoritative.'
        );
      }
      const amendmentVersion = nonnegativeVersion(context.latest_amendment_version);
      if (
        context.proposal_status !== 'PENDING' ||
        Number(context.proposal_version) !== input.expected_proposal_version ||
        Number(context.scope_version) !== input.expected_scope_version ||
        amendmentVersion !== input.expected_amendment_version ||
        Number(context.execution_version) !== input.expected_execution_version ||
        Number(context.latest_financial_version) !== input.expected_financial_version ||
        context.base_version_id !== context.scope_version_id
      ) {
        return fail(
          'CHANGE_ORDER_VERSION_CONFLICT',
          'The proposal, Work Order scope, amendment, or financial chain changed.'
        );
      }
      if (
        !['MATERIALIZED', 'ACKNOWLEDGED', 'EN_ROUTE', 'ARRIVED', 'PAUSED'].includes(
          context.execution_state
        )
      ) {
        return fail(
          'CHANGE_ORDER_STATE_CONFLICT',
          'Pause active work before materializing a scope amendment.'
        );
      }
      if (
        context.customer_approval_decision !== 'APPROVED' ||
        context.provider_approval_decision !== 'APPROVED' ||
        !context.customer_approval_current ||
        !context.provider_approval_current ||
        context.customer_approval_actor_id === context.provider_approval_actor_id
      ) {
        return fail(
          'CHANGE_ORDER_INDEPENDENT_APPROVAL_REQUIRED',
          'Current, independent customer and provider approvals are required.'
        );
      }
      if (
        context.latest_financial_status !== 'SUCCEEDED' ||
        !['SECURED', 'ADJUSTMENT_AUTHORIZED'].includes(context.latest_financial_event_kind)
      ) {
        return fail(
          'CHANGE_ORDER_STATE_CONFLICT',
          'The financial chain is not open for an amendment.'
        );
      }
      if (
        !context.proposed_title ||
        !context.proposed_description ||
        !context.proposed_scope_sha256
      ) {
        return fail(
          'CHANGE_ORDER_CONTEXT_UNAVAILABLE',
          'The immutable proposed scope is incomplete.'
        );
      }
      const proposedScope = {
        title: context.proposed_title,
        description: context.proposed_description,
        requirements: context.proposed_requirements,
        checklist: checklist(context.proposed_checklist),
      };
      if (!scopeContentChanged(context, proposedScope)) {
        return fail(
          'CHANGE_ORDER_STATE_CONFLICT',
          'The approved change order does not change execution scope.'
        );
      }
      const currentCustomerTotal = number(
        context.customer_total_cents,
        'Current customer total is invalid.'
      );
      const currentProviderPayout = number(
        context.provider_payout_cents,
        'Current provider payout is invalid.'
      );
      const isPriceChange = context.change_order_kind === 'PRICE_AND_SCOPE';
      const customerTotal = isPriceChange
        ? number(context.proposed_customer_total_cents, 'Proposed customer total is invalid.')
        : currentCustomerTotal;
      const providerPayout = isPriceChange
        ? number(context.proposed_provider_payout_cents, 'Proposed provider payout is invalid.')
        : currentProviderPayout;
      if (
        providerPayout > customerTotal ||
        context.financial_adjustment_required !== isPriceChange ||
        (isPriceChange && customerTotal === currentCustomerTotal)
      ) {
        return fail(
          'CHANGE_ORDER_STATE_CONFLICT',
          'The approved change-order economics are inconsistent.'
        );
      }
      const scopeSha256 = await databaseScopeHash(
        query,
        proposedScope,
        customerTotal,
        providerPayout,
        context.currency
      );
      if (scopeSha256 !== context.proposed_scope_sha256) {
        return fail(
          'CHANGE_ORDER_SCOPE_HASH_MISMATCH',
          'The proposed scope does not match its PostgreSQL-authoritative digest.'
        );
      }
      const newScope = await query<{ id: string }>(
        `INSERT INTO task_scope_versions (
           task_id, version, scope_hash, title, description, requirements,
           checklist, customer_total_cents, hustler_payout_cents, source,
           change_summary, created_by, supersedes_version_id,
           universal_contract_version, currency
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9,
           'APPROVED_CHANGE', $10, $11, $12, 1, $13
         )
         RETURNING id`,
        [
          context.task_id,
          Number(context.scope_version) + 1,
          scopeSha256,
          proposedScope.title,
          proposedScope.description,
          proposedScope.requirements,
          JSON.stringify(proposedScope.checklist),
          customerTotal,
          providerPayout,
          context.observed_scope_summary,
          actorId,
          context.scope_version_id,
          context.currency,
        ]
      );
      const scopeVersionId = newScope.rows[0]?.id;
      if (!scopeVersionId) {
        return fail(
          'CHANGE_ORDER_MATERIALIZATION_FAILED',
          'The immutable replacement scope was not created.'
        );
      }
      const approved = await query(
        `UPDATE task_scope_change_proposals
            SET status = 'APPROVED',
                reviewed_by = $2,
                reviewed_at = clock_timestamp(),
                decision_reason = 'Customer authorized exact dual-approved amendment',
                approved_version_id = $3,
                updated_at = clock_timestamp()
          WHERE id = $1
            AND status = 'PENDING'`,
        [context.proposal_id, actorId, scopeVersionId]
      );
      if (approved.rowCount !== 1) {
        return fail(
          'CHANGE_ORDER_VERSION_CONFLICT',
          'The approved proposal did not terminalize exactly once.'
        );
      }

      let adjustmentEventId: string | null = null;
      if (isPriceChange) {
        if (!financeFactory) {
          return fail(
            'CHANGE_ORDER_FAKE_FINANCE_ONLY',
            'Price changes require the authorized nonproduction fake provider.'
          );
        }
        const finance = financeFactory(transactionBoundDatabase(query, this.database));
        const predecessorTime = Date.parse(String(context.latest_financial_occurred_at));
        const clientTime = Date.parse(input.client_ts);
        const occurredAt = new Date(Math.max(clientTime, predecessorTime + 1)).toISOString();
        const adjustment = await finance.executeFinancialEvent({
          providerKind: 'FAKE',
          operationKind: 'ADJUST',
          operationId: deterministicUuid(input.idempotency_key, 'adjust'),
          idempotencyKey: `${input.idempotency_key}:adjust`,
          providerExpectedVersion: 0,
          lifecycleExpectedVersion: input.expected_financial_version + 1,
          taskDraftId: context.task_draft_id,
          taskId: context.task_id,
          eligibilityDecisionId: context.eligibility_decision_id,
          scopeVersionId,
          predecessorEventId: context.latest_financial_event_id,
          relatedOperationId: context.latest_financial_operation_id,
          changeOrderId: context.proposal_id,
          amountCents: customerTotal,
          currency: context.currency.toLowerCase(),
          recordedBy: actorId,
          occurredAt,
          scenario: 'SUCCESS',
        });
        if (
          adjustment.eventKind !== 'ADJUSTMENT_AUTHORIZED' ||
          adjustment.status !== 'SUCCEEDED' ||
          adjustment.providerKind !== 'FAKE' ||
          adjustment.taskDraftId !== context.task_draft_id ||
          adjustment.taskId !== context.task_id ||
          adjustment.eligibilityDecisionId !== context.eligibility_decision_id ||
          adjustment.scopeVersionId !== scopeVersionId ||
          adjustment.changeOrderId !== context.proposal_id ||
          adjustment.predecessorEventId !== context.latest_financial_event_id ||
          adjustment.lifecycleExpectedVersion !== input.expected_financial_version + 1 ||
          adjustment.amountCents !== customerTotal ||
          adjustment.currency !== context.currency
        ) {
          return fail(
            'CHANGE_ORDER_FAKE_FINANCE_ONLY',
            'The fake adjustment result did not preserve exact amendment authority.'
          );
        }
        adjustmentEventId = adjustment.id;
      } else if (financeFactory) {
        return fail(
          'CHANGE_ORDER_FAKE_FINANCE_ONLY',
          'Scope-only amendments cannot invoke a financial provider.'
        );
      }

      const nextAmendmentVersion = amendmentVersion + 1;
      const predecessorAmendmentId = amendmentVersion === 0 ? null : context.latest_amendment_id;
      const requestSha256 = await databaseRequestHash(
        query,
        `SELECT public.universal_v1_change_amendment_request_sha256(
           $1::uuid, $2::integer, $3::uuid, $4::uuid,
           $5::uuid, $6::uuid, $7::integer, $8::uuid, $9::text
         ) AS request_sha256`,
        [
          context.work_order_id,
          nextAmendmentVersion,
          predecessorAmendmentId,
          context.proposal_id,
          scopeVersionId,
          adjustmentEventId,
          input.expected_financial_version,
          actorId,
          input.idempotency_key,
        ]
      );

      const taskUpdate = await query<{ worker_id: string | null }>(
        `UPDATE tasks
            SET title = $2,
                description = $3,
                requirements = $4,
                price = $5,
                hustler_payout_cents = $6,
                platform_margin_cents = $5::integer - $6::integer,
                scope_hash = $7,
                active_scope_version_id = $8,
                updated_at = clock_timestamp()
          WHERE id = $1
            AND active_scope_version_id = $9
            AND worker_id IS NULL
            AND universal_contract_version = 1
            AND automation_classification = 'CONTROLLED_TEST'
            AND universal_payment_posture = 'PAYMENT_CREATION_FROZEN'
          RETURNING worker_id`,
        [
          context.task_id,
          proposedScope.title,
          proposedScope.description,
          proposedScope.requirements,
          customerTotal,
          providerPayout,
          scopeSha256,
          scopeVersionId,
          context.scope_version_id,
        ]
      );
      if (taskUpdate.rowCount !== 1 || taskUpdate.rows[0]?.worker_id !== null) {
        return fail(
          'CHANGE_ORDER_HARD_ASSIGNMENT_FORBIDDEN',
          'The Work Order scope could not advance without hard assignment.'
        );
      }
      const amendment = await query<{ id: string }>(
        `INSERT INTO task_work_order_amendments (
           work_order_id, amendment_version, supersedes_amendment_id,
           change_order_id, scope_version_id, adjustment_event_id,
           expected_financial_version, idempotency_key, request_sha256, materialized_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          context.work_order_id,
          nextAmendmentVersion,
          predecessorAmendmentId,
          context.proposal_id,
          scopeVersionId,
          adjustmentEventId,
          input.expected_financial_version,
          input.idempotency_key,
          requestSha256,
          actorId,
        ]
      );
      const amendmentId = amendment.rows[0]?.id;
      if (!amendmentId) {
        return fail(
          'CHANGE_ORDER_MATERIALIZATION_FAILED',
          'The immutable Work Order amendment was not created.'
        );
      }

      const executionKey = `${input.idempotency_key}:execution`;
      const execution = await query<{ id: string }>(
        `INSERT INTO task_work_order_execution_facts (
           work_order_id, task_id, scope_version_id, execution_version,
           supersedes_fact_id, state, transition_kind, completion_fact_id,
           work_order_amendment_id, actor_role, actor_user_id, reason,
           idempotency_key, request_sha256, client_occurred_at,
           policy_version
         ) VALUES (
           $1,$2,$3,$4,$5,$6,'APPLY_AMENDMENT',NULL,$7,'CUSTOMER',$8,NULL,$9,
           public.universal_v1_execution_internal_request_sha256(
             $8,$1,'APPLY_AMENDMENT',$6,$10,$3,NULL,$7,$9,$11::timestamptz,NULL
           ),$11::timestamptz,'universal-v1-work-order-execution-1.0.0'
         ) RETURNING id`,
        [
          context.work_order_id,
          context.task_id,
          scopeVersionId,
          Number(context.execution_version) + 1,
          context.execution_fact_id,
          context.execution_state,
          amendmentId,
          actorId,
          executionKey,
          Number(context.execution_version),
          input.client_ts,
        ]
      );
      if (!execution.rows[0]?.id) {
        return fail(
          'CHANGE_ORDER_MATERIALIZATION_FAILED',
          'The immutable Work Order execution amendment fact was not created.'
        );
      }
      return {
        amendment_id: amendmentId,
        amendment_version: nextAmendmentVersion,
        proposal_id: context.proposal_id,
        scope_version_id: scopeVersionId,
        scope_version: Number(context.scope_version) + 1,
        adjustment_event_id: adjustmentEventId,
        provider_kind: adjustmentEventId ? 'FAKE' : null,
        replayed: false,
        payment_creation_performed: false,
        hard_assignment_created: false,
      };
    });
  }
}
