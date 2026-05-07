-- Migration 011: Claim Conversion + ETA
-- Adds estimated_arrival_minutes and estimated_arrival_at to tasks
-- so the poster can see live hustler ETA after a smart-dispatch claim.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS estimated_arrival_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS estimated_arrival_at TIMESTAMPTZ;

-- Index for the ETA recalculation query in GoModeService.updateLocation:
-- "find claimed smart-dispatch tasks for this worker"
CREATE INDEX IF NOT EXISTS idx_tasks_worker_dispatch_claimed
  ON tasks (worker_id, dispatch_state, fulfillment_mode)
  WHERE dispatch_state = 'claimed' AND fulfillment_mode = 'smart_dispatch';

INSERT INTO schema_versions (version, applied_at, applied_by, notes)
VALUES (
  '011',
  NOW(),
  'phase4-claim-conversion',
  'Add estimated_arrival_minutes / estimated_arrival_at to tasks for smart-dispatch ETA'
);
