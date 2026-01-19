-- Add matched_at column for Instant Execution Mode time tracking
ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS matched_at TIMESTAMPTZ;
