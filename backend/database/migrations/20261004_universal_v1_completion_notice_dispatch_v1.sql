-- Universal V1 completion-notice dispatch and synthetic receipt binding.
--
-- A provider completion submission now commits one durable customer notice
-- request, one EMAIL outbox row, and one matching outbox event in the same
-- transaction.  Delivery remains asynchronous and is accepted only from the
-- deterministic SMTP sink in an unassigned, payment-frozen CONTROLLED_TEST
-- lifecycle.  This migration creates no provider assignment, payment,
-- capture, settlement, payout, or live-communication capability.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Migration 121's CHECK used nullable regex/equality predicates, so a
-- partially populated Universal receipt could have been admitted as SQL
-- UNKNOWN. Refuse the upgrade without exposing or inventing audit fields;
-- operators must classify and repair historical evidence under separate
-- reviewed authority before retrying this append-only migration.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.task_completion_delivery_events delivery
    WHERE delivery.work_order_id IS NOT NULL
      AND NOT (
        delivery.expected_completion_fact_id IS NOT NULL
        AND delivery.expected_completion_version IS NOT NULL
        AND delivery.expected_completion_version > 0
        AND delivery.expected_execution_version IS NOT NULL
        AND delivery.expected_execution_version > 0
        AND delivery.provider_kind IS NOT DISTINCT FROM 'SYNTHETIC_SINK'
        AND delivery.provider_service_identity IS NOT NULL
        AND delivery.provider_service_identity ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
        AND delivery.idempotency_key IS NOT NULL
        AND delivery.idempotency_key ~ '^[A-Za-z0-9:_-]{16,96}$'
        AND delivery.request_sha256 IS NOT NULL
        AND delivery.request_sha256 ~ '^[a-f0-9]{64}$'
        AND delivery.provider_callback_at IS NOT NULL
        AND delivery.authenticated_at IS NOT NULL
        AND delivery.policy_version IS NOT DISTINCT FROM
            'universal-v1-completion-delivery-receipt-1.0.0'
      )
  ) THEN
    RAISE EXCEPTION 'HXUV1-NOTICE-UPGRADE-1: partial legacy completion delivery audit rows require separate reviewed repair before migration 138'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- Canonical launch schemas historically omitted the explicit profile-level
-- opt-out column even though the email worker already enforced it. Restore the
-- intended fail-closed field without enabling any outbound capability.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS do_not_email BOOLEAN DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS public.task_completion_notice_requests (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES public.tasks(id) ON DELETE RESTRICT,
  work_order_id UUID NOT NULL
    REFERENCES public.task_work_orders(id) ON DELETE RESTRICT,
  scope_version_id UUID NOT NULL
    REFERENCES public.task_scope_versions(id) ON DELETE RESTRICT,
  scope_version INTEGER NOT NULL CHECK (scope_version > 0),
  submitted_completion_fact_id UUID NOT NULL UNIQUE
    REFERENCES public.task_completion_facts(id) ON DELETE RESTRICT,
  completion_version INTEGER NOT NULL CHECK (completion_version > 0),
  completion_execution_fact_id UUID NOT NULL UNIQUE
    REFERENCES public.task_work_order_execution_facts(id) ON DELETE RESTRICT,
  execution_version INTEGER NOT NULL CHECK (execution_version > 0),
  recipient_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  sink_actor_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  channel TEXT NOT NULL CHECK (channel = 'EMAIL'),
  provider_kind TEXT NOT NULL CHECK (provider_kind = 'SYNTHETIC_SINK'),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    idempotency_key ~ '^completion-notice-request:[0-9a-f-]{36}$'
  ),
  email_idempotency_key TEXT NOT NULL UNIQUE CHECK (
    email_idempotency_key ~ '^completion-notice-email:[0-9a-f-]{36}$'
  ),
  request_sha256 CHAR(64) NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  policy_version TEXT NOT NULL CHECK (
    policy_version = 'universal-v1-completion-notice-dispatch-1.0.0'
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE public.email_outbox
  ADD COLUMN IF NOT EXISTS task_completion_notice_request_id UUID,
  ADD COLUMN IF NOT EXISTS provider_receipt_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'email_outbox_completion_notice_request_fk'
      AND conrelid = 'public.email_outbox'::regclass
  ) THEN
    ALTER TABLE public.email_outbox
      ADD CONSTRAINT email_outbox_completion_notice_request_fk
      FOREIGN KEY (task_completion_notice_request_id)
      REFERENCES public.task_completion_notice_requests(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'email_outbox_completion_notice_request_unique'
      AND conrelid = 'public.email_outbox'::regclass
  ) THEN
    ALTER TABLE public.email_outbox
      ADD CONSTRAINT email_outbox_completion_notice_request_unique
      UNIQUE (task_completion_notice_request_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'email_outbox_completion_notice_provider_truth_check'
      AND conrelid = 'public.email_outbox'::regclass
  ) THEN
    ALTER TABLE public.email_outbox
      ADD CONSTRAINT email_outbox_completion_notice_provider_truth_check
      CHECK (
        task_completion_notice_request_id IS NULL
        OR (
          lead_id IS NULL
          AND notification_id IS NULL
          AND user_id IS NOT NULL
          AND (
            (
              provider_msg_id IS NULL
              AND provider_name IS NULL
              AND provider_receipt_at IS NULL
            )
            OR (
              provider_msg_id IS NOT NULL
              AND provider_name = 'smtp_sink'
              AND provider_receipt_at IS NOT NULL
            )
          )
        )
      );
  END IF;
END;
$$;

ALTER TABLE public.task_completion_delivery_events
  ADD COLUMN IF NOT EXISTS completion_notice_request_id UUID;

-- Migration 121's conditional shape used regex/equality predicates whose NULL
-- result is accepted by PostgreSQL CHECK constraints. Rebuild it with explicit
-- presence requirements before accepting request-bound receipts.
ALTER TABLE public.task_completion_delivery_events
  DROP CONSTRAINT IF EXISTS task_completion_delivery_universal_v1_shape_check;
ALTER TABLE public.task_completion_delivery_events
  ADD CONSTRAINT task_completion_delivery_universal_v1_shape_check
  CHECK (
    (
      work_order_id IS NULL
      AND expected_completion_fact_id IS NULL
      AND expected_completion_version IS NULL
      AND expected_execution_version IS NULL
      AND provider_kind IS NULL
      AND provider_service_identity IS NULL
      AND idempotency_key IS NULL
      AND request_sha256 IS NULL
      AND provider_callback_at IS NULL
      AND authenticated_at IS NULL
      AND policy_version IS NULL
    )
    OR (
      work_order_id IS NOT NULL
      AND expected_completion_fact_id IS NOT NULL
      AND expected_completion_version IS NOT NULL
      AND expected_completion_version > 0
      AND expected_execution_version IS NOT NULL
      AND expected_execution_version > 0
      AND provider_kind IS NOT NULL
      AND provider_kind = 'SYNTHETIC_SINK'
      AND provider_service_identity IS NOT NULL
      AND provider_service_identity ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
      AND idempotency_key IS NOT NULL
      AND idempotency_key ~ '^[A-Za-z0-9:_-]{16,96}$'
      AND request_sha256 IS NOT NULL
      AND request_sha256 ~ '^[a-f0-9]{64}$'
      AND provider_callback_at IS NOT NULL
      AND authenticated_at IS NOT NULL
      AND policy_version IS NOT NULL
      AND policy_version = 'universal-v1-completion-delivery-receipt-1.0.0'
    )
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'task_completion_delivery_notice_request_fk'
      AND conrelid = 'public.task_completion_delivery_events'::regclass
  ) THEN
    ALTER TABLE public.task_completion_delivery_events
      ADD CONSTRAINT task_completion_delivery_notice_request_fk
      FOREIGN KEY (completion_notice_request_id)
      REFERENCES public.task_completion_notice_requests(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'task_completion_delivery_notice_request_unique'
      AND conrelid = 'public.task_completion_delivery_events'::regclass
  ) THEN
    ALTER TABLE public.task_completion_delivery_events
      ADD CONSTRAINT task_completion_delivery_notice_request_unique
      UNIQUE (completion_notice_request_id);
  END IF;
