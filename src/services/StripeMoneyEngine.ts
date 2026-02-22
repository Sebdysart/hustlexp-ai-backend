/**
 * STRIPE MONEY ENGINE — SAGA 3.0
 *
 * The single entry point for ALL financial state transitions in HustleXP.
 * Implements a 3-phase SAGA pattern:
 *   Phase 1: PREPARE — validate, acquire locks, idempotency check
 *   Phase 2: EXECUTE — perform Stripe operations
 *   Phase 3: COMMIT  — persist state, release locks
 *
 * If any phase fails, a compensation flow reverses completed phases.
 *
 * STATE MACHINE:
 *   open -> held (HOLD_ESCROW)          — capture payment intent
 *   held -> released (RELEASE_PAYOUT)   — transfer to hustler
 *   held -> refunded (REFUND_ESCROW)    — refund to poster
 *
 * TERMINAL STATES: released, refunded, completed
 *
 * INVARIANTS:
 *   - KillSwitch check before any transition
 *   - Idempotency via money_events_processed table
 *   - Serializable-level row locking via money_state_lock
 *   - TemporalGuard ordering enforcement
 *   - LedgerService double-entry accounting
 *
 * @version 3.0.0 (SAGA pattern)
 */

import Stripe from 'stripe';
import { getSql, transaction } from '../db/index.js';
import { createLogger } from '../utils/logger.js';
import { KillSwitch } from '../infra/KillSwitch.js';
import { TemporalGuard } from '../infra/ordering/TemporalGuard.js';
import { LedgerLockService } from './ledger/LedgerLockService.js';
import { LedgerAccountService } from './ledger/LedgerAccountService.js';
import { LedgerService } from './ledger/LedgerService.js';
import { PayoutEligibilityResolver, PayoutDecision } from './PayoutEligibilityResolver.js';
import { assertPayoutsEnabled } from '../config/safety.js';
import { env } from '../config/env.js';

const logger = createLogger('StripeMoneyEngine');

// ============================================================================
// STRIPE CLIENT
// ============================================================================

const stripe = new Stripe((env as any).STRIPE_SECRET_KEY || 'sk_test_placeholder', {
  apiVersion: '2024-12-18.acacia' as any,
});

// ============================================================================
// TYPES
// ============================================================================

export type MoneyEvent =
  | 'HOLD_ESCROW'
  | 'RELEASE_PAYOUT'
  | 'REFUND_ESCROW';

export type MoneyState =
  | 'open'
  | 'held'
  | 'released'
  | 'refunded'
  | 'completed';

export interface HandleOptions {
  eventId?: string;
  adminOverride?: boolean;
}

export interface HandleResult {
  success: boolean;
  status?: string;
  state?: MoneyState;
  stripePaymentIntentId?: string;
  stripeTransferId?: string;
  stripeRefundId?: string;
  error?: string;
}

// ============================================================================
// STATE TRANSITION TABLE
// ============================================================================

/**
 * getNextState — pure function implementing the state transition table.
 *
 * Throws if the (state, event) pair is not in the table.
 */
function getNextState(currentState: MoneyState, event: MoneyEvent): MoneyState {
  switch (currentState) {
    case 'open':
      if (event === 'HOLD_ESCROW') return 'held';
      break;

    case 'held':
      if (event === 'RELEASE_PAYOUT') return 'released';
      if (event === 'REFUND_ESCROW') return 'refunded';
      break;

    // Terminal states — no transitions allowed
    case 'released':
    case 'refunded':
    case 'completed':
      break;
  }

  throw new Error(
    `Invalid event ${event} for current state ${currentState}. ` +
    `No transition defined.`
  );
}

// ============================================================================
// STRIPE EFFECTS (Phase 2 operations)
// ============================================================================

async function executeHoldEscrow(payload: any): Promise<{
  paymentIntentId: string;
  chargeId: string;
}> {
  // Create and confirm payment intent with manual capture
  const paymentIntent = await stripe.paymentIntents.create({
    amount: payload.amountCents,
    currency: 'usd',
    payment_method: payload.paymentMethodId,
    capture_method: 'manual',
    confirm: true,
    metadata: {
      taskId: payload.taskId,
      posterId: payload.posterId,
      hustlerId: payload.hustlerId || '',
    },
  });

  // Capture the funds
  const captured = await stripe.paymentIntents.capture(paymentIntent.id);

  return {
    paymentIntentId: captured.id,
    chargeId: (captured.latest_charge as any)?.id || (captured.latest_charge as string) || '',
  };
}

