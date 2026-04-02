-- ============================================================================
-- Migration 008: Add is_banned column and DELETED account_status
-- ============================================================================
-- The backend code references users.is_banned in ~15 places (trpc.ts, admin.ts,
-- user.ts, realtime-dispatcher.ts, PushNotificationService.ts) but the column
-- was never added to the schema. Without it, user.register and every ban check
-- throws "column is_banned does not exist".
--
-- Also expands account_status CHECK to include 'DELETED' which is used by
-- the GDPR erasure flow and trpc.ts middleware but was absent from the constraint.
--
-- All statements are idempotent.
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

-- 2. Expand account_status CHECK constraint to include 'DELETED'
--    Drop the old constraint and recreate it with the full value set.
DO $$ BEGIN
  -- Only alter if 'DELETED' is not already in the constraint
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

-- 3. Index on is_banned for fast ban-evasion lookups in user.register
CREATE INDEX IF NOT EXISTS idx_users_is_banned ON users(is_banned) WHERE is_banned = TRUE;
