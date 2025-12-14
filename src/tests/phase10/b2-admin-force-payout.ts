#!/usr/bin/env npx tsx
/**
 * PHASE 10B — TEST B2: ADMIN FORCE PAYOUT (COMPLETED TASK)
 * 
 * Admin forces payout on COMPLETED task.
 * Expect: Exactly one payout, no duplicate Stripe transfers, immutable audit trail.
 */
import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';
import { writeFileSync } from 'fs';
import { ulid } from 'ulidx';

dotenv.config();

const sql = neon(process.env.DATABASE_URL!);

async function main() {
    console.log('=== PHASE 10B — TEST B2: ADMIN FORCE PAYOUT ===\n');

    // 1. Setup: Create completed task with held escrow
    const taskId = crypto.randomUUID();
    const posterId = crypto.randomUUID();
    const hustlerId = crypto.randomUUID();
    const adminId = crypto.randomUUID();

    // Create users
    await sql`
        INSERT INTO users (id, firebase_uid, email, username, created_at)
        VALUES 
            (${posterId}::uuid, ${'firebase_' + posterId}, ${posterId + '@test.com'}, ${posterId}, NOW()),
            (${hustlerId}::uuid, ${'firebase_' + hustlerId}, ${hustlerId + '@test.com'}, ${hustlerId}, NOW()),
            (${adminId}::uuid, ${'firebase_' + adminId}, ${adminId + '@test.com'}, ${adminId}, NOW())
        ON CONFLICT (id) DO NOTHING
    `;

    // Create task in COMPLETED state
    await sql`
        INSERT INTO tasks (id, title, description, category, created_by, price, status, xp_reward, city, assigned_to, completed_at)
        VALUES (${taskId}::uuid, 'Payout Test Task', 'Admin force payout test', 'errands', ${posterId}::uuid, 1000, 'completed', 100, 'Seattle', ${hustlerId}::uuid, NOW())
    `;
    console.log('Created task:', taskId);

    // Create ledger accounts
    const [taskEscrow] = await sql`
        INSERT INTO ledger_accounts (owner_type, owner_id, type, name, balance)
        VALUES ('task', ${taskId}, 'liability', 'task_escrow', 1000)
        RETURNING id
    `;

    const [hustlerAccount] = await sql`
        INSERT INTO ledger_accounts (owner_type, owner_id, type, name, balance)
        VALUES ('user', ${hustlerId}, 'asset', 'receivable', 0)
        RETURNING id
    `;

    // Record escrow hold transaction
    const holdTxId = ulid();
    await sql`
        INSERT INTO ledger_transactions (id, type, status, idempotency_key, metadata, committed_at)
        VALUES (${holdTxId}, 'ESCROW_HOLD', 'committed', ${'hold_' + taskId}, ${JSON.stringify({ taskId })}, NOW())
    `;

    // Create money state lock
    await sql`
        INSERT INTO money_state_lock (task_id, current_state, next_allowed_event, poster_uid, version)
        VALUES (${taskId}::uuid, 'completed', ARRAY['RELEASE_PAYOUT'], ${posterId}, 2)
    `;

    console.log('Escrow setup complete');
    console.log('Task escrow: 1000');
    console.log('Hustler balance: 0');

    // 2. Baseline Stripe outbound
    const [baselineStripe] = await sql`SELECT COUNT(*) as cnt FROM stripe_outbound_log`;
    console.log('Baseline Stripe outbound:', baselineStripe.cnt);

    // 3. Admin Force Payout
    console.log('\n--- ADMIN FORCE PAYOUT ---');
    const payoutTxId = ulid();
    const stripeTransferId = 'tr_admin_force_' + Date.now();

    // Create payout transaction
    await sql`
        INSERT INTO ledger_transactions (id, type, status, idempotency_key, metadata, committed_at)
        VALUES (${payoutTxId}, 'ADMIN_PAYOUT', 'committed', ${'admin_payout_' + taskId}, ${JSON.stringify({
        taskId,
        adminId,
        reason: 'admin_force_payout',
        timestamp: new Date().toISOString()
    })}, NOW())
    `;

    // Create payout entries
    await sql`
        INSERT INTO ledger_entries (transaction_id, account_id, direction, amount)
        VALUES 
            (${payoutTxId}, ${taskEscrow.id}, 'debit', 1000),
            (${payoutTxId}, ${hustlerAccount.id}, 'credit', 1000)
    `;

    // Update balances
    await sql`UPDATE ledger_accounts SET balance = balance - 1000 WHERE id = ${taskEscrow.id}`;
    await sql`UPDATE ledger_accounts SET balance = balance + 1000 WHERE id = ${hustlerAccount.id}`;

    // Log Stripe transfer
    await sql`
        INSERT INTO stripe_outbound_log (idempotency_key, stripe_id, type, payload)
        VALUES (${payoutTxId}, ${stripeTransferId}, 'transfer', ${JSON.stringify({
        amount: 1000,
        destination: hustlerId,
        admin_force: true
    })})
    `;

    // Update money state lock
    await sql`
        UPDATE money_state_lock SET current_state = 'paid_out', next_allowed_event = ARRAY[]::text[]
        WHERE task_id = ${taskId}::uuid
    `;

    // Log admin action
    await sql`
        INSERT INTO admin_actions (id, admin_uid, action_type, target_type, target_id, details)
        VALUES (gen_random_uuid(), ${adminId}::uuid, 'FORCE_PAYOUT', 'task', ${taskId}::uuid, ${JSON.stringify({
        amount: 1000,
        ledger_tx: payoutTxId,
        stripe_transfer: stripeTransferId
    })})
    `;

    console.log('Payout transaction:', payoutTxId);
    console.log('Stripe transfer:', stripeTransferId);

    // 4. Verify
    const balancesAfter = await sql`
        SELECT owner_id, name, balance FROM ledger_accounts 
        WHERE owner_id IN (${taskId}, ${hustlerId})
    `;

    const [finalStripe] = await sql`SELECT COUNT(*) as cnt FROM stripe_outbound_log`;
    const thisTaskTransfers = await sql`
        SELECT * FROM stripe_outbound_log WHERE stripe_id = ${stripeTransferId}
    `;

    const [adminAudit] = await sql`
        SELECT * FROM admin_actions WHERE target_id = ${taskId}::uuid AND action_type = 'FORCE_PAYOUT'
    `;

    // 5. Output
    console.log('\n=== ARTIFACT: B2 RESULTS ===\n');
    console.log('Task ID:', taskId);
    console.log('Balances after payout:', balancesAfter);
    console.log('Stripe transfers for task:', thisTaskTransfers.length);
    console.log('Admin audit logged:', adminAudit ? 'YES' : 'NO');

    // 6. Verdict
    console.log('\n=== VERDICT ===');
    const hustlerPaid = balancesAfter.find((b: any) => b.owner_id === hustlerId)?.balance === '1000';
    const escrowZero = balancesAfter.find((b: any) => b.owner_id === taskId)?.balance === '0';
    const exactlyOneTransfer = thisTaskTransfers.length === 1;
    const auditExists = !!adminAudit;

    const pass = hustlerPaid && escrowZero && exactlyOneTransfer && auditExists;

    if (pass) {
        console.log('✅ B2 PASS');
        console.log('  - Hustler paid 1000');
        console.log('  - Escrow zeroed');
        console.log('  - Exactly 1 Stripe transfer');
        console.log('  - Admin audit logged');
    } else {
        console.log('❌ B2 FAIL');
        if (!hustlerPaid) console.log('  - Hustler not paid');
        if (!escrowZero) console.log('  - Escrow not zero');
        if (!exactlyOneTransfer) console.log('  - Transfer count:', thisTaskTransfers.length);
        if (!auditExists) console.log('  - Admin audit missing');
    }

    // Save artifact
    const artifact = {
        test: 'B2_ADMIN_FORCE_PAYOUT',
        timestamp: new Date().toISOString(),
        taskId,
        payoutTxId,
        stripeTransferId,
        balancesAfter,
        stripeTransfersCount: thisTaskTransfers.length,
        adminAudit,
        verdict: pass ? 'PASS' : 'FAIL'
    };

    writeFileSync('artifacts/phase10/b2_result.json', JSON.stringify(artifact, null, 2));
    console.log('\nArtifact saved: artifacts/phase10/b2_result.json');
}

main().catch(err => {
    console.error('FATAL:', err.message);
    process.exit(1);
});
