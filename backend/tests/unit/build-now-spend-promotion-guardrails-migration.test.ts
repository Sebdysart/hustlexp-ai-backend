import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

const migration = source(
  'backend/database/migrations/20260721_build_now_spend_promotion_guardrails.sql',
);
const harness = source(
  'backend/tests/integration/build-now-spend-promotion-guardrails.pg.sql',
);
const runner = [
  source('backend/src/jobs/engine-automation-migration.ts'),
  source('backend/src/jobs/engine-automation-migration-files.ts'),
].join('\n');

describe('Build-Now spend and promotion database guardrails', () => {
  it('sets prospective incentive defaults to zero and rejects cash-spend transitions', () => {
    expect(migration).toContain('ALTER COLUMN referrer_reward_cents SET DEFAULT 0');
    expect(migration).toContain('ALTER COLUMN referred_reward_cents SET DEFAULT 0');
    expect(migration).toContain('HXINC1: cash referral incentives are disabled');
    expect(migration).toContain('HXINC2: cash challenge incentives are disabled');
  });

  it('preserves history while deactivating and rejecting paid promotion', () => {
    expect(migration).toContain('UPDATE featured_listings SET active=FALSE');
    expect(migration).toContain('HXPROMO1: paid task promotion is disabled');
    expect(migration).toContain('BEFORE INSERT OR UPDATE ON featured_listings');
  });

  it('is startup-ordered and ships an executable bypass harness', () => {
    expect(runner).toContain('BUILD_NOW_SPEND_PROMOTION_GUARDRAILS_MIGRATION');
    expect(runner).toContain('20260721_build_now_spend_promotion_guardrails.sql');
    expect(harness).toContain('cash referral incentive unexpectedly succeeded');
    expect(harness).toContain('cash challenge incentive unexpectedly succeeded');
    expect(harness).toContain('paid promotion insert unexpectedly succeeded');
    expect(harness).toContain('BUILD_NOW_SPEND_PROMOTION_GUARDRAILS_DATABASE_CONTRACT_OK');
  });
});
