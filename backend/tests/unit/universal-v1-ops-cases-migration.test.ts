import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const migration = read('backend/database/migrations/20260930_universal_v1_ops_cases_v1.sql');
const service = read('backend/src/services/UniversalV1OpsCaseService.ts');
const router = read('backend/src/routers/operations.ts');

describe('Universal V1 authoritative Operations cases migration', () => {
  it('binds each case to one exact immutable occurrence and aggregate version', () => {
    expect(migration).toContain(
      'occurrence_id UUID NOT NULL UNIQUE\n    REFERENCES public.major_action_events(id) ON DELETE RESTRICT'
    );
    expect(migration).toContain('occurrence_event_name TEXT NOT NULL');
    expect(migration).toContain('occurrence_version INTEGER NOT NULL');
    expect(migration).toContain('aggregate_kind TEXT NOT NULL');
    expect(migration).toContain('aggregate_id TEXT NOT NULL');
    expect(migration).toContain('aggregate_version BIGINT NOT NULL');
    expect(migration).toContain('HXUOC5: occurrence aggregate binding or version mismatched');
    expect(migration).toContain('v_occurrence.source_sequence');
  });

  it('allows only sequential expected-version case transitions', () => {
    for (const status of ['OPEN', 'ACKNOWLEDGED', 'CONTAINED', 'RESOLVED']) {
      expect(migration).toContain(`'${status}'`);
    }
    expect(migration).toContain("OLD.status = 'OPEN' AND NEW.status = 'ACKNOWLEDGED'");
    expect(migration).toContain("OLD.status = 'ACKNOWLEDGED' AND NEW.status = 'CONTAINED'");
    expect(migration).toContain("OLD.status = 'CONTAINED' AND NEW.status = 'RESOLVED'");
    expect(migration).toContain('NEW.version <> OLD.version + 1');
    expect(migration).toContain('case_expected_version BIGINT NOT NULL');
  });

  it('requires independent admin approval for containment and resolution', () => {
    expect(migration).toContain("transition_kind IN ('CONTAIN', 'RESOLVE')");
    expect(migration).toContain('CHECK (requested_by IS DISTINCT FROM decided_by)');
    expect(migration).toContain(
      'HXUOC16: a transition requester cannot approve or reject their own request'
    );
    expect(migration).toContain('assert_universal_v1_ops_case_operator_v1(NEW.decided_by, TRUE)');
    expect(migration).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(migration).toContain(
      'approved containment must transition its exact case before commit'
    );
    expect(migration).toContain('approved resolution must transition its exact case before commit');
  });

  it('keeps the timeline and observation audit append-only and server-only', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.universal_v1_ops_case_timeline');
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS public.universal_v1_ops_case_access_audit'
    );
    expect(migration).toContain('HXUOC19: Operations case evidence is append-only');
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON public.%I');
    for (const table of [
      'universal_v1_ops_cases',
      'universal_v1_ops_case_transition_requests',
      'universal_v1_ops_case_timeline',
      'universal_v1_ops_case_access_audit',
    ]) {
      expect(migration).toContain(`REVOKE ALL ON TABLE public.${table} FROM PUBLIC`);
    }
  });

  it('contains no arbitrary business-lifecycle write target', () => {
    const writeTargets = new Set(
      [
        ...migration.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\.([a-z0-9_]+)/gi),
      ].map((match) => match[1])
    );
    expect([...writeTargets].sort()).toEqual([
      'universal_v1_ops_case_timeline',
      'universal_v1_ops_case_transition_requests',
      'universal_v1_ops_cases',
    ]);
    for (const forbidden of [
      'tasks',
      'task_drafts',
      'task_work_orders',
      'task_assignments',
      'escrows',
      'task_financial_operations',
      'financial_provider_command_journal',
    ]) {
      expect(writeTargets.has(forbidden)).toBe(false);
    }
  });

  it('uses the existing named-identity, MFA step-up, and Operations RBAC boundary', () => {
    expect(service).toContain('requireFreshOperatorIdentity(context)');
    expect(service).toContain('assert_universal_v1_ops_case_operator_v1');
    expect(router).toContain('operationsAdminProcedure');
    expect(router).toContain('openUniversalV1Case');
    expect(router).toContain('decideUniversalV1CaseTransition');
    expect(service).toContain('INSERT INTO public.universal_v1_ops_case_access_audit');
  });

  it('states the shared-runtime caller-attestation limitation without weakening case guards', () => {
    expect(migration).toContain(
      'shared runtime login does not let PostgreSQL attest that p_actor_id is the'
    );
    expect(service).toContain('databaseCallerIdentityAttested: false');
    expect(service).toContain("directFunctionInvocation: 'HELD_PENDING_DEDICATED_COMMAND_ROLE'");
    expect(service).toContain('applicationNamedIdentityRequired: true');
    expect(service).toContain('databaseRoleRechecked: true');
  });
});
