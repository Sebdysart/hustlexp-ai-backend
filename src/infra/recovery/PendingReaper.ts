/**
 * PENDING TRANSACTION REAPER
 * 
 * Formalizes the state machine by ensuring every ledger intent reaches a terminal state.
 * 
 * Trigger conditions:
 * - ledger_transactions.status = 'pending'
 * - created_at < now() - INTERVAL 'X minutes' (default: 5 minutes)
 * - NO matching record in stripe_outbound_log
 * 
 * Action:
 * - Transition -> 'failed'
 * - Record reason: 'crash_pre_execute'
 * - Emit audit log
 * - Do NOT touch balances (none exist for pre-execute crashes)
 */

import { sql } from '../../db/index.js';
import { serviceLogger } from '../../utils/logger.js';

const logger = serviceLogger.child({ module: 'PendingReaper' });

const PENDING_TIMEOUT_MINUTES = 1;

interface OrphanedTransaction {
    id: string;
    type: string;
    created_at: Date;
    idempotency_key: string | null;
}

export class PendingTransactionReaper {

    /**
     * Scan and reap orphaned pending transactions.
     * Should run on startup and periodically via RecoveryEngine.
     */
    static async reap(): Promise<{ reaped: number; transactions: string[] }> {
        logger.info('Scanning for orphaned pending transactions...');

        // 1. Find pending transactions older than timeout with no Stripe outbound record
        if (!sql) {
            logger.warn('Database not available');
            return { reaped: 0, transactions: [] };
        }

        // Use tagged template - hardcode interval since it's a constant
        // Match idempotency keys: ledger TX uses 'ledger_X' while stripe uses 'X'
        const orphaned = await sql`
            SELECT lt.id, lt.type, lt.created_at, lt.idempotency_key
            FROM ledger_transactions lt
            WHERE lt.status = 'pending'
            AND lt.created_at < NOW() - INTERVAL '1 minute'
            AND NOT EXISTS (
                SELECT 1 FROM stripe_outbound_log sol 
                WHERE sol.idempotency_key = lt.idempotency_key
                   OR sol.idempotency_key = REPLACE(lt.idempotency_key, 'ledger_', '')
            )
        ` as OrphanedTransaction[];

        if (orphaned.length === 0) {
            logger.info('No orphaned pending transactions found.');
            return { reaped: 0, transactions: [] };
        }

        logger.warn({ count: orphaned.length }, 'Found orphaned pending transactions - reaping');

        const reapedIds: string[] = [];

        for (const tx of orphaned) {
            try {
                // 2. Transition to FAILED
                await sql`
                    UPDATE ledger_transactions
                    SET 
                        status = 'failed',
                        metadata = metadata || ${JSON.stringify({
                    failure_reason: 'crash_pre_execute',
                    reaped_at: new Date().toISOString(),
                    original_type: tx.type
                })}::jsonb
                    WHERE id = ${tx.id}
                    AND status = 'pending'
                `;

                // 3. Delete associated ledger entries (they were never valid)
                const deleted = await sql`
                    DELETE FROM ledger_entries 
                    WHERE transaction_id = ${tx.id}
                    RETURNING id
                `;

                // 4. Audit log
                await sql`
                    INSERT INTO money_events_audit (
                        event_id, task_id, event_type, previous_state, new_state, raw_context
                    ) VALUES (
                        ${'reaper_' + tx.id},
                        ${'system'},
                        'PENDING_REAPED',
                        'pending',
                        'failed',
                        ${JSON.stringify({
                    transaction_id: tx.id,
                    type: tx.type,
                    entries_deleted: deleted.length,
                    reason: 'crash_pre_execute',
                    timeout_minutes: PENDING_TIMEOUT_MINUTES
                })}
                    )
                `;

                reapedIds.push(tx.id);
                logger.info({ txId: tx.id, type: tx.type, entriesDeleted: deleted.length }, 'Transaction reaped');

            } catch (err: any) {
                logger.error({ txId: tx.id, error: err.message }, 'Failed to reap transaction');
            }
        }

        logger.info({ reaped: reapedIds.length }, 'Pending transaction reaping complete');
        return { reaped: reapedIds.length, transactions: reapedIds };
    }

    /**
     * Get count of pending transactions (for monitoring)
     */
    static async getPendingCount(): Promise<number> {
        if (!sql) return 0;
        const [result] = await sql`
            SELECT COUNT(*) as count FROM ledger_transactions WHERE status = 'pending'
        `;
        return parseInt(result.count, 10);
    }

    /**
     * Recover pending transactions that HAVE Stripe success evidence.
     * These should be COMMITTED, not failed.
     */
    static async recoverStripeCommitted(): Promise<{ recovered: number; transactions: string[] }> {
        if (!sql) return { recovered: 0, transactions: [] };

        logger.info('Scanning for pending transactions with Stripe success...');

        // Find pending transactions WITH matching stripe_outbound_log
        // Handle prefix: ledger TX uses 'ledger_X' while stripe uses 'X'
        const needCommit = await sql`
            SELECT lt.id, lt.type, lt.idempotency_key, sol.stripe_id, sol.type as stripe_type
            FROM ledger_transactions lt
            JOIN stripe_outbound_log sol ON (
                sol.idempotency_key = lt.idempotency_key 
                OR sol.idempotency_key = REPLACE(lt.idempotency_key, 'ledger_', '')
            )
            WHERE lt.status = 'pending'
            AND lt.created_at < NOW() - INTERVAL '1 minute'
        `;

        if (needCommit.length === 0) {
            logger.info('No pending transactions with Stripe success found.');
            return { recovered: 0, transactions: [] };
        }

        logger.warn({ count: needCommit.length }, 'Found pending transactions with Stripe success - committing');

        const recoveredIds: string[] = [];
        const { LedgerService } = await import('../../services/ledger/LedgerService.js');

        for (const tx of needCommit) {
            try {
                // COMMIT the transaction (Stripe already succeeded)
                await LedgerService.commitTransaction(tx.id, {
                    stripe_id: tx.stripe_id,
                    recovered: true,
                    recovery_time: new Date().toISOString()
                }, sql);

                recoveredIds.push(tx.id);
                logger.info({ txId: tx.id, stripeId: tx.stripe_id }, 'Transaction recovered and committed');

            } catch (err: any) {
                logger.error({ txId: tx.id, error: err.message }, 'Failed to recover transaction');
            }
        }

        logger.info({ recovered: recoveredIds.length }, 'Stripe-committed recovery complete');
        return { recovered: recoveredIds.length, transactions: recoveredIds };
    }
}

// Auto-run if called directly
if (process.argv[1]?.includes('PendingReaper')) {
    import('../../config/env.js').then(async () => {
        const result = await PendingTransactionReaper.reap();
        console.log('Reaper result:', result);
        process.exit(0);
    });
}
