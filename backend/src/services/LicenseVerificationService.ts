/**
 * LicenseVerificationService v1.0.0
 * 
 * CONSTITUTIONAL: Trade license verification for workers
 * 
 * Manages the verification workflow for professional licenses:
 * - Document upload and storage
 * - Verification status tracking
 * - Expiration monitoring
 * - State-by-state trade validation
 * 
 * @see ARCHITECTURE.md §11.5
 */

import { db } from '../db.js';
import { logger } from '../logger.js';
import { TRPCError } from '@trpc/server';
import { recomputeCapabilityProfile } from './CapabilityRecomputeService.js';

const log = logger.child({ service: 'LicenseVerificationService' });

// ============================================================================
// TYPES
// ============================================================================

interface LicenseVerificationRow {
  id: string;
  user_id: string;
  trade_type: string;
  issuing_state: string;
  license_number: string;
  expiration_date: string | null;
  document_url: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  submitted_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  rejection_reason: string | null;
  notes: string | null;
}

interface LicenseStatusRow {
  id: string;
  status: string;
}

export interface LicenseVerification {
  id: string;
  userId: string;
  tradeType: string;
  issuingState: string;
  licenseNumber: string;
  expirationDate: string | null;
  documentUrl: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  submittedAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  rejectionReason: string | null;
  notes: string | null;
}

export interface LicenseSubmission {
  userId: string;
  tradeType: string;
  issuingState: string;
  licenseNumber: string;
  expirationDate?: string;
  documentUrl?: string;
}

// Valid trades that require licensing
export const LICENSED_TRADES = [
  'electrician',
  'plumber',
  'hvac',
  'contractor',
  'carpenter',
  'painter',
  'landscaper',
  'mechanic',
  'appliance_repair',
  'pest_control',
] as const;

// States with reciprocity agreements
export const RECIPROCITY_AGREEMENTS: Record<string, string[]> = {
  'CA': ['NV', 'AZ'],
  'NY': ['NJ', 'CT'],
  'TX': ['OK', 'NM'],
  'FL': ['GA', 'AL'],
};

// ============================================================================
// SUBMISSION
// ============================================================================

/**
 * Submit a license for verification
 */
