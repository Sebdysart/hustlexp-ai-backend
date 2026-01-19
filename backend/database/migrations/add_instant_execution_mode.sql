-- Instant Execution Mode Migration
-- Adds instant_mode flag and MATCHING state to tasks table

-- Add instant_mode column
ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS instant_mode BOOLEAN NOT NULL DEFAULT FALSE;

-- Add MATCHING state to state CHECK constraint
-- Note: This requires dropping and recreating the constraint
ALTER TABLE tasks
DROP CONSTRAINT IF EXISTS tasks_state_check;

ALTER TABLE tasks
ADD CONSTRAINT tasks_state_check
CHECK (state IN (
    'OPEN',           -- Visible, accepting applications
    'MATCHING',       -- Instant mode: searching for hustler
    'ACCEPTED',       -- Worker assigned, work in progress
    'PROOF_SUBMITTED',-- Awaiting poster review
    'DISPUTED',       -- Under admin review
    'COMPLETED',      -- TERMINAL: Successfully finished
    'CANCELLED',      -- TERMINAL: Terminated by poster/admin
    'EXPIRED'         -- TERMINAL: Time limit exceeded
));

-- Add constraint: instant tasks cannot re-enter OPEN state
-- (Once in MATCHING or beyond, cannot go back to OPEN)
ALTER TABLE tasks
ADD CONSTRAINT tasks_instant_mode_check
CHECK (
    (instant_mode = FALSE) OR
    (instant_mode = TRUE AND state != 'OPEN')
);

-- Add index for matching queries (instant tasks in MATCHING state)
CREATE INDEX IF NOT EXISTS idx_tasks_instant_matching
ON tasks(instant_mode, state)
WHERE instant_mode = TRUE AND state = 'MATCHING';

-- Add index for eligibility checks (online hustlers, location, trust tier)
-- Note: This assumes we'll query by location and trust requirements
CREATE INDEX IF NOT EXISTS idx_tasks_instant_eligible
ON tasks(instant_mode, state, location, created_at)
WHERE instant_mode = TRUE AND state = 'MATCHING';
