-- Forward convergence for databases that applied the initial HX/OS telemetry
-- migration before provider-namespaced lifecycle codes (for example
-- PAYMENT_INTENT.SUCCEEDED_RECEIVED) were admitted.

ALTER TABLE major_action_events
  DROP CONSTRAINT IF EXISTS major_action_events_previous_lifecycle_state_check,
  DROP CONSTRAINT IF EXISTS major_action_events_lifecycle_state_check;

ALTER TABLE major_action_events
  ADD CONSTRAINT major_action_events_previous_lifecycle_state_check
    CHECK (previous_lifecycle_state ~ '^[A-Z0-9:_.-]{2,100}$'),
  ADD CONSTRAINT major_action_events_lifecycle_state_check
    CHECK (lifecycle_state ~ '^[A-Z0-9:_.-]{2,100}$');
