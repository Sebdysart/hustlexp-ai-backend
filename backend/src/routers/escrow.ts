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
import { dispatchEarningsUpdated } from '../realtime/realtime-dispatcher.js';
import { db } from '../db.js';
import { NotificationService } from '../services/NotificationService.js';
import { MessagingService } from '../services/MessagingService.js';
import { z } from 'zod';
import { logger } from '../logger.js';

const log = logger.child({ router: 'escrow' });

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
      let amount = input.amount !== undefined ? input.amount : taskPriceCents;
      if (amount < taskPriceCents) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Escrow amount (${amount}) cannot be less than task price (${taskPriceCents})`,
        });
      }

      // 1. Create escrow record in PENDING state
      const escrowResult = await EscrowService.create({
        taskId: input.taskId,
        amount,
      });
      if (!escrowResult.success) {
        // If escrow already exists for this task, fetch it instead of failing
        if (escrowResult.error.code === 'DUPLICATE') {
          const existing = await EscrowService.getByTaskId(input.taskId);
          if (existing.success) {
            // If already funded, no need for another payment intent
            if (existing.data.state === 'FUNDED') {
              throw new TRPCError({ code: 'BAD_REQUEST', message: 'This task is already funded.' });
            }
            // Return existing escrow's payment intent if available
          }
        }
        if (escrowResult.error.code !== 'DUPLICATE') {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: escrowResult.error.message });
        }
      }

      // 2. Create Stripe PaymentIntent
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

      // 3. Return escrowId + payment details so iOS can confirm funding after payment
      let escrowId: string | undefined;
      if (escrowResult.success) {
        escrowId = escrowResult.data.id;
      } else {
        const existing = await EscrowService.getByTaskId(input.taskId);
        if (existing.success) {
          escrowId = existing.data.id;
        }
      }
      if (!escrowId) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create escrow record' });
      }

      return {
        ...result.data,
        escrowId,
      };
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

      // Notify nearby/eligible hustlers that a new task is available.
      // Fires asynchronously — don't block the funding response.
      try {
        const taskRow = await db.query<{
          id: string;
          title: string;
          location: string | null;
          location_city: string | null;
          location_state: string | null;
          required_tier: number | null;
          poster_id: string;
        }>(
          `SELECT id, title, location, location_city, location_state, required_tier, poster_id
           FROM tasks WHERE id = $1`,
          [escrow.data.task_id]
        );
        const task = taskRow.rows[0];
        if (task) {
          // Get all eligible hustlers — keep it broad for beta (all active hustlers
          // in same city/state, up to 50 recipients to avoid spam).
          const minTier = task.required_tier ?? 1;
          const cityFilter = task.location_city
            ? `AND city ILIKE $3`
            : ``;
          const params: unknown[] = [task.poster_id, minTier];
          if (task.location_city) params.push(task.location_city);
          const eligibleHustlers = await db.query<{ id: string }>(
            `SELECT id FROM users
             WHERE id != $1
               AND default_mode IN ('worker', 'hustler')
               AND COALESCE(trust_tier, 1) >= $2
               AND account_status = 'ACTIVE'
               ${cityFilter}
             LIMIT 50`,
            params
          );

          // Send notifications in parallel (non-blocking)
          const locationLabel = task.location_city && task.location_state
            ? `${task.location_city}, ${task.location_state}`
            : (task.location ?? 'your area');
          await Promise.all(
            eligibleHustlers.rows.map(h =>
              NotificationService.createNotification({
                userId: h.id,
                category: 'new_matching_task',
                title: 'New task in your area',
                body: `"${task.title}" is now available in ${locationLabel}. Tap to view.`,
                taskId: task.id,
                deepLink: `hustlexp://task/${task.id}`,
                channels: ['push', 'in_app'],
                priority: 'MEDIUM',
              }).catch(() => null)
            )
          );
        }
      } catch (err) {
        log.warn({ err }, '[escrow.confirmFunding] Failed to notify hustlers');
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
   * Release escrow to worker (combined: creates Stripe transfer + releases escrow)
   * This is the primary endpoint for poster-initiated payouts.
   * INV-2: Will fail if task is not COMPLETED
   * SECURITY: Only the poster who created the escrow can release funds
   */
  releaseToWorker: posterProcedure
    .input(z.object({ escrowId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      // ── Check 1: Escrow exists + poster authorization ──
      const escrow = await EscrowService.getById(input.escrowId);
      if (!escrow.success) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Escrow not found' });
      }
      if (escrow.data.poster_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the escrow creator can release funds' });
      }

      // ── Check 2: Escrow is in FUNDED state (not already released/refunded) ──
      if (escrow.data.state === 'RELEASED') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Escrow has already been released to the worker.' });
      }
      if (escrow.data.state === 'REFUNDED') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Escrow has already been refunded.' });
      }
      if (escrow.data.state !== 'FUNDED' && escrow.data.state !== 'LOCKED_DISPUTE') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Escrow must be funded before release. Current state: ${escrow.data.state}`,
        });
      }

      // ── Check 3: Task is COMPLETED (INV-2) ──
      const taskResult = await db.query<{ worker_id: string; price: number; state: string }>(
        'SELECT worker_id, price, state FROM tasks WHERE id = $1',
        [escrow.data.task_id]
      );
      if (taskResult.rows.length === 0 || !taskResult.rows[0].worker_id) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Task has no assigned worker' });
      }
      if (taskResult.rows[0].state !== 'COMPLETED') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Task must be completed before payment. Current state: ${taskResult.rows[0].state}`,
        });
      }
      const workerId = taskResult.rows[0].worker_id;

      // ── Check 4: Worker has Stripe Connect set up ──
      const workerResult = await db.query<{ stripe_connect_id: string | null; full_name: string }>(
        'SELECT stripe_connect_id, full_name FROM users WHERE id = $1',
        [workerId]
      );
      if (workerResult.rows.length === 0 || !workerResult.rows[0].stripe_connect_id) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Worker has not set up their payout account. Funds will remain in escrow until they do.',
        });
      }

      // ── Check 5: Escrow amount is valid ──
      const grossAmount = escrow.data.amount;
      if (!grossAmount || grossAmount <= 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Escrow has no funds to release.' });
      }

      // ── Check 6: Stripe is configured ──
      if (!StripeService.isConfigured()) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Payment processing is not configured. Please contact support.',
        });
      }

      // Note: We do NOT check platform balance proactively because:
      // 1. Stripe holds funds in PENDING for ~2 business days before AVAILABLE
      // 2. In test mode, charges often stay in pending indefinitely
      // 3. Stripe's transfer API has its own balance check that's more accurate
      // If the platform truly lacks balance, the transfer call below will fail
      // with a clear "balance_insufficient" error from Stripe.

      // ── All checks passed — execute transfer ──
      const feePercent = Math.min(100, Math.max(0, 15)); // 15% platform fee
      const platformFeeCents = Math.round(grossAmount * (feePercent / 100));
      const netPayoutCents = grossAmount - platformFeeCents;

      // Create Stripe transfer to worker
      const transferResult = await StripeService.createTransfer({
        escrowId: input.escrowId,
        taskId: escrow.data.task_id,
        workerId,
        workerStripeAccountId: workerResult.rows[0].stripe_connect_id,
        amount: netPayoutCents,
        description: `HustleXP Payout for task`,
      });
      if (!transferResult.success) {
        const stripeMsg = transferResult.error.message;
        // Surface a helpful message for the most common failure: insufficient balance
        if (stripeMsg.toLowerCase().includes('insufficient') || stripeMsg.includes('balance_insufficient')) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Payment is settling — please try again in a few minutes. (Test mode charges may take longer to settle.)',
          });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Payment transfer failed: ${stripeMsg}`,
        });
      }

      // Release escrow with the transfer ID
      const releaseResult = await EscrowService.release({
        escrowId: input.escrowId,
        stripeTransferId: transferResult.data.transferId,
      });
      if (!releaseResult.success) {
        throw new TRPCError({
          code: releaseResult.error.code === 'HX201' ? 'PRECONDITION_FAILED' : 'BAD_REQUEST',
          message: releaseResult.error.message,
        });
      }

      // 6. Fire real-time earnings event to worker
      // Compute new total from released escrows so the worker's UI updates instantly.
      try {
        const taskTitle = await db.query<{ title: string }>(
          'SELECT title FROM tasks WHERE id = $1',
          [escrow.data.task_id]
        );
        const totalResult = await db.query<{ total: string }>(
          `SELECT COALESCE(SUM(amount), 0) AS total FROM escrows WHERE worker_id = $1 AND state = 'RELEASED'`,
          [workerId]
        );
        const newTotalCents = parseInt(totalResult.rows[0]?.total ?? '0', 10);

        await dispatchEarningsUpdated({
          userId: workerId,
          taskId: escrow.data.task_id,
          taskTitle: taskTitle.rows[0]?.title ?? 'Task',
          amountCents: grossAmount,
          netPayoutCents: netPayoutCents,
          newTotalEarningsCents: newTotalCents,
        });
      } catch (err) {
        // Non-blocking — log but don't fail the release
        const message = err instanceof Error ? err.message : String(err);
        log.error({ message }, '[escrow.releaseToWorker] Failed to dispatch earnings event');
      }

      // Once payment has settled, the conversation is no longer load-bearing.
      // Delete the task's messages so they stop cluttering both inboxes.
      // Best-effort — failure here must not surface to the user.
      try {
        const cleanup = await MessagingService.deleteForTask(escrow.data.task_id);
        if (!cleanup.success) {
          log.error({ message: cleanup.error.message }, '[escrow.releaseToWorker] Message cleanup failed');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ message }, '[escrow.releaseToWorker] Message cleanup threw');
      }

      return releaseResult.data;
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

      const result = await EscrowService.refund({
        escrowId: input.escrowId,
      });

      if (!result.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: result.error.message,
        });
      }

      // Same as on release: once funds are returned the conversation is settled.
      try {
        const cleanup = await MessagingService.deleteForTask(escrow.data.task_id);
        if (!cleanup.success) {
          log.error({ message: cleanup.error.message }, '[escrow.refund] Message cleanup failed');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ message }, '[escrow.refund] Message cleanup threw');
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
