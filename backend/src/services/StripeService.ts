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
import { notifyAdmins } from './AdminNotificationHelper.js';
import { resolvePlatformFeeCents } from '../lib/money.js';
import { newPaymentCreationFailure } from './NewPaymentCreationGuard.js';
import type { StripeTransferWitness } from './EscrowReleaseTypes.js';

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
  amount: number;
  platformFeeCents?: number | null;
  description?: string;
}

interface CreatePaymentIntentResult {
  paymentIntentId: string;
  clientSecret: string;
  amount: number;
}

interface PaymentIntentProcessingFeeResult {
  paymentIntentId: string;
  chargeId: string;
  balanceTransactionId: string;
  feeCents: number;
  currency: string;
}

interface CreateTaxPaymentIntentResult {
  paymentIntentId: string;
  clientSecret: string;
  amountCents: number;
}

function feeUnavailable(message: string): ServiceResult<PaymentIntentProcessingFeeResult> {
  return { success: false, error: { code: 'STRIPE_FEE_UNAVAILABLE', message } };
}

async function resolvePaymentIntentCharge(
  paymentIntent: Stripe.PaymentIntent
): Promise<Stripe.Charge | null> {
  if (typeof paymentIntent.latest_charge === 'string') {
    return stripeBreaker.execute(() =>
      stripe!.charges.retrieve(paymentIntent.latest_charge as string, {
        expand: ['balance_transaction'],
      })
    );
  }
  return paymentIntent.latest_charge || null;
}

async function resolveChargeBalanceTransaction(
  charge: Stripe.Charge
): Promise<Stripe.BalanceTransaction | null> {
  if (typeof charge.balance_transaction === 'string') {
    return stripeBreaker.execute(() =>
      stripe!.balanceTransactions.retrieve(charge.balance_transaction as string)
    );
  }
  return charge.balance_transaction || null;
}

interface CreateTransferParams {
  escrowId: string; // P0: Required for metadata correlation
  taskId: string; // P0: Required for metadata correlation
  workerId: string;
  workerStripeAccountId: string;
  amount: number; // USD cents
  description?: string;
  /** Optional suffix appended to the Stripe idempotency key.
   * Use distinct suffixes when different callers issue transfers for the same
   * escrow with different amounts (e.g. EscrowService.partialRefund vs
   * escrow-action-worker.handlePartialRefundRequest) so Stripe does not
   * mask a real duplicate as an idempotent replay.
   */
  idempotencyKeySuffix?: string;
}

interface CreateTransferResult {
  transferId: string;
  amount: number;
}

interface CreateTransferReversalResult {
  reversalId: string | null;
  reversalAmountCents: number | null;
  transferWitness: StripeTransferWitness;
}

interface CreateRefundParams {
  paymentIntentId: string;
  escrowId: string; // P0: Required for metadata correlation
  amount?: number; // USD cents, optional for partial refund
  reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
  /** Optional suffix appended to idempotency key to distinguish callers that share the same paymentIntentId+amount */
  idempotencyKeySuffix?: string;
  /** Exact durable-claim identity. When present it replaces the legacy derived key. */
  providerIdempotencyKey?: string;
  /** Immutable escrow_events claim key copied into provider metadata for crash discovery. */
  refundClaimKey?: string;
}

interface CreateRefundResult {
  refundId: string;
  amount: number;
  status: string;
  currency: string;
  paymentIntentId: string | null;
  chargeId: string | null;
}

interface DiscoverRefundByClaimParams {
  paymentIntentId: string;
  escrowId: string;
  expectedAmountCents: number;
  refundClaimKey: string;
  providerIdempotencyKey: string;
}

interface WebhookEvent {
  type: string;
  data: {
    object: Stripe.PaymentIntent | Stripe.Transfer | Stripe.Refund;
  };
}

