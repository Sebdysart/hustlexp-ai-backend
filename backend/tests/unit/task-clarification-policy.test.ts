import { describe, expect, it } from 'vitest';
import {
  buildMaterialClarificationRevision,
  preparePublicClarification,
} from '../../src/services/TaskClarificationPolicy';

describe('public task clarification policy', () => {
  it('keeps task-specific questions public-safe and hashes the exact stored form', () => {
    const prepared = preparePublicClarification(
      '  Is there an elevator? Email me at worker@example.com. The address is 123 Main Street.  ',
    );
    expect(prepared.text).toBe('Is there an elevator? Email me at [EMAIL_REDACTED]. The address is [location protected].');
    expect(prepared.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(preparePublicClarification(prepared.text).hash).toBe(prepared.hash);
  });

  it('rejects clarification that becomes empty after safety normalization', () => {
    expect(() => preparePublicClarification('   ')).toThrow(/question/i);
  });

  it('builds a reconciled material revision without mutating the active task', () => {
    expect(buildMaterialClarificationRevision({
      summary: 'Haul-away now includes disposal.',
      checklist: ['Load removed items', 'Dispose at an approved facility'],
      customerTotalCents: 12000,
      hustlerPayoutCents: 9000,
      platformMarginCents: 3000,
    })).toEqual({
      summary: 'Haul-away now includes disposal.',
      checklist: ['Load removed items', 'Dispose at an approved facility'],
      customerTotalCents: 12000,
      hustlerPayoutCents: 9000,
      platformMarginCents: 3000,
    });
  });

  it.each([
    { customerTotalCents: 12000, hustlerPayoutCents: 9000, platformMarginCents: 2000 },
    { customerTotalCents: 0, hustlerPayoutCents: 0, platformMarginCents: 0 },
  ])('rejects unreconciled or non-positive revision economics', (economics) => {
    expect(() => buildMaterialClarificationRevision({
      summary: 'Material change', checklist: ['One changed item'], ...economics,
    })).toThrow(/reconcile|positive/i);
  });
});
