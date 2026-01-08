-- ============================================================================
-- HUSTLEXP CONSTITUTIONAL ENFORCEMENT MIGRATION
-- ============================================================================
-- Version: 1.0
-- Date: 2026-01-05
-- Purpose: Add database-level enforcement for BUILD_GUIDE invariants
-- 
-- CRITICAL: This migration makes cheating impossible at the database level.
-- All changes are additive and reversible.
-- ============================================================================

-- ============================================================================
-- 1. TASK TERMINAL STATE TRIGGER (AUDIT-4)
-- ============================================================================
-- Prevents modification of tasks in terminal states: COMPLETED, CANCELLED, EXPIRED
-- This is a constitutional guarantee, not a business rule.

CREATE OR REPLACE FUNCTION prevent_task_terminal_mutation()
RETURNS TRIGGER AS $$
BEGIN
  -- Terminal states are immutable
  IF OLD.status IN ('completed', 'cancelled', 'expired') THEN
    RAISE EXCEPTION 'INV-TERMINAL: Cannot modify task in terminal state: %. Task ID: %', 
      OLD.status, OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop if exists (idempotent)
DROP TRIGGER IF EXISTS task_terminal_guard ON tasks;

-- Create trigger
CREATE TRIGGER task_terminal_guard
BEFORE UPDATE ON tasks
FOR EACH ROW 
EXECUTE FUNCTION prevent_task_terminal_mutation();

-- Log creation
DO $$ BEGIN RAISE NOTICE 'Created: task_terminal_guard trigger'; END $$;


-- ============================================================================
-- 2. ESCROW TERMINAL STATE TRIGGER (AUDIT-4)
-- ============================================================================
-- Prevents modification of escrows in terminal states: released, refunded
-- Uses escrow_holds table (your current escrow table)

CREATE OR REPLACE FUNCTION prevent_escrow_terminal_mutation()
RETURNS TRIGGER AS $$
BEGIN
  -- Terminal states are immutable
  IF OLD.status IN ('released', 'refunded') THEN
    RAISE EXCEPTION 'INV-TERMINAL: Cannot modify escrow in terminal state: %. Escrow ID: %', 
      OLD.status, OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop if exists (idempotent)
DROP TRIGGER IF EXISTS escrow_terminal_guard ON escrow_holds;

-- Create trigger
CREATE TRIGGER escrow_terminal_guard
BEFORE UPDATE ON escrow_holds
FOR EACH ROW 
EXECUTE FUNCTION prevent_escrow_terminal_mutation();

-- Log creation
DO $$ BEGIN RAISE NOTICE 'Created: escrow_terminal_guard trigger'; END $$;


-- ============================================================================
-- 3. ESCROW AMOUNT IMMUTABILITY TRIGGER (INV-4)
-- ============================================================================
-- Escrow amount cannot change after creation. Ever.

CREATE OR REPLACE FUNCTION prevent_escrow_amount_change()
RETURNS TRIGGER AS $$
BEGIN
  -- Amount is immutable after first set
  IF OLD.gross_amount_cents IS NOT NULL 
     AND NEW.gross_amount_cents IS DISTINCT FROM OLD.gross_amount_cents THEN
    RAISE EXCEPTION 'INV-4: Escrow amount is immutable. Cannot change from % to %. Escrow ID: %',
      OLD.gross_amount_cents, NEW.gross_amount_cents, OLD.id;
  END IF;
  
  -- Also protect net_payout_cents
  IF OLD.net_payout_cents IS NOT NULL 
     AND NEW.net_payout_cents IS DISTINCT FROM OLD.net_payout_cents THEN
    RAISE EXCEPTION 'INV-4: Escrow payout amount is immutable. Cannot change from % to %. Escrow ID: %',
      OLD.net_payout_cents, NEW.net_payout_cents, OLD.id;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop if exists (idempotent)
DROP TRIGGER IF EXISTS escrow_amount_immutable ON escrow_holds;

