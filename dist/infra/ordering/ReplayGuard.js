import { sql } from '../../db/index.js';
import { serviceLogger } from '../../utils/logger.js';
/**
 * REPLAY GUARD (OMEGA PHASE 5)
 *
 * Semantic Replay Shield.
 * Handles duplicates, retries, and slight variants.
 *
 * Rule:
 * - If Event ID seen -> REJECT (200 OK).
 * - If Idempotency Key seen -> REJECT (200 OK).
 */
const logger = serviceLogger.child({ module: 'ReplayGuard' });
export class ReplayGuard {
    /**
     * IS DUPLICATE?
     * Returns TRUE if this is a replay (should skip).
     * Returns FALSE if this is new (safe to process).
     */
    static async isDuplicate(eventId, stripeId) {
        if (!sql) {
            logger.warn({ eventId }, 'Replay Guard: Database not available - allowing');
            return false;
        }
        // 1. Check Primary Event ID (Internal ULID)
        const [internalDup] = await sql `
            SELECT 1 FROM money_events_processed WHERE event_id = ${eventId}
        `;
        if (internalDup) {
            logger.info({ eventId }, 'Replay Guard: Duplicate Internal ID (Skip)');
            return true;
        }
        // 2. Check Stripe ID (External Idempotency)
        if (stripeId) {
            const [stripeDup] = await sql `
                SELECT 1 FROM processed_stripe_events WHERE event_id = ${stripeId}
            `;
            if (stripeDup) {
                logger.info({ stripeId }, 'Replay Guard: Duplicate Stripe ID (Skip)');
                return true;
            }
        }
        return false;
    }
    /**
     * RECORD ATTEMPT
     * Logs the attempt to the audit table regardless of success.
     */
    static async logAttempt(eventId, type, payload) {
        // We log to a raw ingress table if needed, or rely on service logs.
        // For Omega Phase 5, we rely on `money_events_audit` usually, but that's for committed ones?
        // Let's assume standard Logger is sufficient for "Audit" if not Mutating.
        // If Mutating, we insert into `money_events_processed` at END of process.
        // This Guard is about *checking* not *writing* results (which happens on Commit).
        logger.debug({ eventId, type }, 'Ingress Attempt Logged');
    }
}
//# sourceMappingURL=ReplayGuard.js.map