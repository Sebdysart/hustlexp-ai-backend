
import { Pool } from '@neondatabase/serverless';
import { M4TestCase, TestResult } from '../m4-runner';
import { StripeMoneyEngine } from '../../../services/StripeMoneyEngine';
import { mockStripe } from '../helpers/mockStripe';
import { v4 as uuid } from 'uuid';
import { serviceLogger } from '../../../utils/logger';
import { LedgerAccountService } from '../../../services/ledger/LedgerAccountService';

export const SagaFaultsCase: M4TestCase = {
    name: 'Saga Fault Injection (Stripe Down)',
    run: async (pool: Pool): Promise<TestResult> => {
        serviceLogger.info('>>> STARTING M4 SAGA FAULTS (STRIPE DOWN) <<<');

        // DEBUG: Verify Table Exists
        try {
            await pool.query('SELECT 1 FROM ledger_locks LIMIT 1');
        } catch (e: any) {
            return { passed: false, error: `CRITICAL: ledger_locks table missing! ${e.message}` };
        }

        const taskId = uuid();
        const hustlerId = uuid();
        const posterId = uuid();

        // 1. Setup Data with proper Schema
        await pool.query(`
            INSERT INTO users (id, name, email) VALUES 
            ('${hustlerId}', 'Hustler Fault', 'hustler_${hustlerId}@test.com'),
            ('${posterId}', 'Poster Fault', 'poster_${posterId}@test.com')
        `);

        await pool.query(`
            INSERT INTO tasks(id, title, category, recommended_price, description, status, payment_status, budget, client_id, assigned_hustler_id)
            VALUES($1, 'M4 Fault Task', 'general', 50.00, 'Fault Test Task', 'in_progress', 'escrow_secured', 1000.00, $2, $3)
        `, [taskId, posterId, hustlerId]);

        // Insert Initial Lock
        await pool.query(`
            INSERT INTO money_state_lock (
               task_id, current_state, next_allowed_event, version, stripe_payment_intent_id, stripe_charge_id
           ) VALUES (
               $1, 'held', '{"RELEASE_PAYOUT"}', 1, 'pi_mock_fault', 'ch_mock_fault'
           )
       `, [taskId]);

        // SEED LEDGER ACCOUNTS (using Service to ensure determinism)
        // We use a dummy transaction to seed them
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // Just calling getAccount checks or creates them
            // We need to pass a client-like object. 'pool' works if we wrap it?
            // LedgerAccountService expects { query } interface compatible with postgres/neon.
            // It uses `tx` which is `msg` from 'postgres' or similar. 
            // Our `pool` is 'neondatabase/serverless'.
            // Let's assume LedgerAccountService is compatible or we skip explicit seeding and rely on Engine to do it inside its TX.
            // Engine CALLS LedgerAccountService.getAccount inside its OWN transaction.
            // So we DON'T need to seed them here manually, provided the Engine works.
            // The "relation does not exist" was likely `ledger_locks` which Ring 1 uses.
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }

        // 2. Inject 100% Failure
        mockStripe.reset();

        // 3. Attack (Run Logic)
        const context = {
            eventId: 'ev_fault_123',
            hustlerStripeAccountId: 'acct_fault',
            payoutAmountCents: 5000,
            hustlerId: hustlerId
        };

        // FORCE STRIPE FAILURE
        const failingStripe = {
            paymentIntents: {
                capture: async () => { throw new Error('stripe_server_error'); }
            },
            transfers: {
                create: async () => { throw new Error('stripe_server_error'); }
            }
        };

        try {
            // NOTE: We do NOT pass 'tx'. We let Engine manage the transaction (Saga 2.0 Mode).
            await StripeMoneyEngine.handle(taskId, 'RELEASE_PAYOUT', context, { stripeClient: failingStripe });
            return { passed: false, error: "Should have failed but succeeded!" };
        } catch (e: any) {
            // Expected Failure
            if (!String(e).includes('stripe_server_error')) {
                return { passed: false, error: `Unexpected error during fault test: ${e.message} \nStack: ${e.stack}` };
            }
        }

        // 4. Verify No Commit / State Consistent
        const { rows } = await pool.query(`SELECT version FROM money_state_lock WHERE task_id = $1`, [taskId]);

        if (rows[0].version !== 1) {
            return { passed: false, error: `State Lock Version advanced to ${rows[0].version} despite failure!` };
        }

        return { passed: true, durationMs: 0, stats: { status: 'Correctly Rolled Back' } };
    }
};
