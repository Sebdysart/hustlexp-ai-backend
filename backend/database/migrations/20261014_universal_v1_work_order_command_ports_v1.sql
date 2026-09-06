-- Universal V1 Work Order sealed command ports v1.
--
-- This migration is restricted to isolated local, preview, and staging
-- targets, synthetic data, and fake financial value. It creates no database
-- role, credential, runtime grant, hard assignment, real-money capability,
-- deployment authority, or production effect. Runtime ACLs and ownership are
-- provisioned and read back separately; every function and relation below is
-- born with PUBLIC authority revoked.

SELECT pg_catalog.set_config('search_path', 'pg_catalog', true);

DO $$
BEGIN
  IF pg_catalog.to_regclass(
       'public.hxos_fake_financial_schema_evidence_v12'
     ) IS NOT NULL
     OR (
       pg_catalog.to_regclass('public.applied_migrations') IS NOT NULL
       AND EXISTS (
         SELECT 1
           FROM public.applied_migrations applied
          WHERE applied.name =
            '20261015_universal_v1_work_order_fake_financial_authority_hardening_v12'
       )
     ) THEN
    RAISE EXCEPTION
      'HXUV1-WOCMD-0C: future v12 evidence must be absent before ordinal146 installs or replays'
      USING ERRCODE = 'P0001';
  END IF;

  IF pg_catalog.to_regclass('hx_authority.universal_v1_actor_assertion_consumption_facts') IS NULL
     OR pg_catalog.to_regprocedure(
       'hx_authority.consume_universal_v1_actor_assertion_v1(text,text,jsonb,text)'
     ) IS NULL
     OR pg_catalog.to_regclass('public.task_work_order_command_requests') IS NULL
     OR pg_catalog.to_regclass('public.task_provider_eligibility_decisions') IS NULL
     OR pg_catalog.to_regclass('public.task_work_orders') IS NULL
     OR pg_catalog.to_regclass('public.task_work_order_execution_facts') IS NULL
     OR pg_catalog.to_regclass('public.task_reservations') IS NULL
     OR pg_catalog.to_regclass('public.task_applications') IS NULL
     OR pg_catalog.to_regclass('public.universal_v1_work_order_compensation_commands') IS NULL
     OR pg_catalog.to_regprocedure(
       'public.claim_universal_v1_work_order_compensations(integer,integer)'
     ) IS NULL THEN
    RAISE EXCEPTION
      'HXUV1-WOCMD-0: actor assertion, Work Order, compensation, and SHA-256 authority must install first'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;


-- Forward-seal the actor assertion hash and request protocol on the core
-- PostgreSQL SHA-256 primitive. The actor-signed request now binds the exact
-- command kind and current Work Order target authority, so an unused assertion
-- cannot cross a same-release target activation.
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

  token_digest := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(opaque_token, 'UTF8')),
    'hex'
  );
  auth_facts_digest := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(verified_auth_facts::TEXT, 'UTF8')),
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
  target_keys TEXT[];
  request_command_kind TEXT;
  request_release_manifest TEXT;
  target_authority JSONB;
  target_authority_id TEXT;
  target_authority_version INTEGER;
  target_database_name TEXT;
  target_environment TEXT;
  target_release_manifest TEXT;
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
    'command_kind',
    'command_payload',
    'release_manifest_sha256',
    'schema_version',
    'target_authority'
  ]::TEXT[]
     OR canonical_request->'schema_version' IS DISTINCT FROM '1'::JSONB
     OR pg_catalog.jsonb_typeof(canonical_request->'command_kind') <> 'string'
     OR pg_catalog.jsonb_typeof(canonical_request->'release_manifest_sha256') <> 'string'
     OR pg_catalog.jsonb_typeof(canonical_request->'target_authority') <> 'object'
     OR pg_catalog.jsonb_typeof(canonical_request->'authentication_requirements') <> 'object'
     OR pg_catalog.jsonb_typeof(canonical_request->'command_payload') <> 'object' THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-17: canonical request must match the closed v1 envelope'
      USING ERRCODE = 'P0001';
  END IF;

  request_command_kind := canonical_request->>'command_kind';
  target_authority := canonical_request->'target_authority';
  requirements := canonical_request->'authentication_requirements';
  command_payload := canonical_request->'command_payload';
  IF request_command_kind IS DISTINCT FROM expected_command_kind THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-17: canonical request command kind does not match'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT pg_catalog.array_agg(target_key ORDER BY target_key)
    INTO target_keys
    FROM pg_catalog.jsonb_object_keys(target_authority) AS keys(target_key);
  IF target_keys IS DISTINCT FROM ARRAY[
    'database',
    'environment',
    'id',
    'release',
    'version'
  ]::TEXT[]
     OR pg_catalog.jsonb_typeof(target_authority->'id') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(target_authority->'version') IS DISTINCT FROM 'number'
     OR pg_catalog.jsonb_typeof(target_authority->'database') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(target_authority->'environment') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(target_authority->'release') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-17: canonical target authority must match the closed v1 shape'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT pg_catalog.array_agg(requirement_key ORDER BY requirement_key)
    INTO requirement_keys
    FROM pg_catalog.jsonb_object_keys(requirements) AS keys(requirement_key);
  IF requirement_keys IS DISTINCT FROM ARRAY[
    'max_auth_age_seconds',
    'max_step_up_age_seconds',
    'mfa_required',
    'step_up_required'
  ]::TEXT[]
     OR pg_catalog.jsonb_typeof(requirements->'mfa_required') IS DISTINCT FROM 'boolean'
     OR pg_catalog.jsonb_typeof(requirements->'step_up_required') IS DISTINCT FROM 'boolean'
     OR pg_catalog.jsonb_typeof(requirements->'max_auth_age_seconds') IS DISTINCT FROM 'number'
     OR pg_catalog.jsonb_typeof(requirements->'max_step_up_age_seconds') IS NULL
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
  target_authority_id := target_authority->>'id';
  target_database_name := target_authority->>'database';
  target_environment := target_authority->>'environment';
  target_release_manifest := target_authority->>'release';
  IF target_authority->>'version' IS NULL
     OR target_authority->>'version' !~ '^[1-9][0-9]{0,8}$' THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-20: exact target authority version is required'
      USING ERRCODE = 'P0001';
  END IF;
  target_authority_version := (target_authority->>'version')::INTEGER;
  IF request_release_manifest IS NULL
     OR request_release_manifest !~ '^sha256:[0-9a-f]{64}$'
     OR request_release_manifest = 'sha256:' || pg_catalog.repeat('0', 64)
     OR target_authority_id IS NULL
     OR target_authority_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR target_authority_version < 1
     OR target_database_name IS DISTINCT FROM pg_catalog.current_database()
     OR target_environment IS DISTINCT FROM expected_environment
     OR target_release_manifest IS DISTINCT FROM request_release_manifest THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-20: exact release and target authority binding are required'
      USING ERRCODE = 'P0001';
  END IF;

  IF requirements->>'max_auth_age_seconds' IS NULL
     OR requirements->>'max_auth_age_seconds' !~ '^[0-9]+$'
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
  IF max_auth_age_seconds IS NULL
     OR max_auth_age_seconds NOT BETWEEN 1 AND 3600
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

  token_digest := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(opaque_token, 'UTF8')),
    'hex'
  );
  request_digest := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(canonical_request::TEXT, 'UTF8')),
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
  IF issuance.expires_at IS NULL
     OR issuance.bearer_expires_at IS NULL
     OR issuance.expires_at <= database_now
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
  IF mfa_required AND issuance.mfa_verified IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-29: command policy requires independently verified MFA'
      USING ERRCODE = 'P0001';
  END IF;
  IF step_up_required AND issuance.step_up_satisfied IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-30: command policy requires a verified step-up'
      USING ERRCODE = 'P0001';
  END IF;
  IF issuance.authentication_time IS NULL
     OR issuance.authentication_time
       < database_now - pg_catalog.make_interval(secs => max_auth_age_seconds)
     OR (
       step_up_required
       AND (
         issuance.step_up_verified_at IS NULL
         OR issuance.step_up_verified_at
           < database_now - pg_catalog.make_interval(secs => max_step_up_age_seconds)
       )
     ) THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-31: authentication or step-up freshness is insufficient'
      USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    SELECT account.id
      INTO STRICT canonical_user_id
      FROM public.users account
     WHERE account.firebase_uid = issuance.verified_subject
       AND pg_catalog.upper(account.account_status::TEXT) = 'ACTIVE'
       AND COALESCE(account.is_minor, FALSE) IS FALSE
       AND COALESCE(account.is_banned, FALSE) IS FALSE;
  EXCEPTION
    WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
      RAISE EXCEPTION 'HXUV1-ACTOR-32: verified subject must resolve to exactly one current active canonical user'
        USING ERRCODE = 'P0001';
  END;

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


-- Direct Work Order authority digests do not depend on pgcrypto. These
-- ordinary, dump-stable HustleXP helpers accept only SHA-256 and delegate to
-- PostgreSQL's built-in primitive. Every protected transitive trigger caller
-- is forward-normalized onto these helpers below.
CREATE OR REPLACE FUNCTION public.hxos_universal_v1_sha256_bytes_v1(
  input_value TEXT,
  algorithm TEXT
)
RETURNS BYTEA
LANGUAGE plpgsql
SECURITY INVOKER
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
BEGIN
  IF algorithm IS DISTINCT FROM 'sha256' THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-HASH-1: only the pinned SHA-256 algorithm is allowed'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN pg_catalog.sha256(pg_catalog.convert_to(input_value, 'UTF8'));
END;
$$;

CREATE OR REPLACE FUNCTION public.hxos_universal_v1_sha256_bytes_v1(
  input_value BYTEA,
  algorithm TEXT
)
RETURNS BYTEA
LANGUAGE plpgsql
SECURITY INVOKER
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
BEGIN
  IF algorithm IS DISTINCT FROM 'sha256' THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-HASH-1: only the pinned SHA-256 algorithm is allowed'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN pg_catalog.sha256(input_value);
END;
$$;

REVOKE ALL ON FUNCTION public.hxos_universal_v1_sha256_bytes_v1(TEXT, TEXT)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hxos_universal_v1_sha256_bytes_v1(BYTEA, TEXT)
  FROM PUBLIC;

-- Exact transitive hash dependencies reached by protected Work Order trigger
-- roots. These dump-stable helper bodies are certified by the runtime
-- authority manifest together with their exact owner and ACL.
CREATE OR REPLACE FUNCTION public.universal_v1_relationship_deterministic_uuid(
  canonical_identity TEXT
)
RETURNS UUID
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  WITH value AS (
    SELECT pg_catalog.encode(
      public.hxos_universal_v1_sha256_bytes_v1(canonical_identity, 'sha256'),
      'hex'
    ) AS hex
  )
  SELECT (
    pg_catalog.substr(hex, 1, 8) || '-' || pg_catalog.substr(hex, 9, 4) || '-5' ||
    pg_catalog.substr(hex, 14, 3) || '-8' || pg_catalog.substr(hex, 18, 3) || '-' ||
    pg_catalog.substr(hex, 21, 12)
  )::UUID
  FROM value
$$;

CREATE OR REPLACE FUNCTION public.universal_v1_execution_command_request_sha256(
  checked_actor_user_id UUID,
  checked_work_order_id UUID,
  checked_action TEXT,
  checked_expected_execution_version INTEGER,
  checked_expected_scope_version INTEGER,
  checked_idempotency_key TEXT,
  checked_client_occurred_at TIMESTAMPTZ,
  checked_reason TEXT
)
RETURNS CHAR(64)
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT pg_catalog.encode(
    public.hxos_universal_v1_sha256_bytes_v1(
      '{' ||
      '"actor_user_id":' || pg_catalog.to_json(checked_actor_user_id::TEXT)::TEXT || ',' ||
      '"command":{' ||
        '"action":' || pg_catalog.to_json(checked_action)::TEXT || ',' ||
        '"client_ts":' || pg_catalog.to_json(
          pg_catalog.to_char(
            checked_client_occurred_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          )
        )::TEXT || ',' ||
        '"expected_execution_version":' || checked_expected_execution_version::TEXT || ',' ||
        '"expected_scope_version":' || checked_expected_scope_version::TEXT || ',' ||
        '"idempotency_key":' || pg_catalog.to_json(checked_idempotency_key)::TEXT || ',' ||
        CASE
          WHEN checked_reason IS NULL THEN ''
          ELSE '"reason":' || pg_catalog.to_json(checked_reason)::TEXT || ','
        END ||
        '"work_order_id":' || pg_catalog.to_json(checked_work_order_id::TEXT)::TEXT ||
      '},' ||
      '"contract_version":1,' ||
      '"operation":"ADVANCE_WORK_ORDER_EXECUTION"' ||
      '}',
      'sha256'
    ),
    'hex'
  )::CHAR(64)
$$;

CREATE OR REPLACE FUNCTION public.universal_v1_task_opportunity_interest_request_sha256(
  p_actor_user_id UUID,
  p_opportunity_id UUID,
  p_expected_opportunity_version INTEGER,
  p_provider_organization_id UUID,
  p_business_credential_id UUID,
  p_idempotency_key TEXT
)
RETURNS CHAR(64)
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT pg_catalog.encode(
    public.hxos_universal_v1_sha256_bytes_v1(
      pg_catalog.concat_ws('|',
        'HX_UNIVERSAL_V1_EXPRESS_INTEREST_V1',
        p_actor_user_id::TEXT,
        p_opportunity_id::TEXT,
        p_expected_opportunity_version::TEXT,
        COALESCE(p_provider_organization_id::TEXT, ''),
        COALESCE(p_business_credential_id::TEXT, ''),
        p_idempotency_key
      ),
      'sha256'
    ),
    'hex'
  )::CHAR(64)
$$;

CREATE OR REPLACE FUNCTION public.ensure_universal_v1_marketplace_relationship_origin(
  exact_task_draft_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  draft public.task_drafts%ROWTYPE;
  initiator_id UUID;
  customer_identity_id UUID;
  customer_consent_id UUID;
  origin_id UUID;
  source_digest CHAR(64);
BEGIN
  SELECT * INTO draft
    FROM public.task_drafts
   WHERE id = exact_task_draft_id
   FOR UPDATE;
  IF NOT FOUND
     OR draft.relationship_origin_contract_version <> 1
     OR draft.relationship_origin_kind <> 'MARKETPLACE'
     OR draft.relationship_origin_policy_version <> 1
     OR draft.relationship_origin_intake_consent_version <> 'v1' THEN
    RAISE EXCEPTION 'HXUV1-REL-25: Marketplace bootstrap requires the exact v1 TaskDraft intake contract'
      USING ERRCODE = 'P0001';
  END IF;

  initiator_id := public.universal_v1_relationship_deterministic_uuid(
    'relationship-origin-observation:' || draft.id::TEXT ||
    ':INITIATOR_IDENTITY_OBSERVED:v1'
  );
  customer_identity_id := public.universal_v1_relationship_deterministic_uuid(
    'relationship-origin-observation:' || draft.id::TEXT ||
    ':CUSTOMER_IDENTITY_OBSERVED:v1'
  );
  customer_consent_id := public.universal_v1_relationship_deterministic_uuid(
    'relationship-origin-observation:' || draft.id::TEXT ||
    ':CUSTOMER_CONSENT_OBSERVED:v1'
  );

  source_digest := pg_catalog.encode(public.hxos_universal_v1_sha256_bytes_v1(
    'MARKETPLACE_INITIATOR|' || draft.id::TEXT || '|' || draft.card_token_hash,
    'sha256'
  ), 'hex')::CHAR(64);
  INSERT INTO public.universal_v1_relationship_origin_observations (
    id, task_draft_id, policy_version, origin_kind, observation_version,
    observation_kind, subject_role, identity_basis,
    subject_binding_sha256, source_evidence_sha256
  ) VALUES (
    initiator_id, draft.id, 1, 'MARKETPLACE', 1,
    'INITIATOR_IDENTITY_OBSERVED', 'CUSTOMER', 'TASK_DRAFT_CAPABILITY',
    draft.card_token_hash, source_digest
  ) ON CONFLICT (task_draft_id, observation_kind, observation_version) DO NOTHING;

  source_digest := pg_catalog.encode(public.hxos_universal_v1_sha256_bytes_v1(
    'MARKETPLACE_CUSTOMER|' || draft.id::TEXT || '|' || draft.card_token_hash,
    'sha256'
  ), 'hex')::CHAR(64);
  INSERT INTO public.universal_v1_relationship_origin_observations (
    id, task_draft_id, policy_version, origin_kind, observation_version,
    observation_kind, subject_role, identity_basis,
    subject_binding_sha256, source_evidence_sha256
  ) VALUES (
    customer_identity_id, draft.id, 1, 'MARKETPLACE', 1,
    'CUSTOMER_IDENTITY_OBSERVED', 'CUSTOMER', 'TASK_DRAFT_CAPABILITY',
    draft.card_token_hash, source_digest
  ) ON CONFLICT (task_draft_id, observation_kind, observation_version) DO NOTHING;

  source_digest := pg_catalog.encode(public.hxos_universal_v1_sha256_bytes_v1(
    'MARKETPLACE_CUSTOMER_CONSENT|' || draft.id::TEXT || '|v1|' ||
    draft.card_token_hash, 'sha256'
  ), 'hex')::CHAR(64);
  INSERT INTO public.universal_v1_relationship_origin_observations (
    id, task_draft_id, policy_version, origin_kind, observation_version,
    observation_kind, subject_role, identity_basis,
    subject_binding_sha256, consent_contract_version,
    source_evidence_sha256
  ) VALUES (
    customer_consent_id, draft.id, 1, 'MARKETPLACE', 1,
    'CUSTOMER_CONSENT_OBSERVED', 'CUSTOMER', 'TASK_DRAFT_CAPABILITY',
    draft.card_token_hash, 'v1', source_digest
  ) ON CONFLICT (task_draft_id, observation_kind, observation_version) DO NOTHING;

  origin_id := public.universal_v1_relationship_deterministic_uuid(
    'relationship-origin:' || draft.id::TEXT || ':v1'
  );
  INSERT INTO public.universal_v1_relationship_origins (
    id, task_draft_id, policy_version, origin_kind, origin_version,
    initiator_identity_observation_id, customer_identity_observation_id,
    customer_consent_observation_id
  ) VALUES (
    origin_id, draft.id, 1, 'MARKETPLACE', 1,
    initiator_id, customer_identity_id, customer_consent_id
  ) ON CONFLICT (task_draft_id, origin_version) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
      FROM public.universal_v1_relationship_origins origin
      JOIN public.universal_v1_relationship_origin_observations initiator
        ON initiator.id = origin.initiator_identity_observation_id
      JOIN public.universal_v1_relationship_origin_observations customer_identity
        ON customer_identity.id = origin.customer_identity_observation_id
      JOIN public.universal_v1_relationship_origin_observations customer_consent
        ON customer_consent.id = origin.customer_consent_observation_id
     WHERE origin.id = origin_id
       AND origin.task_draft_id = draft.id
       AND origin.origin_kind = 'MARKETPLACE'
       AND origin.policy_version = 1
       AND origin.origin_version = 1
       AND origin.initiator_identity_observation_id = initiator_id
       AND origin.customer_identity_observation_id = customer_identity_id
       AND origin.customer_consent_observation_id = customer_consent_id
       AND origin.provider_link_observation_id IS NULL
       AND origin.provider_consent_observation_id IS NULL
       AND origin.routing_state = 'ROUTING_READY'
       AND pg_catalog.cardinality(origin.hold_reason_codes) = 0
       AND initiator.source_evidence_sha256 = pg_catalog.encode(
         public.hxos_universal_v1_sha256_bytes_v1(
           'MARKETPLACE_INITIATOR|' || draft.id::TEXT || '|' || draft.card_token_hash,
           'sha256'
         ), 'hex')::CHAR(64)
       AND customer_identity.source_evidence_sha256 = pg_catalog.encode(
         public.hxos_universal_v1_sha256_bytes_v1(
           'MARKETPLACE_CUSTOMER|' || draft.id::TEXT || '|' || draft.card_token_hash,
           'sha256'
         ), 'hex')::CHAR(64)
       AND customer_consent.source_evidence_sha256 = pg_catalog.encode(
         public.hxos_universal_v1_sha256_bytes_v1(
           'MARKETPLACE_CUSTOMER_CONSENT|' || draft.id::TEXT || '|v1|' ||
           draft.card_token_hash, 'sha256'
         ), 'hex')::CHAR(64)
  ) THEN
    RAISE EXCEPTION 'HXUV1-REL-26: Marketplace bootstrap replay does not match exact certified evidence'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN origin_id;
END;
$$;

