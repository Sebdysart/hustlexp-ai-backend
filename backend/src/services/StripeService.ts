import Stripe from 'stripe';
import { config } from '../config.js';
import { db } from '../db.js';
import type { ServiceResult } from '../types.js';
import { stripeBreaker } from '../middleware/circuit-breaker.js';
import { stripeLogger } from '../logger.js';

let stripe: Stripe | null = null;

if (config.stripe.secretKey && !config.stripe.secretKey.includes('placeholder')) {
  stripe = new Stripe(config.stripe.secretKey, {
    apiVersion: '2025-11-17.clover',
  });
  stripeLogger.info('Stripe initialized');
} else {
  stripeLogger.warn('Stripe not configured (placeholder or missing key)');
}

interface CreatePaymentIntentParams {
  taskId: string;
  posterId: string;
  amount: number;
  description?: string;
}

interface CreatePaymentIntentResult {
  paymentIntentId: string;
  clientSecret: string;
  amount: number;
}

interface CreateTransferParams {
  escrowId: string;
  taskId: string;
  workerId: string;
  workerStripeAccountId: string;
  amount: number;
  description?: string;
}

interface CreateTransferResult {
  transferId: string;
  amount: number;
}

interface CreateRefundParams {
  paymentIntentId: string;
  escrowId: string;
  amount?: number;
  reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
}

interface CreateRefundResult {
  refundId: string;
  amount: number;
  status: string;
}

interface WebhookEvent {
  type: string;
  data: {
    object: Stripe.PaymentIntent | Stripe.Transfer | Stripe.Refund;
  };
}

async function isEventProcessed(eventId: string): Promise<boolean> {
  const result = await db.query(
    'SELECT id FROM processed_stripe_events WHERE event_id = $1',
    [eventId]
  );
  return result.rows.length > 0;
}

async function markEventProcessed(
  eventId: string,
  eventType: string,
  objectId: string
): Promise<void> {
  await db.query(
    `INSERT INTO processed_stripe_events (event_id, event_type, object_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (event_id) DO NOTHING`,
    [eventId, eventType, objectId]
  );
}

