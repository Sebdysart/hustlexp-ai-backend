import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(process.cwd(), 'backend/src/routers/featured.ts'),
  'utf8',
);

describe('featured router source boundary', () => {
  it('contains no payment, revenue, database, or paid-feed execution path', () => {
    expect(source).not.toContain('getSharedStripe');
    expect(source).not.toContain('RevenueService');
    expect(source).not.toContain('featured_listings');
    expect(source).not.toContain('db.query');
    expect(source).toContain("code: 'PRECONDITION_FAILED'");
    expect(source).toContain('.query(() => [])');
  });
});
