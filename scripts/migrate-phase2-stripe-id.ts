
import { query } from '../src/db/index.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function migrate() {
    console.log('Starting Phase 2 Migration: Add stripe_account_id to hustler_profiles...');

    try {
        const sqlPath = path.join(__dirname, '../migrations/2025-phase2-hustler-stripe-id.sql');
        const sqlContent = fs.readFileSync(sqlPath, 'utf8');

        // Split by statement if needed, but our helper executes raw string. 
        // Usually standard drivers handle multiple statements if enabled, 
        // but strict ones might not. The content has 2 statements.
        // Neon HTTP driver `sql` function usually executes one statement block?
        // Actually, `query` uses `sql(queryText)` which supports multiple statements in one call usually?
        // Or we should split.
        // Let's safe split by semicolon.

        // Simple split:
        const statements = sqlContent.split(';')
            .map(s => s.trim())
            .filter(s => s.length > 0);

        for (const statement of statements) {
            console.log(`Executing: ${statement.substring(0, 50)}...`);
            await query(statement);
        }

        console.log('✅ Phase 2 Migration Complete.');
    } catch (error) {
        console.error('❌ Migration Failed:', error);
        process.exit(1);
    }
}

migrate();
