
import { sql } from '../src/db/index.js';
import 'dotenv/config';

async function inspectBalanceSnapshots() {
    console.log('Inspecting balance_snapshots columns...');
    const cols = await sql`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = 'balance_snapshots'
    `;
    console.log('balance_snapshots:', cols.map(c => c.column_name).join(', '));
    process.exit(0);
}

inspectBalanceSnapshots();
