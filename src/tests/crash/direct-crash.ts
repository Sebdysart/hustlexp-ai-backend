#!/usr/bin/env npx tsx
/**
 * Directly trigger RELEASE_PAYOUT via StripeMoneyEngine
 * This runs in-process and will crash when it hits the kill switch
 */
import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';

dotenv.config();

// Set the env var for this process
process.env.CRASH_AFTER_PREPARE = '1';

const sql = neon(process.env.DATABASE_URL!);

async function main() {
    console.log('=== DIRECT CRASH TRIGGER (IN-PROCESS) ===\n');
    console.log('CRASH_AFTER_PREPARE is SET - this process WILL crash after PREPARE\n');

    // Find a task in 'held' state
    const [lock] = await sql`SELECT * FROM money_state_lock WHERE current_state = 'held' LIMIT 1`;

    if (!lock) {
        console.log('No task in "held" state. Cannot trigger crash test.');
        console.log('Please create a task with escrow held first.');
        process.exit(1);
    }

    console.log('Found task in held state:', lock.task_id);
    console.log('Current state:', lock.current_state);
    console.log('PI:', lock.stripe_payment_intent_id);
    console.log('Charge:', lock.stripe_charge_id);

    // Import the engine dynamically
    console.log('\nImporting StripeMoneyEngine...');
    const { StripeMoneyEngine } = await import('../../services/StripeMoneyEngine.js');

    console.log('Calling RELEASE_PAYOUT...');
    console.log('!!! THIS PROCESS WILL NOW CRASH !!!\n');

    try {
        const result = await StripeMoneyEngine.handle(
            lock.task_id,
            'RELEASE_PAYOUT',
            {
                eventId: 'crash-test-' + Date.now(),
                payoutAmountCents: 1000,
                hustlerId: 'test-hustler-1',
                hustlerStripeAccountId: 'acct_test_123',
                taskId: lock.task_id
            }
        );

        // If we get here, the crash didn't happen
        console.log('WARNING: Crash did not occur! Result:', result);
        console.log('Check that CRASH_AFTER_PREPARE logic is correctly placed.');
    } catch (err: any) {
        console.log('Error (before crash):', err.message);
    }
}

main().catch(err => {
    console.error('ERROR:', err.message);
    process.exit(1);
});
