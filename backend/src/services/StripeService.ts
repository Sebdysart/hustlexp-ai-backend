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
    apiVersion: '2024-12-18.acacia' as any,
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

  /** Get the raw Stripe instance (for balance checks etc.) */
  getStripeInstance: () => stripe,

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

    // Stripe stubbing for tests — WARNING: bypasses real Stripe entirely
    if (process.env.HX_STRIPE_STUB === '1') {
      const crypto = await import('crypto');
      stripeLogger.warn({ escrowId, workerId, amount, workerStripeAccountId }, '⚠️ HX_STRIPE_STUB=1 — returning FAKE transfer ID, no real Stripe call');
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

    stripeLogger.info({ escrowId, workerId, amount, destination: workerStripeAccountId }, 'Calling Stripe transfers.create');

    try {
      const transfer = await stripeBreaker.execute(() => stripe!.transfers.create({
        amount,
        currency: 'usd',
        destination: workerStripeAccountId,
        metadata: {
          escrow_id: escrowId,
          worker_id: workerId,
        },
        description: description || `HustleXP Payout ${escrowId}`,
      }));

      stripeLogger.info({ escrowId, transferId: transfer.id, amount: transfer.amount }, '✓ Stripe transfer created');

      return {
        success: true,
        data: {
          transferId: transfer.id,
          amount: transfer.amount,
        },
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Unknown Stripe error';
      stripeLogger.error({ escrowId, workerId, amount, errMsg }, '✗ Stripe transfer FAILED');
      return {
        success: false,
        error: {
          code: 'STRIPE_ERROR',
          message: errMsg,
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
      const refund = await stripeBreaker.execute(() => stripe!.refunds.create({
        payment_intent: paymentIntentId,
        amount, // undefined = full refund
        reason,
        metadata: {
          escrow_id: escrowId,
          payment_intent_id: paymentIntentId,
        },
      }));

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

  // ============================================================================
  // PAYMENT METHOD MANAGEMENT
  // ============================================================================

  /**
   * Ensure a Stripe Customer exists for a user. Creates one if not.
   */
  ensureCustomer: async (
    userId: string,
    email: string,
    name?: string
  ): Promise<ServiceResult<string>> => {
    if (!stripe) {
      return { success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' } };
    }

    // Check if user already has a customer ID
    const userResult = await db.query<{ stripe_customer_id: string | null }>(
      'SELECT stripe_customer_id FROM users WHERE id = $1',
      [userId]
    );
    const existing = userResult.rows[0]?.stripe_customer_id;

    // Verify the customer still exists in Stripe (handles stale IDs after Stripe account reset)
    if (existing) {
      try {
        const customer = await stripeBreaker.execute(() => stripe!.customers.retrieve(existing));
        if (customer && !(customer as { deleted?: boolean }).deleted) {
          return { success: true, data: existing };
        }
        stripeLogger.warn({ userId, existingId: existing }, 'Stored customer ID returned deleted record — recreating');
      } catch (err) {
        // Customer doesn't exist in Stripe (e.g. after test account reset) — clear the stale ID
        stripeLogger.warn({ userId, existingId: existing, err: err instanceof Error ? err.message : String(err) }, 'Stored customer ID is invalid — recreating');
        await db.query('UPDATE users SET stripe_customer_id = NULL WHERE id = $1', [userId]);
      }
    }

    try {
      const customer = await stripeBreaker.execute(() =>
        stripe!.customers.create({
          email,
          name: name || undefined,
          metadata: { user_id: userId },
        })
      );

      await db.query(
        'UPDATE users SET stripe_customer_id = $1, updated_at = NOW() WHERE id = $2',
        [customer.id, userId]
      );

      stripeLogger.info({ userId, customerId: customer.id }, 'Stripe customer created');
      return { success: true, data: customer.id };
    } catch (error) {
      return { success: false, error: { code: 'STRIPE_ERROR', message: error instanceof Error ? error.message : 'Failed to create customer' } };
    }
  },

  /**
   * Create an ephemeral key for a customer (required by PaymentSheet).
   */
  createEphemeralKey: async (
    customerId: string
  ): Promise<ServiceResult<string>> => {
    if (!stripe) {
      return { success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' } };
    }

    try {
      const ephemeralKey = await stripeBreaker.execute(() =>
        stripe!.ephemeralKeys.create(
          { customer: customerId },
          { apiVersion: '2024-12-18.acacia' as any }
        )
      );

      return { success: true, data: ephemeralKey.secret! };
    } catch (error) {
      return { success: false, error: { code: 'STRIPE_ERROR', message: error instanceof Error ? error.message : 'Failed to create ephemeral key' } };
    }
  },

  /**
   * Create a SetupIntent for saving a payment method without charging.
   */
  createSetupIntent: async (
    customerId: string
  ): Promise<ServiceResult<{ setupIntentId: string; clientSecret: string }>> => {
    if (!stripe) {
      return { success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' } };
    }

    try {
      const setupIntent = await stripeBreaker.execute(() =>
        stripe!.setupIntents.create({
          customer: customerId,
          payment_method_types: ['card'],
        })
      );

      return {
        success: true,
        data: {
          setupIntentId: setupIntent.id,
          clientSecret: setupIntent.client_secret!,
        },
      };
    } catch (error) {
      return { success: false, error: { code: 'STRIPE_ERROR', message: error instanceof Error ? error.message : 'Failed to create setup intent' } };
    }
  },

  /**
   * List saved payment methods for a customer.
   */
  listPaymentMethods: async (
    customerId: string
  ): Promise<ServiceResult<Array<{
    id: string;
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
    isDefault: boolean;
  }>>> => {
    if (!stripe) {
      return { success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' } };
    }

    try {
      const methods = await stripeBreaker.execute(() =>
        stripe!.paymentMethods.list({
          customer: customerId,
          type: 'card',
        })
      );

      // Get default payment method
      const customer = await stripeBreaker.execute(() =>
        stripe!.customers.retrieve(customerId)
      );
      const defaultPmId = (customer as Stripe.Customer).invoice_settings?.default_payment_method;

      return {
        success: true,
        data: methods.data.map((pm) => ({
          id: pm.id,
          brand: pm.card?.brand ?? 'unknown',
          last4: pm.card?.last4 ?? '????',
          expMonth: pm.card?.exp_month ?? 0,
          expYear: pm.card?.exp_year ?? 0,
          isDefault: pm.id === defaultPmId,
        })),
      };
    } catch (error) {
      return { success: false, error: { code: 'STRIPE_ERROR', message: error instanceof Error ? error.message : 'Failed to list payment methods' } };
    }
  },

  /**
   * Remove a payment method.
   */
  detachPaymentMethod: async (
    paymentMethodId: string
  ): Promise<ServiceResult<void>> => {
    if (!stripe) {
      return { success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' } };
    }

    try {
      await stripeBreaker.execute(() =>
        stripe!.paymentMethods.detach(paymentMethodId)
      );
      return { success: true, data: undefined };
    } catch (error) {
      return { success: false, error: { code: 'STRIPE_ERROR', message: error instanceof Error ? error.message : 'Failed to remove payment method' } };
    }
  },

  /**
   * Set a payment method as the customer's default.
   */
  setDefaultPaymentMethod: async (
    customerId: string,
    paymentMethodId: string
  ): Promise<ServiceResult<void>> => {
    if (!stripe) {
      return { success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' } };
    }

    try {
      await stripeBreaker.execute(() =>
        stripe!.customers.update(customerId, {
          invoice_settings: { default_payment_method: paymentMethodId },
        })
      );
      return { success: true, data: undefined };
    } catch (error) {
      return { success: false, error: { code: 'STRIPE_ERROR', message: error instanceof Error ? error.message : 'Failed to set default payment method' } };
    }
  },
};

export default StripeService;
