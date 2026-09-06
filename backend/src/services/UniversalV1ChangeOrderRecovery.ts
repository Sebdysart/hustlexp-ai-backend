import { db, type Database } from '../db.js';
import {
  UniversalV1ChangeOrderError,
  type MaterializedUniversalV1ChangeOrder,
} from './UniversalV1ChangeOrderContracts.js';
import {
  PostgresUniversalV1ChangeOrderRepository,
  type PriceAndScopeChangeOrderMaterializationPhase,
} from './UniversalV1ChangeOrderPostgresRepository.js';
import type {
  RecordedUniversalV1FinancialEvent,
  UniversalV1FakeFinancialApplicationService,
} from './payment/UniversalV1FinancialApplicationService.js';

/**
 * Compensation is deliberately terminal. A compensating REVERSAL closes the
 * adjusted fake-value chain, but it does not recreate the predecessor SECURED
 * state and it grants no execution/capture authority.
 */
export const UNIVERSAL_V1_CHANGE_ORDER_RECOVERY_SEMANTIC_LIMITATION = Object.freeze({
  compensationOutcome: 'CANCELLED_RECOVERY_REQUIRED',
  priorSecuredStateRestored: false,
  executionMayResumeAfterCompensation: false,
  captureMayResumeAfterCompensation: false,
  restoreContract: 'NOT_IMPLEMENTED_SEPARATE_REVIEW_REQUIRED',
} as const);

export type UniversalV1ChangeOrderRecoveryObservation =
  | 'ADJUST_READY'
  | 'ADJUST_REPLAYABLE'
  | 'ADJUST_RECONCILE_ONLY'
  | 'ADJUST_TERMINAL_NO_EFFECT'
  | 'ADJUST_NO_EFFECT_AUTHORITY_REVOKED'
  | 'ADJUSTMENT_SUCCEEDED'
  | 'COMPENSATION_READY'
  | 'COMPENSATION_REPLAYABLE'
  | 'COMPENSATION_RECONCILE_ONLY'
  | 'COMPENSATION_TERMINAL_NO_EFFECT'
  | 'COMPENSATION_SUCCEEDED'
  | 'AMENDMENT_MATERIALIZED'
  | 'WAITING';

export interface UniversalV1ChangeOrderCompensationCommand {
  readonly compensationCommandId: string;
  readonly proposalId: string;
  readonly witnessRequestSha256: string;
  readonly taskDraftId: string;
  readonly taskId: string;
  readonly eligibilityDecisionId: string;
  readonly baseScopeVersionId: string;
  readonly adjustmentEventId: string;
  readonly adjustmentOperationId: string;
  readonly reversalOperationId: string;
  readonly reversalIdempotencyKey: string;
  readonly lifecycleExpectedVersion: number;
  readonly amountCents: number;
  readonly currency: string;
  readonly requestedBy: string;
  readonly createdAt: string;
  readonly semanticLimitation: 'PRIOR_SECURED_STATE_NOT_RESTORED';
}

export interface UniversalV1ChangeOrderRecoveryClaim {
  readonly proposalId: string;
  readonly recoveryLeaseId: string;
  readonly leaseOwnerId: string;
  readonly observation: UniversalV1ChangeOrderRecoveryObservation;
  readonly idempotencyKey: string;
  readonly witnessRequestSha256: string;
  readonly actorUserId: string;
  readonly workOrderId: string;
  readonly taskId: string;
  readonly taskDraftId: string;
  readonly eligibilityDecisionId: string;
  readonly baseScopeVersionId: string;
  readonly replacementScopeVersionId: string;
  readonly replacementScopeVersion: number;
  readonly expectedFinancialVersion: number;
  readonly predecessorEventId: string;
  readonly predecessorOperationId: string;
  readonly adjustmentOperationId: string;
  readonly customerTotalCents: number;
  readonly currency: string;
  readonly occurredAt: string;
  readonly adjustmentEventId: string | null;
  readonly amendmentId: string | null;
  readonly compensationEventId: string | null;
  readonly adjustmentOutcomeFactId: string | null;
  readonly authorityRevocationReason: string | null;
  readonly compensationCommand: UniversalV1ChangeOrderCompensationCommand | null;
}

export interface ClaimUniversalV1ChangeOrderRecoveryInput {
  readonly leaseOwnerId: string;
  readonly limit: number;
  readonly leaseDurationSeconds: number;
  readonly minimumAgeSeconds: number;
}

export type UniversalV1ChangeOrderCompensationResolution =
  | {
      readonly kind: 'AMENDMENT_MATERIALIZED';
      readonly amendmentId: string;
      readonly adjustmentEventId: string;
    }
  | {
      readonly kind: 'COMPENSATE';
      readonly command: UniversalV1ChangeOrderCompensationCommand;
    };

export interface UniversalV1ChangeOrderRecoveryRepository {
  claimDue(
    input: ClaimUniversalV1ChangeOrderRecoveryInput
  ): Promise<readonly UniversalV1ChangeOrderRecoveryClaim[]>;
  recordMaterialized(
    claim: UniversalV1ChangeOrderRecoveryClaim,
    amendmentId: string,
    adjustmentEventId: string
  ): Promise<void>;
  claimCompensation(
    claim: UniversalV1ChangeOrderRecoveryClaim,
    adjustmentEventId: string
  ): Promise<UniversalV1ChangeOrderCompensationResolution>;
  recordCompensated(
    claim: UniversalV1ChangeOrderRecoveryClaim,
    command: UniversalV1ChangeOrderCompensationCommand,
    compensationEventId: string
  ): Promise<void>;
  recordNoEffect(
    claim: UniversalV1ChangeOrderRecoveryClaim
  ): Promise<void>;
}

