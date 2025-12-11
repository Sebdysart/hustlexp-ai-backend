import { query } from '../src/db/index.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigration() {
    console.log("=== Phase 1: Money Engine Migration ===");

    if (!process.env.DATABASE_URL) {
        console.error("❌ DATABASE_URL not set");
        process.exit(1);
    }

    const migrationPath = path.join(__dirname, '../migrations/2025-phase1-money-state-lock.sql');
    const sqlContent = fs.readFileSync(migrationPath, 'utf-8');

    // Split statements by semicolon and filter empty strings
    const statements = sqlContent
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0);

    try {
        console.log(`Found ${statements.length} statements.`);
        for (const statement of statements) {
            console.log(`Executing: ${statement.substring(0, 50).replace(/\n/g, ' ')}...`);
            // Use the `query` helper which handles the connection check and error logging
            await query(statement);
        }
        console.log("✅ Phase 1 Migration Complete");
        process.exit(0);
    } catch (e) {
        console.error("❌ Migration Failed", e);
        process.exit(1);
    }
}

runMigration();
