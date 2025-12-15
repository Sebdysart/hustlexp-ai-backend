
import { Pool } from '@neondatabase/serverless';
import fs from 'fs';
import path from 'path';
import { serviceLogger } from '../utils/logger.js';
import '../config/env'; // Ensure env vars loaded

const logger = serviceLogger.child({ module: 'MigrationRunner' });

async function runMigration() {
    const dbUrl = process.env.DATABASE_URL_M4 || process.env.DATABASE_URL;

    if (!dbUrl) {
        logger.fatal('No DATABASE_URL found!');
        process.exit(1);
    }

    logger.info(`Applying Omega Invariants to: ${dbUrl.slice(0, 20)}...`);

    const pool = new Pool({ connectionString: dbUrl });
    const client = await pool.connect();

    const migrationPath = path.join(process.cwd(), 'src/db/migrations/omega_01_engine_hardening.sql');

    try {
        const migrationSql = fs.readFileSync(migrationPath, 'utf8');

        // Use client.query which typically checks for multi-statement support better
        await client.query(migrationSql);

        logger.info('✅ Omega Phase 8A Migrations Applied Successfully!');
    } catch (e: any) {
        logger.fatal({ message: e.message, stack: e.stack, detail: e }, '❌ Migration Failed');
        process.exit(1);
    }
}

runMigration();
