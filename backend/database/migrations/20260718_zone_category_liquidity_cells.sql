-- HX/OS launch-cell authority. Public promises, dispatch, and expansion consume
-- one versioned geography × category × operating-window decision.

CREATE TABLE IF NOT EXISTS zone_category_cells (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  geo_zone TEXT NOT NULL CHECK (geo_zone ~ '^[a-z0-9][a-z0-9_-]{1,79}$'),
  geography_label TEXT NOT NULL CHECK (char_length(geography_label) BETWEEN 2 AND 120),
  category TEXT NOT NULL CHECK (char_length(category) BETWEEN 1 AND 100),
  operating_window TEXT NOT NULL CHECK (char_length(operating_window) BETWEEN 2 AND 160),
  state TEXT NOT NULL CHECK (state IN ('CLOSED','SEEDING','LIMITED','OPEN','DENSE','THROTTLED','SUSPENDED')),
  policy_version TEXT NOT NULL,
  launch_cell_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  green_category BOOLEAN NOT NULL DEFAULT FALSE,
  metrics_computed_at TIMESTAMPTZ,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stable_since TIMESTAMPTZ,
  suspension_reason TEXT,
  state_reasons JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(state_reasons) = 'array'),
  completed_tasks_total INTEGER NOT NULL DEFAULT 0 CHECK (completed_tasks_total >= 0),
  paid_tasks_30d INTEGER NOT NULL DEFAULT 0 CHECK (paid_tasks_30d >= 0),
  fill_rate_30d NUMERIC(6,5) NOT NULL DEFAULT 0 CHECK (fill_rate_30d BETWEEN 0 AND 1),
  active_verified_providers INTEGER NOT NULL DEFAULT 0 CHECK (active_verified_providers >= 0),
  anchor_demand_accounts INTEGER NOT NULL DEFAULT 0 CHECK (anchor_demand_accounts >= 0),
  average_contribution_cents INTEGER NOT NULL DEFAULT 0,
  dispute_rate_30d NUMERIC(6,5) NOT NULL DEFAULT 0 CHECK (dispute_rate_30d BETWEEN 0 AND 1),
  no_show_rate_30d NUMERIC(6,5) NOT NULL DEFAULT 0 CHECK (no_show_rate_30d BETWEEN 0 AND 1),
  cancellation_rate_30d NUMERIC(6,5) NOT NULL DEFAULT 0 CHECK (cancellation_rate_30d BETWEEN 0 AND 1),
  repeat_demand_rate_30d NUMERIC(6,5) NOT NULL DEFAULT 0 CHECK (repeat_demand_rate_30d BETWEEN 0 AND 1),
  dispatch_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  public_instant_requests_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  expansion_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  max_concurrent_dispatches INTEGER NOT NULL DEFAULT 0 CHECK (max_concurrent_dispatches BETWEEN 0 AND 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (geo_zone, category, operating_window)
);

CREATE INDEX IF NOT EXISTS zone_category_cells_public_idx
  ON zone_category_cells(state, evaluated_at DESC)
  WHERE launch_cell_enabled = TRUE;

CREATE TABLE IF NOT EXISTS zone_category_cell_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cell_id UUID NOT NULL REFERENCES zone_category_cells(id) ON DELETE RESTRICT,
  from_state TEXT CHECK (from_state IS NULL OR from_state IN ('CLOSED','SEEDING','LIMITED','OPEN','DENSE','THROTTLED','SUSPENDED')),
  to_state TEXT NOT NULL CHECK (to_state IN ('CLOSED','SEEDING','LIMITED','OPEN','DENSE','THROTTLED','SUSPENDED')),
  policy_version TEXT NOT NULL,
  metrics_hash CHAR(64) NOT NULL CHECK (metrics_hash ~ '^[a-f0-9]{64}$'),
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reasons) = 'array'),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('POLICY','ADMIN','SYSTEM')),
  actor_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS zone_category_cell_events_cell_time_idx
  ON zone_category_cell_events(cell_id, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_zone_category_cell_event_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'zone_category_cell_events is append-only';
END;
$$;

DROP TRIGGER IF EXISTS zone_category_cell_events_immutable ON zone_category_cell_events;
CREATE TRIGGER zone_category_cell_events_immutable
BEFORE UPDATE OR DELETE ON zone_category_cell_events
FOR EACH ROW EXECUTE FUNCTION prevent_zone_category_cell_event_mutation();

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS geo_zone TEXT NOT NULL DEFAULT 'unmapped',
  ADD COLUMN IF NOT EXISTS liquidity_cell_id UUID REFERENCES zone_category_cells(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS tasks_liquidity_cell_active_idx
  ON tasks(liquidity_cell_id, state)
  WHERE state IN ('MATCHING','ACCEPTED','PROOF_SUBMITTED','DISPUTED');

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
  SELECT COUNT(DISTINCT category) INTO v_green_categories
  FROM zone_category_cells
  WHERE geo_zone = v_cell.geo_zone AND launch_cell_enabled = TRUE AND green_category = TRUE;
  IF v_green_categories < 2 OR v_green_categories > 3 THEN
    RAISE EXCEPTION 'HXLC7: launch requires two or three green categories' USING ERRCODE = 'P0001';
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

DROP TRIGGER IF EXISTS task_liquidity_cell_accept_gate ON tasks;
CREATE TRIGGER task_liquidity_cell_accept_gate
BEFORE INSERT OR UPDATE OF state, worker_id, liquidity_cell_id ON tasks
FOR EACH ROW EXECUTE FUNCTION enforce_task_liquidity_cell_on_accept();
