-- Canonical, owner-attributable safety resolution.
-- A generic Operations mirror is never authoritative for closing a task safety case.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'task_safety_resolution_event_fields_ck'
  ) THEN
    ALTER TABLE task_safety_incident_events
      ADD CONSTRAINT task_safety_resolution_event_fields_ck CHECK (
        event_type <> 'resolved'
        OR (
          actor_user_id IS NOT NULL
          AND metadata->>'resolution_code' IS NOT NULL
          AND metadata->>'resolution_code' IN (
            'safety_plan_confirmed',
            'emergency_services_referred',
            'fraud_or_payment_referred',
            'legal_or_licensing_referred',
            'compensation_referred',
            'unable_to_confirm'
          )
          AND metadata->>'idempotency_key' IS NOT NULL
          AND metadata->>'idempotency_key' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          AND metadata->>'request_hash' IS NOT NULL
          AND metadata->>'request_hash' ~ '^[a-f0-9]{64}$'
        )
      ) NOT VALID;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION enforce_task_safety_resolution_integrity()
RETURNS TRIGGER AS $$
DECLARE
  resolution_event RECORD;
BEGIN
  IF NEW.assigned_admin_id IS DISTINCT FROM OLD.assigned_admin_id AND NOT (
    OLD.status = 'received'
    AND NEW.status = 'acknowledged'
    AND OLD.assigned_admin_id IS NULL
    AND NEW.assigned_admin_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'HX827: safety case owner can be bound only on first acknowledgment'
      USING ERRCODE = 'HX827';
  END IF;

  IF NEW.status IN ('resolved', 'closed')
    AND OLD.status NOT IN ('resolved', 'closed') THEN
    SELECT actor_user_id,
           metadata->>'resolution_code' AS resolution_code,
           metadata->>'idempotency_key' AS idempotency_key,
           metadata->>'request_hash' AS request_hash
      INTO resolution_event
      FROM task_safety_incident_events
     WHERE incident_id = NEW.id
       AND event_type = 'resolved'
     ORDER BY created_at DESC, id DESC
     LIMIT 1;

    IF NEW.assigned_admin_id IS NULL
      OR NOT FOUND
      OR resolution_event.actor_user_id IS DISTINCT FROM NEW.assigned_admin_id
      OR resolution_event.resolution_code IS NULL
      OR resolution_event.resolution_code NOT IN (
        'safety_plan_confirmed',
        'emergency_services_referred',
        'fraud_or_payment_referred',
        'legal_or_licensing_referred',
        'compensation_referred',
        'unable_to_confirm'
      )
      OR resolution_event.idempotency_key IS NULL
      OR resolution_event.idempotency_key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR resolution_event.request_hash IS NULL
      OR resolution_event.request_hash !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'HX828: terminal safety state lacks owner-authored resolution evidence'
        USING ERRCODE = 'HX828';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS task_safety_resolution_integrity ON task_safety_incidents;
CREATE TRIGGER task_safety_resolution_integrity
  BEFORE UPDATE ON task_safety_incidents
  FOR EACH ROW EXECUTE FUNCTION enforce_task_safety_resolution_integrity();
