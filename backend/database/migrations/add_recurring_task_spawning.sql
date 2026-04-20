-- ============================================================
-- Migration: Recurring Task Spawning Enhancements
-- Adds columns needed by the recurring-task spawner job:
--   - Series: risk_level, template_slug, requires_proof, requirements
--   - Occurrences: escrow_id (FK), spawn_error, spawned_at
--   - Performance indexes for the scheduler query and series lookup
--
-- Idempotent: safe to re-run (ADD COLUMN IF NOT EXISTS + IF NOT EXISTS).
-- ============================================================

-- ------------------------------------------------------------
-- 1. recurring_task_series — new columns
-- ------------------------------------------------------------
ALTER TABLE recurring_task_series
    ADD COLUMN IF NOT EXISTS risk_level VARCHAR(10) NOT NULL DEFAULT 'LOW'
        CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH'));

ALTER TABLE recurring_task_series
    ADD COLUMN IF NOT EXISTS template_slug VARCHAR(50);

ALTER TABLE recurring_task_series
    ADD COLUMN IF NOT EXISTS requires_proof BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE recurring_task_series
    ADD COLUMN IF NOT EXISTS requirements TEXT;

-- ------------------------------------------------------------
-- 2. recurring_task_occurrences — new columns
-- ------------------------------------------------------------
ALTER TABLE recurring_task_occurrences
    ADD COLUMN IF NOT EXISTS escrow_id UUID REFERENCES escrows(id) ON DELETE SET NULL;

ALTER TABLE recurring_task_occurrences
    ADD COLUMN IF NOT EXISTS spawn_error TEXT;

ALTER TABLE recurring_task_occurrences
    ADD COLUMN IF NOT EXISTS spawned_at TIMESTAMPTZ;

-- ------------------------------------------------------------
-- 3. Indexes for the spawner scheduler query
-- ------------------------------------------------------------

-- Fast lookup of occurrences the spawner still needs to process
CREATE INDEX IF NOT EXISTS idx_recurring_occ_scheduled_pending
    ON recurring_task_occurrences(scheduled_date, status)
    WHERE status = 'scheduled';

-- Fast lookup of spawned tasks by their parent series + state
CREATE INDEX IF NOT EXISTS idx_tasks_series_state
    ON tasks(parent_series_id, state)
    WHERE parent_series_id IS NOT NULL;

-- ============================================================
-- DONE
-- ============================================================
