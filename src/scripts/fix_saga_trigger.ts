import dotenv from 'dotenv';
import path from 'path';
import { neon } from '@neondatabase/serverless';

// Load Env
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
// Use M4 if available (Targeting Test DB)
const DATABASE_URL = process.env.DATABASE_URL_M4 || process.env.DATABASE_URL;

if (!DATABASE_URL) {
    console.error('❌ Database URL missing!');
    process.exit(1);
}

const sql = neon(DATABASE_URL);

async function run() {
    console.log('🔧 Fixing Trigger Function enforce_saga_state (Case Sensitivity)...');

    // Redefine function with lowercase enum values
    await sql`
        CREATE OR REPLACE FUNCTION enforce_saga_state() RETURNS TRIGGER AS $$
        BEGIN
            -- Fix: Use lowercase 'committed', 'failed' to match enum definition
            IF OLD.status IN ('committed', 'failed') AND NEW.status != OLD.status THEN
                RAISE EXCEPTION 'Immutable SAGA Violation: Cannot modify transaction in final state %', OLD.status;
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
    `;

    console.log('✅ Trigger Fixed.');
}

run().catch(console.error);
