-- Worker standing rights: progression and deactivation decisions are explainable,
-- appealable, non-retaliatory, independently reviewed, and observable.

CREATE TABLE IF NOT EXISTS worker_standing_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision_type TEXT NOT NULL CHECK (decision_type IN ('DEACTIVATION','PROGRESSION')),
  decision_state TEXT NOT NULL CHECK (char_length(decision_state) BETWEEN 2 AND 80),
  current_tier INTEGER NOT NULL CHECK (current_tier BETWEEN 1 AND 4),
  target_tier INTEGER CHECK (target_tier BETWEEN 2 AND 4),
  reason_codes TEXT[] NOT NULL CHECK (cardinality(reason_codes) > 0),
  public_explanation TEXT NOT NULL CHECK (char_length(public_explanation) BETWEEN 10 AND 2000),
  policy_version TEXT NOT NULL CHECK (char_length(policy_version) BETWEEN 3 AND 100),
  decision_source TEXT NOT NULL CHECK (decision_source IN ('SYSTEM','ADMIN','POLICY')),
  decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  source_idempotency_key TEXT NOT NULL UNIQUE CHECK (char_length(source_idempotency_key) BETWEEN 8 AND 200),
  appeal_deadline_at TIMESTAMPTZ NOT NULL,
  ranking_penalty INTEGER NOT NULL DEFAULT 0 CHECK (ranking_penalty = 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (decision_type='PROGRESSION' AND target_tier IS NOT NULL AND target_tier > current_tier)
    OR (decision_type='DEACTIVATION' AND target_tier IS NULL)
  ),
  CHECK (appeal_deadline_at > created_at)
);

CREATE INDEX IF NOT EXISTS worker_standing_decisions_worker_time_idx
  ON worker_standing_decisions(worker_id,created_at DESC);

CREATE TABLE IF NOT EXISTS worker_standing_appeal_access (
  decision_id UUID PRIMARY KEY REFERENCES worker_standing_decisions(id) ON DELETE RESTRICT,
  token_hash CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at > created_at)
);

CREATE TABLE IF NOT EXISTS worker_standing_appeals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id UUID NOT NULL REFERENCES worker_standing_decisions(id) ON DELETE RESTRICT,
  worker_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN (
    'OPEN','UNDER_REVIEW','NEEDS_INFORMATION','OVERTURNED','UPHELD','WITHDRAWN'
  )),
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 4000),
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  review_due_at TIMESTAMPTZ NOT NULL,
  assigned_reviewer_id UUID REFERENCES users(id) ON DELETE SET NULL,
  resolution_note TEXT,
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  outcome_effect_applied BOOLEAN NOT NULL DEFAULT FALSE,
  ranking_penalty INTEGER NOT NULL DEFAULT 0 CHECK (ranking_penalty = 0),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (worker_id,idempotency_key),
  CHECK (review_due_at > opened_at),
  CHECK (
    (status IN ('OVERTURNED','UPHELD') AND resolved_by IS NOT NULL
      AND resolved_at IS NOT NULL AND resolution_note IS NOT NULL
      AND char_length(resolution_note) BETWEEN 10 AND 4000
      AND outcome_effect_applied)
    OR (status NOT IN ('OVERTURNED','UPHELD') AND resolved_by IS NULL
      AND resolved_at IS NULL AND resolution_note IS NULL
      AND outcome_effect_applied=FALSE)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS worker_standing_appeals_one_open_idx
  ON worker_standing_appeals(decision_id)
  WHERE status IN ('OPEN','UNDER_REVIEW','NEEDS_INFORMATION');
CREATE INDEX IF NOT EXISTS worker_standing_appeals_review_queue_idx
  ON worker_standing_appeals(status,review_due_at,opened_at)
  WHERE status IN ('OPEN','UNDER_REVIEW','NEEDS_INFORMATION');

CREATE TABLE IF NOT EXISTS worker_standing_appeal_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appeal_id UUID NOT NULL REFERENCES worker_standing_appeals(id) ON DELETE RESTRICT,
  worker_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  statement TEXT NOT NULL CHECK (char_length(statement) BETWEEN 3 AND 4000),
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (worker_id,idempotency_key)
);