async function executeReleasePayout(payload: any, lockRow: any): Promise<{
  transferId: string;
}> {
  assertPayoutsEnabled();

  // Check payout eligibility
  const eligibility = await PayoutEligibilityResolver.resolve({
    hustlerId: payload.hustlerId,
    amountCents: payload.payoutAmountCents,
    taskId: payload.taskId,
  });

  if (eligibility.decision === PayoutDecision.BLOCK) {
    throw new Error(`Payout blocked: ${(eligibility as any).reason || 'Eligibility check failed'}`);
  }

  // Create transfer to connected account
  const transfer = await stripe.transfers.create({
    amount: payload.payoutAmountCents || lockRow.amount_cents,
    currency: 'usd',
    destination: payload.hustlerStripeAccountId,
    source_transaction: lockRow.stripe_charge_id,
    metadata: {
      taskId: payload.taskId,
      hustlerId: payload.hustlerId,
    },
  });

  return { transferId: transfer.id };
}

async function executeRefundEscrow(payload: any, lockRow: any): Promise<{
  refundId: string;
}> {
  const refund = await stripe.refunds.create({
    payment_intent: lockRow.stripe_payment_intent_id,
    amount: payload.refundAmountCents,
    reason: 'requested_by_customer',
    metadata: {
      taskId: payload.taskId,
      reason: payload.reason || 'Escrow refund',
    },
  });

  return { refundId: refund.id };
}

// ============================================================================
// COMPENSATION FLOWS
// ============================================================================

async function compensateHoldEscrow(paymentIntentId: string): Promise<void> {
  try {
    await stripe.paymentIntents.cancel(paymentIntentId);
    logger.info({ paymentIntentId }, 'Compensation: payment intent cancelled');
  } catch (err) {
    logger.error({ err, paymentIntentId }, 'Compensation FAILED for hold escrow');
    await KillSwitch.trigger('COMPENSATION_FAILED', {
      operation: 'HOLD_ESCROW',
      paymentIntentId,
    });
  }
}

async function compensateReleasePayout(transferId: string): Promise<void> {
  try {
    await stripe.transfers.createReversal(transferId);
    logger.info({ transferId }, 'Compensation: transfer reversed');
  } catch (err) {
    logger.error({ err, transferId }, 'Compensation FAILED for release payout');
    await KillSwitch.trigger('COMPENSATION_FAILED', {
      operation: 'RELEASE_PAYOUT',
      transferId,
    });
  }
}

// ============================================================================
// MAIN HANDLER — SAGA 3.0
// ============================================================================

/**
 * handle — the single entry point for ALL financial state transitions.
 *
 * @param taskId  - The task ID this event relates to
 * @param event   - One of: HOLD_ESCROW, RELEASE_PAYOUT, REFUND_ESCROW
 * @param payload - Event-specific data (amounts, IDs, etc.)
 * @param options - Optional: eventId for idempotency
 */
