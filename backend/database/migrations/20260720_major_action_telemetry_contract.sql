-- HX/OS 2.0 major-action and consequential-event telemetry contract.
--
-- This is a normalized, privacy-safe projection over authoritative domain
-- events. It deliberately contains no JSON/free-text payload column: safety
-- evidence, private messages, exact location, identity material, and provider
-- payloads stay in their purpose-specific stores. Every row links back to the
-- immutable source fact that caused it.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS major_action_class_contracts (
  action_class TEXT PRIMARY KEY CHECK (action_class IN (
    'INTENT_SCOPE','PRICING_QUOTE','PAYMENT','DISPATCH','OFFER_ASSIGNMENT',
    'EXECUTION','PROOF_COMPLETION','SETTLEMENT','PAYOUT','DISPUTE','SAFETY',
    'TRUST_IDENTITY','BUSINESS_OPERATION','RECURRING_WORK','RECOMMENDATION',
    'AUTOMATION','NOTIFICATION','OFFLINE_SYNC','LIQUIDITY'
  )),
  default_automation_class TEXT NOT NULL CHECK (default_automation_class IN ('A0','A1','A2','A3','A4','A5')),
  server_confirmation_required BOOLEAN NOT NULL,
  realized_outcome_required_when_terminal BOOLEAN NOT NULL,
  policy_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO major_action_class_contracts(
  action_class,default_automation_class,server_confirmation_required,
  realized_outcome_required_when_terminal,policy_version
) VALUES
  ('INTENT_SCOPE','A2',FALSE,FALSE,'hxos-major-action-taxonomy-v1'),
  ('PRICING_QUOTE','A2',TRUE,FALSE,'hxos-major-action-taxonomy-v1'),
  ('PAYMENT','A3',TRUE,TRUE,'hxos-major-action-taxonomy-v1'),
  ('DISPATCH','A2',TRUE,FALSE,'hxos-major-action-taxonomy-v1'),
  ('OFFER_ASSIGNMENT','A2',TRUE,FALSE,'hxos-major-action-taxonomy-v1'),
  ('EXECUTION','A2',FALSE,FALSE,'hxos-major-action-taxonomy-v1'),
  ('PROOF_COMPLETION','A2',FALSE,TRUE,'hxos-major-action-taxonomy-v1'),
  ('SETTLEMENT','A3',TRUE,TRUE,'hxos-major-action-taxonomy-v1'),
  ('PAYOUT','A3',TRUE,TRUE,'hxos-major-action-taxonomy-v1'),
  ('DISPUTE','A4',TRUE,TRUE,'hxos-major-action-taxonomy-v1'),
  ('SAFETY','A4',FALSE,TRUE,'hxos-major-action-taxonomy-v1'),
  ('TRUST_IDENTITY','A4',TRUE,TRUE,'hxos-major-action-taxonomy-v1'),
  ('BUSINESS_OPERATION','A2',TRUE,FALSE,'hxos-major-action-taxonomy-v1'),
  ('RECURRING_WORK','A2',TRUE,FALSE,'hxos-major-action-taxonomy-v1'),
  ('RECOMMENDATION','A0',FALSE,TRUE,'hxos-major-action-taxonomy-v1'),
  ('AUTOMATION','A1',FALSE,FALSE,'hxos-major-action-taxonomy-v1'),
  ('NOTIFICATION','A2',FALSE,FALSE,'hxos-major-action-taxonomy-v1'),
  ('OFFLINE_SYNC','A1',FALSE,FALSE,'hxos-major-action-taxonomy-v1'),
  ('LIQUIDITY','A1',TRUE,FALSE,'hxos-major-action-taxonomy-v1')
ON CONFLICT (action_class) DO UPDATE SET
  default_automation_class=EXCLUDED.default_automation_class,
  server_confirmation_required=EXCLUDED.server_confirmation_required,
  realized_outcome_required_when_terminal=EXCLUDED.realized_outcome_required_when_terminal,
  policy_version=EXCLUDED.policy_version;

CREATE TABLE IF NOT EXISTS major_action_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version TEXT NOT NULL DEFAULT 'hxos-major-action-v1'
    CHECK (schema_version = 'hxos-major-action-v1'),
  event_name TEXT NOT NULL CHECK (event_name ~ '^[a-z][a-z0-9_.-]{2,119}$'),
  event_version INTEGER NOT NULL DEFAULT 1 CHECK (event_version > 0),
  action_class TEXT NOT NULL REFERENCES major_action_class_contracts(action_class) ON DELETE RESTRICT,
  automation_class TEXT NOT NULL CHECK (automation_class IN ('A0','A1','A2','A3','A4','A5')),
  actor_role TEXT NOT NULL CHECK (actor_role IN (
    'VISITOR','POSTER','HUSTLER','BUSINESS','OPERATOR','SYSTEM','PROVIDER','USER'
  )),
  actor_ref TEXT NOT NULL CHECK (
    actor_ref ~ '^[A-Za-z0-9:_-]{2,200}$' AND actor_ref !~ '^[0-9+]{7,20}$'
  ),
  aggregate_type TEXT NOT NULL CHECK (aggregate_type ~ '^[a-z][a-z0-9_]{1,63}$'),
  aggregate_id TEXT NOT NULL CHECK (aggregate_id ~ '^[A-Za-z0-9:_-]{2,200}$'),
  previous_lifecycle_state TEXT NOT NULL
    CHECK (previous_lifecycle_state ~ '^[A-Z0-9:_.-]{2,100}$'),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state ~ '^[A-Z0-9:_.-]{2,100}$'),
  sync_state TEXT NOT NULL CHECK (sync_state IN (
    'SERVER_CONFIRMED','LOCAL_PENDING','SYNCING','CONFLICT','REJECTED'
  )),
  entry_surface TEXT NOT NULL CHECK (entry_surface ~ '^[A-Z0-9:_-]{2,100}$'),
  context_source TEXT NOT NULL CHECK (context_source ~ '^[A-Z0-9:_-]{2,100}$'),
  policy_version TEXT NOT NULL CHECK (policy_version ~ '^[A-Za-z0-9:_.-]{2,160}$'),
  policy_applicability TEXT NOT NULL CHECK (policy_applicability IN (
    'APPLIED','NOT_APPLICABLE','UNATTRIBUTED'
  )),
  recommendation_id UUID REFERENCES recommendations(id) ON DELETE RESTRICT,
  model_version TEXT NOT NULL CHECK (model_version ~ '^[A-Za-z0-9:_.-]{2,160}$'),
  model_applicability TEXT NOT NULL CHECK (model_applicability IN (
    'APPLIED','NOT_APPLICABLE','UNATTRIBUTED'
  )),
  risk_class TEXT NOT NULL CHECK (risk_class IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  correlation_id TEXT NOT NULL CHECK (correlation_id ~ '^[A-Za-z0-9:_.-]{4,240}$'),
  causation_id TEXT NOT NULL CHECK (causation_id ~ '^[A-Za-z0-9:_.-]{4,240}$'),
  idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_.-]{8,240}$'),
  source_sequence BIGINT NOT NULL CHECK (source_sequence > 0),
  ordering_state TEXT NOT NULL CHECK (ordering_state IN ('ROOT','IN_ORDER','STALE','GAP')),
  environment TEXT NOT NULL CHECK (environment IN ('PRODUCTION','TEST')),
  is_test BOOLEAN NOT NULL,
  payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  result TEXT NOT NULL CHECK (result IN (
    'SUCCESS','FAILURE','PARTIAL','NOOP','QUEUED','REJECTED','CONFLICT'
  )),
  latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
  latency_class TEXT NOT NULL CHECK (latency_class IN (
    'LT_100MS','LT_500MS','LT_2S','GTE_2S'
  )),
  latency_kind TEXT NOT NULL DEFAULT 'INGEST' CHECK (latency_kind = 'INGEST'),
  failure_reason_code TEXT CHECK (
    failure_reason_code IS NULL OR failure_reason_code ~ '^[A-Z][A-Z0-9_]{2,99}$'
  ),
  recovery_action_code TEXT CHECK (
    recovery_action_code IS NULL OR recovery_action_code ~ '^[A-Z][A-Z0-9_]{2,99}$'
  ),
  change_reason_code TEXT NOT NULL CHECK (change_reason_code ~ '^[A-Z][A-Z0-9_]{2,99}$'),
  experiment_variant TEXT NOT NULL CHECK (experiment_variant ~ '^[A-Za-z0-9:_.-]{2,100}$'),
  experiment_applicability TEXT NOT NULL CHECK (experiment_applicability IN (
    'APPLIED','NOT_APPLICABLE'
  )),
  reversible BOOLEAN NOT NULL,
  source_table TEXT NOT NULL CHECK (source_table ~ '^[a-z][a-z0-9_]{1,100}$'),
  source_event_id TEXT NOT NULL CHECK (source_event_id ~ '^[A-Za-z0-9:_.-]{2,240}$'),
  occurred_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (idempotency_key, event_version),
  UNIQUE (source_table, source_event_id, event_version),
  CHECK (environment = CASE WHEN is_test THEN 'TEST' ELSE 'PRODUCTION' END),
  CHECK (recorded_at >= occurred_at - INTERVAL '5 minutes'),
  CHECK (
    (result IN ('FAILURE','REJECTED','CONFLICT')
      AND failure_reason_code IS NOT NULL AND recovery_action_code IS NOT NULL)
    OR
    (result NOT IN ('FAILURE','REJECTED','CONFLICT') AND failure_reason_code IS NULL)
  ),
  CHECK (ordering_state <> 'GAP' OR recovery_action_code IS NOT NULL),
  CHECK (
    (model_applicability='APPLIED' AND model_version NOT IN ('NOT_APPLICABLE','UNATTRIBUTED'))
    OR (model_applicability='NOT_APPLICABLE' AND model_version='NOT_APPLICABLE')
    OR (model_applicability='UNATTRIBUTED' AND model_version='UNATTRIBUTED')
  ),
  CHECK ((experiment_applicability = 'APPLIED') = (experiment_variant <> 'NOT_APPLICABLE')),
  CHECK (action_class <> 'RECOMMENDATION' OR recommendation_id IS NOT NULL),
  CHECK (action_class NOT IN ('PAYMENT','SETTLEMENT','PAYOUT') OR sync_state = 'SERVER_CONFIRMED')
);

