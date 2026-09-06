-- Universal V1 provider-authored Financial Security Event expiry v1.
--
-- Expiry is immutable provider truth, not a scheduler or renewal authority.
-- Historical rows remain untouched. New successful authorization/security/
-- adjustment facts must carry an expiry later than their provider occurrence;
-- every other result must carry no expiry. Positive consumers compare that
-- expiry with their own database-observed command time. Recovery, void,
-- refund, reversal, settlement observation, and reconciliation stay outside
-- these positive-use gates.

DO $$
BEGIN
  IF to_regclass('public.task_financial_security_events') IS NULL
     OR to_regclass('public.task_work_orders') IS NULL
     OR to_regclass('public.task_work_order_amendments') IS NULL
     OR to_regclass('public.universal_v1_prepared_financial_commands') IS NULL
     OR to_regclass('public.financial_provider_command_journal') IS NULL
     OR to_regclass('public.financial_provider_command_dispatch_attempts') IS NULL
     OR to_regclass('public.task_location_access_log') IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FSE-EXP-0: exact Universal V1 financial authority chain must be installed first'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

ALTER TABLE public.task_financial_security_events
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'task_financial_security_events_expiry_v1_chk'
       AND conrelid = 'public.task_financial_security_events'::regclass
  ) THEN
    ALTER TABLE public.task_financial_security_events
      ADD CONSTRAINT task_financial_security_events_expiry_v1_chk CHECK (
        (
          status = 'SUCCEEDED'
          AND event_kind IN ('AUTHORIZED', 'SECURED', 'ADJUSTMENT_AUTHORIZED')
          AND expires_at IS NOT NULL
          AND expires_at > occurred_at
        )
        OR
        (
          NOT (
            status = 'SUCCEEDED'
            AND event_kind IN ('AUTHORIZED', 'SECURED', 'ADJUSTMENT_AUTHORIZED')
          )
          AND expires_at IS NULL
        )
      ) NOT VALID;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.universal_v1_financial_security_is_current_v1(
  checked_expires_at TIMESTAMPTZ,
  observed_at TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT checked_expires_at IS NOT NULL
     AND observed_at IS NOT NULL
     AND checked_expires_at > observed_at;
$$;

COMMENT ON COLUMN public.task_financial_security_events.expires_at IS
  'Provider-authored expiry for successful AUTHORIZED, SECURED, and ADJUSTMENT_AUTHORIZED facts only. NULL is stale/unusable for positive authority.';
COMMENT ON FUNCTION public.universal_v1_financial_security_is_current_v1(
  TIMESTAMPTZ,
  TIMESTAMPTZ
) IS
  'Fail-closed expiry comparison against an explicit authoritative observed_at; never reads a clock or session GUC.';

CREATE OR REPLACE FUNCTION public.universal_v1_effective_financial_security_expiry_v1(
  starting_event_id UUID
)
RETURNS TIMESTAMPTZ
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  WITH RECURSIVE authority_chain AS (
    SELECT financial.id,
           financial.predecessor_event_id,
           financial.event_kind,
           financial.status,
           financial.expires_at,
           0 AS depth
      FROM public.task_financial_security_events financial
     WHERE financial.id = starting_event_id
    UNION ALL
    SELECT predecessor.id,
           predecessor.predecessor_event_id,
           predecessor.event_kind,
           predecessor.status,
           predecessor.expires_at,
           successor.depth + 1
      FROM authority_chain successor
      JOIN public.task_financial_security_events predecessor
        ON predecessor.id = successor.predecessor_event_id
     WHERE successor.depth < 63
  )
  SELECT authority.expires_at
    FROM authority_chain authority
   WHERE authority.status = 'SUCCEEDED'
     AND authority.event_kind IN ('AUTHORIZED', 'SECURED', 'ADJUSTMENT_AUTHORIZED')
   ORDER BY authority.depth
   LIMIT 1;
$$;

COMMENT ON FUNCTION public.universal_v1_effective_financial_security_expiry_v1(UUID) IS
  'Resolves the nearest successful provider-authored security expiry through append-only retry/failure observations; never invents renewal.';

CREATE INDEX IF NOT EXISTS task_financial_security_events_current_expiry_v1_idx
  ON public.task_financial_security_events(task_draft_id, expires_at, expected_version)
  WHERE status = 'SUCCEEDED'
    AND event_kind IN ('AUTHORIZED', 'SECURED', 'ADJUSTMENT_AUTHORIZED');

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_work_order_financial_expiry_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  observed_at TIMESTAMPTZ;
  security_expiry TIMESTAMPTZ;
BEGIN
  observed_at := clock_timestamp();
  NEW.materialized_at := observed_at;
  SELECT public.universal_v1_effective_financial_security_expiry_v1(
           NEW.financial_security_event_id
         )
    INTO security_expiry
  ;

  IF NOT public.universal_v1_financial_security_is_current_v1(
    security_expiry,
    observed_at
  ) THEN
    RAISE EXCEPTION 'HXUV1-FSE-EXP-1: expired financial security cannot materialize a Work Order'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_universal_v1_work_order_financial_expiry_v1
  ON public.task_work_orders;
CREATE TRIGGER zz_universal_v1_work_order_financial_expiry_v1
BEFORE INSERT ON public.task_work_orders
FOR EACH ROW
EXECUTE FUNCTION public.enforce_universal_v1_work_order_financial_expiry_v1();

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_amendment_financial_expiry_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  observed_at TIMESTAMPTZ;
  adjustment_expiry TIMESTAMPTZ;
BEGIN
  IF NEW.adjustment_event_id IS NULL THEN
    RETURN NEW;
  END IF;

  observed_at := clock_timestamp();
  NEW.materialized_at := observed_at;

  SELECT public.universal_v1_effective_financial_security_expiry_v1(
           NEW.adjustment_event_id
         )
    INTO adjustment_expiry
  ;

  IF NOT public.universal_v1_financial_security_is_current_v1(
    adjustment_expiry,
    observed_at
  ) THEN
    RAISE EXCEPTION 'HXUV1-FSE-EXP-2: expired adjustment authority cannot materialize a Work Order amendment'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_universal_v1_amendment_financial_expiry_v1
  ON public.task_work_order_amendments;
CREATE TRIGGER zz_universal_v1_amendment_financial_expiry_v1
BEFORE INSERT ON public.task_work_order_amendments
FOR EACH ROW
EXECUTE FUNCTION public.enforce_universal_v1_amendment_financial_expiry_v1();

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_prepared_positive_expiry_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  predecessor_expiry TIMESTAMPTZ;
BEGIN
  IF NEW.operation_kind NOT IN ('SECURE', 'ADJUST', 'CAPTURE') THEN
    RETURN NEW;
  END IF;

  SELECT public.universal_v1_effective_financial_security_expiry_v1(
           NEW.predecessor_event_id
         )
    INTO predecessor_expiry
  ;

  IF NOT public.universal_v1_financial_security_is_current_v1(
    predecessor_expiry,
    NEW.prepared_at
  ) THEN
    RAISE EXCEPTION 'HXUV1-FSE-EXP-3: expired financial security cannot prepare positive provider I/O'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS v_universal_v1_prepared_positive_expiry_v1
  ON public.universal_v1_prepared_financial_commands;
CREATE TRIGGER v_universal_v1_prepared_positive_expiry_v1
BEFORE INSERT ON public.universal_v1_prepared_financial_commands
FOR EACH ROW
EXECUTE FUNCTION public.enforce_universal_v1_prepared_positive_expiry_v1();

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_dispatch_positive_expiry_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  dispatched_operation_kind TEXT;
  predecessor_expiry TIMESTAMPTZ;
BEGIN
  SELECT journal.operation_kind,
         public.universal_v1_effective_financial_security_expiry_v1(
           prepared.predecessor_event_id
         )
    INTO dispatched_operation_kind, predecessor_expiry
    FROM public.financial_provider_command_journal journal
    LEFT JOIN public.universal_v1_prepared_financial_commands prepared
      ON prepared.prepared_command_id = journal.prepared_financial_command_id
   LEFT JOIN public.task_financial_security_events financial
      ON financial.id = prepared.predecessor_event_id
   WHERE journal.command_id = NEW.command_id
   FOR SHARE OF journal;

  IF dispatched_operation_kind IN ('SECURE', 'ADJUST', 'CAPTURE')
     AND NOT public.universal_v1_financial_security_is_current_v1(
       predecessor_expiry,
       NEW.attempted_at
     ) THEN
    RAISE EXCEPTION 'HXUV1-FSE-EXP-4: expired financial security cannot enter positive provider I/O'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- Trigger names are ordered alphabetically. The existing recovery guard first
-- replaces attempted_at with its database clock observation; this guard then
-- evaluates that exact value immediately before the adapter-entry fact exists.
DROP TRIGGER IF EXISTS v_universal_v1_dispatch_positive_expiry_v1
  ON public.financial_provider_command_dispatch_attempts;
CREATE TRIGGER v_universal_v1_dispatch_positive_expiry_v1
BEFORE INSERT ON public.financial_provider_command_dispatch_attempts
FOR EACH ROW
EXECUTE FUNCTION public.enforce_universal_v1_dispatch_positive_expiry_v1();

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_location_access_expiry_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  observed_at TIMESTAMPTZ;
  task_contract_version INTEGER;
  task_work_order_id UUID;
  work_order_id UUID;
  security_expiry TIMESTAMPTZ;
BEGIN
  observed_at := clock_timestamp();
  NEW.accessed_at := observed_at;

  SELECT task_record.universal_contract_version,
         task_record.work_order_id,
         work_order.id,
         public.universal_v1_effective_financial_security_expiry_v1(
           work_order.financial_security_event_id
         )
    INTO task_contract_version, task_work_order_id, work_order_id, security_expiry
    FROM public.tasks task_record
    LEFT JOIN public.task_work_orders work_order
      ON work_order.id = task_record.work_order_id
     AND work_order.task_id = task_record.id
   WHERE task_record.id = NEW.task_id
   FOR SHARE OF task_record;

  IF task_contract_version = 1
     AND (
       task_work_order_id IS NULL
       OR work_order_id IS NULL
       OR NOT public.universal_v1_financial_security_is_current_v1(
         security_expiry,
         observed_at
       )
     ) THEN
    RAISE EXCEPTION 'HXUV1-FSE-EXP-5: expired financial security cannot release a Universal V1 exact address'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS v_universal_v1_location_access_expiry_v1
  ON public.task_location_access_log;
CREATE TRIGGER v_universal_v1_location_access_expiry_v1
BEFORE INSERT ON public.task_location_access_log
FOR EACH ROW
EXECUTE FUNCTION public.enforce_universal_v1_location_access_expiry_v1();

REVOKE ALL ON FUNCTION public.universal_v1_financial_security_is_current_v1(
  TIMESTAMPTZ,
  TIMESTAMPTZ
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_effective_financial_security_expiry_v1(UUID)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_work_order_financial_expiry_v1()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_amendment_financial_expiry_v1()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_prepared_positive_expiry_v1()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_dispatch_positive_expiry_v1()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_location_access_expiry_v1()
  FROM PUBLIC;
