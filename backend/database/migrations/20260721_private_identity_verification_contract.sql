-- Private identity verification is provider-attested evidence, not an
-- unconstrained boolean. No identity document, selfie, raw provider payload,
-- or public URL is stored in the canonical engine.

CREATE TABLE IF NOT EXISTS identity_verification_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (NULLIF(BTRIM(provider), '') IS NOT NULL),
  provider_environment TEXT NOT NULL
    CHECK (provider_environment IN ('PRODUCTION','CONTROLLED_TEST')),
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  policy_version TEXT NOT NULL CHECK (NULLIF(BTRIM(policy_version), '') IS NOT NULL),
  disclosure_hash CHAR(64) NOT NULL CHECK (disclosure_hash ~ '^[a-f0-9]{64}$'),
  purpose TEXT NOT NULL CHECK (CHAR_LENGTH(BTRIM(purpose)) BETWEEN 20 AND 500),
  consented_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, idempotency_key),
  CHECK (
    (provider_environment = 'CONTROLLED_TEST' AND is_test IS TRUE
      AND provider = 'local_certification_identity')
    OR
    (provider_environment = 'PRODUCTION' AND is_test IS FALSE
      AND provider <> 'local_certification_identity')
  ),
  CHECK (revoked_at IS NULL OR revoked_at >= consented_at)
);