REVOKE ALL ON FUNCTION public.universal_v1_relationship_deterministic_uuid(TEXT)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_universal_v1_marketplace_relationship_origin(UUID)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_execution_command_request_sha256(
  UUID, UUID, TEXT, INTEGER, INTEGER, TEXT, TIMESTAMPTZ, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_task_opportunity_interest_request_sha256(
  UUID, UUID, INTEGER, UUID, UUID, TEXT
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.universal_v1_work_order_operation_id_v1(
  work_order_idempotency_key TEXT,
  operation_label TEXT
)
RETURNS UUID
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
  hexadecimal TEXT;
  variant_nibble TEXT;
BEGIN
  hexadecimal := substr(
    encode(public.hxos_universal_v1_sha256_bytes_v1(work_order_idempotency_key || ':' || operation_label, 'sha256'), 'hex'),
    1,
    32
  );
  variant_nibble := CASE substr(hexadecimal, 17, 1)
    WHEN '0' THEN '8' WHEN '1' THEN '9' WHEN '2' THEN 'a' WHEN '3' THEN 'b'
    WHEN '4' THEN '8' WHEN '5' THEN '9' WHEN '6' THEN 'a' WHEN '7' THEN 'b'
    WHEN '8' THEN '8' WHEN '9' THEN '9' WHEN 'a' THEN 'a' WHEN 'b' THEN 'b'
    WHEN 'c' THEN '8' WHEN 'd' THEN '9' WHEN 'e' THEN 'a' WHEN 'f' THEN 'b'
  END;
  hexadecimal := overlay(hexadecimal placing '4' from 13 for 1);
  hexadecimal := overlay(hexadecimal placing variant_nibble from 17 for 1);
  RETURN (
    substr(hexadecimal, 1, 8) || '-' || substr(hexadecimal, 9, 4) || '-' ||
    substr(hexadecimal, 13, 4) || '-' || substr(hexadecimal, 17, 4) || '-' ||
    substr(hexadecimal, 21, 12)
  )::UUID;
END;
$$;

CREATE OR REPLACE FUNCTION public.universal_v1_execution_internal_request_sha256(
  checked_actor_user_id UUID,
  checked_work_order_id UUID,
  checked_transition_kind TEXT,
  checked_state TEXT,
  checked_expected_execution_version INTEGER,
  checked_scope_version_id UUID,
  checked_completion_fact_id UUID,
  checked_work_order_amendment_id UUID,
  checked_idempotency_key TEXT,
  checked_client_occurred_at TIMESTAMPTZ,
  checked_reason TEXT
)
RETURNS CHAR(64)
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT encode(
    public.hxos_universal_v1_sha256_bytes_v1(
      jsonb_build_object(
        'contract', 'HUSTLEXP_UNIVERSAL_V1_EXECUTION_INTERNAL_V1',
        'actorUserId', checked_actor_user_id,
        'workOrderId', checked_work_order_id,
        'transitionKind', checked_transition_kind,
        'state', checked_state,
        'expectedExecutionVersion', checked_expected_execution_version,
        'scopeVersionId', checked_scope_version_id,
        'completionFactId', checked_completion_fact_id,
        'workOrderAmendmentId', checked_work_order_amendment_id,
        'idempotencyKey', checked_idempotency_key,
        'clientOccurredAt', to_char(
          checked_client_occurred_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'reason', checked_reason
      )::TEXT,
      'sha256'
    ),
    'hex'
  )::CHAR(64);
$$;

-- Protected transitive trigger callers are forward-normalized onto the ordinary,
-- dump-stable core SHA helper. This removes pgcrypto from the sealed Work Order
-- command authority call graph without mutating extension-owned functions.

-- Major-action telemetry must never infer production posture from a database
-- name or a caller-writable GUC. The exact current Work Order target is the
-- sealed environment authority. An entirely empty target chain preserves the
-- legacy production telemetry path. Once any target fact exists, this port
-- returns TEST only after proving one exact nonproduction tip for this database
-- while holding the target-activation lock.
CREATE OR REPLACE FUNCTION public.hxos_read_universal_v1_telemetry_environment_v1()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  target_fact_count INTEGER;
  current_tip_count INTEGER;
  current_target_database TEXT;
  current_target_environment TEXT;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hxuv1-work-order-target-authority-v1', 0)
  );

  SELECT pg_catalog.count(*)::INTEGER
    INTO target_fact_count
    FROM hx_authority.universal_v1_work_order_target_authority_facts;

  -- Empty is the only legacy production shape. Once any append-only target
  -- fact exists, telemetry must bind to one exact current nonproduction tip;
  -- it can never fall back to caller input or a database-name heuristic.
  IF target_fact_count = 0 THEN
    RETURN 'PRODUCTION';
  END IF;

  SELECT pg_catalog.count(*)::INTEGER,
         pg_catalog.min(target.target_database_name),
         pg_catalog.min(target.environment)
    INTO current_tip_count, current_target_database, current_target_environment
    FROM hx_authority.universal_v1_work_order_target_authority_facts target
   WHERE NOT EXISTS (
     SELECT 1
       FROM hx_authority.universal_v1_work_order_target_authority_facts successor
      WHERE successor.supersedes_target_authority_id = target.target_authority_id
   );

  IF current_tip_count <> 1
     OR current_target_database IS DISTINCT FROM pg_catalog.current_database()
     OR current_target_environment IS NULL
     OR current_target_environment NOT IN ('local', 'preview', 'staging') THEN
    RAISE EXCEPTION
      'HXUV1-WOCMD-5: telemetry requires one exact nonproduction target authority'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN 'TEST';
END;
$$;

REVOKE ALL ON FUNCTION public.hxos_read_universal_v1_telemetry_environment_v1()
  FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.record_major_action_event(
  p_event_name TEXT,
  p_action_class TEXT,
  p_automation_class TEXT,
  p_actor_role TEXT,
  p_actor_ref TEXT,
  p_aggregate_type TEXT,
  p_aggregate_id TEXT,
  p_previous_lifecycle_state TEXT,
  p_lifecycle_state TEXT,
  p_sync_state TEXT,
  p_entry_surface TEXT,
  p_context_source TEXT,
  p_policy_version TEXT,
  p_policy_applicability TEXT,
  p_recommendation_id UUID,
  p_model_version TEXT,
  p_model_applicability TEXT,
  p_risk_class TEXT,
  p_correlation_id TEXT,
  p_causation_id TEXT,
  p_idempotency_key TEXT,
  p_source_sequence BIGINT,
  p_payload_hash TEXT,
  p_result TEXT,
  p_failure_reason_code TEXT,
  p_recovery_action_code TEXT,
  p_change_reason_code TEXT,
  p_experiment_variant TEXT,
  p_experiment_applicability TEXT,
  p_reversible BOOLEAN,
  p_source_table TEXT,
  p_source_event_id TEXT,
  p_occurred_at TIMESTAMPTZ,
  p_event_version INTEGER DEFAULT 1
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_existing public.major_action_events%ROWTYPE;
  v_id UUID;
  v_max_sequence BIGINT;
  v_sequence BIGINT;
  v_ordering_state TEXT;
  v_recorded_at TIMESTAMPTZ := pg_catalog.clock_timestamp();
  v_latency_ms INTEGER;
  v_latency_class TEXT;
  v_environment TEXT;
  v_is_test BOOLEAN;
  v_recovery_action_code TEXT := p_recovery_action_code;
BEGIN
  SELECT * INTO v_existing
    FROM public.major_action_events
   WHERE idempotency_key = p_idempotency_key
     AND event_version = p_event_version;

  IF FOUND THEN
    IF v_existing.payload_hash <> p_payload_hash
       OR v_existing.event_name <> p_event_name
       OR v_existing.aggregate_type <> p_aggregate_type
       OR v_existing.aggregate_id <> p_aggregate_id
       OR v_existing.result <> p_result THEN
      RAISE EXCEPTION 'HXOBS2: idempotency conflict for %', p_idempotency_key
        USING ERRCODE = 'P0001';
    END IF;
    RETURN v_existing.id;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('major-action-sequence'),
    pg_catalog.hashtext(p_action_class || ':' || p_aggregate_type || ':' || p_aggregate_id)
  );
  SELECT pg_catalog.max(source_sequence) INTO v_max_sequence
    FROM public.major_action_events
   WHERE action_class = p_action_class
     AND aggregate_type = p_aggregate_type
     AND aggregate_id = p_aggregate_id;

  v_sequence := COALESCE(p_source_sequence, v_max_sequence + 1, 1);
  v_ordering_state := CASE
    WHEN v_max_sequence IS NULL THEN 'ROOT'
    WHEN v_sequence <= v_max_sequence THEN 'STALE'
    WHEN v_sequence = v_max_sequence + 1 THEN 'IN_ORDER'
    ELSE 'GAP'
  END;
  IF v_ordering_state = 'GAP' AND v_recovery_action_code IS NULL THEN
    v_recovery_action_code := 'RECONCILE_SEQUENCE_GAP';
  END IF;

  v_latency_ms := GREATEST(
    0,
    ROUND(EXTRACT(EPOCH FROM (v_recorded_at - p_occurred_at)) * 1000)::INTEGER
  );
  v_latency_class := CASE
    WHEN v_latency_ms < 100 THEN 'LT_100MS'
    WHEN v_latency_ms < 500 THEN 'LT_500MS'
    WHEN v_latency_ms < 2000 THEN 'LT_2S'
    ELSE 'GTE_2S'
  END;
  v_environment := public.hxos_read_universal_v1_telemetry_environment_v1();
  v_is_test := v_environment = 'TEST';

  INSERT INTO public.major_action_events(
    event_name,event_version,action_class,automation_class,actor_role,actor_ref,
    aggregate_type,aggregate_id,previous_lifecycle_state,lifecycle_state,sync_state,
    entry_surface,context_source,policy_version,policy_applicability,
    recommendation_id,model_version,model_applicability,risk_class,
    correlation_id,causation_id,idempotency_key,source_sequence,ordering_state,
    environment,is_test,payload_hash,result,latency_ms,latency_class,
    failure_reason_code,recovery_action_code,change_reason_code,
    experiment_variant,experiment_applicability,reversible,source_table,
    source_event_id,occurred_at,recorded_at
  ) VALUES (
    p_event_name,p_event_version,p_action_class,p_automation_class,p_actor_role,p_actor_ref,
    p_aggregate_type,p_aggregate_id,p_previous_lifecycle_state,p_lifecycle_state,p_sync_state,
    p_entry_surface,p_context_source,p_policy_version,p_policy_applicability,
    p_recommendation_id,p_model_version,p_model_applicability,p_risk_class,
    p_correlation_id,p_causation_id,p_idempotency_key,v_sequence,v_ordering_state,
    v_environment,v_is_test,p_payload_hash,p_result,v_latency_ms,v_latency_class,
    p_failure_reason_code,v_recovery_action_code,p_change_reason_code,
    p_experiment_variant,p_experiment_applicability,p_reversible,p_source_table,
    p_source_event_id,p_occurred_at,v_recorded_at
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.mirror_major_action_source_event()
RETURNS TRIGGER LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_row JSONB := to_jsonb(NEW);
  v_action_class TEXT := TG_ARGV[0];
  v_aggregate_type TEXT := TG_ARGV[1];
  v_aggregate_key TEXT := TG_ARGV[2];
  v_source_id_key TEXT := TG_ARGV[3];
  v_actor_role TEXT := TG_ARGV[4];
  v_entry_surface TEXT := TG_ARGV[5];
  v_context_source TEXT := TG_ARGV[6];
  v_contract_policy TEXT := TG_ARGV[7];
  v_source_id TEXT;
  v_source_id_base TEXT;
  v_aggregate_id TEXT;
  v_event_type TEXT;
  v_event_name TEXT;
  v_actor_ref TEXT;
  v_previous_state TEXT;
  v_lifecycle_state TEXT;
  v_policy_version TEXT;
  v_policy_applicability TEXT;
  v_model_version TEXT := 'NOT_APPLICABLE';
  v_model_applicability TEXT := 'NOT_APPLICABLE';
  v_recommendation_id UUID;
  v_risk_class TEXT;
  v_result TEXT := 'SUCCESS';
  v_failure_code TEXT;
  v_recovery_code TEXT;
  v_occurred_at TIMESTAMPTZ;
  v_payload_hash TEXT;
  v_major_event_id UUID;
  v_automation_class TEXT;
  v_reversible BOOLEAN := TRUE;
  v_outcome_type TEXT;
  v_outcome_result TEXT;
  v_amount_cents INTEGER;
BEGIN
  v_source_id_base := COALESCE(v_row->>v_source_id_key,v_row->>'id');
  v_source_id := v_source_id_base;
  v_aggregate_id := COALESCE(v_row->>v_aggregate_key,v_source_id);
  IF v_source_id IS NULL OR v_aggregate_id IS NULL THEN
    RAISE EXCEPTION 'HXOBS3: source % lacks configured identity', TG_TABLE_NAME USING ERRCODE='P0001';
  END IF;

  v_event_type := COALESCE(
    v_row->>'event_type',v_row->>'action',v_row->>'outcome',v_row->>'state',v_row->>'result',v_row->>'type',
    CASE WHEN TG_OP='INSERT' THEN 'RECORDED' ELSE 'UPDATED' END
  );
  IF TG_TABLE_NAME='stripe_events' THEN
    v_event_type := COALESCE(v_row->>'type','PROVIDER_EVENT') || '_' || COALESCE(v_row->>'result','RECEIVED');
  END IF;
  IF TG_OP='UPDATE' THEN
    v_source_id := v_source_id_base || ':' || lower(regexp_replace(
      COALESCE(v_row->>'result',v_row->>'state',v_row->>'status',v_event_type),'[^A-Za-z0-9]+','_','g'
    )) || ':' || COALESCE(v_row->>'version','1');
  END IF;
  v_actor_ref := COALESCE(
    v_row->>'actor_id',v_row->>'actor_user_id',v_row->>'created_by',
    v_row->>'worker_id',v_row->>'initiated_by',
    CASE WHEN v_actor_role='PROVIDER' THEN 'PROVIDER' ELSE 'SYSTEM' END
  );
  v_previous_state := upper(COALESCE(
    CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD)->>'state' END,
    CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD)->>'status' END,
    CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD)->>'result' END,
    v_row->>'from_state','ROOT'));
  v_lifecycle_state := upper(COALESCE(
    v_row->>'to_state',v_row->>'state',v_row->>'status',v_row->>'result',v_row->>'outcome',v_event_type
  ));
  v_occurred_at := COALESCE(
    (v_row->>'occurred_at')::TIMESTAMPTZ,(v_row->>'measured_at')::TIMESTAMPTZ,
    (v_row->>'created_at')::TIMESTAMPTZ,clock_timestamp()
  );

  v_policy_version := COALESCE(v_row->>'policy_version',v_contract_policy);
  v_policy_applicability := CASE
    WHEN v_policy_version='NOT_APPLICABLE' THEN 'NOT_APPLICABLE'
    WHEN v_policy_version='UNATTRIBUTED' THEN 'UNATTRIBUTED'
    ELSE 'APPLIED'
  END;

  IF TG_TABLE_NAME IN ('recommendation_events','recommendation_outcomes') THEN
    v_recommendation_id := (v_row->>'recommendation_id')::UUID;
    SELECT recommendation.policy_version,
           COALESCE(recommendation.model_version,'NOT_APPLICABLE')
      INTO v_policy_version,v_model_version
    FROM recommendations recommendation WHERE recommendation.id=v_recommendation_id;
    v_policy_applicability := 'APPLIED';
    v_model_applicability := CASE WHEN v_model_version='NOT_APPLICABLE'
      THEN 'NOT_APPLICABLE' ELSE 'APPLIED' END;
  END IF;

  IF TG_TABLE_NAME='worker_offer_events' THEN
    SELECT decision.policy_version INTO v_policy_version
    FROM worker_offer_decisions decision WHERE decision.id=(v_row->>'offer_decision_id')::UUID;
    v_policy_applicability := 'APPLIED';
  ELSIF TG_TABLE_NAME='worker_counter_offer_events' THEN
    SELECT counter.policy_version INTO v_policy_version
    FROM worker_counter_offers counter WHERE counter.id=(v_row->>'counter_offer_id')::UUID;
    v_policy_applicability := 'APPLIED';
    v_actor_role := CASE WHEN lower(v_event_type)='submitted' THEN 'HUSTLER' ELSE 'POSTER' END;
  END IF;

  IF TG_TABLE_NAME='engine_automation_events' THEN
    v_action_class := CASE
      WHEN v_event_type IN ('TASK_IN_PROGRESS') THEN 'EXECUTION'
      WHEN v_event_type IN ('PAYOUT_READY','POSTER_CONFIRMED_COMPLETION') THEN 'PROOF_COMPLETION'
      WHEN v_event_type IN ('TASK_EXPIRED_UNFILLED') THEN 'DISPATCH'
      WHEN v_event_type LIKE 'PAYMENT_%' THEN 'PAYMENT'
      WHEN v_event_type LIKE 'COMPLETION_MESSAGE_%' THEN 'NOTIFICATION'
      ELSE 'AUTOMATION'
    END;
    v_policy_version := CASE
      WHEN v_action_class='EXECUTION' THEN 'task-execution-state-v1'
      WHEN v_action_class='PROOF_COMPLETION' THEN 'task-completion-policy-v1'
      WHEN v_action_class='DISPATCH' THEN 'dispatch-expiry-policy-v1'
      WHEN v_action_class='PAYMENT' THEN 'payment-reconciliation-policy-v1'
      WHEN v_action_class='NOTIFICATION' THEN 'completion-delivery-policy-v1'
      ELSE 'engine-automation-contract-v1'
    END;
    v_policy_applicability := 'APPLIED';
  ELSIF TG_TABLE_NAME='escrow_events' AND upper(COALESCE(v_row->>'to_state','')) IN ('RELEASED','REFUNDED') THEN
    v_action_class := 'SETTLEMENT';
  END IF;

  v_event_name := lower(v_action_class) || '.' || lower(regexp_replace(v_event_type,'[^A-Za-z0-9]+','_','g'));

  v_risk_class := CASE
    WHEN v_action_class IN ('SAFETY','TRUST_IDENTITY') THEN 'CRITICAL'
    WHEN v_action_class IN ('PAYMENT','SETTLEMENT','PAYOUT','DISPUTE') THEN 'HIGH'
    WHEN v_action_class IN ('PRICING_QUOTE','DISPATCH','OFFER_ASSIGNMENT','PROOF_COMPLETION') THEN 'MEDIUM'
    ELSE 'LOW'
  END;
  SELECT default_automation_class INTO v_automation_class
  FROM major_action_class_contracts WHERE action_class=v_action_class;
  v_reversible := v_automation_class NOT IN ('A5');

  IF lower(v_event_type) ~ '(fail|reject|blocked|contact_failed)' THEN
    v_result := CASE WHEN lower(v_event_type) ~ 'reject' THEN 'REJECTED' ELSE 'FAILURE' END;
    v_failure_code := upper(substr(regexp_replace(v_event_type,'[^A-Za-z0-9]+','_','g'),1,100));
    v_recovery_code := CASE WHEN v_action_class='SAFETY' THEN 'USE_ALTERNATE_SAFETY_CHANNEL'
      WHEN v_action_class IN ('PAYMENT','SETTLEMENT','PAYOUT') THEN 'RECONCILE_PROVIDER_STATE'
      ELSE 'RETRY_OR_ESCALATE' END;
  ELSIF lower(v_event_type) ~ '(pending|processing|submitted|opened|started)' THEN
    v_result := 'QUEUED';
  ELSIF lower(v_event_type) ~ '(stale|ignored)' THEN
    v_result := 'NOOP';
  END IF;
  IF TG_TABLE_NAME='outbox_events' AND lower(COALESCE(v_row->>'status','pending')) IN ('pending','enqueued') THEN
    v_result := 'QUEUED';
  END IF;

  v_payload_hash := encode(public.hxos_universal_v1_sha256_bytes_v1(concat_ws('|',
    'hxos-major-action-v1',v_action_class,v_event_name,v_actor_role,v_actor_ref,
    v_aggregate_type,v_aggregate_id,v_previous_state,v_lifecycle_state,
    v_policy_version,v_model_version,v_result,v_source_id
  ),'sha256'),'hex');

  v_major_event_id := record_major_action_event(
    v_event_name,v_action_class,v_automation_class,v_actor_role,v_actor_ref,
    v_aggregate_type,v_aggregate_id,v_previous_state,v_lifecycle_state,'SERVER_CONFIRMED',
    v_entry_surface,v_context_source,v_policy_version,v_policy_applicability,
    v_recommendation_id,v_model_version,v_model_applicability,v_risk_class,
    v_aggregate_type || ':' || v_aggregate_id,
    TG_TABLE_NAME || ':' || v_source_id,
    'major-action:' || TG_TABLE_NAME || ':' || v_source_id || ':' || lower(v_action_class),
    NULL,v_payload_hash,v_result,v_failure_code,v_recovery_code,
    'EVENT_' || upper(substr(regexp_replace(v_event_type,'[^A-Za-z0-9]+','_','g'),1,94)),
    'NOT_APPLICABLE','NOT_APPLICABLE',v_reversible,TG_TABLE_NAME,
    v_source_id || ':' || lower(v_action_class),v_occurred_at,1
  );

  IF TG_TABLE_NAME='task_scope_versions' AND v_action_class='INTENT_SCOPE' THEN
    PERFORM record_major_action_event(
      'pricing_quote.scope_priced','PRICING_QUOTE','A2','POSTER',v_actor_ref,
      'task',v_aggregate_id,v_previous_state,'PRICE_VERSIONED','SERVER_CONFIRMED',
      v_entry_surface,v_context_source,'task-scope-version-v1','APPLIED',
      NULL,'NOT_APPLICABLE','NOT_APPLICABLE','MEDIUM',
      'task:' || v_aggregate_id,TG_TABLE_NAME || ':' || v_source_id,
      'major-action:' || TG_TABLE_NAME || ':' || v_source_id || ':pricing_quote',
      NULL,encode(public.hxos_universal_v1_sha256_bytes_v1(v_payload_hash || '|pricing','sha256'),'hex'),'SUCCESS',NULL,NULL,
      'SCOPE_PRICE_VERSIONED','NOT_APPLICABLE','NOT_APPLICABLE',TRUE,TG_TABLE_NAME,
      v_source_id || ':pricing_quote',v_occurred_at,1
    );
  END IF;

  v_outcome_type := CASE
    WHEN TG_TABLE_NAME='recommendation_outcomes' THEN upper(v_row->>'outcome_type')
    WHEN TG_TABLE_NAME='worker_cash_out_events' AND upper(v_event_type) IN ('PAID','FAILED','REVERSED')
      THEN 'PAYOUT_' || upper(v_event_type)
    WHEN TG_TABLE_NAME='escrow_events' AND upper(v_lifecycle_state) IN ('RELEASED','REFUNDED')
      THEN 'ESCROW_' || upper(v_lifecycle_state)
    WHEN TG_TABLE_NAME='disputes' AND upper(v_lifecycle_state) IN ('RESOLVED','CLOSED')
      THEN 'DISPUTE_' || upper(v_lifecycle_state)
    WHEN TG_TABLE_NAME='task_safety_incident_events' AND lower(v_event_type) IN ('resolved','closed')
      THEN 'SAFETY_' || upper(v_event_type)
    ELSE NULL
  END;
  IF v_outcome_type IS NOT NULL THEN
    v_outcome_result := CASE
      WHEN v_outcome_type LIKE '%FAILED%' THEN 'FAILED'
      WHEN v_outcome_type LIKE '%REVERSED%' THEN 'REVERSED'
      WHEN v_outcome_type LIKE '%REFUNDED%' THEN 'REFUNDED'
      ELSE 'CONFIRMED'
    END;
    v_amount_cents := CASE WHEN (v_row->>'amount_cents') ~ '^[0-9]+$'
      THEN (v_row->>'amount_cents')::INTEGER ELSE NULL END;
    PERFORM record_major_action_outcome(
      v_major_event_id,v_outcome_type,v_aggregate_type,v_aggregate_id,v_outcome_result,
      v_amount_cents,CASE WHEN v_amount_cents IS NULL THEN NULL ELSE 'usd' END,
      encode(public.hxos_universal_v1_sha256_bytes_v1(v_payload_hash || '|outcome|' || v_outcome_type,'sha256'),'hex'),
      TG_TABLE_NAME,v_source_id || ':' || lower(v_action_class),v_occurred_at
    );
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.mirror_worker_standing_appeal_major_action()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_result TEXT := CASE WHEN NEW.event_type='OPENED' THEN 'QUEUED' ELSE 'SUCCESS' END;
  v_hash TEXT;
BEGIN
  v_hash:=encode(public.hxos_universal_v1_sha256_bytes_v1(concat_ws('|','worker-standing-appeals-v1',NEW.id::text,
    NEW.appeal_id::text,NEW.event_type,NEW.actor_role,COALESCE(NEW.actor_id::text,'system')),'sha256'),'hex');
  PERFORM record_major_action_event(
    'trust_identity.worker_standing_'||lower(NEW.event_type),'TRUST_IDENTITY','A4',
    CASE NEW.actor_role WHEN 'WORKER' THEN 'HUSTLER' WHEN 'ADMIN' THEN 'OPERATOR' ELSE 'SYSTEM' END,
    COALESCE(NEW.actor_id::text,'system'),'worker_standing_appeal',NEW.appeal_id::text,
    'APPEAL_PENDING',NEW.event_type,'SERVER_CONFIRMED','WORKER_RIGHTS','POSTGRES_TRIGGER',
    'worker-standing-appeals-v1','APPLIED',NULL,'NOT_APPLICABLE','NOT_APPLICABLE','CRITICAL',
    'worker_standing_appeal:'||NEW.appeal_id::text,'worker_standing_appeal_events:'||NEW.id::text,
    'major-action:worker-standing-appeal-events:'||NEW.id::text,NULL,v_hash,v_result,NULL,
    CASE WHEN NEW.event_type IN ('OPENED','EVIDENCE_ADDED','INFORMATION_REQUESTED') THEN 'AWAIT_HUMAN_REVIEW' ELSE NULL END,
    'WORKER_STANDING_'||NEW.event_type,'NOT_APPLICABLE','NOT_APPLICABLE',TRUE,
    'worker_standing_appeal_events',NEW.id::text,NEW.created_at,1
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_provider_estimate_submission()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  route_reason_codes TEXT[];
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.quotes quote
    JOIN public.quote_versions quote_version
      ON quote_version.id = NEW.quote_version_id
     AND quote_version.quote_id = quote.id
    JOIN public.task_routing_decisions routing
      ON routing.id = NEW.routing_decision_id
    JOIN public.task_drafts draft
      ON draft.id = routing.task_draft_id
    WHERE quote.id = NEW.quote_id
      AND quote.quote_kind = 'PROVIDER_ESTIMATE'
      AND quote.routing_decision_id = NEW.routing_decision_id
      AND quote.task_draft_id = routing.task_draft_id
      AND draft.active_routing_decision_id = routing.id
      AND routing.outcome = 'ESTIMATE_REQUIRED'
      AND routing.category_snapshot = NEW.work_category_code
      AND quote_version.version_number = NEW.expected_quote_version
      AND quote_version.expected_quote_version = NEW.expected_quote_version
      AND quote_version.provider_submitted_at IS NOT NULL
      AND quote_version.universal_contract_version = 1
      AND quote_version.payment_posture = 'PAYMENT_FREE_ESTIMATE'
      AND quote_version.pay_token IS NULL
      AND quote_version.stripe_payment_link_url IS NULL
      AND quote_version.stripe_checkout_session_id IS NULL
      AND quote_version.stripe_payment_intent_id IS NULL
      AND quote_version.stripe_mode IS NULL
      AND quote_version.paid_at IS NULL
      AND quote_version.scope_json = NEW.scope_snapshot
      AND quote_version.scope_hash = NEW.scope_hash
      AND quote_version.total_cents = NEW.customer_total_cents
      AND quote_version.hustler_payout_cents = NEW.provider_payout_cents
      AND (
        quote_version.scope_version_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM public.task_scope_versions scope
          WHERE scope.id = quote_version.scope_version_id
            AND scope.scope_hash = NEW.scope_hash
        )
      )
      AND quote.active_version_id = quote_version.id
      AND quote.provider_user_id IS NOT DISTINCT FROM NEW.provider_user_id
      AND quote.provider_organization_id IS NOT DISTINCT FROM NEW.provider_organization_id
  ) THEN
    RAISE EXCEPTION 'HXUV1-EST-1: provider estimate must bind the routed payment-free quote and exact version'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.scope_hash <> encode(public.hxos_universal_v1_sha256_bytes_v1(NEW.scope_snapshot::text, 'sha256'), 'hex')
     OR NEW.payload_hash <> encode(public.hxos_universal_v1_sha256_bytes_v1(jsonb_build_object(
       'scopeSnapshot', NEW.scope_snapshot,
       'scopeHash', NEW.scope_hash,
       'workCategoryCode', NEW.work_category_code,
       'lineItems', NEW.line_items,
       'customerTotalCents', NEW.customer_total_cents,
       'providerPayoutCents', NEW.provider_payout_cents,
       'currency', NEW.currency
     )::text, 'sha256'), 'hex') THEN
    RAISE EXCEPTION 'HXUV1-EST-2: immutable estimate scope or payload digest mismatch'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.submitted_by IS DISTINCT FROM NEW.provider_user_id
     AND NOT EXISTS (
       SELECT 1
       FROM public.business_memberships membership
       WHERE membership.organization_id = NEW.provider_organization_id
         AND membership.user_id = NEW.submitted_by
         AND membership.status = 'ACTIVE'
         AND membership.role IN ('OWNER','ADMIN','DISPATCHER','CREW')
     ) THEN
    RAISE EXCEPTION 'HXUV1-EST-3: estimate submitter lacks provider authority'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT routing.reason_codes
  INTO route_reason_codes
  FROM public.task_routing_decisions routing
  WHERE routing.id = NEW.routing_decision_id;

  IF 'CREDENTIALED_TRADE_REVIEW_REQUIRED' = ANY(route_reason_codes)
     AND NOT EXISTS (
       SELECT 1
       FROM public.current_verified_trade_qualifications qualification
       CROSS JOIN LATERAL unnest(qualification.permitted_work_categories) permitted(category)
       WHERE qualification.provider_user_id = NEW.provider_user_id
         AND qualification.organization_id = NEW.provider_organization_id
         AND lower(permitted.category) = NEW.work_category_code
     ) THEN
    RAISE EXCEPTION 'HXUV1-EST-5: credentialed trade estimate requires a current verified qualification for the exact work category'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_financial_provider_command_outcome_fact()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  lease_action TEXT;
  lease_expiry TIMESTAMPTZ;
  command_provider_kind TEXT;
  command_operation_kind TEXT;
  command_operation_id UUID;
  command_provider_expected_version BIGINT;
  command_amount_cents BIGINT;
  command_currency CHAR(3);
  attempt_lease_id UUID;
  latest_attempt_id UUID;
  authority_now TIMESTAMPTZ;
  expected_provider_result_sha256 CHAR(64);
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext('financial-provider-command-recovery-v1'),
    hashtext(NEW.command_id::TEXT)
  );

  authority_now := clock_timestamp();
  NEW.recorded_at := authority_now;
  NEW.recovery_not_before := CASE
    WHEN NEW.recovery_delay_seconds IS NULL THEN NULL
    ELSE authority_now + make_interval(secs => NEW.recovery_delay_seconds)
  END;

  SELECT lease.recovery_action, lease.expires_at, command.provider_kind,
         command.operation_kind, command.operation_id,
         command.provider_expected_version, command.amount_cents,
         command.currency, attempt.recovery_lease_id
    INTO lease_action, lease_expiry, command_provider_kind,
         command_operation_kind, command_operation_id,
         command_provider_expected_version, command_amount_cents,
         command_currency, attempt_lease_id
    FROM public.financial_provider_command_recovery_leases lease
    JOIN public.financial_provider_command_journal command
      ON command.command_id = lease.command_id
    JOIN public.financial_provider_command_dispatch_attempts attempt
      ON attempt.command_id = command.command_id
     AND attempt.dispatch_attempt_id = NEW.dispatch_attempt_id
   WHERE lease.recovery_lease_id = NEW.recovery_lease_id
     AND lease.command_id = NEW.command_id;
  IF NOT FOUND OR command_provider_kind <> 'FAKE' THEN
    RAISE EXCEPTION 'HXFPCREC1: outcome lacks fake command authority'
      USING ERRCODE = 'P0001';
  END IF;
  IF lease_expiry <= authority_now THEN
    RAISE EXCEPTION 'HXFPCREC1: recovery lease expired before outcome commitment'
      USING ERRCODE = 'P0001';
  END IF;
  IF lease_action = 'DISPATCH' AND attempt_lease_id <> NEW.recovery_lease_id THEN
    RAISE EXCEPTION 'HXFPCREC1: dispatch outcome is not bound to its attempt lease'
      USING ERRCODE = 'P0001';
  END IF;
  IF lease_action = 'RECONCILE' AND EXISTS (
    SELECT 1 FROM public.financial_provider_command_dispatch_attempts attempt
     WHERE attempt.recovery_lease_id = NEW.recovery_lease_id
  ) THEN
    RAISE EXCEPTION 'HXFPCREC1: reconciliation lease cannot create a dispatch attempt'
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.financial_provider_command_outcome_facts outcome
     WHERE outcome.recovery_lease_id = NEW.recovery_lease_id
  ) THEN
    RAISE EXCEPTION 'HXFPCREC1: recovery lease already recorded an outcome'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT attempt.dispatch_attempt_id
    INTO latest_attempt_id
    FROM public.financial_provider_command_dispatch_attempts attempt
   WHERE attempt.command_id = NEW.command_id
   ORDER BY attempt.attempt_number DESC
   LIMIT 1;
  IF latest_attempt_id <> NEW.dispatch_attempt_id THEN
    RAISE EXCEPTION 'HXFPCREC1: outcome does not reference the latest attempt'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.outcome_kind = 'OUTCOME_OBSERVED' AND NOT (
    (
      command_operation_kind IN (
        'PREPARE_PAYMENT_METHOD', 'AUTHORIZE', 'SECURE', 'ADJUST', 'CAPTURE',
        'ONBOARD_PROVIDER', 'REFRESH_PROVIDER_ACCOUNT_STATE', 'SETTLE', 'FUND',
        'PROVIDER_RELEASE', 'PAYOUT', 'OBSERVE_BANK_SETTLEMENT'
      )
      AND NEW.provider_state IN (
        'PENDING', 'SUCCEEDED', 'DECLINED', 'FAILED', 'RETRYABLE_FAILURE'
      )
    )
    OR (
      command_operation_kind = 'VOID'
      AND NEW.provider_state IN (
        'PENDING', 'VOIDED', 'DECLINED', 'FAILED', 'RETRYABLE_FAILURE'
      )
    )
    OR (
      command_operation_kind = 'REFUND'
      AND NEW.provider_state IN (
        'PENDING', 'REFUNDED', 'PARTIALLY_REFUNDED', 'DECLINED', 'FAILED',
        'RETRYABLE_FAILURE'
      )
    )
    OR (
      command_operation_kind = 'REVERSAL'
      AND NEW.provider_state IN (
        'PENDING', 'REVERSED', 'DECLINED', 'FAILED', 'RETRYABLE_FAILURE'
      )
    )
    OR (
      command_operation_kind = 'INGEST_WEBHOOK'
      AND NEW.provider_state IN ('PENDING', 'ACCEPTED', 'REJECTED', 'RETRYABLE_FAILURE')
    )
    OR (
      command_operation_kind = 'RECONCILE'
      AND NEW.provider_state IN ('MATCHED', 'MISMATCH')
    )
  ) THEN
    RAISE EXCEPTION 'HXFPCREC1: observed provider state is invalid for command operation'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.outcome_kind = 'OUTCOME_OBSERVED' THEN
    IF NEW.provider_result_version <> command_provider_expected_version + 1 THEN
      RAISE EXCEPTION 'HXFPCREC1: observed provider version does not advance exact command version'
        USING ERRCODE = 'P0001';
    END IF;
    IF command_operation_kind IN (
      'AUTHORIZE', 'SECURE', 'VOID', 'ADJUST', 'CAPTURE', 'REFUND',
      'REVERSAL', 'SETTLE', 'FUND', 'PROVIDER_RELEASE', 'PAYOUT',
      'OBSERVE_BANK_SETTLEMENT'
    ) THEN
      IF NEW.amount_cents IS DISTINCT FROM command_amount_cents
         OR NEW.currency IS DISTINCT FROM command_currency THEN
        RAISE EXCEPTION 'HXFPCREC1: observed provider value differs from exact command value'
          USING ERRCODE = 'P0001';
      END IF;
    ELSIF NEW.amount_cents IS NOT NULL OR NEW.currency IS NOT NULL THEN
      RAISE EXCEPTION 'HXFPCREC1: non-money provider outcome cannot project value'
        USING ERRCODE = 'P0001';
    END IF;

    expected_provider_result_sha256 := encode(
      public.hxos_universal_v1_sha256_bytes_v1(
        command_operation_id::TEXT || ':' || command_operation_kind || ':' ||
        command_provider_kind || ':' || NEW.provider_state || ':' ||
        NEW.provider_result_version::TEXT || ':' ||
        COALESCE(NEW.amount_cents::TEXT, '') || ':' ||
        COALESCE(NEW.currency, '') || ':' || NEW.external_reference_sha256 || ':' ||
        NEW.retryable::TEXT,
        'sha256'
      ),
      'hex'
    );
    IF NEW.provider_result_sha256 <> expected_provider_result_sha256 THEN
      RAISE EXCEPTION 'HXFPCREC1: observed provider projection digest mismatch'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.financial_provider_command_outcome_facts outcome
     WHERE outcome.command_id = NEW.command_id
       AND (
         (outcome.outcome_kind = 'OUTCOME_OBSERVED' AND outcome.retryable = FALSE)
         OR (outcome.outcome_kind = 'FAILED' AND outcome.retryable = FALSE)
       )
  ) THEN
    RAISE EXCEPTION 'HXFPCREC1: terminal outcome already exists'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_task_opportunity_interest_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  opportunity public.current_universal_v1_task_opportunities_v1%ROWTYPE;
  provider public.users%ROWTYPE;
  profile public.capability_profiles%ROWTYPE;
  organization public.business_organizations%ROWTYPE;
  credential public.business_credentials%ROWTYPE;
  expected_request_sha256 CHAR(64);
  capability_snapshot JSONB;
  trade_qualification RECORD;
  trade_qualification_snapshot JSONB;
