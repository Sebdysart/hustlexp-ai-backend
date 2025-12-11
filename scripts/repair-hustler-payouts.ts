
import { sql } from '../src/db/index.js';
import 'dotenv/config';

async function repairHustlerPayouts() {
    console.log('Repairing hustler_payouts schema...');
    try {
        await sql`
            ALTER TABLE hustler_payouts 
            ADD COLUMN IF NOT EXISTS escrow_id TEXT,
            ADD COLUMN IF NOT EXISTS hustler_stripe_account_id TEXT,
            ADD COLUMN IF NOT EXISTS gross_amount_cents INTEGER,
            ADD COLUMN IF NOT EXISTS fee_cents INTEGER,
            ADD COLUMN IF NOT EXISTS net_amount_cents INTEGER,
            ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'standard'
        `;
        console.log('Columns added successfully.');
        process.exit(0);
    } catch (e) {
        console.error('Error altering table:', e);
        process.exit(1);
    }
}

repairHustlerPayouts();