CREATE INDEX IF NOT EXISTS major_action_events_object_time_idx
  ON major_action_events(aggregate_type,aggregate_id,recorded_at DESC);
CREATE INDEX IF NOT EXISTS major_action_events_class_result_idx
  ON major_action_events(action_class,result,recorded_at DESC);
CREATE INDEX IF NOT EXISTS major_action_events_correlation_idx
  ON major_action_events(correlation_id,recorded_at ASC);
CREATE INDEX IF NOT EXISTS major_action_events_failure_idx
  ON major_action_events(result,recorded_at DESC)
  WHERE result IN ('FAILURE','REJECTED','CONFLICT') OR ordering_state IN ('STALE','GAP');

CREATE TABLE IF NOT EXISTS major_action_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  major_action_event_id UUID NOT NULL REFERENCES major_action_events(id) ON DELETE RESTRICT,
  outcome_type TEXT NOT NULL CHECK (outcome_type ~ '^[A-Z][A-Z0-9_]{2,99}$'),
  outcome_object_type TEXT NOT NULL CHECK (outcome_object_type ~ '^[a-z][a-z0-9_]{1,63}$'),
  outcome_object_id TEXT NOT NULL CHECK (outcome_object_id ~ '^[A-Za-z0-9:_-]{2,200}$'),
  realized_result TEXT NOT NULL CHECK (realized_result IN (
    'CONFIRMED','FAILED','REVERSED','REFUNDED','HELD','NOT_REALIZED'
  )),
  realized_amount_cents INTEGER CHECK (realized_amount_cents IS NULL OR realized_amount_cents >= 0),
  currency CHAR(3) CHECK (currency IS NULL OR currency = 'usd'),
  payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  source_table TEXT NOT NULL CHECK (source_table ~ '^[a-z][a-z0-9_]{1,100}$'),
  source_event_id TEXT NOT NULL CHECK (source_event_id ~ '^[A-Za-z0-9:_.-]{2,240}$'),
  measured_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (major_action_event_id,outcome_type,outcome_object_type,outcome_object_id),
  UNIQUE (source_table,source_event_id,outcome_type)
);

CREATE INDEX IF NOT EXISTS major_action_outcomes_event_idx
  ON major_action_outcomes(major_action_event_id,measured_at DESC);

CREATE TABLE IF NOT EXISTS major_action_source_registry (
  action_class TEXT NOT NULL REFERENCES major_action_class_contracts(action_class) ON DELETE RESTRICT,
  platform TEXT NOT NULL CHECK (platform IN ('ENGINE','SUPABASE','CLIENT')),
  source_table TEXT NOT NULL CHECK (source_table ~ '^[a-z][a-z0-9_]{1,100}$'),
  trigger_name TEXT,
  source_contract_version TEXT NOT NULL,
  privacy_contract TEXT NOT NULL,
  PRIMARY KEY (action_class,platform,source_table),
  CHECK ((platform = 'ENGINE' AND trigger_name IS NOT NULL) OR platform <> 'ENGINE')
);

