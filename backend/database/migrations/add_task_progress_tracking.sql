-- Migration: Add task progress tracking (Pillar A - Realtime Tracking)
-- Adds progress_state, progress_updated_at, progress_by to tasks table
-- 
-- Purpose: Enable "Hustler on the way" realtime tracking
-- Authoritative: task.progress_state is the source of truth
-- Behavior: Enforced in TaskService.advanceProgress (no DB triggers)

BEGIN;

-- Add progress_state column with CHECK constraint
ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS progress_state VARCHAR(20) NOT NULL DEFAULT 'POSTED'
  CHECK (progress_state IN (
    'POSTED',
    'ACCEPTED',
    'TRAVELING',
    'WORKING',
    'COMPLETED',
    'CLOSED'
  ));

-- Add progress_updated_at timestamp
ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS progress_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Add progress_by (references users, nullable - can be system-initiated)
ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS progress_by UUID REFERENCES users(id);

-- Add index for progress_state queries (useful for "find tasks in progress")
CREATE INDEX IF NOT EXISTS idx_tasks_progress_state ON tasks(progress_state);

COMMIT;
