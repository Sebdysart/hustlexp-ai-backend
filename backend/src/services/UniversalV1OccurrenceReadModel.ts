import { createHash } from 'node:crypto';

import { db, type Database, type QueryFn } from '../db.js';
import {
  UniversalV1EstimateLineItemSchema,
  UniversalV1EstimateScopeSchema,
} from './UniversalV1EstimateContracts.js';
import { UniversalV1ChangeOrderScopeSchema } from './UniversalV1ChangeOrderContracts.js';

export type UniversalV1OccurrencePerspective = 'CUSTOMER' | 'PROVIDER' | 'OPERATIONS';

export type UniversalV1OccurrenceNextAction =
  | 'ACKNOWLEDGE_WORK_ORDER'
  | 'CONTINUE_EXECUTION'
  | 'DECIDE_COMPLETION'
  | 'ESTABLISH_ELIGIBILITY'
  | 'EXPRESS_INTEREST'
  | 'ISSUE_ESTIMATE_INVITATION'
  | 'MARK_ARRIVAL'
  | 'MATERIALIZE_WORK_ORDER'
  | 'MONITOR_CUSTOMER_DECISION'
  | 'MONITOR_ESTIMATE'
  | 'MONITOR_EXECUTION'
  | 'MONITOR_HOLD'
  | 'MONITOR_PROVIDER_INTEREST'
  | 'MONITOR_WORK_ORDER_MATERIALIZATION'
  | 'NO_ACTION'
  | 'OCCURRENCE_COMPLETE'
  | 'RESOLVE_ELIGIBILITY_BLOCKERS'
  | 'RESOLVE_ROUTING'
  | 'REVIEW_ESTIMATE'
  | 'REVIEW_PROVIDER_INTEREST'
  | 'ROUTE_DRAFT'
  | 'START_TRAVEL_OR_WORK'
  | 'START_WORK'
  | 'SUBMIT_ESTIMATE'
  | 'TRACK_WORK_ORDER'
  | 'WAIT_FOR_COMPLETION_DECISION'
  | 'WAIT_FOR_COMPLETION_NOTICE'
  | 'WAIT_FOR_CUSTOMER_HOLD'
  | 'WAIT_FOR_ESTIMATE_DECISION'
  | 'WAIT_FOR_INVITATION'
  | 'WAIT_FOR_PROVIDER_ESTIMATE'
  | 'WAIT_FOR_PROVIDER_INTEREST'
  | 'WAIT_FOR_FINANCIAL_COMPLETION'
  | 'WAIT_FOR_ROUTING'
  | 'WAIT_FOR_RECONCILIATION'
  | 'WAIT_FOR_TASK_MATERIALIZATION'
  | 'WAIT_FOR_WORK_ORDER'
  | 'COMPLETE_FAKE_FINANCIAL_LIFECYCLE'
  | 'RESOLVE_RECONCILIATION_MISMATCH';

type Timestamp = Date | string;

type UniversalV1ChangeOrderMaterializationState =
  | 'NOT_PREPARED'
  | 'PREPARED_RECOVERING'
  | 'MATERIALIZED'
  | 'CANCELLED_RECOVERY_REQUIRED';

interface RawUniversalV1ChangeOrderApproval {
  approver_party: unknown;
  decision: unknown;
  decided_at: unknown;
}

interface RawUniversalV1ChangeOrderTimelineEntry {
  proposal_id: unknown;
  proposal_version: unknown;
  status: unknown;
  change_order_kind: unknown;
  proposer_party: unknown;
  supersedes_proposal_id: unknown;
  base_scope_version_id: unknown;
  base_scope_version: unknown;
  observed_scope_summary: unknown;
  proposed_scope_sha256: unknown;
  proposed_scope: unknown;
  proposed_customer_total_cents: unknown;
  proposed_provider_payout_cents: unknown;
  created_at: unknown;
  approvals: unknown;
  materialization_state: unknown;
  amendment_id: unknown;
  amendment_version: unknown;
  amendment_scope_version_id: unknown;
  amendment_scope_version: unknown;
}

/**
 * Deliberately contains only fields admitted to the public occurrence model.
 * In particular, it has no Task location, draft raw input/structured payload,
 * eligibility evidence, proof content, operator reason, or provider reference.
 */
export interface RawUniversalV1OccurrenceRow {
  task_draft_id: string;
  draft_status: string;
  draft_updated_at: Timestamp;
  route_id: string | null;
  route_version: number | null;
  route_outcome: string | null;
  route_reason_codes: string[] | null;
  route_policy_version: string | null;
  route_category: string | null;
  route_service_cell: string | null;
  route_created_at: Timestamp | null;
  provider_user_id: string | null;
  provider_organization_id: string | null;
  provider_class: string | null;
  qualification_provider_class: string | null;
  qualification_credential_type: string | null;
  qualification_issuing_authority: string | null;
  qualification_jurisdiction_code: string | null;
  qualification_license_scope: string | null;
  qualification_license_status: string | null;
  qualification_expires_at: Timestamp | null;
  qualification_verified_at: Timestamp | null;
  qualification_official_source_checked_at: Timestamp | null;
  qualification_permitted_work_categories: string[] | null;
  eligibility_id: string | null;
  eligibility_version: number | null;
  eligibility_task_eligible: boolean | null;
  eligibility_is_current: boolean | null;
  eligibility_blocker_codes: string[] | null;
  eligibility_policy_version: string | null;
  eligibility_evaluated_at: Timestamp | null;
  eligibility_valid_until: Timestamp | null;
  invitation_id: string | null;
  invitation_quote_id: string | null;
  invitation_expected_draft_version: number | null;
  invitation_expected_quote_version: number | string | null;
  invitation_is_current: boolean | null;
  invitation_valid_until: Timestamp | null;
  invitation_created_at: Timestamp | null;
  estimate_id: string | null;
  estimate_quote_id: string | null;
  estimate_quote_version_id: string | null;
  estimate_version: number | null;
  estimate_work_category: string | null;
  estimate_customer_total_cents: number | string | null;
  estimate_provider_payout_cents: number | string | null;
  estimate_currency: string | null;
  estimate_scope_snapshot: unknown | null;
  estimate_line_items: unknown | null;
  estimate_created_at: Timestamp | null;
  acceptance_id: string | null;
  acceptance_created_at: Timestamp | null;
  task_id: string | null;
  task_state: string | null;
  task_category: string | null;
  task_risk_level: string | null;
  task_requires_proof: boolean | null;
  task_universal_payment_posture: string | null;
  task_automation_classification: string | null;
  task_worker_id: string | null;
  scope_version_id: string | null;
  scope_version: number | null;
  scope_hash: string | null;
  scope_source: string | null;
  scope_customer_total_cents: number | string | null;
  scope_provider_payout_cents: number | string | null;
  scope_currency: string | null;
  scope_title: string | null;
  scope_description: string | null;
  scope_requirements: string | null;
  scope_checklist: unknown | null;
  scope_created_at: Timestamp | null;
  interest_id: string | null;
  interest_status: string | null;
  interest_created_at: Timestamp | null;
  hold_id: string | null;
  hold_is_active: boolean | null;
  hold_status: string | null;
  hold_reserved_at: Timestamp | null;
  hold_expires_at: Timestamp | null;
  work_order_id: string | null;
  work_order_materialization_version: number | null;
  work_order_materialized_at: Timestamp | null;
  latest_amendment_id: string | null;
  latest_amendment_version: number | null;
  latest_financial_version: number | string | null;
  change_order_timeline: unknown | null;
  execution_fact_id: string | null;
  execution_version: number | null;
  execution_state: string | null;
  execution_transition: string | null;
  execution_recorded_at: Timestamp | null;
  completion_fact_id: string | null;
  completion_version: number | null;
  completion_kind: string | null;
  completion_created_at: Timestamp | null;
  completion_delivery_event_id: string | null;
  completion_delivery_channel: string | null;
  completion_delivered_at: Timestamp | null;
  terminal_intent_id: string | null;
  terminal_path: string | null;
  terminal_materialized_at: Timestamp | null;
  reconciliation_id: string | null;
  reconciliation_version: number | null;
  reconciliation_void_state: string | null;
  reconciliation_capture_state: string | null;
  reconciliation_refund_state: string | null;
  reconciliation_reversal_state: string | null;
  reconciliation_settlement_state: string | null;
  reconciliation_funding_state: string | null;
  reconciliation_provider_release_state: string | null;
  reconciliation_payout_state: string | null;
  reconciliation_bank_settlement_state: string | null;
  reconciliation_ledger_state: string | null;
  reconciliation_state: string | null;
  reconciliation_mismatch_codes: string[] | null;
  reconciliation_created_at: Timestamp | null;
}

interface UniversalV1CommercialScope {
  title: string;
  description: string;
  requirements: string | null;
  checklist: readonly string[];
}

interface UniversalV1CommercialLineItem {
  description: string;
  quantity: number;
  unit_amount_cents: number;
  total_amount_cents: number;
}

interface UniversalV1CommercialChangeOrderApproval {
  approver_party: 'CUSTOMER' | 'PROVIDER';
  decision: 'APPROVED' | 'REJECTED';
  decided_at: string;
}

