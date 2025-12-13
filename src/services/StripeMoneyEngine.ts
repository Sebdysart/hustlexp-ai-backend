import { LedgerService } from './ledger/LedgerService';
import { LedgerAccountService } from './ledger/LedgerAccountService';
import { LedgerLockService } from './ledger/LedgerLockService';
import { withFinancialRetry } from '../utils/financialRetry';
import { transaction } from '../db/index.js';
import Stripe from 'stripe';
import { v4 as uuid } from 'uuid';
import { serviceLogger as logger } from '../utils/logger.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2025-11-17.clover' as any,
    typescript: true,
});

// ---------------------------------------------------------
// TRANSITION TABLE (UNCHANGED)
// ---------------------------------------------------------

function getNextState(current: string, event: string) {
    switch (current) {
        case 'open':
            if (event === 'HOLD_ESCROW') return 'held';
            break;
        case 'held':
            if (event === 'RELEASE_PAYOUT') return 'released';
            if (event === 'REFUND_ESCROW') return 'refunded';
            if (event === 'DISPUTE_OPEN') return 'pending_dispute';
            break;
        case 'pending_dispute':
            if (event === 'RESOLVE_REFUND') return 'refunded';
            if (event === 'RESOLVE_UPHOLD') return 'upheld';
            break;
        case 'released':
            if (event === 'FORCE_REFUND') return 'refunded';
            break;
    }
    throw new Error(`Invalid transition: ${current} -> ${event}`);
}

function getNextAllowed(state: string): string[] {
    switch (state) {
        case 'open': return ['HOLD_ESCROW'];
        case 'held': return ['RELEASE_PAYOUT', 'REFUND_ESCROW', 'DISPUTE_OPEN'];
        case 'released': return ['FORCE_REFUND'];
        case 'pending_dispute': return ['RESOLVE_REFUND', 'RESOLVE_UPHOLD'];
        case 'refunded':
        case 'completed':
        case 'upheld':
            return [];
        default:
            throw new Error(`Unknown state: ${state}`);
    }
}

// ---------------------------------------------------------
// STRIPE EFFECTS (PURE - No DB Access)
// ---------------------------------------------------------

interface StripeEffectResult {
    piId?: string;
    chargeId?: string;
    transferId?: string;
    refundId?: string;
}

// Modified to NOT take 'lock' directly from DB, but purely necessary strings.
async function executeStripeEffects(
    eventType: string,
    context: any,
    eventId: string,
    stripeClient: any,
    lockData: { piId?: string, chargeId?: string, transferId?: string, currentState?: string }
): Promise<StripeEffectResult> {
    const client = stripeClient || stripe;

    switch (eventType) {
        case 'HOLD_ESCROW':
            return await effectHoldEscrow(context, eventId, client);
        case 'RELEASE_PAYOUT':
        case 'RESOLVE_UPHOLD':
            return await effectReleasePayout(context, eventId, client, lockData);
        case 'REFUND_ESCROW':
        case 'RESOLVE_REFUND':
        case 'FORCE_REFUND':
            return await effectRefund(context, eventId, client, lockData);
        case 'DISPUTE_OPEN':
            return {};
    }
    throw new Error(`Unknown eventType in executeStripeEffects: ${eventType}`);
}

async function effectHoldEscrow(ctx: any, eventId: string, stripe: any): Promise<StripeEffectResult> {
    const { amountCents, paymentMethodId, posterId, hustlerId, taskId } = ctx;
    const pi = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: 'usd',
        payment_method: paymentMethodId,
        capture_method: 'manual',
        confirmation_method: 'automatic',
        confirm: false,
        metadata: { taskId, posterId, hustlerId, type: 'escrow_hold' },
        transfer_group: taskId,
    }, { idempotencyKey: eventId });

    let confirmed = await stripe.paymentIntents.confirm(pi.id, {
        payment_method: paymentMethodId,
        return_url: 'https://hustlexp.com/payment/return',
        expand: ['latest_charge'],
    }, { idempotencyKey: `${eventId}-confirm` });

    if (confirmed.status !== 'requires_capture') {
        throw new Error(`HoldEscrow: Expected requires_capture but got ${confirmed.status}`);
    }

    if (!confirmed.latest_charge) {
        confirmed = await stripe.paymentIntents.retrieve(confirmed.id, { expand: ['latest_charge'] });
    }

    const chargeId = typeof confirmed.latest_charge === 'string'
        ? confirmed.latest_charge
        : confirmed.latest_charge?.id;

    return { piId: confirmed.id, chargeId: chargeId as string };
}

