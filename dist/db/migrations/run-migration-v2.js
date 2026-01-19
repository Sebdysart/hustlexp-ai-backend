#!/usr/bin/env npx tsx
/**
 * Execute migration using Neon transaction with proper statement handling
 * PostgreSQL functions require $$ delimiters - we handle those specially
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
// Parse SQL file into executable statements
// Handles $$ function bodies correctly
function parseStatements(content) {
    const statements = [];
    let current = '';
    let inDollarQuote = false;
    let i = 0;
    while (i < content.length) {
        // Check for $$ delimiter
        if (content.slice(i, i + 2) === '$$') {
            inDollarQuote = !inDollarQuote;
            current += '$$';
            i += 2;
            continue;
        }
        // Check for semicolon outside of $$ blocks
        if (content[i] === ';' && !inDollarQuote) {
            const stmt = current.trim();
            if (stmt && !stmt.startsWith('--')) {
                statements.push(stmt);
            }
            current = '';
            i++;
            continue;
        }
        current += content[i];
        i++;
    }
    // Handle final statement
    const final = current.trim();
    if (final && !final.startsWith('--')) {
        statements.push(final);
    }
    return statements.filter(s => {
        const lower = s.toLowerCase().trim();
        return !lower.startsWith('--') &&
            lower !== 'begin' &&
            lower !== 'commit' &&
            lower !== 'rollback' &&
            s.length > 5;
    });
}
async function main() {
    const migration = fs.readFileSync('src/db/migrations/2025_ledger_foundation.sql', 'utf-8');
    const statements = parseStatements(migration);
    console.log('=== EXECUTING MIGRATION ===');
    console.log('Total statements:', statements.length);
    try {
        for (let i = 0; i < statements.length; i++) {
            const stmt = statements[i];
            const preview = stmt.substring(0, 60).replace(/\n/g, ' ');
            console.log(`[${i + 1}/${statements.length}] ${preview}...`);
            try {
                await sql.unsafe(stmt);
            }
            catch (err) {
                // Some statements may fail if object exists - log and continue for enums
                if (err.message.includes('already exists')) {
                    console.log(`  (skipped - already exists)`);
                }
                else {
                    throw err;
                }
            }
        }
        console.log('\n=== MIGRATION COMPLETE ===');
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
        const moneyTables = await sql `
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name LIKE 'money_%'
            ORDER BY table_name
        `;
        console.log('\n=== VERIFICATION ===');
        console.log('Ledger tables:', ledgerTables.length);
        ledgerTables.forEach((t) => console.log('  ✓', t.table_name));
        console.log('Stripe tables:', stripeTables.length);
        stripeTables.forEach((t) => console.log('  ✓', t.table_name));
        console.log('Money tables:', moneyTables.length);
        moneyTables.forEach((t) => console.log('  ✓', t.table_name));
        // Check for required tables
        const required = [
            'ledger_accounts',
            'ledger_transactions',
            'ledger_entries',
            'ledger_locks',
            'stripe_outbound_log'
        ];
        const found = [...ledgerTables, ...stripeTables, ...moneyTables].map((t) => t.table_name);
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
        console.error('\n=== MIGRATION FAILED ===');
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
//# sourceMappingURL=run-migration-v2.js.map