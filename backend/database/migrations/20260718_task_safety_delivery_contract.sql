-- Payload-bound safety intake replay and orthogonal contact-delivery evidence.

ALTER TABLE task_safety_incidents
  ADD COLUMN IF NOT EXISTS request_hash CHAR(64);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'task_safety_incidents_request_hash_ck'
  ) THEN
    ALTER TABLE task_safety_incidents ADD CONSTRAINT task_safety_incidents_request_hash_ck CHECK (
      request_hash IS NULL OR request_hash ~ '^[a-f0-9]{64}$'
    );
  END IF;
END
$$;

-- Human acknowledgment is case status, not transport delivery. Preserve the
-- distinction for rows created before this contract.
UPDATE task_safety_incidents
SET delivery_state = 'received'
WHERE delivery_state = 'acknowledged';

ALTER TABLE task_safety_incident_events
  ADD COLUMN IF NOT EXISTS provider_event_id TEXT,
  ADD COLUMN IF NOT EXISTS contact_channel TEXT,
  ADD COLUMN IF NOT EXISTS request_hash CHAR(64);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'task_safety_contact_event_fields_ck'
  ) THEN
    ALTER TABLE task_safety_incident_events ADD CONSTRAINT task_safety_contact_event_fields_ck CHECK (
      (
        event_type IN ('contact_attempted', 'contact_delivered', 'contact_failed')
        AND provider_event_id IS NOT NULL
        AND provider_event_id ~ '^[A-Za-z0-9:_-]{8,255}$'
        AND contact_channel IN ('call', 'text')
        AND request_hash ~ '^[a-f0-9]{64}$'
      )
      OR (
        event_type NOT IN ('contact_attempted', 'contact_delivered', 'contact_failed')
        AND provider_event_id IS NULL
        AND contact_channel IS NULL
        AND request_hash IS NULL
      )
    );
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS task_safety_provider_event_uniq
  ON task_safety_incident_events(provider_event_id)
  WHERE provider_event_id IS NOT NULL;
