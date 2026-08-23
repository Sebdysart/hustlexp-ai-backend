import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PAYMENT_EXCEPTION_RECOVERY_AUTHORITY_V7,
  paymentExceptionRecoveryBlockersV7,
  type PaymentExceptionRecoveryInputV7,
} from '../../src/contracts/PaymentUnderwritingExceptionRecoveryV7.js';

const root = process.cwd();
const source = (path: string): string => {
  const absolute = resolve(root, path);
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : '';
};

const migrationPath =
  'backend/database/migrations/20260826_payment_underwriting_exception_recovery_v7.sql';
const contractPath = 'backend/src/contracts/PaymentUnderwritingExceptionRecoveryV7.ts';
const pgContractPath =
  'backend/tests/integration/payment-underwriting-exception-recovery-v7.pg.sql';
const manifestPath = 'docs/underwriting/payment-underwriting-d8-exception-recovery-v7.json';

describe('payment underwriting exception and recovery containment v7', () => {
  it('pins D8 to exact D7 and the locked revision-7 authority', () => {
    const contract = source(contractPath);
    expect(contract).toContain('1PYpWdbnlhRBoovc6GfTyxMuu1IzMIdDQpV6hHHraXaQ');
    expect(contract).toContain("driveRevision: '7'");
    expect(contract).toContain(
      'AIroW37g_sqKNU_dvvRNUndw-qUeooFwAYIHqN60aHvPSR178sKjMMu5rMzGTzODqgDKERue3ZbAT8UesInsUZvT6p1Z0bUvPByrgwaPDA'
    );
    expect(contract).toContain('ba8dc04bfc43feb24bd78698c6e5b820ecdf22177f915fb04856a55d8076bd26');
    expect(contract).toContain('44db114aa548189413ec62cee380d2a9fb86c6ab');
    expect(contract).toContain('c7a2abb06038b332cdc08cba1fbc402841800170');
  });

  it('derives every unresolved exception blocker and never trusts a caller disposition', () => {
    expect(PAYMENT_EXCEPTION_RECOVERY_AUTHORITY_V7.operationallyEnabled).toBe(false);
    expect(PAYMENT_EXCEPTION_RECOVERY_AUTHORITY_V7.refundAutomationEnabled).toBe(false);
    expect(PAYMENT_EXCEPTION_RECOVERY_AUTHORITY_V7.disputeAutomationEnabled).toBe(false);
    expect(PAYMENT_EXCEPTION_RECOVERY_AUTHORITY_V7.replacementAutomationEnabled).toBe(false);
    expect(PAYMENT_EXCEPTION_RECOVERY_AUTHORITY_V7.recurringPaymentsEnabled).toBe(false);
    const ready: PaymentExceptionRecoveryInputV7 = {
      refundPolicyApproved: true,
      disputePolicyApproved: true,
      replacementPolicyApproved: true,
      recurringPolicyApproved: true,
      openExceptionCaseCount: 0,
      unreconciledExceptionCaseCount: 0,
      conflictingRefundDisputeCount: 0,
      unresolvedLossAllocationCount: 0,
      replacementPriorSecurityReversed: true,
      replacementCustomerAuthorizationPresent: true,
      recurringOccurrenceIndependent: true,
      longTermPrepaymentRequested: false,
    };
    expect(paymentExceptionRecoveryBlockersV7(ready)).toEqual([]);
    expect(
      paymentExceptionRecoveryBlockersV7({
        refundPolicyApproved: false,
        disputePolicyApproved: false,
        replacementPolicyApproved: false,
        recurringPolicyApproved: false,
        openExceptionCaseCount: 1,
        unreconciledExceptionCaseCount: 1,
        conflictingRefundDisputeCount: 1,
        unresolvedLossAllocationCount: 1,
        replacementPriorSecurityReversed: false,
        replacementCustomerAuthorizationPresent: false,
        recurringOccurrenceIndependent: false,
        longTermPrepaymentRequested: true,
      })
    ).toEqual([
      'refund_policy_unapproved',
      'dispute_policy_unapproved',
      'replacement_policy_unapproved',
      'recurring_policy_unapproved',
      'open_exception_cases',
      'unreconciled_exception_cases',
      'conflicting_refund_dispute',
      'loss_allocation_unresolved',
      'prior_provider_security_not_reversed',
      'replacement_customer_authorization_missing',
      'recurring_occurrence_not_independent',
      'long_term_prepayment_prohibited',
    ]);
  });

  it('requires append-only policy, exception, recovery, and recurring-occurrence evidence', () => {
    const migration = source(migrationPath);
    for (const table of [
      'payment_processor_policy_decisions_v7',
      'payment_post_funding_exception_cases_v7',
      'payment_post_funding_exception_events_v7',
      'payment_exception_reconciliations_v7',
      'payment_recurring_occurrences_v7',
    ]) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    for (const functionName of [
      'hxos_payment_exception_case_sha256_v7',
      'hxos_payment_exception_event_sha256_v7',
      'hxos_payment_exception_reconciliation_sha256_v7',
      'hxos_payment_recurring_occurrence_sha256_v7',
      'hxos_enforce_payment_exception_event_v7',
      'hxos_enforce_payment_exception_reconciliation_v7',
      'hxos_enforce_payment_recurring_occurrence_v7',
      'hxos_enforce_payment_closure_attestation_v7',
    ]) {
      expect(migration).toContain(functionName);
    }
    expect(migration).toContain(
      "case_kind IN ('REFUND', 'DISPUTE', 'CHARGEBACK', 'RETURN', 'NEGATIVE_BALANCE', 'RECOVERY', 'PROVIDER_REPLACEMENT', 'AMOUNT_CHANGE')"
    );
    expect(migration).toContain("prepayment_mode = 'PER_OCCURRENCE_ONLY'");
    expect(migration).toContain('open_exception_case_count');
    expect(migration).toContain("OR NEW.case_kind = 'PROVIDER_REPLACEMENT'");
    expect(migration).toContain('v_policy.created_at > NEW.observed_at');
    expect(migration).toContain('v_policy.created_at > NEW.opened_at');
    expect(migration).toContain(
      'v_policy.expires_at IS NOT NULL AND v_policy.expires_at <= NEW.observed_at'
    );
    expect(migration).toContain(
      'v_webhook.event_id_sha256 IS DISTINCT FROM NEW.provider_reference_sha256'
    );
    expect(migration).toContain('v_webhook.payload_sha256 IS DISTINCT FROM NEW.evidence_sha256');
    expect(migration).toContain('NEW.observed_at < v_webhook.received_at');
    expect(migration).toContain('RECOVERY_RECONCILED_AWAITING_RECLOSURE');
    expect(migration).toContain('BEFORE TRUNCATE');
    expect(migration).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(migration).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE|TRUNCATE|EXECUTE)/i);
    expect(migration).not.toMatch(/paymentIntents|refunds\.create|transfers\.create|capture\(/i);
  });

  it('proves open exposure blocks closure, terminal evidence reconciles, and recurrence is per occurrence', () => {
    const pgContract = source(pgContractPath);
    for (const proof of [
      'unapproved_policy_rejected',
      'conflicting_refund_dispute_rejected',
      'open_exception_blocks_closure',
      'unreconciled_resolution_blocks_closure',
      'crossed_exception_reconciliation_rejected',
      'postdated_policy_rejected',
      'unrelated_webhook_rejected',
      'provider_replacement_rejected',
      'stale_closure_not_reused',
      'long_term_prepayment_rejected',
      'duplicate_lifecycle_occurrence_rejected',
    ]) {
      expect(pgContract).toContain(proof);
    }
    expect(pgContract).toContain("effective_financial_state IS DISTINCT FROM 'CLOSED'");
    expect(pgContract).toContain(
      '\\ir ../../database/migrations/20260826_payment_underwriting_exception_recovery_v7.sql'
    );
  });

  it('keeps D8 unregistered, provider-inert, and explicit about unresolved written decisions', () => {
    const registry = source('backend/src/jobs/engine-automation-migration-files.ts');
    expect(registry).not.toContain('20260826_payment_underwriting_exception_recovery_v7');
    const manifestText = source(manifestPath);
    expect(manifestText).not.toBe('');
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      schema: 'HX_PAYMENT_UNDERWRITING_TRACEABILITY_V7',
      slice: 'D8_EXCEPTION_RECOVERY_RECURRING_CONTAINMENT',
      parentCommit: '44db114aa548189413ec62cee380d2a9fb86c6ab',
      acceptedDependencyCommit: '44db114aa548189413ec62cee380d2a9fb86c6ab',
      acceptedDependencyTree: 'c7a2abb06038b332cdc08cba1fbc402841800170',
      migrationSha256: '99606ddee1748b663134215cfa1d1680f2b24abd09cbf02ac03306ad7f5f4ba5',
      startupRegistered: false,
      operationallyEnabled: false,
      runtimeAuthority: 'NONE_SCHEMA_ARTIFACT_ONLY',
    });
    expect(manifest).toMatchObject({
      refundAutomationEnabled: false,
      disputeAutomationEnabled: false,
      replacementAutomationEnabled: false,
      recurringPaymentsEnabled: false,
    });
  });
});
