-- Universal V1 pre-WorkOrder fake-finance compensation authority v1.
--
-- This migration adds one immutable recovery command for the only boundary at
-- which a successful fake SECURE fact can outlive a failed WorkOrder
-- finalization. The command is derived exclusively from the Phase-A witness
-- and the exact terminal fake lifecycle bridge. It cannot create money,
-- assignment, deployment, or approved-provider authority.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF to_regclass('public.task_work_order_command_requests') IS NULL
     OR to_regclass('public.task_work_orders') IS NULL
     OR to_regclass('public.task_financial_security_events') IS NULL
     OR to_regclass('public.universal_v1_prepared_financial_commands') IS NULL
     OR to_regprocedure('public.enforce_universal_v1_financial_command_preparation()') IS NULL THEN
    RAISE EXCEPTION 'HXUV1-WOC-0: WorkOrder and prepared-finance authority must be installed first'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

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
    encode(digest(work_order_idempotency_key || ':' || operation_label, 'sha256'), 'hex'),
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

CREATE TABLE IF NOT EXISTS public.universal_v1_work_order_compensation_commands (
  compensation_command_id UUID PRIMARY KEY,
  work_order_idempotency_key TEXT NOT NULL UNIQUE
    REFERENCES public.task_work_order_command_requests(idempotency_key) ON DELETE RESTRICT,
  task_draft_id UUID NOT NULL REFERENCES public.task_drafts(id) ON DELETE RESTRICT,
  task_id UUID NOT NULL UNIQUE REFERENCES public.tasks(id) ON DELETE RESTRICT,
  scope_version_id UUID NOT NULL REFERENCES public.task_scope_versions(id) ON DELETE RESTRICT,
  eligibility_decision_id UUID NOT NULL
    REFERENCES public.task_provider_eligibility_decisions(id) ON DELETE RESTRICT,
  secured_event_id UUID NOT NULL UNIQUE
    REFERENCES public.task_financial_security_events(id) ON DELETE RESTRICT,
  secured_operation_id UUID NOT NULL,
  void_operation_id UUID NOT NULL UNIQUE,
  void_idempotency_key TEXT NOT NULL UNIQUE CHECK (
    void_idempotency_key ~ '^[A-Za-z0-9:_-]{16,128}$'
  ),
  amount_cents BIGINT NOT NULL CHECK (amount_cents BETWEEN 1 AND 9007199254740991),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  requested_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'FINALIZATION_FAILED', 'RECOVERY_TIMEOUT'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION public.validate_universal_v1_work_order_compensation_command()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  request_record RECORD;
  task_record RECORD;
  secured_record RECORD;
  bridge_record RECORD;
BEGIN
  IF to_regclass('public.universal_v1_fake_financial_lifecycle_bridges') IS NULL THEN
    RAISE EXCEPTION 'HXUV1-WOC-1: nonproduction fake lifecycle bridge authority is unavailable'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO request_record
    FROM public.task_work_order_command_requests
   WHERE idempotency_key = NEW.work_order_idempotency_key;
  IF request_record.idempotency_key IS NULL THEN
    RAISE EXCEPTION 'HXUV1-WOC-2: exact Phase-A WorkOrder witness is required'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('work-order:' || request_record.task_id::TEXT, 0)
  );
  SELECT * INTO request_record
    FROM public.task_work_order_command_requests
   WHERE idempotency_key = NEW.work_order_idempotency_key
   FOR SHARE;
  SELECT * INTO task_record
    FROM public.tasks
   WHERE id = request_record.task_id
   FOR SHARE;
  SELECT * INTO secured_record
    FROM public.task_financial_security_events
   WHERE id = NEW.secured_event_id
   FOR SHARE;
  SELECT * INTO bridge_record
    FROM public.universal_v1_fake_financial_lifecycle_bridges
   WHERE task_financial_security_event_id = NEW.secured_event_id
   FOR SHARE;

  IF task_record.id IS NULL
     OR secured_record.id IS NULL
     OR bridge_record.bridge_id IS NULL
     OR NEW.requested_by IS DISTINCT FROM request_record.actor_user_id
     OR task_record.universal_contract_version <> 1
     OR task_record.automation_classification <> 'CONTROLLED_TEST'
     OR task_record.universal_payment_posture <> 'PAYMENT_CREATION_FROZEN'
     OR task_record.worker_id IS NOT NULL
     OR task_record.work_order_id IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM public.task_work_orders work_order
       WHERE work_order.task_id = request_record.task_id
          OR work_order.idempotency_key = request_record.idempotency_key
     )
     OR secured_record.operation_id IS DISTINCT FROM
          public.universal_v1_work_order_operation_id_v1(
            request_record.idempotency_key, 'secure'
          )::TEXT
     OR secured_record.event_kind <> 'SECURED'
     OR secured_record.status <> 'SUCCEEDED'
     OR secured_record.provider_kind <> 'FAKE'
     OR secured_record.expected_version <> 2
     OR secured_record.task_draft_id IS DISTINCT FROM request_record.task_draft_id
     OR secured_record.task_id IS DISTINCT FROM request_record.task_id
     OR secured_record.eligibility_decision_id IS DISTINCT FROM request_record.eligibility_decision_id
     OR secured_record.scope_version_id IS DISTINCT FROM request_record.scope_version_id
     OR secured_record.amount_cents IS DISTINCT FROM request_record.amount_cents
     OR secured_record.currency IS DISTINCT FROM request_record.currency
     OR bridge_record.fake_operation_id IS DISTINCT FROM secured_record.operation_id::UUID
     OR bridge_record.fake_operation_kind <> 'SECURE'
     OR bridge_record.fake_provider_state <> 'SUCCEEDED'
     OR bridge_record.lifecycle_event_kind <> 'SECURED'
     OR bridge_record.lifecycle_status <> 'SUCCEEDED'
     OR bridge_record.lifecycle_expected_version <> 2
     OR bridge_record.task_draft_id IS DISTINCT FROM request_record.task_draft_id
     OR bridge_record.task_id IS DISTINCT FROM request_record.task_id
     OR bridge_record.eligibility_decision_id IS DISTINCT FROM request_record.eligibility_decision_id
     OR bridge_record.scope_version_id IS DISTINCT FROM request_record.scope_version_id
     OR bridge_record.amount_cents IS DISTINCT FROM request_record.amount_cents
     OR bridge_record.currency IS DISTINCT FROM request_record.currency
     OR EXISTS (
       SELECT 1 FROM public.task_financial_security_events successor
       WHERE successor.task_draft_id = secured_record.task_draft_id
         AND successor.expected_version > secured_record.expected_version
     ) THEN
    RAISE EXCEPTION 'HXUV1-WOC-3: compensation requires the exact unfinalized terminal SECURE chain'
      USING ERRCODE = 'P0001';
  END IF;

  NEW.compensation_command_id := public.universal_v1_work_order_operation_id_v1(
    request_record.idempotency_key,
    'void-compensation-command'
  );
  NEW.task_draft_id := request_record.task_draft_id;
  NEW.task_id := request_record.task_id;
  NEW.scope_version_id := request_record.scope_version_id;
  NEW.eligibility_decision_id := request_record.eligibility_decision_id;
  NEW.secured_operation_id := secured_record.operation_id::UUID;
  NEW.void_operation_id := public.universal_v1_work_order_operation_id_v1(
    request_record.idempotency_key,
    'void'
  );
  NEW.void_idempotency_key := request_record.idempotency_key || ':void';
  NEW.amount_cents := request_record.amount_cents;
  NEW.currency := request_record.currency;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_work_order_compensation_command_guard
  ON public.universal_v1_work_order_compensation_commands;
