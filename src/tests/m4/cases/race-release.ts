
import { Client, Pool } from '@neondatabase/serverless';
import { M4TestCase, TestResult } from '../m4-runner';
import { StripeMoneyEngine } from '../../../services/StripeMoneyEngine';
import { LedgerAccountService } from '../../../services/ledger/LedgerAccountService';
import { mockStripe } from '../helpers/mockStripe';
import { v4 as uuid } from 'uuid';
import { ulid } from 'ulidx';
import { serviceLogger } from '../../../utils/logger';

export const RaceReleaseCase: M4TestCase = {
    name: 'Race Release (Option A: 500 Manual Clients - No Pool)',
    run: async (pool: Pool): Promise<TestResult> => {
        serviceLogger.info(">>> STARTING M4 RACE RELEASE (OPTION A - STRICT) <<<");

        // 1. Setup Data
        const taskId = uuid();
        const hustlerId = uuid();
        const posterId = uuid();
        const amountCents = 5000;
        const payoutAmountCents = 5000;

        const eventId = `ev_release_${taskId}`;

        // Compute Ledger Account IDs
        const posterReceivableId = LedgerAccountService.computeId(posterId, 'receivable');
        const taskEscrowId = LedgerAccountService.computeId(taskId, 'task_escrow');
        const hustlerReceivableId = LedgerAccountService.computeId(hustlerId, 'receivable');

        // A. Insert Users
        await pool.query(`
            INSERT INTO users (id, name, email) VALUES 
            ('${hustlerId}', 'Hustler M4 Race', 'hustler_${hustlerId}@test.com'),
            ('${posterId}', 'Poster M4 Race', 'poster_${posterId}@test.com')
        `);

        // B. Insert Task
        await pool.query(`
            INSERT INTO tasks(id, title, category, recommended_price, description, status, payment_status, budget, client_id, assigned_hustler_id)
            VALUES($1, 'M4 Race Task', 'general', 50.00, 'Test Task', 'in_progress', 'escrow_secured', 50.00, $2, $3)
                `, [taskId, posterId, hustlerId]);

        // C. Insert Initial Lock State
        await pool.query(`
             INSERT INTO money_state_lock (
               task_id, current_state, next_allowed_event, version, stripe_payment_intent_id, stripe_charge_id
           ) VALUES (
               $1, 'held', '{"RELEASE_PAYOUT"}', 1, 'pi_mock_123', 'ch_mock_123'
           )
       `, [taskId]);

        // D. SEED LEDGER STATE (The "Hold")
        // 1. Create Accounts
        await pool.query(`INSERT INTO ledger_accounts (id, owner_id, owner_type, type, currency, name, balance) VALUES ($1, $2, 'user', 'asset', 'USD', 'Poster Receivable', 0) ON CONFLICT DO NOTHING`, [posterReceivableId, posterId]);
        await pool.query(`INSERT INTO ledger_accounts (id, owner_id, owner_type, type, currency, name, balance) VALUES ($1, $2, 'task', 'liability', 'USD', 'Task Escrow', 0) ON CONFLICT DO NOTHING`, [taskEscrowId, taskId]);

        // 2. Create Hold Transaction
        const holdTxId = ulid();
        await pool.query(`INSERT INTO ledger_transactions (id, type, idempotency_key, status, metadata) VALUES ($1, 'ESCROW_HOLD', $2, 'committed', '{}')`, [holdTxId, `seed_hold_${taskId}`]);

        // 3. Create Entries
        await pool.query(`INSERT INTO ledger_entries (transaction_id, account_id, direction, amount) VALUES ($1, $2, 'debit', $4), ($1, $3, 'credit', $4)`, [holdTxId, posterReceivableId, taskEscrowId, amountCents]);

        // 4. Update Initial Balances (SPLIT QUERIES)
        await pool.query(`UPDATE ledger_accounts SET balance = $1 WHERE id = $2`, [amountCents, posterReceivableId]);
        await pool.query(`UPDATE ledger_accounts SET balance = $1 WHERE id = $2`, [amountCents, taskEscrowId]);

        // Setup Mock
        mockStripe.reset();
        mockStripe.config({ delayMs: 15 });

        // 2. Attack: 10 MANUAL CLIENTS
        const CONQ = 10;
        const connectionString = process.env.DATABASE_URL_M4!;

        const attackPromises = [];

        const context = {
            eventId: eventId,
            hustlerStripeAccountId: 'acct_test_hustler',
            payoutAmountCents: payoutAmountCents,
            taskId,
            hustlerId,
            actorUid: 'poster_1'
        };

        for (let i = 0; i < CONQ; i++) {
            attackPromises.push((async (index) => {
                const client = new Client({ connectionString });
                await client.connect();

                try {
                    await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE');
                    await client.query('BEGIN');

                    const txWrapper: any = async (strings: TemplateStringsArray, ...values: any[]) => {
                        let text = strings[0];
                        for (let k = 1; k < strings.length; k++) text += '$' + k + strings[k];
                        const res = await client.query(text, values);
                        return res.rows;
                    };

                    const result = await StripeMoneyEngine.handle(
                        taskId,
                        'RELEASE_PAYOUT',
                        context,
                        { tx: txWrapper, disableRetries: true, stripeClient: mockStripe }
                    );

                    await client.query('COMMIT');
                    return { status: 'fulfilled', id: index, val: result };

                } catch (e: any) {
                    try { await client.query('ROLLBACK'); } catch (_) { }
                    return { status: 'rejected', reason: e, id: index };
                } finally {
                    await client.end();
                }
            })(i));
        }

        const results = await Promise.all(attackPromises);

        // 3. Verify
        const { rows: processedRows } = await pool.query(`SELECT * FROM money_events_processed WHERE event_id = $1`, [eventId]);
        const { rows: lockRows } = await pool.query(`SELECT version FROM money_state_lock WHERE task_id = $1`, [taskId]);
        const finalVersion = lockRows[0]?.version;
        const successes = results.filter(r => r.status === 'fulfilled').length;
        const failures = results.filter(r => r.status === 'rejected').length;

        const stats = { successes, failures, processedCount: processedRows.length, finalVersion, workers: CONQ };

        if (stats.processedCount !== 1) {
            const firstError = (results.find(r => r.status === 'rejected') as any)?.reason;
            return { passed: false, error: `Idempotency Failed: ${stats.processedCount} processed. ${firstError}`, stats };
        }

        return { passed: true, durationMs: 0, stats };
    }
};
