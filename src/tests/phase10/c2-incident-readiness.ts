#!/usr/bin/env npx tsx
/**
 * PHASE 10C — TEST C2: INCIDENT READINESS
 * Question: "What is broken right now?"
 */
import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';
import { writeFileSync } from 'fs';

dotenv.config();
const sql = neon(process.env.DATABASE_URL!);

async function main() {
    console.log('=== PHASE 10C — TEST C2: INCIDENT READINESS ===\n');
    const startTime = Date.now();

    // 1. DLQ Status
    const [dlqCount] = await sql`SELECT COUNT(*) as cnt FROM ledger_pending_actions WHERE status = 'pending'`;
    console.log('DLQ Pending Items:', dlqCount.cnt);

    // 2. KillSwitch Status
    const [killswitch] = await sql`SELECT active, reason, activated_at FROM killswitch WHERE id = 1`;
    console.log('KillSwitch Active:', killswitch?.active ? 'YES - ' + killswitch.reason : 'NO');

    // 3. Pending Transactions
    const [pendingTx] = await sql`SELECT COUNT(*) as cnt FROM ledger_transactions WHERE status = 'pending'`;
    console.log('Pending Transactions:', pendingTx.cnt);

    // 4. Failed Transactions (last 15 min)
    const [failedTx] = await sql`
        SELECT COUNT(*) as cnt FROM ledger_transactions 
        WHERE status = 'failed' AND created_at > NOW() - INTERVAL '15 minutes'
    `;
    console.log('Failed Transactions (15m):', failedTx.cnt);

    // 5. Last Reconcile (simulated - use latest ledger tx)
    const [lastTx] = await sql`SELECT MAX(committed_at) as last FROM ledger_transactions WHERE status = 'committed'`;
    console.log('Last Committed TX:', lastTx?.last || 'None');

    const elapsed = Date.now() - startTime;
    console.log('\nQuery Time:', elapsed + 'ms');

    // Verdict
    console.log('\n=== VERDICT ===');
    const pass = elapsed < 30000; // < 30 seconds

    if (pass) {
        console.log('✅ C2 PASS');
        console.log('  - Clear status in', elapsed + 'ms');
        console.log('  - DLQ visible');
        console.log('  - KillSwitch visible');
    } else {
        console.log('❌ C2 FAIL');
        console.log('  - Query took >', elapsed, 'ms');
    }

    const artifact = {
        test: 'C2_INCIDENT_READINESS',
        timestamp: new Date().toISOString(),
        queryTimeMs: elapsed,
        dlqPending: Number(dlqCount.cnt),
        killswitchActive: killswitch?.active || false,
        killswitchReason: killswitch?.reason,
        pendingTransactions: Number(pendingTx.cnt),
        failedTransactions15m: Number(failedTx.cnt),
        lastCommittedTx: lastTx?.last,
        verdict: pass ? 'PASS' : 'FAIL'
    };

    writeFileSync('artifacts/phase10/c2_incident_view.json', JSON.stringify(artifact, null, 2));
    console.log('\nArtifact saved: artifacts/phase10/c2_incident_view.json');
}

main().catch(err => {
    console.error('FATAL:', err.message);
    process.exit(1);
});
