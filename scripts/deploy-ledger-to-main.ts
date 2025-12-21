import 'dotenv/config';
import { Pool } from '@neondatabase/serverless';
import fs from 'fs';
import path from 'path';

async function main() {
    const dbUrl = process.env.DATABASE_URL;

    if (!dbUrl) {
        console.error("❌ DATABASE_URL not defined.");
        process.exit(1);
    }

    console.log("Setting up Ledger on Main Database...");

    const pool = new Pool({ connectionString: dbUrl });
    const ledgerSqlPath = path.join(process.cwd(), 'src', 'db', 'ledger_schema.sql');

    try {
        const ledgerSql = fs.readFileSync(ledgerSqlPath, 'utf-8');
        console.log("Applying Ledger Schema...");
        await pool.query(ledgerSql);
        console.log("✅ Ledger Schema Applied Successfully.");
    } catch (e: any) {
        console.error("❌ Failed to apply ledger schema:", e.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

main();
