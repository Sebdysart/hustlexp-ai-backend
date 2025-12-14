#!/usr/bin/env npx tsx
/**
 * Trigger a crash test scenario by calling the money engine
 */
import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';

dotenv.config();

const sql = neon(process.env.DATABASE_URL!);

async function main() {
    console.log('=== CRASH TEST TRIGGER ===');

    // Check for existing tasks and money states
    const tasks = await sql`SELECT id, status, created_by FROM tasks ORDER BY created_at DESC LIMIT 5`;
    console.log('Recent tasks:', tasks);

    const locks = await sql`SELECT * FROM money_state_lock ORDER BY last_transition_at DESC LIMIT 5`;
    console.log('Money state locks:', locks);

    // Find a task in 'held' state (ready for release)
    const heldTasks = locks.filter((l: any) => l.current_state === 'held');

    if (heldTasks.length === 0) {
        console.log('\nNo tasks in "held" state found.');
        console.log('Creating test scenario...');

        // Create a test task
        const [newTask] = await sql`
            INSERT INTO tasks (id, title, description, category, created_by, price, status)
            VALUES (gen_random_uuid(), 'Crash Test Task', 'Testing crash consistency', 'errands', 'test-poster-1', 1000, 'in_progress')
            RETURNING id
        `;
        console.log('Created test task:', newTask.id);

        // Create a money state lock in 'held' state (simulating escrow held)
        await sql`
            INSERT INTO money_state_lock (task_id, current_state, next_allowed_event, poster_uid, version)
            VALUES (${newTask.id}, 'held', ARRAY['RELEASE_PAYOUT', 'REFUND_ESCROW', 'DISPUTE_OPEN'], 'test-poster-1', 1)
            ON CONFLICT (task_id) DO UPDATE SET current_state = 'held', next_allowed_event = ARRAY['RELEASE_PAYOUT', 'REFUND_ESCROW', 'DISPUTE_OPEN']
        `;
        console.log('Created money state lock in "held" state');

        console.log('\nTest scenario ready. Task ID:', newTask.id);
        console.log('\nTo trigger crash:');
        console.log(`curl -X POST http://localhost:3000/api/tasks/${newTask.id}/release -H "Content-Type: application/json"`);
    } else {
        console.log('\nFound task in "held" state:', heldTasks[0].task_id);
        console.log('\nTo trigger crash:');
        console.log(`curl -X POST http://localhost:3000/api/tasks/${heldTasks[0].task_id}/release -H "Content-Type: application/json"`);
    }
}

main().catch(err => {
    console.error('ERROR:', err.message);
    process.exit(1);
});
