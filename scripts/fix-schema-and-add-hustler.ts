/**
 * Add firebase_uid column and create test hustler
 * 
 * Usage: npx tsx scripts/fix-schema-and-add-hustler.ts
 */

import 'dotenv/config';
import { sql, isDatabaseAvailable } from '../src/db/index.js';

const TEST_HUSTLER_UID = 'test-hustler-001';

async function fixSchemaAndAddHustler() {
    if (!isDatabaseAvailable() || !sql) {
        console.error('Database not available');
        process.exit(1);
    }

    console.log('=== STEP 1: Add firebase_uid column if missing ===');

    try {
        await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS firebase_uid VARCHAR(128) UNIQUE`;
        console.log('firebase_uid column added/verified');
    } catch (error) {
        console.log('Column already exists or error:', error);
    }

    console.log('');
    console.log('=== STEP 2: Create or update test hustler ===');

    try {
        // Check if our test user already exists by firebase_uid
        const existing = await sql`
            SELECT id, email, role, firebase_uid
            FROM users
            WHERE firebase_uid = ${TEST_HUSTLER_UID}
        `;

        if (existing.length > 0) {
            console.log('Test user already exists:', existing[0]);

            if (existing[0].role !== 'hustler') {
                await sql`
                    UPDATE users
                    SET role = 'hustler', updated_at = NOW()
                    WHERE firebase_uid = ${TEST_HUSTLER_UID}
                `;
                console.log('Updated role to hustler');
            }
        } else {
            // Create new test user
            const result = await sql`
                INSERT INTO users (firebase_uid, email, name, role)
                VALUES (
                    ${TEST_HUSTLER_UID}, 
                    'test-hustler-001@hustlexp.com', 
                    'Gate-1 Test Hustler', 
                    'hustler'
                )
                RETURNING id, firebase_uid, email, role
            `;
            console.log('Created test user:', result[0]);
        }

    } catch (error) {
        console.error('Error creating/updating user:', error);
    }

    console.log('');
    console.log('=== STEP 3: Verify ===');

    try {
        const users = await sql`
            SELECT id, firebase_uid, email, role
            FROM users
            WHERE firebase_uid = ${TEST_HUSTLER_UID}
        `;
        console.log('Test hustler:', users[0]);
    } catch (error) {
        console.error('Verification error:', error);
    }

    process.exit(0);
}

fixSchemaAndAddHustler();
