-- HX/OS 2.0 AI observability contract.
-- Stores privacy-safe decision metadata, never prompts, raw evidence, or model output.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS ai_observation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  surface_id TEXT NOT NULL CHECK (char_length(surface_id) BETWEEN 3 AND 100),
  actor_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  affected_object_type TEXT NOT NULL CHECK (char_length(affected_object_type) BETWEEN 1 AND 80),
  affected_object_id TEXT NOT NULL CHECK (char_length(affected_object_id) BETWEEN 1 AND 200),
  action TEXT NOT NULL CHECK (char_length(action) BETWEEN 1 AND 500),
  scope_affected TEXT NOT NULL CHECK (char_length(scope_affected) BETWEEN 1 AND 200),
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 2000),
  evidence_classes JSONB NOT NULL CHECK (
    jsonb_typeof(evidence_classes) = 'array'
    AND jsonb_array_length(evidence_classes) BETWEEN 1 AND 16
    AND NOT jsonb_path_exists(evidence_classes, '$[*] ? (@.type() != "string")')
  ),
  expected_benefit TEXT NOT NULL CHECK (char_length(expected_benefit) BETWEEN 1 AND 1000),
  uncertainty TEXT NOT NULL CHECK (char_length(uncertainty) BETWEEN 1 AND 1000),
  downside TEXT NOT NULL CHECK (char_length(downside) BETWEEN 1 AND 1000),
  authority_level TEXT NOT NULL CHECK (authority_level IN ('A2_PROPOSAL_ONLY','INFORMATIONAL_ONLY')),
  policy_version TEXT NOT NULL CHECK (char_length(policy_version) BETWEEN 3 AND 120),
  provider TEXT NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 80),
  model_version TEXT NOT NULL CHECK (char_length(model_version) BETWEEN 1 AND 160),
  confidence_band TEXT NOT NULL CHECK (confidence_band IN ('STRONG_SIGNAL','LIKELY','SUGGESTION','UNKNOWN')),
  controls JSONB NOT NULL CHECK (
    jsonb_typeof(controls) = 'object'
    AND controls @> '{"why":true,"autoExecute":false,"reversible":true}'::JSONB
  ),
  outcome_source TEXT NOT NULL CHECK (char_length(outcome_source) BETWEEN 1 AND 500),
  execution_result TEXT NOT NULL CHECK (execution_result IN ('GENERATED','CACHED','FAILED')),
  output_hash CHAR(64) CHECK (output_hash IS NULL OR output_hash ~ '^[a-f0-9]{64}$'),
  latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
  occurred_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retention_class TEXT NOT NULL DEFAULT 'AI_DECISION_400D',
  purge_after TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '400 days'),
  CHECK ((execution_result = 'FAILED' AND output_hash IS NULL) OR execution_result <> 'FAILED'),
  CHECK (purge_after > occurred_at)
);

