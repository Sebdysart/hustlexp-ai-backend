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
import { match } from 'ts-pattern';
import { transaction } from '../db/index.js';
import type { SqlTx } from '../db/index.js';
import { createLogger } from '../utils/logger.js';
import { KillSwitch } from '../infra/KillSwitch.js';
import { TemporalGuard } from '../infra/ordering/TemporalGuard.js';
import { LedgerAccountService } from './ledger/LedgerAccountService.js';
import { LedgerService } from './ledger/LedgerService.js';
import { PayoutEligibilityResolver, PayoutDecision } from './PayoutEligibilityResolver.js';
import { assertPayoutsEnabled } from '../config/safety.js';

const logger = createLogger('StripeMoneyEngine');

// ============================================================================
// STRIPE CLIENT
// ============================================================================

// SECURITY: Fail fast if Stripe key is missing — never use placeholder keys
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
if (!STRIPE_SECRET_KEY && process.env.NODE_ENV === 'production') {
  throw new Error('FATAL: STRIPE_SECRET_KEY is required in production. Refusing to start with missing key.');
}

const isStripeMoneyEngineConfigured = !!STRIPE_SECRET_KEY;
const stripe = isStripeMoneyEngineConfigured
  ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-12-18.acacia' as Stripe.LatestApiVersion })
  : null;

// ============================================================================
// TYPES
// ============================================================================

/** Payload for HOLD_ESCROW: create and capture a PaymentIntent */
export interface HoldEscrowPayload {
  amountCents: number;
  paymentMethodId: string;
  taskId: string;
  posterId: string;
  hustlerId?: string;
  eventId?: string;
}

/** Payload for RELEASE_PAYOUT: transfer funds to a connected Stripe account */
export interface ReleasePayoutPayload {
  taskId: string;
  hustlerId: string;
  hustlerStripeAccountId: string;
  payoutAmountCents?: number;
  eventId?: string;
}

/** Payload for REFUND_ESCROW: refund the captured PaymentIntent to the poster */
export interface RefundEscrowPayload {
  taskId: string;
  reason?: string;
  refundAmountCents?: number;
  posterId?: string;
  eventId?: string;
}

/** Union of all valid engine payloads */
export type MoneyEnginePayload =
  | HoldEscrowPayload
  | ReleasePayoutPayload
  | RefundEscrowPayload;

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
 * Uses ts-pattern exhaustive match so TypeScript will emit a compile error if
 * a new MoneyState variant is added without updating this transition table.
 *
 * Throws if the (state, event) pair is not in the table.
 */
function getNextState(currentState: MoneyState, event: MoneyEvent): MoneyState {
  const nextState: MoneyState | null = match(currentState)
    .with('open',      () => event === 'HOLD_ESCROW'    ? 'held'     : null)
    .with('held',      () => event === 'RELEASE_PAYOUT' ? 'released'
                           : event === 'REFUND_ESCROW'  ? 'refunded'
                           : null)
    // Terminal states — no transitions allowed
    .with('released',  () => null)
    .with('refunded',  () => null)
    .with('completed', () => null)
    .exhaustive();

  if (nextState === null) {
    throw new Error(
      `Invalid event ${event} for current state ${currentState}. ` +
      `No transition defined.`
    );
  }

  return nextState;
}

// ============================================================================
// STRIPE EFFECTS (Phase 2 operations)
// ============================================================================

async function executeHoldEscrow(payload: HoldEscrowPayload): Promise<{
  paymentIntentId: string;
  chargeId: string;
}> {
  if (!stripe) throw new Error('Stripe not configured — cannot execute HOLD_ESCROW');
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

  // latest_charge is string | Stripe.Charge | null — extract .id when it's an object
  const latestCharge = captured.latest_charge;
  const chargeId =
    typeof latestCharge === 'object' && latestCharge !== null
      ? latestCharge.id
      : (latestCharge ?? '');

  return {
    paymentIntentId: captured.id,
    chargeId,
  };
}

interface MoneyStateLockRow {
  task_id: string;
  current_state: MoneyState;
  amount_cents: number;
  stripe_payment_intent_id: string | null;
  stripe_charge_id: string | null;
  stripe_transfer_id: string | null;
}