END;
$$;

-- Successor for migration 121. Legacy/unbound callbacks retain the exact
-- latest-COMPLETION_SUBMITTED rule. A request-bound asynchronous receipt may
-- arrive after a customer decision appended a newer execution fact; it binds
-- the immutable request's submitted completion and execution facts instead.
CREATE OR REPLACE FUNCTION public.enforce_universal_v1_completion_delivery_receipt()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  work_order public.task_work_orders%ROWTYPE;
  task_record public.tasks%ROWTYPE;
  completion public.task_completion_facts%ROWTYPE;
  execution public.task_work_order_execution_facts%ROWTYPE;
  request_record public.task_completion_notice_requests%ROWTYPE;
BEGIN
  IF NEW.work_order_id IS NULL THEN
    RETURN NEW;
  END IF;

  NEW.authenticated_at := clock_timestamp();

  SELECT * INTO work_order
  FROM public.task_work_orders
  WHERE id = NEW.work_order_id
  FOR SHARE;

  SELECT * INTO task_record
  FROM public.tasks
  WHERE id = NEW.task_id
  FOR SHARE;

  SELECT * INTO completion
  FROM public.task_completion_facts
  WHERE id = NEW.expected_completion_fact_id
  FOR SHARE;

  IF NEW.completion_notice_request_id IS NOT NULL THEN
    SELECT * INTO request_record
    FROM public.task_completion_notice_requests request
    WHERE request.id = NEW.completion_notice_request_id
    FOR SHARE;

    SELECT * INTO execution
    FROM public.task_work_order_execution_facts
      WHERE id = request_record.completion_execution_fact_id
      FOR SHARE;
  ELSE
    IF EXISTS (
      SELECT 1
      FROM public.task_completion_notice_requests notice_request
      WHERE notice_request.work_order_id = NEW.work_order_id
        AND notice_request.submitted_completion_fact_id = NEW.expected_completion_fact_id
    ) THEN
      RAISE EXCEPTION 'HXUV1-DELIVERY-6: request-bound completion notices reject legacy unbound receipt writers'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO execution
    FROM public.task_work_order_execution_facts
    WHERE work_order_id = NEW.work_order_id
    ORDER BY execution_version DESC
    LIMIT 1
    FOR SHARE;
  END IF;

  IF work_order.id IS NULL
     OR task_record.id IS NULL
     OR completion.id IS NULL
     OR execution.id IS NULL
     OR completion.work_order_id IS DISTINCT FROM NEW.work_order_id
     OR completion.task_id IS DISTINCT FROM NEW.task_id
     OR completion.completion_version IS DISTINCT FROM NEW.expected_completion_version
     OR completion.fact_kind IS DISTINCT FROM 'SUBMITTED'
     OR execution.work_order_id IS DISTINCT FROM NEW.work_order_id
     OR execution.execution_version IS DISTINCT FROM NEW.expected_execution_version
     OR execution.state IS DISTINCT FROM 'COMPLETION_SUBMITTED'
     OR execution.completion_fact_id IS DISTINCT FROM NEW.expected_completion_fact_id
     OR execution.scope_version_id IS DISTINCT FROM completion.scope_version_id
     OR (
       NEW.completion_notice_request_id IS NULL
       AND (
         work_order.task_id IS DISTINCT FROM NEW.task_id
         OR task_record.work_order_id IS DISTINCT FROM NEW.work_order_id
         OR work_order.execution_contract_version IS DISTINCT FROM 1
         OR
         task_record.universal_contract_version IS DISTINCT FROM 1
         OR task_record.automation_classification IS DISTINCT FROM 'CONTROLLED_TEST'
         OR task_record.universal_payment_posture IS DISTINCT FROM 'PAYMENT_CREATION_FROZEN'
         OR task_record.worker_id IS NOT NULL
       )
     )
     OR NEW.provider_service_identity IS DISTINCT FROM
        'hustlexp.synthetic-communications-sink.v1:' || NEW.recorded_by::TEXT THEN
    RAISE EXCEPTION 'HXUV1-DELIVERY-1: receipt must bind the exact unassigned Universal V1 completion submission'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.completion_notice_request_id IS NOT NULL AND (
    request_record.id IS NULL
    OR request_record.task_id IS DISTINCT FROM NEW.task_id
    OR request_record.work_order_id IS DISTINCT FROM NEW.work_order_id
    OR request_record.submitted_completion_fact_id IS DISTINCT FROM NEW.expected_completion_fact_id
    OR request_record.completion_version IS DISTINCT FROM NEW.expected_completion_version
    OR request_record.completion_execution_fact_id IS DISTINCT FROM execution.id
    OR request_record.execution_version IS DISTINCT FROM NEW.expected_execution_version
    OR request_record.sink_actor_user_id IS DISTINCT FROM NEW.recorded_by
    OR request_record.channel IS DISTINCT FROM NEW.channel
    OR request_record.provider_kind IS DISTINCT FROM NEW.provider_kind
  ) THEN
    RAISE EXCEPTION 'HXUV1-DELIVERY-5: asynchronous receipt must bind its exact immutable completion notice request'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.completion_notice_request_id IS NULL AND NOT EXISTS (
    SELECT 1
    FROM public.users service_actor
    WHERE service_actor.id = NEW.recorded_by
      AND service_actor.account_status = 'ACTIVE'
      AND service_actor.is_minor IS FALSE
      AND COALESCE(service_actor.is_banned, FALSE) IS FALSE
  ) THEN
    RAISE EXCEPTION 'HXUV1-DELIVERY-2: receipt requires an active authenticated service actor'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.provider_callback_at IS NULL
     OR abs(extract(epoch FROM (clock_timestamp() - NEW.provider_callback_at))) > 300 THEN
    RAISE EXCEPTION 'HXUV1-DELIVERY-3: provider callback timestamp is outside the accepted window'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.delivered_at IS NULL
     OR NEW.delivered_at > clock_timestamp() + INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'HXUV1-DELIVERY-4: provider delivery timestamp cannot be in the future'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE INDEX IF NOT EXISTS task_completion_notice_work_order_idx
  ON public.task_completion_notice_requests(work_order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS email_outbox_completion_notice_pending_idx
  ON public.email_outbox(task_completion_notice_request_id, status)
  WHERE task_completion_notice_request_id IS NOT NULL;

-- Seal direct execution-fact INSERTs behind the same per-Work-Order lock used
-- by application fulfillment commands and completion-notice pre-I/O checks.
-- The alphabetically-first trigger name makes this lock precede the existing
-- execution validation trigger; application acquisitions are re-entrant.
CREATE OR REPLACE FUNCTION public.lock_universal_v1_fulfillment_execution_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('fulfillment:' || NEW.work_order_id::TEXT, 0)
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_universal_v1_fulfillment_execution_lock
  ON public.task_work_order_execution_facts;
CREATE TRIGGER a_universal_v1_fulfillment_execution_lock
BEFORE INSERT ON public.task_work_order_execution_facts
FOR EACH ROW
EXECUTE FUNCTION public.lock_universal_v1_fulfillment_execution_insert();

-- Seal direct completion-decision facts behind the same per-Work-Order lock.
-- Application fulfillment transactions already hold this re-entrant lock.
CREATE OR REPLACE FUNCTION public.lock_universal_v1_fulfillment_completion_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('fulfillment:' || NEW.work_order_id::TEXT, 0)
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_universal_v1_fulfillment_completion_lock
  ON public.task_completion_facts;
CREATE TRIGGER a_universal_v1_fulfillment_completion_lock
BEFORE INSERT ON public.task_completion_facts
FOR EACH ROW
EXECUTE FUNCTION public.lock_universal_v1_fulfillment_completion_insert();

CREATE OR REPLACE FUNCTION public.universal_v1_completion_notice_request_sha256(
  checked_request_id UUID,
  checked_task_id UUID,
  checked_work_order_id UUID,
  checked_scope_version_id UUID,
  checked_scope_version INTEGER,
  checked_completion_fact_id UUID,
  checked_completion_version INTEGER,
  checked_execution_fact_id UUID,
  checked_execution_version INTEGER,
  checked_recipient_user_id UUID,
  checked_sink_actor_user_id UUID,
  checked_idempotency_key TEXT,
  checked_email_idempotency_key TEXT
)
RETURNS CHAR(64)
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT encode(
    digest(
      jsonb_build_object(
        'contract', 'HUSTLEXP_UNIVERSAL_V1_COMPLETION_NOTICE_REQUEST_V1',
        'requestId', checked_request_id,
        'taskId', checked_task_id,
        'workOrderId', checked_work_order_id,
        'scopeVersionId', checked_scope_version_id,
        'scopeVersion', checked_scope_version,
        'submittedCompletionFactId', checked_completion_fact_id,
        'completionVersion', checked_completion_version,
        'completionExecutionFactId', checked_execution_fact_id,
        'executionVersion', checked_execution_version,
        'recipientUserId', checked_recipient_user_id,
        'sinkActorUserId', checked_sink_actor_user_id,
        'channel', 'EMAIL',
        'providerKind', 'SYNTHETIC_SINK',
        'idempotencyKey', checked_idempotency_key,
        'emailIdempotencyKey', checked_email_idempotency_key,
        'paymentCreationFrozen', TRUE,
        'hardAssignmentCreated', FALSE
      )::TEXT,
      'sha256'
    ),
    'hex'
  )::CHAR(64);
$$;

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_completion_notice_request()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  work_order public.task_work_orders%ROWTYPE;
  task_record public.tasks%ROWTYPE;
  scope_record public.task_scope_versions%ROWTYPE;
  completion public.task_completion_facts%ROWTYPE;
  proof_record public.proofs%ROWTYPE;
  execution public.task_work_order_execution_facts%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('fulfillment:' || NEW.work_order_id::TEXT, 0)
  );

  IF EXISTS (
    SELECT 1
    FROM public.email_outbox email
    WHERE email.idempotency_key = NEW.email_idempotency_key
  )
  OR EXISTS (
    SELECT 1
    FROM public.outbox_events outbox
    WHERE outbox.idempotency_key = NEW.email_idempotency_key
  ) THEN
    RAISE EXCEPTION 'HXUV1-NOTICE-24: completion transport identity must not predate its request'
      USING ERRCODE = 'P0001';
  END IF;

  NEW.created_at := clock_timestamp();

  SELECT * INTO work_order
  FROM public.task_work_orders
  WHERE id = NEW.work_order_id
  FOR SHARE;

  SELECT * INTO task_record
  FROM public.tasks
  WHERE id = NEW.task_id
  FOR SHARE;

  SELECT * INTO scope_record
  FROM public.task_scope_versions
  WHERE id = NEW.scope_version_id
  FOR SHARE;

  SELECT * INTO completion
  FROM public.task_completion_facts
  WHERE id = NEW.submitted_completion_fact_id
  FOR SHARE;

  SELECT * INTO proof_record
  FROM public.proofs proof
  WHERE proof.id = completion.proof_id
  FOR SHARE;

  SELECT * INTO execution
  FROM public.task_work_order_execution_facts
  WHERE id = NEW.completion_execution_fact_id
  FOR SHARE;

  IF work_order.id IS NULL
     OR task_record.id IS NULL
     OR scope_record.id IS NULL
     OR completion.id IS NULL
     OR proof_record.id IS NULL
     OR proof_record.state IS DISTINCT FROM 'SUBMITTED'
     OR execution.id IS NULL
     OR work_order.task_id IS DISTINCT FROM NEW.task_id
     OR task_record.work_order_id IS DISTINCT FROM NEW.work_order_id
     OR scope_record.task_id IS DISTINCT FROM NEW.task_id
     OR scope_record.id IS DISTINCT FROM task_record.active_scope_version_id
     OR scope_record.version IS DISTINCT FROM NEW.scope_version
     OR completion.work_order_id IS DISTINCT FROM NEW.work_order_id
     OR completion.task_id IS DISTINCT FROM NEW.task_id
     OR completion.scope_version_id IS DISTINCT FROM NEW.scope_version_id
     OR completion.completion_version IS DISTINCT FROM NEW.completion_version
     OR completion.fact_kind IS DISTINCT FROM 'SUBMITTED'
     OR EXISTS (
       SELECT 1
       FROM public.task_completion_facts newer_completion
       WHERE newer_completion.work_order_id = NEW.work_order_id
         AND newer_completion.completion_version > NEW.completion_version
     )
     OR execution.work_order_id IS DISTINCT FROM NEW.work_order_id
     OR execution.task_id IS DISTINCT FROM NEW.task_id
     OR execution.scope_version_id IS DISTINCT FROM NEW.scope_version_id
     OR execution.execution_version IS DISTINCT FROM NEW.execution_version
     OR execution.state IS DISTINCT FROM 'COMPLETION_SUBMITTED'
     OR execution.transition_kind IS DISTINCT FROM 'COMPLETION_SUBMITTED'
     OR execution.completion_fact_id IS DISTINCT FROM NEW.submitted_completion_fact_id
     OR EXISTS (
       SELECT 1
       FROM public.task_work_order_execution_facts newer
       WHERE newer.work_order_id = NEW.work_order_id
         AND newer.execution_version > NEW.execution_version
     )
     OR work_order.execution_contract_version IS DISTINCT FROM 1
     OR task_record.universal_contract_version IS DISTINCT FROM 1
     OR task_record.automation_classification IS DISTINCT FROM 'CONTROLLED_TEST'
     OR task_record.universal_payment_posture IS DISTINCT FROM 'PAYMENT_CREATION_FROZEN'
     OR task_record.worker_id IS NOT NULL
     OR task_record.poster_id IS DISTINCT FROM NEW.recipient_user_id
     OR NEW.sink_actor_user_id = NEW.recipient_user_id
     OR NEW.sink_actor_user_id = completion.actor_id
     OR NEW.channel IS DISTINCT FROM 'EMAIL'
     OR NEW.provider_kind IS DISTINCT FROM 'SYNTHETIC_SINK'
     OR NEW.policy_version IS DISTINCT FROM 'universal-v1-completion-notice-dispatch-1.0.0'
     OR NEW.idempotency_key IS DISTINCT FROM
        'completion-notice-request:' || NEW.submitted_completion_fact_id::TEXT
     OR NEW.email_idempotency_key IS DISTINCT FROM
        'completion-notice-email:' || NEW.submitted_completion_fact_id::TEXT THEN
    RAISE EXCEPTION 'HXUV1-NOTICE-1: notice request must bind the exact current unassigned completion submission'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.users recipient
    WHERE recipient.id = NEW.recipient_user_id
      AND recipient.account_status = 'ACTIVE'
      AND COALESCE(recipient.is_banned, FALSE) IS FALSE
      AND COALESCE(recipient.do_not_email, FALSE) IS FALSE
      AND NULLIF(btrim(recipient.email), '') IS NOT NULL
  )
  OR NOT EXISTS (
    SELECT 1
    FROM public.users sink_actor
    WHERE sink_actor.id = NEW.sink_actor_user_id
      AND sink_actor.account_status = 'ACTIVE'
      AND sink_actor.is_minor IS FALSE
      AND COALESCE(sink_actor.is_banned, FALSE) IS FALSE
  ) THEN
    RAISE EXCEPTION 'HXUV1-NOTICE-2: notice recipient and configured synthetic sink actor must be active'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.request_sha256 IS DISTINCT FROM
     public.universal_v1_completion_notice_request_sha256(
       NEW.id,
       NEW.task_id,
       NEW.work_order_id,
       NEW.scope_version_id,
       NEW.scope_version,
       NEW.submitted_completion_fact_id,
       NEW.completion_version,
       NEW.completion_execution_fact_id,
       NEW.execution_version,
       NEW.recipient_user_id,
       NEW.sink_actor_user_id,
       NEW.idempotency_key,
       NEW.email_idempotency_key
     ) THEN
    RAISE EXCEPTION 'HXUV1-NOTICE-3: notice request digest mismatch'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_universal_v1_completion_notice_request
  ON public.task_completion_notice_requests;
