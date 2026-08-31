-- Provider-neutral financial observation normalization v1.
--
-- Authenticated provider bytes are evidence, never commands. This migration
-- can only correlate an immutable inbox observation with an already committed
-- provider command and DISPATCH_ATTEMPTED fact. Nonterminal and UNKNOWN facts
-- are reserved for follow-up. A terminal fact is merely corroborated against
-- the exact existing provider outcome; this contract performs no provider I/O,
-- creates no lifecycle success, and grants no payment or production capability.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF to_regclass('public.provider_event_inbox_observations') IS NULL
     OR to_regclass('public.provider_event_inbox_receipts') IS NULL
     OR to_regclass('public.provider_event_processing_outcomes') IS NULL
     OR to_regclass('public.financial_provider_command_journal') IS NULL
     OR to_regclass('public.financial_provider_command_dispatch_attempts') IS NULL
     OR to_regclass('public.financial_provider_command_outcome_facts') IS NULL THEN
    RAISE EXCEPTION 'HXFON1: provider inbox and committed command authority must be installed first'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- A successfully normalized UNKNOWN observation must remain distinguishable
-- from provider PENDING. Processing success means only that normalization was
-- durable; it does not mean the observed financial operation succeeded.
ALTER TABLE public.provider_event_processing_outcomes
  DROP CONSTRAINT IF EXISTS provider_event_processing_outcomes_normalized_state_check;
ALTER TABLE public.provider_event_processing_outcomes
  DROP CONSTRAINT IF EXISTS provider_event_processing_normalized_state_v2_chk;
ALTER TABLE public.provider_event_processing_outcomes
  ADD CONSTRAINT provider_event_processing_normalized_state_v2_chk CHECK (
    normalized_state IS NULL OR normalized_state IN (
      'UNKNOWN', 'PENDING', 'SUCCEEDED', 'DECLINED', 'FAILED',
      'RETRYABLE_FAILURE', 'VOIDED', 'REFUNDED', 'PARTIALLY_REFUNDED',
      'REVERSED', 'ACCEPTED', 'REJECTED', 'MATCHED', 'MISMATCH'
    )
  );

CREATE TABLE IF NOT EXISTS public.provider_financial_observation_normalizations (
  normalization_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id UUID NOT NULL UNIQUE
    REFERENCES public.provider_event_inbox_observations(observation_id) ON DELETE RESTRICT,
  command_id UUID NOT NULL
    REFERENCES public.financial_provider_command_journal(command_id) ON DELETE RESTRICT,
  dispatch_attempt_id UUID NOT NULL
    REFERENCES public.financial_provider_command_dispatch_attempts(dispatch_attempt_id)
    ON DELETE RESTRICT,
  outcome_fact_id UUID
    REFERENCES public.financial_provider_command_outcome_facts(outcome_fact_id)
    ON DELETE RESTRICT,
  provider_kind TEXT NOT NULL CHECK (
    provider_kind ~ '^[A-Z][A-Z0-9_]{1,63}$'
  ),
  operation_id UUID NOT NULL,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN (
    'PREPARE_PAYMENT_METHOD', 'AUTHORIZE', 'SECURE', 'VOID', 'ADJUST',
    'CAPTURE', 'REFUND', 'REVERSAL', 'SETTLE', 'FUND',
    'PROVIDER_RELEASE', 'PAYOUT', 'OBSERVE_BANK_SETTLEMENT'
  )),
  predecessor_provider_version BIGINT NOT NULL CHECK (
    predecessor_provider_version BETWEEN 0 AND 9007199254740990
  ),
  observed_provider_version BIGINT NOT NULL CHECK (
    observed_provider_version BETWEEN 1 AND 9007199254740991
    AND observed_provider_version = predecessor_provider_version + 1
  ),
  observed_state TEXT NOT NULL CHECK (observed_state IN (
    'UNKNOWN', 'PENDING', 'RETRYABLE_FAILURE', 'SUCCEEDED', 'DECLINED',
    'FAILED', 'VOIDED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'REVERSED'
  )),
  external_reference_sha256 CHAR(64) NOT NULL CHECK (
    external_reference_sha256 ~ '^[0-9a-f]{64}$'
  ),
  amount_cents BIGINT CHECK (
    amount_cents IS NULL OR amount_cents BETWEEN 1 AND 9007199254740991
  ),
  currency CHAR(3) CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  provider_occurred_at TIMESTAMPTZ NOT NULL,
  materialization_state TEXT NOT NULL CHECK (
    materialization_state IN ('RESERVED', 'TERMINAL_CORROBORATED')
  ),
  normalized_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  followup_due_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  CONSTRAINT provider_financial_observation_value_shape_chk CHECK (
    (amount_cents IS NULL) = (currency IS NULL)
    AND (
      (operation_kind = 'PREPARE_PAYMENT_METHOD' AND amount_cents IS NULL)
      OR (operation_kind <> 'PREPARE_PAYMENT_METHOD' AND amount_cents IS NOT NULL)
    )
  ),
  CONSTRAINT provider_financial_observation_materialization_bundle_chk CHECK (
    (
      materialization_state = 'RESERVED'
      AND outcome_fact_id IS NULL
      AND observed_state IN ('UNKNOWN', 'PENDING', 'RETRYABLE_FAILURE')
      AND followup_due_at = normalized_at + INTERVAL '15 minutes'
      AND expires_at = normalized_at + INTERVAL '24 hours'
    )
    OR (
      materialization_state = 'TERMINAL_CORROBORATED'
      AND outcome_fact_id IS NOT NULL
      AND observed_state NOT IN ('UNKNOWN', 'PENDING', 'RETRYABLE_FAILURE')
      AND followup_due_at IS NULL
      AND expires_at IS NULL
    )
  )
);

