-- Canonical safety-case lifecycle and provider-delivery evidence.
-- Receipt, contact delivery, and human acknowledgment are independent facts.

ALTER TABLE task_safety_incidents
  ADD COLUMN IF NOT EXISTS delivery_event_id UUID;

-- Earlier schemas allowed human acknowledgment to leak into the transport field.
-- Preserve acknowledgment in status/acknowledged_at and normalize only transport.
UPDATE task_safety_incidents
SET delivery_state = 'received', delivery_event_id = NULL, updated_at = NOW()
WHERE delivery_state = 'acknowledged';

-- Preserve historical provider evidence where it exists. A contact-looking state
-- without an append-only matching event is not evidence and returns to received.
UPDATE task_safety_incidents incident
SET delivery_event_id = (
  SELECT event.id
  FROM task_safety_incident_events event
  WHERE event.incident_id = incident.id
    AND event.event_type = incident.delivery_state
    AND event.contact_channel = incident.contact_permission
    AND event.provider_event_id IS NOT NULL
    AND event.request_hash IS NOT NULL
  ORDER BY event.created_at DESC, event.id DESC
  LIMIT 1
)
WHERE incident.delivery_state IN ('contact_attempted', 'contact_delivered', 'contact_failed');

UPDATE task_safety_incidents
SET delivery_state = 'received', delivery_event_id = NULL, updated_at = NOW()
WHERE delivery_state IN ('contact_attempted', 'contact_delivered', 'contact_failed')
  AND delivery_event_id IS NULL;

-- A legacy acknowledged timestamp is stronger evidence than a stale received label.
UPDATE task_safety_incidents
SET status = 'acknowledged', updated_at = NOW()
WHERE status = 'received' AND acknowledged_at IS NOT NULL;

UPDATE task_safety_incidents
SET resolved_at = COALESCE(resolved_at, acknowledged_at, updated_at, created_at),
    updated_at = NOW()
WHERE status IN ('resolved', 'closed') AND resolved_at IS NULL;

ALTER TABLE task_safety_incidents
  DROP CONSTRAINT IF EXISTS task_safety_incidents_delivery_state_check,
  DROP CONSTRAINT IF EXISTS task_safety_incidents_check,
  DROP CONSTRAINT IF EXISTS task_safety_incident_delivery_event_fk,
  DROP CONSTRAINT IF EXISTS task_safety_incident_status_truth_ck,
  DROP CONSTRAINT IF EXISTS task_safety_incident_delivery_truth_ck;

