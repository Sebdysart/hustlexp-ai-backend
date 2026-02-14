/**
 * StripeService v1.0.0
 * 
 * CONSTITUTIONAL: Supports payment flow for escrow system
 * 
 * Stripe is authoritative for payment state (ARCHITECTURE.md §4).
 * This service handles:
 * - Payment intent creation (poster funds escrow)
 * - Transfer to worker (escrow release)
 * - Refunds (escrow refund)
 * - Webhook processing
 * 
 * @see PRODUCT_SPEC.md §4
 * @see ARCHITECTURE.md §1.1
 */

import Stripe from 'stripe';
import { config } from '../config';
import { db } from '../db';
import type { ServiceResult } from '../types';
import { ErrorCodes } from '../types';

// ============================================================================
// INITIALIZATION
// ============================================================================

let stripe: Stripe | null = null;

if (config.stripe.secretKey && !config.stripe.secretKey.includes('placeholder')) {
  stripe = new Stripe(config.stripe.secretKey, {
    apiVersion: '2025-12-15.clover',
  });
  console.log('✅ Stripe initialized');
} else {
  console.warn('⚠️ Stripe not configured (placeholder or missing key)');
}

// ============================================================================
// TYPES
// ============================================================================

interface CreatePaymentIntentParams {
  taskId: string;
  posterId: string;
  amount: number; // USD cents
  description?: string;
}

interface CreatePaymentIntentResult {
  paymentIntentId: string;
  clientSecret: string;
  amount: number;
}

interface CreateTransferParams {
  escrowId: string; // P0: Required for metadata correlation
  taskId: string; // P0: Required for metadata correlation
  workerId: string;
  workerStripeAccountId: string;
  amount: number; // USD cents
  description?: string;
}

interface CreateTransferResult {
  transferId: string;
  amount: number;
}

interface CreateRefundParams {
  paymentIntentId: string;
  escrowId: string; // P0: Required for metadata correlation
  amount?: number; // USD cents, optional for partial refund
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

// ============================================================================
// IDEMPOTENCY
// ============================================================================

/**
 * Check if Stripe event already processed
 */
async function isEventProcessed(eventId: string): Promise<boolean> {
  const result = await db.query(
    'SELECT id FROM processed_stripe_events WHERE event_id = $1',
    [eventId]
  );
  return result.rows.length > 0;
}

/**
 * Mark Stripe event as processed
 */
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

// ============================================================================
// SERVICE
// ============================================================================

export const StripeService = {
  /**
   * Check if Stripe is configured
   */
  isConfigured: (): boolean => stripe !== null,

  /**
   * Create payment intent for escrow funding
   */
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

    // PRODUCT_SPEC §9: Minimum task value $5.00 (500 cents)
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
      // Calculate platform fee (PRODUCT_SPEC §9: 15% platform fee)
      const platformFee = Math.floor(amount * (config.stripe.platformFeePercent / 100));

      const paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency: 'usd',
        automatic_payment_methods: { enabled: true },
        metadata: {
          task_id: taskId,
          poster_id: posterId,
          platform_fee: platformFee.toString(),
        },
        description: description || `HustleXP Task ${taskId}`,
      });

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

  /**
   * Create transfer to worker (escrow release)
   */
  createTransfer: async (
    params: CreateTransferParams
  ): Promise<ServiceResult<CreateTransferResult>> => {
    const { escrowId, workerId, workerStripeAccountId, amount, description } = params;

    // Stripe stubbing for tests (Evil Test A)
    if (process.env.HX_STRIPE_STUB === '1') {
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
      const transfer = await stripe.transfers.create({
        amount,
        currency: 'usd',
        destination: workerStripeAccountId,
        metadata: {
          escrow_id: escrowId,
          worker_id: workerId,
        },
        description: description || `HustleXP Payout ${escrowId}`,
      });

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

  /**
   * Create refund (escrow refund)
   */
  createRefund: async (
    params: CreateRefundParams
  ): Promise<ServiceResult<CreateRefundResult>> => {
    const { paymentIntentId, escrowId, amount, reason } = params;

    // Stripe stubbing for tests (Evil Test A)
    if (process.env.HX_STRIPE_STUB === '1') {
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
      const refund = await stripe.refunds.create({
        payment_intent: paymentIntentId,
        amount, // undefined = full refund
        reason,
        metadata: {
          escrow_id: escrowId,
          payment_intent_id: paymentIntentId,
        },
      });

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

  /**
   * Verify webhook signature
   */
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

  /**
   * Process webhook event (idempotent)
   */
  processWebhookEvent: async (
    eventId: string,
    eventType: string,
    objectId: string,
    handler: () => Promise<void>
  ): Promise<ServiceResult<void>> => {
    // Check idempotency
    if (await isEventProcessed(eventId)) {
      return { success: true, data: undefined };
    }

    try {
      await handler();
      await markEventProcessed(eventId, eventType, objectId);
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
