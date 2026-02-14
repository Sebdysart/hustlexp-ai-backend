/**
 * Expertise Supply Control Router v1.0.0
 *
 * Endpoints for managing expertise-based supply/demand balance.
 *
 * User endpoints (protectedProcedure):
 *   - listExpertise: Browse available expertise categories
 *   - getMyExpertise: View current selections
 *   - addExpertise: Select an expertise (auto-waitlists if capped)
 *   - removeExpertise: Remove an expertise (respects 30-day lock)
 *   - promoteExpertise: Swap primary/secondary
 *   - getMyWaitlist: View waitlist status
 *   - acceptInvite: Accept a waitlist invitation
 *   - checkCapacity: Preview capacity for an expertise
 *
 * Admin endpoints (adminProcedure):
 *   - getSupplyDashboard: Full supply/demand dashboard
 *   - updateCapacity: Override capacity settings
 *   - triggerRecalc: Force ratio recalculation
 *
 * @see ExpertiseSupplyService.ts
 * @see expertise_supply_control.sql
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure, adminProcedure } from '../trpc';
import { ExpertiseSupplyService } from '../services/ExpertiseSupplyService';

export const expertiseSupplyRouter = router({
  // ==========================================================================
  // USER: Browse & Select Expertise
  // ==========================================================================

  /**
   * List all active expertise categories.
   * Public to authenticated users — shown during onboarding and profile edit.
   */
  listExpertise: protectedProcedure
    .query(async () => {
      const result = await ExpertiseSupplyService.listExpertise();
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      return result.data;
    }),

  /**
   * Get the current user's expertise selections.
   */
  getMyExpertise: protectedProcedure
    .query(async ({ ctx }) => {
      const result = await ExpertiseSupplyService.getUserExpertise(ctx.user.id);
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      return result.data;
    }),

  /**
   * Add an expertise to the user's profile.
   * If capacity is full → auto-waitlisted with FIFO position.
   */
  addExpertise: protectedProcedure
    .input(z.object({
      expertiseId: z.string().uuid(),
      isPrimary: z.boolean().default(true),
      geoZone: z.string().default('seattle_metro'),
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await ExpertiseSupplyService.addUserExpertise(
        ctx.user.id,
        input.expertiseId,
        input.isPrimary,
        input.geoZone
      );
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      return result.data;
    }),

  /**
   * Remove an expertise from the user's profile.
   * Respects 30-day lock period.
   */
  removeExpertise: protectedProcedure
    .input(z.object({
      expertiseId: z.string().uuid(),
      geoZone: z.string().default('seattle_metro'),
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await ExpertiseSupplyService.removeUserExpertise(
        ctx.user.id,
        input.expertiseId,
        input.geoZone
      );
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      return result.data;
    }),

  /**
   * Swap primary/secondary expertise.
   */
  promoteExpertise: protectedProcedure
    .input(z.object({
      expertiseId: z.string().uuid(),
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await ExpertiseSupplyService.promoteExpertise(
        ctx.user.id,
        input.expertiseId
      );
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      return result.data;
    }),

  /**
   * Check capacity status for a specific expertise.
   * Shows whether it's accepting new hustlers or waitlisted.
   */
  checkCapacity: protectedProcedure
    .input(z.object({
      expertiseId: z.string().uuid(),
      geoZone: z.string().default('seattle_metro'),
    }))
    .query(async ({ input }) => {
      const result = await ExpertiseSupplyService.checkCapacity(
        input.expertiseId,
        input.geoZone
      );
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      return result.data;
    }),

  // ==========================================================================
  // USER: Waitlist
  // ==========================================================================

  /**
   * Get the current user's waitlist entries.
   */
  getMyWaitlist: protectedProcedure
    .query(async ({ ctx }) => {
      const result = await ExpertiseSupplyService.getUserWaitlist(ctx.user.id);
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      return result.data;
    }),

  /**
   * Accept a waitlist invitation.
   * Must be called within 48 hours of invitation.
   */
  acceptInvite: protectedProcedure
    .input(z.object({
      waitlistEntryId: z.string().uuid(),
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await ExpertiseSupplyService.acceptWaitlistInvite(
        ctx.user.id,
        input.waitlistEntryId
      );
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      return result.data;
    }),

  // ==========================================================================
  // ADMIN: Supply Dashboard & Controls
  // ==========================================================================

  /**
   * Get full supply/demand dashboard for all expertise categories.
   */
  getSupplyDashboard: adminProcedure
    .input(z.object({
      geoZone: z.string().default('seattle_metro'),
    }).optional())
    .query(async ({ input }) => {
      const result = await ExpertiseSupplyService.getSupplyDashboard(
        input?.geoZone || 'seattle_metro'
      );
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      return result.data;
    }),

  /**
   * Admin: Override capacity settings for an expertise.
   */
  updateCapacity: adminProcedure
    .input(z.object({
      expertiseId: z.string().uuid(),
      geoZone: z.string().default('seattle_metro'),
      maxWeightCapacity: z.number().positive().optional(),
      minTaskToSupplyRatio: z.number().positive().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await ExpertiseSupplyService.adminUpdateCapacity(
        input.expertiseId,
        input.geoZone,
        {
          maxWeightCapacity: input.maxWeightCapacity,
          minTaskToSupplyRatio: input.minTaskToSupplyRatio,
        },
        ctx.user.id
      );
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      return result.data;
    }),

  /**
   * Admin: Force recalculation of all capacity metrics.
   * Normally runs via daily cron — this is for manual trigger.
   */
  triggerRecalc: adminProcedure
    .mutation(async () => {
      const result = await ExpertiseSupplyService.recalculateAllCapacity();
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      return result.data;
    }),
});
