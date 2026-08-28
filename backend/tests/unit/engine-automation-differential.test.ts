import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db', () => ({
  db: { query: vi.fn(), transaction: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { deriveRoughArea, redactPrivateLocation } from '../../src/services/TaskLocationService';
import { isExactCanonicalPaymentAmount } from '../../src/services/EscrowPaymentPolicy';

const SAFE_LEGACY_AREAS = [
  'Bellevue, WA',
  'Redmond, WA',
  'Sammamish, WA',
  'Seattle, WA',
] as const;

describe('engine automation compatibility differential', () => {
  it.each(SAFE_LEGACY_AREAS)(
    'preserves a legacy city-level public location while adding the area qualifier: %s',
    (legacyLocation) => {
      expect(deriveRoughArea(legacyLocation)).toBe(`${legacyLocation} area`);
      expect(deriveRoughArea(undefined, legacyLocation)).toBe(`${legacyLocation} area`);
    },
  );

  it.each(SAFE_LEGACY_AREAS)(
    'leaves already-safe legacy descriptions unchanged: %s',
    (legacyLocation) => {
      const legacyDescription = `Outdoor help near ${legacyLocation}`;
      expect(redactPrivateLocation(legacyDescription)).toBe(legacyDescription);
    },
  );

  it('preserves the exact-price happy path and rejects both amount drifts', () => {
    const canonicalPrice = 5_000;
    expect(isExactCanonicalPaymentAmount(canonicalPrice, canonicalPrice)).toBe(true);
    expect(isExactCanonicalPaymentAmount(canonicalPrice, 100)).toBe(false);
    expect(isExactCanonicalPaymentAmount(canonicalPrice, 5_001)).toBe(false);
  });
});