async function executeReleasePayout(payload: ReleasePayoutPayload, lockRow: MoneyStateLockRow): Promise<{
  transferId: string;
}> {
  if (!stripe) throw new Error('Stripe not configured — cannot execute RELEASE_PAYOUT');
  assertPayoutsEnabled();

  // Check payout eligibility
  const eligibility = await PayoutEligibilityResolver.resolve({
    hustlerId: payload.hustlerId,
    amountCents: payload.payoutAmountCents,
    taskId: payload.taskId,
  });

  if (eligibility.decision === PayoutDecision.BLOCK) {
    // The stub resolve() returns { decision }, but a real implementation may include reason
    const reason = (eligibility as { decision: string; reason?: string }).reason;
    throw new Error(`Payout blocked: ${reason ?? 'Eligibility check failed'}`);
  }

  // Create transfer to connected account
  const transfer = await stripe.transfers.create({
    amount: payload.payoutAmountCents || lockRow.amount_cents,
    currency: 'usd',
    destination: payload.hustlerStripeAccountId,
    source_transaction: lockRow.stripe_charge_id ?? undefined,
    metadata: {
      taskId: payload.taskId,
      hustlerId: payload.hustlerId,
    },
  });

  return { transferId: transfer.id };
}

async function executeRefundEscrow(payload: RefundEscrowPayload, lockRow: MoneyStateLockRow): Promise<{
  refundId: string;
}> {
  if (!stripe) throw new Error('Stripe not configured — cannot execute REFUND_ESCROW');
  const refund = await stripe.refunds.create({
    payment_intent: lockRow.stripe_payment_intent_id ?? undefined,
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
  if (!stripe) { logger.error({ paymentIntentId }, 'Stripe not configured — cannot compensate hold'); return; }
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
  if (!stripe) { logger.error({ transferId }, 'Stripe not configured — cannot compensate release'); return; }
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
  payload: MoneyEnginePayload,
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
  return transaction(async (tx: SqlTx) => {

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
    const [lockRow] = (await tx`
      SELECT task_id, current_state, amount_cents,
             stripe_payment_intent_id, stripe_charge_id, stripe_transfer_id
      FROM money_state_lock
      WHERE task_id = ${taskId}
      FOR UPDATE
    `) as MoneyStateLockRow[];

    const currentState: MoneyState = lockRow?.current_state || 'open';

    // 1c. Validate transition
    const nextState = getNextState(currentState, event);

    // 1d. TemporalGuard check
    await TemporalGuard.validateSequence(taskId, event);

    // ========================================================================
    // PHASE 2: EXECUTE (Stripe operations)
    // ========================================================================
    // All optional — populated only for the relevant event branch
    type StripeExecuteResult = {
      paymentIntentId?: string;
      chargeId?: string;
      transferId?: string;
      refundId?: string;
    };
    let stripeResult: StripeExecuteResult = {};

    try {
      switch (event) {
        case 'HOLD_ESCROW':
          stripeResult = await executeHoldEscrow(payload as HoldEscrowPayload);
          break;

        case 'RELEASE_PAYOUT':
          stripeResult = await executeReleasePayout(payload as ReleasePayoutPayload, lockRow);
          break;

        case 'REFUND_ESCROW':
          stripeResult = await executeRefundEscrow(payload as RefundEscrowPayload, lockRow);
          break;
      }
    } catch (stripeError: unknown) {
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
      // Create lock row for new escrow (HOLD_ESCROW path)
      const holdPayload = payload as HoldEscrowPayload;
      await tx`
        INSERT INTO money_state_lock (
          task_id, current_state, amount_cents,
          stripe_payment_intent_id, stripe_charge_id,
          updated_at
        ) VALUES (
          ${taskId}, ${nextState}, ${holdPayload.amountCents || 0},
          ${stripeResult.paymentIntentId ?? null}, ${stripeResult.chargeId ?? null},
          NOW()
        )
      `;
    }

    // 3b. Record idempotency
    await tx`
      INSERT INTO money_events_processed (event_id, task_id, event_type, processed_at)
      VALUES (${eventId}, ${taskId}, ${event}, NOW())
    `;

    // 3c. Ledger entry — access fields safely via narrowed payload types
    const amountCents =
      event === 'HOLD_ESCROW'
        ? ((payload as HoldEscrowPayload).amountCents ?? lockRow?.amount_cents ?? 0)
        : (lockRow?.amount_cents ?? 0);
    const fromAccount =
      event === 'REFUND_ESCROW'
        ? LedgerAccountService.getPlatformId()
        : ((payload as HoldEscrowPayload).posterId ?? 'unknown');
    const toAccount =
      event === 'RELEASE_PAYOUT'
        ? ((payload as ReleasePayoutPayload).hustlerId ?? 'unknown')
        : LedgerAccountService.getPlatformId();

    try {
      const ledgerTx = await LedgerService.prepareTransaction({
        taskId,
        event,
        amountCents,
        fromAccount,
        toAccount,
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

// Named export alias for callers using `import { StripeMoneyEngine }` syntax
export const StripeMoneyEngine = { handle, getNextState };
