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
import { config } from '../config.js';
import sgMail from '@sendgrid/mail';
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
    .input(z.object({}).optional())
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
            // email_verified tracked in users_identity only
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
      log.info({ userId: ctx.user.id, phone: input.phone }, '>>> sendPhoneOTP called');

      // Rate limit: max 3 OTP sends per 10 minutes per user
      // sms_outbox table may not exist — skip rate limiting if so
      try {
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
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        log.warn({ err }, 'sms_outbox rate limit check failed (table may not exist) — skipping');
      }

      // Ensure users_identity row exists
      try {
        await db.query(
          `INSERT INTO users_identity (user_id, email, phone)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id) DO UPDATE SET phone = $3, updated_at = NOW()`,
          [ctx.user.id, ctx.user.email, input.phone]
        );
        log.info({ userId: ctx.user.id }, 'users_identity upserted');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ userId: ctx.user.id, err: msg }, 'FAILED: users_identity upsert');
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Database error: ${msg}`,
        });
      }

      // Send OTP via Twilio Verify
      log.info({ phone: input.phone }, 'Calling Twilio sendVerification...');
      const result = await sendVerification(input.phone, 'sms');

      if (!result.success) {
        log.error({ userId: ctx.user.id, phone: input.phone, err: result.error }, 'Phone OTP send failed (Twilio)');
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error ?? 'Failed to send verification code. Please try again.',
        });
      }

      log.info({ userId: ctx.user.id, phone: input.phone }, 'Phone OTP sent successfully');

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
    .input(z.object({}).optional())
    .mutation(async ({ ctx }) => {
      log.info({
        userId: ctx.user.id,
        email: ctx.user.email,
        firebaseUid: ctx.user.firebase_uid ?? 'MISSING',
        hasSendgridKey: !!config.identity.sendgrid.apiKey,
        fromEmail: config.identity.sendgrid.fromEmail,
      }, '>>> sendEmailVerification called');

      if (!ctx.user.firebase_uid) {
        log.error({ userId: ctx.user.id }, 'No firebase_uid on user');
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'No Firebase account linked.',
        });
      }

      // Step 1: Generate Firebase email verification link
      let link: string;
      try {
        link = await fbGenerateEmailVerificationLink(ctx.user.email);
        log.info({ userId: ctx.user.id, email: ctx.user.email }, 'Firebase verification link generated');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ userId: ctx.user.id, email: ctx.user.email, err: msg }, 'STEP 1 FAILED: Firebase generateEmailVerificationLink');
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Firebase link generation failed: ${msg}`,
        });
      }

      // Step 2: Send the link via SendGrid
      if (!config.identity.sendgrid.apiKey) {
        log.error('STEP 2 FAILED: SENDGRID_API_KEY not configured');
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Email service not configured (SENDGRID_API_KEY missing)',
        });
      }

      try {
        sgMail.setApiKey(config.identity.sendgrid.apiKey);

        await sgMail.send({
          to: ctx.user.email,
          from: config.identity.sendgrid.fromEmail,
          subject: 'Verify your email — HustleXP',
          html: `<div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;padding:24px;background:#0D0D0D;color:#F5F5F5;">
            <div style="text-align:center;margin-bottom:24px;">
              <span style="font-size:24px;font-weight:700;color:#A855F7;">⚡ HustleXP</span>
            </div>
            <h2 style="color:#F5F5F5;">Verify Your Email</h2>
            <p>Click the button below to verify your email address.</p>
            <div style="text-align:center;margin:24px 0;">
              <a href="${link}" style="display:inline-block;padding:14px 32px;background:#A855F7;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;font-size:16px;">Verify Email</a>
            </div>
            <p style="color:#888;font-size:13px;">If the button doesn't work, copy and paste this link:<br/><a href="${link}" style="color:#A855F7;word-break:break-all;">${link}</a></p>
            <hr style="border:none;border-top:1px solid #2A2A2A;margin:24px 0;"/>
            <p style="font-size:12px;color:#888;">If you didn't request this, you can safely ignore this email.</p>
          </div>`,
          text: `Verify your email for HustleXP. Click this link: ${link}`,
        });

        log.info({ userId: ctx.user.id, email: ctx.user.email }, 'Email verification sent via SendGrid');
        return { success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // SendGrid errors often have a response body with details
        const sgBody = (err as any)?.response?.body;
        log.error({ userId: ctx.user.id, email: ctx.user.email, err: msg, sendgridResponse: sgBody, fromEmail: config.identity.sendgrid.fromEmail }, 'STEP 2 FAILED: SendGrid send');
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Email send failed: ${msg}`,
        });
      }
    }),

  /**
   * Check if the user's email has been verified in Firebase and sync to DB.
   * Call this after the user clicks the verification link.
   */
  checkEmailVerification: protectedProcedure
    .input(z.object({}).optional())
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

      // Sync to DB (upsert in case row doesn't exist yet)
      await db.query(
        `INSERT INTO users_identity (user_id, email, email_verified, email_verified_at)
         VALUES ($1, $2, TRUE, NOW())
         ON CONFLICT (user_id) DO UPDATE
         SET email_verified = TRUE, email_verified_at = NOW(), updated_at = NOW()`,
        [ctx.user.id, ctx.user.email]
      );

      await invalidateUser(ctx.user.id);
      invalidateAuthCacheForUser(ctx.user.id);

      log.info({ userId: ctx.user.id }, 'Email verified successfully');

      return { emailVerified: true };
    }),

  // --------------------------------------------------------------------------
  // ID VERIFICATION & BACKGROUND CHECK (Checkr)
  // --------------------------------------------------------------------------

  /**
   * Start identity verification + background check via Checkr.
   * Creates a Checkr candidate and invitation, returns the hosted URL
   * where the user completes verification.
   */
  startIdentityVerification: protectedProcedure
    .input(z.object({
      firstName: z.string().min(1).max(100),
      lastName: z.string().min(1).max(100),
      dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
      ssnLast4: z.string().length(4).regex(/^\d{4}$/, 'Must be 4 digits').optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      log.info({ userId: ctx.user.id }, '>>> startIdentityVerification called');

      const { initiateBackgroundCheck } = await import('../services/BackgroundCheckService.js');

      try {
        const check = await initiateBackgroundCheck({
          userId: ctx.user.id,
          provider: 'checkr',
          fullName: `${input.firstName} ${input.lastName}`,
          dateOfBirth: input.dateOfBirth,
          ssnLast4: input.ssnLast4,
        });

        // Extract invitationUrl from details
        const invitationUrl = (check.details as any)?.invitationUrl ?? null;

        log.info({
          userId: ctx.user.id,
          checkId: check.id,
          hasInvitationUrl: !!invitationUrl,
        }, 'Identity verification initiated');

        return {
          checkId: check.id,
          status: check.status,
          invitationUrl,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ userId: ctx.user.id, err: msg }, 'startIdentityVerification failed');

        // Re-throw TRPCErrors (like CONFLICT for existing check)
        if (err instanceof TRPCError) throw err;

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Identity verification failed: ${msg}`,
        });
      }
    }),

  /**
   * Get the current ID verification / background check status.
   */
  getIdentityVerificationStatus: protectedProcedure
    .input(z.object({}).optional())
    .query(async ({ ctx }) => {
      const { getUserBackgroundCheck } = await import('../services/BackgroundCheckService.js');

      const check = await getUserBackgroundCheck(ctx.user.id);

      if (!check) {
        return {
          status: 'NOT_STARTED' as const,
          checkId: null,
          invitationUrl: null,
          completedAt: null,
        };
      }

      return {
        status: check.status,
        checkId: check.id,
        invitationUrl: (check.details as any)?.invitationUrl ?? null,
        completedAt: check.completedAt,
      };
    }),
});

export type VerificationRouter = typeof verificationRouter;
