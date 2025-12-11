
import { sql } from '../src/db/index.js';
import 'dotenv/config';

async function checkTables() {
    console.log('Checking for tables...');
    try {
        const tables = await sql`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public'
        `;

        const names = tables.map(t => t.table_name);
        console.log('Tables found:', names.join(', '));

        const needed = ['hustler_payouts', 'escrow_holds', 'admin_locks', 'balance_snapshots'];
        const missing = needed.filter(n => !names.includes(n));

        if (missing.length > 0) {
            console.error('MISSING TABLES:', missing);
            process.exit(1);
        } else {
            console.log('All required Phase 2 tables present.');
            process.exit(0);
        }
    } catch (e) {
        console.error('Error checking tables:', e);
        process.exit(1);
    }
}

checkTables();