interface ChangeOrderRecoveryClaimRow {
  proposal_id: string;
  recovery_lease_id: string;
  lease_owner_id: string;
  recovery_state: UniversalV1ChangeOrderRecoveryObservation;
  idempotency_key: string;
  request_sha256: string;
  actor_user_id: string;
  work_order_id: string;
  task_id: string;
  task_draft_id: string;
  eligibility_decision_id: string;
  base_scope_version_id: string;
  replacement_scope_version_id: string;
  replacement_scope_version: string | number;
  expected_financial_version: string | number;
  predecessor_event_id: string;
  predecessor_operation_id: string;
  adjustment_operation_id: string;
  customer_total_cents: string | number;
  currency: string;
  occurred_at: string | Date;
  adjustment_event_id: string | null;
  amendment_id: string | null;
  compensation_event_id: string | null;
  adjustment_outcome_fact_id: string | null;
  authority_revocation_reason: string | null;
  compensation_command_id: string | null;
  compensation_reversal_operation_id: string | null;
  compensation_reversal_idempotency_key: string | null;
  compensation_lifecycle_expected_version: string | number | null;
  compensation_amount_cents: string | number | null;
  compensation_currency: string | null;
  compensation_requested_by: string | null;
  compensation_created_at: string | Date | null;
  compensation_semantic_limitation: string | null;
}

interface CompensationResolutionRow {
  resolution_kind: 'AMENDMENT_MATERIALIZED' | 'COMPENSATE';
  amendment_id: string | null;
  adjustment_event_id: string;
  compensation_command_id: string | null;
  proposal_id: string;
  witness_request_sha256: string | null;
  task_draft_id: string | null;
  task_id: string | null;
  eligibility_decision_id: string | null;
  base_scope_version_id: string | null;
  adjustment_operation_id: string | null;
  reversal_operation_id: string | null;
  reversal_idempotency_key: string | null;
  lifecycle_expected_version: string | number | null;
  amount_cents: string | number | null;
  currency: string | null;
  requested_by: string | null;
  created_at: string | Date | null;
  semantic_limitation: string | null;
}

const RECOVERY_STATES = new Set<UniversalV1ChangeOrderRecoveryObservation>([
  'ADJUST_READY',
  'ADJUST_REPLAYABLE',
  'ADJUST_RECONCILE_ONLY',
  'ADJUST_TERMINAL_NO_EFFECT',
  'ADJUST_NO_EFFECT_AUTHORITY_REVOKED',
  'ADJUSTMENT_SUCCEEDED',
  'COMPENSATION_READY',
  'COMPENSATION_REPLAYABLE',
  'COMPENSATION_RECONCILE_ONLY',
  'COMPENSATION_TERMINAL_NO_EFFECT',
  'COMPENSATION_SUCCEEDED',
  'AMENDMENT_MATERIALIZED',
  'WAITING',
]);

function safeInteger(value: string | number | null, code: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(code);
  return number;
}

function isoTimestamp(value: string | Date | null, code: string): string {
  if (value === null) throw new Error(code);
  const timestamp = new Date(value).toISOString();
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(code);
  return timestamp;
}

function compensationFromClaimRow(
  row: ChangeOrderRecoveryClaimRow
): UniversalV1ChangeOrderCompensationCommand | null {
  if (row.compensation_command_id === null) return null;
  if (
    row.compensation_reversal_operation_id === null ||
    row.compensation_reversal_idempotency_key === null ||
    row.compensation_lifecycle_expected_version === null ||
    row.compensation_amount_cents === null ||
    row.compensation_currency === null ||
    row.compensation_requested_by === null ||
    row.compensation_created_at === null ||
    row.compensation_semantic_limitation !== 'PRIOR_SECURED_STATE_NOT_RESTORED' ||
    row.adjustment_event_id === null
  ) {
    throw new Error('CHANGE_ORDER_RECOVERY_COMPENSATION_IDENTITY_INCOMPLETE');
  }
  return {
    compensationCommandId: row.compensation_command_id,
    proposalId: row.proposal_id,
    witnessRequestSha256: row.request_sha256,
    taskDraftId: row.task_draft_id,
    taskId: row.task_id,
    eligibilityDecisionId: row.eligibility_decision_id,
    baseScopeVersionId: row.base_scope_version_id,
    adjustmentEventId: row.adjustment_event_id,
    adjustmentOperationId: row.adjustment_operation_id,
    reversalOperationId: row.compensation_reversal_operation_id,
    reversalIdempotencyKey: row.compensation_reversal_idempotency_key,
    lifecycleExpectedVersion: safeInteger(
      row.compensation_lifecycle_expected_version,
      'CHANGE_ORDER_RECOVERY_COMPENSATION_VERSION_INVALID'
    ),
    amountCents: safeInteger(
      row.compensation_amount_cents,
      'CHANGE_ORDER_RECOVERY_COMPENSATION_AMOUNT_INVALID'
    ),
    currency: row.compensation_currency,
    requestedBy: row.compensation_requested_by,
    createdAt: isoTimestamp(
      row.compensation_created_at,
      'CHANGE_ORDER_RECOVERY_COMPENSATION_TIMESTAMP_INVALID'
    ),
    semanticLimitation: 'PRIOR_SECURED_STATE_NOT_RESTORED',
  };
}

