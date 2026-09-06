-- Universal V1 Work Order command authority v2: actor-assertion kernel only.
--
-- This migration creates no Work Order command, assignment, financial effect,
-- runtime grant, or production capability. An isolated attester may later be
-- granted the public issuer, and a distinct NOLOGIN command owner may later be
-- granted the internal consumer, only by separately reviewed role provisioning.
-- The opaque 256-bit assertion token is never persisted: only its SHA-256
-- digest appears in the two append-only fact relations.

DO $$
BEGIN
  IF to_regclass('public.users') IS NULL
     OR to_regprocedure('public.digest(text,text)') IS NULL
     OR to_regprocedure('public.digest(bytea,text)') IS NULL THEN
    RAISE EXCEPTION
      'HXUV1-ACTOR-0: canonical user identity and exact SHA-256 dependencies must install first'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE SCHEMA IF NOT EXISTS hx_authority;
REVOKE ALL ON SCHEMA hx_authority FROM PUBLIC;

CREATE TABLE IF NOT EXISTS hx_authority.universal_v1_actor_assertion_issuance_facts (
  assertion_id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  token_sha256 CHAR(64) NOT NULL CHECK (
    token_sha256 ~ '^[0-9a-f]{64}$'
    AND token_sha256 <> pg_catalog.repeat('0', 64)
  ),
  environment TEXT NOT NULL CHECK (
    environment IN ('local', 'preview', 'staging')
  ),
  command_kind TEXT NOT NULL CHECK (command_kind IN (
    'EXPRESS_POST_ESTIMATE_INTEREST',
    'PLACE_CONDITIONAL_HOLD',
    'PREPARE_FAKE_WORK_ORDER',
    'MATERIALIZE_FAKE_WORK_ORDER',
    'REQUEST_FAKE_WORK_ORDER_RECOVERY',
    'CLAIM_WORK_ORDER_COMPENSATION'
  )),
  canonical_request_sha256 CHAR(64) NOT NULL CHECK (
    canonical_request_sha256 ~ '^[0-9a-f]{64}$'
    AND canonical_request_sha256 <> pg_catalog.repeat('0', 64)
  ),
  release_manifest_sha256 TEXT NOT NULL CHECK (
    release_manifest_sha256 ~ '^sha256:[0-9a-f]{64}$'
    AND release_manifest_sha256 <> 'sha256:' || pg_catalog.repeat('0', 64)
  ),
  verified_subject TEXT NOT NULL CHECK (
    verified_subject = pg_catalog.btrim(verified_subject)
    AND pg_catalog.char_length(verified_subject) BETWEEN 1 AND 128
    AND verified_subject ~ '^[A-Za-z0-9:_-]+$'
  ),
  verified_issuer TEXT NOT NULL CHECK (
    verified_issuer = pg_catalog.btrim(verified_issuer)
    AND pg_catalog.char_length(verified_issuer) BETWEEN 3 AND 512
  ),
  verified_audience TEXT NOT NULL CHECK (
    verified_audience = pg_catalog.btrim(verified_audience)
    AND pg_catalog.char_length(verified_audience) BETWEEN 1 AND 512
  ),
  verified_at TIMESTAMPTZ NOT NULL,
  bearer_expires_at TIMESTAMPTZ NOT NULL,
  authentication_time TIMESTAMPTZ NOT NULL,
  revocation_checked_at TIMESTAMPTZ NOT NULL,
  authentication_methods JSONB NOT NULL CHECK (
    pg_catalog.jsonb_typeof(authentication_methods) = 'array'
    AND pg_catalog.jsonb_array_length(authentication_methods) BETWEEN 1 AND 8
  ),
  mfa_verified BOOLEAN NOT NULL,
  step_up_satisfied BOOLEAN NOT NULL,
  step_up_method TEXT,
  step_up_verified_at TIMESTAMPTZ,
  auth_facts_sha256 CHAR(64) NOT NULL CHECK (
    auth_facts_sha256 ~ '^[0-9a-f]{64}$'
    AND auth_facts_sha256 <> pg_catalog.repeat('0', 64)
  ),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT universal_v1_actor_assertion_token_v2_uniq UNIQUE (token_sha256),
  CONSTRAINT universal_v1_actor_assertion_lifetime_v2_chk CHECK (
    expires_at > issued_at
    AND expires_at <= issued_at + INTERVAL '60 seconds'
    AND expires_at <= bearer_expires_at
  ),
  CONSTRAINT universal_v1_actor_assertion_verification_time_v2_chk CHECK (
    authentication_time <= verified_at
    AND verified_at <= issued_at
    AND verified_at >= issued_at - INTERVAL '60 seconds'
    AND revocation_checked_at <= issued_at
    AND revocation_checked_at >= issued_at - INTERVAL '60 seconds'
  ),
  CONSTRAINT universal_v1_actor_assertion_step_up_v2_chk CHECK (
    (
      step_up_satisfied
      AND step_up_method IS NOT NULL
      AND step_up_method = pg_catalog.btrim(step_up_method)
      AND pg_catalog.char_length(step_up_method) BETWEEN 1 AND 64
      AND step_up_verified_at IS NOT NULL
      AND step_up_verified_at >= authentication_time
      AND step_up_verified_at <= verified_at
    )
    OR
    (
      NOT step_up_satisfied
      AND step_up_method IS NULL
      AND step_up_verified_at IS NULL
    )
  ),
  CONSTRAINT universal_v1_actor_assertion_exact_binding_v2_uniq UNIQUE (
    assertion_id,
    token_sha256,
    environment,
    command_kind,
    canonical_request_sha256,
    release_manifest_sha256,
    verified_subject,
    auth_facts_sha256,
    mfa_verified,
    step_up_satisfied
  )
);