CREATE TRIGGER universal_v1_work_order_compensation_command_guard
BEFORE INSERT ON public.universal_v1_work_order_compensation_commands
FOR EACH ROW
EXECUTE FUNCTION public.validate_universal_v1_work_order_compensation_command();

CREATE OR REPLACE FUNCTION public.reject_universal_v1_work_order_compensation_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'HXUV1-WOC-4: WorkOrder compensation commands are append-only'
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_work_order_compensation_no_update_delete
  ON public.universal_v1_work_order_compensation_commands;
CREATE TRIGGER universal_v1_work_order_compensation_no_update_delete
BEFORE UPDATE OR DELETE ON public.universal_v1_work_order_compensation_commands
FOR EACH ROW
EXECUTE FUNCTION public.reject_universal_v1_work_order_compensation_mutation();
DROP TRIGGER IF EXISTS universal_v1_work_order_compensation_no_truncate
  ON public.universal_v1_work_order_compensation_commands;
CREATE TRIGGER universal_v1_work_order_compensation_no_truncate
BEFORE TRUNCATE ON public.universal_v1_work_order_compensation_commands
FOR EACH STATEMENT
EXECUTE FUNCTION public.reject_universal_v1_work_order_compensation_mutation();

-- This predicate is the only exception to pre-WorkOrder eligibility freshness.
-- Every other PFC validation still runs, including frozen task posture, exact
-- predecessor, amount/currency, unused lifecycle version, and fake-only gates.
CREATE OR REPLACE FUNCTION public.universal_v1_pre_work_order_void_is_authorized(
  checked_operation_id UUID,
  checked_provider_kind TEXT,
  checked_idempotency_key TEXT,
  checked_provider_expected_version BIGINT,
  checked_lifecycle_expected_version BIGINT,
  checked_task_draft_id UUID,
  checked_task_id UUID,
  checked_eligibility_decision_id UUID,
  checked_scope_version_id UUID,
  checked_predecessor_event_id UUID,
  checked_related_operation_id UUID,
  checked_amount_cents BIGINT,
  checked_currency TEXT,
  checked_recorded_by UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
PARALLEL UNSAFE
AS $$
BEGIN
  IF to_regclass('public.universal_v1_fake_financial_lifecycle_bridges') IS NULL THEN
    RETURN FALSE;
  END IF;
  RETURN EXISTS (
    SELECT 1
      FROM public.universal_v1_work_order_compensation_commands compensation
      JOIN public.task_work_order_command_requests request
        ON request.idempotency_key = compensation.work_order_idempotency_key
      JOIN public.task_financial_security_events secured
        ON secured.id = compensation.secured_event_id
      JOIN public.universal_v1_fake_financial_lifecycle_bridges bridge
        ON bridge.task_financial_security_event_id = secured.id
      JOIN public.tasks task_record ON task_record.id = compensation.task_id
     WHERE compensation.void_operation_id = checked_operation_id
       AND compensation.void_idempotency_key = checked_idempotency_key
       AND compensation.requested_by = checked_recorded_by
       AND checked_provider_kind = 'FAKE'
       AND checked_provider_expected_version = 0
       AND checked_lifecycle_expected_version = 3
       AND compensation.task_draft_id = checked_task_draft_id
       AND compensation.task_id = checked_task_id
       AND compensation.eligibility_decision_id = checked_eligibility_decision_id
       AND compensation.scope_version_id = checked_scope_version_id
       AND compensation.secured_event_id = checked_predecessor_event_id
       AND compensation.secured_operation_id = checked_related_operation_id
       AND compensation.amount_cents = checked_amount_cents
       AND compensation.currency = upper(checked_currency)
       AND request.actor_user_id = checked_recorded_by
       AND secured.operation_id = checked_related_operation_id::TEXT
       AND secured.event_kind = 'SECURED'
       AND secured.status = 'SUCCEEDED'
       AND secured.provider_kind = 'FAKE'
       AND secured.expected_version = 2
       AND bridge.fake_operation_kind = 'SECURE'
       AND bridge.lifecycle_event_kind = 'SECURED'
       AND bridge.lifecycle_status = 'SUCCEEDED'
       AND bridge.lifecycle_expected_version = 2
       AND task_record.universal_contract_version = 1
       AND task_record.automation_classification = 'CONTROLLED_TEST'
       AND task_record.universal_payment_posture = 'PAYMENT_CREATION_FROZEN'
       AND task_record.worker_id IS NULL
       AND task_record.work_order_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.task_work_orders work_order
         WHERE work_order.task_id = compensation.task_id
       )
  );