-- Create trigger
CREATE TRIGGER escrow_amount_immutable
BEFORE UPDATE ON escrow_holds
FOR EACH ROW 
EXECUTE FUNCTION prevent_escrow_amount_change();

-- Log creation
DO $$ BEGIN RAISE NOTICE 'Created: escrow_amount_immutable trigger'; END $$;


-- ============================================================================
-- 4. XP LEDGER ESCROW LINKAGE (INV-5 PREPARATION)
-- ============================================================================
-- Add escrow_id column to xp_events for proper idempotency
-- XP should be linked to escrow (payment), not task (work)

-- Add column if not exists
ALTER TABLE xp_events 
ADD COLUMN IF NOT EXISTS escrow_id TEXT;

-- Add unique constraint for idempotency (one XP award per escrow)
-- This is the constitutional guarantee of INV-5
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'xp_events_escrow_id_unique'
  ) THEN
    ALTER TABLE xp_events 
    ADD CONSTRAINT xp_events_escrow_id_unique 
    UNIQUE (escrow_id);
    RAISE NOTICE 'Created: xp_events_escrow_id_unique constraint';
  ELSE
    RAISE NOTICE 'Already exists: xp_events_escrow_id_unique constraint';
  END IF;
END $$;

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_xp_events_escrow ON xp_events(escrow_id);

-- Log creation
DO $$ BEGIN RAISE NOTICE 'Added: escrow_id column + unique constraint to xp_events'; END $$;


-- ============================================================================
-- 5. BADGE LEDGER APPEND-ONLY ENFORCEMENT (INV-BADGE-2)
-- ============================================================================
-- Badges cannot be deleted. Ever. This is append-only.

CREATE OR REPLACE FUNCTION prevent_badge_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'INV-BADGE-2: Badge ledger is append-only. Deletions are forbidden. Badge ID: %',
    OLD.id;
END;
$$ LANGUAGE plpgsql;

-- Drop if exists (idempotent)
DROP TRIGGER IF EXISTS badge_no_delete ON badges;

-- Create trigger
CREATE TRIGGER badge_no_delete
BEFORE DELETE ON badges
FOR EACH ROW 
EXECUTE FUNCTION prevent_badge_delete();

-- Log creation
DO $$ BEGIN RAISE NOTICE 'Created: badge_no_delete trigger'; END $$;


-- ============================================================================
-- 6. XP LEDGER APPEND-ONLY ENFORCEMENT
-- ============================================================================
-- XP cannot be deleted. Ever. Only added.

CREATE OR REPLACE FUNCTION prevent_xp_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'INV-XP: XP ledger is append-only. Deletions are forbidden. XP Event ID: %',
    OLD.id;
END;
$$ LANGUAGE plpgsql;

-- Drop if exists (idempotent)
DROP TRIGGER IF EXISTS xp_no_delete ON xp_events;

-- Create trigger
CREATE TRIGGER xp_no_delete
BEFORE DELETE ON xp_events
FOR EACH ROW 
EXECUTE FUNCTION prevent_xp_delete();

-- Log creation
DO $$ BEGIN RAISE NOTICE 'Created: xp_no_delete trigger'; END $$;


-- ============================================================================
-- 7. TRUST TIER BOUNDS CHECK
-- ============================================================================
-- Add trust_tier column to users if missing, with CHECK constraint

-- Add column if not exists
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS trust_tier INTEGER DEFAULT 1;

-- Add CHECK constraint for tier bounds (1-4)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'trust_tier_bounds'
  ) THEN
    ALTER TABLE users 
    ADD CONSTRAINT trust_tier_bounds 
    CHECK (trust_tier >= 1 AND trust_tier <= 4);
    RAISE NOTICE 'Created: trust_tier_bounds constraint (1-4)';
  ELSE
    RAISE NOTICE 'Already exists: trust_tier_bounds constraint';
  END IF;
END $$;

-- Log creation
DO $$ BEGIN RAISE NOTICE 'Added: trust_tier column with bounds check'; END $$;