interface UniversalV1CommercialChangeOrder {
  proposal_id: string;
  proposal_version: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELED';
  change_order_kind: 'SCOPE_ONLY' | 'PRICE_AND_SCOPE';
  proposer_party: 'CUSTOMER' | 'PROVIDER';
  supersedes_proposal_id: string | null;
  base_scope_version_id: string;
  base_scope_version: number;
  proposed_scope: UniversalV1CommercialScope;
  proposed_customer_total_cents?: number;
  proposed_provider_payout_cents?: number;
  proposed_at: string;
  approvals: readonly UniversalV1CommercialChangeOrderApproval[];
  materialization: {
    state: UniversalV1ChangeOrderMaterializationState;
    amendment_id?: string;
    amendment_version?: number;
    scope_version_id?: string;
    scope_version?: number;
  };
}

export interface UniversalV1CommercialProjection {
  authority: {
    source: 'POSTGRESQL_DURABLE_FACTS';
    read_model_only: true;
    command_authority_granted: false;
    command_rechecks_current_authority: true;
  };
  trade_qualification: {
    provider_class: 'VERIFIED_TRADE_BUSINESS';
    credential_type: string;
    issuing_authority: string;
    jurisdiction_code: string;
    license_scope: string;
    license_status: 'ACTIVE';
    expires_at: string;
    verified_at: string;
    official_source_checked_at: string;
    permitted_work_categories: readonly string[];
  } | null;
  estimate: {
    invitation: {
      invitation_id: string;
      quote_id: string;
      expected_draft_version: number;
      expected_quote_version: number;
      is_current: boolean;
      valid_until: string;
      created_at: string;
    } | null;
    submission: {
      provider_estimate_submission_id: string;
      quote_id: string;
      quote_version_id: string;
      quote_version: number;
      work_category_code: string;
      scope: UniversalV1CommercialScope;
      line_items: readonly UniversalV1CommercialLineItem[];
      currency: string;
      customer_total_cents?: number;
      provider_payout_cents?: number;
      submitted_at: string;
    } | null;
    acceptance: {
      acceptance_materialization_id: string;
      accepted_at: string;
    } | null;
    observed_command_context: {
      issue_provider_estimate_invitation: {
        eligibility_decision_id: string;
        expected_draft_version: number;
        expected_eligibility_version: number;
      } | null;
      submit_provider_estimate: {
        quote_id: string;
        expected_draft_version: number;
        expected_quote_version: number;
      } | null;
      accept_provider_estimate: {
        provider_estimate_submission_id: string;
        expected_draft_version: number;
        expected_quote_version: number;
      } | null;
    };
  };
  change_orders: {
    work_order_id: string;
    current_scope: UniversalV1CommercialScope & {
      scope_version_id: string;
      version: number;
      currency: string;
      customer_total_cents?: number;
      provider_payout_cents?: number;
    };
    latest_amendment: {
      amendment_id: string;
      amendment_version: number;
    } | null;
    latest_execution_version: number;
    latest_financial_version: number;
    timeline: readonly UniversalV1CommercialChangeOrder[];
    observed_command_context: {
      propose_change_order: {
        work_order_id: string;
        expected_scope_version: number;
        expected_amendment_version: number;
        expected_latest_proposal_version: number;
      } | null;
      decide_change_order: {
        proposal_id: string;
        expected_proposal_version: number;
      } | null;
      authorize_and_materialize_fake_change_order: {
        proposal_id: string;
        expected_proposal_version: number;
        expected_scope_version: number;
        expected_amendment_version: number;
        expected_execution_version: number;
        expected_financial_version: number;
      } | null;
    };
  } | null;
  payment_creation_frozen: true;
  fake_finance_only: true;
  hard_assignment_created: false;
}

export interface UniversalV1OccurrenceProjection {
  task_draft_id: string;
  perspective: UniversalV1OccurrencePerspective;
  draft: {
    status: string;
    updated_at: string;
  };
  route: {
    routing_decision_id: string;
    decision_version: number;
    outcome: string;
    reason_codes: readonly string[];
    policy_version: string;
    work_category_code: string;
    service_cell: string | null;
    decided_at: string;
  } | null;
  provider: {
    provider_class: string;
    provider_user_id?: string;
    provider_organization_id?: string | null;
  } | null;
  eligibility: {
    eligibility_decision_id: string;
    decision_version: number;
    task_eligible: boolean;
    is_current: boolean;
    blocker_codes: readonly string[];
    policy_version: string;
    evaluated_at: string;
    valid_until: string;
  } | null;
  invitation: {
    invitation_id: string;
    is_current: boolean;
    valid_until: string;
    created_at: string;
  } | null;
  estimate: {
    provider_estimate_submission_id: string;
    quote_id: string;
    quote_version_id: string;
    quote_version: number;
    work_category_code: string;
    currency: string;
    customer_total_cents?: number;
    provider_payout_cents?: number;
    submitted_at: string;
  } | null;
  acceptance: {
    acceptance_materialization_id: string;
    accepted_at: string;
  } | null;
  task: {
    task_id: string;
    state: string;
    category: string;
    risk_level: string;
    requires_proof: boolean;
  } | null;
  scope: {
    scope_version_id: string;
    version: number;
    source: string;
    currency: string;
    customer_total_cents?: number;
    provider_payout_cents?: number;
    created_at: string;
  } | null;
  interest: {
    interest_application_id: string;
    status: string;
    expressed_at: string;
  } | null;
  hold: {
    conditional_hold_id: string;
    is_active: boolean;
    status: string;
    reserved_at: string;
    expires_at: string;
  } | null;
  work_order: {
    work_order_id: string;
    materialization_version: number;
    materialized_at: string;
  } | null;
  execution: {
    execution_fact_id: string;
    execution_version: number;
    state: string;
    transition_kind: string;
    recorded_at: string;
  } | null;
  completion: {
    completion_fact_id: string;
    completion_version: number;
    fact_kind: string;
    recorded_at: string;
    delivery_receipt?: {
      delivery_event_id: string;
      status: 'DELIVERED';
      channel: string;
      delivered_at: string;
    };
  } | null;
  financial_lifecycle: {
    terminal_intent_id: string;
    terminal_path: string;
    materialized_at: string;
    reconciliation: {
      reconciliation_fact_id: string;
      reconciliation_version: number;
      void_state: string;
      capture_state: string;
      refund_state: string;
      reversal_state: string;
      settlement_state: string;
      funding_state: string;
      provider_release_state: string;
      payout_state: string;
      bank_settlement_state: string;
      ledger_state: string;
      state: string;
      mismatch_codes: readonly string[];
      recorded_at: string;
    } | null;
  } | null;
  commercial: UniversalV1CommercialProjection;
  next_action: UniversalV1OccurrenceNextAction;
  payment_creation_frozen: true;
  hard_assignment_created: false;
  final_availability_confirmation_required: true;
}

export interface UniversalV1OccurrenceFactReader {
  loadCustomer(taskDraftId: string, actorUserId: string): Promise<RawUniversalV1OccurrenceRow | null>;
  loadProvider(taskDraftId: string, actorUserId: string): Promise<RawUniversalV1OccurrenceRow | null>;
}

export type UniversalV1OccurrenceReadErrorCode =
  | 'OCCURRENCE_NOT_FOUND'
  | 'OCCURRENCE_OPERATOR_AUTHORITY_REVOKED'
  | 'OCCURRENCE_READ_UNAVAILABLE';

export class UniversalV1OccurrenceReadError extends Error {
  constructor(readonly code: UniversalV1OccurrenceReadErrorCode) {
    super(
      code === 'OCCURRENCE_NOT_FOUND'
        ? 'The occurrence is unavailable.'
        : code === 'OCCURRENCE_OPERATOR_AUTHORITY_REVOKED'
          ? 'Current Operations authority is required.'
          : 'Unable to load the occurrence.',
    );
    this.name = 'UniversalV1OccurrenceReadError';
  }
}

function iso(value: Timestamp): string {
  return new Date(value).toISOString();
}

function cents(value: number | string): number {
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new UniversalV1OccurrenceReadError('OCCURRENCE_READ_UNAVAILABLE');
  }
  return result;
}

function readUnavailable(): never {
  throw new UniversalV1OccurrenceReadError('OCCURRENCE_READ_UNAVAILABLE');
}

function positiveVersion(value: unknown): number {
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 1) return readUnavailable();
  return result;
}

function nonnegativeVersion(value: unknown): number {
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) return readUnavailable();
  return result;
}

function nonemptyString(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return readUnavailable();
  return value;
}

function nullableUuid(value: unknown): string | null {
  if (value === null) return null;
  return nonemptyString(value);
}

function commercialEstimateScope(value: unknown): UniversalV1CommercialScope {
  const parsed = UniversalV1EstimateScopeSchema.safeParse(value);
  if (!parsed.success) return readUnavailable();
  return {
    title: parsed.data.title,
    description: parsed.data.description,
    requirements: parsed.data.requirements,
    checklist: parsed.data.checklist,
  };
}

function commercialChangeOrderScope(value: unknown): UniversalV1CommercialScope {
  const parsed = UniversalV1ChangeOrderScopeSchema.safeParse(value);
  if (!parsed.success) return readUnavailable();
  return parsed.data;
}

function commercialLineItems(value: unknown): readonly UniversalV1CommercialLineItem[] {
  const parsed = UniversalV1EstimateLineItemSchema.array().min(1).max(100).safeParse(value);
  if (!parsed.success) return readUnavailable();
  return parsed.data;
}

