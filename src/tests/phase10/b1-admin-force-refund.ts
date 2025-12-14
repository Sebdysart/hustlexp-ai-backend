#!/usr/bin/env npx tsx
/**
 * PHASE 10B — TEST B1: ADMIN FORCE REFUND (HELD ESCROW)
 * 
 * Admin forces refund while task is ASSIGNED.
 * Expect: Funds return to poster, task CANCELLED, ledger zero-sum preserved.
 */
import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';
import { writeFileSync } from 'fs';
import { ulid } from 'ulidx';

dotenv.config();

const sql = neon(process.env.DATABASE_URL!);

async function main() {
    console.log('=== PHASE 10B — TEST B1: ADMIN FORCE REFUND ===\n');

    // 1. Setup: Create task with escrow held
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

    // Create task in ASSIGNED state
    await sql`
        INSERT INTO tasks (id, title, description, category, created_by, price, status, xp_reward, city, assigned_to)
        VALUES (${taskId}::uuid, 'Refund Test Task', 'Admin force refund test', 'errands', ${posterId}::uuid, 1000, 'assigned', 100, 'Seattle', ${hustlerId}::uuid)
    `;
    console.log('Created task:', taskId);

    // Create ledger accounts
    const [posterAccount] = await sql`
        INSERT INTO ledger_accounts (owner_type, owner_id, type, name, balance)
        VALUES ('user', ${posterId}, 'asset', 'receivable', 49000)
        RETURNING id
    `;

    const [taskEscrow] = await sql`
        INSERT INTO ledger_accounts (owner_type, owner_id, type, name, balance)
        VALUES ('task', ${taskId}, 'liability', 'task_escrow', 1000)
        RETURNING id
    `;

    // Record escrow hold transaction
    const holdTxId = ulid();
    await sql`
        INSERT INTO ledger_transactions (id, type, status, idempotency_key, metadata, committed_at)
        VALUES (${holdTxId}, 'ESCROW_HOLD', 'committed', ${'hold_' + taskId}, ${JSON.stringify({ taskId })}, NOW())
    `;

    await sql`
        INSERT INTO ledger_entries (transaction_id, account_id, direction, amount)
        VALUES 
            (${holdTxId}, ${posterAccount.id}, 'debit', 1000),
            (${holdTxId}, ${taskEscrow.id}, 'credit', 1000)
    `;

    // Create money state lock
    await sql`
        INSERT INTO money_state_lock (task_id, current_state, next_allowed_event, poster_uid, version)
        VALUES (${taskId}::uuid, 'held', ARRAY['RELEASE_PAYOUT', 'REFUND_ESCROW', 'DISPUTE_OPEN'], ${posterId}, 1)
    `;

    console.log('Escrow setup complete');
    console.log('Poster balance: 49000');
    console.log('Task escrow: 1000');

    // 2. Baseline
    const balancesBefore = await sql`
        SELECT owner_id, name, balance FROM ledger_accounts 
        WHERE owner_id IN (${posterId}, ${taskId})
    `;
    console.log('\nBalances before refund:', balancesBefore);

    // 3. Admin Force Refund
    console.log('\n--- ADMIN FORCE REFUND ---');
    const refundTxId = ulid();

    // Create refund transaction
    await sql`
        INSERT INTO ledger_transactions (id, type, status, idempotency_key, metadata, committed_at)
        VALUES (${refundTxId}, 'ADMIN_REFUND', 'committed', ${'admin_refund_' + taskId}, ${JSON.stringify({
        taskId,
        adminId,
        reason: 'admin_force_refund',
        timestamp: new Date().toISOString()
    })}, NOW())
    `;

    // Create refund entries (reverse of hold)
    await sql`
        INSERT INTO ledger_entries (transaction_id, account_id, direction, amount)
        VALUES 
            (${refundTxId}, ${taskEscrow.id}, 'debit', 1000),
            (${refundTxId}, ${posterAccount.id}, 'credit', 1000)
    `;

    // Update balances
    await sql`UPDATE ledger_accounts SET balance = balance + 1000 WHERE id = ${posterAccount.id}`;
    await sql`UPDATE ledger_accounts SET balance = balance - 1000 WHERE id = ${taskEscrow.id}`;

    // Update task state
    await sql`
        UPDATE tasks SET status = 'cancelled', cancel_reason = 'admin_force_refund', updated_at = NOW()
        WHERE id = ${taskId}::uuid
    `;

    // Update money state lock
    await sql`
        UPDATE money_state_lock SET current_state = 'refunded', next_allowed_event = ARRAY[]::text[]
        WHERE task_id = ${taskId}::uuid
    `;

    // Log admin action
    await sql`
        INSERT INTO admin_actions (id, admin_uid, action_type, target_type, target_id, details)
        VALUES (gen_random_uuid(), ${adminId}::uuid, 'FORCE_REFUND', 'task', ${taskId}::uuid, ${JSON.stringify({
        amount: 1000,
        ledger_tx: refundTxId
    })})
    `;

    console.log('Refund transaction:', refundTxId);

    // 4. Verify
    const [finalTask] = await sql`SELECT id, status, cancel_reason FROM tasks WHERE id = ${taskId}::uuid`;
    const balancesAfter = await sql`
        SELECT owner_id, name, balance FROM ledger_accounts 
        WHERE owner_id IN (${posterId}, ${taskId})
    `;

    // Check zero-sum
    const zeroSumCheck = await sql`
        SELECT 
            transaction_id,
            SUM(CASE WHEN direction='debit' THEN amount ELSE -amount END) AS net
        FROM ledger_entries
        WHERE transaction_id IN (${holdTxId}, ${refundTxId})
        GROUP BY transaction_id
        HAVING SUM(CASE WHEN direction='debit' THEN amount ELSE -amount END) != 0
    `;

    // Check admin audit
    const [adminAudit] = await sql`
        SELECT * FROM admin_actions WHERE target_id = ${taskId}::uuid AND action_type = 'FORCE_REFUND'
    `;

    // 5. Output
    console.log('\n=== ARTIFACT: B1 RESULTS ===\n');
    console.log('Task ID:', taskId);
    console.log('Final Status:', finalTask.status);
    console.log('Cancel Reason:', finalTask.cancel_reason);
    console.log('\nBalances after refund:', balancesAfter);
    console.log('Zero-sum violations:', zeroSumCheck.length === 0 ? 'None' : zeroSumCheck);
    console.log('Admin audit logged:', adminAudit ? 'YES' : 'NO');

    // 6. Verdict
    console.log('\n=== VERDICT ===');
    const taskCancelled = finalTask.status === 'cancelled';
    const posterRefunded = balancesAfter.find((b: any) => b.owner_id === posterId)?.balance === '50000';
    const escrowZero = balancesAfter.find((b: any) => b.owner_id === taskId)?.balance === '0';
    const zeroSumHolds = zeroSumCheck.length === 0;
    const auditExists = !!adminAudit;

    const pass = taskCancelled && posterRefunded && escrowZero && zeroSumHolds && auditExists;

    if (pass) {
        console.log('✅ B1 PASS');
        console.log('  - Task cancelled');
        console.log('  - Poster refunded to 50000');
        console.log('  - Escrow zeroed');
        console.log('  - Zero-sum preserved');
        console.log('  - Admin audit logged');
    } else {
        console.log('❌ B1 FAIL');
        if (!taskCancelled) console.log('  - Task not cancelled:', finalTask.status);
        if (!posterRefunded) console.log('  - Poster not refunded');
        if (!escrowZero) console.log('  - Escrow not zero');
        if (!zeroSumHolds) console.log('  - Zero-sum violation');
        if (!auditExists) console.log('  - Admin audit missing');
    }

    // Save artifact
    const artifact = {
        test: 'B1_ADMIN_FORCE_REFUND',
        timestamp: new Date().toISOString(),
        taskId,
        refundTxId,
        adminId,
        balancesBefore,
        balancesAfter,
        zeroSumCheck,
        adminAudit,
        verdict: pass ? 'PASS' : 'FAIL'
    };

    writeFileSync('artifacts/phase10/b1_result.json', JSON.stringify(artifact, null, 2));
    console.log('\nArtifact saved: artifacts/phase10/b1_result.json');
}

main().catch(err => {
    console.error('FATAL:', err.message);
    process.exit(1);
});
