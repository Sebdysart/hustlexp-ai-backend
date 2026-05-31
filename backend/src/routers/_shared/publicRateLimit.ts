/**
 * Shared rate-limit + IP-derivation helpers for PUBLIC anonymous endpoints.
 *
 * Anonymous endpoints (no auth) are a wallet-drain vector and a scraping
 * vector. Every one of them must derive a stable client key and then pass
 * through the same three-layer Redis-backed rate limit:
 *
 *   Layer 1 — per-IP burst   (fails OPEN; degradation > denial)
 *   Layer 2 — per-IP daily   (fails OPEN)
 *   Layer 3 — GLOBAL kill switch (fails CLOSED; cannot risk uncapped spend)
 *
 * Lifted from the original inline implementation in task.ts (draftEstimate).
 * Kept here so additional public endpoints (geo.availability, etc.) cannot
 * accidentally drift from the same invariants.
 */
import { TRPCError } from '@trpc/server';
import { checkRateLimit } from '../../cache/redis.js';
import { logger } from '../../logger.js';

const rlLog = logger.child({ module: 'publicRateLimit' });

export interface PublicRateLimitOptions {
  /** Category name used as the Redis namespace, e.g. 'task:draft-estimate' or 'geo:availability'. */
  category: string;
  /** Burst layer: max requests per `burstWindowSec` per IP. */
  burstLimit: number;
  burstWindowSec: number;
  /** Daily layer: max requests per `dailyWindowSec` per IP. */
  dailyLimit: number;
  dailyWindowSec: number;
  /** Global kill switch: max total requests per `globalWindowSec` across all callers. */
  globalLimit: number;
  globalWindowSec: number;
  /** Caller-facing message when burst/daily limits fire. */
  burstMessage?: string;
  dailyMessage?: string;
  /** Caller-facing message when the global kill switch fires (or Redis is down). */
  globalMessage?: string;
}

/**
 * Run the three-layer public rate-limit check.
 * Throws TRPCError TOO_MANY_REQUESTS on per-IP overage, SERVICE_UNAVAILABLE
 * on global cap or Redis failure during the global check.
 */
export async function checkPublicAnonRateLimit(
  ipKey: string,
  opts: PublicRateLimitOptions
): Promise<void> {
  const {
    category,
    burstLimit,
    burstWindowSec,
    dailyLimit,
    dailyWindowSec,
    globalLimit,
    globalWindowSec,
    burstMessage = "You've made a lot of requests. Please wait a minute before trying again.",
    dailyMessage = "You've reached today's free limit. Try again tomorrow.",
    globalMessage = 'This endpoint is taking a breath — please try again later.',
  } = opts;

  // Layer 1: per-IP burst — fails OPEN.
  try {
    const burst = await checkRateLimit(ipKey, `${category}:burst`, burstLimit, burstWindowSec);
    if (!burst.allowed) {
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: burstMessage });
    }
  } catch (err) {
    if (err instanceof TRPCError) throw err;
    rlLog.warn({ err, ipKey, category }, 'Redis unavailable for burst layer — allowing request');
  }

  // Layer 2: per-IP daily — fails OPEN.
  try {
    const daily = await checkRateLimit(ipKey, `${category}:daily`, dailyLimit, dailyWindowSec);
    if (!daily.allowed) {
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: dailyMessage });
    }
  } catch (err) {
    if (err instanceof TRPCError) throw err;
    rlLog.warn({ err, ipKey, category }, 'Redis unavailable for daily layer — allowing request');
  }

  // Layer 3: GLOBAL kill switch — fails CLOSED.
  try {
    const global = await checkRateLimit('GLOBAL', `${category}:global`, globalLimit, globalWindowSec);
    if (!global.allowed) {
      rlLog.warn({ category }, 'global daily kill switch fired');
      throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: globalMessage });
    }
  } catch (err) {
    if (err instanceof TRPCError) throw err;
    rlLog.error({ err, category }, 'Redis unavailable for global kill switch — failing closed');
    throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: globalMessage });
  }
}

/**
 * Derive a stable IP key from forwarded / real-ip headers.
 *
 * In production we rely on a reverse proxy (Vercel / Cloudflare / nginx) to
 * always set x-forwarded-for; if neither header is present, we refuse the
 * request rather than let an unkeyed call through. In dev/test there is no
 * proxy, so a browser-direct localhost request has neither header — we fall
 * back to a fixed 'dev-local' key. All dev callers share that one bucket,
 * which is fine because dev requests are cheap and not adversarial.
 */
export function deriveIpKey(headers: Headers | undefined): string | null {
  const xff = headers?.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const realIp = headers?.get('x-real-ip');
  if (realIp) {
    const trimmed = realIp.trim();
    if (trimmed) return trimmed;
  }
  if (process.env.NODE_ENV !== 'production') return 'dev-local';
  return null;
}
