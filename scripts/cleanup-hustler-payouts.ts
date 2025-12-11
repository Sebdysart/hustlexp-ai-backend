
import { sql } from '../src/db/index.js';
import 'dotenv/config';

async function cleanupHustlerPayouts() {
    console.log('Dropping legacy amount_cents column from hustler_payouts...');
    try {
        await sql`
            ALTER TABLE hustler_payouts 
            DROP COLUMN IF EXISTS amount_cents
        `;
        console.log('Column dropped successfully.');
        process.exit(0);
    } catch (e) {
        console.error('Error altering table:', e);
        process.exit(1);
    }
}

cleanupHustlerPayouts();
