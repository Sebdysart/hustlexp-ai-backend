-- Add surge_level column to tasks table for Instant Surge Incentives v1
-- Surge levels: 0 = no surge, 1 = visibility boost, 2 = XP boost, 3 = failed

ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS surge_level INTEGER NOT NULL DEFAULT 0
  CHECK (surge_level >= 0 AND surge_level <= 3);

CREATE INDEX IF NOT EXISTS idx_tasks_instant_surge ON tasks(instant_mode, state, surge_level, matched_at)
  WHERE instant_mode = TRUE AND state = 'MATCHING';
