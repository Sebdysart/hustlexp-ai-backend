-- HX payment-underwriting v7 D6: immutable completion evidence, poster amount
-- and incident approval, one idempotent capture operation, authenticated
-- provider observations, and lifecycle barriers. This remains an unregistered
-- schema artifact and grants no runtime or processor authority.

DO $$
DECLARE
  v_complete BOOLEAN;
  v_absent BOOLEAN;
BEGIN
  IF to_regclass('public.payment_work_order_materialization_authorities_v7') IS NULL
     OR to_regclass('public.payment_work_order_assignments_v7') IS NULL
     OR to_regclass('public.payment_private_fulfillment_grants_v7') IS NULL
     OR to_regclass('public.payment_captures_v7') IS NULL THEN
    RAISE EXCEPTION 'HXPV60: D6 requires the accepted D2 through D5 schema artifacts'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT
    to_regclass('public.payment_completion_evidence_v7') IS NOT NULL
    AND to_regclass('public.payment_completion_approvals_v7') IS NOT NULL
    AND to_regclass('public.payment_capture_authorities_v7') IS NOT NULL
    AND to_regclass('public.payment_capture_operation_observations_v7') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM pg_attribute
       WHERE attrelid = 'public.payment_captures_v7'::regclass
         AND attname = 'capture_authority_id' AND NOT attisdropped
    )
    AND EXISTS (
      SELECT 1 FROM pg_attribute
       WHERE attrelid = 'public.payment_captures_v7'::regclass
         AND attname = 'expires_at' AND NOT attisdropped
    )
    AND EXISTS (
      SELECT 1 FROM pg_attribute
       WHERE attrelid = 'public.payment_captures_v7'::regclass
         AND attname = 'operation_material_sha256' AND NOT attisdropped
    )
  INTO v_complete;
  SELECT
    to_regclass('public.payment_completion_evidence_v7') IS NULL
    AND to_regclass('public.payment_completion_approvals_v7') IS NULL
    AND to_regclass('public.payment_capture_authorities_v7') IS NULL
    AND to_regclass('public.payment_capture_operation_observations_v7') IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM pg_attribute
       WHERE attrelid = 'public.payment_captures_v7'::regclass
         AND attname IN ('capture_authority_id', 'expires_at', 'operation_material_sha256')
         AND NOT attisdropped
    )
  INTO v_absent;
  IF NOT v_complete AND NOT v_absent THEN
    RAISE EXCEPTION 'HXPV60: D6 catalog is partial or contradictory'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_absent AND (
    EXISTS (SELECT 1 FROM payment_captures_v7)
    OR EXISTS (
      SELECT 1 FROM payment_underwriting_lifecycle_events_v7
       WHERE stage IN ('CAPTURE_PENDING', 'CAPTURED')
    )
  ) THEN
    RAISE EXCEPTION 'HXPV60: D6 cannot retrofit unauthorised capture evidence'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_payment_completion_evidence_sha256_v7(
  p_completion_evidence_id UUID,
  p_lifecycle_id UUID,
  p_work_order_id UUID,
  p_assignment_id UUID,
  p_task_id UUID,
  p_provider_user_id UUID,
  p_proof_bundle_sha256 TEXT,
  p_completion_scope_sha256 TEXT,
  p_submitted_at TIMESTAMPTZ,
  p_evidence_sha256 TEXT
)
RETURNS TEXT LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
  SELECT encode(digest(jsonb_build_object(
    'schema', 'HX_PAYMENT_COMPLETION_EVIDENCE_V7',
    'completionEvidenceId', p_completion_evidence_id,
    'lifecycleId', p_lifecycle_id,
    'workOrderId', p_work_order_id,
    'assignmentId', p_assignment_id,
    'taskId', p_task_id,
    'providerUserId', p_provider_user_id,
    'proofBundleSha256', p_proof_bundle_sha256,
    'completionScopeSha256', p_completion_scope_sha256,
    'submittedAt', to_char(p_submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'evidenceSha256', p_evidence_sha256
  )::TEXT, 'sha256'), 'hex')
$$;

CREATE OR REPLACE FUNCTION hxos_payment_completion_approval_sha256_v7(
  p_approval_id UUID,
  p_completion_evidence_id UUID,
  p_lifecycle_id UUID,
  p_work_order_id UUID,
  p_task_id UUID,
  p_poster_user_id UUID,
  p_customer_notice_state TEXT,
  p_customer_notice_sha256 TEXT,
  p_approved_amount_cents BIGINT,
  p_currency TEXT,
  p_amount_approval_sha256 TEXT,
  p_incident_clearance_sha256 TEXT,
  p_approved_at TIMESTAMPTZ,
  p_evidence_sha256 TEXT
)
RETURNS TEXT LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
  SELECT encode(digest(jsonb_build_object(
    'schema', 'HX_PAYMENT_COMPLETION_APPROVAL_V7',
    'approvalId', p_approval_id,
    'completionEvidenceId', p_completion_evidence_id,
    'lifecycleId', p_lifecycle_id,
    'workOrderId', p_work_order_id,
    'taskId', p_task_id,
    'posterUserId', p_poster_user_id,
    'approvalState', 'APPROVED',
    'customerNoticeState', p_customer_notice_state,
    'customerNoticeSha256', p_customer_notice_sha256,
    'approvedAmountCents', p_approved_amount_cents,
    'currency', p_currency,
    'amountApprovalSha256', p_amount_approval_sha256,
    'incidentClearanceState', 'CLEAR',
    'incidentClearanceSha256', p_incident_clearance_sha256,
    'approvedAt', to_char(p_approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'evidenceSha256', p_evidence_sha256
  )::TEXT, 'sha256'), 'hex')
$$;

CREATE OR REPLACE FUNCTION hxos_payment_capture_authority_sha256_v7(
  p_capture_authority_id UUID,
  p_approval_id UUID,
  p_completion_evidence_id UUID,
  p_lifecycle_id UUID,
  p_work_order_id UUID,
  p_financial_security_event_id UUID,
  p_provider_account_ref_id UUID,
  p_processor_code TEXT,
  p_approved_amount_cents BIGINT,
  p_currency TEXT,
  p_authorized_by_user_id UUID,
  p_authorized_at TIMESTAMPTZ,
  p_expires_at TIMESTAMPTZ
)
RETURNS TEXT LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
  SELECT encode(digest(jsonb_build_object(
    'schema', 'HX_PAYMENT_CAPTURE_AUTHORITY_V7',
    'captureAuthorityId', p_capture_authority_id,
    'approvalId', p_approval_id,
    'completionEvidenceId', p_completion_evidence_id,
    'lifecycleId', p_lifecycle_id,
    'workOrderId', p_work_order_id,
    'financialSecurityEventId', p_financial_security_event_id,
    'providerAccountRefId', p_provider_account_ref_id,
    'processorCode', p_processor_code,
    'approvedAmountCents', p_approved_amount_cents,
    'currency', p_currency,
    'authorizedByUserId', p_authorized_by_user_id,
    'authorizedAt', to_char(p_authorized_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt', to_char(p_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )::TEXT, 'sha256'), 'hex')
$$;

CREATE OR REPLACE FUNCTION hxos_payment_capture_operation_sha256_v7(
  p_capture_id UUID,
  p_capture_authority_id UUID,
  p_lifecycle_id UUID,
  p_work_order_id UUID,
  p_financial_security_event_id UUID,
  p_processor_code TEXT,
  p_approved_amount_cents BIGINT,
  p_currency TEXT,
  p_completion_evidence_sha256 TEXT,
  p_amount_approval_sha256 TEXT,
  p_incident_clearance_sha256 TEXT,
  p_operation_id UUID,
  p_idempotency_key TEXT,
  p_request_sha256 TEXT,
  p_created_at TIMESTAMPTZ,
  p_expires_at TIMESTAMPTZ
)
RETURNS TEXT LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
  SELECT encode(digest(jsonb_build_object(
    'schema', 'HX_PAYMENT_CAPTURE_OPERATION_V7',
    'captureId', p_capture_id,
    'captureAuthorityId', p_capture_authority_id,
    'lifecycleId', p_lifecycle_id,
    'workOrderId', p_work_order_id,
    'financialSecurityEventId', p_financial_security_event_id,
    'processorCode', p_processor_code,
    'approvedAmountCents', p_approved_amount_cents,
    'currency', p_currency,
    'completionEvidenceSha256', p_completion_evidence_sha256,
    'amountApprovalSha256', p_amount_approval_sha256,
    'incidentClearanceSha256', p_incident_clearance_sha256,
    'operationId', p_operation_id,
    'idempotencyKey', p_idempotency_key,
    'requestSha256', p_request_sha256,
    'createdAt', to_char(p_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt', to_char(p_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )::TEXT, 'sha256'), 'hex')
$$;

CREATE OR REPLACE FUNCTION hxos_payment_capture_observation_sha256_v7(
  p_observation_id UUID,
  p_capture_id UUID,
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
  p_observed_at TIMESTAMPTZ,
  p_provider_response_sha256 TEXT
)
RETURNS TEXT LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
  SELECT encode(digest(jsonb_build_object(
    'schema', 'HX_PAYMENT_CAPTURE_OPERATION_OBSERVATION_V7',
    'observationId', p_observation_id,
    'captureId', p_capture_id,
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
    'observedAt', to_char(p_observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'providerResponseSha256', p_provider_response_sha256
  )::TEXT, 'sha256'), 'hex')
$$;

CREATE OR REPLACE FUNCTION hxos_payment_capture_agreement_sha256_v7(
  p_capture_id UUID,
  p_api_observation_sha256 TEXT,
  p_webhook_observation_sha256 TEXT,
  p_provider_operation_reference_sha256 TEXT,
  p_observed_amount_cents BIGINT,
  p_currency TEXT
)
RETURNS TEXT LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
  SELECT encode(digest(jsonb_build_object(
    'schema', 'HX_PAYMENT_CAPTURE_AGREEMENT_V7',
    'captureId', p_capture_id,
    'apiObservationSha256', p_api_observation_sha256,
    'webhookObservationSha256', p_webhook_observation_sha256,
    'providerOperationReferenceSha256', p_provider_operation_reference_sha256,
    'observedAmountCents', p_observed_amount_cents,
    'currency', p_currency
  )::TEXT, 'sha256'), 'hex')
$$;

CREATE UNIQUE INDEX IF NOT EXISTS payment_work_order_d6_completion_binding_uq
  ON payment_canonical_work_orders_v7(
    work_order_id, lifecycle_id, financial_security_event_id,
    provider_account_ref_id, processor_code, task_id, assigned_provider_user_id
  );

CREATE UNIQUE INDEX IF NOT EXISTS payment_work_order_d6_capture_authority_binding_uq
  ON payment_canonical_work_orders_v7(
    work_order_id, lifecycle_id, financial_security_event_id,
    provider_account_ref_id, processor_code
  );

CREATE UNIQUE INDEX IF NOT EXISTS payment_assignment_d6_completion_binding_uq
  ON payment_work_order_assignments_v7(
    assignment_id, work_order_id, lifecycle_id, task_id,
    provider_account_ref_id, provider_user_id
  );

CREATE TABLE IF NOT EXISTS payment_completion_evidence_v7 (
  completion_evidence_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lifecycle_id UUID NOT NULL UNIQUE,
  work_order_id UUID NOT NULL UNIQUE,
  assignment_id UUID NOT NULL UNIQUE,
  task_id UUID NOT NULL UNIQUE,
  provider_account_ref_id UUID NOT NULL,
  provider_user_id UUID NOT NULL,
  submitted_by_user_id UUID NOT NULL,
  proof_bundle_sha256 CHAR(64) NOT NULL CHECK (proof_bundle_sha256 ~ '^[0-9a-f]{64}$'),
  completion_scope_sha256 CHAR(64) NOT NULL CHECK (completion_scope_sha256 ~ '^[0-9a-f]{64}$'),
  submitted_at TIMESTAMPTZ NOT NULL,
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  completion_material_sha256 CHAR(64) NOT NULL UNIQUE CHECK (completion_material_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (
    completion_evidence_id, lifecycle_id, work_order_id, task_id,
    provider_account_ref_id, provider_user_id
  ),
  FOREIGN KEY (
    assignment_id, work_order_id, lifecycle_id, task_id,
    provider_account_ref_id, provider_user_id
  ) REFERENCES payment_work_order_assignments_v7(
    assignment_id, work_order_id, lifecycle_id, task_id,
    provider_account_ref_id, provider_user_id
  ) ON DELETE RESTRICT,
  CHECK (submitted_by_user_id = provider_user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_completion_d6_approval_binding_uq
  ON payment_completion_evidence_v7(
    completion_evidence_id, lifecycle_id, work_order_id, task_id
  );

CREATE TABLE IF NOT EXISTS payment_completion_approvals_v7 (
  completion_approval_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  completion_evidence_id UUID NOT NULL UNIQUE,
  lifecycle_id UUID NOT NULL UNIQUE,
  work_order_id UUID NOT NULL UNIQUE,
  task_id UUID NOT NULL UNIQUE,
  poster_user_id UUID NOT NULL,
  approved_by_user_id UUID NOT NULL,
  approval_state TEXT NOT NULL CHECK (approval_state = 'APPROVED'),
  customer_notice_state TEXT NOT NULL CHECK (
    customer_notice_state IN ('ACKNOWLEDGED', 'DISCLOSED_TIMEOUT')
  ),
  customer_notice_sha256 CHAR(64) NOT NULL CHECK (
    customer_notice_sha256 ~ '^[0-9a-f]{64}$'
  ),
  approved_amount_cents BIGINT NOT NULL CHECK (approved_amount_cents > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  amount_approval_sha256 CHAR(64) NOT NULL CHECK (amount_approval_sha256 ~ '^[0-9a-f]{64}$'),
  incident_clearance_state TEXT NOT NULL CHECK (incident_clearance_state = 'CLEAR'),
  incident_clearance_sha256 CHAR(64) NOT NULL CHECK (incident_clearance_sha256 ~ '^[0-9a-f]{64}$'),
  approved_at TIMESTAMPTZ NOT NULL,
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  approval_material_sha256 CHAR(64) NOT NULL UNIQUE CHECK (approval_material_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (
    completion_approval_id, completion_evidence_id, lifecycle_id,
    work_order_id, task_id, poster_user_id, approved_amount_cents, currency
  ),
  FOREIGN KEY (
    completion_evidence_id, lifecycle_id, work_order_id, task_id
  ) REFERENCES payment_completion_evidence_v7(
    completion_evidence_id, lifecycle_id, work_order_id, task_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (task_id, poster_user_id)
    REFERENCES tasks(id, poster_id) ON DELETE RESTRICT,
  CHECK (approved_by_user_id = poster_user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_approval_d6_capture_authority_binding_uq
  ON payment_completion_approvals_v7(
    completion_approval_id, completion_evidence_id, lifecycle_id,
    work_order_id, approved_amount_cents, currency
  );

CREATE TABLE IF NOT EXISTS payment_capture_authorities_v7 (
  capture_authority_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  completion_approval_id UUID NOT NULL UNIQUE,
  completion_evidence_id UUID NOT NULL UNIQUE,
  lifecycle_id UUID NOT NULL UNIQUE,
  work_order_id UUID NOT NULL UNIQUE,
  financial_security_event_id UUID NOT NULL UNIQUE,
  provider_account_ref_id UUID NOT NULL,
  processor_code TEXT NOT NULL CHECK (processor_code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  approved_amount_cents BIGINT NOT NULL CHECK (approved_amount_cents > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  authorized_by_user_id UUID NOT NULL,
  authorized_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  authority_sha256 CHAR(64) NOT NULL UNIQUE CHECK (authority_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (
    capture_authority_id, lifecycle_id, work_order_id,
    financial_security_event_id, processor_code, approved_amount_cents, currency
  ),
  FOREIGN KEY (
    completion_approval_id, completion_evidence_id, lifecycle_id,
    work_order_id, approved_amount_cents, currency
  ) REFERENCES payment_completion_approvals_v7(
    completion_approval_id, completion_evidence_id, lifecycle_id,
    work_order_id, approved_amount_cents, currency
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    work_order_id, lifecycle_id, financial_security_event_id,
    provider_account_ref_id, processor_code
  ) REFERENCES payment_canonical_work_orders_v7(
    work_order_id, lifecycle_id, financial_security_event_id,
    provider_account_ref_id, processor_code
  ) ON DELETE RESTRICT,
  CHECK (expires_at > authorized_at)
);

ALTER TABLE payment_captures_v7
  ADD COLUMN IF NOT EXISTS capture_authority_id UUID,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS operation_material_sha256 CHAR(64);
ALTER TABLE payment_captures_v7
  ALTER COLUMN capture_authority_id SET NOT NULL,
  ALTER COLUMN expires_at SET NOT NULL,
  ALTER COLUMN operation_material_sha256 SET NOT NULL,
  DROP CONSTRAINT IF EXISTS payment_captures_v7_d6_authority_fk,
  ADD CONSTRAINT payment_captures_v7_d6_authority_fk
    FOREIGN KEY (
      capture_authority_id, lifecycle_id, work_order_id,
      financial_security_event_id, processor_code, approved_amount_cents, currency
    ) REFERENCES payment_capture_authorities_v7(
      capture_authority_id, lifecycle_id, work_order_id,
      financial_security_event_id, processor_code, approved_amount_cents, currency
    ) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS payment_captures_v7_d6_expiry_ck,
  ADD CONSTRAINT payment_captures_v7_d6_expiry_ck CHECK (expires_at > created_at),
  DROP CONSTRAINT IF EXISTS payment_captures_v7_d6_material_ck,
  ADD CONSTRAINT payment_captures_v7_d6_material_ck CHECK (
    operation_material_sha256 ~ '^[0-9a-f]{64}$'
  );
CREATE UNIQUE INDEX IF NOT EXISTS payment_captures_v7_d6_observation_binding_uq
  ON payment_captures_v7(
    capture_id, lifecycle_id, operation_id, processor_code,
    approved_amount_cents, currency
  );
CREATE UNIQUE INDEX IF NOT EXISTS payment_captures_v7_d6_authority_uq
  ON payment_captures_v7(capture_authority_id);

CREATE TABLE IF NOT EXISTS payment_capture_operation_observations_v7 (
  observation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  capture_id UUID NOT NULL,
  lifecycle_id UUID NOT NULL,
  operation_id UUID NOT NULL,
  processor_code TEXT NOT NULL CHECK (processor_code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  source TEXT NOT NULL CHECK (source IN ('API_RESPONSE', 'WEBHOOK')),
  sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
  prior_observation_id UUID REFERENCES payment_capture_operation_observations_v7(observation_id)
    ON DELETE RESTRICT,
  webhook_inbox_id UUID REFERENCES payment_webhook_inbox_v7(webhook_inbox_id) ON DELETE RESTRICT,
  provider_event_id_sha256 CHAR(64)
    CHECK (provider_event_id_sha256 IS NULL OR provider_event_id_sha256 ~ '^[0-9a-f]{64}$'),
  provider_operation_reference_sha256 CHAR(64)
    CHECK (provider_operation_reference_sha256 IS NULL OR provider_operation_reference_sha256 ~ '^[0-9a-f]{64}$'),
  provider_state TEXT NOT NULL CHECK (provider_state IN (
    'PENDING', 'ACTION_REQUIRED', 'SUCCEEDED', 'FAILED', 'CANCELED', 'UNKNOWN'
  )),
  observed_amount_cents BIGINT NOT NULL CHECK (observed_amount_cents > 0),
  observed_currency CHAR(3) NOT NULL CHECK (observed_currency ~ '^[a-z]{3}$'),
  observed_at TIMESTAMPTZ NOT NULL,
  provider_response_sha256 CHAR(64) NOT NULL CHECK (provider_response_sha256 ~ '^[0-9a-f]{64}$'),
  observation_material_sha256 CHAR(64) NOT NULL UNIQUE
    CHECK (observation_material_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (capture_id, source, sequence_number),
  FOREIGN KEY (
    capture_id, lifecycle_id, operation_id, processor_code,
    observed_amount_cents, observed_currency
  ) REFERENCES payment_captures_v7(
    capture_id, lifecycle_id, operation_id, processor_code,
    approved_amount_cents, currency
  ) ON DELETE RESTRICT,
  CHECK (
    (source = 'API_RESPONSE' AND webhook_inbox_id IS NULL AND provider_event_id_sha256 IS NULL)
    OR (source = 'WEBHOOK' AND webhook_inbox_id IS NOT NULL AND provider_event_id_sha256 IS NOT NULL)
  ),
  CHECK (provider_state <> 'SUCCEEDED' OR provider_operation_reference_sha256 IS NOT NULL)
);

CREATE OR REPLACE VIEW payment_capture_status_v7
WITH (security_barrier = true, security_invoker = true)
AS
SELECT
  capture.capture_id,
  capture.lifecycle_id,
  capture.operation_id,
  capture.processor_code,
  capture.approved_amount_cents,
  capture.currency,
  api.observation_id AS api_observation_id,
  webhook.observation_id AS webhook_observation_id,
  CASE WHEN api.provider_state = 'SUCCEEDED'
    AND webhook.provider_state = 'SUCCEEDED'
    AND api.provider_operation_reference_sha256 = webhook.provider_operation_reference_sha256
    AND api.observed_amount_cents = webhook.observed_amount_cents
    AND api.observed_currency = webhook.observed_currency
  THEN 'AGREED' ELSE 'UNRESOLVED' END AS agreement_state,
  CASE WHEN api.provider_state = 'SUCCEEDED'
    AND webhook.provider_state = 'SUCCEEDED'
    AND api.provider_operation_reference_sha256 = webhook.provider_operation_reference_sha256
    AND api.observed_amount_cents = webhook.observed_amount_cents
    AND api.observed_currency = webhook.observed_currency
  THEN 'SUCCEEDED' ELSE COALESCE(webhook.provider_state, api.provider_state, 'PENDING') END
    AS provider_state,
  CASE WHEN api.observation_id IS NOT NULL AND webhook.observation_id IS NOT NULL THEN
    hxos_payment_capture_agreement_sha256_v7(
      capture.capture_id, api.observation_material_sha256,
      webhook.observation_material_sha256,
      api.provider_operation_reference_sha256,
      api.observed_amount_cents, api.observed_currency
    )
  END AS agreement_sha256,
  capture.operation_material_sha256,
  capture.expires_at
FROM payment_captures_v7 capture
LEFT JOIN LATERAL (
  SELECT * FROM payment_capture_operation_observations_v7 observation
   WHERE observation.capture_id = capture.capture_id AND observation.source = 'API_RESPONSE'
   ORDER BY observation.sequence_number DESC LIMIT 1
) api ON TRUE
LEFT JOIN LATERAL (
  SELECT * FROM payment_capture_operation_observations_v7 observation
   WHERE observation.capture_id = capture.capture_id AND observation.source = 'WEBHOOK'
   ORDER BY observation.sequence_number DESC LIMIT 1
) webhook ON TRUE;

CREATE OR REPLACE FUNCTION hxos_reject_payment_underwriting_d6_mutation_v7()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HXPV61: payment underwriting D6 evidence is append-only'
    USING ERRCODE = 'P0001';
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_completion_evidence_v7()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_stage TEXT;
  v_task_state TEXT;
  v_scope_sha256 TEXT;
  v_expected TEXT;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT stage INTO v_stage FROM payment_underwriting_lifecycle_status_v7
   WHERE lifecycle_id = NEW.lifecycle_id;
  SELECT task.state, work_order.scope_sha256
    INTO v_task_state, v_scope_sha256
    FROM tasks task
    JOIN payment_canonical_work_orders_v7 work_order ON work_order.task_id = task.id
   WHERE task.id = NEW.task_id AND work_order.work_order_id = NEW.work_order_id;
  v_expected := hxos_payment_completion_evidence_sha256_v7(
    NEW.completion_evidence_id, NEW.lifecycle_id, NEW.work_order_id,
    NEW.assignment_id, NEW.task_id, NEW.provider_user_id,
    NEW.proof_bundle_sha256::TEXT, NEW.completion_scope_sha256::TEXT,
    NEW.submitted_at, NEW.evidence_sha256::TEXT
  );
  IF v_stage IS DISTINCT FROM 'IN_PROGRESS'
     OR v_task_state IS DISTINCT FROM 'PROOF_SUBMITTED'
     OR NEW.completion_scope_sha256 IS DISTINCT FROM v_scope_sha256
     OR NEW.submitted_at < v_now - INTERVAL '5 minutes'
     OR NEW.submitted_at > v_now + INTERVAL '5 seconds'
     OR NEW.completion_material_sha256::TEXT IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'HXPV62: completion evidence is stale, crossed, or incomplete'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_completion_approval_v7()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_completion payment_completion_evidence_v7%ROWTYPE;
  v_stage TEXT;
  v_fse_amount BIGINT;
  v_fse_currency TEXT;
  v_expected TEXT;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO v_completion FROM payment_completion_evidence_v7
   WHERE completion_evidence_id = NEW.completion_evidence_id FOR SHARE;
  SELECT stage INTO v_stage FROM payment_underwriting_lifecycle_status_v7
   WHERE lifecycle_id = NEW.lifecycle_id;
  SELECT fse.amount_cents, fse.currency INTO v_fse_amount, v_fse_currency
    FROM payment_canonical_work_orders_v7 work_order
    JOIN payment_financial_security_events_v7 fse
      ON fse.financial_security_event_id = work_order.financial_security_event_id
   WHERE work_order.work_order_id = NEW.work_order_id;
  v_expected := hxos_payment_completion_approval_sha256_v7(
    NEW.completion_approval_id, NEW.completion_evidence_id,
    NEW.lifecycle_id, NEW.work_order_id, NEW.task_id, NEW.poster_user_id,
    NEW.customer_notice_state, NEW.customer_notice_sha256::TEXT,
    NEW.approved_amount_cents, NEW.currency, NEW.amount_approval_sha256::TEXT,
    NEW.incident_clearance_sha256::TEXT, NEW.approved_at, NEW.evidence_sha256::TEXT
  );
  IF v_completion.completion_evidence_id IS NULL
     OR v_stage IS DISTINCT FROM 'COMPLETION_SUBMITTED'
     OR NEW.approved_amount_cents IS DISTINCT FROM v_fse_amount
     OR NEW.currency IS DISTINCT FROM v_fse_currency
     OR NEW.approved_at < v_completion.submitted_at
     OR NEW.approved_at < v_now - INTERVAL '5 minutes'
     OR NEW.approved_at > v_now + INTERVAL '5 seconds'
     OR NEW.approval_material_sha256::TEXT IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'HXPV63: completion approval lacks exact amount and incident authority'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_capture_authority_v7()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_approval payment_completion_approvals_v7%ROWTYPE;
  v_financial payment_financial_security_status_v7%ROWTYPE;
  v_stage TEXT;
  v_expected TEXT;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO v_approval FROM payment_completion_approvals_v7
   WHERE completion_approval_id = NEW.completion_approval_id FOR SHARE;
  SELECT * INTO v_financial FROM payment_financial_security_status_v7
   WHERE financial_security_event_id = NEW.financial_security_event_id;
  SELECT stage INTO v_stage FROM payment_underwriting_lifecycle_status_v7
   WHERE lifecycle_id = NEW.lifecycle_id;
  v_expected := hxos_payment_capture_authority_sha256_v7(
    NEW.capture_authority_id, NEW.completion_approval_id,
    NEW.completion_evidence_id, NEW.lifecycle_id, NEW.work_order_id,
    NEW.financial_security_event_id, NEW.provider_account_ref_id,
    NEW.processor_code, NEW.approved_amount_cents, NEW.currency,
    NEW.authorized_by_user_id, NEW.authorized_at, NEW.expires_at
  );
  IF v_approval.completion_approval_id IS NULL
     OR v_stage IS DISTINCT FROM 'COMPLETION_SUBMITTED'
     OR v_financial.agreement_state IS DISTINCT FROM 'AGREED'
     OR v_financial.provider_state IS DISTINCT FROM 'SUCCEEDED'
     OR v_financial.provider_expires_at <= v_now
     OR NEW.authorized_by_user_id IS DISTINCT FROM v_approval.poster_user_id
     OR NEW.authorized_at < v_approval.approved_at
     OR NEW.authorized_at > v_now + INTERVAL '5 seconds'
     OR NEW.expires_at > v_financial.provider_expires_at
     OR NEW.expires_at <= v_now
     OR NEW.authority_sha256::TEXT IS DISTINCT FROM v_expected
     OR EXISTS (SELECT 1 FROM payment_captures_v7 WHERE lifecycle_id = NEW.lifecycle_id) THEN
    RAISE EXCEPTION 'HXPV64: capture authority lacks completion and current FSE agreement'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_capture_operation_v7()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_authority payment_capture_authorities_v7%ROWTYPE;
  v_approval payment_completion_approvals_v7%ROWTYPE;
  v_completion payment_completion_evidence_v7%ROWTYPE;
  v_expected TEXT;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO v_authority FROM payment_capture_authorities_v7
   WHERE capture_authority_id = NEW.capture_authority_id FOR UPDATE;
  SELECT * INTO v_approval FROM payment_completion_approvals_v7
   WHERE completion_approval_id = v_authority.completion_approval_id FOR SHARE;
  SELECT * INTO v_completion FROM payment_completion_evidence_v7
   WHERE completion_evidence_id = v_authority.completion_evidence_id FOR SHARE;
  v_expected := hxos_payment_capture_operation_sha256_v7(
    NEW.capture_id, NEW.capture_authority_id, NEW.lifecycle_id,
    NEW.work_order_id, NEW.financial_security_event_id, NEW.processor_code,
    NEW.approved_amount_cents, NEW.currency,
    NEW.completion_evidence_sha256::TEXT, NEW.amount_approval_sha256::TEXT,
    NEW.incident_clearance_sha256::TEXT, NEW.operation_id,
    NEW.idempotency_key, NEW.request_sha256::TEXT, NEW.created_at, NEW.expires_at
  );
  IF v_authority.capture_authority_id IS NULL
     OR v_approval.completion_approval_id IS NULL
     OR v_completion.completion_evidence_id IS NULL
     OR NEW.completion_evidence_sha256 IS DISTINCT FROM v_completion.completion_material_sha256
     OR NEW.amount_approval_sha256 IS DISTINCT FROM v_approval.amount_approval_sha256
     OR NEW.incident_clearance_sha256 IS DISTINCT FROM v_approval.incident_clearance_sha256
     OR v_authority.expires_at <= v_now
     OR NEW.idempotency_key IS DISTINCT FROM 'hx-capture-v7:' || NEW.operation_id::TEXT
     OR NEW.created_at < v_now - INTERVAL '5 seconds'
     OR NEW.created_at > v_now + INTERVAL '5 seconds'
     OR NEW.created_at < v_authority.authorized_at
     OR NEW.created_at > v_authority.expires_at
     OR NEW.expires_at > v_authority.expires_at
     OR NEW.operation_material_sha256::TEXT IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'HXPV65: capture operation lacks exact idempotent authority'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_capture_observation_v7()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_capture payment_captures_v7%ROWTYPE;
  v_latest payment_capture_operation_observations_v7%ROWTYPE;
  v_webhook payment_webhook_inbox_v7%ROWTYPE;
  v_expected TEXT;
BEGIN
  SELECT * INTO v_capture FROM payment_captures_v7
   WHERE capture_id = NEW.capture_id FOR SHARE;
  SELECT * INTO v_latest FROM payment_capture_operation_observations_v7
   WHERE capture_id = NEW.capture_id AND source = NEW.source
   ORDER BY sequence_number DESC LIMIT 1 FOR UPDATE;
  IF NEW.source = 'WEBHOOK' THEN
    SELECT * INTO v_webhook FROM payment_webhook_inbox_v7
     WHERE webhook_inbox_id = NEW.webhook_inbox_id FOR SHARE;
  END IF;
  v_expected := hxos_payment_capture_observation_sha256_v7(
    NEW.observation_id, NEW.capture_id, NEW.lifecycle_id, NEW.operation_id,
    NEW.processor_code, NEW.source, NEW.sequence_number, NEW.prior_observation_id,
    NEW.webhook_inbox_id, NEW.provider_event_id_sha256::TEXT,
    NEW.provider_operation_reference_sha256::TEXT, NEW.provider_state,
    NEW.observed_amount_cents, NEW.observed_currency,
    NEW.observed_at, NEW.provider_response_sha256::TEXT
  );
  IF v_capture.capture_id IS NULL
     OR NEW.observed_at < v_capture.created_at
     OR NEW.observed_at > v_capture.expires_at
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
       OR v_webhook.normalized_event_type IS DISTINCT FROM 'CAPTURE_' || NEW.provider_state
       OR v_webhook.processor_code IS DISTINCT FROM NEW.processor_code
       OR v_webhook.event_id_sha256 IS DISTINCT FROM NEW.provider_event_id_sha256
     ))
     OR NEW.observation_material_sha256::TEXT IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'HXPV66: capture observation is unauthenticated, stale, or contradictory'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_capture_lifecycle_transition_v7()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_completion payment_completion_evidence_v7%ROWTYPE;
  v_capture payment_captures_v7%ROWTYPE;
  v_status payment_capture_status_v7%ROWTYPE;
BEGIN
  IF NEW.stage = 'COMPLETION_SUBMITTED' THEN
    SELECT * INTO v_completion FROM payment_completion_evidence_v7
     WHERE lifecycle_id = NEW.lifecycle_id;
    IF v_completion.completion_evidence_id IS NULL
       OR NEW.evidence_sha256 IS DISTINCT FROM v_completion.completion_material_sha256 THEN
      RAISE EXCEPTION 'HXPV67: completion transition lacks exact evidence'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.stage = 'CAPTURE_PENDING' THEN
    SELECT * INTO v_capture FROM payment_captures_v7 WHERE lifecycle_id = NEW.lifecycle_id;
    IF v_capture.capture_id IS NULL
       OR v_capture.expires_at <= clock_timestamp()
       OR NEW.evidence_sha256 IS DISTINCT FROM v_capture.operation_material_sha256 THEN
      RAISE EXCEPTION 'HXPV67: capture-pending transition lacks operation authority'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.stage = 'CAPTURED' THEN
    SELECT * INTO v_status FROM payment_capture_status_v7 WHERE lifecycle_id = NEW.lifecycle_id;
    IF v_status.capture_id IS NULL
       OR v_status.agreement_state IS DISTINCT FROM 'AGREED'
       OR v_status.provider_state IS DISTINCT FROM 'SUCCEEDED'
       OR v_status.expires_at <= clock_timestamp()
       OR NEW.evidence_sha256 IS DISTINCT FROM v_status.agreement_sha256 THEN
      RAISE EXCEPTION 'HXPV67: captured transition requires API and authenticated webhook agreement'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_work_order_materialization_bundle_v7()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_work_order payment_canonical_work_orders_v7%ROWTYPE;
  v_assignment payment_work_order_assignments_v7%ROWTYPE;
  v_grant payment_private_fulfillment_grants_v7%ROWTYPE;
  v_void_count BIGINT;
  v_consumed BOOLEAN;
  v_stage TEXT;
  v_task_valid BOOLEAN;
  v_success BOOLEAN;
  v_compensation BOOLEAN;
BEGIN
  SELECT * INTO v_work_order FROM payment_canonical_work_orders_v7
   WHERE materialization_authority_id = NEW.materialization_authority_id;
  SELECT * INTO v_assignment FROM payment_work_order_assignments_v7
   WHERE materialization_authority_id = NEW.materialization_authority_id;
  SELECT * INTO v_grant FROM payment_private_fulfillment_grants_v7
   WHERE materialization_authority_id = NEW.materialization_authority_id;
  SELECT count(*) INTO v_void_count FROM payment_work_order_void_obligations_v7
   WHERE materialization_authority_id = NEW.materialization_authority_id;
  SELECT EXISTS (
    SELECT 1 FROM payment_conditional_provider_hold_status_v7
     WHERE hold_id = NEW.hold_id AND state = 'CONSUMED'
  ) INTO v_consumed;
  SELECT stage INTO v_stage FROM payment_underwriting_lifecycle_status_v7
   WHERE lifecycle_id = NEW.lifecycle_id;
  SELECT EXISTS (
    SELECT 1 FROM tasks task
    JOIN task_drafts draft
      ON draft.id = NEW.task_draft_id AND draft.poster_user_id = NEW.customer_user_id
     AND draft.task_id = task.id
   WHERE task.id = NEW.planned_task_id
     AND task.poster_id = NEW.customer_user_id
     AND task.worker_id = NEW.provider_user_id
  ) INTO v_task_valid;
  v_success := v_work_order.work_order_id IS NOT NULL
    AND v_assignment.assignment_id IS NOT NULL
    AND v_grant.grant_id IS NOT NULL
    AND v_void_count = 0 AND v_consumed AND v_task_valid
    AND v_stage IN (
      'ASSIGNED', 'IN_PROGRESS', 'COMPLETION_SUBMITTED', 'CAPTURE_PENDING', 'CAPTURED'
    );
  v_compensation := v_work_order.work_order_id IS NULL
    AND v_assignment.assignment_id IS NULL AND v_grant.grant_id IS NULL
    AND v_void_count = 1 AND NOT v_consumed
    AND v_stage = 'FINANCIALLY_SECURED'
    AND NOT EXISTS (SELECT 1 FROM tasks WHERE id = NEW.planned_task_id);
  IF NOT v_success AND NOT v_compensation THEN
    RAISE EXCEPTION 'HXPV58: materialization must commit one complete success or void graph'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS payment_completion_evidence_insert_guard_v7
  ON payment_completion_evidence_v7;
CREATE TRIGGER payment_completion_evidence_insert_guard_v7
BEFORE INSERT ON payment_completion_evidence_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_completion_evidence_v7();
DROP TRIGGER IF EXISTS payment_completion_approval_insert_guard_v7
  ON payment_completion_approvals_v7;
CREATE TRIGGER payment_completion_approval_insert_guard_v7
BEFORE INSERT ON payment_completion_approvals_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_completion_approval_v7();
DROP TRIGGER IF EXISTS payment_capture_authority_insert_guard_v7
  ON payment_capture_authorities_v7;
CREATE TRIGGER payment_capture_authority_insert_guard_v7
BEFORE INSERT ON payment_capture_authorities_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_capture_authority_v7();
DROP TRIGGER IF EXISTS payment_capture_operation_insert_guard_v7 ON payment_captures_v7;
CREATE TRIGGER payment_capture_operation_insert_guard_v7
BEFORE INSERT ON payment_captures_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_capture_operation_v7();
DROP TRIGGER IF EXISTS payment_capture_observation_insert_guard_v7
  ON payment_capture_operation_observations_v7;
CREATE TRIGGER payment_capture_observation_insert_guard_v7
BEFORE INSERT ON payment_capture_operation_observations_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_capture_observation_v7();
DROP TRIGGER IF EXISTS payment_capture_lifecycle_transition_guard_v7
  ON payment_underwriting_lifecycle_events_v7;
CREATE TRIGGER payment_capture_lifecycle_transition_guard_v7
BEFORE INSERT ON payment_underwriting_lifecycle_events_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_capture_lifecycle_transition_v7();

DO $$
DECLARE relation_name TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'payment_completion_evidence_v7',
    'payment_completion_approvals_v7',
    'payment_capture_authorities_v7',
    'payment_capture_operation_observations_v7'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', relation_name || '_append_only_v7', relation_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION hxos_reject_payment_underwriting_d6_mutation_v7()',
      relation_name || '_append_only_v7', relation_name
    );
  END LOOP;
END;
$$;

REVOKE ALL ON TABLE
  payment_completion_evidence_v7,
  payment_completion_approvals_v7,
  payment_capture_authorities_v7,
  payment_capture_operation_observations_v7,
  payment_capture_status_v7
FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_payment_completion_evidence_sha256_v7(
  UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_payment_completion_approval_sha256_v7(
  UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT,
  TIMESTAMPTZ, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_payment_capture_authority_sha256_v7(
  UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, BIGINT, TEXT, UUID,
  TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_payment_capture_operation_sha256_v7(
  UUID, UUID, UUID, UUID, UUID, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT,
  UUID, TEXT, TEXT,
  TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_payment_capture_observation_sha256_v7(
  UUID, UUID, UUID, UUID, TEXT, TEXT, INTEGER, UUID, UUID, TEXT, TEXT, TEXT,
  BIGINT, TEXT, TIMESTAMPTZ, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_payment_capture_agreement_sha256_v7(
  UUID, TEXT, TEXT, TEXT, BIGINT, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_reject_payment_underwriting_d6_mutation_v7() FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_enforce_payment_completion_evidence_v7() FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_enforce_payment_completion_approval_v7() FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_enforce_payment_capture_authority_v7() FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_enforce_payment_capture_operation_v7() FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_enforce_payment_capture_observation_v7() FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_enforce_payment_capture_lifecycle_transition_v7() FROM PUBLIC;
