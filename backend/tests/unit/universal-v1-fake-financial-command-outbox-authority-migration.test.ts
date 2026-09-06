import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { FAKE_FINANCIAL_OUTBOX_V13_SQL_SHA256 } from '../../src/jobs/work-order-command-role-authority.js';

const fileName = '20261016_universal_v1_fake_financial_command_outbox_authority_v13.sql';
const migration = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations', fileName),
  'utf8'
);

function functionDefinition(name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = migration.match(
    new RegExp(
      `CREATE OR REPLACE FUNCTION ${escaped}\\([\\s\\S]*?(?=\\nCREATE (?:OR REPLACE FUNCTION|TRIGGER|TABLE|INDEX)|\\nDROP TRIGGER|\\nCOMMENT ON|\\nREVOKE ALL|$)`,
      'u'
    )
  );
  expect(match, `${name} definition`).not.toBeNull();
  return match?.[0] ?? '';
}

describe('Universal V1 fake-financial command outbox authority v13 migration', () => {
  it('pins runtime authority to the exact packaged v13 SQL bytes', () => {
    expect(createHash('sha256').update(migration, 'utf8').digest('hex')).toBe(
      FAKE_FINANCIAL_OUTBOX_V13_SQL_SHA256
    );
  });
  it('is an append-only successor foundation with hostile-search-path and predecessor holds', () => {
    for (const token of [
      "SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)",
      'public.hxos_fake_financial_schema_evidence_v12',
      'hx_authority.universal_v1_work_order_target_authority_facts',
      'non-owner CREATE remains available on schema',
      'CREATE TABLE public.hxos_fake_financial_schema_evidence_v13',
      '20261016_universal_v1_fake_financial_command_outbox_authority_v13',
      'exact sealed predecessor/v13 migration evidence is absent',
      'pg_catalog.min(pg_catalog.btrim(applied.sha256)) IS DISTINCT FROM expected.expected_sha256',
      'pg_catalog.count(applied.name) IS DISTINCT FROM 1::BIGINT',
      'JOIN public.applied_migrations applied',
      'pg_catalog.btrim(applied.sha256) IS NOT DISTINCT FROM',
    ]) {
      expect(migration).toContain(token);
    }
    expect(migration).not.toContain('CREATE EXTENSION');
    // This regprocedure literal identifies the old CHECK dependency, not a digest invocation.
    expect(
      migration.replaceAll("'public.digest(bytea,text)'", "'<legacy-check-identity>'")
    ).not.toMatch(/(?<!pg_catalog\.)\b(?:digest|sha256)\s*\(/iu);
  });

  it('captures one exact PREPARED plus REQUESTED fake command in the journal transaction', () => {
    for (const token of [
      'fake_financial_command_outbox_requests_v13',
      "prepared_state TEXT NOT NULL DEFAULT 'PREPARED'",
      "command_state TEXT NOT NULL DEFAULT 'REQUESTED'",
      "provider_kind TEXT NOT NULL DEFAULT 'FAKE'",
      "release_environment IN ('local', 'preview', 'staging')",
      "release_authentication_status IS DISTINCT FROM 'VERIFIED'",
      'prepared.provider_request_sha256',
      'command.prepared_financial_command_id',
      'command.prepared_authority_sha256',
      'command.command_identity_sha256',
      'AFTER INSERT ON public.financial_provider_command_journal',
      'REQUESTED fact does not match exact PREPARED authority',
      'outbox request lacks exact PREPARED/REQUESTED/target authority',
    ]) {
      expect(migration).toContain(token);
    }
    const newRelations = [...migration.matchAll(/^CREATE TABLE\b[\s\S]+?^\);/gmu)];
    expect(
      newRelations
        .map(([definition]) => definition.match(/^CREATE TABLE\s+([a-z0-9_.]+)/u)?.[1])
        .sort()
    ).toEqual([
      'hx_authority.fake_financial_change_order_compensation_origins_v13',
      'hx_authority.fake_financial_command_outbox_requests_v13',
      'hx_authority.fake_financial_dispatch_admissions_v13',
      'hx_authority.fake_financial_exact_requests_v13',
      'hx_authority.fake_financial_job_validations_v13',
      'hx_authority.fake_financial_outbox_dispositions_v13',
      'hx_authority.fake_financial_outbox_publish_claims_v13',
      'hx_authority.fake_financial_outbox_publish_outcomes_v13',
      'hx_authority.fake_financial_preparation_authority_v13',
      'hx_authority.fake_financial_publish_exhaustions_v13',
      'hx_authority.fake_financial_webhook_inert_evidence_v13',
      'hx_authority.fake_financial_webhook_key_revocations_v13',
      'hx_authority.fake_financial_webhook_keys_v13',
      'hx_authority.fake_financial_webhook_rejection_receipts_v13',
      'hx_authority.fake_financial_webhook_verifications_v13',
      'public.hxos_fake_financial_schema_evidence_v13',
    ]);
    for (const [definition] of newRelations) {
      expect(definition).not.toMatch(
        /\b(?:exact_request|request_payload)\s+(?:BYTEA|JSONB|TEXT)\b/iu
      );
      expect(definition).not.toMatch(
        /\b(?:payment_method_reference|provider_account_reference)\s+/iu
      );
    }
  });

  it('derives a PII-free deterministic BullMQ identity from immutable command and target authority', () => {
    for (const token of [
      'fake_financial_job_digest_v13',
      "'HXUV1_FAKE_FINANCIAL_BULLMQ_JOB_V13'",
      'NEW.provider_expected_version::TEXT',
      'NEW.command_identity_sha256',
      'NEW.prepared_authority_sha256',
      'NEW.target_authority_id::TEXT',
      "'hx-fake-fin-'",
      "bullmq_job_id ~ '^hx-fake-fin-[0-9a-f]{32}-[0-9a-f]{64}$'",
      "'kind', 'UNIVERSAL_V1_FAKE_FINANCIAL_COMMAND'",
      "'outboxRequestId'",
      "'commandId'",
      "'jobAuthoritySha256'",
    ]) {
      expect(migration).toContain(token);
    }
    const claimPort = functionDefinition('hx_authority.claim_fake_financial_outbox_v13');
    expect(claimPort).not.toMatch(
      /raw_payload|amount_cents|currency|task_draft_id|work_order_id/iu
    );
  });

  it('uses append-only publisher leases and outcomes for retry and queue-add acknowledgement recovery', () => {
    for (const token of [
      'fake_financial_outbox_publish_claims_v13',
      'fake_financial_outbox_publish_outcomes_v13',
      "'BULLMQ_CONFIRMED', 'RETRYABLE_FAILURE', 'TERMINAL_FAILURE'",
      'lease_expires_at <= authority_now',
      "latest_outcome.outcome_kind = 'RETRYABLE_FAILURE'",
      'latest_outcome.retry_not_before <= authority_now',
      'publisher outcome is stale or duplicated',
      'BullMQ acknowledgement identity mismatch',
      'publisher retry bound exhausted',
    ]) {
      expect(migration).toContain(token);
    }
    for (const relation of [
      'fake_finance_outbox_request',
      'fake_finance_publish_claim',
      'fake_finance_publish_outcome',
      'fake_finance_outbox_disposition',
      'fake_finance_dispatch_admission',
      'fake_finance_job_validation',
      'fake_finance_webhook_inert',
      'fake_finance_webhook_rejection',
      'fake_finance_schema_evidence',
    ]) {
      expect(migration).toContain(`${relation}_append_only_v13`);
      expect(migration).toContain(`${relation}_no_truncate_v13`);
    }
    expect(migration).toContain('fake-financial outbox authority facts are append-only');
  });

  it('retires stale target requests append-only and only claims the exact locked current tip', () => {
    const claimPort = functionDefinition('hx_authority.claim_fake_financial_outbox_v13');
    for (const token of [
      'fake_financial_outbox_dispositions_v13',
      "disposition_kind = 'TARGET_SUPERSEDED'",
      'superseded_target_authority_id',
      'replacement_target_authority_id',
      'FOR UPDATE',
      'fake_financial_outbox_dispositions_v13 disposition',
    ]) {
      expect(migration).toContain(token);
    }
    expect(claimPort).toContain('INSERT INTO hx_authority.fake_financial_outbox_dispositions_v13');
    expect(claimPort).toContain('request.target_authority_id = current_tip.target_authority_id');
    expect(claimPort).toContain('disposition.outbox_request_id = request.outbox_request_id');
  });

  it('rejects forged Redis identity before recording fake-only dispatch crash-boundary evidence', () => {
    const workerPort = functionDefinition(
      'hx_authority.record_fake_financial_job_dispatch_evidence_v13'
    );
    for (const token of [
      'forged, stale, or unpublished Redis job rejected',
      'request_record.bullmq_job_id IS DISTINCT FROM',
      'request_record.job_authority_sha256 IS DISTINCT FROM',
      'fake_financial_outbox_publish_claims_v13',
      'fake_financial_dispatch_admissions_v13',
      'same-transaction sealed v13 admission',
      'financial_provider_command_recovery_leases',
      'financial_provider_command_dispatch_attempts',
      "'DISPATCH'",
      'provider_execution_capability BOOLEAN NOT NULL DEFAULT FALSE',
      'positive_money_capability BOOLEAN NOT NULL DEFAULT FALSE',
      'production_capability BOOLEAN NOT NULL DEFAULT FALSE',
      'DISPATCH_ATTEMPTED rows written by the sealed evidence port',
      'never issues adapter or money capability',
    ]) {
      expect(migration).toContain(token);
    }
    expect(workerPort).toContain('SECURITY DEFINER');
    expect(workerPort).toContain('INSERT INTO hx_authority.fake_financial_dispatch_admissions_v13');
    expect(workerPort).toContain('pg_catalog.pg_current_xact_id()::TEXT::BIGINT');
    expect(workerPort).not.toMatch(/executeFinancialEvent|invokeAdapter|queue\.add|new Queue/iu);
  });

  it('forward-replaces the legacy NULL-outcome redispatch hole with a null-safe zero-write denial', () => {
    const leaseGuard = functionDefinition(
      'public.assert_financial_provider_command_recovery_lease'
    );
    for (const token of [
      'CREATE OR REPLACE FUNCTION public.assert_financial_provider_command_recovery_lease()',
      "latest_outcome_kind IS DISTINCT FROM 'FAILED'",
      'latest_outcome_retryable IS DISTINCT FROM TRUE',
      "latest_effect_certainty IS DISTINCT FROM 'CONFIRMED_NO_EFFECT'",
      'latest_recovery_not_before IS NULL',
      'redispatch requires a due retryable FAILED CONFIRMED_NO_EFFECT outcome',
      'DISPATCH requires one same-transaction sealed v13 admission',
      'DROP TRIGGER IF EXISTS financial_provider_command_recovery_lease_guard',
      'EXECUTE FUNCTION public.assert_financial_provider_command_recovery_lease()',
      'Redis replay lacks a due confirmed-no-effect outcome',
    ]) {
      expect(migration).toContain(token);
    }
    expect(leaseGuard).toContain('SECURITY INVOKER');
    expect(leaseGuard).toContain('SET search_path = pg_catalog');
    expect(leaseGuard).not.toMatch(/latest_attempt_id\s+IS\s+NOT\s+NULL\s+AND\s+NOT\s*\(/iu);
  });

  it('keeps authenticated fake webhooks on a distinct append-only inert evidence rail', () => {
    const webhookCapture = functionDefinition(
      'hx_authority.capture_fake_financial_webhook_inert_v13'
    );
    for (const token of [
      'fake_financial_webhook_inert_evidence_v13',
      "evidence_state = 'INERT_WEBHOOK_EVIDENCE'",
      'outbox_dispatch_authorized IS FALSE',
      'lifecycle_transition_authorized IS FALSE',
      'AFTER INSERT ON public.provider_event_inbox_receipts',
      'Raw payload remains only in the provider inbox',
    ]) {
      expect(migration).toContain(token);
    }
    expect(webhookCapture).toContain(
      'INSERT INTO hx_authority.fake_financial_webhook_inert_evidence_v13'
    );
    expect(webhookCapture).not.toContain(
      'INSERT INTO hx_authority.fake_financial_command_outbox_requests_v13'
    );
    expect(webhookCapture).not.toMatch(/task_financial_security_events|task_work_orders/iu);
  });

  it('preserves digest-only unauthenticated fake webhook rejection evidence with zero authority', () => {
    const rejectionPort = functionDefinition(
      'hx_authority.record_fake_financial_webhook_rejection_v13'
    );
    const webhookCapture = functionDefinition(
      'hx_authority.capture_fake_financial_webhook_inert_v13'
    );
    for (const token of [
      'fake_financial_webhook_rejection_receipts_v13',
      "receipt_state = 'UNAUTHENTICATED_REJECTED'",
      'raw_payload_sha256',
      'authentication_evidence_sha256',
      'provider_execution_capability IS FALSE',
      'positive_money_capability IS FALSE',
      'production_capability IS FALSE',
    ]) {
      expect(migration).toContain(token);
    }
    expect(rejectionPort).toContain('SECURITY INVOKER');
    expect(rejectionPort).toContain(
      'INSERT INTO hx_authority.fake_financial_webhook_rejection_receipts_v13'
    );
    expect(rejectionPort).not.toMatch(/raw_payload\s*[,)]/iu);
    expect(webhookCapture).toContain('record_fake_financial_webhook_rejection_v13');
    expect(webhookCapture).not.toContain('unauthenticated FAKE webhook receipt refused');
  });

  it('keeps transport ports invoker-only, seals the worker admission port, and closes new authority objects', () => {
    for (const name of [
      'hx_authority.claim_fake_financial_outbox_v13',
      'hx_authority.record_fake_financial_publish_outcome_v13',
    ]) {
      const definition = functionDefinition(name);
      expect(definition).toContain('SECURITY INVOKER');
      expect(definition).toContain('SET search_path = pg_catalog');
    }
    const workerPort = functionDefinition(
      'hx_authority.record_fake_financial_job_dispatch_evidence_v13'
    );
    expect(workerPort).toContain('SECURITY DEFINER');
    expect(workerPort).toContain('SET search_path = pg_catalog');
    for (const token of [
      'REVOKE ALL ON TABLE',
      'fake_financial_command_outbox_requests_v13',
      'fake_financial_outbox_publish_claims_v13',
      'fake_financial_outbox_publish_outcomes_v13',
      'fake_financial_outbox_dispositions_v13',
      'fake_financial_dispatch_admissions_v13',
      'fake_financial_job_validations_v13',
      'fake_financial_webhook_inert_evidence_v13',
      'fake_financial_webhook_rejection_receipts_v13',
      'hxos_fake_financial_schema_evidence_v13',
      'FROM PUBLIC',
      'Strip every non-owner',
      'privilege.grantee <> namespace_state.nspowner',
      'pg_catalog.pg_auth_members',
      "'REVOKE ALL PRIVILEGES ON TABLE %s FROM %s'",
      "'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %s'",
    ]) {
      expect(migration).toContain(token);
    }
    expect(migration).not.toMatch(/^\s*GRANT\b/imu);
  });

  it('confines canonical event insertion to the sealed fake materializer and excludes live effects', () => {
    const materializer = functionDefinition('public.hxos_materialize_fake_financial_event_v13');
    const protectedWrite =
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\.(?:task_financial_security_events|task_work_orders|task_financial_operations|provider_payables|provider_payouts|payments|escrows)\b/giu;
    const allowedEventInsert = /\bINSERT\s+INTO\s+public\.task_financial_security_events\b/iu;
    const writes = [...materializer.matchAll(protectedWrite)].map((match) => match[0]);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(allowedEventInsert);
    expect(migration.replace(materializer, '')).not.toMatch(protectedWrite);
    expect(materializer).toContain('SECURITY DEFINER');
    expect(materializer).toContain('hx_authority.read_fake_financial_materialization_evidence_v13');
    expect(migration).not.toMatch(/\b(?:stripe|payment_intent|transfer_data|payout_method)\b/iu);
    expect(migration).not.toMatch(/\b(?:queue\.add|new Queue|fetch\s*\(|axios\.)/iu);
    expect(migration).not.toMatch(/provider_kind\s*=\s*'APPROVED_PROVIDER'/iu);
    for (const token of [
      'provider_execution_capability IS FALSE',
      'positive_money_capability IS FALSE',
      'production_capability IS FALSE',
      "release_environment NOT IN ('local', 'preview', 'staging')",
    ]) {
      expect(migration).toContain(token);
    }
  });
});
