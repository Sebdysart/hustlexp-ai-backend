#!/usr/bin/env npx tsx
/**
 * Direct execution of ledger foundation tables
 * No fancy parsing - just run each statement directly
 */
import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';

dotenv.config();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    console.error('FATAL: DATABASE_URL not set');
    process.exit(1);
}

const sql = neon(DATABASE_URL);

async function exec(name: string, statement: string) {
    console.log(`Executing: ${name}...`);
    try {
        await sql.unsafe(statement);
        console.log(`  ✓ ${name}`);
    } catch (err: any) {
        if (err.message.includes('already exists')) {
            console.log(`  (skipped - already exists)`);
        } else {
            console.error(`  ✗ FAILED: ${err.message}`);
            throw err;
        }
    }
}

async function main() {
    console.log('=== LEDGER FOUNDATION MIGRATION ===\n');

    // 1. ENUMS
    await exec('ledger_account_type enum', `CREATE TYPE ledger_account_type AS ENUM ('asset', 'liability', 'equity', 'expense')`);
    await exec('ledger_entry_direction enum', `CREATE TYPE ledger_entry_direction AS ENUM ('debit', 'credit')`);
    await exec('ledger_tx_status enum', `CREATE TYPE ledger_tx_status AS ENUM ('pending', 'executing', 'committed', 'confirmed', 'failed')`);

    // 2. LEDGER ACCOUNTS
    await exec('ledger_accounts table', `
        CREATE TABLE ledger_accounts (
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
        )
    `);
    await exec('idx_ledger_accounts_owner', `CREATE INDEX idx_ledger_accounts_owner ON ledger_accounts(owner_type, owner_id)`);

    // 3. LEDGER TRANSACTIONS
    await exec('ledger_transactions table', `
        CREATE TABLE ledger_transactions (
            id text PRIMARY KEY,
            type text NOT NULL,
            idempotency_key text UNIQUE,
            status text NOT NULL DEFAULT 'pending',
            metadata jsonb DEFAULT '{}',
            description text,
            created_at timestamptz DEFAULT now(),
            committed_at timestamptz
        )
    `);
    await exec('idx_ledger_tx_status', `CREATE INDEX idx_ledger_tx_status ON ledger_transactions(status)`);
    await exec('idx_ledger_tx_date', `CREATE INDEX idx_ledger_tx_date ON ledger_transactions(created_at)`);

    // 4. LEDGER ENTRIES
    await exec('ledger_entries table', `
        CREATE TABLE ledger_entries (
            id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
            transaction_id text NOT NULL REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
            account_id uuid NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
            direction text NOT NULL CHECK (direction IN ('debit', 'credit')),
            amount bigint NOT NULL CHECK (amount > 0),
            created_at timestamptz DEFAULT now()
        )
    `);
    await exec('idx_ledger_entries_tx', `CREATE INDEX idx_ledger_entries_tx ON ledger_entries(transaction_id)`);
    await exec('idx_ledger_entries_account', `CREATE INDEX idx_ledger_entries_account ON ledger_entries(account_id)`);

    // 5. LEDGER LOCKS
    await exec('ledger_locks table', `
        CREATE TABLE ledger_locks (
            resource_id text PRIMARY KEY,
            owner_ulid text NOT NULL,
            acquired_at timestamptz DEFAULT now(),
            expires_at timestamptz NOT NULL
        )
    `);

    // 6. STRIPE TABLES
    await exec('stripe_outbound_log table', `
        CREATE TABLE stripe_outbound_log (
            idempotency_key text PRIMARY KEY,
            stripe_id text NOT NULL,
            type text NOT NULL,
            payload jsonb,
            created_at timestamptz DEFAULT now()
        )
    `);

    await exec('stripe_balance_history table', `
        CREATE TABLE stripe_balance_history (
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
        )
    `);

    // 7. LEDGER PREPARES
    await exec('ledger_prepares table', `
        CREATE TABLE ledger_prepares (
            ulid text PRIMARY KEY,
            idempotency_key text NOT NULL,
            type text NOT NULL,
            metadata jsonb DEFAULT '{}',
            entries_snapshot jsonb NOT NULL,
            created_at timestamptz DEFAULT now()
        )
    `);
    await exec('idx_ledger_prepares_idempotency', `CREATE INDEX idx_ledger_prepares_idempotency ON ledger_prepares(idempotency_key)`);

    // 8. LEDGER SNAPSHOTS
    await exec('ledger_snapshots table', `
        CREATE TABLE ledger_snapshots (
            id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
            account_id uuid NOT NULL REFERENCES ledger_accounts(id),
            balance bigint NOT NULL,
            last_tx_ulid text NOT NULL,
            snapshot_hash text NOT NULL,
            created_at timestamptz DEFAULT now()
        )
    `);
    await exec('idx_ledger_snapshot_account', `CREATE INDEX idx_ledger_snapshot_account ON ledger_snapshots(account_id, created_at DESC)`);

    // 9. LEDGER PENDING ACTIONS
    await exec('ledger_pending_actions table', `
        CREATE TABLE ledger_pending_actions (
            id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
            transaction_id text,
            type text NOT NULL,
            payload jsonb NOT NULL,
            error_log text,
            retry_count int DEFAULT 0,
            next_retry_at timestamptz DEFAULT now(),
            status text DEFAULT 'pending'
        )
    `);

    // 10. LEDGER GLOBAL SEQUENCE
    await exec('ledger_global_sequence table', `
        CREATE TABLE ledger_global_sequence (
            seq_id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
            transaction_id text NOT NULL,
            ulid text NOT NULL,
            created_at timestamptz DEFAULT now(),
            tx_hash text
        )
    `);

    // 11. IMMUTABILITY TRIGGER FUNCTION
    await exec('prevent_ledger_tamper function', `
        CREATE OR REPLACE FUNCTION prevent_ledger_tamper()
        RETURNS TRIGGER AS $$
        BEGIN
            RAISE EXCEPTION 'Invariant Violation: Ledger entries are append-only. No updates or deletes allowed.';
        END;
        $$ LANGUAGE plpgsql
    `);

    await exec('prevent_ledger_tamper_update trigger', `
        CREATE TRIGGER prevent_ledger_tamper_update
        BEFORE UPDATE OR DELETE ON ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION prevent_ledger_tamper()
    `);

    // 12. POSITIVE AMOUNT TRIGGER
    await exec('check_positive_amount function', `
        CREATE OR REPLACE FUNCTION check_positive_amount()
        RETURNS TRIGGER AS $$
        BEGIN
            IF NEW.amount <= 0 THEN
                RAISE EXCEPTION 'Invariant Violation: Ledger entries must have strictly positive amounts (Got: %)', NEW.amount;
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
    `);

    await exec('enforce_positive_amount trigger', `
        CREATE TRIGGER enforce_positive_amount
        BEFORE INSERT ON ledger_entries
        FOR EACH ROW EXECUTE FUNCTION check_positive_amount()
    `);

    // 13. ZERO-SUM VERIFICATION FUNCTION
    await exec('verify_transaction_invariants function', `
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
                RAISE EXCEPTION 'Invariant Violation: Zero-Sum Failure. Debits (%) != Credits (%) for TX %', 
                    sum_debits, sum_credits, tx_id;
            END IF;

            RETURN TRUE;
        END;
        $$ LANGUAGE plpgsql
    `);

    // 14. GLOBAL SEQUENCE TRIGGER
    await exec('log_global_sequence function', `
        CREATE OR REPLACE FUNCTION log_global_sequence()
        RETURNS TRIGGER AS $$
        BEGIN
            IF NEW.status = 'committed' AND (OLD.status IS NULL OR OLD.status != 'committed') THEN
                INSERT INTO ledger_global_sequence (transaction_id, ulid, tx_hash)
                VALUES (
                    NEW.id, 
                    NEW.id,
                    md5(NEW.id || NEW.created_at::text)
                );
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
    `);

    await exec('log_global_sequence trigger', `
        CREATE TRIGGER log_global_sequence
        AFTER UPDATE ON ledger_transactions
        FOR EACH ROW EXECUTE FUNCTION log_global_sequence()
    `);

    // VERIFICATION
    console.log('\n=== VERIFICATION ===');

    const ledgerTables = await sql`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name LIKE 'ledger%'
        ORDER BY table_name
    `;

    const stripeTables = await sql`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name LIKE 'stripe_%'
        ORDER BY table_name
    `;

    console.log('Ledger tables:', ledgerTables.length);
    ledgerTables.forEach((t: any) => console.log('  ✓', t.table_name));

    console.log('Stripe tables:', stripeTables.length);
    stripeTables.forEach((t: any) => console.log('  ✓', t.table_name));

    const required = [
        'ledger_accounts',
        'ledger_transactions',
        'ledger_entries',
        'ledger_locks',
        'stripe_outbound_log'
    ];

    const found = [...ledgerTables, ...stripeTables].map((t: any) => t.table_name);
    const missing = required.filter(r => !found.includes(r));

    if (missing.length > 0) {
        console.log('\n❌ MISSING REQUIRED TABLES:', missing);
        process.exit(1);
    } else {
        console.log('\n✅ PROD LEDGER SCHEMA APPLIED — TABLES VERIFIED');
    }
}

main().catch(err => {
    console.error('FATAL:', err.message);
    process.exit(1);
});
