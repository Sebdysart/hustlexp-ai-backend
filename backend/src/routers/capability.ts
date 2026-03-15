/**
 * Capability Router
 * 
 * tRPC router for capability and eligibility management.
 * 
 * @see ARCHITECTURE.md §11
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, hustlerProcedure } from '../trpc.js';
import { db } from '../db.js';
import * as CapabilityProfileService from '../services/CapabilityProfileService.js';
import * as EligibilityResolverService from '../services/EligibilityResolverService.js';
import * as FeedQueryService from '../services/FeedQueryService.js';
import * as LicenseVerificationService from '../services/LicenseVerificationService.js';
import * as InsuranceVerificationService from '../services/InsuranceVerificationService.js';
import * as BackgroundCheckService from '../services/BackgroundCheckService.js';

export const capabilityRouter = router({
  // ==========================================================================
  // Capability Profile
  // ==========================================================================
  
  /**
   * Get current user's capability profile
   */
  getProfile: hustlerProcedure
    .input(z.void())
    .query(async ({ ctx }) => {
      return await CapabilityProfileService.getCapabilityProfile(ctx.user.id);
    }),

  /**
   * Get capability summary (lightweight)
   */
  getSummary: hustlerProcedure
    .input(z.void())
    .query(async ({ ctx }) => {
      return await CapabilityProfileService.getCapabilitySummary(ctx.user.id);
    }),

  /**
   * Check if user has specific capability
   */
  hasCapability: hustlerProcedure
    .input(z.object({
      trade: z.string(),
      state: z.string(),
      riskLevel: z.string().optional(),
    }))
    .query(async ({ ctx, input }) => {
      return await CapabilityProfileService.hasCapability(
        ctx.user.id,
        input.trade,
        input.state,
        input.riskLevel
      );
    }),

  /**
   * Trigger profile recompute
   */
  recomputeProfile: hustlerProcedure
    .input(z.void())
    .mutation(async ({ ctx }) => {
      await CapabilityProfileService.recompute(ctx.user.id, 'user_requested');
      return { success: true };
    }),

  // ==========================================================================
  // Eligibility
  // ==========================================================================

  /**
   * Check eligibility for a task
   */
  checkEligibility: hustlerProcedure
    .input(z.object({
      taskId: z.string(),
    }))
    .query(async ({ ctx, input }) => {
      // Fetch task requirements
      const taskResult = await db.query<{
        trade_type: string;
        location_state: string;
        location_city: string | undefined;
        risk_level: 'low' | 'medium' | 'high' | 'critical';
        insurance_required: boolean;
        background_check_required: boolean;
      }>(
        `SELECT trade_type, location_state, location_city, risk_level,
                insurance_required, background_check_required
         FROM tasks WHERE id = $1`,
        [input.taskId]
      );

      if (taskResult.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
      }

      // Single roundtrip: account age, trust tier, active task count, active dispute
      const ctxResult = await db.query<{
        account_age_days: number;
        trust_tier: number;
        active_task_count: number;
        has_active_dispute: boolean;
      }>(
        `SELECT
           EXTRACT(DAY FROM NOW() - u.created_at)::int AS account_age_days,
           u.trust_tier,
           (
             SELECT COUNT(*)::int FROM tasks
             WHERE worker_id = u.id
               AND state IN ('ACCEPTED', 'PROOF_SUBMITTED')
           ) AS active_task_count,
           EXISTS (
             SELECT 1 FROM disputes
             WHERE (worker_id = u.id OR initiated_by = u.id)
               AND state != 'RESOLVED'
           ) AS has_active_dispute
         FROM users u
         WHERE u.id = $1`,
        [ctx.user.id]
      );

      if (ctxResult.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }

      const userCtx = ctxResult.rows[0];
      const task = taskResult.rows[0];
      const profile = await CapabilityProfileService.getCapabilityProfile(ctx.user.id);

      return EligibilityResolverService.isEligible(
        {
          trade: task.trade_type,
          state: task.location_state,
          city: task.location_city,
          riskLevel: task.risk_level,
          insuranceRequired: task.insurance_required,
          backgroundCheckRequired: task.background_check_required,
        },
        {
          userId: ctx.user.id,
          capabilityProfile: profile,
          activeTaskCount: userCtx.active_task_count,
          hasActiveDispute: userCtx.has_active_dispute,
          accountAgeDays: userCtx.account_age_days,
          trustScore: userCtx.trust_tier,
        }
      );
    }),

  // ==========================================================================
  // Feed
  // ==========================================================================

  /**
   * Query task feed
   */
  queryFeed: hustlerProcedure
    .input(z.object({
      location: z.object({
        lat: z.number(),
        lng: z.number(),
      }).optional(),
      radiusMiles: z.number().optional(),
      filters: z.object({
        trades: z.array(z.string()).optional(),
        minPayout: z.number().optional(),
        maxPayout: z.number().optional(),
        riskLevels: z.array(z.string()).optional(),
      }).optional(),
      cursor: z.string().optional(),
      limit: z.number().min(1).max(50).default(20),
    }))
    .query(async ({ ctx, input }) => {
      const profile = await CapabilityProfileService.getCapabilityProfile(ctx.user.id);

      return await FeedQueryService.queryFeed({
        userId: ctx.user.id,
        capabilityProfile: profile,
        location: input.location,
        radiusMiles: input.radiusMiles,
        filters: input.filters,
        pagination: {
          cursor: input.cursor,
          limit: input.limit,
        },
      });
    }),

  /**
   * Get nearby tasks (simple, no eligibility filter)
   */
  getNearbyTasks: hustlerProcedure
    .input(z.object({
      lat: z.number(),
      lng: z.number(),
      radiusMiles: z.number().default(25),
      limit: z.number().min(1).max(50).default(20),
    }))
    .query(async ({ input }) => {
      return await FeedQueryService.getNearbyTasks(
        input.lat,
        input.lng,
        input.radiusMiles,
        input.limit
      );
    }),

  // ==========================================================================
  // License Verification
  // ==========================================================================

  /**
   * Submit license for verification
   */
  submitLicense: hustlerProcedure
    .input(z.object({
      tradeType: z.string(),
      issuingState: z.string(),
      licenseNumber: z.string(),
      expirationDate: z.string().optional(),
      documentUrl: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      return await LicenseVerificationService.submitLicense({
        userId: ctx.user.id,
        tradeType: input.tradeType,
        issuingState: input.issuingState,
        licenseNumber: input.licenseNumber,
        expirationDate: input.expirationDate,
        documentUrl: input.documentUrl,
      });
    }),

  /**
   * Get user's license verifications
   */
  getLicenses: hustlerProcedure
    .input(z.void())
    .query(async ({ ctx }) => {
      return await LicenseVerificationService.getUserLicenses(ctx.user.id);
    }),

  // ==========================================================================
  // Insurance Verification
  // ==========================================================================

  /**
   * Submit insurance for verification
   */
  submitInsurance: hustlerProcedure
    .input(z.object({
      provider: z.string(),
      policyNumber: z.string(),
      coverageAmount: z.number(), // in dollars
      expirationDate: z.string(),
      documentUrl: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      return await InsuranceVerificationService.submitInsurance({
        userId: ctx.user.id,
        provider: input.provider,
        policyNumber: input.policyNumber,
        coverageAmount: input.coverageAmount,
        expirationDate: input.expirationDate,
        documentUrl: input.documentUrl,
      });
    }),

  /**
   * Get user's insurance verification
   */
  getInsurance: hustlerProcedure
    .input(z.void())
    .query(async ({ ctx }) => {
      return await InsuranceVerificationService.getUserInsurance(ctx.user.id);
    }),

  // ==========================================================================
  // Background Check
  // ==========================================================================

  /**
   * Initiate background check
   */
  initiateBackgroundCheck: hustlerProcedure
    .input(z.object({
      provider: z.enum(['checkr', 'sterling', 'goodhire', 'manual']),
    }))
    .mutation(async ({ ctx, input }) => {
      return await BackgroundCheckService.initiateBackgroundCheck({
        userId: ctx.user.id,
        provider: input.provider,
      });
    }),

  /**
   * Get user's background check status
   */
  getBackgroundCheck: hustlerProcedure
    .input(z.void())
    .query(async ({ ctx }) => {
      return await BackgroundCheckService.getUserBackgroundCheck(ctx.user.id);
    }),

  // ==========================================================================
  // Admin/Ops (should be restricted to admins)
  // ==========================================================================

  /**
   * Approve license verification (admin only)
   */
  approveLicense: hustlerProcedure
    .input(z.object({
      verificationId: z.string(),
      notes: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // PLANNED: Enforce role-based access control (RBAC) for admin operations
      return await LicenseVerificationService.approveLicense(
        input.verificationId,
        ctx.user.id,
        input.notes
      );
    }),

  /**
   * Reject license verification (admin only)
   */
  rejectLicense: hustlerProcedure
    .input(z.object({
      verificationId: z.string(),
      reason: z.string(),
      notes: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // PLANNED: Enforce role-based access control (RBAC) for admin operations
      return await LicenseVerificationService.rejectLicense(
        input.verificationId,
        ctx.user.id,
        input.reason,
        input.notes
      );
    }),

  /**
   * Get pending license verifications (admin only)
   */
  getPendingLicenses: hustlerProcedure
    .input(z.object({
      limit: z.number().default(50),
      offset: z.number().default(0),
    }))
    .query(async ({ input }) => {
      // PLANNED: Enforce role-based access control (RBAC) for admin operations
      return await LicenseVerificationService.getPendingVerifications(
        input.limit,
        input.offset
      );
    }),
});

export default capabilityRouter;
