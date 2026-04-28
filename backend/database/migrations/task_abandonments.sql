-- Task abandonments tracking
-- Records when a hustler abandons (cancels) their accepted task before completing it.
-- Used for worker reputation tracking and to surface repeated abandoners for moderation.

CREATE TABLE IF NOT EXISTS task_abandonments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  worker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT,
  abandoned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A worker can only abandon a specific task once (re-acceptance creates a new attempt)
  UNIQUE(task_id, worker_id, abandoned_at)
);

CREATE INDEX IF NOT EXISTS idx_task_abandonments_worker ON task_abandonments(worker_id);
CREATE INDEX IF NOT EXISTS idx_task_abandonments_task ON task_abandonments(task_id);
