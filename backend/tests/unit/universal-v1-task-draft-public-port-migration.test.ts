import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'backend/database/migrations/20260902_universal_v1_task_draft_public_port.sql',
  ),
  'utf8',
);

describe('Universal V1 task-draft-public compatibility migration', () => {
  it('is append-only after canonical lead ingress and before account claim', () => {
    const publicPortIndex = REQUIRED_MIGRATION_FILES.findIndex(
      ({ name }) => name === '20260902_universal_v1_task_draft_public_port',
    );

    expect(REQUIRED_MIGRATION_FILES).toHaveLength(121);
    expect(publicPortIndex).toBeGreaterThan(0);
    expect(REQUIRED_MIGRATION_FILES.slice(publicPortIndex - 1)).toEqual([
      {
        name: '20260901_universal_v1_lead_ingress_port',
        fileName: '20260901_universal_v1_lead_ingress_port.sql',
      },
      {
        name: '20260902_universal_v1_task_draft_public_port',
        fileName: '20260902_universal_v1_task_draft_public_port.sql',
      },
      {
        name: '20260903_universal_v1_task_draft_account_claim',
        fileName: '20260903_universal_v1_task_draft_account_claim.sql',
      },
      {
        name: '20260904_canonical_user_email_identity',
        fileName: '20260904_canonical_user_email_identity.sql',
      },
      {
        name: '20260905_universal_v1_task_draft_legacy_claim_import_repair',
        fileName: '20260905_universal_v1_task_draft_legacy_claim_import_repair.sql',
      },
      {
        name: '20260906_universal_v1_estimate_acceptance_materialization',
        fileName: '20260906_universal_v1_estimate_acceptance_materialization.sql',
      },
      {
        name: '20260907_universal_v1_provider_estimate_invitation',
        fileName: '20260907_universal_v1_provider_estimate_invitation.sql',
      },
      {
        name: '20260908_universal_v1_provider_work_order_authority',
        fileName: '20260908_universal_v1_provider_work_order_authority.sql',
      },
      {
        name: '20260909_universal_v1_reconciliation_alias_repair',
        fileName: '20260909_universal_v1_reconciliation_alias_repair.sql',
      },
      {
        name: '20260911_universal_v1_change_order_application',
        fileName: '20260911_universal_v1_change_order_application.sql',
      },
      {
        name: '20260912_universal_v1_work_order_execution_facts',
        fileName: '20260912_universal_v1_work_order_execution_facts.sql',
      },
      {
        name: '20260913_universal_v1_completion_delivery_receipt',
        fileName: '20260913_universal_v1_completion_delivery_receipt.sql',
      },
    ]);
  });

  it('classifies exact ingress, token, IP-hash, and legacy evidence contracts', () => {
    for (const column of [
      'ingress_contract_version',
      'ingress_origin',
      'card_token_contract_version',
      'ip_hash_scheme',
      'legacy_lead_submission_id',
      'legacy_poster_auth_user_id',
      'legacy_quote_id',
      'legacy_engine_task_id',
      'legacy_import_batch_id',
      'legacy_source_row_sha256',
      'legacy_import_disposition',
    ]) {
      expect(migration).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }

    for (const origin of [
      'UNCLASSIFIED_V0',
      'BACKEND_POSTGRESQL',
      'LEGACY_SUPABASE_TASK_DRAFT_PUBLIC',
    ]) {
      expect(migration).toContain(`'${origin}'`);
    }

    for (const scheme of [
      'UNKNOWN_V0',
      'LEGACY_SHA256_IP_SUFFIX_V1',
      'HMAC_SHA256_V1',
    ]) {
      expect(migration).toContain(`'${scheme}'`);
    }

    expect(migration).toContain('ingress_contract_version IN (0, 1)');
    expect(migration).toContain('card_token_contract_version IN (0, 1)');
    expect(migration).toMatch(
      /ingress_origin = 'LEGACY_SUPABASE_TASK_DRAFT_PUBLIC'[\s\S]*?ingress_contract_version = 0[\s\S]*?card_token_contract_version = 0/u,
    );
    expect(migration).toContain(
      'ON public.task_drafts(ip_hash_scheme, ip_hash, created_at DESC)',
    );
  });

  it('backfills only compatibility metadata and never guesses canonical authority', () => {
    const match = migration.match(/UPDATE public\.task_drafts\s+SET ([\s\S]*?)\s+WHERE /u);
    expect(match).not.toBeNull();
    const assignments = Array.from(match?.[1].matchAll(/^\s*([a-z_]+)\s*=/gmu))
      .map(([, column]) => column);
    expect(assignments).toEqual([
      'ingress_contract_version',
      'ingress_origin',
      'card_token_contract_version',
      'ip_hash_scheme',
    ]);

    expect(migration).not.toMatch(/INSERT\s+INTO\s+(?:public\.)?task_drafts/iu);
    expect(migration).not.toMatch(/INSERT\s+INTO\s+(?:public\.)?task_routing_decisions/iu);
    expect(migration).not.toMatch(/UPDATE\s+(?:public\.)?task_routing_decisions/iu);
    expect(migration).not.toMatch(/DELETE\s+FROM\s+(?:public\.)?task_drafts/iu);
  });

  it('requires two-person reviewed, rate-continuous immutable import evidence', () => {
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS public.task_draft_legacy_import_batches',
    );
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS public.task_draft_legacy_import_receipts',
    );
    expect(migration).toContain('CHECK (prepared_by <> reviewed_by)');
    expect(migration).toContain("import_mode = 'READ_ONLY_NO_ROUTE'");
    expect(migration).toContain("'DUAL_SCHEME_SECRET_REFERENCE'");
    expect(migration).toContain("'WAIT_ONE_HOUR_AFTER_WRITER_DISABLE'");
    expect(migration).toContain("'FAIL_CLOSED'");
    expect(migration).toContain(
      "backend_accept_not_before >= legacy_writer_disabled_at + interval '1 hour'",
    );
    expect(migration).toContain("'NO_SYNTHETIC_ROUTE'");
    expect(migration).toContain("'EXPLICIT_APPLICATION_ADOPTION_REQUIRED'");
    expect(migration).toContain('CREATE TRIGGER task_draft_legacy_import_receipt_guard');
    expect(migration).toContain('imported_draft.lead_id IS NOT NULL');
    expect(migration).toContain('imported_draft.poster_user_id IS NOT NULL');
    expect(migration).toContain('imported_draft.task_id IS NOT NULL');
    expect(migration).toContain('imported_draft.quote_id IS NOT NULL');
    expect(migration).toContain('imported_draft.active_routing_decision_id IS NOT NULL');
    expect(migration).toContain('FROM public.task_routing_decisions routing');
    expect(migration).toContain(
      'HXUV1-TD-LEGACY-2: imported TaskDraft must remain an exact read-only v0 row without canonical links or routes',
    );
    expect(migration).toContain('CREATE TRIGGER task_draft_ingress_compatibility_immutable');
    expect(migration).toContain(
      'HXUV1-TD-LEGACY-3: imported TaskDraft evidence is read-only pending an explicit adoption contract',
    );
    expect(migration).toContain(
      'HXUV1-TD-LEGACY-4: TaskDraft ingress compatibility identity is immutable after insert',
    );
    expect(migration).toContain(
      'CREATE CONSTRAINT TRIGGER task_draft_legacy_import_receipt_presence_guard',
    );
    expect(migration).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(migration).toContain(
      'HXUV1-TD-LEGACY-5: imported TaskDraft requires its exact immutable receipt by commit',
    );

    for (const trigger of [
      'task_draft_legacy_import_batches_immutable',
      'task_draft_legacy_import_batches_no_truncate',
      'task_draft_legacy_import_receipts_immutable',
      'task_draft_legacy_import_receipts_no_truncate',
    ]) {
      expect(migration).toContain(`CREATE TRIGGER ${trigger}`);
    }
    expect(migration).toContain(
      'HXUV1-TD-LEGACY-1: TaskDraft legacy import evidence is append-only',
    );
    expect(migration).toContain(
      'REVOKE ALL ON TABLE public.task_draft_legacy_import_batches FROM PUBLIC',
    );
    expect(migration).toContain(
      'REVOKE ALL ON TABLE public.task_draft_legacy_import_receipts FROM PUBLIC',
    );
  });
});
