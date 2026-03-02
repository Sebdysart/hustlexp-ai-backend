/**
 * LICENSE VERIFICATION SERVICE
 * 
 * Manages trade license verification workflow.
 * Authority: Layer 1 (Backend Service)
 * 
 * Constitutional Reference: ARCHITECTURE.md §12, VERIFICATION_PIPELINE_LOCKED.md
 * 
 * @version 1.0.0
 */

import { transaction } from '../db/index.js';
import type { SqlTx } from '../db/index.js';
import { createLogger } from '../utils/logger.js';
import { CapabilityProfileService } from './CapabilityProfileService.js';
import { getErrorMessage } from '../utils/errors.js';

const logger = createLogger('LicenseVerificationService');

// ============================================================================
// TYPES
// ============================================================================

export type LicenseStatus = 'pending' | 'verified' | 'failed' | 'expired';
export type VerificationSource = 'registry' | 'document' | 'manual_review';

export interface LicenseVerification {
  id: string;
  userId: string;
  trade: string;
  state: string;
  licenseNumber: string;
  licenseType: string | null;
  status: LicenseStatus;
  verifiedAt: Date | null;
  expiresAt: Date | null;
  failureReason: string | null;
  source: VerificationSource;
  verificationMethod: string | null;
  verificationProvider: string | null;
  confidenceScore: number | null;
  reviewerId: string | null;
  reviewNotes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateLicenseVerificationInput {
  userId: string;
  trade: string;
  state: string;
  licenseNumber: string;
  licenseType?: string;
  source?: VerificationSource;
}

export interface UpdateLicenseVerificationInput {
  status: LicenseStatus;
  verifiedAt?: Date;
  expiresAt?: Date;
  failureReason?: string;
  reviewerId?: string;
  reviewNotes?: string;
  confidenceScore?: number;
  verificationMethod?: string;
  verificationProvider?: string;
}

export interface VerificationResult {
  success: boolean;
  verification?: LicenseVerification;
  error?: string;
}

// ============================================================================
// CRUD OPERATIONS
// ============================================================================

/**
 * Create a new license verification request.
 * Triggers async verification process.
 */
export async function createVerification(
  input: CreateLicenseVerificationInput
): Promise<VerificationResult> {
  try {
    return await transaction(async (tx: SqlTx) => {
      // Check if verification already exists for this user/trade/state
      const [existing] = await tx`
        SELECT id, status FROM license_verifications
        WHERE user_id = ${input.userId}
          AND trade = ${input.trade}
          AND state = ${input.state}
          AND status IN ('pending', 'verified')
      `;

      if (existing) {
        if (existing.status === 'verified') {
          return {
            success: false,
            error: 'License already verified for this trade and state',
          };
        }
        return {
          success: false,
          error: 'Verification already pending for this trade and state',
        };
      }

      // Create verification record
      const [verification] = await tx`
        INSERT INTO license_verifications (
          user_id,
          trade,
          state,
          license_number,
          license_type,
          status,
          source,
          created_at,
          updated_at
        ) VALUES (
          ${input.userId},
          ${input.trade},
          ${input.state},
          ${input.licenseNumber},
          ${input.licenseType || null},
          'pending',
          ${input.source || 'manual_review'},
          NOW(),
          NOW()
        )
        RETURNING *
      `;

      logger.info({
        verificationId: verification.id,
        userId: input.userId,
        trade: input.trade,
        state: input.state,
      }, 'License verification created');

      // Trigger async verification
      triggerAsyncVerification(verification.id).catch(err => {
        logger.error({ error: err, verificationId: verification.id }, 'Async verification failed');
      });

      return {
        success: true,
        verification: formatVerification(verification),
      };
    });
  } catch (error: unknown) {
    logger.error({ error, input }, 'Failed to create license verification');
    return { success: false, error: getErrorMessage(error) };
  }
}

/**
 * Update license verification status.
 * Triggers profile recompute on status change.
 */
export async function updateVerification(
  verificationId: string,
  input: UpdateLicenseVerificationInput
): Promise<VerificationResult> {
  try {
    return await transaction(async (tx: SqlTx) => {
      // Get current verification
      const [current] = await tx`
        SELECT * FROM license_verifications WHERE id = ${verificationId}
      `;

      if (!current) {
        return { success: false, error: 'Verification not found' };
      }

      // Update verification
      const [updated] = await tx`
        UPDATE license_verifications
        SET 
          status = ${input.status},
          verified_at = ${input.verifiedAt || (input.status === 'verified' ? new Date() : null)},
          expires_at = ${input.expiresAt || null},
          failure_reason = ${input.failureReason || null},
          reviewer_id = ${input.reviewerId || null},
          review_notes = ${input.reviewNotes || null},
          confidence_score = ${input.confidenceScore || null},
          verification_method = ${input.verificationMethod || null},
          verification_provider = ${input.verificationProvider || null},
          updated_at = NOW()
        WHERE id = ${verificationId}
        RETURNING *
      `;

      logger.info({
        verificationId,
        oldStatus: current.status,
        newStatus: input.status,
        userId: current.user_id,
      }, 'License verification updated');

      // Recompute capability profile on status change
      if (current.status !== input.status) {
        await CapabilityProfileService.recompute(current.user_id);
      }

      return {
        success: true,
        verification: formatVerification(updated),
      };
    });
  } catch (error: unknown) {
    logger.error({ error, verificationId }, 'Failed to update license verification');
    return { success: false, error: getErrorMessage(error) };
  }
}

/**
 * Get license verification by ID.
 */
export async function getVerification(verificationId: string): Promise<LicenseVerification | null> {
  const { sql } = await import('../db/index.js');

  const [row] = await sql`
    SELECT * FROM license_verifications WHERE id = ${verificationId}
  `;

  return row ? formatVerification(row) : null;
}

/**
 * Get all license verifications for a user.
 */
export async function getUserVerifications(userId: string): Promise<LicenseVerification[]> {
  const { sql } = await import('../db/index.js');

  const rows = await sql`
    SELECT * FROM license_verifications
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
  `;

  return rows.map(formatVerification);
}

/**
 * Get active (verified and not expired) license verifications for a user.
 */
export async function getActiveVerifications(userId: string): Promise<LicenseVerification[]> {
  const { sql } = await import('../db/index.js');

  const rows = await sql`
    SELECT * FROM license_verifications
    WHERE user_id = ${userId}
      AND status = 'verified'
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY trade, state
  `;

  return rows.map(formatVerification);
}

// ============================================================================
// ASYNC VERIFICATION
// ============================================================================

/**
 * Trigger async verification of a license.
 * This would integrate with state registry APIs or manual review queues.
 */
async function triggerAsyncVerification(verificationId: string): Promise<void> {
  logger.info({ verificationId }, 'Starting async license verification');

  // PLANNED: Implement actual verification logic
  // - Check state contractor registry APIs
  // - OCR document verification
  // - Queue for manual review

  // For now, simulate manual review queue
  await new Promise(resolve => setTimeout(resolve, 100));

  logger.info({ verificationId }, 'Async verification queued');
}

/**
 * Process automated registry lookup.
 * Returns verification result from state contractor registry.
 */
export async function processRegistryLookup(
  verificationId: string
): Promise<{ valid: boolean; expiresAt?: Date; licenseType?: string } | null> {
  // PLANNED: Implement state registry API integrations
  // Examples:
  // - California: CSLB (Contractors State License Board)
  // - Texas: TDLR (Texas Department of Licensing and Regulation)
  // - Florida: DBPR (Department of Business and Professional Regulation)

  logger.info({ verificationId }, 'Registry lookup not yet implemented');
  return null;
}

// ============================================================================
// EXPIRY MANAGEMENT
// ============================================================================

/**
 * Check for expired licenses and update status.
 * Should be called by scheduled job.
 */
export async function checkExpiredLicenses(): Promise<{
  checked: number;
  expired: number;
}> {
  const { sql } = await import('../db/index.js');

  const result = await sql`
    UPDATE license_verifications
    SET status = 'expired', updated_at = NOW()
    WHERE status = 'verified'
      AND expires_at < NOW()
    RETURNING id, user_id
  `;

  interface ExpiredLicenseRow { id: string; user_id: string; }
  // Recompute profiles for affected users
  const affectedUserIds = new Set((result as ExpiredLicenseRow[]).map((r) => r.user_id));
  for (const userId of affectedUserIds) {
    await CapabilityProfileService.recompute(userId);
  }

  logger.info({ expired: result.length }, 'Expired licenses updated');

  return {
    checked: result.length,
    expired: result.length,
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

interface LicenseVerificationRow {
  id: string;
  user_id: string;
  trade: string;
  state: string;
  license_number: string;
  license_type: string | null;
  status: LicenseStatus;
  verified_at: Date | null;
  expires_at: Date | null;
  failure_reason: string | null;
  source: VerificationSource;
  verification_method: string | null;
  verification_provider: string | null;
  confidence_score: number | null;
  reviewer_id: string | null;
  review_notes: string | null;
  created_at: Date;
  updated_at: Date;
}

function formatVerification(row: LicenseVerificationRow): LicenseVerification {
  return {
    id: row.id,
    userId: row.user_id,
    trade: row.trade,
    state: row.state,
    licenseNumber: row.license_number,
    licenseType: row.license_type,
    status: row.status,
    verifiedAt: row.verified_at,
    expiresAt: row.expires_at,
    failureReason: row.failure_reason,
    source: row.source,
    verificationMethod: row.verification_method,
    verificationProvider: row.verification_provider,
    confidenceScore: row.confidence_score,
    reviewerId: row.reviewer_id,
    reviewNotes: row.review_notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================================================
// SERVICE EXPORT
// ============================================================================

export const LicenseVerificationService = {
  createVerification,
  updateVerification,
  getVerification,
  getUserVerifications,
  getActiveVerifications,
  processRegistryLookup,
  checkExpiredLicenses,
};

export default LicenseVerificationService;
