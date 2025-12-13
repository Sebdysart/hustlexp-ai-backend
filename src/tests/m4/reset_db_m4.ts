
import 'dotenv/config';
import { serviceLogger } from '../../utils/logger';

async function main() {
    const m4Url = process.env.DATABASE_URL_M4;
    if (!m4Url) {
        console.error("FATAL: DATABASE_URL_M4 not set");
        process.exit(1);
    }
    process.env.DATABASE_URL = m4Url;
    process.env.RAILWAY_ENVIRONMENT_NAME = 'staging';

    const { sql } = await import('../../db'); // Dynamic load

    console.log(">> Wiping M4 Ledger Tables...");
    try {
        await sql`TRUNCATE TABLE 
            ledger_entries, 
            ledger_transactions, 
            ledger_accounts,
            ledger_locks,
            ledger_snapshots,
            money_events_processed,
            money_state_lock,
            money_events_audit,
            processed_stripe_events
            CASCADE`;
        console.log(">> Wipe Complete.");
        process.exit(0);
    } catch (err) {
        console.error("Wipe Failed", err);
        process.exit(1);
    }
}

main();
