-- HX/OS 2.0 authoritative Recommendation object.
-- Recommendations are proposal-only, evidence-class based, user-reversible,
-- append-only, replay-safe, and independently measurable against outcomes.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('TASK','PRICE','SCHEDULE','ROUTE','PROOF','SAFETY')),
  subject_id UUID NOT NULL,
  recommendation_class TEXT NOT NULL
    CHECK (recommendation_class IN ('INFORMATIONAL','CORRECTIVE','ECONOMIC','SCHEDULING','SAFETY','ROUTE','QUALITY')),
  source_type TEXT NOT NULL CHECK (source_type IN ('AI','DETERMINISTIC','POLICY')),
  recommendation_text TEXT NOT NULL CHECK (char_length(recommendation_text) BETWEEN 1 AND 1000),
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 2000),
  evidence_classes JSONB NOT NULL CHECK (
    jsonb_typeof(evidence_classes) = 'array'
    AND jsonb_array_length(evidence_classes) BETWEEN 1 AND 12
    AND NOT jsonb_path_exists(evidence_classes, '$[*] ? (@.type() != "string")')
  ),
  expected_benefit TEXT NOT NULL CHECK (char_length(expected_benefit) BETWEEN 1 AND 1000),
  downside TEXT NOT NULL CHECK (char_length(downside) BETWEEN 1 AND 1000),
  confidence_band TEXT NOT NULL
    CHECK (confidence_band IN ('STRONG_SIGNAL','LIKELY','SUGGESTION','UNKNOWN')),
  model_version TEXT,
  policy_version TEXT NOT NULL,
  scope_affected TEXT NOT NULL CHECK (char_length(scope_affected) BETWEEN 1 AND 200),
  user_controls JSONB NOT NULL CHECK (
    jsonb_typeof(user_controls) = 'object'
    AND user_controls @> '{"dismiss":true,"why":true,"autoExecute":false}'::jsonb
  ),
  autonomy_level TEXT NOT NULL DEFAULT 'RECOMMEND_ONLY'
    CHECK (autonomy_level = 'RECOMMEND_ONLY'),
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  retention_class TEXT NOT NULL DEFAULT 'PRODUCT_DECISION_400D',
  displayed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  purge_after TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '400 days'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (recipient_user_id, idempotency_key),
  CHECK ((source_type = 'AI' AND model_version IS NOT NULL) OR source_type <> 'AI'),
  CHECK (expires_at > created_at),
  CHECK (purge_after > expires_at)
);

CREATE INDEX IF NOT EXISTS recommendations_recipient_current_idx
  ON recommendations(recipient_user_id, expires_at, created_at DESC);
CREATE INDEX IF NOT EXISTS recommendations_subject_idx
  ON recommendations(subject_type, subject_id, created_at DESC);
CREATE INDEX IF NOT EXISTS recommendations_retention_idx
  ON recommendations(purge_after);

CREATE TABLE IF NOT EXISTS recommendation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_id UUID NOT NULL REFERENCES recommendations(id) ON DELETE RESTRICT,
  actor_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'DISPLAYED','OPENED','EDITED','DISMISSED','SNOOZED','IGNORED','OVERRIDDEN','APPEALED'
  )),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  public_note TEXT CHECK (public_note IS NULL OR char_length(public_note) BETWEEN 1 AND 1000),
  ranking_penalty NUMERIC NOT NULL DEFAULT 0 CHECK (ranking_penalty = 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (recommendation_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS recommendation_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_id UUID NOT NULL REFERENCES recommendations(id) ON DELETE RESTRICT,
  outcome_type TEXT NOT NULL CHECK (outcome_type IN (
    'TASK_OPENED','TASK_APPLIED','TASK_ACCEPTED','TASK_COMPLETED','TASK_SETTLED',
    'TASK_CANCELLED','TASK_DISPUTED','RECOMMENDATION_EXPIRED'
  )),
  source_object_id UUID NOT NULL,
  realized_value JSONB NOT NULL CHECK (jsonb_typeof(realized_value) = 'object'),
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  measured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (recommendation_id, outcome_type, source_object_id)
);

CREATE OR REPLACE FUNCTION prevent_recommendation_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HXREC1: recommendation evidence is append-only' USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS recommendations_immutable ON recommendations;
CREATE TRIGGER recommendations_immutable
BEFORE UPDATE OR DELETE ON recommendations
FOR EACH ROW EXECUTE FUNCTION prevent_recommendation_mutation();

DROP TRIGGER IF EXISTS recommendation_events_immutable ON recommendation_events;
CREATE TRIGGER recommendation_events_immutable
BEFORE UPDATE OR DELETE ON recommendation_events
FOR EACH ROW EXECUTE FUNCTION prevent_recommendation_mutation();

DROP TRIGGER IF EXISTS recommendation_outcomes_immutable ON recommendation_outcomes;
CREATE TRIGGER recommendation_outcomes_immutable
BEFORE UPDATE OR DELETE ON recommendation_outcomes
FOR EACH ROW EXECUTE FUNCTION prevent_recommendation_mutation();

CREATE OR REPLACE FUNCTION record_task_recommendation_settlement_outcome()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_realized_value JSONB;
BEGIN
  IF NEW.state <> 'RELEASED' OR OLD.state = 'RELEASED' THEN
    RETURN NEW;
  END IF;

  v_realized_value := jsonb_build_object(
    'escrowState', 'RELEASED',
    'settlementRail', CASE
      WHEN NEW.stripe_transfer_id IS NOT NULL THEN 'CONNECTED_BALANCE'
      ELSE 'RELEASE_STATE_ONLY'
    END,
    'bankPayoutConfirmed', FALSE
  );

  INSERT INTO recommendation_outcomes (
    recommendation_id,outcome_type,source_object_id,realized_value,request_hash
  )
  SELECT recommendation.id,'TASK_SETTLED',NEW.task_id,v_realized_value,
         encode(digest(
           concat_ws('|','TASK_SETTLED',NEW.task_id::text,v_realized_value::text),
           'sha256'
         ),'hex')
  FROM recommendations recommendation
  WHERE recommendation.subject_type = 'TASK'
    AND recommendation.subject_id = NEW.task_id
  ON CONFLICT (recommendation_id,outcome_type,source_object_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS escrows_record_recommendation_settlement ON escrows;
CREATE TRIGGER escrows_record_recommendation_settlement
AFTER UPDATE OF state ON escrows
FOR EACH ROW EXECUTE FUNCTION record_task_recommendation_settlement_outcome();

COMMENT ON TABLE recommendations IS
  'Authoritative HX/OS proposal-only recommendation snapshots. Evidence classes only; no raw sensitive feature payloads.';
COMMENT ON COLUMN recommendation_events.ranking_penalty IS
  'Worker-respect invariant: dismissal, snooze, ignore, override, and appeal never lower ranking.';
COMMENT ON FUNCTION record_task_recommendation_settlement_outcome() IS
  'Records RELEASED as connected-balance settlement only when provider transfer evidence exists; never claims bank payout.';
