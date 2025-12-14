-- ==============================================================================
-- PRODUCTION LEDGER SCHEMA MIGRATION
-- Migration: 2025_ledger_foundation.sql
-- Date: 2025-12-13
-- ==============================================================================
--
-- CRITICAL: This is a point-of-no-return migration for Seattle Beta.
-- 
-- RULES:
--   1. NO "IF NOT EXISTS" - fail hard on conflicts
--   2. Transaction-wrapped - all or nothing
--   3. Must run in single session
--
-- VERIFICATION BEFORE RUNNING:
--   BEGIN; <paste contents> ROLLBACK;  -- Dry run
--
-- PRODUCTION RUN:
--   BEGIN; <paste contents> COMMIT;
--
-- ==============================================================================

BEGIN;

-- ==============================================================================
-- SECTION 1: ENUMS (Must be first, fail if exist)
-- ==============================================================================

CREATE TYPE ledger_account_type AS ENUM ('asset', 'liability', 'equity', 'expense');
CREATE TYPE ledger_entry_direction AS ENUM ('debit', 'credit');
CREATE TYPE ledger_tx_status AS ENUM ('pending', 'executing', 'committed', 'confirmed', 'failed');


-- ==============================================================================
-- SECTION 2: CORE LEDGER TABLES
-- ==============================================================================

-- 2.1 LEDGER ACCOUNTS
-- Tracks the current state of every bucket of money.
CREATE TABLE ledger_accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_type text NOT NULL,            -- 'platform', 'user', 'task'
    owner_id text,                        -- TEXT for flexibility (UUID or prefixed ID)
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

CREATE INDEX idx_ledger_accounts_owner ON ledger_accounts(owner_type, owner_id);


-- 2.2 LEDGER TRANSACTIONS
-- The atomic unit of change. ID is ULID stored as TEXT.
CREATE TABLE ledger_transactions (
    id text PRIMARY KEY,                  -- ULID
    type text NOT NULL,                   -- 'ESCROW_HOLD', 'PAYOUT_RELEASE', etc.
    idempotency_key text UNIQUE,          -- Ring 3 Lock (Stripe/Event ID)
    status text NOT NULL DEFAULT 'pending',
    metadata jsonb DEFAULT '{}',
    description text,
    created_at timestamptz DEFAULT now(),
    committed_at timestamptz
);

CREATE INDEX idx_ledger_tx_status ON ledger_transactions(status);
CREATE INDEX idx_ledger_tx_date ON ledger_transactions(created_at);