END;
$$;

-- Patch only PFC-9 in the already-installed canonical trigger definition. The
-- migration refuses to apply if its exact predecessor definition drifted.
DO $migration$
DECLARE
  definition TEXT;
  needle TEXT := $needle$    IF work_order.id IS NULL THEN
      IF eligibility.scope_version_id IS DISTINCT FROM NEW.scope_version_id
         OR eligibility.valid_until <= clock_timestamp()
         OR EXISTS (
           SELECT 1
           FROM public.task_provider_eligibility_decisions newer
           WHERE newer.task_draft_id = eligibility.task_draft_id
             AND newer.provider_user_id = eligibility.provider_user_id
             AND newer.provider_organization_id IS NOT DISTINCT FROM eligibility.provider_organization_id
             AND newer.decision_version > eligibility.decision_version
         ) THEN
        RAISE EXCEPTION 'HXUV1-PFC-9: pre-Work-Order finance requires current unexpired eligibility and its exact scope'
          USING ERRCODE = 'P0001';
      END IF;
    ELSE$needle$;
  replacement TEXT := $replacement$    IF work_order.id IS NULL THEN
      IF eligibility.scope_version_id IS DISTINCT FROM NEW.scope_version_id
         OR (
           (
             eligibility.valid_until <= clock_timestamp()
             OR EXISTS (
               SELECT 1
               FROM public.task_provider_eligibility_decisions newer
               WHERE newer.task_draft_id = eligibility.task_draft_id
                 AND newer.provider_user_id = eligibility.provider_user_id
                 AND newer.provider_organization_id IS NOT DISTINCT FROM eligibility.provider_organization_id
                 AND newer.decision_version > eligibility.decision_version
             )
           )
           AND NOT (
             NEW.operation_kind = 'VOID'
             AND public.universal_v1_pre_work_order_void_is_authorized(
               NEW.operation_id,
               NEW.provider_kind,
               NEW.idempotency_key,
               NEW.provider_expected_version,
               NEW.lifecycle_expected_version,
               NEW.task_draft_id,
               NEW.task_id,
               NEW.eligibility_decision_id,
               NEW.scope_version_id,
               NEW.predecessor_event_id,
               NEW.related_operation_id,
               NEW.amount_cents,
               NEW.currency,
               NEW.recorded_by
             )
           )
         ) THEN
        RAISE EXCEPTION 'HXUV1-PFC-9: pre-Work-Order finance requires current eligibility or one exact compensation claim'
          USING ERRCODE = 'P0001';
      END IF;
    ELSE$replacement$;
