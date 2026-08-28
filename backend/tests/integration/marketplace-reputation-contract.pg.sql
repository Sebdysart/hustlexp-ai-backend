\set ON_ERROR_STOP on

CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poster_id UUID NOT NULL REFERENCES users(id),
  worker_id UUID REFERENCES users(id),
  category TEXT,
  trade_type TEXT,
  region_code TEXT,
  state TEXT NOT NULL,
  automation_classification TEXT NOT NULL DEFAULT 'PRODUCTION'
);
CREATE TABLE proofs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id),
  state TEXT NOT NULL
);
CREATE TABLE disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id)
);
CREATE TABLE task_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id),
  rater_id UUID NOT NULL REFERENCES users(id),
  ratee_id UUID NOT NULL REFERENCES users(id),
  stars INTEGER NOT NULL,
  structured_feedback JSONB,
  is_public BOOLEAN NOT NULL DEFAULT TRUE,
  is_blind BOOLEAN NOT NULL DEFAULT FALSE,
  is_auto_rated BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO users(id) VALUES
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002'),
  ('00000000-0000-4000-8000-000000000003'),
  ('00000000-0000-4000-8000-000000000004');

\ir ../../database/migrations/20260718_marketplace_reputation_contract.sql

INSERT INTO verified_region_memberships(
  user_id, region_code, verification_method, verification_ref_hash, verified_by
) VALUES
  ('00000000-0000-4000-8000-000000000001','US-WA','ADDRESS_PROVIDER',repeat('a',64),'00000000-0000-4000-8000-000000000004'),
  ('00000000-0000-4000-8000-000000000002','US-WA','ADDRESS_PROVIDER',repeat('b',64),'00000000-0000-4000-8000-000000000004');

DO $$
BEGIN
  BEGIN
    INSERT INTO local_provider_recommendations(
      recommender_id, provider_user_id, category, region_code, body,
      relationship, idempotency_key
    ) VALUES (
      '00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001',
      'yard_help','US-WA','I recommend my own work here.','NEIGHBOR','self-rec-0001'
    );
    RAISE EXCEPTION 'expected HXREP1';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXREP1:%' THEN RAISE; END IF;
  END;

  BEGIN
    INSERT INTO local_provider_recommendations(
      recommender_id, provider_user_id, category, region_code, body,
      relationship, idempotency_key
    ) VALUES (
      '00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002',
      'yard_help','US-WA','Helpful with seasonal yard cleanup.','NEIGHBOR','unlocal-0001'
    );
    RAISE EXCEPTION 'expected HXREP2';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXREP2:%' THEN RAISE; END IF;
  END;

  BEGIN
    INSERT INTO local_provider_recommendations(
      recommender_id, provider_user_id, category, region_code, body,
      relationship, idempotency_key, state
    ) VALUES (
      '00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',
      'yard_help','US-WA','Helpful with seasonal yard cleanup.','NEIGHBOR','premature-0001','PUBLISHED'
    );
    RAISE EXCEPTION 'expected HXREP5';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXREP5:%' THEN RAISE; END IF;
  END;
END
$$;

INSERT INTO local_provider_recommendations(
  id, recommender_id, provider_user_id, category, region_code, body,
  relationship, idempotency_key
) VALUES (
  '10000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',
  'yard_help','US-WA','Reliable help with seasonal yard cleanup.','NEIGHBOR','local-rec-0001'
);

DO $$
BEGIN
  BEGIN
    UPDATE local_provider_recommendations SET body = 'Mutated recommendation content.'
     WHERE id = '10000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'expected HXREP3';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXREP3:%' THEN RAISE; END IF;
  END;

  BEGIN
    DELETE FROM local_provider_recommendations
     WHERE id = '10000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'expected HXREP4';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXREP4:%' THEN RAISE; END IF;
  END;
END
$$;

UPDATE local_provider_recommendations
   SET state = 'PUBLISHED', moderated_by = '00000000-0000-4000-8000-000000000004',
       moderation_reason = 'The recommendation passed manual content and locality review.',
       moderated_at = NOW()
 WHERE id = '10000000-0000-4000-8000-000000000001';