function changeOrderApproval(value: unknown): UniversalV1CommercialChangeOrderApproval {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return readUnavailable();
  const raw = value as RawUniversalV1ChangeOrderApproval;
  if (!['CUSTOMER', 'PROVIDER'].includes(String(raw.approver_party))) {
    return readUnavailable();
  }
  if (!['APPROVED', 'REJECTED'].includes(String(raw.decision))) return readUnavailable();
  return {
    approver_party: raw.approver_party as 'CUSTOMER' | 'PROVIDER',
    decision: raw.decision as 'APPROVED' | 'REJECTED',
    decided_at: iso(nonemptyString(raw.decided_at)),
  };
}

function changeOrderTimeline(
  perspective: UniversalV1OccurrencePerspective,
  value: unknown,
): readonly UniversalV1CommercialChangeOrder[] {
  if (value === null) return [];
  if (!Array.isArray(value)) return readUnavailable();
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return readUnavailable();
    const raw = entry as RawUniversalV1ChangeOrderTimelineEntry;
    if (!['PENDING', 'APPROVED', 'REJECTED', 'CANCELED'].includes(String(raw.status))) {
      return readUnavailable();
    }
    if (!['SCOPE_ONLY', 'PRICE_AND_SCOPE'].includes(String(raw.change_order_kind))) {
      return readUnavailable();
    }
    if (!['CUSTOMER', 'PROVIDER'].includes(String(raw.proposer_party))) {
      return readUnavailable();
    }
    if (![
      'NOT_PREPARED',
      'PREPARED_RECOVERING',
      'MATERIALIZED',
      'CANCELLED_RECOVERY_REQUIRED',
    ].includes(String(raw.materialization_state))) {
      return readUnavailable();
    }
    if (!Array.isArray(raw.approvals)) return readUnavailable();
    const materializationState = raw.materialization_state as
      UniversalV1ChangeOrderMaterializationState;
    const amendmentPresent = raw.amendment_id !== null;
    if (
      (materializationState === 'MATERIALIZED') !== amendmentPresent
      || (amendmentPresent && (
        raw.amendment_version === null
        || raw.amendment_scope_version_id === null
        || raw.amendment_scope_version === null
      ))
    ) return readUnavailable();

    const customerTotal = raw.proposed_customer_total_cents === null
      ? null
      : cents(raw.proposed_customer_total_cents as number | string);
    const providerPayout = raw.proposed_provider_payout_cents === null
      ? null
      : cents(raw.proposed_provider_payout_cents as number | string);
    return {
      proposal_id: nonemptyString(raw.proposal_id),
      proposal_version: positiveVersion(raw.proposal_version),
      status: raw.status as UniversalV1CommercialChangeOrder['status'],
      change_order_kind: raw.change_order_kind as UniversalV1CommercialChangeOrder['change_order_kind'],
      proposer_party: raw.proposer_party as UniversalV1CommercialChangeOrder['proposer_party'],
      supersedes_proposal_id: nullableUuid(raw.supersedes_proposal_id),
      base_scope_version_id: nonemptyString(raw.base_scope_version_id),
      base_scope_version: positiveVersion(raw.base_scope_version),
      proposed_scope: commercialChangeOrderScope(raw.proposed_scope),
      ...(customerTotal !== null
        ? { proposed_customer_total_cents: customerTotal }
        : {}),
      ...(perspective !== 'CUSTOMER' && providerPayout !== null
        ? { proposed_provider_payout_cents: providerPayout }
        : {}),
      proposed_at: iso(nonemptyString(raw.created_at)),
      approvals: raw.approvals.map(changeOrderApproval),
      materialization: {
        state: materializationState,
        ...(amendmentPresent ? {
          amendment_id: nonemptyString(raw.amendment_id),
          amendment_version: positiveVersion(raw.amendment_version),
          scope_version_id: nonemptyString(raw.amendment_scope_version_id),
          scope_version: positiveVersion(raw.amendment_scope_version),
        } : {}),
      },
    };
  });
}

function tradeQualification(
  row: RawUniversalV1OccurrenceRow,
): UniversalV1CommercialProjection['trade_qualification'] {
  const observed = [
    row.qualification_provider_class,
    row.qualification_credential_type,
    row.qualification_issuing_authority,
    row.qualification_jurisdiction_code,
    row.qualification_license_scope,
    row.qualification_license_status,
    row.qualification_expires_at,
    row.qualification_verified_at,
    row.qualification_official_source_checked_at,
    row.qualification_permitted_work_categories,
  ];
  if (observed.every((value) => value === null)) return null;
  if (
    row.qualification_provider_class !== 'VERIFIED_TRADE_BUSINESS'
    || row.qualification_license_status !== 'ACTIVE'
    || !Array.isArray(row.qualification_permitted_work_categories)
    || row.qualification_permitted_work_categories.length === 0
    || row.qualification_permitted_work_categories.some(
      (category) => typeof category !== 'string' || !category.trim(),
    )
    || !row.qualification_expires_at
    || !row.qualification_verified_at
    || !row.qualification_official_source_checked_at
  ) return readUnavailable();
  return {
    provider_class: 'VERIFIED_TRADE_BUSINESS',
    credential_type: nonemptyString(row.qualification_credential_type),
    issuing_authority: nonemptyString(row.qualification_issuing_authority),
    jurisdiction_code: nonemptyString(row.qualification_jurisdiction_code),
    license_scope: nonemptyString(row.qualification_license_scope),
    license_status: 'ACTIVE',
    expires_at: iso(row.qualification_expires_at),
    verified_at: iso(row.qualification_verified_at),
    official_source_checked_at: iso(row.qualification_official_source_checked_at),
    permitted_work_categories: row.qualification_permitted_work_categories,
  };
}

function assertFrozenUnassignedBoundary(row: RawUniversalV1OccurrenceRow): void {
  if (!row.task_id) {
    if (
      row.task_universal_payment_posture !== null
      || row.task_automation_classification !== null
      || row.task_worker_id !== null
    ) return readUnavailable();
    return;
  }
  if (
    row.task_universal_payment_posture !== 'PAYMENT_CREATION_FROZEN'
    || row.task_automation_classification !== 'CONTROLLED_TEST'
    || row.task_worker_id !== null
  ) return readUnavailable();
}

