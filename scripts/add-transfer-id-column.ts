
import { sql } from '../src/db/index.js';
import 'dotenv/config';

async function addTransferIdColumn() {
    console.log('Adding stripe_transfer_id column to escrow_holds...');
    try {
        await sql`
            ALTER TABLE escrow_holds 
            ADD COLUMN IF NOT EXISTS stripe_transfer_id TEXT
        `;
        console.log('Column added successfully.');
        process.exit(0);
    } catch (e) {
        console.error('Error altering table:', e);
        process.exit(1);
    }
}

addTransferIdColumn();
