/**
 * InsuranceVerificationService v1.0.0
 * 
 * CONSTITUTIONAL: Insurance verification for workers
 * 
 * Manages general liability insurance verification:
 * - Policy document upload
 * - Coverage amount validation
 * - Expiration tracking
 * - Annual renewal workflow
 * 
 * @see ARCHITECTURE.md §11.6
 */

import { db } from '../db';
import { logger } from '../logger';
import { TRPCError } from '@trpc/server';
import { recomputeCapabilityProfile } from './CapabilityRecomputeService';

const log = logger.child({ service: 'InsuranceVerificationService' });

// ============================================================================
// TYPES
// ============================================================================

export interface InsuranceVerification {
  id: string;
  userId: string;
  provider: string;
  policyNumber: string;
  coverageAmountCents: number;
  expirationDate: string;
  documentUrl: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  submittedAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  rejectionReason: string | null;
  notes: string | null;
}

export interface InsuranceSubmission {
  userId: string;
  provider: string;
  policyNumber: string;
  coverageAmount: number; // in dollars
  expirationDate: string;
  documentUrl?: string;
}

// Minimum coverage requirements by trade
export const MIN_COVERAGE_REQUIREMENTS: Record<string, number> = {
  'default': 1_000_000, // $1M default
  'electrician': 1_000_000,
  'plumber': 1_000_000,
  'hvac': 1_000_000,
  'contractor': 2_000_000,
  'carpenter': 1_000_000,
  'painter': 500_000,
  'landscaper': 500_000,
  'mechanic': 1_000_000,
  'appliance_repair': 500_000,
  'pest_control': 500_000,
};

// ============================================================================
// SUBMISSION
// ============================================================================

/**
 * Submit insurance for verification
 */
export async function submitInsurance(
  submission: InsuranceSubmission
): Promise<InsuranceVerification> {
  // Check for existing valid verification
  const existingResult = await db.query<Record<string, any>>(
    `
    SELECT id, status
    FROM insurance_verifications
    WHERE user_id = $1
      AND status IN ('PENDING', 'APPROVED')
      AND expiration_date > CURRENT_DATE + INTERVAL '30 days'
    ORDER BY submitted_at DESC
    LIMIT 1
    `,
    [submission.userId]
  );

  if (existingResult.rows.length > 0) {
    const existing = existingResult.rows[0];
    if (existing.status === 'PENDING') {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Insurance verification already pending',
      });
    }
    if (existing.status === 'APPROVED') {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Valid insurance already on file',
      });
    }
  }

  // Validate coverage amount (minimum $500K)
  const minCoverage = 500_000; // $500K minimum
  if (submission.coverageAmount < minCoverage) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Coverage amount must be at least $${minCoverage.toLocaleString()}`,
    });
  }

  // Create verification record
  const result = await db.query<Record<string, any>>(
    `
    INSERT INTO insurance_verifications (
      user_id, provider, policy_number, coverage_amount_cents,
      expiration_date, document_url, status, submitted_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', NOW())
    RETURNING *
    `,
    [
      submission.userId,
      submission.provider,
      submission.policyNumber,
      submission.coverageAmount * 100, // Convert to cents
      submission.expirationDate,
      submission.documentUrl || null,
    ]
  );

  const row = result.rows[0];
  
  log.info({ 
    userId: submission.userId, 
    provider: submission.provider,
    coverage: submission.coverageAmount,
    verificationId: row.id 
  }, 'Insurance verification submitted');

  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    policyNumber: row.policy_number,
    coverageAmountCents: row.coverage_amount_cents,
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
// REVIEW
// ============================================================================

/**
 * Approve insurance verification
 */
export async function approveInsurance(
  verificationId: string,
  adminUserId: string,
  notes?: string
): Promise<InsuranceVerification> {
  const result = await db.query<Record<string, any>>(
    `
    UPDATE insurance_verifications
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
      message: 'Insurance verification not found or not in PENDING status',
    });
  }

  const row = result.rows[0];

  // Trigger capability recompute
  await recomputeCapabilityProfile(row.user_id, { 
    reason: 'insurance_approved',
    sourceVerificationId: verificationId 
  });

  log.info({ 
    verificationId, 
    userId: row.user_id,
    adminUserId 
  }, 'Insurance verification approved');

  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    policyNumber: row.policy_number,
    coverageAmountCents: row.coverage_amount_cents,
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
 * Reject insurance verification
 */
