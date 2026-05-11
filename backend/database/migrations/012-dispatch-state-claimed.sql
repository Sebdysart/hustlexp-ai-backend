-- Migration 012: Add 'claimed' to tasks and dispatch_events check constraints
--
-- confirmClaim sets dispatch_state = 'claimed' on tasks and inserts a dispatch_event
-- with event_type = 'claimed', but neither CHECK constraint included that value.
-- Migration 011 created an index WHERE dispatch_state = 'claimed' (proving intent)
-- but forgot to update both constraints — causing 500s on every Accept tap.

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_dispatch_state_check;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_dispatch_state_check
  CHECK (dispatch_state IN (
    'idle',
    'broadcasting',
    'wave_1',
    'wave_2',
    'wave_3',
    'soft_held',
    'fulfilled',
    'claimed',
    'expired'
  ));

ALTER TABLE dispatch_events DROP CONSTRAINT IF EXISTS dispatch_events_event_type_check;

ALTER TABLE dispatch_events
  ADD CONSTRAINT dispatch_events_event_type_check
  CHECK (event_type IN (
    'wave_started',
    'ping_sent',
    'ping_viewed',
    'ping_accepted',
    'ping_declined',
    'ping_expired',
    'soft_hold_acquired',
    'soft_hold_released',
    'task_fulfilled',
    'dispatch_expired',
    'claimed'
  ));

INSERT INTO schema_versions (version, applied_at, applied_by, notes)
VALUES (
  '012',
  NOW(),
  'phase4-dispatch-state-fix',
  'Add claimed to tasks_dispatch_state_check — confirmClaim was violating the constraint'
);