BEGIN
  definition := pg_get_functiondef(
    'public.enforce_universal_v1_financial_command_preparation()'::regprocedure
  );
  IF (length(definition) - length(replace(definition, replacement, '')))
       / length(replacement) = 1
     AND (length(definition) - length(replace(definition, needle, '')))
       / length(needle) = 0 THEN
    -- The registered runner deliberately verifies an unapplied row after
    -- executing SQL. If a database connection is interrupted at that exact
    -- boundary, rerunning this append-only migration must recognize the
    -- already-installed exact replacement rather than broaden or re-patch it.
    NULL;
  ELSIF (length(definition) - length(replace(definition, needle, '')))
          / length(needle) = 1
        AND (length(definition) - length(replace(definition, replacement, '')))
          / length(replacement) = 0 THEN
    EXECUTE replace(definition, needle, replacement);
  ELSE
    RAISE EXCEPTION 'HXUV1-WOC-5: prepared-finance predecessor definition drifted'
      USING ERRCODE = 'P0001';
  END IF;
END;
$migration$;

CREATE OR REPLACE FUNCTION public.validate_universal_v1_pre_work_order_void()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.operation_kind = 'VOID'
     AND NEW.work_order_id IS NULL
     AND NOT public.universal_v1_pre_work_order_void_is_authorized(
       NEW.operation_id,
       NEW.provider_kind,
       NEW.idempotency_key,
       NEW.provider_expected_version,
       NEW.lifecycle_expected_version,
       NEW.task_draft_id,
       NEW.task_id,
       NEW.eligibility_decision_id,
       NEW.scope_version_id,
       NEW.predecessor_event_id,
       NEW.related_operation_id,
       NEW.amount_cents,
       NEW.currency,
       NEW.recorded_by
     ) THEN
    RAISE EXCEPTION 'HXUV1-WOC-6: pre-WorkOrder VOID requires the exact immutable compensation command'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_universal_v1_pre_work_order_void_guard
  ON public.universal_v1_prepared_financial_commands;
