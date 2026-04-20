/**
 * Stripe Connect Router v1.0.0
 * 
 * CONSTITUTIONAL: Worker Stripe Connect onboarding and management
 * 
 * Handles:
 * - Stripe Connect onboarding status and links
 * - Express dashboard access
 * - Payout settings (instant vs standard)
 * - Tax information (W-9/W-8BEN)
 * - Earnings summary for 1099 tracking
 * 
 * @see PRODUCT_SPEC.md §4 (Payments)
 * @see ARCHITECTURE.md §1.1
 */

import { TRPCError } from '@trpc/server';
import { router, hustlerProcedure } from '../trpc.js';
import { StripeConnectService } from '../services/StripeConnectService.js';
import { TaxReportingService } from '../services/TaxReportingService.js';
import { z } from 'zod';

// ============================================================================
// INPUT SCHEMAS
// ============================================================================

const PayoutScheduleSchema = z.enum(['instant', 'standard']);

const TaxFormTypeSchema = z.enum(['W9', 'W8BEN', 'W8BENE']);

const TaxInfoInputSchema = z.object({
  formType: TaxFormTypeSchema,
  // W-9 Fields
  name: z.string().min(1).max(255).optional(),
  businessName: z.string().max(255).optional(),
  taxClassification: z.enum(['INDIVIDUAL', 'SOLE_PROPRIETOR', 'C_CORP', 'S_CORP', 'PARTNERSHIP', 'TRUST', 'LLC_C', 'LLC_S', 'LLC_P', 'OTHER']).optional(),
  llcClassification: z.enum(['C', 'S', 'P']).optional(),
  otherClassification: z.string().max(100).optional(),
  exemptions: z.string().max(100).optional(),
  // Address
  addressLine1: z.string().min(1).max(255).optional(),
  addressLine2: z.string().max(255).optional(),
  city: z.string().min(1).max(100).optional(),
  state: z.string().min(1).max(100).optional(),
  zipCode: z.string().min(1).max(20).optional(),
  country: z.string().length(2).default('US'), // ISO country code
  // Tax ID (SSN removed — Stripe handles SSN collection during Connect onboarding)
  ein: z.string().regex(/^\d{9}$/).optional(),
  // W-8BEN Fields (for non-US persons)
  foreignTaxId: z.string().max(50).optional(),
  treatyCountry: z.string().length(2).optional(),
  treatyArticle: z.string().max(50).optional(),
  // Certification
  signature: z.string().min(1).max(255).optional(),
  signatureDate: z.string().datetime().optional(),
});

// ============================================================================
// ROUTER
// ============================================================================