function commercialProjection(
  perspective: UniversalV1OccurrencePerspective,
  row: RawUniversalV1OccurrenceRow,
): UniversalV1CommercialProjection {
  assertFrozenUnassignedBoundary(row);
  const invitation = row.invitation_id
    && row.invitation_quote_id
    && row.invitation_expected_draft_version !== null
    && row.invitation_expected_quote_version !== null
    && row.invitation_is_current !== null
    && row.invitation_valid_until
    && row.invitation_created_at
    ? {
      invitation_id: row.invitation_id,
      quote_id: row.invitation_quote_id,
      expected_draft_version: positiveVersion(row.invitation_expected_draft_version),
      expected_quote_version: nonnegativeVersion(row.invitation_expected_quote_version),
      is_current: row.invitation_is_current,
      valid_until: iso(row.invitation_valid_until),
      created_at: iso(row.invitation_created_at),
    }
    : null;

  const submission = row.estimate_id
    && row.estimate_quote_id
    && row.estimate_quote_version_id
    && row.estimate_version !== null
    && row.estimate_work_category
    && row.estimate_currency
    && row.estimate_scope_snapshot !== null
    && row.estimate_line_items !== null
    && row.estimate_created_at
    ? {
      provider_estimate_submission_id: row.estimate_id,
      quote_id: row.estimate_quote_id,
      quote_version_id: row.estimate_quote_version_id,
      quote_version: positiveVersion(row.estimate_version),
      work_category_code: row.estimate_work_category,
      scope: commercialEstimateScope(row.estimate_scope_snapshot),
      line_items: commercialLineItems(row.estimate_line_items),
      currency: row.estimate_currency,
      ...(row.estimate_customer_total_cents !== null
        ? { customer_total_cents: cents(row.estimate_customer_total_cents) }
        : {}),
      ...(perspective !== 'CUSTOMER' && row.estimate_provider_payout_cents !== null
        ? { provider_payout_cents: cents(row.estimate_provider_payout_cents) }
        : {}),
      submitted_at: iso(row.estimate_created_at),
    }
    : null;

  const acceptance = row.acceptance_id && row.acceptance_created_at
    ? {
      acceptance_materialization_id: row.acceptance_id,
      accepted_at: iso(row.acceptance_created_at),
    }
    : null;

  const issueInvitation = perspective === 'OPERATIONS'
    && row.route_outcome === 'ESTIMATE_REQUIRED'
    && row.route_version !== null
    && row.eligibility_id
    && row.eligibility_version !== null
    && row.eligibility_task_eligible === true
    && row.eligibility_is_current === true
    && !row.invitation_id
    && !row.estimate_id
    ? {
      eligibility_decision_id: row.eligibility_id,
      expected_draft_version: positiveVersion(row.route_version),
      expected_eligibility_version: positiveVersion(row.eligibility_version),
    }
    : null;
  const submitEstimate = perspective === 'PROVIDER'
    && invitation?.is_current === true
    && !submission
    ? {
      quote_id: invitation.quote_id,
      expected_draft_version: invitation.expected_draft_version,
      expected_quote_version: invitation.expected_quote_version,
    }
    : null;
  const acceptEstimate = perspective === 'CUSTOMER'
    && submission
    && !acceptance
    && row.route_version !== null
    ? {
      provider_estimate_submission_id: submission.provider_estimate_submission_id,
      expected_draft_version: positiveVersion(row.route_version),
      expected_quote_version: submission.quote_version,
    }
    : null;

  let changeOrders: UniversalV1CommercialProjection['change_orders'] = null;
  if (row.work_order_id) {
    if (
      !row.scope_version_id
      || row.scope_version === null
      || !row.scope_hash
      || !row.scope_currency
      || !row.scope_title
      || !row.scope_description
      || row.scope_checklist === null
      || row.execution_version === null
      || row.latest_financial_version === null
    ) return readUnavailable();
    const timeline = changeOrderTimeline(perspective, row.change_order_timeline);
    const latest = timeline.at(-1) ?? null;
    const amendmentVersion = row.latest_amendment_version === null
      ? 0
      : nonnegativeVersion(row.latest_amendment_version);
    if ((row.latest_amendment_id === null) !== (amendmentVersion === 0)) {
      return readUnavailable();
    }
    const latestProposalVersion = latest?.proposal_version ?? 0;
    const lifecycleOpen = row.completion_fact_id === null && row.reconciliation_id === null;
    const latestAllowsProposal = !latest
      || ['REJECTED', 'CANCELED'].includes(latest.status)
      || latest.materialization.state === 'MATERIALIZED';
    const participant = perspective === 'CUSTOMER' || perspective === 'PROVIDER';
    const propose = participant && lifecycleOpen && latestAllowsProposal
      ? {
        work_order_id: row.work_order_id,
        expected_scope_version: positiveVersion(row.scope_version),
        expected_amendment_version: amendmentVersion,
        expected_latest_proposal_version: latestProposalVersion,
      }
      : null;
    const actorParty = perspective === 'CUSTOMER' || perspective === 'PROVIDER'
      ? perspective
      : null;
    const actorAlreadyDecided = actorParty && latest
      ? latest.approvals.some((approval) => approval.approver_party === actorParty)
      : false;
    const decide = actorParty && latest?.status === 'PENDING' && !actorAlreadyDecided
      ? {
        proposal_id: latest.proposal_id,
        expected_proposal_version: latest.proposal_version,
      }
      : null;
    const approvals = new Map(
      latest?.approvals.map((approval) => [approval.approver_party, approval.decision]) ?? [],
    );
    const authorize = perspective === 'CUSTOMER'
      && lifecycleOpen
      && latest?.status === 'PENDING'
      && latest.materialization.state === 'NOT_PREPARED'
      && approvals.get('CUSTOMER') === 'APPROVED'
      && approvals.get('PROVIDER') === 'APPROVED'
      ? {
        proposal_id: latest.proposal_id,
        expected_proposal_version: latest.proposal_version,
        expected_scope_version: positiveVersion(row.scope_version),
        expected_amendment_version: amendmentVersion,
        expected_execution_version: positiveVersion(row.execution_version),
        expected_financial_version: nonnegativeVersion(row.latest_financial_version),
      }
      : null;

    const currentScope = commercialChangeOrderScope({
      title: row.scope_title,
      description: row.scope_description,
      requirements: row.scope_requirements,
      checklist: row.scope_checklist,
    });
    changeOrders = {
      work_order_id: row.work_order_id,
      current_scope: {
        ...currentScope,
        scope_version_id: row.scope_version_id,
        version: positiveVersion(row.scope_version),
        currency: row.scope_currency,
        ...(row.scope_customer_total_cents !== null
          ? { customer_total_cents: cents(row.scope_customer_total_cents) }
          : {}),
        ...(perspective !== 'CUSTOMER' && row.scope_provider_payout_cents !== null
          ? { provider_payout_cents: cents(row.scope_provider_payout_cents) }
          : {}),
      },
      latest_amendment: row.latest_amendment_id
        ? {
          amendment_id: row.latest_amendment_id,
          amendment_version: positiveVersion(row.latest_amendment_version),
        }
        : null,
      latest_execution_version: positiveVersion(row.execution_version),
      latest_financial_version: nonnegativeVersion(row.latest_financial_version),
      timeline,
      observed_command_context: {
        propose_change_order: propose,
        decide_change_order: decide,
        authorize_and_materialize_fake_change_order: authorize,
      },
    };
  }

  return {
    authority: {
      source: 'POSTGRESQL_DURABLE_FACTS',
      read_model_only: true,
      command_authority_granted: false,
      command_rechecks_current_authority: true,
    },
    trade_qualification: tradeQualification(row),
    estimate: {
      invitation,
      submission,
      acceptance,
      observed_command_context: {
        issue_provider_estimate_invitation: issueInvitation,
        submit_provider_estimate: submitEstimate,
        accept_provider_estimate: acceptEstimate,
      },
    },
    change_orders: changeOrders,
    payment_creation_frozen: true,
    fake_finance_only: true,
    hard_assignment_created: false,
  };
}

function nextAction(
  perspective: UniversalV1OccurrencePerspective,
  row: RawUniversalV1OccurrenceRow,
): UniversalV1OccurrenceNextAction {
  if (!row.route_id) {
    return perspective === 'CUSTOMER'
      ? 'WAIT_FOR_ROUTING'
      : perspective === 'PROVIDER' ? 'NO_ACTION' : 'ROUTE_DRAFT';
  }

  if (['DECLINE', 'REFERRAL'].includes(row.route_outcome ?? '')) return 'NO_ACTION';
  if (['MANUAL_SOURCING', 'WAITLIST'].includes(row.route_outcome ?? '')) {
    return perspective === 'OPERATIONS' ? 'RESOLVE_ROUTING' : 'NO_ACTION';
  }

  if (row.route_outcome === 'ESTIMATE_REQUIRED') {
    if (
      !row.eligibility_id
      || row.eligibility_task_eligible !== true
      || row.eligibility_is_current !== true
    ) {
      return perspective === 'CUSTOMER'
        ? 'WAIT_FOR_PROVIDER_ESTIMATE'
        : perspective === 'PROVIDER'
          ? 'RESOLVE_ELIGIBILITY_BLOCKERS'
          : 'ESTABLISH_ELIGIBILITY';
    }
    if ((!row.invitation_id || row.invitation_is_current !== true) && !row.estimate_id) {
      return perspective === 'CUSTOMER'
        ? 'WAIT_FOR_PROVIDER_ESTIMATE'
        : perspective === 'PROVIDER' ? 'WAIT_FOR_INVITATION' : 'ISSUE_ESTIMATE_INVITATION';
    }
    if (!row.estimate_id) {
      return perspective === 'CUSTOMER'
        ? 'WAIT_FOR_PROVIDER_ESTIMATE'
        : perspective === 'PROVIDER' ? 'SUBMIT_ESTIMATE' : 'MONITOR_ESTIMATE';
    }
    if (!row.acceptance_id) {
      return perspective === 'CUSTOMER'
        ? 'REVIEW_ESTIMATE'
        : perspective === 'PROVIDER' ? 'WAIT_FOR_ESTIMATE_DECISION' : 'MONITOR_CUSTOMER_DECISION';
    }
  }

  if (!row.task_id) {
    return perspective === 'OPERATIONS' ? 'MONITOR_PROVIDER_INTEREST' : 'WAIT_FOR_TASK_MATERIALIZATION';
  }
  if (
    row.eligibility_task_eligible !== true
    || row.eligibility_is_current !== true
  ) {
    return perspective === 'CUSTOMER'
      ? 'WAIT_FOR_PROVIDER_INTEREST'
      : perspective === 'PROVIDER'
        ? 'RESOLVE_ELIGIBILITY_BLOCKERS'
        : 'ESTABLISH_ELIGIBILITY';
  }
  if (!row.interest_id || row.interest_status !== 'pending') {
    return perspective === 'CUSTOMER'
      ? 'WAIT_FOR_PROVIDER_INTEREST'
      : perspective === 'PROVIDER' ? 'EXPRESS_INTEREST' : 'MONITOR_PROVIDER_INTEREST';
  }
  if (!row.hold_id || row.hold_is_active !== true) {
    return perspective === 'CUSTOMER'
      ? 'REVIEW_PROVIDER_INTEREST'
      : perspective === 'PROVIDER' ? 'WAIT_FOR_CUSTOMER_HOLD' : 'MONITOR_HOLD';
  }
  if (!row.work_order_id) {
    return perspective === 'CUSTOMER'
      ? 'MATERIALIZE_WORK_ORDER'
      : perspective === 'PROVIDER' ? 'WAIT_FOR_WORK_ORDER' : 'MONITOR_WORK_ORDER_MATERIALIZATION';
  }

  if (row.completion_kind === 'APPROVED') {
    if (!row.terminal_intent_id) {
      return perspective === 'OPERATIONS'
        ? 'COMPLETE_FAKE_FINANCIAL_LIFECYCLE'
        : 'WAIT_FOR_FINANCIAL_COMPLETION';
    }
    if (row.reconciliation_state === 'MISMATCH') {
      return perspective === 'OPERATIONS'
        ? 'RESOLVE_RECONCILIATION_MISMATCH'
        : 'WAIT_FOR_RECONCILIATION';
    }
    if (
      (row.terminal_path === 'SETTLED' && row.reconciliation_state === 'MATCHED')
      || (row.terminal_path === 'FULL_REFUND' && row.reconciliation_state === 'CLOSED')
    ) {
      return 'OCCURRENCE_COMPLETE';
    }
    return 'WAIT_FOR_RECONCILIATION';
  }
  if (perspective === 'OPERATIONS') return 'MONITOR_EXECUTION';
  if (perspective === 'CUSTOMER') {
    if (row.execution_state === 'COMPLETION_SUBMITTED') {
      return row.completion_delivery_event_id
        ? 'DECIDE_COMPLETION'
        : 'WAIT_FOR_COMPLETION_NOTICE';
    }
    return 'TRACK_WORK_ORDER';
  }
  switch (row.execution_state) {
    case 'MATERIALIZED': return 'ACKNOWLEDGE_WORK_ORDER';
    case 'ACKNOWLEDGED': return 'START_TRAVEL_OR_WORK';
    case 'EN_ROUTE': return 'MARK_ARRIVAL';
    case 'ARRIVED': return 'START_WORK';
    case 'COMPLETION_SUBMITTED': return 'WAIT_FOR_COMPLETION_DECISION';
    case 'IN_PROGRESS':
    case 'PAUSED':
    case 'REWORK_REQUIRED':
      return 'CONTINUE_EXECUTION';
    default: return 'WAIT_FOR_WORK_ORDER';
  }
}

