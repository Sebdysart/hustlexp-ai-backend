-- Enforce offer truth when assignment ownership is established, while allowing
-- an already assigned worker to revisit ACCEPTED after a proof retake. Approved
-- scope changes have their own immutable version and consent audit; requiring the
-- pre-change offer hash again would deadlock the legitimate retake lifecycle.

CREATE OR REPLACE FUNCTION enforce_worker_offer_decision_on_accept()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_offer worker_offer_decisions%ROWTYPE;
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
  SELECT * INTO v_offer
  FROM worker_offer_decisions
  WHERE task_id = NEW.id AND worker_id = NEW.worker_id
    AND decision_ready = TRUE AND expires_at > NOW()
  ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXWO2: no current accept-ready worker offer decision' USING ERRCODE = 'P0001';
  END IF;
  IF v_offer.customer_total_cents <> NEW.price
     OR v_offer.payout_cents IS DISTINCT FROM NEW.hustler_payout_cents
     OR v_offer.scope_hash IS DISTINCT FROM NEW.scope_hash THEN
    RAISE EXCEPTION 'HXWO3: worker offer no longer matches task economics or scope' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_worker_offer_accept_gate ON tasks;
CREATE TRIGGER task_worker_offer_accept_gate
BEFORE INSERT OR UPDATE OF state, worker_id ON tasks
FOR EACH ROW EXECUTE FUNCTION enforce_worker_offer_decision_on_accept();
