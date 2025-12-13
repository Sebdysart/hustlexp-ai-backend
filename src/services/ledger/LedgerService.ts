
import { sql } from '../../db';
import { ulid } from 'ulidx';
import { LedgerGuardService } from './LedgerGuardService';
import { LedgerLockService } from './LedgerLockService';
import {
    LedgerTransaction,
    LedgerEntry,
    LedgerAccount,
    CreateLedgerTransactionInput,
    LedgerTransactionStatus
} from './types';
import { serviceLogger } from '../../utils/logger';
import { LedgerAccountService } from './LedgerAccountService';

/**
 * LEDGER SERVICE (The Iron Pipeline)
 * 
 * Orchestrates the "Hard-Mode" Saga:
 * 1. Ring 1 Lock (App) - Managed Externally or Internally check?
 *    (Option B: Managed by caller typically, or we check ownership)
 * 2. Guard Validation
 * 3. Ring 2 Lock (DB) - Via injected `client`
 * 4. Pending Write
 * 5. Saga State Management
 */
export class LedgerService {

    /**
     * PREPARE TRANSACTION (Step 1 of Saga)
     * Must be called within an active DB Transaction (`client`).
     */
    static async prepareTransaction(
        input: CreateLedgerTransactionInput,
        client: any // Transaction Client (Mandatory for Ring 2)
    ): Promise<LedgerTransaction> {
        const txUlid = ulid();
        const logger = serviceLogger.child({ txId: txUlid, type: 'LedgerPrepare' });

        logger.info(`Preparing ledger transaction: ${input.type}`);

        try {
            // ---------------------------------------------------------
            // GUARD: PRE-WRITE VALIDATION
            // ---------------------------------------------------------

            const accountIds = [...new Set(input.entries.map(e => e.account_id))];

            const accountsRaw = await client<LedgerAccount[]>`
                SELECT * FROM ledger_accounts WHERE id = ANY(${accountIds})
            `;
            const accountMap = new Map(accountsRaw.map(a => [a.id, a]));

            // 2. Execute Firewall Logic
            LedgerGuardService.validateTransactionProposal(input, accountMap);

            // ---------------------------------------------------------
            // RING 2: WRITE PENDING (IDEMPOTENT)
            // ---------------------------------------------------------

            // Attempt Insert with ON CONFLICT DO NOTHING (Prevents Exception/Abort)
            const [tx] = await client<LedgerTransaction[]>`
                INSERT INTO ledger_transactions (
                    id, type, idempotency_key, status, metadata
                ) VALUES (
                    ${txUlid}, ${input.type}, ${input.idempotency_key}, 'pending', ${input.metadata || {}}
                ) 
                ON CONFLICT (idempotency_key) DO NOTHING
                RETURNING *
            `;

            // CASE A: NEW TRANSACTION (Successfully Inserted)
            if (tx) {
                // Insert Entries
                for (const entry of input.entries) {
                    await client`
                        INSERT INTO ledger_entries (
                            transaction_id, account_id, direction, amount
                        ) VALUES (
                            ${txUlid}, ${entry.account_id}, ${entry.direction}, ${entry.amount}
                        )
                    `;
                }
                logger.info('Transaction PREPARED (Pending)');
                return tx;
            }

            // CASE B: DUPLICATE / IDEMPOTENT REPLAY
            // (Insert returned null, meaning key exists)
            logger.warn('Duplicate transaction detected (Idempotency). Returning existing.');

            const [existing] = await client<LedgerTransaction[]>`
                SELECT * FROM ledger_transactions WHERE idempotency_key = ${input.idempotency_key}
            `;

            if (!existing) {
                // Should be impossible unless concurrent delete?
                throw new Error('Idempotency Error: Key collision but row missing.');
            }

            // Consistency Check
            if (existing.type !== input.type) {
                logger.error({ existingType: existing.type, inputType: input.type }, 'Idempotency Conflict: Types do not match');
                throw new Error('Idempotency Conflict: Mismatched transaction type');
            }

            return existing;

        } catch (error) {
            logger.error({ error }, 'Prepare Failed');
            throw error;
        }
    }

    /**
     * COMMIT TRANSACTION (Step 3 of Saga)
     * Must be called within an active DB Transaction (`client`).
     */
    static async commitTransaction(
        txId: string,
        stripeMetadata: any,
        client: any // Transaction Client
    ): Promise<void> {
        const logger = serviceLogger.child({ txId, type: 'LedgerCommit' });

        try {
            const [updated] = await client<LedgerTransaction[]>`
                UPDATE ledger_transactions 
                SET status = 'committed', 
                metadata = metadata || ${JSON.stringify({ stripe_commit: stripeMetadata })},
                committed_at = now()
                WHERE id = ${txId} 
                AND status IN ('pending', 'executing')
                RETURNING *
             `;

            if (!updated) {
                const [check] = await client<LedgerTransaction[]>`SELECT status FROM ledger_transactions WHERE id = ${txId}`;
                if (check && check.status === 'committed') {
                    logger.info('Transaction already committed (Idempotency)');
                    return;
                }
                throw new Error(`[LedgerService] Commit failed: Transaction ${txId} not in valid state.`);
            }

            // CRITICAL: Update Account Balances (Double-Entry Logic)
            // We use standard accounting equation:
            // Assets: Dr +, Cr -
            // Liabilities: Cr +, Dr -
            // Equity: Cr +, Dr -
            // Expenses: Dr +, Cr -
            // Revenue: Cr +, Dr -
            // This ensures accounts reflect true value.

            await client`
                UPDATE ledger_accounts
                SET balance = balance + (
                    CASE 
                        WHEN ledger_accounts.type IN ('asset', 'expense') AND le.direction = 'debit' THEN le.amount
                        WHEN ledger_accounts.type IN ('asset', 'expense') AND le.direction = 'credit' THEN -le.amount
                        WHEN ledger_accounts.type IN ('liability', 'equity') AND le.direction = 'credit' THEN le.amount
                        WHEN ledger_accounts.type IN ('liability', 'equity') AND le.direction = 'debit' THEN -le.amount
                    END
                ),
                updated_at = NOW()
                FROM ledger_entries le
                WHERE le.account_id = ledger_accounts.id 
                AND le.transaction_id = ${txId}
            `;

            logger.info('Transaction COMMITTED & Balances UPDATED');

        } catch (error) {
            logger.error({ error }, 'Commit Failed');
            throw error;
        }
    }

    /**
     * MARK FAILED (Step 3b of Saga)
     */
    static async markFailed(
        txId: string,
        reason: string,
        client: any
    ): Promise<void> {
        await client`
            UPDATE ledger_transactions 
            SET status = 'failed', 
            metadata = metadata || ${JSON.stringify({ error: reason })}
            WHERE id = ${txId}
        `;
    }

    /**
     * SAGA EXECUTION HELPERS
     */
    static async setExecuting(txId: string, client: any): Promise<void> {
        await client`
            UPDATE ledger_transactions
            SET status = 'executing'
            WHERE id = ${txId} AND status = 'pending'
        `;
    }
}
