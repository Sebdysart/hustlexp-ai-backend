\set ON_ERROR_STOP on

BEGIN;

CREATE TEMP TABLE hx_identity_context AS
SELECT id AS user_id
FROM users
WHERE account_status='ACTIVE' AND COALESCE(is_minor,FALSE) IS FALSE
ORDER BY created_at NULLS LAST,id
LIMIT 1;

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM hx_identity_context)<>1 THEN
    RAISE EXCEPTION 'private identity fixture user is unavailable';
  END IF;
END;
$$;

DO $$
DECLARE v_user UUID := (SELECT user_id FROM hx_identity_context);
BEGIN
  BEGIN
    UPDATE users SET is_verified=TRUE,verified_at=NOW() WHERE id=v_user;
    RAISE EXCEPTION 'forged verification projection unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXIDV2:%' THEN RAISE; END IF;
  END;
END;
$$;

INSERT INTO identity_verification_consents(
  id,user_id,provider,provider_environment,is_test,policy_version,
  disclosure_hash,purpose,idempotency_key
)
SELECT '85100000-0000-4000-8000-000000000001',user_id,
       'local_certification_identity','CONTROLLED_TEST',TRUE,
       'hxos-private-identity-local-test-v1',repeat('a',64),
       'Controlled TEST identity state-machine evidence only; no identity document is collected or verified.',
       'identity-contract-consent-0001'
FROM hx_identity_context;

DO $$
DECLARE v_user UUID := (SELECT user_id FROM hx_identity_context);
BEGIN
  BEGIN
    PERFORM * FROM begin_identity_verification_case_v1(
      v_user,'85100000-0000-4000-8000-000000000001',
      'local_certification_identity','idv_hxos_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'CONTROLLED_TEST',TRUE,'hxos-private-identity-local-test-v1',repeat('b',64),
      NOW()+INTERVAL '90 days'
    );
    RAISE EXCEPTION 'controlled TEST case started without local authority';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXIDV4:%' THEN RAISE; END IF;
  END;
END;
$$;

SET LOCAL hustlexp.local_test_identity_enabled='true';

CREATE TEMP TABLE hx_identity_case AS
SELECT * FROM begin_identity_verification_case_v1(
  (SELECT user_id FROM hx_identity_context),
  '85100000-0000-4000-8000-000000000001',
  'local_certification_identity','idv_hxos_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'CONTROLLED_TEST',TRUE,'hxos-private-identity-local-test-v1',repeat('b',64),
  NOW()+INTERVAL '90 days'
);

DO $$
BEGIN
  IF (SELECT case_status FROM hx_identity_case)<>'PENDING' THEN
    RAISE EXCEPTION 'identity case did not start pending';
  END IF;
END;
$$;

DO $$
DECLARE v_case UUID := (SELECT case_id FROM hx_identity_case);
BEGIN
  BEGIN
    UPDATE identity_verification_cases SET status='FAILED',terminal_at=NOW() WHERE id=v_case;
    RAISE EXCEPTION 'direct identity case mutation unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXIDV15:%' THEN RAISE; END IF;
  END;
END;
$$;

SELECT * FROM record_identity_verification_event_v1(
  (SELECT user_id FROM hx_identity_context),(SELECT case_id FROM hx_identity_case),
  'identity-processing-0001','PROCESSING',repeat('c',64),NULL,NOW(),NULL,
  (SELECT user_id FROM hx_identity_context)
);

CREATE TEMP TABLE hx_identity_verified AS
SELECT * FROM record_identity_verification_event_v1(
  (SELECT user_id FROM hx_identity_context),(SELECT case_id FROM hx_identity_case),
  'identity-verified-0001','VERIFIED',repeat('d',64),repeat('e',64),
  NOW(),NOW()+INTERVAL '90 days',(SELECT user_id FROM hx_identity_context)
);

DO $$
DECLARE
  v_user UUID := (SELECT user_id FROM hx_identity_context);
  v_case UUID := (SELECT case_id FROM hx_identity_case);
