/**
 * Background Check Initiation Handler (Phase N2.3)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Route: POST /trpc/verification.initiateBackgroundCheck
 * Purpose: Initiate background check request (user-initiated)
 * Phase: N2.3 (Verification Submission)
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS (NON-NEGOTIABLE)
 * ============================================================================
 * 
 * 1. INITIATION ONLY (NO ACCESS GRANT):
 *    ✅ Creates record in background_checks with status = PENDING
 *    ✅ Never writes to capability_profiles
 *    ✅ Never grants eligibility
 *    ✅ Never blocks unrelated work
 * 
 * 2. PRECONDITION:
 *    ✅ User opted into high-risk work (claim from onboarding)
 *    ✅ Jurisdiction supports background checks
 *    (These checks are advisory - we verify user exists and consent is true)
 * 
 * 3. IDEMPOTENCY:
 *    ✅ Duplicate submissions handled (returns existing PENDING record)
 *    ✅ One PENDING background check per user at a time
 * 
 * 4. FORBIDDEN:
 *    ❌ Immediate pass/fail (status is always PENDING on initiation)
 *    ❌ Eligibility unlocks
 *    ❌ Blocking unrelated work
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

interface BackgroundCheckRow {
  id: string;
  status: string;
  initiated_at: Date;
}

const initiateBackgroundCheckSchema = z.object({
  consent: z.boolean().refine((val) => val === true, {
    message: 'User consent is required to initiate background check',
  }),
  jurisdiction: z.string().min(2), // State/country code (e.g., 'WA', 'US')
});

export const verificationInitiateBackgroundCheckProcedure = protectedProcedure
  .input(initiateBackgroundCheckSchema)
  .mutation(async ({ ctx, input }) => {
    const firebaseUid = ctx.user?.uid;

    if (!firebaseUid) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'User ID not found in context',
      });
    }

    // Precondition: Consent must be true
    if (!input.consent) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'User consent is required to initiate background check',
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

    // N2.3 NOTE: Precondition checks (high-risk work opt-in, jurisdiction support) are advisory.
    // We verify user exists and consent is true. Jurisdiction validity is a provider concern (N2.4).

    // Step 1: Check for existing PENDING background check (idempotency)
    const existingResult = await db.query<BackgroundCheckRow>(
      `
      SELECT id, status, initiated_at
      FROM background_checks
      WHERE user_id = $1
        AND status = 'PENDING'
      LIMIT 1
      `,
      [userId]
    );

    if (existingResult.rows.length > 0) {
      // Idempotent: Return existing PENDING record
      const existing = existingResult.rows[0];
      console.log('[Background Check] Duplicate initiation detected, returning existing record:', existing.id);
      
      return {
        checkId: existing.id,
        status: 'PENDING' as const,
        initiatedAt: existing.initiated_at,
      };
    }

    // Step 2: Create new PENDING background check record
    // N2.3 ENFORCEMENT: provider_ref and provider_name are NULL on initiation
    // They will be set later (N2.4) when external provider processes the request
    const insertResult = await db.query<BackgroundCheckRow>(
      `
      INSERT INTO background_checks (
        user_id, jurisdiction, consent, status, initiated_at
      )
      VALUES ($1, $2, $3, 'PENDING', NOW())
      RETURNING id, status, initiated_at
      `,
      [userId, input.jurisdiction, input.consent]
    );

    if (insertResult.rows.length === 0) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to create background check record',
      });
    }

    const backgroundCheck = insertResult.rows[0];

    console.log('[Background Check] Created PENDING record:', {
      checkId: backgroundCheck.id,
      userId,
      jurisdiction: input.jurisdiction,
    });

    // N2.3 ENFORCEMENT: Status is always PENDING on initiation
    // No capability profile writes, no eligibility unlocks, no work blocking

    return {
      checkId: backgroundCheck.id,
      status: 'PENDING' as const,
      initiatedAt: backgroundCheck.initiated_at,
    };
  });
