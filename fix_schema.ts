
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL!);

async function run() {
    try {
        await sql`
            ALTER TABLE money_state_lock 
            ADD COLUMN IF NOT EXISTS recovery_attempts INTEGER DEFAULT 0;
        `;
        console.log('Successfully added recovery_attempts column');
    } catch (e) {
        console.error('Failed to alter table:', e);
    }
}

run().catch(console.error);
