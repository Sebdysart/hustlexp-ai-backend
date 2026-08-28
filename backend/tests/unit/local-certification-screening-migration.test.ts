import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(
  process.cwd(),
  'backend/database/migrations/20260720_local_certification_screening_provider.sql',
), 'utf8');

describe('local certification screening migration', () => {
  it('makes TEST screening identities and provenance explicit', () => {
    expect(sql).toContain("provider = 'local_certification_test'");
    expect(sql).toContain("provider_environment = 'CONTROLLED_TEST'");
    expect(sql).toContain('background_check_is_test');
    expect(sql).toContain("check_id ~ '^scr_hxos_test_[a-f0-9]{32}$'");
  });

  it('requires transaction-local authority and append-only report events', () => {
    expect(sql).toContain("current_setting('hustlexp.local_test_screening_enabled', TRUE) = 'true'");
    expect(sql).toContain('BEFORE UPDATE OR DELETE OR TRUNCATE');
    expect(sql).toContain('HXLTS7: local TEST screening events are append-only');
    expect(sql).toContain('HXLTS8: local TEST screening CLEAR requires exact provider evidence');
  });

  it('blocks TEST evidence from production acceptance at both policy gates', () => {
    expect(sql).toContain("NEW.automation_classification = 'CONTROLLED_TEST'");
    expect(sql).toContain("background.provider_environment = 'PRODUCTION'");
    expect(sql).toContain("v_worker.background_check_environment <> 'CONTROLLED_TEST'");
    expect(sql).toContain('HXWE16: TEST screening cannot authorize production work');
    expect(sql).toContain('HXRP19: background check required by region policy');
  });

  it('restores Tier 0 verified identity and phone enforcement after the payout trigger replacement', () => {
    expect(sql).toContain('v_worker.is_verified');
    expect(sql).toContain("NULLIF(BTRIM(v_worker.phone), '') IS NULL");
    expect(sql).toContain('HXWE15: Tier 0 is browse-only; verified identity and phone are required');
  });
});