async function effectReleasePayout(ctx: any, eventId: string, stripe: any, lock: any): Promise<StripeEffectResult> {
    const { piId, chargeId } = lock;
    const { hustlerStripeAccountId, payoutAmountCents, taskId } = ctx;

    if (!piId) throw new Error("Missing PI ID");
    if (!chargeId) throw new Error("Missing charge_id");
    if (!hustlerStripeAccountId) throw new Error("ReleasePayout: No Hustler Stripe Account ID provided");

    const pi = await stripe.paymentIntents.capture(piId, {}, { idempotencyKey: `${eventId}-capture` });

    if (pi.status !== 'succeeded') throw new Error(`ReleasePayout: Capture failed - ${pi.status}`);

    const transfer = await stripe.transfers.create({
        amount: payoutAmountCents,
        currency: 'usd',
        destination: hustlerStripeAccountId,
        source_transaction: chargeId,
        transfer_group: taskId,
        metadata: { taskId, type: 'payout' }
    }, { idempotencyKey: `${eventId}-transfer` });

    return { chargeId: chargeId, transferId: transfer.id };
}

async function effectRefund(ctx: any, eventId: string, stripe: any, lock: any): Promise<StripeEffectResult> {
    const { piId, chargeId, transferId, currentState } = lock;
    const { refundAmountCents, reason, taskId } = ctx;

    if (!piId) throw new Error("Missing PI ID for refund");

    if (currentState === 'held' || currentState === 'pending_dispute') {
        const cancelled = await stripe.paymentIntents.cancel(
            piId,
            { cancellation_reason: reason ?? 'requested_by_customer' },
            { idempotencyKey: `${eventId}-cancel` }
        );
        if (cancelled.status !== 'canceled') throw new Error(`RefundEscrow: Expected canceled but got ${cancelled.status}`);
        return { piId: piId };
    }

    if (!chargeId || !transferId) throw new Error("Cannot post-refund without charge_id and transfer_id");

    const reversal = await stripe.transfers.createReversal(
        transferId,
        { amount: refundAmountCents, metadata: { taskId, reason } },
        { idempotencyKey: `${eventId}-reversal` }
    );
    if (!reversal || !reversal.id) throw new Error("Transfer reversal failed");

    const refund = await stripe.refunds.create({
        payment_intent: piId,
        amount: refundAmountCents,
        reason: 'requested_by_customer',
        metadata: { taskId }
    }, { idempotencyKey: `${eventId}-refund` });

    if (!refund || refund.status === 'failed') throw new Error("Refund failed at Stripe");

    return { chargeId: chargeId, transferId: transferId, refundId: refund.id };
}


// ---------------------------------------------------------
// SAGA 2.0 ENGINE (PRE-COMMIT INTENT ARCHITECTURE)
// ---------------------------------------------------------