CREATE OR REPLACE FUNCTION prevent_major_action_evidence_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HXOBS1: major-action evidence is append-only' USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS major_action_events_immutable ON major_action_events;
CREATE TRIGGER major_action_events_immutable
BEFORE UPDATE OR DELETE ON major_action_events
FOR EACH ROW EXECUTE FUNCTION prevent_major_action_evidence_mutation();

DROP TRIGGER IF EXISTS major_action_events_no_truncate ON major_action_events;
CREATE TRIGGER major_action_events_no_truncate
BEFORE TRUNCATE ON major_action_events
FOR EACH STATEMENT EXECUTE FUNCTION prevent_major_action_evidence_mutation();

DROP TRIGGER IF EXISTS major_action_outcomes_immutable ON major_action_outcomes;
CREATE TRIGGER major_action_outcomes_immutable
BEFORE UPDATE OR DELETE ON major_action_outcomes
FOR EACH ROW EXECUTE FUNCTION prevent_major_action_evidence_mutation();

DROP TRIGGER IF EXISTS major_action_outcomes_no_truncate ON major_action_outcomes;
CREATE TRIGGER major_action_outcomes_no_truncate
BEFORE TRUNCATE ON major_action_outcomes
FOR EACH STATEMENT EXECUTE FUNCTION prevent_major_action_evidence_mutation();

DROP TRIGGER IF EXISTS major_action_classes_immutable ON major_action_class_contracts;
CREATE TRIGGER major_action_classes_immutable
BEFORE UPDATE OR DELETE ON major_action_class_contracts
FOR EACH ROW EXECUTE FUNCTION prevent_major_action_evidence_mutation();

DROP TRIGGER IF EXISTS major_action_sources_immutable ON major_action_source_registry;
CREATE TRIGGER major_action_sources_immutable
BEFORE UPDATE OR DELETE ON major_action_source_registry
FOR EACH ROW EXECUTE FUNCTION prevent_major_action_evidence_mutation();