CREATE TABLE IF NOT EXISTS hx_authority.universal_v1_actor_assertion_consumption_facts (
  consumption_id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  assertion_id UUID NOT NULL,
  token_sha256 CHAR(64) NOT NULL CHECK (
    token_sha256 ~ '^[0-9a-f]{64}$'
    AND token_sha256 <> pg_catalog.repeat('0', 64)
  ),
  environment TEXT NOT NULL CHECK (
    environment IN ('local', 'preview', 'staging')
  ),
  command_kind TEXT NOT NULL,
  canonical_request_sha256 CHAR(64) NOT NULL CHECK (
    canonical_request_sha256 ~ '^[0-9a-f]{64}$'
  ),
  release_manifest_sha256 TEXT NOT NULL CHECK (
    release_manifest_sha256 ~ '^sha256:[0-9a-f]{64}$'
  ),
  verified_subject TEXT NOT NULL,
  resolved_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  auth_facts_sha256 CHAR(64) NOT NULL CHECK (
    auth_facts_sha256 ~ '^[0-9a-f]{64}$'
  ),
  mfa_verified BOOLEAN NOT NULL,
  step_up_satisfied BOOLEAN NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT universal_v1_actor_assertion_consumed_once_v2_uniq UNIQUE (assertion_id),
  CONSTRAINT universal_v1_actor_assertion_consumed_token_v2_uniq UNIQUE (token_sha256),
  CONSTRAINT universal_v1_actor_assertion_consumption_binding_v2_fk FOREIGN KEY (
    assertion_id,
    token_sha256,
    environment,
    command_kind,
    canonical_request_sha256,
    release_manifest_sha256,
    verified_subject,
    auth_facts_sha256,
    mfa_verified,
    step_up_satisfied
  ) REFERENCES hx_authority.universal_v1_actor_assertion_issuance_facts (
    assertion_id,
    token_sha256,
    environment,
    command_kind,
    canonical_request_sha256,
    release_manifest_sha256,
    verified_subject,
    auth_facts_sha256,
    mfa_verified,
    step_up_satisfied
  ) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS universal_v1_actor_assertion_expiry_v2_idx
  ON hx_authority.universal_v1_actor_assertion_issuance_facts(expires_at, assertion_id);
CREATE INDEX IF NOT EXISTS universal_v1_actor_assertion_subject_time_v2_idx
  ON hx_authority.universal_v1_actor_assertion_issuance_facts(
    verified_subject,
    issued_at,
    assertion_id
  );
CREATE INDEX IF NOT EXISTS universal_v1_actor_assertion_consumed_time_v2_idx
  ON hx_authority.universal_v1_actor_assertion_consumption_facts(
    consumed_at,
    consumption_id
  );

CREATE OR REPLACE FUNCTION hx_authority.reject_universal_v1_actor_assertion_mutation_v2()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'HXUV1-ACTOR-1: actor-assertion evidence is append-only'
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_actor_assertion_issuance_no_mutation_v2
  ON hx_authority.universal_v1_actor_assertion_issuance_facts;
CREATE TRIGGER universal_v1_actor_assertion_issuance_no_mutation_v2
BEFORE UPDATE OR DELETE
ON hx_authority.universal_v1_actor_assertion_issuance_facts
FOR EACH ROW
EXECUTE FUNCTION hx_authority.reject_universal_v1_actor_assertion_mutation_v2();

DROP TRIGGER IF EXISTS universal_v1_actor_assertion_issuance_no_truncate_v2
  ON hx_authority.universal_v1_actor_assertion_issuance_facts;
CREATE TRIGGER universal_v1_actor_assertion_issuance_no_truncate_v2
BEFORE TRUNCATE
ON hx_authority.universal_v1_actor_assertion_issuance_facts
FOR EACH STATEMENT
EXECUTE FUNCTION hx_authority.reject_universal_v1_actor_assertion_mutation_v2();

DROP TRIGGER IF EXISTS universal_v1_actor_assertion_consumption_no_mutation_v2
  ON hx_authority.universal_v1_actor_assertion_consumption_facts;
CREATE TRIGGER universal_v1_actor_assertion_consumption_no_mutation_v2
BEFORE UPDATE OR DELETE
ON hx_authority.universal_v1_actor_assertion_consumption_facts
FOR EACH ROW
EXECUTE FUNCTION hx_authority.reject_universal_v1_actor_assertion_mutation_v2();

DROP TRIGGER IF EXISTS universal_v1_actor_assertion_consumption_no_truncate_v2
  ON hx_authority.universal_v1_actor_assertion_consumption_facts;
CREATE TRIGGER universal_v1_actor_assertion_consumption_no_truncate_v2
BEFORE TRUNCATE
ON hx_authority.universal_v1_actor_assertion_consumption_facts
FOR EACH STATEMENT
EXECUTE FUNCTION hx_authority.reject_universal_v1_actor_assertion_mutation_v2();

CREATE OR REPLACE FUNCTION public.hxos_issue_universal_v1_actor_assertion_v1(
  opaque_token TEXT,
  asserted_environment TEXT,
  asserted_command_kind TEXT,
  asserted_canonical_request_sha256 TEXT,
  verified_auth_facts JSONB,
  requested_expires_at TIMESTAMPTZ
)
RETURNS TABLE (
  assertion_id UUID,
  issued_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  database_now TIMESTAMPTZ;
  token_digest TEXT;
  auth_facts_digest TEXT;
  fact_keys TEXT[];
  step_up_keys TEXT[];
  auth_methods JSONB;
  verified_subject_value TEXT;
  verified_issuer_value TEXT;
  verified_audience_value TEXT;
  release_manifest_value TEXT;
  verified_at_value TIMESTAMPTZ;
  bearer_expires_at_value TIMESTAMPTZ;
  authentication_time_value TIMESTAMPTZ;
  revocation_checked_at_value TIMESTAMPTZ;
  mfa_verified_value BOOLEAN;
  step_up_satisfied_value BOOLEAN;
  step_up_method_value TEXT;
  step_up_verified_at_value TIMESTAMPTZ;
  effective_expires_at TIMESTAMPTZ;
BEGIN
  database_now := pg_catalog.clock_timestamp();

  IF opaque_token IS NULL
     OR opaque_token !~ '^[0-9a-f]{64}$'
     OR opaque_token = pg_catalog.repeat('0', 64) THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-2: assertion token must be one opaque 256-bit lowercase-hex value'
      USING ERRCODE = 'P0001';
  END IF;
  IF asserted_environment NOT IN ('local', 'preview', 'staging') THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-3: assertion environment is not isolated nonproduction'
      USING ERRCODE = 'P0001';
  END IF;
  IF asserted_command_kind NOT IN (
    'EXPRESS_POST_ESTIMATE_INTEREST',
    'PLACE_CONDITIONAL_HOLD',
    'PREPARE_FAKE_WORK_ORDER',
    'MATERIALIZE_FAKE_WORK_ORDER',
    'REQUEST_FAKE_WORK_ORDER_RECOVERY',
    'CLAIM_WORK_ORDER_COMPENSATION'
  ) THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-4: assertion command kind is outside the closed V1A set'
      USING ERRCODE = 'P0001';
  END IF;
  IF asserted_canonical_request_sha256 IS NULL
     OR asserted_canonical_request_sha256 !~ '^[0-9a-f]{64}$'
     OR asserted_canonical_request_sha256 = pg_catalog.repeat('0', 64) THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-5: exact canonical request SHA-256 is required'
      USING ERRCODE = 'P0001';
  END IF;
  IF pg_catalog.jsonb_typeof(verified_auth_facts) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-6: verified authentication facts must be one closed object'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT pg_catalog.array_agg(fact_key ORDER BY fact_key)
    INTO fact_keys
    FROM pg_catalog.jsonb_object_keys(verified_auth_facts) AS keys(fact_key);
  IF fact_keys IS DISTINCT FROM ARRAY[
    'amr',
    'audience',
    'auth_time',
    'bearer_expires_at',
    'issuer',
    'mfa_verified',
    'release_manifest_sha256',
    'revocation_checked_at',
    'schema_version',
    'step_up',
    'verified_at',
    'verified_subject'
  ]::TEXT[]
     OR verified_auth_facts->'schema_version' IS DISTINCT FROM '1'::JSONB
     OR pg_catalog.jsonb_typeof(verified_auth_facts->'verified_subject') <> 'string'
     OR pg_catalog.jsonb_typeof(verified_auth_facts->'issuer') <> 'string'
     OR pg_catalog.jsonb_typeof(verified_auth_facts->'audience') <> 'string'
     OR pg_catalog.jsonb_typeof(verified_auth_facts->'release_manifest_sha256') <> 'string'
     OR pg_catalog.jsonb_typeof(verified_auth_facts->'verified_at') <> 'string'
     OR pg_catalog.jsonb_typeof(verified_auth_facts->'bearer_expires_at') <> 'string'
     OR pg_catalog.jsonb_typeof(verified_auth_facts->'auth_time') <> 'string'
     OR pg_catalog.jsonb_typeof(verified_auth_facts->'revocation_checked_at') <> 'string'
     OR pg_catalog.jsonb_typeof(verified_auth_facts->'amr') <> 'array'
     OR pg_catalog.jsonb_typeof(verified_auth_facts->'mfa_verified') <> 'boolean'
     OR pg_catalog.jsonb_typeof(verified_auth_facts->'step_up') <> 'object' THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-6: verified authentication facts must match the exact v1 shape'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT pg_catalog.array_agg(step_key ORDER BY step_key)
    INTO step_up_keys
    FROM pg_catalog.jsonb_object_keys(verified_auth_facts->'step_up') AS keys(step_key);
  IF step_up_keys IS DISTINCT FROM ARRAY['method', 'satisfied', 'verified_at']::TEXT[]
     OR pg_catalog.jsonb_typeof(verified_auth_facts->'step_up'->'satisfied') <> 'boolean'
     OR pg_catalog.jsonb_typeof(verified_auth_facts->'step_up'->'method')
          NOT IN ('string', 'null')
     OR pg_catalog.jsonb_typeof(verified_auth_facts->'step_up'->'verified_at')
          NOT IN ('string', 'null') THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-7: step-up facts must match the exact v1 shape'
      USING ERRCODE = 'P0001';
  END IF;

  auth_methods := verified_auth_facts->'amr';
  IF pg_catalog.jsonb_array_length(auth_methods) NOT BETWEEN 1 AND 8
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.jsonb_array_elements(auth_methods) AS method(value)
        WHERE pg_catalog.jsonb_typeof(value) <> 'string'
           OR value #>> '{}' !~ '^[a-z0-9:_-]{1,64}$'
     ) THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-8: authentication methods must be a bounded typed set'
      USING ERRCODE = 'P0001';
  END IF;

  verified_subject_value := verified_auth_facts->>'verified_subject';
  verified_issuer_value := verified_auth_facts->>'issuer';
  verified_audience_value := verified_auth_facts->>'audience';
  release_manifest_value := verified_auth_facts->>'release_manifest_sha256';
  verified_at_value := (verified_auth_facts->>'verified_at')::TIMESTAMPTZ;
  bearer_expires_at_value := (verified_auth_facts->>'bearer_expires_at')::TIMESTAMPTZ;
  authentication_time_value := (verified_auth_facts->>'auth_time')::TIMESTAMPTZ;
  revocation_checked_at_value :=
    (verified_auth_facts->>'revocation_checked_at')::TIMESTAMPTZ;
  mfa_verified_value := (verified_auth_facts->>'mfa_verified')::BOOLEAN;
  step_up_satisfied_value :=
    (verified_auth_facts->'step_up'->>'satisfied')::BOOLEAN;
  step_up_method_value := verified_auth_facts->'step_up'->>'method';
  step_up_verified_at_value := CASE
    WHEN verified_auth_facts->'step_up'->>'verified_at' IS NULL THEN NULL
    ELSE (verified_auth_facts->'step_up'->>'verified_at')::TIMESTAMPTZ
  END;

  IF verified_subject_value IS NULL
     OR verified_subject_value <> pg_catalog.btrim(verified_subject_value)
     OR pg_catalog.char_length(verified_subject_value) NOT BETWEEN 1 AND 128
     OR verified_subject_value !~ '^[A-Za-z0-9:_-]+$'
     OR verified_issuer_value IS NULL
     OR verified_issuer_value <> pg_catalog.btrim(verified_issuer_value)
     OR pg_catalog.char_length(verified_issuer_value) NOT BETWEEN 3 AND 512
     OR verified_audience_value IS NULL
     OR verified_audience_value <> pg_catalog.btrim(verified_audience_value)
     OR pg_catalog.char_length(verified_audience_value) NOT BETWEEN 1 AND 512
     OR release_manifest_value IS NULL
     OR release_manifest_value !~ '^sha256:[0-9a-f]{64}$'
     OR release_manifest_value = 'sha256:' || pg_catalog.repeat('0', 64) THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-9: verified subject, issuer, audience, and release binding are required'
      USING ERRCODE = 'P0001';
  END IF;

  IF authentication_time_value > verified_at_value
     OR verified_at_value > database_now
     OR verified_at_value < database_now - INTERVAL '60 seconds'
     OR revocation_checked_at_value > database_now
     OR revocation_checked_at_value < database_now - INTERVAL '60 seconds'
     OR bearer_expires_at_value <= database_now THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-10: bearer verification is stale, future-dated, revoked, or expired'
      USING ERRCODE = 'P0001';
  END IF;
  IF mfa_verified_value IS DISTINCT FROM (auth_methods @> '["mfa"]'::JSONB) THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-11: MFA fact contradicts the independently verified methods'
      USING ERRCODE = 'P0001';
  END IF;
  IF (
       step_up_satisfied_value
       AND (
         step_up_method_value IS NULL
         OR step_up_method_value <> pg_catalog.btrim(step_up_method_value)
         OR pg_catalog.char_length(step_up_method_value) NOT BETWEEN 1 AND 64
         OR step_up_verified_at_value IS NULL
         OR step_up_verified_at_value < authentication_time_value
         OR step_up_verified_at_value > verified_at_value
       )
     )
     OR (
       NOT step_up_satisfied_value
       AND (step_up_method_value IS NOT NULL OR step_up_verified_at_value IS NOT NULL)
     ) THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-12: step-up evidence is contradictory'
      USING ERRCODE = 'P0001';
  END IF;
  IF requested_expires_at IS NULL OR requested_expires_at <= database_now THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-13: requested assertion expiry must still be in the future'
      USING ERRCODE = 'P0001';
  END IF;

  effective_expires_at := LEAST(
    requested_expires_at,
    bearer_expires_at_value,
    database_now + INTERVAL '60 seconds'
  );
  IF effective_expires_at <= database_now THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-13: database-owned effective assertion lifetime is empty'
      USING ERRCODE = 'P0001';
  END IF;

  token_digest := pg_catalog.encode(public.digest(opaque_token, 'sha256'), 'hex');
  auth_facts_digest := pg_catalog.encode(
    public.digest(verified_auth_facts::TEXT, 'sha256'),
    'hex'
  );

  RETURN QUERY
  INSERT INTO hx_authority.universal_v1_actor_assertion_issuance_facts (
    token_sha256,
    environment,
    command_kind,
    canonical_request_sha256,
    release_manifest_sha256,
    verified_subject,
    verified_issuer,
    verified_audience,
    verified_at,
    bearer_expires_at,
    authentication_time,
    revocation_checked_at,
    authentication_methods,
    mfa_verified,
    step_up_satisfied,
    step_up_method,
    step_up_verified_at,
    auth_facts_sha256,
    issued_at,
    expires_at
  ) VALUES (
    token_digest,
    asserted_environment,
    asserted_command_kind,
    asserted_canonical_request_sha256,
    release_manifest_value,
    verified_subject_value,
    verified_issuer_value,
    verified_audience_value,
    verified_at_value,
    bearer_expires_at_value,
    authentication_time_value,
    revocation_checked_at_value,
    auth_methods,
    mfa_verified_value,
    step_up_satisfied_value,
    step_up_method_value,
    step_up_verified_at_value,
    auth_facts_digest,
    database_now,
    effective_expires_at
  )
  RETURNING
    universal_v1_actor_assertion_issuance_facts.assertion_id,
    universal_v1_actor_assertion_issuance_facts.issued_at,
    universal_v1_actor_assertion_issuance_facts.expires_at;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-14: assertion token digest already exists'
      USING ERRCODE = 'P0001';
END;
$$;

CREATE OR REPLACE FUNCTION hx_authority.consume_universal_v1_actor_assertion_v1(
  opaque_token TEXT,
  expected_command_kind TEXT,
  canonical_request JSONB,
  expected_environment TEXT
)
RETURNS TABLE (
  assertion_id UUID,
  verified_subject TEXT,
  resolved_user_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  database_now TIMESTAMPTZ;
  token_digest TEXT;
  request_digest TEXT;
  request_keys TEXT[];
  requirement_keys TEXT[];
  request_release_manifest TEXT;
  requirements JSONB;
  command_payload JSONB;
  mfa_required BOOLEAN;
  step_up_required BOOLEAN;
  max_auth_age_seconds INTEGER;
  max_step_up_age_seconds INTEGER;
  issuance hx_authority.universal_v1_actor_assertion_issuance_facts%ROWTYPE;
  canonical_user_id UUID;
BEGIN
  database_now := pg_catalog.clock_timestamp();

  IF opaque_token IS NULL
     OR opaque_token !~ '^[0-9a-f]{64}$'
     OR opaque_token = pg_catalog.repeat('0', 64) THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-15: assertion token is malformed'
      USING ERRCODE = 'P0001';
  END IF;
  IF expected_environment NOT IN ('local', 'preview', 'staging') THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-16: consumer environment is not isolated nonproduction'
      USING ERRCODE = 'P0001';
  END IF;
  IF pg_catalog.jsonb_typeof(canonical_request) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-17: canonical request must be one exact object'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT pg_catalog.array_agg(request_key ORDER BY request_key)
    INTO request_keys
    FROM pg_catalog.jsonb_object_keys(canonical_request) AS keys(request_key);
  IF request_keys IS DISTINCT FROM ARRAY[
    'authentication_requirements',
    'command_payload',
    'release_manifest_sha256',
    'schema_version'
  ]::TEXT[]
     OR canonical_request->'schema_version' IS DISTINCT FROM '1'::JSONB
     OR pg_catalog.jsonb_typeof(canonical_request->'release_manifest_sha256') <> 'string'
     OR pg_catalog.jsonb_typeof(canonical_request->'authentication_requirements') <> 'object'
     OR pg_catalog.jsonb_typeof(canonical_request->'command_payload') <> 'object' THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-17: canonical request must match the closed v1 envelope'
      USING ERRCODE = 'P0001';
  END IF;

  requirements := canonical_request->'authentication_requirements';
  command_payload := canonical_request->'command_payload';
  SELECT pg_catalog.array_agg(requirement_key ORDER BY requirement_key)
    INTO requirement_keys
    FROM pg_catalog.jsonb_object_keys(requirements) AS keys(requirement_key);
  IF requirement_keys IS DISTINCT FROM ARRAY[
    'max_auth_age_seconds',
    'max_step_up_age_seconds',
    'mfa_required',
    'step_up_required'
  ]::TEXT[]
     OR pg_catalog.jsonb_typeof(requirements->'mfa_required') <> 'boolean'
     OR pg_catalog.jsonb_typeof(requirements->'step_up_required') <> 'boolean'
     OR pg_catalog.jsonb_typeof(requirements->'max_auth_age_seconds') <> 'number'
     OR pg_catalog.jsonb_typeof(requirements->'max_step_up_age_seconds')
          NOT IN ('number', 'null') THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-18: authentication requirements must match the closed v1 shape'
      USING ERRCODE = 'P0001';
  END IF;

  IF command_payload::TEXT ~
       '"(actor_id|actor_uuid|auth_facts|authorization|capability|command_kind|environment|firebase_uid|mfa_verified|release_manifest_sha256|role|step_up|verified_subject)"[[:space:]]*:' THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-19: command payload may not carry actor or authority fields'
      USING ERRCODE = 'P0001';
  END IF;

  request_release_manifest := canonical_request->>'release_manifest_sha256';
  IF request_release_manifest IS NULL
     OR request_release_manifest !~ '^sha256:[0-9a-f]{64}$'
     OR request_release_manifest = 'sha256:' || pg_catalog.repeat('0', 64) THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-20: exact release-manifest SHA-256 is required'
      USING ERRCODE = 'P0001';
  END IF;

  IF requirements->>'max_auth_age_seconds' !~ '^[0-9]+$'
     OR (
       requirements->>'max_step_up_age_seconds' IS NOT NULL
       AND requirements->>'max_step_up_age_seconds' !~ '^[0-9]+$'
     ) THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-21: authentication ages must be exact integers'
      USING ERRCODE = 'P0001';
  END IF;
  mfa_required := (requirements->>'mfa_required')::BOOLEAN;
  step_up_required := (requirements->>'step_up_required')::BOOLEAN;
  max_auth_age_seconds := (requirements->>'max_auth_age_seconds')::INTEGER;
  max_step_up_age_seconds := CASE
    WHEN requirements->>'max_step_up_age_seconds' IS NULL THEN NULL
    ELSE (requirements->>'max_step_up_age_seconds')::INTEGER
  END;
  IF max_auth_age_seconds NOT BETWEEN 1 AND 3600
     OR (
       step_up_required
       AND (
         max_step_up_age_seconds IS NULL
         OR max_step_up_age_seconds NOT BETWEEN 1 AND 900
         OR max_step_up_age_seconds > max_auth_age_seconds
       )
     )
     OR (NOT step_up_required AND max_step_up_age_seconds IS NOT NULL) THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-21: authentication ages are outside the closed policy bounds'
      USING ERRCODE = 'P0001';
  END IF;

  token_digest := pg_catalog.encode(public.digest(opaque_token, 'sha256'), 'hex');
  request_digest := pg_catalog.encode(
    public.digest(canonical_request::TEXT, 'sha256'),
    'hex'
  );

  SELECT fact.*
    INTO issuance
    FROM hx_authority.universal_v1_actor_assertion_issuance_facts fact
   WHERE fact.token_sha256 = token_digest
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-22: actor assertion is unknown'
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM hx_authority.universal_v1_actor_assertion_consumption_facts consumed
     WHERE consumed.assertion_id = issuance.assertion_id
  ) THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-23: actor assertion has already been consumed'
      USING ERRCODE = 'P0001';
  END IF;
  IF issuance.expires_at <= database_now
     OR issuance.bearer_expires_at <= database_now THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-24: actor assertion or verified bearer has expired'
      USING ERRCODE = 'P0001';
  END IF;
  IF issuance.environment IS DISTINCT FROM expected_environment THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-25: actor assertion environment does not match'
      USING ERRCODE = 'P0001';
  END IF;
  IF issuance.command_kind IS DISTINCT FROM expected_command_kind THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-26: actor assertion command kind does not match'
      USING ERRCODE = 'P0001';
  END IF;
  IF issuance.release_manifest_sha256 IS DISTINCT FROM request_release_manifest THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-27: actor assertion release manifest does not match'
      USING ERRCODE = 'P0001';
  END IF;
  IF issuance.canonical_request_sha256 IS DISTINCT FROM request_digest THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-28: actor assertion canonical request does not match'
      USING ERRCODE = 'P0001';
  END IF;
  IF mfa_required AND NOT issuance.mfa_verified THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-29: command policy requires independently verified MFA'
      USING ERRCODE = 'P0001';
  END IF;
  IF step_up_required AND NOT issuance.step_up_satisfied THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-30: command policy requires a verified step-up'
      USING ERRCODE = 'P0001';
  END IF;
  IF issuance.authentication_time
       < database_now - pg_catalog.make_interval(secs => max_auth_age_seconds)
     OR (
       step_up_required
       AND issuance.step_up_verified_at
         < database_now - pg_catalog.make_interval(secs => max_step_up_age_seconds)
     ) THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-31: authentication or step-up freshness is insufficient'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT account.id
    INTO canonical_user_id
    FROM public.users account
   WHERE account.firebase_uid = issuance.verified_subject
     AND pg_catalog.upper(account.account_status::TEXT) = 'ACTIVE'
     AND COALESCE(account.is_minor, FALSE) IS FALSE
     AND COALESCE(account.is_banned, FALSE) IS FALSE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-32: verified subject has no current active canonical user'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  INSERT INTO hx_authority.universal_v1_actor_assertion_consumption_facts (
    assertion_id,
    token_sha256,
    environment,
    command_kind,
    canonical_request_sha256,
    release_manifest_sha256,
    verified_subject,
    resolved_user_id,
    auth_facts_sha256,
    mfa_verified,
    step_up_satisfied,
    consumed_at
  ) VALUES (
    issuance.assertion_id,
    issuance.token_sha256,
    issuance.environment,
    issuance.command_kind,
    issuance.canonical_request_sha256,
    issuance.release_manifest_sha256,
    issuance.verified_subject,
    canonical_user_id,
    issuance.auth_facts_sha256,
    issuance.mfa_verified,
    issuance.step_up_satisfied,
    database_now
  )
  RETURNING
    universal_v1_actor_assertion_consumption_facts.assertion_id,
    universal_v1_actor_assertion_consumption_facts.verified_subject,
    universal_v1_actor_assertion_consumption_facts.resolved_user_id;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-23: actor assertion has already been consumed'
      USING ERRCODE = 'P0001';