BEGIN
  IF NEW.opportunity_contract_version <> 1 THEN
    RETURN NEW;
  END IF;

  IF NEW.universal_contract_version <> 1
     OR NEW.authority <> 'EXPRESS_INTEREST'
     OR NEW.status <> 'pending'
     OR NEW.task_id IS NOT NULL
     OR NEW.interest_scope_version_id IS NOT NULL
     OR NEW.idempotency_key IS NULL
     OR NEW.request_sha256 IS NULL
     OR NEW.message IS NOT NULL
     OR NEW.rejection_reason IS NOT NULL
     OR NEW.counter_offer_round <> 0 THEN
    RAISE EXCEPTION 'HXUV1-OPPORTUNITY-1: TaskDraft interest must remain a bounded EXPRESS_INTEREST observation'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO opportunity
  FROM public.current_universal_v1_task_opportunities_v1 current_opportunity
  WHERE current_opportunity.opportunity_id = NEW.opportunity_id
    AND current_opportunity.opportunity_version = NEW.opportunity_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUV1-OPPORTUNITY-2: exact current open TaskDraft opportunity version is unavailable'
      USING ERRCODE = 'P0001';
  END IF;

  IF (NEW.task_draft_id IS NOT NULL
        AND NEW.task_draft_id IS DISTINCT FROM opportunity.task_draft_id)
     OR (NEW.interest_routing_decision_id IS NOT NULL
        AND NEW.interest_routing_decision_id IS DISTINCT FROM opportunity.routing_decision_id)
     OR (NEW.interest_routing_decision_version IS NOT NULL
        AND NEW.interest_routing_decision_version IS DISTINCT FROM opportunity.routing_decision_version)
     OR (NEW.interest_relationship_origin_id IS NOT NULL
        AND NEW.interest_relationship_origin_id IS DISTINCT FROM opportunity.relationship_origin_id)
     OR (NEW.interest_relationship_origin_version IS NOT NULL
        AND NEW.interest_relationship_origin_version IS DISTINCT FROM opportunity.relationship_origin_version)
     OR (NEW.interest_scope_artifact_kind IS NOT NULL
        AND NEW.interest_scope_artifact_kind IS DISTINCT FROM opportunity.scope_artifact_kind)
     OR (NEW.interest_scope_artifact_id IS NOT NULL
        AND NEW.interest_scope_artifact_id IS DISTINCT FROM opportunity.scope_artifact_id)
     OR (NEW.interest_scope_artifact_version IS NOT NULL
        AND NEW.interest_scope_artifact_version IS DISTINCT FROM opportunity.scope_artifact_version)
     OR (NEW.interest_scope_artifact_sha256 IS NOT NULL
        AND btrim(NEW.interest_scope_artifact_sha256) IS DISTINCT FROM
            btrim(opportunity.scope_artifact_sha256)) THEN
    RAISE EXCEPTION 'HXUV1-OPPORTUNITY-3: forged route, origin, or scope artifact binding'
      USING ERRCODE = 'P0001';
  END IF;

  -- Lock the mutable TaskDraft pointer, then re-read the projection. Route,
  -- origin, cell, and scope evidence are append-only facts.
  PERFORM 1
  FROM public.task_drafts draft
  WHERE draft.id = opportunity.task_draft_id
  FOR SHARE;
  SELECT * INTO opportunity
  FROM public.current_universal_v1_task_opportunities_v1 current_opportunity
  WHERE current_opportunity.opportunity_id = NEW.opportunity_id
    AND current_opportunity.opportunity_version = NEW.opportunity_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUV1-OPPORTUNITY-3: TaskDraft opportunity changed before interest recording'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO provider
  FROM public.users actor
  WHERE actor.id = NEW.hustler_id
  FOR SHARE;
  IF NOT FOUND
     OR provider.account_status <> 'ACTIVE'
     OR provider.is_minor IS NOT FALSE
     OR COALESCE(provider.is_banned, FALSE) IS TRUE THEN
    RAISE EXCEPTION 'HXUV1-OPPORTUNITY-4: active adult provider identity observation is required'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO profile
  FROM public.capability_profiles capability
  WHERE capability.user_id = NEW.hustler_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUV1-OPPORTUNITY-5: provider capability observation is unresolved'
      USING ERRCODE = 'P0001';
  END IF;

  capability_snapshot := jsonb_build_object(
    'providerClass', profile.provider_class,
    'trustTier', profile.trust_tier,
    'riskClearance', profile.risk_clearance,
    'insuranceValid', profile.insurance_valid,
    'insuranceExpiresAt', profile.insurance_expires_at,
    'backgroundCheckValid', profile.background_check_valid,
    'backgroundCheckExpiresAt', profile.background_check_expires_at,
    'locationState', profile.location_state,
    'updatedAt', profile.updated_at
  );

  IF NEW.provider_organization_id IS NULL THEN
    IF NEW.observed_trade_credential_id IS NOT NULL
       OR profile.provider_class <> 'GENERAL_SERVICE_PROVIDER' THEN
      RAISE EXCEPTION 'HXUV1-OPPORTUNITY-6: individual general-provider observation is unresolved'
        USING ERRCODE = 'P0001';
    END IF;
    NEW.provider_class_snapshot := 'GENERAL_SERVICE_PROVIDER';
    NEW.trade_credential_observed_at := NULL;
    NEW.trade_credential_evidence_sha256 := NULL;
    NEW.trade_qualification_sha256 := NULL;
  ELSE
    SELECT * INTO organization
    FROM public.business_organizations candidate
    WHERE candidate.id = NEW.provider_organization_id
    FOR SHARE;
    IF NOT FOUND
       OR organization.status <> 'ACTIVE'
       OR organization.verification_status <> 'VERIFIED'
       OR organization.provider_enabled IS NOT TRUE
       OR NOT EXISTS (
         SELECT 1
         FROM public.business_memberships membership
         WHERE membership.organization_id = organization.id
           AND membership.user_id = NEW.hustler_id
           AND membership.status = 'ACTIVE'
           AND membership.role IN ('OWNER', 'ADMIN', 'DISPATCHER', 'CREW')
       ) THEN
      RAISE EXCEPTION 'HXUV1-OPPORTUNITY-7: active provider-business membership observation is unresolved'
        USING ERRCODE = 'P0001';
    END IF;

    IF organization.provider_class = 'GENERAL_SERVICE_PROVIDER' THEN
      IF NEW.observed_trade_credential_id IS NOT NULL
         OR profile.provider_class <> 'GENERAL_SERVICE_PROVIDER' THEN
        RAISE EXCEPTION 'HXUV1-OPPORTUNITY-8: general-provider business observation is inconsistent'
          USING ERRCODE = 'P0001';
      END IF;
      NEW.provider_class_snapshot := 'GENERAL_SERVICE_PROVIDER';
      NEW.trade_credential_observed_at := NULL;
      NEW.trade_credential_evidence_sha256 := NULL;
      NEW.trade_qualification_sha256 := NULL;
    ELSIF organization.provider_class = 'VERIFIED_TRADE_BUSINESS' THEN
      IF NEW.observed_trade_credential_id IS NULL THEN
        RAISE EXCEPTION 'HXUV1-OPPORTUNITY-9: Verified Trade Business interest requires one exact credential observation'
          USING ERRCODE = 'P0001';
      END IF;
      SELECT * INTO credential
      FROM public.business_credentials candidate
      WHERE candidate.id = NEW.observed_trade_credential_id
        AND candidate.organization_id = organization.id
      FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'HXUV1-OPPORTUNITY-9: Verified Trade Business credential observation is unavailable'
          USING ERRCODE = 'P0001';
      END IF;
      IF profile.provider_class <> 'VERIFIED_TRADE_BUSINESS' THEN
        RAISE EXCEPTION 'HXUV1-OPPORTUNITY-10: Verified Trade Business capability observation is unresolved'
          USING ERRCODE = 'P0001';
      END IF;
      SELECT
        qualification.issuing_authority,
        qualification.jurisdiction_code,
        qualification.license_scope,
        qualification.license_status,
        qualification.expires_at,
        qualification.evidence_hash,
        qualification.verified_at,
        qualification.official_source_checked_at,
        permitted.category AS permitted_category
      INTO trade_qualification
        FROM public.current_verified_trade_qualifications qualification
        CROSS JOIN LATERAL unnest(qualification.permitted_work_categories)
          permitted(category)
        WHERE qualification.provider_user_id = NEW.hustler_id
          AND qualification.organization_id = organization.id
          AND qualification.business_credential_id = credential.id
          AND qualification.jurisdiction_code = opportunity.region_code
          AND lower(permitted.category) = opportunity.work_category_code
        ORDER BY permitted.category
        LIMIT 1;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'HXUV1-OPPORTUNITY-10: active credential/category/jurisdiction observation is unresolved'
          USING ERRCODE = 'P0001';
      END IF;
      trade_qualification_snapshot := jsonb_build_object(
        'credentialId', credential.id,
        'organizationId', organization.id,
        'issuingAuthority', trade_qualification.issuing_authority,
        'jurisdictionCode', trade_qualification.jurisdiction_code,
        'licenseScope', trade_qualification.license_scope,
        'licenseStatus', trade_qualification.license_status,
        'expiresAt', trade_qualification.expires_at,
        'evidenceHash', trade_qualification.evidence_hash,
        'verifiedAt', trade_qualification.verified_at,
        'officialSourceCheckedAt', trade_qualification.official_source_checked_at,
        'permittedCategory', lower(trade_qualification.permitted_category)
      );
      NEW.provider_class_snapshot := 'VERIFIED_TRADE_BUSINESS';
      NEW.trade_credential_observed_at := credential.updated_at;
      NEW.trade_credential_evidence_sha256 := credential.evidence_hash;
      NEW.trade_qualification_sha256 := encode(
        public.hxos_universal_v1_sha256_bytes_v1(trade_qualification_snapshot::TEXT, 'sha256'),
        'hex'
      );
    ELSE
      RAISE EXCEPTION 'HXUV1-OPPORTUNITY-11: provider-business class observation is unresolved'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  expected_request_sha256 :=
    public.universal_v1_task_opportunity_interest_request_sha256(
      NEW.hustler_id,
      NEW.opportunity_id,
      NEW.opportunity_version,
      NEW.provider_organization_id,
      NEW.observed_trade_credential_id,
      NEW.idempotency_key
    );
  IF btrim(NEW.request_sha256) IS DISTINCT FROM btrim(expected_request_sha256) THEN
    RAISE EXCEPTION 'HXUV1-OPPORTUNITY-12: EXPRESS_INTEREST request witness mismatch'
      USING ERRCODE = 'P0001';
  END IF;

  NEW.task_id := NULL;
  NEW.task_draft_id := opportunity.task_draft_id;
  NEW.interest_routing_decision_id := opportunity.routing_decision_id;
  NEW.interest_routing_decision_version := opportunity.routing_decision_version;
  NEW.interest_relationship_origin_id := opportunity.relationship_origin_id;
  NEW.interest_relationship_origin_version := opportunity.relationship_origin_version;
  NEW.interest_scope_artifact_kind := opportunity.scope_artifact_kind;
  NEW.interest_scope_artifact_id := opportunity.scope_artifact_id;
  NEW.interest_scope_artifact_version := opportunity.scope_artifact_version;
  NEW.interest_scope_artifact_sha256 := opportunity.scope_artifact_sha256;
  NEW.provider_capability_observed_at := profile.updated_at;
  NEW.provider_capability_sha256 := encode(
    public.hxos_universal_v1_sha256_bytes_v1(capability_snapshot::TEXT, 'sha256'),
    'hex'
  );
  NEW.provider_binding_sha256 := encode(public.hxos_universal_v1_sha256_bytes_v1(concat_ws('|',
    'HX_UNIVERSAL_V1_PROVIDER_BINDING_V1',
    NEW.hustler_id::TEXT,
    COALESCE(NEW.provider_organization_id::TEXT, '')
  ), 'sha256'), 'hex');
  NEW.created_at := clock_timestamp();
  NEW.updated_at := NEW.created_at;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_task_ai_scope_outcome()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_result JSONB;
BEGIN
  IF NEW.ai_scope_observation_id IS NULL THEN
    RETURN NEW;
  END IF;
  v_result := jsonb_build_object(
    'taskCreated', TRUE,
    'proposalAuthorizedState', FALSE,
    'executablePolicyRevalidated', TRUE
  );
  INSERT INTO ai_observation_outcomes (
    observation_id,outcome_type,outcome_object_type,outcome_object_id,
    realized_result,source_table,source_event_id,payload_hash,measured_at
  ) VALUES (
    NEW.ai_scope_observation_id,'TASK_CREATED','TASK',NEW.id::TEXT,
    v_result,'tasks',NEW.id::TEXT,
    encode(public.hxos_universal_v1_sha256_bytes_v1(concat_ws('|',NEW.ai_scope_observation_id::TEXT,'TASK_CREATED',NEW.id::TEXT,v_result::TEXT),'sha256'),'hex'),
    COALESCE(NEW.created_at,NOW())
  ) ON CONFLICT (observation_id,outcome_type,source_event_id) DO NOTHING;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_provider_estimate_submission() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_financial_provider_command_outcome_fact() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_task_opportunity_interest_v1()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_task_ai_scope_outcome() FROM PUBLIC;
-- The Phase-A domain witness and the caller's full canonical command are
-- different facts.  Keep both so an idempotency key can never replay a changed
-- eligibility version, timestamp, actor-bound assertion request, or target
-- release while still preserving the independently derived domain witness.
ALTER TABLE public.task_work_order_command_requests
  ADD COLUMN IF NOT EXISTS canonical_command_request_sha256 CHAR(64);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint constraint_state
     WHERE constraint_state.conname =
             'task_work_order_command_requests_canonical_command_v1_chk'
       AND constraint_state.conrelid =
             'public.task_work_order_command_requests'::pg_catalog.regclass
  ) THEN
    ALTER TABLE public.task_work_order_command_requests
      ADD CONSTRAINT task_work_order_command_requests_canonical_command_v1_chk
      CHECK (
        canonical_command_request_sha256 IS NULL
        OR (
          canonical_command_request_sha256 ~ '^[0-9a-f]{64}$'
          AND canonical_command_request_sha256 <> pg_catalog.repeat('0', 64)
        )
      );
  END IF;
END;
$$;

-- A SECURITY DEFINER command fixes its own path to pg_catalog.  Every trigger
-- reached by the direct writes below must therefore have an independently
-- fixed path rather than inheriting the caller's path.  The public schema is
-- admitted only after the role verifier proves its global CREATE ACL is closed.
-- The one trigger that projects a Work Order id onto its task is additionally
-- made a sealed definer.  Runtime provisioning MUST transfer this one function
-- to the NOLOGIN command owner and grant that owner only the two projected task
-- columns; the verifier rejects the temporary migration ownership left by DDL.
-- This keeps the one-shot migrator out of the runtime call graph.
ALTER FUNCTION public.lock_universal_v1_estimate_authority(
  UUID, UUID, UUID, UUID, UUID
) SET search_path TO pg_catalog, public;
ALTER FUNCTION public.universal_v1_work_order_operation_id_v1(TEXT, TEXT)
  SET search_path TO pg_catalog, public;
ALTER FUNCTION public.universal_v1_execution_internal_request_sha256(
  UUID, UUID, TEXT, TEXT, INTEGER, UUID, UUID, UUID, TEXT, TIMESTAMPTZ, TEXT
) SET search_path TO pg_catalog, public;
ALTER FUNCTION public.bind_universal_work_order_to_task() SECURITY DEFINER;
REVOKE ALL ON FUNCTION public.bind_universal_work_order_to_task() FROM PUBLIC;

-- The execution-genesis guard is DEFERRABLE and therefore runs when the API
-- transaction commits, after the sealed materializer has returned to its
-- invoker.  Seal that exact trigger under the NOLOGIN command owner so it can
-- read the append-only genesis fact without granting the API any relation
-- authority. Runtime readback requires command-owner ownership, fixed path,
-- SELECT-only dependency access, and no PUBLIC execute authority.
ALTER FUNCTION public.enforce_universal_v1_work_order_execution_genesis()
  SECURITY DEFINER;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_work_order_execution_genesis()
  FROM PUBLIC;

-- A Work Order id projection changes neither assignment authority nor the
-- Universal contract version.  Return before the legacy disposable-assignment
-- predicate is reachable; that CI-only bypass remains ungranted to the command
-- owner. Assignment-relevant INSERT/UPDATE behavior is otherwise preserved.
CREATE OR REPLACE FUNCTION public.enforce_universal_hard_assignment_hold()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.worker_id IS NOT DISTINCT FROM NEW.worker_id
     AND OLD.universal_contract_version IS NOT DISTINCT FROM
           NEW.universal_contract_version THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.universal_contract_version = 1
     AND NEW.universal_contract_version <> 1 THEN
    RAISE EXCEPTION 'HXUV1-ASSIGN-1: Universal V1 task authority cannot be downgraded'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.worker_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.universal_contract_version = 1 THEN
    RAISE EXCEPTION 'HXUV1-ASSIGN-2: hard assignment remains held pending separate protected capability approval'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT public.is_hustlexp_disposable_assignment_ci() THEN
    RAISE EXCEPTION 'HXUV1-ASSIGN-3: hard assignment is denied outside the exact disposable CI database identity'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

-- The Work Order projection also leaves the complete payment-posture tuple
-- unchanged. Do not widen command-owner reads to the legacy escrow relation;
-- preserve that legacy guard only for INSERTs or payment-authority changes.
CREATE OR REPLACE FUNCTION public.enforce_universal_task_payment_posture()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.universal_contract_version IS NOT DISTINCT FROM
           NEW.universal_contract_version
     AND OLD.payment_method IS NOT DISTINCT FROM NEW.payment_method
     AND OLD.universal_payment_posture IS NOT DISTINCT FROM
           NEW.universal_payment_posture THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.universal_contract_version = 1
     AND (
       NEW.universal_contract_version <> 1
       OR NEW.payment_method IS DISTINCT FROM OLD.payment_method
       OR NEW.universal_payment_posture IS DISTINCT FROM OLD.universal_payment_posture
     ) THEN
    RAISE EXCEPTION 'HXUV1-MAT-1: Universal V1 Task payment authority and posture are immutable'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.universal_contract_version = 1 AND (
    NEW.payment_method IS DISTINCT FROM 'universal_financial_security'
    OR NEW.universal_payment_posture IS DISTINCT FROM 'PAYMENT_CREATION_FROZEN'
  ) THEN
    RAISE EXCEPTION 'HXUV1-MAT-2: Universal V1 Task must remain provider-neutral with payment creation frozen'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.universal_contract_version = 1
     AND EXISTS (
       SELECT 1
         FROM public.escrows escrow
        WHERE escrow.task_id = NEW.id
     ) THEN
    RAISE EXCEPTION 'HXUV1-MAT-3: Universal V1 Task cannot bind a legacy escrow'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

-- The Work Order id projection does not change the active scope. The legacy
-- deferred scope guard otherwise runs at API commit time and performs reads as
-- the invoker. Return before that graph for an exact unchanged-scope UPDATE;
-- retain the complete original validation for inserts and real scope changes.
CREATE OR REPLACE FUNCTION public.enforce_universal_active_scope_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  active_scope public.task_scope_versions%ROWTYPE;
  approved_proposal_id UUID;
  existing_work_order_id UUID;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.universal_contract_version IS NOT DISTINCT FROM
           NEW.universal_contract_version
     AND OLD.active_scope_version_id IS NOT DISTINCT FROM
           NEW.active_scope_version_id THEN
    RETURN NEW;
  END IF;

  IF NEW.universal_contract_version <> 1 THEN
    RETURN NEW;
  END IF;

  SELECT * INTO active_scope
    FROM public.task_scope_versions
   WHERE id = NEW.active_scope_version_id;
  IF NOT FOUND
     OR active_scope.task_id <> NEW.id
     OR active_scope.universal_contract_version <> 1 THEN
    RAISE EXCEPTION 'HXUV1-SCOPE-1: Universal V1 task must bind its exact durable scope'
      USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF active_scope.source <> 'INITIAL'
       OR active_scope.version <> 1
       OR active_scope.supersedes_version_id IS NOT NULL THEN
      RAISE EXCEPTION 'HXUV1-SCOPE-2: initial Universal V1 scope must begin the immutable task scope chain'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.universal_contract_version <> 1
     OR OLD.active_scope_version_id IS NULL THEN
    IF active_scope.source <> 'INITIAL'
       OR active_scope.version <> 1
       OR active_scope.supersedes_version_id IS NOT NULL THEN
      RAISE EXCEPTION 'HXUV1-SCOPE-2: initial Universal V1 scope must begin the immutable task scope chain'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.active_scope_version_id = OLD.active_scope_version_id THEN
    RETURN NEW;
  END IF;

  IF active_scope.source <> 'APPROVED_CHANGE'
     OR active_scope.supersedes_version_id <> OLD.active_scope_version_id
     OR NOT EXISTS (
       SELECT 1
         FROM public.task_scope_versions prior_scope
        WHERE prior_scope.id = OLD.active_scope_version_id
          AND prior_scope.task_id = NEW.id
          AND prior_scope.universal_contract_version = 1
          AND active_scope.version = prior_scope.version + 1
     ) THEN
    RAISE EXCEPTION 'HXUV1-SCOPE-3: active scope can only advance one exact immutable version'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT proposal.id INTO approved_proposal_id
    FROM public.task_scope_change_proposals proposal
   WHERE proposal.task_id = NEW.id
     AND proposal.universal_contract_version = 1
     AND proposal.status = 'APPROVED'
     AND proposal.base_version_id = OLD.active_scope_version_id
     AND proposal.approved_version_id = NEW.active_scope_version_id
     AND EXISTS (
       SELECT 1
         FROM public.task_scope_change_approvals approval
        WHERE approval.proposal_id = proposal.id
          AND approval.approver_role = 'CUSTOMER'
          AND approval.decision = 'APPROVED'
     )
     AND EXISTS (
       SELECT 1
         FROM public.task_scope_change_approvals approval
        WHERE approval.proposal_id = proposal.id
          AND approval.approver_role = 'PROVIDER'
          AND approval.decision = 'APPROVED'
     )
   ORDER BY proposal.proposal_version DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUV1-SCOPE-4: active scope transition requires the exact dual-approved change order'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT work_order.id INTO existing_work_order_id
    FROM public.task_work_orders work_order
   WHERE work_order.task_id = NEW.id;
  IF FOUND AND NOT EXISTS (
    SELECT 1
      FROM public.task_work_order_amendments amendment
     WHERE amendment.work_order_id = existing_work_order_id
       AND amendment.change_order_id = approved_proposal_id
       AND amendment.scope_version_id = NEW.active_scope_version_id
  ) THEN
    RAISE EXCEPTION 'HXUV1-SCOPE-5: active Work Order scope transition requires its exact amendment fact'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

