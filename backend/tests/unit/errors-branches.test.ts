/**
 * errors.ts branch coverage tests
 *
 * Covers the uncovered branch in src/utils/errors.ts:
 * - getErrorMessage for Error instance
 * - getErrorMessage for non-Error values (string, number, object)
 */
import { describe, it, expect } from 'vitest';
import { getErrorMessage } from '../../../src/utils/errors';

describe('getErrorMessage', () => {
  it('returns message for Error instance', () => {
    expect(getErrorMessage(new Error('test error'))).toBe('test error');
  });

  it('returns message for TypeError', () => {
    expect(getErrorMessage(new TypeError('type err'))).toBe('type err');
  });

  it('returns stringified value for string', () => {
    expect(getErrorMessage('string error')).toBe('string error');
  });

  it('returns stringified value for number', () => {
    expect(getErrorMessage(42)).toBe('42');
  });

  it('returns stringified value for null', () => {
    expect(getErrorMessage(null)).toBe('null');
  });

  it('returns stringified value for undefined', () => {
    expect(getErrorMessage(undefined)).toBe('undefined');
  });

  it('returns stringified value for object', () => {
    expect(getErrorMessage({ code: 500 })).toBe('[object Object]');
  });
});