function mapClaim(row: ChangeOrderRecoveryClaimRow): UniversalV1ChangeOrderRecoveryClaim {
  if (!RECOVERY_STATES.has(row.recovery_state)) {
    throw new Error('CHANGE_ORDER_RECOVERY_STATE_INVALID');
  }
  const adjustmentOutcomeFactId = row.recovery_state === 'ADJUST_TERMINAL_NO_EFFECT'
    ? row.adjustment_outcome_fact_id
    : null;
  const authorityRevocationReason = row.recovery_state === 'ADJUST_NO_EFFECT_AUTHORITY_REVOKED'
    ? row.authority_revocation_reason
    : null;
  if (
    (row.recovery_state === 'ADJUST_TERMINAL_NO_EFFECT' && adjustmentOutcomeFactId === null)
    || (
      row.recovery_state === 'ADJUST_NO_EFFECT_AUTHORITY_REVOKED'
      && authorityRevocationReason === null
    )
  ) {
    throw new Error('CHANGE_ORDER_RECOVERY_NO_EFFECT_EVIDENCE_INCOMPLETE');
  }
  return {
    proposalId: row.proposal_id,
    recoveryLeaseId: row.recovery_lease_id,
    leaseOwnerId: row.lease_owner_id,
    observation: row.recovery_state,
    idempotencyKey: row.idempotency_key,
    witnessRequestSha256: row.request_sha256,
    actorUserId: row.actor_user_id,
    workOrderId: row.work_order_id,
    taskId: row.task_id,
    taskDraftId: row.task_draft_id,
    eligibilityDecisionId: row.eligibility_decision_id,
    baseScopeVersionId: row.base_scope_version_id,
    replacementScopeVersionId: row.replacement_scope_version_id,
    replacementScopeVersion: safeInteger(
      row.replacement_scope_version,
      'CHANGE_ORDER_RECOVERY_SCOPE_VERSION_INVALID'
    ),
    expectedFinancialVersion: safeInteger(
      row.expected_financial_version,
      'CHANGE_ORDER_RECOVERY_FINANCIAL_VERSION_INVALID'
    ),
    predecessorEventId: row.predecessor_event_id,
    predecessorOperationId: row.predecessor_operation_id,
    adjustmentOperationId: row.adjustment_operation_id,
    customerTotalCents: safeInteger(
      row.customer_total_cents,
      'CHANGE_ORDER_RECOVERY_AMOUNT_INVALID'
    ),
    currency: row.currency,
    occurredAt: isoTimestamp(row.occurred_at, 'CHANGE_ORDER_RECOVERY_TIMESTAMP_INVALID'),
    adjustmentEventId: row.adjustment_event_id,
    amendmentId: row.amendment_id,
    compensationEventId: row.compensation_event_id,
    // The SQL classifier may observe an unrelated current-authority drift at
    // the same time as a terminal provider outcome. The recovery mutator
    // requires one causal evidence source, so carry only the source selected
    // by the classified recovery state.
    adjustmentOutcomeFactId,
    authorityRevocationReason,
    compensationCommand: compensationFromClaimRow(row),
  };
}

function commandFromResolutionRow(
  row: CompensationResolutionRow
): UniversalV1ChangeOrderCompensationCommand {
  if (
    row.compensation_command_id === null ||
    row.witness_request_sha256 === null ||
    row.task_draft_id === null ||
    row.task_id === null ||
    row.eligibility_decision_id === null ||
    row.base_scope_version_id === null ||
    row.adjustment_operation_id === null ||
    row.reversal_operation_id === null ||
    row.reversal_idempotency_key === null ||
    row.lifecycle_expected_version === null ||
    row.amount_cents === null ||
    row.currency === null ||
    row.requested_by === null ||
    row.created_at === null ||
    row.semantic_limitation !== 'PRIOR_SECURED_STATE_NOT_RESTORED'
  ) {
    throw new Error('CHANGE_ORDER_RECOVERY_COMPENSATION_RESOLUTION_INVALID');
  }
  return {
    compensationCommandId: row.compensation_command_id,
    proposalId: row.proposal_id,
    witnessRequestSha256: row.witness_request_sha256,
    taskDraftId: row.task_draft_id,
    taskId: row.task_id,
    eligibilityDecisionId: row.eligibility_decision_id,
    baseScopeVersionId: row.base_scope_version_id,
    adjustmentEventId: row.adjustment_event_id,
    adjustmentOperationId: row.adjustment_operation_id,
    reversalOperationId: row.reversal_operation_id,
    reversalIdempotencyKey: row.reversal_idempotency_key,
    lifecycleExpectedVersion: safeInteger(
      row.lifecycle_expected_version,
      'CHANGE_ORDER_RECOVERY_COMPENSATION_VERSION_INVALID'
    ),
    amountCents: safeInteger(
      row.amount_cents,
      'CHANGE_ORDER_RECOVERY_COMPENSATION_AMOUNT_INVALID'
    ),
    currency: row.currency,
    requestedBy: row.requested_by,
    createdAt: isoTimestamp(
      row.created_at,
      'CHANGE_ORDER_RECOVERY_COMPENSATION_TIMESTAMP_INVALID'
    ),
    semanticLimitation: 'PRIOR_SECURED_STATE_NOT_RESTORED',
  };
}

