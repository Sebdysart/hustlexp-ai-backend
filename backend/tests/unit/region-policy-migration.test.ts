import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations/20260718_region_policy_contract.sql'),
  'utf8',
);

describe('versioned region policy database contract', () => {
  it('stores immutable versioned policy and append-only events', () => {
    expect(SQL).toContain('CREATE TABLE IF NOT EXISTS region_policies');
    expect(SQL).toContain('policy_hash CHAR(64)');
    expect(SQL).toContain('production_enabled BOOLEAN NOT NULL DEFAULT FALSE');
    expect(SQL).toContain('CREATE UNIQUE INDEX IF NOT EXISTS region_policies_one_active');
    expect(SQL).toContain('CREATE TABLE IF NOT EXISTS region_policy_events');
    expect(SQL).toContain('prevent_region_policy_event_mutation');
    expect(SQL).toContain('prevent_region_policy_mutation');
  });

  it('binds new tasks to exact policy identity and a complete domain snapshot', () => {
    for (const column of [
      'region_code', 'region_policy_id', 'region_policy_version', 'region_policy_hash',
      'region_policy_snapshot', 'trade_type', 'location_state', 'license_required',
      'insurance_required', 'background_check_required', 'proof_min_photos',
      'proof_max_photos', 'proof_gps_required',
    ]) expect(SQL).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    expect(SQL).toContain('enforce_task_region_policy_binding');
    expect(SQL).toContain("NEW.automation_classification = 'PRODUCTION'");
    expect(SQL).toContain('production policy is not approved');
    expect(SQL).toContain('region policy snapshot mismatch');
    expect(SQL).toContain('region policy binding is immutable');
  });

  it('fails acceptance closed for unbound tasks and missing policy credentials', () => {
    expect(SQL).toContain('enforce_task_region_policy_on_accept');
    expect(SQL).toContain('accepted task has no region policy binding');
    expect(SQL).toContain('background check required by region policy');
    expect(SQL).toContain('insurance required by region policy');
    expect(SQL).toContain('license required by region policy');
  });

  it('seeds only a test-only Washington policy pending counsel approval', () => {
    expect(SQL).toContain("'US-WA'");
    expect(SQL).toContain("'us-wa-launch-2026-07-18-v1'");
    expect(SQL).toContain("'moving'");
    expect(SQL).toContain("'yard'");
    expect(SQL).toContain("'cleaning'");
    expect(SQL).toMatch(/production_enabled[\s\S]*FALSE/);
    expect(SQL).toContain('COUNSEL_APPROVAL_REQUIRED');
  });
});
