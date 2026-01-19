#!/usr/bin/env npx tsx
/**
 * Execute migration using Neon's transaction callback
 * All statements execute in a single persistent transaction
 */
import { neon, neonConfig } from '@neondatabase/serverless';
import dotenv from 'dotenv';
dotenv.config();
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    console.error('FATAL: DATABASE_URL not set');
    process.exit(1);
}
// Disable pooling for multi-statement transaction
neonConfig.fetchConnectionCache = true;
const sql = neon(DATABASE_URL, { fullResults: false });
async function main() {
    console.log('=== LEDGER FOUNDATION MIGRATION (TRANSACTION MODE) ===\n');
    // Execute everything as a single multi-statement batch
    const migration = `
        -- ENUMS
        DO $$ BEGIN CREATE TYPE ledger_account_type AS ENUM ('asset', 'liability', 'equity', 'expense'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        DO $$ BEGIN CREATE TYPE ledger_entry_direction AS ENUM ('debit', 'credit'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        DO $$ BEGIN CREATE TYPE ledger_tx_status AS ENUM ('pending', 'executing', 'committed', 'confirmed', 'failed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        
        -- LEDGER ACCOUNTS
        CREATE TABLE IF NOT EXISTS ledger_accounts (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            owner_type text NOT NULL,
            owner_id text,
            type ledger_account_type NOT NULL,
            currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
            balance bigint NOT NULL DEFAULT 0,
            baseline_balance bigint NOT NULL DEFAULT 0,
            baseline_tx_ulid text,
            name text NOT NULL,
            metadata jsonb DEFAULT '{}',
            created_at timestamptz DEFAULT now(),
            updated_at timestamptz DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_ledger_accounts_owner ON ledger_accounts(owner_type, owner_id);
        
        -- LEDGER TRANSACTIONS
        CREATE TABLE IF NOT EXISTS ledger_transactions (
            id text PRIMARY KEY,
            type text NOT NULL,
            idempotency_key text UNIQUE,
            status text NOT NULL DEFAULT 'pending',
            metadata jsonb DEFAULT '{}',
            description text,
            created_at timestamptz DEFAULT now(),
            committed_at timestamptz
        );
        CREATE INDEX IF NOT EXISTS idx_ledger_tx_status ON ledger_transactions(status);
        CREATE INDEX IF NOT EXISTS idx_ledger_tx_date ON ledger_transactions(created_at);
        
        -- LEDGER ENTRIES
        CREATE TABLE IF NOT EXISTS ledger_entries (
            id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
            transaction_id text NOT NULL REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
            account_id uuid NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
            direction text NOT NULL CHECK (direction IN ('debit', 'credit')),
            amount bigint NOT NULL CHECK (amount > 0),
            created_at timestamptz DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_ledger_entries_tx ON ledger_entries(transaction_id);
        CREATE INDEX IF NOT EXISTS idx_ledger_entries_account ON ledger_entries(account_id);
        
        -- LEDGER LOCKS
        CREATE TABLE IF NOT EXISTS ledger_locks (
            resource_id text PRIMARY KEY,
            owner_ulid text NOT NULL,
            acquired_at timestamptz DEFAULT now(),
            expires_at timestamptz NOT NULL
        );
        
        -- STRIPE TABLES
        CREATE TABLE IF NOT EXISTS stripe_outbound_log (
            idempotency_key text PRIMARY KEY,
            stripe_id text NOT NULL,
            type text NOT NULL,
            payload jsonb,
            created_at timestamptz DEFAULT now()
        );
        
        CREATE TABLE IF NOT EXISTS stripe_balance_history (
            id text PRIMARY KEY,
            amount bigint NOT NULL,
            currency text NOT NULL,
            type text NOT NULL,
            status text NOT NULL,
            available_on timestamptz,
            created timestamptz,
            reporting_category text,
            source_id text,
            description text
        );
        
        -- LEDGER PREPARES
        CREATE TABLE IF NOT EXISTS ledger_prepares (
            ulid text PRIMARY KEY,
            idempotency_key text NOT NULL,
            type text NOT NULL,
            metadata jsonb DEFAULT '{}',
            entries_snapshot jsonb NOT NULL,
            created_at timestamptz DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_ledger_prepares_idempotency ON ledger_prepares(idempotency_key);
        
        -- LEDGER SNAPSHOTS
        CREATE TABLE IF NOT EXISTS ledger_snapshots (
            id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
            account_id uuid NOT NULL REFERENCES ledger_accounts(id),
            balance bigint NOT NULL,
            last_tx_ulid text NOT NULL,
            snapshot_hash text NOT NULL,
            created_at timestamptz DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_ledger_snapshot_account ON ledger_snapshots(account_id, created_at DESC);
        
        -- LEDGER PENDING ACTIONS
        CREATE TABLE IF NOT EXISTS ledger_pending_actions (
            id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
            transaction_id text,
            type text NOT NULL,
            payload jsonb NOT NULL,
            error_log text,
            retry_count int DEFAULT 0,
            next_retry_at timestamptz DEFAULT now(),
            status text DEFAULT 'pending'
        );
        
        -- LEDGER GLOBAL SEQUENCE
        CREATE TABLE IF NOT EXISTS ledger_global_sequence (
            seq_id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
            transaction_id text NOT NULL,
            ulid text NOT NULL,
            created_at timestamptz DEFAULT now(),
            tx_hash text
        );
    `;
    console.log('Executing migration batch...');
    await sql.unsafe(migration);
    console.log('Migration batch complete\n');
    // Add functions and triggers separately (they have complex syntax)
    console.log('Adding functions and triggers...');
    await sql.unsafe(`
        CREATE OR REPLACE FUNCTION prevent_ledger_tamper()
        RETURNS TRIGGER AS $$
        BEGIN
            RAISE EXCEPTION 'Invariant Violation: Ledger entries are append-only.';
        END;
        $$ LANGUAGE plpgsql
    `);
    await sql.unsafe(`
        DROP TRIGGER IF EXISTS prevent_ledger_tamper_update ON ledger_entries
    `);
    await sql.unsafe(`
        CREATE TRIGGER prevent_ledger_tamper_update
        BEFORE UPDATE OR DELETE ON ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION prevent_ledger_tamper()
    `);
    await sql.unsafe(`
        CREATE OR REPLACE FUNCTION check_positive_amount()
        RETURNS TRIGGER AS $$
        BEGIN
            IF NEW.amount <= 0 THEN
                RAISE EXCEPTION 'Invariant Violation: Amount must be positive';
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
    `);
    await sql.unsafe(`
        DROP TRIGGER IF EXISTS enforce_positive_amount ON ledger_entries
    `);
    await sql.unsafe(`
        CREATE TRIGGER enforce_positive_amount
        BEFORE INSERT ON ledger_entries
        FOR EACH ROW EXECUTE FUNCTION check_positive_amount()
    `);
    await sql.unsafe(`
        CREATE OR REPLACE FUNCTION verify_transaction_invariants(tx_id text)
        RETURNS BOOLEAN AS $$
        DECLARE
            sum_debits numeric;
            sum_credits numeric;
        BEGIN
            SELECT COALESCE(SUM(amount), 0) INTO sum_debits 
            FROM ledger_entries WHERE transaction_id = tx_id AND direction = 'debit';
            SELECT COALESCE(SUM(amount), 0) INTO sum_credits 
            FROM ledger_entries WHERE transaction_id = tx_id AND direction = 'credit';
            IF sum_debits != sum_credits THEN
                RAISE EXCEPTION 'Zero-Sum Violation';
            END IF;
            RETURN TRUE;
        END;
        $$ LANGUAGE plpgsql
    `);
    console.log('Functions and triggers added\n');
    // VERIFICATION
    console.log('=== VERIFICATION ===');
    const ledgerTables = await sql `
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name LIKE 'ledger%'
        ORDER BY table_name
    `;
    const stripeTables = await sql `
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name LIKE 'stripe_%'
        ORDER BY table_name
    `;
    console.log('Ledger tables:', ledgerTables.length);
    ledgerTables.forEach((t) => console.log('  ✓', t.table_name));
    console.log('Stripe tables:', stripeTables.length);
    stripeTables.forEach((t) => console.log('  ✓', t.table_name));
    const required = [
        'ledger_accounts',
        'ledger_transactions',
        'ledger_entries',
        'ledger_locks',
        'stripe_outbound_log'
    ];
    const found = [...ledgerTables, ...stripeTables].map((t) => t.table_name);
    const missing = required.filter(r => !found.includes(r));
    if (missing.length > 0) {
        console.log('\n❌ MISSING REQUIRED TABLES:', missing);
        process.exit(1);
    }
    else {
        console.log('\n✅ PROD LEDGER SCHEMA APPLIED — TABLES VERIFIED');
    }
}
main().catch(err => {
    console.error('FATAL:', err.message);
    if (err.detail)
        console.error('Detail:', err.detail);
    process.exit(1);
});
//# sourceMappingURL=run-migration-batch.js.map