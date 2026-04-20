-- ============================================================
-- Migration: Idempotent Spawning + Rolling Generation
--
-- 1. Add 'spawning' transient state to occurrence status CHECK
-- 2. Add scheduled_for column (TIMESTAMPTZ) for precise scheduling
-- 3. Update index for SKIP LOCKED queries
--
-- Idempotent: safe to re-run.
-- ============================================================

-- 1. Drop and re-add the CHECK constraint to include 'spawning'
--    'spawning' is a transient lock state: scheduled → spawning → posted/failed
ALTER TABLE recurring_task_occurrences
  DROP CONSTRAINT IF EXISTS recurring_task_occurrences_status_check;

ALTER TABLE recurring_task_occurrences
  ADD CONSTRAINT recurring_task_occurrences_status_check
  CHECK (status IN ('scheduled', 'spawning', 'posted', 'in_progress', 'completed', 'skipped', 'cancelled'));

-- 2. Add scheduled_for (precise TIMESTAMPTZ) alongside scheduled_date (DATE)
--    Used by rolling generation for time-of-day aware scheduling
ALTER TABLE recurring_task_occurrences
  ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ;

-- Backfill: set scheduled_for from scheduled_date at noon UTC where missing
UPDATE recurring_task_occurrences
  SET scheduled_for = (scheduled_date::TEXT || 'T12:00:00Z')::TIMESTAMPTZ
  WHERE scheduled_for IS NULL;

-- 3. Optimized index for the SKIP LOCKED spawn query
--    Replaces the old partial index with one that includes the columns the query needs
DROP INDEX IF EXISTS idx_recurring_occ_scheduled_pending;
CREATE INDEX IF NOT EXISTS idx_recurring_occ_spawn_candidates
  ON recurring_task_occurrences(scheduled_date, status)
  WHERE status IN ('scheduled');

-- ============================================================
-- DONE
-- ============================================================