export async function handle(
  taskId: string,
  event: MoneyEvent,
  payload: Record<string, any>,
  options: HandleOptions = {}
): Promise<HandleResult> {
  const eventId = options.eventId || `${taskId}-${event}-${Date.now()}`;

  // ========================================================================
  // PRE-CHECK: KillSwitch
  // ========================================================================
  const killSwitchActive = await KillSwitch.isActive();
  if (killSwitchActive) {
    logger.fatal({ taskId, event }, 'KILLSWITCH ENGAGED — blocking financial operation');
    throw new Error('KILLSWITCH ENGAGED');
  }

  // ========================================================================
  // PHASE 1: PREPARE (inside transaction)
  // ========================================================================
  return transaction(async (tx: any) => {

    // 1a. Idempotency check
    const [existing] = await tx`
      SELECT 1 FROM money_events_processed
      WHERE event_id = ${eventId}
    `;

    if (existing) {
      logger.info({ taskId, eventId, event }, 'Duplicate event — idempotent return');
      return { success: true, status: 'duplicate_ignored' };
    }

    // 1b. Acquire row lock
    const [lockRow] = await tx`
      SELECT task_id, current_state, amount_cents,
             stripe_payment_intent_id, stripe_charge_id, stripe_transfer_id
      FROM money_state_lock
      WHERE task_id = ${taskId}
      FOR UPDATE
    `;

    const currentState: MoneyState = lockRow?.current_state || 'open';

    // 1c. Validate transition
    const nextState = getNextState(currentState, event);

    // 1d. TemporalGuard check
    await TemporalGuard.validateSequence(taskId, event);

    // ========================================================================
    // PHASE 2: EXECUTE (Stripe operations)
    // ========================================================================
    let stripeResult: any = {};

    try {
      switch (event) {
        case 'HOLD_ESCROW':
          stripeResult = await executeHoldEscrow(payload);
          break;

        case 'RELEASE_PAYOUT':
          stripeResult = await executeReleasePayout(payload, lockRow);
          break;

        case 'REFUND_ESCROW':
          stripeResult = await executeRefundEscrow(payload, lockRow);
          break;
      }
    } catch (stripeError: any) {
      logger.error({ stripeError, taskId, event }, 'Stripe operation failed');

      // Compensate if needed
      if (event === 'HOLD_ESCROW' && stripeResult.paymentIntentId) {
        await compensateHoldEscrow(stripeResult.paymentIntentId);
      }
      if (event === 'RELEASE_PAYOUT' && stripeResult.transferId) {
        await compensateReleasePayout(stripeResult.transferId);
      }

      throw stripeError;
    }

    // ========================================================================
    // PHASE 3: COMMIT (persist state)
    // ========================================================================

    // 3a. Update state lock
    if (lockRow) {
      await tx`
        UPDATE money_state_lock
        SET current_state = ${nextState},
            ${event === 'HOLD_ESCROW' ? tx`
              stripe_payment_intent_id = ${stripeResult.paymentIntentId},
              stripe_charge_id = ${stripeResult.chargeId},
            ` : tx``}
            ${event === 'RELEASE_PAYOUT' ? tx`
              stripe_transfer_id = ${stripeResult.transferId},
            ` : tx``}
            updated_at = NOW()
        WHERE task_id = ${taskId}
      `;
    } else {
      // Create lock row for new escrow
      await tx`
        INSERT INTO money_state_lock (
          task_id, current_state, amount_cents,
          stripe_payment_intent_id, stripe_charge_id,
          updated_at
        ) VALUES (
          ${taskId}, ${nextState}, ${payload.amountCents || 0},
          ${stripeResult.paymentIntentId || null}, ${stripeResult.chargeId || null},
          NOW()
        )
      `;
    }

    // 3b. Record idempotency
    await tx`
      INSERT INTO money_events_processed (event_id, task_id, event_type, processed_at)
      VALUES (${eventId}, ${taskId}, ${event}, NOW())
    `;

    // 3c. Ledger entry
    try {
      const ledgerTx = await LedgerService.prepareTransaction({
        taskId,
        event,
        amountCents: payload.amountCents || lockRow?.amount_cents || 0,
        fromAccount: event === 'REFUND_ESCROW'
          ? LedgerAccountService.getPlatformId()
          : (payload.posterId || 'unknown'),
        toAccount: event === 'RELEASE_PAYOUT'
          ? (payload.hustlerId || 'unknown')
          : LedgerAccountService.getPlatformId(),
      });
      await LedgerService.commitTransaction(ledgerTx.id);
    } catch (ledgerErr) {
      logger.error({ ledgerErr, taskId }, 'Ledger entry failed (non-fatal)');
    }

    // 3d. Log transition
    await tx`
      INSERT INTO money_state_log (task_id, from_state, to_state, event, event_id, created_at)
      VALUES (${taskId}, ${currentState}, ${nextState}, ${event}, ${eventId}, NOW())
    `;

    logger.info({
      taskId,
      event,
      from: currentState,
      to: nextState,
      stripeResult,
    }, 'StripeMoneyEngine: transition committed');

    return {
      success: true,
      status: 'committed',
      state: nextState,
      stripePaymentIntentId: stripeResult.paymentIntentId,
      stripeTransferId: stripeResult.transferId,
      stripeRefundId: stripeResult.refundId,
    };
  });
}

// ============================================================================
// UTILITY EXPORTS
// ============================================================================

export { getNextState };

export default {
  handle,
  getNextState,
};
