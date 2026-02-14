/**
 * Featured Listings Router v1.1.0
 *
 * P0 Profitability Fix: promoteTask now inserts with active = FALSE
 * and payment_status = 'pending'. The new confirmPromotion mutation
 * verifies the Stripe PaymentIntent succeeded before activating.
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import { db } from '../db';
import Stripe from 'stripe';
import { config } from '../config';
import { RevenueService } from '../services/RevenueService';

const FEATURE_PRICING: Record<string, { cents: number; hours: number }> = {
  promoted: { cents: 299, hours: 24 },
  highlighted: { cents: 499, hours: 48 },
  urgent_boost: { cents: 799, hours: 12 },
};

export const featuredRouter = router({
  /**
   * Promote a task: creates a Stripe PaymentIntent and inserts
   * the listing with active = FALSE until payment is confirmed.
   */
  promoteTask: protectedProcedure
    .input(z.object({
      taskId: z.string().uuid(),
      featureType: z.enum(['promoted', 'highlighted', 'urgent_boost']),
    }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const pricing = FEATURE_PRICING[input.featureType];

      if (!pricing) {
        return { success: false, error: 'Invalid feature type' };
      }

      // Verify task ownership
      const task = await db.query<{ poster_id: string }>(
        'SELECT poster_id FROM tasks WHERE id = $1',
        [input.taskId]
      );

      if (task.rows.length === 0 || task.rows[0].poster_id !== userId) {
        return { success: false, error: 'Task not found or not owned by user' };
      }

      // Check for existing active promotion
      const existing = await db.query(
        `SELECT id FROM featured_listings
         WHERE task_id = $1 AND active = TRUE AND expires_at > NOW()`,
        [input.taskId]
      );

      if (existing.rows.length > 0) {
        return { success: false, error: 'Task already has an active promotion' };
      }

      // Create Stripe payment
      let clientSecret: string | null = null;
      let paymentIntentId: string | null = null;

      if (config.stripe.secretKey && !config.stripe.secretKey.includes('placeholder')) {
        const stripe = new Stripe(config.stripe.secretKey, { apiVersion: '2025-12-15.clover' });
        const pi = await stripe.paymentIntents.create({
          amount: pricing.cents,
          currency: 'usd',
          automatic_payment_methods: { enabled: true },
          metadata: {
            type: 'featured_listing',
            task_id: input.taskId,
            feature_type: input.featureType,
          },
        });
        clientSecret = pi.client_secret;
        paymentIntentId = pi.id;
      }

      // Insert listing with active = FALSE until payment confirmed
      const expiresAt = new Date(Date.now() + pricing.hours * 60 * 60 * 1000);
      const listingResult = await db.query<{ id: string }>(
        `INSERT INTO featured_listings
           (task_id, poster_id, feature_type, fee_cents, stripe_payment_intent_id, expires_at, active, payment_status)
         VALUES ($1, $2, $3, $4, $5, $6, FALSE, 'pending')
         RETURNING id`,
        [input.taskId, userId, input.featureType, pricing.cents, paymentIntentId, expiresAt]
      );

      return {
        success: true,
        listingId: listingResult.rows[0].id,
        clientSecret,
        feeCents: pricing.cents,
      };
    }),

  /**
   * Confirm promotion: verifies the PaymentIntent succeeded,
   * then activates the featured listing and logs revenue.
   */
  confirmPromotion: protectedProcedure
    .input(z.object({
      listingId: z.string().uuid(),
      stripePaymentIntentId: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;

      // 1. Verify PaymentIntent status in Stripe
      if (config.stripe.secretKey && !config.stripe.secretKey.includes('placeholder')) {
        const stripe = new Stripe(config.stripe.secretKey, { apiVersion: '2025-12-15.clover' });
        const pi = await stripe.paymentIntents.retrieve(input.stripePaymentIntentId);

        if (pi.status !== 'succeeded') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Payment not completed. Current status: ${pi.status}`,
          });
        }
      }

      // 2. Activate the listing
      const result = await db.query<{ id: string; fee_cents: number; task_id: string; feature_type: string }>(
        `UPDATE featured_listings
         SET active = TRUE,
             payment_status = 'paid'
         WHERE id = $1
           AND poster_id = $2
           AND stripe_payment_intent_id = $3
           AND payment_status = 'pending'
         RETURNING id, fee_cents, task_id, feature_type`,
        [input.listingId, userId, input.stripePaymentIntentId]
      );

      if (result.rowCount === 0) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Featured listing not found, already activated, or payment mismatch',
        });
      }

      const listing = result.rows[0];

      // 3. Log revenue event
      await RevenueService.logEvent({
        eventType: 'featured_listing',
        userId,
        taskId: listing.task_id,
        amountCents: listing.fee_cents,
        // V2: 100% revenue, no fee split
        currency: 'usd',
        grossAmountCents: listing.fee_cents,
        platformFeeCents: 0,
        netAmountCents: listing.fee_cents,
        feeBasisPoints: 0,
        stripePaymentIntentId: input.stripePaymentIntentId,
        metadata: { featureType: listing.feature_type, listingId: listing.id },
      });

      return {
        success: true,
        listingId: listing.id,
        active: true,
      };
    }),

  getFeaturedTasks: protectedProcedure
    .query(async () => {
      const result = await db.query(
        `SELECT fl.*, t.title, t.description, t.price, t.location_text
         FROM featured_listings fl
         JOIN tasks t ON t.id = fl.task_id
         WHERE fl.active = TRUE AND fl.expires_at > NOW()
         ORDER BY fl.created_at DESC
         LIMIT 20`
      );

      return result.rows;
    }),
});
