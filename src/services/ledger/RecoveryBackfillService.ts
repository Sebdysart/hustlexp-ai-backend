
import { StripeService } from '../StripeService';
import { sql } from '../../db';
import { serviceLogger } from '../../utils/logger';
import Stripe from 'stripe';
import { env } from '../../config/env';

const stripe = new Stripe(env.STRIPE_SECRET_KEY!, { typescript: true });

/**
 * RECOVERY BACKFILL SERVICE (The Time Machine)
 * 
 * Rebuilds internal state from Stripe Truth.
 * Used when DB is corrupted, restored from old backup, or major drift occurred.
 */
export class RecoveryBackfillService {

    /**
     * Reconcile a single Task's financial state
     */
    static async backfillTask(taskId: string) {
        const logger = serviceLogger.child({ taskId, module: 'Backfill' });
        logger.info('Starting Backfill...');

        // 1. Search Stripe for Related Objects (via Metadata)
        // This is expensive (List Scan). Optimally we have IDs.
        // If we have nothing, we search by transfer_group = taskId.

        const pis = await stripe.paymentIntents.search({ query: `metadata['taskId']:'${taskId}'` });
        const transfers = await stripe.transfers.list({ transfer_group: taskId });

        if (pis.data.length === 0) {
            logger.warn('No Payment Intent found in Stripe.');
            return;
        }

        const pi = pis.data[0];

        // 2. Check Hold State
        if (pi.status === 'succeeded') {
            await StripeService.recoverHoldEscrow(pi, taskId); // Idempotent
        }

        // 3. Check Release State
        const transfer = transfers.data.find(t => t.metadata.taskId === taskId);
        if (transfer) {
            await StripeService.recoverReleaseEscrow(transfer, taskId); // Idempotent
        }

        logger.info('Backfill Complete.');
    }
}
