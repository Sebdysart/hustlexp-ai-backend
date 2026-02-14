/**
 * Subscription Router v1.0.0
 *
 * Gates recurring task creation behind subscription plans.
 * Free users: 0 recurring tasks. Premium: 5. Pro: unlimited.
 *
 * Creates Stripe Subscriptions for recurring billing and manages
 * plan lifecycle (subscribe, cancel, confirm).
 *
 * @see config.ts §stripe.plans for pricing
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import { db } from '../db';
import Stripe from 'stripe';
import { config } from '../config';
import { RevenueService } from '../services/RevenueService';

// ============================================================================
// CONSTANTS
// ============================================================================

const RECURRING_TASK_LIMITS: Record<string, number> = {
  free: 0,
  premium: 5,
  pro: 999999, // effectively unlimited
};

// ============================================================================
// ROUTER
// ============================================================================

export const subscriptionRouter = router({
  /**
   * Get current subscription status including recurring task usage.
   */
  getMySubscription: protectedProcedure
    .query(async ({ ctx }) => {
      const userId = ctx.user.id;

      // Get user plan info
      const userResult = await db.query<{
        plan: string;
        plan_expires_at: Date | null;
        stripe_subscription_id: string | null;
      }>(
        `SELECT plan, plan_expires_at, stripe_subscription_id
         FROM users WHERE id = $1`,
        [userId]
      );

      if (userResult.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }

      const user = userResult.rows[0];
      const plan = user.plan || 'free';

      // Count active recurring tasks
      const recurringResult = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM tasks
         WHERE poster_id = $1 AND mode = 'STANDARD' AND state = 'OPEN'
         AND id IN (SELECT task_id FROM recurring_tasks WHERE active = TRUE)`,
        [userId]
      );

      const recurringTaskCount = parseInt(recurringResult.rows[0]?.count || '0', 10);
      const recurringTaskLimit = RECURRING_TASK_LIMITS[plan] ?? 0;

      return {
        plan,
        expiresAt: user.plan_expires_at,
        stripeSubscriptionId: user.stripe_subscription_id,
        recurringTaskCount,
        recurringTaskLimit,
        canCreateRecurringTask: recurringTaskCount < recurringTaskLimit,
      };
    }),

  /**
   * Subscribe to a plan. Creates a Stripe Subscription and updates
   * the user's plan. Returns clientSecret for first payment.
   */
  subscribe: protectedProcedure
    .input(z.object({
      plan: z.enum(['premium', 'pro']),
      interval: z.enum(['month', 'year']),
    }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;

      // 1. Get plan pricing from config
      const planConfig = config.stripe.plans[input.plan];
      const priceCents = input.interval === 'month'
        ? planConfig.monthlyPriceCents
        : planConfig.yearlyPriceCents;

      // 2. Look up user's stripe_customer_id
      const userResult = await db.query<{
        stripe_customer_id: string | null;
        email: string;
        full_name: string;
      }>(
        'SELECT stripe_customer_id, email, full_name FROM users WHERE id = $1',
        [userId]
      );

      if (userResult.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }

      let stripeCustomerId = userResult.rows[0].stripe_customer_id;
      let clientSecret: string | null = null;
      let stripeSubscriptionId: string | null = null;

      if (config.stripe.secretKey && !config.stripe.secretKey.includes('placeholder')) {
        const stripe = new Stripe(config.stripe.secretKey, { apiVersion: '2025-12-15.clover' });

        // 3. Create Stripe customer if needed
        if (!stripeCustomerId) {
          const customer = await stripe.customers.create({
            email: userResult.rows[0].email,
            name: userResult.rows[0].full_name,
            metadata: { user_id: userId },
          });
          stripeCustomerId = customer.id;

          await db.query(
            'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
            [stripeCustomerId, userId]
          );
        }

        // 4. Create Stripe Product for subscription
        const product = await stripe.products.create({
          name: `HustleXP ${input.plan.charAt(0).toUpperCase() + input.plan.slice(1)} Plan`,
          metadata: { type: 'subscription', plan: input.plan },
        });

        // 5. Create Stripe Subscription
        const subscription = await stripe.subscriptions.create({
          customer: stripeCustomerId,
          items: [{
            price_data: {
              currency: 'usd',
              product: product.id,
              unit_amount: priceCents,
              recurring: { interval: input.interval },
            },
          }],
          payment_behavior: 'default_incomplete',
          payment_settings: {
            save_default_payment_method: 'on_subscription',
          },
          expand: ['latest_invoice.payment_intent'],
          metadata: {
            user_id: userId,
            type: 'subscription',
            plan: input.plan,
            interval: input.interval,
          },
        });

        stripeSubscriptionId = subscription.id;

        // Extract clientSecret from the expanded latest_invoice
        // The expand: ['latest_invoice.payment_intent'] inlines payment_intent on the invoice
        const latestInvoice = subscription.latest_invoice as Stripe.Invoice & {
          payment_intent?: Stripe.PaymentIntent;
        };
        const paymentIntent = latestInvoice?.payment_intent as Stripe.PaymentIntent | undefined;
        clientSecret = paymentIntent?.client_secret ?? null;
      }

      // 5. Update user record with subscription info
      const recurringTaskLimit = RECURRING_TASK_LIMITS[input.plan] ?? 0;
      await db.query(
        `UPDATE users
         SET plan = $1,
             stripe_subscription_id = $2,
             plan_subscribed_at = NOW(),
             recurring_task_limit = $3
         WHERE id = $4`,
        [input.plan, stripeSubscriptionId, recurringTaskLimit, userId]
      );

      // NOTE: Revenue is NOT logged here because payment_behavior is
      // 'default_incomplete' — the subscription hasn't been paid yet.
      // Revenue is logged in confirmSubscription after the payment succeeds.

      return {
        success: true,
        plan: input.plan,
        clientSecret,
        subscriptionId: stripeSubscriptionId,
        recurringTaskLimit,
      };
    }),

  /**
   * Cancel subscription: cancels in Stripe and downgrades to free plan.
   */
  cancel: protectedProcedure
    .mutation(async ({ ctx }) => {
      const userId = ctx.user.id;

      // 1. Look up stripe_subscription_id
      const userResult = await db.query<{ stripe_subscription_id: string | null }>(
        'SELECT stripe_subscription_id FROM users WHERE id = $1',
        [userId]
      );

      if (userResult.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }

      const stripeSubId = userResult.rows[0].stripe_subscription_id;

      // 2. Cancel Stripe subscription
      if (stripeSubId && config.stripe.secretKey && !config.stripe.secretKey.includes('placeholder')) {
        const stripe = new Stripe(config.stripe.secretKey, { apiVersion: '2025-12-15.clover' });
        try {
          await stripe.subscriptions.cancel(stripeSubId);
        } catch (err) {
          console.error('[Subscription] Failed to cancel Stripe subscription:', err);
          // Continue with local downgrade even if Stripe cancel fails
        }
      }

      // 3. Downgrade user to free plan
      await db.query(
        `UPDATE users
         SET plan = 'free',
             stripe_subscription_id = NULL,
             plan_expires_at = NOW(),
             recurring_task_limit = 0
         WHERE id = $1`,
        [userId]
      );

      // 4. Pause all active recurring task series for this user
      const pauseResult = await db.query(
        `UPDATE recurring_task_series
         SET status = 'paused',
             updated_at = NOW()
         WHERE poster_id = $1
           AND status = 'active'
         RETURNING id`,
        [userId]
      );

      // 5. Cancel all scheduled (not yet posted) occurrences
      if (pauseResult.rowCount && pauseResult.rowCount > 0) {
        const seriesIds = pauseResult.rows.map((r: { id: string }) => r.id);
        await db.query(
          `UPDATE recurring_task_occurrences
           SET status = 'cancelled'
           WHERE series_id = ANY($1::uuid[])
             AND status = 'scheduled'`,
          [seriesIds]
        );
      }

      return { success: true, plan: 'free', recurringTaskLimit: 0, pausedSeriesCount: pauseResult.rowCount || 0 };
    }),

  /**
   * Confirm subscription: verifies the Stripe subscription is active
   * and updates user plan + expiration date.
   */
  confirmSubscription: protectedProcedure
    .input(z.object({ stripeSubscriptionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;

      if (config.stripe.secretKey && !config.stripe.secretKey.includes('placeholder')) {
        const stripe = new Stripe(config.stripe.secretKey, { apiVersion: '2025-12-15.clover' });
        const subscription = await stripe.subscriptions.retrieve(input.stripeSubscriptionId);

        if (subscription.status !== 'active' && subscription.status !== 'trialing') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Subscription not active. Current status: ${subscription.status}`,
          });
        }

        // Extract plan from metadata
        const plan = subscription.metadata.plan || 'premium';
        const recurringTaskLimit = RECURRING_TASK_LIMITS[plan] ?? 0;

        // Update user with confirmed subscription details
        // In newer Stripe API, current_period_end is on SubscriptionItem, not Subscription
        const periodEnd = new Date(subscription.items.data[0].current_period_end * 1000);
        await db.query(
          `UPDATE users
           SET plan = $1,
               stripe_subscription_id = $2,
               plan_expires_at = $3,
               recurring_task_limit = $4
           WHERE id = $5`,
          [plan, input.stripeSubscriptionId, periodEnd, recurringTaskLimit, userId]
        );

        // Log revenue event now that subscription is confirmed active/paid.
        // This was intentionally moved from the subscribe mutation because
        // payment_behavior: 'default_incomplete' means payment hasn't
        // happened at subscription creation time.
        const interval = subscription.metadata.interval || 'month';
        const planConfig = config.stripe.plans[plan as keyof typeof config.stripe.plans];
        const priceCents = planConfig
          ? (interval === 'year' ? planConfig.yearlyPriceCents : planConfig.monthlyPriceCents)
          : 0;

        if (priceCents > 0) {
          await RevenueService.logEvent({
            eventType: 'subscription',
            userId,
            amountCents: priceCents,
            currency: 'usd',
            grossAmountCents: priceCents,
            platformFeeCents: 0,
            netAmountCents: priceCents,
            feeBasisPoints: 0,
            stripeSubscriptionId: input.stripeSubscriptionId,
            metadata: { plan, interval },
          });
        }

        return {
          success: true,
          plan,
          expiresAt: periodEnd,
          recurringTaskLimit,
        };
      }

      // Fallback when Stripe is not configured (dev/test)
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Stripe is not configured',
      });
    }),
});
