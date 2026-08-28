-- HX/OS 2.0 financial truth: a dispute lock is an actual payout hold.
-- A LOCKED_DISPUTE escrow may reach RELEASED only after an authoritative
-- resolved worker-favor decision, or through the separately authorized service
-- override which sets a transaction-local marker and records an operator reason.

CREATE OR REPLACE FUNCTION prevent_escrow_terminal_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('RELEASED', 'REFUNDED', 'REFUND_PARTIAL')
     AND NEW.state <> OLD.state THEN
    RAISE EXCEPTION 'HX002: Cannot transition terminal escrow state % (escrow % is terminal and immutable)',
      OLD.state, OLD.id
      USING ERRCODE = 'HX002';
  END IF;

  IF OLD.state = 'LOCKED_DISPUTE' AND NEW.state = 'RELEASED'
     AND COALESCE(current_setting('hustlexp.dispute_release_override', true), '') <> 'true'
     AND NOT EXISTS (
       SELECT 1 FROM disputes
       WHERE escrow_id = OLD.id
         AND state = 'RESOLVED'
         AND outcome_escrow_action = 'RELEASE'
     ) THEN
    RAISE EXCEPTION 'HX002: Cannot release dispute-locked escrow % without resolved worker-favor authority', OLD.id
      USING ERRCODE = 'HX002';
  END IF;

  RETURN NEW;
END;
$$;
