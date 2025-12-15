
import '../config/env.js';
import { serviceLogger } from '../utils/logger.js';

/**
 * TASK SUBLEDGER VALIDATOR
 */
export async function validateTaskSubledgers() {
    const { sql } = await import('../db/index.js');

    const logger = serviceLogger.child({ module: 'SubledgerValidator' });
    logger.info('Starting Task Subledger Validation...');

    try {
        // 1. Validate Account Balances (Internal Consistency)
        // ONLY sum entries from COMMITTED transactions.
        const balanceAnomalies = await sql`
            WITH calculated_balances AS (
                SELECT 
                    le.account_id,
                    SUM(
                        CASE 
                            WHEN la.type IN ('asset', 'expense') AND le.direction = 'debit' THEN le.amount
                            WHEN la.type IN ('asset', 'expense') AND le.direction = 'credit' THEN -le.amount
                            WHEN la.type IN ('liability', 'equity') AND le.direction = 'credit' THEN le.amount
                            WHEN la.type IN ('liability', 'equity') AND le.direction = 'debit' THEN -le.amount
                        END
                    ) as calculated_balance
                FROM ledger_entries le
                JOIN ledger_accounts la ON le.account_id = la.id
                JOIN ledger_transactions lt ON le.transaction_id = lt.id
                WHERE lt.status = 'committed' -- CRITICAL FILTER
                GROUP BY le.account_id
            )
            SELECT 
                la.id, la.name, la.balance, cb.calculated_balance
            FROM ledger_accounts la
            JOIN calculated_balances cb ON la.id = cb.account_id
            WHERE la.balance != cb.calculated_balance
        `;

        if (balanceAnomalies.length > 0) {
            logger.error({ count: balanceAnomalies.length, sample: balanceAnomalies.slice(0, 3) }, 'CRITICAL: Account Balance Drift Detected!');
        } else {
            logger.info('PASS: All Ledger Account Balances match Entry History.');
        }

        // 2. Validate Task Escrow Zero-Sum
        const zombieEscrows = await sql`
             SELECT la.id, la.balance, la.owner_id as task_id, msl.current_state
             FROM ledger_accounts la
             LEFT JOIN money_state_lock msl ON la.owner_id::uuid = msl.task_id
             WHERE la.owner_type = 'task'
             AND la.balance != 0
             AND (msl.current_state = 'released' OR msl.current_state = 'refunded')
        `;

        if (zombieEscrows.length > 0) {
            logger.error({ count: zombieEscrows.length, sample: zombieEscrows.slice(0, 3) }, 'CRITICAL: Zombie Escrow Detected');
        } else {
            logger.info('PASS: All Released Tasks have 0 Escrow Balance.');
        }

    } catch (error) {
        logger.error({ error }, 'Validation Failed');
        process.exit(1);
    }
}
