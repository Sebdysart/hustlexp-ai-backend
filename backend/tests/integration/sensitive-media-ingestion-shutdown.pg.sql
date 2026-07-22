\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  v_constraints INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_constraints
  FROM pg_constraint
  WHERE conname IN (
    'users_avatar_receipt_only_ck',
    'worker_skills_license_receipt_only_ck',
    'license_verifications_document_receipt_only_ck',
    'insurance_verifications_document_receipt_only_ck',
    'tasks_before_photo_receipt_only_ck',
    'proof_submissions_receipt_only_media_ck'
  );
  IF v_constraints <> 6 THEN
    RAISE EXCEPTION 'expected six sensitive-media shutdown constraints, found %', v_constraints;
  END IF;

  IF EXISTS (SELECT 1 FROM users WHERE avatar_url IS NOT NULL)
     OR EXISTS (SELECT 1 FROM worker_skills WHERE license_url IS NOT NULL)
     OR EXISTS (SELECT 1 FROM license_verifications WHERE document_url IS NOT NULL)
     OR EXISTS (SELECT 1 FROM insurance_verifications WHERE document_url IS NOT NULL)
     OR EXISTS (SELECT 1 FROM tasks WHERE before_photo_url IS NOT NULL)
     OR EXISTS (SELECT 1 FROM proof_submissions WHERE photo_url IS NOT NULL OR lidar_depth_map_url IS NOT NULL) THEN
    RAISE EXCEPTION 'unsupported sensitive media survived the shutdown migration';
  END IF;
END;
$$;

DO $$
DECLARE v_user UUID := (SELECT id FROM users ORDER BY id LIMIT 1);
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'user fixture unavailable'; END IF;
  BEGIN
    UPDATE users SET avatar_url='https://public.example/avatar-with-exif.jpg' WHERE id=v_user;
    RAISE EXCEPTION 'direct avatar media unexpectedly persisted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$$;

DO $$
DECLARE v_task UUID := (SELECT id FROM tasks ORDER BY id LIMIT 1);
BEGIN
  IF v_task IS NULL THEN RAISE EXCEPTION 'task fixture unavailable'; END IF;
  BEGIN
    UPDATE tasks SET before_photo_url='https://public.example/location-photo.jpg' WHERE id=v_task;
    RAISE EXCEPTION 'direct task before-photo unexpectedly persisted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$$;

DO $$
DECLARE v_proof_submission UUID := (SELECT id FROM proof_submissions ORDER BY id LIMIT 1);
BEGIN
  IF v_proof_submission IS NOT NULL THEN
    BEGIN
      UPDATE proof_submissions
      SET photo_url='https://public.example/proof.jpg',
          lidar_depth_map_url='https://public.example/depth.bin'
      WHERE id=v_proof_submission;
      RAISE EXCEPTION 'direct proof media unexpectedly persisted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END IF;
END;
$$;

SELECT 'SENSITIVE_MEDIA_INGESTION_SHUTDOWN_DATABASE_CONTRACT_OK' AS result;
ROLLBACK;
