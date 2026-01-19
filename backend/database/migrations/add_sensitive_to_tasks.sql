-- Migration: Add sensitive field to tasks table
-- Purpose: Sensitive tasks require higher trust tier (Tier ≥ 3) for Instant Mode

ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS sensitive BOOLEAN NOT NULL DEFAULT FALSE;

-- Index for filtering sensitive instant tasks
CREATE INDEX IF NOT EXISTS idx_tasks_sensitive_instant ON tasks(sensitive, instant_mode, state) WHERE instant_mode = TRUE;
