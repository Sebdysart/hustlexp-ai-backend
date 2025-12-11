
import { sql } from '../src/db/index.js';
import 'dotenv/config';

async function inspectSchema() {
    console.log('Inspecting hustler_payouts columns...');
    const cols = await sql`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = 'hustler_payouts'
    `;
    console.log('hustler_payouts:', cols.map(c => c.column_name).join(', '));

    console.log('Inspecting escrow_holds columns...');
    const cols2 = await sql`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = 'escrow_holds'
    `;
    console.log('escrow_holds:', cols2.map(c => c.column_name).join(', '));

    process.exit(0);
}

inspectSchema();
