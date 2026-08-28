-- HX/OS Build-Now unit-economics authority. Worker earnings include actual
-- active task time plus an attributable travel estimate. Production policy
-- thresholds require external approval; the isolated local certification lane
-- uses an explicitly labeled TEST hypothesis and never represents live policy.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE zone_category_cells
  ADD COLUMN IF NOT EXISTS minimum_provider_net_hourly_cents INTEGER,
  ADD COLUMN IF NOT EXISTS provider_earnings_policy_version TEXT,
  ADD COLUMN IF NOT EXISTS provider_earnings_policy_state TEXT,
  ADD COLUMN IF NOT EXISTS provider_earnings_policy_reference TEXT,
  ADD COLUMN IF NOT EXISTS provider_earnings_sample_size INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS average_provider_net_hourly_cents INTEGER NOT NULL DEFAULT 0;

-- The migration may touch an existing isolated certification cell only under
-- the same session authority required by its original database contract.
SELECT set_config('hustlexp.local_test_liquidity_enabled', 'true', TRUE);

UPDATE zone_category_cells
   SET minimum_provider_net_hourly_cents = 2000,
       provider_earnings_policy_version = 'hxos-provider-economics-test-v1',
       provider_earnings_policy_state = 'TEST_HYPOTHESIS',
       provider_earnings_policy_reference = NULL,
       provider_earnings_sample_size = 0,
       average_provider_net_hourly_cents = 0,
       updated_at = NOW()
 WHERE environment = 'CONTROLLED_TEST' AND is_test IS TRUE;

