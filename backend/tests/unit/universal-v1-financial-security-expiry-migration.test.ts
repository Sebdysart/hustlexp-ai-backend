import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';
import { CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES } from '../../src/jobs/nonproduction-fake-financial-execution.js';

const coreFileName = '20261010_universal_v1_financial_security_event_expiry_v1.sql';
const fakeFileName = '20261010_universal_v1_fake_financial_expiry_v9.sql';
const recoveryFileName = '20261011_universal_v1_fake_financial_expiry_recovery_v10.sql';
const core = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations', coreFileName),
  'utf8'
);
const fake = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations', fakeFileName),
  'utf8'
);
const recovery = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations', recoveryFileName),
  'utf8'
);

function functionBody(sql: string, name: string, next: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  const end = sql.indexOf(next, start);
  expect(start, `${name} start`).toBeGreaterThanOrEqual(0);
  expect(end, `${name} end`).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('Universal V1 provider-authored financial-security expiry migrations', () => {
  it('registers core migration 144 and the ordered supplemental fake v9-v12 plus seal chain', () => {
    expect(REQUIRED_MIGRATION_FILES).toHaveLength(146);
    expect(REQUIRED_MIGRATION_FILES[143]).toEqual({
      name: '20261010_universal_v1_financial_security_event_expiry_v1',
      fileName: coreFileName,
    });
    expect(CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES).toHaveLength(14);
    expect(CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES[8]).toEqual({
      name: '20261010_universal_v1_fake_financial_expiry_v9',
      fileName: fakeFileName,
      evidenceTable: 'hxos_fake_financial_schema_evidence_v9',
    });
    expect(CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES[9]).toEqual({
      name: '20261011_universal_v1_fake_financial_expiry_recovery_v10',
      fileName: recoveryFileName,
      evidenceTable: 'hxos_fake_financial_schema_evidence_v10',
    });
    expect(CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES[10]).toEqual({
      name: '20261013_nonproduction_runtime_insert_authority_v1',
      fileName: '20261013_nonproduction_runtime_insert_authority_v1.sql',
      evidenceTable: 'hxos_fake_financial_schema_evidence_v11',
    });
    expect(CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES[11]).toEqual({
      name: '20261015_universal_v1_work_order_fake_financial_authority_hardening_v12',
      fileName: '20261015_universal_v1_work_order_fake_financial_authority_hardening_v12.sql',
      evidenceTable: 'hxos_fake_financial_schema_evidence_v12',
    });
    expect(CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES[12]).toEqual({
      name: '20261015_universal_v1_work_order_bootstrap_seal_v1',
      fileName: '20261015_universal_v1_work_order_bootstrap_seal_v1.sql',
      evidenceTable: 'hxos_work_order_bootstrap_seal_evidence_v1',
    });
    expect(CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES[13]).toEqual({
      name: '20261016_universal_v1_fake_financial_command_outbox_authority_v13',
      fileName: '20261016_universal_v1_fake_financial_command_outbox_authority_v13.sql',
      evidenceTable: 'hxos_fake_financial_schema_evidence_v13',
    });
    expect(REQUIRED_MIGRATION_FILES.some(({ fileName }) => String(fileName) === fakeFileName)).toBe(false);
    expect(REQUIRED_MIGRATION_FILES.some(({ fileName }) => String(fileName) === recoveryFileName)).toBe(
      false
    );
    expect(
      REQUIRED_MIGRATION_FILES.some(
        ({ fileName }) =>
          String(fileName) ===
          '20261015_universal_v1_work_order_fake_financial_authority_hardening_v12.sql'
      )
    ).toBe(false);
  });

  it('requires expiry only on successful security facts and compares an explicit observation strictly', () => {
    expect(core).toContain("status = 'SUCCEEDED'");
    expect(core).toContain("event_kind IN ('AUTHORIZED', 'SECURED', 'ADJUSTMENT_AUTHORIZED')");
    expect(core).toContain('expires_at > occurred_at');
    expect(core).toContain('checked_expires_at > observed_at');
    expect(core).toContain('SET search_path = pg_catalog, public');
    expect(core).not.toContain("current_setting('hustlexp.test");
    expect(core).not.toContain('Stripe');
    expect(core).not.toMatch(/PAYMENT_CREATION_MODE\s*=\s*['"]enabled/iu);
  });

  it('gates only positive preparation and adapter entry while leaving recovery operations outside', () => {
    const prepared = functionBody(
      core,
      'enforce_universal_v1_prepared_positive_expiry_v1()',
      'DROP TRIGGER IF EXISTS v_universal_v1_prepared_positive_expiry_v1'
    );
    const dispatch = functionBody(
      core,
      'enforce_universal_v1_dispatch_positive_expiry_v1()',
      '-- Trigger names are ordered alphabetically.'
    );
    for (const body of [prepared, dispatch]) {
      expect(body).toContain("('SECURE', 'ADJUST', 'CAPTURE')");
      for (const recoveryOperation of ['VOID', 'REFUND', 'REVERSAL', 'RECONCILE']) {
        expect(body).not.toContain(`'${recoveryOperation}'`);
      }
    }
    expect(core).toContain('NEW.attempted_at');
    expect(core).not.toContain('UPDATE public.task_financial_security_events');
    expect(core).not.toContain('DELETE FROM public.task_financial_security_events');
  });

  it('fails address release closed on exact Universal task/Work Order identity before audit insertion', () => {
    const access = functionBody(
      core,
      'enforce_universal_v1_location_access_expiry_v1()',
      'DROP TRIGGER IF EXISTS v_universal_v1_location_access_expiry_v1'
    );
    expect(access).toContain('task_record.universal_contract_version');
    expect(access).toContain('work_order.id = task_record.work_order_id');
    expect(access).toContain('work_order.task_id = task_record.id');
    expect(access).toContain('NEW.accessed_at := observed_at');
    expect(access).toContain('task_contract_version = 1');
    expect(access).toContain('task_work_order_id IS NULL');
  });

  it('binds exact raw provider occurrence and expiry into an immutable fake bridge digest', () => {
    expect(fake).toContain('hxos_fake_financial_schema_evidence_v8');
    expect(fake).toContain('hxos_fake_financial_schema_evidence_v9');
    expect(fake).toContain("operation_kind IN ('AUTHORIZE', 'SECURE', 'ADJUST')");
    expect(fake).toContain('expires_at > recorded_at');
    expect(fake).toContain('raw.recorded_at, raw.expires_at');
    expect(fake).toContain('lifecycle.occurred_at, lifecycle.expires_at');
    expect(fake).toContain('provider_recorded_at');
    expect(fake).toContain('provider_expires_at');
    expect(fake).toContain('expiry_authority_sha256');
    expect(fake).toContain('NEW.expiry_authority_sha256 := exact_expiry_authority_sha256');
    expect(fake).toContain('(extract(epoch FROM raw_recorded_at) * 1000000)::BIGINT');
    expect(fake).toContain('(extract(epoch FROM raw_expiry) * 1000000)::BIGINT');
    expect(fake).not.toContain('raw_recorded_at::TEXT');
    expect(fake).not.toContain('raw_expiry::TEXT');
    expect(fake).toContain('universal_v1_change_order_recovery_revocation_reason_pre_expiry_v7');
    expect(fake).toContain("RETURN 'FINANCIAL_SECURITY_EXPIRED'");
    expect(fake).toContain('universal_v1_change_order_compensation_expiry_reason_v9_chk');
    expect(fake).toContain('universal_v1_change_order_terminal_expiry_reason_v9_chk');
    expect(fake).toContain('SET search_path = pg_catalog, public');
    expect(fake).not.toContain("current_setting('hustlexp.test");
    expect(fake).not.toContain('Stripe');
  });

  it('retires legacy NULL expiry without invention and durably compensates raw-only effects', () => {
    expect(fake).toContain('hxos_fake_financial_legacy_expiry_dispositions_v9');
    expect(fake).toContain("disposition = 'LEGACY_EXPIRY_UNPROVEN'");
    expect(fake).toContain("'EXACT_REPLAY_ONLY', 'COMPENSATION_REQUIRED'");
    expect(fake).toContain('hxos_fake_financial_legacy_expiry_compensation_commands_v9');
    expect(fake).toContain('hxos_fake_financial_legacy_expiry_compensation_attempts_v9');
    expect(fake).toContain('hxos_fake_financial_legacy_expiry_compensation_outcomes_v9');
    expect(fake).toContain('hxos_fake_financial_legacy_expiry_compensations_v9');
    expect(fake).toContain("THEN 'VOID'");
    expect(fake).toContain("THEN 'REVERSAL'");
    expect(fake).toContain('provider_event.recorded_at < attempt.attempted_at');
    expect(fake).toContain('require_legacy_expiry_compensation_before_terminal_outcome_v9');
    expect(fake).toContain("NEW.outcome_kind = 'FAILED'");
    expect(fake).toContain("NEW.outcome_kind = 'OUTCOME_OBSERVED'");
    expect(fake).toContain(
      'raw-only legacy success cannot acquire a contradictory terminal outcome'
    );
    expect(fake).toContain("date_trunc('milliseconds', clock_timestamp())");
    expect(fake).not.toContain("expires_at = recorded_at + interval '15 minutes'");
    expect(fake).not.toContain('UPDATE public.hxos_fake_financial_operation_events_v1');
  });

  it('moves legacy recovery behind three exact sealed v10 commands and terminalizes amountless rows', () => {
    expect(recovery).toContain('hxos_fake_financial_schema_evidence_v10');
    expect(recovery).toContain('hxos_fake_financial_legacy_expiry_noncompensable_facts_v10');
    expect(recovery).toContain('SOURCE_AMOUNT_AND_CURRENCY_UNPROVEN');
    expect(recovery).toContain('SOURCE_AMOUNT_OUTSIDE_RUNTIME_RANGE');
    expect(recovery).toContain('amount_cents <= 9007199254740991');
    expect(recovery).toContain('source_event.amount_cents > 9007199254740991');
    expect(recovery).toContain('source_event.amount_cents IS NULL');
    expect(recovery).toContain('source_event.currency IS NULL');
    expect(recovery).toContain('positive_use_denied := TRUE');
    expect(recovery).toContain('recovery_terminal := TRUE');
    expect(recovery).toContain('recovery_retryable := FALSE');
    for (const signature of [
      'hxos_prepare_legacy_expiry_compensation_v10',
      'hxos_record_legacy_expiry_compensation_attempt_v10',
      'hxos_finalize_legacy_expiry_compensation_v10',
    ]) {
      const start = recovery.indexOf(`CREATE OR REPLACE FUNCTION public.${signature}`);
      expect(start).toBeGreaterThanOrEqual(0);
      const end = recovery.indexOf('$$;', recovery.indexOf('AS $$', start));
      const body = recovery.slice(start, end);
      expect(body).toContain('SECURITY DEFINER');
      expect(body).toContain('VOLATILE');
      expect(body).toContain('PARALLEL UNSAFE');
      expect(body).toContain('SET search_path = pg_catalog');
    }
    expect(recovery).toContain(
      'checked_provider_request_sha256 IS DISTINCT FROM expected_request_sha256'
    );
    expect(recovery).toContain('require_legacy_expiry_terminal_before_outcome_v10');
    expect(recovery).toContain('REVOKE ALL ON FUNCTION');
    expect(recovery).not.toContain('GRANT EXECUTE');
    expect(recovery).not.toContain('Stripe');
  });
});
