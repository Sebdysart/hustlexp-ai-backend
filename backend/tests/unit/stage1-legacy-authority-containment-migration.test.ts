import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const migrationPath =
  'backend/database/migrations/20261006_stage1_legacy_authority_containment_v1.sql';
const migration = read(migrationPath);
const occurrenceAudit = read(
  'backend/database/migrations/20261005_universal_v1_occurrence_access_audit_v1.sql'
);
const frozenUpgradeWitness = read(
  'backend/tests/integration/upgrade-convergence-assert.pg.sql'
);

const retiredMigrationPaths = [
  'backend/database/migrations/20260819_ops_web_hardening.sql',
  'backend/database/migrations/20260821_business_claim_links_extra.sql',
  'backend/database/migrations/20260821_business_ownership.sql',
  'backend/database/migrations/20260821_ops_business_claim_links.sql',
  'backend/database/migrations/20260823_business_fulfiller_lifecycle.sql',
  'backend/database/migrations/20260823_business_payout_tables.sql',
  'backend/database/migrations/20260824_business_controlled_test_acceptance.sql',
  'backend/database/migrations/20260824_enforce_controlled_test_business_acceptance.sql',
  'backend/database/migrations/20260824_orchestration_mode.sql',
  'backend/database/migrations/20260825_ops_manual_liquidity_bypass.sql',
  'backend/database/migrations/20260825_ops_manual_worker_offer_bypass.sql',
  'backend/database/migrations/20260826_business_local_test_payout_evidence.sql',
] as const;

