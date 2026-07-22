-- TEST liquidity authorizes assignment and cell binding. It must not require a
-- reservation-only marker for later proof, dispute, or completion transitions.

BEGIN;

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
  WHERE id=NEW.liquidity_cell_id;
  v_requires_marker := TG_OP='INSERT'
    OR OLD.liquidity_cell_id IS DISTINCT FROM NEW.liquidity_cell_id
    OR OLD.geo_zone IS DISTINCT FROM NEW.geo_zone
    OR OLD.category IS DISTINCT FROM NEW.category
    OR OLD.automation_classification IS DISTINCT FROM NEW.automation_classification
    OR (OLD.worker_id IS DISTINCT FROM NEW.worker_id AND NEW.worker_id IS NOT NULL)
    OR (OLD.state IN ('OPEN','MATCHING') AND NEW.state='ACCEPTED');
  IF v_is_test IS TRUE AND v_requires_marker
     AND NOT hxos_local_test_liquidity_marker_enabled() THEN
    RAISE EXCEPTION 'HXLQ9: TEST liquidity cannot authorize production work' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION enforce_local_test_liquidity_task_marker() IS
  'Requires local TEST liquidity authority only when binding a TEST cell or assigning a worker; later lifecycle state changes remain independently guarded.';

COMMIT;
