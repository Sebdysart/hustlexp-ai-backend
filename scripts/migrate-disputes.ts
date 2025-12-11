import { readFileSync } from 'fs';
import { neon } from '@neondatabase/serverless';
import 'dotenv/config';

async function run() {
    if (!process.env.DATABASE_URL) {
        console.error("DATABASE_URL is not set");
        process.exit(1);
    }
    const sql = neon(process.env.DATABASE_URL!);

    console.log("=== DISPUTE ENGINE MIGRATION START ===");

    try {
        const migration = readFileSync('migrations/2025-disputes-table.sql', 'utf8');

        // Neon driver doesn't support multi-statement queries.
        // Split by semicolon, filter out empty/comment-only lines.
        const statements = migration
            .split(';')
            .map(s => s.trim())
            .filter(s => s.length > 0);

        for (const stmt of statements) {
            // Check if it's just a comment
            if (stmt.startsWith('--') && !stmt.includes('\n')) continue;

            console.log(`Executing statement: ${stmt.substring(0, 50)}...`);
            await sql(stmt);
        }
    } catch (err) {
        console.error("Migration FAILED:", err);
        process.exit(1);
    }

    console.log("=== DISPUTE ENGINE MIGRATION COMPLETE ===");
}

run();