/** PostgreSQL adapter; every mutating function revalidates the active lease. */
export class PostgresUniversalV1ChangeOrderRecoveryRepository
  implements UniversalV1ChangeOrderRecoveryRepository
{
  constructor(private readonly database: Database = db) {}

  async claimDue(
    input: ClaimUniversalV1ChangeOrderRecoveryInput
  ): Promise<readonly UniversalV1ChangeOrderRecoveryClaim[]> {
    const result = await this.database.query<ChangeOrderRecoveryClaimRow>(
      `WITH claimed AS (
         SELECT proposal_id, recovery_lease_id, lease_owner_id
           FROM public.claim_universal_v1_change_order_recovery_v1($1,$2,$3,$4)
       )
       SELECT command.proposal_id, claimed.recovery_lease_id, claimed.lease_owner_id,
              command.idempotency_key, command.request_sha256,
              command.actor_user_id, command.work_order_id, command.task_id,
              command.task_draft_id, command.eligibility_decision_id,
              command.base_scope_version_id, command.replacement_scope_version_id,
              replacement.version AS replacement_scope_version,
              command.expected_financial_version, command.predecessor_event_id,
              command.predecessor_operation_id, command.adjustment_operation_id,
              command.customer_total_cents, command.currency, command.occurred_at,
              adjustment.id AS adjustment_event_id,
              amendment.id AS amendment_id,
              compensation_event.id AS compensation_event_id,
              adjustment_outcome.outcome_fact_id AS adjustment_outcome_fact_id,
              public.universal_v1_change_order_recovery_revocation_reason_v1(
                command.proposal_id
              ) AS authority_revocation_reason,
              compensation.compensation_command_id,
              compensation.reversal_operation_id AS compensation_reversal_operation_id,
              compensation.reversal_idempotency_key AS compensation_reversal_idempotency_key,
              compensation.lifecycle_expected_version AS compensation_lifecycle_expected_version,
              compensation.amount_cents AS compensation_amount_cents,
              compensation.currency AS compensation_currency,
              compensation.requested_by AS compensation_requested_by,
              compensation.created_at AS compensation_created_at,
              compensation.semantic_limitation AS compensation_semantic_limitation,
              CASE
                WHEN amendment.id IS NOT NULL THEN 'AMENDMENT_MATERIALIZED'
                WHEN compensation_event.id IS NOT NULL AND compensation_bridge.bridge_id IS NOT NULL
                  THEN 'COMPENSATION_SUCCEEDED'
                WHEN compensation.compensation_command_id IS NOT NULL THEN
                  CASE
                    WHEN compensation_journal.command_id IS NULL
                      OR compensation_attempt.dispatch_attempt_id IS NULL
                      THEN 'COMPENSATION_READY'
                    WHEN compensation_outcome.outcome_kind = 'OUTCOME_OBSERVED'
                      AND compensation_outcome.effect_certainty = 'CONFIRMED_EFFECT'
                      AND compensation_outcome.provider_state = 'REVERSED'
                      AND compensation_outcome.retryable = FALSE
                      THEN 'COMPENSATION_REPLAYABLE'
                    WHEN (
                      compensation_outcome.outcome_kind = 'FAILED'
                      AND compensation_outcome.effect_certainty = 'CONFIRMED_NO_EFFECT'
                      AND compensation_outcome.retryable = FALSE
                    ) OR (
                      compensation_outcome.outcome_kind = 'OUTCOME_OBSERVED'
                      AND compensation_outcome.effect_certainty = 'CONFIRMED_NO_EFFECT'
                      AND compensation_outcome.retryable = FALSE
                    ) THEN 'COMPENSATION_TERMINAL_NO_EFFECT'
                    WHEN compensation_attempt.dispatch_attempt_id IS NOT NULL
                      THEN 'COMPENSATION_RECONCILE_ONLY'
                    ELSE 'WAITING'
                  END
                WHEN adjustment.id IS NOT NULL
                  AND adjustment.status = 'SUCCEEDED'
                  AND adjustment_bridge.bridge_id IS NOT NULL
                  THEN 'ADJUSTMENT_SUCCEEDED'
                WHEN adjustment.id IS NOT NULL
                  AND adjustment.status IN ('DECLINED','FAILED')
                  AND adjustment_bridge.bridge_id IS NOT NULL
                  THEN 'ADJUST_TERMINAL_NO_EFFECT'
                WHEN adjustment_attempt.dispatch_attempt_id IS NULL
                  AND public.universal_v1_change_order_recovery_revocation_reason_v1(
                    command.proposal_id
                  ) IN (
                    'AMENDMENT_CHAIN_CHANGED',
                    'FINANCIAL_CHAIN_CHANGED',
                    'WORK_ORDER_TERMINALIZED'
                  )
                  THEN 'WAITING'
                WHEN adjustment_attempt.dispatch_attempt_id IS NULL
                  AND public.universal_v1_change_order_recovery_revocation_reason_v1(
                    command.proposal_id
                  ) IS NOT NULL
                  THEN 'ADJUST_NO_EFFECT_AUTHORITY_REVOKED'
                WHEN adjustment_journal.command_id IS NULL
                  OR adjustment_attempt.dispatch_attempt_id IS NULL
                  THEN 'ADJUST_READY'
                WHEN adjustment_outcome.outcome_kind = 'OUTCOME_OBSERVED'
                  AND adjustment_outcome.effect_certainty = 'CONFIRMED_EFFECT'
                  AND adjustment_outcome.provider_state = 'SUCCEEDED'
                  AND adjustment_outcome.retryable = FALSE
                  THEN 'ADJUST_REPLAYABLE'
                WHEN (
                  adjustment_outcome.outcome_kind = 'FAILED'
                  AND adjustment_outcome.effect_certainty = 'CONFIRMED_NO_EFFECT'
                  AND adjustment_outcome.retryable = FALSE
                ) OR (
                  adjustment_outcome.outcome_kind = 'OUTCOME_OBSERVED'
                  AND adjustment_outcome.effect_certainty = 'CONFIRMED_NO_EFFECT'
                  AND adjustment_outcome.retryable = FALSE
                ) THEN 'ADJUST_TERMINAL_NO_EFFECT'
                WHEN adjustment_attempt.dispatch_attempt_id IS NOT NULL
                  THEN 'ADJUST_RECONCILE_ONLY'
                ELSE 'WAITING'
              END AS recovery_state
         FROM claimed
         JOIN public.universal_v1_change_order_materialization_commands command
           ON command.proposal_id = claimed.proposal_id
         JOIN public.task_scope_versions replacement
           ON replacement.id = command.replacement_scope_version_id
         LEFT JOIN public.task_work_order_amendments amendment
           ON amendment.change_order_id = command.proposal_id
         LEFT JOIN public.task_financial_security_events adjustment
           ON adjustment.operation_id = command.adjustment_operation_id::text
          AND adjustment.idempotency_key = command.idempotency_key || ':adjust'
          AND adjustment.expected_version = command.expected_financial_version + 1
         LEFT JOIN public.universal_v1_fake_financial_lifecycle_bridges adjustment_bridge
           ON adjustment_bridge.task_financial_security_event_id = adjustment.id
          AND adjustment_bridge.fake_operation_kind = 'ADJUST'
         LEFT JOIN public.universal_v1_prepared_financial_commands adjustment_prepared
           ON adjustment_prepared.operation_kind = 'ADJUST'
          AND adjustment_prepared.operation_id = command.adjustment_operation_id
          AND adjustment_prepared.provider_kind = 'FAKE'
          AND adjustment_prepared.provider_expected_version = 0
          AND adjustment_prepared.idempotency_key = command.idempotency_key || ':adjust'
         LEFT JOIN public.financial_provider_command_journal adjustment_journal
           ON adjustment_journal.prepared_financial_command_id = adjustment_prepared.prepared_command_id
          AND adjustment_journal.operation_id = command.adjustment_operation_id
          AND adjustment_journal.idempotency_key = command.idempotency_key || ':adjust'
         LEFT JOIN LATERAL (
           SELECT attempt.dispatch_attempt_id
             FROM public.financial_provider_command_dispatch_attempts attempt
            WHERE attempt.command_id = adjustment_journal.command_id
            ORDER BY attempt.attempt_number DESC
            LIMIT 1
         ) adjustment_attempt ON TRUE
         LEFT JOIN LATERAL (
           SELECT outcome.outcome_fact_id, outcome.outcome_kind, outcome.effect_certainty,
                  outcome.provider_state, outcome.retryable
             FROM public.financial_provider_command_outcome_facts outcome
            WHERE outcome.command_id = adjustment_journal.command_id
            ORDER BY outcome.recorded_at DESC, outcome.outcome_fact_id DESC
            LIMIT 1
         ) adjustment_outcome ON TRUE
         LEFT JOIN public.universal_v1_change_order_compensation_commands compensation
           ON compensation.proposal_id = command.proposal_id
         LEFT JOIN public.task_financial_security_events compensation_event
           ON compensation_event.operation_id = compensation.reversal_operation_id::text
          AND compensation_event.idempotency_key = compensation.reversal_idempotency_key
          AND compensation_event.expected_version = compensation.lifecycle_expected_version
          AND compensation_event.event_kind = 'REVERSED'
          AND compensation_event.status = 'SUCCEEDED'
          AND compensation_event.provider_kind = 'FAKE'
         LEFT JOIN public.universal_v1_fake_financial_lifecycle_bridges compensation_bridge
           ON compensation_bridge.task_financial_security_event_id = compensation_event.id
          AND compensation_bridge.fake_operation_kind = 'REVERSAL'
         LEFT JOIN public.universal_v1_prepared_financial_commands compensation_prepared
           ON compensation_prepared.operation_kind = 'REVERSAL'
          AND compensation_prepared.operation_id = compensation.reversal_operation_id
          AND compensation_prepared.provider_kind = 'FAKE'
          AND compensation_prepared.provider_expected_version = 0
          AND compensation_prepared.idempotency_key = compensation.reversal_idempotency_key
         LEFT JOIN public.financial_provider_command_journal compensation_journal
           ON compensation_journal.prepared_financial_command_id = compensation_prepared.prepared_command_id
          AND compensation_journal.operation_id = compensation.reversal_operation_id
          AND compensation_journal.idempotency_key = compensation.reversal_idempotency_key
         LEFT JOIN LATERAL (
           SELECT attempt.dispatch_attempt_id
             FROM public.financial_provider_command_dispatch_attempts attempt
            WHERE attempt.command_id = compensation_journal.command_id
            ORDER BY attempt.attempt_number DESC
            LIMIT 1
         ) compensation_attempt ON TRUE
         LEFT JOIN LATERAL (
           SELECT outcome.outcome_kind, outcome.effect_certainty,
                  outcome.provider_state, outcome.retryable
             FROM public.financial_provider_command_outcome_facts outcome
            WHERE outcome.command_id = compensation_journal.command_id
            ORDER BY outcome.recorded_at DESC, outcome.outcome_fact_id DESC
            LIMIT 1
         ) compensation_outcome ON TRUE
        ORDER BY command.prepared_at, command.proposal_id`,
      [
        input.leaseOwnerId,
        input.limit,
        input.leaseDurationSeconds,
        input.minimumAgeSeconds,
      ]
    );
    return result.rows.map(mapClaim);
  }

  async recordMaterialized(
    claim: UniversalV1ChangeOrderRecoveryClaim,
    amendmentId: string,
    adjustmentEventId: string
  ): Promise<void> {
    const result = await this.database.query<{ terminal_fact_id: string }>(
      `SELECT terminal_fact_id
         FROM public.record_universal_v1_change_order_materialized_recovery_v1(
           $1,$2,$3,$4,$5
         )`,
      [
        claim.proposalId,
        claim.recoveryLeaseId,
        claim.leaseOwnerId,
        amendmentId,
        adjustmentEventId,
      ]
    );
    if (!result.rows[0]?.terminal_fact_id) {
      throw new Error('CHANGE_ORDER_RECOVERY_MATERIALIZED_FACT_MISSING');
    }
  }

  async claimCompensation(
    claim: UniversalV1ChangeOrderRecoveryClaim,
    adjustmentEventId: string
  ): Promise<UniversalV1ChangeOrderCompensationResolution> {
    const result = await this.database.query<CompensationResolutionRow>(
      `SELECT *
         FROM public.claim_universal_v1_change_order_compensation_v1(
           $1,$2,$3,$4
         )`,
      [claim.proposalId, claim.recoveryLeaseId, claim.leaseOwnerId, adjustmentEventId]
    );
    const row = result.rows[0];
    if (!row || row.proposal_id !== claim.proposalId) {
      throw new Error('CHANGE_ORDER_RECOVERY_COMPENSATION_RESOLUTION_MISSING');
    }
    if (row.resolution_kind === 'AMENDMENT_MATERIALIZED') {
      if (row.amendment_id === null) {
        throw new Error('CHANGE_ORDER_RECOVERY_MATERIALIZED_RESOLUTION_INVALID');
      }
      return {
        kind: 'AMENDMENT_MATERIALIZED',
        amendmentId: row.amendment_id,
        adjustmentEventId: row.adjustment_event_id,
      };
    }
    return { kind: 'COMPENSATE', command: commandFromResolutionRow(row) };
  }

  async recordCompensated(
    claim: UniversalV1ChangeOrderRecoveryClaim,
    command: UniversalV1ChangeOrderCompensationCommand,
    compensationEventId: string
  ): Promise<void> {
    const result = await this.database.query<{ terminal_fact_id: string }>(
      `SELECT terminal_fact_id
         FROM public.record_universal_v1_change_order_compensated_recovery_v1(
           $1,$2,$3,$4,$5
         )`,
      [
        claim.proposalId,
        claim.recoveryLeaseId,
        claim.leaseOwnerId,
        command.compensationCommandId,
        compensationEventId,
      ]
    );
    if (!result.rows[0]?.terminal_fact_id) {
      throw new Error('CHANGE_ORDER_RECOVERY_COMPENSATED_FACT_MISSING');
    }
  }

  async recordNoEffect(claim: UniversalV1ChangeOrderRecoveryClaim): Promise<void> {
    const result = await this.database.query<{ terminal_fact_id: string }>(
      `SELECT terminal_fact_id
         FROM public.record_universal_v1_change_order_no_effect_recovery_v1(
           $1,$2,$3,$4,$5
         )`,
      [
        claim.proposalId,
        claim.recoveryLeaseId,
        claim.leaseOwnerId,
        claim.adjustmentOutcomeFactId,
        claim.authorityRevocationReason,
      ]
    );
    if (!result.rows[0]?.terminal_fact_id) {
      throw new Error('CHANGE_ORDER_RECOVERY_NO_EFFECT_FACT_MISSING');
    }
  }
}

