import dotenv from 'dotenv';
import path from 'path';
import { serviceLogger } from '../../utils/logger.js';
import { ulid } from 'ulidx';

// Force Load Env
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Override with M4 (Test DB)
if (process.env.DATABASE_URL_M4) {
    console.log('🧪 Switching to M4 Database for Invariant Test');
    process.env.DATABASE_URL = process.env.DATABASE_URL_M4;
}

const logger = serviceLogger.child({ module: 'InvariantBreak:KillSwitch' });

export async function runKillSwitchTest() {
    // Dynamic Imports to ensure Env is picked up correctly
    const { sql, transaction } = await import('../../db/index.js');
    const { LedgerService } = await import('../../services/ledger/LedgerService.js');
    const { KillSwitch } = await import('../../infra/KillSwitch.js');

    if (!sql) throw new Error("Database client not initialized");
    // const db = sql; // Unused if we only use transaction helper

    logger.info('🧪 STARTING TEST: KillSwitch Traffic Freeze');

    // 1. Activate KillSwitch
    logger.info('🛑 ACTIVATING KILLSWITCH...');
    await KillSwitch.trigger('TEST_SIMULATION', { user: 'OmegaRunner' });

    // Verify Active
    if (!await KillSwitch.isActive()) {
        logger.error('❌ KillSwitch failed to activate!');
        process.exit(1);
    }
    logger.info('🔒 KillSwitch ENABLED.');

    // 2. Attempt Ledger Operation (Should Fail)
    try {
        const txId = ulid();
        await transaction(async (tx) => {
            // Check Pre-condition (Simulating Service Logic)
            await LedgerService.prepareTransaction({
                type: 'HOLD_ESCROW',
                idempotency_key: `test_${txId}`,
                metadata: { taskId: 'test_task', posterId: 'test_poster', hustlerId: 'test_hustler' },
                entries: [
                    { account_id: 'test_account_1', direction: 'debit', amount: 100 },
                    { account_id: 'test_account_2', direction: 'credit', amount: 100 }
                ]
            }, tx);
        });

        throw new Error('❌ TEST FAILED: Transaction allowed despite KillSwitch!');

    } catch (e: any) {
        if (e.message.includes('KillSwitch Active') || e.message.includes('KILL SWITCH TRIGGERED')) {
            logger.info('✅ SUCCESS: KillSwitch blocked the transaction.');
        } else {
            throw e;
        }
    } finally {
        await KillSwitch.resolve();
        logger.info('🔓 KillSwitch DISABLED.');
    }

    // 3. Reset KillSwitch
    await KillSwitch.resolve();
}

// Auto-run if main
if (process.argv[1] === import.meta.filename) {
    runKillSwitchTest();
}
