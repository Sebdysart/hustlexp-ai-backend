
import { SourceGuard } from './SourceGuard';
import { ReplayGuard } from './ReplayGuard';
import { SettlementGuard } from './SettlementGuard';
import { MoneyPathGuard } from './MoneyPathGuard';
import { TemporalGuard } from './TemporalGuard';
import { serviceLogger } from '../../utils/logger';
import { KillSwitch } from '../KillSwitch';
import Stripe from 'stripe';

/**
 * ORDERING GATE (OMEGA PHASE 5)
 * 
 * THE FIREWALL.
 * Orchestrates all Hard Mode Guards.
 * 
 * Usage:
 * const event = OrderingGate.ingress(req.headers, req.body);
 * if (!event) return 200; // Blocked safely
 */

const logger = serviceLogger.child({ module: 'OrderingGate' });

export class OrderingGate {

    /**
     * INGRESS GATE
     * Run this immediately upon receiving a Webhook.
     * @returns Stripe.Event if Safe, NULL if Blocked (Safe to ignore).
     * @throws Error only if Signature fails (400 Bad Request).
     */
    static async ingress(signature: string, rawBody: string | Buffer, internalEventId: string): Promise<Stripe.Event | null> {

        // PHASE 8B: KILLSWITCH GLOBAL FREEZE
        if (await KillSwitch.isActive()) {
            logger.warn('KillSwitch Active: Rejecting Ingress');
            return null; // Block Ingress safely
        }

        // 1. SOURCE GUARD (Auth) - Throws on failure
        const event = SourceGuard.validate(signature, rawBody);

        // 2. REPLAY GUARD (Dedupe)
        if (await ReplayGuard.isDuplicate(internalEventId, event.id)) {
            return null;
        }

        // 3. SETTLEMENT GUARD (Scope)
        if (!SettlementGuard.shouldProcessForLedger(event.type)) {
            return null;
        }

        // 4. MONEY PATH GUARD (Validation)
        // Check data.object
        const object = event.data.object as any;
        if (!MoneyPathGuard.validatePayload(object)) {
            return null;
        }

        // 5. TEMPORAL GUARD (Time Travel)
        // Requires Task ID
        const taskId = MoneyPathGuard.getTaskId(event);

        // PHASE 8B: LATE ARRIVAL & GAP DETECTION
        if (event.created) {
            const delaySeconds = Math.floor(Date.now() / 1000) - event.created;
            if (delaySeconds > 600) { // 10 Minutes
                logger.warn({
                    delaySeconds,
                    eventId: event.id,
                    created: new Date(event.created * 1000).toISOString()
                }, '⚠️ LATE ARRIVAL DETECTED (>10m drift). Inspect for Gap/Outage.');
            }
        }

        if (taskId) {
            // Audit Log for Sequence Tracking
            logger.info({ taskId, internalEventId }, 'Sequence Audit: Enforcing Monotonicity');

            // If Task ID present, enforce strict temporal ordering for that Task.
            const isSafe = await TemporalGuard.validateSequence(taskId, internalEventId);
            if (!isSafe) {
                return null;
            }
        }

        logger.info({ type: event.type, id: event.id, internalId: internalEventId }, '🛡️ Ordering Gate: PASSED');
        return event;
    }
}
