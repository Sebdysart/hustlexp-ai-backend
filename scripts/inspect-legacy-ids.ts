
import { sql } from '../src/db/index.js';
import 'dotenv/config';

async function inspectLegacyIds() {
    console.log('Checking for non-UUID task_ids...');

    // Regex for UUID: 8-4-4-4-12 hex digits
    const uuidRegex = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

    const legacyEscrows = await sql`
        SELECT task_id FROM escrow_holds 
        WHERE task_id !~ ${uuidRegex}
    `;

    const legacyPayouts = await sql`
        SELECT task_id FROM hustler_payouts 
        WHERE task_id !~ ${uuidRegex}
    `;

    console.log(`Found ${legacyEscrows.length} legacy task_ids in escrow_holds.`);
    if (legacyEscrows.length > 0) {
        console.log('Samples:', legacyEscrows.slice(0, 5).map(r => r.task_id));
    }

    console.log(`Found ${legacyPayouts.length} legacy task_ids in hustler_payouts.`);
    if (legacyPayouts.length > 0) {
        console.log('Samples:', legacyPayouts.slice(0, 5).map(r => r.task_id));
    }

    process.exit(0);
}

inspectLegacyIds();