function normalizeTransferWitness(transfer: Stripe.Transfer): StripeTransferWitness {
  const destinationAccountId = typeof transfer.destination === 'string'
    ? transfer.destination
    : transfer.destination?.id ?? null;
  return {
    provider: 'STRIPE',
    transferId: transfer.id,
    amountCents: transfer.amount,
    currency: transfer.currency,
    destinationAccountId,
    reversed: transfer.reversed === true,
    amountReversedCents: transfer.amount_reversed,
    escrowId: transfer.metadata?.escrow_id ?? null,
    taskId: transfer.metadata?.task_id ?? null,
    payoutRecipientUserId: transfer.metadata?.worker_id ?? null,
  };
}

function stripeReferenceId(value: string | { id: string } | null | undefined): string | null {
  return typeof value === 'string' ? value : value?.id ?? null;
}

function normalizeRefundWitness(refund: Stripe.Refund): CreateRefundResult {
  return {
    refundId: refund.id,
    amount: refund.amount,
    status: refund.status ?? '',
    currency: refund.currency,
    paymentIntentId: stripeReferenceId(refund.payment_intent),
    chargeId: stripeReferenceId(refund.charge),
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
   * Read and normalize the current Stripe transfer state.  This is a read-only
   * processor operation and remains available while payment creation is frozen.
   * Canonical release code must still re-bind the witness to locked database
   * state before accepting it.
   */
  readTransferWitness: async (
    transferId: string,
  ): Promise<ServiceResult<StripeTransferWitness>> => {
    if (!stripe) {
      return {
        success: false,
        error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' },
      };
    }
    try {
      const transfer = await stripeBreaker.execute(() =>
        stripe!.transfers.retrieve(transferId)
      );
      return {
        success: true,
        data: normalizeTransferWitness(transfer),
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'STRIPE_TRANSFER_EVIDENCE_UNAVAILABLE',
          message: error instanceof Error
            ? error.message
            : 'Stripe transfer could not be verified',
        },
      };
    }
  },

  /**
   * Create payment intent for escrow funding
   */
  createPaymentIntent: async (
    params: CreatePaymentIntentParams
  ): Promise<ServiceResult<CreatePaymentIntentResult>> => {
    const frozen = newPaymentCreationFailure('escrow_funding');
    if (frozen) return frozen;

    if (!stripe) {
      return {
        success: false,
        error: {
          code: 'STRIPE_NOT_CONFIGURED',
          message: 'Stripe is not configured',
        },
      };
    }

    const { taskId, posterId, escrowId, amount, platformFeeCents, description } = params;

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
      const platformFee = resolvePlatformFeeCents(
        amount,
        config.stripe.platformFeePercent,
        platformFeeCents
      );

      const paymentIntent = await stripeBreaker.execute(() =>
        stripe!.paymentIntents.create(
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
          {
            idempotencyKey: `pi_create_${escrowId}`,
          }
        )
      );

      return {
        success: true,
        data: {
          paymentIntentId: paymentIntent.id,
          clientSecret: paymentIntent.client_secret!,
          amount: paymentIntent.amount,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'STRIPE_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  /**
   * Create payment intent for XP tax payments.
   * Unlike escrow funding, tax payments have no minimum task value
   * (Stripe minimum is 50 cents).
   *
   * @param timestamp - A per-call Unix ms timestamp (pass Date.now()). Included
   * in the Stripe idempotency key to prevent key collisions when the same user
   * owes the same tax amount twice within Stripe's 24-hour idempotency window.
   */
  createTaxPaymentIntent: async (
    userId: string,
    amountCents: number,
    timestamp: number
  ): Promise<ServiceResult<CreateTaxPaymentIntentResult>> => {
    const frozen = newPaymentCreationFailure('xp_tax');
    if (frozen) return frozen;
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
      const paymentIntent = await stripeBreaker.execute(() =>
        stripe!.paymentIntents.create(
          {
            amount: amountCents,
            currency: 'usd',
            automatic_payment_methods: { enabled: true },
            metadata: {
              type: 'xp_tax',
              user_id: userId,
            },
            description: `HustleXP XP Tax Payment`,
          },
          { idempotencyKey: `xp_tax_pi_${userId}_${amountCents}_${timestamp}` }
        )
      );

      return {
        success: true,
        data: {
          paymentIntentId: paymentIntent.id,
          clientSecret: paymentIntent.client_secret!,
          amountCents,
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
    paymentIntentId: string
  ): Promise<
    ServiceResult<{ status: string; amountCents: number; metadata: Record<string, string> }>
  > => {
    if (!stripe) {
      return {
        success: false,
        error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' },
      };
    }

    try {
      const pi = await stripeBreaker.execute(() =>
        stripe!.paymentIntents.retrieve(paymentIntentId)
      );
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
   * Read Stripe's actual processing fee for a successful PaymentIntent.
   *
   * This is provider-read-only. It is used when the worker transfer is created
   * so the platform-fee ledger row can prove actual contribution instead of
   * treating an estimated margin as profit.
   */
  getPaymentIntentProcessingFee: async (
    paymentIntentId: string
  ): Promise<ServiceResult<PaymentIntentProcessingFeeResult>> => {
    if (!stripe) {
      return {
        success: false,
        error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' },
      };
    }

    try {
      const paymentIntent = await stripeBreaker.execute(() =>
        stripe!.paymentIntents.retrieve(paymentIntentId, {
          expand: ['latest_charge.balance_transaction'],
        })
      );

      const charge = await resolvePaymentIntentCharge(paymentIntent);

      if (!charge) {
        return feeUnavailable(`PaymentIntent ${paymentIntentId} has no charge`);
      }

      const balanceTransaction = await resolveChargeBalanceTransaction(charge);

      if (
        !balanceTransaction ||
        !Number.isInteger(balanceTransaction.fee) ||
        balanceTransaction.fee < 0
      ) {
        return feeUnavailable(`PaymentIntent ${paymentIntentId} has no settled processing fee`);
      }

      return {
        success: true,
        data: {
          paymentIntentId,
          chargeId: charge.id,
          balanceTransactionId: balanceTransaction.id,
          feeCents: balanceTransaction.fee,
          currency: balanceTransaction.currency,
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
    const frozen = newPaymentCreationFailure('settlement_transfer');
    if (frozen) return frozen;

    const {
      escrowId,
      taskId,
      workerId,
      workerStripeAccountId,
      amount,
      description,
      idempotencyKeySuffix,
    } =
      params;

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
      // BUG 7 FIX: Include idempotencyKeySuffix in the key so that callers with
      // different roles (EscrowService.partialRefund vs escrow-action-worker) produce
      // distinct keys for the same escrow. Without distinct keys, Stripe would treat
      // the second call as an idempotent replay of the first, masking a real duplicate
      // that sends two transfers for different amounts to the same worker.
      // F-29: Also include the last 8 chars of the destination account so that a
      // transfer to a different worker for the same escrow+amount is never treated
      // as an idempotent replay of a prior transfer to a different account.
      const destSuffix = workerStripeAccountId ? `_${workerStripeAccountId.slice(-8)}` : '';
      const idempotencyKey = idempotencyKeySuffix
        ? `tr_create_${escrowId}_${amount}${destSuffix}_${idempotencyKeySuffix}`
        : `tr_create_${escrowId}_${amount}${destSuffix}`;
      const transfer = await stripeBreaker.execute(() =>
        stripe!.transfers.create(
          {
            amount,
            currency: 'usd',
            destination: workerStripeAccountId,
            metadata: {
              escrow_id: escrowId,
              task_id: taskId,
              worker_id: workerId,
            },
            description: description || `HustleXP Payout ${escrowId}`,
          },
          { idempotencyKey }
        )
      );

      return {
        success: true,
        data: {
          transferId: transfer.id,
          amount: transfer.amount,
        },
      };
    } catch (error) {
      const providerCode = error && typeof error === 'object' && 'code' in error
        && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : 'STRIPE_ERROR';
      return {
        success: false,
        error: {
          code: providerCode,
          message: error instanceof Error ? error.message : 'Unknown Stripe error',
        },
      };
    }
  },

  /**
   * Create refund (escrow refund)
   */
  createRefund: async (params: CreateRefundParams): Promise<ServiceResult<CreateRefundResult>> => {
    const {
      paymentIntentId,
      escrowId,
      amount,
      reason,
      idempotencyKeySuffix,
      providerIdempotencyKey,
      refundClaimKey,
    } = params;

    // Stripe stubbing for tests (Evil Test A) — never active in production
    if (process.env.HX_STRIPE_STUB === '1' && process.env.NODE_ENV !== 'production') {
      const crypto = await import('crypto');
      return {
        success: true,
        data: {
          refundId: `re_test_${crypto.randomUUID().slice(0, 8)}`,
          amount: amount || 0,
          status: 'succeeded',
          currency: 'usd',
          paymentIntentId,
          chargeId: `ch_test_${paymentIntentId}`,
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
      const idempotencyKey = providerIdempotencyKey ?? (idempotencyKeySuffix
        ? `re_create_${paymentIntentId}_${amount ?? 'full'}_${idempotencyKeySuffix}`
        : `re_create_${paymentIntentId}_${amount ?? 'full'}`);
      const metadata: Record<string, string> = {
        escrow_id: escrowId,
        payment_intent_id: paymentIntentId,
      };
      if (refundClaimKey && providerIdempotencyKey) {
        metadata.refund_claim_key = refundClaimKey;
        metadata.refund_provider_key = providerIdempotencyKey;
      }

      const created = await stripeBreaker.execute(() =>
        stripe!.refunds.create(
          {
            payment_intent: paymentIntentId,
            amount, // undefined = full refund
            reason,
            metadata,
          },
          { idempotencyKey }
        )
      );
      // An idempotent create replay can return the response cached at the time
      // of the first request. Always re-read the Refund so callers can bind
      // terminal canonical state to current provider truth.
      const refund = await stripeBreaker.execute(() => stripe!.refunds.retrieve(created.id));

      if (
        refundClaimKey
        && providerIdempotencyKey
        && (
          refund.metadata?.escrow_id !== escrowId
          || refund.metadata?.payment_intent_id !== paymentIntentId
          || refund.metadata?.refund_claim_key !== refundClaimKey
          || refund.metadata?.refund_provider_key !== providerIdempotencyKey
        )
      ) {
        return {
          success:false,
          error:{
            code:'STRIPE_REFUND_CLAIM_MISMATCH',
            message:'Current Refund metadata does not match the immutable provider claim',
          },
        };
      }

      return { success: true, data: normalizeRefundWitness(refund) };
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
   * Recover a provider-success / application-crash gap without issuing a new
   * refund. Any non-exhaustive list, duplicate claim, or non-exact provider
   * object is ambiguous and therefore fails closed.
   */
  discoverRefundByClaim: async (
    params: DiscoverRefundByClaimParams,
  ): Promise<ServiceResult<CreateRefundResult>> => {
    if (!stripe) {
      return {
        success:false,
        error:{ code:'STRIPE_NOT_CONFIGURED',message:'Stripe is not configured' },
      };
    }
    try {
      const page = await stripeBreaker.execute(() => stripe!.refunds.list({
        payment_intent: params.paymentIntentId,
        limit: 100,
      }));
      if (page.has_more) {
        return {
          success:false,
          error:{
            code:'STRIPE_REFUND_DISCOVERY_PAGINATION',
            message:'Refund discovery is non-exhaustive; manual reconciliation is required',
          },
        };
      }
      const matches = page.data.filter((refund) => (
        refund.metadata?.escrow_id === params.escrowId
        && refund.metadata?.payment_intent_id === params.paymentIntentId
        && refund.metadata?.refund_claim_key === params.refundClaimKey
        && refund.metadata?.refund_provider_key === params.providerIdempotencyKey
      ));
      if (matches.length !== 1) {
        return {
          success:false,
          error:{
            code:matches.length === 0
              ? 'STRIPE_REFUND_NOT_FOUND'
              : 'STRIPE_REFUND_AMBIGUOUS',
            message:matches.length === 0
              ? 'No exact refund exists for the immutable provider claim'
              : 'Multiple refunds match the immutable provider claim',
          },
        };
      }
      const refund = await stripeBreaker.execute(() => stripe!.refunds.retrieve(matches[0].id));
      if (
        refund.metadata?.escrow_id !== params.escrowId
        || refund.metadata?.payment_intent_id !== params.paymentIntentId
        || refund.metadata?.refund_claim_key !== params.refundClaimKey
        || refund.metadata?.refund_provider_key !== params.providerIdempotencyKey
        || stripeReferenceId(refund.payment_intent) !== params.paymentIntentId
        || refund.amount !== params.expectedAmountCents
        || refund.currency !== 'usd'
      ) {
        return {
          success:false,
          error:{
            code:'STRIPE_REFUND_DISCOVERY_MISMATCH',
            message:'Discovered refund does not exactly match the immutable provider claim',
          },
        };
      }
      if (refund.status !== 'succeeded') {
        return {
          success:false,
          error:{
            code:refund.status === 'pending'
              ? 'STRIPE_REFUND_PENDING'
              : 'STRIPE_REFUND_DISCOVERY_MISMATCH',
            message:`Discovered refund is not succeeded (status=${refund.status ?? 'unknown'})`,
          },
        };
      }
      return { success:true,data:normalizeRefundWitness(refund) };
    } catch (error) {
      return {
        success:false,
        error:{
          code:'STRIPE_REFUND_DISCOVERY_FAILED',
          message:error instanceof Error ? error.message : 'Unknown Stripe error',
        },
      };
    }
  },

  /** Read the current Refund rather than trusting a stored or cached identity. */
  readRefundWitness: async (
    refundId: string,
  ): Promise<ServiceResult<CreateRefundResult>> => {
    if (!stripe) {
      return {
        success:false,
        error:{ code:'STRIPE_NOT_CONFIGURED',message:'Stripe is not configured' },
      };
    }
    try {
      const refund = await stripeBreaker.execute(() => stripe!.refunds.retrieve(refundId));
      return { success:true,data:normalizeRefundWitness(refund) };
    } catch (error) {
      return {
        success:false,
        error:{
          code:'STRIPE_ERROR',
          message:error instanceof Error ? error.message : 'Unknown Stripe error',
        },
      };
    }
  },

  /**
   * Cancel a Stripe refund (best-effort double-spend recovery).
   * Stripe only allows cancellation of refunds in 'pending' state.
   * Returns success=true if cancelled or already in a terminal state that is not 'failed'.
   */
  cancelRefund: async (
    refundId: string
  ): Promise<ServiceResult<{ refundId: string; status: string }>> => {
    if (!stripe) {
      return {
        success: false,
        error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured' },
      };
    }

    try {
      const cancelled = await stripeBreaker.execute(() => stripe!.refunds.cancel(refundId));
      return {
        success: true,
        data: { refundId: cancelled.id, status: cancelled.status ?? 'cancelled' },
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
   * Reverse a Stripe transfer (used when a dispute reverses a previously-released escrow).
   * Idempotent: if the reversal already exists (resource_already_exists), resolves successfully.
   */
  createTransferReversal: async (
    transferId: string,
    escrowId: string,
    refundId?: string,
  ): Promise<ServiceResult<CreateTransferReversalResult>> => {
    if (!stripe) {
      return {
        success: false,
        error: {
          code: 'STRIPE_NOT_CONFIGURED',
          message: 'Stripe is not configured',
        },
      };
    }

    const idempotencyKey = refundId
      ? `tr_reversal_${escrowId}_${transferId}_${refundId}`
      : `tr_reversal_${escrowId}_${transferId}`;

    try {
      const reversal = await stripeBreaker.execute(() =>
        stripe!.transfers.createReversal(transferId, {}, { idempotencyKey })
      );
      const reversalTransferId = typeof reversal.transfer === 'string'
        ? reversal.transfer
        : reversal.transfer.id;
      if (
        reversalTransferId !== transferId
        || reversal.currency !== 'usd'
        || !Number.isInteger(reversal.amount)
        || reversal.amount <= 0
      ) {
        return {
          success: false,
          error: {
            code: 'STRIPE_TRANSFER_REVERSAL_EVIDENCE_MISMATCH',
            message: 'Stripe reversal response does not match the requested USD transfer',
          },
        };
      }
      const transfer = await stripeBreaker.execute(() => stripe!.transfers.retrieve(transferId));
      return {
        success: true,
        data: {
          reversalId: reversal.id,
          reversalAmountCents: reversal.amount,
          transferWitness: normalizeTransferWitness(transfer),
        },
      };
    } catch (error) {
      const stripeCode = (error as Error & { code?: string }).code;
      if (stripeCode === 'resource_already_exists') {
        // A prior request may have fully reversed the transfer. Presence of an
        // error code is not proof; retrieve current transfer state and return a
        // normalized read-only witness. The caller must still bind it to locked
        // canonical facts and prove amount_reversed === amount.
        try {
          const transfer = await stripeBreaker.execute(() => stripe!.transfers.retrieve(transferId));
          return {
            success: true,
            data: {
              reversalId: null,
              reversalAmountCents: null,
              transferWitness: normalizeTransferWitness(transfer),
            },
          };
        } catch (readError) {
          return {
            success: false,
            error: {
              code: 'STRIPE_TRANSFER_REVERSAL_EVIDENCE_UNAVAILABLE',
              message: readError instanceof Error
                ? readError.message
                : 'Current reversed transfer evidence is unavailable',
            },
          };
        }
      }
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
  verifyWebhook: (payload: string | Buffer, signature: string): ServiceResult<WebhookEvent> => {
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
      const event = stripe.webhooks.constructEvent(payload, signature, config.stripe.webhookSecret);

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
      // Roll back the idempotency row so Stripe's retry delivery can re-claim
      // the event.  Without this DELETE, the INSERT above is already committed;
      // the next delivery attempt sees the existing row, returns claimed=false,
      // and skips the event permanently — causing silent data loss.
      try {
        await db.query('DELETE FROM processed_stripe_events WHERE event_id = $1', [eventId]);
        stripeLogger.warn(
          { eventId },
          'Handler failed — rolled back idempotency row so retry can re-claim'
        );
      } catch (deleteError) {
        // BUG 7 FIX: The DELETE failed, meaning the idempotency row is permanently stuck.
        // Stripe's next retry delivery will see the existing row, return claimed=false, and
        // skip the event — causing silent permanent data loss. Alert ops immediately.
        stripeLogger.error(
          {
            err: deleteError instanceof Error ? deleteError.message : String(deleteError),
            eventId,
          },
          '[stripe-webhook] PERMANENT: Failed to delete idempotency row — this Stripe event will never be retried. Manual intervention required.'
        );
        try {
          await notifyAdmins({
            title: 'Stripe Event Permanently Stuck',
            body: `Stripe event ${eventId} is permanently stuck — idempotency row deletion failed. Manual DB intervention required.`,
            deepLink: `/admin/stripe-events/${eventId}`,
            priority: 'CRITICAL',
            metadata: {
              event_id: eventId,
              delete_error:
                deleteError instanceof Error ? deleteError.message : String(deleteError),
            },
          });
        } catch (notifyError) {
          stripeLogger.error(
            {
              err: notifyError instanceof Error ? notifyError.message : String(notifyError),
              eventId,
            },
            '[stripe-webhook] Failed to notify admins of stuck event — check both DB and notification service'
          );
        }
      }
      return {
        success: false,
        error: {
          code: 'WEBHOOK_PROCESSING_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  createQuotePaymentIntent: async (params: {
    quoteId: string;
    quoteVersionId: string;
    posterId: string;
    amountCents: number;
    platformFeeCents?: number | null;
    description?: string;
  }): Promise<
    ServiceResult<{
      paymentIntentId: string;
      clientSecret: string;
      amountCents: number;
    }>
  > => {
    const frozen = newPaymentCreationFailure('quote_payment');
    if (frozen) return frozen;

    if (!stripe) {
      return {
        success: false,
        error: {
          code: 'STRIPE_NOT_CONFIGURED',
          message: 'Stripe is not configured',
        },
      };
    }

    const { quoteId, quoteVersionId, posterId, amountCents, platformFeeCents, description } =
      params;

    if (amountCents < config.stripe.minimumTaskValueCents) {
      return {
        success: false,
        error: {
          code: 'INVALID_AMOUNT',
          message: `Task value must be at least $${config.stripe.minimumTaskValueCents / 100}.00`,
        },
      };
    }

    try {
      const platformFee = resolvePlatformFeeCents(
        amountCents,
        config.stripe.platformFeePercent,
        platformFeeCents
      );

      const paymentIntent = await stripeBreaker.execute(() =>
        stripe!.paymentIntents.create(
          {
            amount: amountCents,
            currency: 'usd',
            automatic_payment_methods: {
              enabled: true,
              allow_redirects: 'never',
            },
            metadata: {
              quote_id: quoteId,
              quote_version_id: quoteVersionId,
              poster_id: posterId,
              platform_fee: platformFee.toString(),
            },
            description: description || `HustleXP Quote ${quoteId}`,
          },
          {
            idempotencyKey: `pi_create_quote_${quoteId}_v${quoteVersionId}`,
          }
        )
      );

      return {
        success: true,
        data: {
          paymentIntentId: paymentIntent.id,
          clientSecret: paymentIntent.client_secret!,
          amountCents: paymentIntent.amount,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'STRIPE_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  /**
   * TEST ONLY: Confirm a PaymentIntent using a Stripe test PaymentMethod.
   *
   * This exists so backend-only integration tests can complete a sandbox
   * payment without requiring Stripe.js / Elements.
   */
  confirmTestPaymentIntent: async (
    paymentIntentId: string
  ): Promise<
    ServiceResult<{
      paymentIntentId: string;
      status: string;
      amountCents: number;
    }>
  > => {
    const frozen = newPaymentCreationFailure('quote_payment');
    if (frozen) return frozen;

    if (!stripe) {
      return {
        success: false,
        error: {
          code: 'STRIPE_NOT_CONFIGURED',
          message: 'Stripe is not configured',
        },
      };
    }

    if (process.env.NODE_ENV === 'production') {
      return {
        success: false,
        error: {
          code: 'TEST_PAYMENT_DISABLED',
          message: 'Test payment confirmation is disabled in production.',
        },
      };
    }

    try {
      // The PaymentIntent was originally created with automatic payment
      // methods that may include redirect-based methods. Disable redirects
      // for our backend-only test confirmation path.

      const paymentIntent = await stripeBreaker.execute(() =>
        stripe!.paymentIntents.confirm(paymentIntentId, {
          payment_method: 'pm_card_visa',
        })
      );

      return {
        success: true,
        data: {
          paymentIntentId: paymentIntent.id,
          status: paymentIntent.status,
          amountCents: paymentIntent.amount,
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
};

export default StripeService;
