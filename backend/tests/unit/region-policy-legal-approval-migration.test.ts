import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const SQL = read(
  'backend/database/migrations/20260722_region_policy_legal_approval_activation.sql'
);
const HARNESS = read('backend/tests/integration/region-policy-legal-approval-activation.pg.sql');
const RUNNER = [
  read('backend/src/jobs/engine-automation-migration.ts'),
  read('backend/src/jobs/engine-automation-migration-files.ts'),
].join('\n');

describe('region policy legal approval activation contract', () => {
  it('persists one immutable hash-verified approval for the exact policy', () => {
    expect(SQL).toContain('CREATE TABLE IF NOT EXISTS region_policy_legal_approvals');
    expect(SQL).toContain("digest(NEW.approval_document::text, 'sha256')");
    expect(SQL).toContain('UNIQUE (region_policy_id)');
    expect(SQL).toContain('prevent_region_policy_legal_approval_mutation');
    expect(SQL).toContain('BEFORE UPDATE OR DELETE OR TRUNCATE');
  });

  it('validates jurisdiction, categories, release bindings, owners, dates, and evidence', () => {
    for (const token of [
      "'EXT-LEGAL-001'",
      "'jurisdiction_code'",
      "'APPROVED'",
      "'WA'",
      "'worker_classification'",
      "'category_licensing'",
      "'screening_and_adverse_action'",
      "'privacy_and_retention'",
      "'payments_payouts_and_tax'",
      "'disputes_arbitration_and_liability'",
      "'safety_location_and_recording'",
      'approved_revision',
      'deployed_revision',
      'review_at',
      'evidence',
    ])
      expect(SQL).toContain(token);
    expect(SQL).toContain('HXRPLA8: approval category scope does not match policy');
    expect(SQL).toContain('HXRPLA12: approved and deployed revisions must match');
  });

  it('allows only a one-way function-mediated production transition and event', () => {
    expect(SQL).toContain('activate_region_policy_with_legal_approval');
    expect(SQL).toContain("approval_state = 'COUNSEL_APPROVED'");
    expect(SQL).toContain('production_enabled = TRUE');
    expect(SQL).toContain('event_type, actor_id, policy_hash, public_reason');
    expect(SQL).toContain("'PRODUCTION_APPROVED'");
    expect(SQL).toContain('HXRP4: active or retired region policy is immutable');
  });

  it('blocks production tasks after approval expiry or approval identity drift', () => {
    expect(SQL).toContain('enforce_production_region_policy_legal_approval');
    expect(SQL).toContain('approval.review_at > clock_timestamp()');
    expect(SQL).toContain('approval.policy_hash = policy.policy_hash');
    expect(SQL).toContain('HXRPLA18: production legal approval is missing, expired, or mismatched');
  });

  it('is registered in the fail-closed production migration runner', () => {
    expect(RUNNER).toContain('REGION_POLICY_LEGAL_APPROVAL_ACTIVATION_MIGRATION');
    expect(RUNNER).toContain('20260722_region_policy_legal_approval_activation.sql');
  });

  it('ships a real PostgreSQL harness for rejection, activation, expiry, and immutability', () => {
    for (const token of [
      'expected HXRPLA8',
      'expected HXRPLA12',
      'expected HXRPLA18',
      'expected immutable approval rejection',
      'REGION_POLICY_LEGAL_APPROVAL_ACTIVATION_OK',
    ])
      expect(HARNESS).toContain(token);
  });
});
