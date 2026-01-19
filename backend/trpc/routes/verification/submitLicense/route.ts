/**
 * License Verification Submission Handler (Phase N2.3)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Route: POST /trpc/verification.submitLicense
 * Purpose: Submit license verification claim (user-submitted)
 * Phase: N2.3 (Verification Submission)
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS (NON-NEGOTIABLE)
 * ============================================================================
 * 
 * 1. SUBMISSION ONLY (NO ACCESS GRANT):
 *    ✅ Creates record in license_verifications with status = PENDING
 *    ✅ Never writes to capability_profiles
 *    ✅ Never creates verified_trades
 *    ✅ Never grants eligibility
 *    ✅ Never triggers recompute
 * 
 * 2. IDEMPOTENCY:
 *    ✅ Duplicate submissions handled (returns existing PENDING record)
 *    ✅ Unique constraint prevents multiple PENDING verifications for same license
 * 
 * 3. FORBIDDEN:
 *    ❌ Writing capability_profiles
 *    ❌ Creating verified_trades
 *    ❌ Granting eligibility
 *    ❌ Sync validation with external agencies (that's N2.4)
 *    ❌ Status other than PENDING on creation
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

interface LicenseVerificationRow {
  id: string;
  status: string;
  submitted_at: Date;
}

const submitLicenseSchema = z.object({
  tradeType: z.string().min(1),
  licenseNumber: z.string().min(1),
  issuingState: z.string().length(2), // Two-letter state code
  expirationDate: z.string().date().optional(),
  attachments: z.array(z.string().url()).optional(),
});

export const verificationSubmitLicenseProcedure = protectedProcedure
  .input(submitLicenseSchema)
  .mutation(async ({ ctx, input) => {
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

    // Step 1: Check for existing PENDING verification (idempotency)
    const existingResult = await db.query<LicenseVerificationRow>(
      `
      SELECT id, status, submitted_at
      FROM license_verifications
      WHERE user_id = $1
        AND trade_type = $2
        AND license_number = $3
        AND issuing_state = $4
        AND status = 'PENDING'
      LIMIT 1
      `,
      [userId, input.tradeType, input.licenseNumber, input.issuingState]
    );

    if (existingResult.rows.length > 0) {
      // Idempotent: Return existing PENDING record
      const existing = existingResult.rows[0];
      console.log('[License Verification] Duplicate submission detected, returning existing record:', existing.id);
      
      return {
        verificationId: existing.id,
        status: 'PENDING' as const,
        submittedAt: existing.submitted_at,
      };
    }

    // Step 2: Create new PENDING verification record
    const insertResult = await db.query<LicenseVerificationRow>(
      `
      INSERT INTO license_verifications (
        user_id, trade_type, license_number, issuing_state,
        expiration_date, status, source, submitted_at, attachments
      )
      VALUES ($1, $2, $3, $4, $5, 'PENDING', 'USER_SUBMITTED', NOW(), $6)
      RETURNING id, status, submitted_at
      `,
      [
        userId,
        input.tradeType,
        input.licenseNumber,
        input.issuingState,
        input.expirationDate || null,
        input.attachments || [],
      ]
    );

    if (insertResult.rows.length === 0) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to create license verification record',
      });
    }

    const verification = insertResult.rows[0];

    console.log('[License Verification] Created PENDING record:', {
      verificationId: verification.id,
      userId,
      tradeType: input.tradeType,
    });

    // N2.3 ENFORCEMENT: Status is always PENDING on creation
    // No capability profile writes, no verified_trades writes, no eligibility changes

    return {
      verificationId: verification.id,
      status: 'PENDING' as const,
      submittedAt: verification.submitted_at,
    };
  });