END;
$$;

REVOKE ALL ON TABLE
  hx_authority.universal_v1_actor_assertion_issuance_facts,
  hx_authority.universal_v1_actor_assertion_consumption_facts
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  hx_authority.reject_universal_v1_actor_assertion_mutation_v2()
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.hxos_issue_universal_v1_actor_assertion_v1(
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    JSONB,
    TIMESTAMPTZ
  )
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  hx_authority.consume_universal_v1_actor_assertion_v1(
    TEXT,
    TEXT,
    JSONB,
    TEXT
  )
FROM PUBLIC;

-- Raw replay must fail closed over a hostile or incompatible pre-existing
-- namespace. The exact fact shape is intentionally frozen; later authority
-- versions add new objects rather than mutating these immutable v1 facts.
DO $$
DECLARE
  issuance_columns TEXT[];
  consumption_columns TEXT[];
  constraint_catalog_sha256 TEXT;
  default_catalog_sha256 TEXT;
  index_catalog_sha256 TEXT;
  trigger_catalog_sha256 TEXT;
  common_owner_count INTEGER;
  required_constraint_count INTEGER;
  required_trigger_count INTEGER;
  sealed_function_count INTEGER;
BEGIN
  IF (
    SELECT relation.relkind <> 'r'
           OR relation.relpersistence <> 'p'
           OR relation.relispartition
           OR relation.relrowsecurity
           OR relation.relforcerowsecurity
           OR relation.relhasrules
      FROM pg_catalog.pg_class relation
     WHERE relation.oid =
       'hx_authority.universal_v1_actor_assertion_issuance_facts'::REGCLASS
  ) OR (
    SELECT relation.relkind <> 'r'
           OR relation.relpersistence <> 'p'
           OR relation.relispartition
           OR relation.relrowsecurity
           OR relation.relforcerowsecurity
           OR relation.relhasrules
      FROM pg_catalog.pg_class relation
     WHERE relation.oid =
       'hx_authority.universal_v1_actor_assertion_consumption_facts'::REGCLASS
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_policy policy_state
     WHERE policy_state.polrelid IN (
       'hx_authority.universal_v1_actor_assertion_issuance_facts'::REGCLASS,
       'hx_authority.universal_v1_actor_assertion_consumption_facts'::REGCLASS
     )
  ) THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-33: assertion facts must be exact persistent ordinary relations without row policy or rewrite authority'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT pg_catalog.array_agg(
           attribute.attname || ':' ||
           pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) || ':' ||
           CASE WHEN attribute.attnotnull THEN 'required' ELSE 'nullable' END
           ORDER BY attribute.attnum
         )
    INTO issuance_columns
    FROM pg_catalog.pg_attribute attribute
   WHERE attribute.attrelid =
         'hx_authority.universal_v1_actor_assertion_issuance_facts'::REGCLASS
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped;
  IF issuance_columns IS DISTINCT FROM ARRAY[
    'assertion_id:uuid:required',
    'token_sha256:character(64):required',
    'environment:text:required',
    'command_kind:text:required',
    'canonical_request_sha256:character(64):required',
    'release_manifest_sha256:text:required',
    'verified_subject:text:required',
    'verified_issuer:text:required',
    'verified_audience:text:required',
    'verified_at:timestamp with time zone:required',
    'bearer_expires_at:timestamp with time zone:required',
    'authentication_time:timestamp with time zone:required',
    'revocation_checked_at:timestamp with time zone:required',
    'authentication_methods:jsonb:required',
    'mfa_verified:boolean:required',
    'step_up_satisfied:boolean:required',
    'step_up_method:text:nullable',
    'step_up_verified_at:timestamp with time zone:nullable',
    'auth_facts_sha256:character(64):required',
    'issued_at:timestamp with time zone:required',
    'expires_at:timestamp with time zone:required'
  ]::TEXT[] THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-34: assertion issuance relation shape is incompatible'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT pg_catalog.array_agg(
           attribute.attname || ':' ||
           pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) || ':' ||
           CASE WHEN attribute.attnotnull THEN 'required' ELSE 'nullable' END
           ORDER BY attribute.attnum
         )
    INTO consumption_columns
    FROM pg_catalog.pg_attribute attribute
   WHERE attribute.attrelid =
         'hx_authority.universal_v1_actor_assertion_consumption_facts'::REGCLASS
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped;
  IF consumption_columns IS DISTINCT FROM ARRAY[
    'consumption_id:uuid:required',
    'assertion_id:uuid:required',
    'token_sha256:character(64):required',
    'environment:text:required',
    'command_kind:text:required',
    'canonical_request_sha256:character(64):required',
    'release_manifest_sha256:text:required',
    'verified_subject:text:required',
    'resolved_user_id:uuid:required',
    'auth_facts_sha256:character(64):required',
    'mfa_verified:boolean:required',
    'step_up_satisfied:boolean:required',
    'consumed_at:timestamp with time zone:required'
  ]::TEXT[] THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-35: assertion consumption relation shape is incompatible'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT pg_catalog.count(*)::INTEGER
    INTO required_constraint_count
    FROM pg_catalog.pg_constraint constraint_state
   WHERE (
       constraint_state.conrelid =
         'hx_authority.universal_v1_actor_assertion_issuance_facts'::REGCLASS
       AND constraint_state.conname IN (
         'universal_v1_actor_assertion_lifetime_v2_chk',
         'universal_v1_actor_assertion_verification_time_v2_chk',
         'universal_v1_actor_assertion_step_up_v2_chk',
         'universal_v1_actor_assertion_token_v2_uniq',
         'universal_v1_actor_assertion_exact_binding_v2_uniq'
       )
     ) OR (
       constraint_state.conrelid =
         'hx_authority.universal_v1_actor_assertion_consumption_facts'::REGCLASS
       AND constraint_state.conname IN (
         'universal_v1_actor_assertion_consumption_binding_v2_fk',
         'universal_v1_actor_assertion_consumed_once_v2_uniq',
         'universal_v1_actor_assertion_consumed_token_v2_uniq'
       )
     );
  IF required_constraint_count <> 8 OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint constraint_state
     WHERE constraint_state.conname IN (
       'universal_v1_actor_assertion_lifetime_v2_chk',
       'universal_v1_actor_assertion_verification_time_v2_chk',
       'universal_v1_actor_assertion_step_up_v2_chk',
       'universal_v1_actor_assertion_token_v2_uniq',
       'universal_v1_actor_assertion_exact_binding_v2_uniq',
       'universal_v1_actor_assertion_consumption_binding_v2_fk',
       'universal_v1_actor_assertion_consumed_once_v2_uniq',
       'universal_v1_actor_assertion_consumed_token_v2_uniq'
     )
       AND NOT constraint_state.convalidated
  ) THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-36: assertion integrity constraints are incomplete'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT pg_catalog.encode(
           public.digest(
             pg_catalog.string_agg(
               pg_catalog.jsonb_build_object(
                 'relation', pg_catalog.format('%I.%I', namespace.nspname, relation.relname),
                 'name', constraint_state.conname,
                 'type', constraint_state.contype,
                 'deferrable', constraint_state.condeferrable,
                 'deferred', constraint_state.condeferred,
                 'validated', constraint_state.convalidated,
                 'no_inherit', constraint_state.connoinherit,
                 'keys', constraint_state.conkey,
                 'referenced_relation', CASE
                   WHEN constraint_state.confrelid = 0 THEN NULL
                   ELSE pg_catalog.format(
                     '%I.%I',
                     referenced_namespace.nspname,
                     referenced_relation.relname
                   )
                 END,
                 'referenced_keys', constraint_state.confkey,
                 'match', constraint_state.confmatchtype,
                 'update', constraint_state.confupdtype,
                 'delete', constraint_state.confdeltype,
                 'is_local', constraint_state.conislocal,
                 'inherit_count', constraint_state.coninhcount,
                 'parent_oid', constraint_state.conparentid,
                 'expression', constraint_state.conbin::TEXT
               )::TEXT,
               E'\n'
               ORDER BY namespace.nspname, relation.relname, constraint_state.conname
             ),
             'sha256'
           ),
           'hex'
         )
    INTO constraint_catalog_sha256
    FROM pg_catalog.pg_constraint constraint_state
    JOIN pg_catalog.pg_class relation
      ON relation.oid = constraint_state.conrelid
    JOIN pg_catalog.pg_namespace namespace
      ON namespace.oid = relation.relnamespace
    LEFT JOIN pg_catalog.pg_class referenced_relation
      ON referenced_relation.oid = constraint_state.confrelid
    LEFT JOIN pg_catalog.pg_namespace referenced_namespace
      ON referenced_namespace.oid = referenced_relation.relnamespace
   WHERE constraint_state.conrelid IN (
     'hx_authority.universal_v1_actor_assertion_issuance_facts'::REGCLASS,
     'hx_authority.universal_v1_actor_assertion_consumption_facts'::REGCLASS
  );
  IF constraint_catalog_sha256 IS DISTINCT FROM
       'a9150b8b5fb671bd4fe3bea33400b5671bfd53d608ef468761933328f95e0111' THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-36: assertion integrity constraint definitions are incompatible'
      USING ERRCODE = 'P0001',
            DETAIL = pg_catalog.format(
              'expected=%s actual=%s',
              'a9150b8b5fb671bd4fe3bea33400b5671bfd53d608ef468761933328f95e0111',
              constraint_catalog_sha256
            );
  END IF;

  SELECT pg_catalog.encode(
           public.digest(
             pg_catalog.string_agg(
               pg_catalog.jsonb_build_object(
                 'relation', pg_catalog.format('%I.%I', namespace.nspname, relation.relname),
                 'column', attribute.attname,
                 'expression', default_state.adbin::TEXT
               )::TEXT,
               E'\n'
               ORDER BY namespace.nspname, relation.relname, attribute.attname
             ),
             'sha256'
           ),
           'hex'
         )
    INTO default_catalog_sha256
    FROM pg_catalog.pg_attribute attribute
    JOIN pg_catalog.pg_attrdef default_state
      ON default_state.adrelid = attribute.attrelid
     AND default_state.adnum = attribute.attnum
    JOIN pg_catalog.pg_class relation
      ON relation.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace namespace
      ON namespace.oid = relation.relnamespace
   WHERE attribute.attrelid IN (
     'hx_authority.universal_v1_actor_assertion_issuance_facts'::REGCLASS,
     'hx_authority.universal_v1_actor_assertion_consumption_facts'::REGCLASS
  );
  IF default_catalog_sha256 IS DISTINCT FROM
       '98bfb7b50044fb6b20fc222499f9fd00033a62d14f58ea6eff0f0100fb63a9b5' THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-41: assertion default expressions are incompatible'
      USING ERRCODE = 'P0001',
            DETAIL = pg_catalog.format(
              'expected=%s actual=%s',
              '98bfb7b50044fb6b20fc222499f9fd00033a62d14f58ea6eff0f0100fb63a9b5',
              default_catalog_sha256
            );
  END IF;

  SELECT pg_catalog.encode(
           public.digest(
             pg_catalog.string_agg(
               pg_catalog.jsonb_build_object(
                 'relation', pg_catalog.format(
                   '%I.%I', table_namespace.nspname, table_relation.relname
                 ),
                 'index', pg_catalog.format(
                   '%I.%I', index_namespace.nspname, index_relation.relname
                 ),
                 'access_method', access_method.amname,
                 'unique', index_state.indisunique,
                 'primary', index_state.indisprimary,
                 'exclusion', index_state.indisexclusion,
                 'immediate', index_state.indimmediate,
                 'clustered', index_state.indisclustered,
                 'valid', index_state.indisvalid,
                 'check_xmin', index_state.indcheckxmin,
                 'ready', index_state.indisready,
                 'live', index_state.indislive,
                 'replica_identity', index_state.indisreplident,
                 'key_attributes', index_state.indnkeyatts,
                 'attributes', index_state.indnatts,
                 'keys', index_state.indkey::TEXT,
                 'opclasses', opclass_names.names,
                 'collations', collation_names.names,
                 'options', index_state.indoption::TEXT,
                 'expressions', index_state.indexprs::TEXT,
                 'predicate', index_state.indpred::TEXT,
                 'reloptions', index_relation.reloptions,
                 'tablespace', COALESCE(tablespace.spcname, '')
               )::TEXT,
               E'\n'
               ORDER BY
                 table_namespace.nspname,
                 table_relation.relname,
                 index_namespace.nspname,
                 index_relation.relname
             ),
             'sha256'
           ),
           'hex'
         )
    INTO index_catalog_sha256
    FROM pg_catalog.pg_index index_state
    JOIN pg_catalog.pg_class table_relation
      ON table_relation.oid = index_state.indrelid
    JOIN pg_catalog.pg_namespace table_namespace
      ON table_namespace.oid = table_relation.relnamespace
    JOIN pg_catalog.pg_class index_relation
      ON index_relation.oid = index_state.indexrelid
    JOIN pg_catalog.pg_namespace index_namespace
      ON index_namespace.oid = index_relation.relnamespace
    JOIN pg_catalog.pg_am access_method
      ON access_method.oid = index_relation.relam
    LEFT JOIN pg_catalog.pg_tablespace tablespace
      ON tablespace.oid = index_relation.reltablespace
    CROSS JOIN LATERAL (
      SELECT pg_catalog.string_agg(
               pg_catalog.format('%I.%I', opclass_namespace.nspname, opclass.opcname),
               ',' ORDER BY item.ordinality
             ) AS names
        FROM pg_catalog.unnest(index_state.indclass::OID[])
          WITH ORDINALITY AS item(oid, ordinality)
        JOIN pg_catalog.pg_opclass opclass
          ON opclass.oid = item.oid
        JOIN pg_catalog.pg_namespace opclass_namespace
          ON opclass_namespace.oid = opclass.opcnamespace
    ) opclass_names
    CROSS JOIN LATERAL (
      SELECT pg_catalog.string_agg(
               CASE
                 WHEN item.oid = 0 THEN '-'
                 ELSE pg_catalog.format(
                   '%I.%I', collation_namespace.nspname, collation_state.collname
                 )
               END,
               ',' ORDER BY item.ordinality
             ) AS names
        FROM pg_catalog.unnest(index_state.indcollation::OID[])
          WITH ORDINALITY AS item(oid, ordinality)
        LEFT JOIN pg_catalog.pg_collation collation_state
          ON collation_state.oid = item.oid
        LEFT JOIN pg_catalog.pg_namespace collation_namespace
          ON collation_namespace.oid = collation_state.collnamespace
    ) collation_names
   WHERE index_state.indrelid IN (
     'hx_authority.universal_v1_actor_assertion_issuance_facts'::REGCLASS,
     'hx_authority.universal_v1_actor_assertion_consumption_facts'::REGCLASS
  );
  IF index_catalog_sha256 IS DISTINCT FROM
       '402883c4d37f7d2725a1235d9ed4a08b5ac1076888e4a3487e3250aa2adbf5ee' THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-42: assertion index graph is incompatible'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT pg_catalog.count(*)::INTEGER,
         pg_catalog.encode(
           public.digest(
             pg_catalog.string_agg(
               pg_catalog.jsonb_build_object(
                 'relation', pg_catalog.format('%I.%I', namespace.nspname, relation.relname),
                 'name', trigger_state.tgname,
                 'enabled', trigger_state.tgenabled,
                 'type', trigger_state.tgtype,
                 'function', pg_catalog.format(
                   '%I.%I(%s)',
                   function_namespace.nspname,
                   function_state.proname,
                   pg_catalog.pg_get_function_identity_arguments(function_state.oid)
                 ),
                 'constraint_oid', trigger_state.tgconstraint,
                 'deferrable', trigger_state.tgdeferrable,
                 'initially_deferred', trigger_state.tginitdeferred,
                 'arguments_count', trigger_state.tgnargs,
                 'arguments', pg_catalog.encode(trigger_state.tgargs, 'hex'),
                 'attribute_numbers', trigger_state.tgattr::TEXT,
                 'condition', trigger_state.tgqual::TEXT,
                 'old_table', trigger_state.tgoldtable,
                 'new_table', trigger_state.tgnewtable,
                 'parent_oid', trigger_state.tgparentid
               )::TEXT,
               E'\n'
               ORDER BY namespace.nspname, relation.relname, trigger_state.tgname
             ),
             'sha256'
           ),
           'hex'
         )
    INTO required_trigger_count, trigger_catalog_sha256
    FROM pg_catalog.pg_trigger trigger_state
    JOIN pg_catalog.pg_class relation
      ON relation.oid = trigger_state.tgrelid
    JOIN pg_catalog.pg_namespace namespace
      ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_proc function_state
      ON function_state.oid = trigger_state.tgfoid
    JOIN pg_catalog.pg_namespace function_namespace
      ON function_namespace.oid = function_state.pronamespace
   WHERE NOT trigger_state.tgisinternal
     AND trigger_state.tgrelid IN (
       'hx_authority.universal_v1_actor_assertion_issuance_facts'::REGCLASS,
       'hx_authority.universal_v1_actor_assertion_consumption_facts'::REGCLASS
     );
  IF required_trigger_count <> 4
     OR trigger_catalog_sha256 IS DISTINCT FROM
       '03b32fc101ff6eefc3cf8b00f83b337d18c53118f5375f910a50dca464107142' THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-37: assertion append-only trigger graph is incompatible'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT pg_catalog.count(*)::INTEGER
    INTO sealed_function_count
    FROM pg_catalog.pg_proc function_state
   WHERE function_state.oid IN (
       'public.hxos_issue_universal_v1_actor_assertion_v1(text,text,text,text,jsonb,timestamptz)'::REGPROCEDURE,
       'hx_authority.consume_universal_v1_actor_assertion_v1(text,text,jsonb,text)'::REGPROCEDURE,
       'hx_authority.reject_universal_v1_actor_assertion_mutation_v2()'::REGPROCEDURE
     )
     AND function_state.prosecdef
     AND function_state.provolatile = 'v'
     AND function_state.proparallel = 'u'
     AND function_state.proconfig = ARRAY['search_path=pg_catalog']::TEXT[];
  IF sealed_function_count <> 3 THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-38: assertion functions are not exactly sealed'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT pg_catalog.count(DISTINCT owner_oid)::INTEGER
    INTO common_owner_count
    FROM (
      SELECT namespace.nspowner AS owner_oid
        FROM pg_catalog.pg_namespace namespace
       WHERE namespace.nspname = 'hx_authority'
      UNION ALL
      SELECT relation.relowner
        FROM pg_catalog.pg_class relation
       WHERE relation.oid IN (
         'hx_authority.universal_v1_actor_assertion_issuance_facts'::REGCLASS,
         'hx_authority.universal_v1_actor_assertion_consumption_facts'::REGCLASS
       )
      UNION ALL
      SELECT function_state.proowner
        FROM pg_catalog.pg_proc function_state
       WHERE function_state.oid IN (
         'public.hxos_issue_universal_v1_actor_assertion_v1(text,text,text,text,jsonb,timestamptz)'::REGPROCEDURE,
         'hx_authority.consume_universal_v1_actor_assertion_v1(text,text,jsonb,text)'::REGPROCEDURE,
         'hx_authority.reject_universal_v1_actor_assertion_mutation_v2()'::REGPROCEDURE
       )
    ) owners;
  IF common_owner_count <> 1 THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-39: assertion schema, facts, and sealed functions require one exact owner'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_namespace namespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          namespace.nspacl,
          pg_catalog.acldefault('n', namespace.nspowner)
        )
      ) privilege
     WHERE namespace.nspname = 'hx_authority'
       AND privilege.grantee = 0
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
      ) privilege
     WHERE relation.oid IN (
       'hx_authority.universal_v1_actor_assertion_issuance_facts'::REGCLASS,
       'hx_authority.universal_v1_actor_assertion_consumption_facts'::REGCLASS
     )
       AND privilege.grantee = 0
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc function_state
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_state.proacl,
          pg_catalog.acldefault('f', function_state.proowner)
        )
      ) privilege
     WHERE function_state.oid IN (
       'public.hxos_issue_universal_v1_actor_assertion_v1(text,text,text,text,jsonb,timestamptz)'::REGPROCEDURE,
       'hx_authority.consume_universal_v1_actor_assertion_v1(text,text,jsonb,text)'::REGPROCEDURE,
       'hx_authority.reject_universal_v1_actor_assertion_mutation_v2()'::REGPROCEDURE
     )
       AND privilege.grantee = 0
  ) THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-40: PUBLIC authority over assertion objects is forbidden'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

