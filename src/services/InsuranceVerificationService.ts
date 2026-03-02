/**
 * INSURANCE VERIFICATION SERVICE
 * 
 * Manages trade-scoped insurance verification.
 * Authority: Layer 1 (Backend Service)
 * 
 * Constitutional Reference: ARCHITECTURE.md §12.5, VERIFICATION_PIPELINE_LOCKED.md §2
 * INV-ELIGIBILITY-4: Insurance validity gated by verified trade
 * 
 * @version 1.0.0
 */

import { transaction } from '../db/index.js';
import type { SqlTx } from '../db/index.js';
import { createLogger } from '../utils/logger.js';
import { CapabilityProfileService } from './CapabilityProfileService.js';

const logger = createLogger('InsuranceVerificationService');

// ============================================================================
// TYPES
// ============================================================================

export type InsuranceStatus = 'pending' | 'verified' | 'failed' | 'expired';
export type InsuranceSource = 'coi_upload' | 'manual_review';

export interface InsuranceVerification {
  id: string;
  userId: string;
  trade: string;
  status: InsuranceStatus;
  coverageAmount: number;
  verifiedAt: Date | null;
  expiresAt: Date | null;
  failureReason: string | null;
  source: InsuranceSource;
  verificationMethod: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateInsuranceVerificationInput {
  userId: string;
  trade: string;
  coverageAmount: number;
  source?: InsuranceSource;
  documentUrl?: string;
}

export interface UpdateInsuranceVerificationInput {
  status: InsuranceStatus;
  verifiedAt?: Date;
  expiresAt?: Date;
  failureReason?: string;
  verificationMethod?: string;
}

export interface VerificationResult {
  success: boolean;
  verification?: InsuranceVerification;
  error?: string;
}

// ============================================================================
// CRUD OPERATIONS
// ============================================================================

/**
 * Create a new insurance verification request.
 * INV-ELIGIBILITY-4: Requires verified trade for the same trade type.
 */
export async function createVerification(
  input: CreateInsuranceVerificationInput
): Promise<VerificationResult> {
  try {
    return await transaction(async (tx: SqlTx) => {
      // Check for verified trade (INV-ELIGIBILITY-4)
      const [verifiedTrade] = await tx`
        SELECT 1 FROM verified_trades
        WHERE user_id = ${input.userId}
          AND trade = ${input.trade}
          AND (expires_at IS NULL OR expires_at > NOW())
        LIMIT 1
      `;

      if (!verifiedTrade) {
        return {
          success: false,
          error: 'Cannot verify insurance without verified trade for this category',
        };
      }

      // Check if insurance verification already exists
      const [existing] = await tx`
        SELECT id, status FROM insurance_verifications
        WHERE user_id = ${input.userId}
          AND trade = ${input.trade}
      `;

      if (existing?.status === 'verified') {
        return {
          success: false,
          error: 'Insurance already verified for this trade',
        };
      }

      // Create or update verification record
      let verification;
      if (existing) {
        [verification] = await tx`
          UPDATE insurance_verifications
          SET 
            status = 'pending',
            coverage_amount = ${input.coverageAmount},
            source = ${input.source || 'coi_upload'},
            updated_at = NOW()
          WHERE id = ${existing.id}
          RETURNING *
        `;
      } else {
        [verification] = await tx`
          INSERT INTO insurance_verifications (
            user_id,
            trade,
            status,
            coverage_amount,
            source,
            created_at,
            updated_at
          ) VALUES (
            ${input.userId},
            ${input.trade},
            'pending',
            ${input.coverageAmount},
            ${input.source || 'coi_upload'},
            NOW(),
            NOW()
          )
          RETURNING *
        `;
      }

      logger.info({
        verificationId: verification.id,
        userId: input.userId,
        trade: input.trade,
        coverageAmount: input.coverageAmount,
      }, 'Insurance verification created');

      // Trigger async verification (OCR/manual review)
      triggerAsyncVerification(verification.id, input.documentUrl).catch(err => {
        logger.error({ error: err, verificationId: verification.id }, 'Async verification failed');
      });

      return {
        success: true,
        verification: formatVerification(verification),
      };
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error, input }, 'Failed to create insurance verification');
    return { success: false, error: message };
  }
}

/**
 * Update insurance verification status.
 * Triggers profile recompute on status change to/from verified.
 */
export async function updateVerification(
  verificationId: string,
  input: UpdateInsuranceVerificationInput
): Promise<VerificationResult> {
  try {
    return await transaction(async (tx: SqlTx) => {
      const [current] = await tx`
        SELECT * FROM insurance_verifications WHERE id = ${verificationId}
      `;

      if (!current) {
        return { success: false, error: 'Verification not found' };
      }

      const [updated] = await tx`
        UPDATE insurance_verifications
        SET 
          status = ${input.status},
          verified_at = ${input.verifiedAt || (input.status === 'verified' ? new Date() : null)},
          expires_at = ${input.expiresAt || null},
          failure_reason = ${input.failureReason || null},
          verification_method = ${input.verificationMethod || null},
          updated_at = NOW()
        WHERE id = ${verificationId}
        RETURNING *
      `;

      logger.info({
        verificationId,
        oldStatus: current.status,
        newStatus: input.status,
        userId: current.user_id,
      }, 'Insurance verification updated');

      // Recompute profile if status changed
      if (current.status !== input.status) {
        await CapabilityProfileService.recompute(current.user_id);
      }

      return {
        success: true,
        verification: formatVerification(updated),
      };
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error, verificationId }, 'Failed to update insurance verification');
    return { success: false, error: message };
  }
}

/**
 * Get insurance verification by ID.
 */
export async function getVerification(verificationId: string): Promise<InsuranceVerification | null> {
  const { sql } = await import('../db/index.js');

  const [row] = await sql`
    SELECT * FROM insurance_verifications WHERE id = ${verificationId}
  `;

  return row ? formatVerification(row) : null;
}

/**
 * Get all insurance verifications for a user.
 */
export async function getUserVerifications(userId: string): Promise<InsuranceVerification[]> {
  const { sql } = await import('../db/index.js');

  const rows = await sql`
    SELECT * FROM insurance_verifications
    WHERE user_id = ${userId}
    ORDER BY trade
  `;

  return rows.map(formatVerification);
}

/**
 * Get active insurance verifications for a user.
 */
export async function getActiveVerifications(userId: string): Promise<InsuranceVerification[]> {
  const { sql } = await import('../db/index.js');

  const rows = await sql`
    SELECT * FROM insurance_verifications
    WHERE user_id = ${userId}
      AND status = 'verified'
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY trade
  `;

  return rows.map(formatVerification);
}

// ============================================================================
// ASYNC VERIFICATION
// ============================================================================

/**
 * Trigger async verification of insurance document.
 */
async function triggerAsyncVerification(
  verificationId: string,
  documentUrl?: string
): Promise<void> {
  logger.info({ verificationId, hasDocument: !!documentUrl }, 'Starting async insurance verification');

  // TODO: Implement:
  // - OCR of Certificate of Insurance (COI)
  // - Extract policy number, coverage dates, coverage amounts
  // - Validate with insurance carrier
  // - Queue for manual review if confidence low

  logger.info({ verificationId }, 'Insurance verification queued for review');
}

// ============================================================================
// EXPIRY MANAGEMENT
// ============================================================================

/**
 * Check for expired insurance and update status.
 */
export async function checkExpiredInsurance(): Promise<{
  checked: number;
  expired: number;
}> {
  const { sql } = await import('../db/index.js');

  const result = await sql`
    UPDATE insurance_verifications
    SET status = 'expired', updated_at = NOW()
    WHERE status = 'verified'
      AND expires_at < NOW()
    RETURNING id, user_id
  `;

  interface ExpiredInsuranceRow { id: string; user_id: string; }
  // Recompute profiles for affected users
  const affectedUserIds = new Set((result as ExpiredInsuranceRow[]).map((r) => r.user_id));
  for (const userId of affectedUserIds) {
    await CapabilityProfileService.recompute(userId);
  }

  logger.info({ expired: result.length }, 'Expired insurance policies updated');

  return {
    checked: result.length,
    expired: result.length,
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

interface InsuranceVerificationRow {
  id: string;
  user_id: string;
  trade: string;
  status: InsuranceStatus;
  coverage_amount: number;
  verified_at: Date | null;
  expires_at: Date | null;
  failure_reason: string | null;
  source: InsuranceSource;
  verification_method: string | null;
  created_at: Date;
  updated_at: Date;
}

function formatVerification(row: InsuranceVerificationRow): InsuranceVerification {
  return {
    id: row.id,
    userId: row.user_id,
    trade: row.trade,
    status: row.status,
    coverageAmount: row.coverage_amount,
    verifiedAt: row.verified_at,
    expiresAt: row.expires_at,
    failureReason: row.failure_reason,
    source: row.source,
    verificationMethod: row.verification_method,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================================================
// SERVICE EXPORT
// ============================================================================

export const InsuranceVerificationService = {
  createVerification,
  updateVerification,
  getVerification,
  getUserVerifications,
  getActiveVerifications,
  checkExpiredInsurance,
};

export default InsuranceVerificationService;
