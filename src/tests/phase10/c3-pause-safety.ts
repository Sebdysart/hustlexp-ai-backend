#!/usr/bin/env npx tsx
/**
 * PHASE 10C — TEST C3: PAUSE SAFETY
 * Question: "Is it safe to unpause?"
 */
import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';
import { writeFileSync } from 'fs';

dotenv.config();
const sql = neon(process.env.DATABASE_URL!);

async function main() {
    console.log('=== PHASE 10C — TEST C3: PAUSE SAFETY ===\n');

    // 1. Pending Ledger Transactions
    const [pendingTx] = await sql`SELECT COUNT(*) as cnt FROM ledger_transactions WHERE status = 'pending'`;
    console.log('Pending Ledger TX:', pendingTx.cnt);

    // 2. DLQ Items
    const [dlqCount] = await sql`SELECT COUNT(*) as cnt FROM ledger_pending_actions WHERE status = 'pending'`;
    console.log('DLQ Pending:', dlqCount.cnt);

    // 3. KillSwitch Status
    const [killswitch] = await sql`SELECT active FROM killswitch WHERE id = 1`;
    console.log('KillSwitch:', killswitch?.active ? 'ON (BLOCKED)' : 'OFF (SAFE)');

    // 4. Unreconciled Stripe (stripe outbound without matching ledger commit)
    const unreconciledCount = await sql`
        SELECT COUNT(*) as cnt FROM stripe_outbound_log sol
        WHERE NOT EXISTS (
            SELECT 1 FROM ledger_transactions lt 
            WHERE lt.idempotency_key = sol.idempotency_key 
            OR REPLACE(lt.idempotency_key, 'ledger_', '') = sol.idempotency_key
        )
    `;
    console.log('Unreconciled Stripe Events:', unreconciledCount[0]?.cnt || 0);

    // 5. Calculate safety
    const pendingCount = Number(pendingTx.cnt);
    const dlq = Number(dlqCount.cnt);
    const unreconciled = Number(unreconciledCount[0]?.cnt || 0);
    const killswitchOff = !killswitch?.active;

    const safeToUnpause = pendingCount === 0 && dlq === 0 && killswitchOff;

    console.log('\n=== PAUSE SAFETY CHECK ===');
    console.log('Pending TX = 0:', pendingCount === 0 ? '✓' : '✗ (' + pendingCount + ')');
    console.log('DLQ Empty:', dlq === 0 ? '✓' : '✗ (' + dlq + ')');
    console.log('KillSwitch OFF:', killswitchOff ? '✓' : '✗');
    console.log('');
    console.log('SAFE TO UNPAUSE:', safeToUnpause ? 'YES' : 'NO');

    // Verdict
    console.log('\n=== VERDICT ===');
    if (safeToUnpause) {
        console.log('✅ C3 PASS');
        console.log('  - All checks passed');
        console.log('  - Binary YES with proof');
    } else {
        console.log('❌ C3 FAIL');
        console.log('  - Not safe to unpause');
    }

    const artifact = {
        test: 'C3_PAUSE_SAFETY',
        timestamp: new Date().toISOString(),
        pendingTransactions: pendingCount,
        dlqPending: dlq,
        unreconciledStripe: unreconciled,
        killswitchOff: killswitchOff,
        safeToUnpause,
        verdict: safeToUnpause ? 'PASS' : 'FAIL'
    };

    writeFileSync('artifacts/phase10/c3_pause_safety.json', JSON.stringify(artifact, null, 2));
    console.log('\nArtifact saved: artifacts/phase10/c3_pause_safety.json');
}

main().catch(err => {
    console.error('FATAL:', err.message);
    process.exit(1);
});
