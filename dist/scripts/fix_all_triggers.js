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
    console.log('🔧 Fixing ALL Trigger Functions (Case Sensitivity + Schema)...');
    // 1. Fix enforce_saga_state (Lowercase enums)
    await sql `
        CREATE OR REPLACE FUNCTION enforce_saga_state() RETURNS TRIGGER AS $$
        BEGIN
            -- No Deletes
            IF TG_OP = 'DELETE' THEN
                RAISE EXCEPTION 'Invariant Violation: Ledger transactions cannot be deleted.';
            END IF;

            -- Terminal State Guarantee
            IF OLD.status IN ('committed', 'failed') AND NEW.status != OLD.status THEN
                RAISE EXCEPTION 'Invariant Violation: Cannot mutate ledger transaction from terminal state % to %', OLD.status, NEW.status;
            END IF;

            -- Valid Transitions (Strict Graph)
            IF OLD.status = 'pending' AND NEW.status NOT IN ('executing', 'failed', 'committed') THEN
                RAISE EXCEPTION 'Invariant Violation: Invalid state transition from PENDING to %', NEW.status;
            END IF;

            IF OLD.status = 'executing' AND NEW.status NOT IN ('committed', 'failed') THEN
                RAISE EXCEPTION 'Invariant Violation: Invalid state transition from EXECUTING to %', NEW.status;
            END IF;

            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
    `;
    console.log('✅ enforce_saga_state Fixed.');
    // 2. Fix log_global_sequence (Lowercase enums + Correct Schema)
    // Fix Table Schema: transaction_id must be TEXT (ULID), not UUID
    await sql `DROP TABLE IF EXISTS ledger_global_sequence CASCADE`;
    await sql `
        CREATE TABLE IF NOT EXISTS ledger_global_sequence (
            seq_id BIGSERIAL PRIMARY KEY,
            transaction_id TEXT NOT NULL, 
            ulid TEXT NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            tx_hash TEXT
        )
    `;
    console.log('✅ ledger_global_sequence Table Recreated.');
    await sql `
        CREATE OR REPLACE FUNCTION log_global_sequence() RETURNS TRIGGER AS $$
        BEGIN
            IF NEW.status = 'committed' AND (OLD.status IS NULL OR OLD.status != 'committed') THEN
                INSERT INTO ledger_global_sequence (transaction_id, ulid, tx_hash)
                VALUES (
                    NEW.id, 
                    NEW.idempotency_key, 
                    md5(NEW.id::text || NEW.created_at::text || NEW.type::text)
                );
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
    `;
    console.log('✅ log_global_sequence Fixed.');
    // 3. Fix update_account_snapshot (Correct column 'balance')
    await sql `
        CREATE OR REPLACE FUNCTION update_account_snapshot() RETURNS TRIGGER AS $$
        BEGIN
            NEW.last_snapshot_hash := md5(NEW.id::text || NEW.balance::text || NOW()::text);
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
    `;
    console.log('✅ update_account_snapshot Fixed.');
    // 4. Fix verify_transaction_invariants (TxID is TEXT/ULID)
    await sql `
        CREATE OR REPLACE FUNCTION verify_transaction_invariants(tx_id TEXT)
        RETURNS BOOLEAN AS $$
        DECLARE
            sum_debits NUMERIC;
            sum_credits NUMERIC;
        BEGIN
            SELECT COALESCE(SUM(amount), 0) INTO sum_debits FROM ledger_entries WHERE transaction_id = tx_id AND direction = 'debit';
            SELECT COALESCE(SUM(amount), 0) INTO sum_credits FROM ledger_entries WHERE transaction_id = tx_id AND direction = 'credit';

            IF sum_debits != sum_credits THEN
                RAISE EXCEPTION 'Invariant Violation: Zero-Sum Failure. Debits (%) != Credits (%) for TX %', sum_debits, sum_credits, tx_id;
            END IF;

            RETURN TRUE;
        END;
        $$ LANGUAGE plpgsql;
    `;
    console.log('✅ verify_transaction_invariants Fixed.');
}
run().catch(console.error);
//# sourceMappingURL=fix_all_triggers.js.map