/**
 * URL Safety Utilities v1.0.0
 *
 * SSRF protection: validates URLs before server-side fetch().
 * Blocks internal IPs, private networks, and non-HTTPS protocols.
 *
 * @see biometric.ts (Zod refine), BiometricVerificationService.ts (fetch guards)
 */

import { logger } from '../logger';

const log = logger.child({ module: 'url-safety' });

// ============================================================================
// INTERNAL IP DETECTION
// ============================================================================

/**
 * Check if a hostname resolves to an internal/private IP address.
 * Blocks RFC 1918, link-local, loopback, AWS metadata, and IPv6 equivalents.
 */
export function isInternalIP(hostname: string): boolean {
  // Normalize
  const host = hostname.toLowerCase().trim();

  // IPv4 patterns
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b, c] = ipv4Match.map(Number);

    // Loopback: 127.0.0.0/8
    if (a === 127) return true;

    // Private: 10.0.0.0/8
    if (a === 10) return true;

    // Private: 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;

    // Private: 192.168.0.0/16
    if (a === 192 && b === 168) return true;

    // Link-local: 169.254.0.0/16 (includes AWS metadata 169.254.169.254)
    if (a === 169 && b === 254) return true;

    // 0.0.0.0
    if (a === 0 && b === 0 && c === 0) return true;
  }

  // IPv6 loopback
  if (host === '::1' || host === '[::1]') return true;

  // IPv6 link-local (fe80::/10)
  if (host.startsWith('fe80:') || host.startsWith('[fe80:')) return true;

  // IPv6 unique local (fc00::/7)
  if (host.startsWith('fc') || host.startsWith('fd') ||
      host.startsWith('[fc') || host.startsWith('[fd')) return true;

  // Hex-encoded IPv4 (e.g., 0x7f000001 = 127.0.0.1)
  const hexMatch = host.match(/^0x([0-9a-f]+)$/i);
  if (hexMatch) {
    const ipNum = parseInt(hexMatch[1], 16);
    const a = (ipNum >>> 24) & 0xff;
    const b = (ipNum >>> 16) & 0xff;
    if (a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0) {
      return true;
    }
  }

  // localhost
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  return false;
}

// ============================================================================
// URL VALIDATION
// ============================================================================

/**
 * Validate that a URL is safe for server-side fetching.
 * Rejects internal IPs, non-HTTPS protocols, and suspicious patterns.
 */
export function validateSafeUrl(urlString: string): { safe: boolean; reason?: string } {
  try {
    const parsed = new URL(urlString);

    // Protocol check: only HTTPS allowed
    if (parsed.protocol !== 'https:') {
      return { safe: false, reason: `Protocol '${parsed.protocol}' not allowed, only https: permitted` };
    }

    // Hostname check: reject internal IPs
    const hostname = parsed.hostname;
    if (isInternalIP(hostname)) {
      return { safe: false, reason: `Hostname '${hostname}' resolves to internal/private network` };
    }

    // Port check: reject non-standard ports
    if (parsed.port && parsed.port !== '443') {
      return { safe: false, reason: `Non-standard port '${parsed.port}' not allowed` };
    }

    // Username/password in URL: reject
    if (parsed.username || parsed.password) {
      return { safe: false, reason: 'URLs with embedded credentials not allowed' };
    }

    return { safe: true };
  } catch {
    return { safe: false, reason: 'Invalid URL format' };
  }
}
