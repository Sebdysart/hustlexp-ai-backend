-- ============================================================================
-- HUSTLEXP ROLLBACK SCRIPT
-- ============================================================================
-- Use this ONLY if you need to revert 001_constitutional_enforcement.sql
-- This removes all triggers and constraints added by that migration
-- WARNING: This removes constitutional protection. Use with extreme caution.
-- ============================================================================

-- Remove triggers
DROP TRIGGER IF EXISTS task_terminal_guard ON tasks;
DROP TRIGGER IF EXISTS escrow_terminal_guard ON escrow_holds;
DROP TRIGGER IF EXISTS escrow_amount_immutable ON escrow_holds;
DROP TRIGGER IF EXISTS badge_no_delete ON badges;
DROP TRIGGER IF EXISTS xp_no_delete ON xp_events;
DROP TRIGGER IF EXISTS trust_ledger_no_delete ON trust_ledger;

-- Remove functions
DROP FUNCTION IF EXISTS prevent_task_terminal_mutation();
DROP FUNCTION IF EXISTS prevent_escrow_terminal_mutation();
DROP FUNCTION IF EXISTS prevent_escrow_amount_change();
DROP FUNCTION IF EXISTS prevent_badge_delete();
DROP FUNCTION IF EXISTS prevent_xp_delete();
DROP FUNCTION IF EXISTS prevent_trust_ledger_delete();

-- Remove constraints (be careful - these may have data)
ALTER TABLE xp_events DROP CONSTRAINT IF EXISTS xp_events_escrow_id_unique;
ALTER TABLE users DROP CONSTRAINT IF EXISTS trust_tier_bounds;

-- Remove indexes
DROP INDEX IF EXISTS idx_xp_events_escrow;
DROP INDEX IF EXISTS idx_trust_ledger_user;
DROP INDEX IF EXISTS idx_trust_ledger_created;
DROP INDEX IF EXISTS idx_admin_roles_user;
DROP INDEX IF EXISTS idx_admin_roles_active;

-- DO NOT drop columns or tables - they may contain data
-- If you need to remove them, do so manually after verification

DO $$
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '============================================================';
  RAISE NOTICE 'ROLLBACK COMPLETE';
  RAISE NOTICE '============================================================';
  RAISE NOTICE 'Constitutional enforcement has been REMOVED.';
  RAISE NOTICE '';
  RAISE NOTICE 'WARNING: The following protections are now DISABLED:';
  RAISE NOTICE '  ✗ Task terminal state protection';
  RAISE NOTICE '  ✗ Escrow terminal state protection';
  RAISE NOTICE '  ✗ Escrow amount immutability';
  RAISE NOTICE '  ✗ Badge append-only enforcement';
  RAISE NOTICE '  ✗ XP append-only enforcement';
  RAISE NOTICE '  ✗ Trust ledger append-only enforcement';
  RAISE NOTICE '';
  RAISE NOTICE 'Re-run 001_constitutional_enforcement.sql to restore.';
  RAISE NOTICE '============================================================';
END $$;