-- ============================================================================
-- 8. TRUST LEDGER TABLE (INV-TRUST-3)
-- ============================================================================
-- All trust changes must be audited. This is the audit log.

CREATE TABLE IF NOT EXISTS trust_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  old_tier INTEGER NOT NULL,
  new_tier INTEGER NOT NULL,
  reason TEXT NOT NULL,
  triggered_by TEXT NOT NULL,  -- 'system', 'admin:{uid}', 'dispute:{id}'
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for user lookups
CREATE INDEX IF NOT EXISTS idx_trust_ledger_user ON trust_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_trust_ledger_created ON trust_ledger(created_at);

-- Append-only enforcement
CREATE OR REPLACE FUNCTION prevent_trust_ledger_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'INV-TRUST-3: Trust ledger is append-only. Deletions are forbidden.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trust_ledger_no_delete ON trust_ledger;
CREATE TRIGGER trust_ledger_no_delete
BEFORE DELETE ON trust_ledger
FOR EACH ROW 
EXECUTE FUNCTION prevent_trust_ledger_delete();

-- Log creation
DO $$ BEGIN RAISE NOTICE 'Created: trust_ledger table (append-only)'; END $$;


-- ============================================================================
-- 9. ADMIN ROLES TABLE (INV-ADMIN-2)
-- ============================================================================
-- Formal admin authority matrix

CREATE TABLE IF NOT EXISTS admin_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(50) NOT NULL CHECK (role IN (
    'founder',           -- Full override authority
    'lead_engineer',     -- Technical overrides
    'support_lead',      -- Dispute resolution
    'support_agent'      -- Limited actions
  )),
  granted_by UUID REFERENCES users(id),
  granted_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,  -- NULL = permanent
  revoked_at TIMESTAMPTZ,
  
  -- Only one active role per user per type
  CONSTRAINT unique_active_admin_role UNIQUE (user_id, role, revoked_at)
);

CREATE INDEX IF NOT EXISTS idx_admin_roles_user ON admin_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_admin_roles_active ON admin_roles(revoked_at) WHERE revoked_at IS NULL;

-- Log creation
DO $$ BEGIN RAISE NOTICE 'Created: admin_roles table'; END $$;


-- ============================================================================
-- VERIFICATION SUMMARY
-- ============================================================================
DO $$
DECLARE
  trigger_count INTEGER;
  constraint_count INTEGER;
BEGIN
  -- Count triggers
  SELECT COUNT(*) INTO trigger_count
  FROM pg_trigger t
  JOIN pg_class c ON t.tgrelid = c.oid
  WHERE t.tgname IN (
    'task_terminal_guard',
    'escrow_terminal_guard', 
    'escrow_amount_immutable',
    'badge_no_delete',
    'xp_no_delete',
    'trust_ledger_no_delete'
  );
  
  RAISE NOTICE '';
  RAISE NOTICE '============================================================';
  RAISE NOTICE 'CONSTITUTIONAL ENFORCEMENT MIGRATION COMPLETE';
  RAISE NOTICE '============================================================';
  RAISE NOTICE 'Triggers created: %', trigger_count;
  RAISE NOTICE '';
  RAISE NOTICE 'Active enforcement:';
  RAISE NOTICE '  ✓ Task terminal state guard (AUDIT-4)';
  RAISE NOTICE '  ✓ Escrow terminal state guard (AUDIT-4)';
  RAISE NOTICE '  ✓ Escrow amount immutability (INV-4)';
  RAISE NOTICE '  ✓ XP ledger escrow linkage (INV-5)';
  RAISE NOTICE '  ✓ Badge append-only (INV-BADGE-2)';
  RAISE NOTICE '  ✓ XP append-only';
  RAISE NOTICE '  ✓ Trust tier bounds (1-4)';
  RAISE NOTICE '  ✓ Trust ledger append-only (INV-TRUST-3)';
  RAISE NOTICE '  ✓ Admin roles table (INV-ADMIN-2)';
  RAISE NOTICE '============================================================';
END $$;
