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

export const StripeService = {
  isConfigured: (): boolean => stripe !== null,

  createPaymentIntent: async (
    params: CreatePaymentIntentParams
  ): Promise<ServiceResult<CreatePaymentIntentResult>> => {
    if (!stripe) {
      return { success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' } };
    }

    const { taskId, posterId, amount, description } = params;

    if (amount < config.stripe.minimumTaskValueCents) {
      return { success: false, error: { code: 'INVALID_AMOUNT', message: `Task value must be at least $${config.stripe.minimumTaskValueCents / 100}.00` } };
    }

    try {
      const platformFee = Math.floor(amount * (config.stripe.platformFeePercent / 100));
      const paymentIntent = await stripeBreaker.execute(() => stripe!.paymentIntents.create(
        {
          amount,
          currency: 'usd',
          automatic_payment_methods: { enabled: true },
          metadata: { task_id: taskId, poster_id: posterId, platform_fee: platformFee.toString() },
          description: description || `HustleXP Task ${taskId}`,
        },
        { idempotencyKey: `pi_create_${taskId}` }
      ));

      return { success: true, data: { paymentIntentId: paymentIntent.id, clientSecret: paymentIntent.client_secret!, amount } };
    } catch (error) {
      return { success: false, error: { code: 'STRIPE_ERROR', message: error instanceof Error ? error.message : 'Unknown Stripe error' } };
    }
  },

  // GAP-7 FIX: Added idempotencyKey to prevent duplicate tax payment intents on retry.
  createTaxPaymentIntent: async (
    userId: string,
    amountCents: number,
  ): Promise<ServiceResult<CreatePaymentIntentResult>> => {
    if (!stripe) {
      return { success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' } };
    }
    if (amountCents < 50) {
      return { success: false, error: { code: 'INVALID_AMOUNT', message: 'Tax amount must be at least $0.50' } };
    }

    try {
      const paymentIntent = await stripeBreaker.execute(() => stripe!.paymentIntents.create(
        {
          amount: amountCents,
          currency: 'usd',
          automatic_payment_methods: { enabled: true },
          metadata: { type: 'xp_tax', user_id: userId },
          description: 'HustleXP XP Tax Payment',
        },
        { idempotencyKey: `pi_tax_${userId}_${amountCents}` }
      ));

      return { success: true, data: { paymentIntentId: paymentIntent.id, clientSecret: paymentIntent.client_secret!, amount: amountCents } };
    } catch (error) {
      return { success: false, error: { code: 'STRIPE_ERROR', message: error instanceof Error ? error.message : 'Unknown Stripe error' } };
    }
  },

  verifyPaymentIntent: async (
    paymentIntentId: string,
  ): Promise<ServiceResult<{ status: string; amountCents: number; metadata: Record<string, string> }>> => {
    if (!stripe) {
      return { success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' } };
    }
    try {
      const pi = await stripeBreaker.execute(() => stripe!.paymentIntents.retrieve(paymentIntentId));
      return { success: true, data: { status: pi.status, amountCents: pi.amount, metadata: (pi.metadata || {}) as Record<string, string> } };
    } catch (error) {
      return { success: false, error: { code: 'STRIPE_ERROR', message: error instanceof Error ? error.message : 'Unknown Stripe error' } };
    }
  },

  createTransfer: async (
    params: CreateTransferParams
  ): Promise<ServiceResult<CreateTransferResult>> => {
    const { escrowId, workerId, workerStripeAccountId, amount, description } = params;

    if (process.env.HX_STRIPE_STUB === '1') {
      if (config.app.isProduction) {
        stripeLogger.error('FATAL: HX_STRIPE_STUB=1 is set in production');
        return { success: false, error: { code: 'STRIPE_STUB_IN_PRODUCTION', message: 'HX_STRIPE_STUB is not allowed in production' } };
      }
      const crypto = await import('crypto');
      return { success: true, data: { transferId: `tr_test_${crypto.randomUUID().slice(0, 8)}`, amount } };
    }

    if (!stripe) {
      return { success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' } };
    }

    try {
      const transfer = await stripeBreaker.execute(() => stripe!.transfers.create(
        {
          amount,
          currency: 'usd',
          destination: workerStripeAccountId,
          metadata: { escrow_id: escrowId, worker_id: workerId },
          description: description || `HustleXP Payout ${escrowId}`,
        },
        { idempotencyKey: `tr_${escrowId}` }
      ));
      return { success: true, data: { transferId: transfer.id, amount: transfer.amount } };
    } catch (error) {
      return { success: false, error: { code: 'STRIPE_ERROR', message: error instanceof Error ? error.message : 'Unknown Stripe error' } };
    }
  },

  createRefund: async (
    params: CreateRefundParams
  ): Promise<ServiceResult<CreateRefundResult>> => {
    const { paymentIntentId, escrowId, amount, reason } = params;

    if (process.env.HX_STRIPE_STUB === '1') {
      if (config.app.isProduction) {
        stripeLogger.error('FATAL: HX_STRIPE_STUB=1 is set in production');
        return { success: false, error: { code: 'STRIPE_STUB_IN_PRODUCTION', message: 'HX_STRIPE_STUB is not allowed in production' } };
      }
      const crypto = await import('crypto');
      return { success: true, data: { refundId: `re_test_${crypto.randomUUID().slice(0, 8)}`, amount: amount || 0, status: 'succeeded' } };
    }

    if (!stripe) {
      return { success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' } };
    }

    try {
      const refund = await stripeBreaker.execute(() => stripe!.refunds.create(
        {
          payment_intent: paymentIntentId,
          amount,
          reason,
          metadata: { escrow_id: escrowId, payment_intent_id: paymentIntentId },
        },
        { idempotencyKey: `re_${escrowId}` }
      ));
      return { success: true, data: { refundId: refund.id, amount: refund.amount, status: refund.status ?? '' } };
    } catch (error) {
      return { success: false, error: { code: 'STRIPE_ERROR', message: error instanceof Error ? error.message : 'Unknown Stripe error' } };
    }
  },

  verifyWebhook: (
    payload: string | Buffer,
    signature: string
  ): ServiceResult<WebhookEvent> => {
    if (!stripe) {
      return { success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' } };
    }
    if (!config.stripe.webhookSecret) {
      return { success: false, error: { code: 'WEBHOOK_SECRET_MISSING', message: 'Stripe webhook secret not configured' } };
    }
    try {
      const event = stripe.webhooks.constructEvent(payload, signature, config.stripe.webhookSecret);
      return { success: true, data: event as unknown as WebhookEvent };
    } catch (error) {
      return { success: false, error: { code: 'WEBHOOK_VERIFICATION_FAILED', message: error instanceof Error ? error.message : 'Invalid webhook signature' } };
    }
  },

  submitDisputeEvidence: async (
    stripeDisputeId: string,
    evidence: Record<string, string>,
    submit: boolean
  ): Promise<ServiceResult<void>> => {
    if (!stripe) {
      return { success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' } };
    }
    try {
      await stripeBreaker.execute(() =>
        stripe!.disputes.update(stripeDisputeId, { evidence, submit } as never)
      );
      return { success: true, data: undefined };
    } catch (error) {
      return { success: false, error: { code: 'STRIPE_DISPUTE_EVIDENCE_FAILED', message: error instanceof Error ? error.message : 'Unknown error' } };
    }
  },

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
      return { success: false, error: { code: 'WEBHOOK_PROCESSING_ERROR', message: error instanceof Error ? error.message : 'Unknown error' } };
    }
  },
};

export default StripeService;