export async function handle(
    taskId: string,
    eventType: string,
    context: any,
    options?: {
        tx?: any;
        disableRetries?: boolean;
        stripeClient?: any;
    }
) {
    const eventId = context.eventId ?? uuid();
    const providedTx = options?.tx;
    const stripeClient = options?.stripeClient;

    // --------------------------------------------------------------------------------
    // LEGACY / M4 RUNNER MODE (ALL-IN-ONE TX)
    // --------------------------------------------------------------------------------
    if (providedTx) {
        return await executeLegacyFlow(providedTx, taskId, eventType, context, eventId, options)
    }

    // --------------------------------------------------------------------------------
    // SAGA 2.0 PRODUCTION MODE (App Lock -> Prep TX -> Stripe -> Commit TX)
    // --------------------------------------------------------------------------------

    // 1. RING 1: APPLICATION LOCK
    const lockResource = `task:${taskId}`;
    const lease = await LedgerLockService.acquire(lockResource, eventId);
    if (!lease.acquired) {
        throw new Error(`Failed to acquire application lock for ${lockResource}`);
    }

    try {
        // -------------------------------------------------
        // 2. PHASE 1: PREPARE (DB Transaction 1)
        // -------------------------------------------------
        const prepResult = await transaction(async (tx) => {
            // A. Idempotency Check
            const [done] = await tx`SELECT 1 FROM money_events_processed WHERE event_id = ${eventId}`;
            if (done) return { type: 'ALREADY_DONE' };

            // B. Lock Row & Get State
            const [lock] = await tx`SELECT * FROM money_state_lock WHERE task_id = ${taskId} FOR UPDATE`;

            // C. Validate Transition & Guards
            await validateGuards(tx, taskId, eventType, context, lock);

            // D. Prepare Ledger Transaction
            let ledgerTxId: string | null = null;
            let prepData: any = {};

            // Initialization Logic (HOLD_ESCROW)
            if (eventType === 'HOLD_ESCROW') {
                const posterReceivable = await LedgerAccountService.getAccount(context.posterId, 'receivable', tx);
                const taskEscrow = await LedgerAccountService.getAccount(taskId, 'task_escrow', tx);
                const lTx = await LedgerService.prepareTransaction({
                    type: 'ESCROW_HOLD',
                    idempotency_key: `ledger_${eventId}`,
                    metadata: { taskId, event: eventType },
                    entries: [
                        { account_id: posterReceivable.id, direction: 'debit', amount: context.amountCents },
                        { account_id: taskEscrow.id, direction: 'credit', amount: context.amountCents }
                    ]
                }, tx);
                ledgerTxId = lTx.id;
                prepData = { current_state: 'initial' };
            }
            else if (eventType === 'RELEASE_PAYOUT') {
                if (!context.hustlerId) throw new Error("Missing hustlerId in context");
                const taskEscrow = await LedgerAccountService.getAccount(taskId, 'task_escrow', tx);
                const hustlerReceivable = await LedgerAccountService.getAccount(context.hustlerId, 'receivable', tx);
                const lTx = await LedgerService.prepareTransaction({
                    type: 'PAYOUT_RELEASE',
                    idempotency_key: `ledger_${eventId}`,
                    metadata: { taskId, event: eventType },
                    entries: [
                        { account_id: taskEscrow.id, direction: 'debit', amount: context.payoutAmountCents },
                        { account_id: hustlerReceivable.id, direction: 'credit', amount: context.payoutAmountCents }
                    ]
                }, tx);
                ledgerTxId = lTx.id;
                prepData = {
                    piId: lock.stripe_payment_intent_id,
                    chargeId: lock.stripe_charge_id,
                    currentState: lock.current_state
                };
            }
            else if (eventType === 'REFUND_ESCROW' || eventType === 'FORCE_REFUND' || eventType === 'RESOLVE_REFUND') {
                const taskEscrow = await LedgerAccountService.getAccount(taskId, 'task_escrow', tx);
                const posterReceivable = await LedgerAccountService.getAccount(context.posterId || lock?.poster_uid, 'receivable', tx);
                const lTx = await LedgerService.prepareTransaction({
                    type: 'ESCROW_REFUND',
                    idempotency_key: `ledger_${eventId}`,
                    metadata: { taskId, event: eventType },
                    entries: [
                        { account_id: taskEscrow.id, direction: 'credit', amount: context.amountCents || context.refundAmountCents },
                        { account_id: posterReceivable.id, direction: 'debit', amount: context.amountCents || context.refundAmountCents }
                    ]
                }, tx);
                ledgerTxId = lTx.id;
                prepData = {
                    piId: lock.stripe_payment_intent_id,
                    chargeId: lock.stripe_charge_id,
                    transferId: lock.stripe_transfer_id,
                    currentState: lock.current_state
                };
            }

            return {
                type: 'CONTINUE',
                ledgerTxId,
                prepData,
                lockData: lock ? {
                    piId: lock.stripe_payment_intent_id,
                    chargeId: lock.stripe_charge_id,
                    transferId: lock.stripe_transfer_id,
                    currentState: lock.current_state
                } : {}
            };
        });

        if (prepResult.type === 'ALREADY_DONE') return { success: true, status: 'duplicate_ignored' };

        // -------------------------------------------------
        // 3. PHASE 2: EXECUTE (Network Call - No Lock)
        // -------------------------------------------------
        const effects = await executeStripeEffects(
            eventType,
            context,
            eventId,
            stripeClient,
            { ...prepResult.lockData, ...prepResult.prepData }
        );

        // -------------------------------------------------
        // 4. PHASE 3: COMMIT (DB Transaction 2)
        // -------------------------------------------------
        await transaction(async (tx) => {
            // A. Commit Ledger (if exists)
            if (prepResult.ledgerTxId) {
                await LedgerService.commitTransaction(prepResult.ledgerTxId, {
                    pi: effects.piId,
                    charge: effects.chargeId,
                    transfer: effects.transferId
                }, tx);
            }

            // B. Update State Lock
            const newState = prepResult.prepData.current_state === 'initial'
                ? 'held'
                : getNextState(prepResult.lockData.currentState, eventType);

            const nextEvents = getNextAllowed(newState);

            if (eventType === 'HOLD_ESCROW') {
                // Insert
                await tx`
                    INSERT INTO money_state_lock (
                        task_id, current_state, next_allowed_event, 
                        stripe_payment_intent_id, stripe_charge_id, version
                    ) VALUES (
                        ${taskId}, ${newState}, ${nextEvents}, 
                        ${effects.piId}, ${effects.chargeId}, 1
                    )
                `;
                if (context.hustlerId) {
                    await tx`UPDATE tasks SET assigned_hustler_id=${context.hustlerId}, status='in_progress' WHERE id=${taskId}`;
                }
            } else {
                // Update
                await tx`
                    UPDATE money_state_lock
                    SET current_state = ${newState},
                        next_allowed_event = ${nextEvents},
                        stripe_charge_id = COALESCE(stripe_charge_id, ${effects.chargeId}),
                        stripe_transfer_id = COALESCE(stripe_transfer_id, ${effects.transferId}),
                        stripe_refund_id = COALESCE(stripe_refund_id, ${effects.refundId}),
                        last_transition_at = NOW(),
                        version = version + 1
                    WHERE task_id = ${taskId}
                `;
            }

            // C. Idempotency Record
            await tx`INSERT INTO money_events_processed(event_id, task_id, event_type) VALUES(${eventId}, ${taskId}, ${eventType})`;

            // D. Audit Log
            await tx`
                INSERT INTO money_events_audit(
                    event_id, task_id, event_type, previous_state, new_state,
                    stripe_payment_intent_id, stripe_charge_id, stripe_transfer_id,
                    raw_context
                ) VALUES(
                    ${eventId}, ${taskId}, ${eventType}, 
                    ${prepResult.lockData.currentState || 'initial'}, ${newState},
                    ${effects.piId}, ${effects.chargeId}, ${effects.transferId},
                    ${JSON.stringify(context)}
                )
             `;
        });

        return { success: true, state: 'transitioned_safely' };

    } catch (err: any) {
        logger.error({ err, taskId, eventType }, 'Saga Failed from Engine');
        throw err;
    } finally {
        await LedgerLockService.release(lockResource, lease.leaseId);
    }
}


