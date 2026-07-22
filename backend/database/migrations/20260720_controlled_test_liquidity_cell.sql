-- HX/OS controlled TEST liquidity authority. TEST supply is derived from one
-- currently eligible provider and one funded task. It never represents public
-- launch coverage, production availability, or an expansion signal.

ALTER TABLE zone_category_cells
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'PRODUCTION',
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'zone_category_cells'::regclass
      AND conname = 'zone_category_cells_environment_consistency'
  ) THEN
    ALTER TABLE zone_category_cells
      ADD CONSTRAINT zone_category_cells_environment_consistency CHECK (
        environment IN ('PRODUCTION','CONTROLLED_TEST')
        AND (
          (environment = 'PRODUCTION' AND is_test IS FALSE)
          OR (environment = 'CONTROLLED_TEST' AND is_test IS TRUE)
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'zone_category_cells'::regclass
      AND conname = 'zone_category_cells_test_shape'
  ) THEN
    ALTER TABLE zone_category_cells
      ADD CONSTRAINT zone_category_cells_test_shape CHECK (
        is_test IS FALSE OR (
          environment = 'CONTROLLED_TEST' AND is_test IS TRUE
          AND geo_zone ~ '^hxos-test-'
          AND policy_version = 'hxos-local-certification-liquidity-v1'
          AND state = 'LIMITED'
          AND launch_cell_enabled IS FALSE
          AND green_category IS FALSE
          AND dispatch_allowed IS TRUE
          AND public_instant_requests_allowed IS FALSE
          AND expansion_eligible IS FALSE
          AND max_concurrent_dispatches = 1
          AND active_verified_providers = 1
          AND anchor_demand_accounts = 1
          AND average_contribution_cents > 0
          AND metrics_computed_at IS NOT NULL
          AND state_reasons @> '["controlled_test_only"]'::jsonb
          AND state_reasons @> '["one_eligible_provider"]'::jsonb
          AND state_reasons @> '["not_public_liquidity"]'::jsonb
          AND state_reasons @> '["no_production_coverage_claim"]'::jsonb
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'zone_category_cells'::regclass
      AND conname = 'zone_category_cells_production_namespace'
  ) THEN
    ALTER TABLE zone_category_cells
      ADD CONSTRAINT zone_category_cells_production_namespace CHECK (
        is_test IS TRUE OR (
          geo_zone !~ '^hxos-test-'
          AND policy_version <> 'hxos-local-certification-liquidity-v1'
        )
      );
  END IF;
END;
$$;

DROP INDEX IF EXISTS zone_category_cells_public_idx;
CREATE INDEX zone_category_cells_public_idx
  ON zone_category_cells(state, evaluated_at DESC)
  WHERE launch_cell_enabled = TRUE
    AND environment = 'PRODUCTION' AND is_test IS FALSE;

CREATE TABLE IF NOT EXISTS hxos_local_test_liquidity_witnesses (
  id UUID PRIMARY KEY,
  cell_id UUID NOT NULL REFERENCES zone_category_cells(id) ON DELETE RESTRICT,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  worker_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  background_check_id UUID NOT NULL REFERENCES background_checks(id) ON DELETE RESTRICT,
  payout_destination_id TEXT NOT NULL REFERENCES hxos_local_test_payout_destinations(id) ON DELETE RESTRICT,
  provider_count INTEGER NOT NULL CHECK (provider_count = 1),
  contribution_cents INTEGER NOT NULL CHECK (contribution_cents > 0),
  policy_version TEXT NOT NULL CHECK (policy_version = 'hxos-local-certification-liquidity-v1'),
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  metrics_hash CHAR(64) NOT NULL CHECK (metrics_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  actor_id TEXT NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 128),
  is_test BOOLEAN NOT NULL DEFAULT TRUE CHECK (is_test IS TRUE),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (actor_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS hxos_local_test_liquidity_witness_task_idx
  ON hxos_local_test_liquidity_witnesses(task_id, cell_id, worker_id, created_at DESC);

CREATE OR REPLACE FUNCTION enforce_controlled_test_liquidity_cell_shape()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_test IS TRUE OR (TG_OP = 'UPDATE' AND OLD.is_test IS TRUE) THEN
    IF (current_setting('hustlexp.local_test_liquidity_enabled', TRUE) = 'true') IS NOT TRUE THEN
      RAISE EXCEPTION 'HXLQ1: local TEST liquidity authority is required' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.environment <> 'CONTROLLED_TEST'
       OR NEW.is_test IS NOT TRUE
       OR NEW.geo_zone !~ '^hxos-test-'
       OR NEW.policy_version <> 'hxos-local-certification-liquidity-v1'
       OR NEW.state <> 'LIMITED'
       OR NEW.launch_cell_enabled
       OR NEW.green_category
       OR NOT NEW.dispatch_allowed
       OR NEW.public_instant_requests_allowed
       OR NEW.expansion_eligible
       OR NEW.max_concurrent_dispatches <> 1
       OR NEW.active_verified_providers <> 1
       OR NEW.anchor_demand_accounts <> 1
       OR NEW.average_contribution_cents <= 0 THEN
      RAISE EXCEPTION 'HXLQ2: controlled TEST liquidity shape is invalid' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS controlled_test_liquidity_cell_shape_guard ON zone_category_cells;
CREATE TRIGGER controlled_test_liquidity_cell_shape_guard
BEFORE INSERT OR UPDATE ON zone_category_cells
FOR EACH ROW EXECUTE FUNCTION enforce_controlled_test_liquidity_cell_shape();

CREATE OR REPLACE FUNCTION enforce_controlled_test_liquidity_witness()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_task tasks%ROWTYPE;
  v_cell zone_category_cells%ROWTYPE;
  v_worker RECORD;
  v_active INTEGER;
BEGIN
  IF (current_setting('hustlexp.local_test_liquidity_enabled', TRUE) = 'true') IS NOT TRUE THEN
    RAISE EXCEPTION 'HXLQ3: local TEST liquidity witness authority is required' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.is_test IS NOT TRUE OR NEW.provider_count <> 1 THEN
    RAISE EXCEPTION 'HXLQ4: local TEST liquidity witness must represent exactly one TEST provider' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_task FROM tasks WHERE id = NEW.task_id FOR SHARE;
  SELECT * INTO v_cell FROM zone_category_cells WHERE id = NEW.cell_id FOR SHARE;
  IF v_task.id IS NULL OR v_cell.id IS NULL
     OR v_task.automation_classification <> 'CONTROLLED_TEST'
     OR v_task.state NOT IN ('OPEN','MATCHING')
     OR v_task.worker_id IS NOT NULL
     OR v_task.category <> v_cell.category
     OR v_cell.environment <> 'CONTROLLED_TEST'
     OR v_cell.is_test IS NOT TRUE
     OR v_cell.state <> 'LIMITED'
     OR v_cell.launch_cell_enabled
     OR v_cell.public_instant_requests_allowed
     OR v_cell.expansion_eligible
     OR NOT v_cell.dispatch_allowed
     OR v_cell.max_concurrent_dispatches <> 1
     OR v_cell.active_verified_providers <> 1
     OR v_cell.average_contribution_cents <> NEW.contribution_cents
     OR v_task.platform_margin_cents <> NEW.contribution_cents
     OR v_task.platform_margin_cents <= 0
     OR v_task.price <> v_task.hustler_payout_cents + v_task.platform_margin_cents
     OR NOT EXISTS (
       SELECT 1 FROM escrows escrow
       WHERE escrow.task_id = v_task.id AND escrow.state = 'FUNDED'
     ) THEN
    RAISE EXCEPTION 'HXLQ5: witness task or cell evidence is invalid' USING ERRCODE = 'P0001';
  END IF;

  SELECT worker.default_mode, worker.account_status, worker.is_minor, worker.is_banned,
         worker.trust_hold, worker.trust_hold_until, worker.trust_tier,
         worker.is_verified, worker.phone, worker.plan, profile.risk_clearance
    INTO v_worker
  FROM users worker
  JOIN capability_profiles profile ON profile.user_id = worker.id
  JOIN background_checks background
    ON background.id = NEW.background_check_id
   AND background.id = profile.background_check_source_id
   AND background.user_id = worker.id
   AND background.status = 'CLEAR'
   AND background.provider = 'local_certification_test'
   AND background.provider_environment = 'CONTROLLED_TEST'
   AND background.is_test IS TRUE
   AND (background.expires_at IS NULL OR background.expires_at > clock_timestamp())
  JOIN hxos_local_test_screening_reports report
    ON report.background_check_id = background.id
   AND report.worker_id = worker.id
   AND report.status = 'CLEAR'
   AND report.is_test IS TRUE
  JOIN hxos_local_test_payout_destinations destination
    ON destination.id = NEW.payout_destination_id
   AND destination.worker_id = worker.id
   AND destination.status = 'ACTIVE'
   AND destination.is_test IS TRUE
  WHERE worker.id = NEW.worker_id
    AND profile.background_check_valid IS TRUE
    AND profile.background_check_provider = 'local_certification_test'
    AND profile.background_check_environment = 'CONTROLLED_TEST'
    AND profile.background_check_is_test IS TRUE;

  IF NOT FOUND
     OR v_worker.default_mode <> 'worker'
     OR v_worker.account_status <> 'ACTIVE'
     OR v_worker.is_minor
     OR COALESCE(v_worker.is_banned, FALSE)
     OR (v_worker.trust_hold AND (v_worker.trust_hold_until IS NULL OR v_worker.trust_hold_until > clock_timestamp()))
     OR v_worker.trust_tier < GREATEST(
       COALESCE(v_task.trust_tier_required, 1),
       CASE v_task.risk_level WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 ELSE 1 END
     )
     OR NOT v_worker.is_verified
     OR NULLIF(BTRIM(v_worker.phone), '') IS NULL
     OR v_task.risk_level = 'IN_HOME'
     OR NOT (lower(v_task.risk_level) = ANY(v_worker.risk_clearance))
     OR v_task.price > (CASE WHEN v_worker.trust_tier = 1 THEN 5000 WHEN v_worker.trust_tier = 2 THEN 20000 ELSE 9999900 END)
     OR (v_task.risk_level = 'HIGH' AND v_worker.plan <> 'pro' AND NOT EXISTS (
       SELECT 1 FROM plan_entitlements entitlement
       WHERE entitlement.user_id = NEW.worker_id
         AND (entitlement.task_id IS NULL OR entitlement.task_id = NEW.task_id)
         AND entitlement.risk_level = 'HIGH'
         AND entitlement.expires_at > clock_timestamp()
     ))
     OR (v_task.license_required AND NOT EXISTS (
       SELECT 1 FROM license_verifications license
       WHERE license.user_id = NEW.worker_id
         AND license.trade_type = v_task.trade_type
         AND license.issuing_state = v_task.location_state
         AND lower(license.status) IN ('approved','verified')
         AND (license.expiration_date IS NULL OR license.expiration_date >= CURRENT_DATE)
     ))
     OR (v_task.insurance_required AND NOT EXISTS (
       SELECT 1 FROM insurance_verifications insurance
       WHERE insurance.user_id = NEW.worker_id
         AND lower(insurance.status) IN ('approved','verified')
         AND (insurance.expiration_date IS NULL OR insurance.expiration_date >= CURRENT_DATE)
     ))
     OR EXISTS (
       SELECT 1 FROM disputes dispute
       WHERE dispute.worker_id = NEW.worker_id
         AND dispute.state IN ('OPEN','EVIDENCE_REQUESTED','ESCALATED')
     ) THEN
    RAISE EXCEPTION 'HXLQ6: claimed TEST provider is not currently eligible' USING ERRCODE = 'P0001';
  END IF;

  SELECT COUNT(*) INTO v_active
  FROM tasks active_task
  WHERE active_task.worker_id = NEW.worker_id
    AND active_task.id <> NEW.task_id
    AND active_task.state IN ('ACCEPTED','PROOF_SUBMITTED','DISPUTED');
  IF v_active <> 0 THEN
    RAISE EXCEPTION 'HXLQ6: claimed TEST provider is already committed' USING ERRCODE = 'P0001';
  END IF;

  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS controlled_test_liquidity_witness_guard ON hxos_local_test_liquidity_witnesses;
CREATE TRIGGER controlled_test_liquidity_witness_guard
BEFORE INSERT ON hxos_local_test_liquidity_witnesses
FOR EACH ROW EXECUTE FUNCTION enforce_controlled_test_liquidity_witness();

CREATE OR REPLACE FUNCTION prevent_controlled_test_liquidity_witness_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HXLQ7: local TEST liquidity witnesses are append-only' USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS controlled_test_liquidity_witnesses_immutable ON hxos_local_test_liquidity_witnesses;
CREATE TRIGGER controlled_test_liquidity_witnesses_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON hxos_local_test_liquidity_witnesses
FOR EACH STATEMENT EXECUTE FUNCTION prevent_controlled_test_liquidity_witness_mutation();

CREATE OR REPLACE FUNCTION hxos_local_test_liquidity_witness_current(
  p_task_id UUID,
  p_worker_id UUID,
  p_cell_id UUID
) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM hxos_local_test_liquidity_witnesses witness
    JOIN tasks task ON task.id = witness.task_id
    JOIN zone_category_cells cell ON cell.id = witness.cell_id
    JOIN users worker ON worker.id = witness.worker_id
    JOIN capability_profiles profile ON profile.user_id = worker.id
    JOIN background_checks background
      ON background.id = witness.background_check_id
     AND background.id = profile.background_check_source_id
     AND background.user_id = worker.id
    JOIN hxos_local_test_screening_reports report
      ON report.background_check_id = background.id
     AND report.worker_id = worker.id
    JOIN hxos_local_test_payout_destinations destination
      ON destination.id = witness.payout_destination_id
     AND destination.worker_id = worker.id
    WHERE witness.task_id = p_task_id
      AND witness.worker_id = p_worker_id
      AND witness.cell_id = p_cell_id
      AND witness.is_test IS TRUE
      AND witness.provider_count = 1
      AND witness.created_at >= clock_timestamp() - INTERVAL '15 minutes'
      AND task.automation_classification = 'CONTROLLED_TEST'
      AND task.state IN ('OPEN','MATCHING')
      AND task.worker_id IS NULL
      AND task.category = cell.category
      AND task.platform_margin_cents = witness.contribution_cents
      AND task.platform_margin_cents > 0
      AND task.price = task.hustler_payout_cents + task.platform_margin_cents
      AND cell.environment = 'CONTROLLED_TEST'
      AND cell.is_test IS TRUE
      AND cell.geo_zone ~ '^hxos-test-'
      AND cell.state = 'LIMITED'
      AND cell.dispatch_allowed IS TRUE
      AND cell.launch_cell_enabled IS FALSE
      AND cell.public_instant_requests_allowed IS FALSE
      AND cell.expansion_eligible IS FALSE
      AND cell.max_concurrent_dispatches = 1
      AND cell.active_verified_providers = 1
      AND cell.average_contribution_cents = witness.contribution_cents
      AND cell.metrics_computed_at >= clock_timestamp() - INTERVAL '15 minutes'
      AND cell.evaluated_at >= clock_timestamp() - INTERVAL '15 minutes'
      AND worker.default_mode = 'worker'
      AND worker.account_status = 'ACTIVE'
      AND worker.is_minor IS FALSE
      AND COALESCE(worker.is_banned, FALSE) IS FALSE
      AND worker.is_verified IS TRUE
      AND NULLIF(BTRIM(worker.phone), '') IS NOT NULL
      AND NOT (worker.trust_hold AND (worker.trust_hold_until IS NULL OR worker.trust_hold_until > clock_timestamp()))
      AND profile.background_check_valid IS TRUE
      AND profile.background_check_provider = 'local_certification_test'
      AND profile.background_check_environment = 'CONTROLLED_TEST'
      AND profile.background_check_is_test IS TRUE
      AND background.status = 'CLEAR'
      AND background.provider = 'local_certification_test'
      AND background.provider_environment = 'CONTROLLED_TEST'
      AND background.is_test IS TRUE
      AND (background.expires_at IS NULL OR background.expires_at > clock_timestamp())
      AND report.status = 'CLEAR'
      AND report.is_test IS TRUE
      AND destination.status = 'ACTIVE'
      AND destination.is_test IS TRUE
      AND EXISTS (
        SELECT 1 FROM escrows escrow
        WHERE escrow.task_id = task.id AND escrow.state = 'FUNDED'
      )
      AND NOT EXISTS (
        SELECT 1 FROM disputes dispute
        WHERE dispute.worker_id = worker.id
          AND dispute.state IN ('OPEN','EVIDENCE_REQUESTED','ESCALATED')
      )
      AND NOT EXISTS (
        SELECT 1 FROM tasks active_task
        WHERE active_task.worker_id = worker.id
          AND active_task.id <> task.id
          AND active_task.state IN ('ACCEPTED','PROOF_SUBMITTED','DISPUTED')
      )
  );
$$;

CREATE OR REPLACE FUNCTION enforce_task_liquidity_cell_binding()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_cell zone_category_cells%ROWTYPE;
BEGIN
  IF NEW.liquidity_cell_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_cell FROM zone_category_cells WHERE id = NEW.liquidity_cell_id FOR SHARE;
  IF NOT FOUND OR v_cell.geo_zone <> NEW.geo_zone OR v_cell.category <> NEW.category THEN
    RAISE EXCEPTION 'HXLQ8: task does not match its liquidity cell' USING ERRCODE = 'P0001';
  END IF;

  IF v_cell.is_test IS TRUE THEN
    IF NEW.automation_classification <> 'CONTROLLED_TEST'
       OR (current_setting('hustlexp.local_test_liquidity_enabled', TRUE) = 'true') IS NOT TRUE THEN
      RAISE EXCEPTION 'HXLQ9: TEST liquidity cannot authorize production work' USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM hxos_local_test_liquidity_witnesses witness
      WHERE witness.task_id = NEW.id
        AND witness.cell_id = NEW.liquidity_cell_id
        AND hxos_local_test_liquidity_witness_current(NEW.id, witness.worker_id, NEW.liquidity_cell_id)
    ) THEN
      RAISE EXCEPTION 'HXLQ10: current TEST liquidity witness is required' USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.automation_classification <> 'PRODUCTION'
        OR v_cell.environment <> 'PRODUCTION'
        OR v_cell.is_test IS NOT FALSE THEN
    RAISE EXCEPTION 'HXLQ11: controlled or unclassified work cannot consume production liquidity' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_liquidity_cell_binding_guard ON tasks;
CREATE TRIGGER task_liquidity_cell_binding_guard
BEFORE INSERT OR UPDATE OF liquidity_cell_id, geo_zone, category, automation_classification ON tasks
FOR EACH ROW EXECUTE FUNCTION enforce_task_liquidity_cell_binding();

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
  IF TG_OP = 'UPDATE' AND OLD.state = 'ACCEPTED' AND OLD.worker_id IS NOT DISTINCT FROM NEW.worker_id THEN
    RETURN NEW;
  END IF;
  IF NEW.liquidity_cell_id IS NULL THEN
    RAISE EXCEPTION 'HXLC1: task has no authoritative liquidity cell' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_cell FROM zone_category_cells WHERE id = NEW.liquidity_cell_id FOR SHARE;
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
  ELSE
    IF NEW.automation_classification <> 'PRODUCTION'
       OR v_cell.environment <> 'PRODUCTION'
       OR v_cell.is_test IS NOT FALSE THEN
      RAISE EXCEPTION 'HXLQ11: controlled or unclassified work cannot consume production liquidity' USING ERRCODE = 'P0001';
    END IF;
    SELECT COUNT(DISTINCT category) INTO v_green_categories
    FROM zone_category_cells
    WHERE geo_zone = v_cell.geo_zone
      AND launch_cell_enabled = TRUE
      AND green_category = TRUE
      AND environment = 'PRODUCTION' AND is_test IS FALSE;
    IF v_green_categories < 2 OR v_green_categories > 3 THEN
      RAISE EXCEPTION 'HXLC7: launch requires two or three green categories' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NOT v_cell.dispatch_allowed OR v_cell.state NOT IN ('LIMITED','OPEN','DENSE') THEN
    RAISE EXCEPTION 'HXLC3: liquidity cell is not dispatchable' USING ERRCODE = 'P0001';
  END IF;
  IF v_cell.metrics_computed_at IS NULL OR v_cell.evaluated_at < NOW() - INTERVAL '15 minutes'
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

COMMENT ON COLUMN zone_category_cells.environment IS
  'PRODUCTION cells support public launch doctrine. CONTROLLED_TEST cells are isolated certification evidence only.';
COMMENT ON TABLE hxos_local_test_liquidity_witnesses IS
  'Append-only evidence binding one currently eligible TEST provider to one funded controlled task and non-public cell.';
