
import { sql, transaction } from '../db/index.js';
import Stripe from 'stripe';
import { v4 as uuid } from 'uuid';
import { serviceLogger as logger } from '../utils/logger.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2025-11-17.clover' as any, // Using strict version demanded by installed type definitions.
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
            if (event === 'WEBHOOK_PAYOUT_PAID') return 'completed';
            if (event === 'FORCE_REFUND') return 'refunded';
            break;
    }

    throw new Error(`Invalid transition: ${current} -> ${event}`);
}

function getNextAllowed(state: string): string[] {
    switch (state) {
        case 'held': return ['RELEASE_PAYOUT', 'REFUND_ESCROW', 'DISPUTE_OPEN'];
        // Normalized input events in array to match transition table checks? 
        // The skeleton provided by user had lowercase internal names e.g. 'release', 'refund'.
        // But the transition table used UPPERCASE 'RELEASE_PAYOUT'.
        // The handle() logic does: `if (!lock.next_allowed_event.includes(eventType))`
        // So next_allowed_event MUST MATCH eventType strings strictly.
        // User check: "held -> RELEASE_PAYOUT -> released".
        // User skeleton: "case 'held': return ['release', 'refund', 'dispute_open'];"
        // User handle(): "if (!lock.next_allowed_event.includes(eventType))"
        // CONTRADICTION: If eventType is 'RELEASE_PAYOUT' but next_allowed is 'release', it fails.
        // FIX: I will use the UPPERCASE event types in `next_allowed_event` to match `handle()` input.

        // Correction based on Transition Table above:
        case 'open': return ['HOLD_ESCROW'];
        case 'held': return ['RELEASE_PAYOUT', 'REFUND_ESCROW', 'DISPUTE_OPEN'];
        case 'released': return ['WEBHOOK_PAYOUT_PAID', 'FORCE_REFUND'];
        case 'pending_dispute': return ['RESOLVE_REFUND', 'RESOLVE_UPHOLD'];
        // Terminal states
        case 'refunded':
        case 'completed':
        case 'upheld':
            return [];
        default:
            throw new Error(`Unknown state: ${state}`);
    }
}


// ---------------------------------------------------------
// STRIPE EFFECTS IMPLEMENTATIONS
// ---------------------------------------------------------

// Type for effects return
interface StripeEffectResult {
    piId?: string;
    chargeId?: string;
    transferId?: string;
    refundId?: string; // Correcting return type to include refundId
}

async function effectHoldEscrow(lock: any, ctx: any, eventId: string): Promise<StripeEffectResult> {
    const { amountCents, paymentMethodId, posterId, hustlerId, taskId } = ctx;

    // 1. CREATE PI (manual capture)
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

    // 2. CONFIRM PI (Atomic Idempotent Confirm)
    // 2. CONFIRM PI (Atomic Idempotent Confirm)
    let confirmed = await stripe.paymentIntents.confirm(pi.id, {
        payment_method: paymentMethodId,
        return_url: 'https://hustlexp.com/payment/return', // Required for automatic_payment_methods
        expand: ['latest_charge'],
    }, { idempotencyKey: `${eventId}-confirm` });

    if (confirmed.status !== 'requires_capture') {
        // In some flows (instant settlement), it might be succeeded?
        // But for manual capture (escrow), it should be requires_capture.
        throw new Error(`HoldEscrow: Expected requires_capture but got ${confirmed.status}`);
    }

    if (!confirmed.latest_charge) {
        console.log('DEBUG: latest_charge missing, re-fetching PI:', confirmed.id);
        confirmed = await stripe.paymentIntents.retrieve(confirmed.id, { expand: ['latest_charge'] });
    }

    const chargeId = typeof confirmed.latest_charge === 'string'
        ? confirmed.latest_charge
        : confirmed.latest_charge?.id;

    console.log('DEBUG: Final chargeId:', chargeId);

    return {
        piId: confirmed.id, // Must return PI ID to store it
        chargeId: chargeId as string,    // stored in money_state_lock
    };
}

