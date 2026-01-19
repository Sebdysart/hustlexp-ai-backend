#!/usr/bin/env npx tsx
/**
 * Create a fresh crash test scenario from scratch
 * Then trigger RELEASE_PAYOUT to crash the process
 */
import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';
import { ulid } from 'ulidx';
dotenv.config();
// ARM THE CRASH
process.env.CRASH_AFTER_PREPARE = '1';
const sql = neon(process.env.DATABASE_URL);
async function main() {
    console.log('=== CRASH TEST #1: FRESH SCENARIO ===\n');
    console.log('Creating completely fresh test data...\n');
    // 1. Create a fresh task
    const taskId = crypto.randomUUID();
    await sql.unsafe(`
        INSERT INTO tasks (id, title, description, category, created_by, price, status)
        VALUES ('${taskId}', 'Crash Test Fresh', 'Fresh crash test scenario', 'errands', 'crash-test-poster', 1000, 'in_progress')
    `);
    console.log('Created task:', taskId);
    // 2. Create ledger accounts for this scenario
    const platformId = 'platform';
    const posterId = 'crash-test-poster';
    const hustlerId = 'crash-test-hustler';
    // Check if platform accounts exist, if not create them
    const platformExists = await sql `SELECT id FROM ledger_accounts WHERE owner_id = ${platformId} AND name = 'receivable' LIMIT 1`;
    if (platformExists.length === 0) {
        await sql `INSERT INTO ledger_accounts (owner_type, owner_id, type, name, balance) VALUES ('platform', ${platformId}, 'asset', 'receivable', 0)`;
        await sql `INSERT INTO ledger_accounts (owner_type, owner_id, type, name, balance) VALUES ('platform', ${platformId}, 'liability', 'platform_dispute_hold', 0)`;
    }
    // Create poster receivable
    const [posterAccount] = await sql `
        INSERT INTO ledger_accounts (owner_type, owner_id, type, name, balance)
        VALUES ('user', ${posterId}, 'asset', 'receivable', 50000)
        RETURNING id
    `;
    console.log('Created poster account:', posterAccount.id);
    // Create task escrow
    const [taskEscrow] = await sql `
        INSERT INTO ledger_accounts (owner_type, owner_id, type, name, balance)
        VALUES ('task', ${taskId}, 'liability', 'task_escrow', 0)
        RETURNING id
    `;
    console.log('Created task escrow:', taskEscrow.id);
    // Create hustler receivable
    const [hustlerAccount] = await sql `
        INSERT INTO ledger_accounts (owner_type, owner_id, type, name, balance)
        VALUES ('user', ${hustlerId}, 'asset', 'receivable', 0)
        RETURNING id
    `;
    console.log('Created hustler account:', hustlerAccount.id);
    // 3. Simulate escrow being held (create initial transaction)
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
    // Update balances
    await sql `UPDATE ledger_accounts SET balance = balance - 1000 WHERE id = ${posterAccount.id}`;
    await sql `UPDATE ledger_accounts SET balance = balance + 1000 WHERE id = ${taskEscrow.id}`;
    console.log('Created escrow hold transaction:', holdTxId);
    // 4. Create money state lock in 'held' state (ready for release)
    await sql `
        INSERT INTO money_state_lock (task_id, current_state, next_allowed_event, poster_uid, version, stripe_payment_intent_id, stripe_charge_id)
        VALUES (${taskId}::uuid, 'held', ARRAY['RELEASE_PAYOUT', 'REFUND_ESCROW', 'DISPUTE_OPEN'], ${posterId}, 1, 'pi_test_crash', 'ch_test_crash')
        ON CONFLICT (task_id) DO UPDATE SET current_state = 'held', version = 1
    `;
    console.log('Created money state lock');
    // BASELINE
    console.log('\n=== BASELINE ===');
    const txCount = await sql `SELECT COUNT(*) as cnt FROM ledger_transactions`;
    const entryCount = await sql `SELECT COUNT(*) as cnt FROM ledger_entries`;
    const stripeCount = await sql `SELECT COUNT(*) as cnt FROM stripe_outbound_log`;
    console.log('Transactions:', txCount[0].cnt);
    console.log('Entries:', entryCount[0].cnt);
    console.log('Stripe outbound:', stripeCount[0].cnt);
    // 5. NOW TRIGGER THE CRASH
    console.log('\n=== TRIGGERING CRASH ===');
    console.log('!!! PROCESS WILL EXIT WITH CODE 137 !!!\n');
    const { StripeMoneyEngine } = await import('../../services/StripeMoneyEngine.js');
    const newEventId = ulid(); // Fresh ULID - newer than holdTxId
    try {
        await StripeMoneyEngine.handle(taskId, 'RELEASE_PAYOUT', {
            payoutAmountCents: 1000,
            hustlerId: hustlerId,
            hustlerStripeAccountId: 'acct_test_123',
            taskId: taskId,
            posterId: posterId
        }, { eventId: newEventId } // Pass eventId in options, not context
        );
        console.log('ERROR: Process did not crash!');
    }
    catch (err) {
        console.log('Error before crash:', err.message);
    }
}
main().catch(err => console.error('FATAL:', err.message));
//# sourceMappingURL=fresh-crash-test.js.map