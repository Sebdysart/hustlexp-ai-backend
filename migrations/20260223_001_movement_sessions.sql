--
-- Movement Tracking Sessions Table
-- Tracks worker GPS trail during task execution
--

CREATE TABLE IF NOT EXISTS movement_sessions (
  id TEXT PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')),
  gps_trail JSONB NOT NULL DEFAULT '[]',
  total_distance DOUBLE PRECISION NOT NULL DEFAULT 0,
  average_speed DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS movement_sessions_task_idx ON movement_sessions(task_id);
CREATE INDEX IF NOT EXISTS movement_sessions_user_idx ON movement_sessions(user_id);
CREATE INDEX IF NOT EXISTS movement_sessions_status_idx ON movement_sessions(status);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_movement_sessions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER movement_sessions_updated_at
BEFORE UPDATE ON movement_sessions
FOR EACH ROW
EXECUTE FUNCTION update_movement_sessions_updated_at();
