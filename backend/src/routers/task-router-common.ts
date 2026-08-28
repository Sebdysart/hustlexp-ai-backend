import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { checkRateLimit } from '../cache/redis.js';
import { logger } from '../logger.js';

const log = logger.child({ router: 'task' });
export const approvedProofMediaUrl = z.string().max(
  0,
  'Direct proof media URLs are disabled; use finalized upload receipts.',
);

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
