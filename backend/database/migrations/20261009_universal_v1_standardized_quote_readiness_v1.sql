-- HustleXP Universal V1 standardized-scope quote and fake-readiness facts.
--
-- This successor closes only the pre-Task standardized-scope seam. It records
-- an immutable deterministic quote, the owning Poster's acceptance, and a
-- nonproduction FAKE payment-method-readiness observation. The shared database
-- role can only preserve an application-measured release witness; it cannot
-- authenticate the signed manifest independently. None of these facts
-- is a Financial Security Event, authorization, capture, assignment,
-- reservation, Work Order, address grant, payable, payout, or settlement.
-- The six held Work Order command relations are deliberately not referenced.
-- Release evidence posture: APPLICATION_MEASURED_DB_WITNESS_ONLY.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

CREATE TABLE IF NOT EXISTS public.universal_v1_service_cell_price_book_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_cell_authority_id UUID NOT NULL
    REFERENCES public.universal_v1_service_cell_authorities(id) ON DELETE RESTRICT,
  service_cell_authority_version INTEGER NOT NULL CHECK (
    service_cell_authority_version > 0
  ),
  price_book_id UUID NOT NULL
    REFERENCES public.price_book(id) ON DELETE RESTRICT,
  price_book_policy_version TEXT NOT NULL CHECK (
    price_book_policy_version = 'hxos-price-book-v1'
  ),
  environment_class TEXT NOT NULL CHECK (
    environment_class IN ('local', 'preview', 'staging')
  ),
  mapping_version INTEGER NOT NULL CHECK (mapping_version = 1),
  evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  evidence_sha256 CHAR(64) NOT NULL CHECK (
    evidence_sha256 ~ '^[a-f0-9]{64}$'
    AND btrim(evidence_sha256) = encode(public.digest(evidence::TEXT, 'sha256'), 'hex')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (
    service_cell_authority_id,
    service_cell_authority_version,
    price_book_id,
    price_book_policy_version,
    environment_class,
    mapping_version
  )
);

CREATE TABLE IF NOT EXISTS public.task_draft_standardized_quote_versions (
  id UUID PRIMARY KEY,
  task_draft_id UUID NOT NULL
    REFERENCES public.task_drafts(id) ON DELETE RESTRICT,
  routing_decision_id UUID NOT NULL
    REFERENCES public.task_routing_decisions(id) ON DELETE RESTRICT,
  routing_decision_version INTEGER NOT NULL CHECK (routing_decision_version > 0),
  relationship_origin_id UUID NOT NULL
    REFERENCES public.universal_v1_relationship_origins(id) ON DELETE RESTRICT,
  relationship_origin_version INTEGER NOT NULL CHECK (relationship_origin_version > 0),
  service_cell_authority_id UUID NOT NULL
    REFERENCES public.universal_v1_service_cell_authorities(id) ON DELETE RESTRICT,
  service_cell_authority_version INTEGER NOT NULL CHECK (service_cell_authority_version > 0),
  quote_version INTEGER NOT NULL CHECK (quote_version > 0),
  expected_quote_version INTEGER NOT NULL CHECK (expected_quote_version >= 0),
  supersedes_quote_version_id UUID
    REFERENCES public.task_draft_standardized_quote_versions(id) ON DELETE RESTRICT,
  quote_kind TEXT NOT NULL CHECK (quote_kind = 'STANDARDIZED_SCOPE_FIXED_PRICE'),
  scope_artifact_kind TEXT NOT NULL CHECK (
    scope_artifact_kind = 'TASK_DRAFT_STANDARDIZED_SCOPE_V1'
  ),
  scope_artifact_id UUID NOT NULL,
  scope_artifact_version INTEGER NOT NULL CHECK (scope_artifact_version > 0),
  work_category_code TEXT NOT NULL CHECK (
    work_category_code ~ '^[a-z0-9][a-z0-9_-]{1,99}$'
  ),
  region_code TEXT NOT NULL CHECK (region_code ~ '^US-[A-Z]{2}$'),
  rough_location TEXT NOT NULL CHECK (
    char_length(btrim(rough_location)) BETWEEN 2 AND 120
  ),
  risk_level TEXT NOT NULL CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH', 'IN_HOME')),
  requires_proof BOOLEAN NOT NULL CHECK (requires_proof IS TRUE),
  scope_snapshot JSONB NOT NULL CHECK (jsonb_typeof(scope_snapshot) = 'object'),
  scope_sha256 CHAR(64) NOT NULL CHECK (
    scope_sha256 ~ '^[a-f0-9]{64}$'
    AND btrim(scope_sha256) = encode(public.digest(scope_snapshot::TEXT, 'sha256'), 'hex')
  ),
  price_book_id UUID NOT NULL
    REFERENCES public.price_book(id) ON DELETE RESTRICT,
  price_book_mapping_id UUID NOT NULL
    REFERENCES public.universal_v1_service_cell_price_book_mappings(id)
      ON DELETE RESTRICT,
  pricing_policy_version TEXT NOT NULL CHECK (
    char_length(btrim(pricing_policy_version)) BETWEEN 3 AND 128
  ),
  pricing_snapshot JSONB NOT NULL CHECK (jsonb_typeof(pricing_snapshot) = 'object'),
  pricing_sha256 CHAR(64) NOT NULL CHECK (
    pricing_sha256 ~ '^[a-f0-9]{64}$'
    AND btrim(pricing_sha256) = encode(public.digest(pricing_snapshot::TEXT, 'sha256'), 'hex')
  ),
  quote_evidence_sha256 CHAR(64) NOT NULL CHECK (
    quote_evidence_sha256 ~ '^[a-f0-9]{64}$'
  ),
  customer_total_cents INTEGER NOT NULL CHECK (customer_total_cents > 0),
  provider_payout_cents INTEGER NOT NULL CHECK (provider_payout_cents > 0),
  platform_margin_cents INTEGER NOT NULL CHECK (platform_margin_cents >= 0),
  currency TEXT NOT NULL CHECK (currency = 'usd'),
  decision_authority TEXT NOT NULL CHECK (decision_authority = 'DETERMINISTIC_POLICY'),
  payment_posture TEXT NOT NULL CHECK (payment_posture = 'PAYMENT_CREATION_FROZEN'),
  environment_class TEXT NOT NULL CHECK (
    environment_class IN ('local', 'preview', 'staging')
  ),
  requested_by_user_id UUID NOT NULL
    REFERENCES public.users(id) ON DELETE RESTRICT,
  issuance_build_commit_sha CHAR(40) NOT NULL CHECK (
    issuance_build_commit_sha ~ '^[a-f0-9]{40}$'
  ),
  issuance_release_manifest_digest TEXT NOT NULL CHECK (
    issuance_release_manifest_digest ~ '^sha256:[a-f0-9]{64}$'
  ),
  issuance_capability_policy_digest TEXT NOT NULL CHECK (
    issuance_capability_policy_digest ~ '^sha256:[a-f0-9]{64}$'
  ),
  issuance_evidence_sha256 CHAR(64) NOT NULL CHECK (
    issuance_evidence_sha256 ~ '^[a-f0-9]{64}$'
  ),
  idempotency_key TEXT NOT NULL CHECK (
    idempotency_key ~ '^[A-Za-z0-9:_-]{16,96}$'
  ),
  request_sha256 CHAR(64) NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  client_timestamp_ms BIGINT NOT NULL CHECK (client_timestamp_ms > 0),
  valid_until TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (task_draft_id, quote_version),
  UNIQUE (supersedes_quote_version_id),
  UNIQUE (requested_by_user_id, idempotency_key),
  CHECK (customer_total_cents = provider_payout_cents + platform_margin_cents),
  CHECK (quote_version = expected_quote_version + 1),
  CHECK (scope_artifact_id = id),
  CHECK (scope_artifact_version = quote_version),
  CHECK (
    (quote_version = 1 AND supersedes_quote_version_id IS NULL)
    OR (quote_version > 1 AND supersedes_quote_version_id IS NOT NULL)
  ),
  CHECK (valid_until > created_at)
);

CREATE INDEX IF NOT EXISTS task_draft_standardized_quote_versions_current_idx
  ON public.task_draft_standardized_quote_versions(task_draft_id, quote_version DESC);

