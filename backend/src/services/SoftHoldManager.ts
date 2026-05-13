/**
 * SoftHoldManager
 *
 * Prevents race conditions when multiple hustlers accept the same task
 * simultaneously. Uses a DB column (soft_hold_expires_at + soft_hold_hustler_id)
 * as an atomic mutex via PostgreSQL advisory locks + UPDATE … WHERE.
 *
 * Why DB instead of Redis SET NX EX:
 *   Redis is not configured in the current environment. The DB implementation
 *   provides equivalent atomicity guarantees via a single UPDATE … WHERE that
 *   only succeeds when the hold is vacant or expired.
 *
 * Hold lifecycle:
 *   acquire → task row locked for ttl seconds → release (on accept/cancel)
 *   If TTL expires the next caller's acquire() overwrites the stale hold.
 */

import { db } from '../db.js';
import { logger as serviceLogger } from '../logger.js';

const log = serviceLogger.child({ service: 'SoftHoldManager' });

const DEFAULT_HOLD_TTL_SECONDS = 90;

export interface SoftHoldResult {
  acquired: boolean;
  holderId: string | null;
  expiresAt: Date | null;
}

export const SoftHoldManager = {
  /**
   * Try to acquire a soft hold on a task for a specific hustler.
   *
   * Atomic: a single UPDATE … WHERE ensures only one hustler can hold at a time.
   * Returns { acquired: true } if the hold was granted, { acquired: false } if
   * another hustler holds the task.
   */
  async acquire(
    taskId: string,
    hustlerId: string,
    ttlSeconds = DEFAULT_HOLD_TTL_SECONDS
  ): Promise<SoftHoldResult> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    // Atomic: only succeeds when:
    //   1. No hold exists (soft_hold_expires_at IS NULL), OR
    //   2. Existing hold has expired (soft_hold_expires_at < NOW())
    const result = await db.query<{ soft_hold_hustler_id: string; soft_hold_expires_at: Date }>(
      `UPDATE tasks
          SET soft_hold_hustler_id = $1,
              soft_hold_expires_at  = $2,
              dispatch_state        = 'soft_held',
              updated_at            = NOW()
        WHERE id = $3
          AND (
            soft_hold_expires_at IS NULL
            OR soft_hold_expires_at < NOW()
            OR soft_hold_hustler_id = $1
          )
       RETURNING soft_hold_hustler_id, soft_hold_expires_at`,
      [hustlerId, expiresAt, taskId]
    );

    if (result.rowCount === 0) {
      // Hold is occupied — read who holds it
      const current = await db.query<{ soft_hold_hustler_id: string; soft_hold_expires_at: Date }>(
        `SELECT soft_hold_hustler_id, soft_hold_expires_at FROM tasks WHERE id = $1`,
        [taskId]
      );
      const row = current.rows[0];
      log.info({ taskId, hustlerId, holder: row?.soft_hold_hustler_id }, 'Soft hold denied — task held by another hustler');
      return {
        acquired: false,
        holderId: row?.soft_hold_hustler_id ?? null,
        expiresAt: row?.soft_hold_expires_at ?? null,
      };
    }

    log.info({ taskId, hustlerId, expiresAt }, 'Soft hold acquired');
    return {
      acquired: true,
      holderId: hustlerId,
      expiresAt,
    };
  },

  /**
   * Release a soft hold. Only succeeds if the caller is the current holder.
   * Restores dispatch_state to 'broadcasting' so the task remains claimable.
   */
  async release(taskId: string, hustlerId: string): Promise<boolean> {
    const result = await db.query(
      `UPDATE tasks
          SET soft_hold_hustler_id = NULL,
              soft_hold_expires_at  = NULL,
              dispatch_state        = 'broadcasting',
              updated_at            = NOW()
        WHERE id = $1
          AND soft_hold_hustler_id = $2`,
      [taskId, hustlerId]
    );

    const released = (result.rowCount ?? 0) > 0;
    if (released) {
      log.info({ taskId, hustlerId }, 'Soft hold released');
    }
    return released;
  },

  /**
   * Check who currently holds the task.
   * Returns null if the task is not soft-held or the hold has expired.
   */
  async check(taskId: string): Promise<{ holderId: string; expiresAt: Date } | null> {
    const result = await db.query<{ soft_hold_hustler_id: string; soft_hold_expires_at: Date }>(
      `SELECT soft_hold_hustler_id, soft_hold_expires_at
         FROM tasks
        WHERE id = $1
          AND soft_hold_hustler_id IS NOT NULL
          AND soft_hold_expires_at > NOW()`,
      [taskId]
    );

    if (result.rowCount === 0) return null;

    return {
      holderId: result.rows[0].soft_hold_hustler_id,
      expiresAt: result.rows[0].soft_hold_expires_at,
    };
  },

  /**
   * Force-clear expired holds (maintenance utility).
   * Returns the number of holds cleared.
   */
  async clearExpired(): Promise<number> {
    const result = await db.query(
      `UPDATE tasks
          SET soft_hold_hustler_id = NULL,
              soft_hold_expires_at  = NULL,
              dispatch_state        = 'broadcasting',
              updated_at            = NOW()
        WHERE soft_hold_expires_at IS NOT NULL
          AND soft_hold_expires_at < NOW()
          AND dispatch_state = 'soft_held'`
    );
    const cleared = result.rowCount ?? 0;
    if (cleared > 0) {
      log.info({ cleared }, 'Cleared expired soft holds');
    }
    return cleared;
  },
};
