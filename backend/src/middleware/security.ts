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
import { checkRateLimit, redis } from '../cache/redis.js';
import { config } from '../config.js';
import { firebaseAuth } from '../auth/firebase.js';
import { logger } from '../logger.js';

const securityLog = logger.child({ module: 'security' });

// ============================================================================
// TRUSTED IP RESOLUTION
// ============================================================================

/**
 * Resolve the canonical client IP from an incoming request, safe against
 * X-Forwarded-For spoofing.
 *
 * The X-Forwarded-For header is formatted as:
 *   "client, proxy1, proxy2"
 * Each hop appends its own entry.  Our trusted reverse proxy (Fly.io /
 * Cloudflare) always appends the rightmost entry, so an attacker cannot forge
 * that position — any value they inject is pushed further left by the proxy.
 *
 * Rules:
 *   1. If XFF is present, take the RIGHTMOST (last) entry — set by our proxy.
 *   2. Otherwise fall back to Cloudflare's cf-connecting-ip, then x-real-ip.
 *   3. If none of the above are available, return 'unknown'.
 *
 * This function must be used for ALL IP-based rate limiting.  Using the raw
 * header (or its leftmost entry) allows an attacker to supply an arbitrary IP
 * and receive a fresh rate-limit bucket on every request.
 */
function getTrustedClientIP(c: Context): string {
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const ips = xff.split(',').map((ip) => ip.trim()).filter(Boolean);
    // The rightmost entry is appended by our own trusted reverse proxy
    // and cannot be injected by the client.
    if (ips.length > 0) {
      return ips[ips.length - 1];
    }
  }
  // Fallback: Cloudflare's canonical header, then a generic real-ip header
  return (
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-real-ip') ||
    'unknown'
  );
}

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
  auth: { limit: 20, windowSeconds: 60 },        // 20 auth attempts/min (brute force protection)
  browse: { limit: 30, windowSeconds: 60 },      // 30 public browse requests/min — IP-based DoS protection
  escrow: { limit: 30, windowSeconds: 60 },      // 30 escrow ops/min
  financial: { limit: 10, windowSeconds: 60 },   // 10 financial ops/min (escrow release, stripe)
  live: { limit: 20, windowSeconds: 60 },        // 20 live mode requests/min — multi-table JOIN, geo amplification risk
  mutation: { limit: 60, windowSeconds: 60 },    // 60 mutation ops/min (write-heavy routes)
  task: { limit: 60, windowSeconds: 60 },         // 60 task ops/min
  general: { limit: 120, windowSeconds: 60 },     // 120 general requests/min
  sse: { limit: 10, windowSeconds: 60 },          // 10 SSE connection attempts/min (connection-flood protection)
} as const;

type RateLimitCategory = keyof typeof RATE_LIMITS;

/**
 * Creates a rate-limiting middleware for the given category.
 *
 * Bucket key strategy
 * -------------------
 * We deliberately do NOT decode the JWT payload here to extract a user ID.
 * Decoding without verifying the signature lets an attacker forge arbitrary
 * `sub` / `user_id` claims and cycle through unlimited fresh rate-limit
 * buckets with no cost.  The verified user identity is only available after
 * Firebase token verification (in the tRPC auth middleware), which runs
 * inside the procedure handler — too late for HTTP-layer rate limiting.
 *
 * Therefore this middleware uses the trusted client IP (rightmost XFF entry,
 * set by our reverse proxy) as the bucket key for all requests.  This is
 * spoofing-resistant and requires no JWT inspection.
 *
 * Per-user rate limiting (using the verified ctx.user.id) can be added at
 * the tRPC procedure level where the verified identity is already available.
 */
