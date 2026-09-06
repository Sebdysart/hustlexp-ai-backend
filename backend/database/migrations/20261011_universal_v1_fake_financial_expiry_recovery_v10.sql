-- Nonproduction fake-finance v10: sealed legacy-expiry recovery authority.
--
-- This forward-only successor keeps the v9 append-only evidence intact while
-- removing runtime table-write authority. Pre-v9 successes that cannot be
-- represented by the runtime become terminal noncompensable facts; safely
-- valued successes are recovered only through three exact SECURITY DEFINER
-- commands. No row represents money, assignment, production capability, or
-- permission to contact a live provider.

DO $$
BEGIN
  IF pg_catalog.to_regclass('public.hxos_fake_financial_schema_evidence_v9') IS NULL
     OR pg_catalog.to_regclass(
       'public.hxos_fake_financial_legacy_expiry_dispositions_v9'
     ) IS NULL
     OR pg_catalog.to_regclass(
       'public.hxos_fake_financial_legacy_expiry_compensation_commands_v9'
     ) IS NULL
     OR pg_catalog.to_regclass(
       'public.hxos_fake_financial_legacy_expiry_compensation_attempts_v9'
     ) IS NULL
     OR pg_catalog.to_regclass(
       'public.hxos_fake_financial_legacy_expiry_compensation_outcomes_v9'
     ) IS NULL
     OR pg_catalog.to_regclass(
       'public.hxos_fake_financial_legacy_expiry_compensations_v9'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.legacy_fake_expiry_compensation_operation_id_v9(uuid)'
     ) IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FSE-V10-0: exact fake-finance v9 recovery authority must be installed first'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- v9 observes clock_timestamp(), so its current classifier is intentionally
-- volatile even though its historical definition declared STABLE.
ALTER FUNCTION public.universal_v1_change_order_recovery_revocation_reason_v1(UUID)
  VOLATILE;

CREATE TABLE IF NOT EXISTS public.hxos_fake_financial_schema_evidence_v10 (
  migration_name TEXT PRIMARY KEY CHECK (
    migration_name = '20261011_universal_v1_fake_financial_expiry_recovery_v10'
  ),
  migration_sql_sha256 CHAR(64) NOT NULL CHECK (
    migration_sql_sha256 ~ '^[0-9a-f]{64}$'
  ),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

DROP TRIGGER IF EXISTS hxos_fake_financial_schema_evidence_append_only_v10
  ON public.hxos_fake_financial_schema_evidence_v10;
CREATE TRIGGER hxos_fake_financial_schema_evidence_append_only_v10
BEFORE UPDATE OR DELETE ON public.hxos_fake_financial_schema_evidence_v10
FOR EACH ROW EXECUTE FUNCTION public.hxos_reject_fake_financial_mutation_v1();

DROP TRIGGER IF EXISTS hxos_fake_financial_schema_evidence_no_truncate_v10
  ON public.hxos_fake_financial_schema_evidence_v10;
CREATE TRIGGER hxos_fake_financial_schema_evidence_no_truncate_v10
BEFORE TRUNCATE ON public.hxos_fake_financial_schema_evidence_v10
FOR EACH STATEMENT EXECUTE FUNCTION public.hxos_reject_fake_financial_mutation_v1();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint constraint_record
     WHERE constraint_record.conrelid =
             'public.hxos_fake_financial_operations_v1'::regclass
       AND constraint_record.conname =
             'hxos_fake_financial_operation_amount_runtime_safe_v10_chk'
  ) THEN
    ALTER TABLE public.hxos_fake_financial_operations_v1
      ADD CONSTRAINT hxos_fake_financial_operation_amount_runtime_safe_v10_chk
      CHECK (amount_cents IS NULL OR amount_cents <= 9007199254740991)
      NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint constraint_record
     WHERE constraint_record.conrelid =
             'public.hxos_fake_financial_operation_events_v1'::regclass
       AND constraint_record.conname =
             'hxos_fake_financial_event_amount_runtime_safe_v10_chk'
  ) THEN
    ALTER TABLE public.hxos_fake_financial_operation_events_v1
      ADD CONSTRAINT hxos_fake_financial_event_amount_runtime_safe_v10_chk
      CHECK (amount_cents IS NULL OR amount_cents <= 9007199254740991)
      NOT VALID;
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS
  public.hxos_fake_financial_legacy_expiry_noncompensable_facts_v10 (
  source_fake_operation_event_id UUID PRIMARY KEY
    REFERENCES public.hxos_fake_financial_legacy_expiry_dispositions_v9(
      fake_operation_event_id
    ) ON DELETE RESTRICT,
  source_operation_id UUID NOT NULL,
  source_operation_kind TEXT NOT NULL CHECK (
    source_operation_kind IN ('AUTHORIZE', 'SECURE', 'ADJUST')
  ),
  provider_recorded_at TIMESTAMPTZ NOT NULL,
  reason_code TEXT NOT NULL CHECK (
    reason_code IN (
      'SOURCE_AMOUNT_AND_CURRENCY_UNPROVEN',
      'SOURCE_AMOUNT_OUTSIDE_RUNTIME_RANGE'
    )
  ),
  positive_use_denied BOOLEAN NOT NULL CHECK (positive_use_denied),
  recovery_terminal BOOLEAN NOT NULL CHECK (recovery_terminal),
  recovery_retryable BOOLEAN NOT NULL CHECK (NOT recovery_retryable),
  terminalized_at TIMESTAMPTZ NOT NULL CHECK (
    terminalized_at >= provider_recorded_at
  ),
  authority_sha256 CHAR(64) NOT NULL CHECK (
    authority_sha256 ~ '^[0-9a-f]{64}$'
  )
);

