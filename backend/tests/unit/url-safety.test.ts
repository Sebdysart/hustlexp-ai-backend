/**
 * URL Safety (SSRF Protection) Unit Tests
 *
 * Tests the SSRF protection utilities that block internal/private IPs,
 * loopback addresses, AWS metadata endpoints, and non-HTTPS protocols.
 *
 * @see backend/src/lib/url-safety.ts
 */
import { describe, it, expect } from 'vitest';
import { isInternalIP, validateSafeUrl } from '../../src/lib/url-safety';

// ============================================================================
// isInternalIP
// ============================================================================

describe('isInternalIP', () => {
  it('blocks loopback IPv4', () => {
    expect(isInternalIP('127.0.0.1')).toBe(true);
    expect(isInternalIP('127.0.0.2')).toBe(true);
    expect(isInternalIP('127.255.255.255')).toBe(true);
  });

  it('blocks localhost', () => {
    expect(isInternalIP('localhost')).toBe(true);
  });

  it('blocks RFC 1918 - 10.x.x.x', () => {
    expect(isInternalIP('10.0.0.1')).toBe(true);
    expect(isInternalIP('10.255.255.255')).toBe(true);
  });

  it('blocks RFC 1918 - 172.16-31.x.x', () => {
    expect(isInternalIP('172.16.0.1')).toBe(true);
    expect(isInternalIP('172.31.255.255')).toBe(true);
  });

  it('does not block 172.32.x.x (outside range)', () => {
    expect(isInternalIP('172.32.0.1')).toBe(false);
  });

  it('blocks RFC 1918 - 192.168.x.x', () => {
    expect(isInternalIP('192.168.0.1')).toBe(true);
    expect(isInternalIP('192.168.255.255')).toBe(true);
  });

  it('blocks link-local 169.254.x.x', () => {
    expect(isInternalIP('169.254.0.1')).toBe(true);
    expect(isInternalIP('169.254.169.254')).toBe(true); // AWS metadata
  });

  it('blocks IPv6 loopback', () => {
    expect(isInternalIP('::1')).toBe(true);
  });

  it('blocks IPv6 link-local', () => {
    expect(isInternalIP('fe80::1')).toBe(true);
  });

  it('blocks 0.0.0.0', () => {
    expect(isInternalIP('0.0.0.0')).toBe(true);
  });

  it('allows public IPs', () => {
    expect(isInternalIP('8.8.8.8')).toBe(false);
    expect(isInternalIP('1.1.1.1')).toBe(false);
    expect(isInternalIP('203.0.113.1')).toBe(false);
  });

  it('allows public domains', () => {
    expect(isInternalIP('example.com')).toBe(false);
    expect(isInternalIP('api.hustlexp.com')).toBe(false);
  });
});

// ============================================================================
// validateSafeUrl
// ============================================================================

describe('validateSafeUrl', () => {
  it('accepts valid HTTPS URLs', () => {
    const result = validateSafeUrl('https://example.com/image.jpg');
    expect(result.safe).toBe(true);
  });

  it('accepts HTTPS URLs with paths and query params', () => {
    const result = validateSafeUrl('https://cdn.example.com/photos/abc.jpg?w=200');
    expect(result.safe).toBe(true);
  });

  it('rejects HTTP URLs', () => {
    const result = validateSafeUrl('http://example.com/image.jpg');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('Protocol');
  });

  it('rejects file:// URLs', () => {
    const result = validateSafeUrl('file:///etc/passwd');
    expect(result.safe).toBe(false);
  });

  it('rejects internal IPs (loopback)', () => {
    const result = validateSafeUrl('https://127.0.0.1/api');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('internal');
  });

  it('rejects internal IPs (RFC 1918)', () => {
    expect(validateSafeUrl('https://10.0.0.1/api').safe).toBe(false);
    expect(validateSafeUrl('https://192.168.1.1/api').safe).toBe(false);
    expect(validateSafeUrl('https://172.16.0.1/api').safe).toBe(false);
  });

  it('rejects AWS metadata endpoint', () => {
    const result = validateSafeUrl('https://169.254.169.254/latest/meta-data/');
    expect(result.safe).toBe(false);
  });

  it('rejects non-standard ports', () => {
    const result = validateSafeUrl('https://example.com:8080/api');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('port');
  });

  it('allows standard HTTPS port 443', () => {
    const result = validateSafeUrl('https://example.com:443/api');
    expect(result.safe).toBe(true);
  });

  it('rejects embedded credentials', () => {
    const result = validateSafeUrl('https://user:pass@example.com/api');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('credentials');
  });

  it('rejects invalid URLs gracefully', () => {
    const result = validateSafeUrl('not-a-url');
    expect(result.safe).toBe(false);
  });

  it('rejects localhost', () => {
    const result = validateSafeUrl('https://localhost/api');
    expect(result.safe).toBe(false);
  });
});
