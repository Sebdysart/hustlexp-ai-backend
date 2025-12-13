-- OMEGA PHASE 8B: ENGINE HARDENING SCHEMA
-- Support for Split-Brain Guards and Prepare Audit

-- 1. STRIPE OUTBOUND MIRROR (Split-Brain Guard)
-- Tracks every successful outbound Stripe call by its Idempotency Key.
-- If Node crashes after Stripe Success but before DB Commit, this table allows recovery/short-circuit.
CREATE TABLE IF NOT EXISTS stripe_outbound_log (
    idempotency_key VARCHAR(255) PRIMARY KEY,
    stripe_id VARCHAR(255) NOT NULL, -- The result ID (pi_..., tr_..., re_...)
    type VARCHAR(50) NOT NULL, -- 'pi', 'transfer', 'refund'
    payload JSONB, -- Optional: Storing the result for exact replay
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. LEDGER PREPARE STREAM (Audit)
-- Logs every intent to change money, even if it fails later.
-- Append-Only.
CREATE TABLE IF NOT EXISTS ledger_prepares (
    ulid VARCHAR(26) PRIMARY KEY, -- The Transaction ULID
    idempotency_key VARCHAR(255) NOT NULL,
    type VARCHAR(100) NOT NULL,
    metadata JSONB DEFAULT '{}',
    entries_snapshot JSONB NOT NULL, -- The intended entries
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for searching prepares by idempotency (to match transactions)
CREATE INDEX IF NOT EXISTS idx_ledger_prepares_idempotency ON ledger_prepares(idempotency_key);
