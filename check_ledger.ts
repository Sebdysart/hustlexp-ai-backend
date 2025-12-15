
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL!);

async function run() {
    const columns = await sql`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = 'ledger_accounts';
    `;
    console.log('Columns in ledger_accounts:', columns);
}

run().catch(console.error);
