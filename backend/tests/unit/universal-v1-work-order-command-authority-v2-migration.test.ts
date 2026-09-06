import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';

const fileName = '20261012_universal_v1_work_order_command_authority_v2.sql';
const migration = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations', fileName),
  'utf8'
);

function functionDefinition(signature: string, nextMarker: string): string {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION ${signature}`);
  const end = migration.indexOf(nextMarker, start);
  expect(start, `${signature} start`).toBeGreaterThanOrEqual(0);
  expect(end, `${signature} end`).toBeGreaterThan(start);
  return migration.slice(start, end);
}

describe('Universal V1 Work Order command authority v2 actor-assertion kernel', () => {
  it('remains exact append-only engine ordinal 145 before the sealed ports', () => {
    expect(REQUIRED_MIGRATION_FILES).toHaveLength(146);
    expect(REQUIRED_MIGRATION_FILES[143]).toEqual({
      name: '20261010_universal_v1_financial_security_event_expiry_v1',
      fileName: '20261010_universal_v1_financial_security_event_expiry_v1.sql',
    });
    expect(REQUIRED_MIGRATION_FILES[144]).toEqual({
      name: '20261012_universal_v1_work_order_command_authority_v2',
      fileName,
    });
    expect(REQUIRED_MIGRATION_FILES[145]).toEqual({
      name: '20261014_universal_v1_work_order_command_ports_v1',
      fileName: '20261014_universal_v1_work_order_command_ports_v1.sql',
    });
  });

  it('persists only the token digest and closed verified authentication facts', () => {
    expect(migration).toContain('CREATE SCHEMA IF NOT EXISTS hx_authority');
    expect(migration).toContain('universal_v1_actor_assertion_issuance_facts');
    expect(migration).toContain('universal_v1_actor_assertion_consumption_facts');
    expect(migration).toContain("token_sha256 ~ '^[0-9a-f]{64}$'");
    expect(migration).toContain("public.digest(opaque_token, 'sha256')");
    expect(migration).toContain("public.digest(verified_auth_facts::TEXT, 'sha256')");
    expect(migration).toContain("'verified_subject'");
    expect(migration).toContain("'revocation_checked_at'");
    expect(migration).toContain("'release_manifest_sha256'");
    expect(migration).toContain("release_manifest_sha256 ~ '^sha256:[0-9a-f]{64}$'");
    expect(migration).toContain("'mfa_verified'");
    expect(migration).toContain("'step_up'");

    const issuanceTable = migration.slice(
      migration.indexOf(
        'CREATE TABLE IF NOT EXISTS hx_authority.universal_v1_actor_assertion_issuance_facts'
      ),
      migration.indexOf(
        'CREATE TABLE IF NOT EXISTS hx_authority.universal_v1_actor_assertion_consumption_facts'
      )
    );
    expect(issuanceTable).not.toMatch(/\bopaque_token\b/u);
    expect(issuanceTable).not.toMatch(/\bactor_(?:id|uuid)\b/iu);
  });

  it('uses database-owned time and enforces at most exactly sixty seconds', () => {
    expect(migration).toContain("expires_at <= issued_at + INTERVAL '60 seconds'");
    expect(migration).toContain('expires_at <= bearer_expires_at');
    expect(migration).toContain('database_now := pg_catalog.clock_timestamp()');
    expect(migration).toContain("database_now + INTERVAL '60 seconds'");
    expect(migration).toContain("verified_at >= issued_at - INTERVAL '60 seconds'");
    expect(migration).toContain("revocation_checked_at >= issued_at - INTERVAL '60 seconds'");
    expect(migration).not.toContain('NOW()');
    expect(migration).not.toContain('CURRENT_TIMESTAMP');
  });

  it('seals the exact issuer and internal consumer without installing a runtime grant', () => {
    const issuer = functionDefinition(
      'public.hxos_issue_universal_v1_actor_assertion_v1(',
      'CREATE OR REPLACE FUNCTION hx_authority.consume_universal_v1_actor_assertion_v1('
    );
    const consumer = functionDefinition(
      'hx_authority.consume_universal_v1_actor_assertion_v1(',
      'REVOKE ALL ON TABLE'
    );
    for (const body of [issuer, consumer]) {
      expect(body).toContain('SECURITY DEFINER');
      expect(body).toContain('VOLATILE');
      expect(body).toContain('PARALLEL UNSAFE');
      expect(body).toContain('SET search_path = pg_catalog');
      expect(body).not.toContain('SET search_path = pg_catalog, public');
    }
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION\s+public\.hxos_issue_universal_v1_actor_assertion_v1\([\s\S]*?FROM PUBLIC/u
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION\s+hx_authority\.consume_universal_v1_actor_assertion_v1\([\s\S]*?FROM PUBLIC/u
    );
    expect(migration).not.toMatch(/^\s*GRANT\b/imu);
    expect(migration).not.toMatch(/\bTO CURRENT_USER\b/iu);
  });

  it('binds exact environment, kind, canonical jsonb digest, release, and policy facts', () => {
    expect(migration).toContain("environment IN ('local', 'preview', 'staging')");
    expect(migration).not.toMatch(/environment IN \([^)]*production/iu);
    expect(migration).toContain('canonical_request::TEXT');
    expect(migration).toContain(
      'issuance.canonical_request_sha256 IS DISTINCT FROM request_digest'
    );
    expect(migration).toContain(
      'issuance.release_manifest_sha256 IS DISTINCT FROM request_release_manifest'
    );
    expect(migration).toContain('issuance.environment IS DISTINCT FROM expected_environment');
    expect(migration).toContain('issuance.command_kind IS DISTINCT FROM expected_command_kind');
    expect(migration).toContain('mfa_required AND NOT issuance.mfa_verified');
    expect(migration).toContain('step_up_required AND NOT issuance.step_up_satisfied');
    expect(migration).toContain("'authentication_requirements'");
    expect(migration).toContain("'command_payload'");
    expect(migration).toContain('command payload may not carry actor or authority fields');
    expect(migration).not.toContain("current_setting('");
    expect(migration).not.toContain('set_config(');
  });

  it('maps the verified subject inside PostgreSQL and consumes exactly once under a row lock', () => {
    expect(migration).toContain('account.firebase_uid = issuance.verified_subject');
    expect(migration).toContain("pg_catalog.upper(account.account_status::TEXT) = 'ACTIVE'");
    expect(migration).toContain('COALESCE(account.is_minor, FALSE) IS FALSE');
    expect(migration).toContain('COALESCE(account.is_banned, FALSE) IS FALSE');
    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain('actor assertion has already been consumed');
    expect(migration).toContain(
      'CONSTRAINT universal_v1_actor_assertion_consumed_once_v2_uniq UNIQUE (assertion_id)'
    );
    expect(migration).toContain(
      'CONSTRAINT universal_v1_actor_assertion_consumed_token_v2_uniq UNIQUE (token_sha256)'
    );
  });

  it('makes issuance and consumption immutable and creates no held command or effect', () => {
    for (const triggerName of [
      'universal_v1_actor_assertion_issuance_no_mutation_v2',
      'universal_v1_actor_assertion_issuance_no_truncate_v2',
      'universal_v1_actor_assertion_consumption_no_mutation_v2',
      'universal_v1_actor_assertion_consumption_no_truncate_v2',
    ]) {
      expect(migration).toContain(`DROP TRIGGER IF EXISTS ${triggerName}`);
      expect(migration).toContain(`CREATE TRIGGER ${triggerName}`);
    }
    expect(migration).not.toMatch(
      /\b(?:INSERT INTO|UPDATE|DELETE FROM|TRUNCATE)\s+public\.(?:task_work_orders|task_work_order_command_requests|task_provider_eligibility_decisions|task_reservations|task_applications|task_financial_security_events)\b/iu
    );
    expect(migration).not.toMatch(/\b(?:PAYMENT_CREATION_MODE|Stripe|hard_assignment_created)\b/iu);
  });
});