CREATE TABLE IF NOT EXISTS worker_standing_appeal_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appeal_id UUID NOT NULL REFERENCES worker_standing_appeals(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'OPENED','EVIDENCE_ADDED','REVIEW_STARTED','INFORMATION_REQUESTED',
    'OVERTURNED','UPHELD','WITHDRAWN'
  )),
  actor_role TEXT NOT NULL CHECK (actor_role IN ('WORKER','ADMIN','SYSTEM')),
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  public_message TEXT NOT NULL CHECK (char_length(public_message) BETWEEN 3 AND 1000),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 8 AND 240),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION prevent_worker_standing_evidence_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HXSTAND1: worker standing evidence is append-only' USING ERRCODE='P0001';
END;
$$;

CREATE OR REPLACE FUNCTION enforce_worker_standing_appeal()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_decision worker_standing_decisions%ROWTYPE;
BEGIN
  SELECT * INTO v_decision FROM worker_standing_decisions WHERE id=NEW.decision_id FOR SHARE;
  IF NOT FOUND OR v_decision.worker_id<>NEW.worker_id THEN
    RAISE EXCEPTION 'HXSTAND2: appeal must belong to the decision worker' USING ERRCODE='P0001';
  END IF;
  IF TG_OP='INSERT' AND v_decision.appeal_deadline_at<=NOW() THEN
    RAISE EXCEPTION 'HXSTAND3: appeal deadline has passed' USING ERRCODE='P0001';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.decision_id<>OLD.decision_id OR NEW.worker_id<>OLD.worker_id
       OR NEW.reason<>OLD.reason OR NEW.request_hash<>OLD.request_hash
       OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.review_due_at<>OLD.review_due_at
       OR NEW.opened_at<>OLD.opened_at OR NEW.ranking_penalty<>OLD.ranking_penalty THEN
      RAISE EXCEPTION 'HXSTAND4: appeal authority fields are immutable' USING ERRCODE='P0001';
    END IF;
    IF OLD.status IN ('OVERTURNED','UPHELD','WITHDRAWN') THEN
      RAISE EXCEPTION 'HXSTAND5: terminal appeal cannot change' USING ERRCODE='P0001';
    END IF;
    IF NOT (
      (OLD.status='OPEN' AND NEW.status IN ('OPEN','UNDER_REVIEW','NEEDS_INFORMATION','OVERTURNED','UPHELD','WITHDRAWN'))
      OR (OLD.status='UNDER_REVIEW' AND NEW.status IN ('UNDER_REVIEW','NEEDS_INFORMATION','OVERTURNED','UPHELD'))
      OR (OLD.status='NEEDS_INFORMATION' AND NEW.status IN ('NEEDS_INFORMATION','UNDER_REVIEW','OVERTURNED','UPHELD','WITHDRAWN'))
    ) THEN
      RAISE EXCEPTION 'HXSTAND6: invalid appeal transition % -> %',OLD.status,NEW.status USING ERRCODE='P0001';
    END IF;
  END IF;
  IF NEW.resolved_by IS NOT NULL THEN
    IF NEW.resolved_by=NEW.worker_id OR (v_decision.decided_by IS NOT NULL AND NEW.resolved_by=v_decision.decided_by) THEN
      RAISE EXCEPTION 'HXSTAND7: appeal requires an independent human reviewer' USING ERRCODE='P0001';
    END IF;
  END IF;
  NEW.updated_at=NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_worker_standing_evidence_owner()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM worker_standing_appeals a
    WHERE a.id=NEW.appeal_id AND a.worker_id=NEW.worker_id
      AND a.status IN ('OPEN','UNDER_REVIEW','NEEDS_INFORMATION')
  ) THEN
    RAISE EXCEPTION 'HXSTAND8: evidence requires an open worker-owned appeal' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS worker_standing_decisions_immutable ON worker_standing_decisions;