function projection(
  perspective: UniversalV1OccurrencePerspective,
  row: RawUniversalV1OccurrenceRow,
): UniversalV1OccurrenceProjection {
  const provider = row.provider_class ? {
    provider_class: row.provider_class,
    ...(perspective === 'CUSTOMER' ? {} : {
      provider_user_id: row.provider_user_id ?? undefined,
      provider_organization_id: row.provider_organization_id,
    }),
  } : null;

  const estimate = row.estimate_id
    && row.estimate_quote_id
    && row.estimate_quote_version_id
    && row.estimate_version !== null
    && row.estimate_work_category
    && row.estimate_currency
    && row.estimate_created_at
    ? {
      provider_estimate_submission_id: row.estimate_id,
      quote_id: row.estimate_quote_id,
      quote_version_id: row.estimate_quote_version_id,
      quote_version: row.estimate_version,
      work_category_code: row.estimate_work_category,
      currency: row.estimate_currency,
      ...(row.estimate_customer_total_cents !== null
        ? { customer_total_cents: cents(row.estimate_customer_total_cents) }
        : {}),
      ...(perspective !== 'CUSTOMER' && row.estimate_provider_payout_cents !== null
        ? { provider_payout_cents: cents(row.estimate_provider_payout_cents) }
        : {}),
      submitted_at: iso(row.estimate_created_at),
    }
    : null;

  const scope = row.scope_version_id
    && row.scope_version !== null
    && row.scope_hash
    && row.scope_source
    && row.scope_currency
    && row.scope_created_at
    ? {
      scope_version_id: row.scope_version_id,
      version: row.scope_version,
      source: row.scope_source,
      currency: row.scope_currency,
      ...(row.scope_customer_total_cents !== null
        ? { customer_total_cents: cents(row.scope_customer_total_cents) }
        : {}),
      ...(perspective !== 'CUSTOMER' && row.scope_provider_payout_cents !== null
        ? { provider_payout_cents: cents(row.scope_provider_payout_cents) }
        : {}),
      created_at: iso(row.scope_created_at),
    }
    : null;

  const reconciliation = row.reconciliation_id
    && row.reconciliation_version !== null
    && row.reconciliation_void_state
    && row.reconciliation_capture_state
    && row.reconciliation_refund_state
    && row.reconciliation_reversal_state
    && row.reconciliation_settlement_state
    && row.reconciliation_funding_state
    && row.reconciliation_provider_release_state
    && row.reconciliation_payout_state
    && row.reconciliation_bank_settlement_state
    && row.reconciliation_ledger_state
    && row.reconciliation_state
    && row.reconciliation_created_at
    ? {
      reconciliation_fact_id: row.reconciliation_id,
      reconciliation_version: row.reconciliation_version,
      void_state: row.reconciliation_void_state,
      capture_state: row.reconciliation_capture_state,
      refund_state: row.reconciliation_refund_state,
      reversal_state: row.reconciliation_reversal_state,
      settlement_state: row.reconciliation_settlement_state,
      funding_state: row.reconciliation_funding_state,
      provider_release_state: row.reconciliation_provider_release_state,
      payout_state: row.reconciliation_payout_state,
      bank_settlement_state: row.reconciliation_bank_settlement_state,
      ledger_state: row.reconciliation_ledger_state,
      state: row.reconciliation_state,
      mismatch_codes: row.reconciliation_mismatch_codes ?? [],
      recorded_at: iso(row.reconciliation_created_at),
    }
    : null;

  return {
    task_draft_id: row.task_draft_id,
    perspective,
    draft: { status: row.draft_status, updated_at: iso(row.draft_updated_at) },
    route: row.route_id
      && row.route_version !== null
      && row.route_outcome
      && row.route_policy_version
      && row.route_category
      && row.route_created_at
      ? {
        routing_decision_id: row.route_id,
        decision_version: row.route_version,
        outcome: row.route_outcome,
        reason_codes: row.route_reason_codes ?? [],
        policy_version: row.route_policy_version,
        work_category_code: row.route_category,
        service_cell: row.route_service_cell,
        decided_at: iso(row.route_created_at),
      }
      : null,
    provider,
    eligibility: row.eligibility_id
      && row.eligibility_version !== null
      && row.eligibility_task_eligible !== null
      && row.eligibility_is_current !== null
      && row.eligibility_policy_version
      && row.eligibility_evaluated_at
      && row.eligibility_valid_until
      ? {
        eligibility_decision_id: row.eligibility_id,
        decision_version: row.eligibility_version,
        task_eligible: row.eligibility_task_eligible,
        is_current: row.eligibility_is_current,
        blocker_codes: row.eligibility_blocker_codes ?? [],
        policy_version: row.eligibility_policy_version,
        evaluated_at: iso(row.eligibility_evaluated_at),
        valid_until: iso(row.eligibility_valid_until),
      }
      : null,
    invitation: row.invitation_id
      && row.invitation_is_current !== null
      && row.invitation_valid_until
      && row.invitation_created_at
      ? {
        invitation_id: row.invitation_id,
        is_current: row.invitation_is_current,
        valid_until: iso(row.invitation_valid_until),
        created_at: iso(row.invitation_created_at),
      }
      : null,
    estimate,
    acceptance: row.acceptance_id && row.acceptance_created_at
      ? {
        acceptance_materialization_id: row.acceptance_id,
        accepted_at: iso(row.acceptance_created_at),
      }
      : null,
    task: row.task_id
      && row.task_state
      && row.task_category
      && row.task_risk_level
      && row.task_requires_proof !== null
      ? {
        task_id: row.task_id,
        state: row.task_state,
        category: row.task_category,
        risk_level: row.task_risk_level,
        requires_proof: row.task_requires_proof,
      }
      : null,
    scope,
    interest: row.interest_id && row.interest_status && row.interest_created_at
      ? {
        interest_application_id: row.interest_id,
        status: row.interest_status,
        expressed_at: iso(row.interest_created_at),
      }
      : null,
    hold: row.hold_id
      && row.hold_is_active !== null
      && row.hold_status
      && row.hold_reserved_at
      && row.hold_expires_at
      ? {
        conditional_hold_id: row.hold_id,
        is_active: row.hold_is_active,
        status: row.hold_status,
        reserved_at: iso(row.hold_reserved_at),
        expires_at: iso(row.hold_expires_at),
      }
      : null,
    work_order: row.work_order_id
      && row.work_order_materialization_version !== null
      && row.work_order_materialized_at
      ? {
        work_order_id: row.work_order_id,
        materialization_version: row.work_order_materialization_version,
        materialized_at: iso(row.work_order_materialized_at),
      }
      : null,
    execution: row.execution_fact_id
      && row.execution_version !== null
      && row.execution_state
      && row.execution_transition
      && row.execution_recorded_at
      ? {
        execution_fact_id: row.execution_fact_id,
        execution_version: row.execution_version,
        state: row.execution_state,
        transition_kind: row.execution_transition,
        recorded_at: iso(row.execution_recorded_at),
      }
      : null,
    completion: row.completion_fact_id
      && row.completion_version !== null
      && row.completion_kind
      && row.completion_created_at
      ? {
        completion_fact_id: row.completion_fact_id,
        completion_version: row.completion_version,
        fact_kind: row.completion_kind,
        recorded_at: iso(row.completion_created_at),
        ...(perspective !== 'PROVIDER'
          && row.completion_delivery_event_id
          && row.completion_delivery_channel
          && row.completion_delivered_at
          ? {
            delivery_receipt: {
              delivery_event_id: row.completion_delivery_event_id,
              status: 'DELIVERED' as const,
              channel: row.completion_delivery_channel,
              delivered_at: iso(row.completion_delivered_at),
            },
          }
          : {}),
      }
      : null,
    financial_lifecycle: row.terminal_intent_id
      && row.terminal_path
      && row.terminal_materialized_at
      ? {
        terminal_intent_id: row.terminal_intent_id,
        terminal_path: row.terminal_path,
        materialized_at: iso(row.terminal_materialized_at),
        reconciliation,
      }
      : null,
    commercial: commercialProjection(perspective, row),
    next_action: nextAction(perspective, row),
    payment_creation_frozen: true,
    hard_assignment_created: false,
    final_availability_confirmation_required: true,
  };
}

