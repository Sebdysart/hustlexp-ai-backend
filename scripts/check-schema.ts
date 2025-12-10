/**
 * Check what columns exist in users table
 * 
 * Usage: npx tsx scripts/check-schema.ts
 */

import 'dotenv/config';
import { sql, isDatabaseAvailable } from '../src/db/index.js';

async function checkSchema() {
    if (!isDatabaseAvailable() || !sql) {
        console.error('Database not available');
        process.exit(1);
    }

    console.log('Checking users table schema...');

    try {
        // Get column info
        const columns = await sql`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_name = 'users'
            ORDER BY ordinal_position
        `;

        console.log('');
        console.log('=== USERS TABLE COLUMNS ===');
        for (const col of columns) {
            console.log(`  ${col.column_name}: ${col.data_type} (nullable: ${col.is_nullable})`);
        }
        console.log('');

        // Check if firebase_uid exists
        const hasFirebaseUid = columns.some((c: { column_name: string }) => c.column_name === 'firebase_uid');
        console.log('firebase_uid column exists:', hasFirebaseUid);

        // Run a quick test query
        console.log('');
        console.log('=== SAMPLE USERS ===');
        const users = await sql`SELECT id, email, role FROM users LIMIT 5`;
        console.log(users);

    } catch (error) {
        console.error('Error:', error);
    }

    process.exit(0);
}

checkSchema();
