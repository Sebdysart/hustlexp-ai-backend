import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db.js', () => ({
  db: { query: vi.fn(), transaction: vi.fn() },
}));

import { leadOwnershipMatchesPoster } from '../../src/services/QuotePaymentFinalizationService.js';

describe('quote payment poster identity', () => {
  it('accepts a trusted phone-origin lead bound to the same internal user', () => {
    expect(leadOwnershipMatchesPoster({
      leadUserId: 'poster-1',
      leadEmail: null,
      posterId: 'poster-1',
      posterEmail: null,
    })).toBe(true);
  });

  it('rejects a bound lead owned by another internal user', () => {
    expect(leadOwnershipMatchesPoster({
      leadUserId: 'poster-2',
      leadEmail: 'same@example.com',
      posterId: 'poster-1',
      posterEmail: 'same@example.com',
    })).toBe(false);
  });

  it('preserves the legacy normalized-email identity fallback for unbound leads', () => {
    expect(leadOwnershipMatchesPoster({
      leadUserId: null,
      leadEmail: 'Customer@Example.com ',
      posterId: 'poster-1',
      posterEmail: ' customer@example.com',
    })).toBe(true);
  });
});
