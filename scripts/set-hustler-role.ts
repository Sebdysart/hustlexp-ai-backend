/**
 * Set test user role to hustler for Gate-1 verification
 * 
 * Usage: npx tsx scripts/set-hustler-role.ts
 */

import 'dotenv/config';
import { sql, isDatabaseAvailable } from '../src/db/index.js';

if (!isDatabaseAvailable() || !sql) {
    console.error('Database not available');
    process.exit(1);
}

const TEST_HUSTLER_UID = 'test-hustler-001';

async function setHustlerRole() {
    console.log('Connecting to database...');

    try {
        // Check if user exists
        const existing = await sql`
            SELECT id, firebase_uid, email, role
            FROM users
            WHERE firebase_uid = ${TEST_HUSTLER_UID}
        `;

        if (existing.length > 0) {
            console.log('User found:', existing[0]);

            if (existing[0].role === 'hustler') {
                console.log('User already has hustler role!');
            } else {
                // Update role
                await sql`
                    UPDATE users
                    SET role = 'hustler', updated_at = NOW()
                    WHERE firebase_uid = ${TEST_HUSTLER_UID}
                `;
                console.log('Role updated to hustler!');
            }
        } else {
            console.log('User not found, creating...');

            // Create user with hustler role
            const result = await sql`
                INSERT INTO users (firebase_uid, email, name, role)
                VALUES (${TEST_HUSTLER_UID}, 'hustler_test@hustlexp.com', 'Test Hustler', 'hustler')
                RETURNING id, firebase_uid, email, role
            `;

            console.log('User created:', result[0]);
        }

        // Verify
        const verify = await sql`
            SELECT id, firebase_uid, email, role
            FROM users
            WHERE firebase_uid = ${TEST_HUSTLER_UID}
        `;

        console.log('');
        console.log('=== VERIFICATION ===');
        console.log('User:', verify[0]);
        console.log('Role is now:', verify[0]?.role);

    } catch (error) {
        console.error('Error:', error);
    } finally {
        await sql.end();
    }
}

setHustlerRole();