CREATE OR REPLACE FUNCTION
  public.validate_fake_financial_legacy_expiry_noncompensable_v10()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  disposition public.hxos_fake_financial_legacy_expiry_dispositions_v9%ROWTYPE;
  source_event public.hxos_fake_financial_operation_events_v1%ROWTYPE;
BEGIN
  SELECT * INTO disposition
    FROM public.hxos_fake_financial_legacy_expiry_dispositions_v9 existing
   WHERE existing.fake_operation_event_id = NEW.source_fake_operation_event_id
   FOR SHARE;
  SELECT * INTO source_event
    FROM public.hxos_fake_financial_operation_events_v1 existing
   WHERE existing.event_id = NEW.source_fake_operation_event_id
   FOR SHARE;

  IF disposition.fake_operation_event_id IS NULL
     OR disposition.disposition <> 'LEGACY_EXPIRY_UNPROVEN'
     OR disposition.recovery_state <> 'COMPENSATION_REQUIRED'
     OR disposition.recovery_terminal
     OR NOT disposition.recovery_retryable
     OR source_event.event_id IS NULL
     OR source_event.state <> 'SUCCEEDED'
     OR source_event.operation_kind NOT IN ('AUTHORIZE', 'SECURE', 'ADJUST')
     OR source_event.expires_at IS NOT NULL
     OR NOT (
       (
         source_event.amount_cents IS NULL
         AND source_event.currency IS NULL
       ) OR (
         source_event.amount_cents > 9007199254740991
         AND source_event.currency IS NOT NULL
       )
     )
     OR EXISTS (
       SELECT 1
         FROM public.hxos_fake_financial_legacy_expiry_compensation_commands_v9 command
        WHERE command.source_fake_operation_event_id = source_event.event_id
     )
     OR EXISTS (
       SELECT 1
         FROM public.hxos_fake_financial_legacy_expiry_compensations_v9 compensation
        WHERE compensation.source_fake_operation_event_id = source_event.event_id
     ) THEN
    RAISE EXCEPTION 'HXUV1-FSE-V10-1: only runtime-unrepresentable raw legacy security may be terminalized as noncompensable'
      USING ERRCODE = 'P0001';
  END IF;

  NEW.source_operation_id := source_event.operation_id;
  NEW.source_operation_kind := source_event.operation_kind;
  NEW.provider_recorded_at := source_event.recorded_at;
  NEW.reason_code := CASE
    WHEN source_event.amount_cents IS NULL
      THEN 'SOURCE_AMOUNT_AND_CURRENCY_UNPROVEN'
    ELSE 'SOURCE_AMOUNT_OUTSIDE_RUNTIME_RANGE'
  END;
  NEW.positive_use_denied := TRUE;
  NEW.recovery_terminal := TRUE;
  NEW.recovery_retryable := FALSE;
  NEW.terminalized_at := pg_catalog.date_trunc(
    'milliseconds', pg_catalog.statement_timestamp()
  );
  NEW.authority_sha256 := pg_catalog.encode(
    public.digest(
      source_event.event_id::TEXT || ':' || source_event.operation_id::TEXT || ':' ||
      source_event.operation_kind || ':' || source_event.state || ':' ||
      ((extract(epoch FROM source_event.recorded_at) * 1000000)::BIGINT)::TEXT || ':' ||
      source_event.identity_sha256 || ':' || source_event.request_sha256 || ':' ||
      source_event.response_sha256 || ':' || disposition.authority_sha256 || ':' ||
      NEW.reason_code || ':true:true:false:' ||
      ((extract(epoch FROM NEW.terminalized_at) * 1000000)::BIGINT)::TEXT,
      'sha256'
    ),
    'hex'
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_fake_financial_legacy_expiry_noncompensable_v10
  ON public.hxos_fake_financial_legacy_expiry_noncompensable_facts_v10;
CREATE TRIGGER validate_fake_financial_legacy_expiry_noncompensable_v10
BEFORE INSERT
ON public.hxos_fake_financial_legacy_expiry_noncompensable_facts_v10
FOR EACH ROW
EXECUTE FUNCTION public.validate_fake_financial_legacy_expiry_noncompensable_v10();

INSERT INTO public.hxos_fake_financial_legacy_expiry_noncompensable_facts_v10 (
  source_fake_operation_event_id,
  source_operation_id,
  source_operation_kind,
  provider_recorded_at,
  reason_code,
  positive_use_denied,
  recovery_terminal,
  recovery_retryable,
  terminalized_at,
  authority_sha256
)
SELECT disposition.fake_operation_event_id,
       disposition.operation_id,
       disposition.operation_kind,
       disposition.provider_recorded_at,
       CASE
         WHEN source_event.amount_cents IS NULL
           THEN 'SOURCE_AMOUNT_AND_CURRENCY_UNPROVEN'
         ELSE 'SOURCE_AMOUNT_OUTSIDE_RUNTIME_RANGE'
       END,
       TRUE,
       TRUE,
       FALSE,
       pg_catalog.statement_timestamp(),
       pg_catalog.repeat('0', 64)
  FROM public.hxos_fake_financial_legacy_expiry_dispositions_v9 disposition
  JOIN public.hxos_fake_financial_operation_events_v1 source_event
    ON source_event.event_id = disposition.fake_operation_event_id
 WHERE disposition.recovery_state = 'COMPENSATION_REQUIRED'
   AND (
     (
       source_event.amount_cents IS NULL
       AND source_event.currency IS NULL
     ) OR (
       source_event.amount_cents > 9007199254740991
       AND source_event.currency IS NOT NULL
     )
   )
ON CONFLICT (source_fake_operation_event_id) DO NOTHING;

DROP TRIGGER IF EXISTS hxos_fake_financial_legacy_noncompensable_append_only_v10
  ON public.hxos_fake_financial_legacy_expiry_noncompensable_facts_v10;
CREATE TRIGGER hxos_fake_financial_legacy_noncompensable_append_only_v10
BEFORE UPDATE OR DELETE
ON public.hxos_fake_financial_legacy_expiry_noncompensable_facts_v10
FOR EACH ROW EXECUTE FUNCTION public.hxos_reject_fake_financial_mutation_v1();

DROP TRIGGER IF EXISTS hxos_fake_financial_legacy_noncompensable_no_truncate_v10
  ON public.hxos_fake_financial_legacy_expiry_noncompensable_facts_v10;
CREATE TRIGGER hxos_fake_financial_legacy_noncompensable_no_truncate_v10
BEFORE TRUNCATE
ON public.hxos_fake_financial_legacy_expiry_noncompensable_facts_v10
FOR EACH STATEMENT EXECUTE FUNCTION public.hxos_reject_fake_financial_mutation_v1();

CREATE OR REPLACE FUNCTION public.hxos_prepare_legacy_expiry_compensation_v10(
  checked_source_event_id UUID,
  checked_provider_request_sha256 TEXT
)
RETURNS TABLE (
  command_id UUID,
  source_fake_operation_event_id UUID,
  compensation_operation_id UUID,
  compensation_operation_kind TEXT,
  compensation_idempotency_key TEXT,
  amount_cents BIGINT,
  currency CHAR(3),
  provider_request_sha256 CHAR(64),
  idempotency_replayed BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  disposition public.hxos_fake_financial_legacy_expiry_dispositions_v9%ROWTYPE;
  source_event public.hxos_fake_financial_operation_events_v1%ROWTYPE;
  prepared public.hxos_fake_financial_legacy_expiry_compensation_commands_v9%ROWTYPE;
  expected_operation_id UUID;
  expected_idempotency_key TEXT;
  expected_request_json TEXT;
  expected_request_sha256 CHAR(64);
  inserted_count BIGINT;
BEGIN
  IF checked_source_event_id IS NULL
     OR checked_provider_request_sha256 IS NULL
     OR checked_provider_request_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'HXUV1-FSE-V10-2: legacy compensation preparation identity is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO disposition
    FROM public.hxos_fake_financial_legacy_expiry_dispositions_v9 existing
   WHERE existing.fake_operation_event_id = checked_source_event_id
   FOR UPDATE;
  SELECT * INTO source_event
    FROM public.hxos_fake_financial_operation_events_v1 existing
   WHERE existing.event_id = checked_source_event_id
   FOR SHARE;

  IF disposition.fake_operation_event_id IS NULL
     OR disposition.recovery_state <> 'COMPENSATION_REQUIRED'
     OR disposition.recovery_terminal
     OR NOT disposition.recovery_retryable
     OR source_event.event_id IS NULL
     OR source_event.amount_cents IS NULL
     OR source_event.amount_cents > 9007199254740991
     OR source_event.currency IS NULL
     OR EXISTS (
       SELECT 1
         FROM public.hxos_fake_financial_legacy_expiry_noncompensable_facts_v10 terminal
        WHERE terminal.source_fake_operation_event_id = checked_source_event_id
     ) THEN
    RAISE EXCEPTION 'HXUV1-FSE-V10-3: source is not exact valued legacy compensation authority'
      USING ERRCODE = 'P0001';
  END IF;

  expected_operation_id :=
    public.legacy_fake_expiry_compensation_operation_id_v9(checked_source_event_id);
  expected_idempotency_key :=
    'legacy-expiry-compensation:v9:' || checked_source_event_id::TEXT;
  expected_request_json :=
    '{"amountCents":' || source_event.amount_cents::TEXT ||
    ',"currency":' || pg_catalog.to_json(source_event.currency::TEXT)::TEXT ||
    ',"expectedVersion":0' ||
    ',"idempotencyKey":' || pg_catalog.to_json(expected_idempotency_key)::TEXT ||
    ',"operationId":' || pg_catalog.to_json(expected_operation_id::TEXT)::TEXT ||
    ',"relatedOperationId":' ||
      pg_catalog.to_json(source_event.operation_id::TEXT)::TEXT || '}';
  expected_request_sha256 := pg_catalog.encode(
    public.digest(expected_request_json, 'sha256'), 'hex'
  );
  IF checked_provider_request_sha256 IS DISTINCT FROM expected_request_sha256 THEN
    RAISE EXCEPTION 'HXUV1-FSE-V10-4: runtime request digest differs from database-derived provider command'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.hxos_fake_financial_legacy_expiry_compensation_commands_v9 existing
     WHERE existing.source_fake_operation_event_id = checked_source_event_id
  ) THEN
    inserted_count := 0;
  ELSE
    INSERT INTO public.hxos_fake_financial_legacy_expiry_compensation_commands_v9 (
      source_fake_operation_event_id,
      provider_request_sha256
    ) VALUES (
      checked_source_event_id,
      expected_request_sha256
    );
    inserted_count := 1;
  END IF;

  SELECT * INTO prepared
    FROM public.hxos_fake_financial_legacy_expiry_compensation_commands_v9 existing
   WHERE existing.source_fake_operation_event_id = checked_source_event_id
   FOR SHARE;
  IF prepared.command_id IS NULL
     OR prepared.compensation_operation_id IS DISTINCT FROM expected_operation_id
     OR prepared.compensation_idempotency_key IS DISTINCT FROM expected_idempotency_key
     OR prepared.provider_request_sha256 IS DISTINCT FROM expected_request_sha256
     OR prepared.amount_cents IS DISTINCT FROM source_event.amount_cents
     OR prepared.currency IS DISTINCT FROM source_event.currency THEN
    RAISE EXCEPTION 'HXUV1-FSE-V10-5: prepared legacy compensation winner conflicts'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY SELECT
    prepared.command_id,
    prepared.source_fake_operation_event_id,
    prepared.compensation_operation_id,
    prepared.compensation_operation_kind,
    prepared.compensation_idempotency_key,
    prepared.amount_cents,
    prepared.currency,
    prepared.provider_request_sha256,
    inserted_count = 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.hxos_record_legacy_expiry_compensation_attempt_v10(
  checked_command_id UUID
)
RETURNS TABLE (
  dispatch_attempt_id UUID,
  command_id UUID,
  idempotency_replayed BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  prepared public.hxos_fake_financial_legacy_expiry_compensation_commands_v9%ROWTYPE;
  attempted public.hxos_fake_financial_legacy_expiry_compensation_attempts_v9%ROWTYPE;
  inserted_count BIGINT;
BEGIN
  IF checked_command_id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FSE-V10-6: legacy compensation command identity is invalid'
      USING ERRCODE = '22023';
  END IF;
  SELECT * INTO prepared
    FROM public.hxos_fake_financial_legacy_expiry_compensation_commands_v9 existing
   WHERE existing.command_id = checked_command_id
   FOR UPDATE;
  IF prepared.command_id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FSE-V10-7: exact prepared legacy compensation is missing'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.hxos_fake_financial_legacy_expiry_compensation_attempts_v9 existing
     WHERE existing.command_id = checked_command_id
  ) THEN
    inserted_count := 0;
  ELSE
    INSERT INTO public.hxos_fake_financial_legacy_expiry_compensation_attempts_v9 (
      command_id
    ) VALUES (checked_command_id);
    inserted_count := 1;
  END IF;

  SELECT * INTO attempted
    FROM public.hxos_fake_financial_legacy_expiry_compensation_attempts_v9 existing
   WHERE existing.command_id = checked_command_id
   FOR SHARE;
  IF attempted.dispatch_attempt_id IS NULL
     OR attempted.command_id IS DISTINCT FROM checked_command_id THEN
    RAISE EXCEPTION 'HXUV1-FSE-V10-8: legacy compensation attempt winner conflicts'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY SELECT attempted.dispatch_attempt_id,
                      attempted.command_id,
                      inserted_count = 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.hxos_finalize_legacy_expiry_compensation_v10(
  checked_source_event_id UUID,
  checked_compensation_event_id UUID,
  checked_command_id UUID,
  checked_dispatch_attempt_id UUID
)
RETURNS TABLE (
  source_fake_operation_event_id UUID,
  compensation_fake_operation_event_id UUID,
  compensation_operation_id UUID,
  compensation_operation_kind TEXT,
  compensation_provider_state TEXT,
  compensation_command_id UUID,
  dispatch_attempt_id UUID,
  outcome_fact_id UUID,
  idempotency_replayed BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  disposition public.hxos_fake_financial_legacy_expiry_dispositions_v9%ROWTYPE;
  prepared public.hxos_fake_financial_legacy_expiry_compensation_commands_v9%ROWTYPE;
  attempted public.hxos_fake_financial_legacy_expiry_compensation_attempts_v9%ROWTYPE;
  observed public.hxos_fake_financial_legacy_expiry_compensation_outcomes_v9%ROWTYPE;
  receipt public.hxos_fake_financial_legacy_expiry_compensations_v9%ROWTYPE;
  inserted_count BIGINT;
BEGIN
  IF checked_source_event_id IS NULL
     OR checked_compensation_event_id IS NULL
     OR checked_command_id IS NULL
     OR checked_dispatch_attempt_id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FSE-V10-9: legacy compensation outcome identity is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO disposition
    FROM public.hxos_fake_financial_legacy_expiry_dispositions_v9 existing
   WHERE existing.fake_operation_event_id = checked_source_event_id
   FOR UPDATE;
  SELECT * INTO prepared
    FROM public.hxos_fake_financial_legacy_expiry_compensation_commands_v9 existing
   WHERE existing.command_id = checked_command_id
   FOR UPDATE;
  SELECT * INTO attempted
    FROM public.hxos_fake_financial_legacy_expiry_compensation_attempts_v9 existing
   WHERE existing.dispatch_attempt_id = checked_dispatch_attempt_id
   FOR UPDATE;

  IF disposition.fake_operation_event_id IS NULL
     OR prepared.source_fake_operation_event_id IS DISTINCT FROM checked_source_event_id
     OR attempted.command_id IS DISTINCT FROM checked_command_id THEN
    RAISE EXCEPTION 'HXUV1-FSE-V10-10: legacy compensation command chain conflicts'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO receipt
    FROM public.hxos_fake_financial_legacy_expiry_compensations_v9 existing
   WHERE existing.source_fake_operation_event_id = checked_source_event_id
   FOR SHARE;
  IF receipt.source_fake_operation_event_id IS NOT NULL THEN
    IF receipt.compensation_fake_operation_event_id IS DISTINCT FROM
         checked_compensation_event_id
       OR receipt.compensation_command_id IS DISTINCT FROM checked_command_id
       OR receipt.dispatch_attempt_id IS DISTINCT FROM checked_dispatch_attempt_id THEN
      RAISE EXCEPTION 'HXUV1-FSE-V10-11: legacy compensation replay identity conflicts'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY SELECT
      receipt.source_fake_operation_event_id,
      receipt.compensation_fake_operation_event_id,
      receipt.compensation_operation_id,
      receipt.compensation_operation_kind,
      receipt.compensation_provider_state,
      receipt.compensation_command_id,
      receipt.dispatch_attempt_id,
      receipt.outcome_fact_id,
      TRUE;
    RETURN;
  END IF;

  SELECT * INTO observed
    FROM public.hxos_fake_financial_legacy_expiry_compensation_outcomes_v9 existing
   WHERE existing.command_id = checked_command_id
   FOR UPDATE;
  IF observed.outcome_fact_id IS NULL THEN
    INSERT INTO public.hxos_fake_financial_legacy_expiry_compensation_outcomes_v9 (
      command_id,
      dispatch_attempt_id,
      compensation_fake_operation_event_id
    ) VALUES (
      checked_command_id,
      checked_dispatch_attempt_id,
      checked_compensation_event_id
    )
    RETURNING * INTO observed;
  ELSIF observed.dispatch_attempt_id IS DISTINCT FROM checked_dispatch_attempt_id
     OR observed.compensation_fake_operation_event_id IS DISTINCT FROM
       checked_compensation_event_id THEN
    RAISE EXCEPTION 'HXUV1-FSE-V10-12: legacy compensation outcome winner conflicts'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.hxos_fake_financial_legacy_expiry_compensations_v9 (
    source_fake_operation_event_id,
    compensation_fake_operation_event_id,
    compensation_command_id,
    dispatch_attempt_id,
    outcome_fact_id
  ) VALUES (
    checked_source_event_id,
    checked_compensation_event_id,
    checked_command_id,
    checked_dispatch_attempt_id,
    observed.outcome_fact_id
  );
  inserted_count := 1;

  SELECT * INTO receipt
    FROM public.hxos_fake_financial_legacy_expiry_compensations_v9 existing
   WHERE existing.source_fake_operation_event_id = checked_source_event_id
   FOR SHARE;
  IF receipt.source_fake_operation_event_id IS NULL
     OR receipt.compensation_fake_operation_event_id IS DISTINCT FROM
       checked_compensation_event_id
     OR receipt.compensation_command_id IS DISTINCT FROM checked_command_id
     OR receipt.dispatch_attempt_id IS DISTINCT FROM checked_dispatch_attempt_id
     OR receipt.outcome_fact_id IS DISTINCT FROM observed.outcome_fact_id THEN
    RAISE EXCEPTION 'HXUV1-FSE-V10-13: legacy compensation closure winner conflicts'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY SELECT
    receipt.source_fake_operation_event_id,
    receipt.compensation_fake_operation_event_id,
    receipt.compensation_operation_id,
    receipt.compensation_operation_kind,
    receipt.compensation_provider_state,
    receipt.compensation_command_id,
    receipt.dispatch_attempt_id,
    receipt.outcome_fact_id,
    inserted_count = 0;
END;
$$;

CREATE OR REPLACE FUNCTION
  public.require_legacy_expiry_terminal_before_outcome_v10()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT NEW.retryable
     AND EXISTS (
       SELECT 1
         FROM public.financial_provider_command_journal command
         JOIN public.hxos_fake_financial_operation_events_v1 raw
           ON raw.idempotency_key = command.idempotency_key
         JOIN public.hxos_fake_financial_legacy_expiry_dispositions_v9 disposition
           ON disposition.fake_operation_event_id = raw.event_id
        WHERE command.command_id = NEW.command_id
          AND disposition.recovery_state = 'COMPENSATION_REQUIRED'
          AND (
            NEW.outcome_kind = 'FAILED'
            OR (
              NEW.outcome_kind = 'OUTCOME_OBSERVED'
              AND NOT EXISTS (
                SELECT 1
                  FROM public.hxos_fake_financial_legacy_expiry_compensations_v9 compensation
                 WHERE compensation.source_fake_operation_event_id = raw.event_id
              )
              AND NOT EXISTS (
                SELECT 1
                  FROM public.hxos_fake_financial_legacy_expiry_noncompensable_facts_v10 terminal
                 WHERE terminal.source_fake_operation_event_id = raw.event_id
              )
            )
          )
     ) THEN
    RAISE EXCEPTION 'HXUV1-FSE-V10-14: raw-only legacy success requires exact terminal recovery evidence'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_require_legacy_expiry_compensation_v9
  ON public.financial_provider_command_outcome_facts;
DROP TRIGGER IF EXISTS zz_require_legacy_expiry_terminal_v10
  ON public.financial_provider_command_outcome_facts;
CREATE TRIGGER zz_require_legacy_expiry_terminal_v10
BEFORE INSERT ON public.financial_provider_command_outcome_facts
FOR EACH ROW
EXECUTE FUNCTION public.require_legacy_expiry_terminal_before_outcome_v10();

COMMENT ON TABLE
  public.hxos_fake_financial_legacy_expiry_noncompensable_facts_v10 IS
  'Append-only terminal denial for a raw pre-v9 fake security success whose value is absent or cannot be represented safely by the runtime. It grants no positive-use authority and causes no provider effect.';
COMMENT ON FUNCTION public.hxos_prepare_legacy_expiry_compensation_v10(UUID, TEXT) IS
  'Sealed nonproduction command that independently derives and prepares one exact legacy fake compensation request.';
COMMENT ON FUNCTION public.hxos_record_legacy_expiry_compensation_attempt_v10(UUID) IS
  'Sealed nonproduction command that records exactly one dispatch-attempt boundary for a prepared legacy fake compensation.';
COMMENT ON FUNCTION public.hxos_finalize_legacy_expiry_compensation_v10(
  UUID, UUID, UUID, UUID
) IS
  'Sealed nonproduction command that atomically records the exact provider outcome and terminal legacy fake compensation receipt.';

REVOKE ALL ON TABLE public.hxos_fake_financial_schema_evidence_v10 FROM PUBLIC;
REVOKE ALL ON TABLE
  public.hxos_fake_financial_legacy_expiry_noncompensable_facts_v10
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.validate_fake_financial_legacy_expiry_noncompensable_v10()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.hxos_prepare_legacy_expiry_compensation_v10(UUID, TEXT)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.hxos_record_legacy_expiry_compensation_attempt_v10(UUID)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.hxos_finalize_legacy_expiry_compensation_v10(UUID, UUID, UUID, UUID)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.require_legacy_expiry_terminal_before_outcome_v10()
  FROM PUBLIC;
