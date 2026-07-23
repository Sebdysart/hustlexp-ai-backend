import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations/20260721_hustler_trust_progression_contract.sql'),
  'utf8',
);

describe('canonical Hustler trust progression migration', () => {
  it('represents Explorer in immutable trust and standing evidence', () => {
    expect(sql).toContain('CHECK (old_tier BETWEEN 0 AND 4)');
    expect(sql).toContain('CHECK (new_tier BETWEEN 0 AND 4)');
    expect(sql).toContain('CHECK (current_tier BETWEEN 0 AND 4)');
    expect(sql).toContain('CHECK (target_tier BETWEEN 1 AND 4)');
  });

  it('rejects unsupported, unauthoritative, and skipped promotions', () => {
    expect(sql).toContain('HXTRUST1');
    expect(sql).toContain("current_setting('hustlexp.trust_promotion_authority', TRUE)");
    expect(sql).toContain('hustler-trust-progression-v1');
    expect(sql).toContain('worker-standing-appeal');
    expect(sql).toContain('HXTRUST2');
    expect(sql).toContain('NEW.trust_tier <> OLD.trust_tier + 1');
    expect(sql).toContain('HXTRUST3');
  });

  it('synchronizes canonical tier and risk clearance into dispatch capability', () => {
    expect(sql).toContain('synchronize_hustler_trust_capability_profile');
    expect(sql).toContain("WHEN 1 THEN ARRAY['low']::text[]");
    expect(sql).toContain("WHEN 2 THEN ARRAY['low','medium']::text[]");
    expect(sql).toContain("ELSE ARRAY['low','medium','high']::text[]");
  });
});
