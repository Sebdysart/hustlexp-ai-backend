import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const BASELINE = read('backend/database/constitutional-schema.sql');
const MIGRATION = read(
  'backend/database/migrations/20260720_dispute_release_authority_contract.sql'
);
const RUNNER = [
  read('backend/src/jobs/engine-automation-migration.ts'),
  read('backend/src/jobs/engine-automation-migration-files.ts'),
].join('\n');
const DOCKERFILE = read('Dockerfile');
const HARNESS = read('backend/tests/integration/dispute-release-authority.pg.sql');

describe('dispute release authority contract', () => {
  it('requires a resolved worker-favor decision or attributable override at the database boundary', () => {
    for (const source of [BASELINE, MIGRATION]) {
      expect(source).toContain("OLD.state = 'LOCKED_DISPUTE' AND NEW.state = 'RELEASED'");
      expect(source).toContain("state = 'RESOLVED'");
      expect(source).toContain("outcome_escrow_action = 'RELEASE'");
      expect(source).toContain("current_setting('hustlexp.dispute_release_override', true)");
      expect(source).toContain('HX002: Cannot release dispute-locked escrow');
    }
  });

  it('ships the forward migration through startup and the production image', () => {
    expect(RUNNER).toMatch(
      /DISPUTE_RELEASE_AUTHORITY_CONTRACT_MIGRATION\s*=\s*'20260720_dispute_release_authority_contract'/
    );
    expect(RUNNER).toContain("fileName: '20260720_dispute_release_authority_contract.sql'");
    expect(DOCKERFILE).toContain(
      '/app/backend/database/migrations/20260720_dispute_release_authority_contract.sql'
    );
  });

  it('ships an isolated adversarial PostgreSQL harness', () => {
    expect(HARNESS).toContain('unresolved dispute release unexpectedly succeeded');
    expect(HARNESS).toContain('resolved worker-favor release was rejected');
    expect(HARNESS).toContain('administrator override release was rejected');
    expect(HARNESS).toContain('DISPUTE_RELEASE_AUTHORITY_DATABASE_CONTRACT_OK');
    expect(HARNESS.trimEnd()).toMatch(/ROLLBACK;$/);
  });
});