CREATE TRIGGER zz_universal_v1_pre_work_order_void_guard
BEFORE INSERT ON public.universal_v1_prepared_financial_commands
FOR EACH ROW
EXECUTE FUNCTION public.validate_universal_v1_pre_work_order_void();

CREATE OR REPLACE FUNCTION public.reject_universal_v1_work_order_after_compensation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.universal_v1_work_order_compensation_commands compensation
     WHERE compensation.task_id = NEW.task_id
        OR compensation.work_order_idempotency_key = NEW.idempotency_key
  ) THEN
    RAISE EXCEPTION 'HXUV1-WOC-7: compensation already won the WorkOrder resolution race'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS aa_universal_v1_work_order_compensation_winner_guard
  ON public.task_work_orders;
CREATE TRIGGER aa_universal_v1_work_order_compensation_winner_guard
BEFORE INSERT ON public.task_work_orders
FOR EACH ROW
EXECUTE FUNCTION public.reject_universal_v1_work_order_after_compensation();

CREATE OR REPLACE FUNCTION public.claim_universal_v1_work_order_compensations(
  requested_limit INTEGER,
  minimum_age_seconds INTEGER
)
RETURNS SETOF public.universal_v1_work_order_compensation_commands
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  candidate RECORD;
BEGIN
  IF requested_limit IS NULL OR requested_limit < 1 OR requested_limit > 100
     OR minimum_age_seconds IS NULL
     OR minimum_age_seconds < 5 OR minimum_age_seconds > 3600 THEN
    RAISE EXCEPTION 'HXUV1-WOC-8: compensation claim bounds are invalid'
      USING ERRCODE = '22023';
  END IF;
  IF to_regclass('public.universal_v1_fake_financial_lifecycle_bridges') IS NULL THEN
    RAISE EXCEPTION 'HXUV1-WOC-1: nonproduction fake lifecycle bridge authority is unavailable'
      USING ERRCODE = 'P0001';
  END IF;

  FOR candidate IN
    SELECT request.idempotency_key, request.task_id, request.actor_user_id,
           bridge.task_financial_security_event_id
      FROM public.task_work_order_command_requests request
      JOIN public.tasks task_record ON task_record.id = request.task_id
      JOIN public.universal_v1_fake_financial_lifecycle_bridges bridge
        ON bridge.task_id = request.task_id
       AND bridge.task_draft_id = request.task_draft_id
       AND bridge.eligibility_decision_id = request.eligibility_decision_id
       AND bridge.scope_version_id = request.scope_version_id
       AND bridge.amount_cents = request.amount_cents
       AND bridge.currency = request.currency
       AND bridge.fake_operation_id = public.universal_v1_work_order_operation_id_v1(
         request.idempotency_key,
         'secure'
       )
       AND bridge.fake_operation_kind = 'SECURE'
       AND bridge.fake_provider_state = 'SUCCEEDED'
       AND bridge.lifecycle_event_kind = 'SECURED'
       AND bridge.lifecycle_status = 'SUCCEEDED'
       AND bridge.lifecycle_expected_version = 2
     WHERE task_record.universal_contract_version = 1
       AND task_record.automation_classification = 'CONTROLLED_TEST'
       AND task_record.universal_payment_posture = 'PAYMENT_CREATION_FROZEN'
       AND task_record.worker_id IS NULL
       AND task_record.work_order_id IS NULL
       AND bridge.materialized_at <= clock_timestamp() - make_interval(secs => minimum_age_seconds)
       AND NOT EXISTS (
         SELECT 1 FROM public.task_work_orders work_order
         WHERE work_order.task_id = request.task_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.universal_v1_work_order_compensation_commands compensation
         WHERE compensation.task_id = request.task_id
       )
     ORDER BY bridge.materialized_at, request.idempotency_key
     LIMIT requested_limit
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('work-order:' || candidate.task_id::TEXT, 0)
    );
    IF NOT EXISTS (
      SELECT 1 FROM public.task_work_orders work_order
      WHERE work_order.task_id = candidate.task_id
    ) THEN
      INSERT INTO public.universal_v1_work_order_compensation_commands(
        work_order_idempotency_key,
        secured_event_id,
        requested_by,
        reason_code
      ) VALUES (
        candidate.idempotency_key,
        candidate.task_financial_security_event_id,
        candidate.actor_user_id,
        'RECOVERY_TIMEOUT'
      ) ON CONFLICT (work_order_idempotency_key) DO NOTHING;
    END IF;
  END LOOP;

  RETURN QUERY
  SELECT compensation.*
    FROM public.universal_v1_work_order_compensation_commands compensation
   WHERE NOT EXISTS (
     SELECT 1 FROM public.task_work_orders work_order
     WHERE work_order.task_id = compensation.task_id
   )
     AND NOT EXISTS (
       SELECT 1
         FROM public.task_financial_security_events void_event
         JOIN public.universal_v1_fake_financial_lifecycle_bridges void_bridge
           ON void_bridge.task_financial_security_event_id = void_event.id
        WHERE void_event.operation_id = compensation.void_operation_id::TEXT
          AND void_event.idempotency_key = compensation.void_idempotency_key
          AND void_event.event_kind = 'VOIDED'
          AND void_event.status = 'SUCCEEDED'
          AND void_event.provider_kind = 'FAKE'
          AND void_event.expected_version = 3
          AND void_event.predecessor_event_id = compensation.secured_event_id
          AND void_bridge.fake_operation_kind = 'VOID'
          AND void_bridge.lifecycle_event_kind = 'VOIDED'
          AND void_bridge.lifecycle_status = 'SUCCEEDED'
     )
   ORDER BY compensation.created_at, compensation.compensation_command_id
   LIMIT requested_limit;
