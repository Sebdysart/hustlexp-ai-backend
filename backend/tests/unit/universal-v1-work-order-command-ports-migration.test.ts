import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';
import { CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES } from '../../src/jobs/nonproduction-fake-financial-execution.js';

const fileName = '20261014_universal_v1_work_order_command_ports_v1.sql';
const migration = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations', fileName),
  'utf8'
);
const v12FileName =
  '20261015_universal_v1_work_order_fake_financial_authority_hardening_v12.sql';
const v12Migration = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations', v12FileName),
  'utf8'
);
const sealFileName = '20261015_universal_v1_work_order_bootstrap_seal_v1.sql';
const sealMigration = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations', sealFileName),
  'utf8'
);
const migrationSha256 = createHash('sha256').update(migration, 'utf8').digest('hex');
const humanFunctions = [
  'hxos_express_universal_v1_post_estimate_interest_v1',
  'hxos_place_universal_v1_conditional_hold_v1',
  'hxos_prepare_universal_v1_fake_work_order_v1',
  'hxos_materialize_universal_v1_fake_work_order_v1',
  'hxos_request_universal_v1_fake_work_order_recovery_v1',
] as const;

function definition(name: string, next: string): string {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const end = migration.indexOf(next, start);
  expect(start, `${name} start`).toBeGreaterThanOrEqual(0);
  expect(end, `${name} end`).toBeGreaterThan(start);
  return migration.slice(start, end);
}

