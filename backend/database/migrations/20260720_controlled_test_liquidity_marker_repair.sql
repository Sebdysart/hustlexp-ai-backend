-- Forward repair for SQL three-valued logic at the TEST liquidity marker
-- boundary. Missing, false, and malformed settings are all unauthorized.

CREATE OR REPLACE FUNCTION hxos_local_test_liquidity_marker_enabled()
RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
  SELECT (current_setting('hustlexp.local_test_liquidity_enabled', TRUE) = 'true') IS TRUE;
$$;

CREATE OR REPLACE FUNCTION enforce_local_test_liquidity_cell_marker()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_test IS TRUE AND NOT hxos_local_test_liquidity_marker_enabled() THEN
    RAISE EXCEPTION 'HXLQ1: local TEST liquidity authority is required' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.is_test IS TRUE
     AND NOT hxos_local_test_liquidity_marker_enabled() THEN
    RAISE EXCEPTION 'HXLQ1: local TEST liquidity authority is required' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS controlled_test_liquidity_marker_cell_guard ON zone_category_cells;
CREATE TRIGGER controlled_test_liquidity_marker_cell_guard
BEFORE INSERT OR UPDATE ON zone_category_cells
FOR EACH ROW EXECUTE FUNCTION enforce_local_test_liquidity_cell_marker();

CREATE OR REPLACE FUNCTION enforce_local_test_liquidity_witness_marker()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT hxos_local_test_liquidity_marker_enabled() THEN
    RAISE EXCEPTION 'HXLQ3: local TEST liquidity witness authority is required' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS controlled_test_liquidity_marker_witness_guard ON hxos_local_test_liquidity_witnesses;
CREATE TRIGGER controlled_test_liquidity_marker_witness_guard
BEFORE INSERT ON hxos_local_test_liquidity_witnesses
FOR EACH ROW EXECUTE FUNCTION enforce_local_test_liquidity_witness_marker();

CREATE OR REPLACE FUNCTION enforce_local_test_liquidity_task_marker()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_is_test BOOLEAN;
  v_requires_marker BOOLEAN;
BEGIN
  IF NEW.liquidity_cell_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT is_test INTO v_is_test
  FROM zone_category_cells
  WHERE id = NEW.liquidity_cell_id;
  v_requires_marker := TG_OP='INSERT'
    OR OLD.liquidity_cell_id IS DISTINCT FROM NEW.liquidity_cell_id
    OR OLD.geo_zone IS DISTINCT FROM NEW.geo_zone
    OR OLD.category IS DISTINCT FROM NEW.category
    OR OLD.automation_classification IS DISTINCT FROM NEW.automation_classification
    OR (OLD.worker_id IS DISTINCT FROM NEW.worker_id AND NEW.worker_id IS NOT NULL)
    OR (OLD.state IN ('OPEN','MATCHING') AND NEW.state='ACCEPTED');
  IF v_is_test IS TRUE AND v_requires_marker AND NOT hxos_local_test_liquidity_marker_enabled() THEN
    RAISE EXCEPTION 'HXLQ9: TEST liquidity cannot authorize production work' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_liquidity_marker_guard ON tasks;
CREATE TRIGGER task_liquidity_marker_guard
BEFORE INSERT OR UPDATE OF state,worker_id,liquidity_cell_id,geo_zone,category,automation_classification ON tasks
FOR EACH ROW EXECUTE FUNCTION enforce_local_test_liquidity_task_marker();

COMMENT ON FUNCTION hxos_local_test_liquidity_marker_enabled() IS
  'Fail-closed transaction marker: only the exact local TEST liquidity value true is authorized.';
