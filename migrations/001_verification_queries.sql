-- ============================================================================
-- HUSTLEXP VERIFICATION QUERIES
-- ============================================================================
-- Run these AFTER applying 001_constitutional_enforcement.sql
-- ALL queries should return 0 rows or expected values
-- If any return unexpected results, STOP and investigate
-- ============================================================================

-- ============================================================================
-- 1. VERIFY TRIGGERS EXIST
-- ============================================================================
-- Expected: 6 rows

SELECT 
  t.tgname as trigger_name,
  c.relname as table_name,
  CASE WHEN t.tgenabled = 'O' THEN 'ENABLED' ELSE 'DISABLED' END as status
FROM pg_trigger t
JOIN pg_class c ON t.tgrelid = c.oid
WHERE t.tgname IN (
  'task_terminal_guard',
  'escrow_terminal_guard', 
  'escrow_amount_immutable',
  'badge_no_delete',
  'xp_no_delete',
  'trust_ledger_no_delete'
)
ORDER BY c.relname, t.tgname;

-- ============================================================================
-- 2. VERIFY CONSTRAINTS EXIST
-- ============================================================================
-- Expected: trust_tier_bounds, xp_events_escrow_id_unique

SELECT 
  conname as constraint_name,
  conrelid::regclass as table_name,
  contype as type
FROM pg_constraint
WHERE conname IN (
  'trust_tier_bounds',
  'xp_events_escrow_id_unique'
);

-- ============================================================================
-- 3. TEST: TASK TERMINAL MUTATION BLOCKED
-- ============================================================================
-- This should FAIL with: INV-TERMINAL: Cannot modify task in terminal state
-- Uncomment to test, then rollback

-- BEGIN;
-- UPDATE tasks SET title = 'HACKED' WHERE status = 'completed' LIMIT 1;
-- ROLLBACK;

-- ============================================================================
-- 4. TEST: ESCROW TERMINAL MUTATION BLOCKED  
-- ============================================================================
-- This should FAIL with: INV-TERMINAL: Cannot modify escrow in terminal state
-- Uncomment to test, then rollback

-- BEGIN;
-- UPDATE escrow_holds SET status = 'held' WHERE status = 'released' LIMIT 1;
-- ROLLBACK;

-- ============================================================================
-- 5. TEST: ESCROW AMOUNT IMMUTABILITY
-- ============================================================================
-- This should FAIL with: INV-4: Escrow amount is immutable
-- Uncomment to test, then rollback

-- BEGIN;
-- UPDATE escrow_holds SET gross_amount_cents = 999999 WHERE id = (SELECT id FROM escrow_holds LIMIT 1);
-- ROLLBACK;

-- ============================================================================
-- 6. TEST: BADGE DELETE BLOCKED
-- ============================================================================
-- This should FAIL with: INV-BADGE-2: Badge ledger is append-only
-- Uncomment to test, then rollback

-- BEGIN;
-- DELETE FROM badges WHERE id = (SELECT id FROM badges LIMIT 1);
-- ROLLBACK;

-- ============================================================================
-- 7. TEST: XP DELETE BLOCKED
-- ============================================================================
-- This should FAIL with: INV-XP: XP ledger is append-only
-- Uncomment to test, then rollback

-- BEGIN;
-- DELETE FROM xp_events WHERE id = (SELECT id FROM xp_events LIMIT 1);
-- ROLLBACK;

-- ============================================================================
-- 8. VERIFY: NEW COLUMNS EXIST
-- ============================================================================
-- Expected: escrow_id in xp_events, trust_tier in users

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'xp_events' AND column_name = 'escrow_id'
UNION ALL
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'users' AND column_name = 'trust_tier';

-- ============================================================================
-- 9. VERIFY: NEW TABLES EXIST
-- ============================================================================
-- Expected: trust_ledger, admin_roles

SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('trust_ledger', 'admin_roles');

-- ============================================================================
-- 10. INVARIANT CHECK: XP WITHOUT RELEASED ESCROW
-- ============================================================================
-- Expected: 0 rows (no XP should exist for unreleased escrows)
-- NOTE: Run this AFTER backfill migration

SELECT 
  xp.id as xp_event_id,
  xp.escrow_id,
  xp.amount,
  xp.reason,
  e.status as escrow_status
FROM xp_events xp
LEFT JOIN escrow_holds e ON e.id = xp.escrow_id
WHERE xp.escrow_id IS NOT NULL
  AND (e.status IS NULL OR e.status != 'released');

-- ============================================================================
-- 11. INVARIANT CHECK: TRUST TIERS IN BOUNDS
-- ============================================================================
-- Expected: 0 rows (no users with invalid trust tier)

SELECT id, email, trust_tier
FROM users
WHERE trust_tier IS NOT NULL
  AND (trust_tier < 1 OR trust_tier > 4);

-- ============================================================================
-- 12. COUNT ENFORCEMENT COVERAGE
-- ============================================================================

SELECT 
  'Tasks in terminal state' as category,
  COUNT(*) as count
FROM tasks
WHERE status IN ('completed', 'cancelled', 'expired')

UNION ALL

SELECT 
  'Escrows in terminal state' as category,
  COUNT(*) as count
FROM escrow_holds
WHERE status IN ('released', 'refunded')

UNION ALL

SELECT 
  'Total XP events' as category,
  COUNT(*) as count
FROM xp_events

UNION ALL

SELECT 
  'Total badges' as category,
  COUNT(*) as count
FROM badges;

-- ============================================================================
-- SUMMARY: RUN THIS LAST
-- ============================================================================

DO $$
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '============================================================';
  RAISE NOTICE 'VERIFICATION COMPLETE';
  RAISE NOTICE '============================================================';
  RAISE NOTICE 'If all queries returned expected results:';
  RAISE NOTICE '  ✓ Constitutional enforcement is ACTIVE';
  RAISE NOTICE '  ✓ Safe to proceed to Phase 0.2B';
  RAISE NOTICE '';
  RAISE NOTICE 'If any queries returned unexpected results:';
  RAISE NOTICE '  ✗ STOP and investigate before proceeding';
  RAISE NOTICE '  ✗ Check trigger creation errors';
  RAISE NOTICE '  ✗ Check for pre-existing constraint conflicts';
  RAISE NOTICE '============================================================';
END $$;
