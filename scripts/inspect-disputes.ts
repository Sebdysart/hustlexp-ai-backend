
import { sql } from '../src/db/index.js';
import 'dotenv/config';

async function inspectDisputesSchema() {
    console.log('Inspecting disputes schema...');
    const cols = await sql`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns 
        WHERE table_name = 'disputes'
    `;
    console.log('Columns:', JSON.stringify(cols, null, 2));
    process.exit(0);
}

inspectDisputesSchema();
