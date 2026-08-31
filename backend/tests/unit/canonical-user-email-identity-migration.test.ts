import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';

const SQL = readFileSync(resolve(
  process.cwd(),
  'backend/database/migrations/20260904_canonical_user_email_identity.sql',
), 'utf8');

describe('canonical user-email identity migration', () => {
  it('retains its exact append-only position in the current startup chain', () => {
    const identityIndex = REQUIRED_MIGRATION_FILES.findIndex(
      ({ name }) => name === '20260904_canonical_user_email_identity',
    );

    expect(REQUIRED_MIGRATION_FILES).toHaveLength(140);
    expect(identityIndex).toBeGreaterThan(0);
    expect(REQUIRED_MIGRATION_FILES.slice(identityIndex - 1)).toEqual([
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
      {
        name: '20260914_notification_provider_in_flight',
        fileName: '20260914_notification_provider_in_flight.sql',
      },
      {
        name: '20260915_ai_spend_attempt_ledger',
        fileName: '20260915_ai_spend_attempt_ledger.sql',
      },
      {
        name: '20260916_provider_event_inbox_v1',
        fileName: '20260916_provider_event_inbox_v1.sql',
      },
      {
        name: '20260917_financial_provider_command_journal_v1',
        fileName: '20260917_financial_provider_command_journal_v1.sql',
      },
      {
        name: '20260918_universal_v1_prepared_financial_command_v1',
        fileName: '20260918_universal_v1_prepared_financial_command_v1.sql',
      },
      {
        name: '20260919_provider_event_processing_v1',
        fileName: '20260919_provider_event_processing_v1.sql',
      },
      {
        name: '20260920_financial_provider_command_recovery_v1',
        fileName: '20260920_financial_provider_command_recovery_v1.sql',
      },
      {
        name: '20260923_legacy_escrow_insert_containment_v1',
        fileName: '20260923_legacy_escrow_insert_containment_v1.sql',
      },
      {
        name: '20260924_universal_v1_task_draft_route_context_v1',
        fileName: '20260924_universal_v1_task_draft_route_context_v1.sql',
      },
      {
        name: '20260925_universal_v1_work_order_compensation_v1',
        fileName: '20260925_universal_v1_work_order_compensation_v1.sql',
      },
      {
        name: '20260928_provider_observation_normalization_v1',
        fileName: '20260928_provider_observation_normalization_v1.sql',
      },
      {
        name: '20260929_universal_v1_double_entry_ledger_v1',
        fileName: '20260929_universal_v1_double_entry_ledger_v1.sql',
      },
      {
        name: '20260930_universal_v1_ops_cases_v1',
        fileName: '20260930_universal_v1_ops_cases_v1.sql',
      },
      {
        name: '20261001_universal_v1_relationship_origin_v1',
        fileName: '20261001_universal_v1_relationship_origin_v1.sql',
      },
      {
        name: '20261002_universal_v1_dispute_recovery_v1',
        fileName: '20261002_universal_v1_dispute_recovery_v1.sql',
      },
      {
        name: '20261003_universal_v1_task_opportunities_v1',
        fileName: '20261003_universal_v1_task_opportunities_v1.sql',
      },
      {
        name: '20261004_universal_v1_completion_notice_dispatch_v1',
        fileName: '20261004_universal_v1_completion_notice_dispatch_v1.sql',
      },
      {
        name: '20261005_universal_v1_occurrence_access_audit_v1',
        fileName: '20261005_universal_v1_occurrence_access_audit_v1.sql',
      },
      {
        name: '20261006_stage1_legacy_authority_containment_v1',
        fileName: '20261006_stage1_legacy_authority_containment_v1.sql',
      },
    ]);
  });

  it('refuses pre-existing ambiguity and enforces one case-insensitive identity key', () => {
    expect(SQL).toContain('GROUP BY lower(email)');
    expect(SQL).toContain('HXAUTH-EMAIL-1');
    expect(SQL).toContain('CREATE UNIQUE INDEX IF NOT EXISTS users_canonical_email_identity_uidx');
    expect(SQL).toContain('ON public.users (lower(email))');
    expect(SQL).toContain('index_state.indisunique');
    expect(SQL).toContain('index_state.indisvalid');
    expect(SQL).toContain(
      "pg_get_expr(index_state.indexprs, index_state.indrelid) = 'lower((email)::text)'",
    );
    expect(SQL).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE)\b/iu);
  });
});
