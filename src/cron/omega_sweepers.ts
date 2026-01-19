import { safeSql as sql } from '../db/index.js';
import { serviceLogger } from '../utils/logger.js';
import Stripe from 'stripe';
import { env } from '../config/env.js';

const logger = serviceLogger.child({ module: 'OmegaSweepers' });

// CONFIG
const SAGA_TIMEOUT_MS = 1000 * 60 * 5; // 5 Minutes
const MIRROR_WINDOW_DAYS = 30;

/**
 * OMEGA SWEEPERS (Background Invariant Enforcement)
 */
export class OmegaSweepers {

    private static stripe: Stripe;
    private static sagaTimer?: NodeJS.Timer;
    private static mirrorTimer?: NodeJS.Timer;
    private static hourlyTimer?: NodeJS.Timer;
    private static dailyTimer?: NodeJS.Timer;

    static init() {
        if (!this.stripe) {
            this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-11-20.acacia' as any } as any);
        }
    }

    /**
     * Start all background sweepers.
     */
    static start() {
        this.init();
        
        // Clean up any existing timers before starting new ones
        this.stop();
        
        logger.info('Starting Omega Sweepers...');

        // 1. Saga Timeout Sweeper (Every 1 min)
        this.sagaTimer = setInterval(() => this.sweepStuckSagas(), 60 * 1000);

        // 2. Reality Mirror Backfill (Every 6 hours)
        this.mirrorTimer = setInterval(() => this.backfillRealityMirror(), 6 * 60 * 60 * 1000);

        // 3. Control Plane: Hourly Snapshot (Every 1 hour)
        this.hourlyTimer = setInterval(() => this.generateSnapshot('hourly'), 60 * 60 * 1000);

        // 4. Control Plane: Daily Snapshot (Every 24 hours)
        this.dailyTimer = setInterval(() => this.generateSnapshot('daily'), 24 * 60 * 60 * 1000);

        // Run once on boot
        this.sweepStuckSagas().catch(e => logger.error(e, 'Boot Sweep Failed'));
    }

    /**
     * Stop all background sweepers and clean up timers.
     */
    static stop(): void {
        if (this.sagaTimer) {
            clearInterval(this.sagaTimer);
            this.sagaTimer = undefined;
        }
        if (this.mirrorTimer) {
            clearInterval(this.mirrorTimer);
            this.mirrorTimer = undefined;
        }
        if (this.hourlyTimer) {
            clearInterval(this.hourlyTimer);
            this.hourlyTimer = undefined;
        }
        if (this.dailyTimer) {
            clearInterval(this.dailyTimer);
            this.dailyTimer = undefined;
        }
    }

    /**
     * CONTROL PLANE: Generate Analysis Snapshot
     * Creates immutable snapshot for offline AI analysis
     */
    static async generateSnapshot(type: 'hourly' | 'daily' | 'manual') {
        try {
            const { AnalysisSnapshotService } = await import('../control-plane/AnalysisSnapshotService.js');
            const snapshot = await AnalysisSnapshotService.generateSnapshot(type);
            logger.info({ snapshotId: snapshot.id, type }, 'Analysis snapshot generated');
        } catch (err) {
            logger.error({ err, type }, 'Failed to generate analysis snapshot');
        }
    }

    /**
     * POINT 12: SAGA TIMEOUT INVARIANT
     * Auto-fail Sagas stuck in PENDING/EXECUTING > X seconds.
     */
    static async sweepStuckSagas() {
        try {
            const cutoff = new Date(Date.now() - SAGA_TIMEOUT_MS);

            // Find stuck transactions
            const stuckTxs = await sql`
                SELECT id, status, created_at 
                FROM ledger_transactions 
                WHERE status IN ('pending', 'executing') 
                AND created_at < ${cutoff.toISOString()}
            `;

            if (stuckTxs.length > 0) {
                logger.warn({ count: stuckTxs.length }, 'Found Stuck Sagas - Moving to FAILED/DLQ');

                // Bulk Fail
                const ids = stuckTxs.map(t => t.id);

                await sql`
                    UPDATE ledger_transactions 
                    SET status = 'failed', 
                        metadata = jsonb_set(metadata, '{failure_reason}', '"Saga Timeout - Auto Swept"')
                    WHERE id = ANY(${ids})
                `;

                // Emitting Metrics would go here
            }
        } catch (err) {
            logger.error({ err }, 'Saga Sweep Failed');
        }
    }

    /**
     * POINT 14: REALITY MIRROR BACKFILL
     * Audit Stripe vs DB Consistency (30 Day Window).
     */
    static async backfillRealityMirror() {
        try {
            const limit = 100;
            const thirtyDaysAgo = Math.floor(Date.now() / 1000) - (MIRROR_WINDOW_DAYS * 86400);

            // This is a simplified "Audit" - in real prod we would paginate purely
            // For now, we fetch latest 100 events and ensure they exist in 'processed_stripe_events'

            const events = await this.stripe.events.list({
                limit,
                created: { gt: thirtyDaysAgo },
                types: ['payment_intent.succeeded', 'transfer.created', 'charge.refunded']
            });

            let missingCount = 0;

            for (const event of events.data) {
                const [exists] = await sql`SELECT 1 FROM processed_stripe_events WHERE event_id = ${event.id}`;
                if (!exists) {
                    logger.error({ eventId: event.id, type: event.type }, 'CRITICAL: Reality Mirror Gap (Stripe Event missing in DB)');
                    missingCount++;
                    // In real backfill, we would trigger re-ingest here.
                    // For Audit, we strictly Log Critical.
                }
            }

            if (missingCount === 0) {
                logger.info('Reality Mirror Audit Passed (Recent Window)');
            }

        } catch (err) {
            logger.error({ err }, 'Reality Mirror Backfill Failed');
        }
    }
}