export const StripeService = {
  isConfigured: (): boolean => stripe !== null,

  createPaymentIntent: async (
    params: CreatePaymentIntentParams
  ): Promise<ServiceResult<CreatePaymentIntentResult>> => {
    if (!stripe) {
      return {
        success: false,
        error: {
          code: 'STRIPE_NOT_CONFIGURED',
          message: 'Stripe is not configured',
        },
      };
    }

    const { taskId, posterId, amount, description } = params;

    if (amount < config.stripe.minimumTaskValueCents) {
      return {
        success: false,
        error: {
          code: 'INVALID_AMOUNT',
          message: `Task value must be at least $${config.stripe.minimumTaskValueCents / 100}.00 (${config.stripe.minimumTaskValueCents} cents)`,
        },
      };
    }

    try {
      const platformFee = Math.floor(amount * (config.stripe.platformFeePercent / 100));

      const paymentIntent = await stripeBreaker.execute(() => stripe!.paymentIntents.create(
        {
          amount,
          currency: 'usd',
          automatic_payment_methods: { enabled: true },
          metadata: {
            task_id: taskId,
            poster_id: posterId,
            platform_fee: platformFee.toString(),
          },
          description: description || `HustleXP Task ${taskId}`,
        },
        { idempotencyKey: `pi_create_${taskId}` }
      ));

      return {
        success: true,
        data: {
          paymentIntentId: paymentIntent.id,
          clientSecret: paymentIntent.client_secret!,
          amount,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'STRIPE_ERROR',
          message: error instanceof Error ? error.message : 'Unknown Stripe error',
        },
      };
    }
  },

  createTaxPaymentIntent: async (
    userId: string,
    amountCents: number,
  ): Promise<ServiceResult<CreatePaymentIntentResult>> => {
    if (!stripe) {
      return {
        success: false,
        error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' },
      };
    }

    if (amountCents < 50) {
      return {
        success: false,
        error: { code: 'INVALID_AMOUNT', message: 'Tax amount must be at least $0.50' },
      };
    }

    try {
      const paymentIntent = await stripeBreaker.execute(() => stripe!.paymentIntents.create({
        amount: amountCents,
        currency: 'usd',
        automatic_payment_methods: { enabled: true },
        metadata: {
          type: 'xp_tax',
          user_id: userId,
        },
        description: `HustleXP XP Tax Payment`,
      }));

      return {
        success: true,
        data: {
          paymentIntentId: paymentIntent.id,
          clientSecret: paymentIntent.client_secret!,
          amount: amountCents,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'STRIPE_ERROR',
          message: error instanceof Error ? error.message : 'Unknown Stripe error',
        },
      };
    }
  },

  verifyPaymentIntent: async (
    paymentIntentId: string,
  ): Promise<ServiceResult<{ status: string; amountCents: number; metadata: Record<string, string> }>> => {
    if (!stripe) {
      return {
        success: false,
        error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' },
      };
    }

    try {
      const pi = await stripeBreaker.execute(() => stripe!.paymentIntents.retrieve(paymentIntentId));
      return {
        success: true,
        data: {
          status: pi.status,
          amountCents: pi.amount,
          metadata: (pi.metadata || {}) as Record<string, string>,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'STRIPE_ERROR',
          message: error instanceof Error ? error.message : 'Unknown Stripe error',
        },
      };
    }
  },

  // STOP-005 FIX: Added idempotencyKey to transfers.create() to prevent double-payout
  // on retry/duplicate webhook delivery. Key format: tr_<escrowId> ensures one
  // transfer per escrow regardless of how many times the release flow is invoked.
  createTransfer: async (
    params: CreateTransferParams
  ): Promise<ServiceResult<CreateTransferResult>> => {
    const { escrowId, workerId, workerStripeAccountId, amount, description } = params;

    // STOP-009 FIX: Block HX_STRIPE_STUB in production. The stub returns fake
    // transfer IDs without touching Stripe, which would silently skip real payouts.
    if (process.env.HX_STRIPE_STUB === '1') {
      if (config.app.isProduction) {
        stripeLogger.error('FATAL: HX_STRIPE_STUB=1 is set in production — refusing to create stub transfer');
        return {
          success: false,
          error: {
            code: 'STRIPE_STUB_IN_PRODUCTION',
            message: 'HX_STRIPE_STUB is not allowed in production',
          },
        };
      }
      const crypto = await import('crypto');
      return {
        success: true,
        data: {
          transferId: `tr_test_${crypto.randomUUID().slice(0, 8)}`,
          amount,
        },
      };
    }

    if (!stripe) {
      return {
        success: false,
        error: {
          code: 'STRIPE_NOT_CONFIGURED',
          message: 'Stripe is not configured',
        },
      };
    }

    try {
      const transfer = await stripeBreaker.execute(() => stripe!.transfers.create(
        {
          amount,
          currency: 'usd',
          destination: workerStripeAccountId,
          metadata: {
            escrow_id: escrowId,
            worker_id: workerId,
          },
          description: description || `HustleXP Payout ${escrowId}`,
        },
        { idempotencyKey: `tr_${escrowId}` }
      ));

      return {
        success: true,
        data: {
          transferId: transfer.id,
          amount: transfer.amount,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'STRIPE_ERROR',
          message: error instanceof Error ? error.message : 'Unknown Stripe error',
        },
      };
    }
  },

  // STOP-005 FIX: Added idempotencyKey to refunds.create() to prevent double-refund.
  // Key format: re_<escrowId> ensures one refund per escrow.
  createRefund: async (
    params: CreateRefundParams
  ): Promise<ServiceResult<CreateRefundResult>> => {
    const { paymentIntentId, escrowId, amount, reason } = params;

    // STOP-009 FIX: Block HX_STRIPE_STUB in production.
    if (process.env.HX_STRIPE_STUB === '1') {
      if (config.app.isProduction) {
        stripeLogger.error('FATAL: HX_STRIPE_STUB=1 is set in production — refusing to create stub refund');
        return {
          success: false,
          error: {
            code: 'STRIPE_STUB_IN_PRODUCTION',
            message: 'HX_STRIPE_STUB is not allowed in production',
          },
        };
      }
      const crypto = await import('crypto');
      return {
        success: true,
        data: {
          refundId: `re_test_${crypto.randomUUID().slice(0, 8)}`,
          amount: amount || 0,
          status: 'succeeded',
        },
      };
    }

    if (!stripe) {
      return {
        success: false,
        error: {
          code: 'STRIPE_NOT_CONFIGURED',
          message: 'Stripe is not configured',
        },
      };
    }

    try {
      const refund = await stripeBreaker.execute(() => stripe!.refunds.create(
        {
          payment_intent: paymentIntentId,
          amount,
          reason,
          metadata: {
            escrow_id: escrowId,
            payment_intent_id: paymentIntentId,
          },
        },
        { idempotencyKey: `re_${escrowId}` }
      ));

      return {
        success: true,
        data: {
          refundId: refund.id,
          amount: refund.amount,
          status: refund.status ?? '',
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'STRIPE_ERROR',
          message: error instanceof Error ? error.message : 'Unknown Stripe error',
        },
      };
    }
  },

  verifyWebhook: (
    payload: string | Buffer,
    signature: string
  ): ServiceResult<WebhookEvent> => {
    if (!stripe) {
      return {
        success: false,
        error: {
          code: 'STRIPE_NOT_CONFIGURED',
          message: 'Stripe is not configured',
        },
      };
    }

    if (!config.stripe.webhookSecret) {
      return {
        success: false,
        error: {
          code: 'WEBHOOK_SECRET_MISSING',
          message: 'Stripe webhook secret not configured',
        },
      };
    }

    try {
      const event = stripe.webhooks.constructEvent(
        payload,
        signature,
        config.stripe.webhookSecret
      );

      return {
        success: true,
        data: event as unknown as WebhookEvent,
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'WEBHOOK_VERIFICATION_FAILED',
          message: error instanceof Error ? error.message : 'Invalid webhook signature',
        },
      };
    }
  },

  // STOP-008 FIX: Replaced check-then-insert with atomic INSERT ON CONFLICT.
  // The old pattern had a TOCTOU race: two concurrent webhook deliveries could
  // both pass the isEventProcessed check (both see 0 rows), then both execute
  // the handler. Now the INSERT is atomic — the second call hits ON CONFLICT
  // DO NOTHING and rowCount=0 signals "already processed".
  processWebhookEvent: async (
    eventId: string,
    eventType: string,
    objectId: string,
    handler: () => Promise<void>
  ): Promise<ServiceResult<void>> => {
    try {
      const claim = await db.query(
        `INSERT INTO processed_stripe_events (event_id, event_type, object_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (event_id) DO NOTHING`,
        [eventId, eventType, objectId]
      );

      if (claim.rowCount === 0) {
        return { success: true, data: undefined };
      }

      await handler();
      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'WEBHOOK_PROCESSING_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
};

export default StripeService;
