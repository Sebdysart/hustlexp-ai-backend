-- HX payment-underwriting v7 D5: atomic Work Order materialization, hard
-- provider assignment, sealed private-fulfillment authority, and a fail-closed
-- void obligation when materialization cannot complete. This remains an
-- unregistered schema artifact with no runtime or processor authority.

DO $$
DECLARE
  v_catalog_complete BOOLEAN;
  v_catalog_absent BOOLEAN;
BEGIN
  IF to_regclass('public.payment_financial_security_authorities_v7') IS NULL
     OR to_regclass('public.payment_financial_security_operation_observations_v7') IS NULL
     OR to_regclass('public.payment_canonical_work_orders_v7') IS NULL
     OR to_regclass('public.task_location_vault') IS NULL THEN
    RAISE EXCEPTION 'HXPV50: D5 requires the accepted D2, D3, and D4 schema artifacts'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT
    to_regclass('public.payment_work_order_materialization_authorities_v7') IS NOT NULL
    AND to_regclass('public.payment_work_order_assignments_v7') IS NOT NULL
    AND to_regclass('public.payment_private_fulfillment_grants_v7') IS NOT NULL
    AND to_regclass('public.payment_private_fulfillment_access_events_v7') IS NOT NULL
    AND to_regclass('public.payment_work_order_void_obligations_v7') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM pg_attribute
       WHERE attrelid = 'public.payment_canonical_work_orders_v7'::regclass
         AND attname = 'materialization_authority_id'
         AND NOT attisdropped
    )
    AND EXISTS (
      SELECT 1 FROM pg_attribute
       WHERE attrelid = 'public.payment_canonical_work_orders_v7'::regclass
         AND attname = 'hold_id'
         AND NOT attisdropped
    )
  INTO v_catalog_complete;

  SELECT
    to_regclass('public.payment_work_order_materialization_authorities_v7') IS NULL
    AND to_regclass('public.payment_work_order_assignments_v7') IS NULL
    AND to_regclass('public.payment_private_fulfillment_grants_v7') IS NULL
    AND to_regclass('public.payment_private_fulfillment_access_events_v7') IS NULL
    AND to_regclass('public.payment_work_order_void_obligations_v7') IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM pg_attribute
       WHERE attrelid = 'public.payment_canonical_work_orders_v7'::regclass
         AND attname IN ('materialization_authority_id', 'hold_id')
         AND NOT attisdropped
    )
  INTO v_catalog_absent;

  IF NOT v_catalog_complete AND NOT v_catalog_absent THEN
    RAISE EXCEPTION 'HXPV50: D5 catalog is partial or contradictory'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_catalog_absent AND (
    EXISTS (SELECT 1 FROM payment_canonical_work_orders_v7)
    OR EXISTS (
      SELECT 1 FROM payment_conditional_provider_hold_events_v7
       WHERE event_type = 'CONSUMED'
    )
    OR EXISTS (
      SELECT 1 FROM payment_underwriting_lifecycle_events_v7
       WHERE stage IN ('WORK_ORDER_MATERIALIZED', 'ASSIGNED')
    )
  ) THEN
    RAISE EXCEPTION 'HXPV50: D5 cannot retrofit unauthorised work-order evidence'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_payment_work_order_materialization_authority_sha256_v7(
  p_authority_id UUID,
  p_lifecycle_id UUID,
  p_task_draft_id UUID,
  p_customer_user_id UUID,
  p_financial_security_event_id UUID,
  p_hold_id UUID,
  p_provider_account_ref_id UUID,
  p_provider_user_id UUID,
  p_processor_code TEXT,
  p_planned_task_id UUID,
  p_materialization_command_id UUID,
  p_agreement_sha256 TEXT,
  p_scope_sha256 TEXT,
  p_economics_sha256 TEXT,
  p_authorized_at TIMESTAMPTZ,
  p_expires_at TIMESTAMPTZ
)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT encode(digest(jsonb_build_object(
    'schema', 'HX_PAYMENT_WORK_ORDER_MATERIALIZATION_AUTHORITY_V7',
    'authorityId', p_authority_id,
    'lifecycleId', p_lifecycle_id,
    'taskDraftId', p_task_draft_id,
    'customerUserId', p_customer_user_id,
    'financialSecurityEventId', p_financial_security_event_id,
    'holdId', p_hold_id,
    'providerAccountRefId', p_provider_account_ref_id,
    'providerUserId', p_provider_user_id,
    'processorCode', p_processor_code,
    'plannedTaskId', p_planned_task_id,
    'materializationCommandId', p_materialization_command_id,
    'agreementSha256', p_agreement_sha256,
    'scopeSha256', p_scope_sha256,
    'economicsSha256', p_economics_sha256,
    'authorizedAt', to_char(p_authorized_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt', to_char(p_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )::TEXT, 'sha256'), 'hex')
$$;

CREATE OR REPLACE FUNCTION hxos_payment_work_order_assignment_sha256_v7(
  p_assignment_id UUID,
  p_authority_id UUID,
  p_work_order_id UUID,
  p_lifecycle_id UUID,
  p_task_id UUID,
  p_provider_account_ref_id UUID,
  p_provider_user_id UUID,
  p_processor_code TEXT,
  p_assigned_at TIMESTAMPTZ,
  p_evidence_sha256 TEXT
)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT encode(digest(jsonb_build_object(
    'schema', 'HX_PAYMENT_WORK_ORDER_ASSIGNMENT_V7',
    'assignmentId', p_assignment_id,
    'authorityId', p_authority_id,
    'workOrderId', p_work_order_id,
    'lifecycleId', p_lifecycle_id,
    'taskId', p_task_id,
    'providerAccountRefId', p_provider_account_ref_id,
    'providerUserId', p_provider_user_id,
    'processorCode', p_processor_code,
    'assignedAt', to_char(p_assigned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'evidenceSha256', p_evidence_sha256
  )::TEXT, 'sha256'), 'hex')
$$;

CREATE OR REPLACE FUNCTION hxos_payment_private_fulfillment_grant_sha256_v7(
  p_grant_id UUID,
  p_assignment_id UUID,
  p_work_order_id UUID,
  p_lifecycle_id UUID,
  p_task_id UUID,
  p_provider_user_id UUID,
  p_access_scope TEXT,
  p_location_key_id TEXT,
  p_location_fingerprint TEXT,
  p_granted_at TIMESTAMPTZ,
  p_expires_at TIMESTAMPTZ
)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT encode(digest(jsonb_build_object(
    'schema', 'HX_PAYMENT_PRIVATE_FULFILLMENT_GRANT_V7',
    'grantId', p_grant_id,
    'assignmentId', p_assignment_id,
    'workOrderId', p_work_order_id,
    'lifecycleId', p_lifecycle_id,
    'taskId', p_task_id,
    'providerUserId', p_provider_user_id,
    'accessScope', p_access_scope,
    'locationKeyId', p_location_key_id,
    'locationFingerprint', p_location_fingerprint,
    'grantedAt', to_char(p_granted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt', to_char(p_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )::TEXT, 'sha256'), 'hex')
$$;

CREATE OR REPLACE FUNCTION hxos_payment_private_fulfillment_access_event_sha256_v7(
  p_access_event_id UUID,
  p_grant_id UUID,
  p_lifecycle_id UUID,
  p_task_id UUID,
  p_provider_user_id UUID,
  p_sequence_number INTEGER,
  p_prior_access_event_id UUID,
  p_outcome TEXT,
  p_access_reason TEXT,
  p_evidence_sha256 TEXT,
  p_accessed_at TIMESTAMPTZ
)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT encode(digest(jsonb_build_object(
    'schema', 'HX_PAYMENT_PRIVATE_FULFILLMENT_ACCESS_EVENT_V7',
    'accessEventId', p_access_event_id,
    'grantId', p_grant_id,
    'lifecycleId', p_lifecycle_id,
    'taskId', p_task_id,
    'providerUserId', p_provider_user_id,
    'sequenceNumber', p_sequence_number,
    'priorAccessEventId', p_prior_access_event_id,
    'outcome', p_outcome,
    'accessReason', p_access_reason,
    'evidenceSha256', p_evidence_sha256,
    'accessedAt', to_char(p_accessed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )::TEXT, 'sha256'), 'hex')
$$;

CREATE OR REPLACE FUNCTION hxos_payment_work_order_void_obligation_sha256_v7(
  p_obligation_id UUID,
  p_authority_id UUID,
  p_lifecycle_id UUID,
  p_financial_security_event_id UUID,
  p_original_operation_id UUID,
  p_void_operation_id UUID,
  p_processor_code TEXT,
  p_idempotency_key TEXT,
  p_reason_code TEXT,
  p_request_sha256 TEXT,
  p_planned_at TIMESTAMPTZ,
  p_evidence_sha256 TEXT
)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT encode(digest(jsonb_build_object(
    'schema', 'HX_PAYMENT_WORK_ORDER_VOID_OBLIGATION_V7',
    'obligationId', p_obligation_id,
    'authorityId', p_authority_id,
    'lifecycleId', p_lifecycle_id,
    'financialSecurityEventId', p_financial_security_event_id,
    'originalOperationId', p_original_operation_id,
    'voidOperationId', p_void_operation_id,
    'processorCode', p_processor_code,
    'idempotencyKey', p_idempotency_key,
    'reasonCode', p_reason_code,
    'requestSha256', p_request_sha256,
    'plannedAt', to_char(p_planned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'evidenceSha256', p_evidence_sha256
  )::TEXT, 'sha256'), 'hex')
$$;

CREATE UNIQUE INDEX IF NOT EXISTS payment_fse_d5_materialization_binding_uq
  ON payment_financial_security_events_v7(
    financial_security_event_id, lifecycle_id, task_draft_id, customer_user_id,
    hold_id, provider_account_ref_id, processor_code
  );
CREATE UNIQUE INDEX IF NOT EXISTS payment_hold_d5_materialization_binding_uq
  ON payment_conditional_provider_holds_v7(
    hold_id, lifecycle_id, provider_account_ref_id, provider_user_id
  );
CREATE UNIQUE INDEX IF NOT EXISTS payment_provider_d5_materialization_binding_uq
  ON payment_provider_account_refs_v7(
    provider_account_ref_id, provider_user_id, processor_code
  );
CREATE UNIQUE INDEX IF NOT EXISTS tasks_d5_assignment_binding_uq
  ON tasks(id, poster_id, worker_id);

CREATE TABLE IF NOT EXISTS payment_work_order_materialization_authorities_v7 (
  materialization_authority_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lifecycle_id UUID NOT NULL UNIQUE,
  task_draft_id UUID NOT NULL,
  customer_user_id UUID NOT NULL,
  financial_security_event_id UUID NOT NULL UNIQUE,
  hold_id UUID NOT NULL UNIQUE,
  provider_account_ref_id UUID NOT NULL,
  provider_user_id UUID NOT NULL,
  processor_code TEXT NOT NULL CHECK (processor_code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  planned_task_id UUID NOT NULL UNIQUE,
  materialization_command_id UUID NOT NULL UNIQUE,
  agreement_sha256 CHAR(64) NOT NULL CHECK (agreement_sha256 ~ '^[0-9a-f]{64}$'),
  scope_sha256 CHAR(64) NOT NULL CHECK (scope_sha256 ~ '^[0-9a-f]{64}$'),
  economics_sha256 CHAR(64) NOT NULL CHECK (economics_sha256 ~ '^[0-9a-f]{64}$'),
  authorized_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  authority_sha256 CHAR(64) NOT NULL UNIQUE CHECK (authority_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (
    materialization_authority_id, lifecycle_id, task_draft_id, customer_user_id,
    financial_security_event_id, hold_id, provider_account_ref_id,
    provider_user_id, processor_code, planned_task_id, materialization_command_id
  ),
  UNIQUE (materialization_authority_id, lifecycle_id, financial_security_event_id),
  FOREIGN KEY (
    financial_security_event_id, lifecycle_id, task_draft_id, customer_user_id,
    hold_id, provider_account_ref_id, processor_code
  ) REFERENCES payment_financial_security_events_v7(
    financial_security_event_id, lifecycle_id, task_draft_id, customer_user_id,
    hold_id, provider_account_ref_id, processor_code
  ) ON DELETE RESTRICT,
  FOREIGN KEY (hold_id, lifecycle_id, provider_account_ref_id, provider_user_id)
    REFERENCES payment_conditional_provider_holds_v7(
      hold_id, lifecycle_id, provider_account_ref_id, provider_user_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (provider_account_ref_id, provider_user_id, processor_code)
    REFERENCES payment_provider_account_refs_v7(
      provider_account_ref_id, provider_user_id, processor_code
    ) ON DELETE RESTRICT,
  FOREIGN KEY (lifecycle_id, task_draft_id)
    REFERENCES payment_underwriting_lifecycles_v7(lifecycle_id, task_draft_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (task_draft_id, customer_user_id)
    REFERENCES task_drafts(id, poster_user_id) ON DELETE RESTRICT,
  CHECK (expires_at > authorized_at)
);

ALTER TABLE payment_canonical_work_orders_v7
  ADD COLUMN IF NOT EXISTS materialization_authority_id UUID,
  ADD COLUMN IF NOT EXISTS hold_id UUID;

ALTER TABLE payment_canonical_work_orders_v7
  ALTER COLUMN materialization_authority_id SET NOT NULL,
  ALTER COLUMN hold_id SET NOT NULL,
  ALTER COLUMN assigned_provider_user_id SET NOT NULL,
  DROP CONSTRAINT IF EXISTS payment_canonical_work_orders_v7_d5_authority_fk,
  ADD CONSTRAINT payment_canonical_work_orders_v7_d5_authority_fk
    FOREIGN KEY (
      materialization_authority_id, lifecycle_id, task_draft_id, customer_user_id,
      financial_security_event_id, hold_id, provider_account_ref_id,
      assigned_provider_user_id, processor_code, task_id, materialization_command_id
    ) REFERENCES payment_work_order_materialization_authorities_v7(
      materialization_authority_id, lifecycle_id, task_draft_id, customer_user_id,
      financial_security_event_id, hold_id, provider_account_ref_id,
      provider_user_id, processor_code, planned_task_id, materialization_command_id
    ) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS payment_canonical_work_orders_v7_d5_binding_uq
  ON payment_canonical_work_orders_v7(
    work_order_id, lifecycle_id, task_draft_id, customer_user_id,
    financial_security_event_id, hold_id, provider_account_ref_id,
    assigned_provider_user_id, processor_code, task_id, materialization_authority_id
  );

CREATE TABLE IF NOT EXISTS payment_work_order_assignments_v7 (
  assignment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  materialization_authority_id UUID NOT NULL UNIQUE,
  work_order_id UUID NOT NULL UNIQUE,
  lifecycle_id UUID NOT NULL UNIQUE,
  task_draft_id UUID NOT NULL,
  customer_user_id UUID NOT NULL,
  financial_security_event_id UUID NOT NULL,
  hold_id UUID NOT NULL UNIQUE,
  task_id UUID NOT NULL UNIQUE,
  provider_account_ref_id UUID NOT NULL,
  provider_user_id UUID NOT NULL,
  processor_code TEXT NOT NULL CHECK (processor_code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  assigned_at TIMESTAMPTZ NOT NULL,
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  assignment_sha256 CHAR(64) NOT NULL UNIQUE CHECK (assignment_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (
    assignment_id, materialization_authority_id, work_order_id, lifecycle_id,
    task_id, provider_account_ref_id, provider_user_id, processor_code
  ),
  FOREIGN KEY (
    work_order_id, lifecycle_id, task_draft_id, customer_user_id,
    financial_security_event_id, hold_id, provider_account_ref_id,
    provider_user_id, processor_code, task_id, materialization_authority_id
  ) REFERENCES payment_canonical_work_orders_v7(
    work_order_id, lifecycle_id, task_draft_id, customer_user_id,
    financial_security_event_id, hold_id, provider_account_ref_id,
    assigned_provider_user_id, processor_code, task_id, materialization_authority_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (task_id, customer_user_id, provider_user_id)
    REFERENCES tasks(id, poster_id, worker_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS payment_private_fulfillment_grants_v7 (
  grant_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID NOT NULL UNIQUE,
  materialization_authority_id UUID NOT NULL UNIQUE,
  work_order_id UUID NOT NULL UNIQUE,
  lifecycle_id UUID NOT NULL UNIQUE,
  task_id UUID NOT NULL UNIQUE,
  provider_account_ref_id UUID NOT NULL,
  provider_user_id UUID NOT NULL,
  processor_code TEXT NOT NULL CHECK (processor_code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  access_scope TEXT NOT NULL CHECK (access_scope = 'EXACT_FULFILLMENT_LOCATION'),
  location_key_id TEXT NOT NULL CHECK (length(location_key_id) BETWEEN 1 AND 160),
  location_fingerprint CHAR(64) NOT NULL CHECK (location_fingerprint ~ '^[0-9a-f]{64}$'),
  granted_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  grant_sha256 CHAR(64) NOT NULL UNIQUE CHECK (grant_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (
    grant_id, assignment_id, materialization_authority_id, work_order_id,
    lifecycle_id, task_id, provider_user_id
  ),
  UNIQUE (grant_id, lifecycle_id, task_id, provider_user_id),
  FOREIGN KEY (
    assignment_id, materialization_authority_id, work_order_id, lifecycle_id,
    task_id, provider_account_ref_id, provider_user_id, processor_code
  ) REFERENCES payment_work_order_assignments_v7(
    assignment_id, materialization_authority_id, work_order_id, lifecycle_id,
    task_id, provider_account_ref_id, provider_user_id, processor_code
  ) ON DELETE RESTRICT,
  FOREIGN KEY (task_id) REFERENCES task_location_vault(task_id) ON DELETE RESTRICT,
  CHECK (expires_at > granted_at)
);

CREATE TABLE IF NOT EXISTS payment_private_fulfillment_access_events_v7 (
  access_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id UUID NOT NULL REFERENCES payment_private_fulfillment_grants_v7(grant_id) ON DELETE RESTRICT,
  lifecycle_id UUID NOT NULL,
  task_id UUID NOT NULL,
  provider_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
  prior_access_event_id UUID REFERENCES payment_private_fulfillment_access_events_v7(access_event_id)
    ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (outcome IN ('AUTHORIZED', 'DENIED', 'EXPIRED')),
  access_reason TEXT NOT NULL CHECK (access_reason = 'FULFILLMENT_EXECUTION'),
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  access_material_sha256 CHAR(64) NOT NULL UNIQUE CHECK (access_material_sha256 ~ '^[0-9a-f]{64}$'),
  accessed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (grant_id, sequence_number),
  FOREIGN KEY (grant_id, lifecycle_id, task_id, provider_user_id)
    REFERENCES payment_private_fulfillment_grants_v7(
      grant_id, lifecycle_id, task_id, provider_user_id
    ) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS payment_work_order_void_obligations_v7 (
  obligation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  materialization_authority_id UUID NOT NULL UNIQUE,
  lifecycle_id UUID NOT NULL UNIQUE,
  financial_security_event_id UUID NOT NULL UNIQUE,
  original_operation_id UUID NOT NULL,
  void_operation_id UUID NOT NULL UNIQUE,
  processor_code TEXT NOT NULL CHECK (processor_code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 16 AND 160),
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'TASK_MATERIALIZATION_FAILED', 'ASSIGNMENT_FAILED', 'PRIVATE_FULFILLMENT_SEAL_FAILED'
  )),
  state TEXT NOT NULL DEFAULT 'PLANNED' CHECK (state = 'PLANNED'),
  request_sha256 CHAR(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  planned_at TIMESTAMPTZ NOT NULL,
  obligation_sha256 CHAR(64) NOT NULL UNIQUE CHECK (obligation_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (materialization_authority_id, lifecycle_id, financial_security_event_id)
    REFERENCES payment_work_order_materialization_authorities_v7(
      materialization_authority_id, lifecycle_id, financial_security_event_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (original_operation_id)
    REFERENCES payment_financial_security_events_v7(operation_id) ON DELETE RESTRICT,
  CHECK (void_operation_id <> original_operation_id)
);

CREATE OR REPLACE FUNCTION hxos_assert_payment_private_fulfillment_access_history_v7()
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM (
        SELECT
          grant_id,
          accessed_at,
          lag(accessed_at) OVER (
            PARTITION BY grant_id ORDER BY sequence_number
          ) AS prior_accessed_at
        FROM payment_private_fulfillment_access_events_v7
      ) ordered_access
     WHERE ordered_access.prior_accessed_at IS NOT NULL
       AND ordered_access.accessed_at < ordered_access.prior_accessed_at
  ) OR EXISTS (
    SELECT 1
      FROM payment_private_fulfillment_access_events_v7 access
      JOIN payment_private_fulfillment_grants_v7 grant_row
        ON grant_row.grant_id = access.grant_id
      LEFT JOIN task_location_vault vault
        ON vault.task_id = access.task_id
     WHERE access.outcome = 'AUTHORIZED'
       AND (
         vault.task_id IS NULL
         OR vault.location_key_id IS DISTINCT FROM grant_row.location_key_id
         OR vault.location_fingerprint IS DISTINCT FROM grant_row.location_fingerprint
         OR (
           vault.expired_at IS NOT NULL
           AND (
             access.accessed_at >= vault.expired_at
             OR access.created_at >= vault.expired_at
           )
         )
       )
  ) THEN
    RAISE EXCEPTION 'HXPV59: existing private fulfillment access history is contradictory'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

SELECT hxos_assert_payment_private_fulfillment_access_history_v7();

CREATE OR REPLACE FUNCTION hxos_reject_payment_underwriting_d5_mutation_v7()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'HXPV51: payment underwriting D5 evidence is append-only'
    USING ERRCODE = 'P0001';
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_work_order_materialization_authority_v7()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_lifecycle payment_underwriting_lifecycle_status_v7%ROWTYPE;
  v_financial payment_financial_security_status_v7%ROWTYPE;
  v_hold payment_conditional_provider_holds_v7%ROWTYPE;
  v_hold_state TEXT;
  v_provider payment_provider_account_refs_v7%ROWTYPE;
  v_draft_task_id UUID;
  v_expected TEXT;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO v_lifecycle FROM payment_underwriting_lifecycle_status_v7
   WHERE lifecycle_id = NEW.lifecycle_id;
  SELECT * INTO v_financial FROM payment_financial_security_status_v7
   WHERE financial_security_event_id = NEW.financial_security_event_id
     AND lifecycle_id = NEW.lifecycle_id;
  SELECT * INTO v_hold FROM payment_conditional_provider_holds_v7
   WHERE hold_id = NEW.hold_id FOR SHARE;
  SELECT state INTO v_hold_state FROM payment_conditional_provider_hold_status_v7
   WHERE hold_id = NEW.hold_id;
  SELECT * INTO v_provider FROM payment_provider_account_refs_v7
   WHERE provider_account_ref_id = NEW.provider_account_ref_id
     AND provider_user_id = NEW.provider_user_id
     AND processor_code = NEW.processor_code
   FOR SHARE;
  SELECT task_id INTO v_draft_task_id FROM task_drafts
   WHERE id = NEW.task_draft_id AND poster_user_id = NEW.customer_user_id
   FOR SHARE;
  v_expected := hxos_payment_work_order_materialization_authority_sha256_v7(
    NEW.materialization_authority_id, NEW.lifecycle_id, NEW.task_draft_id,
    NEW.customer_user_id, NEW.financial_security_event_id, NEW.hold_id,
    NEW.provider_account_ref_id, NEW.provider_user_id, NEW.processor_code,
    NEW.planned_task_id, NEW.materialization_command_id, NEW.agreement_sha256::TEXT,
    NEW.scope_sha256::TEXT, NEW.economics_sha256::TEXT,
    NEW.authorized_at, NEW.expires_at
  );
  IF v_lifecycle.stage IS DISTINCT FROM 'FINANCIALLY_SECURED'
     OR v_financial.agreement_state IS DISTINCT FROM 'AGREED'
     OR v_financial.provider_state IS DISTINCT FROM 'SUCCEEDED'
     OR v_financial.agreement_sha256 IS DISTINCT FROM NEW.agreement_sha256::TEXT
     OR v_financial.provider_expires_at <= v_now
     OR v_hold_state IS DISTINCT FROM 'SOFT_RESERVED'
     OR v_hold.expires_at <= v_now
     OR NEW.scope_sha256 IS DISTINCT FROM v_hold.scope_sha256
     OR NEW.economics_sha256 IS DISTINCT FROM v_hold.provider_economics_sha256
     OR v_provider.provider_account_ref_id IS NULL
     OR v_provider.eligibility_state IS DISTINCT FROM 'ELIGIBLE'
     OR v_provider.funding_state IS DISTINCT FROM 'READY'
     OR v_provider.expires_at <= v_now
     OR v_provider.expires_at < NEW.expires_at
     OR v_draft_task_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM tasks WHERE id = NEW.planned_task_id)
     OR NEW.authorized_at < v_lifecycle.stage_recorded_at
     OR NEW.authorized_at < v_now - INTERVAL '5 seconds'
     OR NEW.authorized_at > v_now + INTERVAL '5 seconds'
     OR NEW.expires_at > v_financial.provider_expires_at
     OR NEW.expires_at > v_hold.expires_at
     OR NEW.expires_at <= v_now
     OR NEW.authority_sha256::TEXT IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'HXPV52: work-order authority lacks current FSE and hold agreement'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_canonical_work_order_v7()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_authority payment_work_order_materialization_authorities_v7%ROWTYPE;
  v_financial payment_financial_security_status_v7%ROWTYPE;
  v_hold_state TEXT;
  v_task_worker UUID;
  v_location_ready BOOLEAN;
  v_expected TEXT;
BEGIN
  SELECT * INTO v_authority FROM payment_work_order_materialization_authorities_v7
   WHERE materialization_authority_id = NEW.materialization_authority_id
   FOR UPDATE;
  SELECT * INTO v_financial FROM payment_financial_security_status_v7
   WHERE financial_security_event_id = NEW.financial_security_event_id;
  SELECT state INTO v_hold_state FROM payment_conditional_provider_hold_status_v7
   WHERE hold_id = NEW.hold_id;
  SELECT worker_id INTO v_task_worker FROM tasks WHERE id = NEW.task_id FOR UPDATE;
  SELECT TRUE INTO v_location_ready FROM task_location_vault
   WHERE task_id = NEW.task_id
     AND expired_at IS NULL
     AND location_ciphertext IS NOT NULL
     AND location_nonce IS NOT NULL
     AND location_auth_tag IS NOT NULL
     AND location_key_id IS NOT NULL
     AND location_fingerprint IS NOT NULL
   FOR SHARE;
  v_expected := encode(digest(jsonb_build_object(
    'schema', 'HX_PAYMENT_CANONICAL_WORK_ORDER_MATERIALIZATION_V7',
    'workOrderId', NEW.work_order_id,
    'authorityId', NEW.materialization_authority_id,
    'lifecycleId', NEW.lifecycle_id,
    'taskDraftId', NEW.task_draft_id,
    'customerUserId', NEW.customer_user_id,
    'financialSecurityEventId', NEW.financial_security_event_id,
    'holdId', NEW.hold_id,
    'providerAccountRefId', NEW.provider_account_ref_id,
    'providerUserId', NEW.assigned_provider_user_id,
    'processorCode', NEW.processor_code,
    'taskId', NEW.task_id,
    'scopeSha256', NEW.scope_sha256,
    'economicsSha256', NEW.economics_sha256,
    'materializationCommandId', NEW.materialization_command_id,
    'createdAt', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )::TEXT, 'sha256'), 'hex');
  IF v_authority.materialization_authority_id IS NULL
     OR v_financial.agreement_state IS DISTINCT FROM 'AGREED'
     OR v_financial.provider_state IS DISTINCT FROM 'SUCCEEDED'
     OR v_financial.provider_expires_at <= NEW.created_at
     OR v_hold_state IS DISTINCT FROM 'SOFT_RESERVED'
     OR NEW.created_at < v_authority.authorized_at
     OR NEW.created_at > v_authority.expires_at
     OR v_task_worker IS DISTINCT FROM NEW.assigned_provider_user_id
     OR v_location_ready IS DISTINCT FROM TRUE
     OR NEW.scope_sha256 IS DISTINCT FROM v_authority.scope_sha256
     OR NEW.economics_sha256 IS DISTINCT FROM v_authority.economics_sha256
     OR NEW.materialization_sha256::TEXT IS DISTINCT FROM v_expected
     OR EXISTS (
       SELECT 1 FROM payment_work_order_void_obligations_v7
        WHERE materialization_authority_id = NEW.materialization_authority_id
     ) THEN
    RAISE EXCEPTION 'HXPV53: canonical Work Order lacks exact materialization authority'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_work_order_assignment_v7()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_authority payment_work_order_materialization_authorities_v7%ROWTYPE;
  v_work_order payment_canonical_work_orders_v7%ROWTYPE;
  v_expected TEXT;
BEGIN
  SELECT * INTO v_authority FROM payment_work_order_materialization_authorities_v7
   WHERE materialization_authority_id = NEW.materialization_authority_id FOR SHARE;
  SELECT * INTO v_work_order FROM payment_canonical_work_orders_v7
   WHERE work_order_id = NEW.work_order_id FOR SHARE;
  v_expected := hxos_payment_work_order_assignment_sha256_v7(
    NEW.assignment_id, NEW.materialization_authority_id, NEW.work_order_id,
    NEW.lifecycle_id, NEW.task_id, NEW.provider_account_ref_id,
    NEW.provider_user_id, NEW.processor_code, NEW.assigned_at,
    NEW.evidence_sha256::TEXT
  );
  IF v_authority.materialization_authority_id IS NULL
     OR v_work_order.work_order_id IS NULL
     OR NEW.assigned_at < v_work_order.created_at
     OR NEW.assigned_at > v_authority.expires_at
     OR NEW.assignment_sha256::TEXT IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'HXPV54: hard assignment lacks the exact Work Order authority'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_private_fulfillment_grant_v7()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_assignment payment_work_order_assignments_v7%ROWTYPE;
  v_authority payment_work_order_materialization_authorities_v7%ROWTYPE;
  v_location_ready BOOLEAN;
  v_expected TEXT;
BEGIN
  SELECT * INTO v_assignment FROM payment_work_order_assignments_v7
   WHERE assignment_id = NEW.assignment_id FOR SHARE;
  SELECT * INTO v_authority FROM payment_work_order_materialization_authorities_v7
   WHERE materialization_authority_id = NEW.materialization_authority_id FOR SHARE;
  SELECT TRUE INTO v_location_ready FROM task_location_vault
   WHERE task_id = NEW.task_id
     AND expired_at IS NULL
     AND location_ciphertext IS NOT NULL
     AND location_nonce IS NOT NULL
     AND location_auth_tag IS NOT NULL
     AND location_key_id = NEW.location_key_id
     AND location_fingerprint = NEW.location_fingerprint
   FOR SHARE;
  v_expected := hxos_payment_private_fulfillment_grant_sha256_v7(
    NEW.grant_id, NEW.assignment_id, NEW.work_order_id, NEW.lifecycle_id,
    NEW.task_id, NEW.provider_user_id, NEW.access_scope, NEW.location_key_id,
    NEW.location_fingerprint::TEXT, NEW.granted_at, NEW.expires_at
  );
  IF v_assignment.assignment_id IS NULL
     OR v_authority.materialization_authority_id IS NULL
     OR v_location_ready IS DISTINCT FROM TRUE
     OR NEW.granted_at < v_assignment.assigned_at
     OR NEW.granted_at > v_authority.expires_at
     OR NEW.expires_at > v_authority.expires_at
     OR NEW.expires_at <= NEW.granted_at
     OR NEW.grant_sha256::TEXT IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'HXPV55: private fulfillment grant lacks sealed hard-assignment authority'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_private_fulfillment_access_event_v7()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_grant payment_private_fulfillment_grants_v7%ROWTYPE;
  v_latest payment_private_fulfillment_access_events_v7%ROWTYPE;
  v_location_ready BOOLEAN;
  v_expected TEXT;
BEGIN
  SELECT * INTO v_grant FROM payment_private_fulfillment_grants_v7
   WHERE grant_id = NEW.grant_id FOR SHARE;
  SELECT * INTO v_latest FROM payment_private_fulfillment_access_events_v7
   WHERE grant_id = NEW.grant_id ORDER BY sequence_number DESC LIMIT 1 FOR UPDATE;
  SELECT TRUE INTO v_location_ready FROM task_location_vault
   WHERE task_id = NEW.task_id
     AND expired_at IS NULL
     AND location_ciphertext IS NOT NULL
     AND location_nonce IS NOT NULL
     AND location_auth_tag IS NOT NULL
     AND location_key_id = v_grant.location_key_id
     AND location_fingerprint = v_grant.location_fingerprint
   FOR SHARE;
  v_expected := hxos_payment_private_fulfillment_access_event_sha256_v7(
    NEW.access_event_id, NEW.grant_id, NEW.lifecycle_id, NEW.task_id,
    NEW.provider_user_id, NEW.sequence_number, NEW.prior_access_event_id,
    NEW.outcome, NEW.access_reason, NEW.evidence_sha256::TEXT, NEW.accessed_at
  );
  IF v_grant.grant_id IS NULL
     OR NEW.provider_user_id IS DISTINCT FROM v_grant.provider_user_id
     OR NEW.accessed_at < v_grant.granted_at
     OR (NEW.outcome = 'AUTHORIZED' AND NEW.accessed_at >= v_grant.expires_at)
     OR (NEW.outcome = 'AUTHORIZED' AND v_location_ready IS DISTINCT FROM TRUE)
     OR NEW.access_material_sha256::TEXT IS DISTINCT FROM v_expected
     OR (v_latest.access_event_id IS NULL AND (
       NEW.sequence_number <> 1 OR NEW.prior_access_event_id IS NOT NULL
     ))
     OR (v_latest.access_event_id IS NOT NULL AND (
       NEW.sequence_number <> v_latest.sequence_number + 1
       OR NEW.prior_access_event_id IS DISTINCT FROM v_latest.access_event_id
       OR NEW.accessed_at < v_latest.accessed_at
     )) THEN
    RAISE EXCEPTION 'HXPV56: private fulfillment access evidence is stale or unbound'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_work_order_void_obligation_v7()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_authority payment_work_order_materialization_authorities_v7%ROWTYPE;
  v_operation payment_financial_security_events_v7%ROWTYPE;
  v_stage TEXT;
  v_expected TEXT;
BEGIN
  SELECT * INTO v_authority FROM payment_work_order_materialization_authorities_v7
   WHERE materialization_authority_id = NEW.materialization_authority_id FOR UPDATE;
  SELECT * INTO v_operation FROM payment_financial_security_events_v7
   WHERE financial_security_event_id = NEW.financial_security_event_id FOR SHARE;
  SELECT stage INTO v_stage FROM payment_underwriting_lifecycle_status_v7
   WHERE lifecycle_id = NEW.lifecycle_id;
  v_expected := hxos_payment_work_order_void_obligation_sha256_v7(
    NEW.obligation_id, NEW.materialization_authority_id, NEW.lifecycle_id,
    NEW.financial_security_event_id, NEW.original_operation_id,
    NEW.void_operation_id, NEW.processor_code, NEW.idempotency_key,
    NEW.reason_code, NEW.request_sha256::TEXT, NEW.planned_at,
    NEW.evidence_sha256::TEXT
  );
  IF v_authority.materialization_authority_id IS NULL
     OR v_operation.financial_security_event_id IS NULL
     OR NEW.original_operation_id IS DISTINCT FROM v_operation.operation_id
     OR NEW.processor_code IS DISTINCT FROM v_operation.processor_code
     OR v_stage IS DISTINCT FROM 'FINANCIALLY_SECURED'
     OR NEW.planned_at < v_authority.authorized_at
     OR NEW.planned_at > v_authority.expires_at
     OR NEW.idempotency_key IS DISTINCT FROM
       'hx-fse-void-v7:' || NEW.void_operation_id::TEXT
     OR NEW.obligation_sha256::TEXT IS DISTINCT FROM v_expected
     OR EXISTS (
       SELECT 1 FROM payment_canonical_work_orders_v7
        WHERE materialization_authority_id = NEW.materialization_authority_id
     ) THEN
    RAISE EXCEPTION 'HXPV57: void obligation is not bound to a failed materialization'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_work_order_materialization_bundle_v7()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
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
      ON draft.id = NEW.task_draft_id
     AND draft.poster_user_id = NEW.customer_user_id
     AND draft.task_id = task.id
    JOIN task_location_vault vault ON vault.task_id = task.id
   WHERE task.id = NEW.planned_task_id
     AND task.poster_id = NEW.customer_user_id
     AND task.worker_id = NEW.provider_user_id
     AND task.state = 'ACCEPTED'
     AND vault.expired_at IS NULL
     AND vault.location_ciphertext IS NOT NULL
     AND vault.location_nonce IS NOT NULL
     AND vault.location_auth_tag IS NOT NULL
     AND vault.location_key_id = v_grant.location_key_id
     AND vault.location_fingerprint = v_grant.location_fingerprint
  ) INTO v_task_valid;

  v_success := v_work_order.work_order_id IS NOT NULL
    AND v_assignment.assignment_id IS NOT NULL
    AND v_grant.grant_id IS NOT NULL
    AND v_void_count = 0
    AND v_consumed
    AND v_stage = 'ASSIGNED'
    AND v_task_valid;
  v_compensation := v_work_order.work_order_id IS NULL
    AND v_assignment.assignment_id IS NULL
    AND v_grant.grant_id IS NULL
    AND v_void_count = 1
    AND NOT v_consumed
    AND v_stage = 'FINANCIALLY_SECURED'
    AND NOT EXISTS (SELECT 1 FROM tasks WHERE id = NEW.planned_task_id);

  IF NOT v_success AND NOT v_compensation THEN
    RAISE EXCEPTION 'HXPV58: materialization must commit one complete success or void graph'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_fse_lifecycle_transition_v7()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_status payment_financial_security_status_v7%ROWTYPE;
  v_hold_state TEXT;
  v_hold_expires_at TIMESTAMPTZ;
  v_work_order payment_canonical_work_orders_v7%ROWTYPE;
  v_assignment payment_work_order_assignments_v7%ROWTYPE;
  v_grant payment_private_fulfillment_grants_v7%ROWTYPE;
BEGIN
  IF NEW.stage NOT IN (
    'FINANCIAL_SECURITY_PENDING', 'FINANCIALLY_SECURED',
    'WORK_ORDER_MATERIALIZED', 'ASSIGNED'
  ) THEN
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
  IF NEW.stage IN ('WORK_ORDER_MATERIALIZED', 'ASSIGNED') THEN
    SELECT * INTO v_work_order FROM payment_canonical_work_orders_v7
     WHERE lifecycle_id = NEW.lifecycle_id;
    SELECT * INTO v_assignment FROM payment_work_order_assignments_v7
     WHERE lifecycle_id = NEW.lifecycle_id;
    SELECT * INTO v_grant FROM payment_private_fulfillment_grants_v7
     WHERE lifecycle_id = NEW.lifecycle_id;
    IF v_work_order.work_order_id IS NULL
       OR v_assignment.assignment_id IS NULL
       OR v_grant.grant_id IS NULL
       OR v_hold_state IS DISTINCT FROM 'CONSUMED'
       OR (NEW.stage = 'WORK_ORDER_MATERIALIZED'
         AND NEW.evidence_sha256 IS DISTINCT FROM v_work_order.materialization_sha256)
       OR (NEW.stage = 'ASSIGNED'
         AND NEW.evidence_sha256 IS DISTINCT FROM v_assignment.assignment_sha256) THEN
      RAISE EXCEPTION 'HXPV59: lifecycle transition lacks the complete materialization graph'
        USING ERRCODE = 'P0001';
    END IF;
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
  v_stage TEXT;
  v_work_order payment_canonical_work_orders_v7%ROWTYPE;
  v_assignment payment_work_order_assignments_v7%ROWTYPE;
  v_grant payment_private_fulfillment_grants_v7%ROWTYPE;
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
    SELECT stage INTO v_stage FROM payment_underwriting_lifecycle_status_v7
     WHERE lifecycle_id = v_hold.lifecycle_id;
    SELECT * INTO v_work_order FROM payment_canonical_work_orders_v7
     WHERE lifecycle_id = v_hold.lifecycle_id;
    SELECT * INTO v_assignment FROM payment_work_order_assignments_v7
     WHERE lifecycle_id = v_hold.lifecycle_id;
    SELECT * INTO v_grant FROM payment_private_fulfillment_grants_v7
     WHERE lifecycle_id = v_hold.lifecycle_id;
    IF v_stage IS DISTINCT FROM 'FINANCIALLY_SECURED'
       OR v_work_order.work_order_id IS NULL
       OR v_assignment.assignment_id IS NULL
       OR v_grant.grant_id IS NULL
       OR v_work_order.hold_id IS DISTINCT FROM NEW.hold_id
       OR NEW.event_material_sha256 IS DISTINCT FROM v_work_order.materialization_sha256 THEN
      RAISE EXCEPTION 'HXPV59: hold consumption lacks complete materialization authority'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payment_work_order_authority_insert_guard_v7
  ON payment_work_order_materialization_authorities_v7;
CREATE TRIGGER payment_work_order_authority_insert_guard_v7
BEFORE INSERT ON payment_work_order_materialization_authorities_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_work_order_materialization_authority_v7();

DROP TRIGGER IF EXISTS payment_canonical_work_order_insert_guard_v7
  ON payment_canonical_work_orders_v7;
CREATE TRIGGER payment_canonical_work_order_insert_guard_v7
BEFORE INSERT ON payment_canonical_work_orders_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_canonical_work_order_v7();

DROP TRIGGER IF EXISTS payment_work_order_assignment_insert_guard_v7
  ON payment_work_order_assignments_v7;
CREATE TRIGGER payment_work_order_assignment_insert_guard_v7
BEFORE INSERT ON payment_work_order_assignments_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_work_order_assignment_v7();

DROP TRIGGER IF EXISTS payment_private_fulfillment_grant_insert_guard_v7
  ON payment_private_fulfillment_grants_v7;
CREATE TRIGGER payment_private_fulfillment_grant_insert_guard_v7
BEFORE INSERT ON payment_private_fulfillment_grants_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_private_fulfillment_grant_v7();

DROP TRIGGER IF EXISTS payment_private_fulfillment_access_insert_guard_v7
  ON payment_private_fulfillment_access_events_v7;
CREATE TRIGGER payment_private_fulfillment_access_insert_guard_v7
BEFORE INSERT ON payment_private_fulfillment_access_events_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_private_fulfillment_access_event_v7();

DROP TRIGGER IF EXISTS payment_work_order_void_insert_guard_v7
  ON payment_work_order_void_obligations_v7;
CREATE TRIGGER payment_work_order_void_insert_guard_v7
BEFORE INSERT ON payment_work_order_void_obligations_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_work_order_void_obligation_v7();

DROP TRIGGER IF EXISTS payment_work_order_materialization_bundle_v7
  ON payment_work_order_materialization_authorities_v7;
CREATE CONSTRAINT TRIGGER payment_work_order_materialization_bundle_v7
AFTER INSERT ON payment_work_order_materialization_authorities_v7
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_work_order_materialization_bundle_v7();

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
    'payment_work_order_materialization_authorities_v7',
    'payment_work_order_assignments_v7',
    'payment_private_fulfillment_grants_v7',
    'payment_private_fulfillment_access_events_v7',
    'payment_work_order_void_obligations_v7'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', relation_name || '_append_only_v7', relation_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION hxos_reject_payment_underwriting_d5_mutation_v7()',
      relation_name || '_append_only_v7', relation_name
    );
  END LOOP;
END;
$$;

REVOKE ALL ON TABLE
  payment_work_order_materialization_authorities_v7,
  payment_work_order_assignments_v7,
  payment_private_fulfillment_grants_v7,
  payment_private_fulfillment_access_events_v7,
  payment_work_order_void_obligations_v7
FROM PUBLIC;

REVOKE ALL ON FUNCTION hxos_payment_work_order_materialization_authority_sha256_v7(
  UUID, UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, UUID, UUID,
  TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_payment_work_order_assignment_sha256_v7(
  UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TIMESTAMPTZ, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_payment_private_fulfillment_grant_sha256_v7(
  UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_payment_private_fulfillment_access_event_sha256_v7(
  UUID, UUID, UUID, UUID, UUID, INTEGER, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ
) FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_assert_payment_private_fulfillment_access_history_v7()
FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_payment_work_order_void_obligation_sha256_v7(
  UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_reject_payment_underwriting_d5_mutation_v7() FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_enforce_payment_work_order_materialization_authority_v7() FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_enforce_payment_canonical_work_order_v7() FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_enforce_payment_work_order_assignment_v7() FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_enforce_payment_private_fulfillment_grant_v7() FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_enforce_payment_private_fulfillment_access_event_v7() FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_enforce_payment_work_order_void_obligation_v7() FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_enforce_payment_work_order_materialization_bundle_v7() FROM PUBLIC;
