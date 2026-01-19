-- BUILD_GUIDE Phase 3: State Machine Audit Tables
-- Creates logging tables for state machine transitions
-- Run this migration to enable state tracking

-- ============================================================================
-- TASK STATE LOG
-- ============================================================================

CREATE TABLE IF NOT EXISTS task_state_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id),
  from_state VARCHAR(50) NOT NULL,
  to_state VARCHAR(50) NOT NULL,
  context JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_state_log_task_id ON task_state_log(task_id);
CREATE INDEX IF NOT EXISTS idx_task_state_log_created_at ON task_state_log(created_at);

-- ============================================================================
-- ESCROW STATE LOG
-- ============================================================================

CREATE TABLE IF NOT EXISTS escrow_state_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL,
  from_state VARCHAR(50) NOT NULL,
  to_state VARCHAR(50) NOT NULL,
  context JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_escrow_state_log_task_id ON escrow_state_log(task_id);
CREATE INDEX IF NOT EXISTS idx_escrow_state_log_created_at ON escrow_state_log(created_at);

-- ============================================================================
-- PROOF STATE LOG
-- ============================================================================

CREATE TABLE IF NOT EXISTS proof_state_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proof_id UUID NOT NULL,
  task_id UUID NOT NULL,
  from_state VARCHAR(50) NOT NULL,
  to_state VARCHAR(50) NOT NULL,
  context JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_proof_state_log_proof_id ON proof_state_log(proof_id);
CREATE INDEX IF NOT EXISTS idx_proof_state_log_task_id ON proof_state_log(task_id);
CREATE INDEX IF NOT EXISTS idx_proof_state_log_created_at ON proof_state_log(created_at);

-- ============================================================================
-- PROOF SUBMISSIONS TABLE (if not exists)
-- ============================================================================

CREATE TABLE IF NOT EXISTS proof_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id),
  hustler_id UUID NOT NULL REFERENCES users(id),
  description TEXT,
  photo_urls JSONB DEFAULT '[]',
  quality VARCHAR(20) DEFAULT 'BASIC' CHECK (quality IN ('BASIC', 'STANDARD', 'COMPREHENSIVE')),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewing', 'accepted', 'rejected', 'expired')),
  ai_score NUMERIC(5,2),
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_proof_submissions_task_id ON proof_submissions(task_id);
CREATE INDEX IF NOT EXISTS idx_proof_submissions_status ON proof_submissions(status);
CREATE INDEX IF NOT EXISTS idx_proof_submissions_hustler_id ON proof_submissions(hustler_id);

-- ============================================================================
-- MONEY STATE LOCK TABLE (if not exists)
-- This is the canonical escrow state table
-- ============================================================================

CREATE TABLE IF NOT EXISTS money_state_lock (
  task_id UUID PRIMARY KEY REFERENCES tasks(id),
  current_state VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (current_state IN (
    'pending', 'funded', 'locked_dispute', 'released', 'refunded', 'partial_refund'
  )),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  stripe_payment_intent_id VARCHAR(255),
  stripe_transfer_id VARCHAR(255),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_money_state_lock_state ON money_state_lock(current_state);

-- ============================================================================
-- TERMINAL STATE GUARDS
-- ============================================================================

-- Task terminal guard (if not exists)
CREATE OR REPLACE FUNCTION prevent_task_terminal_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IN ('completed', 'cancelled', 'expired') THEN
    RAISE EXCEPTION 'Cannot modify task in terminal state: %', OLD.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS task_terminal_guard ON tasks;
CREATE TRIGGER task_terminal_guard
BEFORE UPDATE ON tasks
FOR EACH ROW EXECUTE FUNCTION prevent_task_terminal_mutation();

-- Escrow terminal guard
CREATE OR REPLACE FUNCTION prevent_escrow_terminal_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.current_state IN ('released', 'refunded', 'partial_refund') THEN
    RAISE EXCEPTION 'Cannot modify escrow in terminal state: %', OLD.current_state;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS escrow_terminal_guard ON money_state_lock;
CREATE TRIGGER escrow_terminal_guard
BEFORE UPDATE ON money_state_lock
FOR EACH ROW EXECUTE FUNCTION prevent_escrow_terminal_mutation();

-- ============================================================================
-- XP LEDGER (ensure exists with proper constraints)
-- ============================================================================

CREATE TABLE IF NOT EXISTS xp_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  task_id UUID REFERENCES tasks(id),
  money_state_lock_task_id UUID UNIQUE,  -- INV-5: One XP per escrow
  base_xp INTEGER NOT NULL,
  decay_factor NUMERIC(10,4) NOT NULL DEFAULT 1.0000,
  effective_xp INTEGER NOT NULL,
  streak_multiplier NUMERIC(4,2) NOT NULL DEFAULT 1.00,
  final_xp INTEGER NOT NULL,
  reason VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_xp_ledger_user_id ON xp_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_xp_ledger_task_id ON xp_ledger(task_id);

-- ============================================================================
-- TRUST LEDGER (ensure exists)
-- ============================================================================

CREATE TABLE IF NOT EXISTS trust_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  old_tier INTEGER NOT NULL,
  new_tier INTEGER NOT NULL,
  reason VARCHAR(255) NOT NULL,
  triggered_by VARCHAR(50) NOT NULL,
  task_id UUID REFERENCES tasks(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trust_ledger_user_id ON trust_ledger(user_id);

-- ============================================================================
-- BADGE LEDGER (ensure exists with append-only guard)
-- ============================================================================

CREATE TABLE IF NOT EXISTS badge_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  badge_id VARCHAR(50) NOT NULL,
  tier INTEGER NOT NULL CHECK (tier BETWEEN 1 AND 4),
  name VARCHAR(100) NOT NULL,
  animation_shown_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_badge_per_user UNIQUE (user_id, badge_id)
);

CREATE INDEX IF NOT EXISTS idx_badge_ledger_user_id ON badge_ledger(user_id);

-- Badge append-only guard
CREATE OR REPLACE FUNCTION prevent_badge_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Badge ledger is append-only. Deletions forbidden.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS badge_no_delete ON badge_ledger;
CREATE TRIGGER badge_no_delete
BEFORE DELETE ON badge_ledger
FOR EACH ROW EXECUTE FUNCTION prevent_badge_delete();

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================

-- Log migration
INSERT INTO schema_migrations (version, name, applied_at)
VALUES ('20260107_001', 'state_machine_tables', NOW())
ON CONFLICT (version) DO NOTHING;