-- Keep exact local/staging replays safe while this append-only migration is
-- under candidate construction. These ALTERs converge databases that already
-- evaluated the earlier value-bearing-only draft without rewriting evidence.
ALTER TABLE public.provider_financial_observation_normalizations
  ALTER COLUMN amount_cents DROP NOT NULL,
  ALTER COLUMN currency DROP NOT NULL;
ALTER TABLE public.provider_financial_observation_normalizations
  DROP CONSTRAINT IF EXISTS provider_financial_observation_normalizati_operation_kind_check,
  DROP CONSTRAINT IF EXISTS provider_financial_observation_operation_kind_v2_chk,
  DROP CONSTRAINT IF EXISTS provider_financial_observation_normalization_amount_cents_check,
  DROP CONSTRAINT IF EXISTS provider_financial_observation_amount_v2_chk,
  DROP CONSTRAINT IF EXISTS provider_financial_observation_currency_v2_chk,
  DROP CONSTRAINT IF EXISTS provider_financial_observation_value_shape_chk;
ALTER TABLE public.provider_financial_observation_normalizations
  ADD CONSTRAINT provider_financial_observation_operation_kind_v2_chk CHECK (
    operation_kind IN (
      'PREPARE_PAYMENT_METHOD', 'AUTHORIZE', 'SECURE', 'VOID', 'ADJUST',
      'CAPTURE', 'REFUND', 'REVERSAL', 'SETTLE', 'FUND',
      'PROVIDER_RELEASE', 'PAYOUT', 'OBSERVE_BANK_SETTLEMENT'
    )
  ),
  ADD CONSTRAINT provider_financial_observation_amount_v2_chk CHECK (
    amount_cents IS NULL OR amount_cents BETWEEN 1 AND 9007199254740991
  ),
  ADD CONSTRAINT provider_financial_observation_currency_v2_chk CHECK (
    currency IS NULL OR currency ~ '^[A-Z]{3}$'
  ),
  ADD CONSTRAINT provider_financial_observation_value_shape_chk CHECK (
    (amount_cents IS NULL) = (currency IS NULL)
    AND (
      (operation_kind = 'PREPARE_PAYMENT_METHOD' AND amount_cents IS NULL)
      OR (operation_kind <> 'PREPARE_PAYMENT_METHOD' AND amount_cents IS NOT NULL)
    )
  );

