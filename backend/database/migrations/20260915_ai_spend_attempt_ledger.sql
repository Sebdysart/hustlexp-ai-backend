-- Durable, append-only AI provider-attempt spend authority.
--
-- Redis remains the atomic daily ceiling authority. This ledger records the
-- independently durable pre-I/O RESERVED fact and exactly one terminal fact.
-- It deliberately does not claim a distributed transaction between Redis,
-- PostgreSQL, and an external provider.

CREATE TABLE IF NOT EXISTS public.ai_spend_attempt_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 512),
  attempt_id TEXT NOT NULL CHECK (length(attempt_id) BETWEEN 1 AND 512),
  transition TEXT NOT NULL CHECK (transition IN ('RESERVED','UNKNOWN','SETTLED','RELEASED')),
  agent_type TEXT NOT NULL CHECK (length(agent_type) BETWEEN 1 AND 512),
  subject_ref_hash CHAR(64) NOT NULL CHECK (subject_ref_hash ~ '^[0-9a-f]{64}$'),
  provider_kind TEXT NOT NULL CHECK (length(provider_kind) BETWEEN 1 AND 128),
  provider_model TEXT NOT NULL CHECK (length(provider_model) BETWEEN 1 AND 256),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) BETWEEN 1 AND 512),
  budget_day BIGINT NOT NULL CHECK (budget_day >= 0),
  reserved_cents INTEGER NOT NULL CHECK (reserved_cents > 0),
  actual_cost_cents INTEGER,
  detail_code TEXT CHECK (detail_code IS NULL OR length(detail_code) BETWEEN 1 AND 128),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ai_spend_attempt_transition_shape_chk CHECK (
    (transition = 'SETTLED' AND actual_cost_cents BETWEEN 0 AND reserved_cents AND detail_code IS NULL)
    OR (transition = 'UNKNOWN' AND actual_cost_cents IS NULL AND detail_code IS NOT NULL)
    OR (transition = 'RELEASED' AND actual_cost_cents IS NULL AND detail_code IS NOT NULL)
    OR (transition = 'RESERVED' AND actual_cost_cents IS NULL AND detail_code IS NULL)
  ),
  CONSTRAINT ai_spend_attempt_transition_uniq UNIQUE (operation_id, attempt_id, transition)
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_spend_attempt_one_terminal_uniq
  ON public.ai_spend_attempt_events(operation_id, attempt_id)
  WHERE transition <> 'RESERVED';

CREATE INDEX IF NOT EXISTS ai_spend_attempt_recorded_idx
  ON public.ai_spend_attempt_events(recorded_at, operation_id, attempt_id);

CREATE OR REPLACE FUNCTION public.enforce_ai_spend_attempt_event_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  reserved_fact public.ai_spend_attempt_events%ROWTYPE;
BEGIN
  IF NEW.transition = 'RESERVED' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO reserved_fact
  FROM public.ai_spend_attempt_events
  WHERE operation_id = NEW.operation_id
    AND attempt_id = NEW.attempt_id
    AND transition = 'RESERVED';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXAI2: AI spend terminal fact requires its exact RESERVED predecessor'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.agent_type IS DISTINCT FROM reserved_fact.agent_type
    OR NEW.subject_ref_hash IS DISTINCT FROM reserved_fact.subject_ref_hash
    OR NEW.provider_kind IS DISTINCT FROM reserved_fact.provider_kind
    OR NEW.provider_model IS DISTINCT FROM reserved_fact.provider_model
    OR NEW.request_fingerprint IS DISTINCT FROM reserved_fact.request_fingerprint
    OR NEW.budget_day IS DISTINCT FROM reserved_fact.budget_day
    OR NEW.reserved_cents IS DISTINCT FROM reserved_fact.reserved_cents
  THEN
    RAISE EXCEPTION 'HXAI3: AI spend terminal fact identity differs from RESERVED predecessor'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_spend_attempt_validate_insert ON public.ai_spend_attempt_events;
CREATE TRIGGER ai_spend_attempt_validate_insert
BEFORE INSERT ON public.ai_spend_attempt_events
FOR EACH ROW EXECUTE FUNCTION public.enforce_ai_spend_attempt_event_insert();

CREATE OR REPLACE FUNCTION public.reject_ai_spend_attempt_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'HXAI4: AI spend attempt evidence is append-only'
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS ai_spend_attempt_events_no_update_delete ON public.ai_spend_attempt_events;
CREATE TRIGGER ai_spend_attempt_events_no_update_delete
BEFORE UPDATE OR DELETE ON public.ai_spend_attempt_events
FOR EACH ROW EXECUTE FUNCTION public.reject_ai_spend_attempt_event_mutation();

DROP TRIGGER IF EXISTS ai_spend_attempt_events_no_truncate ON public.ai_spend_attempt_events;
CREATE TRIGGER ai_spend_attempt_events_no_truncate
BEFORE TRUNCATE ON public.ai_spend_attempt_events
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_ai_spend_attempt_event_mutation();

COMMENT ON TABLE public.ai_spend_attempt_events IS
  'Append-only AI spend attempt evidence. RESERVED commits before provider I/O; UNKNOWN, SETTLED, or RELEASED is the sole terminal fact.';
COMMENT ON COLUMN public.ai_spend_attempt_events.budget_day IS
  'UTC epoch-day selected atomically by Redis TIME during the ceiling reservation.';
COMMENT ON COLUMN public.ai_spend_attempt_events.subject_ref_hash IS
  'SHA-256 of the budget subject reference; raw prompts and provider output are prohibited here.';

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.ai_spend_attempt_events FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_ai_spend_attempt_event_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_ai_spend_attempt_event_mutation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_ai_spend_attempt_event_insert() TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.reject_ai_spend_attempt_event_mutation() TO CURRENT_USER;
