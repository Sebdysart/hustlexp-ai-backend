import dotenv from 'dotenv';
import path from 'path';
import { serviceLogger } from '../../utils/logger.js';
import { ulid } from 'ulidx';
import { v4 as uuid } from 'uuid';

// Force Load Env
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Override with M4 (Test DB)
if (process.env.DATABASE_URL_M4) {
    console.log('🧪 Switching to M4 Database for Invariant Test');
    process.env.DATABASE_URL = process.env.DATABASE_URL_M4;
}

const logger = serviceLogger.child({ module: 'InvariantBreak:SplitBrain' });

// MOCK STRIPE CLIENT
const mockStripe = {
    paymentIntents: {
        create: async (payload: any, opts: any) => {
            logger.info({ id: opts.idempotencyKey }, 'MockStripe: Creating PI (Call 1)');
            return { id: 'pi_mock_123', status: 'requires_capture' };
        },
        confirm: async (id: string) => ({ id, status: 'requires_capture', latest_charge: 'ch_mock_123' }),
        retrieve: async (id: string, opts: any) => ({ id, status: 'requires_capture', latest_charge: 'ch_mock_123' }),
        capture: async (id: string) => ({ id, status: 'succeeded' }),
        cancel: async (id: string) => ({ id, status: 'canceled' })
    },
    transfers: {
        create: async (payload: any) => ({ id: 'tr_mock_123' }),
        createReversal: async (id: string) => ({ id: 'trr_mock_123' })
    },
    refunds: {
        create: async (payload: any) => ({ id: 're_mock_123' })
    }
};

export async function runSplitBrainTest() {
    // Dynamic Import
    const { sql } = await import('../../db/index.js');
    const { handle } = await import('../../services/StripeMoneyEngine.js');

    if (!sql) throw new Error("Database client not initialized");
    const db = sql;

    logger.info('🧪 STARTING TEST: Split-Brain Recovery (Execute Once or Never)');

    // 1. Setup Data
    const taskId = uuid(); // UUID for Task
    const posterId = uuid();
    const eventId = ulid(); // Idempotency Key

    // Create Dummy Task/Users for FK constraints
    await db`INSERT INTO users (id, email, name) VALUES (${posterId}, ${posterId + '@test.com'}, 'Test Poster') ON CONFLICT DO NOTHING`;
    await db`
        INSERT INTO tasks (id, title, category, recommended_price, client_id) 
        VALUES (${taskId}, 'Split Brain Test', 'general', 50.00, ${posterId})
    `;

    // Ensure Accounts Exist for Ledger with Valid NAME
    const posterReceivable = uuid();
    const taskEscrow = uuid();
    await db`
        INSERT INTO ledger_accounts (id, name, type, balance, owner_type, owner_id) 
        VALUES 
            (${posterReceivable}, 'Poster Receivable', 'asset', 10000, 'user', ${posterId}),
            (${taskEscrow}, 'Task Escrow', 'liability', 0, 'task', ${taskId})
    `;

    // 2. Scenario: "Crash After Stripe, Before DB Commit"
    // We simulate this by MANUALLY inserting into stripe_outbound_log 
    // simulating that a previous run succeeded but crashed before `money_events_processed`.

    logger.info('💥 SIMULATING SPLIT-BRAIN: Injecting Phantom Stripe Log...');
    await db`
        INSERT INTO stripe_outbound_log (idempotency_key, stripe_id, type, payload)
        VALUES (${eventId}, 'pi_existing_phantom_999', 'pi', '{"chargeId": "ch_existing_phantom_999"}')
    `;

    // 3. Run Handle (Replay)
    // It SHOULD see the phantom log and return it WITHOUT calling mockStripe.create
    logger.info('🔄 Running Engine Handle (Recovery Mode)...');

    const result = await handle(taskId, {
        eventType: 'HOLD_ESCROW',
        context: {
            amountCents: 5000,
            paymentMethodId: 'pm_card_visa',
            posterId,
            taskId
        },
        eventId: eventId,
        options: {
            stripeClient: mockStripe
        }
    });

    // 4. Verify Result
    const [audit] = await sql`
        SELECT stripe_payment_intent_id FROM money_events_audit WHERE event_id = ${eventId}
    `;

    if (audit && audit.stripe_payment_intent_id === 'pi_existing_phantom_999') {
        logger.info('✅ SUCCESS: Split-Brain Recovery used Mirror Table (Phantom ID preserved)');
    } else {
        logger.error({ got: audit?.stripe_payment_intent_id }, '❌ FAILURE: Engine ignored Mirror and created new Stripe Object');
        process.exit(1);
    }
}

// Auto-run if main
if (process.argv[1] === import.meta.filename) {
    runSplitBrainTest();
}