-- A version-1 MATERIALIZED execution fact is the Work Order genesis itself;
-- no change-order witness can predate the just-created Work Order row. Keep
-- the prepared-change hold for every later execution transition without
-- granting this command owner access to the change-order recovery graph.
CREATE OR REPLACE FUNCTION public.prevent_execution_during_prepared_change_order()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.execution_version = 1
     AND NEW.supersedes_fact_id IS NULL
     AND NEW.state = 'MATERIALIZED'
     AND NEW.transition_kind = 'MATERIALIZED'
     AND NEW.work_order_amendment_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('fulfillment:' || NEW.work_order_id::TEXT, 0)
  );
  IF EXISTS (
    SELECT 1
      FROM public.universal_v1_change_order_materialization_commands witness
      JOIN public.universal_v1_change_order_recovery_terminal_facts terminal
        ON terminal.proposal_id = witness.proposal_id
     WHERE witness.work_order_id = NEW.work_order_id
       AND terminal.outcome_state = 'CANCELLED'
       AND terminal.recovery_state = 'RECOVERY_REQUIRED'
  ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-27: CANCELLED_RECOVERY_REQUIRED permits bounded recovery only, not execution'
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.universal_v1_change_order_materialization_commands witness
     WHERE witness.work_order_id = NEW.work_order_id
       AND NOT EXISTS (
         SELECT 1
           FROM public.task_work_order_amendments amendment
          WHERE amendment.change_order_id = witness.proposal_id
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.universal_v1_change_order_recovery_terminal_facts terminal
          WHERE terminal.proposal_id = witness.proposal_id
            AND terminal.outcome_state = 'MATERIALIZED'
       )
  ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-3P-6: execution is held until the prepared amendment finalizes or terminally recovers'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- Disputes can block completion, reconciliation, release, and payout; they
-- cannot predate the genesis of a just-inserted Work Order. Preserve the
-- closure gate everywhere else without granting dispute-operator helpers to
-- the Work Order command owner.
CREATE OR REPLACE FUNCTION public.enforce_universal_v1_dispute_closure_gate_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  checked_work_order_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'task_work_order_execution_facts'
     AND NEW.execution_version = 1
     AND NEW.supersedes_fact_id IS NULL
     AND NEW.state = 'MATERIALIZED'
     AND NEW.transition_kind = 'MATERIALIZED' THEN
    RETURN NEW;
  END IF;

  checked_work_order_id := NEW.work_order_id;
  PERFORM public.universal_v1_dispute_lock_v1(checked_work_order_id);
  IF public.universal_v1_has_open_material_dispute_v1(checked_work_order_id) THEN
    IF TG_TABLE_NAME = 'task_completion_facts' THEN
      IF NEW.fact_kind = 'APPROVED' THEN
        RAISE EXCEPTION 'HXUDR9: material dispute blocks completion approval'
          USING ERRCODE = 'P0001';
      END IF;
    ELSIF TG_TABLE_NAME = 'task_work_order_execution_facts' THEN
      IF NEW.state = 'COMPLETED' OR NEW.transition_kind = 'COMPLETION_APPROVED' THEN
        RAISE EXCEPTION 'HXUDR9: material dispute blocks Work Order closure'
          USING ERRCODE = 'P0001';
      END IF;
    ELSIF TG_TABLE_NAME = 'task_reconciliation_facts' THEN
      IF NEW.reconciliation_state IN ('MATCHED', 'CLOSED') THEN
        RAISE EXCEPTION 'HXUDR9: material dispute blocks reconciliation closure'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Legacy quote-shortlist and external-offer overlays are not Universal V1
-- command writers.  Keep their historical behavior for legacy applications,
-- but make the exclusion explicit in trigger metadata so a V1 interest close
-- cannot transitively mutate unowned legacy relations.
DROP TRIGGER IF EXISTS task_quote_shortlist_application_close
  ON public.task_applications;
CREATE TRIGGER task_quote_shortlist_application_close
AFTER UPDATE OF status ON public.task_applications
FOR EACH ROW
WHEN (
  OLD.status IS DISTINCT FROM NEW.status
  AND NEW.universal_contract_version IS DISTINCT FROM 1
)
EXECUTE FUNCTION public.close_task_quote_shortlist_on_application_exit();

DROP TRIGGER IF EXISTS task_external_offer_application_sync
  ON public.task_applications;
CREATE TRIGGER task_external_offer_application_sync
AFTER UPDATE OF status ON public.task_applications
FOR EACH ROW
WHEN (NEW.universal_contract_version IS DISTINCT FROM 1)
EXECUTE FUNCTION public.sync_task_external_offer_from_application();

-- Fail before hardening if an upgrade target contains even one unknown,
-- missing, rewired, or redefined trigger on the exact direct sealed-command,
-- lock-input, fake-finance-input, and telemetry dependency surface. The digest
-- was captured from a clean PG16 ordinal-145 catalog plus
-- the two explicit Universal V1 legacy-overlay exclusions immediately above.
-- It covers relation, trigger name, trigger function, event/column/WHEN shape,
-- constraint timing, language, SECURITY mode, volatility, parallel safety,
-- and the exact function body. Search-path configuration is applied only from
-- the literal allowlist below and is independently bound by runtime readback.
DO $$
DECLARE
  trigger_count INTEGER;
  trigger_catalog_sha256 TEXT;
  trigger_function pg_catalog.regprocedure;
  work_order_authority_relations_installed BOOLEAN;
  fake_financial_surface_marker_count INTEGER;
  fake_financial_surface_installed BOOLEAN;
BEGIN
  PERFORM pg_catalog.set_config('search_path', 'pg_catalog, public', true);

  IF (
    pg_catalog.to_regclass(
      'hx_authority.universal_v1_work_order_target_authority_facts'
    ) IS NULL
  ) IS DISTINCT FROM (
    pg_catalog.to_regclass(
      'hx_authority.universal_v1_work_order_command_execution_facts'
    ) IS NULL
  ) OR (
    pg_catalog.to_regclass(
      'hx_authority.universal_v1_work_order_target_authority_facts'
    ) IS NULL
  ) IS DISTINCT FROM (
    pg_catalog.to_regclass(
      'public.hxos_universal_v1_work_order_target_activation_barrier_v1'
    ) IS NULL
  ) THEN
    RAISE EXCEPTION
      'HXUV1-WOCMD-0A: partial Work Order authority trigger surface'
      USING ERRCODE = 'P0001';
  END IF;
  work_order_authority_relations_installed := pg_catalog.to_regclass(
    'hx_authority.universal_v1_work_order_target_authority_facts'
  ) IS NOT NULL;

  -- The canonical engine chain has none of the supplemental fake-finance
  -- evidence surface. A legacy nonproduction database may already have the
  -- complete v1-v11 surface. Accept only those two exact shapes: never infer
  -- authority from one optional relation or bless a partially applied chain.
  SELECT pg_catalog.count(*)::INTEGER
    INTO fake_financial_surface_marker_count
    FROM pg_catalog.unnest(ARRAY[
      pg_catalog.to_regclass('public.hxos_fake_financial_schema_evidence_v1')::OID,
      pg_catalog.to_regclass('public.hxos_fake_financial_schema_evidence_v2')::OID,
      pg_catalog.to_regclass('public.hxos_fake_financial_schema_evidence_v3')::OID,
      pg_catalog.to_regclass('public.hxos_fake_financial_schema_evidence_v4')::OID,
      pg_catalog.to_regclass('public.hxos_fake_financial_schema_evidence_v5')::OID,
      pg_catalog.to_regclass('public.hxos_fake_financial_schema_evidence_v6')::OID,
      pg_catalog.to_regclass('public.hxos_fake_financial_schema_evidence_v7')::OID,
      pg_catalog.to_regclass('public.hxos_fake_financial_schema_evidence_v8')::OID,
      pg_catalog.to_regclass('public.hxos_fake_financial_schema_evidence_v9')::OID,
      pg_catalog.to_regclass('public.hxos_fake_financial_schema_evidence_v10')::OID,
      pg_catalog.to_regclass('public.hxos_fake_financial_schema_evidence_v11')::OID,
      pg_catalog.to_regclass(
        'public.universal_v1_fake_financial_lifecycle_bridges'
      )::OID,
      pg_catalog.to_regprocedure(
        'public.validate_universal_v1_fake_financial_lifecycle_bridge()'
      )::OID,
      pg_catalog.to_regprocedure(
        'public.reject_universal_v1_fake_financial_lifecycle_bridge_mutation()'
      )::OID,
      pg_catalog.to_regprocedure(
        'public.require_universal_v1_controlled_fake_lifecycle_bridge()'
      )::OID,
      pg_catalog.to_regprocedure(
        'public.enforce_universal_v1_fake_expiry_bridge_v9()'
      )::OID,
      pg_catalog.to_regprocedure(
        'public.validate_universal_v1_fake_terminal_reconcile_command()'
      )::OID,
      pg_catalog.to_regprocedure(
        'public.prevent_change_order_adjust_after_terminal_recovery()'
      )::OID,
      pg_catalog.to_regprocedure(
        'public.require_legacy_expiry_terminal_before_outcome_v10()'
      )::OID
    ]::OID[]) AS marker(marker_oid)
   WHERE marker.marker_oid IS NOT NULL;
  IF fake_financial_surface_marker_count NOT IN (0, 19) THEN
    RAISE EXCEPTION
      'HXUV1-WOCMD-0B: partial nonproduction fake-financial surface (% / 19)',
      fake_financial_surface_marker_count
      USING ERRCODE = 'P0001';
  END IF;
  fake_financial_surface_installed := fake_financial_surface_marker_count = 19;

  WITH trigger_rows AS (
    SELECT pg_catalog.format('%I.%I', namespace_state.nspname, relation_state.relname)
             || '|' || trigger_state.tgname
             || '|' || pg_catalog.format(
                  '%I.%I(%s)', function_namespace.nspname, function_state.proname,
                  pg_catalog.oidvectortypes(function_state.proargtypes)
                )
             || '|' || pg_catalog.pg_get_triggerdef(trigger_state.oid, false)
             || '|' || trigger_state.tgenabled::TEXT
             || '|' || function_state.prolang::pg_catalog.regproc::TEXT
             || '|' || function_state.prokind::TEXT
             || '|' || function_state.prorettype::pg_catalog.regtype::TEXT
             || '|' || function_state.prosecdef::TEXT
             || '|' || function_state.proisstrict::TEXT
             || '|' || function_state.proleakproof::TEXT
             || '|' || function_state.provolatile::TEXT
             || '|' || function_state.proparallel::TEXT
             || '|' || function_state.prosrc AS line
      FROM pg_catalog.pg_trigger trigger_state
      JOIN pg_catalog.pg_class relation_state
        ON relation_state.oid = trigger_state.tgrelid
      JOIN pg_catalog.pg_namespace namespace_state
        ON namespace_state.oid = relation_state.relnamespace
      JOIN pg_catalog.pg_proc function_state
        ON function_state.oid = trigger_state.tgfoid
      JOIN pg_catalog.pg_namespace function_namespace
        ON function_namespace.oid = function_state.pronamespace
     WHERE trigger_state.tgisinternal IS FALSE
       AND pg_catalog.format('%I.%I', namespace_state.nspname, relation_state.relname)
             = ANY (ARRAY[
               'hx_authority.universal_v1_actor_assertion_consumption_facts',
               'hx_authority.universal_v1_actor_assertion_issuance_facts',
               'hx_authority.universal_v1_work_order_command_execution_facts',
               'hx_authority.universal_v1_work_order_target_authority_facts',
               'public.admin_roles',
               'public.business_credentials',
               'public.business_memberships',
               'public.business_organizations',
               'public.capability_profiles',
               'public.current_verified_trade_qualifications',
               'public.financial_provider_command_journal',
               'public.financial_provider_command_outcome_facts',
               'public.hxos_universal_v1_work_order_target_activation_barrier_v1',
               'public.major_action_class_contracts',
               'public.major_action_events',
               'public.major_action_outcomes',
               'public.provider_estimate_submissions',
               'public.recommendations',
               'public.task_applications',
               'public.task_drafts',
               'public.task_estimate_acceptance_materializations',
               'public.task_financial_security_events',
               'public.task_provider_eligibility_decisions',
               'public.task_reservations',
               'public.task_reservation_requests',
               'public.task_routing_decisions',
               'public.task_scope_versions',
               'public.task_work_order_command_requests',
               'public.task_work_orders',
               'public.task_work_order_execution_facts',
               'public.universal_v1_fake_financial_lifecycle_bridges',
               'public.universal_v1_service_cell_authorities',
               'public.universal_v1_work_order_compensation_commands',
               'public.tasks',
               'public.users',
               'public.verified_trades',
               'public.worker_counter_offers',
               'public.worker_offer_decisions'
             ]::TEXT[])
  )
  SELECT pg_catalog.count(*)::INTEGER,
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
           COALESCE(pg_catalog.string_agg(line, E'\n' ORDER BY line), ''),
           'UTF8'
         )), 'hex')
    INTO trigger_count, trigger_catalog_sha256
    FROM trigger_rows;

  IF NOT (
    (
      work_order_authority_relations_installed IS FALSE
      AND fake_financial_surface_installed IS FALSE
      AND trigger_count = 150
      AND trigger_catalog_sha256 =
            'b1fcae11d1808bb54317a8167b7d0c28cff6a9be3732f0a0cb33ef6a2283fa98'
    ) OR (
      work_order_authority_relations_installed IS TRUE
      AND fake_financial_surface_installed IS FALSE
      AND trigger_count = 155
      AND trigger_catalog_sha256 =
            '4e3b52f487d85a7ed0bdf806925f65fdeb9806184c90ac4f5d9514a41061915b'
    ) OR (
      work_order_authority_relations_installed IS FALSE
      AND fake_financial_surface_installed IS TRUE
      AND trigger_count = 159
      AND trigger_catalog_sha256 =
            'ed38b20dc0a54b330f3d9191291c2a3ee4a53453e5256f38efac1f03b0856cc6'
    )
  ) THEN
    RAISE EXCEPTION
      'HXUV1-WOCMD-0A: Work Order trigger catalog mismatch (% / %)',
      trigger_count,
      COALESCE(trigger_catalog_sha256, 'MISSING')
      USING ERRCODE = 'P0001';
  END IF;

  FOR trigger_function IN
    SELECT pg_catalog.unnest(ARRAY[
      'public.anonymize_worker_wallet_on_user_deletion()',
      'public.assert_financial_provider_command_outcome_fact()',
      'public.bind_universal_work_order_to_task()',
      'public.bootstrap_task_draft_marketplace_relationship_origin()',
      'public.bump_task_aggregate_version()',
      'public.certify_task_draft_relationship_origin_presence()',
      'public.close_task_quote_shortlist_on_application_exit()',
      'public.close_task_quote_shortlist_on_assignment()',
      'public.enforce_completed_requires_accepted_proof()',
      'public.enforce_controlled_test_offer_acceptance()',
      'public.enforce_controlled_test_provider_capability_on_accept()',
      'public.enforce_counter_replacement_task()',
      'public.enforce_current_invitation_on_estimate_acceptance()',
      'public.enforce_financial_provider_command_prepared_authority()',
      'public.enforce_hustler_trust_tier_transition()',
      'public.enforce_local_test_offer_snapshot_insert()',
      'public.enforce_local_test_offer_v3_snapshot_insert()',
      'public.enforce_invited_provider_estimate_submission()',
      'public.enforce_local_test_liquidity_task_marker()',
      'public.enforce_local_test_task_duration_update()',
      'public.enforce_production_region_policy_legal_approval()',
      'public.enforce_provider_estimate_submission()',
      'public.enforce_relationship_origin_before_routing()',
      'public.enforce_service_business_task_assignment()',
      'public.enforce_task_clarification_on_accept()',
      'public.enforce_task_clarification_state()',
      'public.enforce_task_draft_account_claim_presence()',
      'public.enforce_task_draft_account_claim_transition()',
      'public.enforce_task_draft_ingress_compatibility_immutability()',
      'public.enforce_task_draft_legacy_receipt_presence()',
      'public.enforce_task_draft_relationship_origin_contract()',
      'public.enforce_task_estimate_acceptance_materialization()',
      'public.enforce_task_identity_verification_environment()',
      'public.enforce_task_liquidity_cell_binding()',
      'public.enforce_task_liquidity_cell_on_accept()',
      'public.enforce_task_region_policy_binding()',
      'public.enforce_task_region_policy_on_accept()',
      'public.enforce_task_retention_binding()',
      'public.enforce_task_template_policy_on_accept()',
      'public.enforce_task_worker_eligibility_on_accept()',
      'public.enforce_offer_identity_verification_environment()',
      'public.enforce_universal_active_scope_transition()',
      'public.enforce_universal_conditional_hold()',
      'public.enforce_universal_conditional_hold_update()',
      'public.enforce_universal_eligibility_sequence()',
      'public.enforce_universal_fake_finance_boundary()',
      'public.enforce_universal_financial_event_sequence()',
      'public.enforce_universal_hard_assignment_hold()',
      'public.enforce_universal_interest_integrity()',
      'public.enforce_universal_post_estimate_hold()',
      'public.enforce_universal_post_estimate_interest()',
      'public.enforce_universal_post_estimate_work_order()',
      'public.enforce_universal_routing_sequence()',
      'public.enforce_universal_task_draft_authority()',
      'public.enforce_universal_task_draft_materialization_presence()',
      'public.enforce_universal_task_draft_one_time_binding()',
      'public.enforce_universal_task_payment_posture()',
      'public.enforce_universal_trade_qualification()',
      'public.enforce_universal_v1_dispute_closure_gate_v1()',
      'public.enforce_universal_v1_dispute_release_gate_v1()',
      'public.enforce_universal_v1_execution_fact()',
      'public.enforce_universal_v1_financial_execution_completion()',
      'public.enforce_universal_v1_service_cell_sequence()',
      'public.enforce_universal_v1_task_draft_route_context_v1()',
      'public.enforce_universal_v1_task_opportunity_interest_v1()',
      'public.enforce_universal_v1_work_order_execution_genesis()',
      'public.enforce_universal_v1_work_order_financial_expiry_v1()',
      'public.enforce_universal_v1_work_order_preinsert_task_v1()',
      'public.enforce_universal_work_order_materialization()',
      'public.enforce_verified_trade_projection()',
      'public.enforce_worker_offer_decision_on_accept()',
      'public.expire_task_location_on_terminal()',
      'public.forbid_work_order_request_mutation()',
      'public.freeze_universal_v1_work_order_task_projection_v1()',
      'public.guard_user_identity_verification_projection()',
      'public.live_task_price_floor()',
      'public.live_task_requires_funded_escrow()',
      'public.lock_universal_v1_fulfillment_execution_insert()',
      'public.mirror_major_action_source_event()',
      'public.pause_business_recurrence_on_authority_change()',
      'public.pause_business_recurrence_on_workspace_change()',
      'public.pause_recurring_on_task_dispute()',
      'public.prevent_append_only_row_mutation()',
      'public.prevent_append_only_truncate()',
      'public.prevent_counter_replacement_binding_mutation()',
      'public.prevent_execution_during_prepared_change_order()',
      'public.prevent_major_action_evidence_mutation()',
      'public.prevent_recommendation_mutation()',
      'public.prevent_stage1_core_evidence_truncate_v1()',
      'public.prevent_task_retention_binding_mutation()',
      'public.prevent_task_template_policy_mutation()',
      'public.prevent_task_terminal_mutation()',
      'public.prevent_universal_v1_fact_mutation()',
      'public.prevent_universal_v1_task_opportunity_interest_delete()',
      'public.prevent_universal_v1_task_opportunity_interest_truncate()',
      'public.prevent_universal_v1_work_order_task_delete_v1()',
      'public.prevent_worker_offer_event_mutation()',
      'public.protect_business_last_owner()',
      'public.publish_universal_routing_decision()',
      'public.record_external_task_completion_attribution()',
      'public.record_legacy_task_draft_claim_observation()',
      'public.record_task_ai_scope_outcome()',
      'public.reject_financial_provider_command_mutation()',
      'public.reject_financial_provider_command_recovery_mutation()',
      'public.reject_universal_v1_work_order_after_compensation()',
      'public.reject_universal_v1_work_order_compensation_mutation()',
      'public.restrict_business_payout_on_provider_change()',
      'public.sync_task_external_offer_from_application()',
      'public.synchronize_hustler_trust_capability_profile()',
      'public.update_updated_at()',
      'public.validate_business_operations_scope()',
      'public.validate_recommendation_ai_observation()',
      'public.validate_task_ai_scope_observation()',
      'public.enforce_worker_counter_offer_mutation()',
      'public.validate_universal_v1_work_order_compensation_command()'
    ]::pg_catalog.regprocedure[])
  LOOP
    EXECUTE pg_catalog.format(
      'ALTER FUNCTION %s SET search_path TO pg_catalog, public',
      trigger_function
    );
  END LOOP;

  IF fake_financial_surface_installed THEN
    FOR trigger_function IN
      SELECT pg_catalog.unnest(ARRAY[
        'public.enforce_universal_v1_fake_expiry_bridge_v9()',
        'public.prevent_change_order_adjust_after_terminal_recovery()',
        'public.reject_universal_v1_fake_financial_lifecycle_bridge_mutation()',
        'public.require_universal_v1_controlled_fake_lifecycle_bridge()',
        'public.validate_universal_v1_fake_financial_lifecycle_bridge()',
        'public.validate_universal_v1_fake_terminal_reconcile_command()'
      ]::pg_catalog.regprocedure[])
    LOOP
      EXECUTE pg_catalog.format(
        'ALTER FUNCTION %s SET search_path TO pg_catalog, public',
        trigger_function
      );
    END LOOP;
    ALTER FUNCTION public.require_legacy_expiry_terminal_before_outcome_v10()
      SET search_path TO pg_catalog;
    REVOKE ALL ON FUNCTION public.require_universal_v1_controlled_fake_lifecycle_bridge()
      FROM PUBLIC;
  END IF;

  -- The assertion append-only guard resolves no public object. Keep its path
  -- narrower than the legacy public trigger family certified above.
  ALTER FUNCTION hx_authority.reject_universal_v1_actor_assertion_mutation_v2()
    SET search_path TO pg_catalog;
  ALTER FUNCTION public.record_major_action_event(
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
    TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT,
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TEXT,
    TIMESTAMPTZ, INTEGER
  ) SET search_path TO pg_catalog, public;
  ALTER FUNCTION public.record_major_action_outcome(
    UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ
  ) SET search_path TO pg_catalog, public;
  ALTER FUNCTION public.mirror_worker_standing_appeal_major_action()
    SET search_path TO pg_catalog, public;
  REVOKE ALL ON FUNCTION public.mirror_major_action_source_event() FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.record_major_action_event(
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
    TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT,
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TEXT,
    TIMESTAMPTZ, INTEGER
  ) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.record_major_action_outcome(
    UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ
  ) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.mirror_worker_standing_appeal_major_action()
    FROM PUBLIC;

  IF work_order_authority_relations_installed THEN
    ALTER FUNCTION hx_authority.reject_universal_v1_work_order_authority_mutation_v1()
      SET search_path TO pg_catalog;
    ALTER FUNCTION hx_authority.validate_universal_v1_work_order_target_activation_v1()
      SET search_path TO pg_catalog;
  END IF;
END;
$$;

-- Ordinal146 and v12 deliberately remain unusable until a later, tiny seal
-- migration can embed both frozen predecessor hashes without a self-hash
-- cycle. Every Work Order command and target activation calls this exact
-- placeholder before reading authority or consuming an assertion.
CREATE OR REPLACE FUNCTION hx_authority.assert_universal_v1_work_order_bootstrap_seal_v1()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION
    'HXUV1-WOCMD-SEAL-0: exact post-v12 Work Order bootstrap seal is required'
    USING ERRCODE = 'P0001';
END;
$$;
REVOKE ALL ON FUNCTION
  hx_authority.assert_universal_v1_work_order_bootstrap_seal_v1()
  FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.hxos_request_universal_v1_fake_work_order_recovery_v1(
  actor_assertion_token TEXT,
  requested_idempotency_key TEXT,
  expected_request_sha256 TEXT,
  secured_event_id UUID
)
RETURNS TABLE (
  completed BOOLEAN,
  work_order_id UUID,
  financial_security_event_id UUID,
  compensation_command_id UUID,
  work_order_idempotency_key TEXT,
  task_draft_id UUID,
  task_id UUID,
  scope_version_id UUID,
  eligibility_decision_id UUID,
  compensation_secured_event_id UUID,
  secured_operation_id UUID,
  void_operation_id UUID,
  void_idempotency_key TEXT,
  amount_cents BIGINT,
  currency TEXT,
  requested_by UUID,
  created_at TIMESTAMPTZ,
  replayed BOOLEAN,
  hard_assignment_created BOOLEAN,
  payment_creation_performed BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  request_authority RECORD;
  actor_authority RECORD;
  witness RECORD;
  claimed RECORD;
  claim_preexisted BOOLEAN;
  secured_is_exact BOOLEAN;
  nonproduction_bootstrap_ready BOOLEAN;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')
       IS DISTINCT FROM 'serializable'
     OR pg_catalog.current_setting('transaction_read_only')::BOOLEAN IS TRUE THEN
    RAISE EXCEPTION
      'HXUV1-WOCMD-7: human Work Order commands require one writable SERIALIZABLE transaction'
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM hx_authority.assert_universal_v1_work_order_bootstrap_seal_v1();
  IF pg_catalog.to_regclass(
       'public.universal_v1_fake_financial_lifecycle_bridges'
     ) IS NULL
     OR pg_catalog.to_regclass(
       'public.hxos_fake_financial_schema_evidence_v12'
     ) IS NULL THEN
    RAISE EXCEPTION
      'HXUV1-WOCMD-49: canonical nonproduction fake-financial bootstrap is required for Work Order recovery'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT pg_catalog.count(*) = 1
    INTO nonproduction_bootstrap_ready
    FROM public.hxos_fake_financial_schema_evidence_v12 evidence
   WHERE evidence.migration_name =
           '20261015_universal_v1_work_order_fake_financial_authority_hardening_v12'
     AND pg_catalog.btrim(evidence.migration_sql_sha256) ~ '^[0-9a-f]{64}$'
     AND pg_catalog.btrim(evidence.migration_sql_sha256) <>
           pg_catalog.repeat('0', 64)
     AND pg_catalog.btrim(evidence.ordinal146_sql_sha256) ~ '^[0-9a-f]{64}$'
     AND pg_catalog.btrim(evidence.ordinal146_sql_sha256) <>
           pg_catalog.repeat('0', 64);
  IF nonproduction_bootstrap_ready IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION
      'HXUV1-WOCMD-49: exact v12 and ordinal146 checksum evidence is required for Work Order recovery'
      USING ERRCODE = 'P0001';
  END IF;
  IF requested_idempotency_key IS NULL
     OR requested_idempotency_key !~ '^[A-Za-z0-9:_-]{16,96}$'
     OR expected_request_sha256 IS NULL
     OR expected_request_sha256 !~ '^[0-9a-f]{64}$'
     OR expected_request_sha256 = pg_catalog.repeat('0', 64)
     OR secured_event_id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-50: exact Work Order recovery witness is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO STRICT request_authority
    FROM hx_authority.build_universal_v1_work_order_command_request_v1(
      'REQUEST_FAKE_WORK_ORDER_RECOVERY',
      pg_catalog.jsonb_build_object(
        'idempotency_key', requested_idempotency_key,
        'request_sha256', expected_request_sha256,
        'secured_event_id', secured_event_id
      )
    );
  SELECT * INTO STRICT actor_authority
    FROM hx_authority.consume_universal_v1_actor_assertion_v1(
      actor_assertion_token,
      'REQUEST_FAKE_WORK_ORDER_RECOVERY',
      request_authority.canonical_request,
      request_authority.environment
    );

  SELECT request.idempotency_key,
         request.request_sha256::TEXT AS request_sha256,
         request.actor_user_id,
         request.task_id,
         request.task_draft_id,
         request.scope_version_id,
         request.eligibility_decision_id,
         request.amount_cents,
         request.currency::TEXT AS currency,
         task.worker_id,
         task.work_order_id AS task_work_order_id,
         existing.id AS work_order_id,
         existing.financial_security_event_id
    INTO witness
    FROM public.task_work_order_command_requests request
    JOIN public.tasks task ON task.id = request.task_id
    LEFT JOIN public.task_work_orders existing
      ON existing.idempotency_key = request.idempotency_key
   WHERE request.idempotency_key = requested_idempotency_key
     AND request.request_sha256 = expected_request_sha256
     AND request.actor_user_id = actor_authority.resolved_user_id
   FOR UPDATE OF request, task;
  IF witness.idempotency_key IS NULL THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-51: exact actor-bound recovery witness changed'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('work-order:' || witness.task_id::TEXT, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'hxuv1-financial-security-task:' || witness.task_id::TEXT,
      0
    )
  );
  PERFORM 1
    FROM public.users actor
   WHERE actor.id = actor_authority.resolved_user_id
   FOR SHARE;
  IF NOT EXISTS (
    SELECT 1
      FROM public.users actor
     WHERE actor.id = actor_authority.resolved_user_id
       AND actor.account_status = 'ACTIVE'
       AND actor.is_minor IS FALSE
       AND COALESCE(actor.is_banned, FALSE) IS FALSE
  ) THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-56: post-lock recovery actor authority was revoked'
      USING ERRCODE = 'P0001';
  END IF;
  IF witness.work_order_id IS NOT NULL OR witness.task_work_order_id IS NOT NULL THEN
    IF witness.work_order_id IS NULL
       OR witness.task_work_order_id IS DISTINCT FROM witness.work_order_id
       OR witness.financial_security_event_id IS DISTINCT FROM secured_event_id THEN
      RAISE EXCEPTION 'HXUV1-WOCMD-52: Work Order recovery outcome is ambiguous'
        USING ERRCODE = 'P0001';
    END IF;
    PERFORM hx_authority.record_universal_v1_work_order_command_execution_v1(
      request_authority.target_authority_id,
      actor_authority.assertion_id,
      'REQUEST_FAKE_WORK_ORDER_RECOVERY',
      request_authority.canonical_request_sha256,
      actor_authority.resolved_user_id,
      NULL,
      requested_idempotency_key,
      witness.task_id,
      NULL,
      'COMPLETED',
      pg_catalog.jsonb_build_object(
        'work_order_id', witness.work_order_id,
        'financial_security_event_id', witness.financial_security_event_id
      )
    );
    RETURN QUERY SELECT
      TRUE,
      witness.work_order_id::UUID,
      witness.financial_security_event_id::UUID,
      NULL::UUID,
      requested_idempotency_key,
      witness.task_draft_id::UUID,
      witness.task_id::UUID,
      witness.scope_version_id::UUID,
      witness.eligibility_decision_id::UUID,
      secured_event_id,
      NULL::UUID,
      NULL::UUID,
      NULL::TEXT,
      witness.amount_cents::BIGINT,
      witness.currency::TEXT,
      actor_authority.resolved_user_id::UUID,
      NULL::TIMESTAMPTZ,
      TRUE,
      FALSE,
      FALSE;
    RETURN;
  END IF;
  IF witness.worker_id IS NOT NULL THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-53: hard assignment forbids fake recovery'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.universal_v1_fake_financial_lifecycle_bridges bridge
      JOIN public.task_financial_security_events event
        ON event.id = bridge.task_financial_security_event_id
      JOIN public.financial_provider_command_journal command
        ON command.command_id = bridge.command_id
      JOIN public.financial_provider_command_outcome_facts outcome
        ON outcome.outcome_fact_id = bridge.outcome_fact_id
      JOIN public.tasks task ON task.id = witness.task_id
     WHERE bridge.task_financial_security_event_id = secured_event_id
       AND bridge.fake_operation_id =
           public.universal_v1_work_order_operation_id_v1(
             requested_idempotency_key,
             'secure'
           )
       AND bridge.fake_operation_kind = 'SECURE'
       AND bridge.fake_provider_state = 'SUCCEEDED'
       AND bridge.lifecycle_event_kind = 'SECURED'
       AND bridge.lifecycle_status = 'SUCCEEDED'
       AND bridge.lifecycle_expected_version = 2
       AND bridge.task_draft_id = witness.task_draft_id
       AND bridge.task_id = witness.task_id
       AND bridge.eligibility_decision_id = witness.eligibility_decision_id
       AND bridge.scope_version_id = witness.scope_version_id
       AND bridge.amount_cents = witness.amount_cents
       AND bridge.currency = witness.currency
       AND command.operation_id = bridge.fake_operation_id
       AND command.operation_kind = 'SECURE'
       AND command.provider_kind = 'FAKE'
       AND command.provider_expected_version = 0
       AND outcome.command_id = command.command_id
       AND outcome.outcome_kind = 'OUTCOME_OBSERVED'
       AND outcome.provider_state = 'SUCCEEDED'
       AND outcome.retryable IS FALSE
       AND event.operation_id = bridge.fake_operation_id::TEXT
       AND event.event_kind = 'SECURED'
       AND event.status = 'SUCCEEDED'
       AND event.provider_kind = 'FAKE'
       AND event.evidence->>'providerState' = 'SUCCEEDED'
       AND event.expected_version = 2
       AND event.task_draft_id = witness.task_draft_id
       AND event.task_id = witness.task_id
       AND event.eligibility_decision_id = witness.eligibility_decision_id
       AND event.scope_version_id = witness.scope_version_id
       AND event.amount_cents = witness.amount_cents
       AND event.currency = witness.currency
       AND outcome.provider_state = event.evidence->>'providerState'
       AND outcome.provider_result_version =
             (event.evidence->>'providerOperationVersion')::INTEGER
       AND task.universal_contract_version = 1
       AND task.automation_classification = 'CONTROLLED_TEST'
       AND task.universal_payment_posture = 'PAYMENT_CREATION_FROZEN'
       AND task.worker_id IS NULL
       AND task.work_order_id IS NULL
       AND NOT EXISTS (
         SELECT 1
           FROM public.task_financial_security_events successor
          WHERE successor.task_draft_id = event.task_draft_id
            AND successor.expected_version > event.expected_version
       )
  ) INTO secured_is_exact;
  IF NOT secured_is_exact THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-54: exact successful fake SECURE recovery authority is unavailable'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.universal_v1_work_order_compensation_commands compensation
     WHERE compensation.work_order_idempotency_key = requested_idempotency_key
  ) INTO claim_preexisted;
  INSERT INTO public.universal_v1_work_order_compensation_commands (
    work_order_idempotency_key,
    secured_event_id,
    requested_by,
    reason_code
  ) VALUES (
    requested_idempotency_key,
    secured_event_id,
    actor_authority.resolved_user_id,
    'FINALIZATION_FAILED'
  )
  ON CONFLICT ON CONSTRAINT
    universal_v1_work_order_compensa_work_order_idempotency_key_key
  DO NOTHING;

  SELECT compensation.compensation_command_id,
         compensation.work_order_idempotency_key,
         compensation.task_draft_id,
         compensation.task_id,
         compensation.scope_version_id,
         compensation.eligibility_decision_id,
         compensation.secured_event_id,
         compensation.secured_operation_id,
         compensation.void_operation_id,
         compensation.void_idempotency_key,
         compensation.amount_cents,
         compensation.currency::TEXT AS currency,
         compensation.requested_by,
         compensation.created_at
    INTO STRICT claimed
    FROM public.universal_v1_work_order_compensation_commands compensation
   WHERE compensation.work_order_idempotency_key = requested_idempotency_key;
  IF claimed.secured_event_id IS DISTINCT FROM secured_event_id
     OR claimed.requested_by IS DISTINCT FROM actor_authority.resolved_user_id THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-55: exact recovery command identity changed'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM hx_authority.record_universal_v1_work_order_command_execution_v1(
    request_authority.target_authority_id,
    actor_authority.assertion_id,
    'REQUEST_FAKE_WORK_ORDER_RECOVERY',
    request_authority.canonical_request_sha256,
    actor_authority.resolved_user_id,
    NULL,
    requested_idempotency_key,
    witness.task_id,
    NULL,
    CASE WHEN claim_preexisted THEN 'REPLAYED' ELSE 'RECOVERY_RECORDED' END,
    pg_catalog.jsonb_build_object(
      'compensation_command_id', claimed.compensation_command_id,
      'secured_event_id', claimed.secured_event_id
    )
  );
  RETURN QUERY SELECT
    FALSE,
    NULL::UUID,
    NULL::UUID,
    claimed.compensation_command_id::UUID,
    claimed.work_order_idempotency_key::TEXT,
    claimed.task_draft_id::UUID,
    claimed.task_id::UUID,
    claimed.scope_version_id::UUID,
    claimed.eligibility_decision_id::UUID,
    claimed.secured_event_id::UUID,
    claimed.secured_operation_id::UUID,
    claimed.void_operation_id::UUID,
    claimed.void_idempotency_key::TEXT,
    claimed.amount_cents::BIGINT,
    claimed.currency::TEXT,
    claimed.requested_by::UUID,
    claimed.created_at::TIMESTAMPTZ,
    claim_preexisted,
    FALSE,
    FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.hxos_claim_universal_v1_work_order_compensation_v2(
  requested_limit INTEGER,
  minimum_age_seconds INTEGER
)
RETURNS SETOF public.universal_v1_work_order_compensation_commands
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  request_authority RECORD;
  candidate public.universal_v1_work_order_compensation_commands%ROWTYPE;
  claimed_count INTEGER := 0;
