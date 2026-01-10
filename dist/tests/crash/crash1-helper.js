#!/usr/bin/env npx tsx
import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config();
const sql = neon(process.env.DATABASE_URL);
async function main() {
    const command = process.argv[2];
    if (command === 'baseline') {
        console.log('=== BASELINE SNAPSHOT ===');
        const txCount = await sql `SELECT COUNT(*) as count FROM ledger_transactions`;
        const entryCount = await sql `SELECT COUNT(*) as count FROM ledger_entries`;
        const stripeCount = await sql `SELECT COUNT(*) as count FROM stripe_outbound_log`;
        const output = `
BASELINE SNAPSHOT
=================
Timestamp: ${new Date().toISOString()}

ledger_transactions: ${txCount[0].count}
ledger_entries: ${entryCount[0].count}
stripe_outbound_log: ${stripeCount[0].count}
`;
        console.log(output);
        fs.writeFileSync('artifacts/crash1/before.txt', output);
        console.log('Saved to artifacts/crash1/before.txt');
    }
    else if (command === 'post-crash') {
        console.log('=== POST-CRASH INSPECTION ===');
        const txs = await sql `SELECT id, status, type, created_at FROM ledger_transactions ORDER BY created_at DESC LIMIT 5`;
        const prepares = await sql `SELECT * FROM ledger_prepares ORDER BY created_at DESC LIMIT 5`;
        const entries = await sql `SELECT * FROM ledger_entries ORDER BY created_at DESC LIMIT 10`;
        console.log('\nRecent Transactions:');
        txs.forEach((t) => console.log(`  ${t.id}: ${t.status} (${t.type})`));
        console.log('\nRecent Prepares:');
        prepares.forEach((p) => console.log(`  ${p.ulid}: ${p.type}`));
        console.log('\nRecent Entries:');
        entries.forEach((e) => console.log(`  TX ${e.transaction_id}: ${e.direction} ${e.amount}`));
        // Check for corruption
        console.log('\n=== CORRUPTION CHECK ===');
        // Partial entries (transactions with odd number of entries)
        const partialTx = await sql `
            SELECT transaction_id, COUNT(*) as cnt 
            FROM ledger_entries 
            GROUP BY transaction_id 
            HAVING COUNT(*) < 2
        `;
        console.log('Partial transactions (< 2 entries):', partialTx.length > 0 ? 'FOUND!' : 'None');
        // Duplicate prepares
        const dupPrepares = await sql `
            SELECT idempotency_key, COUNT(*) as cnt 
            FROM ledger_prepares 
            GROUP BY idempotency_key 
            HAVING COUNT(*) > 1
        `;
        console.log('Duplicate prepares:', dupPrepares.length > 0 ? 'FOUND!' : 'None');
        const output = {
            transactions: txs,
            prepares: prepares,
            entries: entries,
            partialTx: partialTx,
            dupPrepares: dupPrepares
        };
        fs.writeFileSync('artifacts/crash1/post-crash.json', JSON.stringify(output, null, 2));
    }
    else if (command === 'verify') {
        console.log('=== FINAL VERIFICATION ===');
        // Status distribution
        const statusDist = await sql `SELECT status, COUNT(*) as count FROM ledger_transactions GROUP BY status`;
        console.log('\nTransaction Status Distribution:');
        statusDist.forEach((s) => console.log(`  ${s.status}: ${s.count}`));
        // Zero-sum check
        const nonZeroSum = await sql `
            SELECT 
                transaction_id,
                SUM(CASE WHEN direction='debit' THEN amount ELSE -amount END) AS net
            FROM ledger_entries
            GROUP BY transaction_id
            HAVING SUM(CASE WHEN direction='debit' THEN amount ELSE -amount END) != 0
        `;
        console.log('\nNon-zero sum transactions:', nonZeroSum.length > 0 ? 'FOUND!' : 'None (GOOD)');
        if (nonZeroSum.length > 0) {
            console.log('CORRUPTION:', nonZeroSum);
        }
        // Stripe outbound count
        const stripeCount = await sql `SELECT COUNT(*) as count FROM stripe_outbound_log`;
        console.log('\nStripe outbound records:', stripeCount[0].count);
        // Pending transactions
        const pending = await sql `SELECT id FROM ledger_transactions WHERE status = 'pending'`;
        console.log('Pending transactions:', pending.length > 0 ? pending.length + ' FOUND' : 'None (GOOD)');
        // VERDICT
        console.log('\n=== VERDICT ===');
        const pass = nonZeroSum.length === 0 && pending.length === 0;
        if (pass) {
            console.log('✅ CRASH TEST #1 PASSED');
        }
        else {
            console.log('❌ CRASH TEST #1 FAILED');
            if (nonZeroSum.length > 0)
                console.log('  - Non-zero sum transactions found');
            if (pending.length > 0)
                console.log('  - Stuck pending transactions');
        }
        const output = {
            statusDistribution: statusDist,
            nonZeroSum: nonZeroSum,
            stripeCount: stripeCount[0].count,
            pendingCount: pending.length,
            PASS: pass
        };
        fs.writeFileSync('artifacts/crash1/final.json', JSON.stringify(output, null, 2));
    }
    else {
        console.log('Usage: crash1-helper.ts <baseline|post-crash|verify>');
    }
}
main().catch(err => {
    console.error('ERROR:', err.message);
    process.exit(1);
});
//# sourceMappingURL=crash1-helper.js.map