CREATE OR REPLACE FUNCTION record_major_action_event(
  p_event_name TEXT,
  p_action_class TEXT,
  p_automation_class TEXT,
  p_actor_role TEXT,
  p_actor_ref TEXT,
  p_aggregate_type TEXT,
  p_aggregate_id TEXT,
  p_previous_lifecycle_state TEXT,
  p_lifecycle_state TEXT,
  p_sync_state TEXT,
  p_entry_surface TEXT,
  p_context_source TEXT,
  p_policy_version TEXT,
  p_policy_applicability TEXT,
  p_recommendation_id UUID,
  p_model_version TEXT,
  p_model_applicability TEXT,
  p_risk_class TEXT,
  p_correlation_id TEXT,
  p_causation_id TEXT,
  p_idempotency_key TEXT,
  p_source_sequence BIGINT,
  p_payload_hash TEXT,
  p_result TEXT,
  p_failure_reason_code TEXT,
  p_recovery_action_code TEXT,
  p_change_reason_code TEXT,
  p_experiment_variant TEXT,
  p_experiment_applicability TEXT,
  p_reversible BOOLEAN,
  p_source_table TEXT,
  p_source_event_id TEXT,
  p_occurred_at TIMESTAMPTZ,
  p_event_version INTEGER DEFAULT 1
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_existing major_action_events%ROWTYPE;
  v_id UUID;
  v_max_sequence BIGINT;
  v_sequence BIGINT;
  v_ordering_state TEXT;
  v_recorded_at TIMESTAMPTZ := clock_timestamp();
  v_latency_ms INTEGER;
  v_latency_class TEXT;
  v_is_test BOOLEAN;
  v_recovery_action_code TEXT := p_recovery_action_code;
BEGIN
  SELECT * INTO v_existing
  FROM major_action_events
  WHERE idempotency_key=p_idempotency_key AND event_version=p_event_version;

  IF FOUND THEN
    IF v_existing.payload_hash <> p_payload_hash
       OR v_existing.event_name <> p_event_name
       OR v_existing.aggregate_type <> p_aggregate_type
       OR v_existing.aggregate_id <> p_aggregate_id
       OR v_existing.result <> p_result THEN
      RAISE EXCEPTION 'HXOBS2: idempotency conflict for %', p_idempotency_key
        USING ERRCODE = 'P0001';
    END IF;
    RETURN v_existing.id;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext('major-action-sequence'),
    hashtext(p_action_class || ':' || p_aggregate_type || ':' || p_aggregate_id)
  );
  SELECT MAX(source_sequence) INTO v_max_sequence
  FROM major_action_events
  WHERE action_class=p_action_class
    AND aggregate_type=p_aggregate_type
    AND aggregate_id=p_aggregate_id;

  v_sequence := COALESCE(p_source_sequence,v_max_sequence + 1,1);
  v_ordering_state := CASE
    WHEN v_max_sequence IS NULL THEN 'ROOT'
    WHEN v_sequence <= v_max_sequence THEN 'STALE'
    WHEN v_sequence = v_max_sequence + 1 THEN 'IN_ORDER'
    ELSE 'GAP'
  END;
  IF v_ordering_state = 'GAP' AND v_recovery_action_code IS NULL THEN
    v_recovery_action_code := 'RECONCILE_SEQUENCE_GAP';
  END IF;

  v_latency_ms := GREATEST(0,ROUND(EXTRACT(EPOCH FROM (v_recorded_at-p_occurred_at))*1000)::INTEGER);
  v_latency_class := CASE
    WHEN v_latency_ms < 100 THEN 'LT_100MS'
    WHEN v_latency_ms < 500 THEN 'LT_500MS'
    WHEN v_latency_ms < 2000 THEN 'LT_2S'
    ELSE 'GTE_2S'
  END;
  v_is_test := COALESCE(NULLIF(current_setting('hustlexp.is_test',TRUE),'')::BOOLEAN,FALSE)
    OR current_database() ~* '(test|e2e|startup)';

  INSERT INTO major_action_events(
    event_name,event_version,action_class,automation_class,actor_role,actor_ref,
    aggregate_type,aggregate_id,previous_lifecycle_state,lifecycle_state,sync_state,
    entry_surface,context_source,policy_version,policy_applicability,
    recommendation_id,model_version,model_applicability,risk_class,
    correlation_id,causation_id,idempotency_key,source_sequence,ordering_state,
    environment,is_test,payload_hash,result,latency_ms,latency_class,
    failure_reason_code,recovery_action_code,change_reason_code,
    experiment_variant,experiment_applicability,reversible,source_table,
    source_event_id,occurred_at,recorded_at
  ) VALUES (
    p_event_name,p_event_version,p_action_class,p_automation_class,p_actor_role,p_actor_ref,
    p_aggregate_type,p_aggregate_id,p_previous_lifecycle_state,p_lifecycle_state,p_sync_state,
    p_entry_surface,p_context_source,p_policy_version,p_policy_applicability,
    p_recommendation_id,p_model_version,p_model_applicability,p_risk_class,
    p_correlation_id,p_causation_id,p_idempotency_key,v_sequence,v_ordering_state,
    CASE WHEN v_is_test THEN 'TEST' ELSE 'PRODUCTION' END,v_is_test,p_payload_hash,
    p_result,v_latency_ms,v_latency_class,p_failure_reason_code,v_recovery_action_code,
    p_change_reason_code,p_experiment_variant,p_experiment_applicability,p_reversible,
    p_source_table,p_source_event_id,p_occurred_at,v_recorded_at
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION record_major_action_outcome(
  p_major_action_event_id UUID,
  p_outcome_type TEXT,
  p_outcome_object_type TEXT,
  p_outcome_object_id TEXT,
  p_realized_result TEXT,
  p_realized_amount_cents INTEGER,
  p_currency TEXT,
  p_payload_hash TEXT,
  p_source_table TEXT,
  p_source_event_id TEXT,
  p_measured_at TIMESTAMPTZ
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_existing major_action_outcomes%ROWTYPE;
  v_id UUID;
BEGIN
  SELECT * INTO v_existing FROM major_action_outcomes
  WHERE source_table=p_source_table
    AND source_event_id=p_source_event_id
    AND outcome_type=p_outcome_type;
  IF FOUND THEN
    IF v_existing.major_action_event_id <> p_major_action_event_id
       OR v_existing.outcome_object_type <> p_outcome_object_type
       OR v_existing.outcome_object_id <> p_outcome_object_id
       OR v_existing.realized_result <> p_realized_result
       OR v_existing.realized_amount_cents IS DISTINCT FROM p_realized_amount_cents
       OR v_existing.currency IS DISTINCT FROM p_currency
       OR v_existing.payload_hash <> p_payload_hash THEN
      RAISE EXCEPTION 'HXOBS4: realized-outcome replay conflict for %/%',
        p_source_table,p_source_event_id USING ERRCODE='P0001';
    END IF;
    RETURN v_existing.id;
  END IF;
  INSERT INTO major_action_outcomes(
    major_action_event_id,outcome_type,outcome_object_type,outcome_object_id,
    realized_result,realized_amount_cents,currency,payload_hash,source_table,
    source_event_id,measured_at
  ) VALUES (
    p_major_action_event_id,p_outcome_type,p_outcome_object_type,p_outcome_object_id,
    p_realized_result,p_realized_amount_cents,p_currency,p_payload_hash,p_source_table,
    p_source_event_id,p_measured_at
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION mirror_major_action_source_event()
RETURNS TRIGGER LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_row JSONB := to_jsonb(NEW);
  v_action_class TEXT := TG_ARGV[0];
  v_aggregate_type TEXT := TG_ARGV[1];
  v_aggregate_key TEXT := TG_ARGV[2];
  v_source_id_key TEXT := TG_ARGV[3];
  v_actor_role TEXT := TG_ARGV[4];
  v_entry_surface TEXT := TG_ARGV[5];
  v_context_source TEXT := TG_ARGV[6];
  v_contract_policy TEXT := TG_ARGV[7];
  v_source_id TEXT;
  v_source_id_base TEXT;
  v_aggregate_id TEXT;
  v_event_type TEXT;
  v_event_name TEXT;
  v_actor_ref TEXT;
  v_previous_state TEXT;
  v_lifecycle_state TEXT;
  v_policy_version TEXT;
  v_policy_applicability TEXT;
  v_model_version TEXT := 'NOT_APPLICABLE';
  v_model_applicability TEXT := 'NOT_APPLICABLE';
  v_recommendation_id UUID;
  v_risk_class TEXT;
  v_result TEXT := 'SUCCESS';
  v_failure_code TEXT;
  v_recovery_code TEXT;
  v_occurred_at TIMESTAMPTZ;
  v_payload_hash TEXT;
  v_major_event_id UUID;
  v_automation_class TEXT;
  v_reversible BOOLEAN := TRUE;
  v_outcome_type TEXT;
  v_outcome_result TEXT;
  v_amount_cents INTEGER;
BEGIN
  v_source_id_base := COALESCE(v_row->>v_source_id_key,v_row->>'id');
  v_source_id := v_source_id_base;
  v_aggregate_id := COALESCE(v_row->>v_aggregate_key,v_source_id);
  IF v_source_id IS NULL OR v_aggregate_id IS NULL THEN
    RAISE EXCEPTION 'HXOBS3: source % lacks configured identity', TG_TABLE_NAME USING ERRCODE='P0001';
  END IF;

  v_event_type := COALESCE(
    v_row->>'event_type',v_row->>'action',v_row->>'outcome',v_row->>'state',v_row->>'result',v_row->>'type',
    CASE WHEN TG_OP='INSERT' THEN 'RECORDED' ELSE 'UPDATED' END
  );
  IF TG_TABLE_NAME='stripe_events' THEN
    v_event_type := COALESCE(v_row->>'type','PROVIDER_EVENT') || '_' || COALESCE(v_row->>'result','RECEIVED');
  END IF;
  IF TG_OP='UPDATE' THEN
    v_source_id := v_source_id_base || ':' || lower(regexp_replace(
      COALESCE(v_row->>'result',v_row->>'state',v_row->>'status',v_event_type),'[^A-Za-z0-9]+','_','g'
    )) || ':' || COALESCE(v_row->>'version','1');
  END IF;
  v_actor_ref := COALESCE(
    v_row->>'actor_id',v_row->>'actor_user_id',v_row->>'created_by',
    v_row->>'worker_id',v_row->>'initiated_by',
    CASE WHEN v_actor_role='PROVIDER' THEN 'PROVIDER' ELSE 'SYSTEM' END
  );
  v_previous_state := upper(COALESCE(
    CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD)->>'state' END,
    CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD)->>'status' END,
    CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD)->>'result' END,
    v_row->>'from_state','ROOT'));
  v_lifecycle_state := upper(COALESCE(
    v_row->>'to_state',v_row->>'state',v_row->>'status',v_row->>'result',v_row->>'outcome',v_event_type
  ));
  v_occurred_at := COALESCE(
    (v_row->>'occurred_at')::TIMESTAMPTZ,(v_row->>'measured_at')::TIMESTAMPTZ,
    (v_row->>'created_at')::TIMESTAMPTZ,clock_timestamp()
  );

  v_policy_version := COALESCE(v_row->>'policy_version',v_contract_policy);
  v_policy_applicability := CASE
    WHEN v_policy_version='NOT_APPLICABLE' THEN 'NOT_APPLICABLE'
    WHEN v_policy_version='UNATTRIBUTED' THEN 'UNATTRIBUTED'
    ELSE 'APPLIED'
  END;

  IF TG_TABLE_NAME IN ('recommendation_events','recommendation_outcomes') THEN
    v_recommendation_id := (v_row->>'recommendation_id')::UUID;
    SELECT recommendation.policy_version,
           COALESCE(recommendation.model_version,'NOT_APPLICABLE')
      INTO v_policy_version,v_model_version
    FROM recommendations recommendation WHERE recommendation.id=v_recommendation_id;
    v_policy_applicability := 'APPLIED';
    v_model_applicability := CASE WHEN v_model_version='NOT_APPLICABLE'
      THEN 'NOT_APPLICABLE' ELSE 'APPLIED' END;
  END IF;

  IF TG_TABLE_NAME='worker_offer_events' THEN
    SELECT decision.policy_version INTO v_policy_version
    FROM worker_offer_decisions decision WHERE decision.id=(v_row->>'offer_decision_id')::UUID;
    v_policy_applicability := 'APPLIED';
  ELSIF TG_TABLE_NAME='worker_counter_offer_events' THEN
    SELECT counter.policy_version INTO v_policy_version
    FROM worker_counter_offers counter WHERE counter.id=(v_row->>'counter_offer_id')::UUID;
    v_policy_applicability := 'APPLIED';
    v_actor_role := CASE WHEN lower(v_event_type)='submitted' THEN 'HUSTLER' ELSE 'POSTER' END;
  END IF;

  IF TG_TABLE_NAME='engine_automation_events' THEN
    v_action_class := CASE
      WHEN v_event_type IN ('TASK_IN_PROGRESS') THEN 'EXECUTION'
      WHEN v_event_type IN ('PAYOUT_READY','POSTER_CONFIRMED_COMPLETION') THEN 'PROOF_COMPLETION'
      WHEN v_event_type IN ('TASK_EXPIRED_UNFILLED') THEN 'DISPATCH'
      WHEN v_event_type LIKE 'PAYMENT_%' THEN 'PAYMENT'
      WHEN v_event_type LIKE 'COMPLETION_MESSAGE_%' THEN 'NOTIFICATION'
      ELSE 'AUTOMATION'
    END;
    v_policy_version := CASE
      WHEN v_action_class='EXECUTION' THEN 'task-execution-state-v1'
      WHEN v_action_class='PROOF_COMPLETION' THEN 'task-completion-policy-v1'
      WHEN v_action_class='DISPATCH' THEN 'dispatch-expiry-policy-v1'
      WHEN v_action_class='PAYMENT' THEN 'payment-reconciliation-policy-v1'
      WHEN v_action_class='NOTIFICATION' THEN 'completion-delivery-policy-v1'
      ELSE 'engine-automation-contract-v1'
    END;
    v_policy_applicability := 'APPLIED';
  ELSIF TG_TABLE_NAME='escrow_events' AND upper(COALESCE(v_row->>'to_state','')) IN ('RELEASED','REFUNDED') THEN
    v_action_class := 'SETTLEMENT';
  END IF;

  v_event_name := lower(v_action_class) || '.' || lower(regexp_replace(v_event_type,'[^A-Za-z0-9]+','_','g'));

  v_risk_class := CASE
    WHEN v_action_class IN ('SAFETY','TRUST_IDENTITY') THEN 'CRITICAL'
    WHEN v_action_class IN ('PAYMENT','SETTLEMENT','PAYOUT','DISPUTE') THEN 'HIGH'
    WHEN v_action_class IN ('PRICING_QUOTE','DISPATCH','OFFER_ASSIGNMENT','PROOF_COMPLETION') THEN 'MEDIUM'
    ELSE 'LOW'
  END;
  SELECT default_automation_class INTO v_automation_class
  FROM major_action_class_contracts WHERE action_class=v_action_class;
  v_reversible := v_automation_class NOT IN ('A5');

  IF lower(v_event_type) ~ '(fail|reject|blocked|contact_failed)' THEN
    v_result := CASE WHEN lower(v_event_type) ~ 'reject' THEN 'REJECTED' ELSE 'FAILURE' END;
    v_failure_code := upper(substr(regexp_replace(v_event_type,'[^A-Za-z0-9]+','_','g'),1,100));
    v_recovery_code := CASE WHEN v_action_class='SAFETY' THEN 'USE_ALTERNATE_SAFETY_CHANNEL'
      WHEN v_action_class IN ('PAYMENT','SETTLEMENT','PAYOUT') THEN 'RECONCILE_PROVIDER_STATE'
      ELSE 'RETRY_OR_ESCALATE' END;
  ELSIF lower(v_event_type) ~ '(pending|processing|submitted|opened|started)' THEN
    v_result := 'QUEUED';
  ELSIF lower(v_event_type) ~ '(stale|ignored)' THEN
    v_result := 'NOOP';
  END IF;
  IF TG_TABLE_NAME='outbox_events' AND lower(COALESCE(v_row->>'status','pending')) IN ('pending','enqueued') THEN
    v_result := 'QUEUED';
  END IF;

  v_payload_hash := encode(digest(concat_ws('|',
    'hxos-major-action-v1',v_action_class,v_event_name,v_actor_role,v_actor_ref,
    v_aggregate_type,v_aggregate_id,v_previous_state,v_lifecycle_state,
    v_policy_version,v_model_version,v_result,v_source_id
  ),'sha256'),'hex');

  v_major_event_id := record_major_action_event(
    v_event_name,v_action_class,v_automation_class,v_actor_role,v_actor_ref,
    v_aggregate_type,v_aggregate_id,v_previous_state,v_lifecycle_state,'SERVER_CONFIRMED',
    v_entry_surface,v_context_source,v_policy_version,v_policy_applicability,
    v_recommendation_id,v_model_version,v_model_applicability,v_risk_class,
    v_aggregate_type || ':' || v_aggregate_id,
    TG_TABLE_NAME || ':' || v_source_id,
    'major-action:' || TG_TABLE_NAME || ':' || v_source_id || ':' || lower(v_action_class),
    NULL,v_payload_hash,v_result,v_failure_code,v_recovery_code,
    'EVENT_' || upper(substr(regexp_replace(v_event_type,'[^A-Za-z0-9]+','_','g'),1,94)),
    'NOT_APPLICABLE','NOT_APPLICABLE',v_reversible,TG_TABLE_NAME,
    v_source_id || ':' || lower(v_action_class),v_occurred_at,1
  );

  IF TG_TABLE_NAME='task_scope_versions' AND v_action_class='INTENT_SCOPE' THEN
    PERFORM record_major_action_event(
      'pricing_quote.scope_priced','PRICING_QUOTE','A2','POSTER',v_actor_ref,
      'task',v_aggregate_id,v_previous_state,'PRICE_VERSIONED','SERVER_CONFIRMED',
      v_entry_surface,v_context_source,'task-scope-version-v1','APPLIED',
      NULL,'NOT_APPLICABLE','NOT_APPLICABLE','MEDIUM',
      'task:' || v_aggregate_id,TG_TABLE_NAME || ':' || v_source_id,
      'major-action:' || TG_TABLE_NAME || ':' || v_source_id || ':pricing_quote',
      NULL,encode(digest(v_payload_hash || '|pricing','sha256'),'hex'),'SUCCESS',NULL,NULL,
      'SCOPE_PRICE_VERSIONED','NOT_APPLICABLE','NOT_APPLICABLE',TRUE,TG_TABLE_NAME,
      v_source_id || ':pricing_quote',v_occurred_at,1
    );
  END IF;

  v_outcome_type := CASE
    WHEN TG_TABLE_NAME='recommendation_outcomes' THEN upper(v_row->>'outcome_type')
    WHEN TG_TABLE_NAME='worker_cash_out_events' AND upper(v_event_type) IN ('PAID','FAILED','REVERSED')
      THEN 'PAYOUT_' || upper(v_event_type)
    WHEN TG_TABLE_NAME='escrow_events' AND upper(v_lifecycle_state) IN ('RELEASED','REFUNDED')
      THEN 'ESCROW_' || upper(v_lifecycle_state)
    WHEN TG_TABLE_NAME='disputes' AND upper(v_lifecycle_state) IN ('RESOLVED','CLOSED')
      THEN 'DISPUTE_' || upper(v_lifecycle_state)
    WHEN TG_TABLE_NAME='task_safety_incident_events' AND lower(v_event_type) IN ('resolved','closed')
      THEN 'SAFETY_' || upper(v_event_type)
    ELSE NULL
  END;
  IF v_outcome_type IS NOT NULL THEN
    v_outcome_result := CASE
      WHEN v_outcome_type LIKE '%FAILED%' THEN 'FAILED'
      WHEN v_outcome_type LIKE '%REVERSED%' THEN 'REVERSED'
      WHEN v_outcome_type LIKE '%REFUNDED%' THEN 'REFUNDED'
      ELSE 'CONFIRMED'
    END;
    v_amount_cents := CASE WHEN (v_row->>'amount_cents') ~ '^[0-9]+$'
      THEN (v_row->>'amount_cents')::INTEGER ELSE NULL END;
    PERFORM record_major_action_outcome(
      v_major_event_id,v_outcome_type,v_aggregate_type,v_aggregate_id,v_outcome_result,
      v_amount_cents,CASE WHEN v_amount_cents IS NULL THEN NULL ELSE 'usd' END,
      encode(digest(v_payload_hash || '|outcome|' || v_outcome_type,'sha256'),'hex'),
      TG_TABLE_NAME,v_source_id || ':' || lower(v_action_class),v_occurred_at
    );
  END IF;

  RETURN NEW;