BEGIN
  PERFORM hx_authority.assert_universal_v1_work_order_bootstrap_seal_v1();
  IF requested_limit IS NULL OR requested_limit < 1 OR requested_limit > 100
     OR minimum_age_seconds IS NULL
     OR minimum_age_seconds < 5 OR minimum_age_seconds > 3600 THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-60: compensation claim bounds are invalid'
      USING ERRCODE = '22023';
  END IF;
  SELECT * INTO STRICT request_authority
    FROM hx_authority.build_universal_v1_work_order_command_request_v1(
      'CLAIM_WORK_ORDER_COMPENSATION',
      pg_catalog.jsonb_build_object(
        'limit', requested_limit,
        'minimum_age_seconds', minimum_age_seconds
      )
    );

  FOR candidate IN
    SELECT *
      FROM public.claim_universal_v1_work_order_compensations(
        requested_limit,
        minimum_age_seconds
      )
  LOOP
    claimed_count := claimed_count + 1;
    PERFORM hx_authority.record_universal_v1_work_order_command_execution_v1(
      request_authority.target_authority_id,
      NULL,
      'CLAIM_WORK_ORDER_COMPENSATION',
      request_authority.canonical_request_sha256,
      NULL,
      'hustlexp.work-order-compensation-worker.v1',
      NULL,
      candidate.compensation_command_id,
      NULL,
      'WORKER_CLAIMED',
      pg_catalog.jsonb_build_object(
        'compensation_command_id', candidate.compensation_command_id,
        'work_order_idempotency_key', candidate.work_order_idempotency_key
      )
    );
    RETURN NEXT candidate;
  END LOOP;
  IF claimed_count = 0 THEN
    PERFORM hx_authority.record_universal_v1_work_order_command_execution_v1(
      request_authority.target_authority_id,
      NULL,
      'CLAIM_WORK_ORDER_COMPENSATION',
      request_authority.canonical_request_sha256,
      NULL,
      'hustlexp.work-order-compensation-worker.v1',
      NULL,
      NULL,
      NULL,
      'WORKER_CLAIMED',
      pg_catalog.jsonb_build_object('claimed_count', 0)
    );
  END IF;
  RETURN;
END;
$$;

-- A command must bind to the database target independently of the presented
-- assertion. The append-only chain has exactly one current tip; no command can
-- infer environment or release identity from assertion issuance evidence.
-- This intentionally empty permanent relation is the snapshot barrier shared
-- by target activation and runtime/data-plane transactions. A runtime caller
-- takes ACCESS SHARE as a utility command before its first snapshot-producing
-- statement; activation takes ACCESS EXCLUSIVE before the target advisory lock.
CREATE TABLE IF NOT EXISTS
  public.hxos_universal_v1_work_order_target_activation_barrier_v1 ();

DO $$
DECLARE
  barrier RECORD;
BEGIN
  SELECT relation.oid,
         relation.relkind,
         relation.relpersistence,
         relation.relispartition,
         relation.relrowsecurity,
         relation.relforcerowsecurity,
         relation.relhasrules,
         relation.relhastriggers,
         relation.relnatts,
         relation.relhassubclass,
         pg_catalog.count(parent.inhparent)::INTEGER AS parent_count
    INTO STRICT barrier
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace
      ON namespace.oid = relation.relnamespace
    LEFT JOIN pg_catalog.pg_inherits parent
      ON parent.inhrelid = relation.oid
   WHERE namespace.nspname = 'public'
     AND relation.relname =
       'hxos_universal_v1_work_order_target_activation_barrier_v1'
   GROUP BY relation.oid;
  IF barrier.relkind IS DISTINCT FROM 'r'
     OR barrier.relpersistence IS DISTINCT FROM 'p'
     OR barrier.relispartition IS DISTINCT FROM FALSE
     OR barrier.relrowsecurity IS DISTINCT FROM FALSE
     OR barrier.relforcerowsecurity IS DISTINCT FROM FALSE
     OR barrier.relhasrules IS DISTINCT FROM FALSE
     OR barrier.relhastriggers IS DISTINCT FROM FALSE
     OR barrier.relnatts IS DISTINCT FROM 0
     OR barrier.relhassubclass IS DISTINCT FROM FALSE
     OR barrier.parent_count IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION
      'HXUV1-WOCMD-0D: target activation snapshot barrier is not exact'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS hx_authority.universal_v1_work_order_target_authority_facts (
  target_authority_id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  authority_version INTEGER NOT NULL UNIQUE CHECK (authority_version > 0),
  supersedes_target_authority_id UUID UNIQUE REFERENCES
    hx_authority.universal_v1_work_order_target_authority_facts(target_authority_id)
    ON DELETE RESTRICT,
  target_database_name TEXT NOT NULL CHECK (
    target_database_name = pg_catalog.btrim(target_database_name)
    AND pg_catalog.char_length(target_database_name) BETWEEN 1 AND 63
  ),
  environment TEXT NOT NULL CHECK (environment IN ('local', 'preview', 'staging')),
  release_manifest_sha256 TEXT NOT NULL CHECK (
    release_manifest_sha256 ~ '^sha256:[0-9a-f]{64}$'
    AND release_manifest_sha256 <> 'sha256:' || pg_catalog.repeat('0', 64)
  ),
  activation_request_sha256 CHAR(64) NOT NULL UNIQUE CHECK (
    activation_request_sha256 ~ '^[0-9a-f]{64}$'
    AND activation_request_sha256 <> pg_catalog.repeat('0', 64)
  ),
  activated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT universal_v1_work_order_target_chain_shape_v1_chk CHECK (
    (authority_version = 1 AND supersedes_target_authority_id IS NULL)
    OR (authority_version > 1 AND supersedes_target_authority_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS hx_authority.universal_v1_work_order_command_execution_facts (
  command_execution_fact_id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  target_authority_id UUID NOT NULL REFERENCES
    hx_authority.universal_v1_work_order_target_authority_facts(target_authority_id)
    ON DELETE RESTRICT,
  actor_assertion_id UUID REFERENCES
    hx_authority.universal_v1_actor_assertion_issuance_facts(assertion_id)
    ON DELETE RESTRICT,
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
  actor_user_id UUID REFERENCES public.users(id) ON DELETE RESTRICT,
  service_identity TEXT,
  idempotency_key TEXT,
  domain_object_id UUID,
  expected_version INTEGER CHECK (expected_version IS NULL OR expected_version >= 0),
  result_kind TEXT NOT NULL CHECK (result_kind IN (
    'RECORDED', 'REPLAYED', 'COMPLETED', 'RECOVERY_RECORDED', 'WORKER_CLAIMED'
  )),
  result_identifiers JSONB NOT NULL CHECK (
    pg_catalog.jsonb_typeof(result_identifiers) = 'object'
  ),
  hard_assignment_created BOOLEAN NOT NULL DEFAULT FALSE CHECK (
    hard_assignment_created IS FALSE
  ),
  payment_creation_performed BOOLEAN NOT NULL DEFAULT FALSE CHECK (
    payment_creation_performed IS FALSE
  ),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT universal_v1_work_order_command_actor_shape_v1_chk CHECK (
    (
      command_kind <> 'CLAIM_WORK_ORDER_COMPENSATION'
      AND actor_assertion_id IS NOT NULL
      AND actor_user_id IS NOT NULL
      AND service_identity IS NULL
      AND idempotency_key IS NOT NULL
    ) OR (
      command_kind = 'CLAIM_WORK_ORDER_COMPENSATION'
      AND actor_assertion_id IS NULL
      AND actor_user_id IS NULL
      AND service_identity = 'hustlexp.work-order-compensation-worker.v1'
      AND idempotency_key IS NULL
    )
  ),
  CONSTRAINT universal_v1_work_order_command_assertion_once_v1_uniq
    UNIQUE (actor_assertion_id)
);

CREATE INDEX IF NOT EXISTS universal_v1_work_order_command_execution_time_v1_idx
  ON hx_authority.universal_v1_work_order_command_execution_facts(
    recorded_at,
    command_execution_fact_id
  );

CREATE OR REPLACE FUNCTION hx_authority.reject_universal_v1_work_order_authority_mutation_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'HXUV1-WOCMD-1: Work Order target and command authority facts are append-only'
    USING ERRCODE = 'P0001';
END;
$$;

CREATE OR REPLACE FUNCTION hx_authority.validate_universal_v1_work_order_target_activation_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  current_tip RECORD;
BEGIN
  LOCK TABLE public.hxos_universal_v1_work_order_target_activation_barrier_v1
    IN ACCESS EXCLUSIVE MODE;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hxuv1-work-order-target-authority-v1', 0)
  );
  NEW.activated_at := pg_catalog.clock_timestamp();
  IF NEW.target_database_name IS DISTINCT FROM pg_catalog.current_database() THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-2: target authority names a different database'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT target.target_authority_id, target.authority_version
    INTO current_tip
    FROM hx_authority.universal_v1_work_order_target_authority_facts target
   WHERE NOT EXISTS (
     SELECT 1
       FROM hx_authority.universal_v1_work_order_target_authority_facts successor
      WHERE successor.supersedes_target_authority_id = target.target_authority_id
   )
   FOR SHARE;

  IF current_tip.target_authority_id IS NULL THEN
    IF NEW.authority_version <> 1 OR NEW.supersedes_target_authority_id IS NOT NULL THEN
      RAISE EXCEPTION 'HXUV1-WOCMD-3: first target authority must be exact version one'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.authority_version <> current_tip.authority_version + 1
        OR NEW.supersedes_target_authority_id IS DISTINCT FROM
             current_tip.target_authority_id THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-3: target authority must extend the one current tip'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_work_order_target_activation_guard_v1
  ON hx_authority.universal_v1_work_order_target_authority_facts;
CREATE TRIGGER universal_v1_work_order_target_activation_guard_v1
BEFORE INSERT ON hx_authority.universal_v1_work_order_target_authority_facts
FOR EACH ROW
EXECUTE FUNCTION hx_authority.validate_universal_v1_work_order_target_activation_v1();

DROP TRIGGER IF EXISTS universal_v1_work_order_target_no_mutation_v1
  ON hx_authority.universal_v1_work_order_target_authority_facts;
CREATE TRIGGER universal_v1_work_order_target_no_mutation_v1
BEFORE UPDATE OR DELETE ON hx_authority.universal_v1_work_order_target_authority_facts
FOR EACH ROW
EXECUTE FUNCTION hx_authority.reject_universal_v1_work_order_authority_mutation_v1();

DROP TRIGGER IF EXISTS universal_v1_work_order_target_no_truncate_v1
  ON hx_authority.universal_v1_work_order_target_authority_facts;
CREATE TRIGGER universal_v1_work_order_target_no_truncate_v1
BEFORE TRUNCATE ON hx_authority.universal_v1_work_order_target_authority_facts
FOR EACH STATEMENT
EXECUTE FUNCTION hx_authority.reject_universal_v1_work_order_authority_mutation_v1();

DROP TRIGGER IF EXISTS universal_v1_work_order_command_execution_no_mutation_v1
  ON hx_authority.universal_v1_work_order_command_execution_facts;
CREATE TRIGGER universal_v1_work_order_command_execution_no_mutation_v1
BEFORE UPDATE OR DELETE ON hx_authority.universal_v1_work_order_command_execution_facts
FOR EACH ROW
EXECUTE FUNCTION hx_authority.reject_universal_v1_work_order_authority_mutation_v1();

DROP TRIGGER IF EXISTS universal_v1_work_order_command_execution_no_truncate_v1
  ON hx_authority.universal_v1_work_order_command_execution_facts;
CREATE TRIGGER universal_v1_work_order_command_execution_no_truncate_v1
BEFORE TRUNCATE ON hx_authority.universal_v1_work_order_command_execution_facts
FOR EACH STATEMENT
EXECUTE FUNCTION hx_authority.reject_universal_v1_work_order_authority_mutation_v1();

CREATE OR REPLACE FUNCTION hx_authority.read_universal_v1_work_order_target_authority_v1()
RETURNS TABLE (
  target_authority_id UUID,
  authority_version INTEGER,
  target_database_name TEXT,
  environment TEXT,
  release_manifest_sha256 TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
DECLARE
  target_count INTEGER;
  selected_target RECORD;
BEGIN
  PERFORM hx_authority.assert_universal_v1_work_order_bootstrap_seal_v1();
  SELECT pg_catalog.count(*)::INTEGER
    INTO target_count
    FROM hx_authority.universal_v1_work_order_target_authority_facts target
   WHERE NOT EXISTS (
     SELECT 1
       FROM hx_authority.universal_v1_work_order_target_authority_facts successor
      WHERE successor.supersedes_target_authority_id = target.target_authority_id
   );

  IF target_count <> 1 THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-4: exactly one current target authority is required'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT target.target_authority_id,
         target.authority_version,
         target.target_database_name,
         target.environment,
         target.release_manifest_sha256
    INTO STRICT selected_target
    FROM hx_authority.universal_v1_work_order_target_authority_facts target
   WHERE NOT EXISTS (
     SELECT 1
       FROM hx_authority.universal_v1_work_order_target_authority_facts successor
      WHERE successor.supersedes_target_authority_id = target.target_authority_id
   );
  IF selected_target.target_authority_id IS NULL
     OR selected_target.authority_version IS NULL
     OR selected_target.authority_version < 1
     OR selected_target.target_database_name IS DISTINCT FROM pg_catalog.current_database()
     OR selected_target.environment IS NULL
     OR selected_target.environment NOT IN ('local', 'preview', 'staging')
     OR selected_target.release_manifest_sha256 IS NULL
     OR selected_target.release_manifest_sha256 !~ '^sha256:[0-9a-f]{64}$'
     OR selected_target.release_manifest_sha256 =
          'sha256:' || pg_catalog.repeat('0', 64) THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-5: current target authority is not exact isolated nonproduction'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY SELECT
    selected_target.target_authority_id,
    selected_target.authority_version,
    selected_target.target_database_name,
    selected_target.environment,
    selected_target.release_manifest_sha256;
END;
$$;

-- The LOGIN migration authority cannot own or write the sealed target table.
-- This command-owner port is its only post-provision activation path. It binds
-- one exact release manifest to the current database and append-only target
-- chain, serializes with every Work Order command, and treats the complete
-- canonical activation request digest as the idempotency identity.
CREATE OR REPLACE FUNCTION public.hxos_activate_universal_v1_work_order_target_v1(
  requested_environment TEXT,
  requested_release_manifest_sha256 TEXT,
  expected_current_target_authority_id UUID,
  expected_current_authority_version INTEGER
)
RETURNS TABLE (
  target_authority_id UUID,
  authority_version INTEGER,
  activation_request_sha256 TEXT,
  replayed BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  current_tip_count INTEGER;
  current_tip RECORD;
  existing_activation_count INTEGER;
  existing_activation RECORD;
  evidence_count INTEGER;
  evidence_migration_name TEXT;
  evidence_ordinal146_sha256 TEXT;
  evidence_v12_sha256 TEXT;
  next_authority_version INTEGER;
  canonical_activation_sha256 TEXT;
  inserted_target_id UUID;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'serializable'
     OR pg_catalog.current_setting('transaction_read_only')::BOOLEAN IS TRUE THEN
    RAISE EXCEPTION
      'HXUV1-WOCMD-60: target activation requires one writable SERIALIZABLE transaction'
      USING ERRCODE = 'P0001';
  END IF;
  LOCK TABLE public.hxos_universal_v1_work_order_target_activation_barrier_v1
    IN ACCESS EXCLUSIVE MODE;
  PERFORM hx_authority.assert_universal_v1_work_order_bootstrap_seal_v1();
  IF requested_environment IS NULL
     OR requested_environment NOT IN ('local', 'preview', 'staging')
     OR requested_release_manifest_sha256 IS NULL
     OR requested_release_manifest_sha256 !~ '^sha256:[0-9a-f]{64}$'
     OR requested_release_manifest_sha256 =
          'sha256:' || pg_catalog.repeat('0', 64)
     OR expected_current_authority_version IS NULL
     OR expected_current_authority_version < 0
     OR (
       expected_current_authority_version = 0
       AND expected_current_target_authority_id IS NOT NULL
     )
     OR (
       expected_current_authority_version > 0
       AND expected_current_target_authority_id IS NULL
     ) THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-61: target activation request is not exact'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT pg_catalog.count(*)::INTEGER,
         pg_catalog.min(evidence.migration_name),
         pg_catalog.min(pg_catalog.btrim(evidence.ordinal146_sql_sha256)),
         pg_catalog.min(pg_catalog.btrim(evidence.migration_sql_sha256))
    INTO evidence_count, evidence_migration_name,
         evidence_ordinal146_sha256, evidence_v12_sha256
    FROM public.hxos_fake_financial_schema_evidence_v12 evidence;
  IF evidence_count <> 1
     OR evidence_migration_name IS NULL
     OR evidence_migration_name IS DISTINCT FROM
          '20261015_universal_v1_work_order_fake_financial_authority_hardening_v12'
     OR evidence_ordinal146_sha256 IS NULL
     OR evidence_ordinal146_sha256 !~ '^[0-9a-f]{64}$'
     OR evidence_ordinal146_sha256 = pg_catalog.repeat('0', 64)
     OR evidence_v12_sha256 IS NULL
     OR evidence_v12_sha256 !~ '^[0-9a-f]{64}$'
     OR evidence_v12_sha256 = pg_catalog.repeat('0', 64) THEN
    RAISE EXCEPTION
      'HXUV1-WOCMD-62: target activation requires exact immutable bootstrap evidence'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hxuv1-work-order-target-authority-v1', 0)
  );

  next_authority_version := expected_current_authority_version + 1;
  canonical_activation_sha256 := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'schema_version', 1,
          'target_database_name', pg_catalog.current_database(),
          'environment', requested_environment,
          'release_manifest_sha256', requested_release_manifest_sha256,
          'authority_version', next_authority_version,
          'supersedes_target_authority_id', expected_current_target_authority_id,
          'ordinal146_sql_sha256', evidence_ordinal146_sha256,
          'v12_sql_sha256', evidence_v12_sha256
        )::TEXT,
        'UTF8'
      )
    ),
    'hex'
  );

  SELECT pg_catalog.count(*)::INTEGER
    INTO current_tip_count
    FROM hx_authority.universal_v1_work_order_target_authority_facts;
  IF current_tip_count > 0 THEN
    SELECT target.target_authority_id,
           target.authority_version,
           target.target_database_name,
           target.environment,
           target.release_manifest_sha256
      INTO STRICT current_tip
      FROM hx_authority.read_universal_v1_work_order_target_authority_v1() target;
    current_tip_count := 1;
  END IF;

  SELECT pg_catalog.count(*)::INTEGER
    INTO existing_activation_count
    FROM hx_authority.universal_v1_work_order_target_authority_facts target
   WHERE target.activation_request_sha256 = canonical_activation_sha256;
  IF existing_activation_count > 0 THEN
    IF existing_activation_count <> 1 THEN
      RAISE EXCEPTION 'HXUV1-WOCMD-63: release target replay is ambiguous'
        USING ERRCODE = 'P0001';
    END IF;
    SELECT target.target_authority_id,
           target.authority_version,
           target.supersedes_target_authority_id,
           target.target_database_name,
           target.environment,
           pg_catalog.btrim(target.activation_request_sha256) AS activation_request_sha256
      INTO STRICT existing_activation
      FROM hx_authority.universal_v1_work_order_target_authority_facts target
     WHERE target.activation_request_sha256 = canonical_activation_sha256;
    IF existing_activation.authority_version IS DISTINCT FROM next_authority_version
       OR existing_activation.supersedes_target_authority_id IS DISTINCT FROM
            expected_current_target_authority_id
       OR existing_activation.target_database_name IS DISTINCT FROM pg_catalog.current_database()
       OR existing_activation.environment IS DISTINCT FROM requested_environment
       OR existing_activation.activation_request_sha256 IS DISTINCT FROM
            canonical_activation_sha256
       OR current_tip_count <> 1
       OR current_tip.target_authority_id IS DISTINCT FROM
            existing_activation.target_authority_id THEN
      RAISE EXCEPTION 'HXUV1-WOCMD-64: release target replay conflicts'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY SELECT
      existing_activation.target_authority_id::UUID,
      existing_activation.authority_version::INTEGER,
      existing_activation.activation_request_sha256::TEXT,
      TRUE;
    RETURN;
  END IF;

  IF current_tip_count = 0 THEN
    IF expected_current_authority_version <> 0
       OR expected_current_target_authority_id IS NOT NULL THEN
      RAISE EXCEPTION 'HXUV1-WOCMD-65: initial target expectation conflicts'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF current_tip_count = 1 THEN
    IF current_tip.target_authority_id IS DISTINCT FROM
         expected_current_target_authority_id
       OR current_tip.authority_version IS DISTINCT FROM
            expected_current_authority_version THEN
      RAISE EXCEPTION 'HXUV1-WOCMD-65: current target expectation conflicts'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO hx_authority.universal_v1_work_order_target_authority_facts AS inserted(
    authority_version,
    supersedes_target_authority_id,
    target_database_name,
    environment,
    release_manifest_sha256,
    activation_request_sha256
  ) VALUES (
    next_authority_version,
    expected_current_target_authority_id,
    pg_catalog.current_database(),
    requested_environment,
    requested_release_manifest_sha256,
    canonical_activation_sha256
  )
  RETURNING inserted.target_authority_id
    INTO inserted_target_id;

  RETURN QUERY SELECT
    inserted_target_id,
    next_authority_version,
    canonical_activation_sha256,
    FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.hxos_activate_universal_v1_work_order_target_v1(
  TEXT, TEXT, UUID, INTEGER
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION hx_authority.build_universal_v1_work_order_command_request_v1(
  expected_command_kind TEXT,
  command_payload JSONB
)
RETURNS TABLE (
  target_authority_id UUID,
  environment TEXT,
  release_manifest_sha256 TEXT,
  canonical_request JSONB,
  actor_request_sha256 TEXT,
  canonical_request_sha256 TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  target RECORD;
BEGIN
  IF expected_command_kind NOT IN (
    'EXPRESS_POST_ESTIMATE_INTEREST',
    'PLACE_CONDITIONAL_HOLD',
    'PREPARE_FAKE_WORK_ORDER',
    'MATERIALIZE_FAKE_WORK_ORDER',
    'REQUEST_FAKE_WORK_ORDER_RECOVERY',
    'CLAIM_WORK_ORDER_COMPENSATION'
  ) OR pg_catalog.jsonb_typeof(command_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-6: canonical command kind and object payload are required'
      USING ERRCODE = 'P0001';
  END IF;
  IF command_payload::TEXT ~
       '"(actor_id|actor_uuid|auth_facts|authorization|capability|command_kind|environment|firebase_uid|mfa_verified|release_manifest_sha256|role|step_up|verified_subject)"[[:space:]]*:' THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-6: command payload may not contain authority fields'
      USING ERRCODE = 'P0001';
  END IF;

  -- Share the activation trigger's lock. Every caller holds the exact target
  -- tip stable through its surrounding transaction and all domain writes.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hxuv1-work-order-target-authority-v1', 0)
  );
  SELECT * INTO STRICT target
    FROM hx_authority.read_universal_v1_work_order_target_authority_v1();
  canonical_request := pg_catalog.jsonb_build_object(
    'schema_version', 1,
    'command_kind', expected_command_kind,
    'release_manifest_sha256', target.release_manifest_sha256,
    'target_authority', pg_catalog.jsonb_build_object(
      'id', target.target_authority_id,
      'version', target.authority_version,
      'database', target.target_database_name,
      'environment', target.environment,
      'release', target.release_manifest_sha256
    ),
    'authentication_requirements', pg_catalog.jsonb_build_object(
      'mfa_required', FALSE,
      'step_up_required', FALSE,
      'max_auth_age_seconds', 300,
      'max_step_up_age_seconds', NULL
    ),
    'command_payload', command_payload
  );
  target_authority_id := target.target_authority_id;
  environment := target.environment;
  release_manifest_sha256 := target.release_manifest_sha256;
  actor_request_sha256 := pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(canonical_request::TEXT, 'UTF8')
  ), 'hex');
  canonical_request_sha256 := pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(
      pg_catalog.jsonb_build_object(
        'schema_version', 1,
        'command_kind', expected_command_kind,
        'target_authority', pg_catalog.jsonb_build_object(
          'target_authority_id', target.target_authority_id,
          'authority_version', target.authority_version,
          'target_database_name', target.target_database_name,
          'isolated_environment', target.environment,
          'release_manifest_sha256', target.release_manifest_sha256
        ),
        'actor_request_sha256', actor_request_sha256,
        'command_payload', command_payload
      )::TEXT,
      'UTF8'
    )
  ), 'hex');
  RETURN NEXT;
