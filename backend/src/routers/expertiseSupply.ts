/**
 * Expertise Supply Control Router v1.0.0
 *
 * Endpoints for managing expertise-based supply/demand balance.
 *
 * User endpoints (hustlerProcedure):
 *   - listExpertise: Browse available expertise categories
 *   - getMyExpertise: View current selections
 *   - addExpertise: Select an expertise (auto-waitlists if capped)
 *   - removeExpertise: Remove an expertise (respects 30-day lock)
 *   - promoteExpertise: Swap primary/secondary
 *   - getMyWaitlist: View waitlist status
 *   - acceptInvite: Accept a waitlist invitation
 *   - checkCapacity: Preview capacity for an expertise
 *
 * Platform-administrator endpoints:
 *   - getSupplyDashboard: Full supply/demand dashboard
 *   - updateCapacity: Override capacity settings
 *   - triggerRecalc: Force ratio recalculation
 *
 * @see ExpertiseSupplyService.ts
 * @see expertise_supply_control.sql
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, hustlerProcedure, platformAdminProcedure, publicProcedure } from '../trpc.js';
import { ExpertiseSupplyService } from '../services/ExpertiseSupplyService.js';
import { LiquidityCellService } from '../services/LiquidityCellService.js';

export const expertiseSupplyRouter = router({
  getPublicCells: publicProcedure
    .input(z.object({ geoZone: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,79}$/).optional() }).optional())
    .query(async ({ input }) => {
      const result = await LiquidityCellService.getPublicSnapshot(input?.geoZone);
      if (!result.success) {
        throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: result.error.message });
      }
      return result.data;
    }),

  // ==========================================================================
  // USER: Browse & Select Expertise
  // ==========================================================================

  /**
   * List all active expertise categories.
   * Public to authenticated users — shown during onboarding and profile edit.
   */
  listExpertise: hustlerProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(50).optional(),
      offset: z.number().int().min(0).max(500).default(0).optional(),
    }).optional())
    .query(async ({ input }) => {
      const limit = Math.min(input?.limit ?? 50, 100);
      const offset = input?.offset ?? 0;
      const result = await ExpertiseSupplyService.listExpertise();
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      return result.data.slice(offset, offset + limit);
    }),

  /**
   * Get the current user's expertise selections.
   */
  getMyExpertise: hustlerProcedure
    .input(z.void())
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
  addExpertise: hustlerProcedure
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
  removeExpertise: hustlerProcedure
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
  promoteExpertise: hustlerProcedure
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
  checkCapacity: hustlerProcedure
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
  getMyWaitlist: hustlerProcedure
    .input(z.void())
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
  acceptInvite: hustlerProcedure
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
  getSupplyDashboard: platformAdminProcedure
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
  updateCapacity: platformAdminProcedure
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

  recalculateLiquidityCell: platformAdminProcedure
    .input(z.object({ cellId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const result = await LiquidityCellService.recalculateCell(input.cellId, ctx.user.id);
      if (!result.success) {
        throw new TRPCError({
          code: result.error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      return result.data;
    }),

  requestAdjacentExpansion: platformAdminProcedure
    .input(z.object({
      sourceCellId: z.string().uuid(),
      targetGeoZone: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,79}$/),
      targetGeographyLabel: z.string().trim().min(2).max(120),
      targetCategory: z.string().trim().min(1).max(100),
      targetOperatingWindow: z.string().trim().min(2).max(160),
      idempotencyKey: z.string().trim().min(8).max(128),
      override: z.object({
        owner: z.string().trim().min(3).max(120),
        reason: z.string().trim().min(20).max(500),
        expiresAt: z.string().datetime(),
      }).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await LiquidityCellService.requestAdjacentExpansion(input, ctx.user.id);
      if (!result.success) {
        throw new TRPCError({
          code: result.error.code === 'NOT_FOUND' ? 'NOT_FOUND'
            : result.error.code === 'CONFLICT' ? 'CONFLICT'
              : result.error.code === 'INVALID_INPUT' ? 'BAD_REQUEST' : 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      return result.data;
    }),

  bindTaskLiquidityCell: platformAdminProcedure
    .input(z.object({ taskId: z.string().uuid(), cellId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const result = await LiquidityCellService.bindTaskToCell(input.taskId, input.cellId);
      if (!result.success) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: result.error.message });
      }
      return result.data;
    }),

  /**
   * Admin: Force recalculation of all capacity metrics.
   * Normally runs via daily cron — this is for manual trigger.
   */
  triggerRecalc: platformAdminProcedure
    .input(z.void())
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