END;
$$;

-- Engine sources are real writers. The trigger arguments are:
-- action class, aggregate type, aggregate key, source id key, actor role,
-- entry surface, context source, source contract/policy version.
DROP TRIGGER IF EXISTS major_action_task_scope_versions ON task_scope_versions;
CREATE TRIGGER major_action_task_scope_versions AFTER INSERT ON task_scope_versions
FOR EACH ROW EXECUTE FUNCTION mirror_major_action_source_event(
  'INTENT_SCOPE','task','task_id','id','POSTER','TASK_CREATE','CANONICAL_ENGINE','task-scope-version-v1');

DROP TRIGGER IF EXISTS major_action_escrow_events ON escrow_events;
CREATE TRIGGER major_action_escrow_events AFTER INSERT ON escrow_events
FOR EACH ROW EXECUTE FUNCTION mirror_major_action_source_event(
  'PAYMENT','escrow','escrow_id','id','SYSTEM','PAYMENT_ENGINE','CANONICAL_ENGINE','escrow-state-machine-v1');

DROP TRIGGER IF EXISTS major_action_worker_offer_events ON worker_offer_events;
CREATE TRIGGER major_action_worker_offer_events AFTER INSERT ON worker_offer_events
FOR EACH ROW EXECUTE FUNCTION mirror_major_action_source_event(
  'OFFER_ASSIGNMENT','offer_decision','offer_decision_id','id','HUSTLER','OPPORTUNITY_DETAIL','CANONICAL_ENGINE','worker-offer-rights-v1');

