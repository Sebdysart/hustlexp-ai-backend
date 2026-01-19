#!/usr/bin/env npx tsx
/**
 * Execute migration as a single block using Neon's transaction API
 * This does NOT split on semicolons - it sends the entire SQL as one request
 */
import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config();
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    console.error('FATAL: DATABASE_URL not set');
    process.exit(1);
}
const sql = neon(DATABASE_URL);
async function main() {
    const migration = fs.readFileSync('src/db/migrations/2025_ledger_foundation.sql', 'utf-8');
    console.log('=== EXECUTING FULL MIGRATION AS SINGLE BLOCK ===');
    console.log('Migration size:', migration.length, 'bytes');
    try {
        // Execute the entire SQL file as one atomic operation
        // Neon's sql.unsafe() should handle this correctly
        await sql.unsafe(migration);
        console.log('=== MIGRATION COMPLETE ===');
        // Verify tables exist
        const ledgerTables = await sql `
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name LIKE 'ledger%'
            ORDER BY table_name
        `;
        const stripeTables = await sql `
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name LIKE 'stripe_%'
            ORDER BY table_name
        `;
        console.log('\n=== VERIFICATION ===');
        console.log('Ledger tables found:', ledgerTables.length);
        ledgerTables.forEach((t) => console.log('  ✓', t.table_name));
        console.log('Stripe tables found:', stripeTables.length);
        stripeTables.forEach((t) => console.log('  ✓', t.table_name));
        // Check for required tables
        const required = [
            'ledger_accounts',
            'ledger_transactions',
            'ledger_entries',
            'ledger_locks',
            'stripe_outbound_log'
        ];
        const found = [...ledgerTables, ...stripeTables].map((t) => t.table_name);
        const missing = required.filter(r => !found.includes(r));
        if (missing.length > 0) {
            console.log('\n❌ MISSING REQUIRED TABLES:', missing);
            process.exit(1);
        }
        else {
            console.log('\n✅ ALL REQUIRED TABLES PRESENT');
        }
    }
    catch (err) {
        console.error('=== MIGRATION FAILED ===');
        console.error('Error:', err.message);
        if (err.detail)
            console.error('Detail:', err.detail);
        if (err.hint)
            console.error('Hint:', err.hint);
        if (err.position)
            console.error('Position:', err.position);
        process.exit(1);
    }
}
main();
//# sourceMappingURL=run-migration-atomic.js.map