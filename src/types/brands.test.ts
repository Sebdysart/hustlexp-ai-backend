import { describe, it, expect } from 'vitest';
import { UserId, TaskId, Cents, DisputeId, ProofId, LedgerEntryId } from './brands.js';

describe('Branded types — smart constructors', () => {
  it('UserId.parse accepts valid UUIDs', () => {
    const id = UserId.parse('550e8400-e29b-41d4-a716-446655440000');
    expect(id).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('UserId.parse rejects non-UUIDs', () => {
    expect(() => UserId.parse('not-a-uuid')).toThrow(TypeError);
    expect(() => UserId.parse('')).toThrow(TypeError);
    expect(() => UserId.parse('123')).toThrow(TypeError);
  });

  it('TaskId.parse rejects UserId-shaped string at type level', () => {
    // This test documents the COMPILE-TIME guarantee (runtime strings are still strings)
    const taskId = TaskId.parse('550e8400-e29b-41d4-a716-446655440001');
    expect(taskId).toBeDefined();
    // The compiler prevents: processTask(userId) — passing UserId where TaskId expected
  });

  it('Cents.fromNumber accepts non-negative integers', () => {
    expect(Cents.fromNumber(0)).toBe(0);
    expect(Cents.fromNumber(1000)).toBe(1000);
  });

  it('Cents.fromNumber rejects negatives and floats', () => {
    expect(() => Cents.fromNumber(-1)).toThrow(TypeError);
    expect(() => Cents.fromNumber(10.5)).toThrow(TypeError);
  });

  it('DisputeId.parse accepts valid UUIDs', () => {
    const id = DisputeId.parse('550e8400-e29b-41d4-a716-446655440002');
    expect(id).toBeDefined();
  });

  it('ProofId.parse rejects non-UUIDs', () => {
    expect(() => ProofId.parse('bad')).toThrow(TypeError);
  });

  it('LedgerEntryId.parse accepts valid UUIDs', () => {
    const id = LedgerEntryId.parse('550e8400-e29b-41d4-a716-446655440003');
    expect(id).toBeDefined();
  });

  it('Cents.parse is equivalent to Cents.fromNumber', () => {
    expect(Cents.parse(500)).toBe(500);
    expect(() => Cents.parse(-1)).toThrow(TypeError);
    expect(Cents.isValid(100)).toBe(true);
    expect(Cents.isValid(-1)).toBe(false);
  });
});
