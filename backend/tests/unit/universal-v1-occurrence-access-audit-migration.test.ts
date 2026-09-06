import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const migration = read(
  'backend/database/migrations/20261005_universal_v1_occurrence_access_audit_v1.sql'
);

describe('Universal V1 purpose-bound Operations occurrence access audit migration', () => {
  it('preserves append-only ordinals 138-142 in exact order', () => {
    expect(REQUIRED_MIGRATION_FILES).toHaveLength(146);
    expect(REQUIRED_MIGRATION_FILES[137]).toEqual({
      name: '20261004_universal_v1_completion_notice_dispatch_v1',
      fileName: '20261004_universal_v1_completion_notice_dispatch_v1.sql',
    });
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
  });

  it('binds one exact Operations projection digest to a named operator and purpose', () => {
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS public.universal_v1_occurrence_access_audit'
    );
    expect(migration).toContain("CHECK (projection_perspective = 'OPERATIONS')");
    expect(migration).toContain('CHECK (projection_contract_version = 1)');
    expect(migration).toContain('REFERENCES public.task_drafts(id) ON DELETE RESTRICT');
    expect(migration).toContain('REFERENCES public.users(id) ON DELETE RESTRICT');
    expect(migration).toContain('char_length(purpose) BETWEEN 10 AND 500');
    expect(migration).toContain("projection_sha256 ~ '^[a-f0-9]{64}$'");
    expect(migration).toContain('assert_universal_v1_ops_case_operator_v1');
    expect(migration).toContain('NEW.actor_role IS DISTINCT FROM v_current_role');
    expect(migration).toContain('NEW.observed_at := clock_timestamp()');
  });

  it('makes update, delete, and truncate impossible and removes ambient access', () => {
    expect(migration).toContain(
      'BEFORE UPDATE OR DELETE ON public.universal_v1_occurrence_access_audit'
    );
    expect(migration).toContain(
      'BEFORE TRUNCATE ON public.universal_v1_occurrence_access_audit'
    );
    expect(migration).toContain(
      'HXUVOA3: Universal V1 occurrence access evidence is append-only'
    );
    expect(migration).toContain(
      'REVOKE ALL ON TABLE public.universal_v1_occurrence_access_audit FROM PUBLIC'
    );
    expect(migration).toContain("ARRAY['anon', 'authenticated']");
  });

  it('adds no lifecycle, assignment, address, provider, or financial writer', () => {
    const writeTargets = [
      ...migration.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\.([a-z0-9_]+)/giu),
    ].map((match) => match[1]);
    expect(writeTargets).toEqual([]);
    for (const forbidden of [
      'task_work_orders',
      'task_assignments',
      'task_financial_operations',
      'task_financial_security_events',
      'escrows',
    ]) {
      expect(migration).not.toMatch(new RegExp(`(?:INSERT|UPDATE|DELETE)[\\s\\S]{0,80}${forbidden}`, 'iu'));
    }
  });
});