-- A production floor cannot be invented by a migration. Existing cells that
-- lack approved authority fail closed until Marketplace Governance records it.
WITH affected AS (
  SELECT id, state AS from_state, policy_version
    FROM zone_category_cells
   WHERE environment = 'PRODUCTION' AND is_test IS FALSE
     AND dispatch_allowed IS TRUE
     AND (
       minimum_provider_net_hourly_cents IS NULL
       OR NULLIF(BTRIM(provider_earnings_policy_version), '') IS NULL
       OR provider_earnings_policy_state IS DISTINCT FROM 'APPROVED'
       OR NULLIF(BTRIM(provider_earnings_policy_reference), '') IS NULL
     )
), changed AS (
  UPDATE zone_category_cells cell
     SET state = 'THROTTLED',
         state_reasons = CASE
           WHEN state_reasons @> '["provider_earnings_policy_unapproved"]'::jsonb
             THEN state_reasons
           ELSE state_reasons || '["provider_earnings_policy_unapproved"]'::jsonb
         END,
         dispatch_allowed = FALSE,
         public_instant_requests_allowed = FALSE,
         expansion_eligible = FALSE,
         max_concurrent_dispatches = 0,
         stable_since = NOW(),
         evaluated_at = NOW(),
         updated_at = NOW()
    FROM affected
   WHERE cell.id = affected.id
  RETURNING cell.id, affected.from_state, cell.policy_version, cell.state_reasons
)
INSERT INTO zone_category_cell_events(
  cell_id, from_state, to_state, policy_version, metrics_hash, reasons, actor_type, actor_id
)
SELECT id, from_state, 'THROTTLED', policy_version,
       encode(digest(jsonb_build_object(
         'reason', 'provider_earnings_policy_unapproved',
         'cellId', id,
         'policyVersion', policy_version
       )::text, 'sha256'), 'hex'),
       state_reasons, 'SYSTEM', '20260721_unit_economics_guardrails'
  FROM changed;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'zone_category_cells'::regclass
       AND conname = 'zone_category_cells_provider_economics_values'
  ) THEN
    ALTER TABLE zone_category_cells
      ADD CONSTRAINT zone_category_cells_provider_economics_values CHECK (
        (minimum_provider_net_hourly_cents IS NULL
          OR minimum_provider_net_hourly_cents > 0)
        AND provider_earnings_sample_size >= 0
        AND average_provider_net_hourly_cents >= 0
        AND (provider_earnings_policy_state IS NULL
          OR provider_earnings_policy_state IN ('TEST_HYPOTHESIS','APPROVED'))
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'zone_category_cells'::regclass
       AND conname = 'zone_category_cells_provider_economics_bundle'
  ) THEN
    ALTER TABLE zone_category_cells
      ADD CONSTRAINT zone_category_cells_provider_economics_bundle CHECK (
        (
          minimum_provider_net_hourly_cents IS NULL
          AND provider_earnings_policy_version IS NULL
          AND provider_earnings_policy_state IS NULL
          AND provider_earnings_policy_reference IS NULL
        ) OR (
          minimum_provider_net_hourly_cents > 0
          AND NULLIF(BTRIM(provider_earnings_policy_version), '') IS NOT NULL
          AND provider_earnings_policy_state IN ('TEST_HYPOTHESIS','APPROVED')
          AND (
            provider_earnings_policy_state <> 'APPROVED'
            OR NULLIF(BTRIM(provider_earnings_policy_reference), '') IS NOT NULL
          )
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'zone_category_cells'::regclass
       AND conname = 'zone_category_cells_dispatch_provider_economics'
  ) THEN
    ALTER TABLE zone_category_cells
      ADD CONSTRAINT zone_category_cells_dispatch_provider_economics CHECK (
        dispatch_allowed IS FALSE OR (
          minimum_provider_net_hourly_cents > 0
          AND NULLIF(BTRIM(provider_earnings_policy_version), '') IS NOT NULL
          AND (
            (
              environment = 'CONTROLLED_TEST' AND is_test IS TRUE
              AND provider_earnings_policy_state = 'TEST_HYPOTHESIS'
              AND provider_earnings_policy_version = 'hxos-provider-economics-test-v1'
              AND minimum_provider_net_hourly_cents = 2000
            ) OR (
              environment = 'PRODUCTION' AND is_test IS FALSE
              AND provider_earnings_policy_state = 'APPROVED'
              AND NULLIF(BTRIM(provider_earnings_policy_reference), '') IS NOT NULL
            )
          )
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'zone_category_cells'::regclass
       AND conname = 'zone_category_cells_mature_provider_economics'
  ) THEN
    ALTER TABLE zone_category_cells
      ADD CONSTRAINT zone_category_cells_mature_provider_economics CHECK (
        dispatch_allowed IS FALSE
        OR environment <> 'PRODUCTION'
        OR paid_tasks_30d < 30
        OR (
          provider_earnings_sample_size >= 30
          AND average_provider_net_hourly_cents >= minimum_provider_net_hourly_cents
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'zone_category_cells'::regclass
       AND conname = 'zone_category_cells_expansion_provider_economics'
  ) THEN
    ALTER TABLE zone_category_cells
      ADD CONSTRAINT zone_category_cells_expansion_provider_economics CHECK (
        expansion_eligible IS FALSE OR (
          environment = 'PRODUCTION' AND is_test IS FALSE
          AND provider_earnings_policy_state = 'APPROVED'
          AND provider_earnings_sample_size >= 30
          AND average_provider_net_hourly_cents >= minimum_provider_net_hourly_cents
        )
      );
  END IF;
END;
$$;

ALTER TABLE worker_offer_decisions
  ADD COLUMN IF NOT EXISTS estimated_travel_time_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS travel_time_policy_version TEXT,
  ADD COLUMN IF NOT EXISTS minimum_net_hourly_cents INTEGER,
  ADD COLUMN IF NOT EXISTS provider_earnings_policy_version TEXT,
  ADD COLUMN IF NOT EXISTS provider_earnings_floor_met BOOLEAN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'worker_offer_decisions'::regclass
       AND conname = 'worker_offer_decisions_provider_economics_ready'
  ) THEN
    ALTER TABLE worker_offer_decisions
      ADD CONSTRAINT worker_offer_decisions_provider_economics_ready CHECK (
        decision_ready IS FALSE OR (
          policy_version = 'hxos-worker-offer-v3'
          AND insurance_adjustment_cents >= 0
          AND net_payout_cents > 0
          AND estimated_net_hourly_cents > 0
          AND estimated_travel_time_minutes > 0
          AND NULLIF(BTRIM(travel_time_policy_version), '') IS NOT NULL
          AND minimum_net_hourly_cents > 0
          AND NULLIF(BTRIM(provider_earnings_policy_version), '') IS NOT NULL
          AND provider_earnings_floor_met IS TRUE
          AND estimated_net_hourly_cents >= minimum_net_hourly_cents
        )
      ) NOT VALID;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_worker_offer_decision_on_accept()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_offer worker_offer_decisions%ROWTYPE;
  v_cell zone_category_cells%ROWTYPE;
BEGIN
  IF NEW.state <> 'ACCEPTED' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.state IN ('ACCEPTED', 'PROOF_SUBMITTED')
     AND OLD.worker_id IS NOT NULL
     AND OLD.worker_id IS NOT DISTINCT FROM NEW.worker_id THEN
    RETURN NEW;
  END IF;
  IF NEW.worker_id IS NULL THEN
    RAISE EXCEPTION 'HXWO1: accepted task requires a worker' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_cell
    FROM zone_category_cells
   WHERE id = NEW.liquidity_cell_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXWO4: worker offer lacks current provider economics' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_offer
    FROM worker_offer_decisions
   WHERE task_id = NEW.id AND worker_id = NEW.worker_id
     AND policy_version = 'hxos-worker-offer-v3'
     AND decision_ready = TRUE AND expires_at > NOW()
   ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXWO2: no current accept-ready worker offer decision' USING ERRCODE = 'P0001';
  END IF;
  IF v_offer.customer_total_cents <> NEW.price
     OR v_offer.payout_cents IS DISTINCT FROM NEW.hustler_payout_cents
     OR v_offer.scope_hash IS DISTINCT FROM NEW.scope_hash
     OR v_offer.cancellation_policy_version IS DISTINCT FROM NEW.cancellation_policy_version
     OR v_offer.estimated_duration_minutes IS DISTINCT FROM NEW.estimated_duration_minutes THEN
    RAISE EXCEPTION 'HXWO3: worker offer no longer matches task economics or scope' USING ERRCODE = 'P0001';
  END IF;
  IF v_offer.insurance_adjustment_cents <> ROUND(NEW.price * 0.02)
     OR v_offer.net_payout_cents <> NEW.hustler_payout_cents - ROUND(NEW.price * 0.02)
     OR v_offer.estimated_travel_time_minutes IS NULL
     OR v_offer.estimated_travel_time_minutes <= 0
     OR NULLIF(BTRIM(v_offer.travel_time_policy_version), '') IS NULL
     OR v_offer.minimum_net_hourly_cents IS DISTINCT FROM v_cell.minimum_provider_net_hourly_cents
     OR v_offer.provider_earnings_policy_version IS DISTINCT FROM v_cell.provider_earnings_policy_version
     OR v_offer.provider_earnings_floor_met IS NOT TRUE
     OR v_offer.estimated_net_hourly_cents < v_offer.minimum_net_hourly_cents THEN
    RAISE EXCEPTION 'HXWO4: worker offer lacks current provider economics' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_worker_offer_accept_gate ON tasks;
CREATE TRIGGER task_worker_offer_accept_gate
BEFORE INSERT OR UPDATE OF state, worker_id ON tasks
FOR EACH ROW EXECUTE FUNCTION enforce_worker_offer_decision_on_accept();

CREATE OR REPLACE FUNCTION enforce_task_liquidity_cell_on_accept()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_cell zone_category_cells%ROWTYPE;
  v_active INTEGER;
  v_green_categories INTEGER;
BEGIN
  IF NEW.state <> 'ACCEPTED' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.state = 'ACCEPTED'
     AND OLD.worker_id IS NOT DISTINCT FROM NEW.worker_id THEN
    RETURN NEW;
  END IF;
  IF NEW.liquidity_cell_id IS NULL THEN
    RAISE EXCEPTION 'HXLC1: task has no authoritative liquidity cell' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_cell FROM zone_category_cells
   WHERE id = NEW.liquidity_cell_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXLC1: liquidity cell not found' USING ERRCODE = 'P0001';
  END IF;
  IF v_cell.geo_zone <> NEW.geo_zone OR v_cell.category <> NEW.category THEN
    RAISE EXCEPTION 'HXLC2: task does not match its liquidity cell' USING ERRCODE = 'P0001';
  END IF;

  IF v_cell.is_test IS TRUE THEN
    IF NEW.automation_classification <> 'CONTROLLED_TEST'
       OR (current_setting('hustlexp.local_test_liquidity_enabled', TRUE) = 'true') IS NOT TRUE
       OR NOT hxos_local_test_liquidity_witness_current(NEW.id, NEW.worker_id, NEW.liquidity_cell_id) THEN
      RAISE EXCEPTION 'HXLQ9: TEST liquidity cannot authorize production work' USING ERRCODE = 'P0001';
    END IF;
    IF v_cell.environment <> 'CONTROLLED_TEST'
       OR v_cell.provider_earnings_policy_state <> 'TEST_HYPOTHESIS'
       OR v_cell.provider_earnings_policy_version <> 'hxos-provider-economics-test-v1'
       OR v_cell.minimum_provider_net_hourly_cents <> 2000 THEN
      RAISE EXCEPTION 'HXLC8: provider earnings policy is not authorized' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    IF NEW.automation_classification <> 'PRODUCTION'
       OR v_cell.environment <> 'PRODUCTION'
       OR v_cell.is_test IS NOT FALSE THEN
      RAISE EXCEPTION 'HXLQ11: controlled or unclassified work cannot consume production liquidity' USING ERRCODE = 'P0001';
    END IF;
    IF v_cell.minimum_provider_net_hourly_cents IS NULL
       OR v_cell.minimum_provider_net_hourly_cents <= 0
       OR NULLIF(BTRIM(v_cell.provider_earnings_policy_version), '') IS NULL
       OR v_cell.provider_earnings_policy_state <> 'APPROVED'
       OR NULLIF(BTRIM(v_cell.provider_earnings_policy_reference), '') IS NULL THEN
      RAISE EXCEPTION 'HXLC8: provider earnings policy is not authorized' USING ERRCODE = 'P0001';
    END IF;
    IF v_cell.paid_tasks_30d >= 30 AND (
      v_cell.provider_earnings_sample_size < 30
      OR v_cell.average_provider_net_hourly_cents < v_cell.minimum_provider_net_hourly_cents
    ) THEN
      RAISE EXCEPTION 'HXLC9: mature cell provider earnings are below policy' USING ERRCODE = 'P0001';
    END IF;
    SELECT COUNT(DISTINCT category) INTO v_green_categories
      FROM zone_category_cells
     WHERE geo_zone = v_cell.geo_zone
       AND launch_cell_enabled = TRUE AND green_category = TRUE
       AND environment = 'PRODUCTION' AND is_test IS FALSE;
    IF v_green_categories < 2 OR v_green_categories > 3 THEN
      RAISE EXCEPTION 'HXLC7: launch requires two or three green categories' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NOT v_cell.dispatch_allowed OR v_cell.state NOT IN ('LIMITED','OPEN','DENSE') THEN
    RAISE EXCEPTION 'HXLC3: liquidity cell is not dispatchable' USING ERRCODE = 'P0001';
  END IF;
  IF v_cell.metrics_computed_at IS NULL
     OR v_cell.evaluated_at < NOW() - INTERVAL '15 minutes'
     OR v_cell.metrics_computed_at < NOW() - INTERVAL '15 minutes' THEN
    RAISE EXCEPTION 'HXLC4: liquidity cell decision is stale' USING ERRCODE = 'P0001';
  END IF;
  IF v_cell.average_contribution_cents <= 0 THEN
    RAISE EXCEPTION 'HXLC5: liquidity cell contribution is not positive' USING ERRCODE = 'P0001';
  END IF;
  SELECT COUNT(*) INTO v_active
    FROM tasks
   WHERE liquidity_cell_id = NEW.liquidity_cell_id
     AND id <> NEW.id
     AND state IN ('ACCEPTED','PROOF_SUBMITTED','DISPUTED');
  IF v_active >= v_cell.max_concurrent_dispatches THEN
    RAISE EXCEPTION 'HXLC6: liquidity cell concurrency limit reached' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_local_test_offer_v3_snapshot_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_task tasks%ROWTYPE;
  v_cell zone_category_cells%ROWTYPE;
  v_duration hxos_local_test_duration_evidence%ROWTYPE;
  v_capability hxos_local_test_provider_capability_evidence%ROWTYPE;
  v_witness hxos_local_test_liquidity_witnesses%ROWTYPE;
  v_duration_id UUID;
  v_capability_id UUID;
  v_witness_id UUID;
  v_expected_travel INTEGER;
  v_expected_hourly INTEGER;
BEGIN
  IF NEW.policy_version <> 'hxos-worker-offer-v3' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_task FROM tasks WHERE id = NEW.task_id FOR SHARE;
  IF v_task.id IS NULL OR v_task.automation_classification <> 'CONTROLLED_TEST' THEN
    RETURN NEW;
  END IF;
  IF (current_setting('hustlexp.local_test_offer_review_enabled', TRUE) = 'true') IS NOT TRUE THEN
    RAISE EXCEPTION 'HXOR1: local TEST offer-review authority is required' USING ERRCODE = 'P0001';
  END IF;
  BEGIN
    v_duration_id := (NEW.snapshot #>> '{evidence,durationEvidenceId}')::UUID;
    v_capability_id := (NEW.snapshot #>> '{evidence,providerCapabilityEvidenceId}')::UUID;
    v_witness_id := (NEW.snapshot #>> '{evidence,liquidityWitnessId}')::UUID;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'HXOR2: controlled TEST offer evidence identifiers are invalid' USING ERRCODE = 'P0001';
  END;
  SELECT * INTO v_cell FROM zone_category_cells
   WHERE id = v_task.liquidity_cell_id FOR SHARE;
  SELECT * INTO v_duration FROM hxos_local_test_duration_evidence
   WHERE id = v_duration_id FOR SHARE;
  SELECT * INTO v_capability FROM hxos_local_test_provider_capability_evidence
   WHERE id = v_capability_id FOR SHARE;
  SELECT * INTO v_witness FROM hxos_local_test_liquidity_witnesses
   WHERE id = v_witness_id FOR SHARE;
  v_expected_travel := CEIL(v_capability.service_radius_miles * 3.0)::INTEGER;
  v_expected_hourly := FLOOR(
    ((v_task.hustler_payout_cents - ROUND(v_task.price * 0.02)) * 60.0)
    / (v_duration.duration_expected_minutes + v_expected_travel)
  )::INTEGER;

  IF v_task.state NOT IN ('OPEN','MATCHING') OR v_task.worker_id IS NOT NULL
     OR v_task.poster_id = NEW.worker_id
     OR NEW.decision_ready IS NOT TRUE OR NEW.blocking_reasons <> '[]'::jsonb
     OR NEW.customer_total_cents <> v_task.price
     OR NEW.payout_cents IS DISTINCT FROM v_task.hustler_payout_cents
     OR NEW.insurance_adjustment_cents <> ROUND(v_task.price * 0.02)
     OR NEW.net_payout_cents <> v_task.hustler_payout_cents - ROUND(v_task.price * 0.02)
     OR NEW.scope_hash IS DISTINCT FROM v_task.scope_hash
     OR NEW.cancellation_policy_version IS DISTINCT FROM v_task.cancellation_policy_version
     OR NEW.estimated_duration_minutes IS DISTINCT FROM v_task.estimated_duration_minutes
     OR NEW.minimum_net_hourly_cents <> 2000
     OR NEW.provider_earnings_policy_version <> 'hxos-provider-economics-test-v1'
     OR NEW.provider_earnings_floor_met IS NOT TRUE
     OR NEW.estimated_travel_time_minutes IS DISTINCT FROM v_expected_travel
     OR NEW.travel_time_policy_version <> 'hxos-conservative-travel-v1'
     OR NEW.estimated_net_hourly_cents IS DISTINCT FROM v_expected_hourly
     OR NEW.estimated_net_hourly_cents < NEW.minimum_net_hourly_cents
     OR NEW.expires_at <= clock_timestamp()
     OR v_cell.id IS NULL OR v_cell.environment <> 'CONTROLLED_TEST' OR v_cell.is_test IS NOT TRUE
     OR v_cell.provider_earnings_policy_state <> 'TEST_HYPOTHESIS'
     OR v_cell.provider_earnings_policy_version <> 'hxos-provider-economics-test-v1'
     OR v_cell.minimum_provider_net_hourly_cents <> 2000
     OR v_duration.id IS NULL OR v_duration.task_id <> v_task.id
     OR v_duration.duration_expected_minutes <> v_task.estimated_duration_minutes
     OR v_duration.policy_version <> 'price-book-duration-v1'
     OR v_duration.environment <> 'CONTROLLED_TEST' OR v_duration.source_environment <> 'TEST'
     OR v_duration.is_test IS NOT TRUE
     OR v_capability.id IS NULL OR v_capability.task_id <> v_task.id
     OR v_capability.worker_id <> NEW.worker_id OR v_capability.category <> v_task.category
     OR v_capability.expires_at <= clock_timestamp()
     OR v_capability.environment <> 'CONTROLLED_TEST' OR v_capability.is_test IS NOT TRUE
     OR v_witness.id IS NULL OR v_witness.task_id <> v_task.id
     OR v_witness.worker_id <> NEW.worker_id OR v_witness.cell_id <> v_task.liquidity_cell_id
     OR v_witness.provider_capability_evidence_id IS DISTINCT FROM v_capability.id
     OR v_witness.created_at < clock_timestamp() - INTERVAL '15 minutes'
     OR NOT hxos_local_test_liquidity_witness_current_v2(
       v_task.id, NEW.worker_id, v_task.liquidity_cell_id
     )
     OR EXISTS (
       SELECT 1 FROM unnest(v_task.required_tools) required_tool
       WHERE NOT EXISTS (
         SELECT 1 FROM unnest(v_capability.tools) provided_tool
         WHERE lower(trim(provided_tool)) = lower(trim(required_tool))
       )
     ) THEN
    RAISE EXCEPTION 'HXOR3: controlled TEST offer evidence is stale or mismatched' USING ERRCODE = 'P0001';
  END IF;

  IF jsonb_typeof(NEW.snapshot #> '{logistics,distanceRangeMiles}') <> 'object'
     OR jsonb_typeof(NEW.snapshot #> '{logistics,durationRangeMinutes}') <> 'object'
     OR jsonb_typeof(NEW.snapshot #> '{scope,requiredTools}') <> 'array'
     OR jsonb_typeof(NEW.snapshot #> '{ranking,reasons}') <> 'array' THEN
    RAISE EXCEPTION 'HXOR4: controlled TEST offer snapshot is incomplete' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.snapshot #>> '{decisionReady}' <> 'true'
     OR NEW.snapshot #>> '{logistics,distanceEstimateKind}' <> 'SERVICE_ZONE_RANGE'
     OR (NEW.snapshot #>> '{logistics,distanceRangeMiles,minimum}')::NUMERIC <> 0
     OR (NEW.snapshot #>> '{logistics,distanceRangeMiles,maximum}')::NUMERIC
       <> v_capability.service_radius_miles
     OR NEW.snapshot #>> '{logistics,exactAddressDisclosed}' <> 'false'
     OR NULLIF(TRIM(NEW.snapshot #>> '{logistics,distanceLabel}'), '') IS NULL
     OR (NEW.snapshot #>> '{logistics,estimatedTravelTimeMinutes}')::INTEGER <> v_expected_travel
     OR NEW.snapshot #>> '{logistics,travelTimePolicyVersion}' <> 'hxos-conservative-travel-v1'
     OR NULLIF(TRIM(NEW.snapshot #>> '{logistics,travelTimeDisclosure}'), '') IS NULL
     OR (NEW.snapshot #>> '{logistics,estimatedDurationMinutes}')::INTEGER
       <> v_duration.duration_expected_minutes
     OR (NEW.snapshot #>> '{logistics,durationRangeMinutes,minimum}')::INTEGER
       <> v_duration.duration_min_minutes
     OR (NEW.snapshot #>> '{logistics,durationRangeMinutes,maximum}')::INTEGER
       <> v_duration.duration_max_minutes
     OR NEW.snapshot #>> '{logistics,durationPolicyVersion}' <> v_duration.policy_version
     OR (NEW.snapshot #>> '{economics,netPayoutCents}')::INTEGER <> NEW.net_payout_cents
     OR (NEW.snapshot #>> '{economics,estimatedNetHourlyCents}')::INTEGER
       <> NEW.estimated_net_hourly_cents
     OR (NEW.snapshot #>> '{economics,minimumNetHourlyCents}')::INTEGER
       <> NEW.minimum_net_hourly_cents
     OR NEW.snapshot #>> '{economics,providerEarningsFloorMet}' <> 'true'
     OR NEW.snapshot #>> '{scope,scopeHash}' IS DISTINCT FROM v_task.scope_hash
     OR NEW.snapshot #>> '{scope,risk}' IS DISTINCT FROM v_task.risk_level
     OR NEW.snapshot #> '{scope,requiredTools}' IS DISTINCT FROM to_jsonb(v_task.required_tools)
     OR NEW.snapshot #>> '{cancellation,policyVersion}'
       IS DISTINCT FROM v_task.cancellation_policy_version
     OR NEW.snapshot #>> '{payment,availabilityState}'
       <> 'PENDING_UNTIL_SERVER_CONFIRMED_SETTLEMENT'
     OR NULLIF(TRIM(NEW.snapshot #>> '{payment,timingDisclosure}'), '') IS NULL
     OR NULLIF(TRIM(NEW.snapshot #>> '{payment,externalDeliveryDisclosure}'), '') IS NULL
     OR NEW.snapshot #>> '{ranking,paidPromotionAffectsRank}' <> 'false'
     OR NEW.snapshot #>> '{rights,passingHasRankPenalty}' <> 'false'
     OR jsonb_array_length(NEW.snapshot #> '{ranking,reasons}') = 0
     OR (NEW.snapshot #>> '{expiresAt}')::TIMESTAMPTZ IS DISTINCT FROM NEW.expires_at
     OR (NEW.snapshot #>> '{issuedAt}')::TIMESTAMPTZ > clock_timestamp() + INTERVAL '1 minute'
     OR (NEW.snapshot #>> '{issuedAt}')::TIMESTAMPTZ < clock_timestamp() - INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'HXOR4: controlled TEST offer snapshot is incomplete' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
EXCEPTION
  WHEN SQLSTATE 'P0001' THEN RAISE;
  WHEN OTHERS THEN
    RAISE EXCEPTION 'HXOR4: controlled TEST offer snapshot is malformed' USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS controlled_test_offer_v3_snapshot_insert_guard
  ON worker_offer_decisions;
CREATE TRIGGER controlled_test_offer_v3_snapshot_insert_guard
BEFORE INSERT ON worker_offer_decisions
FOR EACH ROW EXECUTE FUNCTION enforce_local_test_offer_v3_snapshot_insert();

CREATE OR REPLACE FUNCTION enforce_local_test_offer_action_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_task tasks%ROWTYPE;
  v_offer worker_offer_decisions%ROWTYPE;
  v_review hxos_local_test_offer_actions%ROWTYPE;
BEGIN
  IF (current_setting('hustlexp.local_test_offer_review_enabled', TRUE) = 'true') IS NOT TRUE THEN
    RAISE EXCEPTION 'HXOR1: local TEST offer-review authority is required' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_task FROM tasks WHERE id = NEW.task_id FOR SHARE;
  SELECT * INTO v_offer FROM worker_offer_decisions WHERE id = NEW.offer_decision_id FOR SHARE;
  IF v_task.id IS NULL OR v_offer.id IS NULL
     OR v_task.automation_classification <> 'CONTROLLED_TEST'
     OR v_task.state NOT IN ('OPEN','MATCHING') OR v_task.worker_id IS NOT NULL
     OR v_task.poster_id = NEW.worker_id OR NEW.actor_id <> NEW.worker_id
     OR NEW.environment <> 'CONTROLLED_TEST' OR NEW.is_test IS NOT TRUE
     OR v_offer.task_id <> NEW.task_id OR v_offer.worker_id <> NEW.worker_id
     OR v_offer.policy_version <> 'hxos-worker-offer-v3'
     OR v_offer.decision_ready IS NOT TRUE OR v_offer.expires_at <= clock_timestamp()
     OR v_offer.provider_earnings_floor_met IS NOT TRUE
     OR v_offer.estimated_net_hourly_cents < v_offer.minimum_net_hourly_cents
     OR v_offer.snapshot #>> '{evidence,durationEvidenceId}' <> NEW.duration_evidence_id::TEXT
     OR v_offer.snapshot #>> '{evidence,providerCapabilityEvidenceId}'
       <> NEW.provider_capability_evidence_id::TEXT
     OR v_offer.snapshot #>> '{evidence,liquidityWitnessId}' <> NEW.liquidity_witness_id::TEXT
     OR NOT hxos_local_test_liquidity_witness_current_v2(
       NEW.task_id, NEW.worker_id, v_task.liquidity_cell_id
     )
     OR NOT EXISTS (
       SELECT 1 FROM hxos_local_test_liquidity_witnesses witness
        WHERE witness.id = NEW.liquidity_witness_id
          AND witness.task_id = NEW.task_id AND witness.worker_id = NEW.worker_id
          AND witness.cell_id = v_task.liquidity_cell_id
          AND witness.provider_capability_evidence_id = NEW.provider_capability_evidence_id
          AND witness.created_at >= clock_timestamp() - INTERVAL '15 minutes'
     )
     OR NOT hxos_local_test_provider_capability_current(
       NEW.task_id, NEW.worker_id, NEW.provider_capability_evidence_id
     )
     OR NOT EXISTS (
       SELECT 1 FROM hxos_local_test_duration_evidence duration
        WHERE duration.id = NEW.duration_evidence_id AND duration.task_id = NEW.task_id
          AND duration.duration_expected_minutes = v_task.estimated_duration_minutes
     )
     OR NOT EXISTS (
       SELECT 1 FROM worker_offer_events event
        WHERE event.offer_decision_id = NEW.offer_decision_id
          AND event.event_type = NEW.action_type
          AND event.idempotency_key = NEW.idempotency_key
          AND event.request_hash = NEW.request_hash
     ) THEN
    RAISE EXCEPTION 'HXOR5: controlled TEST offer action is stale, mismatched, or unauthenticated' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.action_type = 'VIEWED' THEN
    IF NEW.review_action_id IS NOT NULL
       OR v_offer.snapshot #>> '{evidence,reviewActionId}' <> NEW.id::TEXT THEN
      RAISE EXCEPTION 'HXOR6: controlled TEST review binding is invalid' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    SELECT * INTO v_review FROM hxos_local_test_offer_actions
     WHERE id = NEW.review_action_id FOR SHARE;
    IF v_review.id IS NULL OR v_review.action_type <> 'VIEWED'
       OR v_review.task_id <> NEW.task_id OR v_review.worker_id <> NEW.worker_id
       OR v_review.offer_decision_id <> NEW.offer_decision_id
       OR v_review.duration_evidence_id <> NEW.duration_evidence_id
       OR v_review.provider_capability_evidence_id <> NEW.provider_capability_evidence_id
       OR v_review.liquidity_witness_id <> NEW.liquidity_witness_id
       OR v_offer.snapshot #>> '{evidence,reviewActionId}' <> v_review.id::TEXT THEN
      RAISE EXCEPTION 'HXOR7: controlled TEST acceptance lacks its exact reviewed offer' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_local_test_offer_action_current(
  p_task_id UUID, p_worker_id UUID, p_offer_decision_id UUID, p_action_type TEXT
) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM hxos_local_test_offer_actions action
      JOIN worker_offer_decisions offer ON offer.id = action.offer_decision_id
      JOIN tasks task ON task.id = action.task_id
      JOIN zone_category_cells cell ON cell.id = task.liquidity_cell_id
      JOIN hxos_local_test_duration_evidence duration ON duration.id = action.duration_evidence_id
      JOIN hxos_local_test_provider_capability_evidence capability
        ON capability.id = action.provider_capability_evidence_id
      JOIN hxos_local_test_liquidity_witnesses witness
        ON witness.id = action.liquidity_witness_id
     WHERE action.task_id = p_task_id AND action.worker_id = p_worker_id
       AND action.offer_decision_id = p_offer_decision_id
       AND action.action_type = p_action_type
       AND action.environment = 'CONTROLLED_TEST' AND action.is_test IS TRUE
       AND action.actor_id = action.worker_id
       AND offer.task_id = task.id AND offer.worker_id = action.worker_id
       AND offer.policy_version = 'hxos-worker-offer-v3'
       AND offer.decision_ready IS TRUE AND offer.expires_at > clock_timestamp()
       AND offer.customer_total_cents = task.price
       AND offer.payout_cents IS NOT DISTINCT FROM task.hustler_payout_cents
       AND offer.net_payout_cents = task.hustler_payout_cents - ROUND(task.price * 0.02)
       AND offer.scope_hash IS NOT DISTINCT FROM task.scope_hash
       AND offer.cancellation_policy_version IS NOT DISTINCT FROM task.cancellation_policy_version
       AND offer.estimated_duration_minutes IS NOT DISTINCT FROM task.estimated_duration_minutes
       AND offer.estimated_travel_time_minutes > 0
       AND NULLIF(BTRIM(offer.travel_time_policy_version), '') IS NOT NULL
       AND offer.minimum_net_hourly_cents = cell.minimum_provider_net_hourly_cents
       AND offer.provider_earnings_policy_version = cell.provider_earnings_policy_version
       AND offer.provider_earnings_floor_met IS TRUE
       AND offer.estimated_net_hourly_cents >= offer.minimum_net_hourly_cents
       AND cell.environment = 'CONTROLLED_TEST' AND cell.is_test IS TRUE
       AND cell.provider_earnings_policy_state = 'TEST_HYPOTHESIS'
       AND duration.task_id = task.id
       AND duration.duration_expected_minutes = task.estimated_duration_minutes
       AND capability.task_id = task.id AND capability.worker_id = action.worker_id
       AND hxos_local_test_provider_capability_current(task.id, action.worker_id, capability.id)
       AND witness.task_id = task.id AND witness.worker_id = action.worker_id
       AND witness.cell_id = task.liquidity_cell_id
       AND witness.provider_capability_evidence_id = capability.id
       AND witness.created_at >= clock_timestamp() - INTERVAL '15 minutes'
       AND hxos_local_test_liquidity_witness_current_v2(
         task.id, action.worker_id, task.liquidity_cell_id
       )
  )
$$;

COMMIT;
