-- HX/OS adjacent expansion contract. Expansion decisions are payload-bound,
-- append-only, and may create only SEEDING cells. An exceptional preparation
-- request may create a CLOSED, launch-disabled cell but can never open dispatch.

CREATE TABLE IF NOT EXISTS liquidity_expansion_requests (
  id UUID PRIMARY KEY,
  source_cell_id UUID NOT NULL REFERENCES zone_category_cells(id) ON DELETE RESTRICT,
  target_cell_id UUID REFERENCES zone_category_cells(id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  actor_id TEXT NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 128),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  source_metrics_hash CHAR(64) NOT NULL CHECK (source_metrics_hash ~ '^[a-f0-9]{64}$'),
  policy_version TEXT NOT NULL,
  adjacency_kind TEXT NOT NULL CHECK (adjacency_kind IN ('GEOGRAPHY','CATEGORY','INVALID')),
  target_geo_zone TEXT NOT NULL,
  target_geography_label TEXT NOT NULL,
  target_category TEXT NOT NULL,
  target_operating_window TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('APPROVED','DENIED','OVERRIDE_PREPARED')),
  reasons JSONB NOT NULL CHECK (jsonb_typeof(reasons) = 'array' AND jsonb_array_length(reasons) > 0),
  override_owner TEXT,
  override_reason TEXT,
  override_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (actor_id, idempotency_key),
  UNIQUE (target_cell_id),
  CHECK (
    (decision = 'OVERRIDE_PREPARED'
      AND override_owner IS NOT NULL
      AND override_reason IS NOT NULL
      AND override_expires_at IS NOT NULL)
    OR
    (decision <> 'OVERRIDE_PREPARED'
      AND override_owner IS NULL
      AND override_reason IS NULL
      AND override_expires_at IS NULL)
  )
);

ALTER TABLE zone_category_cells
  ADD COLUMN IF NOT EXISTS expansion_request_id UUID
    REFERENCES liquidity_expansion_requests(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS zone_category_cells_expansion_request_unique
  ON zone_category_cells(expansion_request_id)
  WHERE expansion_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS liquidity_expansion_requests_source_time_idx
  ON liquidity_expansion_requests(source_cell_id, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_liquidity_expansion_request_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'liquidity_expansion_requests is append-only';
END;
$$;

DROP TRIGGER IF EXISTS liquidity_expansion_requests_immutable ON liquidity_expansion_requests;
CREATE TRIGGER liquidity_expansion_requests_immutable
BEFORE UPDATE OR DELETE ON liquidity_expansion_requests
FOR EACH ROW EXECUTE FUNCTION prevent_liquidity_expansion_request_mutation();

CREATE OR REPLACE FUNCTION enforce_expansion_created_cell_state()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_decision TEXT;
BEGIN
  IF NEW.expansion_request_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT decision INTO v_decision
  FROM liquidity_expansion_requests
  WHERE id = NEW.expansion_request_id AND target_cell_id = NEW.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXLC8: expansion request does not authorize this target' USING ERRCODE = 'P0001';
  END IF;
  IF v_decision = 'APPROVED' AND (
    NEW.state <> 'SEEDING' OR NOT NEW.launch_cell_enabled OR NOT NEW.green_category
    OR NEW.dispatch_allowed OR NEW.public_instant_requests_allowed
  ) THEN
    RAISE EXCEPTION 'HXLC9: approved expansion must begin as non-dispatching seeding' USING ERRCODE = 'P0001';
  END IF;
  IF v_decision = 'OVERRIDE_PREPARED' AND (
    NEW.state <> 'CLOSED' OR NEW.launch_cell_enabled OR NEW.green_category
    OR NEW.dispatch_allowed OR NEW.public_instant_requests_allowed
  ) THEN
    RAISE EXCEPTION 'HXLC10: override preparation cannot open a cell' USING ERRCODE = 'P0001';
  END IF;
  IF v_decision = 'DENIED' THEN
    RAISE EXCEPTION 'HXLC11: denied expansion cannot create a cell' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS expansion_created_cell_state_guard ON zone_category_cells;
CREATE TRIGGER expansion_created_cell_state_guard
BEFORE INSERT ON zone_category_cells
FOR EACH ROW EXECUTE FUNCTION enforce_expansion_created_cell_state();

CREATE OR REPLACE FUNCTION prevent_expansion_origin_rewrite()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.expansion_request_id IS DISTINCT FROM NEW.expansion_request_id THEN
    RAISE EXCEPTION 'HXLC12: expansion origin is immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS expansion_origin_immutable ON zone_category_cells;
CREATE TRIGGER expansion_origin_immutable
BEFORE UPDATE OF expansion_request_id ON zone_category_cells
FOR EACH ROW EXECUTE FUNCTION prevent_expansion_origin_rewrite();
