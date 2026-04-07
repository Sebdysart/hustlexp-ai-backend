/**
 * BackgroundCheckService v1.0.0
 * 
 * CONSTITUTIONAL: Background check verification for workers
 * 
 * Manages criminal background check verification:
 * - Check initiation
 * - Status tracking
 * - Result recording
 * - Annual renewal workflow
 * 
 * @see ARCHITECTURE.md §11.7
 */

import { db } from '../db.js';
import { logger } from '../logger.js';
import { TRPCError } from '@trpc/server';
import { recomputeCapabilityProfile } from './CapabilityRecomputeService.js';
import { createCandidate, createInvitation } from './CheckrService.js';
import { config } from '../config.js';

const log = logger.child({ service: 'BackgroundCheckService' });

// ============================================================================
// TYPES
// ============================================================================

interface BackgroundCheckRow {
  id: string;
  user_id: string;
  provider: string;
  check_id: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'CLEAR' | 'CONSIDER' | 'FAILED' | 'EXPIRED';
  initiated_at: string;
  completed_at: string | null;
  expires_at: string | null;
  result_summary: string | null;
  details: Record<string, unknown> | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  notes: string | null;
}

interface BackgroundCheckStatusRow {
  id: string;
  status: string;
}

interface BackgroundCheckExpirationRow {
  user_id: string;
  expires_at: string;
}

export interface BackgroundCheck {
  id: string;
  userId: string;
  provider: string;
  checkId: string; // External provider's check ID
  status: 'PENDING' | 'IN_PROGRESS' | 'CLEAR' | 'CONSIDER' | 'FAILED' | 'EXPIRED';
  initiatedAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  resultSummary: string | null;
  details: Record<string, unknown> | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  notes: string | null;
}

export interface BackgroundCheckInitiation {
  userId: string;
  provider: 'checkr' | 'sterling' | 'goodhire' | 'manual';
  email?: string;
  phone?: string;
  ssnLast4?: string;
  dateOfBirth?: string;
  fullName?: string;
}

// ============================================================================
// INITIATION
// ============================================================================

/**
 * Initiate a background check
 */
