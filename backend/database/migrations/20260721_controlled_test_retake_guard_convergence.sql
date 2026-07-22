-- Converge every acceptance-time controlled-test guard on one definition of a
-- proof-retake continuation. This remains a same-worker lifecycle continuation
-- only; inserts, first assignments, and worker changes still require fresh
-- offer, capability, and liquidity evidence.

BEGIN;

CREATE OR REPLACE FUNCTION hxos_same_worker_proof_retake_continuation(
  p_old_state TEXT,
  p_new_state TEXT,
  p_old_worker_id UUID,
  p_new_worker_id UUID
) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_old_state='PROOF_SUBMITTED'
     AND p_new_state='ACCEPTED'
     AND p_old_worker_id IS NOT NULL
     AND p_old_worker_id IS NOT DISTINCT FROM p_new_worker_id
$$;

CREATE OR REPLACE FUNCTION enforce_controlled_test_offer_acceptance()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='ACCEPTED' AND NEW.automation_classification='CONTROLLED_TEST'
     AND (TG_OP='INSERT' OR OLD.state IS DISTINCT FROM NEW.state OR OLD.worker_id IS DISTINCT FROM NEW.worker_id) THEN
    IF TG_OP='UPDATE' AND hxos_same_worker_proof_retake_continuation(
      OLD.state::TEXT,NEW.state::TEXT,OLD.worker_id,NEW.worker_id
    ) THEN
      RETURN NEW;
    END IF;
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

CREATE OR REPLACE FUNCTION enforce_controlled_test_provider_capability_on_accept()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='ACCEPTED' AND NEW.automation_classification='CONTROLLED_TEST'
     AND (TG_OP='INSERT' OR OLD.state IS DISTINCT FROM NEW.state OR OLD.worker_id IS DISTINCT FROM NEW.worker_id) THEN
    IF TG_OP='UPDATE' AND hxos_same_worker_proof_retake_continuation(
      OLD.state::TEXT,NEW.state::TEXT,OLD.worker_id,NEW.worker_id
    ) THEN
      RETURN NEW;
    END IF;
    IF NEW.worker_id IS NULL OR NEW.liquidity_cell_id IS NULL
       OR NOT hxos_local_test_liquidity_witness_current_v2(NEW.id,NEW.worker_id,NEW.liquidity_cell_id) THEN
      RAISE EXCEPTION 'HXPC5: controlled TEST acceptance lacks capability-bound liquidity' USING ERRCODE='P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

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
  IF TG_OP='UPDATE' AND (
    (OLD.state='ACCEPTED' AND OLD.worker_id IS NOT DISTINCT FROM NEW.worker_id)
    OR hxos_same_worker_proof_retake_continuation(
      OLD.state::TEXT,NEW.state::TEXT,OLD.worker_id,NEW.worker_id
    )
  ) THEN
    RETURN NEW;
  END IF;
  IF NEW.liquidity_cell_id IS NULL THEN
    RAISE EXCEPTION 'HXLC1: task has no authoritative liquidity cell' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO v_cell FROM zone_category_cells
   WHERE id=NEW.liquidity_cell_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXLC1: liquidity cell not found' USING ERRCODE='P0001';
  END IF;
  IF v_cell.geo_zone<>NEW.geo_zone OR v_cell.category<>NEW.category THEN
    RAISE EXCEPTION 'HXLC2: task does not match its liquidity cell' USING ERRCODE='P0001';
  END IF;

  IF v_cell.is_test IS TRUE THEN
    IF NEW.automation_classification<>'CONTROLLED_TEST'
       OR (current_setting('hustlexp.local_test_liquidity_enabled',TRUE)='true') IS NOT TRUE
       OR NOT hxos_local_test_liquidity_witness_current(NEW.id,NEW.worker_id,NEW.liquidity_cell_id) THEN
      RAISE EXCEPTION 'HXLQ9: TEST liquidity cannot authorize production work' USING ERRCODE='P0001';
    END IF;
    IF v_cell.environment<>'CONTROLLED_TEST'
       OR v_cell.provider_earnings_policy_state<>'TEST_HYPOTHESIS'
       OR v_cell.provider_earnings_policy_version<>'hxos-provider-economics-test-v1'
       OR v_cell.minimum_provider_net_hourly_cents<>2000 THEN
      RAISE EXCEPTION 'HXLC8: provider earnings policy is not authorized' USING ERRCODE='P0001';
    END IF;
  ELSE
    IF NEW.automation_classification<>'PRODUCTION'
       OR v_cell.environment<>'PRODUCTION'
       OR v_cell.is_test IS NOT FALSE THEN
      RAISE EXCEPTION 'HXLQ11: controlled or unclassified work cannot consume production liquidity' USING ERRCODE='P0001';
    END IF;
    IF v_cell.minimum_provider_net_hourly_cents IS NULL
       OR v_cell.minimum_provider_net_hourly_cents<=0
       OR NULLIF(BTRIM(v_cell.provider_earnings_policy_version),'') IS NULL
       OR v_cell.provider_earnings_policy_state<>'APPROVED'
       OR NULLIF(BTRIM(v_cell.provider_earnings_policy_reference),'') IS NULL THEN
      RAISE EXCEPTION 'HXLC8: provider earnings policy is not authorized' USING ERRCODE='P0001';
    END IF;
    IF v_cell.paid_tasks_30d>=30 AND (
      v_cell.provider_earnings_sample_size<30
      OR v_cell.average_provider_net_hourly_cents<v_cell.minimum_provider_net_hourly_cents
    ) THEN
      RAISE EXCEPTION 'HXLC9: mature cell provider earnings are below policy' USING ERRCODE='P0001';
    END IF;
    SELECT COUNT(DISTINCT category) INTO v_green_categories
      FROM zone_category_cells
     WHERE geo_zone=v_cell.geo_zone
       AND launch_cell_enabled=TRUE AND green_category=TRUE
       AND environment='PRODUCTION' AND is_test IS FALSE;
    IF v_green_categories<2 OR v_green_categories>3 THEN
      RAISE EXCEPTION 'HXLC7: launch requires two or three green categories' USING ERRCODE='P0001';
    END IF;
  END IF;

  IF NOT v_cell.dispatch_allowed OR v_cell.state NOT IN ('LIMITED','OPEN','DENSE') THEN
    RAISE EXCEPTION 'HXLC3: liquidity cell is not dispatchable' USING ERRCODE='P0001';
  END IF;
  IF v_cell.metrics_computed_at IS NULL
     OR v_cell.evaluated_at<NOW()-INTERVAL '15 minutes'
     OR v_cell.metrics_computed_at<NOW()-INTERVAL '15 minutes' THEN
    RAISE EXCEPTION 'HXLC4: liquidity cell decision is stale' USING ERRCODE='P0001';
  END IF;
  IF v_cell.average_contribution_cents<=0 THEN
    RAISE EXCEPTION 'HXLC5: liquidity cell contribution is not positive' USING ERRCODE='P0001';
  END IF;
  SELECT COUNT(*) INTO v_active
    FROM tasks
   WHERE liquidity_cell_id=NEW.liquidity_cell_id
     AND id<>NEW.id
     AND state IN ('ACCEPTED','PROOF_SUBMITTED','DISPUTED');
  IF v_active>=v_cell.max_concurrent_dispatches THEN
    RAISE EXCEPTION 'HXLC6: liquidity cell concurrency limit reached' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION hxos_same_worker_proof_retake_continuation(TEXT,TEXT,UUID,UUID) IS
  'True only for the same assigned worker continuing from submitted proof into a requested retake.';

COMMIT;
