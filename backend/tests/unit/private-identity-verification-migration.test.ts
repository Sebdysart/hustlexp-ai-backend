import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(
  process.cwd(),
  'backend/database/migrations/20260721_private_identity_verification_contract.sql',
), 'utf8');

describe('private identity verification migration', () => {
  it('stores provider evidence without documents, selfies, raw payloads, or public URLs', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS identity_verification_consents');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS identity_verification_cases');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS identity_verification_events');
    expect(sql).not.toMatch(/document_url|selfie_url|raw_payload|public_url/i);
    expect(sql).toContain('evidence_hash CHAR(64)');
  });

  it('makes provider evidence the only writer of the verification projection', () => {
    expect(sql).toContain('users_identity_verification_projection_guard');
    expect(sql).toContain('HXIDV2: identity verification projection is provider-owned');
    expect(sql).toContain('record_identity_verification_event_v1');
    expect(sql).toContain("set_config('hustlexp.identity_projection_writer', 'true', TRUE)");
    expect(sql).toContain("set_config('hustlexp.identity_projection_writer', 'false', TRUE)");
  });

  it('separates controlled TEST identity from production authorization', () => {
    expect(sql).toContain("provider_environment IN ('PRODUCTION','CONTROLLED_TEST')");
    expect(sql).toContain("provider = 'local_certification_identity'");
    expect(sql).toContain('identity_verification_is_current_v1');
    expect(sql).toContain("NEW.automation_classification = 'CONTROLLED_TEST'");
    expect(sql).toContain('HXIDV20: assigned worker lacks current % identity evidence');
    expect(sql).toContain('HXIDV21: accept-ready offer lacks environment-matched identity evidence');
  });

  it('is append-only, replay-safe, consent-bound, expiring, and revocable', () => {
    expect(sql).toContain('BEFORE UPDATE OR DELETE OR TRUNCATE ON identity_verification_events');
    expect(sql).toContain('HXIDV9: identity provider event replay conflict');
    expect(sql).toContain('HXIDV10: identity provider event lacks current consent');
    expect(sql).toContain("p_to_status IN ('EXPIRED','REVOKED')");
    expect(sql).toContain('HXIDV17: identity evidence cannot expire before its recorded deadline');
  });

  it('is startup ordered and packaged', () => {
    const runner = [
      readFileSync(
        resolve(process.cwd(), 'backend/src/jobs/engine-automation-migration.ts'),
        'utf8',
      ),
      readFileSync(
        resolve(process.cwd(), 'backend/src/jobs/engine-automation-migration-files.ts'),
        'utf8',
      ),
    ].join('\n');
    const dockerfile = readFileSync(resolve(process.cwd(), 'Dockerfile'), 'utf8');
    expect(runner).toContain('20260721_private_identity_verification_contract');
    expect(dockerfile).toContain('20260721_private_identity_verification_contract.sql');
  });
});
