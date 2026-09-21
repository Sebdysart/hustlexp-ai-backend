import { describe, expect, it } from 'vitest';
import { normalizePhoneToE164 } from '../../src/lib/phone.js';

describe('normalizePhoneToE164', () => {
  it.each([
    ['(206) 555-0123', '+12065550123'],
    ['206-555-0123', '+12065550123'],
    ['1 206 555 0123', '+12065550123'],
    ['+12065550123', '+12065550123'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizePhoneToE164(input)).toBe(expected);
  });

  it.each(['', '555-0123', '+442071838750', '1206555012'])('rejects %s', (input) => {
    expect(() => normalizePhoneToE164(input)).toThrow('valid US phone');
  });
});