CREATE TABLE IF NOT EXISTS public.task_draft_standardized_quote_acceptance_facts (
  id UUID PRIMARY KEY,
  task_draft_id UUID NOT NULL
    REFERENCES public.task_drafts(id) ON DELETE RESTRICT,
  quote_version_id UUID NOT NULL UNIQUE
    REFERENCES public.task_draft_standardized_quote_versions(id) ON DELETE RESTRICT,
  quote_version INTEGER NOT NULL CHECK (quote_version > 0),
  expected_quote_version INTEGER NOT NULL CHECK (expected_quote_version > 0),
  routing_decision_id UUID NOT NULL
    REFERENCES public.task_routing_decisions(id) ON DELETE RESTRICT,
  routing_decision_version INTEGER NOT NULL CHECK (routing_decision_version > 0),
  scope_artifact_kind TEXT NOT NULL CHECK (
    scope_artifact_kind = 'TASK_DRAFT_STANDARDIZED_SCOPE_V1'
  ),
  scope_artifact_id UUID NOT NULL,
  scope_artifact_version INTEGER NOT NULL CHECK (scope_artifact_version > 0),
  scope_sha256 CHAR(64) NOT NULL CHECK (scope_sha256 ~ '^[a-f0-9]{64}$'),
  pricing_sha256 CHAR(64) NOT NULL CHECK (pricing_sha256 ~ '^[a-f0-9]{64}$'),
  quote_evidence_sha256 CHAR(64) NOT NULL CHECK (
    quote_evidence_sha256 ~ '^[a-f0-9]{64}$'
  ),
  customer_total_cents INTEGER NOT NULL CHECK (customer_total_cents > 0),
  currency TEXT NOT NULL CHECK (currency = 'usd'),
  acceptance_version INTEGER NOT NULL CHECK (acceptance_version = 1),
  expected_acceptance_version INTEGER NOT NULL CHECK (expected_acceptance_version = 0),
  accepted_by_user_id UUID NOT NULL
    REFERENCES public.users(id) ON DELETE RESTRICT,
  environment_class TEXT NOT NULL CHECK (
    environment_class IN ('local', 'preview', 'staging')
  ),
  command_build_commit_sha CHAR(40) NOT NULL CHECK (
    command_build_commit_sha ~ '^[a-f0-9]{40}$'
  ),
  command_release_manifest_digest TEXT NOT NULL CHECK (
    command_release_manifest_digest ~ '^sha256:[a-f0-9]{64}$'
  ),
  command_capability_policy_digest TEXT NOT NULL CHECK (
    command_capability_policy_digest ~ '^sha256:[a-f0-9]{64}$'
  ),
  command_evidence_sha256 CHAR(64) NOT NULL CHECK (
    command_evidence_sha256 ~ '^[a-f0-9]{64}$'
  ),
  idempotency_key TEXT NOT NULL CHECK (
    idempotency_key ~ '^[A-Za-z0-9:_-]{16,96}$'
  ),
  request_sha256 CHAR(64) NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  client_timestamp_ms BIGINT NOT NULL CHECK (client_timestamp_ms > 0),
  payment_creation_created BOOLEAN NOT NULL DEFAULT FALSE
    CHECK (payment_creation_created IS FALSE),
  financial_security_event_created BOOLEAN NOT NULL DEFAULT FALSE
    CHECK (financial_security_event_created IS FALSE),
  task_created BOOLEAN NOT NULL DEFAULT FALSE CHECK (task_created IS FALSE),
  assignment_created BOOLEAN NOT NULL DEFAULT FALSE CHECK (assignment_created IS FALSE),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (task_draft_id),
  UNIQUE (accepted_by_user_id, idempotency_key),
  CHECK (quote_version = expected_quote_version),
  CHECK (scope_artifact_id = quote_version_id),
  CHECK (scope_artifact_version = quote_version)
);

CREATE TABLE IF NOT EXISTS public.task_draft_payment_method_readiness_facts (
  id UUID PRIMARY KEY,
  task_draft_id UUID NOT NULL
    REFERENCES public.task_drafts(id) ON DELETE RESTRICT,
  acceptance_fact_id UUID NOT NULL
    REFERENCES public.task_draft_standardized_quote_acceptance_facts(id) ON DELETE RESTRICT,
  quote_version_id UUID NOT NULL
    REFERENCES public.task_draft_standardized_quote_versions(id) ON DELETE RESTRICT,
  quote_version INTEGER NOT NULL CHECK (quote_version > 0),
  expected_quote_version INTEGER NOT NULL CHECK (expected_quote_version > 0),
  readiness_version INTEGER NOT NULL CHECK (readiness_version > 0),
  expected_readiness_version INTEGER NOT NULL CHECK (expected_readiness_version >= 0),
  supersedes_readiness_fact_id UUID
    REFERENCES public.task_draft_payment_method_readiness_facts(id) ON DELETE RESTRICT,
  provider_kind TEXT NOT NULL CHECK (provider_kind = 'FAKE'),
  environment_class TEXT NOT NULL CHECK (
    environment_class IN ('local', 'preview', 'staging')
  ),
  prepared_by_user_id UUID NOT NULL
    REFERENCES public.users(id) ON DELETE RESTRICT,
  fake_provider_operation_id UUID NOT NULL UNIQUE,
  opaque_reference_sha256 CHAR(64) NOT NULL CHECK (
    opaque_reference_sha256 ~ '^[a-f0-9]{64}$'
  ),
  command_build_commit_sha CHAR(40) NOT NULL CHECK (
    command_build_commit_sha ~ '^[a-f0-9]{40}$'
  ),
  command_release_manifest_digest TEXT NOT NULL CHECK (
    command_release_manifest_digest ~ '^sha256:[a-f0-9]{64}$'
  ),
  command_capability_policy_digest TEXT NOT NULL CHECK (
    command_capability_policy_digest ~ '^sha256:[a-f0-9]{64}$'
  ),
  command_evidence_sha256 CHAR(64) NOT NULL CHECK (
    command_evidence_sha256 ~ '^[a-f0-9]{64}$'
  ),
  idempotency_key TEXT NOT NULL CHECK (
    idempotency_key ~ '^[A-Za-z0-9:_-]{16,96}$'
  ),
  request_sha256 CHAR(64) NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  client_timestamp_ms BIGINT NOT NULL CHECK (client_timestamp_ms > 0),
  payment_method_prepared BOOLEAN NOT NULL DEFAULT TRUE
    CHECK (payment_method_prepared IS TRUE),
  external_provider_called BOOLEAN NOT NULL DEFAULT FALSE
    CHECK (external_provider_called IS FALSE),
  customer_money_created BOOLEAN NOT NULL DEFAULT FALSE
    CHECK (customer_money_created IS FALSE),
  authorization_created BOOLEAN NOT NULL DEFAULT FALSE
    CHECK (authorization_created IS FALSE),
  financial_security_event_created BOOLEAN NOT NULL DEFAULT FALSE
    CHECK (financial_security_event_created IS FALSE),
  capture_created BOOLEAN NOT NULL DEFAULT FALSE CHECK (capture_created IS FALSE),
  assignment_created BOOLEAN NOT NULL DEFAULT FALSE CHECK (assignment_created IS FALSE),
  work_order_created BOOLEAN NOT NULL DEFAULT FALSE CHECK (work_order_created IS FALSE),
  settlement_created BOOLEAN NOT NULL DEFAULT FALSE CHECK (settlement_created IS FALSE),
  payout_created BOOLEAN NOT NULL DEFAULT FALSE CHECK (payout_created IS FALSE),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (task_draft_id, readiness_version),
  UNIQUE (supersedes_readiness_fact_id),
  UNIQUE (prepared_by_user_id, idempotency_key),
  CHECK (quote_version = expected_quote_version),
  CHECK (readiness_version = expected_readiness_version + 1),
  CHECK (
    (readiness_version = 1 AND supersedes_readiness_fact_id IS NULL)
    OR (readiness_version > 1 AND supersedes_readiness_fact_id IS NOT NULL)
  ),
  CHECK (expires_at > created_at)
);

CREATE OR REPLACE FUNCTION public.universal_v1_standardized_quote_request_sha256(
  p_actor_user_id UUID,
  p_task_draft_id UUID,
  p_expected_routing_decision_version INTEGER,
  p_expected_quote_version INTEGER,
  p_idempotency_key TEXT,
  p_client_timestamp_ms BIGINT
)
RETURNS CHAR(64)
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT encode(public.digest(concat_ws('|',
    'HX_UNIVERSAL_V1_STANDARDIZED_QUOTE_PREPARE_V1',
    p_actor_user_id::TEXT, p_task_draft_id::TEXT,
    p_expected_routing_decision_version::TEXT,
    p_expected_quote_version::TEXT, p_idempotency_key,
    p_client_timestamp_ms::TEXT
  ), 'sha256'), 'hex')::CHAR(64)
$$;

