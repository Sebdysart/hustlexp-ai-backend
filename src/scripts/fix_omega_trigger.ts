
import dotenv from 'dotenv';
import path from 'path';
import { neon } from '@neondatabase/serverless';

// Load Env
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
const DATABASE_URL = process.env.DATABASE_URL_M4;

if (!DATABASE_URL) {
    console.error('❌ M4 Database URL missing!');
    process.exit(1);
}

const sql = neon(DATABASE_URL);

async function run() {
    console.log('🔧 Fixing Trigger Function update_account_snapshot...');

    // Redefine function with correct column 'balance'
    await sql`
        CREATE OR REPLACE FUNCTION update_account_snapshot() RETURNS TRIGGER AS $$
        BEGIN
            -- Fix: Use NEW.balance instead of NEW.balance_amount
            NEW.last_snapshot_hash := md5(NEW.id::text || NEW.balance::text || NOW()::text);
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
    `;

    console.log('✅ Trigger Fixed.');
}

run().catch(console.error);