CREATE TRIGGER enforce_universal_v1_completion_notice_request
BEFORE INSERT ON public.task_completion_notice_requests
FOR EACH ROW
EXECUTE FUNCTION public.enforce_universal_v1_completion_notice_request();

CREATE OR REPLACE FUNCTION public.prevent_universal_v1_completion_notice_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'HXUV1-NOTICE-4: completion notice requests are append-only'
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS task_completion_notice_requests_immutable
  ON public.task_completion_notice_requests;
CREATE TRIGGER task_completion_notice_requests_immutable
BEFORE UPDATE OR DELETE ON public.task_completion_notice_requests
FOR EACH ROW
EXECUTE FUNCTION public.prevent_universal_v1_completion_notice_mutation();

DROP TRIGGER IF EXISTS task_completion_notice_requests_no_truncate
  ON public.task_completion_notice_requests;
CREATE TRIGGER task_completion_notice_requests_no_truncate
BEFORE TRUNCATE ON public.task_completion_notice_requests
FOR EACH STATEMENT
EXECUTE FUNCTION public.prevent_universal_v1_completion_notice_mutation();

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_completion_notice_email()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  request_record public.task_completion_notice_requests%ROWTYPE;
  recipient_email TEXT;
  expected_params JSONB;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.task_completion_notice_request_id IS NOT NULL THEN
      RAISE EXCEPTION 'HXUV1-NOTICE-5: a completion notice email is durable and cannot be deleted'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.task_completion_notice_request_id IS DISTINCT FROM
         NEW.task_completion_notice_request_id THEN
    RAISE EXCEPTION 'HXUV1-NOTICE-6: completion notice email binding is immutable'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.task_completion_notice_request_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO request_record
  FROM public.task_completion_notice_requests request
  WHERE request.id = NEW.task_completion_notice_request_id
  FOR SHARE;

  SELECT recipient.email INTO recipient_email
  FROM public.users recipient
  WHERE recipient.id = request_record.recipient_user_id
  FOR SHARE;

  expected_params := jsonb_build_object(
    'schemaVersion', 1,
    'taskId', request_record.task_id,
    'workOrderId', request_record.work_order_id,
    'submittedCompletionFactId', request_record.submitted_completion_fact_id,
    'completionVersion', request_record.completion_version,
    'executionVersion', request_record.execution_version,
    'paymentCreationFrozen', TRUE,
    'hardAssignmentCreated', FALSE
  );

  IF request_record.id IS NULL
     OR NEW.user_id IS DISTINCT FROM request_record.recipient_user_id
     OR NEW.lead_id IS NOT NULL
     OR NEW.notification_id IS NOT NULL
     OR (TG_OP = 'INSERT' AND NEW.to_email IS DISTINCT FROM recipient_email)
     OR NEW.template IS DISTINCT FROM 'universal_v1_completion_notice'
     OR NEW.params_json IS DISTINCT FROM expected_params
     OR NEW.idempotency_key IS DISTINCT FROM request_record.email_idempotency_key
     OR (
       NEW.status = 'sent'
       AND (
         NEW.provider_msg_id IS NULL
         OR NEW.provider_name IS DISTINCT FROM 'smtp_sink'
         OR NEW.provider_receipt_at IS NULL
       )
     )
     OR (
       NEW.provider_msg_id IS NULL
       AND (NEW.provider_name IS NOT NULL OR NEW.provider_receipt_at IS NOT NULL)
     )
     OR (
       NEW.provider_msg_id IS NOT NULL
       AND (
       NEW.provider_name IS DISTINCT FROM 'smtp_sink'
         OR NEW.provider_receipt_at IS NULL
         OR NEW.provider_io_started_at IS NULL
         OR NEW.notification_provider_attempt_id IS NULL
         OR NEW.provider_receipt_at < NEW.provider_io_started_at
         OR NEW.provider_msg_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,254}$'
         OR NEW.provider_receipt_at > clock_timestamp() + INTERVAL '5 minutes'
       )
     )
     OR (
       (NEW.provider_io_started_at IS NULL) IS DISTINCT FROM
       (NEW.notification_provider_attempt_id IS NULL)
     )
     OR (
       NEW.provider_io_started_at IS NOT NULL
       AND (
         NEW.status NOT IN ('sending', 'sent', 'suppressed', 'provider_outcome_unknown')
         OR NEW.pre_provider_claim_id IS NULL
         OR NEW.pre_provider_claimed_at IS NULL
         OR NEW.pre_provider_claim_deadline_at IS NULL
         OR NEW.pre_provider_claimed_at > NEW.provider_io_started_at
         OR NEW.pre_provider_claim_deadline_at < NEW.provider_io_started_at
       )
     )
     OR (
       NEW.status IN ('pending', 'failed')
       AND (
         NEW.provider_io_started_at IS NOT NULL
         OR NEW.notification_provider_attempt_id IS NOT NULL
         OR NEW.pre_provider_claim_id IS NOT NULL
         OR NEW.pre_provider_claimed_at IS NOT NULL
         OR NEW.pre_provider_claim_deadline_at IS NOT NULL
       )
     )
     OR (
       NEW.status = 'sent'
       AND NEW.sent_at IS NULL
     )
     OR (
       NEW.status = 'suppressed'
       AND (
         NULLIF(btrim(NEW.suppressed_reason), '') IS NULL
         OR NEW.suppressed_at IS NULL
         OR NEW.provider_io_started_at IS NOT NULL
         OR NEW.notification_provider_attempt_id IS NOT NULL
         OR NEW.provider_msg_id IS NOT NULL
         OR NEW.provider_name IS NOT NULL
         OR NEW.provider_receipt_at IS NOT NULL
       )
     )
     OR (
       NEW.status = 'provider_outcome_unknown'
       AND (
         NEW.provider_io_started_at IS NULL
         OR NEW.notification_provider_attempt_id IS NULL
         OR NULLIF(btrim(NEW.last_error), '') IS NULL
       )
     ) THEN
    RAISE EXCEPTION 'HXUV1-NOTICE-7: completion notice email must remain bound to the synthetic EMAIL request'
      USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    OLD.id IS DISTINCT FROM NEW.id
    OR OLD.user_id IS DISTINCT FROM NEW.user_id
    OR OLD.lead_id IS DISTINCT FROM NEW.lead_id
    OR OLD.to_email IS DISTINCT FROM NEW.to_email
    OR OLD.template IS DISTINCT FROM NEW.template
    OR OLD.params_json IS DISTINCT FROM NEW.params_json
    OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
    OR OLD.notification_id IS DISTINCT FROM NEW.notification_id
    OR (
      OLD.provider_io_started_at IS NOT NULL
      AND (
        OLD.provider_io_started_at IS DISTINCT FROM NEW.provider_io_started_at
        OR OLD.notification_provider_attempt_id IS DISTINCT FROM NEW.notification_provider_attempt_id
        OR OLD.pre_provider_claim_id IS DISTINCT FROM NEW.pre_provider_claim_id
        OR OLD.pre_provider_claimed_at IS DISTINCT FROM NEW.pre_provider_claimed_at
        OR OLD.pre_provider_claim_deadline_at IS DISTINCT FROM NEW.pre_provider_claim_deadline_at
      )
    )
    OR (
      OLD.provider_msg_id IS NOT NULL
      AND (
        OLD.provider_msg_id IS DISTINCT FROM NEW.provider_msg_id
        OR OLD.provider_name IS DISTINCT FROM NEW.provider_name
        OR OLD.provider_receipt_at IS DISTINCT FROM NEW.provider_receipt_at
      )
    )
  ) THEN
    RAISE EXCEPTION 'HXUV1-NOTICE-8: completion notice recipient, content, and provider receipt are immutable'
      USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'UPDATE' AND NOT (
    OLD.status = NEW.status
    OR (OLD.status IN ('pending', 'failed') AND NEW.status = 'sending')
    OR (
      OLD.status = 'sending'
      AND OLD.provider_io_started_at IS NULL
      AND NEW.status IN ('pending', 'failed', 'suppressed')
    )
    OR (
      OLD.status = 'sending'
      AND OLD.provider_io_started_at IS NOT NULL
      AND NEW.status IN ('sent', 'provider_outcome_unknown')
    )
    OR (
      OLD.status = 'provider_outcome_unknown'
      AND NEW.status = 'sent'
    )
  ) THEN
    RAISE EXCEPTION 'HXUV1-NOTICE-25: completion notice email state transition is not permitted'
      USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    (
      OLD.status = 'sent'
      AND (
        OLD.sent_at IS DISTINCT FROM NEW.sent_at
        OR OLD.delivered_at IS DISTINCT FROM NEW.delivered_at
        OR OLD.last_error IS DISTINCT FROM NEW.last_error
        OR OLD.suppressed_reason IS DISTINCT FROM NEW.suppressed_reason
        OR OLD.suppressed_at IS DISTINCT FROM NEW.suppressed_at
      )
    )
    OR (
      OLD.status = 'suppressed'
      AND (
        OLD.suppressed_reason IS DISTINCT FROM NEW.suppressed_reason
        OR OLD.suppressed_at IS DISTINCT FROM NEW.suppressed_at
        OR OLD.sent_at IS DISTINCT FROM NEW.sent_at
        OR OLD.delivered_at IS DISTINCT FROM NEW.delivered_at
        OR OLD.last_error IS DISTINCT FROM NEW.last_error
      )
    )
    OR (
      OLD.status = 'provider_outcome_unknown'
      AND (
        OLD.last_error IS DISTINCT FROM NEW.last_error
        OR (
          NEW.status = 'provider_outcome_unknown'
          AND OLD.sent_at IS DISTINCT FROM NEW.sent_at
        )
        OR OLD.delivered_at IS DISTINCT FROM NEW.delivered_at
        OR OLD.suppressed_reason IS DISTINCT FROM NEW.suppressed_reason
        OR OLD.suppressed_at IS DISTINCT FROM NEW.suppressed_at
      )
    )
  ) THEN
    RAISE EXCEPTION 'HXUV1-NOTICE-26: completion notice terminal audit state is immutable'
      USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.provider_io_started_at IS NULL
     AND NEW.provider_io_started_at IS NOT NULL THEN
    PERFORM 1
    FROM public.outbox_events outbox
    WHERE outbox.idempotency_key = request_record.email_idempotency_key
      AND outbox.event_type = 'email.send_requested'
      AND outbox.aggregate_type = 'email'
      AND outbox.aggregate_id = NEW.id
      AND outbox.event_version = 1
      AND outbox.queue_name = 'user_notifications'
      AND outbox.status IN ('enqueued', 'processing')
      AND outbox.dispatch_attempt_id IS NOT NULL
      AND NULLIF(btrim(outbox.bullmq_job_id), '') IS NOT NULL
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'HXUV1-NOTICE-23: provider I/O marker requires the exact active completion dispatch'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_universal_v1_completion_notice_email
  ON public.email_outbox;
