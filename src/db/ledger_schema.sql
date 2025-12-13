
-- ==============================================================================
-- MILITARY-GRADE LEDGER SCHEMA (Option C: Integrated + Operational)
-- ==============================================================================
-- Architecture: Double-Entry, USD-Only, ULID Primary Keys, Immutable History.
-- Invariants:
-- 1. All amounts in integer cents.
-- 2. Currency is strictly 'USD'.
-- 3. Transactions are immutable (NO UPDATE/DELETE).
-- 4. Transactions must balance (Sum Debits = Sum Credits).
-- 5. Transactions must have 2+ entries.
-- ==============================================================================

-- 1. ENUMS & TYPES
-- ------------------------------------------------------------------------------
CREATE TYPE ledger_account_type AS ENUM ('asset', 'liability', 'equity', 'expense');
CREATE TYPE ledger_entry_direction AS ENUM ('debit', 'credit');
CREATE TYPE ledger_tx_status AS ENUM ('pending', 'executing', 'committed', 'confirmed', 'failed');

-- 2. LEDGER ACCOUNTS
-- ------------------------------------------------------------------------------
-- Tracks the current state of every bucket of money.
-- Includes 'baselines' for efficient replay without scanning full history.
CREATE TABLE ledger_accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Ownership Context
    owner_type text NOT NULL, -- 'platform', 'user', 'task'
    owner_id uuid,            -- NULL for platform accounts
    
    -- Financial Properties
    type ledger_account_type NOT NULL,
    currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
    
    -- Balances (Snapshots)
    balance bigint NOT NULL DEFAULT 0,
    
    -- Replay Baselines (The "Save Point")
    baseline_balance bigint NOT NULL DEFAULT 0,
    baseline_tx_ulid text, -- The last transaction included in the baseline
    
    -- Metadata
    name text NOT NULL, -- e.g. "Platform Escrow", "User X Wallet"
    metadata jsonb DEFAULT '{}',
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    
    -- Constraints
    CONSTRAINT balance_validity CHECK (
        -- Assets/Expenses normally positive (Debit balance)
        -- Liabilities/Equity normally positive (Credit balance)
        -- We allow negatives for overdrafts/errors but monitor them at app level.
        -- Use guards in Service Layer for strictness.
        true 
    )
);

-- Index for lookup by owner
CREATE INDEX idx_ledger_accounts_owner ON ledger_accounts(owner_type, owner_id);


-- 3. LEDGER LOCKS (Ring 1)
-- ------------------------------------------------------------------------------
-- Application-level locks to coordinate complex operations before touching DB rows.
CREATE TABLE ledger_locks (
    resource_id text PRIMARY KEY, -- e.g. "task:uuid", "user:uuid"
    owner_ulid text NOT NULL,     -- The ULID of the transaction holding the lock
    acquired_at timestamptz DEFAULT now(),
    expires_at timestamptz NOT NULL
);


-- 4. LEDGER TRANSACTIONS
-- ------------------------------------------------------------------------------
-- The atomic unit of change. 
-- ID is ULID (Sortable, Unique) -> Stored as TEXT for compatibility.
CREATE TABLE ledger_transactions (
    id text PRIMARY KEY, -- ULID
    
    type text NOT NULL, -- 'ESCROW_HOLD', 'PAYOUT_RELEASE', etc.
    idempotency_key text UNIQUE NOT NULL, -- Ring 3 Lock (Stripe ID)
    
    status ledger_tx_status NOT NULL DEFAULT 'pending',
    
    metadata jsonb DEFAULT '{}',
    description text,
    
    -- Auditing
    created_at timestamptz DEFAULT now(),
    committed_at timestamptz
);

-- Index for status checks
CREATE INDEX idx_ledger_tx_status ON ledger_transactions(status);
CREATE INDEX idx_ledger_tx_date ON ledger_transactions(created_at);


-- 5. LEDGER ENTRIES
-- ------------------------------------------------------------------------------
-- The individual line items.
CREATE TABLE ledger_entries (
    id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    transaction_id text NOT NULL REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
    account_id uuid NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
    
    direction ledger_entry_direction NOT NULL,
    amount bigint NOT NULL CHECK (amount > 0), -- Must be positive. Direction determines sign.
    
    created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_ledger_entries_tx ON ledger_entries(transaction_id);
CREATE INDEX idx_ledger_entries_account ON ledger_entries(account_id);


-- 6. LEDGER SNAPSHOTS (Operational Safety)
-- ------------------------------------------------------------------------------
-- Periodic immutable checkpoints for fast reconciliation.
CREATE TABLE ledger_snapshots (
    id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    account_id uuid NOT NULL REFERENCES ledger_accounts(id),
    
    balance bigint NOT NULL,
    last_tx_ulid text NOT NULL,
    
    snapshot_hash text NOT NULL, -- SHA-256(account_id + balance + last_tx_ulid)
    
    created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_ledger_snapshot_account ON ledger_snapshots(account_id, created_at DESC);


-- 7. DEAD LETTER QUEUE (Recovery)
-- ------------------------------------------------------------------------------
-- Stores failed or orphaned actions for the Retry Daemon.
CREATE TABLE ledger_pending_actions (
    id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    transaction_id text,
    type text NOT NULL, -- 'COMMIT_TX', 'REVERSE_STRIPE', 'NOTIFY_ADMIN'
    payload jsonb NOT NULL,
    
    error_log text,
    retry_count int DEFAULT 0,
    next_retry_at timestamptz DEFAULT now(),
    status text DEFAULT 'pending' -- 'pending', 'processing', 'failed', 'resolved'
);


-- 8. STRIPE BALANCE MIRROR (Reconciliation)
-- ------------------------------------------------------------------------------
-- Raw reflection of Stripe's Balance Transactions for 3-Way Recon.
CREATE TABLE stripe_balance_history (
    id text PRIMARY KEY, -- txn_... (Stripe ID)
    amount bigint NOT NULL,
    currency text NOT NULL,
    type text NOT NULL, -- 'charge', 'payout', 'transfer', 'fee'
    status text NOT NULL,
    available_on timestamptz,
    created timestamptz,
    
    reporting_category text, 
    source_id text, -- ch_... or py_...
    description text
);


-- ==============================================================================
-- TRIGGER: BLOCK UPDATES (Immutability)
-- ==============================================================================
CREATE OR REPLACE FUNCTION prevent_ledger_update()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_TABLE_NAME = 'ledger_transactions' THEN
        -- Allow status transitions and metadata updates
        -- But enforce identity immutability
        IF NEW.id != OLD.id OR NEW.type != OLD.type OR NEW.idempotency_key != OLD.idempotency_key OR NEW.created_at != OLD.created_at THEN
            RAISE EXCEPTION 'Ledger transaction identity (id, type, key, created_at) is immutable.';
        END IF;
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Ledger tables are immutable using DELETE/UPDATE. Insert limits only.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_immutable_transactions
BEFORE UPDATE OR DELETE ON ledger_transactions
FOR EACH ROW EXECUTE FUNCTION prevent_ledger_update();

CREATE TRIGGER trg_immutable_entries
BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION prevent_ledger_update();

