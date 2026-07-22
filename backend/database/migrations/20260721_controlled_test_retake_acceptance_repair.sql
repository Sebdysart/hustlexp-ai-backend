-- Preserve explicit controlled-test offer acceptance while allowing the same
-- assigned worker to continue a poster-requested proof retake. A retake moves
-- PROOF_SUBMITTED back to ACCEPTED after the scope hash changes, but it is not
-- a new assignment and must not require an impossible OPEN-state offer replay.

BEGIN;

CREATE OR REPLACE FUNCTION enforce_controlled_test_offer_acceptance()
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

COMMIT;