CREATE INDEX IF NOT EXISTS provider_financial_observation_operation_idx
  ON public.provider_financial_observation_normalizations(
    provider_kind, operation_id, observed_provider_version, normalized_at
  );
CREATE INDEX IF NOT EXISTS provider_financial_observation_backlog_idx
  ON public.provider_financial_observation_normalizations(expires_at, followup_due_at)
  WHERE materialization_state = 'RESERVED';

CREATE OR REPLACE FUNCTION public.validate_financial_provider_observation_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  inbox_record public.provider_event_inbox_observations%ROWTYPE;
  command_record public.financial_provider_command_journal%ROWTYPE;
  dispatch_record public.financial_provider_command_dispatch_attempts%ROWTYPE;
  outcome_record public.financial_provider_command_outcome_facts%ROWTYPE;
  payload JSONB;
  payload_field_count INTEGER;
  terminal_observation BOOLEAN;
  reference_sha256 CHAR(64);
  expected_provider_result_sha256 CHAR(64);
  authority_now TIMESTAMPTZ;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('provider-financial-observation:' || NEW.observation_id::TEXT, 0)
  );
  authority_now := clock_timestamp();

  SELECT * INTO inbox_record
    FROM public.provider_event_inbox_observations observation
   WHERE observation.observation_id = NEW.observation_id
   FOR SHARE;
  IF inbox_record.observation_id IS NULL
     OR inbox_record.provider_event_kind <> 'FINANCIAL_OPERATION_OBSERVED'
     OR NOT EXISTS (
       SELECT 1 FROM public.provider_event_inbox_receipts receipt
        WHERE receipt.observation_id = NEW.observation_id
          AND receipt.authentication_status = 'VERIFIED'
     ) THEN
    RAISE EXCEPTION 'HXFON1: exact authenticated provider observation is required'
      USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    payload := convert_from(inbox_record.raw_payload, 'UTF8')::JSONB;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'HXFON1: raw provider observation is not valid UTF-8 JSON'
      USING ERRCODE = 'P0001';
  END;
  IF jsonb_typeof(payload) <> 'object' THEN
    RAISE EXCEPTION 'HXFON1: provider observation envelope must be an object'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT count(*) INTO payload_field_count FROM jsonb_object_keys(payload);
  IF payload_field_count <> 13
     OR NOT payload ?& ARRAY[
       'version', 'kind', 'providerKind', 'providerEventReference',
       'operationId', 'operationKind', 'predecessorProviderVersion',
       'observedProviderVersion', 'observedState', 'externalReference',
       'amountCents', 'currency', 'providerOccurredAt'
     ]
     OR payload->>'version' <> 'HX_SYNTHETIC_FINANCIAL_OBSERVATION_V1'
     OR payload->>'kind' <> 'FINANCIAL_OPERATION_OBSERVED'
     OR payload->>'providerKind' <> inbox_record.provider_kind
     OR payload->>'providerEventReference' <> inbox_record.provider_event_reference
     OR lower(payload->>'operationId') <> inbox_record.operation_id::TEXT
     OR payload->>'providerKind' <> NEW.provider_kind
     OR lower(payload->>'operationId') <> NEW.operation_id::TEXT
     OR payload->>'operationKind' <> NEW.operation_kind
     OR payload->'predecessorProviderVersion' <> to_jsonb(NEW.predecessor_provider_version)
     OR payload->'observedProviderVersion' <> to_jsonb(NEW.observed_provider_version)
     OR payload->>'observedState' <> NEW.observed_state
     OR encode(digest(convert_to(payload->>'externalReference', 'UTF8'), 'sha256'), 'hex')
        <> NEW.external_reference_sha256
     OR payload->'amountCents' IS DISTINCT FROM COALESCE(to_jsonb(NEW.amount_cents), 'null'::JSONB)
     OR payload->>'currency' IS DISTINCT FROM NEW.currency
     OR (payload->>'providerOccurredAt')::TIMESTAMPTZ <> NEW.provider_occurred_at THEN
    RAISE EXCEPTION 'HXFON1: stored observation differs from its exact raw envelope'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.provider_kind <> 'FAKE' THEN
    RAISE EXCEPTION 'HXFON1: this synthetic observation contract is fake-provider only'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.observed_provider_version <> NEW.predecessor_provider_version + 1 THEN
    RAISE EXCEPTION 'HXFON1: observed provider version is not causally contiguous'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO command_record
    FROM public.financial_provider_command_journal command
   WHERE command.provider_kind = NEW.provider_kind
     AND command.operation_id = NEW.operation_id
     AND command.operation_kind = NEW.operation_kind
     AND command.provider_expected_version = NEW.predecessor_provider_version
   FOR SHARE;
  IF command_record.command_id IS NULL
     OR command_record.prepared_financial_command_id IS NULL
     OR command_record.prepared_authority_sha256 IS NULL
     OR command_record.amount_cents IS DISTINCT FROM NEW.amount_cents
     OR command_record.currency IS DISTINCT FROM NEW.currency THEN
    RAISE EXCEPTION 'HXFON1: observation lacks its exact committed prepared command authority'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO dispatch_record
    FROM public.financial_provider_command_dispatch_attempts attempt
   WHERE attempt.command_id = command_record.command_id
   ORDER BY attempt.attempt_number DESC
   LIMIT 1
   FOR SHARE;
  IF dispatch_record.dispatch_attempt_id IS NULL THEN
    RAISE EXCEPTION 'HXFON1: observation precedes DISPATCH_ATTEMPTED authority'
      USING ERRCODE = 'P0001';
  END IF;
  -- Provider clocks may legitimately be a few minutes behind HustleXP, but
  -- HustleXP receipt order is authoritative. Evidence first received before
  -- the latest dispatch cannot be made causal by a later replay or receipt.
  IF inbox_record.first_received_at < dispatch_record.attempted_at
     OR NOT EXISTS (
       SELECT 1 FROM public.provider_event_inbox_receipts receipt
        WHERE receipt.observation_id = NEW.observation_id
          AND receipt.authentication_status = 'VERIFIED'
          AND receipt.received_at >= dispatch_record.attempted_at
     ) THEN
    RAISE EXCEPTION 'HXFON1: authenticated observation receipt precedes DISPATCH_ATTEMPTED authority'
      USING ERRCODE = 'P0001';
  END IF;
  -- This is provider-clock tolerance only; it does not relax receipt order.
  IF NEW.provider_occurred_at < dispatch_record.attempted_at - INTERVAL '5 minutes'
     OR NEW.provider_occurred_at > authority_now + INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'HXFON1: provider occurrence time is outside its causal window'
      USING ERRCODE = 'P0001';
  END IF;

  terminal_observation := NEW.observed_state NOT IN (
    'UNKNOWN', 'PENDING', 'RETRYABLE_FAILURE'
  );
  IF (
    NEW.operation_kind IN (
      'PREPARE_PAYMENT_METHOD', 'AUTHORIZE', 'SECURE', 'ADJUST', 'CAPTURE', 'SETTLE', 'FUND',
      'PROVIDER_RELEASE', 'PAYOUT', 'OBSERVE_BANK_SETTLEMENT'
    )
    AND NEW.observed_state NOT IN (
      'UNKNOWN', 'PENDING', 'RETRYABLE_FAILURE', 'SUCCEEDED', 'DECLINED', 'FAILED'
    )
  ) OR (
    NEW.operation_kind = 'VOID'
    AND NEW.observed_state NOT IN (
      'UNKNOWN', 'PENDING', 'RETRYABLE_FAILURE', 'VOIDED', 'DECLINED', 'FAILED'
    )
  ) OR (
    NEW.operation_kind = 'REFUND'
    AND NEW.observed_state NOT IN (
      'UNKNOWN', 'PENDING', 'RETRYABLE_FAILURE', 'REFUNDED',
      'PARTIALLY_REFUNDED', 'DECLINED', 'FAILED'
    )
  ) OR (
    NEW.operation_kind = 'REVERSAL'
    AND NEW.observed_state NOT IN (
      'UNKNOWN', 'PENDING', 'RETRYABLE_FAILURE', 'REVERSED', 'DECLINED', 'FAILED'
    )
  ) THEN
    RAISE EXCEPTION 'HXFON1: observed state is invalid for the committed operation kind'
      USING ERRCODE = 'P0001';
  END IF;

  NEW.command_id := command_record.command_id;
  NEW.dispatch_attempt_id := dispatch_record.dispatch_attempt_id;
  NEW.normalized_at := authority_now;
  IF terminal_observation THEN
    reference_sha256 := NEW.external_reference_sha256;
    expected_provider_result_sha256 := encode(digest(convert_to(
      NEW.operation_id::TEXT || ':' ||
      NEW.operation_kind || ':' ||
      NEW.provider_kind || ':' ||
      NEW.observed_state || ':' ||
      NEW.observed_provider_version::TEXT || ':' ||
      COALESCE(NEW.amount_cents::TEXT, '') || ':' ||
      COALESCE(NEW.currency, '') || ':' ||
      reference_sha256 || ':false',
      'UTF8'
    ), 'sha256'), 'hex');
    SELECT * INTO outcome_record
      FROM public.financial_provider_command_outcome_facts outcome
     WHERE outcome.command_id = command_record.command_id
       AND outcome.dispatch_attempt_id = dispatch_record.dispatch_attempt_id
       AND outcome.outcome_kind = 'OUTCOME_OBSERVED'
       AND outcome.retryable = FALSE
       AND outcome.provider_state = NEW.observed_state
       AND outcome.provider_result_version = NEW.observed_provider_version
       AND outcome.amount_cents IS NOT DISTINCT FROM NEW.amount_cents
       AND outcome.currency IS NOT DISTINCT FROM NEW.currency
       AND outcome.external_reference_sha256 = reference_sha256
       AND outcome.provider_result_sha256 = expected_provider_result_sha256
     ORDER BY outcome.recorded_at DESC, outcome.outcome_fact_id DESC
     LIMIT 1
     FOR SHARE;
    IF outcome_record.outcome_fact_id IS NULL THEN
      RAISE EXCEPTION 'HXFON1: terminal observation lacks exact committed outcome authority'
        USING ERRCODE = 'P0001';
    END IF;
    NEW.outcome_fact_id := outcome_record.outcome_fact_id;
    NEW.materialization_state := 'TERMINAL_CORROBORATED';
    NEW.followup_due_at := NULL;
    NEW.expires_at := NULL;
  ELSE
    NEW.outcome_fact_id := NULL;
    NEW.materialization_state := 'RESERVED';
    NEW.followup_due_at := authority_now + INTERVAL '15 minutes';
    NEW.expires_at := authority_now + INTERVAL '24 hours';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS provider_financial_observation_validate
  ON public.provider_financial_observation_normalizations;
