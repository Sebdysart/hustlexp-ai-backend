import dotenv from 'dotenv';
import path from 'path';
import { serviceLogger } from '../../utils/logger.js';
import { LedgerService } from '../../services/ledger/LedgerService.js';
import { ulid } from 'ulidx';
import { v4 as uuid } from 'uuid';

// Force Load Env
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Override with M4 (Test DB)
if (process.env.DATABASE_URL_M4) {
    console.log('🧪 Switching to M4 Database for Invariant Test');
    process.env.DATABASE_URL = process.env.DATABASE_URL_M4;
}

const logger = serviceLogger.child({ module: 'InvariantBreak:ZeroSum' });

export async function runZeroSumTest() {
    // Dynamic Import to ensure Env is set
    const { sql, transaction } = await import('../../db/index.js');

    if (!sql) throw new Error("Database client not initialized");
    const db = sql;

    logger.info('🧪 STARTING TEST: Zero-Sum Invariant Break');

    // 2. Create Dummy Accounts
    const platformId = uuid();
    const posterId = uuid();
    const hustlerId = uuid();

    await db`
        INSERT INTO ledger_accounts (id, type, currency, balance, name)
        VALUES 
        (${platformId}, 'platform', 'USD', 0, 'Platform'),
        (${posterId}, 'wallet', 'USD', 1000, 'Poster'),
        (${hustlerId}, 'wallet', 'USD', 0, 'Hustler')
        ON CONFLICT DO NOTHING
    `;

    // 3. Attempt Unbalanced Transaction (Debit 100, Credit 50) -> GAP 50
    logger.info('💥 ATTEMPTING UNBALANCED TRANSACTION...');

    try {
        await transaction(async (tx) => {
            const txId = ulid();

            // Ledger Entries (Sum = -50 != 0)
            await tx`
                INSERT INTO ledger_entries (id, transaction_id, account_id, direction, amount, currency)
                VALUES 
                (${ulid()}, ${txId}, ${posterId}, 'debit', 100.00, 'USD'),
                (${ulid()}, ${txId}, ${hustlerId}, 'credit', 50.00, 'USD')
            `;

            // Commit (Should Trigger Verify)
            await LedgerService.commitTransaction(txId, {}, tx);
        });

        logger.error('❌ FAILURE: Unbalanced Transaction Committed! Zero-Sum Invariant BROKEN.');
        process.exit(1);

    } catch (e: any) {
        if (e.message.includes('Zero-Sum Failure') || e.message.includes('Invariant Violation')) {
            logger.info('✅ SUCCESS: Invariant 3 Caught the Violation (Zero-Sum)');
            logger.info(`   Error: ${e.message}`);
        } else {
            logger.error({ err: e }, '❓ UNEXPECTED ERROR: Logic failed but not for the right reason?');
            throw e;
        }
    }
}

// Auto-run if main
if (process.argv[1] === import.meta.filename) {
    runZeroSumTest();
}
