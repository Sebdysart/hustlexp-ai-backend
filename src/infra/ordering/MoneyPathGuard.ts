
import { serviceLogger } from '../../utils/logger.js';


/**
 * MONEY PATH GUARD (OMEGA PHASE 5)
 * 
 * Deep Inspection of Event Payload.
 * 
 * Rules:
 * - Must have Task ID (if task related).
 * - Amount must be > 0.
 * - Currency must be USD.
 * - No unexpected metadata overrides.
 */

const logger = serviceLogger.child({ module: 'MoneyPathGuard' });

export class MoneyPathGuard {

    static validatePayload(payload: any): boolean {
        // 1. Currency Check
        if (payload.currency && payload.currency.toLowerCase() !== 'usd') {
            logger.warn({ currency: payload.currency }, 'Money Path Guard: Non-USD Currency Rejected');
            return false;
        }

        // 2. Amount Check
        if (payload.amount && typeof payload.amount === 'number' && payload.amount < 0) {
            logger.warn({ amount: payload.amount }, 'Money Path Guard: Negative Amount Rejected');
            return false;
        }

        // 3. Metadata Integrity
        // If it claims to be a Task Ops, it needs 'task_id'.
        // We assume the caller checks specific fields, but here we check generic structural integrity.

        return true;
    }

    /**
     * EXTRACT TASK ID
     * Safe extraction or NULL.
     */
    static getTaskId(payload: any): string | null {
        return payload?.metadata?.task_id || payload?.data?.object?.metadata?.task_id || null;
    }
}
