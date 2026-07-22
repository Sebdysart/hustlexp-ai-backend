-- Append-only, worker-authenticated offer review and acceptance evidence for the
-- local controlled TEST lifecycle. This never authorizes production work.

BEGIN;

CREATE TABLE IF NOT EXISTS hxos_local_test_offer_actions (
  id UUID PRIMARY KEY,
  action_type TEXT NOT NULL CHECK (action_type IN ('VIEWED','ACCEPTED')),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  worker_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  offer_decision_id UUID NOT NULL REFERENCES worker_offer_decisions(id) ON DELETE RESTRICT,
  duration_evidence_id UUID NOT NULL REFERENCES hxos_local_test_duration_evidence(id) ON DELETE RESTRICT,
  provider_capability_evidence_id UUID NOT NULL REFERENCES hxos_local_test_provider_capability_evidence(id) ON DELETE RESTRICT,
  liquidity_witness_id UUID NOT NULL REFERENCES hxos_local_test_liquidity_witnesses(id) ON DELETE RESTRICT,
  review_action_id UUID REFERENCES hxos_local_test_offer_actions(id) ON DELETE RESTRICT,
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  attestation_hash CHAR(64) NOT NULL CHECK (attestation_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  actor_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  environment TEXT NOT NULL CHECK (environment='CONTROLLED_TEST'),
  is_test BOOLEAN NOT NULL CHECK (is_test IS TRUE),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(worker_id,idempotency_key),
  UNIQUE(offer_decision_id,action_type),
  CONSTRAINT hxos_local_test_offer_action_shape CHECK (
    (action_type='VIEWED' AND review_action_id IS NULL)
    OR (action_type='ACCEPTED' AND review_action_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS hxos_local_test_offer_actions_task_worker_idx
  ON hxos_local_test_offer_actions(task_id,worker_id,created_at DESC);

CREATE OR REPLACE FUNCTION enforce_local_test_offer_snapshot_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_task tasks%ROWTYPE;
  v_duration hxos_local_test_duration_evidence%ROWTYPE;
  v_capability hxos_local_test_provider_capability_evidence%ROWTYPE;
  v_witness hxos_local_test_liquidity_witnesses%ROWTYPE;
  v_duration_id UUID;
  v_capability_id UUID;
  v_witness_id UUID;
BEGIN
  IF NEW.policy_version<>'hxos-worker-offer-v2' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_task FROM tasks WHERE id=NEW.task_id FOR SHARE;
  IF v_task.id IS NULL OR v_task.automation_classification<>'CONTROLLED_TEST' THEN
    RETURN NEW;
  END IF;
  IF (current_setting('hustlexp.local_test_offer_review_enabled',TRUE)='true') IS NOT TRUE THEN
    RAISE EXCEPTION 'HXOR1: local TEST offer-review authority is required' USING ERRCODE='P0001';
  END IF;
  BEGIN
    v_duration_id := (NEW.snapshot #>> '{evidence,durationEvidenceId}')::UUID;
    v_capability_id := (NEW.snapshot #>> '{evidence,providerCapabilityEvidenceId}')::UUID;
    v_witness_id := (NEW.snapshot #>> '{evidence,liquidityWitnessId}')::UUID;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'HXOR2: controlled TEST offer evidence identifiers are invalid' USING ERRCODE='P0001';
  END;
  SELECT * INTO v_duration FROM hxos_local_test_duration_evidence WHERE id=v_duration_id FOR SHARE;
  SELECT * INTO v_capability FROM hxos_local_test_provider_capability_evidence WHERE id=v_capability_id FOR SHARE;
  SELECT * INTO v_witness FROM hxos_local_test_liquidity_witnesses WHERE id=v_witness_id FOR SHARE;
  IF v_task.state NOT IN ('OPEN','MATCHING') OR v_task.worker_id IS NOT NULL
     OR v_task.poster_id=NEW.worker_id
     OR NEW.decision_ready IS NOT TRUE OR NEW.blocking_reasons<>'[]'::jsonb
     OR NEW.customer_total_cents<>v_task.price
     OR NEW.payout_cents IS DISTINCT FROM v_task.hustler_payout_cents
     OR NEW.scope_hash IS DISTINCT FROM v_task.scope_hash
     OR NEW.cancellation_policy_version IS DISTINCT FROM v_task.cancellation_policy_version
     OR NEW.estimated_duration_minutes IS DISTINCT FROM v_task.estimated_duration_minutes
     OR NEW.expires_at<=clock_timestamp()
     OR v_duration.id IS NULL OR v_duration.task_id<>v_task.id
     OR v_duration.duration_expected_minutes<>v_task.estimated_duration_minutes
     OR v_duration.policy_version<>'price-book-duration-v1'
     OR v_duration.environment<>'CONTROLLED_TEST' OR v_duration.source_environment<>'TEST'
     OR v_duration.is_test IS NOT TRUE
     OR v_capability.id IS NULL OR v_capability.task_id<>v_task.id
     OR v_capability.worker_id<>NEW.worker_id OR v_capability.category<>v_task.category
     OR v_capability.expires_at<=clock_timestamp()
     OR v_capability.environment<>'CONTROLLED_TEST' OR v_capability.is_test IS NOT TRUE
     OR v_witness.id IS NULL OR v_witness.task_id<>v_task.id
     OR v_witness.worker_id<>NEW.worker_id OR v_witness.cell_id<>v_task.liquidity_cell_id
     OR v_witness.provider_capability_evidence_id IS DISTINCT FROM v_capability.id
     OR v_witness.created_at<clock_timestamp()-INTERVAL '15 minutes'
     OR NOT hxos_local_test_liquidity_witness_current_v2(v_task.id,NEW.worker_id,v_task.liquidity_cell_id)
     OR EXISTS (
       SELECT 1 FROM unnest(v_task.required_tools) required_tool
       WHERE NOT EXISTS (
         SELECT 1 FROM unnest(v_capability.tools) provided_tool
         WHERE lower(trim(provided_tool))=lower(trim(required_tool))
       )
     ) THEN
    RAISE EXCEPTION 'HXOR3: controlled TEST offer evidence is stale or mismatched' USING ERRCODE='P0001';
  END IF;
  IF jsonb_typeof(NEW.snapshot #> '{logistics,distanceRangeMiles}')<>'object'
     OR jsonb_typeof(NEW.snapshot #> '{logistics,durationRangeMinutes}')<>'object'
     OR jsonb_typeof(NEW.snapshot #> '{scope,requiredTools}')<>'array'
     OR jsonb_typeof(NEW.snapshot #> '{ranking,reasons}')<>'array' THEN
    RAISE EXCEPTION 'HXOR4: controlled TEST offer snapshot is incomplete' USING ERRCODE='P0001';
  END IF;
  IF NEW.snapshot #>> '{decisionReady}'<>'true'
     OR NEW.snapshot #>> '{logistics,distanceEstimateKind}'<>'SERVICE_ZONE_RANGE'
     OR (NEW.snapshot #>> '{logistics,distanceRangeMiles,minimum}')::NUMERIC<>0
     OR (NEW.snapshot #>> '{logistics,distanceRangeMiles,maximum}')::NUMERIC<>v_capability.service_radius_miles
     OR NEW.snapshot #>> '{logistics,exactAddressDisclosed}'<>'false'
     OR nullif(trim(NEW.snapshot #>> '{logistics,distanceLabel}'),'') IS NULL
     OR nullif(trim(NEW.snapshot #>> '{logistics,travelTimeDisclosure}'),'') IS NULL
     OR (NEW.snapshot #>> '{logistics,estimatedDurationMinutes}')::INTEGER<>v_duration.duration_expected_minutes
     OR (NEW.snapshot #>> '{logistics,durationRangeMinutes,minimum}')::INTEGER<>v_duration.duration_min_minutes
     OR (NEW.snapshot #>> '{logistics,durationRangeMinutes,maximum}')::INTEGER<>v_duration.duration_max_minutes
     OR NEW.snapshot #>> '{logistics,durationPolicyVersion}'<>v_duration.policy_version
     OR NEW.snapshot #>> '{scope,scopeHash}' IS DISTINCT FROM v_task.scope_hash
     OR NEW.snapshot #>> '{scope,risk}' IS DISTINCT FROM v_task.risk_level
     OR NEW.snapshot #> '{scope,requiredTools}' IS DISTINCT FROM to_jsonb(v_task.required_tools)
     OR NEW.snapshot #>> '{cancellation,policyVersion}' IS DISTINCT FROM v_task.cancellation_policy_version
     OR NEW.snapshot #>> '{payment,availabilityState}'<>'PENDING_UNTIL_SERVER_CONFIRMED_SETTLEMENT'
     OR nullif(trim(NEW.snapshot #>> '{payment,timingDisclosure}'),'') IS NULL
     OR nullif(trim(NEW.snapshot #>> '{payment,externalDeliveryDisclosure}'),'') IS NULL
     OR NEW.snapshot #>> '{ranking,paidPromotionAffectsRank}'<>'false'
     OR NEW.snapshot #>> '{rights,passingHasRankPenalty}'<>'false'
     OR jsonb_array_length(NEW.snapshot #> '{ranking,reasons}')=0
     OR (NEW.snapshot #>> '{expiresAt}')::TIMESTAMPTZ IS DISTINCT FROM NEW.expires_at
     OR (NEW.snapshot #>> '{issuedAt}')::TIMESTAMPTZ>clock_timestamp()+INTERVAL '1 minute'
     OR (NEW.snapshot #>> '{issuedAt}')::TIMESTAMPTZ<clock_timestamp()-INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'HXOR4: controlled TEST offer snapshot is incomplete' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
EXCEPTION
  WHEN SQLSTATE 'P0001' THEN RAISE;
  WHEN OTHERS THEN
    RAISE EXCEPTION 'HXOR4: controlled TEST offer snapshot is malformed' USING ERRCODE='P0001';
END;
$$;

CREATE TRIGGER controlled_test_offer_snapshot_insert_guard
BEFORE INSERT ON worker_offer_decisions
FOR EACH ROW EXECUTE FUNCTION enforce_local_test_offer_snapshot_insert();

CREATE OR REPLACE FUNCTION enforce_local_test_offer_action_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_task tasks%ROWTYPE;
  v_offer worker_offer_decisions%ROWTYPE;
  v_review hxos_local_test_offer_actions%ROWTYPE;
BEGIN
  IF (current_setting('hustlexp.local_test_offer_review_enabled',TRUE)='true') IS NOT TRUE THEN
    RAISE EXCEPTION 'HXOR1: local TEST offer-review authority is required' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO v_task FROM tasks WHERE id=NEW.task_id FOR SHARE;
  SELECT * INTO v_offer FROM worker_offer_decisions WHERE id=NEW.offer_decision_id FOR SHARE;
  IF v_task.id IS NULL OR v_offer.id IS NULL
     OR v_task.automation_classification<>'CONTROLLED_TEST'
     OR v_task.state NOT IN ('OPEN','MATCHING') OR v_task.worker_id IS NOT NULL
     OR v_task.poster_id=NEW.worker_id OR NEW.actor_id<>NEW.worker_id
     OR NEW.environment<>'CONTROLLED_TEST' OR NEW.is_test IS NOT TRUE
     OR v_offer.task_id<>NEW.task_id OR v_offer.worker_id<>NEW.worker_id
     OR v_offer.policy_version<>'hxos-worker-offer-v2'
     OR v_offer.decision_ready IS NOT TRUE OR v_offer.expires_at<=clock_timestamp()
     OR v_offer.snapshot #>> '{evidence,durationEvidenceId}'<>NEW.duration_evidence_id::TEXT
     OR v_offer.snapshot #>> '{evidence,providerCapabilityEvidenceId}'<>NEW.provider_capability_evidence_id::TEXT
     OR v_offer.snapshot #>> '{evidence,liquidityWitnessId}'<>NEW.liquidity_witness_id::TEXT
     OR NOT hxos_local_test_liquidity_witness_current_v2(NEW.task_id,NEW.worker_id,v_task.liquidity_cell_id)
     OR NOT EXISTS (
       SELECT 1 FROM hxos_local_test_liquidity_witnesses witness
       WHERE witness.id=NEW.liquidity_witness_id
         AND witness.task_id=NEW.task_id AND witness.worker_id=NEW.worker_id
         AND witness.cell_id=v_task.liquidity_cell_id
         AND witness.provider_capability_evidence_id=NEW.provider_capability_evidence_id
         AND witness.created_at>=clock_timestamp()-INTERVAL '15 minutes'
     )
     OR NOT hxos_local_test_provider_capability_current(
       NEW.task_id,NEW.worker_id,NEW.provider_capability_evidence_id
     )
     OR NOT EXISTS (
       SELECT 1 FROM hxos_local_test_duration_evidence duration
       WHERE duration.id=NEW.duration_evidence_id AND duration.task_id=NEW.task_id
         AND duration.duration_expected_minutes=v_task.estimated_duration_minutes
     )
     OR NOT EXISTS (
       SELECT 1 FROM worker_offer_events event
       WHERE event.offer_decision_id=NEW.offer_decision_id
         AND event.event_type=NEW.action_type
         AND event.idempotency_key=NEW.idempotency_key
         AND event.request_hash=NEW.request_hash
     ) THEN
    RAISE EXCEPTION 'HXOR5: controlled TEST offer action is stale, mismatched, or unauthenticated' USING ERRCODE='P0001';
  END IF;
  IF NEW.action_type='VIEWED' THEN
    IF NEW.review_action_id IS NOT NULL
       OR v_offer.snapshot #>> '{evidence,reviewActionId}'<>NEW.id::TEXT THEN
      RAISE EXCEPTION 'HXOR6: controlled TEST review binding is invalid' USING ERRCODE='P0001';
    END IF;
  ELSE
    SELECT * INTO v_review FROM hxos_local_test_offer_actions WHERE id=NEW.review_action_id FOR SHARE;
    IF v_review.id IS NULL OR v_review.action_type<>'VIEWED'
       OR v_review.task_id<>NEW.task_id OR v_review.worker_id<>NEW.worker_id
       OR v_review.offer_decision_id<>NEW.offer_decision_id
       OR v_review.duration_evidence_id<>NEW.duration_evidence_id
       OR v_review.provider_capability_evidence_id<>NEW.provider_capability_evidence_id
       OR v_review.liquidity_witness_id<>NEW.liquidity_witness_id
       OR v_offer.snapshot #>> '{evidence,reviewActionId}'<>v_review.id::TEXT THEN
      RAISE EXCEPTION 'HXOR7: controlled TEST acceptance lacks its exact reviewed offer' USING ERRCODE='P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER controlled_test_offer_action_insert_guard
BEFORE INSERT ON hxos_local_test_offer_actions
FOR EACH ROW EXECUTE FUNCTION enforce_local_test_offer_action_insert();

CREATE OR REPLACE FUNCTION prevent_local_test_offer_action_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HXOR8: local TEST offer actions are append-only' USING ERRCODE='P0001';
END;
$$;

CREATE TRIGGER controlled_test_offer_actions_immutable
BEFORE UPDATE OR DELETE ON hxos_local_test_offer_actions
FOR EACH ROW EXECUTE FUNCTION prevent_local_test_offer_action_mutation();
CREATE TRIGGER controlled_test_offer_actions_truncate_guard
BEFORE TRUNCATE ON hxos_local_test_offer_actions
FOR EACH STATEMENT EXECUTE FUNCTION prevent_local_test_offer_action_mutation();

CREATE OR REPLACE FUNCTION hxos_local_test_offer_action_current(
  p_task_id UUID,p_worker_id UUID,p_offer_decision_id UUID,p_action_type TEXT
) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM hxos_local_test_offer_actions action
    JOIN worker_offer_decisions offer ON offer.id=action.offer_decision_id
    JOIN tasks task ON task.id=action.task_id
    JOIN hxos_local_test_duration_evidence duration ON duration.id=action.duration_evidence_id
    JOIN hxos_local_test_provider_capability_evidence capability
      ON capability.id=action.provider_capability_evidence_id
    JOIN hxos_local_test_liquidity_witnesses witness ON witness.id=action.liquidity_witness_id
    WHERE action.task_id=p_task_id AND action.worker_id=p_worker_id
      AND action.offer_decision_id=p_offer_decision_id AND action.action_type=p_action_type
      AND action.environment='CONTROLLED_TEST' AND action.is_test IS TRUE
      AND action.actor_id=action.worker_id
      AND offer.task_id=task.id AND offer.worker_id=action.worker_id
      AND offer.policy_version='hxos-worker-offer-v2'
      AND offer.decision_ready IS TRUE AND offer.expires_at>clock_timestamp()
      AND offer.customer_total_cents=task.price
      AND offer.payout_cents IS NOT DISTINCT FROM task.hustler_payout_cents
      AND offer.scope_hash IS NOT DISTINCT FROM task.scope_hash
      AND offer.cancellation_policy_version IS NOT DISTINCT FROM task.cancellation_policy_version
      AND offer.estimated_duration_minutes IS NOT DISTINCT FROM task.estimated_duration_minutes
      AND duration.task_id=task.id
      AND duration.duration_expected_minutes=task.estimated_duration_minutes
      AND capability.task_id=task.id AND capability.worker_id=action.worker_id
      AND hxos_local_test_provider_capability_current(task.id,action.worker_id,capability.id)
      AND witness.task_id=task.id AND witness.worker_id=action.worker_id
      AND witness.cell_id=task.liquidity_cell_id
      AND witness.provider_capability_evidence_id=capability.id
      AND witness.created_at>=clock_timestamp()-INTERVAL '15 minutes'
      AND hxos_local_test_liquidity_witness_current_v2(task.id,action.worker_id,task.liquidity_cell_id)
  )
$$;

CREATE OR REPLACE FUNCTION enforce_controlled_test_offer_acceptance()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='ACCEPTED' AND NEW.automation_classification='CONTROLLED_TEST'
     AND (TG_OP='INSERT' OR OLD.state IS DISTINCT FROM NEW.state OR OLD.worker_id IS DISTINCT FROM NEW.worker_id) THEN
    IF NEW.worker_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM hxos_local_test_offer_actions action
      WHERE action.task_id=NEW.id AND action.worker_id=NEW.worker_id
        AND action.action_type='ACCEPTED'
        AND hxos_local_test_offer_action_current(NEW.id,NEW.worker_id,action.offer_decision_id,'ACCEPTED')
    ) THEN
      RAISE EXCEPTION 'HXOR9: controlled TEST task acceptance lacks current explicit worker acceptance' USING ERRCODE='P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER controlled_test_offer_accept_guard
BEFORE INSERT OR UPDATE OF state,worker_id ON tasks
FOR EACH ROW EXECUTE FUNCTION enforce_controlled_test_offer_acceptance();

COMMENT ON TABLE hxos_local_test_offer_actions IS
  'Append-only authenticated review and acceptance evidence for complete controlled TEST worker offers. Never production consent proof.';

COMMIT;
