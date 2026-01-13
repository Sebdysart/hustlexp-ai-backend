-- ============================================================================
-- Trust Engine MVP Schema Migration
-- ============================================================================
-- Adds idempotency and event tracking to trust_ledger
-- Adds trust_hold flags to users
-- Adds risk_level to tasks
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Extend trust_ledger for idempotency
-- ----------------------------------------------------------------------------

ALTER TABLE trust_ledger
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255) UNIQUE,
  ADD COLUMN IF NOT EXISTS event_source VARCHAR(50),
  ADD COLUMN IF NOT EXISTS source_event_id VARCHAR(255);

-- Backfill: generate idempotency keys for existing rows (if any)
-- Format: trust_change:<user_id>:<timestamp>:<old_tier>:<new_tier>
UPDATE trust_ledger
SET idempotency_key = 'trust_change:' || user_id::text || ':' || EXTRACT(EPOCH FROM changed_at)::bigint || ':' || old_tier || ':' || new_tier
WHERE idempotency_key IS NULL;

-- Now make it NOT NULL (after backfill)
ALTER TABLE trust_ledger
  ALTER COLUMN idempotency_key SET NOT NULL,
  ALTER COLUMN event_source SET NOT NULL DEFAULT 'system';

-- Create unique index (if not exists via UNIQUE constraint)
CREATE UNIQUE INDEX IF NOT EXISTS idx_trust_ledger_idempotency ON trust_ledger(idempotency_key);

-- ----------------------------------------------------------------------------
-- 2. Add trust_hold flags to users
-- ----------------------------------------------------------------------------

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS trust_hold BOOLEAN DEFAULT FALSE NOT NULL,
  ADD COLUMN IF NOT EXISTS trust_hold_reason VARCHAR(100),
  ADD COLUMN IF NOT EXISTS trust_hold_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_trust_hold ON users(trust_hold);

-- ----------------------------------------------------------------------------
-- 3. Add risk_level to tasks
-- ----------------------------------------------------------------------------

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS risk_level VARCHAR(20) NOT NULL DEFAULT 'LOW'
    CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH', 'IN_HOME'));

CREATE INDEX IF NOT EXISTS idx_tasks_risk_level ON tasks(risk_level);

-- ----------------------------------------------------------------------------
-- 4. Update trust audit trigger to include idempotency_key
-- ----------------------------------------------------------------------------

-- Note: The audit trigger will be updated by TrustService/trust-worker
-- to use idempotency keys. For now, we keep the existing trigger
-- but it should be disabled in favor of explicit trust_ledger inserts
-- from the trust worker.

-- Drop the automatic audit trigger (trust-worker will handle logging)
DROP TRIGGER IF EXISTS trust_tier_audit ON users;
