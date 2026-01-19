-- Migration: Add missing columns to trust_ledger table
-- Pre-Alpha Prerequisite: Align trust_ledger with canonical schema

-- Add idempotency_key column (required for idempotent trust tier changes)
ALTER TABLE trust_ledger 
ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255);

-- Add event_source column (required for audit trail)
ALTER TABLE trust_ledger 
ADD COLUMN IF NOT EXISTS event_source VARCHAR(50);

-- Add source_event_id column (optional, for linking to outbox events)
ALTER TABLE trust_ledger 
ADD COLUMN IF NOT EXISTS source_event_id VARCHAR(255);

-- Create unique index on idempotency_key (enforces idempotency)
CREATE UNIQUE INDEX IF NOT EXISTS idx_trust_ledger_idempotency 
ON trust_ledger(idempotency_key) 
WHERE idempotency_key IS NOT NULL;

-- Make idempotency_key NOT NULL for new rows (existing rows can be null temporarily)
-- Note: We'll backfill existing rows with generated keys
UPDATE trust_ledger 
SET idempotency_key = 'legacy_' || id::text 
WHERE idempotency_key IS NULL;

-- Now make it NOT NULL
ALTER TABLE trust_ledger 
ALTER COLUMN idempotency_key SET NOT NULL;

-- Set default event_source for existing rows
UPDATE trust_ledger 
SET event_source = 'system' 
WHERE event_source IS NULL;

-- Make event_source NOT NULL
ALTER TABLE trust_ledger 
ALTER COLUMN event_source SET NOT NULL;