export async function submitLicense(
  submission: LicenseSubmission
): Promise<LicenseVerification> {
  if (submission.documentUrl?.trim()) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Direct license document URLs are disabled until private receipt-backed credential upload is available.',
    });
  }
  // Validate trade type
  if (!(LICENSED_TRADES as readonly string[]).includes(submission.tradeType)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Trade type '${submission.tradeType}' does not require licensing`,
    });
  }

  // Check for existing verification
  const existingResult = await db.query<LicenseStatusRow>(
    `
    SELECT id, status
    FROM license_verifications
    WHERE user_id = $1
      AND trade_type = $2
      AND issuing_state = $3
      AND status IN ('PENDING', 'APPROVED')
    ORDER BY submitted_at DESC
    LIMIT 1
    `,
    [submission.userId, submission.tradeType, submission.issuingState]
  );

  if (existingResult.rows.length > 0) {
    const existing = existingResult.rows[0];
    if (existing.status === 'PENDING') {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'License verification already pending for this trade and state',
      });
    }
    if (existing.status === 'APPROVED') {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'License already verified for this trade and state',
      });
    }
  }

  // Create verification record
  const result = await db.query<LicenseVerificationRow>(
    `
    INSERT INTO license_verifications (
      user_id, trade_type, issuing_state, license_number,
      expiration_date, document_url, status, submitted_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', NOW())
    RETURNING *
    `,
    [
      submission.userId,
      submission.tradeType,
      submission.issuingState,
      submission.licenseNumber,
      submission.expirationDate || null,
      submission.documentUrl || null,
    ]
  );

  const row = result.rows[0];
  
  log.info({ 
    userId: submission.userId, 
    trade: submission.tradeType,
    state: submission.issuingState,
    verificationId: row.id 
  }, 'License verification submitted');

  return {
    id: row.id,
    userId: row.user_id,
    tradeType: row.trade_type,
    issuingState: row.issuing_state,
    licenseNumber: row.license_number,
    expirationDate: row.expiration_date,
    documentUrl: row.document_url,
    status: row.status,
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    rejectionReason: row.rejection_reason,
    notes: row.notes,
  };
}

// ============================================================================
// REVIEW (Admin/Ops)
// ============================================================================

/**
 * Approve a license verification
 */
export async function approveLicense(
  verificationId: string,
  adminUserId: string,
  notes?: string
): Promise<LicenseVerification> {
  const result = await db.query<LicenseVerificationRow>(
    `
    UPDATE license_verifications
    SET status = 'APPROVED',
        reviewed_at = NOW(),
        reviewed_by = $2,
        notes = COALESCE($3, notes)
    WHERE id = $1
      AND status = 'PENDING'
    RETURNING *
    `,
    [verificationId, adminUserId, notes || null]
  );

  if (result.rows.length === 0) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'License verification not found or not in PENDING status',
    });
  }

  const row = result.rows[0];

  // Trigger capability recompute
  await recomputeCapabilityProfile(row.user_id, { 
    reason: 'license_approved',
    sourceVerificationId: verificationId 
  });

  log.info({ 
    verificationId, 
    userId: row.user_id,
    adminUserId 
  }, 'License verification approved');

  return {
    id: row.id,
    userId: row.user_id,
    tradeType: row.trade_type,
    issuingState: row.issuing_state,
    licenseNumber: row.license_number,
    expirationDate: row.expiration_date,
    documentUrl: row.document_url,
    status: row.status,
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    rejectionReason: row.rejection_reason,
    notes: row.notes,
  };
}

/**
 * Reject a license verification
 */
export async function rejectLicense(
  verificationId: string,
  adminUserId: string,
  reason: string,
  notes?: string
): Promise<LicenseVerification> {
  const result = await db.query<LicenseVerificationRow>(
    `
    UPDATE license_verifications
    SET status = 'REJECTED',
        reviewed_at = NOW(),
        reviewed_by = $2,
        rejection_reason = $3,
        notes = COALESCE($4, notes)
    WHERE id = $1
      AND status = 'PENDING'
    RETURNING *
    `,
    [verificationId, adminUserId, reason, notes || null]
  );

  if (result.rows.length === 0) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'License verification not found or not in PENDING status',
    });
  }

  const row = result.rows[0];

  log.info({ 
    verificationId, 
    userId: row.user_id,
    adminUserId,
    reason 
  }, 'License verification rejected');

  return {
    id: row.id,
    userId: row.user_id,
    tradeType: row.trade_type,
    issuingState: row.issuing_state,
    licenseNumber: row.license_number,
    expirationDate: row.expiration_date,
    documentUrl: row.document_url,
    status: row.status,
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    rejectionReason: row.rejection_reason,
    notes: row.notes,
  };
}

// ============================================================================
// QUERIES
// ============================================================================

/**
 * Get license verifications for a user
 */
export async function getUserLicenses(userId: string): Promise<LicenseVerification[]> {
  const result = await db.query<LicenseVerificationRow>(
    `
    SELECT *
    FROM license_verifications
    WHERE user_id = $1
    ORDER BY trade_type, issuing_state, submitted_at DESC
    `,
    [userId]
  );

  return result.rows.map(row => ({
    id: row.id,
    userId: row.user_id,
    tradeType: row.trade_type,
    issuingState: row.issuing_state,
    licenseNumber: row.license_number,
    expirationDate: row.expiration_date,
    documentUrl: row.document_url,
    status: row.status,
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    rejectionReason: row.rejection_reason,
    notes: row.notes,
  }));
}

/**
 * Get pending verifications (for admin queue)
 */
export async function getPendingVerifications(
  limit: number = 50,
  offset: number = 0
): Promise<LicenseVerification[]> {
  const result = await db.query<LicenseVerificationRow>(
    `
    SELECT *
    FROM license_verifications
    WHERE status = 'PENDING'
    ORDER BY submitted_at ASC
    LIMIT $1 OFFSET $2
    `,
    [limit, offset]
  );

  return result.rows.map(row => ({
    id: row.id,
    userId: row.user_id,
    tradeType: row.trade_type,
    issuingState: row.issuing_state,
    licenseNumber: row.license_number,
    expirationDate: row.expiration_date,
    documentUrl: row.document_url,
    status: row.status,
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    rejectionReason: row.rejection_reason,
    notes: row.notes,
  }));
}

/**
 * Check if license is valid for a trade in a state
 */
export async function hasValidLicense(
  userId: string,
  tradeType: string,
  state: string
): Promise<boolean> {
  const result = await db.query<{ '?column?': number }>(
    `
    SELECT 1
    FROM license_verifications
    WHERE user_id = $1
      AND trade_type = $2
      AND issuing_state = $3
      AND status = 'APPROVED'
      AND (expiration_date IS NULL OR expiration_date > CURRENT_DATE)
    LIMIT 1
    `,
    [userId, tradeType, state]
  );

  if (result.rows.length > 0) {
    return true;
  }

  // Check reciprocity
  const reciprocityStates = RECIPROCITY_AGREEMENTS[state] || [];
  if (reciprocityStates.length === 0) {
    return false;
  }

  const reciprocityResult = await db.query<{ '?column?': number }>(
    `
    SELECT 1
    FROM license_verifications
    WHERE user_id = $1
      AND trade_type = $2
      AND issuing_state = ANY($3)
      AND status = 'APPROVED'
      AND (expiration_date IS NULL OR expiration_date > CURRENT_DATE)
    LIMIT 1
    `,
    [userId, tradeType, reciprocityStates]
  );

  return reciprocityResult.rows.length > 0;
}

// ============================================================================
// MAINTENANCE
// ============================================================================

/**
 * Mark expired licenses
 * Called by cron job
 */
export async function markExpiredLicenses(): Promise<number> {
  const result = await db.query<{ id: string; user_id: string }>(
    `
    UPDATE license_verifications
    SET status = 'EXPIRED'
    WHERE status = 'APPROVED'
      AND expiration_date < CURRENT_DATE
    RETURNING id, user_id
    `
  );

  // Recompute capability profiles for affected users
  const affectedUsers = new Set(result.rows.map(r => r.user_id));
  for (const userId of affectedUsers) {
    await recomputeCapabilityProfile(userId, { reason: 'license_expired' });
  }

  log.info({ count: result.rows.length }, 'Marked expired licenses');
  return result.rows.length;
}

export default {
  submitLicense,
  approveLicense,
  rejectLicense,
  getUserLicenses,
  getPendingVerifications,
  hasValidLicense,
  markExpiredLicenses,
  LICENSED_TRADES,
  RECIPROCITY_AGREEMENTS,
};
