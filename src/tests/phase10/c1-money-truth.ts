#!/usr/bin/env npx tsx
/**
 * PHASE 10C — TEST C1: MONEY TRUTH CHECK (RECONCILIATION)
 */
import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';
import { writeFileSync } from 'fs';

dotenv.config();
const sql = neon(process.env.DATABASE_URL!);

async function main() {
    console.log('=== PHASE 10C — TEST C1: MONEY TRUTH CHECK ===\n');

    // 1. Ledger totals
    const ledgerTotals = await sql`
        SELECT 
            SUM(CASE WHEN direction='debit' THEN amount ELSE 0 END) as total_debits,
            SUM(CASE WHEN direction='credit' THEN amount ELSE 0 END) as total_credits
        FROM ledger_entries
    `;
    console.log('Ledger Totals:', ledgerTotals[0]);

    // 2. Stripe mirror totals
    const stripeTotals = await sql`
        SELECT 
            type,
            COUNT(*) as count,
            SUM((payload->>'amount')::numeric) as total_amount
        FROM stripe_outbound_log
        WHERE payload->>'amount' IS NOT NULL
        GROUP BY type
    `;
    console.log('Stripe Outbound by Type:', stripeTotals);

    // 3. Zero-sum check (all transactions)
    const nonZeroSum = await sql`
        SELECT 
            transaction_id,
            SUM(CASE WHEN direction='debit' THEN amount ELSE -amount END) AS net
        FROM ledger_entries
        GROUP BY transaction_id
        HAVING SUM(CASE WHEN direction='debit' THEN amount ELSE -amount END) != 0
    `;
    console.log('Non-zero sum transactions:', nonZeroSum.length);

    // 4. Account balance integrity
    const accountCheck = await sql`
        SELECT 
            la.id,
            la.owner_id,
            la.balance as recorded_balance,
            COALESCE(SUM(CASE WHEN le.direction='credit' THEN le.amount ELSE -le.amount END), 0) as computed_balance
        FROM ledger_accounts la
        LEFT JOIN ledger_entries le ON le.account_id = la.id
        GROUP BY la.id, la.owner_id, la.balance
        HAVING la.balance != COALESCE(SUM(CASE WHEN le.direction='credit' THEN le.amount ELSE -le.amount END), 0)
    `;
    console.log('Balance mismatches:', accountCheck.length);

    // 5. Calculate drift
    const totalDebits = Number(ledgerTotals[0]?.total_debits || 0);
    const totalCredits = Number(ledgerTotals[0]?.total_credits || 0);
    const drift = Math.abs(totalDebits - totalCredits);

    console.log('\n=== ARTIFACT: C1 RESULTS ===');
    console.log('Total Debits:', totalDebits);
    console.log('Total Credits:', totalCredits);
    console.log('Drift: $' + (drift / 100).toFixed(2));
    console.log('Zero-sum violations:', nonZeroSum.length);
    console.log('Balance mismatches:', accountCheck.length);

    // Verdict
    console.log('\n=== VERDICT ===');
    const pass = drift === 0 && nonZeroSum.length === 0;

    if (pass) {
        console.log('✅ C1 PASS');
        console.log('  - Drift = $0.00');
        console.log('  - All transactions zero-sum');
    } else {
        console.log('❌ C1 FAIL');
        if (drift !== 0) console.log('  - Drift: $' + (drift / 100).toFixed(2));
        if (nonZeroSum.length > 0) console.log('  - Non-zero sum:', nonZeroSum.length);
    }

    const artifact = {
        test: 'C1_MONEY_TRUTH_CHECK',
        timestamp: new Date().toISOString(),
        totalDebits,
        totalCredits,
        driftCents: drift,
        driftDollars: (drift / 100).toFixed(2),
        nonZeroSumCount: nonZeroSum.length,
        balanceMismatches: accountCheck.length,
        verdict: pass ? 'PASS' : 'FAIL'
    };

    writeFileSync('artifacts/phase10/c1_reconciliation.json', JSON.stringify(artifact, null, 2));
    console.log('\nArtifact saved: artifacts/phase10/c1_reconciliation.json');
}

main().catch(err => {
    console.error('FATAL:', err.message);
    process.exit(1);
});
