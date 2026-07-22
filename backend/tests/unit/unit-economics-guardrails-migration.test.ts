import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

const migration = source(
  'backend/database/migrations/20260721_unit_economics_guardrails.sql',
);
const runner = source('backend/src/jobs/engine-automation-migration.ts');

describe('HX/OS unit-economics database guardrails', () => {
  it('requires versioned worker-earnings policy and mature-category evidence', () => {
    for (const invariant of [
      'minimum_provider_net_hourly_cents',
      'provider_earnings_policy_version',
      'provider_earnings_policy_state',
      'provider_earnings_policy_reference',
      'provider_earnings_sample_size',
      'average_provider_net_hourly_cents',
      'provider_earnings_sample_size >= 30',
      'average_provider_net_hourly_cents >= minimum_provider_net_hourly_cents',
    ]) expect(migration).toContain(invariant);
  });

  it('binds accept-ready offers to travel-adjusted economics and the exact cell policy', () => {
    for (const invariant of [
      "policy_version = 'hxos-worker-offer-v3'",
      'estimated_travel_time_minutes',
      'travel_time_policy_version',
      'minimum_net_hourly_cents',
      'provider_earnings_floor_met',
      'provider_earnings_policy_version',
      'HXWO4: worker offer lacks current provider economics',
      'HXLC8: provider earnings policy is not authorized',
      'HXLC9: mature cell provider earnings are below policy',
    ]) expect(migration).toContain(invariant);
  });

  it('keeps controlled TEST economics explicitly hypothetical and production approval external', () => {
    expect(migration).toContain("provider_earnings_policy_state = 'TEST_HYPOTHESIS'");
    expect(migration).toContain("provider_earnings_policy_state = 'APPROVED'");
    expect(migration).toContain("provider_earnings_policy_reference");
    expect(migration).toContain("hxos-provider-economics-test-v1");
  });

  it('is ordered into the startup migration runner', () => {
    expect(runner).toContain('UNIT_ECONOMICS_GUARDRAILS_MIGRATION');
    expect(runner).toContain('20260721_unit_economics_guardrails.sql');
  });
});