DROP TRIGGER IF EXISTS major_action_worker_counter_offer_events ON worker_counter_offer_events;
CREATE TRIGGER major_action_worker_counter_offer_events AFTER INSERT ON worker_counter_offer_events
FOR EACH ROW EXECUTE FUNCTION mirror_major_action_source_event(
  'OFFER_ASSIGNMENT','counter_offer','counter_offer_id','id','HUSTLER','COUNTER_OFFER','CANONICAL_ENGINE','worker-counter-offer-v1');

DROP TRIGGER IF EXISTS major_action_engine_automation_events ON engine_automation_events;
CREATE TRIGGER major_action_engine_automation_events AFTER INSERT ON engine_automation_events
FOR EACH ROW EXECUTE FUNCTION mirror_major_action_source_event(
  'AUTOMATION','task','task_id','id','SYSTEM','AUTOMATION_SERVICE','POLICY_ENGINE','engine-automation-contract-v1');

DROP TRIGGER IF EXISTS major_action_worker_cash_out_events ON worker_cash_out_events;
CREATE TRIGGER major_action_worker_cash_out_events AFTER INSERT ON worker_cash_out_events
FOR EACH ROW EXECUTE FUNCTION mirror_major_action_source_event(
  'PAYOUT','cash_out_request','cash_out_request_id','id','HUSTLER','WALLET','PAYMENT_PROVIDER','worker-cash-out-v2');