type RecoveryFinance = Pick<UniversalV1FakeFinancialApplicationService, 'executeFinancialEvent'>;
type RecoveryFinalizer = Pick<
  PostgresUniversalV1ChangeOrderRepository,
  'finalizePriceAndScopeMaterialization'
>;

export type UniversalV1ChangeOrderRecoveryResult =
  | {
      readonly status: 'MATERIALIZED';
      readonly terminal: true;
      readonly holdsMayClear: true;
      readonly allowedNextCommands: 'ORDINARY_AMENDMENT_FLOW';
      readonly amendmentId: string;
    }
  | {
      readonly status: 'CANCELLED_RECOVERY_REQUIRED';
      readonly terminal: true;
      readonly holdsMayClear: true;
      readonly allowedNextCommands: 'BOUNDED_CANCELLATION_RECOVERY_ONLY';
      readonly terminalEvidence: 'REVERSAL';
      readonly compensationEventId: string;
    }
  | {
      readonly status: 'CANCELLED_RECOVERY_REQUIRED';
      readonly terminal: true;
      readonly holdsMayClear: true;
      readonly allowedNextCommands: 'BOUNDED_CANCELLATION_RECOVERY_ONLY';
      readonly terminalEvidence: 'NO_EFFECT';
      readonly compensationEventId: null;
    }
  | {
      readonly status:
        | 'RECONCILE_ONLY'
        | 'COMPENSATION_TERMINAL_NO_EFFECT_RECOVERY_REQUIRED'
        | 'RETRY_LATER';
      readonly terminal: false;
      readonly holdsMayClear: false;
      readonly allowedNextCommands: 'NONE';
    };

