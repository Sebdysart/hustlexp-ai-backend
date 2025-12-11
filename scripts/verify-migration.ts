import { neon } from '@neondatabase/serverless';
import 'dotenv/config';

async function verify() {
    const sql = neon(process.env.DATABASE_URL!);

    console.log("=== VERIFYING UUID MIGRATION ===");

    // 1. No legacy IDs left
    const legacyEscrow = await sql("SELECT task_id FROM escrow_holds WHERE task_id::text !~ '^[0-9a-fA-F-]{8}-'");
    const legacyPayout = await sql("SELECT task_id FROM hustler_payouts WHERE task_id::text !~ '^[0-9a-fA-F-]{8}-'");

    if (legacyEscrow.length || legacyPayout.length) {
        console.error("❌ Legacy IDs remain!", { escrow: legacyEscrow, payouts: legacyPayout });
        process.exit(1);
    }

    console.log("✔ No legacy IDs remain.");

    // 2. FK Integrity
    const orphanEscrow = await sql("SELECT task_id FROM escrow_holds WHERE task_id NOT IN (SELECT id FROM tasks)");
    const orphanPayout = await sql("SELECT task_id FROM hustler_payouts WHERE task_id NOT IN (SELECT id FROM tasks)");

    if (orphanEscrow.length || orphanPayout.length) {
        console.error("❌ Orphan rows found!", { orphanEscrow, orphanPayout });
        process.exit(1);
    }

    console.log("✔ All escrow/payout rows map to real tasks.");

    // 3. Mapping verification
    const mapped = await sql("SELECT * FROM migration_map LIMIT 5");

    console.log("Sample mapping:", mapped);

    console.log("=== MIGRATION VERIFIED SUCCESSFULLY ===");
}

verify();
