import 'dotenv/config';
import { Pool } from '@neondatabase/serverless';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
async function main() {
    const m4Url = process.env.DATABASE_URL_M4;
    // Set global DATABASE_URL for runMigrations to pick up
    process.env.DATABASE_URL = m4Url;
    if (!m4Url) {
        logger.error("No DATABASE_URL_M4 defined.");
        process.exit(1);
    }
    logger.info("Setting up M4 Database...");
    // 0. WIPE DATABASE (Surgical clean slate)
    const pool = new Pool({ connectionString: m4Url });
    try {
        logger.warn("WIPING M4 DATABASE...");
        await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    }
    catch (e) {
        logger.error("Wipe failed (ignoring if first run): " + e.message);
    }
    // 1. Run App Schema Migrations (Dynamic import to pick up new DATABASE_URL)
    const { runMigrations } = await import('../db/schema.js');
    await runMigrations();
    // 2. Run Ledger Schema
    const ledgerSqlPath = path.join(process.cwd(), 'src', 'db', 'ledger_schema.sql');
    const ledgerSql = fs.readFileSync(ledgerSqlPath, 'utf-8');
    // Reuse pool
    try {
        logger.info("Applying Ledger Schema...");
        // Function/Trigger definitions often contain semicolons. 
        // Best to run as one block if driver supports it, or split carefully.
        // Neon serverless usually handles multi-statement query strings.
        await pool.query(ledgerSql);
        logger.info("Ledger Schema Applied.");
    }
    catch (e) {
        logger.error({ error: e.message }, "Failed to apply ledger schema");
        throw e;
    }
    finally {
        await pool.end();
    }
    logger.info("M4 Setup Complete.");
}
main();
//# sourceMappingURL=m4-setup.js.map