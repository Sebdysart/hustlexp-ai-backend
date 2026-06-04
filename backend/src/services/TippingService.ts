/**
 * TippingService v1.0.0
 *
 * Post-completion tipping system.
 * Posters can tip hustlers after task completion.
 * Tips are processed via Stripe and 100% goes to the worker (no platform cut).
 *
 * Rules:
 * - Tips only after task state = COMPLETED
 * - One tip per task per poster
 * - Min tip: $1 (100 cents), Max tip: 50% of task price
 * - Tips are non-refundable
 * - Worker receives notification of tip
 */

import Stripe from 'stripe';
import { config } from '../config.js';
import { db } from '../db.js';
import { RevenueService } from './RevenueService.js';
import type { ServiceResult } from '../types.js';
import { logger } from '../logger.js';

// H3 FIX: Module-level Stripe singleton — instantiated once, not per request.
// Matches the pattern used in StripeService.ts. Per-request instantiation
// bypasses the circuit breaker and creates unnecessary overhead.
let stripe: Stripe | null = null;
if (config.stripe.secretKey && !config.stripe.secretKey.includes('placeholder')) {
  stripe = new Stripe(config.stripe.secretKey, { apiVersion: '2025-11-17.clover' });
}

const log = logger.child({ service: 'TippingService' });

interface Tip {
  id: string;
  task_id: string;
  poster_id: string;
  worker_id: string;
  amount_cents: number;
  stripe_payment_intent_id: string | null;
  status: 'pending' | 'completed' | 'failed';
  created_at: Date;
  completed_at: Date | null;
}

interface CreateTipParams {
  taskId: string;
  posterId: string;
  amountCents: number;
}

const MIN_TIP_CENTS = 100;   // $1.00
const MAX_TIP_PERCENT = 0.50; // 50% of task price

