/**
 * AI Endpoint Rate Limiting
 */

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { TRPCError } from '@trpc/server';
import { config } from '../config';

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
let ratelimits: Map<string, Ratelimit> = new Map();

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
  allowed: boolean;
  limit: number;
  remaining: number;
  reset: number;
}

export async function checkRateLimit(agent: string, userId: string): Promise<RateLimitResult> {
  try {
    const ratelimit = getRatelimit(agent);
    const { success, limit, remaining, reset } = await ratelimit.limit(`${agent}:${userId}`);
    return { allowed: success, limit, remaining, reset };
  } catch (error) {
    console.warn(`[RateLimit] Failed:`, error);
    return { allowed: true, limit: 0, remaining: 0, reset: 0 };
  }
}

export async function requireRateLimit(agent: string, userId: string): Promise<void> {
  const result = await checkRateLimit(agent, userId);
  if (!result.allowed) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: `HX703: Rate limit exceeded for ${agent}. Try again in ${Math.ceil((result.reset - Date.now()) / 1000)}s`,
    });
  }
}

export default { checkRateLimit, requireRateLimit };