CREATE INDEX IF NOT EXISTS ai_observation_events_surface_time_idx
  ON ai_observation_events(surface_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS ai_observation_events_object_time_idx
  ON ai_observation_events(affected_object_type, affected_object_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS ai_observation_events_actor_time_idx
  ON ai_observation_events(actor_user_id, occurred_at DESC, id DESC)
  WHERE actor_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_observation_events_purge_idx
  ON ai_observation_events(purge_after);

CREATE TABLE IF NOT EXISTS ai_observation_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id UUID NOT NULL REFERENCES ai_observation_events(id) ON DELETE RESTRICT,
  outcome_type TEXT NOT NULL CHECK (char_length(outcome_type) BETWEEN 1 AND 100),
  outcome_object_type TEXT NOT NULL CHECK (char_length(outcome_object_type) BETWEEN 1 AND 80),
  outcome_object_id TEXT NOT NULL CHECK (char_length(outcome_object_id) BETWEEN 1 AND 200),
  realized_result JSONB NOT NULL CHECK (jsonb_typeof(realized_result) = 'object'),
  source_table TEXT NOT NULL CHECK (char_length(source_table) BETWEEN 1 AND 120),
  source_event_id TEXT NOT NULL CHECK (char_length(source_event_id) BETWEEN 1 AND 200),
  payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  measured_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (observation_id, outcome_type, source_event_id)
);

CREATE INDEX IF NOT EXISTS ai_observation_outcomes_observation_idx
  ON ai_observation_outcomes(observation_id, measured_at, id);

CREATE TABLE IF NOT EXISTS ai_observation_access_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id UUID NOT NULL REFERENCES ai_observation_events(id) ON DELETE RESTRICT,
  admin_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  purpose TEXT NOT NULL CHECK (char_length(purpose) BETWEEN 10 AND 500),
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_observation_access_log_observation_idx
  ON ai_observation_access_log(observation_id, accessed_at DESC, id DESC);

ALTER TABLE recommendations
  ADD COLUMN IF NOT EXISTS ai_observation_id UUID
  REFERENCES ai_observation_events(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS recommendations_ai_observation_idx
  ON recommendations(ai_observation_id)
  WHERE ai_observation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION validate_recommendation_ai_observation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_type = 'AI' THEN
    IF NEW.ai_observation_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM ai_observation_events observation
       WHERE observation.id = NEW.ai_observation_id
         AND observation.surface_id = 'AI-TASK-SUGGESTION-PROPOSAL'
         AND observation.actor_user_id = NEW.recipient_user_id
         AND observation.execution_result IN ('GENERATED','CACHED')
         AND observation.controls @> '{"dismiss":true,"why":true,"autoExecute":false}'::JSONB
    ) THEN
      RAISE EXCEPTION 'HXAI3: AI recommendation observation is missing, foreign, or non-applicable'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.ai_observation_id IS NOT NULL THEN
    RAISE EXCEPTION 'HXAI4: deterministic recommendation cannot claim AI provenance'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS recommendations_validate_ai_observation ON recommendations;
CREATE TRIGGER recommendations_validate_ai_observation
BEFORE INSERT OR UPDATE OF ai_observation_id,source_type,recipient_user_id ON recommendations
FOR EACH ROW EXECUTE FUNCTION validate_recommendation_ai_observation();

CREATE OR REPLACE FUNCTION record_ai_recommendation_event_outcome()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_observation_id UUID;
  v_result JSONB;
BEGIN
  SELECT ai_observation_id INTO v_observation_id
    FROM recommendations WHERE id = NEW.recommendation_id;
  IF v_observation_id IS NULL THEN
    RETURN NEW;
  END IF;
  v_result := CASE WHEN NEW.event_type = 'DISPLAYED' THEN
    jsonb_build_object('recommendationDisplayed',TRUE,'autoExecuted',FALSE)
  ELSE
    jsonb_build_object(
      'userAction',NEW.event_type,
      'automaticStateChange',FALSE,
      'rankingPenalty',NEW.ranking_penalty
    )
  END;
  INSERT INTO ai_observation_outcomes (
    observation_id,outcome_type,outcome_object_type,outcome_object_id,
    realized_result,source_table,source_event_id,payload_hash,measured_at
  ) VALUES (
    v_observation_id,
    CASE WHEN NEW.event_type = 'DISPLAYED' THEN 'RECOMMENDATION_DISPLAYED' ELSE 'USER_' || NEW.event_type END,
    'RECOMMENDATION',NEW.recommendation_id::TEXT,v_result,
    'recommendation_events',NEW.id::TEXT,
    encode(digest(concat_ws('|',v_observation_id::TEXT,NEW.event_type,NEW.id::TEXT,v_result::TEXT),'sha256'),'hex'),
    NEW.created_at
  ) ON CONFLICT (observation_id,outcome_type,source_event_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS recommendation_events_record_ai_outcome ON recommendation_events;
CREATE TRIGGER recommendation_events_record_ai_outcome
AFTER INSERT ON recommendation_events
FOR EACH ROW EXECUTE FUNCTION record_ai_recommendation_event_outcome();

CREATE OR REPLACE FUNCTION record_ai_recommendation_realized_outcome()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_observation_id UUID;
BEGIN
  SELECT ai_observation_id INTO v_observation_id
    FROM recommendations WHERE id = NEW.recommendation_id;
  IF v_observation_id IS NULL THEN
    RETURN NEW;
  END IF;
  INSERT INTO ai_observation_outcomes (
    observation_id,outcome_type,outcome_object_type,outcome_object_id,
    realized_result,source_table,source_event_id,payload_hash,measured_at
  ) VALUES (
    v_observation_id,NEW.outcome_type,'TASK',NEW.source_object_id::TEXT,
    NEW.realized_value,'recommendation_outcomes',NEW.id::TEXT,
    encode(digest(concat_ws('|',v_observation_id::TEXT,NEW.outcome_type,NEW.id::TEXT,NEW.realized_value::TEXT),'sha256'),'hex'),
    NEW.measured_at
  ) ON CONFLICT (observation_id,outcome_type,source_event_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS recommendation_outcomes_record_ai_outcome ON recommendation_outcomes;
CREATE TRIGGER recommendation_outcomes_record_ai_outcome
AFTER INSERT ON recommendation_outcomes
FOR EACH ROW EXECUTE FUNCTION record_ai_recommendation_realized_outcome();

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS ai_scope_observation_id UUID
  REFERENCES ai_observation_events(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS tasks_ai_scope_observation_idx
  ON tasks(ai_scope_observation_id)
  WHERE ai_scope_observation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION validate_task_ai_scope_observation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ai_scope_observation_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM ai_observation_events observation
     WHERE observation.id = NEW.ai_scope_observation_id
       AND observation.surface_id = 'AI-SCOPER-PROPOSAL'
       AND observation.actor_user_id = NEW.poster_id
       AND observation.execution_result IN ('GENERATED','CACHED')
       AND observation.controls @> '{"apply":true,"edit":true,"autoExecute":false}'::JSONB
  ) THEN
    RAISE EXCEPTION 'HXAI2: task scope observation is missing, foreign, or non-applicable'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tasks_validate_ai_scope_observation ON tasks;
CREATE TRIGGER tasks_validate_ai_scope_observation
BEFORE INSERT OR UPDATE OF ai_scope_observation_id ON tasks
FOR EACH ROW EXECUTE FUNCTION validate_task_ai_scope_observation();

CREATE OR REPLACE FUNCTION record_task_ai_scope_outcome()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_result JSONB;
BEGIN
  IF NEW.ai_scope_observation_id IS NULL THEN
    RETURN NEW;
  END IF;
  v_result := jsonb_build_object(
    'taskCreated', TRUE,
    'proposalAuthorizedState', FALSE,
    'executablePolicyRevalidated', TRUE
  );
  INSERT INTO ai_observation_outcomes (
    observation_id,outcome_type,outcome_object_type,outcome_object_id,
    realized_result,source_table,source_event_id,payload_hash,measured_at
  ) VALUES (
    NEW.ai_scope_observation_id,'TASK_CREATED','TASK',NEW.id::TEXT,
    v_result,'tasks',NEW.id::TEXT,
    encode(digest(concat_ws('|',NEW.ai_scope_observation_id::TEXT,'TASK_CREATED',NEW.id::TEXT,v_result::TEXT),'sha256'),'hex'),
    COALESCE(NEW.created_at,NOW())
  ) ON CONFLICT (observation_id,outcome_type,source_event_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tasks_record_ai_scope_outcome ON tasks;
CREATE TRIGGER tasks_record_ai_scope_outcome
AFTER INSERT ON tasks
FOR EACH ROW EXECUTE FUNCTION record_task_ai_scope_outcome();

CREATE OR REPLACE FUNCTION prevent_ai_observation_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HXAI1: AI observability evidence is append-only' USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS ai_observation_events_immutable ON ai_observation_events;
CREATE TRIGGER ai_observation_events_immutable
BEFORE UPDATE OR DELETE ON ai_observation_events
FOR EACH ROW EXECUTE FUNCTION prevent_ai_observation_mutation();

DROP TRIGGER IF EXISTS ai_observation_outcomes_immutable ON ai_observation_outcomes;
CREATE TRIGGER ai_observation_outcomes_immutable
BEFORE UPDATE OR DELETE ON ai_observation_outcomes
FOR EACH ROW EXECUTE FUNCTION prevent_ai_observation_mutation();

DROP TRIGGER IF EXISTS ai_observation_access_log_immutable ON ai_observation_access_log;
CREATE TRIGGER ai_observation_access_log_immutable
BEFORE UPDATE OR DELETE ON ai_observation_access_log
FOR EACH ROW EXECUTE FUNCTION prevent_ai_observation_mutation();

COMMENT ON TABLE ai_observation_events IS
  'Privacy-safe HX/OS AI action ledger. Raw prompts, raw evidence, and model output are prohibited.';
COMMENT ON COLUMN ai_observation_events.outcome_source IS
  'Human-readable authoritative domain source used to reconcile realized outcomes; never a claim that an outcome occurred.';
