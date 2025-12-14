import { KillSwitch } from '../infra/KillSwitch.js';
import { LedgerAccountService } from './ledger/LedgerAccountService.js';
import { LedgerLockService } from './ledger/LedgerLockService.js';
import { transaction, sql } from '../db/index.js';
import Stripe from 'stripe';
import { v4 as uuid } from 'uuid';
import { serviceLogger as logger } from '../utils/logger.js';
import { TemporalGuard } from '../infra/ordering/TemporalGuard.js';
import { LedgerService } from './ledger/LedgerService.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
    apiVersion: '2025-11-17.clover', // Update to match types
    typescript: true,
});

// ---------------------------------------------------------
// TRANSITION TABLE
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
        case 'initial': // For new tasks
            if (event === 'HOLD_ESCROW') return 'held';
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
        case 'initial': return ['HOLD_ESCROW'];
        default:
            throw new Error(`Unknown state: ${state}`);
    }
}

// ---------------------------------------------------------
// STRIPE EFFECTS (PURE)
// ---------------------------------------------------------

interface StripeEffectResult {
    piId?: string;
    chargeId?: string;
    transferId?: string;
    refundId?: string;
}

async function logOutbound(key: string, stripeId: string, type: string, payload: any) {
    await sql`
    INSERT INTO stripe_outbound_log (idempotency_key, stripe_id, type, payload)
    VALUES (${key}, ${stripeId}, ${type}, ${payload})
    ON CONFLICT (idempotency_key) DO NOTHING
`;
}

async function effectHoldEscrow(ctx: any, eventId: string, stripeClient: any): Promise<StripeEffectResult> {
    const { amountCents, paymentMethodId, posterId, hustlerId, taskId } = ctx;

    if (!amountCents || !paymentMethodId) throw new Error("HoldEscrow: Missing amount or payment method");

    const pi = await stripeClient.paymentIntents.create({
        amount: amountCents,
        currency: 'usd',
        payment_method: paymentMethodId,
        capture_method: 'manual',
        confirmation_method: 'automatic',
        confirm: false,
        metadata: { taskId, posterId, hustlerId, type: 'escrow_hold' },
        transfer_group: taskId,
    }, { idempotencyKey: eventId });

    let confirmed = await stripeClient.paymentIntents.confirm(pi.id, {
        payment_method: paymentMethodId,
        return_url: 'https://hustlexp.com/payment/return',
        expand: ['latest_charge'],
    }, { idempotencyKey: `${eventId}-confirm` });

    if (confirmed.status !== 'requires_capture') {
        throw new Error(`HoldEscrow: Expected requires_capture but got ${confirmed.status}`);
    }

    if (!confirmed.latest_charge) {
        confirmed = await stripeClient.paymentIntents.retrieve(confirmed.id, { expand: ['latest_charge'] });
    }

    const chargeId = typeof confirmed.latest_charge === 'string'
        ? confirmed.latest_charge
        : confirmed.latest_charge?.id;

    return { piId: confirmed.id, chargeId: chargeId as string };
}

async function effectReleasePayout(ctx: any, eventId: string, stripeClient: any, lock: any): Promise<StripeEffectResult> {
    const { piId, chargeId } = lock;
    const { hustlerStripeAccountId, payoutAmountCents, taskId } = ctx;

    if (!piId) throw new Error("Missing PI ID");
    if (!chargeId) throw new Error("Missing charge_id");
    if (!hustlerStripeAccountId) throw new Error("ReleasePayout: No Hustler Stripe Account ID provided");

    const pi = await stripeClient.paymentIntents.capture(piId, {}, { idempotencyKey: `${eventId}-capture` });

    if (pi.status !== 'succeeded') throw new Error(`ReleasePayout: Capture failed - ${pi.status}`);

    const transfer = await stripeClient.transfers.create({
        amount: payoutAmountCents,
        currency: 'usd',
        destination: hustlerStripeAccountId,
        source_transaction: chargeId,
        transfer_group: taskId,
        metadata: { taskId, type: 'payout' }
    }, { idempotencyKey: `${eventId}-transfer` });

    return { chargeId: chargeId, transferId: transfer.id };
}