CREATE TABLE IF NOT EXISTS identity_verification_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  consent_id UUID NOT NULL REFERENCES identity_verification_consents(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (NULLIF(BTRIM(provider), '') IS NOT NULL),
  provider_case_id TEXT NOT NULL CHECK (CHAR_LENGTH(BTRIM(provider_case_id)) BETWEEN 16 AND 200),
  provider_environment TEXT NOT NULL
    CHECK (provider_environment IN ('PRODUCTION','CONTROLLED_TEST')),
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN (
      'PENDING','PROCESSING','REVIEW_REQUIRED','VERIFIED',
      'FAILED','EXPIRED','REVOKED','UNAVAILABLE'
    )),
  policy_version TEXT NOT NULL CHECK (NULLIF(BTRIM(policy_version), '') IS NOT NULL),
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  evidence_hash CHAR(64) CHECK (evidence_hash IS NULL OR evidence_hash ~ '^[a-f0-9]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  terminal_at TIMESTAMPTZ,
  last_provider_event_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_environment, provider_case_id),
  CHECK (
    (provider_environment = 'CONTROLLED_TEST' AND is_test IS TRUE
      AND provider = 'local_certification_identity'
      AND provider_case_id ~ '^idv_hxos_test_[a-f0-9]{32}$')
    OR
    (provider_environment = 'PRODUCTION' AND is_test IS FALSE
      AND provider <> 'local_certification_identity'
      AND provider_case_id !~ '^idv_hxos_test_')
  ),
  CHECK (expires_at > created_at),
  CHECK (
    (status = 'VERIFIED' AND verified_at IS NOT NULL AND evidence_hash IS NOT NULL
      AND terminal_at IS NULL)
    OR
    (status IN ('FAILED','EXPIRED','REVOKED','UNAVAILABLE') AND terminal_at IS NOT NULL)
    OR
    (status IN ('PENDING','PROCESSING','REVIEW_REQUIRED') AND verified_at IS NULL
      AND terminal_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS identity_verification_cases_user_idx
  ON identity_verification_cases(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS identity_verification_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES identity_verification_cases(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider_event_id TEXT NOT NULL CHECK (CHAR_LENGTH(BTRIM(provider_event_id)) BETWEEN 8 AND 200),
  from_status TEXT CHECK (from_status IS NULL OR from_status IN (
    'PENDING','PROCESSING','REVIEW_REQUIRED','VERIFIED',
    'FAILED','EXPIRED','REVOKED','UNAVAILABLE'
  )),
  to_status TEXT NOT NULL CHECK (to_status IN (
    'PENDING','PROCESSING','REVIEW_REQUIRED','VERIFIED',
    'FAILED','EXPIRED','REVOKED','UNAVAILABLE'
  )),
  payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  evidence_hash CHAR(64) CHECK (evidence_hash IS NULL OR evidence_hash ~ '^[a-f0-9]{64}$'),
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  UNIQUE (case_id, provider_event_id)
);

CREATE INDEX IF NOT EXISTS identity_verification_events_user_idx
  ON identity_verification_events(user_id, recorded_at DESC);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS identity_verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED',
  ADD COLUMN IF NOT EXISTS identity_verification_environment TEXT,
  ADD COLUMN IF NOT EXISTS identity_verification_case_id UUID
    REFERENCES identity_verification_cases(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS identity_verification_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS identity_verification_policy_version TEXT;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_identity_verification_status_check;
ALTER TABLE users ADD CONSTRAINT users_identity_verification_status_check CHECK (
  identity_verification_status IN (
    'UNVERIFIED','PENDING','PROCESSING','REVIEW_REQUIRED','VERIFIED',
    'FAILED','EXPIRED','REVOKED','UNAVAILABLE','LEGACY_UNATTESTED'
  )
);

-- Existing booleans have no attributable provider evidence in the migration
-- history. Preserve that fact as an explicit state and remove their authority.
SELECT set_config('hustlexp.identity_projection_writer', 'true', TRUE);
UPDATE users
SET is_verified = FALSE,
    verified_at = NULL,
    identity_verification_status = CASE
      WHEN COALESCE(is_verified, FALSE) THEN 'LEGACY_UNATTESTED'
      ELSE 'UNVERIFIED'
    END,
    identity_verification_environment = NULL,
    identity_verification_case_id = NULL,
    identity_verification_expires_at = NULL,
    identity_verification_policy_version = NULL
WHERE COALESCE(is_verified, FALSE)
   OR verified_at IS NOT NULL
   OR identity_verification_status <> 'UNVERIFIED';

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_identity_verification_projection_check;
ALTER TABLE users ADD CONSTRAINT users_identity_verification_projection_check CHECK (
  (
    is_verified IS TRUE
    AND identity_verification_status = 'VERIFIED'
    AND verified_at IS NOT NULL
    AND identity_verification_case_id IS NOT NULL
    AND identity_verification_environment IN ('PRODUCTION','CONTROLLED_TEST')
    AND identity_verification_expires_at IS NOT NULL
    AND identity_verification_expires_at > verified_at
    AND NULLIF(BTRIM(identity_verification_policy_version), '') IS NOT NULL
  )
  OR
  (
    COALESCE(is_verified, FALSE) IS FALSE
    AND identity_verification_status <> 'VERIFIED'
  )
);

CREATE OR REPLACE FUNCTION prevent_identity_verification_event_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HXIDV1: identity verification evidence is append-only'
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS identity_verification_events_immutable ON identity_verification_events;
CREATE TRIGGER identity_verification_events_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON identity_verification_events
FOR EACH STATEMENT EXECUTE FUNCTION prevent_identity_verification_event_mutation();

DROP TRIGGER IF EXISTS identity_verification_cases_no_delete ON identity_verification_cases;
CREATE TRIGGER identity_verification_cases_no_delete
BEFORE DELETE OR TRUNCATE ON identity_verification_cases
FOR EACH STATEMENT EXECUTE FUNCTION prevent_identity_verification_event_mutation();

DROP TRIGGER IF EXISTS identity_verification_consents_no_delete ON identity_verification_consents;
CREATE TRIGGER identity_verification_consents_no_delete
BEFORE DELETE OR TRUNCATE ON identity_verification_consents
FOR EACH STATEMENT EXECUTE FUNCTION prevent_identity_verification_event_mutation();

CREATE OR REPLACE FUNCTION guard_identity_verification_consent_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.user_id IS DISTINCT FROM NEW.user_id
     OR OLD.provider IS DISTINCT FROM NEW.provider
     OR OLD.provider_environment IS DISTINCT FROM NEW.provider_environment
     OR OLD.is_test IS DISTINCT FROM NEW.is_test
     OR OLD.policy_version IS DISTINCT FROM NEW.policy_version
     OR OLD.disclosure_hash IS DISTINCT FROM NEW.disclosure_hash
     OR OLD.purpose IS DISTINCT FROM NEW.purpose
     OR OLD.consented_at IS DISTINCT FROM NEW.consented_at
     OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key THEN
    RAISE EXCEPTION 'HXIDV13: identity verification consent evidence is immutable'
      USING ERRCODE = 'P0001';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'HXIDV14: identity verification consent revocation is terminal'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS identity_verification_consent_integrity
  ON identity_verification_consents;
CREATE TRIGGER identity_verification_consent_integrity
BEFORE UPDATE ON identity_verification_consents
FOR EACH ROW EXECUTE FUNCTION guard_identity_verification_consent_mutation();

CREATE OR REPLACE FUNCTION guard_identity_verification_case_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('hustlexp.identity_case_writer', TRUE) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'HXIDV15: identity verification case is provider-owned'
      USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND (
       OLD.id IS DISTINCT FROM NEW.id
       OR OLD.user_id IS DISTINCT FROM NEW.user_id
       OR OLD.consent_id IS DISTINCT FROM NEW.consent_id
       OR OLD.provider IS DISTINCT FROM NEW.provider
       OR OLD.provider_case_id IS DISTINCT FROM NEW.provider_case_id
       OR OLD.provider_environment IS DISTINCT FROM NEW.provider_environment
       OR OLD.is_test IS DISTINCT FROM NEW.is_test
       OR OLD.policy_version IS DISTINCT FROM NEW.policy_version
       OR OLD.request_hash IS DISTINCT FROM NEW.request_hash
       OR OLD.created_at IS DISTINCT FROM NEW.created_at
     ) THEN
    RAISE EXCEPTION 'HXIDV16: identity verification case identity is immutable'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS identity_verification_case_integrity ON identity_verification_cases;
CREATE TRIGGER identity_verification_case_integrity
BEFORE INSERT OR UPDATE ON identity_verification_cases
FOR EACH ROW EXECUTE FUNCTION guard_identity_verification_case_mutation();

CREATE OR REPLACE FUNCTION guard_user_identity_verification_projection()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('hustlexp.identity_projection_writer', TRUE) IS DISTINCT FROM 'true' THEN
    IF TG_OP = 'INSERT' THEN
      IF COALESCE(NEW.is_verified, FALSE)
         OR NEW.verified_at IS NOT NULL
         OR NEW.identity_verification_status <> 'UNVERIFIED'
         OR NEW.identity_verification_environment IS NOT NULL
         OR NEW.identity_verification_case_id IS NOT NULL
         OR NEW.identity_verification_expires_at IS NOT NULL
         OR NEW.identity_verification_policy_version IS NOT NULL THEN
        RAISE EXCEPTION 'HXIDV2: identity verification projection is provider-owned'
          USING ERRCODE = 'P0001';
      END IF;
    ELSIF OLD.is_verified IS DISTINCT FROM NEW.is_verified
       OR OLD.verified_at IS DISTINCT FROM NEW.verified_at
       OR OLD.identity_verification_status IS DISTINCT FROM NEW.identity_verification_status
       OR OLD.identity_verification_environment IS DISTINCT FROM NEW.identity_verification_environment
       OR OLD.identity_verification_case_id IS DISTINCT FROM NEW.identity_verification_case_id
       OR OLD.identity_verification_expires_at IS DISTINCT FROM NEW.identity_verification_expires_at
       OR OLD.identity_verification_policy_version IS DISTINCT FROM NEW.identity_verification_policy_version THEN
      RAISE EXCEPTION 'HXIDV2: identity verification projection is provider-owned'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_identity_verification_projection_guard ON users;
CREATE TRIGGER users_identity_verification_projection_guard
BEFORE INSERT OR UPDATE OF is_verified, verified_at,
  identity_verification_status, identity_verification_environment,
  identity_verification_case_id, identity_verification_expires_at,
  identity_verification_policy_version
ON users FOR EACH ROW EXECUTE FUNCTION guard_user_identity_verification_projection();

CREATE OR REPLACE FUNCTION begin_identity_verification_case_v1(
  p_user_id UUID,
  p_consent_id UUID,
  p_provider TEXT,
  p_provider_case_id TEXT,
  p_provider_environment TEXT,
  p_is_test BOOLEAN,
  p_policy_version TEXT,
  p_request_hash TEXT,
  p_expires_at TIMESTAMPTZ
) RETURNS TABLE(case_id UUID, case_status TEXT, idempotency_replayed BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_consent identity_verification_consents%ROWTYPE;
  v_case identity_verification_cases%ROWTYPE;
BEGIN
  IF p_request_hash !~ '^[a-f0-9]{64}$' OR p_expires_at <= NOW() THEN
    RAISE EXCEPTION 'HXIDV3: identity verification request is invalid' USING ERRCODE = 'P0001';
  END IF;
  IF p_provider_environment = 'CONTROLLED_TEST'
     AND current_setting('hustlexp.local_test_identity_enabled', TRUE) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'HXIDV4: controlled TEST identity requires transaction-local authority'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_consent
  FROM identity_verification_consents
  WHERE id = p_consent_id FOR SHARE;
  IF NOT FOUND OR v_consent.user_id <> p_user_id
     OR v_consent.provider <> p_provider
     OR v_consent.provider_environment <> p_provider_environment
     OR v_consent.is_test IS DISTINCT FROM p_is_test
     OR v_consent.policy_version <> p_policy_version
     OR v_consent.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'HXIDV5: active provider-matched identity consent is required'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_case
  FROM identity_verification_cases
  WHERE provider = p_provider
    AND provider_environment = p_provider_environment
    AND provider_case_id = p_provider_case_id
  FOR UPDATE;
  IF FOUND THEN
    IF v_case.user_id <> p_user_id OR v_case.consent_id <> p_consent_id
       OR v_case.request_hash <> p_request_hash OR v_case.is_test IS DISTINCT FROM p_is_test
       OR v_case.policy_version <> p_policy_version THEN
      RAISE EXCEPTION 'HXIDV6: identity verification idempotency conflict'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY SELECT v_case.id, v_case.status, TRUE;
    RETURN;
  END IF;

  PERFORM set_config('hustlexp.identity_case_writer', 'true', TRUE);
  INSERT INTO identity_verification_cases (
    user_id, consent_id, provider, provider_case_id, provider_environment,
    is_test, status, policy_version, request_hash, expires_at
  ) VALUES (
    p_user_id, p_consent_id, p_provider, p_provider_case_id, p_provider_environment,
    p_is_test, 'PENDING', p_policy_version, p_request_hash, p_expires_at
  ) RETURNING * INTO v_case;
  PERFORM set_config('hustlexp.identity_case_writer', 'false', TRUE);

  PERFORM set_config('hustlexp.identity_projection_writer', 'true', TRUE);
  UPDATE users
  SET is_verified = FALSE,
      verified_at = NULL,
      identity_verification_status = 'PENDING',
      identity_verification_environment = p_provider_environment,
      identity_verification_case_id = v_case.id,
      identity_verification_expires_at = p_expires_at,
      identity_verification_policy_version = p_policy_version,
      updated_at = NOW()
  WHERE id = p_user_id AND COALESCE(is_verified, FALSE) IS FALSE;
  PERFORM set_config('hustlexp.identity_projection_writer', 'false', TRUE);

  RETURN QUERY SELECT v_case.id, v_case.status, FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION record_identity_verification_event_v1(
  p_user_id UUID,
  p_case_id UUID,
  p_provider_event_id TEXT,
  p_to_status TEXT,
  p_payload_hash TEXT,
  p_evidence_hash TEXT,
  p_occurred_at TIMESTAMPTZ,
  p_expires_at TIMESTAMPTZ,
  p_actor_id UUID DEFAULT NULL
) RETURNS TABLE(case_status TEXT, identity_verified BOOLEAN, idempotency_replayed BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_case identity_verification_cases%ROWTYPE;
  v_consent identity_verification_consents%ROWTYPE;
  v_event identity_verification_events%ROWTYPE;
  v_allowed BOOLEAN := FALSE;
BEGIN
  IF p_to_status NOT IN (
       'PROCESSING','REVIEW_REQUIRED','VERIFIED','FAILED','EXPIRED','REVOKED','UNAVAILABLE'
     ) OR p_payload_hash !~ '^[a-f0-9]{64}$'
     OR p_occurred_at > NOW() + INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'HXIDV7: identity provider event is invalid' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_case FROM identity_verification_cases WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND OR v_case.user_id <> p_user_id THEN
    RAISE EXCEPTION 'HXIDV8: identity verification case does not match user'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_case.provider_environment = 'CONTROLLED_TEST'
     AND current_setting('hustlexp.local_test_identity_enabled', TRUE) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'HXIDV4: controlled TEST identity requires transaction-local authority'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_event
  FROM identity_verification_events
  WHERE case_id = p_case_id AND provider_event_id = p_provider_event_id;
  IF FOUND THEN
    IF v_event.user_id <> p_user_id OR v_event.to_status <> p_to_status
       OR v_event.payload_hash <> p_payload_hash
       OR v_event.evidence_hash IS DISTINCT FROM p_evidence_hash THEN
      RAISE EXCEPTION 'HXIDV9: identity provider event replay conflict'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY SELECT v_case.status,
      (v_case.status = 'VERIFIED' AND v_case.expires_at > NOW()), TRUE;
    RETURN;
  END IF;

  SELECT * INTO v_consent
  FROM identity_verification_consents WHERE id = v_case.consent_id FOR SHARE;
  IF NOT FOUND OR v_consent.user_id <> p_user_id OR v_consent.revoked_at IS NOT NULL
     OR v_consent.provider <> v_case.provider
     OR v_consent.provider_environment <> v_case.provider_environment
     OR v_consent.is_test IS DISTINCT FROM v_case.is_test THEN
    RAISE EXCEPTION 'HXIDV10: identity provider event lacks current consent'
      USING ERRCODE = 'P0001';
  END IF;

  v_allowed :=
    (v_case.status = 'PENDING' AND p_to_status IN (
      'PROCESSING','REVIEW_REQUIRED','VERIFIED','FAILED','UNAVAILABLE'
    ))
    OR (v_case.status = 'PROCESSING' AND p_to_status IN (
      'REVIEW_REQUIRED','VERIFIED','FAILED','UNAVAILABLE'
    ))
    OR (v_case.status = 'REVIEW_REQUIRED' AND p_to_status IN ('VERIFIED','FAILED'))
    OR (v_case.status = 'VERIFIED' AND p_to_status IN ('EXPIRED','REVOKED'));
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'HXIDV11: invalid identity verification transition % -> %',
      v_case.status, p_to_status USING ERRCODE = 'P0001';
  END IF;

  IF p_to_status = 'VERIFIED' THEN
    IF p_evidence_hash IS NULL OR p_evidence_hash !~ '^[a-f0-9]{64}$'
       OR p_expires_at IS NULL OR p_expires_at <= p_occurred_at OR p_expires_at <= NOW()
       OR p_expires_at > p_occurred_at + INTERVAL '2 years' THEN
      RAISE EXCEPTION 'HXIDV12: verified identity requires bounded attributable evidence'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF p_evidence_hash IS NOT NULL AND p_evidence_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'HXIDV7: identity provider event is invalid' USING ERRCODE = 'P0001';
  END IF;
  IF p_to_status = 'EXPIRED' AND v_case.expires_at > p_occurred_at THEN
    RAISE EXCEPTION 'HXIDV17: identity evidence cannot expire before its recorded deadline'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO identity_verification_events (
    case_id, user_id, provider_event_id, from_status, to_status,
    payload_hash, evidence_hash, actor_id, occurred_at, metadata
  ) VALUES (
    p_case_id, p_user_id, p_provider_event_id, v_case.status, p_to_status,
    p_payload_hash, p_evidence_hash, p_actor_id, p_occurred_at,
    jsonb_build_object(
      'provider', v_case.provider,
      'providerEnvironment', v_case.provider_environment,
      'isTest', v_case.is_test,
      'policyVersion', v_case.policy_version
    )
  );

  PERFORM set_config('hustlexp.identity_case_writer', 'true', TRUE);
  UPDATE identity_verification_cases
  SET status = p_to_status,
      evidence_hash = CASE WHEN p_to_status = 'VERIFIED' THEN p_evidence_hash ELSE evidence_hash END,
      expires_at = CASE WHEN p_to_status = 'VERIFIED' THEN p_expires_at ELSE expires_at END,
      verified_at = CASE WHEN p_to_status = 'VERIFIED' THEN p_occurred_at ELSE verified_at END,
      terminal_at = CASE
        WHEN p_to_status IN ('FAILED','EXPIRED','REVOKED','UNAVAILABLE') THEN p_occurred_at
        ELSE NULL
      END,
      last_provider_event_at = p_occurred_at,
      updated_at = NOW()
  WHERE id = p_case_id
  RETURNING * INTO v_case;
  PERFORM set_config('hustlexp.identity_case_writer', 'false', TRUE);

  PERFORM set_config('hustlexp.identity_projection_writer', 'true', TRUE);
  IF p_to_status = 'VERIFIED' THEN
    UPDATE users
    SET is_verified = TRUE,
        verified_at = p_occurred_at,
        identity_verification_status = 'VERIFIED',
        identity_verification_environment = v_case.provider_environment,
        identity_verification_case_id = v_case.id,
        identity_verification_expires_at = v_case.expires_at,
        identity_verification_policy_version = v_case.policy_version,
        updated_at = NOW()
    WHERE id = p_user_id;
  ELSIF p_to_status IN ('EXPIRED','REVOKED') THEN
    UPDATE users
    SET is_verified = FALSE,
        verified_at = NULL,
        identity_verification_status = p_to_status,
        identity_verification_environment = v_case.provider_environment,
        identity_verification_case_id = v_case.id,
        identity_verification_expires_at = v_case.expires_at,
        identity_verification_policy_version = v_case.policy_version,
        updated_at = NOW()
    WHERE id = p_user_id AND identity_verification_case_id = p_case_id;
  ELSIF p_to_status IN ('PROCESSING','REVIEW_REQUIRED','FAILED','UNAVAILABLE') THEN
    UPDATE users
    SET identity_verification_status = p_to_status,
        updated_at = NOW()
    WHERE id = p_user_id
      AND identity_verification_case_id = p_case_id
      AND COALESCE(is_verified, FALSE) IS FALSE;
  END IF;
  PERFORM set_config('hustlexp.identity_projection_writer', 'false', TRUE);

  RETURN QUERY SELECT v_case.status,
    (v_case.status = 'VERIFIED' AND v_case.expires_at > NOW()), FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION identity_verification_is_current_v1(
  p_user_id UUID,
  p_environment TEXT
) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM users identity_user
    JOIN identity_verification_cases identity_case
      ON identity_case.id = identity_user.identity_verification_case_id
     AND identity_case.user_id = identity_user.id
    JOIN identity_verification_consents identity_consent
      ON identity_consent.id = identity_case.consent_id
     AND identity_consent.user_id = identity_user.id
    WHERE identity_user.id = p_user_id
      AND identity_user.is_verified IS TRUE
      AND identity_user.identity_verification_status = 'VERIFIED'
      AND identity_user.identity_verification_environment = p_environment
      AND identity_user.identity_verification_expires_at > NOW()
      AND identity_case.status = 'VERIFIED'
      AND identity_case.provider_environment = p_environment
      AND identity_case.expires_at > NOW()
      AND identity_consent.revoked_at IS NULL
      AND (
        (p_environment = 'PRODUCTION' AND identity_case.is_test IS FALSE)
        OR
        (p_environment = 'CONTROLLED_TEST' AND identity_case.is_test IS TRUE)
      )
  );
$$;

CREATE OR REPLACE FUNCTION enforce_task_identity_verification_environment()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_environment TEXT;
BEGIN
  IF NEW.worker_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.worker_id IS NOT DISTINCT FROM NEW.worker_id
     AND NOT (OLD.state IN ('OPEN','MATCHING') AND NEW.state NOT IN ('OPEN','MATCHING')) THEN
    RETURN NEW;
  END IF;
  v_environment := CASE
    WHEN NEW.automation_classification = 'CONTROLLED_TEST' THEN 'CONTROLLED_TEST'
    ELSE 'PRODUCTION'
  END;
  IF NOT identity_verification_is_current_v1(NEW.worker_id, v_environment) THEN
    RAISE EXCEPTION 'HXIDV20: assigned worker lacks current % identity evidence', v_environment
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_identity_verification_environment_guard ON tasks;
CREATE TRIGGER task_identity_verification_environment_guard
BEFORE INSERT OR UPDATE OF worker_id, state, automation_classification ON tasks
FOR EACH ROW EXECUTE FUNCTION enforce_task_identity_verification_environment();

CREATE OR REPLACE FUNCTION enforce_offer_identity_verification_environment()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_environment TEXT;
BEGIN
  IF NEW.decision_ready IS NOT TRUE THEN RETURN NEW; END IF;
  SELECT CASE
    WHEN task.automation_classification = 'CONTROLLED_TEST' THEN 'CONTROLLED_TEST'
    ELSE 'PRODUCTION'
  END INTO v_environment
  FROM tasks task WHERE task.id = NEW.task_id;
  IF v_environment IS NULL
     OR NOT identity_verification_is_current_v1(NEW.worker_id, v_environment) THEN
    RAISE EXCEPTION 'HXIDV21: accept-ready offer lacks environment-matched identity evidence'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS worker_offer_identity_verification_environment_guard
  ON worker_offer_decisions;
CREATE TRIGGER worker_offer_identity_verification_environment_guard
BEFORE INSERT OR UPDATE OF decision_ready, worker_id, task_id ON worker_offer_decisions
FOR EACH ROW EXECUTE FUNCTION enforce_offer_identity_verification_environment();

REVOKE ALL ON identity_verification_consents FROM PUBLIC;
REVOKE ALL ON identity_verification_cases FROM PUBLIC;
REVOKE ALL ON identity_verification_events FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION begin_identity_verification_case_v1(
  UUID,UUID,TEXT,TEXT,TEXT,BOOLEAN,TEXT,TEXT,TIMESTAMPTZ
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION record_identity_verification_event_v1(
  UUID,UUID,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TIMESTAMPTZ,UUID
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE ON identity_verification_consents TO service_role;
    GRANT SELECT, INSERT, UPDATE ON identity_verification_cases TO service_role;
    GRANT SELECT, INSERT ON identity_verification_events TO service_role;
    GRANT EXECUTE ON FUNCTION begin_identity_verification_case_v1(
      UUID,UUID,TEXT,TEXT,TEXT,BOOLEAN,TEXT,TEXT,TIMESTAMPTZ
    ) TO service_role;
    GRANT EXECUTE ON FUNCTION record_identity_verification_event_v1(
      UUID,UUID,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TIMESTAMPTZ,UUID
    ) TO service_role;
  END IF;
END;
$$;
