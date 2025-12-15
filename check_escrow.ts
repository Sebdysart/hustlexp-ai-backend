
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL!);

async function run() {
    const columns = await sql`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = 'escrow_holds';
    `;
    console.log('Columns in escrow_holds:', columns);
}

run().catch(console.error);