END;
$$;

-- Narrow pre-attestation authority: the API may ask the sealed command owner
-- to build the exact actor-signed request, but cannot read hx_authority facts
-- or supply a target id/version/database itself. The final human command
-- rebuilds the request under the same target-tip lock and rejects tip drift.
CREATE OR REPLACE FUNCTION public.hxos_build_universal_v1_work_order_actor_request_v1(
  expected_command_kind TEXT,
  command_payload JSONB
)
RETURNS TABLE (
  target_authority_id UUID,
  environment TEXT,
  release_manifest_sha256 TEXT,
  canonical_request JSONB,
  actor_request_sha256 TEXT
)
LANGUAGE sql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
  SELECT request.target_authority_id,
         request.environment,
         request.release_manifest_sha256,
         request.canonical_request,
         request.actor_request_sha256
    FROM hx_authority.build_universal_v1_work_order_command_request_v1(
      expected_command_kind,
      command_payload
    ) request;
$$;
REVOKE ALL ON FUNCTION
  public.hxos_build_universal_v1_work_order_actor_request_v1(TEXT, JSONB)
FROM PUBLIC;

CREATE OR REPLACE FUNCTION hx_authority.record_universal_v1_work_order_command_execution_v1(
  recorded_target_authority_id UUID,
  recorded_actor_assertion_id UUID,
  recorded_command_kind TEXT,
  recorded_canonical_request_sha256 TEXT,
  recorded_actor_user_id UUID,
  recorded_service_identity TEXT,
  recorded_idempotency_key TEXT,
  recorded_domain_object_id UUID,
  recorded_expected_version INTEGER,
  recorded_result_kind TEXT,
  recorded_result_identifiers JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
BEGIN
  INSERT INTO hx_authority.universal_v1_work_order_command_execution_facts (
    target_authority_id,
    actor_assertion_id,
    command_kind,
    canonical_request_sha256,
    actor_user_id,
    service_identity,
    idempotency_key,
    domain_object_id,
    expected_version,
    result_kind,
    result_identifiers,
    hard_assignment_created,
    payment_creation_performed,
    recorded_at
  ) VALUES (
    recorded_target_authority_id,
    recorded_actor_assertion_id,
    recorded_command_kind,
    recorded_canonical_request_sha256,
    recorded_actor_user_id,
    recorded_service_identity,
    recorded_idempotency_key,
    recorded_domain_object_id,
    recorded_expected_version,
    recorded_result_kind,
    recorded_result_identifiers,
    FALSE,
    FALSE,
    pg_catalog.clock_timestamp()
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.hxos_express_universal_v1_post_estimate_interest_v1(
  actor_assertion_token TEXT,
  requested_task_id UUID,
  expected_scope_version INTEGER,
  requested_idempotency_key TEXT,
  client_timestamp TIMESTAMPTZ
)
RETURNS TABLE (
  interest_application_id UUID,
  eligibility_decision_id UUID,
  eligibility_version INTEGER,
  replayed BOOLEAN,
  hard_assignment_created BOOLEAN,
  payment_creation_performed BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  database_now TIMESTAMPTZ;
  request_authority RECORD;
  actor_authority RECORD;
  prior RECORD;
  current_authority RECORD;
  inserted_application_id UUID;
  inserted_eligibility_id UUID;
  next_eligibility_version INTEGER;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')
       IS DISTINCT FROM 'serializable'
     OR pg_catalog.current_setting('transaction_read_only')::BOOLEAN IS TRUE THEN
    RAISE EXCEPTION
      'HXUV1-WOCMD-7: human Work Order commands require one writable SERIALIZABLE transaction'
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM hx_authority.assert_universal_v1_work_order_bootstrap_seal_v1();
  database_now := pg_catalog.clock_timestamp();
  IF requested_task_id IS NULL
     OR expected_scope_version IS NULL OR expected_scope_version < 1
     OR requested_idempotency_key IS NULL
     OR requested_idempotency_key !~ '^[A-Za-z0-9:_-]{16,96}$'
     OR client_timestamp IS NULL
     OR client_timestamp IS DISTINCT FROM
          pg_catalog.date_trunc('milliseconds', client_timestamp)
     OR client_timestamp < database_now - INTERVAL '5 minutes'
     OR client_timestamp > database_now + INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-10: exact current provider-interest command is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO STRICT request_authority
    FROM hx_authority.build_universal_v1_work_order_command_request_v1(
      'EXPRESS_POST_ESTIMATE_INTEREST',
      pg_catalog.jsonb_build_object(
        'task_id', requested_task_id,
        'expected_scope_version', expected_scope_version,
        'idempotency_key', requested_idempotency_key,
        'client_timestamp_epoch_ms',
          pg_catalog.floor(EXTRACT(EPOCH FROM client_timestamp) * 1000)::BIGINT
      )
    );
  SELECT * INTO STRICT actor_authority
    FROM hx_authority.consume_universal_v1_actor_assertion_v1(
      actor_assertion_token,
      'EXPRESS_POST_ESTIMATE_INTEREST',
      request_authority.canonical_request,
      request_authority.environment
    );

  -- The append-only initial execution witness is actor/idempotency scoped and
  -- commits atomically with the domain rows. Compare its complete canonical
  -- request before filtering on task or scope so every changed replay fails as
  -- an idempotency conflict instead of falling through to authority/uniqueness.
  IF EXISTS (
    SELECT 1
      FROM hx_authority.universal_v1_work_order_command_execution_facts execution
     WHERE execution.command_kind = 'EXPRESS_POST_ESTIMATE_INTEREST'
       AND execution.actor_user_id = actor_authority.resolved_user_id
       AND execution.idempotency_key = requested_idempotency_key
       AND execution.result_kind IN ('RECORDED', 'REPLAYED')
       AND execution.canonical_request_sha256 IS DISTINCT FROM
             request_authority.canonical_request_sha256
  ) THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-11: provider-interest idempotency payload changed'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('work-order-interest:' || requested_task_id::TEXT, 0)
  );

  SELECT application.id AS interest_application_id,
         eligibility.id AS eligibility_decision_id,
         eligibility.decision_version AS eligibility_version,
         application.request_sha256::TEXT AS request_sha256
    INTO prior
    FROM public.task_applications application
    JOIN public.task_provider_eligibility_decisions eligibility
      ON eligibility.interest_application_id = application.id
    JOIN public.task_scope_versions scope
      ON scope.id = eligibility.scope_version_id
   WHERE application.idempotency_key = requested_idempotency_key
     AND application.task_id = requested_task_id
     AND application.universal_contract_version = 1
     AND application.authority = 'EXPRESS_INTEREST'
     AND scope.version = expected_scope_version
     AND eligibility.processor_payment_eligible IS FALSE
     AND eligibility.payout_funding_eligible IS FALSE
     AND (
       (
         eligibility.provider_organization_id IS NULL
         AND eligibility.provider_user_id = actor_authority.resolved_user_id
       ) OR EXISTS (
         SELECT 1
           FROM public.business_memberships membership
          WHERE membership.organization_id = eligibility.provider_organization_id
            AND membership.user_id = actor_authority.resolved_user_id
            AND membership.status = 'ACTIVE'
            AND membership.role IN ('OWNER', 'ADMIN')
       )
     )
   LIMIT 1
   FOR UPDATE OF application, eligibility;

  IF prior.interest_application_id IS NOT NULL THEN
    IF prior.request_sha256 IS DISTINCT FROM request_authority.canonical_request_sha256 THEN
      RAISE EXCEPTION 'HXUV1-WOCMD-11: provider-interest idempotency payload changed'
        USING ERRCODE = 'P0001';
    END IF;
    PERFORM hx_authority.record_universal_v1_work_order_command_execution_v1(
      request_authority.target_authority_id,
      actor_authority.assertion_id,
      'EXPRESS_POST_ESTIMATE_INTEREST',
      request_authority.canonical_request_sha256,
      actor_authority.resolved_user_id,
      NULL,
      requested_idempotency_key,
      requested_task_id,
      expected_scope_version,
      'REPLAYED',
      pg_catalog.jsonb_build_object(
        'interest_application_id', prior.interest_application_id,
        'eligibility_decision_id', prior.eligibility_decision_id,
        'eligibility_version', prior.eligibility_version
      )
    );
    RETURN QUERY SELECT
      prior.interest_application_id::UUID,
      prior.eligibility_decision_id::UUID,
      prior.eligibility_version::INTEGER,
      TRUE,
      FALSE,
      FALSE;
    RETURN;
  END IF;

  SELECT task.id AS task_id,
         draft.id AS task_draft_id,
         scope.id AS scope_version_id,
         scope.version AS scope_version,
         route.id AS routing_decision_id,
         cell.id AS service_cell_authority_id,
         cell.effective_from AS service_cell_effective_from,
         cell.expires_at AS service_cell_expires_at,
         eligibility.provider_user_id,
         eligibility.provider_organization_id,
         eligibility.provider_class,
         eligibility.trade_credential_id,
         eligibility.id AS predecessor_eligibility_id,
         eligibility.routing_decision_id AS predecessor_routing_decision_id,
         eligibility.decision_version AS predecessor_eligibility_version,
         eligibility.valid_until AS predecessor_valid_until,
         eligibility.profile_eligible,
         eligibility.identity_eligible,
         eligibility.category_eligible,
         eligibility.credential_eligible,
         eligibility.geography_eligible,
         eligibility.availability_eligible,
         eligibility.restriction_clear,
         eligibility.task_eligible,
         eligibility.trust_tier,
         eligibility.blocker_codes,
         eligibility.policy_version,
         eligibility.evidence
    INTO current_authority
    FROM public.tasks task
    JOIN public.task_drafts draft ON draft.task_id = task.id
    JOIN public.task_scope_versions scope ON scope.id = task.active_scope_version_id
    JOIN public.task_routing_decisions route ON route.id = draft.active_routing_decision_id
    JOIN public.task_routing_decisions predecessor_route
      ON predecessor_route.id = route.supersedes_decision_id
    JOIN public.universal_v1_service_cell_authorities cell
      ON cell.id = route.service_cell_authority_id
    JOIN public.task_estimate_acceptance_materializations materialization
      ON materialization.task_draft_id = draft.id
     AND materialization.task_id = task.id
     AND materialization.scope_version_id = scope.id
     AND materialization.resulting_routing_decision_id = route.id
    JOIN public.provider_estimate_submissions estimate
      ON estimate.id = materialization.provider_estimate_submission_id
     AND estimate.routing_decision_id = materialization.prior_routing_decision_id
    JOIN public.task_provider_eligibility_decisions eligibility
      ON eligibility.task_draft_id = draft.id
     AND eligibility.provider_user_id = estimate.provider_user_id
     AND eligibility.provider_organization_id IS NOT DISTINCT FROM
           estimate.provider_organization_id
     AND eligibility.routing_decision_id = materialization.prior_routing_decision_id
    JOIN public.users provider ON provider.id = eligibility.provider_user_id
    LEFT JOIN public.capability_profiles profile
      ON profile.user_id = eligibility.provider_user_id
    LEFT JOIN public.business_organizations organization
      ON organization.id = eligibility.provider_organization_id
   WHERE task.id = requested_task_id
     AND scope.version = expected_scope_version
     AND eligibility.task_id IS NULL
     AND eligibility.scope_version_id IS NULL
     AND eligibility.interest_application_id IS NULL
     AND route.supersedes_decision_id = eligibility.routing_decision_id
     AND predecessor_route.task_draft_id = draft.id
     AND predecessor_route.outcome = 'ESTIMATE_REQUIRED'
     AND predecessor_route.category_snapshot = route.category_snapshot
     AND predecessor_route.service_cell_snapshot = route.service_cell_snapshot
     AND predecessor_route.service_cell_authority_id = route.service_cell_authority_id
     AND route.outcome = 'FULFILLMENT_CANDIDATE'
     AND route.category_snapshot = task.category
     AND route.service_cell_snapshot = task.region_code
     AND cell.region_code = task.region_code
     AND cell.routing_availability = 'ACTIVE'
     AND cell.effective_from <= database_now
     AND (cell.expires_at IS NULL OR cell.expires_at > database_now)
     AND NOT EXISTS (
       SELECT 1
         FROM public.universal_v1_service_cell_authorities successor
        WHERE successor.supersedes_authority_id = cell.id
     )
     AND estimate.work_category_code = task.category
     AND task.scope_hash = scope.scope_hash
     AND estimate.scope_hash = scope.scope_hash
     AND estimate.customer_total_cents = scope.customer_total_cents
     AND estimate.provider_payout_cents = scope.hustler_payout_cents
     AND estimate.currency = scope.currency
     AND eligibility.evidence->>'work_category_code' = task.category
     AND eligibility.evidence->>'region_code' = task.region_code
     AND eligibility.evidence->>'risk_level' = task.risk_level
     AND eligibility.evidence->'requires_proof' = pg_catalog.to_jsonb(task.requires_proof)
     AND eligibility.evidence->>'rough_location' = task.rough_location
     AND (
       (
         eligibility.provider_class = 'GENERAL_SERVICE_PROVIDER'
         AND profile.provider_class = eligibility.provider_class
       ) OR (
         eligibility.provider_class = 'VERIFIED_TRADE_BUSINESS'
         AND organization.provider_class = eligibility.provider_class
       )
     )
     AND task.state = 'OPEN'
     AND task.worker_id IS NULL
     AND task.work_order_id IS NULL
     AND task.universal_contract_version = 1
     AND task.automation_classification = 'CONTROLLED_TEST'
     AND task.universal_payment_posture = 'PAYMENT_CREATION_FROZEN'
     AND provider.account_status = 'ACTIVE'
     AND provider.is_minor IS FALSE
     AND COALESCE(provider.is_banned, FALSE) IS FALSE
     AND NOT (
       COALESCE(provider.trust_hold, FALSE)
       AND (provider.trust_hold_until IS NULL OR provider.trust_hold_until > database_now)
     )
     AND eligibility.profile_eligible IS TRUE
     AND eligibility.identity_eligible IS TRUE
     AND eligibility.category_eligible IS TRUE
     AND eligibility.credential_eligible IS TRUE
     AND eligibility.geography_eligible IS TRUE
     AND eligibility.availability_eligible IS TRUE
     AND eligibility.restriction_clear IS TRUE
     AND eligibility.task_eligible IS TRUE
     AND eligibility.processor_payment_eligible IS FALSE
     AND eligibility.payout_funding_eligible IS FALSE
     AND eligibility.evaluated_at <= database_now
     AND eligibility.valid_until > database_now
     AND public.universal_v1_invited_provider_authority_is_current(
       eligibility.provider_user_id,
       eligibility.provider_organization_id,
       eligibility.provider_class,
       eligibility.trade_credential_id,
       task.category,
       task.region_code
     )
     AND (
       (
         eligibility.provider_organization_id IS NULL
         AND eligibility.provider_user_id = actor_authority.resolved_user_id
       ) OR EXISTS (
         SELECT 1
           FROM public.business_memberships membership
          WHERE membership.organization_id = eligibility.provider_organization_id
            AND membership.user_id = actor_authority.resolved_user_id
            AND membership.status = 'ACTIVE'
            AND membership.role IN ('OWNER', 'ADMIN')
       )
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.task_provider_eligibility_decisions newer
        WHERE newer.task_draft_id = eligibility.task_draft_id
          AND newer.provider_user_id = eligibility.provider_user_id
          AND newer.provider_organization_id IS NOT DISTINCT FROM
                eligibility.provider_organization_id
          AND newer.decision_version > eligibility.decision_version
     )
   ORDER BY eligibility.decision_version DESC
   LIMIT 1
   FOR UPDATE OF task, draft, scope, route, predecessor_route, cell,
     materialization, estimate, eligibility, provider;

  IF current_authority.task_id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-12: current post-estimate provider authority is unavailable'
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM public.lock_universal_v1_estimate_authority(
    current_authority.task_draft_id,
    current_authority.provider_user_id,
    current_authority.provider_organization_id,
    current_authority.trade_credential_id,
    actor_authority.resolved_user_id
  );
  -- The first query locks every selected aggregate row.  The helper then locks
  -- profile, organization, membership, credential, and verified-trade rows.
  -- Re-read every mutable/phantom-sensitive predicate after those locks so a
  -- revoke that committed between the first read and the lock cannot win a
  -- stale command.
  database_now := pg_catalog.clock_timestamp();
  IF NOT EXISTS (
    SELECT 1
      FROM public.task_provider_eligibility_decisions eligibility
      JOIN public.tasks task ON task.id = current_authority.task_id
      JOIN public.task_drafts draft
        ON draft.id = current_authority.task_draft_id
       AND draft.task_id = task.id
      JOIN public.task_scope_versions scope
        ON scope.id = current_authority.scope_version_id
       AND scope.id = task.active_scope_version_id
      JOIN public.task_routing_decisions route
        ON route.id = current_authority.routing_decision_id
       AND route.id = draft.active_routing_decision_id
      JOIN public.universal_v1_service_cell_authorities cell
        ON cell.id = current_authority.service_cell_authority_id
       AND cell.id = route.service_cell_authority_id
      JOIN public.users provider ON provider.id = eligibility.provider_user_id
     WHERE eligibility.id = current_authority.predecessor_eligibility_id
       AND eligibility.task_draft_id = current_authority.task_draft_id
       AND eligibility.routing_decision_id = current_authority.predecessor_routing_decision_id
       AND eligibility.provider_user_id = current_authority.provider_user_id
       AND eligibility.provider_organization_id IS NOT DISTINCT FROM
             current_authority.provider_organization_id
       AND eligibility.provider_class = current_authority.provider_class
       AND eligibility.trade_credential_id IS NOT DISTINCT FROM
             current_authority.trade_credential_id
       AND eligibility.decision_version =
             current_authority.predecessor_eligibility_version
       AND eligibility.valid_until > database_now
       AND eligibility.profile_eligible IS TRUE
       AND eligibility.identity_eligible IS TRUE
       AND eligibility.category_eligible IS TRUE
       AND eligibility.credential_eligible IS TRUE
       AND eligibility.geography_eligible IS TRUE
       AND eligibility.availability_eligible IS TRUE
       AND eligibility.restriction_clear IS TRUE
       AND eligibility.task_eligible IS TRUE
       AND eligibility.processor_payment_eligible IS FALSE
       AND eligibility.payout_funding_eligible IS FALSE
       AND task.state = 'OPEN'
       AND task.worker_id IS NULL
       AND task.work_order_id IS NULL
       AND task.universal_contract_version = 1
       AND task.automation_classification = 'CONTROLLED_TEST'
       AND task.universal_payment_posture = 'PAYMENT_CREATION_FROZEN'
       AND route.outcome = 'FULFILLMENT_CANDIDATE'
       AND route.category_snapshot = task.category
       AND route.service_cell_snapshot = task.region_code
       AND cell.region_code = task.region_code
       AND cell.routing_availability = 'ACTIVE'
       AND cell.effective_from = current_authority.service_cell_effective_from
       AND cell.effective_from <= database_now
       AND cell.expires_at IS NOT DISTINCT FROM current_authority.service_cell_expires_at
       AND (cell.expires_at IS NULL OR cell.expires_at > database_now)
       AND NOT EXISTS (
         SELECT 1
           FROM public.universal_v1_service_cell_authorities successor
          WHERE successor.supersedes_authority_id = cell.id
       )
       AND provider.account_status = 'ACTIVE'
       AND provider.is_minor IS FALSE
       AND COALESCE(provider.is_banned, FALSE) IS FALSE
       AND public.universal_v1_invited_provider_authority_is_current(
         eligibility.provider_user_id,
         eligibility.provider_organization_id,
         eligibility.provider_class,
         eligibility.trade_credential_id,
         task.category,
         task.region_code
       )
       AND (
         (
           eligibility.provider_organization_id IS NULL
           AND eligibility.provider_user_id = actor_authority.resolved_user_id
         ) OR EXISTS (
           SELECT 1
             FROM public.business_memberships membership
            WHERE membership.organization_id = eligibility.provider_organization_id
              AND membership.user_id = actor_authority.resolved_user_id
              AND membership.status = 'ACTIVE'
              AND membership.role IN ('OWNER', 'ADMIN')
         )
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.task_provider_eligibility_decisions newer
          WHERE newer.task_draft_id = eligibility.task_draft_id
            AND newer.provider_user_id = eligibility.provider_user_id
            AND newer.provider_organization_id IS NOT DISTINCT FROM
                  eligibility.provider_organization_id
            AND newer.decision_version > eligibility.decision_version
       )
  ) THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-13: post-lock provider authority was revoked'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.task_applications (
    task_id,
    hustler_id,
    status,
    universal_contract_version,
    authority,
    provider_organization_id,
    interest_scope_version_id,
    idempotency_key,
    request_sha256
  ) VALUES (
    current_authority.task_id,
    current_authority.provider_user_id,
    'pending',
    1,
    'EXPRESS_INTEREST',
    current_authority.provider_organization_id,
    current_authority.scope_version_id,
    requested_idempotency_key,
    request_authority.canonical_request_sha256
  )
  RETURNING id INTO inserted_application_id;

  next_eligibility_version := current_authority.predecessor_eligibility_version + 1;
  INSERT INTO public.task_provider_eligibility_decisions (
    task_draft_id,
    task_id,
    scope_version_id,
    interest_application_id,
    routing_decision_id,
    decision_version,
    supersedes_decision_id,
    provider_user_id,
    provider_organization_id,
    provider_class,
    trade_credential_id,
    profile_eligible,
    identity_eligible,
    category_eligible,
    credential_eligible,
    geography_eligible,
    availability_eligible,
    restriction_clear,
    task_eligible,
    processor_payment_eligible,
    payout_funding_eligible,
    trust_tier,
    blocker_codes,
    policy_version,
    evidence,
    decided_by,
    idempotency_key,
    evaluated_at,
    valid_until
  ) VALUES (
    current_authority.task_draft_id,
    current_authority.task_id,
    current_authority.scope_version_id,
    inserted_application_id,
    current_authority.routing_decision_id,
    next_eligibility_version,
    current_authority.predecessor_eligibility_id,
    current_authority.provider_user_id,
    current_authority.provider_organization_id,
    current_authority.provider_class,
    current_authority.trade_credential_id,
    current_authority.profile_eligible,
    current_authority.identity_eligible,
    current_authority.category_eligible,
    current_authority.credential_eligible,
    current_authority.geography_eligible,
    current_authority.availability_eligible,
    current_authority.restriction_clear,
    current_authority.task_eligible,
    FALSE,
    FALSE,
    current_authority.trust_tier,
    current_authority.blocker_codes,
    'universal-v1-post-estimate-1.2.0',
    current_authority.evidence || pg_catalog.jsonb_build_object(
      'source_eligibility_id', current_authority.predecessor_eligibility_id,
      'source_policy_version', current_authority.policy_version,
      'post_estimate_scope_version_id', current_authority.scope_version_id,
      'post_estimate_routing_decision_id', current_authority.routing_decision_id,
      'payment_creation_frozen', TRUE,
      'payout_funding_frozen', TRUE,
      'final_availability_confirmation_required', TRUE,
      'interest_is_not_assignment', TRUE
    ),
    actor_authority.resolved_user_id,
    requested_idempotency_key || ':elig',
    database_now,
    LEAST(
      current_authority.predecessor_valid_until,
      database_now + INTERVAL '15 minutes'
    )
  )
  RETURNING id INTO inserted_eligibility_id;

  PERFORM hx_authority.record_universal_v1_work_order_command_execution_v1(
    request_authority.target_authority_id,
    actor_authority.assertion_id,
    'EXPRESS_POST_ESTIMATE_INTEREST',
    request_authority.canonical_request_sha256,
    actor_authority.resolved_user_id,
    NULL,
    requested_idempotency_key,
    requested_task_id,
    expected_scope_version,
    'RECORDED',
    pg_catalog.jsonb_build_object(
      'interest_application_id', inserted_application_id,
      'eligibility_decision_id', inserted_eligibility_id,
      'eligibility_version', next_eligibility_version
    )
  );
  RETURN QUERY SELECT
    inserted_application_id,
    inserted_eligibility_id,
    next_eligibility_version,
    FALSE,
    FALSE,
    FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.hxos_place_universal_v1_conditional_hold_v1(
  actor_assertion_token TEXT,
  requested_interest_application_id UUID,
  expected_eligibility_version INTEGER,
  requested_idempotency_key TEXT,
  client_timestamp TIMESTAMPTZ
)
RETURNS TABLE (
  conditional_hold_id UUID,
  expires_at TIMESTAMPTZ,
  replayed BOOLEAN,
  hard_assignment_created BOOLEAN,
  payment_creation_performed BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  database_now TIMESTAMPTZ;
  request_authority RECORD;
  actor_authority RECORD;
  current_authority RECORD;
  prior RECORD;
  inserted_hold RECORD;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')
       IS DISTINCT FROM 'serializable'
     OR pg_catalog.current_setting('transaction_read_only')::BOOLEAN IS TRUE THEN
    RAISE EXCEPTION
      'HXUV1-WOCMD-7: human Work Order commands require one writable SERIALIZABLE transaction'
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM hx_authority.assert_universal_v1_work_order_bootstrap_seal_v1();
  database_now := pg_catalog.clock_timestamp();
  IF requested_interest_application_id IS NULL
     OR expected_eligibility_version IS NULL OR expected_eligibility_version < 1
     OR requested_idempotency_key IS NULL
     OR requested_idempotency_key !~ '^[A-Za-z0-9:_-]{16,96}$'
     OR client_timestamp IS NULL
     OR client_timestamp IS DISTINCT FROM
          pg_catalog.date_trunc('milliseconds', client_timestamp)
     OR client_timestamp < database_now - INTERVAL '5 minutes'
     OR client_timestamp > database_now + INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-20: exact current conditional-hold command is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO STRICT request_authority
    FROM hx_authority.build_universal_v1_work_order_command_request_v1(
      'PLACE_CONDITIONAL_HOLD',
      pg_catalog.jsonb_build_object(
        'interest_application_id', requested_interest_application_id,
        'expected_eligibility_version', expected_eligibility_version,
        'idempotency_key', requested_idempotency_key,
        'client_timestamp_epoch_ms',
          pg_catalog.floor(EXTRACT(EPOCH FROM client_timestamp) * 1000)::BIGINT
      )
    );
  SELECT * INTO STRICT actor_authority
    FROM hx_authority.consume_universal_v1_actor_assertion_v1(
      actor_assertion_token,
      'PLACE_CONDITIONAL_HOLD',
      request_authority.canonical_request,
      request_authority.environment
    );

  -- Compare the complete actor-scoped command before the requested version is
  -- used to locate live authority. A changed replay must never be disguised as
  -- an unavailable eligibility row.
  IF EXISTS (
    SELECT 1
      FROM hx_authority.universal_v1_work_order_command_execution_facts execution
     WHERE execution.command_kind = 'PLACE_CONDITIONAL_HOLD'
       AND execution.actor_user_id = actor_authority.resolved_user_id
       AND execution.idempotency_key = requested_idempotency_key
       AND execution.result_kind IN ('RECORDED', 'REPLAYED')
       AND execution.canonical_request_sha256 IS DISTINCT FROM
             request_authority.canonical_request_sha256
  ) THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-21: conditional-hold idempotency payload changed'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT eligibility.id AS eligibility_decision_id,
         eligibility.decision_version AS eligibility_version,
         eligibility.valid_until AS eligibility_valid_until,
         eligibility.task_draft_id,
         eligibility.task_id,
         eligibility.scope_version_id,
         eligibility.routing_decision_id,
         eligibility.provider_user_id,
         eligibility.provider_organization_id,
         eligibility.provider_class,
         eligibility.trade_credential_id,
         application.id AS interest_application_id,
         task.poster_id
    INTO current_authority
    FROM public.task_provider_eligibility_decisions eligibility
    JOIN public.task_applications application
      ON application.id = eligibility.interest_application_id
    JOIN public.tasks task ON task.id = eligibility.task_id
    JOIN public.task_drafts draft ON draft.task_id = task.id
    JOIN public.task_scope_versions scope ON scope.id = task.active_scope_version_id
    JOIN public.task_routing_decisions route ON route.id = draft.active_routing_decision_id
    JOIN public.users poster ON poster.id = task.poster_id
    JOIN public.users provider ON provider.id = eligibility.provider_user_id
   WHERE application.id = requested_interest_application_id
     AND eligibility.decision_version = expected_eligibility_version
     AND task.poster_id = actor_authority.resolved_user_id
     AND task.state = 'OPEN'
     AND task.worker_id IS NULL
     AND task.work_order_id IS NULL
     AND task.universal_contract_version = 1
     AND task.automation_classification = 'CONTROLLED_TEST'
     AND task.universal_payment_posture = 'PAYMENT_CREATION_FROZEN'
     AND application.status = 'pending'
     AND scope.id = eligibility.scope_version_id
     AND route.id = eligibility.routing_decision_id
     AND poster.account_status = 'ACTIVE'
     AND poster.is_minor IS FALSE
     AND COALESCE(poster.is_banned, FALSE) IS FALSE
     AND provider.account_status = 'ACTIVE'
     AND provider.is_minor IS FALSE
     AND COALESCE(provider.is_banned, FALSE) IS FALSE
     AND eligibility.task_eligible IS TRUE
     AND eligibility.processor_payment_eligible IS FALSE
     AND eligibility.payout_funding_eligible IS FALSE
     AND eligibility.valid_until > database_now
     AND public.universal_v1_invited_provider_authority_is_current(
       eligibility.provider_user_id,
       eligibility.provider_organization_id,
       eligibility.provider_class,
       eligibility.trade_credential_id,
       task.category,
       task.region_code
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.task_provider_eligibility_decisions newer
        WHERE newer.task_draft_id = eligibility.task_draft_id
          AND newer.provider_user_id = eligibility.provider_user_id
          AND newer.provider_organization_id IS NOT DISTINCT FROM
                eligibility.provider_organization_id
          AND newer.decision_version > eligibility.decision_version
     )
   LIMIT 1
   FOR UPDATE OF eligibility, application, task, draft, scope, route, poster, provider;

  IF current_authority.eligibility_decision_id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-24: current conditional-hold authority is unavailable'
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hold:' || current_authority.task_id::TEXT, 0)
  );
  PERFORM public.lock_universal_v1_estimate_authority(
    current_authority.task_draft_id,
    current_authority.provider_user_id,
    current_authority.provider_organization_id,
    current_authority.trade_credential_id,
    actor_authority.resolved_user_id
  );
  database_now := pg_catalog.clock_timestamp();
  IF NOT EXISTS (
    SELECT 1
      FROM public.task_provider_eligibility_decisions eligibility
      JOIN public.task_applications application
        ON application.id = eligibility.interest_application_id
      JOIN public.tasks task ON task.id = eligibility.task_id
      JOIN public.users poster ON poster.id = task.poster_id
      JOIN public.users provider ON provider.id = eligibility.provider_user_id
     WHERE eligibility.id = current_authority.eligibility_decision_id
       AND eligibility.decision_version = current_authority.eligibility_version
       AND eligibility.task_draft_id = current_authority.task_draft_id
       AND eligibility.task_id = current_authority.task_id
       AND eligibility.scope_version_id = current_authority.scope_version_id
       AND eligibility.routing_decision_id = current_authority.routing_decision_id
       AND eligibility.provider_user_id = current_authority.provider_user_id
       AND eligibility.provider_organization_id IS NOT DISTINCT FROM
             current_authority.provider_organization_id
       AND eligibility.provider_class = current_authority.provider_class
       AND eligibility.trade_credential_id IS NOT DISTINCT FROM
             current_authority.trade_credential_id
       AND eligibility.task_eligible IS TRUE
       AND eligibility.processor_payment_eligible IS FALSE
       AND eligibility.payout_funding_eligible IS FALSE
       AND eligibility.valid_until > database_now
       AND application.id = current_authority.interest_application_id
       AND application.status = 'pending'
       AND task.poster_id = actor_authority.resolved_user_id
       AND task.state = 'OPEN'
       AND task.worker_id IS NULL
       AND task.work_order_id IS NULL
       AND task.universal_contract_version = 1
       AND task.automation_classification = 'CONTROLLED_TEST'
       AND task.universal_payment_posture = 'PAYMENT_CREATION_FROZEN'
       AND poster.id = actor_authority.resolved_user_id
       AND poster.account_status = 'ACTIVE'
       AND poster.is_minor IS FALSE
       AND COALESCE(poster.is_banned, FALSE) IS FALSE
       AND provider.account_status = 'ACTIVE'
       AND provider.is_minor IS FALSE
       AND COALESCE(provider.is_banned, FALSE) IS FALSE
       AND public.universal_v1_invited_provider_authority_is_current(
         eligibility.provider_user_id,
         eligibility.provider_organization_id,
         eligibility.provider_class,
         eligibility.trade_credential_id,
         task.category,
         task.region_code
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.task_provider_eligibility_decisions newer
          WHERE newer.task_draft_id = eligibility.task_draft_id
            AND newer.provider_user_id = eligibility.provider_user_id
            AND newer.provider_organization_id IS NOT DISTINCT FROM
                  eligibility.provider_organization_id
            AND newer.decision_version > eligibility.decision_version
       )
  ) THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-23: post-lock conditional-hold authority was revoked'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT reservation.id AS conditional_hold_id,
         reservation.expires_at,
         request.request_hash::TEXT AS request_hash
    INTO prior
    FROM public.task_reservation_requests request
    JOIN public.task_reservations reservation ON reservation.id = request.reservation_id
   WHERE request.idempotency_key = requested_idempotency_key
     AND request.task_id = current_authority.task_id
     AND request.hustler_id = current_authority.provider_user_id
     AND request.requested_by = actor_authority.resolved_user_id
   LIMIT 1
   FOR UPDATE OF reservation;
  IF prior.conditional_hold_id IS NOT NULL THEN
    IF prior.request_hash IS DISTINCT FROM request_authority.canonical_request_sha256 THEN
      RAISE EXCEPTION 'HXUV1-WOCMD-21: conditional-hold idempotency payload changed'
        USING ERRCODE = 'P0001';
    END IF;
    PERFORM hx_authority.record_universal_v1_work_order_command_execution_v1(
      request_authority.target_authority_id,
      actor_authority.assertion_id,
      'PLACE_CONDITIONAL_HOLD',
      request_authority.canonical_request_sha256,
      actor_authority.resolved_user_id,
      NULL,
      requested_idempotency_key,
      requested_interest_application_id,
      expected_eligibility_version,
      'REPLAYED',
      pg_catalog.jsonb_build_object(
        'conditional_hold_id', prior.conditional_hold_id,
        'expires_at', prior.expires_at
      )
    );
    RETURN QUERY SELECT
      prior.conditional_hold_id::UUID,
      prior.expires_at::TIMESTAMPTZ,
      TRUE,
      FALSE,
      FALSE;
    RETURN;
  END IF;

  UPDATE public.task_reservations reservation
     SET status = 'EXPIRED'
   WHERE reservation.task_id = current_authority.task_id
     AND reservation.universal_contract_version = 1
     AND reservation.status = 'ACTIVE'
     AND reservation.expires_at <= database_now;

  INSERT INTO public.task_reservations AS inserted_reservation (
    task_id,
    hustler_id,
    reserved_by,
    status,
    universal_contract_version,
    hold_kind,
    interest_application_id,
    eligibility_decision_id,
    expires_at
  ) VALUES (
    current_authority.task_id,
    current_authority.provider_user_id,
    actor_authority.resolved_user_id,
    'ACTIVE',
    1,
    'CONDITIONAL_HOLD',
    current_authority.interest_application_id,
    current_authority.eligibility_decision_id,
    LEAST(
      current_authority.eligibility_valid_until,
      database_now + INTERVAL '5 minutes'
    )
  )
  RETURNING inserted_reservation.id, inserted_reservation.expires_at INTO inserted_hold;

  INSERT INTO public.task_reservation_requests (
    reservation_id,
    idempotency_key,
    request_hash,
    task_id,
    hustler_id,
    requested_by
  ) VALUES (
    inserted_hold.id,
    requested_idempotency_key,
    request_authority.canonical_request_sha256,
    current_authority.task_id,
    current_authority.provider_user_id,
    actor_authority.resolved_user_id
  );

  PERFORM hx_authority.record_universal_v1_work_order_command_execution_v1(
    request_authority.target_authority_id,
    actor_authority.assertion_id,
    'PLACE_CONDITIONAL_HOLD',
    request_authority.canonical_request_sha256,
    actor_authority.resolved_user_id,
    NULL,
    requested_idempotency_key,
    requested_interest_application_id,
    expected_eligibility_version,
    'RECORDED',
    pg_catalog.jsonb_build_object(
      'conditional_hold_id', inserted_hold.id,
      'expires_at', inserted_hold.expires_at
    )
  );
  RETURN QUERY SELECT
    inserted_hold.id::UUID,
    inserted_hold.expires_at::TIMESTAMPTZ,
    FALSE,
    FALSE,
    FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.hxos_prepare_universal_v1_fake_work_order_v1(
  actor_assertion_token TEXT,
  requested_conditional_hold_id UUID,
  expected_eligibility_version INTEGER,
  requested_idempotency_key TEXT,
  client_timestamp TIMESTAMPTZ
)
RETURNS TABLE (
  completed BOOLEAN,
  work_order_id UUID,
  financial_security_event_id UUID,
  task_id UUID,
  task_draft_id UUID,
  scope_version_id UUID,
  scope_version INTEGER,
  routing_decision_id UUID,
  provider_user_id UUID,
  provider_organization_id UUID,
  provider_class TEXT,
  trade_credential_id UUID,
  predecessor_eligibility_id UUID,
  predecessor_eligibility_version INTEGER,
  predecessor_valid_until TIMESTAMPTZ,
  poster_user_id UUID,
  interest_application_id UUID,
  eligibility_decision_id UUID,
  eligibility_version INTEGER,
  eligibility_valid_until TIMESTAMPTZ,
  conditional_hold_id UUID,
  hold_reserved_at TIMESTAMPTZ,
  hold_expires_at TIMESTAMPTZ,
  provider_estimate_submission_id UUID,
  customer_total_cents BIGINT,
  currency TEXT,
  idempotency_key TEXT,
  request_sha256 TEXT,
  occurred_at TIMESTAMPTZ,
  replayed BOOLEAN,
  hard_assignment_created BOOLEAN,
  payment_creation_performed BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  database_now TIMESTAMPTZ;
  request_authority RECORD;
  actor_authority RECORD;
  requested_task_id UUID;
  prior RECORD;
  live RECORD;
  witness_sha256 TEXT;
  witness_preexisted BOOLEAN;
  nonproduction_bootstrap_ready BOOLEAN;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')
       IS DISTINCT FROM 'serializable'
     OR pg_catalog.current_setting('transaction_read_only')::BOOLEAN IS TRUE THEN
    RAISE EXCEPTION
      'HXUV1-WOCMD-7: human Work Order commands require one writable SERIALIZABLE transaction'
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM hx_authority.assert_universal_v1_work_order_bootstrap_seal_v1();
  IF pg_catalog.to_regclass(
       'public.universal_v1_fake_financial_lifecycle_bridges'
     ) IS NULL
     OR pg_catalog.to_regclass(
       'public.hxos_fake_financial_schema_evidence_v12'
     ) IS NULL THEN
    RAISE EXCEPTION
      'HXUV1-WOCMD-29: canonical nonproduction fake-financial v12 bootstrap is required for Work Order preparation'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT pg_catalog.count(*) = 1
    INTO nonproduction_bootstrap_ready
    FROM public.hxos_fake_financial_schema_evidence_v12 evidence
   WHERE evidence.migration_name =
           '20261015_universal_v1_work_order_fake_financial_authority_hardening_v12'
     AND pg_catalog.btrim(evidence.migration_sql_sha256) ~ '^[0-9a-f]{64}$'
     AND pg_catalog.btrim(evidence.migration_sql_sha256) <>
           pg_catalog.repeat('0', 64)
     AND pg_catalog.btrim(evidence.ordinal146_sql_sha256) ~ '^[0-9a-f]{64}$'
     AND pg_catalog.btrim(evidence.ordinal146_sql_sha256) <>
           pg_catalog.repeat('0', 64);
  IF nonproduction_bootstrap_ready IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION
      'HXUV1-WOCMD-29: exact v12 and ordinal146 checksum evidence is required for Work Order preparation'
      USING ERRCODE = 'P0001';
  END IF;
  database_now := pg_catalog.clock_timestamp();
  IF requested_conditional_hold_id IS NULL
     OR expected_eligibility_version IS NULL OR expected_eligibility_version < 1
     OR requested_idempotency_key IS NULL
     OR requested_idempotency_key !~ '^[A-Za-z0-9:_-]{16,96}$'
     OR client_timestamp IS NULL
     OR client_timestamp IS DISTINCT FROM
          pg_catalog.date_trunc('milliseconds', client_timestamp)
     OR client_timestamp < database_now - INTERVAL '5 minutes'
     OR client_timestamp > database_now + INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-30: exact current Work Order preparation command is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO STRICT request_authority
    FROM hx_authority.build_universal_v1_work_order_command_request_v1(
      'PREPARE_FAKE_WORK_ORDER',
      pg_catalog.jsonb_build_object(
        'conditional_hold_id', requested_conditional_hold_id,
        'expected_eligibility_version', expected_eligibility_version,
        'idempotency_key', requested_idempotency_key,
        'client_timestamp_epoch_ms',
          pg_catalog.floor(EXTRACT(EPOCH FROM client_timestamp) * 1000)::BIGINT
      )
    );
  SELECT * INTO STRICT actor_authority
    FROM hx_authority.consume_universal_v1_actor_assertion_v1(
      actor_assertion_token,
      'PREPARE_FAKE_WORK_ORDER',
      request_authority.canonical_request,
      request_authority.environment
    );

  SELECT reservation.task_id
    INTO requested_task_id
    FROM public.task_reservations reservation
   WHERE reservation.id = requested_conditional_hold_id;
  IF requested_task_id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-31: conditional hold is unavailable'
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('work-order:' || requested_task_id::TEXT, 0)
  );

  SELECT request.idempotency_key,
         request.request_sha256::TEXT AS request_sha256,
         request.canonical_command_request_sha256::TEXT AS canonical_command_request_sha256,
         request.actor_user_id,
         request.conditional_hold_id,
         request.task_id,
         request.eligibility_version,
         work_order.id AS work_order_id,
         work_order.financial_security_event_id
    INTO prior
    FROM public.task_work_order_command_requests request
    LEFT JOIN public.task_work_orders work_order
      ON work_order.idempotency_key = request.idempotency_key
   WHERE request.idempotency_key = requested_idempotency_key
      OR request.task_id = requested_task_id
      OR request.conditional_hold_id = requested_conditional_hold_id
   ORDER BY (request.idempotency_key = requested_idempotency_key) DESC
   LIMIT 1
   FOR UPDATE OF request;
  IF prior.idempotency_key IS NOT NULL AND (
    prior.idempotency_key IS DISTINCT FROM requested_idempotency_key
    OR prior.actor_user_id IS DISTINCT FROM actor_authority.resolved_user_id
    OR prior.task_id IS DISTINCT FROM requested_task_id
    OR prior.conditional_hold_id IS DISTINCT FROM requested_conditional_hold_id
    OR prior.eligibility_version IS DISTINCT FROM expected_eligibility_version
    OR prior.canonical_command_request_sha256 IS DISTINCT FROM
         request_authority.canonical_request_sha256
  ) THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-32: Work Order preparation idempotency context changed'
      USING ERRCODE = 'P0001';
  END IF;
  IF prior.work_order_id IS NOT NULL
     AND prior.financial_security_event_id IS NOT NULL THEN
    PERFORM hx_authority.record_universal_v1_work_order_command_execution_v1(
      request_authority.target_authority_id,
      actor_authority.assertion_id,
      'PREPARE_FAKE_WORK_ORDER',
      request_authority.canonical_request_sha256,
      actor_authority.resolved_user_id,
      NULL,
      requested_idempotency_key,
      requested_conditional_hold_id,
      expected_eligibility_version,
      'REPLAYED',
      pg_catalog.jsonb_build_object(
        'work_order_id', prior.work_order_id,
        'financial_security_event_id', prior.financial_security_event_id
      )
    );
    RETURN QUERY SELECT
      TRUE,
      prior.work_order_id::UUID,
      prior.financial_security_event_id::UUID,
      NULL::UUID, NULL::UUID, NULL::UUID, NULL::INTEGER, NULL::UUID,
      NULL::UUID, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::UUID,
      NULL::INTEGER, NULL::TIMESTAMPTZ, actor_authority.resolved_user_id::UUID,
      NULL::UUID, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ,
      requested_conditional_hold_id, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ,
      NULL::UUID, NULL::BIGINT, NULL::TEXT, requested_idempotency_key,
      prior.request_sha256::TEXT, NULL::TIMESTAMPTZ, TRUE, FALSE, FALSE;
    RETURN;
  END IF;

  SELECT task.id AS task_id,
         draft.id AS task_draft_id,
         scope.id AS scope_version_id,
         scope.version AS scope_version,
         route.id AS routing_decision_id,
         estimate.provider_user_id,
         estimate.provider_organization_id,
         eligibility.provider_class,
         eligibility.trade_credential_id,
         eligibility.id AS predecessor_eligibility_id,
         eligibility.decision_version AS predecessor_eligibility_version,
         eligibility.valid_until AS predecessor_valid_until,
         task.poster_id AS poster_user_id,
         application.id AS interest_application_id,
         eligibility.id AS eligibility_decision_id,
         eligibility.decision_version AS eligibility_version,
         eligibility.valid_until AS eligibility_valid_until,
         reservation.id AS conditional_hold_id,
         reservation.reserved_at AS hold_reserved_at,
         reservation.expires_at AS hold_expires_at,
         materialization.provider_estimate_submission_id,
         scope.customer_total_cents,
         scope.currency::TEXT AS currency
    INTO live
    FROM public.tasks task
    JOIN public.task_drafts draft ON draft.task_id = task.id
    JOIN public.task_scope_versions scope ON scope.id = task.active_scope_version_id
    JOIN public.task_routing_decisions route ON route.id = draft.active_routing_decision_id
    JOIN public.task_estimate_acceptance_materializations materialization
      ON materialization.task_id = task.id
     AND materialization.scope_version_id = scope.id
    JOIN public.provider_estimate_submissions estimate
      ON estimate.id = materialization.provider_estimate_submission_id
    JOIN public.task_reservations reservation
      ON reservation.id = requested_conditional_hold_id
    JOIN public.task_provider_eligibility_decisions eligibility
      ON eligibility.id = reservation.eligibility_decision_id
    JOIN public.task_applications application
      ON application.id = eligibility.interest_application_id
    JOIN public.users poster ON poster.id = task.poster_id
    JOIN public.users provider ON provider.id = eligibility.provider_user_id
   WHERE task.id = requested_task_id
     AND eligibility.decision_version = expected_eligibility_version
     AND task.poster_id = actor_authority.resolved_user_id
     AND task.state = 'OPEN'
     AND task.universal_contract_version = 1
     AND task.automation_classification = 'CONTROLLED_TEST'
     AND task.universal_payment_posture = 'PAYMENT_CREATION_FROZEN'
     AND task.worker_id IS NULL
     AND task.work_order_id IS NULL
     AND poster.account_status = 'ACTIVE'
     AND poster.is_minor IS FALSE
     AND COALESCE(poster.is_banned, FALSE) IS FALSE
     AND provider.account_status = 'ACTIVE'
     AND provider.is_minor IS FALSE
     AND COALESCE(provider.is_banned, FALSE) IS FALSE
     AND route.outcome = 'FULFILLMENT_CANDIDATE'
     AND eligibility.task_eligible IS TRUE
     AND eligibility.processor_payment_eligible IS FALSE
     AND eligibility.payout_funding_eligible IS FALSE
     AND eligibility.valid_until > database_now
     AND application.status = 'pending'
     AND reservation.status = 'ACTIVE'
     AND reservation.expires_at > database_now
     AND public.universal_v1_invited_provider_authority_is_current(
       eligibility.provider_user_id,
       eligibility.provider_organization_id,
       eligibility.provider_class,
       eligibility.trade_credential_id,
       task.category,
       task.region_code
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.task_provider_eligibility_decisions newer
        WHERE newer.task_draft_id = eligibility.task_draft_id
          AND newer.provider_user_id = eligibility.provider_user_id
          AND newer.provider_organization_id IS NOT DISTINCT FROM
                eligibility.provider_organization_id
          AND newer.decision_version > eligibility.decision_version
     )
   LIMIT 1
   FOR UPDATE OF task, draft, scope, route, materialization, estimate,
     eligibility, application, reservation, poster, provider;
  IF live.task_id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-33: current Work Order preparation authority is unavailable'
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM public.lock_universal_v1_estimate_authority(
    live.task_draft_id,
    live.provider_user_id,
    live.provider_organization_id,
    live.trade_credential_id,
    actor_authority.resolved_user_id
  );
  database_now := pg_catalog.clock_timestamp();
  IF NOT EXISTS (
    SELECT 1
      FROM public.task_provider_eligibility_decisions eligibility
      JOIN public.task_applications application
        ON application.id = eligibility.interest_application_id
      JOIN public.task_reservations reservation
        ON reservation.eligibility_decision_id = eligibility.id
      JOIN public.tasks task ON task.id = eligibility.task_id
      JOIN public.task_drafts draft ON draft.id = eligibility.task_draft_id
      JOIN public.task_scope_versions scope ON scope.id = eligibility.scope_version_id
      JOIN public.task_routing_decisions route ON route.id = eligibility.routing_decision_id
      JOIN public.users poster ON poster.id = task.poster_id
      JOIN public.users provider ON provider.id = eligibility.provider_user_id
     WHERE eligibility.id = live.eligibility_decision_id
       AND eligibility.decision_version = live.eligibility_version
       AND eligibility.task_draft_id = live.task_draft_id
       AND eligibility.task_id = live.task_id
       AND eligibility.scope_version_id = live.scope_version_id
       AND eligibility.routing_decision_id = live.routing_decision_id
       AND eligibility.provider_user_id = live.provider_user_id
       AND eligibility.provider_organization_id IS NOT DISTINCT FROM
             live.provider_organization_id
       AND eligibility.provider_class = live.provider_class
       AND eligibility.trade_credential_id IS NOT DISTINCT FROM
             live.trade_credential_id
       AND eligibility.task_eligible IS TRUE
       AND eligibility.processor_payment_eligible IS FALSE
       AND eligibility.payout_funding_eligible IS FALSE
       AND eligibility.valid_until > database_now
       AND application.id = live.interest_application_id
       AND application.status = 'pending'
       AND reservation.id = live.conditional_hold_id
       AND reservation.status = 'ACTIVE'
       AND reservation.expires_at > database_now
       AND draft.task_id = task.id
       AND draft.active_routing_decision_id = route.id
       AND scope.id = task.active_scope_version_id
       AND route.outcome = 'FULFILLMENT_CANDIDATE'
       AND task.poster_id = actor_authority.resolved_user_id
       AND task.state = 'OPEN'
       AND task.worker_id IS NULL
       AND task.work_order_id IS NULL
       AND task.universal_contract_version = 1
       AND task.automation_classification = 'CONTROLLED_TEST'
       AND task.universal_payment_posture = 'PAYMENT_CREATION_FROZEN'
       AND poster.id = actor_authority.resolved_user_id
       AND poster.account_status = 'ACTIVE'
       AND poster.is_minor IS FALSE
       AND COALESCE(poster.is_banned, FALSE) IS FALSE
       AND provider.account_status = 'ACTIVE'
       AND provider.is_minor IS FALSE
       AND COALESCE(provider.is_banned, FALSE) IS FALSE
       AND public.universal_v1_invited_provider_authority_is_current(
         eligibility.provider_user_id,
         eligibility.provider_organization_id,
         eligibility.provider_class,
         eligibility.trade_credential_id,
         task.category,
         task.region_code
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.task_provider_eligibility_decisions newer
          WHERE newer.task_draft_id = eligibility.task_draft_id
            AND newer.provider_user_id = eligibility.provider_user_id
            AND newer.provider_organization_id IS NOT DISTINCT FROM
                  eligibility.provider_organization_id
            AND newer.decision_version > eligibility.decision_version
       )
  ) THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-34: post-lock Work Order preparation authority was revoked'
      USING ERRCODE = 'P0001';
  END IF;

  witness_sha256 := pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(
      pg_catalog.jsonb_build_object(
        'actor', actor_authority.resolved_user_id,
        'hold', live.conditional_hold_id,
        'task', live.task_id,
        'draft', live.task_draft_id,
        'estimate', live.provider_estimate_submission_id,
        'route', live.routing_decision_id,
        'scope', live.scope_version_id,
        'provider', live.provider_user_id,
        'organization', live.provider_organization_id,
        'eligibility', live.eligibility_decision_id,
        'eligibility_version', live.eligibility_version,
        'amount', live.customer_total_cents,
        'currency', live.currency
      )::TEXT,
      'UTF8'
    )
  ), 'hex');
  witness_preexisted := prior.idempotency_key IS NOT NULL;
  IF witness_preexisted AND prior.request_sha256 IS DISTINCT FROM witness_sha256 THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-32: Work Order preparation witness changed'
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT witness_preexisted THEN
    INSERT INTO public.task_work_order_command_requests (
      idempotency_key,
      request_sha256,
      canonical_command_request_sha256,
      actor_user_id,
      conditional_hold_id,
      task_id,
      task_draft_id,
      provider_estimate_submission_id,
      routing_decision_id,
      scope_version_id,
      provider_user_id,
      provider_organization_id,
      eligibility_decision_id,
      eligibility_version,
      amount_cents,
      currency
    ) VALUES (
      requested_idempotency_key,
      witness_sha256,
      request_authority.canonical_request_sha256,
      actor_authority.resolved_user_id,
      live.conditional_hold_id,
      live.task_id,
      live.task_draft_id,
      live.provider_estimate_submission_id,
      live.routing_decision_id,
      live.scope_version_id,
      live.provider_user_id,
      live.provider_organization_id,
      live.eligibility_decision_id,
      live.eligibility_version,
      live.customer_total_cents,
      live.currency
    );
  END IF;

  PERFORM hx_authority.record_universal_v1_work_order_command_execution_v1(
    request_authority.target_authority_id,
    actor_authority.assertion_id,
    'PREPARE_FAKE_WORK_ORDER',
    request_authority.canonical_request_sha256,
    actor_authority.resolved_user_id,
    NULL,
    requested_idempotency_key,
    requested_conditional_hold_id,
    expected_eligibility_version,
    CASE WHEN witness_preexisted THEN 'REPLAYED' ELSE 'RECORDED' END,
    pg_catalog.jsonb_build_object(
      'task_id', live.task_id,
      'request_sha256', witness_sha256,
      'witness_preexisted', witness_preexisted
    )
  );
  RETURN QUERY SELECT
    FALSE,
    NULL::UUID,
    NULL::UUID,
    live.task_id::UUID,
    live.task_draft_id::UUID,
    live.scope_version_id::UUID,
    live.scope_version::INTEGER,
    live.routing_decision_id::UUID,
    live.provider_user_id::UUID,
    live.provider_organization_id::UUID,
    live.provider_class::TEXT,
    live.trade_credential_id::UUID,
    live.predecessor_eligibility_id::UUID,
    live.predecessor_eligibility_version::INTEGER,
    live.predecessor_valid_until::TIMESTAMPTZ,
    live.poster_user_id::UUID,
    live.interest_application_id::UUID,
    live.eligibility_decision_id::UUID,
    live.eligibility_version::INTEGER,
    live.eligibility_valid_until::TIMESTAMPTZ,
    live.conditional_hold_id::UUID,
    live.hold_reserved_at::TIMESTAMPTZ,
    live.hold_expires_at::TIMESTAMPTZ,
    live.provider_estimate_submission_id::UUID,
    live.customer_total_cents::BIGINT,
    live.currency::TEXT,
    requested_idempotency_key,
    witness_sha256,
    live.hold_reserved_at::TIMESTAMPTZ,
    witness_preexisted,
    FALSE,
    FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.hxos_materialize_universal_v1_fake_work_order_v1(
  actor_assertion_token TEXT,
  requested_idempotency_key TEXT,
  expected_request_sha256 TEXT,
  secured_event_id UUID
)
RETURNS TABLE (
  work_order_id UUID,
  financial_security_event_id UUID,
  replayed BOOLEAN,
  hard_assignment_created BOOLEAN,
  payment_creation_performed BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  request_authority RECORD;
  actor_authority RECORD;
  witness RECORD;
  current_authority RECORD;
  secured_is_exact BOOLEAN;
  inserted_work_order RECORD;
  execution_idempotency_key TEXT;
  released_count INTEGER;
  closed_count INTEGER;
  assigned_worker_id UUID;
  nonproduction_bootstrap_ready BOOLEAN;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')
       IS DISTINCT FROM 'serializable'
     OR pg_catalog.current_setting('transaction_read_only')::BOOLEAN IS TRUE THEN
    RAISE EXCEPTION
      'HXUV1-WOCMD-7: human Work Order commands require one writable SERIALIZABLE transaction'
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM hx_authority.assert_universal_v1_work_order_bootstrap_seal_v1();
  IF pg_catalog.to_regclass(
       'public.universal_v1_fake_financial_lifecycle_bridges'
     ) IS NULL
     OR pg_catalog.to_regclass(
       'public.hxos_fake_financial_schema_evidence_v12'
     ) IS NULL THEN
    RAISE EXCEPTION
      'HXUV1-WOCMD-39: canonical nonproduction fake-financial bootstrap is required for Work Order materialization'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT pg_catalog.count(*) = 1
    INTO nonproduction_bootstrap_ready
    FROM public.hxos_fake_financial_schema_evidence_v12 evidence
   WHERE evidence.migration_name =
           '20261015_universal_v1_work_order_fake_financial_authority_hardening_v12'
     AND pg_catalog.btrim(evidence.migration_sql_sha256) ~ '^[0-9a-f]{64}$'
     AND pg_catalog.btrim(evidence.migration_sql_sha256) <>
           pg_catalog.repeat('0', 64)
     AND pg_catalog.btrim(evidence.ordinal146_sql_sha256) ~ '^[0-9a-f]{64}$'
     AND pg_catalog.btrim(evidence.ordinal146_sql_sha256) <>
           pg_catalog.repeat('0', 64);
  IF nonproduction_bootstrap_ready IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION
      'HXUV1-WOCMD-39: exact v12 and ordinal146 checksum evidence is required for Work Order materialization'
      USING ERRCODE = 'P0001';
  END IF;
  IF requested_idempotency_key IS NULL
     OR requested_idempotency_key !~ '^[A-Za-z0-9:_-]{16,96}$'
     OR expected_request_sha256 IS NULL
     OR expected_request_sha256 !~ '^[0-9a-f]{64}$'
     OR expected_request_sha256 = pg_catalog.repeat('0', 64)
     OR secured_event_id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-40: exact Work Order materialization witness is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO STRICT request_authority
    FROM hx_authority.build_universal_v1_work_order_command_request_v1(
      'MATERIALIZE_FAKE_WORK_ORDER',
      pg_catalog.jsonb_build_object(
        'idempotency_key', requested_idempotency_key,
        'request_sha256', expected_request_sha256,
        'secured_event_id', secured_event_id
      )
    );
  SELECT * INTO STRICT actor_authority
    FROM hx_authority.consume_universal_v1_actor_assertion_v1(
      actor_assertion_token,
      'MATERIALIZE_FAKE_WORK_ORDER',
      request_authority.canonical_request,
      request_authority.environment
    );

  SELECT request.idempotency_key,
         request.request_sha256::TEXT AS request_sha256,
         request.actor_user_id,
         request.task_id,
         request.task_draft_id,
         request.scope_version_id,
         request.routing_decision_id,
         request.provider_estimate_submission_id,
         request.provider_user_id,
         request.provider_organization_id,
         request.eligibility_decision_id,
         request.eligibility_version,
         request.conditional_hold_id,
         request.amount_cents,
         request.currency::TEXT AS currency,
         existing.id AS work_order_id,
         existing.financial_security_event_id
    INTO witness
    FROM public.task_work_order_command_requests request
    LEFT JOIN public.task_work_orders existing
      ON existing.idempotency_key = request.idempotency_key
   WHERE request.idempotency_key = requested_idempotency_key
   FOR UPDATE OF request;
  IF witness.idempotency_key IS NULL
     OR witness.request_sha256 IS DISTINCT FROM expected_request_sha256
     OR witness.actor_user_id IS DISTINCT FROM actor_authority.resolved_user_id THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-41: exact actor-bound Work Order witness changed'
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('work-order:' || witness.task_id::TEXT, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'hxuv1-financial-security-task:' || witness.task_id::TEXT,
      0
    )
  );

  IF witness.work_order_id IS NOT NULL THEN
    IF witness.financial_security_event_id IS DISTINCT FROM secured_event_id THEN
      RAISE EXCEPTION 'HXUV1-WOCMD-42: completed Work Order financial witness changed'
        USING ERRCODE = 'P0001';
    END IF;
    PERFORM hx_authority.record_universal_v1_work_order_command_execution_v1(
      request_authority.target_authority_id,
      actor_authority.assertion_id,
      'MATERIALIZE_FAKE_WORK_ORDER',
      request_authority.canonical_request_sha256,
      actor_authority.resolved_user_id,
      NULL,
      requested_idempotency_key,
      witness.task_id,
      witness.eligibility_version,
      'REPLAYED',
      pg_catalog.jsonb_build_object(
        'work_order_id', witness.work_order_id,
        'financial_security_event_id', witness.financial_security_event_id
      )
    );
    RETURN QUERY SELECT
      witness.work_order_id::UUID,
      witness.financial_security_event_id::UUID,
      TRUE,
      FALSE,
      FALSE;
    RETURN;
  END IF;

  SELECT task.id AS task_id,
         draft.id AS task_draft_id,
         scope.id AS scope_version_id,
         route.id AS routing_decision_id,
         materialization.provider_estimate_submission_id,
         application.id AS interest_application_id,
         eligibility.id AS eligibility_decision_id,
         eligibility.decision_version AS eligibility_version,
         reservation.id AS conditional_hold_id,
         estimate.provider_user_id,
         estimate.provider_organization_id,
         eligibility.provider_class,
         eligibility.trade_credential_id,
         task.poster_id AS poster_user_id,
         scope.customer_total_cents,
         scope.currency::TEXT AS currency
    INTO current_authority
    FROM public.tasks task
    JOIN public.task_drafts draft ON draft.id = witness.task_draft_id
                                 AND draft.task_id = task.id
    JOIN public.task_scope_versions scope ON scope.id = witness.scope_version_id
                                         AND scope.id = task.active_scope_version_id
    JOIN public.task_routing_decisions route ON route.id = witness.routing_decision_id
                                            AND route.id = draft.active_routing_decision_id
    JOIN public.task_estimate_acceptance_materializations materialization
      ON materialization.task_id = task.id
     AND materialization.task_draft_id = draft.id
     AND materialization.scope_version_id = scope.id
     AND materialization.provider_estimate_submission_id =
           witness.provider_estimate_submission_id
    JOIN public.provider_estimate_submissions estimate
      ON estimate.id = materialization.provider_estimate_submission_id
     AND estimate.provider_user_id = witness.provider_user_id
     AND estimate.provider_organization_id IS NOT DISTINCT FROM
           witness.provider_organization_id
    JOIN public.task_provider_eligibility_decisions eligibility
      ON eligibility.id = witness.eligibility_decision_id
     AND eligibility.decision_version = witness.eligibility_version
     AND eligibility.task_id = task.id
     AND eligibility.scope_version_id = scope.id
     AND eligibility.routing_decision_id = route.id
     AND eligibility.provider_user_id = witness.provider_user_id
     AND eligibility.provider_organization_id IS NOT DISTINCT FROM
           witness.provider_organization_id
    JOIN public.task_applications application
      ON application.id = eligibility.interest_application_id
    JOIN public.task_reservations reservation
      ON reservation.id = witness.conditional_hold_id
     AND reservation.eligibility_decision_id = eligibility.id
    JOIN public.users poster ON poster.id = task.poster_id
    JOIN public.users provider ON provider.id = eligibility.provider_user_id
   WHERE task.id = witness.task_id
     AND task.poster_id = actor_authority.resolved_user_id
     AND task.state = 'OPEN'
     AND task.universal_contract_version = 1
     AND task.automation_classification = 'CONTROLLED_TEST'
     AND task.universal_payment_posture = 'PAYMENT_CREATION_FROZEN'
     AND task.worker_id IS NULL
     AND task.work_order_id IS NULL
     AND poster.account_status = 'ACTIVE'
     AND poster.is_minor IS FALSE
     AND COALESCE(poster.is_banned, FALSE) IS FALSE
     AND provider.account_status = 'ACTIVE'
     AND provider.is_minor IS FALSE
     AND COALESCE(provider.is_banned, FALSE) IS FALSE
     AND route.outcome = 'FULFILLMENT_CANDIDATE'
     AND application.status = 'pending'
     AND reservation.status = 'ACTIVE'
     AND reservation.expires_at > pg_catalog.clock_timestamp()
     AND eligibility.task_eligible IS TRUE
     AND eligibility.processor_payment_eligible IS FALSE
     AND eligibility.payout_funding_eligible IS FALSE
     AND eligibility.valid_until > pg_catalog.clock_timestamp()
     AND scope.customer_total_cents = witness.amount_cents
     AND scope.currency = witness.currency
     AND public.universal_v1_invited_provider_authority_is_current(
       eligibility.provider_user_id,
       eligibility.provider_organization_id,
       eligibility.provider_class,
       eligibility.trade_credential_id,
       task.category,
       task.region_code
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.task_provider_eligibility_decisions newer
        WHERE newer.task_draft_id = eligibility.task_draft_id
          AND newer.provider_user_id = eligibility.provider_user_id
          AND newer.provider_organization_id IS NOT DISTINCT FROM
                eligibility.provider_organization_id
          AND newer.decision_version > eligibility.decision_version
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.universal_v1_work_order_compensation_commands compensation
        WHERE compensation.task_id = task.id
     )
   LIMIT 1
   FOR UPDATE OF task, draft, scope, route, materialization, estimate,
     eligibility, application, reservation, poster, provider;
  IF current_authority.task_id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-43: current Work Order materialization authority is unavailable'
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM public.lock_universal_v1_estimate_authority(
    current_authority.task_draft_id,
    current_authority.provider_user_id,
    current_authority.provider_organization_id,
    current_authority.trade_credential_id,
    actor_authority.resolved_user_id
  );
  IF NOT EXISTS (
    SELECT 1
      FROM public.task_provider_eligibility_decisions eligibility
      JOIN public.task_applications application
        ON application.id = eligibility.interest_application_id
      JOIN public.task_reservations reservation
        ON reservation.eligibility_decision_id = eligibility.id
      JOIN public.tasks task ON task.id = eligibility.task_id
      JOIN public.task_drafts draft ON draft.id = eligibility.task_draft_id
      JOIN public.task_scope_versions scope ON scope.id = eligibility.scope_version_id
      JOIN public.task_routing_decisions route ON route.id = eligibility.routing_decision_id
      JOIN public.users poster ON poster.id = task.poster_id
      JOIN public.users provider ON provider.id = eligibility.provider_user_id
     WHERE eligibility.id = current_authority.eligibility_decision_id
       AND eligibility.decision_version = current_authority.eligibility_version
       AND eligibility.task_draft_id = current_authority.task_draft_id
       AND eligibility.task_id = current_authority.task_id
       AND eligibility.scope_version_id = current_authority.scope_version_id
       AND eligibility.routing_decision_id = current_authority.routing_decision_id
       AND eligibility.provider_user_id = current_authority.provider_user_id
       AND eligibility.provider_organization_id IS NOT DISTINCT FROM
             current_authority.provider_organization_id
       AND eligibility.provider_class = current_authority.provider_class
       AND eligibility.trade_credential_id IS NOT DISTINCT FROM
             current_authority.trade_credential_id
       AND eligibility.task_eligible IS TRUE
       AND eligibility.processor_payment_eligible IS FALSE
       AND eligibility.payout_funding_eligible IS FALSE
       AND eligibility.valid_until > pg_catalog.clock_timestamp()
       AND application.id = current_authority.interest_application_id
       AND application.status = 'pending'
       AND reservation.id = current_authority.conditional_hold_id
       AND reservation.status = 'ACTIVE'
       AND reservation.expires_at > pg_catalog.clock_timestamp()
       AND draft.task_id = task.id
       AND draft.active_routing_decision_id = route.id
       AND scope.id = task.active_scope_version_id
       AND route.outcome = 'FULFILLMENT_CANDIDATE'
       AND task.poster_id = actor_authority.resolved_user_id
       AND task.state = 'OPEN'
       AND task.worker_id IS NULL
       AND task.work_order_id IS NULL
       AND task.universal_contract_version = 1
       AND task.automation_classification = 'CONTROLLED_TEST'
       AND task.universal_payment_posture = 'PAYMENT_CREATION_FROZEN'
       AND poster.id = actor_authority.resolved_user_id
       AND poster.account_status = 'ACTIVE'
       AND poster.is_minor IS FALSE
       AND COALESCE(poster.is_banned, FALSE) IS FALSE
       AND provider.account_status = 'ACTIVE'
       AND provider.is_minor IS FALSE
       AND COALESCE(provider.is_banned, FALSE) IS FALSE
       AND scope.customer_total_cents = witness.amount_cents
       AND scope.currency = witness.currency
       AND public.universal_v1_invited_provider_authority_is_current(
         eligibility.provider_user_id,
         eligibility.provider_organization_id,
         eligibility.provider_class,
         eligibility.trade_credential_id,
         task.category,
         task.region_code
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.task_provider_eligibility_decisions newer
          WHERE newer.task_draft_id = eligibility.task_draft_id
            AND newer.provider_user_id = eligibility.provider_user_id
            AND newer.provider_organization_id IS NOT DISTINCT FROM
                  eligibility.provider_organization_id
            AND newer.decision_version > eligibility.decision_version
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.universal_v1_work_order_compensation_commands compensation
          WHERE compensation.task_id = task.id
       )
  ) THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-48: post-lock Work Order materialization authority was revoked'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT EXISTS(
    SELECT 1
      FROM public.universal_v1_fake_financial_lifecycle_bridges bridge
      JOIN public.task_financial_security_events event
        ON event.id = bridge.task_financial_security_event_id
      JOIN public.financial_provider_command_journal command
        ON command.command_id = bridge.command_id
      JOIN public.financial_provider_command_outcome_facts outcome
        ON outcome.outcome_fact_id = bridge.outcome_fact_id
     WHERE bridge.task_financial_security_event_id = secured_event_id
       AND bridge.fake_operation_id =
           public.universal_v1_work_order_operation_id_v1(
             requested_idempotency_key,
             'secure'
           )
       AND bridge.fake_operation_kind = 'SECURE'
       AND bridge.fake_provider_state = 'SUCCEEDED'
       AND bridge.lifecycle_event_kind = 'SECURED'
       AND bridge.lifecycle_status = 'SUCCEEDED'
       AND bridge.lifecycle_expected_version = 2
       AND bridge.task_draft_id = witness.task_draft_id
       AND bridge.task_id = witness.task_id
       AND bridge.eligibility_decision_id = witness.eligibility_decision_id
       AND bridge.scope_version_id = witness.scope_version_id
       AND bridge.amount_cents = witness.amount_cents
       AND bridge.currency = witness.currency
       AND command.operation_id = bridge.fake_operation_id
       AND command.operation_kind = 'SECURE'
       AND command.provider_kind = 'FAKE'
       AND command.provider_expected_version = 0
       AND outcome.command_id = command.command_id
       AND outcome.outcome_kind = 'OUTCOME_OBSERVED'
       AND outcome.provider_state = 'SUCCEEDED'
       AND outcome.retryable IS FALSE
       AND event.operation_id = bridge.fake_operation_id::TEXT
       AND event.event_kind = 'SECURED'
       AND event.status = 'SUCCEEDED'
       AND event.provider_kind = 'FAKE'
       AND event.evidence->>'providerState' = 'SUCCEEDED'
       AND event.expected_version = 2
       AND event.task_draft_id = witness.task_draft_id
       AND event.task_id = witness.task_id
       AND event.eligibility_decision_id = witness.eligibility_decision_id
       AND event.scope_version_id = witness.scope_version_id
       AND event.amount_cents = witness.amount_cents
       AND event.currency = witness.currency
       AND outcome.provider_state = event.evidence->>'providerState'
       AND outcome.provider_result_version =
             (event.evidence->>'providerOperationVersion')::INTEGER
       AND NOT EXISTS (
         SELECT 1
           FROM public.task_financial_security_events successor
          WHERE successor.task_draft_id = event.task_draft_id
            AND successor.expected_version > event.expected_version
       )
  ) INTO secured_is_exact;
  IF NOT secured_is_exact THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-44: exact successful fake SECURE evidence is unavailable'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_catalog.set_config(
    'hustlexp.work_order_command_sha256',
    expected_request_sha256,
    TRUE
  );
  INSERT INTO public.task_work_orders (
    task_draft_id,
    task_id,
    scope_version_id,
    routing_decision_id,
    provider_estimate_submission_id,
    interest_application_id,
    eligibility_decision_id,
    conditional_hold_id,
    financial_security_event_id,
    provider_user_id,
    provider_organization_id,
    materialization_version,
    idempotency_key,
    materialized_by,
    execution_contract_version
  ) VALUES (
    current_authority.task_draft_id,
    current_authority.task_id,
    current_authority.scope_version_id,
    current_authority.routing_decision_id,
    current_authority.provider_estimate_submission_id,
    current_authority.interest_application_id,
    current_authority.eligibility_decision_id,
    current_authority.conditional_hold_id,
    secured_event_id,
    current_authority.provider_user_id,
    current_authority.provider_organization_id,
    1,
    requested_idempotency_key,
    actor_authority.resolved_user_id,
    1
  )
  RETURNING id, materialized_at INTO inserted_work_order;

  execution_idempotency_key := requested_idempotency_key || ':execution:materialized';
  INSERT INTO public.task_work_order_execution_facts (
    work_order_id,
    task_id,
    scope_version_id,
    execution_version,
    supersedes_fact_id,
    state,
    transition_kind,
    completion_fact_id,
    work_order_amendment_id,
    actor_role,
    actor_user_id,
    reason,
    idempotency_key,
    request_sha256,
    client_occurred_at,
    policy_version,
    recorded_at
  )
  SELECT work_order.id,
         work_order.task_id,
         work_order.scope_version_id,
         1,
         NULL,
         'MATERIALIZED',
         'MATERIALIZED',
         NULL,
         NULL,
         'CUSTOMER',
         work_order.materialized_by,
         NULL,
         execution_idempotency_key,
         public.universal_v1_execution_internal_request_sha256(
           work_order.materialized_by,
           work_order.id,
           'MATERIALIZED',
           'MATERIALIZED',
           0,
           work_order.scope_version_id,
           NULL,
           NULL,
           execution_idempotency_key,
           work_order.materialized_at,
           NULL
         ),
         work_order.materialized_at,
         'universal-v1-work-order-execution-1.0.0',
         work_order.materialized_at
    FROM public.task_work_orders work_order
   WHERE work_order.id = inserted_work_order.id;

  UPDATE public.task_reservations reservation
     SET status = 'RELEASED'
   WHERE reservation.id = current_authority.conditional_hold_id
     AND reservation.status = 'ACTIVE';
  GET DIAGNOSTICS released_count = ROW_COUNT;
  IF released_count <> 1 THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-45: conditional hold was not released exactly once'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.task_applications application
     SET status = 'expired'
   WHERE application.id = current_authority.interest_application_id
     AND application.status = 'pending';
  GET DIAGNOSTICS closed_count = ROW_COUNT;
  IF closed_count <> 1 THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-46: provider interest was not closed exactly once'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT task.worker_id INTO assigned_worker_id
    FROM public.tasks task
   WHERE task.id = current_authority.task_id;
  IF assigned_worker_id IS NOT NULL THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-47: hard assignment is forbidden'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM hx_authority.record_universal_v1_work_order_command_execution_v1(
    request_authority.target_authority_id,
    actor_authority.assertion_id,
    'MATERIALIZE_FAKE_WORK_ORDER',
    request_authority.canonical_request_sha256,
    actor_authority.resolved_user_id,
    NULL,
    requested_idempotency_key,
    current_authority.task_id,
    current_authority.eligibility_version,
    'COMPLETED',
    pg_catalog.jsonb_build_object(
      'work_order_id', inserted_work_order.id,
      'financial_security_event_id', secured_event_id
    )
  );
  RETURN QUERY SELECT
    inserted_work_order.id::UUID,
    secured_event_id,
    FALSE,
    FALSE,
    FALSE;
