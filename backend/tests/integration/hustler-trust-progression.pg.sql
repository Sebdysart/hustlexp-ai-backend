\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  v_worker UUID;
  v_profile_tier INTEGER;
  v_clearance TEXT[];
  v_decision UUID;
BEGIN
  v_worker := gen_random_uuid();
  INSERT INTO users(
    id,email,full_name,default_mode,date_of_birth,is_minor,trust_tier,
    is_verified,verified_at,phone,stripe_connect_id,payouts_enabled
  ) VALUES(
    v_worker,'hxtrust-probe-'||v_worker::text||'@example.invalid',
    'HXTRUST Probe Worker','worker',DATE '1990-01-01',FALSE,0,
    FALSE,NULL,'+14255550199','acct_hxtrust_probe',TRUE
  );
  INSERT INTO capability_profiles(user_id,trust_tier,risk_clearance)
  VALUES(v_worker,0,ARRAY['low']::text[]);

  BEGIN
    UPDATE users SET trust_tier=1 WHERE id=v_worker;
    RAISE EXCEPTION 'HXTRUST_PROBE: unauthorized promotion unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXTRUST2:%' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM set_config('hustlexp.trust_promotion_authority','arbitrary-caller:probe',TRUE);
    UPDATE users SET trust_tier=1 WHERE id=v_worker;
    RAISE EXCEPTION 'HXTRUST_PROBE: arbitrary authority marker unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXTRUST2:%' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM set_config(
      'hustlexp.trust_promotion_authority',
      'hustler-trust-progression-v1:probe-skip',
      TRUE
    );
    UPDATE users SET trust_tier=2 WHERE id=v_worker;
    RAISE EXCEPTION 'HXTRUST_PROBE: skipped promotion unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXTRUST3:%' THEN RAISE; END IF;
  END;

  PERFORM set_config(
    'hustlexp.trust_promotion_authority',
    'hustler-trust-progression-v1:probe-sequential',
    TRUE
  );
  UPDATE users SET trust_tier=1 WHERE id=v_worker;

  SELECT trust_tier,risk_clearance INTO v_profile_tier,v_clearance
  FROM capability_profiles WHERE user_id=v_worker;
  IF v_profile_tier<>1 OR v_clearance<>ARRAY['low']::text[] THEN
    RAISE EXCEPTION 'HXTRUST_PROBE: capability profile did not synchronize';
  END IF;

  INSERT INTO trust_ledger(
    user_id,old_tier,new_tier,reason,reason_details,changed_by,
    idempotency_key,event_source,source_event_id
  ) VALUES(
    v_worker,0,1,'Probe Explorer to Verified','{"probe":true}'::jsonb,
    'system','hustler-trust-probe-ledger','system','hustler-trust-probe'
  );

  INSERT INTO worker_standing_decisions(
    worker_id,decision_type,decision_state,current_tier,target_tier,reason_codes,
    public_explanation,policy_version,decision_source,decided_by,
    source_idempotency_key,appeal_deadline_at
  ) VALUES(
    v_worker,'PROGRESSION','PROGRESSION_NOT_GRANTED',0,1,
    ARRAY['PROGRESSION_CRITERIA_NOT_MET'],
    'Explorer progression evidence requires review.',
    'hustler-trust-progression-v1','POLICY',NULL,
    'hustler-trust-probe-standing',clock_timestamp()+INTERVAL '1 day'
  ) RETURNING id INTO v_decision;
  IF v_decision IS NULL THEN
    RAISE EXCEPTION 'HXTRUST_PROBE: Tier 0 standing decision was not recorded';
  END IF;

  BEGIN
    PERFORM set_config(
      'hustlexp.trust_promotion_authority',
      'hustler-trust-progression-v1:probe-tier-5',
      TRUE
    );
    UPDATE users SET trust_tier=5 WHERE id=v_worker;
    RAISE EXCEPTION 'HXTRUST_PROBE: unsupported Tier 5 unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXTRUST1:%' THEN RAISE; END IF;
  END;
END;
$$;

SELECT 'HXTRUST probe passed: recognized authority, arbitrary witness rejection, sequential tiers, Tier 0 evidence, profile sync, Tier 5 rejection' AS result;

ROLLBACK;