async function effectReleasePayout(lock: any, ctx: any, eventId: string): Promise<StripeEffectResult> {
    const { stripe_payment_intent_id, stripe_charge_id } = lock;
    const { hustlerStripeAccountId, payoutAmountCents, taskId } = ctx;

    if (!stripe_payment_intent_id) throw new Error("Missing PI ID in lock");
    if (!stripe_charge_id) throw new Error("Missing charge_id in lock");

    // 1. CAPTURE PI (idempotent)
    const pi = await stripe.paymentIntents.capture(
        stripe_payment_intent_id,
        {},
        { idempotencyKey: `${eventId}-capture` }
    );

    if (pi.status !== 'succeeded') {
        throw new Error(`ReleasePayout: Capture failed - ${pi.status}`);
    }

    // 2. TRANSFER FUNDS TO HUSTLER
    const transfer = await stripe.transfers.create({
        amount: payoutAmountCents,
        currency: 'usd',
        destination: hustlerStripeAccountId,
        source_transaction: stripe_charge_id,
        transfer_group: taskId,
        metadata: { taskId, type: 'payout' }
    }, { idempotencyKey: `${eventId}-transfer` });

    return {
        chargeId: stripe_charge_id,
        transferId: transfer.id
    };
}

async function effectRefund(lock: any, ctx: any, eventId: string): Promise<StripeEffectResult> {
    const { stripe_payment_intent_id, stripe_charge_id, stripe_transfer_id, current_state } = lock;
    const { refundAmountCents, reason, taskId } = ctx;

    if (!stripe_payment_intent_id) throw new Error("Missing PI ID for refund");

    // -------------------------------------------------------------
    // PATH A — PRE-PAYOUT (held / pending_dispute -> refund)
    // If no transfer has happened yet, we just cancel the PI.
    // -------------------------------------------------------------
    if (current_state === 'held' || current_state === 'pending_dispute') {
        const cancelled = await stripe.paymentIntents.cancel(
            stripe_payment_intent_id,
            { cancellation_reason: reason ?? 'requested_by_customer' },
            { idempotencyKey: `${eventId}-cancel` }
        );

        if (cancelled.status !== 'canceled') {
            throw new Error(`RefundEscrow: Expected canceled but got ${cancelled.status}`);
        }

        return { piId: stripe_payment_intent_id };
    }

    // -------------------------------------------------------------
    // PATH B — POST-PAYOUT (released -> refund)
    // -------------------------------------------------------------
    if (!stripe_charge_id) {
        throw new Error("Cannot post-refund without charge_id");
    }

    if (!stripe_transfer_id) {
        throw new Error("Post-refund missing stripe_transfer_id");
    }

    // 1. REVERSE THE TRANSFER (funds go from Hustler -> Platform)
    const reversal = await stripe.transfers.createReversal(
        stripe_transfer_id,
        { amount: refundAmountCents, metadata: { taskId, reason } },
        { idempotencyKey: `${eventId}-reversal` }
    );

    if (!reversal || !reversal.id) {
        throw new Error("Transfer reversal failed");
    }

    // 2. REFUND THE ORIGINAL CHARGE (Platform -> Poster)
    const refund = await stripe.refunds.create({
        payment_intent: stripe_payment_intent_id,
        amount: refundAmountCents,
        reason: 'requested_by_customer',
        metadata: { taskId }
    }, { idempotencyKey: `${eventId}-refund` });

    if (!refund || refund.status === 'failed') {
        throw new Error("Refund failed at Stripe");
    }

    // Return current IDs to keep state consistent? 
    // Wait, getNextState logic handles the state transition. 
    // We just return IDs if they changed.
    // For refund, we might want to store refundId?
    return {
        chargeId: stripe_charge_id,
        transferId: stripe_transfer_id,
        refundId: refund.id
    };
}

async function executeStripeEffects(lock: any, event: string, ctx: any, eventId: string): Promise<StripeEffectResult> {

    switch (event) {

        case 'HOLD_ESCROW':
            return await effectHoldEscrow(lock, ctx, eventId);


        case 'RELEASE_PAYOUT':
        case 'RESOLVE_UPHOLD':
            return await effectReleasePayout(lock, ctx, eventId);

        case 'REFUND_ESCROW':
        case 'RESOLVE_REFUND':
        case 'FORCE_REFUND':
            return await effectRefund(lock, ctx, eventId);

        case 'WEBHOOK_PAYOUT_PAID':
        case 'DISPUTE_OPEN':
            // No Stripe effects for these state changes (internal logic only)
            return {};
    }

    throw new Error(`Unknown eventType in executeStripeEffects: ${event}`);
}


// ---------------------------------------------------------
// THE MAIN ENGINE ENTRY POINT
// ---------------------------------------------------------