CREATE OR REPLACE FUNCTION public.universal_v1_standardized_quote_acceptance_request_sha256(
  p_actor_user_id UUID,
  p_task_draft_id UUID,
  p_quote_version_id UUID,
  p_expected_routing_decision_version INTEGER,
  p_expected_quote_version INTEGER,
  p_expected_acceptance_version INTEGER,
  p_idempotency_key TEXT,
  p_client_timestamp_ms BIGINT
)
RETURNS CHAR(64)
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT encode(public.digest(concat_ws('|',
    'HX_UNIVERSAL_V1_STANDARDIZED_QUOTE_ACCEPT_V1',
    p_actor_user_id::TEXT, p_task_draft_id::TEXT, p_quote_version_id::TEXT,
    p_expected_routing_decision_version::TEXT,
    p_expected_quote_version::TEXT, p_expected_acceptance_version::TEXT,
    p_idempotency_key, p_client_timestamp_ms::TEXT
  ), 'sha256'), 'hex')::CHAR(64)
$$;

CREATE OR REPLACE FUNCTION public.universal_v1_fake_payment_readiness_request_sha256(
  p_actor_user_id UUID,
  p_task_draft_id UUID,
  p_acceptance_fact_id UUID,
  p_expected_quote_version INTEGER,
  p_expected_readiness_version INTEGER,
  p_idempotency_key TEXT,
  p_client_timestamp_ms BIGINT,
  p_opaque_reference_sha256 CHAR(64)
)
RETURNS CHAR(64)
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT encode(public.digest(concat_ws('|',
    'HX_UNIVERSAL_V1_FAKE_PAYMENT_METHOD_READINESS_V1',
    p_actor_user_id::TEXT, p_task_draft_id::TEXT, p_acceptance_fact_id::TEXT,
    p_expected_quote_version::TEXT, p_expected_readiness_version::TEXT,
    p_idempotency_key, p_client_timestamp_ms::TEXT,
    p_opaque_reference_sha256::TEXT
  ), 'sha256'), 'hex')::CHAR(64)
$$;

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_standardized_quote_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  draft public.task_drafts%ROWTYPE;
  route public.task_routing_decisions%ROWTYPE;
  origin public.universal_v1_relationship_origins%ROWTYPE;
  cell public.universal_v1_service_cell_authorities%ROWTYPE;
  pricing public.price_book%ROWTYPE;
  pricing_mapping public.universal_v1_service_cell_price_book_mappings%ROWTYPE;
  predecessor public.task_draft_standardized_quote_versions%ROWTYPE;
  expected_request_sha256 CHAR(64);
  margin_floor_bps INTEGER;
  computed_provider_payout_cents INTEGER;
  standardized_pricing_policy_version TEXT;
