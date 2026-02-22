/**
 * Capability Router
 * 
 * tRPC router for capability and eligibility management.
 * 
 * @see ARCHITECTURE.md §11
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import { CapabilityProfileService } from '../services/CapabilityProfileService';
import { EligibilityResolverService } from '../services/EligibilityResolverService';
import { FeedQueryService } from '../services/FeedQueryService';
import { LicenseVerificationService } from '../services/LicenseVerificationService';
import { InsuranceVerificationService } from '../services/InsuranceVerificationService';
import { BackgroundCheckService } from '../services/BackgroundCheckService';

export const capabilityRouter = router({
  // ==========================================================================
  // Capability Profile
  // ==========================================================================
  
  /**
   * Get current user's capability profile
   */
  getProfile: protectedProcedure
    .query(async ({ ctx }) => {
      return await CapabilityProfileService.getCapabilityProfile(ctx.user.id);
    }),

  /**
   * Get capability summary (lightweight)
   */
  getSummary: protectedProcedure
    .query(async ({ ctx }) => {
      return await CapabilityProfileService.getCapabilitySummary(ctx.user.id);
    }),

  /**
   * Check if user has specific capability
   */
  hasCapability: protectedProcedure
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
  recomputeProfile: protectedProcedure
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
  checkEligibility: protectedProcedure
    .input(z.object({
      taskId: z.string(),
    }))
    .query(async ({ ctx, input }) => {
      // Get task requirements
      const { db } = await import('../db');
      const taskResult = await db.query(
        `SELECT trade_type, location_state, location_city, risk_level, 
                insurance_required, background_check_required
         FROM tasks WHERE id = $1`,
        [input.taskId]
      );

      if (taskResult.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
      }

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
          activeTaskCount: 0, // TODO: query actual count
          hasActiveDispute: false, // TODO: query actual status
          accountAgeDays: 30, // TODO: calculate from user.created_at
          trustScore: 4.5, // TODO: query actual score
        }
      );
    }),

  // ==========================================================================
  // Feed
  // ==========================================================================

  /**
   * Query task feed
   */
  queryFeed: protectedProcedure
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
  getNearbyTasks: protectedProcedure
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
  submitLicense: protectedProcedure
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
  getLicenses: protectedProcedure
    .query(async ({ ctx }) => {
      return await LicenseVerificationService.getUserLicenses(ctx.user.id);
    }),

  // ==========================================================================
  // Insurance Verification
  // ==========================================================================

  /**
   * Submit insurance for verification
   */
  submitInsurance: protectedProcedure
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
  getInsurance: protectedProcedure
    .query(async ({ ctx }) => {
      return await InsuranceVerificationService.getUserInsurance(ctx.user.id);
    }),

  // ==========================================================================
  // Background Check
  // ==========================================================================

  /**
   * Initiate background check
   */
  initiateBackgroundCheck: protectedProcedure
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
  getBackgroundCheck: protectedProcedure
    .query(async ({ ctx }) => {
      return await BackgroundCheckService.getUserBackgroundCheck(ctx.user.id);
    }),

  // ==========================================================================
  // Admin/Ops (should be restricted to admins)
  // ==========================================================================

  /**
   * Approve license verification (admin only)
   */
  approveLicense: protectedProcedure
    .input(z.object({
      verificationId: z.string(),
      notes: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // TODO: Check admin role
      return await LicenseVerificationService.approveLicense(
        input.verificationId,
        ctx.user.id,
        input.notes
      );
    }),

  /**
   * Reject license verification (admin only)
   */
  rejectLicense: protectedProcedure
    .input(z.object({
      verificationId: z.string(),
      reason: z.string(),
      notes: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // TODO: Check admin role
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
  getPendingLicenses: protectedProcedure
    .input(z.object({
      limit: z.number().default(50),
      offset: z.number().default(0),
    }))
    .query(async ({ input }) => {
      // TODO: Check admin role
      return await LicenseVerificationService.getPendingVerifications(
        input.limit,
        input.offset
      );
    }),
});

export default capabilityRouter;
