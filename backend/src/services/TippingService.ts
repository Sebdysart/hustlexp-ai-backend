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
import type { ServiceResult } from '../types.js';
import { logger } from '../logger.js';

const log = logger.child({ service: 'TippingService' });

export interface Tip {
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

      if (task.worker_id && task.worker_id === posterId) {
        return { success: false, error: { code: 'SELF_TIP_NOT_ALLOWED', message: 'Cannot tip yourself' } };
      }

      // Validate amount
      if (amountCents < MIN_TIP_CENTS) {
        return { success: false, error: { code: 'INVALID_AMOUNT', message: `Minimum tip is $${MIN_TIP_CENTS / 100}` } };
      }

      const maxTip = Math.floor(task.price * MAX_TIP_PERCENT);
      if (amountCents > maxTip) {
        return { success: false, error: { code: 'INVALID_AMOUNT', message: `Maximum tip is $${(maxTip / 100).toFixed(2)} (50% of task price)` } };
      }

      // Check for existing tip
      const existingTip = await db.query(
        'SELECT id FROM tips WHERE task_id = $1 AND poster_id = $2',
        [taskId, posterId]
      );

      if (existingTip.rows.length > 0) {
        return { success: false, error: { code: 'DUPLICATE', message: 'Already tipped for this task' } };
      }

      // Create Stripe PaymentIntent (no platform fee on tips — 100% to worker)
      if (!config.stripe.secretKey || config.stripe.secretKey.includes('placeholder')) {
        return { success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe not configured' } };
      }

      const stripe = new Stripe(config.stripe.secretKey, { apiVersion: '2025-11-17.clover' });

      // Get worker's Stripe Connect account (tips go 100% to worker)
      const workerResult = await db.query<{ stripe_connect_id: string | null }>(
        'SELECT stripe_connect_id FROM users WHERE id = $1',
        [task.worker_id]
      );

      const workerStripeId = workerResult.rows[0]?.stripe_connect_id ?? undefined;

      const paymentIntent = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: 'usd',
        automatic_payment_methods: { enabled: true },
        metadata: {
          type: 'tip',
          task_id: taskId,
          poster_id: posterId,
          worker_id: task.worker_id,
        },
        ...(workerStripeId ? {
          transfer_data: {
            destination: workerStripeId,
          },
        } : {}),
        description: `HustleXP Tip for Task ${taskId}`,
      });

      // Insert tip record
      const tipResult = await db.query<Tip>(
        `INSERT INTO tips (task_id, poster_id, worker_id, amount_cents, stripe_payment_intent_id, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')
         RETURNING *`,
        [taskId, posterId, task.worker_id, amountCents, paymentIntent.id]
      );

      return {
        success: true,
        data: {
          clientSecret: paymentIntent.client_secret!,
          tipId: tipResult.rows[0].id,
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
      // Verify payment succeeded
      if (!config.stripe.secretKey || config.stripe.secretKey.includes('placeholder')) {
        return { success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe not configured' } };
      }

      const stripe = new Stripe(config.stripe.secretKey, { apiVersion: '2025-11-17.clover' });
      const payment = await stripe.paymentIntents.retrieve(stripePaymentIntentId);

      if (payment.status !== 'succeeded') {
        return { success: false, error: { code: 'PAYMENT_NOT_SUCCEEDED', message: `Payment status: ${payment.status}` } };
      }

      // FIX 4: Verify the PaymentIntent amount matches the tip record amount.
      // Without this check an attacker could reuse a different (smaller)
      // PaymentIntent to confirm a larger tip, crediting the worker more than
      // was actually charged to the poster.
      const tipRecord = await db.query<{ amount_cents: number }>(
        'SELECT amount_cents FROM tips WHERE id = $1',
        [tipId]
      );
      if (tipRecord.rows.length === 0) {
        return { success: false, error: { code: 'NOT_FOUND', message: 'Tip not found' } };
      }
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

      if (result.rows.length === 0) {
        return { success: false, error: { code: 'NOT_FOUND', message: 'Tip not found' } };
      }

      // Notify worker (support both constitutional schema and legacy type/data columns)
      const tip = result.rows[0];
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
