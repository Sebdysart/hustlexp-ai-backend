/**
 * AI Endpoint Rate Limiting
 */

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { TRPCError } from '@trpc/server';
import { config } from '../config.js';
import { rateLimiterEventsTotal } from '../monitoring/metrics.js';

interface RateLimitConfig {
  requests: number;
  window: string;
}

const AGENT_RATE_LIMITS: Record<string, RateLimitConfig> = {
  judge: { requests: 10, window: '1 m' },
  matchmaker: { requests: 30, window: '1 m' },
  dispute: { requests: 5, window: '1 m' },
  reputation: { requests: 20, window: '1 m' },
  onboarding: { requests: 5, window: '1 h' },
  moderation: { requests: 50, window: '1 m' },
  default: { requests: 20, window: '1 m' },
};

let redis: Redis | null = null;
const ratelimits: Map<string, Ratelimit> = new Map();

function getRedis(): Redis {
  if (!redis) {
    if (!config.redis.restUrl || !config.redis.restToken) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'HX003: Redis not configured for rate limiting' });
    }
    redis = new Redis({ url: config.redis.restUrl, token: config.redis.restToken });
  }
  return redis;
}

function getRatelimit(agent: string): Ratelimit {
  if (!ratelimits.has(agent)) {
    const limitConfig = AGENT_RATE_LIMITS[agent] || AGENT_RATE_LIMITS.default;
    const ratelimit = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(limitConfig.requests, limitConfig.window as `${number} s` | `${number} ms` | `${number} m` | `${number} h` | `${number} d`),
      analytics: true,
      prefix: `ratelimit:ai:${agent}`,
    });
    ratelimits.set(agent, ratelimit);
  }
  return ratelimits.get(agent)!;
}

export interface RateLimitResult {
  status: 'allowed' | 'limited' | 'unavailable';
  limit: number;
  remaining: number;
  reset: number;
}

export async function checkRateLimit(agent: string, userId: string): Promise<RateLimitResult> {
  try {
    const ratelimit = getRatelimit(agent);
    const { success, limit, remaining, reset } = await ratelimit.limit(`${agent}:${userId}`);
    if (typeof success !== 'boolean' || !Number.isFinite(limit) || !Number.isFinite(remaining)
      || !Number.isFinite(reset) || reset <= 0) throw new Error('Malformed AI limiter response');
    if (!success) rateLimiterEventsTotal.inc({ outcome: 'quota_hit' });
    return { status: success ? 'allowed' : 'limited', limit, remaining, reset };
  } catch {
    // Intentional fail-CLOSED: consistent with UserAIBudget and AIRouter budget guards.
    // A Redis failure or connection exhaustion must not silently bypass per-user limits.
    rateLimiterEventsTotal.inc({ outcome: 'backend_failure' });
    return { status: 'unavailable', limit: 0, remaining: 0, reset: 0 };
  }
}

export async function requireRateLimit(agent: string, userId: string): Promise<void> {
  const result = await checkRateLimit(agent, userId);
  if (result.status === 'unavailable') throw new TRPCError({
    code: 'SERVICE_UNAVAILABLE', message: 'AI rate limiting temporarily unavailable.',
  });
  if (result.status === 'limited') {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: `HX703: Rate limit exceeded for ${agent}. Try again in ${Math.ceil((result.reset - Date.now()) / 1000)}s`,
    });
  }
}

export default { checkRateLimit, requireRateLimit };