INSERT INTO local_provider_recommendations(
  id, recommender_id, provider_user_id, category, region_code, body,
  relationship, idempotency_key, state, collusion_hold
) VALUES (
  '10000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001',
  'yard_help','US-WA','Consistently thoughtful and careful help.','NEIGHBOR','local-rec-0002',
  'HELD_FOR_REVIEW',TRUE
);
INSERT INTO reputation_signal_flags(
  id, provider_user_id, related_user_id, category, region_code, signal_type,
  source_id, reason_code, evidence
) VALUES (
  '20000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',
  'yard_help','US-WA','LOCAL_RECOMMENDATION','10000000-0000-4000-8000-000000000002',
  'RECIPROCAL_RECOMMENDATION','{"reciprocal":true}'::JSONB
);

DO $$
BEGIN
  BEGIN
    INSERT INTO reputation_signal_appeals(signal_id, provider_user_id, reason)
    VALUES (
      '20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003',
      'I should not be allowed to appeal another provider signal.'
    );
    RAISE EXCEPTION 'expected HXREP2';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXREP2:%' THEN RAISE; END IF;
  END;
END
$$;

INSERT INTO reputation_signal_appeals(
  id, signal_id, provider_user_id, reason
) VALUES (
  '30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001',
  'The relationship is genuine and the accounts are independently controlled.'
);

DO $$
BEGIN
  BEGIN
    UPDATE reputation_signal_appeals SET reason = 'Mutated appeal reason that should not persist.'
     WHERE id = '30000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'expected HXREP3';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXREP3:%' THEN RAISE; END IF;
  END;
END
$$;

INSERT INTO tasks(
  id, poster_id, worker_id, category, trade_type, region_code, state, automation_classification
) VALUES
  ('40000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000002','yard_help','yard_help','US-WA','COMPLETED','PRODUCTION'),
  ('40000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003',
   '00000000-0000-4000-8000-000000000002','yard_help','yard_help','US-WA','CANCELLED','PRODUCTION'),
  ('40000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000002','yard_help','yard_help','US-WA','COMPLETED','CONTROLLED_TEST');
INSERT INTO proofs(task_id, state) VALUES
  ('40000000-0000-4000-8000-000000000001','ACCEPTED');
INSERT INTO task_ratings(
  task_id, rater_id, ratee_id, stars, structured_feedback,
  is_public, is_blind, is_auto_rated, created_at
) VALUES (
  '40000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',5,
  '{"communication":5,"scopeAccuracy":4,"punctuality":5,"care":5,"resultQuality":5,"value":4}'::JSONB,
  TRUE,FALSE,FALSE,NOW() - INTERVAL '10 days'
);

INSERT INTO provider_credential_status(
  provider_user_id, category, region_code, license_status,
  insurance_status, background_check_status, updated_by
) VALUES (
  '00000000-0000-4000-8000-000000000002','yard_help','US-WA',
  'NOT_REQUIRED','UNVERIFIED','UNVERIFIED','00000000-0000-4000-8000-000000000004'
);

DO $$
DECLARE
  summary RECORD;
BEGIN
  SELECT * INTO summary FROM provider_reputation_public
   WHERE provider_user_id = '00000000-0000-4000-8000-000000000002'
     AND category = 'yard_help' AND region_code = 'US-WA';
  IF summary.verified_assignments <> 2
     OR summary.verified_completions <> 1
     OR summary.transaction_review_count <> 1
     OR summary.nearby_recommendation_count <> 1
     OR summary.blended_into_verified_score <> FALSE
     OR summary.experience_band <> 'BUILDING_HISTORY'
     OR summary.exploration_eligible <> TRUE
     OR summary.license_status <> 'NOT_REQUIRED' THEN
    RAISE EXCEPTION 'public reputation signals were blended, fabricated, or miscounted: %', row_to_json(summary);
  END IF;
END
$$;

SELECT 'MARKETPLACE_REPUTATION_DATABASE_CONTRACT_OK' AS result;
