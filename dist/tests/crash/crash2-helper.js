#!/usr/bin/env npx tsx
/**
 * Crash Test #2 Verification Helper
 */
import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';
dotenv.config();
const sql = neon(process.env.DATABASE_URL);
async function main() {
    const command = process.argv[2];
    if (command === 'post-crash') {
        console.log('=== POST-CRASH #2 INSPECTION ===');
        const txs = await sql `
            SELECT id, status, type, created_at 
            FROM ledger_transactions 
            ORDER BY created_at DESC LIMIT 5
        `;
        console.log('\nRecent Transactions:');
        txs.forEach((t) => console.log(`  ${t.id}: ${t.status} (${t.type})`));
        const pending = await sql `SELECT * FROM ledger_transactions WHERE status = 'pending'`;
        console.log('\nPending transactions:', pending.length);
        const stripeLog = await sql `SELECT * FROM stripe_outbound_log ORDER BY created_at DESC LIMIT 5`;
        console.log('\nRecent Stripe Outbound:');
        stripeLog.forEach((s) => console.log(`  ${s.idempotency_key}: ${s.stripe_id} (${s.type})`));
        // Check if transfer was logged
        const crash2Transfer = await sql `SELECT * FROM stripe_outbound_log WHERE stripe_id LIKE 'tr_mock_crash2%'`;
        console.log('\nCrash2 transfer logged:', crash2Transfer.length > 0 ? 'YES' : 'NO');
    }
    else if (command === 'verify') {
        console.log('=== CRASH TEST #2 FINAL VERIFICATION ===');
        // 1. Transaction status
        const status = await sql `SELECT status, COUNT(*) as cnt FROM ledger_transactions GROUP BY status`;
        console.log('\nTransaction Status Distribution:');
        status.forEach((s) => console.log(`  ${s.status}: ${s.cnt}`));
        // 2. Pending count
        const pending = await sql `SELECT * FROM ledger_transactions WHERE status = 'pending'`;
        console.log('\nPending transactions:', pending.length === 0 ? 'None (GOOD)' : pending.length + ' FOUND');
        // 3. Zero-sum check
        const nonZero = await sql `
            SELECT 
                transaction_id,
                SUM(CASE WHEN direction='debit' THEN amount ELSE -amount END) AS net
            FROM ledger_entries
            GROUP BY transaction_id
            HAVING SUM(CASE WHEN direction='debit' THEN amount ELSE -amount END) != 0
        `;
        console.log('Non-zero sum transactions:', nonZero.length === 0 ? 'None (GOOD)' : 'FOUND!');
        // 4. Stripe outbound
        const [stripeCount] = await sql `SELECT COUNT(*) as cnt FROM stripe_outbound_log`;
        console.log('Stripe outbound records:', stripeCount.cnt);
        // 5. Check for duplicate transfers (crash2 specific)
        const crash2Transfers = await sql `SELECT * FROM stripe_outbound_log WHERE stripe_id LIKE 'tr_mock_crash2%'`;
        console.log('Crash2 transfers:', crash2Transfers.length);
        // VERDICT
        console.log('\n=== VERDICT ===');
        const pass = pending.length === 0 &&
            nonZero.length === 0 &&
            crash2Transfers.length <= 1;
        if (pass) {
            console.log('✅ CRASH TEST #2 PASSED');
        }
        else {
            console.log('❌ CRASH TEST #2 FAILED');
            if (pending.length > 0)
                console.log('  - Pending transactions remain');
            if (nonZero.length > 0)
                console.log('  - Zero-sum violation');
            if (crash2Transfers.length > 1)
                console.log('  - DUPLICATE STRIPE TRANSFERS');
        }
    }
    else {
        console.log('Usage: crash2-helper.ts <post-crash|verify>');
    }
}
main().catch(err => console.error('ERROR:', err.message));
//# sourceMappingURL=crash2-helper.js.map