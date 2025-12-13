
import '../../config/env'; // Load .env file first
import { serviceLogger } from '../../utils/logger.js';

async function main() {
    serviceLogger.info('==================================================');
    serviceLogger.info('   OMEGA PHASE 7: HYPER-STRESS GAUNTLET           ');
    serviceLogger.info('==================================================');

    // FORCE M4 DATABASE URL BEFORE IMPORTING DB MODULE
    if (process.env.DATABASE_URL_M4) {
        serviceLogger.info('>>> FORCING DATABASE_URL = DATABASE_URL_M4 for Omega Gauntlet <<<');
        process.env.DATABASE_URL = process.env.DATABASE_URL_M4;
    } else {
        serviceLogger.warn('>>> DATABASE_URL_M4 NOT SET - USING DEFAULT DATABASE_URL <<<');
    }

    // Dynamic Imports to ensure DB is initialized with NEW Env Var
    const { run5000Workers } = await import('./5000-workers.js');
    const { runSagaDesync } = await import('./saga-desync.js');
    const { runWebhookSwarm } = await import('./webhook-swarm.js');

    try {
        await run5000Workers();
        await runSagaDesync();
        await runWebhookSwarm();

        serviceLogger.info('==================================================');
        serviceLogger.info('   OMEGA PHASE 7: PASSED - SYSTEM BATTLE-PROVEN   ');
        serviceLogger.info('==================================================');
        process.exit(0);
    } catch (e: any) {
        serviceLogger.fatal({ error: e }, 'OMEGA PHASE 7: FAILED');
        process.exit(1);
    }
}

main();
