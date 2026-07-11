import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { checkRateLimit } from '../cache/redis.js';
import { logger } from '../logger.js';

const log = logger.child({ router: 'task' });
const configuredR2Host = (() => {
  const raw = process.env.R2_PUBLIC_URL || '';
  try {
    return raw ? new URL(raw).hostname : null;
  } catch {
    return null;
  }
})();

function isApprovedProofMediaHost(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    if (configuredR2Host && hostname === configuredR2Host) return true;
    return /^pub-[a-f0-9]+\.r2\.dev$/.test(hostname);
  } catch {
    return false;
  }
}

export const approvedProofMediaUrl = z.string().url().max(2048).refine(isApprovedProofMediaHost, {
  message: 'Proof media URL must be from an approved storage domain (R2 only)',
});

async function enforceRateLimit(userId: string, lane: string, limit: number, message: string): Promise<void> {
  try {
    const result = await checkRateLimit(userId, lane, limit, 60);
    if (!result.allowed) throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    log.warn({ err: error, userId, lane }, 'Redis unavailable for task rate limit; allowing request');
  }
}

export function checkDraftEvalRateLimit(userId: string): Promise<void> {
  return enforceRateLimit(userId, 'task:draft', 5, 'Too many draft evaluations. Please wait before trying again.');
}

export function checkTaskCreateRateLimit(userId: string): Promise<void> {
  return enforceRateLimit(userId, 'task:create', 3, 'Task creation limit reached. You can create up to 3 tasks per minute.');
}