COMMENT ON SCHEMA hx_authority IS
  'Sealed append-only actor-assertion facts. No Work Order, financial, assignment, deployment, or production capability.';
COMMENT ON TABLE hx_authority.universal_v1_actor_assertion_issuance_facts IS
  'One append-only isolated-attester issuance fact. Stores only the opaque token SHA-256 digest and exact verified bindings; never the token or caller-selected actor UUID.';
COMMENT ON TABLE hx_authority.universal_v1_actor_assertion_consumption_facts IS
  'One append-only exactly-once consumption fact resolving the independently verified subject to the current canonical user.';
COMMENT ON COLUMN
  hx_authority.universal_v1_actor_assertion_issuance_facts.token_sha256 IS
  'SHA-256 digest of the transient random 256-bit opaque token. Plaintext storage is prohibited.';
COMMENT ON FUNCTION public.hxos_issue_universal_v1_actor_assertion_v1(
  TEXT,
  TEXT,
  TEXT,
  TEXT,
  JSONB,
  TIMESTAMPTZ
) IS
  'Sealed isolated-attester issuer. It creates no Work Order, assignment, money, deployment, or production effect and receives no runtime grant in this migration.';
COMMENT ON FUNCTION hx_authority.consume_universal_v1_actor_assertion_v1(
  TEXT,
  TEXT,
  JSONB,
  TEXT
) IS
  'Internal exactly-once consumer for a future separately approved sealed command owner; not a public/API/worker command.';
