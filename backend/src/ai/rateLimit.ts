/**
 * AI Endpoint Rate Limiting
 */

import { randomUUID } from 'crypto';
import { TRPCError } from '@trpc/server';
import {
  getRedisCommandClient,
  takeSlidingWindow,
} from '../redis/RedisCommandPort.js';

interface RateLimitConfig {
  requests: number;
  windowMs: number;
}

const AGENT_RATE_LIMITS: Record<string, RateLimitConfig> = {
  judge: { requests: 10, windowMs: 60_000 },
  matchmaker: { requests: 30, windowMs: 60_000 },
  dispute: { requests: 5, windowMs: 60_000 },
  reputation: { requests: 20, windowMs: 60_000 },
  onboarding: { requests: 5, windowMs: 60 * 60_000 },
  moderation: { requests: 50, windowMs: 60_000 },
  default: { requests: 20, windowMs: 60_000 },
};

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  reset: number;
}

export async function checkRateLimit(agent: string, userId: string): Promise<RateLimitResult> {
  try {
    const redis = getRedisCommandClient();
    if (!redis) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'HX003: Redis not configured for rate limiting' });
    }
    const limitConfig = AGENT_RATE_LIMITS[agent] || AGENT_RATE_LIMITS.default;
    const result = await takeSlidingWindow(redis, {
      key: `ratelimit:ai:${agent}:${userId}`,
      limit: limitConfig.requests,
      windowMs: limitConfig.windowMs,
      member: randomUUID(),
    });
    return {
      allowed: result.allowed,
      limit: result.limit,
      remaining: result.remaining,
      reset: result.resetAt,
    };
  } catch (error) {
    // Intentional fail-CLOSED: consistent with UserAIBudget and AIRouter budget guards.
    // A Redis failure or connection exhaustion must not silently bypass per-user limits.
    console.warn(`[RateLimit] Failed:`, error);
    return { allowed: false, limit: 0, remaining: 0, reset: 0 };
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
