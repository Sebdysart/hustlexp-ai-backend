-- HX payment-underwriting v7 D3 opportunity/privacy/eligibility contract.
--
-- This artifact is deliberately absent from the startup migration registry.
-- It adds no runtime role grant, provider call, assignment, payable, customer
-- authorization, or Financial Security Event authority.

DO $$
BEGIN
  IF to_regclass('public.payment_underwriting_lifecycles_v7') IS NULL
     OR to_regclass('public.payment_task_opportunities_v7') IS NULL
     OR to_regclass('public.payment_provider_account_refs_v7') IS NULL
     OR to_regclass('public.payment_conditional_provider_holds_v7') IS NULL THEN
    RAISE EXCEPTION 'HXPV30: accepted D2 schema artifact must be applied first'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_payment_opportunity_preview_sha256_v7(
  p_category_code TEXT,
  p_general_area_code TEXT,
  p_schedule_window_start TIMESTAMPTZ,
  p_schedule_window_end TIMESTAMPTZ,
  p_scope_summary_sha256 TEXT,
  p_requirements_sha256 TEXT,
  p_pricing_lane TEXT,
  p_gross_earnings_min_cents BIGINT,
  p_gross_earnings_max_cents BIGINT,
  p_currency TEXT
)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT encode(
    digest(
      jsonb_build_object(
        'schema', 'HX_PAYMENT_TASK_OPPORTUNITY_PREVIEW_V7',
        'categoryCode', p_category_code,
        'generalAreaCode', p_general_area_code,
        'scheduleWindowStart', to_char(p_schedule_window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'scheduleWindowEnd', to_char(p_schedule_window_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'scopeSummarySha256', p_scope_summary_sha256,
        'requirementsSha256', p_requirements_sha256,
        'pricingLane', p_pricing_lane,
        'grossEarningsMinCents', p_gross_earnings_min_cents,
        'grossEarningsMaxCents', p_gross_earnings_max_cents,
        'currency', p_currency
      )::TEXT,
      'sha256'
    ),
    'hex'
  )
$$;

CREATE OR REPLACE FUNCTION hxos_payment_opportunity_link_material_sha256_v7(
  p_opportunity_link_id UUID,
  p_opportunity_id UUID,
  p_preview_sha256 TEXT,
  p_token_sha256 TEXT,
  p_link_kind TEXT,
  p_recipient_binding_sha256 TEXT,
  p_expires_at TIMESTAMPTZ,
  p_signature_key_id TEXT
)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT encode(
    digest(
      jsonb_build_object(
        'schema', 'HX_PAYMENT_TASK_OPPORTUNITY_LINK_V7',
        'opportunityLinkId', p_opportunity_link_id,
        'opportunityId', p_opportunity_id,
        'previewSha256', p_preview_sha256,
        'tokenSha256', p_token_sha256,
        'linkKind', p_link_kind,
        'recipientBindingSha256', p_recipient_binding_sha256,
        'expiresAt', to_char(p_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'signatureKeyId', p_signature_key_id
      )::TEXT,
      'sha256'
    ),
    'hex'
  )
$$;

CREATE OR REPLACE FUNCTION hxos_payment_opportunity_link_signature_sha256_v7(
  p_link_material_sha256 TEXT
)
RETURNS TEXT
LANGUAGE SQL
STABLE
PARALLEL UNSAFE
AS $$
  SELECT encode(
    hmac(
      convert_to(p_link_material_sha256, 'UTF8'),
      convert_to(current_setting('hxp.opportunity_link_signing_secret', true), 'UTF8'),
      'sha256'
    ),
    'hex'
  )
$$;

CREATE OR REPLACE FUNCTION hxos_payment_opportunity_link_verification_sha256_v7(
  p_link_material_sha256 TEXT,
  p_signature_sha256 TEXT,
  p_signature_key_id TEXT,
  p_signature_verified_at TIMESTAMPTZ
)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT encode(
    digest(
      jsonb_build_object(
        'schema', 'HX_PAYMENT_TASK_OPPORTUNITY_LINK_SIGNATURE_VERIFICATION_V7',
        'linkMaterialSha256', p_link_material_sha256,
        'signatureSha256', p_signature_sha256,
        'signatureKeyId', p_signature_key_id,
        'signatureVerifiedAt', to_char(
          p_signature_verified_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )
      )::TEXT,
      'sha256'
    ),
    'hex'
  )
$$;

CREATE OR REPLACE FUNCTION hxos_payment_opportunity_signing_key_authority_sha256_v7(
  p_signature_key_id TEXT,
  p_algorithm TEXT,
  p_secret_sha256 TEXT,
  p_valid_from TIMESTAMPTZ,
  p_valid_until TIMESTAMPTZ
)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT encode(
    digest(
      jsonb_build_object(
        'schema', 'HX_PAYMENT_OPPORTUNITY_SIGNING_KEY_AUTHORITY_V7',
        'signatureKeyId', p_signature_key_id,
        'algorithm', p_algorithm,
        'secretSha256', p_secret_sha256,
        'validFrom', to_char(p_valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'validUntil', to_char(p_valid_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )::TEXT,
      'sha256'
    ),
    'hex'
  )
$$;

CREATE OR REPLACE FUNCTION hxos_payment_opportunity_admin_authority_sha256_v7(
  p_admin_authority_id UUID,
  p_admin_user_id UUID,
  p_opportunity_link_id UUID,
  p_reason_code TEXT,
  p_valid_from TIMESTAMPTZ,
  p_valid_until TIMESTAMPTZ,
  p_evidence_sha256 TEXT
)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT encode(
    digest(
      jsonb_build_object(
        'schema', 'HX_PAYMENT_OPPORTUNITY_ADMIN_LINK_REVOCATION_AUTHORITY_V7',
        'adminAuthorityId', p_admin_authority_id,
        'adminUserId', p_admin_user_id,
        'opportunityLinkId', p_opportunity_link_id,
        'reasonCode', p_reason_code,
        'validFrom', to_char(p_valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'validUntil', to_char(p_valid_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'evidenceSha256', p_evidence_sha256
      )::TEXT,
      'sha256'
    ),
    'hex'
  )
$$;

CREATE TABLE IF NOT EXISTS payment_task_opportunity_previews_v7 (
  preview_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID NOT NULL UNIQUE
    REFERENCES payment_task_opportunities_v7(opportunity_id) ON DELETE RESTRICT,
  category_code TEXT NOT NULL CHECK (category_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  general_area_code TEXT NOT NULL CHECK (general_area_code ~ '^[A-Z0-9][A-Z0-9_-]{1,63}$'),
  schedule_window_start TIMESTAMPTZ NOT NULL,
  schedule_window_end TIMESTAMPTZ NOT NULL,
  scope_summary_sha256 CHAR(64) NOT NULL CHECK (scope_summary_sha256 ~ '^[0-9a-f]{64}$'),
  requirements_sha256 CHAR(64) NOT NULL CHECK (requirements_sha256 ~ '^[0-9a-f]{64}$'),
  pricing_lane TEXT NOT NULL CHECK (pricing_lane IN ('PLATFORM_PRICED', 'PROVIDER_ESTIMATE')),
  gross_earnings_min_cents BIGINT NOT NULL CHECK (gross_earnings_min_cents > 0),
  gross_earnings_max_cents BIGINT NOT NULL CHECK (gross_earnings_max_cents >= gross_earnings_min_cents),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  preview_sha256 CHAR(64) NOT NULL UNIQUE CHECK (preview_sha256 ~ '^[0-9a-f]{64}$'),
  redaction_evidence_sha256 CHAR(64) NOT NULL CHECK (redaction_evidence_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (schedule_window_end > schedule_window_start)
);

CREATE TABLE IF NOT EXISTS payment_opportunity_signing_keys_v7 (
  signature_key_id TEXT PRIMARY KEY
    CHECK (signature_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  algorithm TEXT NOT NULL CHECK (algorithm = 'HMAC_SHA256'),
  secret_sha256 CHAR(64) NOT NULL UNIQUE CHECK (secret_sha256 ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state = 'ACTIVE'),
  valid_from TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ NOT NULL,
  authority_sha256 CHAR(64) NOT NULL UNIQUE CHECK (authority_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (valid_until > valid_from AND valid_until <= valid_from + INTERVAL '90 days')
);

CREATE TABLE IF NOT EXISTS payment_task_opportunity_links_v7 (
  opportunity_link_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID NOT NULL REFERENCES payment_task_opportunities_v7(opportunity_id) ON DELETE RESTRICT,
  token_sha256 CHAR(64) NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  link_kind TEXT NOT NULL CHECK (link_kind IN ('OPEN_SHARE', 'DIRECT_INVITE')),
  recipient_binding_sha256 CHAR(64) CHECK (
    recipient_binding_sha256 IS NULL OR recipient_binding_sha256 ~ '^[0-9a-f]{64}$'
  ),
  link_material_sha256 CHAR(64) NOT NULL UNIQUE CHECK (link_material_sha256 ~ '^[0-9a-f]{64}$'),
  signature_sha256 CHAR(64) NOT NULL UNIQUE CHECK (signature_sha256 ~ '^[0-9a-f]{64}$'),
  signature_key_id TEXT NOT NULL CHECK (signature_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  signature_verified_at TIMESTAMPTZ NOT NULL,
  signature_verification_sha256 CHAR(64) NOT NULL UNIQUE
    CHECK (signature_verification_sha256 ~ '^[0-9a-f]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (opportunity_link_id, opportunity_id),
  FOREIGN KEY (signature_key_id)
    REFERENCES payment_opportunity_signing_keys_v7(signature_key_id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '7 days'),
  CHECK (
    (link_kind = 'DIRECT_INVITE' AND recipient_binding_sha256 IS NOT NULL)
    OR (link_kind = 'OPEN_SHARE' AND recipient_binding_sha256 IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS payment_opportunity_admin_authorities_v7 (
  admin_authority_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  opportunity_link_id UUID NOT NULL
    REFERENCES payment_task_opportunity_links_v7(opportunity_link_id) ON DELETE RESTRICT,
  authority_kind TEXT NOT NULL CHECK (authority_kind = 'LINK_REVOCATION'),
  reason_code TEXT NOT NULL CHECK (reason_code IN ('ABUSE', 'ADMIN_REVOKED')),
  valid_from TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ NOT NULL,
  authority_sha256 CHAR(64) NOT NULL UNIQUE CHECK (authority_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_sha256 CHAR(64) NOT NULL UNIQUE CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (opportunity_link_id),
  UNIQUE (admin_authority_id, admin_user_id, opportunity_link_id, reason_code),
  CHECK (valid_until > valid_from AND valid_until <= valid_from + INTERVAL '5 minutes')
);

CREATE TABLE IF NOT EXISTS payment_task_opportunity_link_revocations_v7 (
  opportunity_link_id UUID PRIMARY KEY
    REFERENCES payment_task_opportunity_links_v7(opportunity_link_id) ON DELETE RESTRICT,
  revoked_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  admin_authority_id UUID,
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'POSTER_REVOKED', 'TASK_CHANGED', 'TASK_FILLED', 'ABUSE', 'ADMIN_REVOKED'
  )),
  revocation_material_sha256 CHAR(64) NOT NULL UNIQUE
    CHECK (revocation_material_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (admin_authority_id, revoked_by_user_id, opportunity_link_id, reason_code)
    REFERENCES payment_opportunity_admin_authorities_v7(
      admin_authority_id, admin_user_id, opportunity_link_id, reason_code
    )
    ON DELETE RESTRICT,
  CHECK (
    (reason_code IN ('POSTER_REVOKED', 'TASK_CHANGED', 'TASK_FILLED') AND admin_authority_id IS NULL)
    OR (reason_code IN ('ABUSE', 'ADMIN_REVOKED') AND admin_authority_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS payment_task_opportunity_interests_v7 (
  interest_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID NOT NULL REFERENCES payment_task_opportunities_v7(opportunity_id) ON DELETE RESTRICT,
  opportunity_link_id UUID NOT NULL,
  provider_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  interest_kind TEXT NOT NULL CHECK (interest_kind = 'EXPRESS_INTEREST'),
  availability_start TIMESTAMPTZ NOT NULL,
  availability_end TIMESTAMPTZ NOT NULL,
  acknowledged_scope_sha256 CHAR(64) NOT NULL CHECK (acknowledged_scope_sha256 ~ '^[0-9a-f]{64}$'),
  acknowledged_economics_sha256 CHAR(64) NOT NULL CHECK (acknowledged_economics_sha256 ~ '^[0-9a-f]{64}$'),
  interest_material_sha256 CHAR(64) NOT NULL UNIQUE CHECK (interest_material_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (opportunity_id, provider_user_id),
  UNIQUE (interest_id, opportunity_id, provider_user_id),
  FOREIGN KEY (opportunity_link_id, opportunity_id)
    REFERENCES payment_task_opportunity_links_v7(opportunity_link_id, opportunity_id) ON DELETE RESTRICT,
  CHECK (availability_end > availability_start)
);

CREATE TABLE IF NOT EXISTS payment_task_revalidations_v7 (
  revalidation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lifecycle_id UUID NOT NULL,
  opportunity_id UUID NOT NULL,
  interest_id UUID NOT NULL,
  provider_account_ref_id UUID NOT NULL,
  provider_user_id UUID NOT NULL,
  scope_sha256 CHAR(64) NOT NULL CHECK (scope_sha256 ~ '^[0-9a-f]{64}$'),
  economics_sha256 CHAR(64) NOT NULL CHECK (economics_sha256 ~ '^[0-9a-f]{64}$'),
  schedule_sha256 CHAR(64) NOT NULL CHECK (schedule_sha256 ~ '^[0-9a-f]{64}$'),
  task_open BOOLEAN NOT NULL,
  quote_current BOOLEAN NOT NULL,
  schedule_valid BOOLEAN NOT NULL,
  customer_proceeding BOOLEAN NOT NULL,
  provider_available BOOLEAN NOT NULL,
  scope_accepted BOOLEAN NOT NULL,
  economics_accepted BOOLEAN NOT NULL,
  category_eligible BOOLEAN NOT NULL,
  credentials_eligible BOOLEAN NOT NULL,
  trust_eligible BOOLEAN NOT NULL,
  availability_eligible BOOLEAN NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ NOT NULL,
  evidence_sha256 CHAR(64) NOT NULL UNIQUE CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (
    revalidation_id, lifecycle_id, opportunity_id, interest_id,
    provider_account_ref_id, provider_user_id
  ),
  FOREIGN KEY (opportunity_id, lifecycle_id)
    REFERENCES payment_task_opportunities_v7(opportunity_id, lifecycle_id) ON DELETE RESTRICT,
  FOREIGN KEY (interest_id, opportunity_id, provider_user_id)
    REFERENCES payment_task_opportunity_interests_v7(interest_id, opportunity_id, provider_user_id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_account_ref_id, provider_user_id)
    REFERENCES payment_provider_account_refs_v7(provider_account_ref_id, provider_user_id) ON DELETE RESTRICT,
  CHECK (valid_until > observed_at AND valid_until <= observed_at + INTERVAL '5 minutes'),
  CHECK (
    task_open AND quote_current AND schedule_valid
    AND customer_proceeding AND provider_available
    AND scope_accepted AND economics_accepted
    AND category_eligible AND credentials_eligible
    AND trust_eligible AND availability_eligible
  )
);

ALTER TABLE payment_conditional_provider_holds_v7
  ADD COLUMN IF NOT EXISTS provider_user_id UUID,
  ADD COLUMN IF NOT EXISTS interest_id UUID,
  ADD COLUMN IF NOT EXISTS revalidation_id UUID;

ALTER TABLE payment_conditional_provider_holds_v7
  ALTER COLUMN provider_user_id SET NOT NULL,
  ALTER COLUMN interest_id SET NOT NULL,
  ALTER COLUMN revalidation_id SET NOT NULL;

ALTER TABLE payment_conditional_provider_holds_v7
  DROP CONSTRAINT IF EXISTS payment_conditional_provider_holds_v7_state_d3_ck,
  ADD CONSTRAINT payment_conditional_provider_holds_v7_state_d3_ck CHECK (state = 'SOFT_RESERVED'),
  DROP CONSTRAINT IF EXISTS payment_conditional_provider_holds_v7_ttl_d3_ck,
  ADD CONSTRAINT payment_conditional_provider_holds_v7_ttl_d3_ck CHECK (
    expires_at > accepted_at AND expires_at <= accepted_at + INTERVAL '15 minutes'
  ),
  DROP CONSTRAINT IF EXISTS payment_conditional_provider_holds_v7_interest_d3_fk,
  ADD CONSTRAINT payment_conditional_provider_holds_v7_interest_d3_fk
    FOREIGN KEY (interest_id, opportunity_id, provider_user_id)
    REFERENCES payment_task_opportunity_interests_v7(interest_id, opportunity_id, provider_user_id)
    ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS payment_conditional_provider_holds_v7_revalidation_d3_fk,
  ADD CONSTRAINT payment_conditional_provider_holds_v7_revalidation_d3_fk
    FOREIGN KEY (
      revalidation_id, lifecycle_id, opportunity_id, interest_id,
      provider_account_ref_id, provider_user_id
    ) REFERENCES payment_task_revalidations_v7(
      revalidation_id, lifecycle_id, opportunity_id, interest_id,
      provider_account_ref_id, provider_user_id
    ) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS payment_conditional_provider_hold_events_v7 (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hold_id UUID NOT NULL REFERENCES payment_conditional_provider_holds_v7(hold_id) ON DELETE RESTRICT,
  sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
  prior_event_id UUID REFERENCES payment_conditional_provider_hold_events_v7(event_id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('SOFT_RESERVED', 'RELEASED', 'EXPIRED')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('PROVIDER', 'POSTER', 'SYSTEM')),
  actor_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  event_material_sha256 CHAR(64) NOT NULL UNIQUE CHECK (event_material_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (hold_id, sequence_number),
  CHECK (
    (actor_type IN ('PROVIDER', 'POSTER') AND actor_user_id IS NOT NULL)
    OR (actor_type = 'SYSTEM' AND actor_user_id IS NULL)
  )
);

CREATE OR REPLACE FUNCTION hxos_reject_payment_underwriting_d3_mutation_v7()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'HXPV31: payment underwriting D3 evidence is append-only'
    USING ERRCODE = 'P0001';
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_opportunity_signing_key_v7()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
  v_authority_sha256 TEXT;
BEGIN
  v_authority_sha256 := hxos_payment_opportunity_signing_key_authority_sha256_v7(
    NEW.signature_key_id,
    NEW.algorithm,
    NEW.secret_sha256::TEXT,
    NEW.valid_from,
    NEW.valid_until
  );
  IF NEW.created_at < v_now - INTERVAL '5 seconds'
     OR NEW.created_at > v_now + INTERVAL '5 seconds'
     OR NEW.valid_from > v_now + INTERVAL '5 seconds'
     OR NEW.valid_until <= v_now
     OR NEW.authority_sha256::TEXT IS DISTINCT FROM v_authority_sha256 THEN
    RAISE EXCEPTION 'HXPV45: opportunity signing key is not currently authorized'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_opportunity_admin_authority_v7()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
  v_authority_sha256 TEXT;
BEGIN
  v_authority_sha256 := hxos_payment_opportunity_admin_authority_sha256_v7(
    NEW.admin_authority_id,
    NEW.admin_user_id,
    NEW.opportunity_link_id,
    NEW.reason_code,
    NEW.valid_from,
    NEW.valid_until,
    NEW.evidence_sha256::TEXT
  );
  PERFORM 1
    FROM admin_roles
   WHERE user_id = NEW.admin_user_id
     AND role IN ('admin', 'founder')
   FOR SHARE;
  IF NOT FOUND
     OR NEW.created_at < v_now - INTERVAL '5 seconds'
     OR NEW.created_at > v_now + INTERVAL '5 seconds'
     OR NEW.valid_from > v_now + INTERVAL '5 seconds'
     OR NEW.valid_until <= v_now
     OR NEW.authority_sha256::TEXT IS DISTINCT FROM v_authority_sha256 THEN
    RAISE EXCEPTION 'HXPV46: opportunity administrator authority is not current'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_task_opportunity_v7()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_stage TEXT;
BEGIN
  PERFORM 1
    FROM payment_underwriting_lifecycles_v7
   WHERE lifecycle_id = NEW.lifecycle_id
   FOR UPDATE;
  SELECT stage INTO v_stage
    FROM payment_underwriting_lifecycle_events_v7
   WHERE lifecycle_id = NEW.lifecycle_id
   ORDER BY sequence_number DESC
   LIMIT 1;
  IF v_stage IS DISTINCT FROM 'PROVIDER_SOURCING'
     OR NEW.state <> 'OPEN'
     OR NEW.expires_at <= clock_timestamp()
     OR NEW.expires_at > clock_timestamp() + INTERVAL '7 days' THEN
    RAISE EXCEPTION 'HXPV32: opportunity requires a current PROVIDER_SOURCING lifecycle'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_opportunity_preview_v7()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_opportunity payment_task_opportunities_v7%ROWTYPE;
  v_sha256 TEXT;
BEGIN
  SELECT * INTO v_opportunity
    FROM payment_task_opportunities_v7
   WHERE opportunity_id = NEW.opportunity_id
   FOR UPDATE;
  v_sha256 := hxos_payment_opportunity_preview_sha256_v7(
    NEW.category_code,
    NEW.general_area_code,
    NEW.schedule_window_start,
    NEW.schedule_window_end,
    NEW.scope_summary_sha256::TEXT,
    NEW.requirements_sha256::TEXT,
    NEW.pricing_lane,
    NEW.gross_earnings_min_cents,
    NEW.gross_earnings_max_cents,
    NEW.currency::TEXT
  );
  IF NOT FOUND
     OR NEW.pricing_lane IS DISTINCT FROM (
       SELECT pricing_lane FROM payment_underwriting_lifecycles_v7
        WHERE lifecycle_id = v_opportunity.lifecycle_id
     )
     OR NEW.preview_sha256::TEXT IS DISTINCT FROM v_sha256
     OR v_opportunity.preview_sha256::TEXT IS DISTINCT FROM v_sha256 THEN
    RAISE EXCEPTION 'HXPV33: preview is not the exact redacted opportunity material'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_opportunity_link_v7()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_opportunity payment_task_opportunities_v7%ROWTYPE;
  v_key payment_opportunity_signing_keys_v7%ROWTYPE;
  v_link_material_sha256 TEXT;
  v_signature_sha256 TEXT;
  v_signature_verification_sha256 TEXT;
  v_stage TEXT;
  v_now TIMESTAMPTZ := clock_timestamp();
  v_recent_count INTEGER;
BEGIN
  SELECT * INTO v_opportunity
    FROM payment_task_opportunities_v7
   WHERE opportunity_id = NEW.opportunity_id
   FOR UPDATE;
  PERFORM 1 FROM payment_underwriting_lifecycles_v7
   WHERE lifecycle_id = v_opportunity.lifecycle_id
   FOR UPDATE;
  SELECT stage INTO v_stage
    FROM payment_underwriting_lifecycle_events_v7
   WHERE lifecycle_id = v_opportunity.lifecycle_id
   ORDER BY sequence_number DESC
   LIMIT 1;
  SELECT * INTO v_key
    FROM payment_opportunity_signing_keys_v7
   WHERE signature_key_id = NEW.signature_key_id
   FOR SHARE;
  v_link_material_sha256 := hxos_payment_opportunity_link_material_sha256_v7(
    NEW.opportunity_link_id,
    NEW.opportunity_id,
    v_opportunity.preview_sha256::TEXT,
    NEW.token_sha256::TEXT,
    NEW.link_kind,
    NEW.recipient_binding_sha256::TEXT,
    NEW.expires_at,
    NEW.signature_key_id
  );
  v_signature_sha256 := hxos_payment_opportunity_link_signature_sha256_v7(
    v_link_material_sha256
  );
  v_signature_verification_sha256 := hxos_payment_opportunity_link_verification_sha256_v7(
    v_link_material_sha256,
    NEW.signature_sha256::TEXT,
    NEW.signature_key_id,
    NEW.signature_verified_at
  );
  IF v_opportunity.opportunity_id IS NULL
     OR v_opportunity.state <> 'OPEN'
     OR v_stage IS DISTINCT FROM 'PROVIDER_SOURCING'
     OR v_opportunity.expires_at <= v_now
     OR NEW.expires_at > v_opportunity.expires_at
     OR NEW.created_at < v_now - INTERVAL '5 seconds'
     OR NEW.created_at > v_now + INTERVAL '5 seconds'
     OR NEW.signature_verified_at < v_now - INTERVAL '5 minutes'
     OR NEW.signature_verified_at > v_now + INTERVAL '5 seconds'
     OR v_key.signature_key_id IS NULL
     OR v_key.state <> 'ACTIVE'
     OR v_key.algorithm <> 'HMAC_SHA256'
     OR v_key.valid_from > NEW.signature_verified_at
     OR v_key.valid_until <= NEW.signature_verified_at
     OR v_key.valid_from > v_now
     OR v_key.valid_until <= v_now
     OR octet_length(
       current_setting('hxp.opportunity_link_signing_secret', true)
     ) < 32
     OR encode(
       digest(
         current_setting('hxp.opportunity_link_signing_secret', true),
         'sha256'
       ),
       'hex'
     ) IS DISTINCT FROM v_key.secret_sha256::TEXT
     OR NEW.link_material_sha256::TEXT IS DISTINCT FROM v_link_material_sha256
     OR NEW.signature_sha256::TEXT IS DISTINCT FROM v_signature_sha256
     OR NEW.signature_verification_sha256::TEXT IS DISTINCT FROM v_signature_verification_sha256
     OR NOT EXISTS (
       SELECT 1 FROM payment_task_opportunity_previews_v7
        WHERE opportunity_id = NEW.opportunity_id
          AND preview_sha256 = v_opportunity.preview_sha256
     ) THEN
    RAISE EXCEPTION 'HXPV34: link requires an open, current, redacted opportunity'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT count(*) INTO v_recent_count
    FROM payment_task_opportunity_links_v7
   WHERE opportunity_id = NEW.opportunity_id
     AND created_at > clock_timestamp() - INTERVAL '1 hour';
  IF v_recent_count >= 20 THEN
    RAISE EXCEPTION 'HXPV35: opportunity link issuance rate exceeded'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_opportunity_link_revocation_v7()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_admin_authority payment_opportunity_admin_authorities_v7%ROWTYPE;
  v_admin_role TEXT;
  v_poster_id UUID;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT d.poster_user_id INTO v_poster_id
    FROM payment_task_opportunity_links_v7 link
    JOIN payment_task_opportunities_v7 opportunity
      ON opportunity.opportunity_id = link.opportunity_id
    JOIN payment_underwriting_lifecycles_v7 lifecycle
      ON lifecycle.lifecycle_id = opportunity.lifecycle_id
    JOIN task_drafts d ON d.id = lifecycle.task_draft_id
   WHERE link.opportunity_link_id = NEW.opportunity_link_id
   FOR UPDATE OF link;
  IF NEW.admin_authority_id IS NOT NULL THEN
    SELECT * INTO v_admin_authority
      FROM payment_opportunity_admin_authorities_v7
     WHERE admin_authority_id = NEW.admin_authority_id
       AND admin_user_id = NEW.revoked_by_user_id
       AND opportunity_link_id = NEW.opportunity_link_id
       AND reason_code = NEW.reason_code
     FOR SHARE;
    SELECT role INTO v_admin_role
      FROM admin_roles
     WHERE user_id = NEW.revoked_by_user_id
     FOR SHARE;
  END IF;
  IF v_poster_id IS NULL
     OR (
       NEW.reason_code IN ('POSTER_REVOKED', 'TASK_CHANGED', 'TASK_FILLED')
       AND NEW.revoked_by_user_id IS DISTINCT FROM v_poster_id
     )
     OR (
       NEW.reason_code IN ('ABUSE', 'ADMIN_REVOKED')
       AND (
         v_admin_authority.admin_authority_id IS NULL
         OR v_admin_authority.authority_kind <> 'LINK_REVOCATION'
         OR v_admin_authority.valid_from > NEW.revoked_at
         OR v_admin_authority.valid_until <= NEW.revoked_at
         OR v_admin_authority.valid_from > v_now
         OR v_admin_authority.valid_until <= v_now
         OR v_admin_role IS NULL
         OR v_admin_role NOT IN ('admin', 'founder')
       )
     )
     OR NEW.revoked_at < v_now - INTERVAL '5 minutes'
     OR NEW.revoked_at > v_now + INTERVAL '5 seconds' THEN
    RAISE EXCEPTION 'HXPV43: opportunity-link revocation lacks exact actor authority'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_opportunity_interest_v7()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_link payment_task_opportunity_links_v7%ROWTYPE;
  v_opportunity payment_task_opportunities_v7%ROWTYPE;
  v_poster_id UUID;
  v_stage TEXT;
BEGIN
  SELECT * INTO v_link
    FROM payment_task_opportunity_links_v7
   WHERE opportunity_link_id = NEW.opportunity_link_id
     AND opportunity_id = NEW.opportunity_id
   FOR UPDATE;
  SELECT * INTO v_opportunity
    FROM payment_task_opportunities_v7
   WHERE opportunity_id = NEW.opportunity_id
   FOR UPDATE;
  SELECT d.poster_user_id INTO v_poster_id
    FROM payment_underwriting_lifecycles_v7 l
    JOIN task_drafts d ON d.id = l.task_draft_id
   WHERE l.lifecycle_id = v_opportunity.lifecycle_id;
  PERFORM 1
    FROM payment_underwriting_lifecycles_v7
   WHERE lifecycle_id = v_opportunity.lifecycle_id
   FOR UPDATE;
  SELECT stage INTO v_stage
    FROM payment_underwriting_lifecycle_events_v7
   WHERE lifecycle_id = v_opportunity.lifecycle_id
   ORDER BY sequence_number DESC
   LIMIT 1;
  IF v_link.opportunity_link_id IS NULL
     OR v_opportunity.opportunity_id IS NULL
     OR v_stage IS DISTINCT FROM 'PROVIDER_SOURCING'
     OR v_opportunity.state <> 'OPEN'
     OR v_opportunity.expires_at <= clock_timestamp()
     OR v_link.expires_at <= clock_timestamp()
     OR EXISTS (
       SELECT 1 FROM payment_task_opportunity_link_revocations_v7
        WHERE opportunity_link_id = NEW.opportunity_link_id
     )
     OR NEW.provider_user_id = v_poster_id
     OR NEW.acknowledged_scope_sha256 IS DISTINCT FROM v_opportunity.scope_sha256
     OR NEW.acknowledged_economics_sha256 IS DISTINCT FROM v_opportunity.economics_corridor_sha256
     OR NEW.availability_end <= clock_timestamp()
     OR (
       v_link.link_kind = 'DIRECT_INVITE'
       AND v_link.recipient_binding_sha256 IS DISTINCT FROM
         encode(digest(NEW.provider_user_id::TEXT, 'sha256'), 'hex')
     ) THEN
    RAISE EXCEPTION 'HXPV36: Express Interest is not bound to a current redacted opportunity'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_task_revalidation_v7()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_opportunity payment_task_opportunities_v7%ROWTYPE;
  v_interest payment_task_opportunity_interests_v7%ROWTYPE;
  v_provider payment_provider_account_refs_v7%ROWTYPE;
  v_now TIMESTAMPTZ := clock_timestamp();
  v_stage TEXT;
BEGIN
  SELECT * INTO v_opportunity FROM payment_task_opportunities_v7
   WHERE opportunity_id = NEW.opportunity_id AND lifecycle_id = NEW.lifecycle_id
   FOR UPDATE;
  SELECT * INTO v_interest FROM payment_task_opportunity_interests_v7
   WHERE interest_id = NEW.interest_id
     AND opportunity_id = NEW.opportunity_id
     AND provider_user_id = NEW.provider_user_id
   FOR UPDATE;
  SELECT * INTO v_provider FROM payment_provider_account_refs_v7
   WHERE provider_account_ref_id = NEW.provider_account_ref_id
     AND provider_user_id = NEW.provider_user_id
   FOR UPDATE;
  SELECT stage INTO v_stage FROM payment_underwriting_lifecycle_status_v7
   WHERE lifecycle_id = NEW.lifecycle_id;
  IF v_opportunity.opportunity_id IS NULL
     OR v_interest.interest_id IS NULL
     OR v_provider.provider_account_ref_id IS NULL
     OR v_stage IS DISTINCT FROM 'PAYMENT_ELIGIBLE'
     OR v_opportunity.state <> 'OPEN'
     OR v_opportunity.expires_at <= NEW.observed_at
     OR v_provider.eligibility_state <> 'ELIGIBLE'
     OR v_provider.funding_state <> 'READY'
     OR v_provider.bank_reference_sha256 IS NULL
     OR NEW.observed_at < v_now - INTERVAL '5 minutes'
     OR NEW.observed_at > v_now + INTERVAL '5 seconds'
     OR NEW.valid_until <= v_now
     OR v_provider.observed_at < NEW.observed_at - INTERVAL '5 minutes'
     OR v_provider.observed_at > NEW.observed_at + INTERVAL '5 seconds'
     OR v_provider.expires_at <= NEW.observed_at
     OR v_provider.expires_at <= v_now
     OR v_provider.expires_at < NEW.valid_until
     OR v_provider.merchant_capabilities->>'paymentEligible' IS DISTINCT FROM 'true'
     OR v_provider.merchant_capabilities->>'merchantContextApproved' IS DISTINCT FROM 'true'
     OR v_provider.merchant_capabilities->>'blockingRestrictions' IS DISTINCT FROM 'false'
     OR NEW.scope_sha256 IS DISTINCT FROM v_opportunity.scope_sha256
     OR NEW.economics_sha256 IS DISTINCT FROM v_opportunity.economics_corridor_sha256 THEN
    RAISE EXCEPTION 'HXPV37: provider/task eligibility evidence is incomplete or stale'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_conditional_provider_hold_v7()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_revalidation payment_task_revalidations_v7%ROWTYPE;
  v_provider payment_provider_account_refs_v7%ROWTYPE;
  v_now TIMESTAMPTZ := clock_timestamp();
  v_stage TEXT;
BEGIN
  PERFORM 1 FROM payment_task_opportunities_v7
   WHERE opportunity_id = NEW.opportunity_id
     AND lifecycle_id = NEW.lifecycle_id
     AND state = 'OPEN'
     AND expires_at > NEW.accepted_at
     AND expires_at >= NEW.expires_at
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXPV38: soft hold requires an open current opportunity'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_revalidation FROM payment_task_revalidations_v7
   WHERE revalidation_id = NEW.revalidation_id
     AND lifecycle_id = NEW.lifecycle_id
     AND opportunity_id = NEW.opportunity_id
     AND interest_id = NEW.interest_id
     AND provider_account_ref_id = NEW.provider_account_ref_id
     AND provider_user_id = NEW.provider_user_id
   FOR UPDATE;
  SELECT * INTO v_provider FROM payment_provider_account_refs_v7
   WHERE provider_account_ref_id = NEW.provider_account_ref_id
     AND provider_user_id = NEW.provider_user_id
   FOR SHARE;
  SELECT stage INTO v_stage FROM payment_underwriting_lifecycle_status_v7
   WHERE lifecycle_id = NEW.lifecycle_id;
  IF v_revalidation.revalidation_id IS NULL
     OR v_stage IS DISTINCT FROM 'PAYMENT_ELIGIBLE'
     OR NEW.accepted_at < v_now - INTERVAL '5 seconds'
     OR NEW.accepted_at > v_now + INTERVAL '5 seconds'
     OR NEW.expires_at <= v_now
     OR v_revalidation.observed_at > NEW.accepted_at + INTERVAL '5 seconds'
     OR v_revalidation.valid_until <= NEW.accepted_at
     OR v_provider.provider_account_ref_id IS NULL
     OR v_provider.expires_at <= NEW.accepted_at
     OR v_provider.expires_at < NEW.expires_at
     OR NEW.scope_sha256 IS DISTINCT FROM v_revalidation.scope_sha256
     OR NEW.provider_economics_sha256 IS DISTINCT FROM v_revalidation.economics_sha256
     OR NEW.schedule_sha256 IS DISTINCT FROM v_revalidation.schedule_sha256
     OR EXISTS (
       SELECT 1 FROM payment_conditional_provider_hold_status_v7
        WHERE opportunity_id = NEW.opportunity_id AND state = 'SOFT_RESERVED'
     ) THEN
    RAISE EXCEPTION 'HXPV39: soft hold lacks exact fresh provider/task authority'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_conditional_hold_event_v7()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_hold payment_conditional_provider_holds_v7%ROWTYPE;
  v_latest payment_conditional_provider_hold_events_v7%ROWTYPE;
  v_poster_id UUID;
BEGIN
  SELECT * INTO v_hold FROM payment_conditional_provider_holds_v7
   WHERE hold_id = NEW.hold_id FOR UPDATE;
  IF v_hold.hold_id IS NULL THEN
    RAISE EXCEPTION 'HXPV40: hold event lacks a hold'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT d.poster_user_id INTO v_poster_id
    FROM payment_underwriting_lifecycles_v7 lifecycle
    JOIN task_drafts d ON d.id = lifecycle.task_draft_id
   WHERE lifecycle.lifecycle_id = v_hold.lifecycle_id;
  IF (NEW.actor_type = 'PROVIDER' AND NEW.actor_user_id IS DISTINCT FROM v_hold.provider_user_id)
     OR (NEW.actor_type = 'POSTER' AND NEW.actor_user_id IS DISTINCT FROM v_poster_id)
     OR NEW.actor_type NOT IN ('PROVIDER', 'POSTER', 'SYSTEM') THEN
    RAISE EXCEPTION 'HXPV44: conditional-hold actor is not bound to the hold'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_latest FROM payment_conditional_provider_hold_events_v7
   WHERE hold_id = NEW.hold_id ORDER BY sequence_number DESC LIMIT 1 FOR UPDATE;
  IF v_latest.event_id IS NULL THEN
    IF NEW.sequence_number <> 1
       OR NEW.prior_event_id IS NOT NULL
       OR NEW.event_type <> 'SOFT_RESERVED' THEN
      RAISE EXCEPTION 'HXPV41: hold history must begin at SOFT_RESERVED'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.sequence_number <> v_latest.sequence_number + 1
     OR NEW.prior_event_id IS DISTINCT FROM v_latest.event_id
     OR v_latest.event_type <> 'SOFT_RESERVED'
     OR NEW.event_type NOT IN ('RELEASED', 'EXPIRED') THEN
    RAISE EXCEPTION 'HXPV42: invalid conditional-hold transition'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_record_initial_conditional_hold_event_v7()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO payment_conditional_provider_hold_events_v7(
    hold_id, sequence_number, event_type, actor_type,
    event_material_sha256, evidence_sha256
  ) VALUES (
    NEW.hold_id, 1, 'SOFT_RESERVED', 'SYSTEM',
    encode(digest(NEW.hold_id::TEXT || ':SOFT_RESERVED', 'sha256'), 'hex'),
    NEW.evidence_sha256
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE VIEW payment_conditional_provider_hold_status_v7
WITH (security_barrier = true, security_invoker = true)
AS
SELECT DISTINCT ON (h.hold_id)
  h.hold_id,
  h.lifecycle_id,
  h.opportunity_id,
  h.provider_account_ref_id,
  h.provider_user_id,
  h.interest_id,
  h.revalidation_id,
  e.event_id,
  e.sequence_number,
  e.event_type AS state,
  h.expires_at,
  e.created_at AS state_recorded_at
FROM payment_conditional_provider_holds_v7 h
JOIN payment_conditional_provider_hold_events_v7 e ON e.hold_id = h.hold_id
ORDER BY h.hold_id, e.sequence_number DESC;

DROP TRIGGER IF EXISTS payment_task_opportunity_insert_guard_v7
  ON payment_task_opportunities_v7;
CREATE TRIGGER payment_task_opportunity_insert_guard_v7
BEFORE INSERT ON payment_task_opportunities_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_task_opportunity_v7();

DROP TRIGGER IF EXISTS payment_opportunity_signing_key_insert_guard_v7
  ON payment_opportunity_signing_keys_v7;
CREATE TRIGGER payment_opportunity_signing_key_insert_guard_v7
BEFORE INSERT ON payment_opportunity_signing_keys_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_opportunity_signing_key_v7();

DROP TRIGGER IF EXISTS payment_opportunity_admin_authority_insert_guard_v7
  ON payment_opportunity_admin_authorities_v7;
CREATE TRIGGER payment_opportunity_admin_authority_insert_guard_v7
BEFORE INSERT ON payment_opportunity_admin_authorities_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_opportunity_admin_authority_v7();

DROP TRIGGER IF EXISTS payment_opportunity_preview_insert_guard_v7
  ON payment_task_opportunity_previews_v7;
CREATE TRIGGER payment_opportunity_preview_insert_guard_v7
BEFORE INSERT ON payment_task_opportunity_previews_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_opportunity_preview_v7();

DROP TRIGGER IF EXISTS payment_opportunity_link_insert_guard_v7
  ON payment_task_opportunity_links_v7;
CREATE TRIGGER payment_opportunity_link_insert_guard_v7
BEFORE INSERT ON payment_task_opportunity_links_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_opportunity_link_v7();

DROP TRIGGER IF EXISTS payment_opportunity_link_revocation_insert_guard_v7
  ON payment_task_opportunity_link_revocations_v7;
CREATE TRIGGER payment_opportunity_link_revocation_insert_guard_v7
BEFORE INSERT ON payment_task_opportunity_link_revocations_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_opportunity_link_revocation_v7();

DROP TRIGGER IF EXISTS payment_opportunity_interest_insert_guard_v7
  ON payment_task_opportunity_interests_v7;
CREATE TRIGGER payment_opportunity_interest_insert_guard_v7
BEFORE INSERT ON payment_task_opportunity_interests_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_opportunity_interest_v7();

DROP TRIGGER IF EXISTS payment_task_revalidation_insert_guard_v7
  ON payment_task_revalidations_v7;
CREATE TRIGGER payment_task_revalidation_insert_guard_v7
BEFORE INSERT ON payment_task_revalidations_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_task_revalidation_v7();

DROP TRIGGER IF EXISTS payment_conditional_provider_hold_insert_guard_v7
  ON payment_conditional_provider_holds_v7;
CREATE TRIGGER payment_conditional_provider_hold_insert_guard_v7
BEFORE INSERT ON payment_conditional_provider_holds_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_conditional_provider_hold_v7();

DROP TRIGGER IF EXISTS payment_conditional_hold_event_insert_guard_v7
  ON payment_conditional_provider_hold_events_v7;
CREATE TRIGGER payment_conditional_hold_event_insert_guard_v7
BEFORE INSERT ON payment_conditional_provider_hold_events_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_conditional_hold_event_v7();

DROP TRIGGER IF EXISTS payment_conditional_hold_initial_event_v7
  ON payment_conditional_provider_holds_v7;
CREATE TRIGGER payment_conditional_hold_initial_event_v7
AFTER INSERT ON payment_conditional_provider_holds_v7
FOR EACH ROW EXECUTE FUNCTION hxos_record_initial_conditional_hold_event_v7();

DO $$
DECLARE
  relation_name TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'payment_task_opportunity_previews_v7',
    'payment_opportunity_signing_keys_v7',
    'payment_task_opportunity_links_v7',
    'payment_opportunity_admin_authorities_v7',
    'payment_task_opportunity_link_revocations_v7',
    'payment_task_opportunity_interests_v7',
    'payment_task_revalidations_v7',
    'payment_conditional_provider_hold_events_v7'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', relation_name || '_append_only_v7', relation_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION hxos_reject_payment_underwriting_d3_mutation_v7()',
      relation_name || '_append_only_v7',
      relation_name
    );
  END LOOP;
END;
$$;

REVOKE ALL ON TABLE
  payment_task_opportunity_previews_v7,
  payment_opportunity_signing_keys_v7,
  payment_task_opportunity_links_v7,
  payment_opportunity_admin_authorities_v7,
  payment_task_opportunity_link_revocations_v7,
  payment_task_opportunity_interests_v7,
  payment_task_revalidations_v7,
  payment_conditional_provider_hold_events_v7,
  payment_conditional_provider_hold_status_v7
FROM PUBLIC;

REVOKE ALL ON FUNCTION hxos_payment_opportunity_preview_sha256_v7(
  TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, BIGINT, BIGINT, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_payment_opportunity_link_material_sha256_v7(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_payment_opportunity_link_signature_sha256_v7(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_payment_opportunity_link_verification_sha256_v7(
  TEXT, TEXT, TEXT, TIMESTAMPTZ
) FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_payment_opportunity_signing_key_authority_sha256_v7(
  TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_payment_opportunity_admin_authority_sha256_v7(
  UUID, UUID, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_reject_payment_underwriting_d3_mutation_v7() FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_enforce_payment_opportunity_signing_key_v7() FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_enforce_payment_opportunity_admin_authority_v7() FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_enforce_payment_task_opportunity_v7() FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_enforce_payment_opportunity_preview_v7() FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_enforce_payment_opportunity_link_v7() FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_enforce_payment_opportunity_link_revocation_v7() FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_enforce_payment_opportunity_interest_v7() FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_enforce_payment_task_revalidation_v7() FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_enforce_payment_conditional_provider_hold_v7() FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_enforce_payment_conditional_hold_event_v7() FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_record_initial_conditional_hold_event_v7() FROM PUBLIC;