CREATE TRIGGER enforce_universal_v1_completion_notice_email
BEFORE INSERT OR UPDATE OR DELETE ON public.email_outbox
FOR EACH ROW
EXECUTE FUNCTION public.enforce_universal_v1_completion_notice_email();

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_completion_notice_outbox()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  request_record public.task_completion_notice_requests%ROWTYPE;
  new_request_record public.task_completion_notice_requests%ROWTYPE;
  email_record public.email_outbox%ROWTYPE;
  expected_payload JSONB;
  checked_key TEXT;
BEGIN
  checked_key := CASE
    WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD.idempotency_key
    ELSE NEW.idempotency_key
  END;

  SELECT * INTO request_record
  FROM public.task_completion_notice_requests request
  WHERE request.email_idempotency_key = checked_key
  FOR SHARE;

  IF TG_OP = 'UPDATE' THEN
    SELECT * INTO new_request_record
    FROM public.task_completion_notice_requests request
    WHERE request.email_idempotency_key = NEW.idempotency_key
    FOR SHARE;

    IF request_record.id IS NOT NULL
       AND OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key THEN
      RAISE EXCEPTION 'HXUV1-NOTICE-19: protected completion notice outbox identity cannot be changed'
        USING ERRCODE = 'P0001';
    END IF;

    IF request_record.id IS NULL AND new_request_record.id IS NOT NULL THEN
      request_record := new_request_record;
    END IF;
  END IF;

  IF request_record.id IS NULL THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HXUV1-NOTICE-9: a completion notice outbox event is durable and cannot be deleted'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO email_record
  FROM public.email_outbox email
  WHERE email.task_completion_notice_request_id = request_record.id
  FOR SHARE;

  expected_payload := jsonb_build_object(
    'emailId', email_record.id,
    'userId', request_record.recipient_user_id,
    'toEmail', email_record.to_email,
    'template', 'universal_v1_completion_notice',
    'params', email_record.params_json
  );

  IF email_record.id IS NULL
     OR NEW.event_type IS DISTINCT FROM 'email.send_requested'
     OR NEW.aggregate_type IS DISTINCT FROM 'email'
     OR NEW.aggregate_id IS DISTINCT FROM email_record.id
     OR NEW.event_version IS DISTINCT FROM 1
     OR NEW.idempotency_key IS DISTINCT FROM request_record.email_idempotency_key
     OR NEW.payload IS DISTINCT FROM expected_payload
     OR NEW.queue_name IS DISTINCT FROM 'user_notifications' THEN
    RAISE EXCEPTION 'HXUV1-NOTICE-10: completion notice outbox event must exactly match its EMAIL request'
      USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    OLD.id IS DISTINCT FROM NEW.id
    OR OLD.event_type IS DISTINCT FROM NEW.event_type
    OR OLD.aggregate_type IS DISTINCT FROM NEW.aggregate_type
    OR OLD.aggregate_id IS DISTINCT FROM NEW.aggregate_id
    OR OLD.event_version IS DISTINCT FROM NEW.event_version
    OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
    OR OLD.payload IS DISTINCT FROM NEW.payload
    OR OLD.queue_name IS DISTINCT FROM NEW.queue_name
  ) THEN
    RAISE EXCEPTION 'HXUV1-NOTICE-11: completion notice outbox envelope is immutable'
      USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.status = 'processed'
     AND (
       NEW.status IS DISTINCT FROM 'processed'
       OR OLD.processed_at IS DISTINCT FROM NEW.processed_at
     ) THEN
    RAISE EXCEPTION 'HXUV1-NOTICE-27: processed completion notice outbox state is immutable'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.status = 'processed' AND (
    NEW.processed_at IS NULL
    OR NOT (
      (
        email_record.status = 'sent'
        AND EXISTS (
          SELECT 1
          FROM public.task_completion_delivery_events delivery
          WHERE delivery.completion_notice_request_id = request_record.id
            AND delivery.task_id = request_record.task_id
            AND delivery.work_order_id = request_record.work_order_id
            AND delivery.expected_completion_fact_id =
                request_record.submitted_completion_fact_id
            AND delivery.expected_completion_version = request_record.completion_version
            AND delivery.expected_execution_version = request_record.execution_version
        )
      )
      OR (
        email_record.status = 'suppressed'
        AND NULLIF(btrim(email_record.suppressed_reason), '') IS NOT NULL
        AND email_record.suppressed_at IS NOT NULL
      )
      OR (
        email_record.status = 'provider_outcome_unknown'
        AND email_record.provider_io_started_at IS NOT NULL
        AND email_record.notification_provider_attempt_id IS NOT NULL
        AND email_record.pre_provider_claim_id IS NOT NULL
        AND email_record.pre_provider_claimed_at IS NOT NULL
        AND email_record.pre_provider_claim_deadline_at IS NOT NULL
      )
    )
  ) THEN
    RAISE EXCEPTION 'HXUV1-NOTICE-21: completion notice outbox may close only after a valid terminal delivery outcome'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_universal_v1_completion_notice_outbox
  ON public.outbox_events;