describe('Stage-1 legacy authority forward containment migration', () => {
  it('is append-only ordinal 140 after byte-frozen migration 139', () => {
    expect(REQUIRED_MIGRATION_FILES).toHaveLength(146);
    expect(REQUIRED_MIGRATION_FILES[138]).toEqual({
      name: '20261005_universal_v1_occurrence_access_audit_v1',
      fileName: '20261005_universal_v1_occurrence_access_audit_v1.sql',
    });
    expect(REQUIRED_MIGRATION_FILES[139]).toEqual({
      name: '20261006_stage1_legacy_authority_containment_v1',
      fileName: '20261006_stage1_legacy_authority_containment_v1.sql',
    });
    expect(REQUIRED_MIGRATION_FILES[140]).toEqual({
      name: '20261007_subscription_cancellation_recovery_v1',
      fileName: '20261007_subscription_cancellation_recovery_v1.sql',
    });
    expect(REQUIRED_MIGRATION_FILES[141]).toEqual({
      name: '20261008_universal_v1_work_order_task_state_containment_v1',
      fileName:
        '20261008_universal_v1_work_order_task_state_containment_v1.sql',
    });
    expect(REQUIRED_MIGRATION_FILES[142]).toEqual({
      name: '20261009_universal_v1_standardized_quote_readiness_v1',
      fileName: '20261009_universal_v1_standardized_quote_readiness_v1.sql',
    });
    expect(createHash('sha256').update(occurrenceAudit).digest('hex')).toBe(
      'd805ce946b7aba804be55aea9f131cff99047adaa7d46cd3d21242ac492ec364'
    );
  });

  it('keeps all twelve unsafe source migrations retired', () => {
    const registered = new Set<string>(
      REQUIRED_MIGRATION_FILES.map(({ fileName }) => fileName)
    );
    for (const path of retiredMigrationPaths) {
      expect(existsSync(resolve(process.cwd(), path)), path).toBe(false);
      expect(registered.has(path.split('/').at(-1)!), path).toBe(false);
    }
  });

  it('preserves legacy evidence while removing every competing writer and bypass', () => {
    expect(migration).not.toMatch(/DROP\s+(?:TABLE|COLUMN)\b/iu);
    expect(migration).not.toMatch(/\bCASCADE\b/iu);
    expect(migration).not.toMatch(/DELETE\s+FROM\s+(?:public\.)?applied_migrations/iu);
    for (const relation of [
      'ops_action_audit',
      'ops_business_claim_links',
      'hxos_local_test_business_payout_destinations',
      'hxos_local_test_business_payout_transfers',
    ]) {
      expect(migration).toContain(`'${relation}'`);
    }
    expect(migration).toContain('BEFORE INSERT OR UPDATE OR DELETE ON public.%I');
    expect(migration).toContain('BEFORE TRUNCATE ON public.%I');
    expect(migration).toContain('retired Stage-1 relation is immutable evidence');
    expect(migration).toContain('stage1_quote_authority_containment');
    expect(migration).toContain('stage1_quote_authority_delete_containment');
    expect(migration).toContain('stage1_quote_evidence_truncate_containment');
    expect(migration).toContain('stage1_task_authority_containment');
    expect(migration).toContain('stage1_task_evidence_truncate_containment');
    expect(migration).toContain(
      'core task/quote evidence cannot be truncated'
    );
    expect(migration).toContain(
      "OLD.business_fulfiller_organization_id IS NOT NULL"
    );
    expect(migration).toContain(
      "OLD.orchestration_mode IS DISTINCT FROM 'AUTOMATED'"
    );
    expect(migration).toContain(
      'contaminated Stage-1 quote is immutable evidence'
    );
    expect(migration).toContain("CHECK (orchestration_mode = 'AUTOMATED') NOT VALID");
    expect(migration).toContain(
      'CHECK (business_fulfiller_organization_id IS NULL) NOT VALID'
    );

    for (const trigger of [
      'stage1_feature_flag_key_writer_containment',
      'stage1_retired_relation_row_containment',
      'stage1_retired_relation_truncate_containment',
      'stage1_quote_authority_containment',
      'stage1_quote_authority_delete_containment',
      'stage1_quote_evidence_truncate_containment',
      'stage1_task_authority_containment',
      'stage1_task_evidence_truncate_containment',
      'escrow_payout_provider_evidence_gate',
    ]) {
      expect(migration).toContain(`ENABLE ALWAYS TRIGGER ${trigger}`);
    }
    expect(migration).toContain('v_stage1_task_column_count = 1');
    expect(migration).toContain(
      'partial Stage-1 task authority schema requires explicit adjudication'
    );
    expect(migration).toContain(
      'v_stage1_quote_column_count BETWEEN 1 AND 3'
    );
    expect(migration).toContain(
      'partial Stage-1 quote authority schema requires explicit adjudication'
    );
  });

  it('restores the worker-only assignment and payout gates with no Stage-1 exception', () => {
    expect(migration).toContain('DROP FUNCTION IF EXISTS public.enforce_controlled_test_business_acceptance()');
    for (const trigger of [
      'task_region_policy_accept_insert_gate',
      'task_region_policy_accept_gate',
      'task_worker_eligibility_accept_insert_gate',
      'task_worker_eligibility_accept_gate',
      'controlled_test_provider_capability_accept_guard',
      'controlled_test_offer_accept_guard',
      'task_liquidity_cell_accept_gate',
      'task_worker_offer_accept_gate',
      'escrow_payout_provider_evidence_gate',
    ]) {
      expect(migration).toContain(`CREATE TRIGGER ${trigger}`);
    }
    const payoutFunction = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.enforce_escrow_payout_provider_evidence'),
      migration.indexOf('DROP TRIGGER IF EXISTS escrow_payout_provider_evidence_gate')
    );
    expect(payoutFunction).toContain('hxos_local_test_payout_transfers');
    expect(payoutFunction).not.toContain('hxos_local_test_business_payout');
    expect(payoutFunction).not.toContain('OPS_MANUAL');
    expect(payoutFunction).toContain(
      "task_row.automation_classification IS DISTINCT FROM 'CONTROLLED_TEST'"
    );
    expect(payoutFunction).toContain(
      "NEW.provider_transfer_status IS DISTINCT FROM 'paid'"
    );
    expect(payoutFunction).toContain('NEW.provider_transfer_status IS NULL');
    expect(payoutFunction).toContain(
      "NEW.provider_transfer_status IS DISTINCT FROM 'manual_reconciliation'"
    );
  });

  it('does not move the intentionally frozen migration-138 upgrade witness', () => {
    expect(frozenUpgradeWitness).toContain(
      'count(*)=138 AND count(DISTINCT name)=138'
    );
    expect(frozenUpgradeWitness).toContain(
      "name='20261004_universal_v1_completion_notice_dispatch_v1'"
    );
    expect(frozenUpgradeWitness).not.toContain(
      '20261005_universal_v1_occurrence_access_audit_v1'
    );
    expect(frozenUpgradeWitness).not.toContain(
      '20261006_stage1_legacy_authority_containment_v1'
    );
  });
});
