-- Task-specific, human-accountable safety cases.
-- Canonical case data stays in the marketplace engine; incident_events receives
-- a privacy-minimized Operations mirror in the same transaction.

CREATE TABLE IF NOT EXISTS task_safety_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  reporter_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  category TEXT NOT NULL CHECK (category IN (
    'injury', 'threat', 'property_damage', 'identity_theft', 'fraud',
    'chargeback', 'legal_request', 'licensing_ambiguity',
    'high_value_compensation', 'vulnerable_person_safety', 'other'
  )),
  urgency TEXT NOT NULL CHECK (urgency IN ('standard', 'high', 'urgent')),
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 10 AND 2000),
  location_sharing_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  contact_permission TEXT NOT NULL CHECK (contact_permission IN (
    'call', 'text', 'in_app_only', 'do_not_contact'
  )),
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN (
    'received', 'acknowledged', 'assigned', 'resolved', 'closed'
  )),
  delivery_state TEXT NOT NULL DEFAULT 'received' CHECK (delivery_state IN (
    'received', 'acknowledged', 'contact_attempted', 'contact_delivered', 'contact_failed'
  )),
  assigned_admin_id UUID REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key UUID NOT NULL,
  acknowledged_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (reporter_user_id, idempotency_key),
  CHECK (status = 'received' OR acknowledged_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_task_safety_incidents_task_reporter
  ON task_safety_incidents(task_id, reporter_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_safety_incidents_ops_queue
  ON task_safety_incidents(urgency, created_at ASC)
  WHERE status NOT IN ('resolved', 'closed');

CREATE TABLE IF NOT EXISTS task_safety_incident_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES task_safety_incidents(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'received', 'acknowledged', 'assigned', 'contact_attempted',
    'contact_delivered', 'contact_failed', 'resolved', 'closed'
  )),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  public_message TEXT NOT NULL CHECK (char_length(public_message) BETWEEN 1 AND 500),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_safety_incident_events_case
  ON task_safety_incident_events(incident_id, created_at ASC);

CREATE OR REPLACE FUNCTION prevent_task_safety_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'HX812: task safety incident events are append-only'
    USING ERRCODE = 'HX812';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS task_safety_events_no_update ON task_safety_incident_events;
CREATE TRIGGER task_safety_events_no_update
  BEFORE UPDATE ON task_safety_incident_events
  FOR EACH ROW EXECUTE FUNCTION prevent_task_safety_event_mutation();

DROP TRIGGER IF EXISTS task_safety_events_no_delete ON task_safety_incident_events;
CREATE TRIGGER task_safety_events_no_delete
  BEFORE DELETE ON task_safety_incident_events
  FOR EACH ROW EXECUTE FUNCTION prevent_task_safety_event_mutation();