ALTER TABLE task_safety_incidents
  ADD CONSTRAINT task_safety_incident_delivery_event_fk
    FOREIGN KEY (delivery_event_id)
    REFERENCES task_safety_incident_events(id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT task_safety_incident_status_truth_ck CHECK (
    (status = 'received' AND acknowledged_at IS NULL)
    OR (
      status IN ('acknowledged', 'assigned')
      AND acknowledged_at IS NOT NULL
    )
    OR (
      status IN ('resolved', 'closed')
      AND acknowledged_at IS NOT NULL
      AND resolved_at IS NOT NULL
    )
  ),
  ADD CONSTRAINT task_safety_incident_delivery_truth_ck CHECK (
    (delivery_state = 'received' AND delivery_event_id IS NULL)
    OR (
      delivery_state IN ('contact_attempted', 'contact_delivered', 'contact_failed')
      AND delivery_event_id IS NOT NULL
      AND contact_permission IN ('call', 'text')
    )
  );

CREATE OR REPLACE FUNCTION enforce_task_safety_incident_state_integrity()
RETURNS TRIGGER AS $$
DECLARE
  task_row RECORD;
  delivery_event RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT poster_id, worker_id INTO task_row FROM tasks WHERE id = NEW.task_id;
    IF NOT FOUND OR (
      NEW.reporter_user_id IS DISTINCT FROM task_row.poster_id
      AND NEW.reporter_user_id IS DISTINCT FROM task_row.worker_id
    ) THEN
      RAISE EXCEPTION 'HX819: safety incident reporter is not assigned to this task'
        USING ERRCODE = 'HX819';
    END IF;
    IF NEW.status <> 'received'
      OR NEW.acknowledged_at IS NOT NULL
      OR NEW.resolved_at IS NOT NULL
      OR NEW.delivery_state <> 'received'
      OR NEW.delivery_event_id IS NOT NULL THEN
      RAISE EXCEPTION 'HX820: new safety incidents must begin received and unacknowledged'
        USING ERRCODE = 'HX820';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.task_id IS DISTINCT FROM OLD.task_id
    OR NEW.reporter_user_id IS DISTINCT FROM OLD.reporter_user_id
    OR NEW.category IS DISTINCT FROM OLD.category
    OR NEW.urgency IS DISTINCT FROM OLD.urgency
    OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.location_sharing_enabled IS DISTINCT FROM OLD.location_sharing_enabled
    OR NEW.contact_permission IS DISTINCT FROM OLD.contact_permission
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.source_checkin_id IS DISTINCT FROM OLD.source_checkin_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'HX821: safety incident identity, consent, and report facts are immutable'
      USING ERRCODE = 'HX821';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'received' AND NEW.status = 'acknowledged')
      OR (OLD.status = 'acknowledged' AND NEW.status IN ('assigned', 'resolved', 'closed'))
      OR (OLD.status = 'assigned' AND NEW.status IN ('resolved', 'closed'))
      OR (OLD.status = 'resolved' AND NEW.status = 'closed')
    ) THEN
      RAISE EXCEPTION 'HX822: invalid safety incident status transition % -> %', OLD.status, NEW.status
        USING ERRCODE = 'HX822';
    END IF;
  END IF;

  IF NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at AND NOT (
    OLD.status = 'received'
    AND NEW.status = 'acknowledged'
    AND OLD.acknowledged_at IS NULL
    AND NEW.acknowledged_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'HX823: safety acknowledgment time can be recorded only on first acknowledgment'
      USING ERRCODE = 'HX823';
  END IF;

  IF NEW.resolved_at IS DISTINCT FROM OLD.resolved_at AND NOT (
    NEW.status IN ('resolved', 'closed')
    AND OLD.resolved_at IS NULL
    AND NEW.resolved_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'HX824: safety resolution time can be recorded only on terminal resolution'
      USING ERRCODE = 'HX824';
  END IF;

  IF NEW.delivery_state IS DISTINCT FROM OLD.delivery_state
    OR NEW.delivery_event_id IS DISTINCT FROM OLD.delivery_event_id THEN
    IF NEW.delivery_state IS NOT DISTINCT FROM OLD.delivery_state
      OR NEW.delivery_event_id IS NOT DISTINCT FROM OLD.delivery_event_id
      OR NOT (
        (OLD.delivery_state = 'received' AND NEW.delivery_state = 'contact_attempted')
        OR (OLD.delivery_state = 'contact_attempted' AND NEW.delivery_state IN ('contact_delivered', 'contact_failed'))
        OR (OLD.delivery_state = 'contact_failed' AND NEW.delivery_state IN ('contact_attempted', 'contact_delivered'))
      ) THEN
      RAISE EXCEPTION 'HX825: invalid safety contact-delivery transition % -> %', OLD.delivery_state, NEW.delivery_state
        USING ERRCODE = 'HX825';
    END IF;

    SELECT incident_id, event_type, contact_channel, provider_event_id, request_hash
      INTO delivery_event
      FROM task_safety_incident_events
     WHERE id = NEW.delivery_event_id;
    IF NOT FOUND
      OR delivery_event.incident_id IS DISTINCT FROM NEW.id
      OR delivery_event.event_type IS DISTINCT FROM NEW.delivery_state
      OR delivery_event.contact_channel IS DISTINCT FROM NEW.contact_permission
      OR delivery_event.provider_event_id IS NULL
      OR delivery_event.request_hash IS NULL THEN
      RAISE EXCEPTION 'HX826: delivery state lacks matching append-only provider evidence'
        USING ERRCODE = 'HX826';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS task_safety_incident_state_integrity ON task_safety_incidents;
CREATE TRIGGER task_safety_incident_state_integrity
  BEFORE INSERT OR UPDATE ON task_safety_incidents
  FOR EACH ROW EXECUTE FUNCTION enforce_task_safety_incident_state_integrity();
