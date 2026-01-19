/**
 * Instant Mode Rate Limiter
 * 
 * Launch Hardening v1: Rate limits for Instant Mode operations.
 * Protects against abuse and spam.
 */

import { db } from '../db';

interface RateLimitConfig {
  maxAcceptsPerWindow: number;
  windowMinutes: number;
  maxPostsPerWindow: number;
  postWindowMinutes: number;
}

// Default rate limits (conservative)
const DEFAULT_CONFIG: RateLimitConfig = {
  maxAcceptsPerWindow: 5, // Max 5 Instant accepts per window
  windowMinutes: 15, // 15-minute window
  maxPostsPerWindow: 10, // Max 10 Instant posts per window
  postWindowMinutes: 60, // 60-minute window
};

export const InstantRateLimiter = {
  /**
   * Check if hustler can accept another Instant task
   * Returns: { allowed: boolean, reason?: string, retryAfter?: number }
   */
  checkAcceptLimit: async (hustlerId: string): Promise<{
    allowed: boolean;
    reason?: string;
    retryAfter?: number; // seconds until window resets
  }> => {
    const config = DEFAULT_CONFIG;
    const windowStart = new Date(Date.now() - config.windowMinutes * 60 * 1000);

    // Count Instant accepts in the window
    const result = await db.query<{ count: string; latest_accept: Date | null }>(
      `SELECT 
         COUNT(*) as count,
         MAX(accepted_at) as latest_accept
       FROM tasks
       WHERE worker_id = $1
         AND instant_mode = TRUE
         AND accepted_at >= $2
         AND state IN ('ACCEPTED', 'PROOF_SUBMITTED', 'COMPLETED')`,
      [hustlerId, windowStart]
    );

    const count = parseInt(result.rows[0]?.count || '0', 10);
    const latestAccept = result.rows[0]?.latest_accept;

    if (count >= config.maxAcceptsPerWindow) {
      // Calculate retry after (when the oldest accept in window expires)
      let retryAfter: number | undefined;
      if (latestAccept) {
        const oldestAcceptTime = new Date(latestAccept).getTime();
        const windowEndTime = oldestAcceptTime + config.windowMinutes * 60 * 1000;
        retryAfter = Math.max(0, Math.ceil((windowEndTime - Date.now()) / 1000));
      }

      return {
        allowed: false,
        reason: `Rate limit exceeded: Maximum ${config.maxAcceptsPerWindow} Instant accepts per ${config.windowMinutes} minutes`,
        retryAfter,
      };
    }

    return { allowed: true };
  },

  /**
   * Check if poster can post another Instant task
   * Returns: { allowed: boolean, reason?: string, retryAfter?: number }
   */
  checkPostLimit: async (posterId: string): Promise<{
    allowed: boolean;
    reason?: string;
    retryAfter?: number; // seconds until window resets
  }> => {
    const config = DEFAULT_CONFIG;
    const windowStart = new Date(Date.now() - config.postWindowMinutes * 60 * 1000);

    // Count Instant posts in the window
    const result = await db.query<{ count: string; latest_post: Date | null }>(
      `SELECT 
         COUNT(*) as count,
         MAX(created_at) as latest_post
       FROM tasks
       WHERE poster_id = $1
         AND instant_mode = TRUE
         AND created_at >= $2`,
      [posterId, windowStart]
    );

    const count = parseInt(result.rows[0]?.count || '0', 10);
    const latestPost = result.rows[0]?.latest_post;

    if (count >= config.maxPostsPerWindow) {
      // Calculate retry after
      let retryAfter: number | undefined;
      if (latestPost) {
        const oldestPostTime = new Date(latestPost).getTime();
        const windowEndTime = oldestPostTime + config.postWindowMinutes * 60 * 1000;
        retryAfter = Math.max(0, Math.ceil((windowEndTime - Date.now()) / 1000));
      }

      return {
        allowed: false,
        reason: `Rate limit exceeded: Maximum ${config.maxPostsPerWindow} Instant posts per ${config.postWindowMinutes} minutes`,
        retryAfter,
      };
    }

    return { allowed: true };
  },
};
