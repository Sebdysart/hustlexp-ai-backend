
import { sql } from '../../db/index.js';
import { serviceLogger } from '../../utils/logger.js';
import { decodeTime } from 'ulidx';


/**
 * TEMPORAL GUARD (OMEGA PHASE 5)
 * 
 * Enforces strict temporal ordering based on ULID timestamps.
 * Rule: No event processing allowed if Event ULID < Last Committed Transaction ULID.
 * 
 * This prevents:
 * - Late-arriving webhooks rewriting history.
 * - Out-of-order replay attacks.
 */

const logger = serviceLogger.child({ module: 'TemporalGuard' });

export class TemporalGuard {

    /**
     * VALIDATE SEQUENCE
     * Returns TRUE if safe to proceed.
     * Returns FALSE if event is stale/older than current state (Time Travel).
     */
    static async validateSequence(targetId: string, eventId: string): Promise<boolean> {
        // targetId is usually task_id. We need to find the Last Committed TX for this task.
        // We link Task -> Ledger Accounts -> Ledger Transactions.
        // Or we assume `targetId` corresponds to a lock entity.

        // Strategy: Get the latest `created_at` or `id` (ULID) of any committed transaction associated with this Task's accounts.

        // 1. Get Accounts for Task
        // 2. Get Max(Transaction ID) for those accounts.
        // 3. Compare with eventId (which should be a ULID or mapped to one).

        // If eventId is a Stripe ID (e.g. 'evt_...'), we can't extract ULID time. 
        // We must rely on our generated `eventId` (ULID) or `idempotency_key` (ULID)?
        // Protocol says: "Maintain canonical ULID ordering".
        // The `eventId` passed here MUST be the ULID assigned to this webhook processing attempt.

        try {
            if (!sql) {
                logger.warn({ targetId }, 'Temporal Guard: Database not available - allowing');
                return true;
            }

            const eventTime = decodeTime(eventId);

            // Get Last Commited Transaction for this Task (Owner)
            const [lastTx] = await sql`
                SELECT lt.id 
                FROM ledger_transactions lt
                JOIN ledger_entries le ON lt.id = le.transaction_id
                JOIN ledger_accounts la ON le.account_id = la.id
                WHERE la.owner_id = ${targetId} 
                AND lt.status = 'committed'
                ORDER BY lt.id DESC 
                LIMIT 1
            `;

            if (!lastTx) {
                // No history? Safe.
                return true;
            }

            const lastTxTime = decodeTime(lastTx.id);

            if (eventTime < lastTxTime) {
                logger.warn({
                    targetId,
                    eventTime: new Date(eventTime).toISOString(),
                    lastTxTime: new Date(lastTxTime).toISOString(),
                    diff: lastTxTime - eventTime
                }, '⏳ TEMPORAL GUARD REJECT: Event is older than last committed state (Time Travel).');
                return false;
            }

            return true;

        } catch (error) {
            logger.error({ error, targetId }, 'Temporal Guard Check Failed - Failing Closed (Reject)');
            return false;
        }
    }
}
