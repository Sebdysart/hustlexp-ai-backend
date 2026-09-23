import { TRPCError } from '@trpc/server';
import type { RateLimitResult } from '../cache/redis.js';
import { logger } from '../logger.js';
import { rateLimiterEventsTotal, rateLimiterFallbackActive } from '../monitoring/metrics.js';

const sensitiveProcedures = new Set([
  'completionVerification.generateForPoster', 'completionVerification.verifyForBusiness',
  'taskRework.generateCompletionCode', 'businessTask.verifyReworkCompletionCode',
  'quotePayment.createTilledCheckout', 'quotePayment.finalizeTilledCheckout',
  'quotePayment.completeControlledTestPayment',
  'businessPayment.startTilledOnboarding', 'businessPayment.refreshTilledOnboarding',
]);
const sensitivePrefixes = ['ai.', 'disputeAI.', 'matchmaker.', 'escrow.', 'subscription.', 'fraud.'];

export function sensitiveRateLimitPath(path: string): boolean {
  if (!path.startsWith('/trpc/')) return false;
  return path.slice('/trpc/'.length).split(',').some((procedure) =>
    sensitiveProcedures.has(procedure) || sensitivePrefixes.some((prefix) => procedure.startsWith(prefix))
      || procedure === 'taskDiscovery.getAISuggestions');
}

// Emergency per-process budget only. Cross-replica limits resume with Redis.
const MAX_KEYS = 10_000;
const buckets = new Map<string, { count: number; expires: number }>();
let fallbackActive = false;
let lastSweep = 0;
let backendUnhealthy = false;

function markFallback(active: boolean): void {
  if (fallbackActive === active) return;
  fallbackActive = active;
  rateLimiterFallbackActive.set(active ? 1 : 0);
  rateLimiterEventsTotal.inc({ outcome: active ? 'fallback_entered' : 'fallback_recovered' });
  logger[active ? 'warn' : 'info'](active
    ? 'Redis rate limiter unavailable; using bounded local emergency budget'
    : 'Redis rate limiter recovered; local emergency budget idle');
}

function localLimit(key: string, limit: number, windowSeconds: number): RateLimitResult {
  const now = Date.now();
  if (now - lastSweep >= 60_000 || buckets.size >= MAX_KEYS) {
    for (const [candidate, bucket] of buckets) if (bucket.expires <= now) buckets.delete(candidate);
    lastSweep = now;
  }
  const existing = buckets.get(key);
  if (!existing && buckets.size >= MAX_KEYS) {
    return { status: 'unavailable', remaining: 0 };
  }
  const bucket = existing && existing.expires > now ? existing : { count: 0, expires: now + windowSeconds * 1000 };
  bucket.count += 1;
  buckets.set(key, bucket);
  return { status: bucket.count <= limit ? 'allowed' : 'limited',
    remaining: Math.max(0, limit - bucket.count), resetAt: bucket.expires };
}

export function applyRateLimitPolicy(
  result: RateLimitResult, key: string, limit: number, windowSeconds: number,
  sensitive: boolean,
): RateLimitResult {
  if (result.status === 'unavailable') {
    rateLimiterEventsTotal.inc({ outcome: 'backend_failure' });
    if (!backendUnhealthy) backendUnhealthy = true;
    if (sensitive) return result;
    markFallback(true);
    const fallback = localLimit(key, limit, windowSeconds);
    if (fallback.status === 'limited') rateLimiterEventsTotal.inc({ outcome: 'quota_hit' });
    return fallback;
  }
  if (backendUnhealthy) {
    backendUnhealthy = false;
    rateLimiterEventsTotal.inc({ outcome: 'backend_recovered' });
  }
  markFallback(false);
  if (result.status === 'limited') rateLimiterEventsTotal.inc({ outcome: 'quota_hit' });
  return result;
}

export function enforceProcedureRateLimit(
  result: RateLimitResult, key: string, limit: number, windowSeconds: number,
  sensitive = false, message = 'Rate limit exceeded.',
): void {
  const resolved = applyRateLimitPolicy(result, key, limit, windowSeconds, sensitive);
  if (resolved.status === 'unavailable') throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'Rate limiting temporarily unavailable.' });
  if (resolved.status === 'limited') throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message });
}
