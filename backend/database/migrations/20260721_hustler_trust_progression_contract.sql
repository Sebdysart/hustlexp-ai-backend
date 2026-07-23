-- Canonical individual-provider trust progression.
-- 0 Explorer, 1 Verified, 2 Home Ready, 3 Pro, 4 Licensed Specialist.
-- Tier 5 Enterprise Crew is a later-phase organization model and is not stored
-- in users.trust_tier.

ALTER TABLE trust_ledger DROP CONSTRAINT IF EXISTS trust_ledger_old_tier_check;
ALTER TABLE trust_ledger DROP CONSTRAINT IF EXISTS trust_ledger_new_tier_check;
ALTER TABLE trust_ledger
  ADD CONSTRAINT trust_ledger_old_tier_check CHECK (old_tier BETWEEN 0 AND 4),
  ADD CONSTRAINT trust_ledger_new_tier_check CHECK (new_tier BETWEEN 0 AND 4);

ALTER TABLE worker_standing_decisions
  DROP CONSTRAINT IF EXISTS worker_standing_decisions_current_tier_check;
ALTER TABLE worker_standing_decisions
  DROP CONSTRAINT IF EXISTS worker_standing_decisions_target_tier_check;
ALTER TABLE worker_standing_decisions
  ADD CONSTRAINT worker_standing_decisions_current_tier_check
    CHECK (current_tier BETWEEN 0 AND 4),
  ADD CONSTRAINT worker_standing_decisions_target_tier_check
    CHECK (target_tier BETWEEN 1 AND 4);

CREATE OR REPLACE FUNCTION enforce_hustler_trust_tier_transition()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_authority TEXT;
BEGIN
  IF NEW.trust_tier IS NOT DISTINCT FROM OLD.trust_tier THEN
    RETURN NEW;
  END IF;
  IF NEW.trust_tier NOT BETWEEN 0 AND 4 THEN
    RAISE EXCEPTION 'HXTRUST1: individual provider trust tier must be between 0 and 4'
      USING ERRCODE='P0001';
  END IF;
  IF NEW.trust_tier > OLD.trust_tier THEN
    v_authority := current_setting('hustlexp.trust_promotion_authority', TRUE);
    IF COALESCE(v_authority, '') !~
       '^(hustler-trust-progression-v1|worker-standing-appeal):[A-Za-z0-9-]+$' THEN
      RAISE EXCEPTION 'HXTRUST2: trust promotion requires authoritative policy evaluation'
        USING ERRCODE='P0001';
    END IF;
    IF NEW.trust_tier <> OLD.trust_tier + 1 THEN
      RAISE EXCEPTION 'HXTRUST3: trust promotion cannot skip tiers'
        USING ERRCODE='P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS hustler_trust_tier_transition_guard ON users;
CREATE TRIGGER hustler_trust_tier_transition_guard
BEFORE UPDATE OF trust_tier ON users
FOR EACH ROW EXECUTE FUNCTION enforce_hustler_trust_tier_transition();

CREATE OR REPLACE FUNCTION synchronize_hustler_trust_capability_profile()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE capability_profiles
  SET trust_tier=NEW.trust_tier,
      risk_clearance=CASE NEW.trust_tier
        WHEN 0 THEN ARRAY['low']::text[]
        WHEN 1 THEN ARRAY['low']::text[]
        WHEN 2 THEN ARRAY['low','medium']::text[]
        ELSE ARRAY['low','medium','high']::text[]
      END,
      updated_at=clock_timestamp()
  WHERE user_id=NEW.id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS hustler_trust_capability_profile_sync ON users;
CREATE TRIGGER hustler_trust_capability_profile_sync
AFTER UPDATE OF trust_tier ON users
FOR EACH ROW
WHEN (OLD.trust_tier IS DISTINCT FROM NEW.trust_tier)
EXECUTE FUNCTION synchronize_hustler_trust_capability_profile();

COMMENT ON FUNCTION enforce_hustler_trust_tier_transition() IS
  'HX/OS trust authority: individual provider tiers are 0-4, upward transitions are sequential, and promotions require a transaction-local server policy witness.';
COMMENT ON FUNCTION synchronize_hustler_trust_capability_profile() IS
  'Keeps the derived dispatch profile synchronized with the canonical users.trust_tier after every promotion or demotion.';