DROP TRIGGER IF EXISTS major_action_task_safety_incident_events ON task_safety_incident_events;
CREATE TRIGGER major_action_task_safety_incident_events AFTER INSERT ON task_safety_incident_events
FOR EACH ROW EXECUTE FUNCTION mirror_major_action_source_event(
  'SAFETY','safety_incident','incident_id','id','USER','SAFETY_CENTER','SAFETY_SYSTEM','task-safety-incident-v1');

DROP TRIGGER IF EXISTS major_action_task_safety_checkin_events ON task_safety_checkin_events;
CREATE TRIGGER major_action_task_safety_checkin_events AFTER INSERT ON task_safety_checkin_events
FOR EACH ROW EXECUTE FUNCTION mirror_major_action_source_event(
  'SAFETY','safety_checkin','checkin_id','id','USER','FOCUS_MODE','SAFETY_SYSTEM','task-safety-checkin-v1');

DROP TRIGGER IF EXISTS major_action_worker_screening_events ON worker_screening_events;
CREATE TRIGGER major_action_worker_screening_events AFTER INSERT ON worker_screening_events
FOR EACH ROW EXECUTE FUNCTION mirror_major_action_source_event(
  'TRUST_IDENTITY','worker_screening','worker_id','id','SYSTEM','TRUST_CENTER','TRUST_SYSTEM','worker-screening-rights-v1');

DROP TRIGGER IF EXISTS major_action_worker_decision_appeal_events ON worker_decision_appeal_events;
CREATE TRIGGER major_action_worker_decision_appeal_events AFTER INSERT ON worker_decision_appeal_events
FOR EACH ROW EXECUTE FUNCTION mirror_major_action_source_event(
  'TRUST_IDENTITY','worker_appeal','appeal_id','id','USER','WORKER_RIGHTS','TRUST_SYSTEM','worker-appeal-v1');

DROP TRIGGER IF EXISTS major_action_business_audit_events ON business_audit_events;
CREATE TRIGGER major_action_business_audit_events AFTER INSERT ON business_audit_events
FOR EACH ROW EXECUTE FUNCTION mirror_major_action_source_event(
  'BUSINESS_OPERATION','business_object','object_id','id','BUSINESS','BUSINESS_WORKSPACE','CANONICAL_ENGINE','business-workspace-v1');

DROP TRIGGER IF EXISTS major_action_business_service_activation_events ON business_service_activation_events;
CREATE TRIGGER major_action_business_service_activation_events AFTER INSERT ON business_service_activation_events
FOR EACH ROW EXECUTE FUNCTION mirror_major_action_source_event(
  'BUSINESS_OPERATION','service_profile','service_profile_id','id','BUSINESS','BUSINESS_SERVICES','POLICY_ENGINE','business-operations-v1');

DROP TRIGGER IF EXISTS major_action_recurring_pause_events ON recurring_template_pause_events;
CREATE TRIGGER major_action_recurring_pause_events AFTER INSERT ON recurring_template_pause_events
FOR EACH ROW EXECUTE FUNCTION mirror_major_action_source_event(
  'RECURRING_WORK','recurring_template','template_id','id','USER','RECURRING_WORK','CANONICAL_ENGINE','recurring-work-v1');

DROP TRIGGER IF EXISTS major_action_recurring_recovery_events ON recurring_template_recovery_events;
CREATE TRIGGER major_action_recurring_recovery_events AFTER INSERT ON recurring_template_recovery_events
FOR EACH ROW EXECUTE FUNCTION mirror_major_action_source_event(
  'RECURRING_WORK','recurring_template','template_id','id','OPERATOR','RECURRING_RECOVERY','CANONICAL_ENGINE','recurring-work-v1');

DROP TRIGGER IF EXISTS major_action_recommendation_events ON recommendation_events;
CREATE TRIGGER major_action_recommendation_events AFTER INSERT ON recommendation_events
FOR EACH ROW EXECUTE FUNCTION mirror_major_action_source_event(
  'RECOMMENDATION','recommendation','recommendation_id','id','USER','RECOMMENDATION_SURFACE','DECISION_SUPPORT','recommendation-contract-v1');

DROP TRIGGER IF EXISTS major_action_recommendation_outcomes ON recommendation_outcomes;
CREATE TRIGGER major_action_recommendation_outcomes AFTER INSERT ON recommendation_outcomes
FOR EACH ROW EXECUTE FUNCTION mirror_major_action_source_event(
  'RECOMMENDATION','recommendation','recommendation_id','id','SYSTEM','OUTCOME_RECONCILIATION','CANONICAL_ENGINE','recommendation-contract-v1');

DROP TRIGGER IF EXISTS major_action_outbox_events ON outbox_events;
CREATE TRIGGER major_action_outbox_events AFTER INSERT ON outbox_events
FOR EACH ROW EXECUTE FUNCTION mirror_major_action_source_event(
  'NOTIFICATION','outbox_event','aggregate_id','id','SYSTEM','OUTBOX','DELIVERY_SYSTEM','outbox-contract-v1');

DROP TRIGGER IF EXISTS major_action_zone_category_cell_events ON zone_category_cell_events;
CREATE TRIGGER major_action_zone_category_cell_events AFTER INSERT ON zone_category_cell_events
FOR EACH ROW EXECUTE FUNCTION mirror_major_action_source_event(
  'LIQUIDITY','zone_category_cell','cell_id','id','SYSTEM','LIQUIDITY_CONTROL','POLICY_ENGINE','liquidity-cell-policy-v1');

DROP TRIGGER IF EXISTS major_action_external_bridge_events ON task_external_bridge_events;
CREATE TRIGGER major_action_external_bridge_events AFTER INSERT ON task_external_bridge_events
FOR EACH ROW EXECUTE FUNCTION mirror_major_action_source_event(
  'DISPATCH','task','task_id','id','USER','EXTERNAL_SHARE','CANONICAL_ENGINE','external-task-bridge-v1');

DROP TRIGGER IF EXISTS major_action_stripe_events ON stripe_events;
CREATE TRIGGER major_action_stripe_events AFTER INSERT OR UPDATE OF result ON stripe_events
FOR EACH ROW EXECUTE FUNCTION mirror_major_action_source_event(
  'PAYMENT','provider_event','stripe_event_id','stripe_event_id','PROVIDER','PROVIDER_WEBHOOK','PAYMENT_PROVIDER','NOT_APPLICABLE');

