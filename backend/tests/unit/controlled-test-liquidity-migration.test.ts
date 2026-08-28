import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(
  process.cwd(),
  'backend/database/migrations/20260720_controlled_test_liquidity_cell.sql',
), 'utf8');

describe('controlled TEST liquidity migration', () => {
  it('separates production and TEST cell identities at the schema boundary', () => {
    expect(sql).toContain("environment IN ('PRODUCTION','CONTROLLED_TEST')");
    expect(sql).toContain("environment = 'CONTROLLED_TEST' AND is_test IS TRUE");
    expect(sql).toContain("geo_zone ~ '^hxos-test-'");
    expect(sql).toContain("policy_version = 'hxos-local-certification-liquidity-v1'");
  });

  it('requires one non-public non-expanding provider and positive contribution', () => {
    expect(sql).toContain('active_verified_providers = 1');
    expect(sql).toContain('average_contribution_cents > 0');
    expect(sql).toContain('public_instant_requests_allowed IS FALSE');
    expect(sql).toContain('expansion_eligible IS FALSE');
    expect(sql).toContain('max_concurrent_dispatches = 1');
    expect(sql).toContain('no_production_coverage_claim');
  });

  it('binds the claimed provider to screening, payout, task, and cell evidence', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS hxos_local_test_liquidity_witnesses');
    expect(sql).toContain('background_check_id');
    expect(sql).toContain('payout_destination_id');
    expect(sql).toContain("background.provider_environment = 'CONTROLLED_TEST'");
    expect(sql).toContain("destination.status = 'ACTIVE'");
    expect(sql).toContain("escrow.state = 'FUNDED'");
  });

  it('requires transaction-local authority and keeps witnesses append-only', () => {
    expect(sql).toContain("current_setting('hustlexp.local_test_liquidity_enabled', TRUE) = 'true'");
    expect(sql).toContain('BEFORE UPDATE OR DELETE OR TRUNCATE');
    expect(sql).toContain('HXLQ7: local TEST liquidity witnesses are append-only');
  });

  it('blocks TEST cells from production binding, public reads, and expansion', () => {
    expect(sql).toContain('HXLQ9: TEST liquidity cannot authorize production work');
    expect(sql).toContain("environment = 'PRODUCTION' AND is_test IS FALSE");
    expect(sql).toContain('HXLC7: launch requires two or three green categories');
  });
});
