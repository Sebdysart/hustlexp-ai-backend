
import { sql } from '../src/db/index.js';

async function verifySchema() {
    console.log("=== Verifying Phase 1 Schema ===");

    try {
        // Inspect money_state_lock columns
        const lockColumns = await sql`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns 
            WHERE table_name = 'money_state_lock'
        `;
        console.log("\n[money_state_lock] Columns:");
        console.table(lockColumns);

        // Inspect money_events_processed columns
        const eventColumns = await sql`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns 
            WHERE table_name = 'money_events_processed'
        `;
        console.log("\n[money_events_processed] Columns:");
        console.table(eventColumns);

        // Basic Check
        if (lockColumns.length > 0 && eventColumns.length > 0) {
            console.log("\n✅ Verification PASSED: Tables exist.");
            process.exit(0);
        } else {
            console.log("\n❌ Verification FAILED: Tables missing.");
            process.exit(1);
        }

    } catch (e) {
        console.error("❌ Verification Error", e);
        process.exit(1);
    }
}

verifySchema();