export const stripeConnectRouter = router({
  // --------------------------------------------------------------------------
  // ONBOARDING STATUS & LINKS
  // --------------------------------------------------------------------------

  /**
   * Get onboarding status for current worker
   * Returns whether worker has completed Stripe Connect onboarding
   */
  getOnboardingStatus: hustlerProcedure
    .input(z.object({}).optional())
    .query(async ({ ctx }) => {
      const result = await StripeConnectService.getOnboardingStatus(ctx.user.id);

      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      return result.data;
    }),

  /**
   * Create onboarding link for worker to complete KYC
   * Generates a Stripe Connect onboarding URL
   */
  createOnboardingLink: hustlerProcedure
    .input(z.object({
      refreshUrl: z.string().url().max(2048),
      returnUrl: z.string().url().max(2048),
      collectTaxInfo: z.boolean().default(true),
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await StripeConnectService.createOnboardingLink({
        userId: ctx.user.id,
        email: ctx.user.email,
        fullName: ctx.user.full_name,
        refreshUrl: input.refreshUrl,
        returnUrl: input.returnUrl,
        collectTaxInfo: input.collectTaxInfo,
      });

      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      return result.data;
    }),

  /**
   * Get dashboard link to worker's Stripe Express dashboard
   * Generates a one-time login link to Stripe Express
   */
  getDashboardLink: hustlerProcedure
    .input(z.object({}).optional())
    .query(async ({ ctx }) => {
      const result = await StripeConnectService.getDashboardLink(ctx.user.id);

      if (!result.success) {
        // Handle specific error cases
        if (result.error.code === 'STRIPE_CONNECT_NOT_SETUP') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Stripe Connect account not set up. Complete onboarding first.',
          });
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      return result.data;
    }),

  // --------------------------------------------------------------------------
  // PAYOUT SETTINGS
  // --------------------------------------------------------------------------

  /**
   * Get current payout settings
   * Returns instant vs standard payout preference and eligibility
   */
  getPayoutSettings: hustlerProcedure
    .input(z.object({}).optional())
    .query(async ({ ctx }) => {
      const result = await StripeConnectService.getPayoutSettings(ctx.user.id);

      if (!result.success) {
        if (result.error.code === 'STRIPE_CONNECT_NOT_SETUP') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Stripe Connect account not set up. Complete onboarding first.',
          });
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      return result.data;
    }),

  /**
   * Update payout preferences
   * Switch between instant and standard payout schedules
   */
  updatePayoutSettings: hustlerProcedure
    .input(z.object({
      schedule: PayoutScheduleSchema,
      // Instant payout settings
      debitCardId: z.string().max(255).optional(),
      // Standard payout settings
      bankAccountId: z.string().max(255).optional(),
      // Schedule interval (for standard)
      interval: z.enum(['daily', 'weekly', 'monthly', 'manual']).optional(),
      weeklyAnchor: z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']).optional(),
      monthlyAnchor: z.number().int().min(1).max(31).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await StripeConnectService.updatePayoutSettings({
        userId: ctx.user.id,
        schedule: input.schedule,
        debitCardId: input.debitCardId,
        bankAccountId: input.bankAccountId,
        interval: input.interval,
        weeklyAnchor: input.weeklyAnchor,
        monthlyAnchor: input.monthlyAnchor,
      });

      if (!result.success) {
        if (result.error.code === 'STRIPE_CONNECT_NOT_SETUP') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Stripe Connect account not set up. Complete onboarding first.',
          });
        }

        if (result.error.code === 'INSTANT_PAYOUT_NOT_ELIGIBLE') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Instant payout is not available for your account',
          });
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      return result.data;
    }),

  // --------------------------------------------------------------------------
  // TAX INFORMATION
  // --------------------------------------------------------------------------

  /**
   * Get tax information status
   * Returns W-9/W-8BEN submission status and any requirements
   */
  getTaxInfo: hustlerProcedure
    .input(z.object({}).optional())
    .query(async ({ ctx }) => {
      const result = await StripeConnectService.getTaxInfo(ctx.user.id);

      if (!result.success) {
        if (result.error.code === 'STRIPE_CONNECT_NOT_SETUP') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Stripe Connect account not set up. Complete onboarding first.',
          });
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      return result.data;
    }),

  /**
   * Submit tax information (W-9 or W-8BEN)
   * Required for 1099 reporting threshold tracking
   */
  submitTaxInfo: hustlerProcedure
    .input(TaxInfoInputSchema)
    .mutation(async ({ ctx, input }) => {
      const result = await StripeConnectService.submitTaxInfo({
        userId: ctx.user.id,
        ...input,
      });

      if (!result.success) {
        if (result.error.code === 'STRIPE_CONNECT_NOT_SETUP') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Stripe Connect account not set up. Complete onboarding first.',
          });
        }

        if (result.error.code === 'TAX_INFO_INVALID') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: result.error.message,
          });
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      return result.data;
    }),

  // --------------------------------------------------------------------------
  // EARNINGS & 1099 TRACKING
  // --------------------------------------------------------------------------

  /**
   * Get earnings summary for 1099 threshold tracking
   * Returns current year earnings and 1099-K threshold status
   */
  getEarningsSummary: hustlerProcedure
    .input(z.object({
      year: z.number().int().min(2020).max(2100).optional(),
    }).optional())
    .query(async ({ ctx, input }) => {
      const result = await StripeConnectService.getEarningsSummary({
        userId: ctx.user.id,
        year: input?.year ?? new Date().getFullYear(),
      });

      if (!result.success) {
        if (result.error.code === 'STRIPE_CONNECT_NOT_SETUP') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Stripe Connect account not set up. Complete onboarding first.',
          });
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      return result.data;
    }),

  // --------------------------------------------------------------------------
  // 1099-NEC TAX FILING STATUS
  // --------------------------------------------------------------------------

  /**
   * Get 1099-NEC filing status for current user
   * Returns tax filing records for the given year (defaults to current year)
   */
  get1099Status: hustlerProcedure
    .input(z.object({
      taxYear: z.number().int().min(2020).max(2100).optional(),
    }).optional())
    .query(async ({ ctx, input }) => {
      const result = await TaxReportingService.get1099Status(
        ctx.user.id,
        input?.taxYear
      );

      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      return result.data;
    }),

  // --------------------------------------------------------------------------
  // ADDITIONAL UTILITIES
  // --------------------------------------------------------------------------

  /**
   * Get Stripe Connect account details
   * Returns account status, capabilities, and requirements
   */
  getAccountDetails: hustlerProcedure
    .input(z.object({}).optional())
    .query(async ({ ctx }) => {
      const result = await StripeConnectService.getAccountDetails(ctx.user.id);

      if (!result.success) {
        if (result.error.code === 'STRIPE_CONNECT_NOT_SETUP') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Stripe Connect account not set up. Complete onboarding first.',
          });
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      return result.data;
    }),

  /**
   * Refresh onboarding link if expired
   * Generates a new onboarding link for users who need to complete requirements
   */
  refreshOnboarding: hustlerProcedure
    .input(z.object({
      refreshUrl: z.string().url().max(2048),
      returnUrl: z.string().url().max(2048),
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await StripeConnectService.refreshOnboarding({
        userId: ctx.user.id,
        refreshUrl: input.refreshUrl,
        returnUrl: input.returnUrl,
      });

      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      return result.data;
    }),

  // --------------------------------------------------------------------------
  // BALANCE & CASH OUT
  // --------------------------------------------------------------------------

  /**
   * Get the worker's available and pending Stripe balance
   */
  getBalance: hustlerProcedure
    .input(z.object({}).optional())
    .query(async ({ ctx }) => {
      const result = await StripeConnectService.getBalance(ctx.user.id);

      if (!result.success) {
        if (result.error.code === 'STRIPE_CONNECT_NOT_SETUP') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Stripe Connect account not set up. Complete onboarding first.',
          });
        }
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: result.error.message });
      }

      return result.data;
    }),

  /**
   * Request a payout (cash out) of available balance
   */
  requestPayout: hustlerProcedure
    .input(z.object({
      amountCents: z.number().int().positive().min(100, 'Minimum payout is $1.00'),
      method: z.enum(['instant', 'standard']).default('standard'),
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await StripeConnectService.requestPayout({
        userId: ctx.user.id,
        amountCents: input.amountCents,
        method: input.method,
      });

      if (!result.success) {
        if (result.error.code === 'STRIPE_CONNECT_NOT_SETUP') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Stripe Connect account not set up. Complete onboarding first.',
          });
        }
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: result.error.message });
      }

      return result.data;
    }),
});

export type StripeConnectRouter = typeof stripeConnectRouter;
