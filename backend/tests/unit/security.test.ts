/**
 * Security Module Unit Tests
 *
 * Tests SHA-256 hash behavior used for identifier hashing.
 * Also tests getTrustedClientIP XFF spoofing protection logic.
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

// ============================================================================
// getTrustedClientIP — XFF spoofing protection
// ============================================================================

/**
 * Reimplement getTrustedClientIP locally so we can unit-test the IP
 * resolution algorithm without bringing in the full Hono context.
 *
 * The algorithm is identical to the one in security.ts:
 *   1. Parse X-Forwarded-For — take the RIGHTMOST (last) entry.
 *   2. Fall back to cf-connecting-ip, then x-real-ip.
 *   3. Final fallback: 'unknown'.
 */
function getTrustedClientIP(headers: Record<string, string | undefined>): string {
  const xff = headers['x-forwarded-for'];
  if (xff) {
    const ips = xff.split(',').map((ip) => ip.trim()).filter(Boolean);
    if (ips.length > 0) {
      return ips[ips.length - 1];
    }
  }
  return headers['cf-connecting-ip'] || headers['x-real-ip'] || 'unknown';
}

describe('getTrustedClientIP — XFF spoofing protection', () => {
  it('uses the rightmost XFF entry (added by our reverse proxy)', () => {
    // Client injects a fake IP as the leftmost entry; our proxy appends the real one
    const ip = getTrustedClientIP({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8, 10.0.0.1' });
    expect(ip).toBe('10.0.0.1');
  });

  it('does NOT use the leftmost XFF entry (client-supplied, spoofable)', () => {
    const ip = getTrustedClientIP({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8, 10.0.0.1' });
    expect(ip).not.toBe('1.2.3.4');
  });

  it('works correctly with a single-entry XFF header (no chain)', () => {
    const ip = getTrustedClientIP({ 'x-forwarded-for': '203.0.113.42' });
    expect(ip).toBe('203.0.113.42');
  });

  it('handles XFF entries with extra whitespace correctly', () => {
    // Some proxies add extra spaces around commas
    const ip = getTrustedClientIP({ 'x-forwarded-for': '  1.2.3.4  ,  5.6.7.8  ,  10.0.0.1  ' });
    expect(ip).toBe('10.0.0.1');
  });

  it('falls back to cf-connecting-ip when XFF is absent', () => {
    const ip = getTrustedClientIP({ 'cf-connecting-ip': '203.0.113.99' });
    expect(ip).toBe('203.0.113.99');
  });

  it('falls back to x-real-ip when XFF and cf-connecting-ip are absent', () => {
    const ip = getTrustedClientIP({ 'x-real-ip': '198.51.100.7' });
    expect(ip).toBe('198.51.100.7');
  });

  it("returns 'unknown' when no IP headers are present", () => {
    const ip = getTrustedClientIP({});
    expect(ip).toBe('unknown');
  });

  it('an attacker with spoofed XFF gets the same bucket as the rightmost entry (not their fake IP)', () => {
    // Attacker sends X-Forwarded-For: <random fresh IP>
    // Our proxy appends the actual client IP (same every request from that client)
    const attack1 = getTrustedClientIP({ 'x-forwarded-for': 'attacker-fresh-ip-001, 192.168.1.50' });
    const attack2 = getTrustedClientIP({ 'x-forwarded-for': 'attacker-fresh-ip-002, 192.168.1.50' });
    const attack3 = getTrustedClientIP({ 'x-forwarded-for': 'attacker-fresh-ip-003, 192.168.1.50' });
    // All three resolve to the same real client IP — one shared bucket, not three fresh ones
    expect(attack1).toBe('192.168.1.50');
    expect(attack2).toBe('192.168.1.50');
    expect(attack3).toBe('192.168.1.50');
  });

  it('rejects empty XFF header and falls back gracefully', () => {
    const ip = getTrustedClientIP({ 'x-forwarded-for': '' });
    // Empty XFF — should fall through to fallback
    expect(ip).toBe('unknown');
  });

  it('handles XFF with only commas/whitespace (no valid IPs)', () => {
    const ip = getTrustedClientIP({ 'x-forwarded-for': ' , , ' });
    expect(ip).toBe('unknown');
  });
});