END;
$$;

-- Migration SQL never creates roles or distributes credentials. The exact
-- eight-role ownership and grants are provisioned separately and certified by
-- live catalog readback. These revocations make every object fail closed until
-- that explicit provisioning occurs.
REVOKE ALL ON TABLE
  public.hxos_universal_v1_work_order_target_activation_barrier_v1,
  hx_authority.universal_v1_work_order_target_authority_facts,
  hx_authority.universal_v1_work_order_command_execution_facts
FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE
  public.hxos_universal_v1_work_order_target_activation_barrier_v1,
  public.tasks,
  public.task_drafts,
  public.task_scope_versions,
  public.task_routing_decisions,
  public.universal_v1_service_cell_authorities,
  public.task_estimate_acceptance_materializations,
  public.provider_estimate_submissions,
  public.users,
  public.task_work_order_command_requests,
  public.task_provider_eligibility_decisions,
  public.task_work_orders,
  public.task_work_order_execution_facts,
  public.task_reservations,
  public.task_reservation_requests,
  public.task_applications,
  public.universal_v1_work_order_compensation_commands,
  hx_authority.universal_v1_work_order_target_authority_facts,
  hx_authority.universal_v1_work_order_command_execution_facts
FROM PUBLIC;

REVOKE ALL ON FUNCTION
  hx_authority.reject_universal_v1_work_order_authority_mutation_v1()
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  hx_authority.validate_universal_v1_work_order_target_activation_v1()
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  hx_authority.read_universal_v1_work_order_target_authority_v1()
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  hx_authority.build_universal_v1_work_order_command_request_v1(TEXT, JSONB)
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  hx_authority.record_universal_v1_work_order_command_execution_v1(
    UUID, UUID, TEXT, TEXT, UUID, TEXT, TEXT, UUID, INTEGER, TEXT, JSONB
  )
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.hxos_express_universal_v1_post_estimate_interest_v1(
    TEXT, UUID, INTEGER, TEXT, TIMESTAMPTZ
  )
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.hxos_place_universal_v1_conditional_hold_v1(
    TEXT, UUID, INTEGER, TEXT, TIMESTAMPTZ
  )
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.hxos_prepare_universal_v1_fake_work_order_v1(
    TEXT, UUID, INTEGER, TEXT, TIMESTAMPTZ
  )
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.hxos_materialize_universal_v1_fake_work_order_v1(TEXT, TEXT, TEXT, UUID)
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.hxos_request_universal_v1_fake_work_order_recovery_v1(TEXT, TEXT, TEXT, UUID)
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.hxos_claim_universal_v1_work_order_compensation_v2(INTEGER, INTEGER)
FROM PUBLIC;

