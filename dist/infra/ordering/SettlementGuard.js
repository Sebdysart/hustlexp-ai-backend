import { serviceLogger } from '../../utils/logger.js';
/**
 * SETTLEMENT GUARD (OMEGA PHASE 5)
 *
 * Separation of Concerns:
 * - Stripe Payouts != Internal Ledger Movement.
 * - Stripe Transfers = Internal Ledger Movement (usually).
 *
 * Rules:
 * - 'payout.*' events are LOGGED/IGNORED for Ledger State (unless Payout Failure reversal).
 * - 'transfer.*' events are PROCESSED.
 */
const logger = serviceLogger.child({ module: 'SettlementGuard' });
export class SettlementGuard {
    static shouldProcessForLedger(eventType) {
        if (eventType.startsWith('payout.')) {
            if (eventType === 'payout.failed') {
                return true; // Reversal needed
            }
            logger.info({ eventType }, 'Settlement Guard: Ignoring Bank Payout Event (Banking Layer)');
            return false;
        }
        if (eventType.startsWith('transfer.'))
            return true;
        if (eventType.startsWith('payment_intent.'))
            return true;
        if (eventType.startsWith('charge.'))
            return true;
        return false; // Default safe
    }
}
//# sourceMappingURL=SettlementGuard.js.map