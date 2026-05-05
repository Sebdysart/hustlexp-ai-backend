-- Migration: add_task_bookmarks
-- Adds a task_bookmarks table so hustlers can save tasks for later

CREATE TABLE IF NOT EXISTS task_bookmarks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id     UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_task_bookmarks_user_id ON task_bookmarks(user_id);
CREATE INDEX IF NOT EXISTS idx_task_bookmarks_task_id ON task_bookmarks(task_id);
