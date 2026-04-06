/**
 * Verification Router v1.0.0
 *
 * Phone and email verification endpoints.
 * Phone: Twilio Verify OTP (send code → check code)
 * Email: Firebase email verification status check
 *
 * Verification status is tracked in the `users_identity` table.
 * Successful phone verification bumps trust_tier from 0→1.
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc.js';
import { db } from '../db.js';
import { logger } from '../logger.js';
import { sendVerification, checkVerification } from '../services/TwilioSMSService.js';
import { getFirebaseUser, generateEmailVerificationLink as fbGenerateEmailVerificationLink } from '../auth/firebase.js';
import { invalidateUser } from '../cache/db-cache.js';
import { invalidateAuthCacheForUser } from '../auth-cache.js';
import type { User } from '../types.js';

const log = logger.child({ router: 'verification' });

// E.164 phone format: +<country code><number>, 7-15 digits total
const E164_REGEX = /^\+[1-9]\d{6,14}$/;

export const verificationRouter = router({
  // --------------------------------------------------------------------------
  // GET VERIFICATION STATUS
  // --------------------------------------------------------------------------

  /**
   * Returns the current phone/email verification status for the user.
   * Creates a users_identity row if one doesn't exist yet.
   */
  getStatus: protectedProcedure
    .input(z.void())
    .query(async ({ ctx }) => {
      // Upsert users_identity row
      const result = await db.query<{
        email_verified: boolean;
        phone_verified: boolean;
        phone: string | null;
        email: string | null;
        email_verified_at: Date | null;
        phone_verified_at: Date | null;
      }>(
        `INSERT INTO users_identity (user_id, email, phone)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
         RETURNING email_verified, phone_verified, phone, email, email_verified_at, phone_verified_at`,
        [ctx.user.id, ctx.user.email, ctx.user.phone ?? null]
      );

      const row = result.rows[0];

      // Also check Firebase email verification status
      let firebaseEmailVerified = false;
      if (ctx.user.firebase_uid) {
        try {
          const fbUser = await getFirebaseUser(ctx.user.firebase_uid);
          firebaseEmailVerified = fbUser.emailVerified;

          // Sync Firebase email verified status to our DB if it changed
          if (firebaseEmailVerified && !row.email_verified) {
            await db.query(
              `UPDATE users_identity
               SET email_verified = TRUE, email_verified_at = NOW(), updated_at = NOW()
               WHERE user_id = $1`,
              [ctx.user.id]
            );
            await db.query(
              `UPDATE users SET email_verified = TRUE WHERE id = $1`,
              [ctx.user.id]
            );
            row.email_verified = true;
            row.email_verified_at = new Date();
            log.info({ userId: ctx.user.id }, 'Synced Firebase email verification to DB');
          }
        } catch (err) {
          log.warn({ userId: ctx.user.id, err }, 'Failed to check Firebase email verification');
        }
      }

      return {
        phoneVerified: row.phone_verified,
        emailVerified: row.email_verified || firebaseEmailVerified,
        phone: row.phone,
        email: row.email ?? ctx.user.email,
        phoneVerifiedAt: row.phone_verified_at?.toISOString() ?? null,
        emailVerifiedAt: row.email_verified_at?.toISOString() ?? null,
      };
    }),

  // --------------------------------------------------------------------------
  // PHONE VERIFICATION
  // --------------------------------------------------------------------------

  /**
   * Send an OTP code to the user's phone number via Twilio Verify.
   */
  sendPhoneOTP: protectedProcedure
    .input(z.object({
      phone: z.string().regex(E164_REGEX, 'Phone must be in E.164 format (e.g. +15551234567)'),
    }))
    .mutation(async ({ ctx, input }) => {
      // Rate limit: max 3 OTP sends per 10 minutes per user
      const recentAttempts = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM sms_outbox
         WHERE user_id = $1 AND created_at > NOW() - INTERVAL '10 minutes'`,
        [ctx.user.id]
      );
      if (parseInt(recentAttempts.rows[0]?.count ?? '0', 10) >= 3) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many verification attempts. Please wait 10 minutes.',
        });
      }

      // Ensure users_identity row exists
      await db.query(
        `INSERT INTO users_identity (user_id, email, phone)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET phone = $3, updated_at = NOW()`,
        [ctx.user.id, ctx.user.email, input.phone]
      );

      // Send OTP via Twilio Verify
      const result = await sendVerification(input.phone, 'sms');

      if (!result.success) {
        log.error({ userId: ctx.user.id, phone: input.phone, err: result.error }, 'Phone OTP send failed');
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error ?? 'Failed to send verification code. Please try again.',
        });
      }

      log.info({ userId: ctx.user.id, phone: input.phone }, 'Phone OTP sent');

      return { success: true };
    }),

  /**
   * Verify the OTP code the user received.
   * On success: marks phone_verified=true, updates trust_tier if needed.
   */
  verifyPhone: protectedProcedure
    .input(z.object({
      phone: z.string().regex(E164_REGEX, 'Phone must be in E.164 format'),
      code: z.string().length(6, 'Code must be 6 digits').regex(/^\d{6}$/, 'Code must be 6 digits'),
    }))
    .mutation(async ({ ctx, input }) => {
      // Check code via Twilio Verify
      const result = await checkVerification(input.phone, input.code);

      if (!result.success) {
        log.error({ userId: ctx.user.id, err: result.error }, 'Phone verification check failed');
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error ?? 'Verification service error. Please try again.',
        });
      }

      if (!result.valid) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Invalid or expired code. Please try again.',
        });
      }

      // Mark phone as verified
      await db.query(
        `UPDATE users_identity
         SET phone_verified = TRUE, phone_verified_at = NOW(), phone = $2, updated_at = NOW()
         WHERE user_id = $1`,
        [ctx.user.id, input.phone]
      );

      // Update user's phone number
      await db.query(
        `UPDATE users SET phone = $2, updated_at = NOW() WHERE id = $1`,
        [ctx.user.id, input.phone]
      );

      // Bump trust_tier from 0→1 if currently unverified
      const userResult = await db.query<User>(
        `UPDATE users SET trust_tier = GREATEST(trust_tier, 1), updated_at = NOW()
         WHERE id = $1 AND trust_tier < 1
         RETURNING *`,
        [ctx.user.id]
      );

      if (userResult.rows.length > 0) {
        log.info({ userId: ctx.user.id }, 'Trust tier bumped to 1 after phone verification');
      }

      // Invalidate caches
      await invalidateUser(ctx.user.id);
      invalidateAuthCacheForUser(ctx.user.id);

      log.info({ userId: ctx.user.id, phone: input.phone }, 'Phone verified successfully');

      return { success: true, phoneVerified: true };
    }),

  // --------------------------------------------------------------------------
  // EMAIL VERIFICATION
  // --------------------------------------------------------------------------

  /**
   * Send a verification email via Firebase.
   * Firebase handles the email link; we just trigger it.
   */
  sendEmailVerification: protectedProcedure
    .input(z.void())
    .mutation(async ({ ctx }) => {
      if (!ctx.user.firebase_uid) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'No Firebase account linked.',
        });
      }

      try {
        const link = await fbGenerateEmailVerificationLink(ctx.user.email);
        // The link is generated — Firebase sends the email automatically
        // when using generateEmailVerificationLink with an action code settings.
        // For now, we log it. In production, you'd send via SendGrid for custom branding.
        log.info({ userId: ctx.user.id, email: ctx.user.email }, 'Email verification link generated');

        return { success: true };
      } catch (err) {
        log.error({ userId: ctx.user.id, err }, 'Failed to generate email verification link');
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to send verification email. Please try again.',
        });
      }
    }),

  /**
   * Check if the user's email has been verified in Firebase and sync to DB.
   * Call this after the user clicks the verification link.
   */
  checkEmailVerification: protectedProcedure
    .input(z.void())
    .mutation(async ({ ctx }) => {
      if (!ctx.user.firebase_uid) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'No Firebase account linked.',
        });
      }

      const fbUser = await getFirebaseUser(ctx.user.firebase_uid);

      if (!fbUser.emailVerified) {
        return { emailVerified: false };
      }

      // Sync to DB
      await db.query(
        `UPDATE users_identity
         SET email_verified = TRUE, email_verified_at = NOW(), updated_at = NOW()
         WHERE user_id = $1`,
        [ctx.user.id]
      );
      await db.query(
        `UPDATE users SET email_verified = TRUE WHERE id = $1`,
        [ctx.user.id]
      );

      await invalidateUser(ctx.user.id);
      invalidateAuthCacheForUser(ctx.user.id);

      log.info({ userId: ctx.user.id }, 'Email verified successfully');

      return { emailVerified: true };
    }),
});

export type VerificationRouter = typeof verificationRouter;