export async function initiateBackgroundCheck(
  initiation: BackgroundCheckInitiation
): Promise<BackgroundCheck> {
  // Check for existing valid check
  const existingResult = await db.query<BackgroundCheckStatusRow>(
    `
    SELECT id, status
    FROM background_checks
    WHERE user_id = $1
      AND status IN ('PENDING', 'IN_PROGRESS', 'CLEAR')
      AND (expires_at IS NULL OR expires_at > CURRENT_DATE + INTERVAL '30 days')
    ORDER BY initiated_at DESC
    LIMIT 1
    `,
    [initiation.userId]
  );

  if (existingResult.rows.length > 0) {
    const existing = existingResult.rows[0];
    if (existing.status === 'PENDING' || existing.status === 'IN_PROGRESS') {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Background check already in progress',
      });
    }
    if (existing.status === 'CLEAR') {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Valid background check already on file',
      });
    }
  }

  // Call Checkr API to create candidate and invitation
  let externalCheckId: string;
  let invitationUrl: string | null = null;

  if (initiation.provider === 'checkr' && config.identity.checkr.apiKey) {
    // Parse full name into first/last
    const nameParts = (initiation.fullName || '').trim().split(/\s+/);
    const firstName = nameParts[0] || 'Unknown';
    const lastName = nameParts.slice(1).join(' ') || 'Unknown';

    // Step 1: Create candidate in Checkr
    const candidate = await createCandidate({
      firstName,
      lastName,
      email: initiation.email || '',
      phone: initiation.phone,
      dob: initiation.dateOfBirth,
    });

    // Step 2: Create invitation (sends hosted verification link)
    const invitation = await createInvitation(candidate.id, 'tasker_standard');

    externalCheckId = candidate.id;
    invitationUrl = invitation.invitation_url;

    log.info({
      userId: initiation.userId,
      candidateId: candidate.id,
      invitationUrl,
    }, 'Checkr candidate + invitation created');
  } else {
    // Fallback for manual or non-Checkr providers
    externalCheckId = `bc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    log.info({ userId: initiation.userId, provider: initiation.provider }, 'Manual background check initiated');
  }

  const expiresAt = new Date();
  expiresAt.setFullYear(expiresAt.getFullYear() + 1); // 1 year validity

  const result = await db.query<BackgroundCheckRow>(
    `
    INSERT INTO background_checks (
      user_id, provider, check_id, status,
      initiated_at, expires_at, details
    )
    VALUES ($1, $2, $3, 'PENDING', NOW(), $4, $5)
    RETURNING *
    `,
    [
      initiation.userId,
      initiation.provider,
      externalCheckId,
      expiresAt.toISOString(),
      JSON.stringify({
        ssnLast4: initiation.ssnLast4,
        dateOfBirth: initiation.dateOfBirth,
        fullName: initiation.fullName,
        invitationUrl,
      }),
    ]
  );

  const row = result.rows[0];

  log.info({
    userId: initiation.userId,
    provider: initiation.provider,
    checkId: row.id,
    externalCheckId,
  }, 'Background check initiated');

  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    checkId: row.check_id,
    status: row.status,
    initiatedAt: row.initiated_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
    resultSummary: row.result_summary,
    details: row.details,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    notes: row.notes,
  };
}

// ============================================================================
// STATUS UPDATES (Webhook handlers)
// ============================================================================

/**
 * Update background check status (called by provider webhooks)
 */
export async function updateBackgroundCheckStatus(
  externalCheckId: string,
  status: 'IN_PROGRESS' | 'CLEAR' | 'CONSIDER' | 'FAILED',
  resultSummary?: string,
  details?: Record<string, unknown>
): Promise<BackgroundCheck> {
  const result = await db.query<BackgroundCheckRow>(
    `
    UPDATE background_checks
    SET status = $2,
        completed_at = CASE WHEN $2 IN ('CLEAR', 'CONSIDER', 'FAILED') THEN NOW() ELSE NULL END,
        result_summary = COALESCE($3, result_summary),
        details = COALESCE($4, details)
    WHERE check_id = $1
    RETURNING *
    `,
    [externalCheckId, status, resultSummary || null, details ? JSON.stringify(details) : null]
  );

  if (result.rows.length === 0) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Background check not found',
    });
  }

  const row = result.rows[0];

  // If cleared, trigger capability recompute
  if (status === 'CLEAR') {
    await recomputeCapabilityProfile(row.user_id, { 
      reason: 'background_check_cleared',
      sourceVerificationId: row.id 
    });
  }

  log.info({ 
    checkId: row.id,
    userId: row.user_id,
    status 
  }, 'Background check status updated');

  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    checkId: row.check_id,
    status: row.status,
    initiatedAt: row.initiated_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
    resultSummary: row.result_summary,
    details: row.details,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    notes: row.notes,
  };
}

/**
 * Review a CONSIDER status (manual review required)
 */
export async function reviewBackgroundCheck(
  checkId: string,
  adminUserId: string,
  decision: 'CLEAR' | 'FAILED',
  notes?: string
): Promise<BackgroundCheck> {
  const result = await db.query<BackgroundCheckRow>(
    `
    UPDATE background_checks
    SET status = $3,
        reviewed_at = NOW(),
        reviewed_by = $2,
        notes = COALESCE($4, notes)
    WHERE id = $1
      AND status = 'CONSIDER'
    RETURNING *
    `,
    [checkId, adminUserId, decision, notes || null]
  );

  if (result.rows.length === 0) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Background check not found or not in CONSIDER status',
    });
  }

  const row = result.rows[0];

  // Trigger capability recompute if cleared
  if (decision === 'CLEAR') {
    await recomputeCapabilityProfile(row.user_id, { 
      reason: 'background_check_reviewed_clear',
      sourceVerificationId: row.id 
    });
  }

  log.info({ 
    checkId, 
    userId: row.user_id,
    adminUserId,
    decision 
  }, 'Background check reviewed');

  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    checkId: row.check_id,
    status: row.status,
    initiatedAt: row.initiated_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
    resultSummary: row.result_summary,
    details: row.details,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    notes: row.notes,
  };
}

// ============================================================================
// QUERIES
// ============================================================================

/**
 * Get background check for a user
 */
export async function getUserBackgroundCheck(userId: string): Promise<BackgroundCheck | null> {
  const result = await db.query<BackgroundCheckRow>(
    `
    SELECT *
    FROM background_checks
    WHERE user_id = $1
    ORDER BY initiated_at DESC
    LIMIT 1
    `,
    [userId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    checkId: row.check_id,
    status: row.status,
    initiatedAt: row.initiated_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
    resultSummary: row.result_summary,
    details: row.details,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    notes: row.notes,
  };
}

/**
 * Check if user has valid background check
 */
export async function hasValidBackgroundCheck(userId: string): Promise<boolean> {
  const result = await db.query<{ '?column?': number }>(
    `
    SELECT 1
    FROM background_checks
    WHERE user_id = $1
      AND status = 'CLEAR'
      AND (expires_at IS NULL OR expires_at > CURRENT_DATE)
    LIMIT 1
    `,
    [userId]
  );

  return result.rows.length > 0;
}

/**
 * Get checks requiring manual review
 */
export async function getPendingReviews(
  limit: number = 50,
  offset: number = 0
): Promise<BackgroundCheck[]> {
  const result = await db.query<BackgroundCheckRow>(
    `
    SELECT *
    FROM background_checks
    WHERE status = 'CONSIDER'
    ORDER BY completed_at ASC
    LIMIT $1 OFFSET $2
    `,
    [limit, offset]
  );

  return result.rows.map(row => ({
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    checkId: row.check_id,
    status: row.status,
    initiatedAt: row.initiated_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
    resultSummary: row.result_summary,
    details: row.details,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    notes: row.notes,
  }));
}

/**
 * Get checks by status
 */
export async function getChecksByStatus(
  status: BackgroundCheck['status'],
  limit: number = 50
): Promise<BackgroundCheck[]> {
  const result = await db.query<BackgroundCheckRow>(
    `
    SELECT *
    FROM background_checks
    WHERE status = $1
    ORDER BY initiated_at DESC
    LIMIT $2
    `,
    [status, limit]
  );

  return result.rows.map(row => ({
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    checkId: row.check_id,
    status: row.status,
    initiatedAt: row.initiated_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
    resultSummary: row.result_summary,
    details: row.details,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    notes: row.notes,
  }));
}

// ============================================================================
// MAINTENANCE
// ============================================================================

/**
 * Mark expired background checks
 * Called by cron job
 */
export async function markExpiredChecks(): Promise<number> {
  const result = await db.query<{ id: string; user_id: string }>(
    `
    UPDATE background_checks
    SET status = 'EXPIRED'
    WHERE status = 'CLEAR'
      AND expires_at < CURRENT_DATE
    RETURNING id, user_id
    `
  );

  // Recompute capability profiles for affected users
  const affectedUsers = new Set(result.rows.map(r => r.user_id));
  for (const userId of affectedUsers) {
    await recomputeCapabilityProfile(userId, { reason: 'background_check_expired' });
  }

  log.info({ count: result.rows.length }, 'Marked expired background checks');
  return result.rows.length;
}

/**
 * Get upcoming expirations (for renewal reminders)
 */
export async function getUpcomingExpirations(
  days: number = 30
): Promise<Array<{ userId: string; expiresAt: string }>> {
  const result = await db.query<BackgroundCheckExpirationRow>(
    `
    SELECT DISTINCT ON (user_id) user_id, expires_at
    FROM background_checks
    WHERE status = 'CLEAR'
      AND expires_at BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '${days} days'
    ORDER BY user_id, expires_at ASC
    `
  );

  return result.rows.map(r => ({
    userId: r.user_id,
    expiresAt: r.expires_at,
  }));
}

export default {
  initiateBackgroundCheck,
  updateBackgroundCheckStatus,
  reviewBackgroundCheck,
  getUserBackgroundCheck,
  hasValidBackgroundCheck,
  getPendingReviews,
  getChecksByStatus,
  markExpiredChecks,
  getUpcomingExpirations,
};
