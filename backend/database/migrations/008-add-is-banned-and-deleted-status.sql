-- ============================================================================
-- Migration 008: Add missing users columns + fix constraints
-- ============================================================================
-- Fixes three bugs that cause user.register to fail with 500:
--
-- 1. is_banned column missing → "column is_banned does not exist"
-- 2. date_of_birth / is_minor columns missing → INSERT fails
-- 3. trust_tier CHECK (>= 1) rejects trust_tier=0 for phone-less new users
--
-- Also expands account_status CHECK to include 'DELETED' for GDPR erasure.
--
-- All statements are idempotent — safe to run multiple times.
-- ============================================================================

-- 1. Add is_banned column
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'is_banned'
  ) THEN
    ALTER TABLE users ADD COLUMN is_banned BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;
END $$;

-- 2. Add date_of_birth column (COPPA compliance)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'date_of_birth'
  ) THEN
    ALTER TABLE users ADD COLUMN date_of_birth DATE;
  END IF;
END $$;

-- 3. Add is_minor column (COPPA compliance)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'is_minor'
  ) THEN
    ALTER TABLE users ADD COLUMN is_minor BOOLEAN DEFAULT FALSE;
  END IF;
END $$;

-- 4. Fix trust_tier CHECK to allow 0 (phone-less new users start at 0)
DO $$ BEGIN
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_trust_tier_check;
  ALTER TABLE users ADD CONSTRAINT users_trust_tier_check
    CHECK (trust_tier >= 0 AND trust_tier <= 4);
EXCEPTION WHEN others THEN
  NULL; -- ignore if constraint name differs
END $$;

-- 5. Expand account_status CHECK to include 'DELETED'
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints cc
    JOIN information_schema.constraint_column_usage cu
      ON cc.constraint_name = cu.constraint_name
    WHERE cu.table_name = 'users'
      AND cu.column_name = 'account_status'
      AND cc.check_clause LIKE '%DELETED%'
  ) THEN
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_account_status_check;
    ALTER TABLE users ADD CONSTRAINT users_account_status_check
      CHECK (account_status IN ('ACTIVE', 'PAUSED', 'SUSPENDED', 'DELETED'));
  END IF;
END $$;

-- 6. Indexes
CREATE INDEX IF NOT EXISTS idx_users_is_banned ON users(is_banned) WHERE is_banned = TRUE;
