import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(
  process.cwd(),
  'backend/database/migrations/20260720_local_certification_payout_provider.sql',
), 'utf8');

describe('local certification payout migration', () => {
  it('keeps TEST payout identities and production Stripe evidence distinct', () => {
    expect(sql).toContain("provider_mode = 'local_certification_test'");
    expect(sql).toContain("automation_classification <> 'CONTROLLED_TEST'");
    expect(sql).toContain("payout_provider IN ('STRIPE', 'LOCAL_CERTIFICATION_TEST', 'MANUAL_RECONCILIATION')");
    expect(sql).toContain("NEW.stripe_transfer_id IS NOT NULL");
    expect(sql).toContain("HXLPO8: local TEST escrow release lacks exact paid provider evidence");
  });

  it('pins exact canonical economics and append-only evidence', () => {
    expect(sql).toContain("expected_amount := task_row.hustler_payout_cents");
    expect(sql).toContain("ROUND(task_row.price * 0.02)::INTEGER");
    expect(sql).toContain("NEW.amount_cents <> expected_amount");
    expect(sql).toContain('BEFORE UPDATE OR DELETE OR TRUNCATE');
    expect(sql).toContain('HXLPO7: local TEST payout evidence is append-only');
  });

  it('requires transaction-local opt-in before a TEST destination satisfies acceptance', () => {
    expect(sql).toContain("current_setting('hustlexp.local_test_payout_enabled', TRUE) = 'true'");
    expect(sql).toContain("NEW.automation_classification = 'CONTROLLED_TEST'");
    expect(sql).toContain('AND NOT v_local_test_payout');
  });
});