async function effectRefund(ctx: any, eventId: string, stripeClient: any, lock: any): Promise<StripeEffectResult> {
    const { piId, chargeId, transferId, currentState } = lock;
    const { refundAmountCents, reason, taskId } = ctx;

    if (!piId) throw new Error("Missing PI ID for refund");

    if (currentState === 'held' || currentState === 'pending_dispute') {
        const cancelled = await stripeClient.paymentIntents.cancel(
            piId,
            { cancellation_reason: reason ?? 'requested_by_customer' },
            { idempotencyKey: `${eventId}-cancel` }
        );
        if (cancelled.status !== 'canceled') throw new Error(`RefundEscrow: Expected canceled but got ${cancelled.status}`);
        return { piId: piId };
    }

    if (!chargeId || !transferId) throw new Error("Cannot post-refund without charge_id and transfer_id");

    const reversal = await stripeClient.transfers.createReversal(
        transferId,
        { amount: refundAmountCents, metadata: { taskId, reason } },
        { idempotencyKey: `${eventId}-reversal` }
    );
    if (!reversal || !reversal.id) throw new Error("Transfer reversal failed");

    const refund = await stripeClient.refunds.create({
        payment_intent: piId,
        amount: refundAmountCents,
        reason: 'requested_by_customer',
        metadata: { taskId }
    }, { idempotencyKey: `${eventId}-refund` });

    if (!refund || refund.status === 'failed') throw new Error("Refund failed at Stripe");

    return { chargeId: chargeId, transferId: transferId, refundId: refund.id };
}

async function executeStripeEffects(
    eventType: string,
    context: any,
    eventId: string,
    stripeClient: any,
    lockData: { piId?: string, chargeId?: string, transferId?: string, currentState?: string }
): Promise<StripeEffectResult> {
    const client = stripeClient || stripe;

    // PHASE 8B: SPLIT-BRAIN GUARD (Execute Once or Never)
    const [mirror] = await sql`SELECT * FROM stripe_outbound_log WHERE idempotency_key = ${eventId}`;

    if (mirror) {
        logger.warn({ eventId, stripeId: mirror.stripe_id }, 'Split-Brain Guard: Returned result from Mirror (Stripe Executed, DB Missed)');
        if (mirror.type === 'pi') return { piId: mirror.stripe_id, chargeId: mirror.payload?.chargeId };
        if (mirror.type === 'transfer') return { transferId: mirror.stripe_id };
        if (mirror.type === 'refund') return { refundId: mirror.stripe_id };
        // Fallback
        return { [mirror.type === 'pi' ? 'piId' : 'transferId']: mirror.stripe_id };
    }

    let result: StripeEffectResult;

    switch (eventType) {
        case 'HOLD_ESCROW':
            result = await effectHoldEscrow(context, eventId, client);
            await logOutbound(eventId, result.piId!, 'pi', { chargeId: result.chargeId });
            break;
        case 'RELEASE_PAYOUT':
        case 'RESOLVE_UPHOLD':
            result = await effectReleasePayout(context, eventId, client, lockData);
            await logOutbound(eventId, result.transferId!, 'transfer', {});
            break;
        case 'REFUND_ESCROW':
        case 'RESOLVE_REFUND':
        case 'FORCE_REFUND':
            result = await effectRefund(context, eventId, client, lockData);
            await logOutbound(eventId, result.refundId!, 'refund', {});
            break;
        case 'DISPUTE_OPEN':
            result = {};
            break;
        default:
            throw new Error(`Unknown eventType in executeStripeEffects: ${eventType}`);
    }

    return result;
}

async function validateGuards(tx: any, taskId: string, eventType: string, context: any, lock: any, eventId: string) {
    // 1. Invariant Checks
    if (!lock && eventType !== 'HOLD_ESCROW') throw new Error(`money_state_lock missing for task ${taskId}`);
    if (lock && !lock.next_allowed_event.includes(eventType)) throw new Error(`Invalid event ${eventType} for state ${lock.current_state}`);

    // 2. Temporal Guard (Time Travel Check)
    const isSafe = await TemporalGuard.validateSequence(taskId, eventId);
    if (!isSafe) {
        throw new Error(`Temporal Guard Blocked: Event ${eventId} is older than last committed state.`);
    }

    if (eventType === 'RELEASE_PAYOUT') {
        const [dispute] = await tx`SELECT id FROM disputes WHERE task_id = ${taskId} AND status NOT IN('refunded', 'upheld') LIMIT 1`;
        if (dispute) throw new Error(`BLOCKED: Cannot release payout - active dispute`);
    }
}