function phaseFromClaim(
  claim: UniversalV1ChangeOrderRecoveryClaim
): Extract<PriceAndScopeChangeOrderMaterializationPhase, { completed: false }> {
  return {
    completed: false,
    idempotencyKey: claim.idempotencyKey,
    requestSha256: claim.witnessRequestSha256,
    context: {
      proposalId: claim.proposalId,
      workOrderId: claim.workOrderId,
      taskId: claim.taskId,
      taskDraftId: claim.taskDraftId,
      eligibilityDecisionId: claim.eligibilityDecisionId,
      scopeVersionId: claim.replacementScopeVersionId,
      scopeVersion: claim.replacementScopeVersion,
      customerTotalCents: claim.customerTotalCents,
      currency: claim.currency,
      predecessorEventId: claim.predecessorEventId,
      predecessorOperationId: claim.predecessorOperationId,
      expectedFinancialVersion: claim.expectedFinancialVersion,
      adjustmentOperationId: claim.adjustmentOperationId,
      occurredAt: claim.occurredAt,
    },
  };
}

function assertAdjustmentResult(
  claim: UniversalV1ChangeOrderRecoveryClaim,
  event: RecordedUniversalV1FinancialEvent
): void {
  if (
    event.operationId !== claim.adjustmentOperationId ||
    event.eventKind !== 'ADJUSTMENT_AUTHORIZED' ||
    event.status !== 'SUCCEEDED' ||
    event.providerKind !== 'FAKE' ||
    event.lifecycleExpectedVersion !== claim.expectedFinancialVersion + 1 ||
    event.taskDraftId !== claim.taskDraftId ||
    event.taskId !== claim.taskId ||
    event.eligibilityDecisionId !== claim.eligibilityDecisionId ||
    event.scopeVersionId !== claim.replacementScopeVersionId ||
    event.changeOrderId !== claim.proposalId ||
    event.predecessorEventId !== claim.predecessorEventId ||
    event.amountCents !== claim.customerTotalCents ||
    event.currency !== claim.currency ||
    event.recordedBy !== claim.actorUserId
  ) {
    throw new Error('CHANGE_ORDER_RECOVERY_ADJUSTMENT_IDENTITY_MISMATCH');
  }
}

