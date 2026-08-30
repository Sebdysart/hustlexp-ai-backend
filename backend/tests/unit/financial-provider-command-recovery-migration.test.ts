import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const fileName = '20260920_financial_provider_command_recovery_v1.sql';
const migration = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations', fileName),
  'utf8'
);
const recoveryRepository = readFileSync(
  resolve(
    process.cwd(),
    'backend/src/services/payment/FinancialProviderCommandRecovery.ts'
  ),
  'utf8'
);
const recoveryWorker = readFileSync(
  resolve(process.cwd(), 'backend/src/jobs/financial-provider-command-recovery-worker.ts'),
  'utf8'
);

describe('financial provider command recovery migration', () => {
  it('keeps REQUESTED, DISPATCH_ATTEMPTED, and outcome facts separate and append-only', () => {
    for (const token of [
      'financial_provider_command_journal',
      'financial_provider_command_recovery_leases',
      'financial_provider_command_dispatch_attempts',
      'financial_provider_command_outcome_facts',
      'DISPATCH_ATTEMPTED',
      "'OUTCOME_OBSERVED', 'OUTCOME_UNKNOWN', 'FAILED'",
      'BEFORE UPDATE OR DELETE',
      'BEFORE TRUNCATE',
      'financial provider command recovery evidence is append-only',
    ]) {
      expect(migration).toContain(token);
    }
    expect(migration).not.toMatch(/UPDATE\s+public\.financial_provider_command_journal\s+SET/iu);
  });

  it('fences concurrent work and derives all evidence clocks at the database boundary', () => {
    for (const token of [
      "pg_advisory_xact_lock(\n    hashtext('financial-provider-command-recovery-v1')",
      'financial_provider_command_recovery_lease_command_uniq',
      'financial_provider_command_dispatch_attempt_lease_uniq',
      'recovery lease already recorded an outcome',
      'expires_at = acquired_at + make_interval(secs => lease_duration_seconds)',
      'outcome_deadline_at = attempted_at + make_interval(secs => outcome_timeout_seconds)',
      'recovery_not_before = recorded_at + make_interval(secs => recovery_delay_seconds)',
      'financial_provider_command_one_terminal_outcome_uniq',
      'NEW.acquired_at := authority_now',
      'NEW.expires_at := authority_now + make_interval(secs => NEW.lease_duration_seconds)',
      'NEW.attempted_at := authority_now',
      'NEW.outcome_deadline_at := authority_now',
      'NEW.recorded_at := authority_now',
      'NEW.recovery_not_before := CASE',
    ]) {
      expect(migration).toContain(token);
    }
  });

  it('keeps background recovery reconciliation-only after a committed attempt', () => {
    for (const token of [
      'dispatch outcome deadline has not elapsed',
      'reconciliation requires a due nonterminal outcome',
      "'RECONCILE'::TEXT AS recovery_action",
      'latest_attempt.dispatch_attempt_id IS NOT NULL',
    ]) {
      expect(`${migration}\n${recoveryRepository}`).toContain(token);
    }
    expect(recoveryRepository).toContain('LIMIT 1`');
    expect(recoveryWorker).not.toContain('this.executor.dispatch(');
    expect(recoveryWorker).not.toContain('recordDispatchAttempted({');
  });

  it('preserves pending and retryable observations as durable nonterminal evidence', () => {
    expect(migration).toContain("provider_state IN ('PENDING', 'RETRYABLE_FAILURE')");
    expect(migration).toContain("effect_certainty = 'UNKNOWN'");
    expect(migration).toContain("outcome_kind IN ('OUTCOME_OBSERVED', 'OUTCOME_UNKNOWN', 'FAILED')");
    expect(recoveryWorker).toContain("new Set<FinancialOperationState>(['PENDING', 'RETRYABLE_FAILURE'])");
  });

  it('binds safe value, version, and reference projections to the canonical result digest', () => {
    for (const token of [
      'amount_cents BIGINT',
      'currency CHAR(3)',
      'external_reference_sha256 CHAR(64)',
      'NEW.provider_result_version <> command_provider_expected_version + 1',
      'NEW.amount_cents IS DISTINCT FROM command_amount_cents',
      'observed provider projection digest mismatch',
    ]) {
      expect(migration).toContain(token);
    }
    expect(recoveryWorker).toContain(
      'externalReferenceSha256: sha256(execution.providerResult.externalReference)'
    );
  });

  it('reauthorizes at adapter entry and requires cooperative abort settlement', () => {
    expect(recoveryWorker.match(/this\.authorize\(\{ component: 'worker' \}\)/gu)).toHaveLength(1);
    expect(recoveryWorker).toContain("abortContract: 'ABORT_SIGNAL_SETTLES'");
    expect(recoveryWorker).toContain('new AbortController()');
    expect(recoveryWorker).toContain('this.reconciliationDeadlineMs');
    expect(recoveryWorker).not.toContain('Promise.race');
  });

  it('prevents immediate database and per-run recovery hot loops', () => {
    expect(migration).toContain('recovery_delay_seconds BETWEEN 1 AND 86400');
    expect(recoveryRepository).toContain('excludeCommandIds');
    expect(recoveryRepository).toContain('NOT (command.command_id = ANY($2::UUID[]))');
    expect(recoveryWorker).toContain('processedCommandIds.has(claim.command.commandId)');
  });

  it('makes approved-provider recovery unavailable at the database boundary', () => {
    expect(migration).toContain("IF current_provider_kind <> 'FAKE' THEN");
    expect(migration).toContain('approved-provider recovery is unavailable');
    expect(migration).toContain("command_provider_kind <> 'FAKE'");
    expect(migration).toContain(
      'These tables grant no provider, payment, deployment, scheduling, or'
    );
  });

  it('stores hashes and bounded safe codes, never raw requests or provider references', () => {
    for (const token of [
      'request_sha256 CHAR(64)',
      'provider_result_sha256 CHAR(64)',
      'outcome_identity_sha256 CHAR(64) GENERATED ALWAYS AS',
      "failure_code ~ '^[A-Z][A-Z0-9_.:-]{2,63}$'",
    ]) {
      expect(migration).toContain(token);
    }
    expect(migration).not.toMatch(/\brequest_payload\s+(?:BYTEA|JSONB|TEXT)\b/iu);
    expect(migration).not.toMatch(/\bprovider_payload\s+(?:BYTEA|JSONB|TEXT)\b/iu);
    expect(migration).not.toMatch(/\bpayment_method_reference\s+/iu);
    expect(migration).not.toMatch(/\bprovider_account_reference\s+/iu);
    expect(migration).not.toMatch(/\bexternal_reference\s+/iu);
    expect(recoveryWorker).toContain('sha256(result.externalReference)');
    expect(recoveryWorker).not.toContain('externalReference: result.externalReference');
  });

  it('uses the shared nonproduction authorization gate and exposes unsatisfied integrations', () => {
    expect(recoveryWorker).toContain('assertNonproductionFakeFinanceAuthorized');
    expect(recoveryWorker).toContain("authorize({ component: 'worker' })");
    expect(recoveryWorker).toContain("foregroundPreparedCommandDispatch: 'NOT_WIRED'");
    expect(recoveryWorker).toContain("lifecycleOutcomeMaterialization: 'NOT_WIRED'");
  });
});