BEGIN
  SELECT * INTO draft
  FROM public.task_drafts candidate
  WHERE candidate.id = NEW.task_draft_id
  FOR SHARE;
  IF NOT FOUND
     OR draft.universal_contract_version <> 1
     OR draft.ingress_origin <> 'BACKEND_POSTGRESQL'
     OR draft.status <> 'account_claimed'
     OR draft.poster_user_id IS DISTINCT FROM NEW.requested_by_user_id
     OR draft.task_id IS NOT NULL
     OR draft.relationship_origin_contract_version <> 1
     OR draft.relationship_origin_kind <> 'MARKETPLACE'
     OR draft.relationship_origin_policy_version <> 1
     OR char_length(btrim(COALESCE(draft.scope_summary, ''))) < 3
     OR jsonb_typeof(draft.structured -> 'answers') IS DISTINCT FROM 'object'
     OR jsonb_typeof(draft.structured -> 'missing_questions') IS DISTINCT FROM 'array'
     OR jsonb_array_length(draft.structured -> 'missing_questions') IS DISTINCT FROM 0
     OR draft.structured ->> 'scope_parser' IS DISTINCT FROM 'UNIVERSAL_V1_SERVER'
     OR draft.structured ->> 'scope_policy_version' IS DISTINCT FROM 'task_scope_v1' THEN
    RAISE EXCEPTION 'HXUV1-STDQUOTE-1: exact owned open canonical TaskDraft is required'
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.users actor
    WHERE actor.id = NEW.requested_by_user_id
      AND actor.default_mode = 'poster'
      AND actor.account_status = 'ACTIVE'
      AND actor.is_minor IS FALSE
      AND COALESCE(actor.is_banned, FALSE) IS FALSE
  ) THEN
    RAISE EXCEPTION 'HXUV1-STDQUOTE-2: active adult Poster identity is required'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO route
  FROM public.task_routing_decisions candidate
  WHERE candidate.id = draft.active_routing_decision_id
    AND candidate.task_draft_id = draft.id
  FOR SHARE;
  IF NOT FOUND
     OR route.id IS DISTINCT FROM NEW.routing_decision_id
     OR route.decision_version <> NEW.routing_decision_version THEN
    RAISE EXCEPTION 'HXUV1-STDQUOTE-3: exact active routing decision changed'
      USING ERRCODE = 'P0001';
  END IF;
  IF route.decision_version <> NEW.routing_decision_version
     OR route.outcome <> 'FULFILLMENT_CANDIDATE'
     OR route.category_snapshot NOT IN ('moving', 'furniture_assembly')
     OR route.policy_version <> 'universal-v1-intake-1.2.0' THEN
    RAISE EXCEPTION 'HXUV1-STDQUOTE-3: standardized quote requires current fulfillment route'
      USING ERRCODE = 'P0001';
  END IF;

  -- Provider-visible quote scope is a typed allowlist, not a text sanitizer.
  -- Free-form TaskDraft answers stay customer-side even when ingress has
  -- already sanitized them. Every retained answer is required to match its
  -- exact server-owned type/domain before any quote fact can be inserted.
  IF route.category_snapshot = 'moving' AND (
    EXISTS (
      SELECT 1
      FROM jsonb_object_keys(
        CASE WHEN jsonb_typeof(draft.structured -> 'answers') = 'object'
          THEN draft.structured -> 'answers'
          ELSE '{}'::JSONB
        END
      ) answer_key
      WHERE answer_key NOT IN (
        'size_weight', 'access', 'move_type', 'workers_needed', 'fragile',
        'timing', 'scope_confirmed_at'
      )
    )
    OR jsonb_typeof(draft.structured #> '{answers,size_weight}') IS DISTINCT FROM 'string'
    OR draft.structured #>> '{answers,size_weight}' IS DISTINCT FROM 'light'
    OR jsonb_typeof(draft.structured #> '{answers,access}') IS DISTINCT FROM 'string'
    OR draft.structured #>> '{answers,access}' IS DISTINCT FROM 'ground'
    OR jsonb_typeof(draft.structured #> '{answers,move_type}') IS DISTINCT FROM 'string'
    OR draft.structured #>> '{answers,move_type}' IS DISTINCT FROM 'same'
    OR jsonb_typeof(draft.structured #> '{answers,workers_needed}') IS DISTINCT FROM 'string'
    OR draft.structured #>> '{answers,workers_needed}' IS DISTINCT FROM 'one'
    OR draft.structured #> '{answers,fragile}' IS DISTINCT FROM 'false'::JSONB
  ) THEN
    RAISE EXCEPTION 'HXUV1-STDQUOTE-18: retained moving answer is outside typed allowlist'
      USING ERRCODE = 'P0001';
  ELSIF route.category_snapshot = 'furniture_assembly' AND (
    EXISTS (
      SELECT 1
      FROM jsonb_object_keys(
        CASE WHEN jsonb_typeof(draft.structured -> 'answers') = 'object'
          THEN draft.structured -> 'answers'
          ELSE '{}'::JSONB
        END
      ) answer_key
      WHERE answer_key NOT IN (
        'assembly_scope_class', 'item_count_class', 'item', 'product_link',
        'new_in_box', 'tools_included', 'old_item_removal', 'timing',
        'access', 'item_dimensions', 'assembly_options', 'scope_confirmed_at'
      )
    )
    OR jsonb_typeof(draft.structured #> '{answers,assembly_scope_class}')
      IS DISTINCT FROM 'string'
    OR draft.structured #>> '{answers,assembly_scope_class}'
      IS DISTINCT FROM 'STANDARD_SINGLE_FLAT_PACK_ITEM_V1'
    OR jsonb_typeof(draft.structured #> '{answers,item_count_class}')
      IS DISTINCT FROM 'string'
    OR draft.structured #>> '{answers,item_count_class}' IS DISTINCT FROM 'one'
    OR draft.structured #> '{answers,new_in_box}' IS DISTINCT FROM 'true'::JSONB
    OR draft.structured #> '{answers,tools_included}' IS DISTINCT FROM 'true'::JSONB
    OR draft.structured #> '{answers,old_item_removal}' IS DISTINCT FROM 'false'::JSONB
  ) THEN
    RAISE EXCEPTION 'HXUV1-STDQUOTE-18: retained furniture answer is outside typed allowlist'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO origin
  FROM public.universal_v1_relationship_origins candidate
  WHERE candidate.task_draft_id = draft.id
  ORDER BY candidate.origin_version DESC, candidate.id DESC
  LIMIT 1;
  IF NOT FOUND
     OR origin.origin_kind <> 'MARKETPLACE'
     OR origin.routing_state <> 'ROUTING_READY'
     OR cardinality(origin.hold_reason_codes) <> 0
     OR EXISTS (
       SELECT 1 FROM public.universal_v1_relationship_origins successor
       WHERE successor.supersedes_origin_id = origin.id
     ) THEN
    RAISE EXCEPTION 'HXUV1-STDQUOTE-4: exact current RelationshipOrigin is required'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO cell
  FROM public.universal_v1_service_cell_authorities candidate
  WHERE candidate.id = route.service_cell_authority_id
  FOR SHARE;
  IF NOT FOUND
     OR cell.region_code IS DISTINCT FROM route.service_cell_snapshot
     OR cell.authority_environment <> NEW.environment_class
     OR cell.routing_availability <> 'ACTIVE'
     OR cell.is_test IS NOT TRUE
     OR cell.authority_kind <> 'SYNTHETIC_FIXTURE'
     OR cell.effective_from > clock_timestamp()
     OR (cell.expires_at IS NOT NULL AND cell.expires_at <= clock_timestamp())
     OR EXISTS (
       SELECT 1 FROM public.universal_v1_service_cell_authorities successor
       WHERE successor.supersedes_authority_id = cell.id
     ) THEN
    RAISE EXCEPTION 'HXUV1-STDQUOTE-5: exact active synthetic service-cell authority is required'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT mapping.* INTO pricing_mapping
  FROM public.universal_v1_service_cell_price_book_mappings mapping
  JOIN public.price_book mapped_price
    ON mapped_price.id = mapping.price_book_id
   AND mapped_price.policy_version = mapping.price_book_policy_version
   AND mapped_price.category = route.category_snapshot
  WHERE mapping.service_cell_authority_id = cell.id
    AND mapping.service_cell_authority_version = cell.authority_version
    AND mapping.environment_class = cell.authority_environment
    AND mapping.mapping_version = 1
  FOR SHARE OF mapping;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUV1-STDQUOTE-20: exact service-cell Price Book mapping is required'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO pricing
  FROM public.price_book candidate
  WHERE candidate.id = pricing_mapping.price_book_id
    AND candidate.category = route.category_snapshot
    AND candidate.policy_version = pricing_mapping.price_book_policy_version
    AND candidate.active IS TRUE
  FOR SHARE;
  IF NOT FOUND
     OR pricing.automation_evidence_state <> 'CONTROLLED_TEST_ONLY'
     OR pricing.policy_version <> 'hxos-price-book-v1'
     OR pricing.base_price_cents < pricing.price_min_cents
     OR pricing.base_price_cents > pricing.price_max_cents
     OR pricing.base_price_cents > pricing.price_cap_cents
     OR pricing.min_hustler_payout_cents > pricing.base_price_cents THEN
    RAISE EXCEPTION 'HXUV1-STDQUOTE-6: deterministic nonproduction Price Book row is unavailable'
      USING ERRCODE = 'P0001';
  END IF;
  standardized_pricing_policy_version :=
    pricing.policy_version || ':hxuv1-standardized-base-v1';
  IF char_length(standardized_pricing_policy_version) > 128 THEN
    RAISE EXCEPTION 'HXUV1-STDQUOTE-19: standardized pricing policy witness is invalid'
      USING ERRCODE = 'P0001';
  END IF;
  -- This deliberately separate nonproduction policy quotes only the exact
  -- typed base scope admitted above. Free-form fields are non-authoritative
  -- and excluded from provider/pricing scope; unknown or canonical modifier
  -- keys fail closed before this base-price calculation.
  margin_floor_bps := round(pricing.platform_margin_floor_pct * 100)::INTEGER;
  computed_provider_payout_cents := floor(
    pricing.base_price_cents::NUMERIC * (10000 - margin_floor_bps) / 10000
  )::INTEGER;
  IF computed_provider_payout_cents < pricing.min_hustler_payout_cents
     OR (pricing.base_price_cents - computed_provider_payout_cents)::NUMERIC * 10000
        < pricing.base_price_cents::NUMERIC * margin_floor_bps::NUMERIC THEN
    RAISE EXCEPTION 'HXUV1-STDQUOTE-6: Price Book payout and margin floor are inconsistent'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.expected_quote_version = 0 THEN
    IF EXISTS (
      SELECT 1 FROM public.task_draft_standardized_quote_versions existing
      WHERE existing.task_draft_id = draft.id
    ) THEN
      RAISE EXCEPTION 'HXUV1-STDQUOTE-7: expected quote version changed'
        USING ERRCODE = 'P0001';
    END IF;
    NEW.supersedes_quote_version_id := NULL;
  ELSE
    SELECT * INTO predecessor
    FROM public.task_draft_standardized_quote_versions candidate
    WHERE candidate.task_draft_id = draft.id
      AND NOT EXISTS (
        SELECT 1 FROM public.task_draft_standardized_quote_versions successor
        WHERE successor.supersedes_quote_version_id = candidate.id
      )
    ORDER BY candidate.quote_version DESC
    LIMIT 1
    FOR SHARE;
    IF NOT FOUND OR predecessor.quote_version <> NEW.expected_quote_version THEN
      RAISE EXCEPTION 'HXUV1-STDQUOTE-7: expected quote version changed'
        USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.task_draft_standardized_quote_acceptance_facts acceptance
      WHERE acceptance.task_draft_id = draft.id
    ) THEN
      RAISE EXCEPTION 'HXUV1-STDQUOTE-8: an accepted quote cannot be superseded'
        USING ERRCODE = 'P0001';
    END IF;
    NEW.supersedes_quote_version_id := predecessor.id;
  END IF;

  expected_request_sha256 := public.universal_v1_standardized_quote_request_sha256(
    NEW.requested_by_user_id, NEW.task_draft_id,
    NEW.routing_decision_version, NEW.expected_quote_version,
    NEW.idempotency_key, NEW.client_timestamp_ms
  );
  IF btrim(NEW.request_sha256) IS DISTINCT FROM btrim(expected_request_sha256) THEN
    RAISE EXCEPTION 'HXUV1-STDQUOTE-9: quote request witness mismatch'
      USING ERRCODE = 'P0001';
  END IF;

  NEW.id := public.universal_v1_relationship_deterministic_uuid(
    'STANDARDIZED_QUOTE_V1:' || draft.id::TEXT || ':v' ||
    (NEW.expected_quote_version + 1)::TEXT
  );
  NEW.quote_version := NEW.expected_quote_version + 1;
  NEW.quote_kind := 'STANDARDIZED_SCOPE_FIXED_PRICE';
  NEW.scope_artifact_kind := 'TASK_DRAFT_STANDARDIZED_SCOPE_V1';
  NEW.scope_artifact_id := NEW.id;
  NEW.scope_artifact_version := NEW.quote_version;
  NEW.relationship_origin_id := origin.id;
  NEW.relationship_origin_version := origin.origin_version;
  NEW.service_cell_authority_id := cell.id;
  NEW.service_cell_authority_version := cell.authority_version;
  NEW.work_category_code := route.category_snapshot;
  NEW.region_code := route.service_cell_snapshot;
  NEW.rough_location := route.evidence ->> 'rough_location';
  NEW.risk_level := route.evidence ->> 'risk_level';
  NEW.requires_proof := TRUE;
  NEW.scope_snapshot := jsonb_build_object(
    'contractVersion', 1,
    'scopeArtifactKind', 'TASK_DRAFT_STANDARDIZED_SCOPE_V1',
    'scopeArtifactId', NEW.scope_artifact_id,
    'scopeArtifactVersion', NEW.scope_artifact_version,
    'scopeSource', 'TYPED_TASK_DRAFT_ALLOWLIST_V1',
    'quoteKind', 'STANDARDIZED_SCOPE_FIXED_PRICE',
    'workCategoryCode', route.category_snapshot,
    'answers', CASE route.category_snapshot
      WHEN 'moving' THEN jsonb_strip_nulls(jsonb_build_object(
        'size_weight', draft.structured #> '{answers,size_weight}',
        'access', draft.structured #> '{answers,access}',
        'move_type', draft.structured #> '{answers,move_type}',
        'workers_needed', draft.structured #> '{answers,workers_needed}',
        'fragile', draft.structured #> '{answers,fragile}'
      ))
      WHEN 'furniture_assembly' THEN jsonb_strip_nulls(jsonb_build_object(
        'assembly_scope_class', draft.structured #> '{answers,assembly_scope_class}',
        'item_count_class', draft.structured #> '{answers,item_count_class}',
        'new_in_box', draft.structured #> '{answers,new_in_box}',
        'tools_included', draft.structured #> '{answers,tools_included}',
        'old_item_removal', draft.structured #> '{answers,old_item_removal}'
      ))
      ELSE '{}'::JSONB
    END,
    'scopePolicyVersion', draft.structured ->> 'scope_policy_version',
    'serviceCellAuthorityId', cell.id,
    'serviceCellAuthorityVersion', cell.authority_version,
    'regionCode', route.service_cell_snapshot,
    'roughLocation', route.evidence ->> 'rough_location',
    'riskLevel', route.evidence ->> 'risk_level',
    'requiresProof', TRUE,
    'finalAvailabilityConfirmationRequired', TRUE
  );
  NEW.scope_sha256 := encode(public.digest(NEW.scope_snapshot::TEXT, 'sha256'), 'hex');
  NEW.price_book_id := pricing.id;
  NEW.price_book_mapping_id := pricing_mapping.id;
  NEW.pricing_policy_version := standardized_pricing_policy_version;
  NEW.pricing_snapshot := jsonb_build_object(
    'policyVersion', standardized_pricing_policy_version,
    'sourcePriceBookPolicyVersion', pricing.policy_version,
    'pricingMode', 'BASE_PRICE_NO_MODIFIERS',
    'scopeModifierCount', 0,
    'priceBookId', pricing.id,
    'priceBookMappingId', pricing_mapping.id,
    'priceBookMappingVersion', pricing_mapping.mapping_version,
    'priceBookMappingEvidenceSha256', btrim(pricing_mapping.evidence_sha256),
    'mappedServiceCellAuthorityId', pricing_mapping.service_cell_authority_id,
    'mappedServiceCellAuthorityVersion', pricing_mapping.service_cell_authority_version,
    'mappedEnvironmentClass', pricing_mapping.environment_class,
    'category', pricing.category,
    'serviceArea', pricing.service_area,
    'basePriceCents', pricing.base_price_cents,
    'providerPayoutCents', computed_provider_payout_cents,
    'platformMarginFloorPct', pricing.platform_margin_floor_pct,
    'platformMarginFloorBps', margin_floor_bps,
    'priceMinCents', pricing.price_min_cents,
    'priceMaxCents', pricing.price_max_cents,
    'priceCapCents', pricing.price_cap_cents,
    'automationEvidenceState', pricing.automation_evidence_state,
    'refundPolicyVersion', pricing.refund_policy_version
  );
  NEW.pricing_sha256 := encode(public.digest(NEW.pricing_snapshot::TEXT, 'sha256'), 'hex');
  NEW.customer_total_cents := pricing.base_price_cents;
  NEW.provider_payout_cents := computed_provider_payout_cents;
  NEW.platform_margin_cents := pricing.base_price_cents - computed_provider_payout_cents;
  NEW.currency := 'usd';
  NEW.decision_authority := 'DETERMINISTIC_POLICY';
  NEW.payment_posture := 'PAYMENT_CREATION_FROZEN';
  NEW.issuance_evidence_sha256 := encode(public.digest(concat_ws('|',
    'HX_UNIVERSAL_V1_STANDARDIZED_QUOTE_ISSUANCE_EVIDENCE_V1',
    NEW.environment_class, NEW.issuance_build_commit_sha::TEXT,
    NEW.issuance_release_manifest_digest, NEW.issuance_capability_policy_digest
  ), 'sha256'), 'hex');
  NEW.quote_evidence_sha256 := encode(public.digest(concat_ws('|',
    'HX_UNIVERSAL_V1_STANDARDIZED_QUOTE_EVIDENCE_V1', NEW.id::TEXT,
    NEW.quote_version::TEXT, NEW.scope_sha256::TEXT, NEW.pricing_sha256::TEXT,
    NEW.customer_total_cents::TEXT, NEW.provider_payout_cents::TEXT,
    NEW.platform_margin_cents::TEXT, NEW.currency
  ), 'sha256'), 'hex');
  NEW.created_at := clock_timestamp();
  NEW.valid_until := NEW.created_at + make_interval(hours => pricing.quote_expires_hours);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_standardized_quote_acceptance_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  quote public.task_draft_standardized_quote_versions%ROWTYPE;
  draft public.task_drafts%ROWTYPE;
  expected_request_sha256 CHAR(64);
  acceptance_observed_at TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO quote
  FROM public.task_draft_standardized_quote_versions candidate
  WHERE candidate.id = NEW.quote_version_id
  FOR SHARE;
  IF NOT FOUND
     OR quote.task_draft_id IS DISTINCT FROM NEW.task_draft_id
     OR quote.quote_version <> NEW.expected_quote_version
     OR quote.routing_decision_version <> NEW.routing_decision_version
     OR quote.environment_class <> NEW.environment_class
     OR quote.valid_until <= acceptance_observed_at
     OR EXISTS (
       SELECT 1 FROM public.task_draft_standardized_quote_versions successor
       WHERE successor.supersedes_quote_version_id = quote.id
     ) THEN
    RAISE EXCEPTION 'HXUV1-STDQUOTE-10: exact current unexpired quote version is required'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO draft
  FROM public.task_drafts candidate
  WHERE candidate.id = quote.task_draft_id
  FOR SHARE;
  IF NOT FOUND
     OR draft.poster_user_id IS DISTINCT FROM NEW.accepted_by_user_id
     OR draft.status <> 'account_claimed'
     OR draft.task_id IS NOT NULL
     OR draft.active_routing_decision_id IS DISTINCT FROM quote.routing_decision_id
     OR NOT EXISTS (
       SELECT 1 FROM public.users actor
       WHERE actor.id = NEW.accepted_by_user_id
         AND actor.default_mode = 'poster'
         AND actor.account_status = 'ACTIVE'
         AND actor.is_minor IS FALSE
         AND COALESCE(actor.is_banned, FALSE) IS FALSE
     ) THEN
    RAISE EXCEPTION 'HXUV1-STDQUOTE-11: exact owning active adult Poster is required'
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.task_routing_decisions route
    JOIN public.universal_v1_service_cell_authorities cell
      ON cell.id = route.service_cell_authority_id
    WHERE route.id = quote.routing_decision_id
      AND route.task_draft_id = draft.id
      AND route.decision_version = quote.routing_decision_version
      AND route.outcome = 'FULFILLMENT_CANDIDATE'
      AND route.policy_version = 'universal-v1-intake-1.2.0'
      AND route.category_snapshot = quote.work_category_code
      AND route.service_cell_snapshot = quote.region_code
      AND cell.id = quote.service_cell_authority_id
      AND cell.authority_version = quote.service_cell_authority_version
      AND cell.authority_environment = quote.environment_class
      AND cell.routing_availability = 'ACTIVE'
      AND cell.is_test IS TRUE
      AND cell.authority_kind = 'SYNTHETIC_FIXTURE'
      AND cell.effective_from <= clock_timestamp()
      AND (cell.expires_at IS NULL OR cell.expires_at > clock_timestamp())
      AND NOT EXISTS (
        SELECT 1 FROM public.universal_v1_service_cell_authorities successor
        WHERE successor.supersedes_authority_id = cell.id
      )
      AND EXISTS (
        SELECT 1 FROM public.universal_v1_relationship_origins origin
        WHERE origin.id = quote.relationship_origin_id
          AND origin.task_draft_id = draft.id
          AND origin.origin_version = quote.relationship_origin_version
          AND origin.origin_kind = 'MARKETPLACE'
          AND origin.routing_state = 'ROUTING_READY'
          AND cardinality(origin.hold_reason_codes) = 0
          AND NOT EXISTS (
            SELECT 1 FROM public.universal_v1_relationship_origins successor
            WHERE successor.supersedes_origin_id = origin.id
          )
      )
  ) THEN
    RAISE EXCEPTION 'HXUV1-STDQUOTE-17: quote routing context requires review before acceptance'
      USING ERRCODE = 'P0001';
  END IF;
  expected_request_sha256 := public.universal_v1_standardized_quote_acceptance_request_sha256(
    NEW.accepted_by_user_id, NEW.task_draft_id, NEW.quote_version_id,
    NEW.routing_decision_version, NEW.expected_quote_version,
    NEW.expected_acceptance_version, NEW.idempotency_key,
    NEW.client_timestamp_ms
  );
  IF btrim(NEW.request_sha256) IS DISTINCT FROM btrim(expected_request_sha256) THEN
    RAISE EXCEPTION 'HXUV1-STDQUOTE-12: acceptance request witness mismatch'
      USING ERRCODE = 'P0001';
  END IF;
  NEW.id := public.universal_v1_relationship_deterministic_uuid(
    'STANDARDIZED_QUOTE_ACCEPTANCE_V1:' || quote.id::TEXT
  );
  NEW.task_draft_id := quote.task_draft_id;
  NEW.quote_version := quote.quote_version;
  NEW.routing_decision_id := quote.routing_decision_id;
  NEW.scope_artifact_kind := quote.scope_artifact_kind;
  NEW.scope_artifact_id := quote.scope_artifact_id;
  NEW.scope_artifact_version := quote.scope_artifact_version;
  NEW.scope_sha256 := quote.scope_sha256;
  NEW.pricing_sha256 := quote.pricing_sha256;
  NEW.quote_evidence_sha256 := quote.quote_evidence_sha256;
  NEW.customer_total_cents := quote.customer_total_cents;
  NEW.currency := quote.currency;
  NEW.acceptance_version := 1;
  NEW.environment_class := quote.environment_class;
  NEW.command_evidence_sha256 := encode(public.digest(concat_ws('|',
    'HX_UNIVERSAL_V1_STANDARDIZED_QUOTE_ACCEPTANCE_COMMAND_EVIDENCE_V1',
    NEW.environment_class, NEW.command_build_commit_sha::TEXT,
    NEW.command_release_manifest_digest, NEW.command_capability_policy_digest
  ), 'sha256'), 'hex');
  NEW.payment_creation_created := FALSE;
  NEW.financial_security_event_created := FALSE;
  NEW.task_created := FALSE;
  NEW.assignment_created := FALSE;
  NEW.accepted_at := acceptance_observed_at;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_fake_payment_readiness_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  acceptance public.task_draft_standardized_quote_acceptance_facts%ROWTYPE;
  quote public.task_draft_standardized_quote_versions%ROWTYPE;
  draft public.task_drafts%ROWTYPE;
  predecessor public.task_draft_payment_method_readiness_facts%ROWTYPE;
  expected_request_sha256 CHAR(64);
BEGIN
  SELECT * INTO acceptance
  FROM public.task_draft_standardized_quote_acceptance_facts candidate
  WHERE candidate.id = NEW.acceptance_fact_id
  FOR SHARE;
  IF NOT FOUND OR acceptance.accepted_by_user_id IS DISTINCT FROM NEW.prepared_by_user_id THEN
    RAISE EXCEPTION 'HXUV1-STDQUOTE-13: exact accepted quote fact is required'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO quote
  FROM public.task_draft_standardized_quote_versions candidate
  WHERE candidate.id = acceptance.quote_version_id
  FOR SHARE;
  IF NOT FOUND
     OR quote.task_draft_id IS DISTINCT FROM NEW.task_draft_id
     OR quote.quote_version <> NEW.expected_quote_version
     OR acceptance.accepted_at > quote.valid_until
     OR acceptance.environment_class <> NEW.environment_class
     OR quote.environment_class <> NEW.environment_class
     OR NEW.provider_kind <> 'FAKE' THEN
    RAISE EXCEPTION 'HXUV1-STDQUOTE-13: exact accepted nonproduction fake-readiness context is required'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO draft
  FROM public.task_drafts candidate
  WHERE candidate.id = quote.task_draft_id
  FOR SHARE;
  IF NOT FOUND
     OR draft.poster_user_id IS DISTINCT FROM acceptance.accepted_by_user_id
     OR draft.status <> 'account_claimed'
     OR draft.task_id IS NOT NULL
     OR draft.active_routing_decision_id IS DISTINCT FROM quote.routing_decision_id
     OR NOT EXISTS (
       SELECT 1 FROM public.users actor
       WHERE actor.id = acceptance.accepted_by_user_id
         AND actor.default_mode = 'poster'
         AND actor.account_status = 'ACTIVE'
         AND actor.is_minor IS FALSE
         AND COALESCE(actor.is_banned, FALSE) IS FALSE
     )
     OR NOT EXISTS (
       SELECT 1
       FROM public.task_routing_decisions route
       JOIN public.universal_v1_service_cell_authorities cell
         ON cell.id = route.service_cell_authority_id
       WHERE route.id = quote.routing_decision_id
         AND route.task_draft_id = draft.id
         AND route.decision_version = quote.routing_decision_version
         AND route.outcome = 'FULFILLMENT_CANDIDATE'
         AND route.policy_version = 'universal-v1-intake-1.2.0'
         AND route.category_snapshot = quote.work_category_code
         AND route.service_cell_snapshot = quote.region_code
         AND cell.id = quote.service_cell_authority_id
         AND cell.authority_version = quote.service_cell_authority_version
         AND cell.authority_environment = quote.environment_class
         AND cell.routing_availability = 'ACTIVE'
         AND cell.is_test IS TRUE
         AND cell.authority_kind = 'SYNTHETIC_FIXTURE'
         AND cell.effective_from <= clock_timestamp()
         AND (cell.expires_at IS NULL OR cell.expires_at > clock_timestamp())
         AND NOT EXISTS (
           SELECT 1 FROM public.universal_v1_service_cell_authorities successor
           WHERE successor.supersedes_authority_id = cell.id
         )
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.universal_v1_relationship_origins origin
       WHERE origin.id = quote.relationship_origin_id
         AND origin.task_draft_id = draft.id
         AND origin.origin_version = quote.relationship_origin_version
         AND origin.origin_kind = 'MARKETPLACE'
         AND origin.routing_state = 'ROUTING_READY'
         AND cardinality(origin.hold_reason_codes) = 0
         AND NOT EXISTS (
           SELECT 1 FROM public.universal_v1_relationship_origins successor
           WHERE successor.supersedes_origin_id = origin.id
         )
     ) THEN
    RAISE EXCEPTION 'HXUV1-STDQUOTE-17: accepted quote routing context requires review'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.expected_readiness_version = 0 THEN
    IF EXISTS (
      SELECT 1 FROM public.task_draft_payment_method_readiness_facts existing
      WHERE existing.acceptance_fact_id = acceptance.id
    ) THEN
      RAISE EXCEPTION 'HXUV1-STDQUOTE-16: expected readiness version changed'
        USING ERRCODE = 'P0001';
    END IF;
    NEW.supersedes_readiness_fact_id := NULL;
  ELSE
    SELECT * INTO predecessor
    FROM public.task_draft_payment_method_readiness_facts candidate
    WHERE candidate.acceptance_fact_id = acceptance.id
      AND NOT EXISTS (
        SELECT 1 FROM public.task_draft_payment_method_readiness_facts successor
        WHERE successor.supersedes_readiness_fact_id = candidate.id
      )
    ORDER BY candidate.readiness_version DESC
    LIMIT 1
    FOR SHARE;
    IF NOT FOUND
       OR predecessor.readiness_version <> NEW.expected_readiness_version
       OR predecessor.task_draft_id IS DISTINCT FROM quote.task_draft_id
       OR predecessor.quote_version_id IS DISTINCT FROM quote.id
       OR predecessor.environment_class IS DISTINCT FROM NEW.environment_class THEN
      RAISE EXCEPTION 'HXUV1-STDQUOTE-16: expected readiness version changed'
        USING ERRCODE = 'P0001';
    END IF;
    NEW.supersedes_readiness_fact_id := predecessor.id;
  END IF;

  expected_request_sha256 := public.universal_v1_fake_payment_readiness_request_sha256(
    NEW.prepared_by_user_id, NEW.task_draft_id, NEW.acceptance_fact_id,
    NEW.expected_quote_version, NEW.expected_readiness_version,
    NEW.idempotency_key, NEW.client_timestamp_ms, NEW.opaque_reference_sha256
  );
  IF btrim(NEW.request_sha256) IS DISTINCT FROM btrim(expected_request_sha256) THEN
    RAISE EXCEPTION 'HXUV1-STDQUOTE-14: fake-readiness request witness mismatch'
      USING ERRCODE = 'P0001';
  END IF;
  NEW.id := public.universal_v1_relationship_deterministic_uuid(
    'FAKE_PAYMENT_METHOD_READINESS_V1:' || acceptance.id::TEXT || ':v' ||
    (NEW.expected_readiness_version + 1)::TEXT
  );
  NEW.fake_provider_operation_id := public.universal_v1_relationship_deterministic_uuid(
    'FAKE_PAYMENT_METHOD_OPERATION_V1:' || acceptance.id::TEXT || ':v' ||
    (NEW.expected_readiness_version + 1)::TEXT
  );
  NEW.task_draft_id := quote.task_draft_id;
  NEW.quote_version_id := quote.id;
  NEW.quote_version := quote.quote_version;
  NEW.readiness_version := NEW.expected_readiness_version + 1;
  NEW.command_evidence_sha256 := encode(public.digest(concat_ws('|',
    'HX_UNIVERSAL_V1_FAKE_PAYMENT_METHOD_COMMAND_EVIDENCE_V1',
    NEW.environment_class, NEW.command_build_commit_sha::TEXT,
    NEW.command_release_manifest_digest, NEW.command_capability_policy_digest
  ), 'sha256'), 'hex');
  NEW.payment_method_prepared := TRUE;
  NEW.external_provider_called := FALSE;
  NEW.customer_money_created := FALSE;
  NEW.authorization_created := FALSE;
  NEW.financial_security_event_created := FALSE;
  NEW.capture_created := FALSE;
  NEW.assignment_created := FALSE;
  NEW.work_order_created := FALSE;
  NEW.settlement_created := FALSE;
  NEW.payout_created := FALSE;
  NEW.created_at := clock_timestamp();
  NEW.expires_at := NEW.created_at + interval '30 minutes';
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_universal_v1_standardized_quote_fact_mutation_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'HXUV1-STDQUOTE-15: standardized pricing mappings, quotes, acceptances, and readiness facts are append-only'
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS task_draft_standardized_quote_versions_insert_guard
ON public.task_draft_standardized_quote_versions;
CREATE TRIGGER task_draft_standardized_quote_versions_insert_guard
BEFORE INSERT ON public.task_draft_standardized_quote_versions
FOR EACH ROW EXECUTE FUNCTION public.enforce_universal_v1_standardized_quote_v1();
DROP TRIGGER IF EXISTS task_draft_standardized_quote_acceptance_insert_guard
ON public.task_draft_standardized_quote_acceptance_facts;
CREATE TRIGGER task_draft_standardized_quote_acceptance_insert_guard
BEFORE INSERT ON public.task_draft_standardized_quote_acceptance_facts
FOR EACH ROW EXECUTE FUNCTION public.enforce_universal_v1_standardized_quote_acceptance_v1();
DROP TRIGGER IF EXISTS task_draft_payment_method_readiness_insert_guard
ON public.task_draft_payment_method_readiness_facts;
CREATE TRIGGER task_draft_payment_method_readiness_insert_guard
BEFORE INSERT ON public.task_draft_payment_method_readiness_facts
FOR EACH ROW EXECUTE FUNCTION public.enforce_universal_v1_fake_payment_readiness_v1();

DROP TRIGGER IF EXISTS universal_v1_service_cell_price_book_mappings_immutable
ON public.universal_v1_service_cell_price_book_mappings;
CREATE TRIGGER universal_v1_service_cell_price_book_mappings_immutable
BEFORE UPDATE OR DELETE ON public.universal_v1_service_cell_price_book_mappings
FOR EACH ROW EXECUTE FUNCTION public.prevent_universal_v1_standardized_quote_fact_mutation_v1();
DROP TRIGGER IF EXISTS universal_v1_service_cell_price_book_mappings_no_truncate
ON public.universal_v1_service_cell_price_book_mappings;
CREATE TRIGGER universal_v1_service_cell_price_book_mappings_no_truncate
BEFORE TRUNCATE ON public.universal_v1_service_cell_price_book_mappings
FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_universal_v1_standardized_quote_fact_mutation_v1();

DROP TRIGGER IF EXISTS task_draft_standardized_quote_versions_immutable
ON public.task_draft_standardized_quote_versions;
CREATE TRIGGER task_draft_standardized_quote_versions_immutable
BEFORE UPDATE OR DELETE ON public.task_draft_standardized_quote_versions
FOR EACH ROW EXECUTE FUNCTION public.prevent_universal_v1_standardized_quote_fact_mutation_v1();
DROP TRIGGER IF EXISTS task_draft_standardized_quote_versions_no_truncate
ON public.task_draft_standardized_quote_versions;
CREATE TRIGGER task_draft_standardized_quote_versions_no_truncate
BEFORE TRUNCATE ON public.task_draft_standardized_quote_versions
FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_universal_v1_standardized_quote_fact_mutation_v1();
DROP TRIGGER IF EXISTS task_draft_standardized_quote_acceptance_immutable
ON public.task_draft_standardized_quote_acceptance_facts;
CREATE TRIGGER task_draft_standardized_quote_acceptance_immutable
BEFORE UPDATE OR DELETE ON public.task_draft_standardized_quote_acceptance_facts
FOR EACH ROW EXECUTE FUNCTION public.prevent_universal_v1_standardized_quote_fact_mutation_v1();
DROP TRIGGER IF EXISTS task_draft_standardized_quote_acceptance_no_truncate
ON public.task_draft_standardized_quote_acceptance_facts;
CREATE TRIGGER task_draft_standardized_quote_acceptance_no_truncate
BEFORE TRUNCATE ON public.task_draft_standardized_quote_acceptance_facts
FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_universal_v1_standardized_quote_fact_mutation_v1();
DROP TRIGGER IF EXISTS task_draft_payment_method_readiness_immutable
ON public.task_draft_payment_method_readiness_facts;
CREATE TRIGGER task_draft_payment_method_readiness_immutable
BEFORE UPDATE OR DELETE ON public.task_draft_payment_method_readiness_facts
FOR EACH ROW EXECUTE FUNCTION public.prevent_universal_v1_standardized_quote_fact_mutation_v1();
DROP TRIGGER IF EXISTS task_draft_payment_method_readiness_no_truncate
ON public.task_draft_payment_method_readiness_facts;
CREATE TRIGGER task_draft_payment_method_readiness_no_truncate
BEFORE TRUNCATE ON public.task_draft_payment_method_readiness_facts
FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_universal_v1_standardized_quote_fact_mutation_v1();

-- Keep estimate-required opportunities unchanged. A standardized-scope route is
-- publishable only after the owning Poster accepted its exact current quote and
-- an unexpired, application-witnessed FAKE readiness fact exists. The shared
-- database role does not independently attest a manifest. The legacy route
-- context remains the scope artifact until held Work Order authority is solved.
CREATE OR REPLACE VIEW public.current_universal_v1_task_opportunities_v1
WITH (security_invoker = true)
AS
SELECT
  public.universal_v1_relationship_deterministic_uuid(
    'TASK_OPPORTUNITY_V1:' || route.id::TEXT || ':' || origin.id::TEXT || ':' ||
    scope_digest.scope_artifact_sha256 || CASE
      WHEN route.outcome = 'FULFILLMENT_CANDIDATE'
        THEN ':' || standardized_quote.quote_evidence_sha256::TEXT
      ELSE ''
    END
  ) AS opportunity_id,
  route.decision_version AS opportunity_version,
  draft.id AS task_draft_id,
  route.id AS routing_decision_id,
  route.decision_version AS routing_decision_version,
  route.policy_version AS routing_policy_version,
  origin.id AS relationship_origin_id,
  origin.origin_version AS relationship_origin_version,
  origin.origin_kind AS relationship_origin_kind,
  origin.policy_version AS relationship_origin_policy_version,
  'TASK_DRAFT_ROUTE_CONTEXT_V1'::TEXT AS scope_artifact_kind,
  route.id AS scope_artifact_id,
  route.decision_version AS scope_artifact_version,
  scope_digest.scope_artifact_sha256,
  CASE
    WHEN route.outcome = 'FULFILLMENT_CANDIDATE' THEN standardized_quote.scope_snapshot
    ELSE public_scope.public_scope
  END AS public_scope,
  route.category_snapshot AS work_category_code,
  route.service_cell_authority_id,
  route.service_cell_snapshot AS region_code,
  route.evidence ->> 'rough_location' AS rough_location,
  route.evidence ->> 'risk_level' AS risk_level,
  TRUE AS requires_proof,
  route.outcome AS routing_outcome,
  cell.authority_version AS service_cell_authority_version,
  cell.evidence_sha256 AS service_cell_evidence_sha256,
  draft.updated_at AS draft_observed_at,
  route.created_at AS routed_at,
  'ROUTE_CONTEXT_ALLOWLIST_ONLY'::TEXT AS privacy_posture,
  'HELD_PENDING_TASK_SPECIFIC_EVALUATION'::TEXT AS eligibility_posture,
  'NONE'::TEXT AS assignment_authority,
  'NONE'::TEXT AS address_contact_authority,
  'NONE'::TEXT AS financial_authority,
  'NONE'::TEXT AS guaranteed_earning_authority,
  standardized_quote.id AS standardized_quote_id,
  standardized_quote.quote_version AS standardized_quote_version,
  standardized_quote.quote_evidence_sha256 AS standardized_quote_sha256,
  standardized_quote.customer_total_cents,
  standardized_quote.currency,
  (readiness.id IS NOT NULL) AS fake_payment_method_ready,
  CASE
    WHEN readiness.id IS NOT NULL THEN 'FAKE_PAYMENT_METHOD_READY_NO_FINANCIAL_EFFECT'
    ELSE 'NOT_APPLICABLE'
  END::TEXT AS payment_method_readiness_posture,
  standardized_quote.scope_artifact_kind AS standardized_scope_artifact_kind,
  standardized_quote.scope_artifact_id AS standardized_scope_artifact_id,
  standardized_quote.scope_artifact_version AS standardized_scope_artifact_version,
  standardized_quote.scope_sha256 AS standardized_scope_artifact_sha256
FROM public.task_drafts draft
JOIN public.users poster
  ON poster.id = draft.poster_user_id
JOIN public.task_routing_decisions route
  ON route.id = draft.active_routing_decision_id
 AND route.task_draft_id = draft.id
JOIN public.universal_v1_service_cell_authorities cell
  ON cell.id = route.service_cell_authority_id
 AND cell.region_code = route.service_cell_snapshot
 AND cell.routing_availability = 'ACTIVE'
JOIN LATERAL (
  SELECT candidate.*
  FROM public.universal_v1_relationship_origins candidate
  WHERE candidate.task_draft_id = draft.id
  ORDER BY candidate.origin_version DESC, candidate.id DESC
  LIMIT 1
) origin ON TRUE
LEFT JOIN LATERAL (
  SELECT candidate.*
  FROM public.task_draft_standardized_quote_versions candidate
  WHERE candidate.task_draft_id = draft.id
    AND candidate.routing_decision_id = route.id
    AND candidate.routing_decision_version = route.decision_version
    AND candidate.relationship_origin_id = origin.id
    AND candidate.relationship_origin_version = origin.origin_version
    AND candidate.service_cell_authority_id = cell.id
    AND candidate.service_cell_authority_version = cell.authority_version
    AND candidate.work_category_code = route.category_snapshot
    AND candidate.region_code = route.service_cell_snapshot
    AND candidate.environment_class = cell.authority_environment
    AND NOT EXISTS (
      SELECT 1 FROM public.task_draft_standardized_quote_versions successor
      WHERE successor.supersedes_quote_version_id = candidate.id
    )
  ORDER BY candidate.quote_version DESC
  LIMIT 1
) standardized_quote ON route.outcome = 'FULFILLMENT_CANDIDATE'
LEFT JOIN public.task_draft_standardized_quote_acceptance_facts acceptance
  ON acceptance.quote_version_id = standardized_quote.id
LEFT JOIN LATERAL (
  SELECT candidate.*
  FROM public.task_draft_payment_method_readiness_facts candidate
  WHERE candidate.acceptance_fact_id = acceptance.id
    AND candidate.quote_version_id = standardized_quote.id
    AND candidate.expires_at > clock_timestamp()
    AND NOT EXISTS (
      SELECT 1 FROM public.task_draft_payment_method_readiness_facts successor
      WHERE successor.supersedes_readiness_fact_id = candidate.id
    )
  ORDER BY candidate.readiness_version DESC
  LIMIT 1
) readiness ON TRUE
CROSS JOIN LATERAL (
  SELECT jsonb_build_object(
    'artifactKind', 'TASK_DRAFT_ROUTE_CONTEXT_V1',
    'artifactId', route.id,
    'artifactVersion', route.decision_version,
    'routingPolicyVersion', route.policy_version,
    'routeContextEvidence', route.evidence
  ) AS scope_artifact
) scope_artifact
CROSS JOIN LATERAL (
  SELECT encode(
    public.digest(scope_artifact.scope_artifact::TEXT, 'sha256'),
    'hex'
  ) AS scope_artifact_sha256
) scope_digest
CROSS JOIN LATERAL (
  SELECT jsonb_build_object(
    'contractVersion', 1,
    'workCategoryCode', route.category_snapshot,
    'serviceCellAuthorityId', route.service_cell_authority_id,
    'serviceCellAuthorityVersion', cell.authority_version,
    'regionCode', route.service_cell_snapshot,
    'roughLocation', route.evidence ->> 'rough_location',
    'riskLevel', route.evidence ->> 'risk_level',
    'requiresProof', TRUE,
    'finalAvailabilityConfirmationRequired', TRUE,
    'routingOutcome', route.outcome
  ) AS public_scope
) public_scope
WHERE draft.universal_contract_version = 1
  AND draft.ingress_origin = 'BACKEND_POSTGRESQL'
  AND draft.status = 'account_claimed'
  AND draft.poster_user_id IS NOT NULL
  AND draft.task_id IS NULL
  AND poster.default_mode = 'poster'
  AND poster.account_status = 'ACTIVE'
  AND poster.is_minor IS FALSE
  AND COALESCE(poster.is_banned, FALSE) IS FALSE
  AND draft.relationship_origin_contract_version = 1
  AND draft.relationship_origin_kind = 'MARKETPLACE'
  AND draft.relationship_origin_policy_version = 1
  AND origin.origin_kind = draft.relationship_origin_kind
  AND origin.policy_version = draft.relationship_origin_policy_version
  AND origin.routing_state = 'ROUTING_READY'
  AND cardinality(origin.hold_reason_codes) = 0
  AND NOT EXISTS (
    SELECT 1 FROM public.universal_v1_relationship_origins successor
    WHERE successor.supersedes_origin_id = origin.id
  )
  AND route.outcome IN ('FULFILLMENT_CANDIDATE', 'ESTIMATE_REQUIRED')
  AND route.policy_version = 'universal-v1-intake-1.2.0'
  AND route.category_snapshot = route.evidence ->> 'work_category_code'
  AND route.service_cell_snapshot = route.evidence ->> 'region_code'
  AND route.service_cell_authority_id::TEXT = route.evidence ->> 'service_cell_authority_id'
  AND route.evidence ->> 'service_cell_availability' = 'ACTIVE'
  AND route.evidence -> 'route_context_contract_version' = '1'::JSONB
  AND jsonb_typeof(route.evidence -> 'rough_location') = 'string'
  AND char_length(btrim(route.evidence ->> 'rough_location')) BETWEEN 2 AND 120
  AND route.evidence ->> 'risk_level' IN ('LOW', 'MEDIUM', 'HIGH', 'IN_HOME')
  AND route.evidence -> 'requires_proof' = 'true'::JSONB
  AND route.evidence -> 'final_availability_confirmation_required' = 'true'::JSONB
  AND cell.effective_from <= clock_timestamp()
  AND (cell.expires_at IS NULL OR cell.expires_at > clock_timestamp())
  AND NOT EXISTS (
    SELECT 1 FROM public.universal_v1_service_cell_authorities successor
    WHERE successor.supersedes_authority_id = cell.id
  )
  AND (
    route.outcome = 'ESTIMATE_REQUIRED'
    OR (
      standardized_quote.id IS NOT NULL
      AND acceptance.id IS NOT NULL
      AND acceptance.accepted_at <= standardized_quote.valid_until
      AND readiness.id IS NOT NULL
    )
  );

REVOKE ALL ON TABLE public.universal_v1_service_cell_price_book_mappings FROM PUBLIC;
REVOKE ALL ON TABLE public.task_draft_standardized_quote_versions FROM PUBLIC;
REVOKE ALL ON TABLE public.task_draft_standardized_quote_acceptance_facts FROM PUBLIC;
REVOKE ALL ON TABLE public.task_draft_payment_method_readiness_facts FROM PUBLIC;
REVOKE ALL ON TABLE public.current_universal_v1_task_opportunities_v1 FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_standardized_quote_request_sha256(
  UUID, UUID, INTEGER, INTEGER, TEXT, BIGINT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_standardized_quote_acceptance_request_sha256(
  UUID, UUID, UUID, INTEGER, INTEGER, INTEGER, TEXT, BIGINT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_fake_payment_readiness_request_sha256(
  UUID, UUID, UUID, INTEGER, INTEGER, TEXT, BIGINT, CHAR
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_standardized_quote_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_standardized_quote_acceptance_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_fake_payment_readiness_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prevent_universal_v1_standardized_quote_fact_mutation_v1() FROM PUBLIC;

COMMENT ON TABLE public.task_draft_standardized_quote_versions IS
  'Immutable deterministic standardized-scope quote facts; not a Task, FSE, authorization, assignment, or Work Order.';
COMMENT ON TABLE public.universal_v1_service_cell_price_book_mappings IS
  'Immutable explicit nonproduction authority mapping one exact versioned service cell to one Price Book row; no customer data or financial effect.';
COMMENT ON TABLE public.task_draft_standardized_quote_acceptance_facts IS
  'Immutable Poster acceptance of one exact quote; acceptance creates no money, Task, assignment, or Work Order effect.';
COMMENT ON TABLE public.task_draft_payment_method_readiness_facts IS
  'APPLICATION_MEASURED_DB_WITNESS_ONLY nonproduction FAKE readiness; the shared database role does not authenticate the signed manifest. No network call, external value, FSE, authorization, capture, assignment, settlement, or payout.';
