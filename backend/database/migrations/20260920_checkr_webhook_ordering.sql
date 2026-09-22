-- Keep signed provider report events from replacing newer screening decisions.
-- Historical checks have no trustworthy event timestamp; leave them NULL and
-- let the first validated event establish the ordering point.
ALTER TABLE background_checks
  ADD COLUMN IF NOT EXISTS last_provider_event_id TEXT,
  ADD COLUMN IF NOT EXISTS last_provider_event_at TIMESTAMPTZ;
