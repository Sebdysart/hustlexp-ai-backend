#!/usr/bin/env npx tsx
/**
 * CRASH TEST #2: Post-Stripe Success, Pre-Commit
 *
 * Uses MOCK Stripe client to simulate successful transfer
 * Then crashes BEFORE ledger commit
 */
import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';
import { ulid } from 'ulidx';
dotenv.config();
// ARM CRASH TEST #2
process.env.CRASH_TEST = 'AFTER_STRIPE_BEFORE_LEDGER';
const sql = neon(process.env.DATABASE_URL);
// MOCK STRIPE CLIENT
const mockStripeClient = {
    transfers: {
        create: async (params) => {
            console.log('[MOCK STRIPE] Transfer created:', params.amount);
            return {
                id: 'tr_mock_crash2_' + Date.now(),
                amount: params.amount,
                currency: 'usd',
                destination: params.destination,
            };
        }
    },
    paymentIntents: {
        capture: async (id) => {
            console.log('[MOCK STRIPE] Payment intent captured:', id);
            return { id, status: 'succeeded', latest_charge: 'ch_mock_' + Date.now() };
        }
    },
    refunds: {
        create: async (params) => {
            console.log('[MOCK STRIPE] Refund created:', params.amount);
            return { id: 're_mock_' + Date.now(), amount: params.amount };
        }
    }
};
async function main() {
    console.log('=== CRASH TEST #2: POST-STRIPE / PRE-COMMIT ===\n');
    console.log('Using MOCK Stripe client to simulate success\n');
    // 1. Create fresh test scenario
    const taskId = crypto.randomUUID();
    const posterId = 'crash2-poster-' + Date.now();
    const hustlerId = 'crash2-hustler-' + Date.now();
    await sql.unsafe(`
        INSERT INTO tasks (id, title, description, category, created_by, price, status)
        VALUES ('${taskId}', 'Crash Test 2 Mock', 'Post-Stripe crash test', 'errands', '${posterId}', 1000, 'in_progress')
    `);
    console.log('Created task:', taskId);
    // Create ledger accounts
    const [posterAccount] = await sql `
        INSERT INTO ledger_accounts (owner_type, owner_id, type, name, balance)
        VALUES ('user', ${posterId}, 'asset', 'receivable', 50000)
        RETURNING id
    `;
    const [taskEscrow] = await sql `
        INSERT INTO ledger_accounts (owner_type, owner_id, type, name, balance)
        VALUES ('task', ${taskId}, 'liability', 'task_escrow', 1000)
        RETURNING id
    `;
    const [hustlerAccount] = await sql `
        INSERT INTO ledger_accounts (owner_type, owner_id, type, name, balance)
        VALUES ('user', ${hustlerId}, 'asset', 'receivable', 0)
        RETURNING id
    `;
    // Simulate escrow held
    const holdTxId = ulid();
    await sql `
        INSERT INTO ledger_transactions (id, type, status, idempotency_key, metadata, committed_at)
        VALUES (${holdTxId}, 'ESCROW_HOLD', 'committed', ${'ledger_hold_' + taskId}, ${JSON.stringify({ taskId })}, NOW())
    `;
    await sql `
        INSERT INTO ledger_entries (transaction_id, account_id, direction, amount)
        VALUES 
            (${holdTxId}, ${posterAccount.id}, 'debit', 1000),
            (${holdTxId}, ${taskEscrow.id}, 'credit', 1000)
    `;
    // Create money state lock
    await sql `
        INSERT INTO money_state_lock (task_id, current_state, next_allowed_event, poster_uid, version, stripe_payment_intent_id, stripe_charge_id)
        VALUES (${taskId}::uuid, 'held', ARRAY['RELEASE_PAYOUT', 'REFUND_ESCROW', 'DISPUTE_OPEN'], ${posterId}, 1, 'pi_test_crash2', 'ch_test_crash2')
    `;
    console.log('Test scenario ready');
    console.log('Task escrow balance: 1000');
    console.log('Hustler receivable balance: 0');
    // BASELINE
    console.log('\n=== BASELINE ===');
    const [txCount] = await sql `SELECT COUNT(*) as cnt FROM ledger_transactions`;
    const [stripeCount] = await sql `SELECT COUNT(*) as cnt FROM stripe_outbound_log`;
    const [pendingCount] = await sql `SELECT COUNT(*) as cnt FROM ledger_transactions WHERE status = 'pending'`;
    console.log('Total transactions:', txCount.cnt);
    console.log('Pending transactions:', pendingCount.cnt);
    console.log('Stripe outbound:', stripeCount.cnt);
    // 2. TRIGGER CRASH WITH MOCK STRIPE
    console.log('\n=== TRIGGERING POST-STRIPE CRASH ===');
    console.log('Mock Stripe will succeed, then process will crash before commit');
    console.log('!!! EXIT 137 EXPECTED !!!\n');
    const { StripeMoneyEngine } = await import('../../services/StripeMoneyEngine.js');
    const eventId = ulid();
    try {
        await StripeMoneyEngine.handle(taskId, 'RELEASE_PAYOUT', {
            payoutAmountCents: 1000,
            hustlerId,
            hustlerStripeAccountId: 'acct_mock_crash2',
            taskId,
            posterId
        }, {
            eventId,
            stripeClient: mockStripeClient // Inject mock
        });
        console.log('ERROR: Process should have crashed!');
    }
    catch (err) {
        console.log('Error:', err.message);
    }
}
main().catch(err => console.error('FATAL:', err.message));
//# sourceMappingURL=crash-test-2.js.map