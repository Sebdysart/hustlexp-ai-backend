import { describe, expect, it } from 'vitest';

import {
  canonicalTaskVersion,
  normalizeTaskVersion,
} from '../../src/services/TaskVersion.js';

describe('TaskVersion PostgreSQL BIGINT boundary', () => {
  it.each([
    ['safe number', 7, 7],
    ['canonical decimal string', '42', 42],
    ['safe bigint', 99n, 99],
    ['maximum safe string', String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
    ['maximum safe bigint', BigInt(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  ])('normalizes a %s representation', (_label, input, expected) => {
    expect(canonicalTaskVersion(input)).toBe(expected);
  });

  it.each([
    ['decimal number', 1.5],
    ['non-digit string', '7x'],
    ['decimal string', '1.5'],
    ['negative string', '-1'],
    ['unsafe number', Number.MAX_SAFE_INTEGER + 1],
    ['leading-zero string', '01'],
  ])('rejects an invalid %s representation', (_label, input) => {
    expect(() => canonicalTaskVersion(input)).toThrow('TASK_VERSION_INVALID');
  });

  it.each([
    ['zero number', 0],
    ['zero string', '0'],
    ['zero bigint', 0n],
    ['negative number', -1],
    ['negative bigint', -1n],
    ['out-of-range string', String(BigInt(Number.MAX_SAFE_INTEGER) + 1n)],
    ['out-of-range bigint', BigInt(Number.MAX_SAFE_INTEGER) + 1n],
  ])('rejects an out-of-range %s representation', (_label, input) => {
    expect(() => canonicalTaskVersion(input)).toThrow('TASK_VERSION_OUT_OF_SAFE_RANGE');
  });

  it('preserves the row shape while replacing the database representation with a number', () => {
    const row = { id: 'task-1', version: '17' as const, title: 'Move a sofa' };

    const normalized = normalizeTaskVersion(row);

    expect(normalized).toEqual({ id: 'task-1', version: 17, title: 'Move a sofa' });
    expect(typeof normalized.version).toBe('number');
    expect(row.version).toBe('17');
  });
});
