#!/usr/bin/env npx tsx
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
async function runMigration(mode) {
    const migration = fs.readFileSync('src/db/migrations/2025_ledger_foundation.sql', 'utf-8');
    // Remove BEGIN/COMMIT from file since we control transaction ourselves
    const cleanedMigration = migration
        .replace(/^BEGIN;/gm, '')
        .replace(/^COMMIT;/gm, '');
    console.log(`=== ${mode.toUpperCase()} ===`);
    try {
        await sql `BEGIN`;
        // Execute each statement
        const statements = cleanedMigration
            .split(';')
            .map(s => s.trim())
            .filter(s => s && !s.startsWith('--'));
        for (let i = 0; i < statements.length; i++) {
            const stmt = statements[i];
            if (stmt.length > 5) {
                const preview = stmt.substring(0, 50).replace(/\n/g, ' ');
                console.log(`[${i + 1}/${statements.length}] ${preview}...`);
                await sql.unsafe(stmt);
            }
        }
        if (mode === 'dry-run') {
            await sql `ROLLBACK`;
            console.log('=== DRY RUN COMPLETE - NO ERRORS ===');
        }
        else {
            await sql `COMMIT`;
            console.log('=== COMMIT COMPLETE ===');
        }
    }
    catch (err) {
        console.error(`=== ${mode.toUpperCase()} FAILED ===`);
        console.error('Error:', err.message);
        if (err.detail)
            console.error('Detail:', err.detail);
        if (err.hint)
            console.error('Hint:', err.hint);
        if (err.constraint)
            console.error('Constraint:', err.constraint);
        try {
            await sql `ROLLBACK`;
        }
        catch { }
        process.exit(1);
    }
}
const mode = process.argv[2];
if (!mode || !['dry-run', 'commit'].includes(mode)) {
    console.log('Usage: run-migration.ts <dry-run|commit>');
    process.exit(1);
}
runMigration(mode);
//# sourceMappingURL=run-migration.js.map