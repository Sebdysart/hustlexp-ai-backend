import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, posterProcedure } from '../trpc.js';
import { db } from '../db.js';
import Stripe from 'stripe';
import { config } from '../config.js';
import { RevenueService } from '../services/RevenueService.js';
import { logger } from '../logger.js';

const log = logger.child({ router: 'subscription' });

const RECURRING_TASK_LIMITS: Record<string, number> = {
  free: 0,
  premium: 5,
  pro: 999999,
};

export const subscriptionRouter = router({
  getMySubscription: posterProcedure
    .input(z.void())
    .query(async ({ ctx }) => {
      const userId = ctx.user.id;
      const userResult = await db.query<{
        plan: string;
        plan_expires_at: Date | null;
        stripe_subscription_id: string | null;
      }>(
        'SELECT plan, plan_expires_at, stripe_subscription_id FROM users WHERE id = $1',
        [userId]
      );
      if (userResult.rows.length === 0) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });

      const user = userResult.rows[0];
      const plan = user.plan || 'free';
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

  // EXPLOIT FIX (C1): subscribe no longer sets plan='premium' immediately.
  // The plan stays 'free' until confirmSubscription verifies the payment
  // succeeded. Previously a user could call subscribe, get upgraded to
  // premium, and never complete the payment.
  subscribe: posterProcedure
    .input(z.object({
      plan: z.enum(['premium', 'pro']),
      interval: z.enum(['month', 'year']),
    }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const planConfig = config.stripe.plans[input.plan];
      const priceCents = input.interval === 'month'
        ? planConfig.monthlyPriceCents
        : planConfig.yearlyPriceCents;

      const userResult = await db.query<{
        stripe_customer_id: string | null;
        email: string;
        full_name: string;
      }>('SELECT stripe_customer_id, email, full_name FROM users WHERE id = $1', [userId]);
      if (userResult.rows.length === 0) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });

      let stripeCustomerId = userResult.rows[0].stripe_customer_id;
      let clientSecret: string | null = null;
      let stripeSubscriptionId: string | null = null;

      if (config.stripe.secretKey && !config.stripe.secretKey.includes('placeholder')) {
        const stripe = new Stripe(config.stripe.secretKey, { apiVersion: '2025-11-17.clover' });

        if (!stripeCustomerId) {
          const customer = await stripe.customers.create({
            email: userResult.rows[0].email,
            name: userResult.rows[0].full_name,
            metadata: { user_id: userId },
          });
          stripeCustomerId = customer.id;
          await db.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [stripeCustomerId, userId]);
        }

        const product = await stripe.products.create({
          name: `HustleXP ${input.plan.charAt(0).toUpperCase() + input.plan.slice(1)} Plan`,
          metadata: { type: 'subscription', plan: input.plan },
        });

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
          payment_settings: { save_default_payment_method: 'on_subscription' },
          expand: ['latest_invoice.payment_intent'],
          metadata: { user_id: userId, type: 'subscription', plan: input.plan, interval: input.interval },
        });

        stripeSubscriptionId = subscription.id;
        const latestInvoice = subscription.latest_invoice as Stripe.Invoice & { payment_intent?: Stripe.PaymentIntent };
        clientSecret = (latestInvoice?.payment_intent as Stripe.PaymentIntent | undefined)?.client_secret ?? null;
      }

      // Only store the subscription ID — do NOT upgrade the plan yet.
      // Plan upgrade happens in confirmSubscription after payment succeeds.
      await db.query(
        'UPDATE users SET stripe_subscription_id = $1, plan_subscribed_at = NOW() WHERE id = $2',
        [stripeSubscriptionId, userId]
      );

      return {
        success: true,
        plan: input.plan,
        clientSecret,
        subscriptionId: stripeSubscriptionId,
        recurringTaskLimit: RECURRING_TASK_LIMITS[input.plan] ?? 0,
      };
    }),

  cancel: posterProcedure
    .input(z.void())
    .mutation(async ({ ctx }) => {
      const userId = ctx.user.id;
      const userResult = await db.query<{ stripe_subscription_id: string | null }>(
        'SELECT stripe_subscription_id FROM users WHERE id = $1', [userId]
      );
      if (userResult.rows.length === 0) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });

      const stripeSubId = userResult.rows[0].stripe_subscription_id;
      if (stripeSubId && config.stripe.secretKey && !config.stripe.secretKey.includes('placeholder')) {
        const stripe = new Stripe(config.stripe.secretKey, { apiVersion: '2025-11-17.clover' });
        try { await stripe.subscriptions.cancel(stripeSubId); } catch (err) {
          log.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to cancel Stripe subscription');
        }
      }

      await db.query(
        `UPDATE users SET plan = 'free', stripe_subscription_id = NULL, plan_expires_at = NOW(), recurring_task_limit = 0 WHERE id = $1`,
        [userId]
      );

      const pauseResult = await db.query(
        `UPDATE recurring_task_series SET status = 'paused', updated_at = NOW() WHERE poster_id = $1 AND status = 'active' RETURNING id`,
        [userId]
      );
      if (pauseResult.rowCount && pauseResult.rowCount > 0) {
        const seriesIds = pauseResult.rows.map((r: Record<string, unknown>) => (r as { id: string }).id);
        await db.query(
          `UPDATE recurring_task_occurrences SET status = 'cancelled' WHERE series_id = ANY($1::uuid[]) AND status = 'scheduled'`,
          [seriesIds]
        );
      }

      return { success: true, plan: 'free', recurringTaskLimit: 0, pausedSeriesCount: pauseResult.rowCount || 0 };
    }),

  // EXPLOIT FIX (C4): confirmSubscription now verifies that the Stripe
  // subscription's customer matches the calling user's stripe_customer_id.
  // Previously any user could pass another user's subscription ID to
  // upgrade themselves without paying.
  confirmSubscription: posterProcedure
    .input(z.object({ stripeSubscriptionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;

      if (config.stripe.secretKey && !config.stripe.secretKey.includes('placeholder')) {
        const stripe = new Stripe(config.stripe.secretKey, { apiVersion: '2025-11-17.clover' });
        const subscription = await stripe.subscriptions.retrieve(input.stripeSubscriptionId);

        if (subscription.status !== 'active' && subscription.status !== 'trialing') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: `Subscription not active. Current status: ${subscription.status}` });
        }

        // Verify the subscription belongs to this user
        const userResult = await db.query<{ stripe_customer_id: string | null }>(
          'SELECT stripe_customer_id FROM users WHERE id = $1', [userId]
        );
        const userCustomerId = userResult.rows[0]?.stripe_customer_id;
        const subscriptionCustomerId = typeof subscription.customer === 'string'
          ? subscription.customer
          : subscription.customer?.id;

        if (!userCustomerId || userCustomerId !== subscriptionCustomerId) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'This subscription does not belong to your account' });
        }

        const plan = subscription.metadata.plan || 'premium';
        const recurringTaskLimit = RECURRING_TASK_LIMITS[plan] ?? 0;
        const periodEnd = new Date(subscription.items.data[0].current_period_end * 1000);

        await db.query(
          `UPDATE users SET plan = $1, stripe_subscription_id = $2, plan_expires_at = $3, recurring_task_limit = $4 WHERE id = $5`,
          [plan, input.stripeSubscriptionId, periodEnd, recurringTaskLimit, userId]
        );

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

        return { success: true, plan, expiresAt: periodEnd, recurringTaskLimit };
      }

      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Stripe is not configured' });
    }),
});