export class UniversalV1OccurrenceReadApplication {
  constructor(
    private readonly facts: UniversalV1OccurrenceFactReader,
    private readonly operationsReader?: PostgresUniversalV1OperationsOccurrenceReader,
  ) {}

  async customer(taskDraftId: string, actorUserId: string): Promise<UniversalV1OccurrenceProjection> {
    return this.read('CUSTOMER', () => this.facts.loadCustomer(taskDraftId, actorUserId));
  }

  async provider(taskDraftId: string, actorUserId: string): Promise<UniversalV1OccurrenceProjection> {
    return this.read('PROVIDER', () => this.facts.loadProvider(taskDraftId, actorUserId));
  }

  async operationsAudited(
    taskDraftId: string,
    actorUserId: string,
    purpose: string,
  ): Promise<UniversalV1OccurrenceProjection> {
    if (!this.operationsReader) {
      throw new UniversalV1OccurrenceReadError('OCCURRENCE_READ_UNAVAILABLE');
    }
    try {
      const result = await this.operationsReader.read(taskDraftId, actorUserId, purpose);
      if (!result) throw new UniversalV1OccurrenceReadError('OCCURRENCE_NOT_FOUND');
      return result;
    } catch (error) {
      if (error instanceof UniversalV1OccurrenceReadError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/HXUOC(?:1|2):/u.test(message)) {
        throw new UniversalV1OccurrenceReadError('OCCURRENCE_OPERATOR_AUTHORITY_REVOKED');
      }
      throw new UniversalV1OccurrenceReadError('OCCURRENCE_READ_UNAVAILABLE');
    }
  }

  private async read(
    perspective: UniversalV1OccurrencePerspective,
    load: () => Promise<RawUniversalV1OccurrenceRow | null>,
  ): Promise<UniversalV1OccurrenceProjection> {
    try {
      const row = await load();
      if (!row) throw new UniversalV1OccurrenceReadError('OCCURRENCE_NOT_FOUND');
      return projection(perspective, row);
    } catch (error) {
      if (error instanceof UniversalV1OccurrenceReadError) throw error;
      throw new UniversalV1OccurrenceReadError('OCCURRENCE_READ_UNAVAILABLE');
    }
  }
}

