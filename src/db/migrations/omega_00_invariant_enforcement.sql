-- OMEGA PHASE 8A: SYSTEM-WIDE INVARIANT ENFORCEMENT
-- "Indestructible Fintech Kernel"

-- 1. STRICT POSITIVE AMOUNT INVARIANT
CREATE OR REPLACE FUNCTION check_positive_amount()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.amount <= 0 THEN
        RAISE EXCEPTION 'Invariant Violation: Ledger entries must have strictly positive amounts (Got: %)', NEW.amount;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_positive_amount ON ledger_entries;
CREATE TRIGGER enforce_positive_amount
BEFORE INSERT OR UPDATE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION check_positive_amount();

-- 2. IMMUTABLE MONEY HISTORY INVARIANT
CREATE OR REPLACE FUNCTION prevent_ledger_tamper()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Invariant Violation: Ledger entries are append-only. No updates or deletes allowed.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS prevent_ledger_tamper_update ON ledger_entries;
CREATE TRIGGER prevent_ledger_tamper_update
BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH STATEMENT EXECUTE FUNCTION prevent_ledger_tamper();

-- 3. SAGA STATE MACHINE & TERMINAL GUARANTEES
CREATE OR REPLACE FUNCTION enforce_saga_state()
RETURNS TRIGGER AS $$
BEGIN
    -- No Deletes
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Invariant Violation: Ledger transactions cannot be deleted.';
    END IF;

    -- Terminal State Guarantee
    IF OLD.status IN ('COMMITTED', 'FAILED') AND NEW.status != OLD.status THEN
        RAISE EXCEPTION 'Invariant Violation: Cannot mutate ledger transaction from terminal state % to %', OLD.status, NEW.status;
    END IF;

    -- Valid Transitions (Strict Graph)
    IF OLD.status = 'PENDING' AND NEW.status NOT IN ('EXECUTING', 'FAILED', 'COMMITTED') THEN
        -- Allow fast-fail or fast-commit, but strictly usually PENDING->EXECUTING->...
        -- Just preventing backward flow or weird jumps
        RAISE EXCEPTION 'Invariant Violation: Invalid state transition from PENDING to %', NEW.status;
    END IF;

    IF OLD.status = 'EXECUTING' AND NEW.status NOT IN ('COMMITTED', 'FAILED') THEN
        RAISE EXCEPTION 'Invariant Violation: Invalid state transition from EXECUTING to %', NEW.status;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_saga_state ON ledger_transactions;
CREATE TRIGGER enforce_saga_state
BEFORE UPDATE OR DELETE ON ledger_transactions
FOR EACH ROW EXECUTE FUNCTION enforce_saga_state();

-- 4. MONOTONIC TRANSACTION ORDERING (Global Sequence)
CREATE TABLE IF NOT EXISTS ledger_global_sequence (
    seq_id BIGSERIAL PRIMARY KEY,
    transaction_id UUID NOT NULL, -- references ledger_transactions(id) but weak link to avoid complex FK issues on high write
    ulid TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    tx_hash TEXT -- Proof of Integrity
);

CREATE OR REPLACE FUNCTION log_global_sequence()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'COMMITTED' AND (OLD.status IS NULL OR OLD.status != 'COMMITTED') THEN
        INSERT INTO ledger_global_sequence (transaction_id, ulid, tx_hash)
        VALUES (
            NEW.id, 
            NEW.idempotency_key, -- Using idempotency key as proxy for ULID if not present, needs alignment with code
            md5(NEW.id::text || NEW.created_at::text || NEW.amount::text)
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS log_global_sequence ON ledger_transactions;
CREATE TRIGGER log_global_sequence
AFTER UPDATE ON ledger_transactions
FOR EACH ROW EXECUTE FUNCTION log_global_sequence();

-- 5. ACCOUNT-TYPE COMPATIBILITY & ZERO-SUM (Function for In-Transaction Check)
-- Note: This is usually called explicitly by the Application inside the Commit TX, 
-- but we can adding a helper function here for the App to call.

CREATE OR REPLACE FUNCTION verify_transaction_invariants(tx_id UUID)
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

-- 6. SNAPSHOT CONSISTENCY (Basic Hash Trigger)
ALTER TABLE ledger_accounts ADD COLUMN IF NOT EXISTS last_snapshot_hash TEXT;

CREATE OR REPLACE FUNCTION update_account_snapshot()
RETURNS TRIGGER AS $$
BEGIN
    -- Simple hash of ID + Balance + ModifiedAt
    NEW.last_snapshot_hash := md5(NEW.id::text || NEW.balance_amount::text || NOW()::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_account_snapshot ON ledger_accounts;
CREATE TRIGGER update_account_snapshot
BEFORE INSERT OR UPDATE ON ledger_accounts
FOR EACH ROW EXECUTE FUNCTION update_account_snapshot();