function assertCompensationResult(
  command: UniversalV1ChangeOrderCompensationCommand,
  event: RecordedUniversalV1FinancialEvent
): void {
  if (
    event.operationId !== command.reversalOperationId ||
    event.eventKind !== 'REVERSED' ||
    event.status !== 'SUCCEEDED' ||
    event.providerKind !== 'FAKE' ||
    event.lifecycleExpectedVersion !== command.lifecycleExpectedVersion ||
    event.taskDraftId !== command.taskDraftId ||
    event.taskId !== command.taskId ||
    event.eligibilityDecisionId !== command.eligibilityDecisionId ||
    event.scopeVersionId !== command.baseScopeVersionId ||
    event.changeOrderId !== null ||
    event.predecessorEventId !== command.adjustmentEventId ||
    event.amountCents !== command.amountCents ||
    event.currency !== command.currency ||
    event.recordedBy !== command.requestedBy
  ) {
    throw new Error('CHANGE_ORDER_RECOVERY_COMPENSATION_IDENTITY_MISMATCH');
  }
}

function isPermanentAuthorityRevocation(error: unknown): boolean {
  return (
    error instanceof UniversalV1ChangeOrderError &&
    error.code === 'CHANGE_ORDER_AUTHORITY_REVOKED'
  );
}

/**
 * Executes only claims whose database observation proves dispatch is new or an
 * exact terminal effect can be replayed. UNKNOWN claims are observation-only.
 */
export class UniversalV1ChangeOrderRecoveryService {
  constructor(
    private readonly repository: UniversalV1ChangeOrderRecoveryRepository =
      new PostgresUniversalV1ChangeOrderRecoveryRepository(),
    private readonly finalizer: RecoveryFinalizer =
      new PostgresUniversalV1ChangeOrderRepository()
  ) {}

  async recover(
    claim: UniversalV1ChangeOrderRecoveryClaim,
    finance: RecoveryFinance
  ): Promise<UniversalV1ChangeOrderRecoveryResult> {
    switch (claim.observation) {
      case 'AMENDMENT_MATERIALIZED':
        return this.recordMaterializedClaim(claim);
      case 'COMPENSATION_SUCCEEDED':
        return this.recordCompensatedClaim(claim);
      case 'ADJUSTMENT_SUCCEEDED':
        if (claim.adjustmentEventId === null) {
          throw new Error('CHANGE_ORDER_RECOVERY_ADJUSTMENT_EVENT_MISSING');
        }
        return this.finalizeOrCompensate(claim, claim.adjustmentEventId, finance);
      case 'ADJUST_READY':
      case 'ADJUST_REPLAYABLE':
        return this.executeAdjustment(claim, finance);
      case 'COMPENSATION_READY':
      case 'COMPENSATION_REPLAYABLE':
        if (claim.compensationCommand === null) {
          throw new Error('CHANGE_ORDER_RECOVERY_COMPENSATION_COMMAND_MISSING');
        }
        return this.executeCompensation(claim, claim.compensationCommand, finance);
      case 'ADJUST_RECONCILE_ONLY':
      case 'COMPENSATION_RECONCILE_ONLY':
        return {
          status: 'RECONCILE_ONLY',
          terminal: false,
          holdsMayClear: false,
          allowedNextCommands: 'NONE',
        };
      case 'ADJUST_TERMINAL_NO_EFFECT':
      case 'ADJUST_NO_EFFECT_AUTHORITY_REVOKED':
        await this.repository.recordNoEffect(claim);
        return {
          status: 'CANCELLED_RECOVERY_REQUIRED',
          terminal: true,
          holdsMayClear: true,
          allowedNextCommands: 'BOUNDED_CANCELLATION_RECOVERY_ONLY',
          terminalEvidence: 'NO_EFFECT',
          compensationEventId: null,
        };
      case 'COMPENSATION_TERMINAL_NO_EFFECT':
        return {
          status: 'COMPENSATION_TERMINAL_NO_EFFECT_RECOVERY_REQUIRED',
          terminal: false,
          holdsMayClear: false,
          allowedNextCommands: 'NONE',
        };
      case 'WAITING':
        return {
          status: 'RETRY_LATER',
          terminal: false,
          holdsMayClear: false,
          allowedNextCommands: 'NONE',
        };
    }
  }

  private async executeAdjustment(
    claim: UniversalV1ChangeOrderRecoveryClaim,
    finance: RecoveryFinance
  ): Promise<UniversalV1ChangeOrderRecoveryResult> {
    const adjustment = await finance.executeFinancialEvent({
      providerKind: 'FAKE',
      operationKind: 'ADJUST',
      operationId: claim.adjustmentOperationId,
      idempotencyKey: `${claim.idempotencyKey}:adjust`,
      providerExpectedVersion: 0,
      lifecycleExpectedVersion: claim.expectedFinancialVersion + 1,
      taskDraftId: claim.taskDraftId,
      taskId: claim.taskId,
      eligibilityDecisionId: claim.eligibilityDecisionId,
      scopeVersionId: claim.replacementScopeVersionId,
      predecessorEventId: claim.predecessorEventId,
      relatedOperationId: claim.predecessorOperationId,
      changeOrderId: claim.proposalId,
      amountCents: claim.customerTotalCents,
      currency: claim.currency.toLowerCase(),
      recordedBy: claim.actorUserId,
      occurredAt: claim.occurredAt,
      scenario: 'SUCCESS',
    });
    if (adjustment.status !== 'SUCCEEDED') {
      return {
        // The next leased observation records exact NO_EFFECT evidence if this
        // became terminal; this invocation has no outcome-fact identifier.
        status: 'RETRY_LATER',
        terminal: false,
        holdsMayClear: false,
        allowedNextCommands: 'NONE',
      };
    }
    assertAdjustmentResult(claim, adjustment);
    return this.finalizeOrCompensate(claim, adjustment.id, finance);
  }

