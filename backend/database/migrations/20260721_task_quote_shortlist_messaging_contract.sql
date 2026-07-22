-- One active quote shortlist per open task. This is the sole pre-assignment
-- authority for private Poster/provider chat; a pending application cannot
-- grant itself private-message access.

CREATE TABLE IF NOT EXISTS task_quote_shortlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  worker_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  shortlisted_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','REVOKED','CONVERTED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  CHECK ((status='ACTIVE' AND closed_at IS NULL) OR (status<>'ACTIVE' AND closed_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS task_quote_shortlists_one_active_task
  ON task_quote_shortlists(task_id) WHERE status='ACTIVE';
CREATE INDEX IF NOT EXISTS task_quote_shortlists_worker_history
  ON task_quote_shortlists(worker_id, created_at DESC);

CREATE OR REPLACE FUNCTION enforce_task_quote_shortlist_contract()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_task RECORD;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'HXCHAT1: quote shortlist history is append-preserved'
      USING ERRCODE='P0001';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.task_id IS DISTINCT FROM OLD.task_id
       OR NEW.worker_id IS DISTINCT FROM OLD.worker_id
       OR NEW.shortlisted_by IS DISTINCT FROM OLD.shortlisted_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'HXCHAT2: quote shortlist identity is immutable'
        USING ERRCODE='P0001';
    END IF;
    IF OLD.status<>'ACTIVE' OR NEW.status NOT IN ('REVOKED','CONVERTED') THEN
      RAISE EXCEPTION 'HXCHAT3: quote shortlist transition is invalid'
        USING ERRCODE='P0001';
    END IF;
    NEW.closed_at := COALESCE(NEW.closed_at, clock_timestamp());
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END IF;

  IF NEW.status<>'ACTIVE' OR NEW.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'HXCHAT4: a new quote shortlist must begin active'
      USING ERRCODE='P0001';
  END IF;
  SELECT id,poster_id,worker_id,state INTO v_task FROM tasks WHERE id=NEW.task_id FOR SHARE;
  IF v_task.id IS NULL OR v_task.poster_id IS DISTINCT FROM NEW.shortlisted_by THEN
    RAISE EXCEPTION 'HXCHAT5: only the task Poster can grant quote-chat access'
      USING ERRCODE='P0001';
  END IF;
  IF v_task.state NOT IN ('OPEN','MATCHING') OR v_task.worker_id IS NOT NULL THEN
    RAISE EXCEPTION 'HXCHAT6: quote chat requires an unassigned open task'
      USING ERRCODE='P0001';
  END IF;
  IF NEW.worker_id=NEW.shortlisted_by OR NOT EXISTS (
    SELECT 1 FROM task_applications
     WHERE task_id=NEW.task_id AND hustler_id=NEW.worker_id AND status IN ('pending','countered')
  ) THEN
    RAISE EXCEPTION 'HXCHAT7: quote chat requires an active provider application'
      USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_quote_shortlist_contract_guard ON task_quote_shortlists;
CREATE TRIGGER task_quote_shortlist_contract_guard
BEFORE INSERT OR UPDATE OR DELETE ON task_quote_shortlists
FOR EACH ROW EXECUTE FUNCTION enforce_task_quote_shortlist_contract();

CREATE OR REPLACE FUNCTION close_task_quote_shortlist_on_assignment()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.worker_id IS NOT NULL OR NEW.state NOT IN ('OPEN','MATCHING') THEN
    UPDATE task_quote_shortlists
       SET status=CASE WHEN worker_id=NEW.worker_id THEN 'CONVERTED' ELSE 'REVOKED' END,
           closed_at=clock_timestamp(), updated_at=clock_timestamp()
     WHERE task_id=NEW.id AND status='ACTIVE';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_quote_shortlist_assignment_close ON tasks;
CREATE TRIGGER task_quote_shortlist_assignment_close
AFTER UPDATE OF state,worker_id ON tasks
FOR EACH ROW
WHEN (OLD.state IS DISTINCT FROM NEW.state OR OLD.worker_id IS DISTINCT FROM NEW.worker_id)
EXECUTE FUNCTION close_task_quote_shortlist_on_assignment();

CREATE OR REPLACE FUNCTION close_task_quote_shortlist_on_application_exit()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('rejected','counter_rejected','withdrawn','expired') THEN
    UPDATE task_quote_shortlists
       SET status='REVOKED', closed_at=clock_timestamp(), updated_at=clock_timestamp()
     WHERE task_id=NEW.task_id AND worker_id=NEW.hustler_id AND status='ACTIVE';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_quote_shortlist_application_close ON task_applications;
CREATE TRIGGER task_quote_shortlist_application_close
AFTER UPDATE OF status ON task_applications
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION close_task_quote_shortlist_on_application_exit();

CREATE OR REPLACE FUNCTION enforce_task_message_participant_pair()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_poster UUID;
  v_worker UUID;
  v_state TEXT;
BEGIN
  SELECT poster_id,worker_id,state INTO v_poster,v_worker,v_state
    FROM tasks WHERE id=NEW.task_id FOR SHARE;
  IF v_state IN ('OPEN','MATCHING') AND v_worker IS NULL THEN
    SELECT worker_id INTO v_worker FROM task_quote_shortlists
     WHERE task_id=NEW.task_id AND status='ACTIVE';
  END IF;
  IF v_poster IS NULL OR v_worker IS NULL
     OR v_state NOT IN ('OPEN','MATCHING','ACCEPTED','PROOF_SUBMITTED','DISPUTED')
     OR NOT (
       (NEW.sender_id=v_poster AND NEW.receiver_id=v_worker)
       OR (NEW.sender_id=v_worker AND NEW.receiver_id=v_poster)
     ) THEN
    RAISE EXCEPTION 'HXCHAT8: message pair lacks current task authority'
      USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_message_participant_pair_guard ON task_messages;
CREATE TRIGGER task_message_participant_pair_guard
BEFORE INSERT ON task_messages
FOR EACH ROW EXECUTE FUNCTION enforce_task_message_participant_pair();

REVOKE ALL ON task_quote_shortlists FROM PUBLIC;
COMMENT ON TABLE task_quote_shortlists IS
  'Server-authoritative, one-at-a-time quote-chat grant. Pending applications remain structured interest and never self-authorize private contact.';
COMMENT ON FUNCTION enforce_task_message_participant_pair() IS
  'Database backstop preventing task-message writes outside the assigned or actively shortlisted Poster/provider pair.';
