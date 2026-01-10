#!/usr/bin/env npx tsx
/**
 * PHASE 10A — TEST A1: TASK ACCEPTANCE STORM
 *
 * 200 concurrent users attempt to accept the same task.
 * Expect: Exactly 1 accepted, 199 rejected, no deadlocks.
 */
import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';
import { writeFileSync } from 'fs';
dotenv.config();
const sql = neon(process.env.DATABASE_URL);
const CONCURRENT_USERS = 200;
async function acceptTask(taskId, userId) {
    try {
        // Simulate task acceptance with row-level locking
        const result = await sql `
            UPDATE tasks
            SET assigned_to = ${userId}::uuid, status = 'assigned', updated_at = NOW()
            WHERE id = ${taskId}::uuid
            AND status = 'active'
            AND assigned_to IS NULL
            RETURNING id
        `;
        if (result.length === 0) {
            return { userId, success: false, error: 'ALREADY_ASSIGNED' };
        }
        return { userId, success: true };
    }
    catch (err) {
        return { userId, success: false, error: err.message };
    }
}
async function main() {
    console.log('=== PHASE 10A — TEST A1: TASK ACCEPTANCE STORM ===\n');
    // 1. Create poster user and fresh task
    const taskId = crypto.randomUUID();
    const posterId = crypto.randomUUID();
    // Create user first to satisfy FK
    await sql `
        INSERT INTO users (id, firebase_uid, email, username, created_at)
        VALUES (${posterId}::uuid, ${'firebase_' + posterId}, ${posterId + '@test.com'}, ${posterId}, NOW())
        ON CONFLICT (id) DO NOTHING
    `;
    await sql `
        INSERT INTO tasks (id, title, description, category, created_by, price, status, xp_reward, city)
        VALUES (${taskId}::uuid, 'Storm Test Task', 'Acceptance storm test', 'errands', ${posterId}::uuid, 1000, 'active', 100, 'Seattle')
    `;
    console.log('Created task:', taskId);
    // 2. Generate 200 user UUIDs and create them in DB
    const userIds = Array.from({ length: CONCURRENT_USERS }, () => crypto.randomUUID());
    // Batch create users
    console.log('Creating 200 test users...');
    await Promise.all(userIds.map(userId => sql `
            INSERT INTO users (id, firebase_uid, email, username, created_at)
            VALUES (${userId}::uuid, ${'firebase_' + userId}, ${userId + '@test.com'}, ${userId}, NOW())
            ON CONFLICT (id) DO NOTHING
        `));
    console.log('Users created');
    // 3. Fire ALL accepts concurrently
    console.log(`\nFiring ${CONCURRENT_USERS} concurrent accept requests...`);
    const startTime = Date.now();
    const results = await Promise.all(userIds.map(userId => acceptTask(taskId, userId)));
    const elapsed = Date.now() - startTime;
    console.log(`Completed in ${elapsed}ms\n`);
    // 4. Analyze results
    const successes = results.filter(r => r.success);
    const failures = results.filter(r => !r.success);
    // Error codes histogram
    const errorCodes = {};
    for (const f of failures) {
        const code = f.error || 'UNKNOWN';
        errorCodes[code] = (errorCodes[code] || 0) + 1;
    }
    // 5. Verify task state
    const [finalTask] = await sql `SELECT id, status, assigned_to FROM tasks WHERE id = ${taskId}::uuid`;
    // 6. Output artifact
    console.log('=== ARTIFACT: A1 RESULTS ===\n');
    console.log('Task ID:', taskId);
    console.log('Final Status:', finalTask.status);
    console.log('Assigned To:', finalTask.assigned_to);
    console.log('\nAccepts: SUCCESS =', successes.length, '| REJECTED =', failures.length);
    console.log('Error Codes Histogram:', errorCodes);
    // 7. PASS/FAIL
    console.log('\n=== VERDICT ===');
    const pass = successes.length === 1 && failures.length === CONCURRENT_USERS - 1;
    if (pass) {
        console.log('✅ A1 PASS');
        console.log('  - Exactly 1 accepted');
        console.log('  - 199 rejected deterministically');
    }
    else {
        console.log('❌ A1 FAIL');
        console.log('  - Expected 1 success, got', successes.length);
    }
    // Save artifact
    const artifact = {
        test: 'A1_TASK_ACCEPTANCE_STORM',
        timestamp: new Date().toISOString(),
        taskId,
        finalState: finalTask,
        totalRequests: CONCURRENT_USERS,
        successes: successes.length,
        failures: failures.length,
        errorHistogram: errorCodes,
        elapsedMs: elapsed,
        verdict: pass ? 'PASS' : 'FAIL'
    };
    writeFileSync('artifacts/phase10/a1_result.json', JSON.stringify(artifact, null, 2));
    console.log('\nArtifact saved: artifacts/phase10/a1_result.json');
}
main().catch(err => {
    console.error('FATAL:', err.message);
    process.exit(1);
});
//# sourceMappingURL=a1-acceptance-storm.js.map