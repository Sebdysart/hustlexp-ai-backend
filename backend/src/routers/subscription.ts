/**
 * Subscription Router v1.0.0
 *
 * Legacy subscription read and cancellation-recovery boundary.
 * Historical plan limits are reported as evidence but grant no recurrence
 * creation authority; controlled-v2 owns all new recurring work.
 *
 * Dormant Stripe create/confirm implementations remain below for audit and
 * migration evidence, but are not registered on the production router.
 *
 * @see config.ts §stripe.plans for pricing
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, posterProcedure } from '../trpc.js';
import { db, type QueryFn } from '../db.js';
import type Stripe from 'stripe';
import { config } from '../config.js';
import { RevenueService } from '../services/RevenueService.js';
import { logger } from '../logger.js';
import { getSharedStripe } from '../lib/stripe-client.js'; // AUDIT FIX M5
import { stripeBreaker } from '../middleware/circuit-breaker.js';
import {
  newPaymentCreationFailure,
  paymentCreationErrorCause,
} from '../services/NewPaymentCreationGuard.js';

const log = logger.child({ router: 'subscription' });

// ============================================================================
// CONSTANTS
// ============================================================================

const RECURRING_TASK_LIMITS: Record<string, number> = {
  free: 0,
  premium: 5,
  pro: 999999, // effectively unlimited
};

type LocalCancellationResult = {
  success: true;
  plan: 'free';
  recurringTaskLimit: 0;
  pausedSeriesCount: number;
};

type CancellationPreparation =
  | { kind: 'LOCAL_COMPLETE'; result: LocalCancellationResult }
  | { kind: 'PROVIDER_REQUIRED'; externalSubscriptionId: string; operationId: string };

type CancellationAttempt =
  | { kind: 'COMPLETE'; result: LocalCancellationResult }
  | {
      kind: 'RETRY_REQUIRED';
      code: 'PRECONDITION_FAILED' | 'INTERNAL_SERVER_ERROR';
      message: string;
    };

type CancellationEventRow = {
  operation_id: string;
  status:
    | 'CANCELLATION_PENDING'
    | 'PROVIDER_FAILED'
    | 'CANCELLATION_UNCERTAIN'
    | 'CANCELLED_CONFIRMED';
};

const CANCELLATION_PENDING_MESSAGE = 'Subscription cancellation is pending provider recovery';

async function lockSubscriptionCancellation(query: QueryFn, userId: string): Promise<void> {
  // The transaction-scoped advisory lock closes the gap between the durable
  // operation row and Stripe, whose subscription cancellation endpoint has no
  // idempotency-key support. A user row lock additionally excludes local plan
  // writers that correctly lock the user record.
  await query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended('subscription-cancellation:' || $1::TEXT, 0)
     )`,
    [userId]
  );
}

async function finalizeLocalCancellation(
  query: QueryFn,
  userId: string,
  expectedExternalSubscriptionId: string | null
): Promise<LocalCancellationResult> {
  const downgrade = await query<{ id: string }>(
    `UPDATE users
     SET plan = 'free',
         stripe_subscription_id = NULL,
         plan_expires_at = NOW(),
         recurring_task_limit = 0
     WHERE id = $1
       AND stripe_subscription_id IS NOT DISTINCT FROM $2
     RETURNING id`,
    [userId, expectedExternalSubscriptionId]
  );

  if (downgrade.rowCount !== 1) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Subscription reference changed while cancellation was being reconciled',
    });
  }

  const pauseResult = await query<{ id: string }>(
    `UPDATE recurring_task_series
     SET status = 'paused',
         updated_at = NOW()
     WHERE poster_id = $1
       AND status = 'active'
     RETURNING id`,
    [userId]
  );
  const pausedSeriesCount = pauseResult.rowCount ?? 0;

  if (pausedSeriesCount > 0) {
    await query(
      `UPDATE recurring_task_occurrences
       SET status = 'cancelled'
       WHERE series_id = ANY($1::uuid[])
         AND status = 'scheduled'`,
      [pauseResult.rows.map((row) => row.id)]
    );
  }

  return {
    success: true,
    plan: 'free',
    recurringTaskLimit: 0,
    pausedSeriesCount,
  };
}

async function latestCancellationEvent(
  query: QueryFn,
  userId: string,
  externalSubscriptionId: string
): Promise<CancellationEventRow | undefined> {
  const result = await query<CancellationEventRow>(
    `SELECT operation_id, status
     FROM subscription_cancellation_events_v1
     WHERE user_id = $1
       AND provider_kind = 'stripe'
       AND external_subscription_id = $2
     ORDER BY event_sequence DESC
     LIMIT 1`,
    [userId, externalSubscriptionId]
  );
  return result.rows[0];
}

async function recordCancellationFailure(
  query: QueryFn,
  operationId: string,
  userId: string,
  externalSubscriptionId: string,
  errorCode: string
): Promise<void> {
  await query(
    `INSERT INTO subscription_cancellation_events_v1
     (operation_id, user_id, provider_kind, external_subscription_id, status, error_code)
     VALUES ($1, $2, 'stripe', $3, 'PROVIDER_FAILED', $4)`,
    [operationId, userId, externalSubscriptionId, errorCode]
  );
}

async function recordCancellationUncertain(
  query: QueryFn,
  operationId: string,
  userId: string,
  externalSubscriptionId: string,
  errorCode: string
): Promise<void> {
  await query(
    `INSERT INTO subscription_cancellation_events_v1
     (operation_id, user_id, provider_kind, external_subscription_id, status, error_code)
     VALUES ($1, $2, 'stripe', $3, 'CANCELLATION_UNCERTAIN', $4)`,
    [operationId, userId, externalSubscriptionId, errorCode]
  );
}

async function recordCancellationConfirmed(
  query: QueryFn,
  operationId: string,
  userId: string,
  externalSubscriptionId: string
): Promise<void> {
  await query(
    `INSERT INTO subscription_cancellation_events_v1
     (operation_id, user_id, provider_kind, external_subscription_id, status)
     VALUES ($1, $2, 'stripe', $3, 'CANCELLED_CONFIRMED')
     ON CONFLICT (operation_id) WHERE status = 'CANCELLED_CONFIRMED' DO NOTHING`,
    [operationId, userId, externalSubscriptionId]
  );
}

// ============================================================================
// ROUTER
// ============================================================================

// Legacy positive subscription writers remain available only as implementation
// evidence while the production money boundary is frozen. Production registers
// the explicit read/recovery allowlist below, never this complete procedure set.
export const legacySubscriptionProcedures = {
  /**
   * Get current subscription status including recurring task usage.
   */
  getMySubscription: posterProcedure.input(z.void()).query(async ({ ctx }) => {
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
      // Legacy subscription tiers are historical evidence, not authority to
      // create recurrence. Only the controlled-v2 lifecycle may authorize
      // new recurring work, independently of this read model.
      canCreateRecurringTask: false,
      recurringTaskCreationHeldReason: 'CONTROLLED_V2_AUTHORITY_REQUIRED' as const,
    };
  }),

  /**
   * Subscribe to a plan. Creates a Stripe Subscription and updates
   * the user's plan. Returns clientSecret for first payment.
   */
  subscribe: posterProcedure
    .input(
      z.object({
        plan: z.enum(['premium', 'pro']),
        interval: z.enum(['month', 'year']),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const frozen = newPaymentCreationFailure('subscription');
      if (frozen) {
        const cause = paymentCreationErrorCause(frozen.error.code);
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: frozen.error.message,
          ...(cause ? { cause } : {}),
        });
      }

      // 1. Get plan pricing from config
      const planConfig = config.stripe.plans[input.plan];
      const priceCents =
        input.interval === 'month' ? planConfig.monthlyPriceCents : planConfig.yearlyPriceCents;

      // 2. Look up user's stripe_customer_id
      const userResult = await db.query<{
        stripe_customer_id: string | null;
        email: string;
        full_name: string;
      }>('SELECT stripe_customer_id, email, full_name FROM users WHERE id = $1', [userId]);

      if (userResult.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }

      let stripeCustomerId = userResult.rows[0].stripe_customer_id;
      let clientSecret: string | null = null;
      let stripeSubscriptionId: string | null = null;

      // AUDIT FIX M5: shared client + breaker (was per-request `new Stripe`, no breaker)
      const stripe = getSharedStripe();
      if (stripe) {
        // 3. Create Stripe customer if needed
        if (!stripeCustomerId) {
          const customer = await stripeBreaker.execute(() =>
            stripe.customers.create({
              email: userResult.rows[0].email,
              name: userResult.rows[0].full_name,
              metadata: { user_id: userId },
            })
          );
          stripeCustomerId = customer.id;

          await db.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [
            stripeCustomerId,
            userId,
          ]);
        }

        // 4. Create Stripe Product for subscription
        const product = await stripeBreaker.execute(() =>
          stripe.products.create({
            name: `HustleXP ${input.plan.charAt(0).toUpperCase() + input.plan.slice(1)} Plan`,
            metadata: { type: 'subscription', plan: input.plan },
          })
        );

        // 5. Create Stripe Subscription
        // (const capture: the breaker closure defeats TS narrowing on the mutable let,
        // but stripeCustomerId is guaranteed non-null here — created above if missing)
        const resolvedCustomerId: string = stripeCustomerId;
        const subscription = await stripeBreaker.execute(() =>
          stripe.subscriptions.create({
            customer: resolvedCustomerId,
            items: [
              {
                price_data: {
                  currency: 'usd',
                  product: product.id,
                  unit_amount: priceCents,
                  recurring: { interval: input.interval },
                },
              },
            ],
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
          })
        );

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
   * Cancellation recovery retains the provider reference until Stripe has
   * confirmed cancellation. Missing/failed provider access is retryable and
   * cannot orphan a still-billing subscription.
   */
  cancel: posterProcedure.input(z.void()).mutation(async ({ ctx }) => {
    const userId = ctx.user.id;

    // Phase 1 commits the recovery identity before any provider call. If the
    // process dies after Stripe succeeds, this durable PENDING event gives a
    // retry the exact operation and provider reference to reconcile.
    const preparation = await db.transaction<CancellationPreparation>(async (query) => {
      await lockSubscriptionCancellation(query, userId);
      const userResult = await query<{ stripe_subscription_id: string | null }>(
        `SELECT stripe_subscription_id
           FROM users
           WHERE id = $1
           FOR UPDATE`,
        [userId]
      );

      if (userResult.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }

      const externalSubscriptionId = userResult.rows[0].stripe_subscription_id;
      if (!externalSubscriptionId) {
        return {
          kind: 'LOCAL_COMPLETE',
          result: await finalizeLocalCancellation(query, userId, null),
        };
      }

      const prior = await latestCancellationEvent(query, userId, externalSubscriptionId);
      if (prior) {
        return {
          kind: 'PROVIDER_REQUIRED',
          externalSubscriptionId,
          operationId: prior.operation_id,
        };
      }

      const pending = await query<{ operation_id: string }>(
        `INSERT INTO subscription_cancellation_events_v1
             (operation_id, user_id, provider_kind, external_subscription_id, status)
           VALUES (gen_random_uuid(), $1, 'stripe', $2, 'CANCELLATION_PENDING')
           RETURNING operation_id`,
        [userId, externalSubscriptionId]
      );
      const operationId = pending.rows[0]?.operation_id;
      if (!operationId) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Subscription cancellation recovery evidence was not recorded',
        });
      }
      return { kind: 'PROVIDER_REQUIRED', externalSubscriptionId, operationId };
    });

    if (preparation.kind === 'LOCAL_COMPLETE') {
      return preparation.result;
    }

    // Phase 2 serializes all callers while provider state is retrieved and,
    // only if still necessary, canceled. Retrieval always precedes the
    // non-idempotent Stripe write and recovers a prior write whose response or
    // following database commit was lost.
    const attempt = await db.transaction<CancellationAttempt>(async (query) => {
      await lockSubscriptionCancellation(query, userId);
      const userResult = await query<{ stripe_subscription_id: string | null }>(
        `SELECT stripe_subscription_id
           FROM users
           WHERE id = $1
           FOR UPDATE`,
        [userId]
      );
      if (userResult.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }

      const currentExternalSubscriptionId = userResult.rows[0].stripe_subscription_id;
      if (!currentExternalSubscriptionId) {
        return {
          kind: 'COMPLETE',
          result: await finalizeLocalCancellation(query, userId, null),
        };
      }
      if (currentExternalSubscriptionId !== preparation.externalSubscriptionId) {
        return {
          kind: 'RETRY_REQUIRED',
          code: 'PRECONDITION_FAILED',
          message: 'Subscription reference changed while cancellation was being reconciled',
        };
      }

      const latest = await latestCancellationEvent(query, userId, currentExternalSubscriptionId);
      if (!latest || latest.operation_id !== preparation.operationId) {
        return {
          kind: 'RETRY_REQUIRED',
          code: 'INTERNAL_SERVER_ERROR',
          message: CANCELLATION_PENDING_MESSAGE,
        };
      }

      if (latest.status === 'CANCELLED_CONFIRMED') {
        return {
          kind: 'COMPLETE',
          result: await finalizeLocalCancellation(query, userId, currentExternalSubscriptionId),
        };
      }

      // Once a non-idempotent provider write has an ambiguous outcome, this
      // operation becomes reconciliation-only. A later read that still says
      // "active" may be stale and therefore cannot authorize another cancel.
      const reconciliationOnly = latest.status === 'CANCELLATION_UNCERTAIN';

      const cancelStripe = getSharedStripe();
      if (!cancelStripe) {
        if (reconciliationOnly) {
          await recordCancellationUncertain(
            query,
            preparation.operationId,
            userId,
            currentExternalSubscriptionId,
            'STRIPE_RECONCILIATION_CLIENT_UNAVAILABLE'
          );
        } else {
          await recordCancellationFailure(
            query,
            preparation.operationId,
            userId,
            currentExternalSubscriptionId,
            'STRIPE_CLIENT_UNAVAILABLE'
          );
        }
        return {
          kind: 'RETRY_REQUIRED',
          code: 'PRECONDITION_FAILED',
          message: CANCELLATION_PENDING_MESSAGE,
        };
      }

      let providerStatus: string;
      try {
        const providerSubscription = await stripeBreaker.execute(() =>
          cancelStripe.subscriptions.retrieve(currentExternalSubscriptionId)
        );
        providerStatus = providerSubscription.status;
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          'Failed to retrieve Stripe subscription during cancellation recovery'
        );
        if (reconciliationOnly) {
          await recordCancellationUncertain(
            query,
            preparation.operationId,
            userId,
            currentExternalSubscriptionId,
            'STRIPE_RECONCILIATION_FAILED'
          );
        } else {
          await recordCancellationFailure(
            query,
            preparation.operationId,
            userId,
            currentExternalSubscriptionId,
            'STRIPE_RETRIEVAL_FAILED'
          );
        }
        return {
          kind: 'RETRY_REQUIRED',
          code: 'INTERNAL_SERVER_ERROR',
          message: CANCELLATION_PENDING_MESSAGE,
        };
      }

      if (reconciliationOnly && providerStatus !== 'canceled') {
        await recordCancellationUncertain(
          query,
          preparation.operationId,
          userId,
          currentExternalSubscriptionId,
          'STRIPE_CANCELLATION_AWAITING_CONFIRMATION'
        );
        return {
          kind: 'RETRY_REQUIRED',
          code: 'INTERNAL_SERVER_ERROR',
          message: CANCELLATION_PENDING_MESSAGE,
        };
      }

      if (providerStatus !== 'canceled') {
        try {
          const cancelled = await stripeBreaker.execute(() =>
            cancelStripe.subscriptions.cancel(currentExternalSubscriptionId)
          );
          providerStatus = cancelled.status;
        } catch (err) {
          log.error(
            { err: err instanceof Error ? err.message : String(err) },
            'Stripe cancellation returned an uncertain outcome; reconciling by retrieval'
          );
          try {
            const reconciled = await stripeBreaker.execute(() =>
              cancelStripe.subscriptions.retrieve(currentExternalSubscriptionId)
            );
            providerStatus = reconciled.status;
          } catch (reconcileError) {
            log.error(
              {
                err:
                  reconcileError instanceof Error ? reconcileError.message : String(reconcileError),
              },
              'Failed to reconcile uncertain Stripe subscription cancellation'
            );
            await recordCancellationUncertain(
              query,
              preparation.operationId,
              userId,
              currentExternalSubscriptionId,
              'STRIPE_CANCELLATION_UNCERTAIN'
            );
            return {
              kind: 'RETRY_REQUIRED',
              code: 'INTERNAL_SERVER_ERROR',
              message: CANCELLATION_PENDING_MESSAGE,
            };
          }
        }
      }

      if (providerStatus !== 'canceled') {
        await recordCancellationUncertain(
          query,
          preparation.operationId,
          userId,
          currentExternalSubscriptionId,
          'STRIPE_CANCELLATION_UNCONFIRMED'
        );
        return {
          kind: 'RETRY_REQUIRED',
          code: 'INTERNAL_SERVER_ERROR',
          message: CANCELLATION_PENDING_MESSAGE,
        };
      }

      await recordCancellationConfirmed(
        query,
        preparation.operationId,
        userId,
        currentExternalSubscriptionId
      );
      return {
        kind: 'COMPLETE',
        result: await finalizeLocalCancellation(query, userId, currentExternalSubscriptionId),
      };
    });

    if (attempt.kind === 'RETRY_REQUIRED') {
      throw new TRPCError({ code: attempt.code, message: attempt.message });
    }
    return attempt.result;
  }),

  /**
   * Confirm subscription: verifies the Stripe subscription is active
   * and updates user plan + expiration date.
   */
  confirmSubscription: posterProcedure
    .input(z.object({ stripeSubscriptionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const frozen = newPaymentCreationFailure('subscription');
      if (frozen) {
        const cause = paymentCreationErrorCause(frozen.error.code);
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: frozen.error.message,
          ...(cause ? { cause } : {}),
        });
      }

      // AUDIT FIX M5: shared client + breaker
      const stripe = getSharedStripe();
      if (stripe) {
        // Fetch user's stripe_customer_id for ownership verification
        const userResult = await db.query<{ stripe_customer_id: string | null }>(
          'SELECT stripe_customer_id FROM users WHERE id = $1',
          [userId]
        );

        const subscription = await stripeBreaker.execute(() =>
          stripe.subscriptions.retrieve(input.stripeSubscriptionId)
        );

        // Verify the subscription belongs to the calling user via metadata and customer
        if (subscription.metadata.user_id !== userId) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Subscription does not belong to this user',
          });
        }

        const userStripeCustomerId = userResult.rows[0]?.stripe_customer_id;
        const subscriptionCustomerId =
          typeof subscription.customer === 'string'
            ? subscription.customer
            : subscription.customer?.id;

        if (
          userStripeCustomerId &&
          subscriptionCustomerId &&
          subscriptionCustomerId !== userStripeCustomerId
        ) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Subscription customer does not match this user',
          });
        }

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
          ? interval === 'year'
            ? planConfig.yearlyPriceCents
            : planConfig.monthlyPriceCents
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
};

export const subscriptionRouter = router({
  getMySubscription: legacySubscriptionProcedures.getMySubscription,
  cancel: legacySubscriptionProcedures.cancel,
});