function occurrenceSql(perspective: UniversalV1OccurrencePerspective): string {
  const draftAuthority = perspective === 'CUSTOMER'
    ? 'AND draft.poster_user_id = $2'
    : '';
  const providerAuthority = perspective === 'PROVIDER'
    ? `AND (
        candidate.provider_user_id = $2
        OR public.business_membership_has_action(
          candidate.provider_organization_id,
          $2,
          'SUBMIT_ESTIMATE'
        )
      )`
    : '';
  const requireProviderChain = perspective === 'PROVIDER'
    ? 'WHERE provider_key.provider_user_id IS NOT NULL'
    : '';

  return `
    WITH authorized_draft AS (
      SELECT draft.id, draft.status, draft.updated_at, draft.task_id,
             draft.active_routing_decision_id
        FROM public.task_drafts draft
       WHERE draft.id = $1
         AND draft.universal_contract_version = 1
         ${draftAuthority}
       LIMIT 1
    )
    SELECT draft.id AS task_draft_id,
           draft.status AS draft_status,
           draft.updated_at AS draft_updated_at,
           route.id AS route_id,
           route.decision_version AS route_version,
           route.outcome AS route_outcome,
           route.reason_codes AS route_reason_codes,
           route.policy_version AS route_policy_version,
           route.category_snapshot AS route_category,
           route.service_cell_snapshot AS route_service_cell,
           route.created_at AS route_created_at,
           provider_key.provider_user_id,
           provider_key.provider_organization_id,
           eligibility.provider_class,
           qualification.provider_class AS qualification_provider_class,
           qualification.credential_type AS qualification_credential_type,
           qualification.issuing_authority AS qualification_issuing_authority,
           qualification.jurisdiction_code AS qualification_jurisdiction_code,
           qualification.license_scope AS qualification_license_scope,
           qualification.license_status AS qualification_license_status,
           qualification.expires_at AS qualification_expires_at,
           qualification.verified_at AS qualification_verified_at,
           qualification.official_source_checked_at
             AS qualification_official_source_checked_at,
           qualification.permitted_work_categories
             AS qualification_permitted_work_categories,
           eligibility.id AS eligibility_id,
           eligibility.decision_version AS eligibility_version,
           eligibility.task_eligible AS eligibility_task_eligible,
           eligibility.valid_until > clock_timestamp() AS eligibility_is_current,
           eligibility.blocker_codes AS eligibility_blocker_codes,
           eligibility.policy_version AS eligibility_policy_version,
           eligibility.evaluated_at AS eligibility_evaluated_at,
           eligibility.valid_until AS eligibility_valid_until,
           invitation.id AS invitation_id,
           invitation.quote_id AS invitation_quote_id,
           invitation.routing_decision_version AS invitation_expected_draft_version,
           invitation.expected_quote_version AS invitation_expected_quote_version,
           invitation.valid_until > clock_timestamp() AS invitation_is_current,
           invitation.valid_until AS invitation_valid_until,
           invitation.created_at AS invitation_created_at,
           estimate.id AS estimate_id,
           estimate.quote_id AS estimate_quote_id,
           estimate.quote_version_id AS estimate_quote_version_id,
           estimate.expected_quote_version AS estimate_version,
           estimate.work_category_code AS estimate_work_category,
           estimate.customer_total_cents AS estimate_customer_total_cents,
           estimate.provider_payout_cents AS estimate_provider_payout_cents,
           estimate.currency AS estimate_currency,
           estimate.scope_snapshot AS estimate_scope_snapshot,
           estimate.line_items AS estimate_line_items,
           estimate.created_at AS estimate_created_at,
           acceptance.id AS acceptance_id,
           acceptance.created_at AS acceptance_created_at,
           task.id AS task_id,
           task.state AS task_state,
           task.category AS task_category,
           task.risk_level AS task_risk_level,
           task.requires_proof AS task_requires_proof,
           task.universal_payment_posture AS task_universal_payment_posture,
           task.automation_classification AS task_automation_classification,
           task.worker_id AS task_worker_id,
           scope.id AS scope_version_id,
           scope.version AS scope_version,
           scope.scope_hash,
           scope.source AS scope_source,
           scope.customer_total_cents AS scope_customer_total_cents,
           scope.hustler_payout_cents AS scope_provider_payout_cents,
           scope.currency AS scope_currency,
           scope.title AS scope_title,
           scope.description AS scope_description,
           scope.requirements AS scope_requirements,
           scope.checklist AS scope_checklist,
           scope.created_at AS scope_created_at,
           interest.id AS interest_id,
           interest.status AS interest_status,
           interest.created_at AS interest_created_at,
           hold.id AS hold_id,
           hold.status = 'ACTIVE' AND hold.expires_at > clock_timestamp()
             AS hold_is_active,
           hold.status AS hold_status,
           hold.reserved_at AS hold_reserved_at,
           hold.expires_at AS hold_expires_at,
           work_order.id AS work_order_id,
           work_order.materialization_version AS work_order_materialization_version,
           work_order.materialized_at AS work_order_materialized_at,
           latest_amendment.id AS latest_amendment_id,
           latest_amendment.amendment_version AS latest_amendment_version,
           latest_financial.expected_version AS latest_financial_version,
           change_orders.timeline AS change_order_timeline,
           execution.id AS execution_fact_id,
           execution.execution_version,
           execution.state AS execution_state,
           execution.transition_kind AS execution_transition,
           execution.recorded_at AS execution_recorded_at,
           completion.id AS completion_fact_id,
           completion.completion_version,
           completion.fact_kind AS completion_kind,
           completion.created_at AS completion_created_at,
           completion_delivery.id AS completion_delivery_event_id,
           completion_delivery.channel AS completion_delivery_channel,
           completion_delivery.delivered_at AS completion_delivered_at,
           terminal_intent.terminal_intent_id,
           terminal_intent.terminal_path,
           terminal_intent.materialized_at AS terminal_materialized_at,
           reconciliation.id AS reconciliation_id,
           reconciliation.reconciliation_version,
           reconciliation.void_state AS reconciliation_void_state,
           reconciliation.capture_state AS reconciliation_capture_state,
           reconciliation.refund_state AS reconciliation_refund_state,
           reconciliation.reversal_state AS reconciliation_reversal_state,
           reconciliation.settlement_state AS reconciliation_settlement_state,
           reconciliation.funding_state AS reconciliation_funding_state,
           reconciliation.provider_release_state AS reconciliation_provider_release_state,
           reconciliation.payout_state AS reconciliation_payout_state,
           reconciliation.bank_settlement_state AS reconciliation_bank_settlement_state,
           reconciliation.ledger_state AS reconciliation_ledger_state,
           reconciliation.reconciliation_state,
           reconciliation.mismatch_codes AS reconciliation_mismatch_codes,
           reconciliation.created_at AS reconciliation_created_at
      FROM authorized_draft draft
      LEFT JOIN public.task_routing_decisions route
        ON route.id = draft.active_routing_decision_id
       AND route.task_draft_id = draft.id
      LEFT JOIN public.tasks task
        ON task.id = draft.task_id
       AND task.universal_contract_version = 1
      LEFT JOIN LATERAL (
        SELECT candidate.provider_user_id, candidate.provider_organization_id
          FROM (
            SELECT work_order.provider_user_id, work_order.provider_organization_id,
                   1 AS stage_priority, work_order.materialized_at AS stage_at
              FROM public.task_work_orders work_order
             WHERE work_order.task_draft_id = draft.id
            UNION ALL
            SELECT estimate.provider_user_id, estimate.provider_organization_id,
                   2 AS stage_priority, materialization.created_at AS stage_at
              FROM public.task_estimate_acceptance_materializations materialization
              JOIN public.provider_estimate_submissions estimate
                ON estimate.id = materialization.provider_estimate_submission_id
             WHERE materialization.task_draft_id = draft.id
            UNION ALL
            SELECT estimate.provider_user_id, estimate.provider_organization_id,
                   3 AS stage_priority, estimate.created_at AS stage_at
              FROM public.provider_estimate_submissions estimate
              JOIN public.task_routing_decisions estimate_route
                ON estimate_route.id = estimate.routing_decision_id
             WHERE estimate_route.task_draft_id = draft.id
            UNION ALL
            SELECT invitation.provider_user_id, invitation.provider_organization_id,
                   4 AS stage_priority, invitation.created_at AS stage_at
              FROM public.task_provider_estimate_invitations invitation
             WHERE invitation.task_draft_id = draft.id
            UNION ALL
            SELECT eligibility.provider_user_id, eligibility.provider_organization_id,
                   5 AS stage_priority, eligibility.evaluated_at AS stage_at
              FROM public.task_provider_eligibility_decisions eligibility
             WHERE eligibility.task_draft_id = draft.id
            UNION ALL
            SELECT interest.hustler_id AS provider_user_id,
                   interest.provider_organization_id,
                   6 AS stage_priority, interest.created_at AS stage_at
              FROM public.task_applications interest
              JOIN public.current_universal_v1_task_opportunities_v1 current_opportunity
                ON current_opportunity.opportunity_id = interest.opportunity_id
               AND current_opportunity.opportunity_version = interest.opportunity_version
               AND current_opportunity.task_draft_id = draft.id
               AND current_opportunity.routing_decision_id =
                   interest.interest_routing_decision_id
               AND current_opportunity.routing_decision_id = draft.active_routing_decision_id
             WHERE interest.universal_contract_version = 1
               AND interest.opportunity_contract_version = 1
               AND interest.authority = 'EXPRESS_INTEREST'
               AND interest.status = 'pending'
          ) candidate
         WHERE candidate.provider_user_id IS NOT NULL
           ${providerAuthority}
         ORDER BY candidate.stage_priority, candidate.stage_at DESC,
                  candidate.provider_user_id, candidate.provider_organization_id NULLS FIRST
         LIMIT 1
      ) provider_key ON TRUE
      LEFT JOIN LATERAL (
        SELECT eligibility.id, eligibility.provider_class,
               eligibility.trade_credential_id,
               eligibility.decision_version, eligibility.task_eligible,
               eligibility.blocker_codes, eligibility.policy_version,
               eligibility.evaluated_at, eligibility.valid_until
          FROM public.task_provider_eligibility_decisions eligibility
         WHERE eligibility.task_draft_id = draft.id
           AND eligibility.provider_user_id = provider_key.provider_user_id
           AND eligibility.provider_organization_id IS NOT DISTINCT FROM
               provider_key.provider_organization_id
         ORDER BY eligibility.decision_version DESC, eligibility.evaluated_at DESC,
                  eligibility.id DESC
         LIMIT 1
      ) eligibility ON TRUE
      LEFT JOIN LATERAL (
        SELECT qualification.provider_class, qualification.credential_type,
               qualification.issuing_authority, qualification.jurisdiction_code,
               qualification.license_scope, qualification.license_status,
               qualification.expires_at, qualification.verified_at,
               qualification.official_source_checked_at,
               qualification.permitted_work_categories
          FROM public.current_verified_trade_qualifications qualification
         WHERE qualification.business_credential_id = eligibility.trade_credential_id
           AND qualification.provider_user_id = provider_key.provider_user_id
           AND qualification.organization_id IS NOT DISTINCT FROM
               provider_key.provider_organization_id
         ORDER BY qualification.official_source_checked_at DESC,
                  qualification.business_credential_id
         LIMIT 1
      ) qualification ON TRUE
      LEFT JOIN LATERAL (
        SELECT invitation.id, invitation.quote_id,
               invitation.routing_decision_version,
               COALESCE(active_quote_version.expected_quote_version, 0)
                 AS expected_quote_version,
               invitation.valid_until, invitation.created_at
          FROM public.task_provider_estimate_invitations invitation
          JOIN public.quotes invited_quote
            ON invited_quote.id = invitation.quote_id
           AND invited_quote.task_draft_id = invitation.task_draft_id
           AND invited_quote.provider_user_id = invitation.provider_user_id
           AND invited_quote.provider_organization_id IS NOT DISTINCT FROM
               invitation.provider_organization_id
          LEFT JOIN public.quote_versions active_quote_version
            ON active_quote_version.id = invited_quote.active_version_id
           AND active_quote_version.quote_id = invited_quote.id
         WHERE invitation.task_draft_id = draft.id
           AND invitation.provider_user_id = provider_key.provider_user_id
           AND invitation.provider_organization_id IS NOT DISTINCT FROM
               provider_key.provider_organization_id
         ORDER BY invitation.created_at DESC, invitation.id DESC
         LIMIT 1
      ) invitation ON TRUE
      LEFT JOIN LATERAL (
        SELECT materialization.id,
               materialization.provider_estimate_submission_id,
               materialization.created_at
          FROM public.task_estimate_acceptance_materializations materialization
          JOIN public.provider_estimate_submissions accepted_estimate
            ON accepted_estimate.id = materialization.provider_estimate_submission_id
         WHERE materialization.task_draft_id = draft.id
           AND accepted_estimate.provider_user_id = provider_key.provider_user_id
           AND accepted_estimate.provider_organization_id IS NOT DISTINCT FROM
               provider_key.provider_organization_id
         ORDER BY materialization.created_at DESC, materialization.id DESC
         LIMIT 1
      ) acceptance ON TRUE
      LEFT JOIN LATERAL (
        SELECT estimate.id, estimate.quote_id, estimate.quote_version_id,
               estimate.expected_quote_version, estimate.work_category_code,
               estimate.customer_total_cents, estimate.provider_payout_cents,
               estimate.currency, estimate.scope_snapshot, estimate.line_items,
               estimate.created_at
          FROM public.provider_estimate_submissions estimate
          JOIN public.task_routing_decisions estimate_route
            ON estimate_route.id = estimate.routing_decision_id
         WHERE estimate_route.task_draft_id = draft.id
           AND estimate.provider_user_id = provider_key.provider_user_id
           AND estimate.provider_organization_id IS NOT DISTINCT FROM
               provider_key.provider_organization_id
         ORDER BY (estimate.id = acceptance.provider_estimate_submission_id) DESC,
                  estimate.created_at DESC, estimate.id DESC
         LIMIT 1
      ) estimate ON TRUE
      LEFT JOIN public.task_scope_versions scope
        ON scope.id = task.active_scope_version_id
       AND scope.task_id = task.id
       AND scope.universal_contract_version = 1
      LEFT JOIN LATERAL (
        SELECT interest.id, interest.status, interest.created_at
          FROM public.task_applications interest
         WHERE interest.interest_routing_decision_id = route.id
           AND interest.interest_routing_decision_version = route.decision_version
           AND interest.task_draft_id = draft.id
           AND interest.universal_contract_version = 1
           AND interest.opportunity_contract_version = 1
           AND interest.authority = 'EXPRESS_INTEREST'
           AND interest.status = 'pending'
           AND interest.hustler_id = provider_key.provider_user_id
           AND interest.provider_organization_id IS NOT DISTINCT FROM
               provider_key.provider_organization_id
         ORDER BY interest.created_at DESC, interest.id DESC
         LIMIT 1
      ) interest ON TRUE
      LEFT JOIN LATERAL (
        SELECT hold.id, hold.status, hold.reserved_at, hold.expires_at
          FROM public.task_reservations hold
         WHERE hold.task_id = task.id
           AND hold.universal_contract_version = 1
           AND hold.hold_kind = 'CONDITIONAL_HOLD'
           AND hold.hustler_id = provider_key.provider_user_id
           AND (
             interest.id IS NULL
             OR hold.interest_application_id = interest.id
           )
         ORDER BY hold.reserved_at DESC, hold.id DESC
         LIMIT 1
      ) hold ON TRUE
      LEFT JOIN public.task_work_orders work_order
        ON work_order.task_draft_id = draft.id
       AND work_order.task_id = task.id
       AND work_order.provider_user_id = provider_key.provider_user_id
       AND work_order.provider_organization_id IS NOT DISTINCT FROM
           provider_key.provider_organization_id
      LEFT JOIN LATERAL (
        SELECT amendment.id, amendment.amendment_version,
               amendment.scope_version_id
          FROM public.task_work_order_amendments amendment
         WHERE amendment.work_order_id = work_order.id
         ORDER BY amendment.amendment_version DESC, amendment.id DESC
         LIMIT 1
      ) latest_amendment ON TRUE
      LEFT JOIN LATERAL (
        SELECT financial.expected_version
          FROM public.task_financial_security_events financial
         WHERE financial.task_draft_id = draft.id
         ORDER BY financial.expected_version DESC, financial.id DESC
         LIMIT 1
      ) latest_financial ON TRUE
      LEFT JOIN LATERAL (
        SELECT COALESCE(
          jsonb_agg(history.entry ORDER BY history.proposal_version),
          '[]'::jsonb
        ) AS timeline
        FROM (
          SELECT proposal.proposal_version,
                 jsonb_build_object(
                   'proposal_id', proposal.id,
                   'proposal_version', proposal.proposal_version,
                   'status', proposal.status,
                   'change_order_kind', proposal.change_order_kind,
                   'proposer_party', CASE proposal.proposer_role
                     WHEN 'POSTER' THEN 'CUSTOMER'
                     ELSE 'PROVIDER'
                   END,
                   'supersedes_proposal_id', proposal.supersedes_proposal_id,
                   'base_scope_version_id', proposal.base_version_id,
                   'base_scope_version', base_scope.version,
                   'observed_scope_summary', proposal.observed_scope_summary,
                   'proposed_scope_sha256', proposal.proposed_scope_sha256,
                   'proposed_scope', jsonb_build_object(
                     'title', proposal.proposed_title,
                     'description', proposal.proposed_description,
                     'requirements', proposal.proposed_requirements,
                     'checklist', proposal.proposed_checklist
                   ),
                   'proposed_customer_total_cents',
                     proposal.proposed_customer_total_cents,
                   'proposed_provider_payout_cents',
                     proposal.proposed_provider_payout_cents,
                   'created_at', proposal.created_at,
                   'approvals', COALESCE((
                     SELECT jsonb_agg(jsonb_build_object(
                       'approver_party', approval.approver_role,
                       'decision', approval.decision,
                       'decided_at', approval.created_at
                     ) ORDER BY approval.created_at, approval.id)
                     FROM public.task_scope_change_approvals approval
                     WHERE approval.proposal_id = proposal.id
                   ), '[]'::jsonb),
                   'materialization_state', CASE
                     WHEN amendment.id IS NOT NULL THEN 'MATERIALIZED'
                     WHEN public.universal_v1_change_order_recovery_resolution_v1(
                       proposal.id
                     ) = 'CANCELLED_RECOVERY_REQUIRED'
                       THEN 'CANCELLED_RECOVERY_REQUIRED'
                     WHEN prepared.proposal_id IS NOT NULL THEN 'PREPARED_RECOVERING'
                     ELSE 'NOT_PREPARED'
                   END,
                   'amendment_id', amendment.id,
                   'amendment_version', amendment.amendment_version,
                   'amendment_scope_version_id', amendment.scope_version_id,
                   'amendment_scope_version', amendment_scope.version
                 ) AS entry
            FROM public.task_scope_change_proposals proposal
            JOIN public.task_scope_versions base_scope
              ON base_scope.id = proposal.base_version_id
             AND base_scope.task_id = proposal.task_id
            LEFT JOIN public.task_work_order_amendments amendment
              ON amendment.change_order_id = proposal.id
             AND amendment.work_order_id = work_order.id
            LEFT JOIN public.task_scope_versions amendment_scope
              ON amendment_scope.id = amendment.scope_version_id
             AND amendment_scope.task_id = proposal.task_id
            LEFT JOIN public.universal_v1_change_order_materialization_commands prepared
              ON prepared.proposal_id = proposal.id
           WHERE proposal.task_id = task.id
             AND proposal.universal_contract_version = 1
             AND proposal.application_contract_version = 1
        ) history
      ) change_orders ON TRUE
      LEFT JOIN LATERAL (
        SELECT execution.id, execution.execution_version, execution.state,
               execution.transition_kind, execution.recorded_at
          FROM public.task_work_order_execution_facts execution
         WHERE execution.work_order_id = work_order.id
         ORDER BY execution.execution_version DESC, execution.id DESC
         LIMIT 1
      ) execution ON TRUE
      LEFT JOIN LATERAL (
        SELECT completion.id, completion.completion_version,
               completion.fact_kind, completion.supersedes_fact_id,
               completion.created_at
          FROM public.task_completion_facts completion
         WHERE completion.work_order_id = work_order.id
         ORDER BY completion.completion_version DESC, completion.id DESC
         LIMIT 1
      ) completion ON TRUE
      LEFT JOIN LATERAL (
        SELECT delivery.id, delivery.channel, delivery.delivered_at
          FROM public.task_completion_delivery_events delivery
         WHERE delivery.work_order_id = work_order.id
           AND delivery.expected_completion_fact_id = CASE
             WHEN completion.fact_kind = 'SUBMITTED' THEN completion.id
             WHEN completion.fact_kind = 'APPROVED' THEN completion.supersedes_fact_id
             ELSE NULL
           END
         ORDER BY delivery.delivered_at DESC, delivery.id DESC
         LIMIT 1
      ) completion_delivery ON TRUE
      LEFT JOIN public.universal_v1_fake_terminal_lifecycle_intents terminal_intent
        ON terminal_intent.work_order_id = work_order.id
       AND terminal_intent.completion_fact_id = completion.id
      LEFT JOIN LATERAL (
        SELECT reconciliation.id, reconciliation.reconciliation_version,
               reconciliation.void_state, reconciliation.capture_state,
               reconciliation.refund_state, reconciliation.reversal_state,
               reconciliation.settlement_state, reconciliation.funding_state,
               reconciliation.provider_release_state, reconciliation.payout_state,
               reconciliation.bank_settlement_state, reconciliation.ledger_state,
               reconciliation.reconciliation_state, reconciliation.mismatch_codes,
               reconciliation.created_at
          FROM public.task_reconciliation_facts reconciliation
         WHERE reconciliation.work_order_id = work_order.id
         ORDER BY reconciliation.reconciliation_version DESC,
                  reconciliation.id DESC
         LIMIT 1
      ) reconciliation ON TRUE
      ${requireProviderChain}
     LIMIT 1`;
}

