-- HX payment-underwriting v7 D4: Financial Security Event operation authority,
-- idempotency, provider observation, authenticated webhook agreement, and
-- lifecycle barriers. This remains an unregistered schema artifact: it grants
-- no runtime authority and performs no processor operation.

DO $$
DECLARE
  v_d4_catalog_complete BOOLEAN;
  v_d4_catalog_absent BOOLEAN;
  v_invalid_authority_count BIGINT := 0;
  v_invalid_operation_count BIGINT := 0;
  v_invalid_observation_count BIGINT := 0;
  v_pre_d5_consumed_hold_count BIGINT := 0;
BEGIN
  IF to_regclass('public.payment_financial_security_events_v7') IS NULL
     OR to_regclass('public.payment_conditional_provider_hold_events_v7') IS NULL
     OR to_regclass('public.payment_task_revalidations_v7') IS NULL
     OR to_regclass('public.payment_webhook_inbox_v7') IS NULL THEN
    RAISE EXCEPTION 'HXPV45: D4 requires the accepted D2 and D3 schema artifacts'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT
    to_regclass('public.payment_financial_security_authorities_v7') IS NOT NULL
    AND to_regclass('public.payment_financial_security_operation_observations_v7') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM pg_attribute
       WHERE attrelid = 'public.payment_financial_security_events_v7'::regclass
         AND attname = 'payment_financial_security_authority_id'
         AND NOT attisdropped
    )
    AND EXISTS (
      SELECT 1 FROM pg_attribute
       WHERE attrelid = 'public.payment_financial_security_events_v7'::regclass
         AND attname = 'expires_at'
         AND NOT attisdropped
    )
    AND EXISTS (
      SELECT 1 FROM pg_attribute
       WHERE attrelid = 'public.payment_financial_security_events_v7'::regclass
         AND attname = 'operation_material_sha256'
         AND NOT attisdropped
    )
    AND EXISTS (
      SELECT 1 FROM pg_attribute
       WHERE attrelid = 'public.payment_webhook_inbox_v7'::regclass
         AND attname = 'authentication_evidence_sha256'
         AND NOT attisdropped
    )
    AND EXISTS (
      SELECT 1 FROM pg_attribute
       WHERE attrelid = 'public.payment_webhook_inbox_v7'::regclass
         AND attname = 'signature_verified_at'
         AND NOT attisdropped
    )
  INTO v_d4_catalog_complete;

  SELECT
    to_regclass('public.payment_financial_security_authorities_v7') IS NULL
    AND to_regclass('public.payment_financial_security_operation_observations_v7') IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM pg_attribute
       WHERE attrelid = 'public.payment_financial_security_events_v7'::regclass
         AND attname IN (
           'payment_financial_security_authority_id',
           'expires_at',
           'operation_material_sha256'
         )
         AND NOT attisdropped
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_attribute
       WHERE attrelid = 'public.payment_webhook_inbox_v7'::regclass
         AND attname IN ('authentication_evidence_sha256', 'signature_verified_at')
         AND NOT attisdropped
    )
  INTO v_d4_catalog_absent;

  IF NOT v_d4_catalog_complete AND NOT v_d4_catalog_absent THEN
    RAISE EXCEPTION 'HXPV45: D4 catalog is partial or contradictory'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_d4_catalog_complete THEN
    SELECT count(*)
      INTO v_invalid_authority_count
      FROM payment_financial_security_authorities_v7 authority
      JOIN payment_conditional_provider_holds_v7 hold
        ON hold.hold_id = authority.hold_id
       AND hold.lifecycle_id = authority.lifecycle_id
       AND hold.provider_account_ref_id = authority.provider_account_ref_id
      JOIN payment_provider_account_refs_v7 provider
        ON provider.provider_account_ref_id = authority.provider_account_ref_id
       AND provider.processor_code = authority.processor_code
     WHERE authority.approved_at < hold.accepted_at
        OR authority.expires_at > hold.expires_at
        OR authority.expires_at > provider.expires_at;

    SELECT count(*)
      INTO v_invalid_operation_count
      FROM payment_financial_security_events_v7 operation
      JOIN payment_financial_security_authorities_v7 authority
        ON authority.payment_financial_security_authority_id =
           operation.payment_financial_security_authority_id
      JOIN payment_conditional_provider_holds_v7 hold
        ON hold.hold_id = operation.hold_id
       AND hold.lifecycle_id = operation.lifecycle_id
       AND hold.provider_account_ref_id = operation.provider_account_ref_id
     WHERE operation.created_at < authority.approved_at
        OR operation.created_at > authority.expires_at
        OR operation.expires_at > authority.expires_at
        OR operation.created_at > hold.expires_at
        OR operation.expires_at > hold.expires_at;

    SELECT count(*)
      INTO v_invalid_observation_count
      FROM payment_financial_security_operation_observations_v7 observation
      JOIN payment_financial_security_events_v7 operation
        ON operation.financial_security_event_id = observation.financial_security_event_id
       AND operation.lifecycle_id = observation.lifecycle_id
       AND operation.operation_id = observation.operation_id
       AND operation.processor_code = observation.processor_code
      JOIN payment_conditional_provider_holds_v7 hold
        ON hold.hold_id = operation.hold_id
       AND hold.lifecycle_id = operation.lifecycle_id
       AND hold.provider_account_ref_id = operation.provider_account_ref_id
     WHERE observation.observed_at < operation.created_at
        OR observation.observed_at > operation.expires_at
        OR observation.provider_expires_at > operation.expires_at
        OR observation.observed_at > hold.expires_at
        OR observation.provider_expires_at > hold.expires_at;

    SELECT count(*)
      INTO v_pre_d5_consumed_hold_count
      FROM payment_conditional_provider_hold_events_v7 hold_event
      JOIN payment_conditional_provider_holds_v7 hold
        ON hold.hold_id = hold_event.hold_id
     WHERE hold_event.event_type = 'CONSUMED'
       AND NOT EXISTS (
         SELECT 1
           FROM payment_financial_security_events_v7 operation
           JOIN payment_canonical_work_orders_v7 work_order
             ON work_order.financial_security_event_id = operation.financial_security_event_id
            AND work_order.lifecycle_id = operation.lifecycle_id
          WHERE operation.hold_id = hold.hold_id
            AND operation.lifecycle_id = hold.lifecycle_id
       );

    IF v_invalid_authority_count <> 0
       OR v_invalid_operation_count <> 0
       OR v_invalid_observation_count <> 0
       OR v_pre_d5_consumed_hold_count <> 0 THEN
      RAISE EXCEPTION
        'HXPV45: D4 populated upgrade violates successor invariants: authorities=%, operations=%, observations=%, consumed_without_work_order=%',
        v_invalid_authority_count,
        v_invalid_operation_count,
        v_invalid_observation_count,
        v_pre_d5_consumed_hold_count
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF v_d4_catalog_absent
     AND (
       EXISTS (SELECT 1 FROM payment_financial_security_events_v7)
       OR EXISTS (SELECT 1 FROM payment_webhook_inbox_v7)
     ) THEN
    RAISE EXCEPTION 'HXPV45: D4 cannot retrofit unbound FSE or webhook evidence'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS payment_financial_security_authorities_v7 (
  payment_financial_security_authority_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lifecycle_id UUID NOT NULL,
  task_draft_id UUID NOT NULL,
  customer_user_id UUID NOT NULL,
  approved_by_user_id UUID NOT NULL,
  hold_id UUID NOT NULL,
  provider_account_ref_id UUID NOT NULL,
  payment_method_ref_id UUID NOT NULL,
  processor_code TEXT NOT NULL CHECK (processor_code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  merchant_context_sha256 CHAR(64) NOT NULL CHECK (merchant_context_sha256 ~ '^[0-9a-f]{64}$'),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  fee_routing_sha256 CHAR(64) NOT NULL CHECK (fee_routing_sha256 ~ '^[0-9a-f]{64}$'),
  consent_sha256 CHAR(64) NOT NULL CHECK (consent_sha256 ~ '^[0-9a-f]{64}$'),
  approved_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  authority_sha256 CHAR(64) NOT NULL UNIQUE CHECK (authority_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (lifecycle_id),
  UNIQUE (
    payment_financial_security_authority_id, lifecycle_id, task_draft_id,
    customer_user_id, hold_id, provider_account_ref_id, payment_method_ref_id,
    processor_code, merchant_context_sha256, amount_cents, currency,
    fee_routing_sha256
  ),
  FOREIGN KEY (lifecycle_id, task_draft_id)
    REFERENCES payment_underwriting_lifecycles_v7(lifecycle_id, task_draft_id) ON DELETE RESTRICT,
  FOREIGN KEY (task_draft_id, customer_user_id)
    REFERENCES task_drafts(id, poster_user_id) ON DELETE RESTRICT,
  FOREIGN KEY (hold_id, lifecycle_id, provider_account_ref_id)
    REFERENCES payment_conditional_provider_holds_v7(hold_id, lifecycle_id, provider_account_ref_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (provider_account_ref_id, processor_code)
    REFERENCES payment_provider_account_refs_v7(provider_account_ref_id, processor_code)
    ON DELETE RESTRICT,
  FOREIGN KEY (payment_method_ref_id, customer_user_id, processor_code)
    REFERENCES payment_method_refs_v7(payment_method_ref_id, customer_user_id, processor_code)
    ON DELETE RESTRICT,
  CHECK (approved_by_user_id = customer_user_id),
  CHECK (expires_at > approved_at)
);

CREATE OR REPLACE FUNCTION hxos_payment_fse_authority_sha256_v7(
  p_authority_id UUID,
  p_lifecycle_id UUID,
  p_task_draft_id UUID,
  p_customer_user_id UUID,
  p_hold_id UUID,
  p_provider_account_ref_id UUID,
  p_payment_method_ref_id UUID,
  p_processor_code TEXT,
  p_merchant_context_sha256 TEXT,
  p_amount_cents BIGINT,
  p_currency TEXT,
  p_fee_routing_sha256 TEXT,
  p_consent_sha256 TEXT,
  p_approved_at TIMESTAMPTZ,
  p_expires_at TIMESTAMPTZ
)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT encode(digest(jsonb_build_object(
    'schema', 'HX_PAYMENT_FSE_CUSTOMER_AUTHORITY_V7',
    'authorityId', p_authority_id,
    'lifecycleId', p_lifecycle_id,
    'taskDraftId', p_task_draft_id,
    'customerUserId', p_customer_user_id,
    'holdId', p_hold_id,
    'providerAccountRefId', p_provider_account_ref_id,
    'paymentMethodRefId', p_payment_method_ref_id,
    'processorCode', p_processor_code,
    'merchantContextSha256', p_merchant_context_sha256,
    'amountCents', p_amount_cents,
    'currency', p_currency,
    'feeRoutingSha256', p_fee_routing_sha256,
    'consentSha256', p_consent_sha256,
    'approvedAt', to_char(p_approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt', to_char(p_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )::TEXT, 'sha256'), 'hex')
$$;

ALTER TABLE payment_financial_security_events_v7
  ADD COLUMN IF NOT EXISTS payment_financial_security_authority_id UUID,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS operation_material_sha256 CHAR(64);

ALTER TABLE payment_financial_security_events_v7
  ALTER COLUMN payment_financial_security_authority_id SET NOT NULL,
  ALTER COLUMN expires_at SET NOT NULL,
  ALTER COLUMN operation_material_sha256 SET NOT NULL,
  DROP CONSTRAINT IF EXISTS payment_financial_security_events_v7_operation_material_d4_ck,
  ADD CONSTRAINT payment_financial_security_events_v7_operation_material_d4_ck
    CHECK (operation_material_sha256 ~ '^[0-9a-f]{64}$'),
  DROP CONSTRAINT IF EXISTS payment_financial_security_events_v7_expiry_d4_ck,
  ADD CONSTRAINT payment_financial_security_events_v7_expiry_d4_ck
    CHECK (expires_at > created_at),
  DROP CONSTRAINT IF EXISTS payment_financial_security_events_v7_authority_d4_fk,
  ADD CONSTRAINT payment_financial_security_events_v7_authority_d4_fk
    FOREIGN KEY (
      payment_financial_security_authority_id, lifecycle_id, task_draft_id,
      customer_user_id, hold_id, provider_account_ref_id, payment_method_ref_id,
      processor_code, merchant_context_sha256, amount_cents, currency,
      fee_routing_sha256
    ) REFERENCES payment_financial_security_authorities_v7(
      payment_financial_security_authority_id, lifecycle_id, task_draft_id,
      customer_user_id, hold_id, provider_account_ref_id, payment_method_ref_id,
      processor_code, merchant_context_sha256, amount_cents, currency,
      fee_routing_sha256
    ) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS payment_financial_security_events_v7_operation_binding_d4_uq
  ON payment_financial_security_events_v7(
    financial_security_event_id, lifecycle_id, operation_id, processor_code,
    amount_cents, currency, merchant_context_sha256, expires_at
  );

CREATE UNIQUE INDEX IF NOT EXISTS payment_financial_security_events_v7_observation_binding_d4_uq
  ON payment_financial_security_events_v7(
    financial_security_event_id, lifecycle_id, operation_id, processor_code,
    amount_cents, currency, merchant_context_sha256
  );

CREATE UNIQUE INDEX IF NOT EXISTS payment_financial_security_events_v7_one_per_lifecycle_d4_uq
  ON payment_financial_security_events_v7(lifecycle_id);

CREATE OR REPLACE FUNCTION hxos_payment_fse_operation_material_sha256_v7(
  p_financial_security_event_id UUID,
  p_authority_id UUID,
  p_lifecycle_id UUID,
  p_task_draft_id UUID,
  p_customer_user_id UUID,
  p_hold_id UUID,
  p_provider_account_ref_id UUID,
  p_payment_method_ref_id UUID,
  p_processor_code TEXT,
  p_merchant_context_sha256 TEXT,
  p_amount_cents BIGINT,
  p_currency TEXT,
  p_fee_routing_sha256 TEXT,
  p_operation_id UUID,
  p_idempotency_key TEXT,
  p_request_sha256 TEXT,
  p_expires_at TIMESTAMPTZ
)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT encode(digest(jsonb_build_object(
    'schema', 'HX_PAYMENT_FSE_OPERATION_V7',
    'financialSecurityEventId', p_financial_security_event_id,
    'authorityId', p_authority_id,
    'lifecycleId', p_lifecycle_id,
    'taskDraftId', p_task_draft_id,
    'customerUserId', p_customer_user_id,
    'holdId', p_hold_id,
    'providerAccountRefId', p_provider_account_ref_id,
    'paymentMethodRefId', p_payment_method_ref_id,
    'processorCode', p_processor_code,
    'merchantContextSha256', p_merchant_context_sha256,
    'amountCents', p_amount_cents,
    'currency', p_currency,
    'feeRoutingSha256', p_fee_routing_sha256,
    'operationId', p_operation_id,
    'idempotencyKey', p_idempotency_key,
    'requestSha256', p_request_sha256,
    'expiresAt', to_char(p_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )::TEXT, 'sha256'), 'hex')
$$;

ALTER TABLE payment_webhook_inbox_v7
  ADD COLUMN IF NOT EXISTS authentication_evidence_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS signature_verified_at TIMESTAMPTZ;

ALTER TABLE payment_webhook_inbox_v7
  ALTER COLUMN authentication_evidence_sha256 SET NOT NULL,
  ALTER COLUMN signature_verified_at SET NOT NULL,
  DROP CONSTRAINT IF EXISTS payment_webhook_inbox_v7_auth_evidence_d4_ck,
  ADD CONSTRAINT payment_webhook_inbox_v7_auth_evidence_d4_ck
    CHECK (authentication_evidence_sha256 ~ '^[0-9a-f]{64}$'),
  DROP CONSTRAINT IF EXISTS payment_webhook_inbox_v7_verified_time_d4_ck,
  ADD CONSTRAINT payment_webhook_inbox_v7_verified_time_d4_ck
    CHECK (signature_verified_at <= received_at + INTERVAL '5 seconds');

CREATE TABLE IF NOT EXISTS payment_financial_security_operation_observations_v7 (
  observation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  financial_security_event_id UUID NOT NULL,
  lifecycle_id UUID NOT NULL,
  operation_id UUID NOT NULL,
  processor_code TEXT NOT NULL CHECK (processor_code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  source TEXT NOT NULL CHECK (source IN ('API_RESPONSE', 'WEBHOOK')),
  sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
  prior_observation_id UUID REFERENCES payment_financial_security_operation_observations_v7(observation_id)
    ON DELETE RESTRICT,
  webhook_inbox_id UUID REFERENCES payment_webhook_inbox_v7(webhook_inbox_id) ON DELETE RESTRICT,
  provider_event_id_sha256 CHAR(64)
    CHECK (provider_event_id_sha256 IS NULL OR provider_event_id_sha256 ~ '^[0-9a-f]{64}$'),
  provider_operation_reference_sha256 CHAR(64)
    CHECK (provider_operation_reference_sha256 IS NULL OR provider_operation_reference_sha256 ~ '^[0-9a-f]{64}$'),
  provider_state TEXT NOT NULL CHECK (provider_state IN (
    'PENDING', 'ACTION_REQUIRED', 'SUCCEEDED', 'FAILED', 'CANCELED', 'EXPIRED', 'UNKNOWN'
  )),
  observed_amount_cents BIGINT NOT NULL CHECK (observed_amount_cents > 0),
  observed_currency CHAR(3) NOT NULL CHECK (observed_currency ~ '^[a-z]{3}$'),
  observed_merchant_context_sha256 CHAR(64) NOT NULL
    CHECK (observed_merchant_context_sha256 ~ '^[0-9a-f]{64}$'),
  provider_expires_at TIMESTAMPTZ NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  provider_response_sha256 CHAR(64) NOT NULL CHECK (provider_response_sha256 ~ '^[0-9a-f]{64}$'),
  observation_material_sha256 CHAR(64) NOT NULL UNIQUE
    CHECK (observation_material_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (financial_security_event_id, source, sequence_number),
  FOREIGN KEY (
    financial_security_event_id, lifecycle_id, operation_id, processor_code,
    observed_amount_cents, observed_currency, observed_merchant_context_sha256
  ) REFERENCES payment_financial_security_events_v7(
    financial_security_event_id, lifecycle_id, operation_id, processor_code,
    amount_cents, currency, merchant_context_sha256
  ) ON DELETE RESTRICT,
  CHECK (
    (source = 'API_RESPONSE' AND webhook_inbox_id IS NULL AND provider_event_id_sha256 IS NULL)
    OR (source = 'WEBHOOK' AND webhook_inbox_id IS NOT NULL AND provider_event_id_sha256 IS NOT NULL)
  ),
  CHECK (provider_expires_at > observed_at),
  CHECK (provider_state <> 'SUCCEEDED' OR provider_operation_reference_sha256 IS NOT NULL)
);

CREATE OR REPLACE FUNCTION hxos_payment_fse_observation_material_sha256_v7(
  p_observation_id UUID,
  p_financial_security_event_id UUID,
  p_lifecycle_id UUID,
  p_operation_id UUID,
  p_processor_code TEXT,
  p_source TEXT,
  p_sequence_number INTEGER,
  p_prior_observation_id UUID,
  p_webhook_inbox_id UUID,
  p_provider_event_id_sha256 TEXT,
  p_provider_operation_reference_sha256 TEXT,
  p_provider_state TEXT,
  p_observed_amount_cents BIGINT,
  p_observed_currency TEXT,
  p_observed_merchant_context_sha256 TEXT,
  p_provider_expires_at TIMESTAMPTZ,
  p_observed_at TIMESTAMPTZ,
  p_provider_response_sha256 TEXT
)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT encode(digest(jsonb_build_object(
    'schema', 'HX_PAYMENT_FSE_OPERATION_OBSERVATION_V7',
    'observationId', p_observation_id,
    'financialSecurityEventId', p_financial_security_event_id,
    'lifecycleId', p_lifecycle_id,
    'operationId', p_operation_id,
    'processorCode', p_processor_code,
    'source', p_source,
    'sequenceNumber', p_sequence_number,
    'priorObservationId', p_prior_observation_id,
    'webhookInboxId', p_webhook_inbox_id,
    'providerEventIdSha256', p_provider_event_id_sha256,
    'providerOperationReferenceSha256', p_provider_operation_reference_sha256,
    'providerState', p_provider_state,
    'observedAmountCents', p_observed_amount_cents,
    'observedCurrency', p_observed_currency,
    'observedMerchantContextSha256', p_observed_merchant_context_sha256,
    'providerExpiresAt', to_char(p_provider_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'observedAt', to_char(p_observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'providerResponseSha256', p_provider_response_sha256
  )::TEXT, 'sha256'), 'hex')
$$;

CREATE OR REPLACE FUNCTION hxos_payment_fse_agreement_sha256_v7(
  p_financial_security_event_id UUID,
  p_api_observation_sha256 TEXT,
  p_webhook_observation_sha256 TEXT,
  p_provider_operation_reference_sha256 TEXT,
  p_provider_expires_at TIMESTAMPTZ
)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT encode(digest(jsonb_build_object(
    'schema', 'HX_PAYMENT_FSE_PROVIDER_AGREEMENT_V7',
    'financialSecurityEventId', p_financial_security_event_id,
    'apiObservationSha256', p_api_observation_sha256,
    'webhookObservationSha256', p_webhook_observation_sha256,
    'providerOperationReferenceSha256', p_provider_operation_reference_sha256,
    'providerExpiresAt', to_char(p_provider_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )::TEXT, 'sha256'), 'hex')
$$;

CREATE OR REPLACE FUNCTION hxos_reject_payment_underwriting_d4_mutation_v7()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'HXPV46: payment underwriting D4 evidence is append-only'
    USING ERRCODE = 'P0001';
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_fse_authority_v7()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
  v_stage TEXT;
  v_hold payment_conditional_provider_holds_v7%ROWTYPE;
  v_provider payment_provider_account_refs_v7%ROWTYPE;
  v_payment_method payment_method_refs_v7%ROWTYPE;
  v_hold_state TEXT;
  v_expected TEXT;
BEGIN
  SELECT stage INTO v_stage FROM payment_underwriting_lifecycle_status_v7
   WHERE lifecycle_id = NEW.lifecycle_id;
  SELECT * INTO v_hold FROM payment_conditional_provider_holds_v7
   WHERE hold_id = NEW.hold_id
     AND lifecycle_id = NEW.lifecycle_id
     AND provider_account_ref_id = NEW.provider_account_ref_id
   FOR UPDATE;
  SELECT state INTO v_hold_state FROM payment_conditional_provider_hold_status_v7
   WHERE hold_id = NEW.hold_id;
  SELECT * INTO v_provider FROM payment_provider_account_refs_v7
   WHERE provider_account_ref_id = NEW.provider_account_ref_id
     AND processor_code = NEW.processor_code
   FOR SHARE;
  SELECT * INTO v_payment_method FROM payment_method_refs_v7
   WHERE payment_method_ref_id = NEW.payment_method_ref_id
     AND customer_user_id = NEW.customer_user_id
     AND processor_code = NEW.processor_code
   FOR SHARE;
  v_expected := hxos_payment_fse_authority_sha256_v7(
    NEW.payment_financial_security_authority_id, NEW.lifecycle_id, NEW.task_draft_id,
    NEW.customer_user_id, NEW.hold_id, NEW.provider_account_ref_id,
    NEW.payment_method_ref_id, NEW.processor_code, NEW.merchant_context_sha256,
    NEW.amount_cents, NEW.currency, NEW.fee_routing_sha256, NEW.consent_sha256,
    NEW.approved_at, NEW.expires_at
  );
  IF v_stage IS DISTINCT FROM 'PROVIDER_SOFT_RESERVED'
     OR v_hold.hold_id IS NULL
     OR v_hold_state IS DISTINCT FROM 'SOFT_RESERVED'
     OR v_hold.expires_at <= v_now
     OR v_provider.provider_account_ref_id IS NULL
     OR v_provider.eligibility_state <> 'ELIGIBLE'
     OR v_provider.funding_state <> 'READY'
     OR v_provider.expires_at < NEW.expires_at
     OR NEW.approved_at < v_hold.accepted_at
     OR NEW.expires_at > v_hold.expires_at
     OR v_payment_method.payment_method_ref_id IS NULL
     OR v_payment_method.state <> 'READY'
     OR NEW.approved_at < v_now - INTERVAL '5 minutes'
     OR NEW.approved_at > v_now + INTERVAL '5 seconds'
     OR NEW.expires_at <= v_now
     OR NEW.authority_sha256 IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'HXPV47: FSE customer authority is incomplete, stale, or cross-bound'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_fse_operation_v7()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_authority payment_financial_security_authorities_v7%ROWTYPE;
  v_hold_state TEXT;
  v_hold_expires_at TIMESTAMPTZ;
  v_stage TEXT;
  v_expected TEXT;
BEGIN
  SELECT * INTO v_authority FROM payment_financial_security_authorities_v7
   WHERE payment_financial_security_authority_id = NEW.payment_financial_security_authority_id
   FOR UPDATE;
  SELECT state, expires_at INTO v_hold_state, v_hold_expires_at
    FROM payment_conditional_provider_hold_status_v7
    WHERE hold_id = NEW.hold_id;
  SELECT stage INTO v_stage FROM payment_underwriting_lifecycle_status_v7
   WHERE lifecycle_id = NEW.lifecycle_id;
  v_expected := hxos_payment_fse_operation_material_sha256_v7(
    NEW.financial_security_event_id, NEW.payment_financial_security_authority_id,
    NEW.lifecycle_id, NEW.task_draft_id, NEW.customer_user_id, NEW.hold_id,
    NEW.provider_account_ref_id, NEW.payment_method_ref_id, NEW.processor_code,
    NEW.merchant_context_sha256, NEW.amount_cents, NEW.currency,
    NEW.fee_routing_sha256, NEW.operation_id, NEW.idempotency_key,
    NEW.request_sha256, NEW.expires_at
  );
  IF v_authority.payment_financial_security_authority_id IS NULL
     OR v_stage IS DISTINCT FROM 'PROVIDER_SOFT_RESERVED'
     OR v_hold_state IS DISTINCT FROM 'SOFT_RESERVED'
     OR v_hold_expires_at <= clock_timestamp()
     OR NEW.created_at > v_hold_expires_at
     OR NEW.expires_at > v_hold_expires_at
     OR NEW.created_at < clock_timestamp() - INTERVAL '5 seconds'
     OR NEW.created_at > clock_timestamp() + INTERVAL '5 seconds'
     OR NEW.created_at < v_authority.approved_at
     OR NEW.created_at > v_authority.expires_at
     OR NEW.expires_at > v_authority.expires_at
     OR NEW.idempotency_key IS DISTINCT FROM 'hx-fse-v7:' || NEW.operation_id::TEXT
     OR NEW.operation_material_sha256 IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'HXPV48: FSE operation lacks exact authority or idempotent material'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_fse_observation_v7()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_fse payment_financial_security_events_v7%ROWTYPE;
  v_latest payment_financial_security_operation_observations_v7%ROWTYPE;
  v_webhook payment_webhook_inbox_v7%ROWTYPE;
  v_stage TEXT;
  v_hold_state TEXT;
  v_hold_expires_at TIMESTAMPTZ;
  v_expected TEXT;
BEGIN
  SELECT * INTO v_fse FROM payment_financial_security_events_v7
   WHERE financial_security_event_id = NEW.financial_security_event_id
     AND lifecycle_id = NEW.lifecycle_id
     AND operation_id = NEW.operation_id
     AND processor_code = NEW.processor_code
   FOR UPDATE;
  SELECT stage INTO v_stage FROM payment_underwriting_lifecycle_status_v7
   WHERE lifecycle_id = NEW.lifecycle_id;
  IF v_fse.financial_security_event_id IS NOT NULL THEN
    SELECT state, expires_at INTO v_hold_state, v_hold_expires_at
      FROM payment_conditional_provider_hold_status_v7
     WHERE hold_id = v_fse.hold_id;
  END IF;
  SELECT * INTO v_latest FROM payment_financial_security_operation_observations_v7
   WHERE financial_security_event_id = NEW.financial_security_event_id
     AND source = NEW.source
   ORDER BY sequence_number DESC LIMIT 1 FOR UPDATE;
  IF NEW.source = 'WEBHOOK' THEN
    SELECT * INTO v_webhook FROM payment_webhook_inbox_v7
     WHERE webhook_inbox_id = NEW.webhook_inbox_id
       AND processor_code = NEW.processor_code
       AND event_id_sha256 = NEW.provider_event_id_sha256
       AND payload_sha256 = NEW.provider_response_sha256
     FOR SHARE;
  END IF;
  v_expected := hxos_payment_fse_observation_material_sha256_v7(
    NEW.observation_id, NEW.financial_security_event_id, NEW.lifecycle_id,
    NEW.operation_id, NEW.processor_code, NEW.source, NEW.sequence_number,
    NEW.prior_observation_id, NEW.webhook_inbox_id, NEW.provider_event_id_sha256,
    NEW.provider_operation_reference_sha256, NEW.provider_state,
    NEW.observed_amount_cents, NEW.observed_currency,
    NEW.observed_merchant_context_sha256, NEW.provider_expires_at,
    NEW.observed_at, NEW.provider_response_sha256
  );
  IF v_fse.financial_security_event_id IS NULL
     OR v_stage IS DISTINCT FROM 'FINANCIAL_SECURITY_PENDING'
     OR v_hold_state IS DISTINCT FROM 'SOFT_RESERVED'
     OR v_hold_expires_at <= clock_timestamp()
     OR v_fse.expires_at <= clock_timestamp()
     OR NEW.observed_at < v_fse.created_at
     OR NEW.observed_at > clock_timestamp() + INTERVAL '5 seconds'
     OR NEW.observed_at > v_fse.expires_at
     OR NEW.provider_expires_at > v_fse.expires_at
     OR (v_latest.observation_id IS NULL AND (
       NEW.sequence_number <> 1 OR NEW.prior_observation_id IS NOT NULL
     ))
     OR (v_latest.observation_id IS NOT NULL AND (
       NEW.sequence_number <> v_latest.sequence_number + 1
       OR NEW.prior_observation_id IS DISTINCT FROM v_latest.observation_id
       OR NEW.observed_at < v_latest.observed_at
     ))
     OR (NEW.source = 'WEBHOOK' AND (
       v_webhook.webhook_inbox_id IS NULL
       OR v_webhook.authentication_state <> 'VERIFIED'
       OR v_webhook.processing_state NOT IN ('NORMALIZED', 'APPLIED')
       OR v_webhook.normalized_event_type IS DISTINCT FROM
         'FINANCIAL_SECURITY_' || NEW.provider_state
       OR v_webhook.signature_verified_at > NEW.observed_at + INTERVAL '5 seconds'
     ))
     OR NEW.observation_material_sha256 IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'HXPV49: FSE observation is unauthenticated, stale, or contradictory'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE VIEW payment_financial_security_status_v7
WITH (security_barrier = true, security_invoker = true)
AS
SELECT
  f.financial_security_event_id,
  f.lifecycle_id,
  f.operation_id,
  f.processor_code,
  f.hold_id,
  f.amount_cents,
  f.currency,
  f.merchant_context_sha256,
  api.observation_id AS api_observation_id,
  webhook.observation_id AS webhook_observation_id,
  CASE
    WHEN api.provider_state = 'SUCCEEDED'
     AND webhook.provider_state = 'SUCCEEDED'
     AND api.provider_operation_reference_sha256 = webhook.provider_operation_reference_sha256
     AND api.observed_amount_cents = webhook.observed_amount_cents
     AND api.observed_currency = webhook.observed_currency
     AND api.observed_merchant_context_sha256 = webhook.observed_merchant_context_sha256
     AND api.provider_expires_at = webhook.provider_expires_at
     AND api.provider_expires_at > clock_timestamp()
    THEN 'AGREED'
    ELSE 'UNRESOLVED'
  END AS agreement_state,
  CASE
    WHEN api.provider_state = 'SUCCEEDED'
     AND webhook.provider_state = 'SUCCEEDED'
     AND api.provider_operation_reference_sha256 = webhook.provider_operation_reference_sha256
     AND api.observed_amount_cents = webhook.observed_amount_cents
     AND api.observed_currency = webhook.observed_currency
     AND api.observed_merchant_context_sha256 = webhook.observed_merchant_context_sha256
     AND api.provider_expires_at = webhook.provider_expires_at
     AND api.provider_expires_at > clock_timestamp()
    THEN 'SUCCEEDED'
    ELSE COALESCE(webhook.provider_state, api.provider_state, 'PENDING')
  END AS provider_state,
  CASE WHEN api.observation_id IS NOT NULL AND webhook.observation_id IS NOT NULL THEN
    hxos_payment_fse_agreement_sha256_v7(
      f.financial_security_event_id,
      api.observation_material_sha256,
      webhook.observation_material_sha256,
      api.provider_operation_reference_sha256,
      api.provider_expires_at
    )
  END AS agreement_sha256,
  api.provider_expires_at,
  f.operation_material_sha256
FROM payment_financial_security_events_v7 f
LEFT JOIN LATERAL (
  SELECT * FROM payment_financial_security_operation_observations_v7 o
   WHERE o.financial_security_event_id = f.financial_security_event_id
     AND o.source = 'API_RESPONSE'
   ORDER BY o.sequence_number DESC LIMIT 1
) api ON TRUE
LEFT JOIN LATERAL (
  SELECT * FROM payment_financial_security_operation_observations_v7 o
   WHERE o.financial_security_event_id = f.financial_security_event_id
     AND o.source = 'WEBHOOK'
   ORDER BY o.sequence_number DESC LIMIT 1
) webhook ON TRUE;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_fse_lifecycle_transition_v7()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_status payment_financial_security_status_v7%ROWTYPE;
  v_hold_state TEXT;
  v_hold_expires_at TIMESTAMPTZ;
BEGIN
  IF NEW.stage = 'WORK_ORDER_MATERIALIZED' THEN
    RAISE EXCEPTION 'HXPV49: work-order materialization is deferred to D5 authority'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.stage NOT IN ('FINANCIAL_SECURITY_PENDING', 'FINANCIALLY_SECURED') THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_status FROM payment_financial_security_status_v7
   WHERE lifecycle_id = NEW.lifecycle_id;
  IF v_status.financial_security_event_id IS NOT NULL THEN
    SELECT state, expires_at INTO v_hold_state, v_hold_expires_at
      FROM payment_conditional_provider_hold_status_v7
     WHERE hold_id = v_status.hold_id;
  END IF;
  IF NEW.stage = 'FINANCIAL_SECURITY_PENDING' AND (
    v_status.financial_security_event_id IS NULL
    OR v_hold_state IS DISTINCT FROM 'SOFT_RESERVED'
    OR v_hold_expires_at <= clock_timestamp()
    OR NEW.evidence_sha256 IS DISTINCT FROM v_status.operation_material_sha256
  ) THEN
    RAISE EXCEPTION 'HXPV49: pending FSE transition lacks a current soft hold and operation record'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.stage = 'FINANCIALLY_SECURED' AND (
    v_status.agreement_state IS DISTINCT FROM 'AGREED'
    OR v_status.provider_state IS DISTINCT FROM 'SUCCEEDED'
    OR v_status.provider_expires_at <= clock_timestamp()
    OR v_hold_state IS DISTINCT FROM 'SOFT_RESERVED'
    OR v_hold_expires_at <= clock_timestamp()
    OR NEW.evidence_sha256 IS DISTINCT FROM v_status.agreement_sha256
  ) THEN
    RAISE EXCEPTION 'HXPV49: secured transition requires exact API and authenticated webhook agreement'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE payment_conditional_provider_hold_events_v7
  DROP CONSTRAINT IF EXISTS payment_conditional_provider_hold_events_v7_event_type_check,
  ADD CONSTRAINT payment_conditional_provider_hold_events_v7_event_type_check
    CHECK (event_type IN ('SOFT_RESERVED', 'RELEASED', 'EXPIRED', 'CONSUMED'));

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
    RAISE EXCEPTION 'HXPV40: hold event lacks a hold' USING ERRCODE = 'P0001';
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
    IF NEW.sequence_number <> 1 OR NEW.prior_event_id IS NOT NULL
       OR NEW.event_type <> 'SOFT_RESERVED' THEN
      RAISE EXCEPTION 'HXPV41: hold history must begin at SOFT_RESERVED'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.sequence_number <> v_latest.sequence_number + 1
     OR NEW.prior_event_id IS DISTINCT FROM v_latest.event_id
     OR v_latest.event_type <> 'SOFT_RESERVED'
     OR NEW.event_type NOT IN ('RELEASED', 'EXPIRED', 'CONSUMED') THEN
    RAISE EXCEPTION 'HXPV42: invalid conditional-hold transition'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.event_type = 'CONSUMED' THEN
    RAISE EXCEPTION 'HXPV49: hold consumption is deferred to D5 atomic materialization'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payment_fse_authority_insert_guard_v7
  ON payment_financial_security_authorities_v7;
CREATE TRIGGER payment_fse_authority_insert_guard_v7
BEFORE INSERT ON payment_financial_security_authorities_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_fse_authority_v7();

DROP TRIGGER IF EXISTS payment_fse_operation_insert_guard_v7
  ON payment_financial_security_events_v7;
CREATE TRIGGER payment_fse_operation_insert_guard_v7
BEFORE INSERT ON payment_financial_security_events_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_fse_operation_v7();

DROP TRIGGER IF EXISTS payment_fse_observation_insert_guard_v7
  ON payment_financial_security_operation_observations_v7;
CREATE TRIGGER payment_fse_observation_insert_guard_v7
BEFORE INSERT ON payment_financial_security_operation_observations_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_fse_observation_v7();

DROP TRIGGER IF EXISTS payment_fse_lifecycle_transition_guard_v7
  ON payment_underwriting_lifecycle_events_v7;
CREATE TRIGGER payment_fse_lifecycle_transition_guard_v7
BEFORE INSERT ON payment_underwriting_lifecycle_events_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_fse_lifecycle_transition_v7();

DO $$
DECLARE
  relation_name TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'payment_financial_security_authorities_v7',
    'payment_financial_security_operation_observations_v7'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', relation_name || '_append_only_v7', relation_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION hxos_reject_payment_underwriting_d4_mutation_v7()',
      relation_name || '_append_only_v7', relation_name
    );
  END LOOP;
END;
$$;

REVOKE ALL ON TABLE
  payment_financial_security_authorities_v7,
  payment_financial_security_operation_observations_v7,
  payment_financial_security_status_v7
FROM PUBLIC;

REVOKE ALL ON FUNCTION hxos_payment_fse_authority_sha256_v7(
  UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT,
  TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_payment_fse_operation_material_sha256_v7(
  UUID, UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, BIGINT, TEXT, TEXT,
  UUID, TEXT, TEXT, TIMESTAMPTZ
) FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_payment_fse_observation_material_sha256_v7(
  UUID, UUID, UUID, UUID, TEXT, TEXT, INTEGER, UUID, UUID, TEXT, TEXT, TEXT,
  BIGINT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_payment_fse_agreement_sha256_v7(
  UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ
) FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_reject_payment_underwriting_d4_mutation_v7() FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_enforce_payment_fse_authority_v7() FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_enforce_payment_fse_operation_v7() FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_enforce_payment_fse_observation_v7() FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_enforce_payment_fse_lifecycle_transition_v7() FROM PUBLIC;