BEGIN
  IF NOT identity_verification_is_current_v1(v_user,'CONTROLLED_TEST') THEN
    RAISE EXCEPTION 'controlled TEST identity is not current';
  END IF;
  IF identity_verification_is_current_v1(v_user,'PRODUCTION') THEN
    RAISE EXCEPTION 'controlled TEST identity authorized production';
  END IF;
  IF NOT (SELECT identity_verified FROM hx_identity_verified) THEN
    RAISE EXCEPTION 'verified provider event did not project identity state';
  END IF;

  BEGIN
    UPDATE users SET identity_verification_status='FAILED' WHERE id=v_user;
    RAISE EXCEPTION 'direct projection mutation unexpectedly succeeded after provider event';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXIDV2:%' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM * FROM record_identity_verification_event_v1(
      v_user,v_case,'identity-verified-0001','VERIFIED',repeat('f',64),repeat('e',64),
      NOW(),NOW()+INTERVAL '90 days',v_user
    );
    RAISE EXCEPTION 'conflicting provider replay unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXIDV9:%' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM * FROM record_identity_verification_event_v1(
      v_user,v_case,'identity-expired-too-early-0001','EXPIRED',repeat('0',64),NULL,
      NOW(),NULL,v_user
    );
    RAISE EXCEPTION 'identity evidence expired before its deadline';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXIDV17:%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE identity_verification_consents
       SET purpose='A different purpose cannot replace consent evidence.'
     WHERE id='85100000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'identity consent authority fields unexpectedly changed';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXIDV13:%' THEN RAISE; END IF;
  END;

  BEGIN
    DELETE FROM identity_verification_events WHERE case_id=v_case;
    RAISE EXCEPTION 'identity event history unexpectedly deleted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXIDV1:%' THEN RAISE; END IF;
  END;
END;
$$;

-- Isolate the final assignment boundary from unrelated task guards.
CREATE TEMP TABLE hx_identity_task AS
SELECT id AS task_id FROM tasks WHERE worker_id IS NULL ORDER BY created_at DESC LIMIT 1;

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM hx_identity_task)<>1 THEN
    RAISE EXCEPTION 'private identity task fixture is unavailable';
  END IF;
END;
$$;

ALTER TABLE tasks DISABLE TRIGGER USER;
UPDATE tasks SET automation_classification='PRODUCTION',worker_id=NULL
WHERE id=(SELECT task_id FROM hx_identity_task);
ALTER TABLE tasks ENABLE TRIGGER task_identity_verification_environment_guard;

DO $$
DECLARE
  v_user UUID := (SELECT user_id FROM hx_identity_context);
  v_task UUID := (SELECT task_id FROM hx_identity_task);
BEGIN
  BEGIN
    UPDATE tasks SET worker_id=v_user WHERE id=v_task;
    RAISE EXCEPTION 'TEST identity unexpectedly authorized production assignment';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXIDV20:%' THEN RAISE; END IF;
  END;
END;
$$;

UPDATE tasks
SET automation_classification='CONTROLLED_TEST',
    worker_id=(SELECT user_id FROM hx_identity_context)
WHERE id=(SELECT task_id FROM hx_identity_task);

SELECT * FROM record_identity_verification_event_v1(
  (SELECT user_id FROM hx_identity_context),(SELECT case_id FROM hx_identity_case),
  'identity-revoked-0001','REVOKED',repeat('1',64),NULL,NOW(),NULL,
  (SELECT user_id FROM hx_identity_context)
);

DO $$
DECLARE v_user UUID := (SELECT user_id FROM hx_identity_context);
BEGIN
  IF identity_verification_is_current_v1(v_user,'CONTROLLED_TEST') THEN
    RAISE EXCEPTION 'revoked controlled TEST identity remained current';
  END IF;
  IF (SELECT COALESCE(is_verified,FALSE) FROM users WHERE id=v_user) THEN
    RAISE EXCEPTION 'revocation did not clear the user verification projection';
  END IF;
END;
$$;

SELECT 'PRIVATE_IDENTITY_VERIFICATION_DATABASE_CONTRACT_OK' AS result;
ROLLBACK;
