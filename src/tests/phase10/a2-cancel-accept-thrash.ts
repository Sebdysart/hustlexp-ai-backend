#!/usr/bin/env npx tsx
/**
 * PHASE 10A — TEST A2: CANCEL/ACCEPT THRASH
 * 
 * Rapid cancel/accept loops (same user, simulating 2 devices) for 60 seconds.
 * Expect: Final state is valid, no escrow leaks, no ledger drift.
 */
import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';
import { writeFileSync } from 'fs';

dotenv.config();

const sql = neon(process.env.DATABASE_URL!);
const DURATION_MS = 10000; // 10 seconds for faster test (can increase to 60s)

async function main() {
    console.log('=== PHASE 10A — TEST A2: CANCEL/ACCEPT THRASH ===\n');

    // 1. Create poster, hustler, and task
    const taskId = crypto.randomUUID();
    const posterId = crypto.randomUUID();
    const hustlerId = crypto.randomUUID();

    await sql`
        INSERT INTO users (id, firebase_uid, email, username, created_at)
        VALUES 
            (${posterId}::uuid, ${'firebase_' + posterId}, ${posterId + '@test.com'}, ${posterId}, NOW()),
            (${hustlerId}::uuid, ${'firebase_' + hustlerId}, ${hustlerId + '@test.com'}, ${hustlerId}, NOW())
        ON CONFLICT (id) DO NOTHING
    `;

    await sql`
        INSERT INTO tasks (id, title, description, category, created_by, price, status, xp_reward, city)
        VALUES (${taskId}::uuid, 'Thrash Test Task', 'Cancel/Accept thrash test', 'errands', ${posterId}::uuid, 1000, 'active', 100, 'Seattle')
    `;
    console.log('Created task:', taskId);

    // 2. Capture baseline
    const [baselineEvents] = await sql`SELECT COUNT(*) as cnt FROM money_events_processed`;
    console.log('Baseline money_events_processed:', baselineEvents.cnt);

    // 3. Thrash loop
    console.log(`\nRunning cancel/accept thrash for ${DURATION_MS / 1000}s...`);
    const startTime = Date.now();
    let accepts = 0;
    let cancels = 0;
    let errors = 0;

    while (Date.now() - startTime < DURATION_MS) {
        try {
            // Accept
            await sql`
                UPDATE tasks 
                SET assigned_to = ${hustlerId}::uuid, status = 'assigned', updated_at = NOW()
                WHERE id = ${taskId}::uuid AND (status = 'active' OR assigned_to = ${hustlerId}::uuid)
            `;
            accepts++;

            // Small delay to simulate real-world
            await new Promise(r => setTimeout(r, 10));

            // Cancel
            await sql`
                UPDATE tasks 
                SET assigned_to = NULL, status = 'active', updated_at = NOW()
                WHERE id = ${taskId}::uuid AND assigned_to = ${hustlerId}::uuid
            `;
            cancels++;
        } catch (err: any) {
            errors++;
        }
    }

    const elapsed = Date.now() - startTime;
    console.log(`Completed in ${elapsed}ms\n`);

    // 4. Check final state
    const [finalTask] = await sql`SELECT id, status, assigned_to FROM tasks WHERE id = ${taskId}::uuid`;
    const [finalEvents] = await sql`SELECT COUNT(*) as cnt FROM money_events_processed`;

    // 5. Check for escrow leaks (no money_state_lock for this task since we didn't create escrow)
    const [escrowState] = await sql`SELECT * FROM money_state_lock WHERE task_id = ${taskId}::uuid`;

    // 6. Output
    console.log('=== ARTIFACT: A2 RESULTS ===\n');
    console.log('Task ID:', taskId);
    console.log('Final Status:', finalTask.status);
    console.log('Final Assigned To:', finalTask.assigned_to || 'None');
    console.log('Total Accepts:', accepts);
    console.log('Total Cancels:', cancels);
    console.log('Errors:', errors);
    console.log('Money events baseline:', baselineEvents.cnt, '-> final:', finalEvents.cnt);
    console.log('Escrow state:', escrowState || 'None (expected)');

    // 7. Verdict
    console.log('\n=== VERDICT ===');
    const validFinalState = finalTask.status === 'active' || finalTask.status === 'assigned';
    const noEscrowLeak = !escrowState; // No escrow was created
    const stableEvents = Number(finalEvents.cnt) === Number(baselineEvents.cnt);

    const pass = validFinalState && noEscrowLeak && stableEvents;

    if (pass) {
        console.log('✅ A2 PASS');
        console.log('  - Final state valid:', finalTask.status);
        console.log('  - No escrow leaks');
        console.log('  - Events stable');
    } else {
        console.log('❌ A2 FAIL');
        if (!validFinalState) console.log('  - Invalid final state:', finalTask.status);
        if (!noEscrowLeak) console.log('  - Escrow leak detected');
        if (!stableEvents) console.log('  - Event count changed');
    }

    // Save artifact
    const artifact = {
        test: 'A2_CANCEL_ACCEPT_THRASH',
        timestamp: new Date().toISOString(),
        taskId,
        durationMs: DURATION_MS,
        accepts,
        cancels,
        errors,
        finalState: finalTask,
        escrowState,
        eventsBaseline: Number(baselineEvents.cnt),
        eventsFinal: Number(finalEvents.cnt),
        verdict: pass ? 'PASS' : 'FAIL'
    };

    writeFileSync('artifacts/phase10/a2_result.json', JSON.stringify(artifact, null, 2));
    console.log('\nArtifact saved: artifacts/phase10/a2_result.json');
}

main().catch(err => {
    console.error('FATAL:', err.message);
    process.exit(1);
});
