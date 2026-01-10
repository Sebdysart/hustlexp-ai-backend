import 'dotenv/config'; // Load .env
/**
 * M4 VERIFICATION SUITE RUNNER
 *
 * Purpose: Executes the "Truth Layer" scripts (Option E/M1.5.3) against the CERTIFIED M4 DATABASE.
 * This ensures that our Validation Logic actually works on real (test) data.
 */
async function main() {
    console.log("=========================================");
    console.log("   M4 VERIFICATION SUITE (TRUTH LAYER)   ");
    console.log("=========================================");
    const m4Url = process.env.DATABASE_URL_M4;
    if (!m4Url) {
        console.error("FATAL: DATABASE_URL_M4 not set in .env");
        process.exit(1);
    }
    // 1. FORCE ENVIRONMENT TO M4
    process.env.DATABASE_URL = m4Url;
    // We use STAGING info to allow Test Keys but still enforcing some strictness
    process.env.RAILWAY_ENVIRONMENT_NAME = 'staging';
    console.log("Environment: Switched to M4 Target (Mock Staging).");
    try {
        // 2. IMPORT SCRIPTS (Dynamic to pick up new Env)
        // We import the functions, not the auto-executing files (we handled that with 'if main').
        console.log("\n>> 1. SUBLEDGER VALIDATION (Zero-Sum)");
        const { validateTaskSubledgers } = await import('../../cron/validate_task_subledgers');
        await validateTaskSubledgers();
        console.log("\n>> 2. ORDERING GUARD (Drift Detection)");
        const { OrderingGuard } = await import('../../services/ledger/OrderingGuard');
        await OrderingGuard.scanForAnomalies();
        // 3. RECONCILIATION
        console.log("\n>> 3. STRIPE RECONCILIATION");
        console.log("   [SKIP] M4 does not write to Real Stripe (No Balance History).");
        console.log("\n=========================================");
        console.log("   VERIFICATION COMPLETE                 ");
        console.log("=========================================");
        process.exit(0);
    }
    catch (err) {
        console.error("\n[CRITICAL FAILURE]", err);
        process.exit(1);
    }
}
main();
//# sourceMappingURL=run_verification_suite.js.map