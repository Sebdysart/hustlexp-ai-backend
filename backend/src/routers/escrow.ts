/**
 * Escrow Router v1.0.0
 * 
 * CONSTITUTIONAL: Escrow lifecycle endpoints
 * 
 * INV-2: Escrow can only be RELEASED if task is COMPLETED
 * INV-4: Escrow amount is immutable after creation
 * 
 * @see PRODUCT_SPEC.md §4
 */

import { TRPCError } from '@trpc/server';
import { router, protectedProcedure, hustlerProcedure, posterProcedure, Schemas } from '../trpc.js';
import { EscrowService } from '../services/EscrowService.js';
import { StripeService } from '../services/StripeService.js';
import { XPService } from '../services/XPService.js';
import { db } from '../db.js';
import { z } from 'zod';

export const escrowRouter = router({
  // --------------------------------------------------------------------------
  // READ OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Get escrow by ID
   * SECURITY: Only poster or worker of the associated task can view
   */
  getById: protectedProcedure
    .input(z.object({ escrowId: Schemas.uuid }))
    .query(async ({ ctx, input }) => {
      const result = await EscrowService.getById(input.escrowId);

      if (!result.success) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: result.error.message,
        });
      }

      // Authorization: only poster or worker can view escrow details
      if (result.data.poster_id !== ctx.user.id && result.data.worker_id !== ctx.user.id && !ctx.user.is_admin) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You do not have access to this escrow',
        });
      }

      // Strip Stripe-internal identifiers for non-admin callers
      if (!ctx.user.is_admin) {
        const { stripe_payment_intent_id: _spi, stripe_transfer_id: _sti, ...safeEscrow } = result.data as typeof result.data & { stripe_payment_intent_id?: string; stripe_transfer_id?: string };
        return safeEscrow;
      }
      return result.data;
    }),
  
  /**
   * Get server-authoritative escrow state
   * Used for state confirmation (UI_SPEC §9.1)
   * SECURITY FIX (v2.9.3): Added participant authorization check.
   */
  getState: protectedProcedure
    .input(z.object({ escrowId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const escrow = await EscrowService.getById(input.escrowId);
      if (!escrow.success) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Escrow not found' });
      }
      if (escrow.data.poster_id !== ctx.user.id && escrow.data.worker_id !== ctx.user.id && !ctx.user.is_admin) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this escrow' });
      }
      return {
        state: escrow.data.state,
      };
    }),

  /**
   * Get escrow by task ID
   * SECURITY FIX (v2.9.3): Added participant authorization check.
   */
  getByTaskId: protectedProcedure
    .input(z.object({ taskId: Schemas.uuid }))
    .query(async ({ ctx, input }) => {
      const result = await EscrowService.getByTaskId(input.taskId);

      if (!result.success) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: result.error.message,
        });
      }

      // Fetch poster_id/worker_id (getByTaskId only selects from escrows, not the join)
      const escrow = await EscrowService.getById(result.data.id);
      if (!escrow.success) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Escrow not found' });
      }
      if (escrow.data.poster_id !== ctx.user.id && escrow.data.worker_id !== ctx.user.id && !ctx.user.is_admin) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this escrow' });
      }

      // Strip Stripe-internal identifiers for non-admin callers
      if (!ctx.user.is_admin) {
        const { stripe_payment_intent_id: _spi, stripe_transfer_id: _sti, ...safeEscrow } = result.data as typeof result.data & { stripe_payment_intent_id?: string; stripe_transfer_id?: string };
        return safeEscrow;
      }
      return result.data;
    }),
  
  // --------------------------------------------------------------------------
  // PAYMENT OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Create payment intent for escrow funding
   * Amount is optional — if omitted, derived from task price
   */
  createPaymentIntent: posterProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      amount: z.number().int().positive().max(99999900).optional(), // max $999,999
    }))
    .mutation(async ({ ctx, input }) => {
      if (!StripeService.isConfigured()) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Payment processing is not configured',
        });
      }
      
      // Resolve amount — if not provided, derive from task price
      // SECURITY FIX: AND poster_id = $2 enforces ownership — callers cannot
      // attach a payment to a task belonging to another poster. NOT_FOUND is
      // returned (not FORBIDDEN) to avoid leaking whether the task exists.
      const taskRow = await db.query<{ price: number }>(
        `SELECT price FROM tasks WHERE id = $1 AND poster_id = $2`,
        [input.taskId, ctx.user.id]
      );
      if (taskRow.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
      }
      const taskPriceCents = taskRow.rows[0].price;

      // REG-2 FIX: Reject escrow creation if task has no price set.
      // Without this guard, null coerces to 0 and the floor check silently passes,
      // allowing a $1 escrow to be created for an unpriced draft task.
      if (taskPriceCents == null) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Task price has not been set. Price the task before creating an escrow.',
        });
      }

      // SECURITY FIX (v2.9.3): Enforce escrow amount >= task price.
      // Without this guard a poster can fund $1 for a $50 task, underpaying the worker.
      const amount = input.amount !== undefined ? input.amount : taskPriceCents;
      if (amount < taskPriceCents) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Escrow amount (${amount}) cannot be less than task price (${taskPriceCents})`,
        });
      }

      const result = await StripeService.createPaymentIntent({
        taskId: input.taskId,
        posterId: ctx.user.id,
        amount,
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
   * Confirm escrow funding (after Stripe payment succeeds)
   * SECURITY: Only the poster who created the escrow can confirm funding
   */
  confirmFunding: posterProcedure
    .input(Schemas.fundEscrow)
    .mutation(async ({ ctx, input }) => {
      // Authorization: verify caller is the poster
      const escrow = await EscrowService.getById(input.escrowId);
      if (!escrow.success) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Escrow not found' });
      }
      if (escrow.data.poster_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the escrow creator can confirm funding' });
      }

      const result = await EscrowService.fund({
        escrowId: input.escrowId,
        stripePaymentIntentId: input.stripePaymentIntentId,
      });

      if (!result.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: result.error.message,
        });
      }

      return result.data;
    }),
  
  /**
   * Release escrow to worker
   * INV-2: Will fail if task is not COMPLETED
   * SECURITY: Only the poster who created the escrow can release funds
   */
  release: posterProcedure
    .input(Schemas.releaseEscrow)
    .mutation(async ({ ctx, input }) => {
      // Authorization: only poster can release escrow
      const escrow = await EscrowService.getById(input.escrowId);
      if (!escrow.success) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Escrow not found' });
      }
      if (escrow.data.poster_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the escrow creator can release funds' });
      }

      // Fraud guard: payout/release — fail-closed + block-on-medium (money leaving platform)
      const { fraudGuard } = await import('../middleware/fraud-guard.js');
      await fraudGuard({ entityType: 'user', entityId: ctx.user.id, action: 'payout', blockOnMedium: true, failClosed: true });

      const result = await EscrowService.release({
        escrowId: input.escrowId,
        stripeTransferId: input.stripeTransferId,
      });

      if (!result.success) {
        const code = result.error.code === 'HX201' ? 'PRECONDITION_FAILED' : 'BAD_REQUEST';
        throw new TRPCError({
          code,
          message: result.error.message,
        });
      }

      return result.data;
    }),
  
  /**
   * Refund escrow to poster
   * SECURITY: Only the poster who created the escrow can request a refund
   */
  refund: posterProcedure
    .input(z.object({ escrowId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      // Authorization: only poster can request refund
      const escrow = await EscrowService.getById(input.escrowId);
      if (!escrow.success) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Escrow not found' });
      }
      if (escrow.data.poster_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the escrow creator can request a refund' });
      }

      // Fraud guard: refund (fail-open for normal refunds)
      const { fraudGuard } = await import('../middleware/fraud-guard.js');
      await fraudGuard({ entityType: 'user', entityId: ctx.user.id, action: 'refund' });

      const result = await EscrowService.refund({
        escrowId: input.escrowId,
      });

      if (!result.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: result.error.message,
        });
      }

      return result.data;
    }),
  
  /**
   * Lock escrow for dispute
   * SECURITY FIX (v2.9.3): Added participant authorization check.
   * Any authenticated user could previously grief-lock any escrow.
   */
  lockForDispute: protectedProcedure
    .input(z.object({ escrowId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      // Authorization: only the task's poster or worker may file a dispute
      const escrow = await EscrowService.getById(input.escrowId);
      if (!escrow.success) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Escrow not found' });
      }
      if (escrow.data.poster_id !== ctx.user.id && escrow.data.worker_id !== ctx.user.id) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only task participants can file a dispute',
        });
      }

      const result = await EscrowService.lockForDispute(input.escrowId, { adminOverride: ctx.user.is_admin });

      if (!result.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: result.error.message,
        });
      }

      return result.data;
    }),
  
  /**
   * Get payment/escrow history for current user
   */
  getHistory: protectedProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(50),
    }).optional())
    .query(async ({ ctx, input }) => {
      const result = await db.query(
        `SELECT e.*, t.poster_id, t.worker_id
         FROM escrows e
         JOIN tasks t ON t.id = e.task_id
         WHERE t.poster_id = $1 OR t.worker_id = $1
         ORDER BY e.created_at DESC
         LIMIT $2`,
        [ctx.user.id, input?.limit || 50]
      );

      return result.rows;
    }),

  // --------------------------------------------------------------------------
  // XP OPERATIONS (linked to escrow release)
  // --------------------------------------------------------------------------
  
  /**
   * Award XP after escrow release
   * INV-1: Will fail if escrow is not RELEASED
   * INV-5: Will fail if XP already awarded for this escrow
   *
   * SECURITY FIX: baseXP is derived server-side from the escrow amount.
   * Callers cannot supply an inflated baseXP value.
   */
  awardXP: hustlerProcedure
    .input(Schemas.awardXP)
    .mutation(async ({ ctx, input }) => {
      // Derive baseXP from the escrow record — caller cannot supply it.
      const escrowResult = await db.query<{ amount: number; worker_id: string }>(
        `SELECT amount, worker_id FROM escrows WHERE id = $1 AND state = 'RELEASED'`,
        [input.escrowId]
      );
      if (escrowResult.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Released escrow not found' });
      }
      const escrow = escrowResult.rows[0];
      // Verify the calling user is the worker on this escrow
      if (escrow.worker_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You are not the worker for this escrow' });
      }
      // Derive baseXP from amount (amount is in cents; $1 = 10 XP)
      const derivedBaseXP = Math.round(escrow.amount / 10);

      const result = await XPService.awardXP({
        userId: ctx.user.id,
        taskId: input.taskId,
        escrowId: input.escrowId,
        baseXP: derivedBaseXP,
      });
      
      if (!result.success) {
        let code: 'PRECONDITION_FAILED' | 'CONFLICT' | 'BAD_REQUEST' = 'BAD_REQUEST';
        if (result.error.code === 'HX101') code = 'PRECONDITION_FAILED';
        if (result.error.code === '23505') code = 'CONFLICT';
        
        throw new TRPCError({
          code,
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
});

export type EscrowRouter = typeof escrowRouter;
