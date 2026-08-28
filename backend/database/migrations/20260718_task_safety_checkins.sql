-- Durable timed safety check-ins for active task participants.
-- The browser never owns the deadline. A worker escalates missed deadlines into
-- one canonical urgent safety case without claiming external contact delivery.

CREATE TABLE IF NOT EXISTS task_safety_checkins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  participant_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes IN (15, 30, 60)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'confirmed', 'escalated')),
  idempotency_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  due_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ,
  escalated_at TIMESTAMPTZ,
  escalation_incident_id UUID REFERENCES task_safety_incidents(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (participant_user_id, idempotency_key),
  CHECK (due_at = started_at + make_interval(mins => duration_minutes)),
  CHECK (
    (status = 'active' AND confirmed_at IS NULL AND escalated_at IS NULL AND escalation_incident_id IS NULL)
    OR (status = 'confirmed' AND confirmed_at IS NOT NULL AND escalated_at IS NULL AND escalation_incident_id IS NULL)
    OR (status = 'escalated' AND confirmed_at IS NULL AND escalated_at IS NOT NULL AND escalation_incident_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS task_safety_checkins_one_active
  ON task_safety_checkins(task_id, participant_user_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS task_safety_checkins_due
  ON task_safety_checkins(due_at ASC)
  WHERE status = 'active';

ALTER TABLE task_safety_incidents
  ADD COLUMN IF NOT EXISTS source_checkin_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'task_safety_incidents_source_checkin_fk'
  ) THEN
    ALTER TABLE task_safety_incidents
      ADD CONSTRAINT task_safety_incidents_source_checkin_fk
      FOREIGN KEY (source_checkin_id) REFERENCES task_safety_checkins(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS task_safety_incidents_source_checkin_uniq
  ON task_safety_incidents(source_checkin_id)
  WHERE source_checkin_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_safety_checkin_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checkin_id UUID NOT NULL REFERENCES task_safety_checkins(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('started', 'confirmed', 'escalated')),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  public_message TEXT NOT NULL CHECK (char_length(public_message) BETWEEN 1 AND 500),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS task_safety_checkin_events_timeline
  ON task_safety_checkin_events(checkin_id, created_at ASC);

CREATE OR REPLACE FUNCTION enforce_task_safety_checkin_contract()
RETURNS TRIGGER AS $$
DECLARE
  task_row RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT state, poster_id, worker_id INTO task_row FROM tasks WHERE id = NEW.task_id;
    IF NOT FOUND OR (
      NEW.participant_user_id IS DISTINCT FROM task_row.poster_id
      AND NEW.participant_user_id IS DISTINCT FROM task_row.worker_id
    ) THEN
      RAISE EXCEPTION 'HX813: safety check-in participant is not assigned to this task' USING ERRCODE = 'HX813';
    END IF;
    IF task_row.state NOT IN ('ACCEPTED', 'PROOF_SUBMITTED', 'DISPUTED') THEN
      RAISE EXCEPTION 'HX814: safety check-in requires an active assigned task' USING ERRCODE = 'HX814';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.task_id IS DISTINCT FROM OLD.task_id
    OR NEW.participant_user_id IS DISTINCT FROM OLD.participant_user_id
    OR NEW.duration_minutes IS DISTINCT FROM OLD.duration_minutes
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.started_at IS DISTINCT FROM OLD.started_at
    OR NEW.due_at IS DISTINCT FROM OLD.due_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'HX815: safety check-in identity and deadline are immutable' USING ERRCODE = 'HX815';
  END IF;
  IF OLD.status <> 'active' OR NEW.status NOT IN ('confirmed', 'escalated') THEN
    RAISE EXCEPTION 'HX816: invalid safety check-in transition' USING ERRCODE = 'HX816';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS task_safety_checkin_contract ON task_safety_checkins;
CREATE TRIGGER task_safety_checkin_contract
  BEFORE INSERT OR UPDATE ON task_safety_checkins
  FOR EACH ROW EXECUTE FUNCTION enforce_task_safety_checkin_contract();

CREATE OR REPLACE FUNCTION prevent_task_safety_checkin_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'HX817: safety check-in events are append-only' USING ERRCODE = 'HX817';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS task_safety_checkin_events_no_update ON task_safety_checkin_events;
CREATE TRIGGER task_safety_checkin_events_no_update
  BEFORE UPDATE ON task_safety_checkin_events
  FOR EACH ROW EXECUTE FUNCTION prevent_task_safety_checkin_event_mutation();

DROP TRIGGER IF EXISTS task_safety_checkin_events_no_delete ON task_safety_checkin_events;
CREATE TRIGGER task_safety_checkin_events_no_delete
  BEFORE DELETE ON task_safety_checkin_events
  FOR EACH ROW EXECUTE FUNCTION prevent_task_safety_checkin_event_mutation();
