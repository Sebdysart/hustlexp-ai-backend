
import 'dotenv/config';
import { Pool } from '@neondatabase/serverless';
import fs from 'fs';
import path from 'path';

async function main() {
    console.log("Starting M4 Migration...");

    const m4Url = process.env.DATABASE_URL_M4 || 'postgres://localhost:5432/hxp_m4_runner';
    console.log(`Connecting to M4 DB...`);
    // Do not log URL if it contains secrets, user already saw it in precheck.

    const pool = new Pool({ connectionString: m4Url });

    try {
        const schemaPath = path.join(process.cwd(), 'src', 'db', 'ledger_schema.sql');
        console.log(`Reading schema from: ${schemaPath}`);

        const schemaSql = fs.readFileSync(schemaPath, 'utf8');

        console.log("Applying Schema...");
        await pool.query(schemaSql);

        console.log("Schema Applied Successfully.");

        // Quick Verification
        const res = await pool.query("SELECT count(*) FROM information_schema.tables WHERE table_name = 'ledger_transactions'");
        if (res.rows[0].count > 0) {
            console.log("Verified: ledger_transactions table exists.");
        } else {
            console.error("Verification Failed: Table not found.");
        }

    } catch (err) {
        console.error("Migration Failed:", err);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

main();
