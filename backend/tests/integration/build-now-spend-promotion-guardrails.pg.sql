\set ON_ERROR_STOP on

BEGIN;

CREATE TEMP TABLE hx_spend_guard_context AS
SELECT users.ids[1] AS referrer_id,
       users.ids[2] AS referred_id,
       users.ids[3] AS second_referred_id,
       task.id AS task_id,
       task.poster_id
  FROM (
    SELECT array_agg(id ORDER BY id) AS ids
      FROM (SELECT id FROM users ORDER BY id LIMIT 3) selected_users
  ) users
  CROSS JOIN LATERAL (
    SELECT id,poster_id FROM tasks ORDER BY created_at,id LIMIT 1
  ) task;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM hx_spend_guard_context
     WHERE referrer_id IS NOT NULL AND referred_id IS NOT NULL
       AND second_referred_id IS NOT NULL AND task_id IS NOT NULL AND poster_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'spend guard fixture context is unavailable';
  END IF;
END;
$$;

INSERT INTO referral_codes(id,user_id,code,uses_count,active)
SELECT gen_random_uuid(),referrer_id,'HXGUARD1',0,TRUE FROM hx_spend_guard_context;

INSERT INTO referral_redemptions(
  referral_code_id,referrer_id,referred_id,referrer_reward_cents,referred_reward_cents
)
SELECT code.id,context.referrer_id,context.referred_id,0,0
  FROM hx_spend_guard_context context
  JOIN referral_codes code ON code.code='HXGUARD1';

DO $$
BEGIN
  BEGIN
    UPDATE referral_redemptions
       SET referrer_reward_cents=500,referrer_reward_paid=TRUE
     WHERE referred_id=(SELECT referred_id FROM hx_spend_guard_context);
    RAISE EXCEPTION 'cash referral incentive unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE '%HXINC1:%' THEN RAISE; END IF;
  END;

  BEGIN
    INSERT INTO referral_redemptions(
      referral_code_id,referrer_id,referred_id,referrer_reward_cents,referred_reward_cents
    )
    SELECT code.id,context.referrer_id,context.second_referred_id,500,0
      FROM hx_spend_guard_context context
      JOIN referral_codes code ON code.code='HXGUARD1';
    RAISE EXCEPTION 'cash referral incentive unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE '%HXINC1:%' THEN RAISE; END IF;
  END;
END;
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO daily_challenges(
      challenge_date,title,description,challenge_type,target_value,xp_reward,bonus_cents,active
    ) VALUES (
      CURRENT_DATE,'Cash challenge','Forbidden Build-Now cash spend','complete_task',1,10,500,TRUE
    );
    RAISE EXCEPTION 'cash challenge incentive unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE '%HXINC2:%' THEN RAISE; END IF;
  END;
END;
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO featured_listings(
      task_id,poster_id,feature_type,fee_cents,stripe_payment_intent_id,
      expires_at,active,payment_status
    )
    SELECT task_id,poster_id,'promoted',299,'pi_disabled',NOW()+INTERVAL '1 day',FALSE,'pending'
      FROM hx_spend_guard_context;
    RAISE EXCEPTION 'paid promotion insert unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE '%HXPROMO1:%' THEN RAISE; END IF;
  END;
END;
$$;

ALTER TABLE featured_listings DISABLE TRIGGER build_now_paid_promotion_guard;
INSERT INTO featured_listings(
  task_id,poster_id,feature_type,fee_cents,stripe_payment_intent_id,
  expires_at,active,payment_status
)
SELECT task_id,poster_id,'promoted',299,'pi_historical',NOW()+INTERVAL '1 day',FALSE,'pending'
  FROM hx_spend_guard_context;
ALTER TABLE featured_listings ENABLE TRIGGER build_now_paid_promotion_guard;

DO $$
BEGIN
  BEGIN
    UPDATE featured_listings SET active=TRUE,payment_status='paid'
     WHERE stripe_payment_intent_id='pi_historical';
    RAISE EXCEPTION 'paid promotion activation unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE '%HXPROMO1:%' THEN RAISE; END IF;
  END;
END;
$$;

ROLLBACK;

SELECT 'BUILD_NOW_SPEND_PROMOTION_GUARDRAILS_DATABASE_CONTRACT_OK' AS result;
