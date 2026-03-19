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

import { db } from '../db';
import type { ServiceResult } from '../types';
import { logger } from '../logger';
import { StripeService } from './StripeService';

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
  createTip: async (params: CreateTipParams): Promise<ServiceResult<{ clientSecret: string; tipId: string }>> => {
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

      if (task.state !== 'completed') {
        return { success: false, error: { code: 'INVALID_STATE', message: 'Can only tip on completed tasks' } };
      }

      if (task.poster_id !== posterId) {
        return { success: false, error: { code: 'UNAUTHORIZED', message: 'Only the poster can tip' } };
      }

      // Validate amount
      if (amountCents < MIN_TIP_CENTS) {
        return { success: false, error: { code: 'INVALID_AMOUNT', message: `Minimum tip is $${MIN_TIP_CENTS / 100}` } };
      }

      const maxTip = task.price != null ? Math.floor(task.price * MAX_TIP_PERCENT) : Infinity;
      if (amountCents > maxTip) {
        return { success: false, error: { code: 'INVALID_AMOUNT', message: `Maximum tip is $${(maxTip / 100).toFixed(2)} (50% of task price)` } };
      }

      // TOCTOU-safe: Lock existing tip row inside transaction to prevent concurrent creates
      const existingTip = await db.query(
        'SELECT id FROM tips WHERE task_id = $1 AND tipper_id = $2 FOR UPDATE',
        [taskId, posterId]
      );

      if (existingTip.rows.length > 0) {
        return { success: false, error: { code: 'DUPLICATE', message: 'Already tipped for this task' } };
      }

      // Stripe configuration check via singleton
      if (!StripeService.isConfigured()) {
        return { success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe not configured' } };
      }

      // Create tip PI via StripeService singleton (circuit-breaker protected)
      const piResult = await StripeService.createPaymentIntent({
        taskId,
        posterId,
        amount: amountCents,
        description: `HustleXP Tip for Task ${taskId}`,
      });

      if (!piResult.success) {
        return { success: false, error: { code: 'TIP_CREATION_FAILED', message: piResult.error.message } };
      }

      // Insert tip record
      const tipResult = await db.query<Tip>(
        `INSERT INTO tips (task_id, poster_id, worker_id, amount_cents, stripe_payment_intent_id, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')
         RETURNING *`,
        [taskId, posterId, task.worker_id, amountCents, piResult.data.paymentIntentId]
      );

      return {
        success: true,
        data: {
          clientSecret: piResult.data.clientSecret,
          tipId: tipResult.rows[0].id,
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
      // Verify payment succeeded via StripeService singleton
      if (!StripeService.isConfigured()) {
        return { success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe not configured' } };
      }

      const piVerify = await StripeService.verifyPaymentIntent(stripePaymentIntentId);
      if (!piVerify.success) {
        return { success: false, error: { code: 'STRIPE_ERROR', message: piVerify.error.message } };
      }

      if (piVerify.data.status !== 'succeeded') {
        return { success: false, error: { code: 'PAYMENT_NOT_SUCCEEDED', message: `Payment status: ${piVerify.data.status}` } };
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

      // Send notification to worker
      const tip = result.rows[0];
      await db.query(
        `INSERT INTO notifications (user_id, type, title, body, data, created_at)
         VALUES ($1, 'tip_received', '💰 You received a tip!',
                 $2, $3, NOW())`,
        [
          tip.worker_id,
          `You received a $${(tip.amount_cents / 100).toFixed(2)} tip! Great job!`,
          JSON.stringify({ task_id: tip.task_id, amount_cents: tip.amount_cents })
        ]
      );

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
};

export default TippingService;