export const TippingService = {
  /**
   * Create a tip for a completed task
   */
  createTip: async (params: CreateTipParams): Promise<ServiceResult<{ clientSecret: string; tipId: string; amountCents: number }>> => {
    const { taskId, posterId, amountCents } = params;

    try {
      // Validate task is completed and poster owns it
      const taskResult = await db.query<{
        state: string;
        poster_id: string;
        worker_id: string;
        price: number;
      }>(
        'SELECT state, poster_id, worker_id, price FROM tasks WHERE id = $1',
        [taskId]
      );

      if (taskResult.rows.length === 0) {
        return { success: false, error: { code: 'NOT_FOUND', message: 'Task not found' } };
      }

      const task = taskResult.rows[0];

      if (task.state !== 'COMPLETED') {
        return { success: false, error: { code: 'INVALID_STATE', message: 'Can only tip on completed tasks' } };
      }

      if (task.poster_id !== posterId) {
        return { success: false, error: { code: 'UNAUTHORIZED', message: 'Only the poster can tip' } };
      }

      if (!task.worker_id) {
        return { success: false, error: { code: 'NO_WORKER', message: 'Task has no assigned worker — cannot accept tips' } };
      }

      if (task.worker_id === posterId) {
        return { success: false, error: { code: 'SELF_TIP_NOT_ALLOWED', message: 'Cannot tip yourself' } };
      }

      // Validate amount
      if (amountCents < MIN_TIP_CENTS) {
        return { success: false, error: { code: 'INVALID_AMOUNT', message: `Minimum tip is $${MIN_TIP_CENTS / 100}` } };
      }

      // H2 FIX: When task.price is null, treat it as no cap (null-safe guard).
      // Previously `null * 0.5` evaluated to 0, blocking all tips on null-price tasks.
      // F-21 FIX: task.price is stored in dollars; convert to cents before comparing
      // against amountCents (which is already in cents). Without this conversion the
      // cap is 100× too small (e.g., $50 task → cap of $0.25 instead of $25.00).
      const taskPriceCents = task.price != null ? Math.round(Number(task.price) * 100) : null;
      const cap = taskPriceCents != null ? Math.floor(taskPriceCents * MAX_TIP_PERCENT) : null;
      if (cap !== null && amountCents > cap) {
        return { success: false, error: { code: 'INVALID_AMOUNT', message: `Maximum tip is $${(cap / 100).toFixed(2)} (50% of task price)` } };
      }

      // H3 FIX: Use module-level Stripe singleton (initialized at module load).
      if (!stripe) {
        return { success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe not configured' } };
      }

      // TT-06 FIX: Split the original combined transaction into three steps so
      // that the Stripe PaymentIntent is created OUTSIDE any DB transaction.
      // If the PI was created inside the transaction and the INSERT rolled back,
      // the PI would be orphaned in Stripe with no corresponding DB record.
      //
      // Step 1 — Short transaction: duplicate check + worker Stripe account.
      //   Commits immediately after the FOR UPDATE lock is released, so the
      //   concurrent-duplicate guard (H1 FIX) is preserved.
      const checkResult = await db.transaction(async (query) => {
        // Advisory lock keyed on (task_id, poster_id) — serializes concurrent
        // first-time tip requests for this pair. pg_advisory_xact_lock is
        // released automatically when the transaction ends.
        // Without this, two concurrent requests both see 0 rows from the
        // SELECT FOR UPDATE below and both proceed to create Stripe PIs.
        await query(
          `SELECT pg_advisory_xact_lock(hashtext($1))`,
          [`tip:${taskId}:${posterId}`]
        );

        // Lock on (task_id, poster_id) — prevents concurrent tip creation for
        // the same task by the same poster.
        const lockResult = await query<{ id: string }>(
          'SELECT id FROM tips WHERE task_id = $1 AND poster_id = $2 FOR UPDATE',
          [taskId, posterId]
        );

        if (lockResult.rows.length > 0) {
          return { duplicate: true as const, existingId: lockResult.rows[0].id };
        }

        // Get worker's Stripe Connect account (tips go 100% to worker)
        const workerResult = await query<{ stripe_connect_id: string | null }>(
          'SELECT stripe_connect_id FROM users WHERE id = $1',
          [task.worker_id]
        );

        const workerStripeId = workerResult.rows[0]?.stripe_connect_id ?? undefined;
        return { duplicate: false as const, workerStripeId };
      });

      if (checkResult.duplicate) {
        return { success: false, error: { code: 'DUPLICATE', message: 'Already tipped for this task' } };
      }

      // F47-5 FIX: Reject tip creation when the worker has no Stripe Connect account.
      // Previously, a null workerStripeId caused the PaymentIntent to be created on the
      // platform account with NO transfer_data — the poster was charged but the worker
      // received nothing (funds silently pocketed by the platform). Return a clear error
      // so the caller can prompt the worker to complete Stripe Connect onboarding.
      if (!checkResult.workerStripeId) {
        return {
          success: false,
          error: {
            code: 'WORKER_NO_CONNECT_ACCOUNT',
            message: 'Worker has not connected their Stripe account — tips cannot be sent until they complete Stripe Connect onboarding.',
          },
        };
      }

      // Step 2 — Create Stripe PI outside any DB transaction.
      //   If the subsequent INSERT fails we cancel the PI to avoid orphaning it.
      const paymentIntent = await stripe!.paymentIntents.create(
        {
          amount: amountCents,
          currency: 'usd',
          automatic_payment_methods: { enabled: true },
          metadata: {
            type: 'tip',
            task_id: taskId,
            poster_id: posterId,
            worker_id: task.worker_id,
          },
          ...(checkResult.workerStripeId ? {
            transfer_data: {
              destination: checkResult.workerStripeId,
            },
          } : {}),
          description: `HustleXP Tip for Task ${taskId}`,
        },
        { idempotencyKey: `tip_pi_${taskId}_${posterId}_${amountCents}` }
      );

      // Step 3 — Insert the tip row referencing the newly created PI.
      //   On failure, cancel the PI to keep Stripe clean.
      let insertedTip: Tip;
      let clientSecret: string;
      try {
        const insertResult = await db.query<Tip>(
          `INSERT INTO tips (task_id, poster_id, worker_id, amount_cents, stripe_payment_intent_id, status)
           VALUES ($1, $2, $3, $4, $5, 'pending')
           RETURNING *`,
          [taskId, posterId, task.worker_id, amountCents, paymentIntent.id]
        );
        insertedTip = insertResult.rows[0];
        clientSecret = paymentIntent.client_secret!;
      } catch (insertError) {
        // Attempt to cancel the orphaned PI before re-throwing.
        try {
          await stripe!.paymentIntents.cancel(paymentIntent.id);
          log.warn({ piId: paymentIntent.id, taskId }, 'Cancelled orphaned Stripe PI after tip INSERT failure');
        } catch (cancelError) {
          log.error(
            { piId: paymentIntent.id, err: cancelError instanceof Error ? cancelError.message : String(cancelError) },
            'Failed to cancel orphaned Stripe PI — manual cleanup required'
          );
        }
        throw insertError;
      }

      return {
        success: true,
        data: {
          clientSecret,
          tipId: insertedTip.id,
          amountCents,
        }
      };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'Failed to create tip');
      return {
        success: false,
        error: {
          code: 'TIP_CREATION_FAILED',
          message: error instanceof Error ? error.message : 'Failed to create tip'
        }
      };
    }
  },

  /**
   * Confirm tip payment (called after Stripe payment succeeds)
   */
  confirmTip: async (tipId: string, stripePaymentIntentId: string): Promise<ServiceResult<Tip>> => {
    try {
      // H3 FIX: Use module-level Stripe singleton (initialized at module load).
      if (!stripe) {
        return { success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe not configured' } };
      }

      const payment = await stripe.paymentIntents.retrieve(stripePaymentIntentId);

      if (payment.status !== 'succeeded') {
        return { success: false, error: { code: 'PAYMENT_NOT_SUCCEEDED', message: `Payment status: ${payment.status}` } };
      }

      // TT-02 FIX: Verify PI metadata.type === 'tip' before treating it as a tip.
      // Without this check an escrow PI (or any other PI) that happens to have
      // status=succeeded and a matching amount could be passed to confirm a tip,
      // bypassing the financial isolation between payment types.
      if (payment.metadata?.type !== 'tip') {
        return { success: false, error: { code: 'INVALID_PAYMENT_INTENT', message: 'Payment intent is not a tip' } };
      }

      // Fetch tip record for amount and task_id cross-checks.
      const tipRecord = await db.query<{ amount_cents: number; task_id: string }>(
        'SELECT amount_cents, task_id FROM tips WHERE id = $1',
        [tipId]
      );
      if (tipRecord.rows.length === 0) {
        return { success: false, error: { code: 'NOT_FOUND', message: 'Tip not found' } };
      }

      // TT-02 FIX: Verify PI metadata.task_id matches the tip's task_id.
      // Prevents an attacker from reusing a tip PI for a different task.
      if (payment.metadata?.task_id !== tipRecord.rows[0].task_id) {
        return {
          success: false,
          error: {
            code: 'INVALID_PAYMENT_INTENT',
            message: 'Payment intent task_id does not match tip task_id',
          },
        };
      }

      // FIX 4: Verify the PaymentIntent amount matches the tip record amount.
      // Without this check an attacker could reuse a different (smaller)
      // PaymentIntent to confirm a larger tip, crediting the worker more than
      // was actually charged to the poster.
      if (payment.amount !== tipRecord.rows[0].amount_cents) {
        return {
          success: false,
          error: {
            code: 'PAYMENT_AMOUNT_MISMATCH',
            message: `Payment amount (${payment.amount}) does not match tip amount (${tipRecord.rows[0].amount_cents})`,
          },
        };
      }

      const result = await db.query<Tip>(
        `UPDATE tips
         SET status = 'completed', completed_at = NOW()
         WHERE id = $1 AND stripe_payment_intent_id = $2
         RETURNING *`,
        [tipId, stripePaymentIntentId]
      );

      if (result.rowCount === 0) {
        // LL9: Idempotency — if the UPDATE matched 0 rows, check whether the tip
        // is already in completed status (concurrent call already confirmed it).
        const existing = await db.query<{ status: string; id: string }>(
          'SELECT status, id FROM tips WHERE id = $1',
          [tipId]
        );
        if (existing.rows[0]?.status === 'completed') {
          // Fetch the full row to return the canonical response
          const existingFull = await db.query<Tip>(
            'SELECT * FROM tips WHERE id = $1',
            [tipId]
          );
          return { success: true, data: existingFull.rows[0] };
        }
        return { success: false, error: { code: 'NOT_FOUND', message: 'Tip not found' } };
      }

      if (result.rows.length === 0) {
        return { success: false, error: { code: 'NOT_FOUND', message: 'Tip not found' } };
      }

      // F-04 FIX: Write revenue ledger entry so tips appear in GetRevenueSummary.
      // F46-1 FIX: Changed eventType from 'per_task_fee' to 'tip_received'. The
      // previous code used 'per_task_fee' with amountCents=0, which is silently
      // rejected by RevenueService.POSITIVE_ONLY_EVENTS guard (per_task_fee requires
      // amountCents > 0). 'tip_received' is not in POSITIVE_ONLY_EVENTS so
      // amountCents=0 is accepted — tips are 100% to the worker, platform takes nothing.
      // tipId is included in metadata for dedup and cross-referencing.
      const tip = result.rows[0];
      try {
        await RevenueService.logEvent({
          eventType: 'tip_received',
          userId: tip.worker_id,
          taskId: tip.task_id,
          amountCents: 0, // Tips are 100% to the worker — no platform revenue
          grossAmountCents: tip.amount_cents,
          platformFeeCents: 0,
          netAmountCents: tip.amount_cents,
          stripePaymentIntentId: tip.stripe_payment_intent_id ?? undefined,
          metadata: { tip_id: tip.id, event: 'tip_received' },
        });
      } catch (revenueErr) {
        log.warn(
          { err: revenueErr instanceof Error ? revenueErr.message : String(revenueErr), tipId: tip.id },
          'confirmTip: revenue ledger write failed — tip confirmed but ledger entry missing; manual reconciliation required'
        );
      }

      // Notify worker (support both constitutional schema and legacy type/data columns)
      const notifBody = `You received a $${(tip.amount_cents / 100).toFixed(2)} tip! Great job!`;
      const notifMeta = { task_id: tip.task_id, amount_cents: tip.amount_cents };
      try {
        await db.query(
          `INSERT INTO notifications (user_id, category, title, body, deep_link, task_id, metadata, channels, priority, created_at)
           VALUES ($1, 'tip_received', '💰 You received a tip!', $2, $3, $4, $5::JSONB, ARRAY['push']::TEXT[], 'HIGH', NOW())`,
          [tip.worker_id, notifBody, `/task/${tip.task_id}`, tip.task_id, JSON.stringify(notifMeta)]
        );
      } catch {
        try {
          await db.query(
            `INSERT INTO notifications (user_id, type, title, body, data, created_at)
             VALUES ($1, 'tip_received', '💰 You received a tip!', $2, $3, NOW())`,
            [tip.worker_id, notifBody, JSON.stringify(notifMeta)]
          );
        } catch {
          log.warn({ tipId: tip.id, workerId: tip.worker_id }, 'Could not create tip_received notification');
        }
      }

      return { success: true, data: tip };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'Failed to confirm tip');
      return {
        success: false,
        error: {
          code: 'TIP_CONFIRMATION_FAILED',
          message: error instanceof Error ? error.message : 'Failed to confirm tip'
        }
      };
    }
  },

  /**
   * Get tips for a task
   */
  getTipsForTask: async (taskId: string): Promise<ServiceResult<Tip[]>> => {
    try {
      const result = await db.query<Tip>(
        'SELECT * FROM tips WHERE task_id = $1 ORDER BY created_at DESC',
        [taskId]
      );
      return { success: true, data: result.rows };
    } catch (error) {
      return {
        success: false,
        error: { code: 'GET_TIPS_FAILED', message: error instanceof Error ? error.message : 'Failed' }
      };
    }
  },

  /**
   * Get total tips received by a user
   */
  getTotalTipsReceived: async (userId: string): Promise<ServiceResult<{ totalCents: number; count: number }>> => {
    try {
      const result = await db.query<{ total: string; count: string }>(
        `SELECT COALESCE(SUM(amount_cents), 0) as total, COUNT(*) as count
         FROM tips WHERE worker_id = $1 AND status = 'completed'`,
        [userId]
      );
      return {
        success: true,
        data: {
          totalCents: parseInt(result.rows[0].total, 10),
          count: parseInt(result.rows[0].count, 10),
        }
      };
    } catch (error) {
      return {
        success: false,
        error: { code: 'GET_TIPS_FAILED', message: error instanceof Error ? error.message : 'Failed' }
      };
    }
  },

  /**
   * Get tips sent by a user (as poster)
   */
  getTipsSentByUser: async (
    posterId: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<ServiceResult<Tip[]>> => {
    try {
      const result = await db.query<Tip>(
        `SELECT * FROM tips WHERE poster_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [posterId, limit, offset]
      );
      return { success: true, data: result.rows };
    } catch (error) {
      return {
        success: false,
        error: { code: 'GET_TIPS_FAILED', message: error instanceof Error ? error.message : 'Failed' }
      };
    }
  },
};

export default TippingService;
