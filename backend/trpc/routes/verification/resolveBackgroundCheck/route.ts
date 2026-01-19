/**
 * Background Check Resolution Handler (Phase N2.4)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Route: POST /trpc/verification.resolveBackgroundCheck
 * Purpose: Resolve background check (admin/system only)
 * Phase: N2.4 (Verification Resolution)
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS (NON-NEGOTIABLE)
 * ============================================================================
 * 
 * Same as resolveLicense:
 * - Admin/System only
 * - State transition enforcement
 * - Recompute trigger (not direct mutation)
 * - Idempotency
 * 
 * Reference: Phase N2.4 — Verification Resolution (LOCKED)
 */

import { protectedProcedure } from '../../../create-context';
import { z } from 'zod';
import { db } from '@/backend/database/client';
import { TRPCError } from '@trpc/server';
import { assertVerificationTransition } from '../state-machine';

interface BackgroundCheckRow {
  id: string;
  user_id: string;
  status: string;
}

interface UserRow {
  id: string;
  firebase_uid: string;
  role: string;
}

const resolveBackgroundCheckSchema = z.object({
  checkId: z.string().uuid(),
  decision: z.enum(['APPROVED', 'REJECTED', 'EXPIRED']),
  reason: z.string().optional(),
  decidedBy: z.enum(['ADMIN', 'SYSTEM', 'PROVIDER']),
});

export const verificationResolveBackgroundCheckProcedure = protectedProcedure
  .input(resolveBackgroundCheckSchema)
  .mutation(async ({ ctx, input }) => {
    const firebaseUid = ctx.user?.uid;

    if (!firebaseUid) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'User ID not found in context',
      });
    }

    // N2.4 ENFORCEMENT: Admin/System only
    if (input.decidedBy !== 'SYSTEM') {
      const userResult = await db.query<UserRow>(
        `SELECT id, role FROM users WHERE firebase_uid = $1 LIMIT 1`,
        [firebaseUid]
      );

      if (userResult.rows.length === 0 || userResult.rows[0].role !== 'admin') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only admin or system actors can resolve verifications',
        });
      }
    }

    // Step 1: Get current check state
    const checkResult = await db.query<BackgroundCheckRow>(
      `
      SELECT id, user_id, status
      FROM background_checks
      WHERE id = $1
      LIMIT 1
      `,
      [input.checkId]
    );

    if (checkResult.rows.length === 0) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Background check not found',
      });
    }

    const backgroundCheck = checkResult.rows[0];
    const previousStatus = backgroundCheck.status as 'PENDING' | 'APPROVED';

    // Step 2: Assert legal transition
    assertVerificationTransition(previousStatus, input.decision);

    // Step 3: Check idempotency
    if (backgroundCheck.status === input.decision) {
      return {
        checkId: input.checkId,
        previousStatus: previousStatus,
        newStatus: input.decision,
        decidedAt: new Date().toISOString(),
      };
    }

    // Step 4: Get reviewer user_id if not SYSTEM
    let reviewerUserId: string | null = null;
    if (input.decidedBy !== 'SYSTEM') {
      const reviewerResult = await db.query<{ id: string }>(
        `SELECT id FROM users WHERE firebase_uid = $1 LIMIT 1`,
        [firebaseUid]
      );
      if (reviewerResult.rows.length > 0) {
        reviewerUserId = reviewerResult.rows[0].id;
      }
    }

    // Step 5: Update background check status
    const updateResult = await db.query<{ id: string; status: string; reviewed_at: Date }>(
      `
      UPDATE background_checks
      SET 
        status = $1,
        reviewed_at = NOW(),
        reviewed_by = $2,
        updated_at = NOW()
      WHERE id = $3
        AND status = $4
      RETURNING id, status, reviewed_at
      `,
      [
        input.decision,
        reviewerUserId,
        input.checkId,
        previousStatus,
      ]
    );

    if (updateResult.rows.length === 0) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Background check status changed during resolution. Please retry.',
      });
    }

    // Step 6: Emit recompute trigger
    await db.query(
      `
      INSERT INTO job_queue (id, type, payload, status, scheduled_at)
      VALUES ($1, $2, $3, 'pending', NOW())
      ON CONFLICT (id) DO NOTHING
      `,
      [
        `recompute_capability_${backgroundCheck.user_id}_${Date.now()}`,
        'recompute_capability',
        JSON.stringify({
          userId: backgroundCheck.user_id,
          reason: 'VERIFICATION_RESOLVED',
          sourceVerificationId: input.checkId,
          verificationType: 'background_check',
        }),
      ]
    );

    console.log('[Background Check Resolution] Status updated and recompute triggered:', {
      checkId: input.checkId,
      userId: backgroundCheck.user_id,
      previousStatus,
      newStatus: input.decision,
    });

    return {
      checkId: input.checkId,
      previousStatus: previousStatus,
      newStatus: input.decision as 'APPROVED' | 'REJECTED' | 'EXPIRED',
      decidedAt: updateResult.rows[0].reviewed_at.toISOString(),
    };
  });
