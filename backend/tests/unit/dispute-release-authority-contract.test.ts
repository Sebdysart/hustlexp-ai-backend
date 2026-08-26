import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const BASELINE = read('backend/database/constitutional-schema.sql');
const MIGRATION = read(
  'backend/database/migrations/20260720_dispute_release_authority_contract.sql'
);
const CONTAINMENT = read(
  'backend/database/migrations/20260825_pr276_incident_containment.sql'
);
const RUNNER = [
  read('backend/src/jobs/engine-automation-migration.ts'),
  read('backend/src/jobs/engine-automation-migration-files.ts'),
].join('\n');
const DOCKERFILE = read('Dockerfile');
const HARNESS = read('backend/tests/integration/dispute-release-authority.pg.sql');
const CONTAINMENT_RUNNER = read('scripts/verify-pr276-incident-containment-postgres.mjs');

describe('dispute release authority contract', () => {
  it('supersedes the historical boolean override with fail-closed D1 containment', () => {
    for (const source of [BASELINE, MIGRATION]) {
      expect(source).toContain("OLD.state = 'LOCKED_DISPUTE' AND NEW.state = 'RELEASED'");
      expect(source).toContain("state = 'RESOLVED'");
      expect(source).toContain("outcome_escrow_action = 'RELEASE'");
      expect(source).toContain("current_setting('hustlexp.dispute_release_override', true)");
      expect(source).toContain('HX002: Cannot release dispute-locked escrow');
    }
    expect(CONTAINMENT).not.toContain(
      "current_setting('hustlexp.dispute_release_override', true)"
    );
    expect(CONTAINMENT).toContain(
      'requires exact current dispute and provider release authority'
    );
    expect(CONTAINMENT).toContain('provider_transfer_status_authority_v1');
    expect(CONTAINMENT).toContain(
      "current_setting('hustlexp.dispute_release_restore_authority', true)"
    );
    expect(CONTAINMENT).toContain('dispute_release_restore_authority_v1');
    expect(CONTAINMENT).toContain('jsonb_object_length(event.metadata)=15');
    expect(CONTAINMENT).toContain(
      "(to_jsonb(NEW)-'state'-'version'-'updated_at')"
    );
    expect(CONTAINMENT).toContain(
      'OLD.amount-OLD.platform_fee_cents-ROUND(OLD.amount*0.02)'
    );
    expect(CONTAINMENT).toContain(
      "'released-dispute-origin-v1:' || OLD.id::text || ':' || (OLD.version-1)::text"
    );
  });

  it('ships the forward migration through startup and the production image', () => {
    expect(RUNNER).toMatch(
      /DISPUTE_RELEASE_AUTHORITY_CONTRACT_MIGRATION\s*=\s*'20260720_dispute_release_authority_contract'/
    );
    expect(RUNNER).toContain("fileName: '20260720_dispute_release_authority_contract.sql'");
    expect(DOCKERFILE).toContain(
      'COPY --from=builder /app/backend/database/migrations ./backend/database/migrations'
    );
  });

  it('ships an isolated adversarial PostgreSQL harness', () => {
    expect(HARNESS).toContain('unresolved dispute release unexpectedly succeeded');
    expect(HARNESS).toContain('historical resolved dispute release unexpectedly succeeded');
    expect(HARNESS).toContain('boolean dispute release override unexpectedly succeeded');
    expect(HARNESS).toContain('terminal transfer identity rewrite unexpectedly succeeded');
    expect(HARNESS).toContain('exact provider-status authority must preserve terminal identity');
    expect(HARNESS).toContain('forged dispute restore authority unexpectedly succeeded');
    expect(HARNESS).toContain(
      'exact dispute restore must change only state, version, and timestamp without a second transfer'
    );
    expect(CONTAINMENT_RUNNER).toContain(
      "path.resolve('backend/tests/integration/dispute-release-authority.pg.sql')"
    );
    expect(HARNESS).toContain('DISPUTE_RELEASE_AUTHORITY_DATABASE_CONTRACT_OK');
    expect(HARNESS.trimEnd()).toMatch(/ROLLBACK;$/);
  });
});