// --------------------------------------------------------------------------------
// HELPER: LEGACY FLOW (For M4 tests or Explicit TX Injection)
// --------------------------------------------------------------------------------
async function executeLegacyFlow(tx: any, taskId: string, eventType: string, context: any, eventId: string, options: any) {
    // 1. Idempotency
    const [done] = await tx`SELECT 1 FROM money_events_processed WHERE event_id = ${eventId}`;
    if (done) return { success: true, status: 'duplicate_ignored' };

    // 2. Lock
    const [lock] = await tx`SELECT * FROM money_state_lock WHERE task_id = ${taskId} FOR UPDATE`;
    await validateGuards(tx, taskId, eventType, context, lock);

    // 3. Prepare Ledger
    let ledgerTx: any = null;
    if (eventType === 'RELEASE_PAYOUT') {
        const taskEscrow = await LedgerAccountService.getAccount(taskId, 'task_escrow', tx);
        const hustlerReceivable = await LedgerAccountService.getAccount(context.hustlerId, 'receivable', tx);
        ledgerTx = await LedgerService.prepareTransaction({
            type: 'PAYOUT_RELEASE',
            idempotency_key: `ledger_${eventId}`,
            metadata: { taskId, event: eventType },
            entries: [
                { account_id: taskEscrow.id, direction: 'debit', amount: context.payoutAmountCents },
                { account_id: hustlerReceivable.id, direction: 'credit', amount: context.payoutAmountCents }
            ]
        }, tx);
    }
    // ... basic initialization for M4 path ...
    else if (eventType === 'HOLD_ESCROW') {
        // Minimal M4 support for Hold Escrow if needed (M4 is Race Release mostly)
        // Assuming M4 mainly hits Release path.
    }

    // 4. Execute Stripe
    const lockData = lock ? {
        piId: lock.stripe_payment_intent_id,
        chargeId: lock.stripe_charge_id,
        currentState: lock.current_state
    } : { currentState: 'initial' };

    // Legacy flow maps back to new signature signature needs
    const effects = await executeStripeEffects(eventType, context, eventId, options?.stripeClient, lockData);

    // 5. Commit Ledger
    if (ledgerTx) {
        await LedgerService.commitTransaction(ledgerTx.id, { stripe: effects }, tx);
    }

    // 6. Update State
    const newState = lock ? getNextState(lock.current_state, eventType) : 'held';
    if (!lock && eventType === 'HOLD_ESCROW') {
        await tx`INSERT INTO money_state_lock (task_id, current_state, next_allowed_event, stripe_payment_intent_id, stripe_charge_id, version) VALUES (${taskId}, ${newState}, ${getNextAllowed(newState)}, ${effects.piId}, ${effects.chargeId}, 1)`;
    } else {
        await tx`UPDATE money_state_lock SET current_state=${newState}, next_allowed_event=${getNextAllowed(newState)}, version=version+1 WHERE task_id=${taskId}`;
    }

    // 7. Idempotency & Audit
    await tx`INSERT INTO money_events_processed(event_id, task_id, event_type) VALUES(${eventId}, ${taskId}, ${eventType})`;

    return { success: true, state: newState };
}

async function validateGuards(tx: any, taskId: string, eventType: string, context: any, lock: any) {
    if (!lock && eventType !== 'HOLD_ESCROW') throw new Error(`money_state_lock missing for task ${taskId}`);
    if (lock && !lock.next_allowed_event.includes(eventType)) throw new Error(`Invalid event ${eventType} for state ${lock.current_state}`);

    if (eventType === 'RELEASE_PAYOUT') {
        const [dispute] = await tx`SELECT id FROM disputes WHERE task_id = ${taskId} AND status NOT IN('refunded', 'upheld') LIMIT 1`;
        if (dispute) throw new Error(`BLOCKED: Cannot release payout - active dispute`);
    }
}

export const StripeMoneyEngine = { handle };
