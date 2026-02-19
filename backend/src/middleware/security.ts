/**
 * Security Middleware for HustleXP Backend
 *
 * Provides:
 * - Security headers (CSP, X-Frame-Options, etc.)
 * - Rate limiting per endpoint category
 * - Input sanitization helpers
 * - Prompt injection safeguards for AI endpoints
 */

import { Context, Next } from 'hono';
import { checkRateLimit } from '../cache/redis';
import { config } from '../config';

// ============================================================================
// SECURITY HEADERS
// ============================================================================

export async function securityHeaders(c: Context, next: Next) {
  await next();

  // Prevent clickjacking
  c.header('X-Frame-Options', 'DENY');
  // Block MIME sniffing
  c.header('X-Content-Type-Options', 'nosniff');
  // Referrer policy
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Permissions policy
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // Remove server identification
  c.header('X-Powered-By', '');

  // HSTS — enforce HTTPS for 1 year, include subdomains
  if (!config.app.isDevelopment) {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }

  // Content Security Policy — API-only server, block everything except JSON responses
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
  );

  // Prevent cross-site scripting via cache sniffing
  c.header('X-XSS-Protection', '0'); // Modern CSP replaces this; 0 avoids XSS-Auditor bugs
  // Cross-Origin policies
  c.header('Cross-Origin-Opener-Policy', 'same-origin');
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
}

// ============================================================================
// RATE LIMITING MIDDLEWARE
// ============================================================================

/**
 * Rate limiting configuration per endpoint category.
 * Limits are per-user per-window.
 */
const RATE_LIMITS = {
  ai: { limit: 20, windowSeconds: 60 },         // 20 AI requests/min
  auth: { limit: 10, windowSeconds: 60 },        // 10 auth attempts/min
  escrow: { limit: 30, windowSeconds: 60 },      // 30 escrow ops/min
  task: { limit: 60, windowSeconds: 60 },         // 60 task ops/min
  general: { limit: 100, windowSeconds: 60 },     // 100 general requests/min
} as const;

type RateLimitCategory = keyof typeof RATE_LIMITS;

/**
 * Creates a rate-limiting middleware for the given category.
 * Extracts user ID from the Firebase auth context or falls back to IP.
 */
export function rateLimitMiddleware(category: RateLimitCategory) {
  return async (c: Context, next: Next) => {
    // Extract user identifier: prefer Firebase UID, fall back to IP
    const authHeader = c.req.header('authorization');
    let identifier: string;

    if (authHeader?.startsWith('Bearer ')) {
      // Use a hash of the token as identifier (avoid storing raw tokens)
      const token = authHeader.slice(7);
      identifier = `user:${simpleHash(token)}`;
    } else {
      // Use forwarded IP or connecting IP
      identifier = `ip:${c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown'}`;
    }

    const { limit, windowSeconds } = RATE_LIMITS[category];
    const result = await checkRateLimit(identifier, category, limit, windowSeconds);

    // Set rate-limit headers
    c.header('X-RateLimit-Limit', String(limit));
    c.header('X-RateLimit-Remaining', String(result.remaining));
    if (result.resetAt) {
      c.header('X-RateLimit-Reset', String(result.resetAt));
    }

    if (!result.allowed) {
      return c.json(
        {
          error: 'Too Many Requests',
          message: `Rate limit exceeded. Try again in ${windowSeconds} seconds.`,
          retryAfter: windowSeconds,
        },
        429,
      );
    }

    await next();
  };
}

// ============================================================================
// INPUT SANITIZATION
// ============================================================================

/**
 * Strip common prompt injection patterns from user input.
 * This is a defense-in-depth measure — the AI authority model is the primary safeguard.
 */
export function sanitizeAIInput(input: string): string {
  if (!input || typeof input !== 'string') return '';

  let sanitized = input;

  // Remove attempts to override system prompts
  const injectionPatterns = [
    /ignore\s+(all\s+)?previous\s+instructions/gi,
    /ignore\s+(all\s+)?above\s+instructions/gi,
    /you\s+are\s+now\s+a\s+/gi,
    /system\s*:\s*/gi,
    /\[INST\]/gi,
    /\[\/INST\]/gi,
    /<<SYS>>/gi,
    /<\/SYS>/gi,
    /\bact\s+as\b/gi,
    /\bpretend\s+(to\s+be|you\s+are)\b/gi,
    /\brole[\s-]*play\b/gi,
    /new\s+instructions?\s*:/gi,
    /override\s+(safety|instructions|rules)/gi,
  ];

  for (const pattern of injectionPatterns) {
    sanitized = sanitized.replace(pattern, '[FILTERED]');
  }

  // Limit length (prevent token exhaustion)
  const MAX_AI_INPUT_LENGTH = 4000;
  if (sanitized.length > MAX_AI_INPUT_LENGTH) {
    sanitized = sanitized.slice(0, MAX_AI_INPUT_LENGTH);
  }

  return sanitized.trim();
}

/**
 * General input sanitizer — strips control characters and limits length.
 */
export function sanitizeInput(input: string, maxLength = 10000): string {
  if (!input || typeof input !== 'string') return '';

  // Remove null bytes and control characters (except newlines/tabs)
  let sanitized = input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Trim to max length
  if (sanitized.length > maxLength) {
    sanitized = sanitized.slice(0, maxLength);
  }

  return sanitized.trim();
}

// ============================================================================
// HELPERS
// ============================================================================

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < Math.min(str.length, 64); i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}
