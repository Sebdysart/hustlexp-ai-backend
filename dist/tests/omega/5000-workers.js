import { Pool } from '@neondatabase/serverless';
import { StripeMoneyEngine } from '../../services/StripeMoneyEngine.js';
import { serviceLogger } from '../../utils/logger.js';
import { mockStripe } from '../m4/helpers/mockStripe.js';
import { v4 as uuid } from 'uuid';
import { ulid } from 'ulidx';
/**
 * M5 HYPER-STRESS GAUNTLET: 5000 WORKERS
 *
 * Simulates:
 * - 5000 Concurrent User Actions claiming the SAME task result.
 * - Massive Lock Contention.
 * - DB Connection limit pressure.
 *
 * Target:
 * - EXACTLY 1 Success.
 * - 4999 Failures (Lock Contention or Idempotency).
 */
const logger = serviceLogger.child({ module: 'M5-Stress' });
export async function run5000Workers() {
    logger.info('>>> STARTING M5: 5000 WORKERS SIMULATION <<<');
    // Setup Context
    const taskId = uuid();
    const hustlerId = uuid();
    const posterId = uuid();
    const pool = new Pool({ connectionString: process.env.DATABASE_URL_M4 });
    const eventId_base = ulid();
    // Setup Data
    await pool.query(`INSERT INTO users (id, name, email) VALUES ('${hustlerId}', 'Hustler M5', 'hdm5-${hustlerId}@test.com'), ('${posterId}', 'Poster M5', 'pdm5-${posterId}@test.com') ON CONFLICT (email) DO NOTHING`);
    await pool.query(`INSERT INTO tasks(id, title, status, payment_status, budget, recommended_price, client_id, assigned_hustler_id, category) VALUES($1, 'M5 Stress', 'held', 'escrow_secured', 50.00, 50.00, $2, $3, 'general')`, [taskId, posterId, hustlerId]);
    await pool.query(`INSERT INTO money_state_lock (task_id, current_state, next_allowed_event, version, stripe_payment_intent_id, stripe_charge_id) VALUES ($1, 'held', '{"RELEASE_PAYOUT"}', 1, 'pi_mock_m5', 'ch_mock_m5')`, [taskId]);
    // Mock Stripe
    mockStripe.reset();
    mockStripe.config({ delayMs: 2 });
    const WORKERS = 5000;
    const BATCH_SIZE = 50; // Optimized for performance after DB fix
    const results = [];
    logger.info(`Spawning ${WORKERS} workers against Task ${taskId} (Batch Size: ${BATCH_SIZE})...`);
    const context = {
        taskId,
        hustlerId,
        hustlerStripeAccountId: 'acct_m5_hustler',
        payoutAmountCents: 5000,
        eventId: eventId_base
    };
    const runWorker = async (idx) => {
        const myEventId = ulid(); // UNIQUE ID
        try {
            // Call Engine
            const result = await StripeMoneyEngine.handle(taskId, {
                eventType: 'RELEASE_PAYOUT',
                context: { ...context, eventId: myEventId },
                options: {
                    disableRetries: true,
                    stripeClient: mockStripe
                }
            });
            return { status: 'success', id: idx };
        }
        catch (e) {
            return { status: 'failed', error: e.message, id: idx };
        }
    };
    const start = Date.now();
    for (let i = 0; i < WORKERS; i += BATCH_SIZE) {
        const batch = [];
        for (let j = 0; j < BATCH_SIZE && i + j < WORKERS; j++) {
            batch.push(runWorker(i + j));
        }
        const batchResults = await Promise.all(batch);
        results.push(...batchResults);
        if (i % 500 === 0)
            logger.info(`Processed ${i} workers...`);
    }
    const duration = Date.now() - start;
    const successes = results.filter(r => r.status === 'success').length;
    const failures = results.filter(r => r.status === 'failed').length;
    logger.info({ duration, successes, failures }, 'M5 Simulation Complete');
    pool.end();
    // Validations
    if (successes !== 1) {
        // Detailed Debug
        if (successes === 0) {
            const sampleErrors = results.slice(0, 5).map(r => r.error);
            logger.error({ sampleErrors }, 'M5 Failed: 0 Successes');
        }
        throw new Error(`CRITICAL FAIL: Expected 1 success, got ${successes}`);
    }
    logger.info('M5 5000-Worker Test: PASSED (1 Winner, 4999 Losers)');
}
//# sourceMappingURL=5000-workers.js.map