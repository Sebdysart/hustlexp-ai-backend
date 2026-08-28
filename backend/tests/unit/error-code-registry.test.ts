/**
 * Error Code Registry Unit Tests
 *
 * Validates structural integrity of the HX error code registry.
 */
import { describe, it, expect } from 'vitest';
import {
  ERROR_CODES,
  getErrorCode,
  getAllCodes,
  type ErrorCodeEntry,
} from '../../src/lib/error-code-registry';

describe('Error Code Registry', () => {
  const allCodes = getAllCodes();

  it('should have at least one error code', () => {
    expect(allCodes.length).toBeGreaterThan(0);
  });

  it('all codes follow the HX\\d{3} pattern', () => {
    const hxPattern = /^HX\d{3}$/;
    for (const entry of allCodes) {
      expect(entry.code).toMatch(hxPattern);
    }
  });

  it('has no duplicate codes', () => {
    const codes = allCodes.map(e => e.code);
    const unique = new Set(codes);
    expect(unique.size).toBe(codes.length);
  });

  it('all codes have non-empty messages', () => {
    for (const entry of allCodes) {
      expect(entry.message.length).toBeGreaterThan(0);
    }
  });

  it('all codes have valid httpStatus (400-599)', () => {
    for (const entry of allCodes) {
      expect(entry.httpStatus).toBeGreaterThanOrEqual(400);
      expect(entry.httpStatus).toBeLessThanOrEqual(599);
    }
  });

  it('all codes have non-empty category', () => {
    for (const entry of allCodes) {
      expect(entry.category.length).toBeGreaterThan(0);
    }
  });

  it('all codes have boolean userFacing', () => {
    for (const entry of allCodes) {
      expect(typeof entry.userFacing).toBe('boolean');
    }
  });

  it('registry keys match entry code values', () => {
    for (const [key, entry] of Object.entries(ERROR_CODES)) {
      expect(key).toBe(entry.code);
    }
  });
});

describe('getErrorCode', () => {
  it('returns correct entry for HX001', () => {
    const entry = getErrorCode('HX001');
    expect(entry).toBeDefined();
    expect(entry!.code).toBe('HX001');
    expect(entry!.httpStatus).toBe(409);
    expect(entry!.category).toBe('state_violation');
  });

  it('returns correct entry for HX901', () => {
    const entry = getErrorCode('HX901');
    expect(entry).toBeDefined();
    expect(entry!.code).toBe('HX901');
    expect(entry!.category).toBe('live_mode');
  });

  it('returns undefined for unknown code', () => {
    expect(getErrorCode('HX999')).toBeUndefined();
  });

  it('returns undefined for non-HX code', () => {
    expect(getErrorCode('NOT_FOUND')).toBeUndefined();
  });
});

describe('getAllCodes', () => {
  it('returns all entries from ERROR_CODES', () => {
    const allEntries = getAllCodes();
    expect(allEntries.length).toBe(Object.keys(ERROR_CODES).length);
  });

  it('returns ErrorCodeEntry objects', () => {
    const entries = getAllCodes();
    for (const entry of entries) {
      expect(entry).toHaveProperty('code');
      expect(entry).toHaveProperty('message');
      expect(entry).toHaveProperty('httpStatus');
      expect(entry).toHaveProperty('category');
      expect(entry).toHaveProperty('userFacing');
    }
  });
});

describe('Cross-reference with known codes', () => {
  const expectedCodes = [
    'HX001', 'HX002', 'HX003', 'HX004',
    'HX101', 'HX102',
    'HX201',
    'HX301',
    'HX401',
    'HX601', 'HX602', 'HX603', 'HX604',
    'HX701', 'HX702', 'HX703', 'HX704',
    'HX801',
    'HX901', 'HX902', 'HX903', 'HX904', 'HX905',
  ];

  for (const code of expectedCodes) {
    it(`includes ${code}`, () => {
      expect(getErrorCode(code)).toBeDefined();
    });
  }
});
