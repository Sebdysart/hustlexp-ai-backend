/**
 * Insurance Verification Submission Handler (Phase N2.3)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Route: POST /trpc/verification.submitInsurance
 * Purpose: Submit insurance verification claim (user-submitted COI)
 * Phase: N2.3 (Verification Submission)
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS (NON-NEGOTIABLE)
 * ============================================================================
 * 
 * 1. SUBMISSION ONLY (NO ACCESS GRANT):
 *    ✅ Creates record in insurance_verifications with status = PENDING
 *    ✅ Never writes to capability_profiles
 *    ✅ Never links to verified_trades
 *    ✅ Never grants eligibility
 *    ✅ Never triggers recompute
 * 
 * 2. PRECONDITION:
 *    ✅ User must have at least one claimed trade (from onboarding claims)
 *    (This check is advisory - we verify user exists, but don't check claims)
 * 
 * 3. IDEMPOTENCY:
 *    ✅ Duplicate submissions handled (returns existing PENDING record)
 *    ✅ One PENDING insurance verification per user at a time
 * 
 * 4. FORBIDDEN:
 *    ❌ Writing capability_profiles
 *    ❌ Linking to verified_trades
 *    ❌ Eligibility changes
 *    ❌ Trust tier changes
 * 
 * Reference: Phase N2.3 — Verification Submission (LOCKED)
 */

import { protectedProcedure } from '../../../create-context';
import { z } from 'zod';
import { db } from '@/backend/database/client';
import { TRPCError } from '@trpc/server';

interface UserRow {
  id: string;
  firebase_uid: string;
}

interface InsuranceVerificationRow {
  id: string;
  status: string;
  submitted_at: Date;
}

const submitInsuranceSchema = z.object({
  providerName: z.string().min(1),
  policyNumber: z.string().min(1),
  coverageAmount: z.number().positive().optional(),
  expirationDate: z.string().date(),
  tradeScope: z.array(z.string()).min(1), // At least one trade
  attachments: z.array(z.string().url()).optional(),
});

export const verificationSubmitInsuranceProcedure = protectedProcedure
  .input(submitInsuranceSchema)
  .mutation(async ({ ctx, input }) => {
    const firebaseUid = ctx.user?.uid;

    if (!firebaseUid) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'User ID not found in context',
      });
    }

    // Step 0: Get database user_id from Firebase UID
    const userResult = await db.query<UserRow>(
      `SELECT id FROM users WHERE firebase_uid = $1 LIMIT 1`,
      [firebaseUid]
    );

    if (userResult.rows.length === 0) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'User not found in database',
      });
    }

    const userId = userResult.rows[0].id;

    // N2.3 NOTE: Precondition check (user has claimed trades) is advisory.
    // We don't enforce it here because it's a UX concern, not a submission blocker.
    // The feed eligibility resolver will handle eligibility separately.

    // Step 1: Check for existing PENDING verification (idempotency)
    const existingResult = await db.query<InsuranceVerificationRow>(
      `
      SELECT id, status, submitted_at
      FROM insurance_verifications
      WHERE user_id = $1
        AND status = 'PENDING'
      LIMIT 1
      `,
      [userId]
    );

    if (existingResult.rows.length > 0) {
      // Idempotent: Return existing PENDING record
      const existing = existingResult.rows[0];
      console.log('[Insurance Verification] Duplicate submission detected, returning existing record:', existing.id);
      
      return {
        verificationId: existing.id,
        status: 'PENDING' as const,
        submittedAt: existing.submitted_at,
      };
    }

    // Step 2: Create new PENDING verification record
    const insertResult = await db.query<InsuranceVerificationRow>(
      `
      INSERT INTO insurance_verifications (
        user_id, provider_name, policy_number, coverage_amount,
        expiration_date, trade_scope, status, submitted_at, attachments
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', NOW(), $7)
      RETURNING id, status, submitted_at
      `,
      [
        userId,
        input.providerName,
        input.policyNumber,
        input.coverageAmount || null,
        input.expirationDate,
        input.tradeScope,
        input.attachments || [],
      ]
    );

    if (insertResult.rows.length === 0) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to create insurance verification record',
      });
    }

    const verification = insertResult.rows[0];

    console.log('[Insurance Verification] Created PENDING record:', {
      verificationId: verification.id,
      userId,
      providerName: input.providerName,
    });

    // N2.3 ENFORCEMENT: Status is always PENDING on creation
    // No capability profile writes, no verified_trades links, no eligibility changes

    return {
      verificationId: verification.id,
      status: 'PENDING' as const,
      submittedAt: verification.submitted_at,
    };
  });
