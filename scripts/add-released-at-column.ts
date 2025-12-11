
import { sql } from '../src/db/index.js';
import 'dotenv/config';

async function addReleasedAtColumn() {
    console.log('Adding released_at column to escrow_holds...');
    try {
        await sql`
            ALTER TABLE escrow_holds 
            ADD COLUMN IF NOT EXISTS released_at TIMESTAMP WITH TIME ZONE
        `;
        console.log('Column added successfully.');
        process.exit(0);
    } catch (e) {
        console.error('Error altering table:', e);
        process.exit(1);
    }
}

addReleasedAtColumn();