DROP TRIGGER IF EXISTS major_action_task_geofence_events ON task_geofence_events;
CREATE TRIGGER major_action_task_geofence_events AFTER INSERT ON task_geofence_events
FOR EACH ROW EXECUTE FUNCTION mirror_major_action_source_event(
  'EXECUTION','task','task_id','id','HUSTLER','FOCUS_MODE','GEOFENCE_SERVICE','task-geofence-v1');

DROP TRIGGER IF EXISTS major_action_disputes ON disputes;
CREATE TRIGGER major_action_disputes AFTER INSERT OR UPDATE OF state ON disputes
FOR EACH ROW EXECUTE FUNCTION mirror_major_action_source_event(
  'DISPUTE','dispute','id','id','USER','DISPUTE_CENTER','CANONICAL_ENGINE','dispute-state-machine-v1');

INSERT INTO major_action_source_registry(
  action_class,platform,source_table,trigger_name,source_contract_version,privacy_contract
) VALUES
  ('INTENT_SCOPE','ENGINE','task_scope_versions','major_action_task_scope_versions','task-scope-version-v1','normalized identifiers and state only'),
  ('PRICING_QUOTE','ENGINE','task_scope_versions','major_action_task_scope_versions','task-scope-version-v1','amount excluded from general telemetry'),
  ('PAYMENT','ENGINE','escrow_events','major_action_escrow_events','escrow-state-machine-v1','provider payload excluded'),
  ('PAYMENT','ENGINE','stripe_events','major_action_stripe_events','provider-event-v1','provider payload excluded'),
  ('PAYMENT','ENGINE','engine_automation_events','major_action_engine_automation_events','payment-reconciliation-policy-v1','provider payload and free text excluded'),
  ('DISPATCH','ENGINE','engine_automation_events','major_action_engine_automation_events','engine-automation-contract-v1','normalized identifiers and state only'),
  ('DISPATCH','ENGINE','task_external_bridge_events','major_action_external_bridge_events','external-task-bridge-v1','share tokens and contact data excluded'),
  ('OFFER_ASSIGNMENT','ENGINE','worker_offer_events','major_action_worker_offer_events','worker-offer-rights-v1','public notes excluded'),
  ('OFFER_ASSIGNMENT','ENGINE','worker_counter_offer_events','major_action_worker_counter_offer_events','worker-counter-offer-v1','counter rationale excluded'),
  ('EXECUTION','ENGINE','engine_automation_events','major_action_engine_automation_events','task-execution-state-v1','worker UUID only; no exact location'),
  ('EXECUTION','ENGINE','task_geofence_events','major_action_task_geofence_events','task-geofence-v1','raw latitude and longitude excluded'),
  ('PROOF_COMPLETION','ENGINE','engine_automation_events','major_action_engine_automation_events','task-completion-policy-v1','proof media and free text excluded'),
  ('SETTLEMENT','ENGINE','escrow_events','major_action_escrow_events','escrow-state-machine-v1','provider payload excluded'),
  ('PAYOUT','ENGINE','worker_cash_out_events','major_action_worker_cash_out_events','worker-cash-out-v2','destination and provider payload excluded'),
  ('DISPUTE','ENGINE','disputes','major_action_disputes','dispute-state-machine-v1','description and evidence excluded'),
  ('SAFETY','ENGINE','task_safety_incident_events','major_action_task_safety_incident_events','task-safety-incident-v1','message, metadata, location, and evidence excluded'),
  ('SAFETY','ENGINE','task_safety_checkin_events','major_action_task_safety_checkin_events','task-safety-checkin-v1','message, metadata, and location excluded'),
  ('TRUST_IDENTITY','ENGINE','worker_screening_events','major_action_worker_screening_events','worker-screening-rights-v1','identity evidence and notice text excluded'),
  ('TRUST_IDENTITY','ENGINE','worker_decision_appeal_events','major_action_worker_decision_appeal_events','worker-appeal-v1','appeal message excluded'),
  ('BUSINESS_OPERATION','ENGINE','business_audit_events','major_action_business_audit_events','business-workspace-v1','before and after payloads excluded'),
  ('BUSINESS_OPERATION','ENGINE','business_service_activation_events','major_action_business_service_activation_events','business-operations-v1','readiness payload excluded'),
  ('RECURRING_WORK','ENGINE','recurring_template_pause_events','major_action_recurring_pause_events','recurring-work-v1','evidence and reason text excluded'),
  ('RECURRING_WORK','ENGINE','recurring_template_recovery_events','major_action_recurring_recovery_events','recurring-work-v1','evidence and reason text excluded'),
  ('RECOMMENDATION','ENGINE','recommendation_events','major_action_recommendation_events','recommendation-contract-v1','public note and raw features excluded'),
  ('RECOMMENDATION','ENGINE','recommendation_outcomes','major_action_recommendation_outcomes','recommendation-contract-v1','realized payload excluded; normalized outcome retained'),
  ('AUTOMATION','ENGINE','engine_automation_events','major_action_engine_automation_events','engine-automation-contract-v1','source payload excluded'),
  ('NOTIFICATION','ENGINE','outbox_events','major_action_outbox_events','outbox-contract-v1','message content and destination excluded'),
  ('NOTIFICATION','ENGINE','engine_automation_events','major_action_engine_automation_events','completion-delivery-policy-v1','message content, channel destination, and provider payload excluded'),
  ('OFFLINE_SYNC','CLIENT','offline_action_outbox',NULL,'hxos-local-outbox-v1','encrypted client payload; normalized sync metadata only'),
  ('LIQUIDITY','ENGINE','zone_category_cell_events','major_action_zone_category_cell_events','liquidity-cell-policy-v1','aggregate cell metrics hash only')
ON CONFLICT (action_class,platform,source_table) DO UPDATE SET
  trigger_name=EXCLUDED.trigger_name,
  source_contract_version=EXCLUDED.source_contract_version,
  privacy_contract=EXCLUDED.privacy_contract;

COMMENT ON TABLE major_action_events IS
  'HX/OS normalized consequential-action ledger. Contains no raw JSON, free text, exact location, message, identity evidence, or provider payload.';
COMMENT ON COLUMN major_action_events.causation_id IS
  'Source command/provider/domain-event reference; root actions use their real idempotency/source reference rather than an invented parent event.';
COMMENT ON COLUMN major_action_events.latency_ms IS
  'Database ingest latency from the authoritative source event timestamp to normalized evidence recording.';
COMMENT ON TABLE major_action_outcomes IS
  'Privacy-safe realized outcome witnesses linked to the exact major action and authoritative source event.';