END;
$$;

COMMENT ON TABLE public.universal_v1_work_order_compensation_commands IS
  'Immutable, fake-only resolution command. It makes VOID win exactly when a terminal SECURE chain cannot become a WorkOrder.';
COMMENT ON FUNCTION public.claim_universal_v1_work_order_compensations(INTEGER, INTEGER) IS
  'Claims stale exact SECURE witnesses and returns uncompensated commands. The runtime must use the exact idempotency key through durable UNKNOWN reconciliation.';

REVOKE ALL ON TABLE public.universal_v1_work_order_compensation_commands FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_work_order_operation_id_v1(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_universal_v1_work_order_compensation_command() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_universal_v1_work_order_compensation_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_pre_work_order_void_is_authorized(
  UUID, TEXT, TEXT, BIGINT, BIGINT, UUID, UUID, UUID, UUID, UUID, UUID, BIGINT, TEXT, UUID
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_universal_v1_pre_work_order_void() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_universal_v1_work_order_after_compensation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_universal_v1_work_order_compensations(INTEGER, INTEGER) FROM PUBLIC;

GRANT SELECT, INSERT ON TABLE public.universal_v1_work_order_compensation_commands TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.universal_v1_work_order_operation_id_v1(TEXT, TEXT) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.universal_v1_pre_work_order_void_is_authorized(
  UUID, TEXT, TEXT, BIGINT, BIGINT, UUID, UUID, UUID, UUID, UUID, UUID, BIGINT, TEXT, UUID
) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.claim_universal_v1_work_order_compensations(INTEGER, INTEGER) TO CURRENT_USER;
