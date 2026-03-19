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
import { config } from '../config.js';
import { db } from '../db.js';
import type { ServiceResult } from '../types.js';
import { stripeBreaker } from '../middleware/circuit-breaker.js';
import { stripeLogger } from '../logger.js';

// ============================================================================
// INITIALIZATION
// ============================================================================

let stripe: Stripe | null = null;

if (config.stripe.secretKey && !config.stripe.secretKey.includes('placeholder')) {
  stripe = new Stripe(config.stripe.secretKey, {
    apiVersion: '2025-11-17.clover',
  });
  stripeLogger.info('Stripe initialized');
} else {
  stripeLogger.warn('Stripe not configured (placeholder or missing key)');
}

// ============================================================================
// TYPES
// ============================================================================

interface CreatePaymentIntentParams {
  taskId: string;
  posterId: string;
  escrowId: string;
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
 * Atomically claim a Stripe event for processing.
 * Returns true if this caller won the INSERT race (event not yet processed),
 * false if another worker already claimed it (ON CONFLICT → 0 rows returned).
 */
async function markEventProcessedAtomic(
  eventId: string,
  eventType: string,
  objectId: string
): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO processed_stripe_events (event_id, event_type, object_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (event_id) DO NOTHING`,
    [eventId, eventType, objectId]
  );
  return (result.rowCount ?? 0) === 1;
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

    const { taskId, posterId, escrowId, amount, description } = params;

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

      // NOTE on application_fee_amount (FIX 2 analysis):
      // `application_fee_amount` only works on Connect charges where the payment
      // destination is a connected account (i.e. when `on_behalf_of` or
      // `transfer_data.destination` is set on the PaymentIntent).  In HustleXP's
      // architecture, the poster's payment goes to the *platform* account first
      // (standard Stripe charge), and the worker payout is executed as a separate
      // Stripe Transfer via StripeService.createTransfer().  Setting
      // `application_fee_amount` here would cause a Stripe API error ("You cannot
      // pass `application_fee_amount` on a non-Connect charge").
      // The platform fee is therefore collected via the manual reconciliation
      // approach: the fee amount is stored in metadata so EscrowService.release()
      // can calculate and record it in the revenue ledger via RevenueService.logEvent().
      // If the architecture is ever changed to route payments through a connected
      // account (on_behalf_of + transfer_data), `application_fee_amount: platformFee`
      // should be added here and the manual RevenueService.logEvent() call removed.
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
        { idempotencyKey: `pi_create_${escrowId}` }
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

  /**
   * Create payment intent for XP tax payments.
   * Unlike escrow funding, tax payments have no minimum task value
   * (Stripe minimum is 50 cents).
   */
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

    // Stripe minimum is 50 cents
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

  /**
   * Verify a PaymentIntent has succeeded and return its amount.
   * Used by XPTaxService to verify tax payment before releasing XP.
   */
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

  /**
   * Create transfer to worker (escrow release)
   */
  createTransfer: async (
    params: CreateTransferParams
  ): Promise<ServiceResult<CreateTransferResult>> => {
    const { escrowId, workerId, workerStripeAccountId, amount, description } = params;

    // Stripe stubbing for tests (Evil Test A) — never active in production
    if (process.env.HX_STRIPE_STUB === '1' && process.env.NODE_ENV !== 'production') {
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
        { idempotencyKey: `tr_create_${escrowId}` }
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

  /**
   * Create refund (escrow refund)
   */
  createRefund: async (
    params: CreateRefundParams
  ): Promise<ServiceResult<CreateRefundResult>> => {
    const { paymentIntentId, escrowId, amount, reason } = params;

    // Stripe stubbing for tests (Evil Test A) — never active in production
    if (process.env.HX_STRIPE_STUB === '1' && process.env.NODE_ENV !== 'production') {
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
      const idempotencyKey = amount
        ? `re_create_${paymentIntentId}_${amount}`
        : `re_create_${paymentIntentId}`;

      const refund = await stripeBreaker.execute(() => stripe!.refunds.create(
        {
          payment_intent: paymentIntentId,
          amount, // undefined = full refund
          reason,
          metadata: {
            escrow_id: escrowId,
            payment_intent_id: paymentIntentId,
          },
        },
        { idempotencyKey }
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
    // Atomically claim the event — INSERT first, process only if we won the race.
    // This eliminates the TOCTOU window between isEventProcessed (SELECT) and
    // markEventProcessed (INSERT): two concurrent deliveries both attempting the
    // INSERT will have exactly one succeed (rowCount === 1) and one be silently
    // ignored by ON CONFLICT DO NOTHING. Only the winner proceeds to call handler().
    const claimed = await markEventProcessedAtomic(eventId, eventType, objectId);
    if (!claimed) {
      stripeLogger.info({ eventId }, 'Webhook event already processed, skipping');
      return { success: true, data: undefined };
    }

    try {
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