CREATE TRIGGER enforce_universal_v1_completion_notice_outbox
BEFORE INSERT OR UPDATE OR DELETE ON public.outbox_events
FOR EACH ROW
EXECUTE FUNCTION public.enforce_universal_v1_completion_notice_outbox();

CREATE OR REPLACE FUNCTION public.prevent_universal_v1_completion_notice_dispatch_truncate()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'email_outbox'
     AND EXISTS (
       SELECT 1
       FROM public.email_outbox email
       WHERE email.task_completion_notice_request_id IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'HXUV1-NOTICE-17: completion notice EMAIL rows forbid outbox truncation'
      USING ERRCODE = 'P0001';
  END IF;

  IF TG_TABLE_NAME = 'outbox_events'
     AND EXISTS (
       SELECT 1
       FROM public.outbox_events outbox
       JOIN public.task_completion_notice_requests request
         ON request.email_idempotency_key = outbox.idempotency_key
     ) THEN
    RAISE EXCEPTION 'HXUV1-NOTICE-18: completion notice events forbid outbox truncation'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS email_outbox_completion_notice_no_truncate
  ON public.email_outbox;
CREATE TRIGGER email_outbox_completion_notice_no_truncate
BEFORE TRUNCATE ON public.email_outbox
FOR EACH STATEMENT
EXECUTE FUNCTION public.prevent_universal_v1_completion_notice_dispatch_truncate();

DROP TRIGGER IF EXISTS outbox_events_completion_notice_no_truncate
  ON public.outbox_events;
CREATE TRIGGER outbox_events_completion_notice_no_truncate
BEFORE TRUNCATE ON public.outbox_events
FOR EACH STATEMENT
EXECUTE FUNCTION public.prevent_universal_v1_completion_notice_dispatch_truncate();

CREATE OR REPLACE FUNCTION public.assert_universal_v1_completion_notice_dispatch_bound()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  matching_emails INTEGER;
  matching_events INTEGER;
  initial_email public.email_outbox%ROWTYPE;
  initial_event public.outbox_events%ROWTYPE;
BEGIN
  SELECT count(*)::INTEGER INTO matching_emails
  FROM public.email_outbox email
  WHERE email.task_completion_notice_request_id = NEW.id;

  SELECT count(*)::INTEGER INTO matching_events
  FROM public.email_outbox email
  JOIN public.outbox_events outbox
    ON outbox.idempotency_key = email.idempotency_key
   AND outbox.event_type = 'email.send_requested'
   AND outbox.aggregate_type = 'email'
   AND outbox.aggregate_id = email.id
   AND outbox.event_version = 1
   AND outbox.queue_name = 'user_notifications'
  WHERE email.task_completion_notice_request_id = NEW.id;

  IF matching_emails <> 1 OR matching_events <> 1 THEN
    RAISE EXCEPTION 'HXUV1-NOTICE-12: notice request requires exactly one EMAIL row and matching outbox event'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO initial_email
  FROM public.email_outbox email
  WHERE email.task_completion_notice_request_id = NEW.id;

  SELECT * INTO initial_event
  FROM public.outbox_events outbox
  WHERE outbox.idempotency_key = NEW.email_idempotency_key;

  IF initial_email.status IS DISTINCT FROM 'pending'
     OR initial_email.attempts IS DISTINCT FROM 0
     OR initial_email.max_attempts IS DISTINCT FROM 3
     OR initial_email.available_at > clock_timestamp()
     OR initial_email.next_retry_at IS NOT NULL
     OR initial_email.provider_name IS NOT NULL
     OR initial_email.provider_msg_id IS NOT NULL
     OR initial_email.provider_receipt_at IS NOT NULL
     OR initial_email.sent_at IS NOT NULL
     OR initial_email.delivered_at IS NOT NULL
     OR initial_email.suppressed_reason IS NOT NULL
     OR initial_email.suppressed_at IS NOT NULL
     OR initial_email.last_error IS NOT NULL
     OR initial_email.pre_provider_claim_id IS NOT NULL
     OR initial_email.pre_provider_claimed_at IS NOT NULL
     OR initial_email.pre_provider_claim_deadline_at IS NOT NULL
     OR initial_email.provider_io_started_at IS NOT NULL
     OR initial_email.notification_provider_attempt_id IS NOT NULL
     OR initial_event.status IS DISTINCT FROM 'pending'
     OR initial_event.attempts IS DISTINCT FROM 0
     OR initial_event.available_at > clock_timestamp()
     OR initial_event.enqueued_at IS NOT NULL
     OR initial_event.processed_at IS NOT NULL
     OR initial_event.error_message IS NOT NULL
     OR initial_event.bullmq_job_id IS NOT NULL
     OR initial_event.dispatch_attempt_id IS NOT NULL
     OR initial_event.dispatch_claimed_at IS NOT NULL
     OR initial_event.dispatch_deadline_at IS NOT NULL
     OR initial_event.pre_provider_claim_id IS NOT NULL
     OR initial_event.pre_provider_claimed_at IS NOT NULL
     OR initial_event.pre_provider_claim_deadline_at IS NOT NULL
     OR initial_event.provider_io_started_at IS NOT NULL THEN
    RAISE EXCEPTION 'HXUV1-NOTICE-22: notice dispatch must commit in its exact fresh pending state'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS task_completion_notice_dispatch_exact_binding
  ON public.task_completion_notice_requests;
CREATE CONSTRAINT TRIGGER task_completion_notice_dispatch_exact_binding
AFTER INSERT ON public.task_completion_notice_requests
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.assert_universal_v1_completion_notice_dispatch_bound();

CREATE OR REPLACE FUNCTION public.universal_v1_completion_notice_receipt_sha256(
  checked_request_id UUID,
  checked_email_id UUID,
  checked_provider_message_id TEXT,
  checked_provider_receipt_at TIMESTAMPTZ,
  checked_sink_actor_user_id UUID
)
RETURNS CHAR(64)
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT encode(
    digest(
      jsonb_build_object(
        'contract', 'HUSTLEXP_UNIVERSAL_V1_COMPLETION_NOTICE_RECEIPT_V1',
        'requestId', checked_request_id,
        'emailId', checked_email_id,
        'providerKind', 'SYNTHETIC_SINK',
        'providerName', 'smtp_sink',
        'providerMessageId', checked_provider_message_id,
        'providerReceiptAt', to_char(
          checked_provider_receipt_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'sinkActorUserId', checked_sink_actor_user_id
      )::TEXT,
      'sha256'
    ),
    'hex'
  )::CHAR(64);
$$;

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_completion_notice_delivery_binding()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  request_record public.task_completion_notice_requests%ROWTYPE;
  email_record public.email_outbox%ROWTYPE;
  expected_provider_delivery_id TEXT;
  expected_idempotency_key TEXT;
BEGIN
  IF NEW.completion_notice_request_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO request_record
  FROM public.task_completion_notice_requests request
  WHERE request.id = NEW.completion_notice_request_id
  FOR SHARE;

  SELECT * INTO email_record
  FROM public.email_outbox email
  WHERE email.task_completion_notice_request_id = NEW.completion_notice_request_id
  FOR SHARE;

  expected_provider_delivery_id := 'smtp_sink:' || email_record.provider_msg_id;
  expected_idempotency_key := 'completion-notice-delivery:' || request_record.id::TEXT;

  IF request_record.id IS NULL
     OR email_record.id IS NULL
     OR email_record.status IS DISTINCT FROM 'sent'
     OR email_record.provider_name IS DISTINCT FROM 'smtp_sink'
     OR email_record.provider_msg_id IS NULL
     OR email_record.provider_receipt_at IS NULL
     OR email_record.provider_io_started_at IS NULL
     OR email_record.notification_provider_attempt_id IS NULL
     OR email_record.provider_receipt_at < email_record.provider_io_started_at
     OR NEW.task_id IS DISTINCT FROM request_record.task_id
     OR NEW.work_order_id IS DISTINCT FROM request_record.work_order_id
     OR NEW.expected_completion_fact_id IS DISTINCT FROM request_record.submitted_completion_fact_id
     OR NEW.expected_completion_version IS DISTINCT FROM request_record.completion_version
     OR NEW.expected_execution_version IS DISTINCT FROM request_record.execution_version
     OR NEW.provider_delivery_id IS DISTINCT FROM expected_provider_delivery_id
     OR NEW.channel IS DISTINCT FROM 'EMAIL'
     OR NEW.delivered_at IS DISTINCT FROM email_record.provider_receipt_at
     OR NEW.recorded_by IS DISTINCT FROM request_record.sink_actor_user_id
     OR NEW.provider_kind IS DISTINCT FROM 'SYNTHETIC_SINK'
     OR NEW.provider_service_identity IS DISTINCT FROM
        'hustlexp.synthetic-communications-sink.v1:' || request_record.sink_actor_user_id::TEXT
     OR NEW.idempotency_key IS DISTINCT FROM expected_idempotency_key
     OR NEW.provider_callback_at IS NULL
     OR NEW.policy_version IS DISTINCT FROM
        'universal-v1-completion-delivery-receipt-1.0.0'
     OR NEW.request_sha256 IS DISTINCT FROM
        public.universal_v1_completion_notice_receipt_sha256(
          request_record.id,
          email_record.id,
          email_record.provider_msg_id,
          email_record.provider_receipt_at,
          request_record.sink_actor_user_id
        ) THEN
    RAISE EXCEPTION 'HXUV1-NOTICE-13: delivery receipt must derive from the exact synthetic EMAIL provider receipt'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_universal_v1_completion_notice_delivery_binding
  ON public.task_completion_delivery_events;
CREATE TRIGGER enforce_universal_v1_completion_notice_delivery_binding
BEFORE INSERT ON public.task_completion_delivery_events
FOR EACH ROW
EXECUTE FUNCTION public.enforce_universal_v1_completion_notice_delivery_binding();

CREATE OR REPLACE FUNCTION public.materialize_universal_v1_completion_notice_delivery(
  checked_email_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  request_record public.task_completion_notice_requests%ROWTYPE;
  email_record public.email_outbox%ROWTYPE;
  existing_delivery public.task_completion_delivery_events%ROWTYPE;
  inserted_id UUID;
  expected_provider_delivery_id TEXT;
  expected_delivery_idempotency_key TEXT;
  expected_delivery_request_sha256 CHAR(64);
BEGIN
  SELECT * INTO email_record
  FROM public.email_outbox email
  WHERE email.id = checked_email_id
  FOR UPDATE;

  IF email_record.id IS NULL
     OR email_record.task_completion_notice_request_id IS NULL
     OR email_record.status IS DISTINCT FROM 'sent'
     OR email_record.provider_name IS DISTINCT FROM 'smtp_sink'
     OR email_record.provider_msg_id IS NULL
     OR email_record.provider_receipt_at IS NULL
     OR email_record.provider_io_started_at IS NULL
     OR email_record.notification_provider_attempt_id IS NULL
     OR email_record.provider_receipt_at < email_record.provider_io_started_at
     OR email_record.provider_msg_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,254}$' THEN
    RAISE EXCEPTION 'HXUV1-NOTICE-14: a bound synthetic SMTP provider receipt is required'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO request_record
  FROM public.task_completion_notice_requests request
  WHERE request.id = email_record.task_completion_notice_request_id
  FOR SHARE;

  IF request_record.id IS NULL
     OR request_record.channel IS DISTINCT FROM 'EMAIL'
     OR request_record.provider_kind IS DISTINCT FROM 'SYNTHETIC_SINK'
     OR request_record.recipient_user_id IS DISTINCT FROM email_record.user_id THEN
    RAISE EXCEPTION 'HXUV1-NOTICE-15: synthetic sink receipt authority is unavailable'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('completion-notice-delivery:' || request_record.id::TEXT, 0)
  );

  expected_provider_delivery_id := 'smtp_sink:' || email_record.provider_msg_id;
  expected_delivery_idempotency_key :=
    'completion-notice-delivery:' || request_record.id::TEXT;
  expected_delivery_request_sha256 :=
    public.universal_v1_completion_notice_receipt_sha256(
    request_record.id,
    email_record.id,
    email_record.provider_msg_id,
    email_record.provider_receipt_at,
    request_record.sink_actor_user_id
  );

  SELECT * INTO existing_delivery
  FROM public.task_completion_delivery_events delivery
  WHERE delivery.completion_notice_request_id = request_record.id
     OR delivery.provider_delivery_id = expected_provider_delivery_id
     OR delivery.idempotency_key = expected_delivery_idempotency_key
  ORDER BY delivery.id
  FOR SHARE;

  IF existing_delivery.id IS NOT NULL THEN
    IF existing_delivery.completion_notice_request_id = request_record.id
       AND existing_delivery.provider_delivery_id = expected_provider_delivery_id
       AND existing_delivery.idempotency_key = expected_delivery_idempotency_key
       AND existing_delivery.request_sha256 = expected_delivery_request_sha256 THEN
      RETURN existing_delivery.id;
    END IF;
    RAISE EXCEPTION 'HXUV1-NOTICE-16: completion notice provider receipt identity is already bound differently'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.task_completion_delivery_events (
    task_id,
    work_order_id,
    expected_completion_fact_id,
    expected_completion_version,
    expected_execution_version,
    completion_notice_request_id,
    provider_delivery_id,
    channel,
    delivered_at,
    recorded_by,
    provider_kind,
    provider_service_identity,
    idempotency_key,
    request_sha256,
    provider_callback_at,
    policy_version
  ) VALUES (
    request_record.task_id,
    request_record.work_order_id,
    request_record.submitted_completion_fact_id,
    request_record.completion_version,
    request_record.execution_version,
    request_record.id,
    expected_provider_delivery_id,
    'EMAIL',
    email_record.provider_receipt_at,
    request_record.sink_actor_user_id,
    'SYNTHETIC_SINK',
    'hustlexp.synthetic-communications-sink.v1:' || request_record.sink_actor_user_id::TEXT,
    expected_delivery_idempotency_key,
    expected_delivery_request_sha256,
    clock_timestamp(),
    'universal-v1-completion-delivery-receipt-1.0.0'
  )
  RETURNING id INTO inserted_id;

  RETURN inserted_id;
END;
$$;

-- Successor guard for the lifecycle migration's task-only delivery check.
-- A post-138 decision may cite only the delivery fact derived from the exact
-- immutable notice request for the submitted completion it supersedes.
-- Approval requires that delivery; rejection may omit it, but cannot attach
-- an unrelated receipt as audit evidence.
CREATE OR REPLACE FUNCTION public.enforce_universal_v1_completion_notice_approval_binding()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  submitted public.task_completion_facts%ROWTYPE;
  notice_request public.task_completion_notice_requests%ROWTYPE;
BEGIN
  IF NEW.fact_kind NOT IN ('APPROVED', 'REJECTED')
     OR NEW.supersedes_fact_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO submitted
  FROM public.task_completion_facts completion
  WHERE completion.id = NEW.supersedes_fact_id
  FOR SHARE;

  SELECT * INTO notice_request
  FROM public.task_completion_notice_requests request
  WHERE request.submitted_completion_fact_id = submitted.id
  FOR SHARE;

  IF notice_request.id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.delivery_event_id IS NULL THEN
    IF NEW.fact_kind = 'APPROVED' THEN
      RAISE EXCEPTION 'HXUV1-NOTICE-20: approval requires the exact request-bound completion delivery fact'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.task_completion_delivery_events delivery
    WHERE delivery.id = NEW.delivery_event_id
      AND delivery.completion_notice_request_id = notice_request.id
      AND delivery.task_id = notice_request.task_id
      AND delivery.work_order_id = notice_request.work_order_id
      AND delivery.expected_completion_fact_id = notice_request.submitted_completion_fact_id
      AND delivery.expected_completion_version = notice_request.completion_version
      AND delivery.expected_execution_version = notice_request.execution_version
      AND delivery.provider_kind = 'SYNTHETIC_SINK'
      AND delivery.recorded_by = notice_request.sink_actor_user_id
  ) THEN
    RAISE EXCEPTION 'HXUV1-NOTICE-20: a supplied decision receipt must exactly bind the completion notice request'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_completion_notice_approval_guard
  ON public.task_completion_facts;
