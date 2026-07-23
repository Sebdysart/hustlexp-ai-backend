-- A proof retake is a continuation by the already assigned worker, not a new
-- liquidity decision. Preserve capability-bound liquidity enforcement for all
-- initial or changed assignments while allowing that exact continuation.

BEGIN;

CREATE OR REPLACE FUNCTION enforce_controlled_test_provider_capability_on_accept()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='ACCEPTED' AND NEW.automation_classification='CONTROLLED_TEST'
     AND (TG_OP='INSERT' OR OLD.state IS DISTINCT FROM NEW.state OR OLD.worker_id IS DISTINCT FROM NEW.worker_id) THEN
    IF TG_OP='UPDATE'
       AND OLD.state='PROOF_SUBMITTED'
       AND NEW.state='ACCEPTED'
       AND OLD.worker_id IS NOT NULL
       AND OLD.worker_id IS NOT DISTINCT FROM NEW.worker_id THEN
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

COMMIT;