export class PostgresUniversalV1OccurrenceFactReader
implements UniversalV1OccurrenceFactReader {
  constructor(private readonly query: QueryFn = db.query.bind(db)) {}

  async loadCustomer(
    taskDraftId: string,
    actorUserId: string,
  ): Promise<RawUniversalV1OccurrenceRow | null> {
    return loadPostgresOccurrence(this.query, 'CUSTOMER', [taskDraftId, actorUserId]);
  }

  async loadProvider(
    taskDraftId: string,
    actorUserId: string,
  ): Promise<RawUniversalV1OccurrenceRow | null> {
    return loadPostgresOccurrence(this.query, 'PROVIDER', [taskDraftId, actorUserId]);
  }
}

async function loadPostgresOccurrence(
  query: QueryFn,
  perspective: UniversalV1OccurrencePerspective,
  params: unknown[],
): Promise<RawUniversalV1OccurrenceRow | null> {
  const result = await query<RawUniversalV1OccurrenceRow>(
    occurrenceSql(perspective),
    params,
  );
  return result.rows[0] ?? null;
}

function canonicalizeProjection(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeProjection);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalizeProjection(entry)]),
  );
}

export function universalV1OccurrenceProjectionSha256(
  value: UniversalV1OccurrenceProjection,
): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeProjection(value)), 'utf8')
    .digest('hex');
}

/**
 * Purpose-bound Operations reads are linearized in one primary transaction:
 * PostgreSQL rechecks the named operator, reads one exact projection snapshot,
 * and appends its digest before any data can be returned to the caller.
 */
export class PostgresUniversalV1OperationsOccurrenceReader {
  constructor(
    private readonly transaction: Database['transaction'] = db.transaction.bind(db),
  ) {}

  async read(
    taskDraftId: string,
    actorUserId: string,
    purpose: string,
  ): Promise<UniversalV1OccurrenceProjection | null> {
    return this.transaction(async (query) => {
      const authority = await query<{ actor_role: string }>(
        `SELECT public.assert_universal_v1_ops_case_operator_v1($1, FALSE) AS actor_role`,
        [actorUserId],
      );
      const actorRole = authority.rows[0]?.actor_role;
      if (!actorRole) {
        throw new Error('HXUOC1: current named Operations authority is required');
      }

      const raw = await loadPostgresOccurrence(query, 'OPERATIONS', [taskDraftId]);
      if (!raw) return null;
      const observed = projection('OPERATIONS', raw);
      const projectionSha256 = universalV1OccurrenceProjectionSha256(observed);
      await query(
        `INSERT INTO public.universal_v1_occurrence_access_audit(
           task_draft_id, actor_id, actor_role, purpose, projection_sha256
         ) VALUES ($1, $2, $3, $4, $5)`,
        [taskDraftId, actorUserId, actorRole, purpose, projectionSha256],
      );
      return observed;
    });
  }
}