-- 2.3 LEDGER ENTRIES
-- Individual line items. Double-entry bookkeeping.
CREATE TABLE ledger_entries (
    id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    transaction_id text NOT NULL REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
    account_id uuid NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
    direction text NOT NULL CHECK (direction IN ('debit', 'credit')),
    amount bigint NOT NULL CHECK (amount > 0),
    created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_ledger_entries_tx ON ledger_entries(transaction_id);
CREATE INDEX idx_ledger_entries_account ON ledger_entries(account_id);


-- 2.4 LEDGER LOCKS (Application-Level Coordination)
CREATE TABLE ledger_locks (
    resource_id text PRIMARY KEY,         -- e.g. "task:uuid", "user:uuid"
    owner_ulid text NOT NULL,
    acquired_at timestamptz DEFAULT now(),
    expires_at timestamptz NOT NULL
);


-- ==============================================================================
-- SECTION 3: STRIPE INTEGRATION TABLES
-- ==============================================================================

-- 3.1 STRIPE OUTBOUND LOG (Split-Brain Recovery)
-- Tracks every successful outbound Stripe call by its Idempotency Key.
CREATE TABLE stripe_outbound_log (
    idempotency_key text PRIMARY KEY,
    stripe_id text NOT NULL,              -- pi_..., tr_..., re_...
    type text NOT NULL,                   -- 'pi', 'transfer', 'refund'
    payload jsonb,
    created_at timestamptz DEFAULT now()
);


-- 3.2 STRIPE BALANCE HISTORY (Reconciliation Mirror)
CREATE TABLE stripe_balance_history (
    id text PRIMARY KEY,                  -- txn_... (Stripe ID)
    amount bigint NOT NULL,
    currency text NOT NULL,
    type text NOT NULL,                   -- 'charge', 'payout', 'transfer', 'fee'
    status text NOT NULL,
    available_on timestamptz,
    created timestamptz,
    reporting_category text,
    source_id text,
    description text
);


-- ==============================================================================
-- SECTION 4: SAGA & MONEY STATE TABLES
-- ==============================================================================

-- 4.1 MONEY STATE LOCK (Saga Pattern)
-- This ONLY references tasks if tasks table exists
CREATE TABLE money_state_lock (
    task_id uuid PRIMARY KEY,
    current_state text NOT NULL,
    next_allowed_event text[],
    stripe_payment_intent_id text,
    stripe_charge_id text,
    stripe_transfer_id text,
    stripe_refund_id text,
    poster_uid text,
    version integer DEFAULT 0,
    last_transition_at timestamptz DEFAULT now()
);


-- 4.2 MONEY EVENTS PROCESSED (Idempotency - Ring 3)
CREATE TABLE money_events_processed (
    event_id text PRIMARY KEY,
    task_id uuid NOT NULL,
    event_type text NOT NULL,
    processed_at timestamptz DEFAULT now()
);


-- 4.3 MONEY EVENTS AUDIT (Financial State History)
CREATE TABLE money_events_audit (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id text NOT NULL,
    task_id uuid NOT NULL,
    actor_uid text,
    event_type text NOT NULL,
    previous_state text,
    new_state text,
    stripe_payment_intent_id text,
    stripe_charge_id text,
    stripe_transfer_id text,
    raw_context jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_money_events_audit_task ON money_events_audit(task_id);
CREATE INDEX idx_money_events_audit_event ON money_events_audit(event_id);
CREATE INDEX idx_money_events_audit_created ON money_events_audit(created_at);


-- ==============================================================================
-- SECTION 5: OPERATIONAL SAFETY TABLES
-- ==============================================================================

-- 5.1 LEDGER PREPARES (Audit Trail for All Intent)
CREATE TABLE ledger_prepares (
    ulid text PRIMARY KEY,
    idempotency_key text NOT NULL,
    type text NOT NULL,
    metadata jsonb DEFAULT '{}',
    entries_snapshot jsonb NOT NULL,
    created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_ledger_prepares_idempotency ON ledger_prepares(idempotency_key);


-- 5.2 LEDGER SNAPSHOTS (Periodic Checkpoints)
CREATE TABLE ledger_snapshots (
    id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    account_id uuid NOT NULL REFERENCES ledger_accounts(id),
    balance bigint NOT NULL,
    last_tx_ulid text NOT NULL,
    snapshot_hash text NOT NULL,
    created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_ledger_snapshot_account ON ledger_snapshots(account_id, created_at DESC);


-- 5.3 LEDGER PENDING ACTIONS (Dead Letter Queue)
CREATE TABLE ledger_pending_actions (
    id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    transaction_id text,
    type text NOT NULL,                   -- 'COMMIT_TX', 'REVERSE_STRIPE', 'NOTIFY_ADMIN'
    payload jsonb NOT NULL,
    error_log text,
    retry_count int DEFAULT 0,
    next_retry_at timestamptz DEFAULT now(),
    status text DEFAULT 'pending'
);


-- 5.4 LEDGER GLOBAL SEQUENCE (Monotonic Ordering)
CREATE TABLE ledger_global_sequence (
    seq_id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    transaction_id text NOT NULL,
    ulid text NOT NULL,
    created_at timestamptz DEFAULT now(),
    tx_hash text
);


-- ==============================================================================
-- SECTION 6: IMMUTABILITY TRIGGERS
-- ==============================================================================

-- 6.1 Prevent tampering with ledger entries (append-only)
CREATE OR REPLACE FUNCTION prevent_ledger_tamper()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Invariant Violation: Ledger entries are append-only. No updates or deletes allowed.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_ledger_tamper_update
BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH STATEMENT EXECUTE FUNCTION prevent_ledger_tamper();


-- 6.2 Enforce positive amounts on entries
CREATE OR REPLACE FUNCTION check_positive_amount()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.amount <= 0 THEN
        RAISE EXCEPTION 'Invariant Violation: Ledger entries must have strictly positive amounts (Got: %)', NEW.amount;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_positive_amount
BEFORE INSERT ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION check_positive_amount();


-- ==============================================================================
-- SECTION 7: ZERO-SUM VERIFICATION FUNCTION
-- ==============================================================================

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
$$ LANGUAGE plpgsql;


-- ==============================================================================
-- SECTION 8: GLOBAL SEQUENCE LOGGING
-- ==============================================================================

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
$$ LANGUAGE plpgsql;

CREATE TRIGGER log_global_sequence
AFTER UPDATE ON ledger_transactions
FOR EACH ROW EXECUTE FUNCTION log_global_sequence();


-- ==============================================================================
-- MIGRATION COMPLETE 
-- ==============================================================================

-- Verification query (run after COMMIT to confirm):
-- SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;

COMMIT;