describe('Universal V1 Work Order command ports migration', () => {
  it('is exact engine ordinal 146 after the unchanged actor kernel', () => {
    expect(REQUIRED_MIGRATION_FILES).toHaveLength(146);
    expect(REQUIRED_MIGRATION_FILES[144]?.name).toBe(
      '20261012_universal_v1_work_order_command_authority_v2'
    );
    expect(REQUIRED_MIGRATION_FILES[145]).toEqual({
      name: '20261014_universal_v1_work_order_command_ports_v1',
      fileName,
    });
    expect(CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES[11]).toEqual({
      name: '20261015_universal_v1_work_order_fake_financial_authority_hardening_v12',
      fileName: v12FileName,
      evidenceTable: 'hxos_fake_financial_schema_evidence_v12',
    });
    expect(CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES[12]).toEqual({
      name: '20261015_universal_v1_work_order_bootstrap_seal_v1',
      fileName: sealFileName,
      evidenceTable: 'hxos_work_order_bootstrap_seal_evidence_v1',
    });
    expect(CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES[13]).toEqual({
      name: '20261016_universal_v1_fake_financial_command_outbox_authority_v13',
      fileName: '20261016_universal_v1_fake_financial_command_outbox_authority_v13.sql',
      evidenceTable: 'hxos_fake_financial_schema_evidence_v13',
    });
  });

  it('pins ordinal146 and every v1-v11 receipt before collision-creating v12 evidence', () => {
    expect(v12Migration.match(new RegExp(migrationSha256, 'gu'))).toHaveLength(3);
    for (let version = 1; version <= 11; version += 1) {
      expect(v12Migration).toContain(`public.hxos_fake_financial_schema_evidence_v${version}`);
    }
    expect(v12Migration).toContain(
      'HXUV1-WOCMD-V12-2: fake-finance evidence relation is absent or unsafe'
    );
    expect(v12Migration).toContain(
      'HXUV1-WOCMD-V12-2: exact fake-finance v1-v11 checksum/evidence chain is required'
    );
    expect(v12Migration).toContain(
      'CREATE TABLE public.hxos_fake_financial_schema_evidence_v12 ('
    );
    expect(v12Migration).not.toContain(
      'CREATE TABLE IF NOT EXISTS public.hxos_fake_financial_schema_evidence_v12'
    );
    expect(v12Migration).toContain('trigger_count <> 164');
    expect(v12Migration).toContain(
      '9b1befa40b2b2f377fa3323457e333be77f6e5f2c1d6107c871856cca2838dae'
    );
    expect(v12Migration).toContain(
      '18999ff352af8758d77cdca5b4857e5f0ce36acb3e4ccfbf8eb6bff73169b0f2'
    );
    expect(v12Migration).toContain('trigger_count <> 167');
    expect(v12Migration).toContain(
      'f9f21a5c97f88b6eed26d5e1cfe36bb25463f06cb9a769a713642c07a3c7e441'
    );
    expect(v12Migration).toContain(
      'ALTER FUNCTION public.enforce_task_region_policy_binding()'
    );
    expect(v12Migration).toContain(
      'ALTER FUNCTION public.hxos_reject_fake_financial_mutation_v1()'
    );
    expect(v12Migration).not.toMatch(/^\s*(?:CREATE|ALTER)\s+ROLE\b|^\s*GRANT\b/imu);
    expect(sealMigration).toContain(migrationSha256);
    expect(sealMigration).toContain(
      createHash('sha256').update(v12Migration, 'utf8').digest('hex')
    );
    expect(sealMigration).toContain('HXUV1-WOCMD-SEAL-4');
    expect(sealMigration).toContain(
      'CREATE TABLE public.hxos_work_order_bootstrap_seal_evidence_v1 ('
    );
    expect(sealMigration).toContain(
      'CREATE OR REPLACE FUNCTION hx_authority.assert_universal_v1_work_order_bootstrap_seal_v1()'
    );
    expect(sealMigration).not.toMatch(/^\s*(?:CREATE|ALTER)\s+ROLE\b|^\s*GRANT\b/imu);
  });

  it('binds one exact current database, isolated environment, and lowercase manifest digest', () => {
    expect(migration).toContain('universal_v1_work_order_target_authority_facts');
    expect(migration).toContain(
      "environment TEXT NOT NULL CHECK (environment IN ('local', 'preview', 'staging'))"
    );
    expect(migration).toContain("release_manifest_sha256 ~ '^sha256:[0-9a-f]{64}$'");
    expect(migration).toContain(
      'target_database_name IS DISTINCT FROM pg_catalog.current_database()'
    );
    expect(migration).toContain('IF target_count <> 1 THEN');
    expect(migration).toContain('target authority must extend the one current tip');
    expect(migration).toContain('release_manifest_sha256 =');
    expect(migration).toContain("'sha256:' || pg_catalog.repeat('0', 64)");
  });

  it('makes target and command facts append-only with exact no-effect evidence', () => {
    expect(migration).toContain('universal_v1_work_order_command_execution_facts');
    expect(migration).toContain('hard_assignment_created BOOLEAN NOT NULL DEFAULT FALSE');
    expect(migration).toContain('payment_creation_performed BOOLEAN NOT NULL DEFAULT FALSE');
    expect(migration).toContain('BEFORE UPDATE OR DELETE');
    expect(migration).toContain('BEFORE TRUNCATE');
    expect(migration).toContain('record_universal_v1_work_order_command_execution_v1');
  });

  it('separates the full canonical command digest from the immutable domain witness', () => {
    const prepare = definition(
      'hxos_prepare_universal_v1_fake_work_order_v1',
      'CREATE OR REPLACE FUNCTION public.hxos_materialize_universal_v1_fake_work_order_v1('
    );
    expect(migration).toContain(
      'ADD COLUMN IF NOT EXISTS canonical_command_request_sha256 CHAR(64)'
    );
    expect(prepare).toContain('request.canonical_command_request_sha256::TEXT');
    expect(prepare).toContain(
      'prior.canonical_command_request_sha256 IS DISTINCT FROM'
    );
    expect(prepare).toContain('request_authority.canonical_request_sha256');
    expect(prepare).toContain('witness_sha256 :=');
    expect(prepare).toContain('request_sha256,\n      canonical_command_request_sha256,');
    expect(prepare).toContain('live.eligibility_version');
    expect(migration).toContain(
      'HXUV1-WOCMD-21: conditional-hold idempotency payload changed'
    );
    expect(migration).toContain(
      "execution.command_kind = 'EXPRESS_POST_ESTIMATE_INTEREST'"
    );
    expect(migration).toContain("execution.command_kind = 'PLACE_CONDITIONAL_HOLD'");
    expect(migration).toContain(
      'execution.canonical_request_sha256 IS DISTINCT FROM\n             request_authority.canonical_request_sha256'
    );
  });

  it('requires exact SUCCEEDED fake provider, outcome, bridge, and event state', () => {
    for (const name of [
      'hxos_materialize_universal_v1_fake_work_order_v1',
      'hxos_request_universal_v1_fake_work_order_recovery_v1',
    ]) {
      const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
      const end = migration.indexOf('END;\n$$;', start);
      const body = migration.slice(start, end);
      expect(body).toContain("bridge.fake_provider_state = 'SUCCEEDED'");
      expect(body).toContain("outcome.provider_state = 'SUCCEEDED'");
      expect(body).toContain("event.evidence->>'providerState' = 'SUCCEEDED'");
      expect(body).toContain('bridge.task_draft_id =');
      expect(body).toContain('bridge.eligibility_decision_id =');
      expect(body).toContain('bridge.scope_version_id =');
      expect(body).toContain('bridge.amount_cents =');
      expect(body).toContain('bridge.currency =');
    }
  });

  it('revalidates mutable actor and provider authority after every lock boundary', () => {
    expect(migration).toContain('HXUV1-WOCMD-13: post-lock provider authority was revoked');
    expect(migration).toContain('HXUV1-WOCMD-23: post-lock conditional-hold authority was revoked');
    expect(migration).toContain('HXUV1-WOCMD-34: post-lock Work Order preparation authority was revoked');
    expect(migration).toContain('HXUV1-WOCMD-48: post-lock Work Order materialization authority was revoked');
    expect(migration).toContain('HXUV1-WOCMD-56: post-lock recovery actor authority was revoked');
    expect(migration.match(/poster\.account_status = 'ACTIVE'/gu)).toHaveLength(6);
    expect(migration).toContain('PERFORM public.lock_universal_v1_estimate_authority(');
  });

  it('fails closed on exact trigger-catalog drift and hardens only an explicit allowlist', () => {
    expect(migration).toContain('trigger_count = 150');
    expect(migration).toContain('trigger_count = 155');
    expect(migration).toContain('trigger_count = 159');
    expect(migration).toContain(
      'b1fcae11d1808bb54317a8167b7d0c28cff6a9be3732f0a0cb33ef6a2283fa98'
    );
    expect(migration).toContain(
      '4e3b52f487d85a7ed0bdf806925f65fdeb9806184c90ac4f5d9514a41061915b'
    );
    expect(migration).toContain(
      'ed38b20dc0a54b330f3d9191291c2a3ee4a53453e5256f38efac1f03b0856cc6'
    );
    expect(migration).not.toContain(
      '41ccdc662d5a7f888abbbcf187c418088f0e0e13f3449a152ac69b988e71b372'
    );
    expect(migration).toContain('fake_financial_surface_marker_count NOT IN (0, 19)');
    expect(migration).toContain(
      'HXUV1-WOCMD-0C: future v12 evidence must be absent before ordinal146 installs or replays'
    );
    expect(migration).toContain('HXUV1-WOCMD-0A: partial Work Order authority trigger surface');
    expect(migration).toContain('HXUV1-WOCMD-0A: Work Order trigger catalog mismatch');
    expect(migration).toContain("|| '|' || function_state.prosrc AS line");
    expect(migration).toContain("|| '|' || trigger_state.tgenabled::TEXT");
    expect(migration).toContain("|| '|' || function_state.prorettype::pg_catalog.regtype::TEXT");
    expect(migration).toContain("'public.enforce_universal_eligibility_sequence()'");
    expect(migration).toContain("'public.bind_universal_work_order_to_task()'");
    expect(migration).toContain(
      'ALTER FUNCTION public.enforce_universal_v1_work_order_execution_genesis()\n  SECURITY DEFINER'
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.enforce_universal_v1_work_order_execution_genesis()'
    );
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.enforce_universal_active_scope_transition()'
    );
    expect(migration).toContain(
      'OLD.active_scope_version_id IS NOT DISTINCT FROM\n           NEW.active_scope_version_id'
    );
    expect(migration).toContain("'public.freeze_universal_v1_work_order_task_projection_v1()'");
    for (const relation of [
      'hx_authority.universal_v1_actor_assertion_issuance_facts',
      'hx_authority.universal_v1_actor_assertion_consumption_facts',
      'hx_authority.universal_v1_work_order_target_authority_facts',
      'hx_authority.universal_v1_work_order_command_execution_facts',
      'public.task_drafts',
      'public.provider_estimate_submissions',
      'public.task_routing_decisions',
      'public.financial_provider_command_journal',
      'public.task_financial_security_events',
      'public.major_action_events',
      'public.worker_offer_decisions',
    ]) {
      expect(migration).toContain(`'${relation}'`);
    }
    for (const telemetryFunction of [
      'public.mirror_major_action_source_event()',
      'public.mirror_worker_standing_appeal_major_action()',
      'public.record_major_action_event(',
      'public.record_major_action_outcome(',
    ]) {
      expect(migration).toContain(telemetryFunction);
    }
    expect(migration).not.toContain('NEW.universal_contract_version IS DISTINCT FROM 1\n  )\n  EXECUTE FUNCTION public.mirror_major_action_source_event()');
    expect(migration).not.toMatch(
      /SELECT DISTINCT trigger_state\.tgfoid::pg_catalog\.regprocedure/iu
    );
  });

  it('installs all five human ports and one bounded worker port as sealed functions', () => {
    for (const name of [...humanFunctions, 'hxos_claim_universal_v1_work_order_compensation_v2']) {
      const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
      expect(start, name).toBeGreaterThanOrEqual(0);
      const body = migration.slice(start, migration.indexOf('$$;', start) + 3);
      expect(body).toContain('SECURITY DEFINER');
      expect(body).toContain('VOLATILE');
      expect(body).toContain('PARALLEL UNSAFE');
      expect(body).toContain('SET search_path = pg_catalog');
    }
  });

  it('derives every human actor from one exact consumed assertion', () => {
    const nextMarkers = [
      'CREATE OR REPLACE FUNCTION public.hxos_place_universal_v1_conditional_hold_v1(',
      'CREATE OR REPLACE FUNCTION public.hxos_prepare_universal_v1_fake_work_order_v1(',
      'CREATE OR REPLACE FUNCTION public.hxos_materialize_universal_v1_fake_work_order_v1(',
      '-- Migration SQL never creates roles',
      'CREATE OR REPLACE FUNCTION public.hxos_claim_universal_v1_work_order_compensation_v2(',
    ];
    for (const [index, name] of humanFunctions.entries()) {
      const body = definition(name, nextMarkers[index]!);
      expect(body).toContain('hx_authority.consume_universal_v1_actor_assertion_v1');
      expect(body).toContain('actor_authority.resolved_user_id');
      expect(body).not.toMatch(/current_setting\s*\([^)]*actor/iu);
      expect(body).not.toMatch(/\bEXECUTE\b/iu);
    }
  });

  it('separates interest, hold, preparation, materialization, and recovery state changes', () => {
    expect(definition(humanFunctions[0], 'CREATE OR REPLACE FUNCTION public.hxos_place')).toContain(
      'INSERT INTO public.task_applications'
    );
    expect(
      definition(humanFunctions[1], 'CREATE OR REPLACE FUNCTION public.hxos_prepare')
    ).toContain('INSERT INTO public.task_reservations');
    expect(
      definition(humanFunctions[2], 'CREATE OR REPLACE FUNCTION public.hxos_materialize')
    ).toContain('INSERT INTO public.task_work_order_command_requests');
    expect(definition(humanFunctions[3], '-- Migration SQL never creates roles')).toContain(
      'INSERT INTO public.task_work_orders'
    );
    expect(definition(humanFunctions[4], 'CREATE OR REPLACE FUNCTION public.hxos_claim')).toContain(
      'INSERT INTO public.universal_v1_work_order_compensation_commands'
    );
  });

  it('revokes PUBLIC execution and protected DML without creating roles or runtime grants', () => {
    for (const name of [...humanFunctions, 'hxos_claim_universal_v1_work_order_compensation_v2']) {
      expect(migration).toMatch(new RegExp(`REVOKE ALL ON FUNCTION\\s+public\\.${name}\\(`, 'u'));
    }
    expect(migration).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE');
    expect(migration).not.toMatch(/\bCREATE\s+ROLE\b/iu);
    expect(migration).not.toMatch(/\bGRANT\s+(?:EXECUTE|INSERT|UPDATE|DELETE|TRUNCATE)\b/iu);
  });

  it('contains only synthetic fake-finance checks and no money or assignment enablement', () => {
    expect(migration).toContain("provider_kind = 'FAKE'");
    expect(migration).toContain("universal_payment_posture = 'PAYMENT_CREATION_FROZEN'");
    expect(migration).toContain('hard assignment is forbidden');
    expect(migration).not.toMatch(/live_secret|APPROVED_PROVIDER/iu);
  });
});