// ---------------------------------------------------------
// SAGA 3.0 ENGINE (ATOMIC HARDENING)
// ---------------------------------------------------------

// SAGA 3.0 ENGINE (ATOMIC HARDENING)
// ---------------------------------------------------------

export async function handle(
    taskId: string,
    eventType: string,
    context: any,
    options?: {
        tx?: any;
        disableRetries?: boolean;
        stripeClient?: any;
        eventId?: string; // Move eventId here or generate
    }
) {
    // PHASE 8B: KILLSWITCH GLOBAL FREEZE
    if (await KillSwitch.isActive()) {
        throw new Error('KILLSWITCH ENGAGED: Money Engine Frozen.');
    }

    const eventId = options?.eventId ?? uuid();
    const providedTx = options?.tx;
    const stripeClient = options?.stripeClient;

    // SAGA 3.0: APP LOCK (Batch)
    const resourcesToLock = [`task:${taskId}`];
    if (context.posterId) resourcesToLock.push(`user:${context.posterId}`);
    if (context.hustlerId) resourcesToLock.push(`user:${context.hustlerId}`);

    const lease = await LedgerLockService.acquireBatch(resourcesToLock, eventId);
    if (!lease.acquired) {
        throw new Error(`Failed to acquire application lock for ${resourcesToLock.join(', ')}`);
    }

    let preparedLedgerTxId: string | null = null;
    let preparationPayload: any = null;

    try {
        // -------------------------------------------------
        // 1. PHASE 1: PREPARE (DB Transaction 1)
        // -------------------------------------------------
        const prepResult = await transaction(async (tx) => {
            // A. Idempotency Check
            const [done] = await tx`SELECT 1 FROM money_events_processed WHERE event_id = ${eventId}`;
            if (done) return { type: 'ALREADY_DONE' };

            // B. Lock Row & Get State
            const [lock] = await tx`SELECT * FROM money_state_lock WHERE task_id = ${taskId} FOR UPDATE`;

            // C. Validate Guards
            await validateGuards(tx, taskId, eventType, context, lock, eventId);

            // D. Prepare Ledger Transaction
            let ledgerTxId: string | null = null;
            let prepData: any = {};

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
            else if (['REFUND_ESCROW', 'FORCE_REFUND', 'RESOLVE_REFUND'].includes(eventType)) {
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
            // NEW: DISPUTE LOGIC (Phase 9C)
            else if (eventType === 'DISPUTE_OPEN') {
                const taskEscrow = await LedgerAccountService.getAccount(taskId, 'task_escrow', tx);
                // We move funds to specific Platform Hold to freeze them from automated release logic
                const disputeHold = await LedgerAccountService.getAccount(LedgerAccountService.getPlatformId(), 'platform_dispute_hold', tx);

                // Get Amount from context or infer from lock?? 
                // Currently context usually has logic. We assume Full Hold.
                // We need to know the amount in escrow. Snapshots? or pass in context?
                // For Alpha/Beta, we just pass amounts.
                if (!context.amountCents) throw new Error("DISPUTE_OPEN requires amountCents");

                const lTx = await LedgerService.prepareTransaction({
                    type: 'DISPUTE_HOLD', // New Type
                    idempotency_key: `ledger_${eventId}`,
                    metadata: { taskId, event: eventType },
                    entries: [
                        { account_id: taskEscrow.id, direction: 'debit', amount: context.amountCents },
                        { account_id: disputeHold.id, direction: 'credit', amount: context.amountCents }
                    ]
                }, tx);
                ledgerTxId = lTx.id;
                prepData = {
                    currentState: lock.current_state,
                    holdAmount: context.amountCents
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

        // CAPTURE STATE FOR COMPENSATION
        preparedLedgerTxId = prepResult.ledgerTxId;
        preparationPayload = { ...prepResult.lockData, ...prepResult.prepData };

        // ============================================================
        // CRASH TEST #1: After PREPARE, before EXECUTE STRIPE
        // ============================================================
        if (process.env.CRASH_AFTER_PREPARE === '1') {
            console.error('[CRASH TEST] Crashing after PREPARE');
            console.error('[CRASH TEST] Prepared Ledger TX:', preparedLedgerTxId);
            process.exit(137);
        }

        // -------------------------------------------------
        // 2. PHASE 2: EXECUTE (Network Call)
        // -------------------------------------------------
        // If Logic reaches here, we have a PENDING ledger transaction and DB is clean.
        // We EXECUTE Stripe effects.

        const effects = await executeStripeEffects(
            eventType,
            context,
            eventId,
            stripeClient,
            preparationPayload
        );

        // ============================================================
        // CRASH TEST INJECTION POINT (REMOVE AFTER TESTING)
        // This is the exact worst moment: Stripe succeeded, ledger not committed
        // ============================================================
        if (process.env.CRASH_TEST === 'AFTER_STRIPE_BEFORE_LEDGER') {
            console.error('[CRASH TEST] Simulated crash after Stripe success');
            console.error('[CRASH TEST] Stripe effects:', JSON.stringify(effects));
            console.error('[CRASH TEST] Ledger TX ID:', preparedLedgerTxId);
            process.exit(137);
        }

        // -------------------------------------------------
        // 3. PHASE 3: COMMIT (DB Transaction 2)
        // -------------------------------------------------
        await transaction(async (tx) => {
            // A. Commit Ledger
            if (preparedLedgerTxId) {
                await LedgerService.commitTransaction(preparedLedgerTxId, {
                    pi: effects.piId,
                    charge: effects.chargeId,
                    transfer: effects.transferId
                }, tx);
            }

            // B. Update State Lock
            const newState = preparationPayload.current_state === 'initial'
                ? 'held'
                : getNextState(preparationPayload.currentState, eventType);

            const nextEvents = getNextAllowed(newState);

            if (eventType === 'HOLD_ESCROW') {
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
                    ${preparationPayload.currentState || 'initial'}, ${newState},
                    ${effects.piId}, ${effects.chargeId}, ${effects.transferId},
                    ${JSON.stringify(context)}
                )
             `;
        });

        return { success: true, state: 'transitioned_safely' };

    } catch (err: any) {
        logger.error({ err, taskId, eventType }, 'Saga Failed - Initiating Compensation Flow');

        // -------------------------------------------------
        // 4. COMPENSATION FLOW (Saga 3.0)
        // -------------------------------------------------
        if (preparedLedgerTxId) {
            try {
                // 1. Mark Ledger Transaction as Failed
                await sql`UPDATE ledger_transactions SET status = 'failed', metadata = jsonb_set(metadata, '{failure_reason}', ${JSON.stringify(err.message)}) WHERE id = ${preparedLedgerTxId}`;

                // 2. Add to DLQ
                const nextRetry = new Date(Date.now() + 60 * 1000);

                await sql`
                    INSERT INTO ledger_pending_actions (
                        transaction_id, type, payload, error_log, status, next_retry_at
                    ) VALUES (
                        ${preparedLedgerTxId}, ${eventType === 'RELEASE_PAYOUT' ? 'COMMIT_TX' : 'MANUAL_REVIEW'}, 
                        ${JSON.stringify({ taskId, eventType, context, stripe_metadata: preparationPayload })},
                        ${err.message}, 'pending', ${nextRetry}
                    )
                `;
                logger.info({ preparedLedgerTxId }, 'Compensation: Marked Pending Tx Failed & Enqueued DLQ');

            } catch (compError) {
                logger.fatal({ compError, originalError: err }, 'CRITICAL: Compensation Flow Failed!');
            }
        }

        throw err;
    } finally {
        // Release ALL locks using batch release logic (iteration)
        if (resourcesToLock && lease?.leaseId) {
            await Promise.all(resourcesToLock.map(res => LedgerLockService.release(res, lease.leaseId)));
        }
    }
}

export const StripeMoneyEngine = { handle };
