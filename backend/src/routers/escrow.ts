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
import Stripe from 'stripe';
import { router, protectedProcedure, hustlerProcedure, posterProcedure, Schemas } from '../trpc.js';
import { EscrowService } from '../services/EscrowService.js';
import { StripeService } from '../services/StripeService.js';
import { XPService } from '../services/XPService.js';
import { db } from '../db.js';
import { config } from '../config.js';
import { z } from 'zod';

// Module-level Stripe instance — reused across requests (same pattern as StripeService.ts)
let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!_stripe) {
    if (!config.stripe.secretKey || config.stripe.secretKey.includes('placeholder')) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Payment processing is not configured',
      });
    }
    _stripe = new Stripe(config.stripe.secretKey, { apiVersion: '2025-11-17.clover' });
  }
  return _stripe;
}

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
        const { stripe_payment_intent_id, stripe_transfer_id, ...safeEscrow } = result.data as typeof result.data & { stripe_payment_intent_id?: string; stripe_transfer_id?: string };
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
      // R-14 FIX: EscrowService.getByTaskId now JOINs tasks and returns poster_id/worker_id
      // in the same query, so a second EscrowService.getById() call is no longer needed.
      const result = await EscrowService.getByTaskId(input.taskId);

      if (!result.success) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: result.error.message,
        });
      }

      if (result.data.poster_id !== ctx.user.id && result.data.worker_id !== ctx.user.id && !ctx.user.is_admin) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this escrow' });
      }

      // Strip Stripe-internal identifiers for non-admin callers
      if (!ctx.user.is_admin) {
        const { stripe_payment_intent_id, stripe_transfer_id, ...safeEscrow } = result.data as typeof result.data & { stripe_payment_intent_id?: string; stripe_transfer_id?: string };
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
      // F-30 FIX: tasks.price is DECIMAL(10,2) dollars (e.g. 50.00 for a $50 task).
      // Convert to cents so all downstream comparisons and Stripe calls use cents.
      const taskPriceCents = taskRow.rows[0].price != null
        ? Math.round(Number(taskRow.rows[0].price) * 100)
        : null;

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
      let amount = input.amount !== undefined ? input.amount : taskPriceCents;
      if (amount < taskPriceCents) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Escrow amount (${amount}) cannot be less than task price (${taskPriceCents})`,
        });
      }

      // Look up the existing escrow for this task to scope the PI idempotency key.
      // Each escrow has exactly one PI; scoping to escrowId prevents a refunded
      // escrow from replaying a previously-succeeded PI via Stripe's idempotency cache.
      const escrowRow = await db.query<{ id: string }>(
        `SELECT id FROM escrows WHERE task_id = $1 AND state = 'PENDING' ORDER BY created_at DESC LIMIT 1`,
        [input.taskId]
      );
      if (escrowRow.rows.length === 0) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'No pending escrow found for this task — create the escrow first',
        });
      }
      const escrowId = escrowRow.rows[0].id;

      const result = await StripeService.createPaymentIntent({
        taskId: input.taskId,
        posterId: ctx.user.id,
        escrowId,
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
   * SECURITY FIX (v2.9.4): stripePaymentIntentId is verified against Stripe before
   * transitioning the escrow to FUNDED. A caller supplying a fabricated PI ID will
   * receive PRECONDITION_FAILED — the escrow never transitions without a real, succeeded,
   * correctly-sized payment backing it.
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

      // SECURITY FIX: Verify the payment intent against Stripe before funding the escrow.
      // Without this check a poster can pass a fabricated PI ID and the escrow transitions
      // to FUNDED with no real money backing it — causing platform reserve leakage on release.
      let pi: Stripe.PaymentIntent;
      try {
        pi = await getStripe().paymentIntents.retrieve(input.stripePaymentIntentId, { expand: ['latest_charge'] });
      } catch {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Payment intent not found or could not be verified',
        });
      }

      if (pi.status !== 'succeeded') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Payment intent has not succeeded (status: ${pi.status})`,
        });
      }

      if (pi.amount !== (escrow.data as { amount: number }).amount) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Payment intent amount does not match escrow amount',
        });
      }

      // LL1-A: Verify the PI was created for this specific task — prevents cross-task PI reuse.
      if (pi.metadata?.task_id !== (escrow.data as { task_id: string }).task_id) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Payment intent was not created for this task',
        });
      }

      // LL1-B: Reject refunded PIs. A refunded PI retains status=succeeded but
      // has no money — using it would fund an escrow with no real backing.
      const latestCharge = (pi as Stripe.PaymentIntent & { latest_charge?: { refunded?: boolean } }).latest_charge;
      if (latestCharge?.refunded === true) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Payment intent has already been refunded and cannot be reused',
        });
      }

      // LL1-C: DB dedup — reject if this PI is already linked to a different escrow.
      const piDedupResult = await db.query<{ id: string }>(
        `SELECT id FROM escrows WHERE stripe_payment_intent_id = $1 AND id != $2`,
        [input.stripePaymentIntentId, input.escrowId]
      );
      if (piDedupResult.rows.length > 0) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Payment intent is already associated with another escrow',
        });
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
   *
   * NOTE: The primary payment flow goes through the Stripe webhook handler
   * (transfer.created → payment-worker.ts handleTransferCreated). This endpoint
   * is used as a fallback for cases where the transfer was created server-side
   * but the webhook was not processed, or for manual/off-platform releases.
   *
   * SECURITY FIX (v2.9.4): The stripeTransferId supplied by the poster is verified
   * against Stripe before accepting it. A caller providing a fabricated transfer ID
   * would previously mark the escrow as RELEASED while the worker receives nothing.
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

      // SECURITY FIX: Verify the Stripe transfer exists before accepting the caller-supplied
      // stripeTransferId. A poster providing a fabricated ID would otherwise mark the escrow
      // as RELEASED with no corresponding funds reaching the worker.
      let transfer: Stripe.Transfer;
      try {
        transfer = await getStripe().transfers.retrieve(input.stripeTransferId);
      } catch {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Stripe transfer not found or could not be verified',
        });
      }

      // Sanity-check: transfer amount must be at least the escrow amount (platform fee
      // may mean the transfer is slightly less, but it should never be zero or negative).
      const escrowAmount = (escrow.data as { amount: number }).amount;
      if (transfer.amount <= 0 || transfer.amount > escrowAmount) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Stripe transfer amount is not consistent with escrow amount',
        });
      }

      // BUG-5 FIX: Verify the associated task is COMPLETED before releasing funds.
      // INV-2 states escrow can only be released on a completed task, but previously
      // this router never checked task state — only the escrow state. A poster could
      // trigger release while the task was still IN_PROGRESS.
      const taskStateRow = await db.query<{ state: string; price: number }>(
        `SELECT t.state, t.price FROM tasks t JOIN escrows e ON e.task_id = t.id WHERE e.id = $1`,
        [input.escrowId]
      );
      if (taskStateRow.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found for this escrow' });
      }
      if (taskStateRow.rows[0].state !== 'COMPLETED') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Task must be completed before releasing escrow',
        });
      }

      // SECURITY FIX (HH3): Enforce a minimum transfer floor of 80% of task base price.
      // The platform takes a 15% fee, so the worker should receive ~85% of the task price.
      // A 5% tolerance band is allowed for rounding, giving a floor of 80%.
      // The floor is computed against task price (not escrow amount) so a poster tip
      // above the task price does not artificially inflate the minimum payout requirement.
      const taskPrice = taskStateRow.rows[0].price;

      // BUG-5 FIX: Guard against null/NaN/zero task price before computing floor.
      // Previously: taskPrice = taskPriceRow.rows[0]?.price ?? escrowAmount — if price
      // was null the fallback was escrowAmount (correct) but if price was 0 or NaN,
      // Math.floor(NaN * 0.80) = NaN and NaN < anything is false, silently bypassing
      // the floor check entirely.
      if (!taskPrice || !Number.isFinite(Number(taskPrice)) || Number(taskPrice) <= 0) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Task price is invalid — cannot compute release floor',
        });
      }
      // F-30 FIX: tasks.price is DECIMAL(10,2) dollars — convert to cents before
      // computing the floor so the comparison to transfer.amount (always in cents) is valid.
      const taskPriceCentsForFloor = Math.round(Number(taskPrice) * 100);
      const minimumTransferFloor = Math.floor(taskPriceCentsForFloor * 0.80);
      if (transfer.amount < minimumTransferFloor) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Transfer amount must be at least 80% of task base price',
        });
      }

      // LL2: Verify the transfer metadata ties back to this specific escrow.
      // A poster supplying a transfer from a different escrow would otherwise
      // mark this escrow as RELEASED while the worker for THIS escrow receives nothing.
      if (transfer.metadata?.escrow_id !== input.escrowId) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Stripe transfer was not created for this escrow',
        });
      }

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

      // LL4: Task state validation is performed INSIDE EscrowService.refund()
      // within a FOR UPDATE transaction, eliminating the TOCTOU race window
      // that existed when the check ran here outside the transaction.

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

      // BUG 5 FIX (TOCTOU): Task state validation is now performed INSIDE
      // EscrowService.lockForDispute under the FOR UPDATE transaction lock,
      // eliminating the race window between this check and the service call.
      // Pass allowedTaskStates so the service validates atomically.
      const allowedTaskStates = ['ACCEPTED', 'IN_PROGRESS', 'PROOF_SUBMITTED', 'DISPUTED', 'COMPLETED'];

      const result = await EscrowService.lockForDispute(input.escrowId, { adminOverride: ctx.user.is_admin, initiatedBy: ctx.user.id, allowedTaskStates });

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
      offset: z.number().int().nonnegative().default(0),
    }).optional())
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 50;
      const offset = input?.offset ?? 0;

      const totalResult = await db.query<{ count: string }>(
        `SELECT COUNT(*)::text as count
         FROM escrows e
         JOIN tasks t ON t.id = e.task_id
         WHERE t.poster_id = $1 OR t.worker_id = $1`,
        [ctx.user.id]
      );
      const total = parseInt(totalResult.rows[0]?.count ?? '0', 10);

      const result = await db.query(
        `SELECT e.*, t.poster_id, t.worker_id
         FROM escrows e
         JOIN tasks t ON t.id = e.task_id
         WHERE t.poster_id = $1 OR t.worker_id = $1
         ORDER BY e.created_at DESC
         LIMIT $2 OFFSET $3`,
        [ctx.user.id, limit, offset]
      );

      const rows = result.rows as (Record<string, unknown> & { stripe_payment_intent_id?: string; stripe_transfer_id?: string })[];
      const items = rows.map((row) => {
        const { stripe_payment_intent_id, stripe_transfer_id, ...safe } = row;
        return ctx.user.is_admin === true ? row : safe;
      });
      return { items, total, offset };
    }),

  // --------------------------------------------------------------------------
  // XP OPERATIONS (linked to escrow release)
  // --------------------------------------------------------------------------
  
  /**
   * Award XP after escrow release — MANUAL RETRY PATH.
   *
   * This endpoint exists as a fallback for when EscrowService.release() auto-awards
   * XP but the XP call fails silently (the release still succeeds). In that case the
   * failure is logged at WARN level and the worker can call this endpoint to retry.
   *
   * INV-1: Will fail if escrow is not RELEASED
   * INV-5: Unique constraint prevents double-award — safe to retry idempotently.
   *
   * SECURITY FIX: baseXP is derived server-side from the escrow amount.
   * Callers cannot supply an inflated baseXP value.
   */
  awardXP: hustlerProcedure
    .input(Schemas.awardXP)
    .mutation(async ({ ctx, input }) => {
      // Derive baseXP from the escrow record — caller cannot supply it.
      const escrowResult = await db.query<{ amount: number; worker_id: string; task_id: string }>(
        `SELECT amount, worker_id, task_id FROM escrows WHERE id = $1 AND state = 'RELEASED'`,
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
      // Cross-validate: taskId supplied by caller must match the escrow's own task_id.
      // Without this check a worker can supply their legitimate escrowId but a different
      // taskId (e.g. a Live/surge task) to inflate their XP multiplier.
      if (escrow.task_id !== input.taskId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'taskId does not match escrow' });
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
