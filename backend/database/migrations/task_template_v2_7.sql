-- backend/database/migrations/task_template_v2_7.sql
-- AI Task Template System v2.7
-- Adds: flagged_phrase_counter on users (cross-task coded phrase detection)
--       prorate_on_abort + challenge_window_hours on tasks (partial payout support)

BEGIN;

-- ============================================================
-- 1. Users: cross-task flagged phrase counter
-- ============================================================
-- Stores array of { phrase: string, matched_at: ISO timestamp }
-- Max 20 entries, entries older than 30 days pruned on-write by GuardianService
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS flagged_phrase_counter JSONB DEFAULT '[]'::jsonb;

-- ============================================================
-- 2. Tasks: partial payout columns
-- ============================================================
-- prorate_on_abort: when true, completed legs paid pro-rata if Hustler aborts
-- challenge_window_hours: Poster has this many hours to dispute before funds release
--   Default 6 (same-day tasks). Poster can opt-in to 24 for high-value tasks.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS prorate_on_abort BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS challenge_window_hours INTEGER DEFAULT 6
    CHECK (challenge_window_hours IN (6, 24));

-- Index for escrow release cron queries
CREATE INDEX IF NOT EXISTS idx_tasks_prorate_on_abort
  ON tasks(prorate_on_abort, challenge_window_hours)
  WHERE prorate_on_abort = TRUE;

COMMIT;
