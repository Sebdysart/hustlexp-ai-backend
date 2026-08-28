import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations/20260720_region_policy_price_book_alignment.sql'),
  'utf8',
);

describe('Washington Price Book region-policy alignment', () => {
  it('versions the policy instead of mutating consequential active policy fields', () => {
    expect(SQL).toContain("version <> 'us-wa-price-book-2026-07-20-v2'");
    expect(SQL).toContain("SET policy_state = 'RETIRED'");
    expect(SQL).toContain("'us-wa-price-book-2026-07-20-v2'");
    expect(SQL).toContain("'RETIRED'");
    expect(SQL).toContain("'ACTIVATED'");
    expect(SQL).toContain("encode(digest(document::text, 'sha256'), 'hex')");
  });

  it('defines furniture assembly as an explicit governed category', () => {
    expect(SQL).toContain("'furniture_assembly'");
    expect(SQL).toMatch(/'furniture_assembly'[\s\S]*?'backgroundCheckRequired', TRUE/);
    expect(SQL).toMatch(/'furniture_assembly'[\s\S]*?'proofRequired', TRUE/);
    expect(SQL).toMatch(/'furniture_assembly'[\s\S]*?'minPhotos', 2/);
  });

  it('keeps production unavailable until external legal approval exists', () => {
    expect(SQL).toMatch(/'ACTIVE',\s*FALSE,\s*'COUNSEL_APPROVAL_REQUIRED'/);
    expect(SQL).toContain('production remains disabled pending counsel approval');
    expect(SQL).not.toContain("'COUNSEL_APPROVED'");
  });
});
