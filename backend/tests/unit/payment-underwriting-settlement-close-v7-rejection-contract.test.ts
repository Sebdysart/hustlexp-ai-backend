import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PAYMENT_SETTLEMENT_CLOSE_AUTHORITY_V7,
  paymentSettlementCloseBlockersV7,
  type PaymentSettlementCloseInputV7,
} from '../../src/contracts/PaymentUnderwritingSettlementCloseV7.js';

const root = process.cwd();
const source = (path: string): string => {
  const absolute = resolve(root, path);
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : '';
};

const migrationPath =
  'backend/database/migrations/20260825_payment_underwriting_settlement_close_v7.sql';
const contractPath = 'backend/src/contracts/PaymentUnderwritingSettlementCloseV7.ts';
const pgContractPath = 'backend/tests/integration/payment-underwriting-settlement-close-v7.pg.sql';
const manifestPath = 'docs/underwriting/payment-underwriting-d7-settlement-close-v7.json';

describe('payment underwriting settlement, ledger, reconciliation, and close v7', () => {
  it('pins D7 to the accepted D6 identity and locked source authority', () => {
    const contract = source(contractPath);
    expect(contract).toContain('1PYpWdbnlhRBoovc6GfTyxMuu1IzMIdDQpV6hHHraXaQ');
    expect(contract).toContain("driveRevision: '7'");
    expect(contract).toContain(
      'AIroW37g_sqKNU_dvvRNUndw-qUeooFwAYIHqN60aHvPSR178sKjMMu5rMzGTzODqgDKERue3ZbAT8UesInsUZvT6p1Z0bUvPByrgwaPDA'
    );
    expect(contract).toContain('ba8dc04bfc43feb24bd78698c6e5b820ecdf22177f915fb04856a55d8076bd26');
    expect(contract).toContain('7e1fc60f9afa270b4a19f0aee9b1f36bd1e25674');
    expect(contract).toContain('30d1df8705cbdbca5105fe594ce1b4ea53b3de40');
  });

  it('derives every closure blocker without trusting a caller disposition', () => {
    expect(PAYMENT_SETTLEMENT_CLOSE_AUTHORITY_V7.operationallyEnabled).toBe(false);
    const ready: PaymentSettlementCloseInputV7 = {
      lifecycleStage: 'CAPTURED',
      captureAgreementState: 'AGREED',
      economicsPolicyPresent: true,
      customerAmountCents: 10_000,
      providerAmountCents: 8_000,
      platformAmountCents: 2_000,
      settlementState: 'FUNDED',
      ledgerState: 'POSTED',
      ledgerDebitCents: 10_300,
      ledgerCreditCents: 10_300,
      reconciliationRunState: 'COMPLETED',
      reconciliationExceptionCount: 0,
      processorCustomerAmountCents: 10_000,
      ledgerCustomerAmountCents: 10_000,
      openPostFundingExposureCount: 0,
    };
    expect(paymentSettlementCloseBlockersV7(ready)).toEqual([]);
    expect(
      paymentSettlementCloseBlockersV7({
        ...ready,
        lifecycleStage: 'SETTLING',
        captureAgreementState: 'PENDING',
        economicsPolicyPresent: false,
        providerAmountCents: 7_999,
        settlementState: 'SETTLING',
        ledgerState: 'PENDING',
        ledgerDebitCents: 10_300,
        ledgerCreditCents: 10_299,
        reconciliationRunState: 'EXCEPTION',
        reconciliationExceptionCount: 1,
        processorCustomerAmountCents: 9_999,
        openPostFundingExposureCount: 1,
      })
    ).toEqual([
      'lifecycle_not_captured',
      'capture_not_agreed',
      'economics_policy_missing',
      'economics_unbalanced',
      'settlement_not_terminal',
      'ledger_not_posted',
      'ledger_unbalanced',
      'reconciliation_not_completed',
      'reconciliation_exceptions_present',
      'processor_ledger_mismatch',
      'open_post_funding_exposure',
    ]);
  });

  it('fails closure closed for every unresolved processor, ledger, and exposure fact', () => {
    const contract = source(contractPath);
    for (const blocker of [
      'lifecycle_not_captured',
      'capture_not_agreed',
      'economics_policy_missing',
      'economics_unbalanced',
      'settlement_not_terminal',
      'ledger_not_posted',
      'ledger_unbalanced',
      'reconciliation_not_completed',
      'reconciliation_exceptions_present',
      'processor_ledger_mismatch',
      'open_post_funding_exposure',
    ]) {
      expect(contract).toContain(`'${blocker}'`);
    }
    expect(contract).toContain('paymentSettlementCloseBlockersV7');
  });

  it('requires immutable economics, terminal settlement, balanced ledger, and exact reconciliation', () => {
    const migration = source(migrationPath);
    for (const table of [
      'payment_capture_economics_v7',
      'payment_reconciliation_items_v7',
      'payment_closure_attestations_v7',
    ]) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    for (const functionName of [
      'hxos_payment_capture_economics_sha256_v7',
      'hxos_payment_settlement_record_sha256_v7',
      'hxos_payment_ledger_transaction_sha256_v7',
      'hxos_payment_ledger_entry_sha256_v7',
      'hxos_payment_reconciliation_item_sha256_v7',
      'hxos_payment_closure_attestation_sha256_v7',
      'hxos_enforce_payment_capture_economics_v7',
      'hxos_enforce_payment_settlement_record_v7',
      'hxos_enforce_payment_ledger_transaction_v7',
      'hxos_enforce_payment_ledger_entry_v7',
      'hxos_assert_payment_ledger_balanced_v7',
      'hxos_enforce_payment_reconciliation_item_v7',
      'hxos_enforce_payment_closure_transition_v7',
    ]) {
      expect(migration).toContain(functionName);
    }
    expect(migration).toContain('provider_amount_cents + platform_amount_cents');
    expect(migration).toContain("direction = 'DEBIT'");
    expect(migration).toContain("direction = 'CREDIT'");
    expect(migration).toContain("agreement_state IS DISTINCT FROM 'AGREED'");
    expect(migration).toContain("reconciliation_state IS DISTINCT FROM 'MATCHED'");
    expect(migration).toContain("stage = 'RECONCILED'");
    expect(migration).toContain("stage = 'CLOSED'");
    expect(migration).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(migration).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE|TRUNCATE|EXECUTE)/i);
    expect(migration).not.toMatch(/paymentIntents|refunds\.create|transfers\.create|capture\(/i);

    const pgContract = source(pgContractPath);
    for (const proof of [
      'unbalanced_economics_rejected',
      'unauthenticated_settlement_rejected',
      'unbalanced_ledger_rejected',
      'crossed_reconciliation_rejected',
      'reconciliation_exception_blocks_close',
      'premature_closed_rejected',
    ]) {
      expect(pgContract).toContain(proof);
    }
    expect(pgContract).toContain('\\if :{?HXP_D8_COMPOSED}');
    expect(pgContract).toContain(
      "lifecycle_stage IS DISTINCT FROM (CASE WHEN d8_composed THEN 'RECONCILED' ELSE 'CLOSED' END)"
    );
    expect(pgContract).toContain(
      '\\ir ../../database/migrations/20260825_payment_underwriting_settlement_close_v7.sql'
    );
  });

  it('keeps D7 unregistered and defers refund, dispute, and variant automation', () => {
    const registry = source('backend/src/jobs/engine-automation-migration-files.ts');
    expect(registry).not.toContain('20260825_payment_underwriting_settlement_close_v7');

    const manifestText = source(manifestPath);
    expect(manifestText).not.toBe('');
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      schema: 'HX_PAYMENT_UNDERWRITING_TRACEABILITY_V7',
      slice: 'D7_SETTLEMENT_DOUBLE_ENTRY_RECONCILE_CLOSE',
      parentCommit: '7e1fc60f9afa270b4a19f0aee9b1f36bd1e25674',
      acceptedDependencyCommit: '7e1fc60f9afa270b4a19f0aee9b1f36bd1e25674',
      acceptedDependencyTree: '30d1df8705cbdbca5105fe594ce1b4ea53b3de40',
      migrationSha256: '246af87cf69c5e890eb1ce4a2b468bfc127967dd5dab79b51d449a996c129b04',
      startupRegistered: false,
      operationallyEnabled: false,
      runtimeAuthority: 'NONE_SCHEMA_ARTIFACT_ONLY',
    });
    expect(manifest.deferredDependencies).toEqual([
      'D8_REFUND_DISPUTE_REPLACEMENT_RECURRING_VARIANTS',
    ]);
  });
});