DO $$
DECLARE
  expected_functions TEXT[] := ARRAY[
    'public.hxos_express_universal_v1_post_estimate_interest_v1(text,uuid,integer,text,timestamp with time zone)',
    'public.hxos_place_universal_v1_conditional_hold_v1(text,uuid,integer,text,timestamp with time zone)',
    'public.hxos_prepare_universal_v1_fake_work_order_v1(text,uuid,integer,text,timestamp with time zone)',
    'public.hxos_materialize_universal_v1_fake_work_order_v1(text,text,text,uuid)',
    'public.hxos_request_universal_v1_fake_work_order_recovery_v1(text,text,text,uuid)',
    'public.hxos_claim_universal_v1_work_order_compensation_v2(integer,integer)'
  ]::TEXT[];
  function_identity TEXT;
  command_owner_count INTEGER;
BEGIN
  FOREACH function_identity IN ARRAY expected_functions LOOP
    IF pg_catalog.to_regprocedure(function_identity) IS NULL THEN
      RAISE EXCEPTION 'HXUV1-WOCMD-70: required command function is absent: %', function_identity
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc function_state
     WHERE function_state.oid = ANY (
       ARRAY(
         SELECT pg_catalog.to_regprocedure(identity)::OID
           FROM pg_catalog.unnest(expected_functions) AS identities(identity)
       )
     )
       AND (
         function_state.prosecdef IS FALSE
         OR function_state.provolatile <> 'v'
         OR function_state.proparallel <> 'u'
         OR function_state.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::TEXT[]
       )
  ) THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-71: command functions are not exactly sealed'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT pg_catalog.count(DISTINCT function_state.proowner)::INTEGER
    INTO command_owner_count
    FROM pg_catalog.pg_proc function_state
   WHERE function_state.oid = ANY (
     ARRAY(
       SELECT pg_catalog.to_regprocedure(identity)::OID
         FROM pg_catalog.unnest(expected_functions) AS identities(identity)
     )
   );
  IF command_owner_count <> 1 THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-72: sealed command functions require one exact owner'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc function_state
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_state.proacl,
          pg_catalog.acldefault('f', function_state.proowner)
        )
      ) privilege
     WHERE function_state.oid = ANY (
       ARRAY(
         SELECT pg_catalog.to_regprocedure(identity)::OID
           FROM pg_catalog.unnest(expected_functions) AS identities(identity)
       )
     )
       AND privilege.grantee = 0
       AND privilege.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'HXUV1-WOCMD-73: PUBLIC command execution is forbidden'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

COMMENT ON TABLE hx_authority.universal_v1_work_order_target_authority_facts IS
  'Append-only isolated-target authority. Every command binds the exact current database, local/preview/staging environment, and lowercase nonzero release-manifest SHA-256.';
COMMENT ON TABLE public.hxos_universal_v1_work_order_target_activation_barrier_v1 IS
  'Empty target-activation snapshot barrier. Runtime takes ACCESS SHARE before its first snapshot; activation takes ACCESS EXCLUSIVE before target/advisory authority.';
COMMENT ON TABLE hx_authority.universal_v1_work_order_command_execution_facts IS
  'Append-only exact-target command evidence. It records neither hard assignment nor payment creation capability.';
COMMENT ON FUNCTION public.hxos_claim_universal_v1_work_order_compensation_v2(
  INTEGER,
  INTEGER
) IS
  'Sealed bounded fake-only worker recovery port. No real provider, payment, assignment, deployment, or production capability.';
