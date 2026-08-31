import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const fileName = '20260929_universal_v1_double_entry_ledger_v1.sql';
const migration = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations', fileName),
  'utf8'
);

describe('Universal V1 double-entry ledger migration', () => {
  it('installs an engine-safe closed ledger without making fake fixtures engine dependencies', () => {
    for (const token of [
      'universal_v1_ledger_accounts_v1',
      'universal_v1_ledger_transactions_v1',
      'universal_v1_ledger_postings_v1',
      'universal_v1_ledger_certifications_v1',
      "to_regclass('public.universal_v1_fake_reconciliation_bridges')",
      "to_regclass('public.universal_v1_fake_terminal_lifecycle_intents')",
      'Fake terminal authority is optional at engine-migration',
      'Production payment creation remains frozen',
    ]) {
      expect(migration).toContain(token);
    }

    expect(migration).not.toMatch(
      /REFERENCES\s+public\.universal_v1_fake_(?:reconciliation_bridges|terminal_lifecycle_intents)/iu
    );
  });

  it('fixes the chart of accounts and every allowed path posting in database authority', () => {
    for (const token of [
      "('PROVIDER_CLEARING_ASSET', 'ASSET', 'DEBIT')",
      "('CASH_CONTROL_ASSET', 'ASSET', 'DEBIT')",
      "('CUSTOMER_HELD_LIABILITY', 'LIABILITY', 'CREDIT')",
      "('PROVIDER_PAYABLE_LIABILITY', 'LIABILITY', 'CREDIT')",
      "('PAYOUT_CLEARING_LIABILITY', 'LIABILITY', 'CREDIT')",
      "('BANK_IN_TRANSIT_LIABILITY', 'LIABILITY', 'CREDIT')",
      "('SUSPENSE_UNALLOCATED', 'SUSPENSE', 'CREDIT')",
      "('CAPTURE', 1, 'DEBIT', 'PROVIDER_CLEARING_ASSET')",
      "('CAPTURE', 2, 'CREDIT', 'CUSTOMER_HELD_LIABILITY')",
      "('SETTLEMENT', 1, 'DEBIT', 'CASH_CONTROL_ASSET')",
      "('SETTLEMENT', 2, 'CREDIT', 'PROVIDER_CLEARING_ASSET')",
      "('FUNDING', 1, 'DEBIT', 'CUSTOMER_HELD_LIABILITY')",
      "('FUNDING', 2, 'CREDIT', 'PROVIDER_PAYABLE_LIABILITY')",
      "('FUNDING', 3, 'CREDIT', 'SUSPENSE_UNALLOCATED')",
      "('PROVIDER_RELEASE', 1, 'DEBIT', 'PROVIDER_PAYABLE_LIABILITY')",
      "('PROVIDER_RELEASE', 2, 'CREDIT', 'PAYOUT_CLEARING_LIABILITY')",
      "('PAYOUT', 1, 'DEBIT', 'PAYOUT_CLEARING_LIABILITY')",
      "('PAYOUT', 2, 'CREDIT', 'BANK_IN_TRANSIT_LIABILITY')",
      "('BANK_SETTLEMENT', 1, 'DEBIT', 'BANK_IN_TRANSIT_LIABILITY')",
      "('BANK_SETTLEMENT', 2, 'CREDIT', 'CASH_CONTROL_ASSET')",
      "('REFUND', 1, 'DEBIT', 'CUSTOMER_HELD_LIABILITY')",
      "('REFUND', 2, 'CREDIT', 'PROVIDER_CLEARING_ASSET')",
    ]) {
      expect(migration).toContain(token);
    }

    expect(migration).toContain('customer_amount_cents - provider_amount_cents');
    expect(migration).toContain('IF residual_amount_cents > 0 THEN');
    expect(migration).not.toContain("'PLATFORM_REVENUE'");
    expect(migration).not.toContain("'FEE_REVENUE'");
  });

  it('derives all amounts and identities from the exact bridge, intent, and lifecycle chain', () => {
    for (const token of [
      'universal_v1_expected_double_entry_postings_v1',
      'bridge.reconciliation_fact_id = $1',
      'bridge.terminal_intent_id = intent.terminal_intent_id',
      'bridge.terminal_lifecycle_event_id',
      'intent.authority_context_sha256',
      'bridge.authority_chain_sha256',
      'reconciliation.capture_event_id',
      'reconciliation.refund_event_id',
      'reconciliation.settlement_event_id',
      'reconciliation.funding_event_id',
      'reconciliation.provider_release_event_id',
      'reconciliation.payout_event_id',
      'reconciliation.bank_settlement_event_id',
      "event.provider_kind <> 'FAKE'",
      "event.status <> 'SUCCEEDED'",
      'event.predecessor_event_id IS DISTINCT FROM predecessor_event_ids[ordinal]',
      'HUSTLEXP_UNIVERSAL_V1_DOUBLE_ENTRY_TRANSACTION_V1',
      'HUSTLEXP_UNIVERSAL_V1_DOUBLE_ENTRY_POSTING_V1',
      'HUSTLEXP_UNIVERSAL_V1_DOUBLE_ENTRY_CERTIFICATION_V1',
    ]) {
      expect(migration).toContain(token);
    }

    expect(migration).not.toMatch(/NEW\.(?:customer|provider)_ledger_amount_cents/iu);
    expect(migration).not.toMatch(/NEW\.(?:fee|revenue|commission)_amount_cents/iu);
  });

  it('requires exact per-transaction balance, currency, shape, and complete path certification', () => {
    for (const token of [
      'amount_cents BETWEEN 1 AND 9007199254740991',
      "currency ~ '^[A-Z]{3}$'",
      'count(*) < 2',
      "FILTER (WHERE posting_side = 'DEBIT')",
      "FILTER (WHERE posting_side = 'CREDIT')",
      'debit_total_cents <> credit_total_cents',
      'EXCEPT ALL',
      "terminal_path = 'SETTLED' AND transaction_count <> 6",
      "terminal_path = 'FULL_REFUND' AND transaction_count <> 2",
      'certified_transaction_count',
      'certified_posting_count',
      'ledger_sha256',
    ]) {
      expect(migration).toContain(token);
    }
  });

  it('makes terminal fake ledger certification commit-atomic and backfills idempotently', () => {
    for (const token of [
      'materialize_universal_v1_double_entry_ledger_v1',
      'certify_universal_v1_double_entry_ledger_v1',
      'validate_universal_v1_ledger_certification_v1',
      'require_universal_v1_double_entry_ledger_v1',
      'zz_universal_v1_double_entry_ledger_required_v1',
      'CREATE CONSTRAINT TRIGGER',
      'AFTER INSERT ON public.task_reconciliation_facts',
      'DEFERRABLE INITIALLY DEFERRED',
      'controlled-test terminal reconciliation cannot remain ledger_state=MATCHED',
      'ON CONFLICT (ledger_transaction_id) DO NOTHING',
      'ON CONFLICT (ledger_transaction_id, posting_ordinal) DO NOTHING',
      'ON CONFLICT (reconciliation_bridge_id) DO NOTHING',
      'backfill existing exact fake reconciliation bridges idempotently',
    ]) {
      expect(migration).toContain(token);
    }
  });

  it('keeps the derived ledger append-only, private, fake-only, and effect-free', () => {
    for (const token of [
      'reject_universal_v1_double_entry_ledger_mutation_v1',
      'BEFORE UPDATE OR DELETE',
      'BEFORE TRUNCATE',
      'REVOKE ALL ON TABLE public.universal_v1_ledger_accounts_v1 FROM PUBLIC',
      'REVOKE ALL ON TABLE public.universal_v1_ledger_transactions_v1 FROM PUBLIC',
      'REVOKE ALL ON TABLE public.universal_v1_ledger_postings_v1 FROM PUBLIC',
      'REVOKE ALL ON TABLE public.universal_v1_ledger_certifications_v1 FROM PUBLIC',
      'creates no provider I/O',
    ]) {
      expect(migration).toContain(token);
    }

    expect(migration).not.toMatch(/INSERT\s+INTO\s+public\.task_financial_security_events/iu);
    expect(migration).not.toMatch(/INSERT\s+INTO\s+public\.financial_provider_/iu);
    expect(migration).not.toMatch(/UPDATE\s+public\.task_reconciliation_facts/iu);
    expect(migration).not.toMatch(/provider_kind\s*=\s*'APPROVED_PROVIDER'/iu);
    expect(migration).not.toMatch(/\bstripe[_a-z]*\b/iu);
  });
});
