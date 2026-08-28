\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  v_missing TEXT;
BEGIN
  SELECT string_agg(required.column_name, ', ' ORDER BY required.column_name)
  INTO v_missing
  FROM (VALUES
    ('deepfake_score'),
    ('biometric_analyzed_at'),
    ('biometric_signal_status'),
    ('biometric_provider'),
    ('biometric_failure_reason_code'),
    ('biometric_policy_version'),
    ('metadata'),
    ('capture_source'),
    ('exif_timestamp'),
    ('exif_gps_lat'),
    ('exif_gps_lng'),
    ('exif_device_model'),
    ('capture_validation_passed'),
    ('capture_validation_failures')
  ) AS required(column_name)
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns actual
    WHERE actual.table_schema='public'
      AND actual.table_name='proof_submissions'
      AND actual.column_name=required.column_name
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'missing proof signal columns: %', v_missing;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM proofs p
    WHERE NOT EXISTS (
      SELECT 1 FROM proof_submissions ps WHERE ps.proof_id=p.id
    )
  ) THEN
    RAISE EXCEPTION 'legacy proof backfill left proofs without a signal row';
  END IF;
  IF EXISTS (
    SELECT 1 FROM proof_submissions
    WHERE exif_timestamp IS NOT NULL
       OR exif_gps_lat IS NOT NULL
       OR exif_gps_lng IS NOT NULL
       OR exif_device_model IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'raw media metadata backfill did not strip legacy values';
  END IF;
END $$;

CREATE TEMP TABLE hxos_proof_target AS
SELECT p.id AS proof_id,p.submitter_id AS user_id
FROM proofs p
ORDER BY p.created_at,p.id
LIMIT 1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM hxos_proof_target) THEN
    RAISE EXCEPTION 'proof signal harness requires one canonical proof';
  END IF;
END $$;

UPDATE proof_submissions ps
SET liveness_score=NULL,
    deepfake_score=NULL,
    biometric_signal_status='NOT_RUN',
    biometric_provider=NULL,
    biometric_failure_reason_code=NULL
FROM hxos_proof_target target
WHERE ps.proof_id=target.proof_id;

CREATE TEMP TABLE hxos_latest_signal AS
SELECT gen_random_uuid() AS signal_id,proof_id,user_id
FROM hxos_proof_target;

INSERT INTO proof_submissions(id,proof_id,user_id,created_at)
SELECT signal_id,proof_id,user_id,NOW() + INTERVAL '1 second'
FROM hxos_latest_signal;

WITH target AS (
  SELECT id FROM proof_submissions
  WHERE proof_id = (SELECT proof_id FROM hxos_proof_target)
  ORDER BY created_at DESC,id DESC
  LIMIT 1
)
UPDATE proof_submissions ps
SET liveness_score=0.900,
    deepfake_score=0.100,
    biometric_analyzed_at=NOW(),
    biometric_signal_status='AVAILABLE',
    biometric_provider='AWS_REKOGNITION',
    biometric_failure_reason_code=NULL,
    biometric_policy_version='hxos-proof-consistency-v1',
    biometric_verified=FALSE
FROM target
WHERE ps.id=target.id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM proof_submissions ps
    JOIN hxos_latest_signal target ON target.signal_id=ps.id
    WHERE ps.biometric_signal_status='AVAILABLE'
      AND ps.liveness_score=0.900
      AND ps.deepfake_score=0.100
      AND ps.biometric_provider='AWS_REKOGNITION'
      AND ps.biometric_verified=FALSE
  ) THEN
    RAISE EXCEPTION 'canonical proof-id score persistence failed';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM proof_submissions ps
    JOIN hxos_proof_target target ON target.proof_id=ps.proof_id
    JOIN hxos_latest_signal latest ON latest.proof_id=ps.proof_id
    WHERE ps.id<>latest.signal_id
      AND ps.biometric_signal_status<>'NOT_RUN'
  ) THEN
    RAISE EXCEPTION 'legacy duplicate proof rows were updated non-deterministically';
  END IF;
END $$;

WITH target AS (
  SELECT id FROM proof_submissions
  WHERE proof_id = (SELECT proof_id FROM hxos_proof_target)
  ORDER BY created_at DESC,id DESC
  LIMIT 1
)
UPDATE proof_submissions ps
SET liveness_score=NULL,
    deepfake_score=NULL,
    biometric_analyzed_at=NOW(),
    biometric_signal_status='UNAVAILABLE',
    biometric_provider=NULL,
    biometric_failure_reason_code='BIOMETRIC_PROVIDER_UNAVAILABLE',
    biometric_policy_version='hxos-proof-consistency-v1',
    biometric_verified=FALSE
FROM target
WHERE ps.id=target.id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM proof_submissions ps
    JOIN hxos_latest_signal target ON target.signal_id=ps.id
    WHERE ps.biometric_signal_status='UNAVAILABLE'
      AND ps.liveness_score IS NULL
      AND ps.deepfake_score IS NULL
      AND ps.biometric_provider IS NULL
      AND ps.biometric_failure_reason_code='BIOMETRIC_PROVIDER_UNAVAILABLE'
      AND ps.biometric_analyzed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'provider-unavailable state was not persisted truthfully';
  END IF;
END $$;

DO $$
DECLARE
  v_proof UUID := (SELECT proof_id FROM hxos_proof_target);
  v_user UUID := (SELECT user_id FROM hxos_proof_target);
BEGIN
  BEGIN
    INSERT INTO proof_submissions(proof_id,user_id,liveness_score)
    VALUES (v_proof,v_user,1.001);
    RAISE EXCEPTION 'out-of-range liveness score unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO proof_submissions(proof_id,user_id,deepfake_score)
    VALUES (v_proof,v_user,-0.001);
    RAISE EXCEPTION 'out-of-range deepfake score unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO proof_submissions(proof_id,user_id,biometric_signal_status)
    VALUES (v_proof,v_user,'VERIFIED');
    RAISE EXCEPTION 'fabricated VERIFIED signal state unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO proof_submissions(proof_id,user_id,metadata)
    VALUES (v_proof,v_user,'[]'::jsonb);
    RAISE EXCEPTION 'non-object proof metadata unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO proof_submissions(proof_id,user_id,exif_gps_lat)
    VALUES (v_proof,v_user,47.6062);
    RAISE EXCEPTION 'partial EXIF coordinates unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO proof_submissions(proof_id,user_id,exif_timestamp,exif_gps_lat,exif_gps_lng,exif_device_model)
    VALUES (v_proof,v_user,NOW(),47.6062,-122.3321,'private-device-fingerprint');
    RAISE EXCEPTION 'raw EXIF metadata unexpectedly persisted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

ROLLBACK;

\echo 'PROOF_VERIFICATION_SIGNAL_DATABASE_CONTRACT_OK'