export function rateLimitMiddleware(category: RateLimitCategory) {
  return async (c: Context, next: Next) => {
    // Always use the trusted client IP — avoids unverified-JWT sub spoofing.
    const identifier = `ip:${getTrustedClientIP(c)}`;

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

// ============================================================================
// AI-SPECIFIC RATE LIMITING (Per-User Per-Minute)
// ============================================================================

const AI_RATE_LIMITS = {
  groq: { requests: 30, windowMs: 60000 },      // 30 req/min
  openai: { requests: 20, windowMs: 60000 },    // 20 req/min
  deepseek: { requests: 25, windowMs: 60000 },  // 25 req/min
  anthropic: { requests: 15, windowMs: 60000 }, // 15 req/min
};

/**
 * AI per-minute rate limiter per user
 * Prevents cost abuse while allowing legitimate usage
 *
 * Identity strategy: extract the Firebase Bearer token from the Authorization
 * header and verify it cryptographically before using the resulting uid as the
 * rate-limit bucket key.  Reading a Hono context variable (c.get('userId'))
 * does NOT work here because that variable is only set inside tRPC procedure
 * handlers — it is never populated at the HTTP middleware layer, so it is
 * always undefined, making the middleware permanently return 401.
 */
export async function aiRateLimitMiddleware(provider: keyof typeof AI_RATE_LIMITS) {
  const limits = AI_RATE_LIMITS[provider];

  return async (c: Context, next: Next) => {
    const authHeader = c.req.header('authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    let userId: string;
    try {
      const decoded = await firebaseAuth.verifyIdToken(token);
      userId = decoded.uid;
    } catch {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const key = `ratelimit:ai:${provider}:${userId}`;
    // Use the atomic Lua-based helper to INCR and conditionally EXPIRE in a
    // single Redis round-trip.  A plain INCR followed by a separate EXPIRE
    // has a crash-window between the two calls: if the process dies after INCR
    // but before EXPIRE the key gets no TTL and the user is permanently
    // rate-limited ("immortal key").  The Lua script sets EXPIRE only on first
    // creation (current === 1) so the window is not reset on every request.
    const windowSeconds = limits.windowMs / 1000;
    let current: number;
    try {
      current = await redis.incrWithTtl(key, windowSeconds);
    } catch (err) {
      securityLog.error({ err }, 'aiRateLimitMiddleware: Redis error');
      if (config.app.isProduction) {
        return c.json({ error: 'Service temporarily unavailable' }, 503);
      }
      current = 0; // fail open in dev
    }

    if (current > limits.requests) {
      c.header('X-RateLimit-Limit', limits.requests.toString());
      c.header('X-RateLimit-Remaining', '0');
      c.header('X-RateLimit-Reset', (60).toString());
      return c.json({
        error: 'AI rate limit exceeded',
        retryAfter: 60
      }, 429);
    }
    
    c.header('X-RateLimit-Limit', limits.requests.toString());
    c.header('X-RateLimit-Remaining', (limits.requests - current).toString());
    
    await next();
  };
}


export function sanitizeInput(input: string, maxLength = 10000): string {
  if (!input || typeof input !== 'string') return '';

  // Remove null bytes and control characters (except newlines/tabs)
  // eslint-disable-next-line no-control-regex -- intentional removal of control characters for input sanitization
  let sanitized = input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Trim to max length
  if (sanitized.length > maxLength) {
    sanitized = sanitized.slice(0, maxLength);
  }

  return sanitized.trim();
}

// ============================================================================
// PUBLIC (UNAUTHENTICATED) IP RATE LIMITER
// ============================================================================

const PUBLIC_IP_RATE_LIMIT = 60;       // requests
const PUBLIC_IP_WINDOW_SECONDS = 60;   // per minute

/**
 * IP-based rate limiter for unauthenticated (public) tRPC routes.
 *
 * Uses Redis INCR + EXPIRE to maintain a per-IP counter with a 60-second
 * rolling window.  Key format: `rate:public:ip:{ip}`.
 *
 * If the request already carries a valid Bearer token the user-level bucket
 * in rateLimitMiddleware already applies, so this middleware is skipped to
 * avoid double-counting authenticated users.
 *
 * Behaviour when Redis is unavailable:
 *   - Production: FAIL CLOSED (429) — same posture as checkRateLimit.
 *   - Development: ALLOW with warning.
 */
export function publicIpRateLimitMiddleware() {
  return async (c: Context, next: Next) => {
    // Skip IP rate limiting only when the request carries a *verified* Bearer
    // token.  Checking for the header alone (without verification) allows an
    // attacker to send `Authorization: Bearer garbage` and bypass IP limits
    // entirely — an unauthenticated DoS vector.
    const authHeader = c.req.header('authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      try {
        await firebaseAuth.verifyIdToken(token);
        // Token is valid — the per-user bucket in rateLimitMiddleware applies.
        await next();
        return;
      } catch {
        // Token is invalid/garbage — fall through to IP-based rate limiting.
      }
    }

    // Derive client IP using trusted resolution (rightmost XFF entry, set by
    // our reverse proxy — not the leftmost, which is client-supplied and
    // trivially spoofable).
    const rawIp = getTrustedClientIP(c);

    const key = `rate:public:ip:${rawIp}`;

    try {
      // Atomic INCR + conditional EXPIRE via Lua script (see redis.incrWithTtl).
      // A non-atomic INCR then EXPIRE pair risks leaving an immortal key if the
      // process crashes between the two calls — permanently blocking the IP.
      const current = await redis.incrWithTtl(key, PUBLIC_IP_WINDOW_SECONDS);

      const remaining = Math.max(0, PUBLIC_IP_RATE_LIMIT - current);
      c.header('X-RateLimit-Limit', String(PUBLIC_IP_RATE_LIMIT));
      c.header('X-RateLimit-Remaining', String(remaining));

      if (current > PUBLIC_IP_RATE_LIMIT) {
        return c.json(
          {
            error: 'Too Many Requests',
            message: `Rate limit exceeded. Try again in ${PUBLIC_IP_WINDOW_SECONDS} seconds.`,
            retryAfter: PUBLIC_IP_WINDOW_SECONDS,
          },
          429,
        );
      }
    } catch (err) {
      // Redis error — fail closed in production, open in dev.
      if (config.app.isProduction) {
        return c.json(
          { error: 'Too Many Requests', message: 'Rate limiting unavailable', retryAfter: PUBLIC_IP_WINDOW_SECONDS },
          429,
        );
      }
      // Development: log and allow.
      console.warn('[publicIpRateLimit] Redis error — allowing request in dev mode', err);
    }

    await next();
  };
}