CREATE TRIGGER provider_financial_observation_validate
BEFORE INSERT ON public.provider_financial_observation_normalizations
FOR EACH ROW EXECUTE FUNCTION public.validate_financial_provider_observation_v1();

CREATE OR REPLACE FUNCTION public.reject_financial_provider_observation_mutation_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'HXFON1: normalized provider observation evidence is append-only'
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS provider_financial_observation_no_update_delete
  ON public.provider_financial_observation_normalizations;
CREATE TRIGGER provider_financial_observation_no_update_delete
BEFORE UPDATE OR DELETE ON public.provider_financial_observation_normalizations
FOR EACH ROW EXECUTE FUNCTION public.reject_financial_provider_observation_mutation_v1();
DROP TRIGGER IF EXISTS provider_financial_observation_no_truncate
  ON public.provider_financial_observation_normalizations;
CREATE TRIGGER provider_financial_observation_no_truncate
BEFORE TRUNCATE ON public.provider_financial_observation_normalizations
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_financial_provider_observation_mutation_v1();

CREATE OR REPLACE FUNCTION public.normalize_financial_provider_observation_v1(
  requested_observation_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  payload JSONB;
  normalized_id UUID;
  inserted_count INTEGER;
BEGIN
  SELECT convert_from(observation.raw_payload, 'UTF8')::JSONB
    INTO payload
    FROM public.provider_event_inbox_observations observation
   WHERE observation.observation_id = requested_observation_id;
  IF payload IS NULL THEN
    RAISE EXCEPTION 'HXFON1: provider observation does not exist'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.provider_financial_observation_normalizations (
    observation_id, command_id, dispatch_attempt_id, outcome_fact_id,
    provider_kind, operation_id, operation_kind,
    predecessor_provider_version, observed_provider_version, observed_state,
    external_reference_sha256, amount_cents, currency, provider_occurred_at,
    materialization_state
  ) VALUES (
    requested_observation_id, gen_random_uuid(), gen_random_uuid(), NULL,
    payload->>'providerKind', (payload->>'operationId')::UUID,
    payload->>'operationKind', (payload->>'predecessorProviderVersion')::BIGINT,
    (payload->>'observedProviderVersion')::BIGINT, payload->>'observedState',
    encode(digest(convert_to(payload->>'externalReference', 'UTF8'), 'sha256'), 'hex'),
    (payload->>'amountCents')::BIGINT, payload->>'currency',
    (payload->>'providerOccurredAt')::TIMESTAMPTZ, 'RESERVED'
  )
  ON CONFLICT (observation_id) DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;

  SELECT normalization.normalization_id INTO normalized_id
    FROM public.provider_financial_observation_normalizations normalization
   WHERE normalization.observation_id = requested_observation_id;
  IF normalized_id IS NULL THEN
    RAISE EXCEPTION 'HXFON1: provider observation normalization was not durable'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_build_object(
    'normalizationId', normalized_id,
    'idempotencyReplayed', inserted_count = 0
  );
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range
  OR not_null_violation OR check_violation THEN
  RAISE EXCEPTION 'HXFON1: provider observation envelope is invalid'
    USING ERRCODE = 'P0001';
END;
$$;

CREATE OR REPLACE VIEW public.provider_financial_observation_backlog_v1
WITH (security_barrier = true)
AS
SELECT
  count(*)::BIGINT AS reserved_count,
  count(*) FILTER (WHERE followup_due_at <= clock_timestamp())::BIGINT
    AS followup_due_count,
  count(*) FILTER (WHERE expires_at <= clock_timestamp())::BIGINT
    AS expired_count,
  min(provider_occurred_at) AS oldest_provider_occurred_at,
  min(normalized_at) AS oldest_normalized_at
FROM public.provider_financial_observation_normalizations
WHERE materialization_state = 'RESERVED';

COMMENT ON TABLE public.provider_financial_observation_normalizations IS
  'Append-only provider-neutral correlation facts derived from authenticated raw inbox bytes. RESERVED is not lifecycle success; TERMINAL_CORROBORATED requires the exact existing command, dispatch, and outcome.';
COMMENT ON VIEW public.provider_financial_observation_backlog_v1 IS
  'Read-only truthful counts for due and expired nonterminal/UNKNOWN provider observations. Expiry never invents a financial result.';
COMMENT ON FUNCTION public.normalize_financial_provider_observation_v1(UUID) IS
  'Normalizes one authenticated raw observation without provider I/O. It never dispatches value or inserts lifecycle success.';

REVOKE ALL ON TABLE public.provider_financial_observation_normalizations FROM PUBLIC;
REVOKE ALL ON TABLE public.provider_financial_observation_backlog_v1 FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_financial_provider_observation_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_financial_provider_observation_mutation_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.normalize_financial_provider_observation_v1(UUID) FROM PUBLIC;

GRANT SELECT ON TABLE public.provider_financial_observation_normalizations TO CURRENT_USER;
GRANT SELECT ON TABLE public.provider_financial_observation_backlog_v1 TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.normalize_financial_provider_observation_v1(UUID) TO CURRENT_USER;
