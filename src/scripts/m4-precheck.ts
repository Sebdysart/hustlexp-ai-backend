
import 'dotenv/config';
import { Pool } from '@neondatabase/serverless';

async function main() {
    console.log("Starting Pre-M4 Infrastructure Check (Round 2)...");

    const adminUrl = process.env.DATABASE_URL || 'postgres://localhost:5432/postgres';
    console.log(`Admin URL (Observed): ${adminUrl.replace(/:[^:/@]+@/, ':***@')}`); // Mask password

    // 1. Derive M4 URL
    // We replace the database name in the path.
    // URL format: postgres://user:pass@host:port/dbname?options
    let m4Url: string;

    try {
        const urlObj = new URL(adminUrl);
        urlObj.pathname = '/hxp_m4_runner';
        m4Url = urlObj.toString();
    } catch (e) {
        // Fallback for simple strings?
        m4Url = adminUrl.replace(/\/[^/?]+(\?|$)/, '/hxp_m4_runner$1');
    }

    console.log(`Target M4 URL: ${m4Url.replace(/:[^:/@]+@/, ':***@')}`);

    // 2. Connect to M4 DB
    // We assume the DB was created in the previous run (which succeeded in the 'admin' part).
    // If not, we might fail here, but the previous run Output said "Database created."
    const m4Pool = new Pool({ connectionString: m4Url });

    try {
        console.log("Connecting to M4 DB...");
        // Check Isolation
        const res = await m4Pool.query("SHOW default_transaction_isolation");
        const currentIso = res.rows[0].default_transaction_isolation;
        console.log(`Current Isolation Level: ${currentIso}`);

        if (currentIso.toLowerCase() !== 'serializable') {
            console.log("Isolation is NOT serializable. Attempting to set...");
            await m4Pool.query("ALTER DATABASE hxp_m4_runner SET default_transaction_isolation = 'serializable'");
            console.log("ALTER DATABASE executed. Isolation set to SERIALIZABLE.");
        } else {
            console.log("Isolation is already SERIALIZABLE. Verified.");
        }

        // Print the final URL for the User to confirm (masked or raw if safe? User asked for raw).
        // The user context is private, so we can reveal it in the tool output for *my* consumption to construct the response.
        console.log("M4_URL_CONFIRMED: " + m4Url);

    } catch (err) {
        console.error("Failed to connect/configure M4 DB:", err);
    } finally {
        await m4Pool.end();
    }
}

main();
