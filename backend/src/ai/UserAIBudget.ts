/**
 * UserAIBudget - Per-user and global AI spending limits
 *
 * Prevents runaway costs with:
 * - Per-user $5/day ceiling across all agents
 * - Global platform $500/day budget breaker
 */

import { Redis } from '@upstash/redis';
import { config } from '../config';

const USER_DAILY_CEILING_CENTS = 500; // $5.00
const GLOBAL_DAILY_CEILING_CENTS = 50000; // $500.00
const TTL_SECONDS = 86400;

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    if (!config.redis.restUrl || !config.redis.restToken) {
      throw new Error('Redis not configured for AI budget tracking');
    }
    redis = new Redis({ url: config.redis.restUrl, token: config.redis.restToken });
  }
  return redis;
}

function getDateKey(): string {
  return new Date().toISOString().split('T')[0];
}

export async function checkUserBudget(userId: string): Promise<{ allowed: boolean; spent: number; limit: number }> {
  const key = `ai:user_spend:${userId}:${getDateKey()}`;
  try {
    const spent = Number(await getRedis().get(key) ?? 0);
    return { allowed: spent < USER_DAILY_CEILING_CENTS, spent, limit: USER_DAILY_CEILING_CENTS };
  } catch {
    return { allowed: true, spent: 0, limit: USER_DAILY_CEILING_CENTS };
  }
}

export async function trackUserCost(userId: string, costCents: number): Promise<void> {
  const key = `ai:user_spend:${userId}:${getDateKey()}`;
  try {
    await getRedis().incrby(key, costCents);
    await getRedis().expire(key, TTL_SECONDS);
  } catch {
    // Non-fatal
  }
}

export async function checkGlobalBudget(): Promise<{ allowed: boolean; spent: number; limit: number }> {
  const key = `ai:global_spend:${getDateKey()}`;
  try {
    const spent = Number(await getRedis().get(key) ?? 0);
    return { allowed: spent < GLOBAL_DAILY_CEILING_CENTS, spent, limit: GLOBAL_DAILY_CEILING_CENTS };
  } catch {
    return { allowed: true, spent: 0, limit: GLOBAL_DAILY_CEILING_CENTS };
  }
}

export async function trackGlobalCost(costCents: number): Promise<void> {
  const key = `ai:global_spend:${getDateKey()}`;
  try {
    await getRedis().incrby(key, costCents);
    await getRedis().expire(key, TTL_SECONDS);
  } catch {
    // Non-fatal
  }
}
