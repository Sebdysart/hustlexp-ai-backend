import { db } from '../db.js';
import { logger } from '../logger.js';
import { recomputeCapabilityProfile } from './CapabilityRecomputeService.js';
import {
  backgroundCheckFromRow,
  type BackgroundCheck,
  type BackgroundCheckRow,
  type BackgroundCheckStatus,
} from './BackgroundCheckTypes.js';

const log = logger.child({ service: 'BackgroundCheckService' });

export async function getUserBackgroundCheck(userId: string): Promise<BackgroundCheck | null> {
  const result = await db.query<BackgroundCheckRow>(
    `SELECT *
     FROM background_checks
     WHERE user_id = $1
     ORDER BY initiated_at DESC
     LIMIT 1`,
    [userId],
  );
  return result.rows[0] ? backgroundCheckFromRow(result.rows[0]) : null;
}

export async function hasValidBackgroundCheck(userId: string): Promise<boolean> {
  const result = await db.query<{ '?column?': number }>(
    `SELECT 1
     FROM background_checks
     WHERE user_id = $1
       AND status = 'CLEAR'
       AND provider_environment = 'PRODUCTION'
       AND is_test IS FALSE
       AND (expires_at IS NULL OR expires_at > CURRENT_DATE)
     LIMIT 1`,
    [userId],
  );
  return result.rows.length > 0;
}

export async function getPendingReviews(
  limit = 50,
  offset = 0,
): Promise<BackgroundCheck[]> {
  const result = await db.query<BackgroundCheckRow>(
    `SELECT *
     FROM background_checks
     WHERE status = 'CONSIDER'
     ORDER BY completed_at ASC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return result.rows.map(backgroundCheckFromRow);
}

export async function getChecksByStatus(
  status: BackgroundCheckStatus,
  limit = 50,
): Promise<BackgroundCheck[]> {
  const result = await db.query<BackgroundCheckRow>(
    `SELECT *
     FROM background_checks
     WHERE status = $1
     ORDER BY initiated_at DESC
     LIMIT $2`,
    [status, limit],
  );
  return result.rows.map(backgroundCheckFromRow);
}

export async function markExpiredChecks(): Promise<number> {
  const result = await db.query<{ id: string; user_id: string }>(
    `UPDATE background_checks
     SET status = 'EXPIRED'
     WHERE status = 'CLEAR'
       AND provider_environment = 'PRODUCTION'
       AND is_test IS FALSE
       AND expires_at < CURRENT_DATE
     RETURNING id, user_id`,
  );
  const affectedUsers = new Set(result.rows.map((row) => row.user_id));
  for (const userId of affectedUsers) {
    await recomputeCapabilityProfile(userId, { reason: 'background_check_expired' });
  }
  log.info({ count: result.rows.length }, 'Marked expired background checks');
  return result.rows.length;
}

export async function getUpcomingExpirations(
  days = 30,
): Promise<Array<{ userId: string; expiresAt: string }>> {
  const result = await db.query<{ user_id: string; expires_at: string }>(
    `SELECT DISTINCT ON (user_id) user_id, expires_at
     FROM background_checks
     WHERE status = 'CLEAR'
       AND expires_at BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '${days} days'
     ORDER BY user_id, expires_at ASC`,
  );
  return result.rows.map((row) => ({ userId: row.user_id, expiresAt: row.expires_at }));
}