export async function rejectInsurance(
  verificationId: string,
  adminUserId: string,
  reason: string,
  notes?: string
): Promise<InsuranceVerification> {
  const result = await db.query<Record<string, any>>(
    `
    UPDATE insurance_verifications
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
      message: 'Insurance verification not found or not in PENDING status',
    });
  }

  const row = result.rows[0];

  log.info({ 
    verificationId, 
    userId: row.user_id,
    adminUserId,
    reason 
  }, 'Insurance verification rejected');

  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    policyNumber: row.policy_number,
    coverageAmountCents: row.coverage_amount_cents,
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
 * Get insurance verification for a user
 */
export async function getUserInsurance(userId: string): Promise<InsuranceVerification | null> {
  const result = await db.query<Record<string, any>>(
    `
    SELECT *
    FROM insurance_verifications
    WHERE user_id = $1
    ORDER BY submitted_at DESC
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
    policyNumber: row.policy_number,
    coverageAmountCents: row.coverage_amount_cents,
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
 * Check if user has valid insurance
 */
export async function hasValidInsurance(userId: string): Promise<boolean> {
  const result = await db.query<Record<string, any>>(
    `
    SELECT 1
    FROM insurance_verifications
    WHERE user_id = $1
      AND status = 'APPROVED'
      AND expiration_date > CURRENT_DATE
    LIMIT 1
    `,
    [userId]
  );

  return result.rows.length > 0;
}

/**
 * Get pending verifications (for admin queue)
 */
export async function getPendingVerifications(
  limit: number = 50,
  offset: number = 0
): Promise<InsuranceVerification[]> {
  const result = await db.query<Record<string, any>>(
    `
    SELECT *
    FROM insurance_verifications
    WHERE status = 'PENDING'
    ORDER BY submitted_at ASC
    LIMIT $1 OFFSET $2
    `,
    [limit, offset]
  );

  return result.rows.map(row => ({
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    policyNumber: row.policy_number,
    coverageAmountCents: row.coverage_amount_cents,
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

// ============================================================================
// MAINTENANCE
// ============================================================================

/**
 * Mark expired insurance policies
 * Called by cron job
 */
export async function markExpiredInsurance(): Promise<number> {
  const result = await db.query<Record<string, any>>(
    `
    UPDATE insurance_verifications
    SET status = 'EXPIRED'
    WHERE status = 'APPROVED'
      AND expiration_date < CURRENT_DATE
    RETURNING id, user_id
    `
  );

  // Recompute capability profiles for affected users
  const affectedUsers = new Set(result.rows.map(r => r.user_id));
  for (const userId of affectedUsers) {
    await recomputeCapabilityProfile(userId, { reason: 'insurance_expired' });
  }

  log.info({ count: result.rows.length }, 'Marked expired insurance policies');
  return result.rows.length;
}

/**
 * Get upcoming expirations (for renewal reminders)
 */
export async function getUpcomingExpirations(
  days: number = 30
): Promise<Array<{ userId: string; expirationDate: string }>> {
  const result = await db.query<Record<string, any>>(
    `
    SELECT DISTINCT ON (user_id) user_id, expiration_date
    FROM insurance_verifications
    WHERE status = 'APPROVED'
      AND expiration_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '${days} days'
    ORDER BY user_id, expiration_date ASC
    `
  );

  return result.rows.map(r => ({
    userId: r.user_id,
    expirationDate: r.expiration_date,
  }));
}

export default {
  submitInsurance,
  approveInsurance,
  rejectInsurance,
  getUserInsurance,
  hasValidInsurance,
  getPendingVerifications,
  markExpiredInsurance,
  getUpcomingExpirations,
  MIN_COVERAGE_REQUIREMENTS,
};