  private async finalizeOrCompensate(
    claim: UniversalV1ChangeOrderRecoveryClaim,
    adjustmentEventId: string,
    finance: RecoveryFinance
  ): Promise<UniversalV1ChangeOrderRecoveryResult> {
    let result: MaterializedUniversalV1ChangeOrder;
    try {
      result = await this.finalizer.finalizePriceAndScopeMaterialization(
        phaseFromClaim(claim),
        adjustmentEventId,
        claim.actorUserId
      );
    } catch (error) {
      if (!isPermanentAuthorityRevocation(error)) throw error;
      const resolution = await this.repository.claimCompensation(claim, adjustmentEventId);
      if (resolution.kind === 'AMENDMENT_MATERIALIZED') {
        await this.repository.recordMaterialized(
          claim,
          resolution.amendmentId,
          resolution.adjustmentEventId
        );
        return {
          status: 'MATERIALIZED',
          terminal: true,
          holdsMayClear: true,
          allowedNextCommands: 'ORDINARY_AMENDMENT_FLOW',
          amendmentId: resolution.amendmentId,
        };
      }
      return this.executeCompensation(claim, resolution.command, finance);
    }
    if (
      result.proposal_id !== claim.proposalId ||
      result.adjustment_event_id !== adjustmentEventId ||
      result.scope_version_id !== claim.replacementScopeVersionId ||
      result.scope_version !== claim.replacementScopeVersion ||
      result.provider_kind !== 'FAKE' ||
      result.payment_creation_performed !== false ||
      result.hard_assignment_created !== false
    ) {
      throw new Error('CHANGE_ORDER_RECOVERY_MATERIALIZATION_IDENTITY_MISMATCH');
    }
    await this.repository.recordMaterialized(claim, result.amendment_id, adjustmentEventId);
    return {
      status: 'MATERIALIZED',
      terminal: true,
      holdsMayClear: true,
      allowedNextCommands: 'ORDINARY_AMENDMENT_FLOW',
      amendmentId: result.amendment_id,
    };
  }

  private async executeCompensation(
    claim: UniversalV1ChangeOrderRecoveryClaim,
    command: UniversalV1ChangeOrderCompensationCommand,
    finance: RecoveryFinance
  ): Promise<UniversalV1ChangeOrderRecoveryResult> {
    const compensation = await finance.executeFinancialEvent({
      providerKind: 'FAKE',
      operationKind: 'REVERSAL',
      operationId: command.reversalOperationId,
      idempotencyKey: command.reversalIdempotencyKey,
      providerExpectedVersion: 0,
      lifecycleExpectedVersion: command.lifecycleExpectedVersion,
      taskDraftId: command.taskDraftId,
      taskId: command.taskId,
      eligibilityDecisionId: command.eligibilityDecisionId,
      scopeVersionId: command.baseScopeVersionId,
      predecessorEventId: command.adjustmentEventId,
      relatedOperationId: command.adjustmentOperationId,
      amountCents: command.amountCents,
      currency: command.currency.toLowerCase(),
      recordedBy: command.requestedBy,
      occurredAt: command.createdAt,
      scenario: 'SUCCESS',
    });
    if (compensation.status !== 'SUCCEEDED') {
      return {
        status:
          compensation.status === 'DECLINED' || compensation.status === 'FAILED'
            ? 'COMPENSATION_TERMINAL_NO_EFFECT_RECOVERY_REQUIRED'
            : 'RETRY_LATER',
        terminal: false,
        holdsMayClear: false,
        allowedNextCommands: 'NONE',
      };
    }
    assertCompensationResult(command, compensation);
    await this.repository.recordCompensated(claim, command, compensation.id);
    return {
      status: 'CANCELLED_RECOVERY_REQUIRED',
      terminal: true,
      holdsMayClear: true,
      allowedNextCommands: 'BOUNDED_CANCELLATION_RECOVERY_ONLY',
      terminalEvidence: 'REVERSAL',
      compensationEventId: compensation.id,
    };
  }

  private async recordMaterializedClaim(
    claim: UniversalV1ChangeOrderRecoveryClaim
  ): Promise<UniversalV1ChangeOrderRecoveryResult> {
    if (claim.amendmentId === null || claim.adjustmentEventId === null) {
      throw new Error('CHANGE_ORDER_RECOVERY_MATERIALIZED_IDENTITY_INCOMPLETE');
    }
    await this.repository.recordMaterialized(
      claim,
      claim.amendmentId,
      claim.adjustmentEventId
    );
    return {
      status: 'MATERIALIZED',
      terminal: true,
      holdsMayClear: true,
      allowedNextCommands: 'ORDINARY_AMENDMENT_FLOW',
      amendmentId: claim.amendmentId,
    };
  }

  private async recordCompensatedClaim(
    claim: UniversalV1ChangeOrderRecoveryClaim
  ): Promise<UniversalV1ChangeOrderRecoveryResult> {
    if (claim.compensationCommand === null || claim.compensationEventId === null) {
      throw new Error('CHANGE_ORDER_RECOVERY_COMPENSATED_IDENTITY_INCOMPLETE');
    }
    await this.repository.recordCompensated(
      claim,
      claim.compensationCommand,
      claim.compensationEventId
    );
    return {
      status: 'CANCELLED_RECOVERY_REQUIRED',
      terminal: true,
      holdsMayClear: true,
      allowedNextCommands: 'BOUNDED_CANCELLATION_RECOVERY_ONLY',
      terminalEvidence: 'REVERSAL',
      compensationEventId: claim.compensationEventId,
    };
  }
}

// Shared projection mapper; the restricted observation adapter validates the full receipt first.
export { mapClaim as mapChangeOrderRecoveryObservation };
