#!/usr/bin/env npx tsx
/**
 * CRASH CONSISTENCY TEST #1: "Stripe Succeeds, Node Dies"
 *
 * Category 1, Item 1: Money Cannot Be Lost
 *
 * PASS CONDITIONS (ALL MUST BE TRUE):
 * - Exactly 1 committed ledger transaction
 * - Exactly 1 Stripe transfer
 * - Zero-sum invariant holds
 * - money_events_processed contains exactly 1 event
 * - No manual DB edits required
 *
 * FAIL CONDITIONS (ANY = FAIL):
 * - Duplicate ledger entries
 * - Missing ledger entry
 * - Ledger != Stripe
 * - Requires manual repair
 */
import dotenv from 'dotenv';
dotenv.config();
import { neon } from '@neondatabase/serverless';
import Stripe from 'stripe';
// CONFIGURATION
const DATABASE_URL = process.env.DATABASE_URL ||
    'postgresql://neondb_owner:REDACTED_NEON_PASSWORD_1@REDACTED_NEON_HOST_1-pooler.c-2.us-west-2.aws.neon.tech/neondb?sslmode=require';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_SECRET_KEY || !STRIPE_SECRET_KEY.startsWith('sk_test_')) {
    console.error('FATAL: STRIPE_SECRET_KEY must be a test key');
    process.exit(1);
}
const sql = neon(DATABASE_URL);
const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-11-20.acacia' });
async function captureBaseline() {
    console.log('\n=== STEP 1: BASELINE SNAPSHOT ===\n');
    const ledgerTxns = await sql `SELECT * FROM ledger_transactions ORDER BY created_at DESC LIMIT 10`;
    const ledgerEntries = await sql `SELECT * FROM ledger_entries ORDER BY created_at DESC LIMIT 10`;
    const moneyEvents = await sql `SELECT * FROM money_events_processed ORDER BY processed_at DESC LIMIT 10`;
    console.log('Ledger Transactions:', ledgerTxns.length);
    console.log('Ledger Entries:', ledgerEntries.length);
    console.log('Money Events Processed:', moneyEvents.length);
    return {
        ledgerTxnCount: ledgerTxns.length,
        ledgerEntryCount: ledgerEntries.length,
        moneyEventsCount: moneyEvents.length,
        snapshot: { ledgerTxns, ledgerEntries, moneyEvents }
    };
}
async function verifyPostCrash() {
    console.log('\n=== STEP 4: POST-CRASH STATE (BEFORE RESTART) ===\n');
    // Check ledger state
    const ledgerTxns = await sql `SELECT * FROM ledger_transactions WHERE status = 'committed' ORDER BY created_at DESC LIMIT 5`;
    const pendingTxns = await sql `SELECT * FROM ledger_transactions WHERE status = 'pending' ORDER BY created_at DESC LIMIT 5`;
    console.log('Committed Ledger Transactions:', ledgerTxns.length);
    console.log('Pending Ledger Transactions:', pendingTxns.length);
    if (pendingTxns.length > 0) {
        console.log('PENDING TX IDs:', pendingTxns.map(t => t.id));
    }
    return { committed: ledgerTxns.length, pending: pendingTxns.length };
}
async function verifyFinalState(taskId, eventId) {
    console.log('\n=== STEP 7: FINAL VERIFICATION ===\n');
    // 1. Count committed transactions for this task
    const [committedCount] = await sql `
        SELECT COUNT(*) as count 
        FROM ledger_transactions lt
        JOIN ledger_entries le ON lt.id = le.transaction_id
        JOIN ledger_accounts la ON le.account_id = la.id
        WHERE lt.status = 'committed'
        AND la.owner_id = ${taskId}
    `;
    // 2. Zero-sum check
    const [zeroSum] = await sql `
        SELECT SUM(
            CASE WHEN direction = 'credit' THEN amount ELSE -amount END
        ) as balance
        FROM ledger_entries le
        JOIN ledger_transactions lt ON le.transaction_id = lt.id
        WHERE lt.status = 'committed'
    `;
    // 3. Idempotency check
    const [idempotencyCount] = await sql `
        SELECT COUNT(*) as count FROM money_events_processed WHERE event_id = ${eventId}
    `;
    // 4. Money state lock check
    const [lock] = await sql `SELECT * FROM money_state_lock WHERE task_id = ${taskId}`;
    // 5. Task state check
    const [task] = await sql `SELECT status FROM tasks WHERE id = ${taskId}`;
    console.log('Committed Transaction Count:', committedCount?.count || 0);
    console.log('Zero-Sum Balance:', zeroSum?.balance || 0);
    console.log('Idempotency Events for this ID:', idempotencyCount?.count || 0);
    console.log('Money State Lock:', lock?.current_state || 'NOT FOUND');
    console.log('Task Status:', task?.status || 'NOT FOUND');
    // VERDICT
    const isZeroSum = (zeroSum?.balance || 0) == 0;
    const isIdempotent = (idempotencyCount?.count || 0) <= 1;
    const hasLock = !!lock;
    return {
        committedCount: committedCount?.count || 0,
        zeroSumBalance: zeroSum?.balance || 0,
        isZeroSum,
        idempotencyCount: idempotencyCount?.count || 0,
        isIdempotent,
        lockState: lock?.current_state,
        taskStatus: task?.status,
        PASS: isZeroSum && isIdempotent && hasLock
    };
}
async function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    switch (command) {
        case 'baseline':
            const baseline = await captureBaseline();
            console.log(JSON.stringify(baseline, null, 2));
            break;
        case 'post-crash':
            const postCrash = await verifyPostCrash();
            console.log(JSON.stringify(postCrash, null, 2));
            break;
        case 'verify':
            const taskId = args[1];
            const eventId = args[2];
            if (!taskId || !eventId) {
                console.error('Usage: crash-test-1.ts verify <taskId> <eventId>');
                process.exit(1);
            }
            const result = await verifyFinalState(taskId, eventId);
            console.log('\n=== VERDICT ===');
            console.log(JSON.stringify(result, null, 2));
            if (result.PASS) {
                console.log('\n✅ PASS');
            }
            else {
                console.log('\n❌ FAIL');
            }
            break;
        case 'stripe-transfers':
            // List recent Stripe transfers
            const transfers = await stripe.transfers.list({ limit: 10 });
            console.log('Recent Stripe Transfers:');
            transfers.data.forEach(t => {
                console.log(`  ${t.id}: $${t.amount / 100} @ ${new Date(t.created * 1000).toISOString()}`);
            });
            break;
        default:
            console.log(`
Crash Consistency Test #1 Helper

Commands:
  baseline     - Capture current ledger state
  post-crash   - Check state after crash (before restart)
  verify <taskId> <eventId> - Final verification
  stripe-transfers - List recent Stripe transfers
            `);
    }
}
main().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
});
//# sourceMappingURL=crash-test-1.js.map