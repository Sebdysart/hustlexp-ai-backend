import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db } from '../db.js';
import { hustlerProcedure, trustAdminProcedure } from '../trpc.js';
import * as CapabilityProfileService from '../services/CapabilityProfileService.js';
import * as EligibilityResolverService from '../services/EligibilityResolverService.js';
import * as FeedQueryService from '../services/FeedQueryService.js';
import * as InsuranceVerificationService from '../services/InsuranceVerificationService.js';
import * as LicenseVerificationService from '../services/LicenseVerificationService.js';

async function checkTaskEligibility(userId: string, taskId: string) {
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
    [taskId],
  );
  if (taskResult.rows.length === 0) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
  }
  const contextResult = await db.query<{
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
    [userId],
  );
  if (contextResult.rows.length === 0) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
  }
  const task = taskResult.rows[0];
  const user = contextResult.rows[0];
  const profile = await CapabilityProfileService.getCapabilityProfile(userId);
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
      userId,
      capabilityProfile: profile,
      activeTaskCount: user.active_task_count,
      hasActiveDispute: user.has_active_dispute,
      accountAgeDays: user.account_age_days,
      trustScore: user.trust_tier,
    },
  );
}

export const capabilityCoreProcedures = {
  getProfile: hustlerProcedure
    .input(z.void())
    .query(({ ctx }) => CapabilityProfileService.getCapabilityProfile(ctx.user.id)),

  getSummary: hustlerProcedure
    .input(z.void())
    .query(({ ctx }) => CapabilityProfileService.getCapabilitySummary(ctx.user.id)),

  hasCapability: hustlerProcedure
    .input(z.object({
      trade: z.string(),
      state: z.string(),
      riskLevel: z.string().optional(),
    }))
    .query(({ ctx, input }) => CapabilityProfileService.hasCapability(
      ctx.user.id,
      input.trade,
      input.state,
      input.riskLevel,
    )),

  recomputeProfile: hustlerProcedure
    .input(z.void())
    .mutation(async ({ ctx }) => {
      await CapabilityProfileService.recompute(ctx.user.id, 'user_requested');
      return { success: true };
    }),

  checkEligibility: hustlerProcedure
    .input(z.object({ taskId: z.string() }))
    .query(({ ctx, input }) => checkTaskEligibility(ctx.user.id, input.taskId)),

  queryFeed: hustlerProcedure
    .input(z.object({
      location: z.object({ lat: z.number(), lng: z.number() }).optional(),
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
      return FeedQueryService.queryFeed({
        userId: ctx.user.id,
        capabilityProfile: profile,
        location: input.location,
        radiusMiles: input.radiusMiles,
        filters: input.filters,
        pagination: { cursor: input.cursor, limit: input.limit },
      });
    }),

  getNearbyTasks: hustlerProcedure
    .input(z.object({
      lat: z.number(),
      lng: z.number(),
      radiusMiles: z.number().default(25),
      limit: z.number().min(1).max(50).default(20),
    }))
    .query(async ({ ctx, input }) => {
      const profile = await CapabilityProfileService.getCapabilityProfile(ctx.user.id);
      return FeedQueryService.getNearbyTasks(
        ctx.user.id,
        profile,
        input.lat,
        input.lng,
        input.radiusMiles,
        input.limit,
      );
    }),

  submitLicense: hustlerProcedure
    .input(z.object({
      tradeType: z.string(),
      issuingState: z.string(),
      licenseNumber: z.string(),
      expirationDate: z.string().optional(),
      documentUrl: z.string().max(0, 'Direct credential media URLs are disabled; submit credential facts only.').optional(),
    }))
    .mutation(({ ctx, input }) => LicenseVerificationService.submitLicense({
      userId: ctx.user.id,
      ...input,
    })),

  getLicenses: hustlerProcedure
    .input(z.void())
    .query(({ ctx }) => LicenseVerificationService.getUserLicenses(ctx.user.id)),

  submitInsurance: hustlerProcedure
    .input(z.object({
      provider: z.string(),
      policyNumber: z.string(),
      coverageAmount: z.number(),
      expirationDate: z.string(),
      documentUrl: z.string().max(0, 'Direct credential media URLs are disabled; submit credential facts only.').optional(),
    }))
    .mutation(({ ctx, input }) => InsuranceVerificationService.submitInsurance({
      userId: ctx.user.id,
      ...input,
    })),

  getInsurance: hustlerProcedure
    .input(z.void())
    .query(({ ctx }) => InsuranceVerificationService.getUserInsurance(ctx.user.id)),

  approveLicense: trustAdminProcedure
    .input(z.object({ verificationId: z.string(), notes: z.string().optional() }))
    .mutation(({ ctx, input }) => LicenseVerificationService.approveLicense(
      input.verificationId,
      ctx.user.id,
      input.notes,
    )),

  rejectLicense: trustAdminProcedure
    .input(z.object({
      verificationId: z.string(),
      reason: z.string(),
      notes: z.string().optional(),
    }))
    .mutation(({ ctx, input }) => LicenseVerificationService.rejectLicense(
      input.verificationId,
      ctx.user.id,
      input.reason,
      input.notes,
    )),

  getPendingLicenses: trustAdminProcedure
    .input(z.object({ limit: z.number().default(50), offset: z.number().default(0) }))
    .query(({ input }) => LicenseVerificationService.getPendingVerifications(
      input.limit,
      input.offset,
    )),
};
