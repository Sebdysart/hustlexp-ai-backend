
import { sql } from '../src/db/index.js';
import 'dotenv/config';

async function fixHustlerStripe() {
    console.log('Fixing Stripe Connect ID for test-hustler-001...');

    // 1. Update users table with Stripe Account ID
    const TEST_CONNECT_ID = 'acct_1OW0iQRfbK15hB7j';

    await sql`
        UPDATE users 
        SET stripe_account_id = ${TEST_CONNECT_ID}, stripe_account_status = 'verified'
        WHERE firebase_uid = 'test-hustler-001'
    `;

    // 2. Ensure profile exists - using only verified columns from schema.ts
    // (user_id, skills, rating, completed_tasks)
    const user = (await sql`SELECT id FROM users WHERE firebase_uid = 'test-hustler-001'`)[0];

    // Using ON CONFLICT DO NOTHING to avoid validation errors if it exists
    await sql`
        INSERT INTO hustler_profiles (user_id, rating, completed_tasks)
        VALUES (${user.id}, 5.0, 0)
        ON CONFLICT (user_id) DO NOTHING
    `;

    console.log(`Updated user ${user.id} with Connect ID ${TEST_CONNECT_ID}`);
    process.exit(0);
}

fixHustlerStripe().catch(console.error);
