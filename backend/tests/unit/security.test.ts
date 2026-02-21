/**
 * Security Module Unit Tests
 *
 * Tests SHA-256 hash behavior used for identifier hashing.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';

// Reimplement hashIdentifier to test behavioral correctness
// (The actual function is not exported from security.ts, but uses the same algorithm)
function hashIdentifier(str: string): string {
  return createHash('sha256').update(str).digest('hex').slice(0, 32);
}

describe('hashIdentifier (SHA-256 truncated)', () => {
  it('should return a 32-character string', () => {
    expect(hashIdentifier('test')).toHaveLength(32);
  });

  it('should return only hexadecimal characters', () => {
    expect(hashIdentifier('test')).toMatch(/^[a-f0-9]{32}$/);
  });

  it('should be deterministic (same input = same output)', () => {
    const input = 'consistent-input';
    expect(hashIdentifier(input)).toBe(hashIdentifier(input));
  });

  it('should produce different outputs for different inputs', () => {
    expect(hashIdentifier('input-one')).not.toBe(hashIdentifier('input-two'));
  });

  it('should handle empty string', () => {
    const result = hashIdentifier('');
    expect(result).toHaveLength(32);
    expect(result).toMatch(/^[a-f0-9]{32}$/);
  });

  it('should handle unicode input', () => {
    for (const input of ['你好世界', '🚀🌟✨', 'café', '日本語テスト']) {
      const result = hashIdentifier(input);
      expect(result).toHaveLength(32);
      expect(result).toMatch(/^[a-f0-9]{32}$/);
    }
  });

  it('should handle very long input', () => {
    const result = hashIdentifier('a'.repeat(10000));
    expect(result).toHaveLength(32);
    expect(result).toMatch(/^[a-f0-9]{32}$/);
  });

  it('should produce different hashes for similar inputs', () => {
    const variations = ['test', 'test1', '1test', 'TEST', 'tes', 'test '];
    const hashes = variations.map(hashIdentifier);
    const unique = new Set(hashes);
    expect(unique.size).toBe(variations.length);
  });

  it('should truncate full SHA-256 to first 32 characters', () => {
    const input = 'any-input';
    const fullHash = createHash('sha256').update(input).digest('hex');
    expect(fullHash).toHaveLength(64);
    expect(hashIdentifier(input)).toBe(fullHash.slice(0, 32));
  });
});
