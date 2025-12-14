
import { DLQProcessor } from './DLQProcessor';
import { BackfillService } from './BackfillService';
import { PendingTransactionReaper } from './PendingReaper';
import { serviceLogger } from '../../utils/logger';
import { KillSwitch } from '../KillSwitch';

/**
 * RECOVERY ENGINE (OMEGA PROTOCOL)
 * 
 * The Orchestrator of Self-Healing.
 * Runs typically as a Cron Job or Daemon.
 */

const logger = serviceLogger.child({ module: 'RecoveryEngine' });

export class RecoveryEngine {

    static async runCycle() {
        if (await KillSwitch.isActive()) {
            logger.warn('Recovery Engine Cycle Paused - Kill Switch Active. (Manual intervention required)');
            return;
        }

        logger.info('--- Recovery Engine Cycle Start ---');

        try {
            // 0. Reap orphaned pending transactions (CRASH PRE-EXECUTE)
            const reaperResult = await PendingTransactionReaper.reap();
            if (reaperResult.reaped > 0) {
                logger.warn({ reaped: reaperResult.reaped }, 'Pending transactions reaped');
            }

            // 0b. Recover pending transactions WITH Stripe success (CRASH POST-EXECUTE)
            const recoverResult = await PendingTransactionReaper.recoverStripeCommitted();
            if (recoverResult.recovered > 0) {
                logger.warn({ recovered: recoverResult.recovered }, 'Stripe-succeeded transactions recovered');
            }

            // 1. Process Dead Letters (Retry Pendings)
            await DLQProcessor.processQueue();

            // 2. Scan for Missing History (Backfill)
            await BackfillService.scanAndBackfill();

            // 3. (Optional) Trigger Recon if time?
            // Usually Recon runs independently.

        } catch (error) {
            logger.error({ error }, 'Recovery Engine Cycle Failed');
        }

        logger.info('--- Recovery Engine Cycle End ---');
    }
}

// Auto-Run if called directly
if (process.argv[1] === import.meta.url) {
    import('../../config/env.js').then(() => {
        RecoveryEngine.runCycle().then(() => process.exit(0));
    });
}