export async function handle(taskId: string, eventType: string, context: any) {
    const eventId = context.eventId ?? uuid();

    return await transaction(async (tx) => {

        // IDEMPOTENCY CHECK
        // tx is now our tag function wrapper
        const [done] = await tx`
      SELECT 1 FROM money_events_processed WHERE event_id = ${eventId}
    `;
        if (done) return { success: true, status: 'duplicate_ignored' };

        // LOCK THE STATE ROW
        // Note: tx tag function returns any[], we destructure [lock]
        const [lock] = await tx`
      SELECT * FROM money_state_lock WHERE task_id = ${taskId} FOR UPDATE
    `;

        // INITIALIZATION PATH (HOLD_ESCROW only)
        if (!lock) {
            if (eventType !== 'HOLD_ESCROW') {
                throw new Error(`money_state_lock missing for task ${taskId}`);
            }

            // Execute creation effects (Create PI)
            // Mock empty lock for first pass, checking event type explicitly
            const effects = await executeStripeEffects({ current_state: 'initial' }, eventType, context, eventId);

            // Initial state is ALWAYS 'held' after HOLD_ESCROW
            const newState = 'held';
            const nextEvents = getNextAllowed(newState);

            await tx`
                INSERT INTO money_state_lock (
                    task_id, 
                    current_state, 
                    next_allowed_event, 
                    stripe_payment_intent_id,
                    stripe_charge_id,
                    version
                ) VALUES (
                    ${taskId}, 
                    ${newState}, 
                    ${nextEvents}, 
                    ${effects.piId}, 
                    ${effects.chargeId},
                    1
                )
            `;

            // Assign hustler and update status
            if (context.hustlerId) {
                await tx`
                    UPDATE tasks 
                    SET assigned_hustler_id = ${context.hustlerId},
                        status = 'in_progress',
                        updated_at = NOW()
                    WHERE id = ${taskId}
                `;
            }

            // IDEMPOTENCY RECORD
            await tx`
                INSERT INTO money_events_processed (event_id, task_id, event_type)
                VALUES (${eventId}, ${taskId}, ${eventType})
            `;

            // AUDIT LOG (Phase 5A - Immutable Evidence Layer)
            await tx`
                INSERT INTO money_events_audit (
                    event_id, task_id,
                    actor_uid, event_type,
                    previous_state, new_state,
                    stripe_payment_intent_id, stripe_charge_id, stripe_transfer_id,
                    raw_context
                ) VALUES (
                    ${eventId}, ${taskId},
                    ${context.actorUid ?? null}, ${eventType},
                    'initial', ${newState},
                    ${effects.piId}, ${effects.chargeId ?? null}, ${null},
                    ${JSON.stringify(context)}
                )
            `;

            return { success: true, state: newState };
        }

        // --- EXISTING LOCK PATH ---

        // VALIDATE USER ACTION (next_allowed_event)
        // Neon returns array as string[] usually.
        if (!lock.next_allowed_event.includes(eventType)) {
            throw new Error(`Invalid event ${eventType} for state ${lock.current_state}`);
        }

        // ============================================
        // PHASE 5B: ENGINE-LEVEL TRANSITION GUARDS
        // These guards are the FINAL enforcement layer.
        // Route/controller guards are advisory - ENGINE is authoritative.
        // ============================================

        // GUARD 1: Reject events on terminal states (defense in depth)
        const TERMINAL_STATES = ['refunded', 'completed', 'upheld'];
        if (TERMINAL_STATES.includes(lock.current_state)) {
            throw new Error(`BLOCKED: State ${lock.current_state} is terminal. No further transitions allowed.`);
        }

        // GUARD 2: Block RELEASE_PAYOUT if dispute exists
        if (eventType === 'RELEASE_PAYOUT') {
            const [dispute] = await tx`
                SELECT id, status FROM disputes 
                WHERE task_id = ${taskId} AND status NOT IN ('refunded', 'upheld')
                LIMIT 1
            `;
            if (dispute) {
                throw new Error(`BLOCKED: Cannot release payout - active dispute ${dispute.id} exists for task ${taskId}`);
            }
        }

        // GUARD 3: Validate dispute exists before RESOLVE_* events
        if (eventType === 'RESOLVE_REFUND' || eventType === 'RESOLVE_UPHOLD') {
            const [dispute] = await tx`
                SELECT id, status FROM disputes 
                WHERE task_id = ${taskId} AND status IN ('pending', 'under_review')
                LIMIT 1
            `;
            if (!dispute) {
                throw new Error(`BLOCKED: Cannot resolve - no pending dispute found for task ${taskId}`);
            }
        }

        // GUARD 4: Validate hustler exists before payout (anti-fraud)
        if (eventType === 'RELEASE_PAYOUT' || eventType === 'RESOLVE_UPHOLD') {
            const [task] = await tx`
                SELECT assigned_hustler_id FROM tasks WHERE id = ${taskId}
            `;
            if (!task || !task.assigned_hustler_id) {
                throw new Error(`BLOCKED: Cannot payout - no assigned hustler for task ${taskId}`);
            }
        }

        // ============================================
        // END PHASE 5B GUARDS
        // ============================================

        // ============================================
        // PHASE 5D: ADMIN VALIDATION HARDENING
        // Prevents admin fraud, conflict of interest, and forged actions.
        // ============================================

        const ADMIN_EVENTS = ['RESOLVE_REFUND', 'RESOLVE_UPHOLD', 'FORCE_REFUND'];

        if (ADMIN_EVENTS.includes(eventType)) {
            // GUARD 5: Admin identity MUST be provided
            if (!context.adminUid) {
                throw new Error(`BLOCKED: Admin event ${eventType} requires adminUid in context`);
            }

            // GUARD 6: Fetch task ownership for conflict check
            const [task] = await tx`
                SELECT t.client_id, t.assigned_hustler_id, u1.firebase_uid as poster_uid, u2.firebase_uid as hustler_uid
                FROM tasks t
                LEFT JOIN users u1 ON t.client_id = u1.id
                LEFT JOIN users u2 ON t.assigned_hustler_id = u2.id
                WHERE t.id = ${taskId}
            `;

            if (!task) {
                throw new Error(`BLOCKED: Task ${taskId} not found for admin validation`);
            }

            // GUARD 7: Admin cannot be poster or hustler (conflict of interest)
            if (context.adminUid === task.poster_uid || context.adminUid === task.hustler_uid) {
                throw new Error(`BLOCKED: Admin ${context.adminUid} is a party to this task - conflict of interest`);
            }

            // AUDIT: Log admin action BEFORE executing (pre-audit)
            await tx`
                INSERT INTO admin_actions (
                    admin_uid, action, target_uid, task_id, dispute_id, raw_context
                ) VALUES (
                    ${context.adminUid},
                    ${eventType},
                    ${task.hustler_uid ?? task.poster_uid},
                    ${taskId},
                    ${context.disputeId ?? null},
                    ${JSON.stringify({
                previous_state: lock.current_state,
                triggered_at: new Date().toISOString(),
                reason: context.reason ?? 'Not provided'
            })}
                )
            `;

            logger.info({
                adminUid: context.adminUid,
                eventType,
                taskId,
                previousState: lock.current_state,
            }, 'Admin action validated and logged');
        }

        // ============================================
        // END PHASE 5D GUARDS
        // ============================================

        // DETERMINE NEXT STATE
        const newState = getNextState(lock.current_state, eventType);
        const nextEvents = getNextAllowed(newState);

        // STRIPE SIDE EFFECT
        const effects = await executeStripeEffects(lock, eventType, context, eventId);

        // STATE TRANSITION WRITE
        await tx`
      UPDATE money_state_lock
      SET current_state = ${newState},
          next_allowed_event = ${nextEvents},
          stripe_charge_id = COALESCE(stripe_charge_id, ${effects?.chargeId}),
          stripe_transfer_id = COALESCE(stripe_transfer_id, ${effects?.transferId}),
          stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ${effects?.piId}),
          stripe_refund_id = COALESCE(stripe_refund_id, ${effects?.refundId}),
          last_transition_at = NOW(),
          version = version + 1
      WHERE task_id = ${taskId}
    `;

        // AUDIT LOG (Phase 5A - Immutable Evidence Layer)
        await tx`
            INSERT INTO money_events_audit (
                event_id, task_id,
                actor_uid, event_type,
                previous_state, new_state,
                stripe_payment_intent_id, stripe_charge_id, stripe_transfer_id,
                raw_context
            ) VALUES (
                ${eventId}, ${taskId},
                ${context.actorUid ?? null}, ${eventType},
                ${lock.current_state}, ${newState},
                ${effects?.piId ?? lock.stripe_payment_intent_id}, 
                ${effects?.chargeId ?? lock.stripe_charge_id}, 
                ${effects?.transferId ?? lock.stripe_transfer_id},
                ${JSON.stringify(context)}
            )
        `;

        // IDEMPOTENCY RECORD
        await tx`
      INSERT INTO money_events_processed (event_id, task_id, event_type)
      VALUES (${eventId}, ${taskId}, ${eventType})
    `;


        return { success: true, state: newState };
    });
}

export const StripeMoneyEngine = { handle };