CREATE TRIGGER worker_standing_decisions_immutable BEFORE UPDATE OR DELETE ON worker_standing_decisions
FOR EACH ROW EXECUTE FUNCTION prevent_worker_standing_evidence_mutation();
DROP TRIGGER IF EXISTS worker_standing_access_immutable ON worker_standing_appeal_access;
CREATE TRIGGER worker_standing_access_immutable BEFORE UPDATE OR DELETE ON worker_standing_appeal_access
FOR EACH ROW EXECUTE FUNCTION prevent_worker_standing_evidence_mutation();
DROP TRIGGER IF EXISTS worker_standing_appeals_guard ON worker_standing_appeals;
CREATE TRIGGER worker_standing_appeals_guard BEFORE INSERT OR UPDATE ON worker_standing_appeals
FOR EACH ROW EXECUTE FUNCTION enforce_worker_standing_appeal();
DROP TRIGGER IF EXISTS worker_standing_appeals_no_delete ON worker_standing_appeals;
CREATE TRIGGER worker_standing_appeals_no_delete BEFORE DELETE ON worker_standing_appeals
FOR EACH ROW EXECUTE FUNCTION prevent_worker_standing_evidence_mutation();
DROP TRIGGER IF EXISTS worker_standing_evidence_owner ON worker_standing_appeal_evidence;
CREATE TRIGGER worker_standing_evidence_owner BEFORE INSERT ON worker_standing_appeal_evidence
FOR EACH ROW EXECUTE FUNCTION enforce_worker_standing_evidence_owner();
DROP TRIGGER IF EXISTS worker_standing_evidence_immutable ON worker_standing_appeal_evidence;
CREATE TRIGGER worker_standing_evidence_immutable BEFORE UPDATE OR DELETE ON worker_standing_appeal_evidence
FOR EACH ROW EXECUTE FUNCTION prevent_worker_standing_evidence_mutation();
DROP TRIGGER IF EXISTS worker_standing_events_immutable ON worker_standing_appeal_events;
CREATE TRIGGER worker_standing_events_immutable BEFORE UPDATE OR DELETE ON worker_standing_appeal_events
FOR EACH ROW EXECUTE FUNCTION prevent_worker_standing_evidence_mutation();

DO $$
DECLARE v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'worker_standing_decisions','worker_standing_appeal_access','worker_standing_appeals',
    'worker_standing_appeal_evidence','worker_standing_appeal_events'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_no_truncate ON %I',v_table,v_table);
    EXECUTE format(
      'CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION prevent_worker_standing_evidence_mutation()',
      v_table,v_table
    );
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',v_table);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',v_table);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon',v_table);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM authenticated',v_table);
    END IF;
  END LOOP;
END;
$$;

INSERT INTO major_action_source_registry(
  action_class,platform,source_table,trigger_name,source_contract_version,privacy_contract
) VALUES (
  'TRUST_IDENTITY','ENGINE','worker_standing_appeal_events','major_action_worker_standing_appeal_events',
  'worker-standing-appeals-v1','appeal narrative and evidence excluded; only lifecycle state and actor class mirrored'
) ON CONFLICT (action_class,platform,source_table) DO NOTHING;

CREATE OR REPLACE FUNCTION mirror_worker_standing_appeal_major_action()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_result TEXT := CASE WHEN NEW.event_type='OPENED' THEN 'QUEUED' ELSE 'SUCCESS' END;
  v_hash TEXT;
BEGIN
  v_hash:=encode(digest(concat_ws('|','worker-standing-appeals-v1',NEW.id::text,
    NEW.appeal_id::text,NEW.event_type,NEW.actor_role,COALESCE(NEW.actor_id::text,'system')),'sha256'),'hex');
  PERFORM record_major_action_event(
    'trust_identity.worker_standing_'||lower(NEW.event_type),'TRUST_IDENTITY','A4',
    CASE NEW.actor_role WHEN 'WORKER' THEN 'HUSTLER' WHEN 'ADMIN' THEN 'OPERATOR' ELSE 'SYSTEM' END,
    COALESCE(NEW.actor_id::text,'system'),'worker_standing_appeal',NEW.appeal_id::text,
    'APPEAL_PENDING',NEW.event_type,'SERVER_CONFIRMED','WORKER_RIGHTS','POSTGRES_TRIGGER',
    'worker-standing-appeals-v1','APPLIED',NULL,'NOT_APPLICABLE','NOT_APPLICABLE','CRITICAL',
    'worker_standing_appeal:'||NEW.appeal_id::text,'worker_standing_appeal_events:'||NEW.id::text,
    'major-action:worker-standing-appeal-events:'||NEW.id::text,NULL,v_hash,v_result,NULL,
    CASE WHEN NEW.event_type IN ('OPENED','EVIDENCE_ADDED','INFORMATION_REQUESTED') THEN 'AWAIT_HUMAN_REVIEW' ELSE NULL END,
    'WORKER_STANDING_'||NEW.event_type,'NOT_APPLICABLE','NOT_APPLICABLE',TRUE,
    'worker_standing_appeal_events',NEW.id::text,NEW.created_at,1
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS major_action_worker_standing_appeal_events ON worker_standing_appeal_events;
CREATE TRIGGER major_action_worker_standing_appeal_events
AFTER INSERT ON worker_standing_appeal_events
FOR EACH ROW EXECUTE FUNCTION mirror_worker_standing_appeal_major_action();