CREATE TRIGGER universal_v1_completion_notice_approval_guard
BEFORE INSERT ON public.task_completion_facts
FOR EACH ROW
EXECUTE FUNCTION public.enforce_universal_v1_completion_notice_approval_binding();

REVOKE ALL ON TABLE public.task_completion_notice_requests FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_completion_delivery_receipt()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lock_universal_v1_fulfillment_execution_insert()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lock_universal_v1_fulfillment_completion_insert()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_completion_notice_request_sha256(
  UUID, UUID, UUID, UUID, INTEGER, UUID, INTEGER, UUID, INTEGER, UUID, UUID, TEXT, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_completion_notice_request()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prevent_universal_v1_completion_notice_mutation()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_completion_notice_email()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_completion_notice_outbox()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prevent_universal_v1_completion_notice_dispatch_truncate()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_universal_v1_completion_notice_dispatch_bound()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_completion_notice_receipt_sha256(
  UUID, UUID, TEXT, TIMESTAMPTZ, UUID
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_completion_notice_delivery_binding()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.materialize_universal_v1_completion_notice_delivery(UUID)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_completion_notice_approval_binding()
  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.universal_v1_completion_notice_request_sha256(
  UUID, UUID, UUID, UUID, INTEGER, UUID, INTEGER, UUID, INTEGER, UUID, UUID, TEXT, TEXT
) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.materialize_universal_v1_completion_notice_delivery(UUID)
  TO CURRENT_USER;

COMMENT ON TABLE public.task_completion_notice_requests IS
  'Append-only causal authority for one async EMAIL notice per exact Universal V1 submitted completion; CONTROLLED_TEST, unassigned, payment-frozen, and synthetic-sink only.';
COMMENT ON COLUMN public.email_outbox.task_completion_notice_request_id IS
  'Immutable binding from one EMAIL delivery attempt to its exact Universal V1 completion notice request.';
COMMENT ON COLUMN public.email_outbox.provider_receipt_at IS
  'Database time at which the provider-neutral worker persisted a provider receipt; required for request-bound synthetic SMTP deliveries.';
COMMENT ON FUNCTION public.materialize_universal_v1_completion_notice_delivery(UUID) IS
  'Idempotently derives one immutable completion-delivery fact from an exact persisted smtp_sink receipt; never performs network I/O, assignment, or a money effect.';
COMMENT ON FUNCTION public.enforce_universal_v1_completion_delivery_receipt() IS
  'Legacy unbound receipts retain migration-121 HMAC callback and current-service-actor rules; request-bound receipts instead require the exact immutable completion notice request and its persisted synthetic-sink provider boundary receipt.';
