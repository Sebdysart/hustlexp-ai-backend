-- Financial provider command dispatch and recovery facts v1.
--
-- REQUESTED remains authoritative in financial_provider_command_journal. This
-- migration adds immutable lease, DISPATCH_ATTEMPTED, and provider-outcome
-- facts. A committed dispatch attempt is the crash boundary. Background
-- recovery only reconciles commands that already have that fact; it never
-- promotes an orphan REQUESTED fact into a provider dispatch. A later dispatch
-- after confirmed no-effect evidence remains an explicit foreground decision.
--
-- These tables grant no provider, payment, deployment, scheduling, or
-- production capability. Recovery leases are deliberately limited to FAKE
-- commands. There is no APPROVED_PROVIDER recovery path in this schema.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.financial_provider_command_recovery_leases (
  recovery_lease_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id UUID NOT NULL REFERENCES public.financial_provider_command_journal(command_id),
  recovery_action TEXT NOT NULL CHECK (recovery_action IN ('DISPATCH', 'RECONCILE')),
  lease_owner_id UUID NOT NULL,
  lease_duration_seconds INTEGER NOT NULL CHECK (
    lease_duration_seconds BETWEEN 1 AND 900
  ),
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  lease_identity_sha256 CHAR(64) GENERATED ALWAYS AS (
    encode(
      digest(
        command_id::TEXT || ':' || recovery_lease_id::TEXT || ':' ||
        recovery_action || ':' || lease_owner_id::TEXT || ':' ||
        lease_duration_seconds::TEXT,
        'sha256'
      ),
      'hex'
    )
  ) STORED,
  CONSTRAINT financial_provider_command_recovery_lease_window_chk CHECK (
    expires_at = acquired_at + make_interval(secs => lease_duration_seconds)
  ),
  CONSTRAINT financial_provider_command_recovery_lease_command_uniq
    UNIQUE (command_id, recovery_lease_id)
);

CREATE TABLE IF NOT EXISTS public.financial_provider_command_dispatch_attempts (
  dispatch_attempt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id UUID NOT NULL,
  recovery_lease_id UUID NOT NULL,
  attempt_number BIGINT NOT NULL CHECK (
    attempt_number BETWEEN 1 AND 9007199254740991
  ),
  request_sha256 CHAR(64) NOT NULL CHECK (
    request_sha256 ~ '^[0-9a-f]{64}$'
  ),
  outcome_timeout_seconds INTEGER NOT NULL CHECK (
    outcome_timeout_seconds BETWEEN 0 AND 900
  ),
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  outcome_deadline_at TIMESTAMPTZ NOT NULL,
  attempt_identity_sha256 CHAR(64) GENERATED ALWAYS AS (
    encode(
      digest(
        command_id::TEXT || ':' || dispatch_attempt_id::TEXT || ':' ||
        recovery_lease_id::TEXT || ':' || attempt_number::TEXT || ':' ||
        request_sha256 || ':' || outcome_timeout_seconds::TEXT,
        'sha256'
      ),
      'hex'
    )
  ) STORED,
  CONSTRAINT financial_provider_command_dispatch_attempt_window_chk CHECK (
    outcome_deadline_at = attempted_at + make_interval(secs => outcome_timeout_seconds)
  ),
  CONSTRAINT financial_provider_command_dispatch_attempt_command_lease_fk
    FOREIGN KEY (command_id, recovery_lease_id)
    REFERENCES public.financial_provider_command_recovery_leases(command_id, recovery_lease_id),
  CONSTRAINT financial_provider_command_dispatch_attempt_command_number_uniq
    UNIQUE (command_id, attempt_number),
  CONSTRAINT financial_provider_command_dispatch_attempt_lease_uniq
    UNIQUE (recovery_lease_id),
  CONSTRAINT financial_provider_command_dispatch_attempt_command_id_uniq
    UNIQUE (command_id, dispatch_attempt_id)
);

CREATE TABLE IF NOT EXISTS public.financial_provider_command_outcome_facts (
  outcome_fact_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id UUID NOT NULL,
  dispatch_attempt_id UUID NOT NULL,
  recovery_lease_id UUID NOT NULL,
  outcome_kind TEXT NOT NULL CHECK (
    outcome_kind IN ('OUTCOME_OBSERVED', 'OUTCOME_UNKNOWN', 'FAILED')
  ),
  observation_idempotency_key TEXT NOT NULL CHECK (
    observation_idempotency_key ~ '^[A-Za-z0-9:_-]{16,128}$'
  ),
  provider_result_sha256 CHAR(64) CHECK (
    provider_result_sha256 IS NULL
    OR provider_result_sha256 ~ '^[0-9a-f]{64}$'
  ),
  provider_state TEXT CHECK (
    provider_state IS NULL
    OR provider_state IN (
      'PENDING', 'SUCCEEDED', 'DECLINED', 'FAILED', 'RETRYABLE_FAILURE',
      'VOIDED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'REVERSED', 'ACCEPTED',
      'REJECTED', 'MATCHED', 'MISMATCH'
    )
  ),
  provider_result_version BIGINT CHECK (
    provider_result_version IS NULL
    OR provider_result_version BETWEEN 0 AND 9007199254740991
  ),
  amount_cents BIGINT CHECK (
    amount_cents IS NULL OR amount_cents BETWEEN 0 AND 9007199254740991
  ),
  currency CHAR(3) CHECK (
    currency IS NULL OR currency ~ '^[A-Z]{3}$'
  ),
  external_reference_sha256 CHAR(64) CHECK (
    external_reference_sha256 IS NULL
    OR external_reference_sha256 ~ '^[0-9a-f]{64}$'
  ),
  effect_certainty TEXT NOT NULL CHECK (
    effect_certainty IN ('CONFIRMED_EFFECT', 'CONFIRMED_NO_EFFECT', 'UNKNOWN')
  ),
  retryable BOOLEAN NOT NULL DEFAULT FALSE,
  failure_code TEXT CHECK (
    failure_code IS NULL
    OR failure_code ~ '^[A-Z][A-Z0-9_.:-]{2,63}$'
  ),
  recovery_delay_seconds INTEGER CHECK (
    recovery_delay_seconds IS NULL
    OR recovery_delay_seconds BETWEEN 1 AND 86400
  ),
  recovery_not_before TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  outcome_identity_sha256 CHAR(64) GENERATED ALWAYS AS (
    encode(
      digest(
        command_id::TEXT || ':' || dispatch_attempt_id::TEXT || ':' ||
        recovery_lease_id::TEXT || ':' || outcome_kind || ':' ||
        observation_idempotency_key || ':' ||
        COALESCE(provider_result_sha256, '') || ':' ||
        COALESCE(provider_state, '') || ':' ||
        COALESCE(provider_result_version::TEXT, '') || ':' ||
        effect_certainty || ':' || retryable::TEXT || ':' ||
        COALESCE(failure_code, '') || ':' ||
        COALESCE(recovery_delay_seconds::TEXT, ''),
        'sha256'
      ),
      'hex'
    )
  ) STORED,
  CONSTRAINT financial_provider_command_outcome_attempt_fk
    FOREIGN KEY (command_id, dispatch_attempt_id)
    REFERENCES public.financial_provider_command_dispatch_attempts(command_id, dispatch_attempt_id),
  CONSTRAINT financial_provider_command_outcome_lease_fk
    FOREIGN KEY (command_id, recovery_lease_id)
    REFERENCES public.financial_provider_command_recovery_leases(command_id, recovery_lease_id),
  CONSTRAINT financial_provider_command_outcome_idempotency_uniq
    UNIQUE (observation_idempotency_key),
  CONSTRAINT financial_provider_command_outcome_bundle_chk CHECK (
    (
      outcome_kind = 'OUTCOME_OBSERVED'
      AND provider_result_sha256 IS NOT NULL
      AND provider_state IS NOT NULL
      AND provider_result_version IS NOT NULL
      AND external_reference_sha256 IS NOT NULL
      AND failure_code IS NULL
      AND (amount_cents IS NULL) = (currency IS NULL)
      AND (
        (
          provider_state IN ('PENDING', 'RETRYABLE_FAILURE')
          AND effect_certainty = 'UNKNOWN'
          AND retryable = TRUE
          AND recovery_delay_seconds IS NOT NULL
          AND recovery_not_before IS NOT NULL
        )
        OR (
          provider_state NOT IN ('PENDING', 'RETRYABLE_FAILURE')
          AND effect_certainty IN ('CONFIRMED_EFFECT', 'CONFIRMED_NO_EFFECT')
          AND retryable = FALSE
          AND recovery_delay_seconds IS NULL
          AND recovery_not_before IS NULL
        )
      )
    )
    OR (
      outcome_kind = 'OUTCOME_UNKNOWN'
      AND provider_result_sha256 IS NULL
      AND provider_state IS NULL
      AND provider_result_version IS NULL
      AND amount_cents IS NULL
      AND currency IS NULL
      AND external_reference_sha256 IS NULL
      AND effect_certainty = 'UNKNOWN'
      AND retryable = TRUE
      AND failure_code IS NOT NULL
      AND recovery_delay_seconds IS NOT NULL
      AND recovery_not_before IS NOT NULL
    )
    OR (
      outcome_kind = 'FAILED'
      AND provider_result_sha256 IS NULL
      AND provider_state IS NULL
      AND provider_result_version IS NULL
      AND amount_cents IS NULL
      AND currency IS NULL
      AND external_reference_sha256 IS NULL
      AND effect_certainty = 'CONFIRMED_NO_EFFECT'
      AND failure_code IS NOT NULL
      AND (
        (
          retryable = TRUE
          AND recovery_delay_seconds IS NOT NULL
          AND recovery_not_before IS NOT NULL
        )
        OR (
          retryable = FALSE
          AND recovery_delay_seconds IS NULL
          AND recovery_not_before IS NULL
        )
      )
    )
  ),
  CONSTRAINT financial_provider_command_outcome_recovery_window_chk CHECK (
    (
      recovery_delay_seconds IS NULL
      AND recovery_not_before IS NULL
    )
    OR recovery_not_before = recorded_at + make_interval(secs => recovery_delay_seconds)
  )
);

ALTER TABLE public.financial_provider_command_outcome_facts
  ADD COLUMN IF NOT EXISTS amount_cents BIGINT CHECK (
    amount_cents IS NULL OR amount_cents BETWEEN 0 AND 9007199254740991
  ),
  ADD COLUMN IF NOT EXISTS currency CHAR(3) CHECK (
    currency IS NULL OR currency ~ '^[A-Z]{3}$'
  ),
  ADD COLUMN IF NOT EXISTS external_reference_sha256 CHAR(64) CHECK (
    external_reference_sha256 IS NULL
    OR external_reference_sha256 ~ '^[0-9a-f]{64}$'
  );
ALTER TABLE public.financial_provider_command_outcome_facts
  DROP CONSTRAINT IF EXISTS financial_provider_command_outcome_facts_recovery_delay_seconds_check,
  DROP CONSTRAINT IF EXISTS financial_provider_command_outcome_recovery_delay_chk;
ALTER TABLE public.financial_provider_command_outcome_facts
  ADD CONSTRAINT financial_provider_command_outcome_recovery_delay_chk CHECK (
    recovery_delay_seconds IS NULL OR recovery_delay_seconds BETWEEN 1 AND 86400
  ) NOT VALID;
DROP INDEX IF EXISTS public.financial_provider_command_one_terminal_outcome_uniq;
CREATE UNIQUE INDEX financial_provider_command_one_terminal_outcome_uniq
  ON public.financial_provider_command_outcome_facts(command_id)
  WHERE (outcome_kind = 'OUTCOME_OBSERVED' AND retryable = FALSE)
     OR (outcome_kind = 'FAILED' AND retryable = FALSE);

-- Keep this draft migration safely re-runnable while its contract is under
-- convergence. The original draft admitted only terminal observed outcomes.
ALTER TABLE public.financial_provider_command_outcome_facts
  DROP CONSTRAINT IF EXISTS financial_provider_command_outcome_bundle_chk;
ALTER TABLE public.financial_provider_command_outcome_facts
  ADD CONSTRAINT financial_provider_command_outcome_bundle_chk CHECK (
    (
      outcome_kind = 'OUTCOME_OBSERVED'
      AND provider_result_sha256 IS NOT NULL
      AND provider_state IS NOT NULL
      AND provider_result_version IS NOT NULL
      AND external_reference_sha256 IS NOT NULL
      AND failure_code IS NULL
      AND (amount_cents IS NULL) = (currency IS NULL)
      AND (
        (
          provider_state IN ('PENDING', 'RETRYABLE_FAILURE')
          AND effect_certainty = 'UNKNOWN'
          AND retryable = TRUE
          AND recovery_delay_seconds IS NOT NULL
          AND recovery_not_before IS NOT NULL
        )
        OR (
          provider_state NOT IN ('PENDING', 'RETRYABLE_FAILURE')
          AND effect_certainty IN ('CONFIRMED_EFFECT', 'CONFIRMED_NO_EFFECT')
          AND retryable = FALSE
          AND recovery_delay_seconds IS NULL
          AND recovery_not_before IS NULL
        )
      )
    )
    OR (
      outcome_kind = 'OUTCOME_UNKNOWN'
      AND provider_result_sha256 IS NULL
      AND provider_state IS NULL
      AND provider_result_version IS NULL
      AND amount_cents IS NULL
      AND currency IS NULL
      AND external_reference_sha256 IS NULL
      AND effect_certainty = 'UNKNOWN'
      AND retryable = TRUE
      AND failure_code IS NOT NULL
      AND recovery_delay_seconds IS NOT NULL
      AND recovery_not_before IS NOT NULL
    )
    OR (
      outcome_kind = 'FAILED'
      AND provider_result_sha256 IS NULL
      AND provider_state IS NULL
      AND provider_result_version IS NULL
      AND amount_cents IS NULL
      AND currency IS NULL
      AND external_reference_sha256 IS NULL
      AND effect_certainty = 'CONFIRMED_NO_EFFECT'
      AND failure_code IS NOT NULL
      AND (
        (
          retryable = TRUE
          AND recovery_delay_seconds IS NOT NULL
          AND recovery_not_before IS NOT NULL
        )
        OR (
          retryable = FALSE
          AND recovery_delay_seconds IS NULL
          AND recovery_not_before IS NULL
        )
      )
    )
  ) NOT VALID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.financial_provider_command_outcome_facts
     WHERE recovery_delay_seconds = 0
  ) THEN
    ALTER TABLE public.financial_provider_command_outcome_facts
      VALIDATE CONSTRAINT financial_provider_command_outcome_recovery_delay_chk;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.financial_provider_command_outcome_facts
     WHERE outcome_kind = 'OUTCOME_OBSERVED'
       AND external_reference_sha256 IS NULL
  ) THEN
    ALTER TABLE public.financial_provider_command_outcome_facts
      VALIDATE CONSTRAINT financial_provider_command_outcome_bundle_chk;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS financial_provider_command_recovery_lease_due_idx
  ON public.financial_provider_command_recovery_leases(command_id, expires_at);
CREATE INDEX IF NOT EXISTS financial_provider_command_dispatch_attempt_due_idx
  ON public.financial_provider_command_dispatch_attempts(command_id, outcome_deadline_at);
DROP INDEX IF EXISTS public.financial_provider_command_outcome_recovery_due_idx;
CREATE INDEX financial_provider_command_outcome_recovery_due_idx
  ON public.financial_provider_command_outcome_facts(command_id, recovery_not_before)
  WHERE outcome_kind IN ('OUTCOME_OBSERVED', 'OUTCOME_UNKNOWN', 'FAILED')
    AND retryable = TRUE;

CREATE OR REPLACE FUNCTION public.assert_financial_provider_command_recovery_lease()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  current_provider_kind TEXT;
  latest_attempt_id UUID;
  latest_outcome_deadline TIMESTAMPTZ;
  latest_outcome_kind TEXT;
  latest_outcome_retryable BOOLEAN;
  latest_effect_certainty TEXT;
  latest_recovery_not_before TIMESTAMPTZ;
  authority_now TIMESTAMPTZ;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext('financial-provider-command-recovery-v1'),
    hashtext(NEW.command_id::TEXT)
  );

  authority_now := clock_timestamp();
  NEW.acquired_at := authority_now;
  NEW.expires_at := authority_now + make_interval(secs => NEW.lease_duration_seconds);

  SELECT provider_kind
    INTO current_provider_kind
    FROM public.financial_provider_command_journal
   WHERE command_id = NEW.command_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXFPCREC1: requested command does not exist'
      USING ERRCODE = 'P0001';
  END IF;
  IF current_provider_kind <> 'FAKE' THEN
    RAISE EXCEPTION 'HXFPCREC1: approved-provider recovery is unavailable'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.financial_provider_command_outcome_facts outcome
     WHERE outcome.command_id = NEW.command_id
       AND (
         (outcome.outcome_kind = 'OUTCOME_OBSERVED' AND outcome.retryable = FALSE)
         OR (outcome.outcome_kind = 'FAILED' AND outcome.retryable = FALSE)
       )
  ) THEN
    RAISE EXCEPTION 'HXFPCREC1: command already has a terminal outcome'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.financial_provider_command_recovery_leases lease
     WHERE lease.command_id = NEW.command_id
       AND lease.expires_at > authority_now
       AND NOT EXISTS (
         SELECT 1
           FROM public.financial_provider_command_dispatch_attempts attempt
          WHERE attempt.recovery_lease_id = lease.recovery_lease_id
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.financial_provider_command_outcome_facts outcome
          WHERE outcome.recovery_lease_id = lease.recovery_lease_id
       )
  ) THEN
    RAISE EXCEPTION 'HXFPCREC1: command already has an active recovery lease'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT attempt.dispatch_attempt_id, attempt.outcome_deadline_at
    INTO latest_attempt_id, latest_outcome_deadline
    FROM public.financial_provider_command_dispatch_attempts attempt
   WHERE attempt.command_id = NEW.command_id
   ORDER BY attempt.attempt_number DESC
   LIMIT 1;

  IF latest_attempt_id IS NOT NULL THEN
    SELECT outcome.outcome_kind, outcome.retryable, outcome.effect_certainty,
           outcome.recovery_not_before
      INTO latest_outcome_kind, latest_outcome_retryable,
           latest_effect_certainty, latest_recovery_not_before
      FROM public.financial_provider_command_outcome_facts outcome
     WHERE outcome.dispatch_attempt_id = latest_attempt_id
     ORDER BY outcome.recorded_at DESC, outcome.outcome_fact_id DESC
     LIMIT 1;
  END IF;

  IF NEW.recovery_action = 'DISPATCH' THEN
    IF latest_attempt_id IS NOT NULL AND NOT (
      latest_outcome_kind = 'FAILED'
      AND latest_outcome_retryable = TRUE
      AND latest_effect_certainty = 'CONFIRMED_NO_EFFECT'
      AND latest_recovery_not_before <= authority_now
    ) THEN
      RAISE EXCEPTION 'HXFPCREC1: dispatch requires no attempt or a due definite no-effect failure'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF latest_attempt_id IS NULL THEN
    RAISE EXCEPTION 'HXFPCREC1: reconciliation requires a dispatch attempt'
      USING ERRCODE = 'P0001';
  ELSIF latest_outcome_kind IS NULL THEN
    IF latest_outcome_deadline > authority_now THEN
      RAISE EXCEPTION 'HXFPCREC1: dispatch outcome deadline has not elapsed'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF NOT (
    latest_outcome_kind IN ('OUTCOME_OBSERVED', 'OUTCOME_UNKNOWN', 'FAILED')
    AND latest_outcome_retryable = TRUE
    AND latest_recovery_not_before <= authority_now
  ) THEN
    RAISE EXCEPTION 'HXFPCREC1: reconciliation requires a due nonterminal outcome'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_financial_provider_command_dispatch_attempt()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  lease_action TEXT;
  lease_expiry TIMESTAMPTZ;
  command_provider_kind TEXT;
  command_request_sha256 CHAR(64);
  expected_attempt_number BIGINT;
  authority_now TIMESTAMPTZ;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext('financial-provider-command-recovery-v1'),
    hashtext(NEW.command_id::TEXT)
  );

  authority_now := clock_timestamp();
  NEW.attempted_at := authority_now;
  NEW.outcome_deadline_at := authority_now
    + make_interval(secs => NEW.outcome_timeout_seconds);

  SELECT lease.recovery_action, lease.expires_at,
         command.provider_kind, command.request_sha256
    INTO lease_action, lease_expiry, command_provider_kind, command_request_sha256
    FROM public.financial_provider_command_recovery_leases lease
    JOIN public.financial_provider_command_journal command
      ON command.command_id = lease.command_id
   WHERE lease.recovery_lease_id = NEW.recovery_lease_id
     AND lease.command_id = NEW.command_id;
  IF NOT FOUND OR command_provider_kind <> 'FAKE' OR lease_action <> 'DISPATCH' THEN
    RAISE EXCEPTION 'HXFPCREC1: dispatch attempt lacks a fake dispatch lease'
      USING ERRCODE = 'P0001';
  END IF;
  IF lease_expiry <= authority_now THEN
    RAISE EXCEPTION 'HXFPCREC1: dispatch lease expired before adapter entry'
      USING ERRCODE = 'P0001';
  END IF;
  IF command_request_sha256 <> NEW.request_sha256 THEN
    RAISE EXCEPTION 'HXFPCREC1: dispatch request digest differs from requested command'
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.financial_provider_command_dispatch_attempts attempt
     WHERE attempt.recovery_lease_id = NEW.recovery_lease_id
  ) OR EXISTS (
    SELECT 1 FROM public.financial_provider_command_outcome_facts outcome
     WHERE outcome.recovery_lease_id = NEW.recovery_lease_id
  ) THEN
    RAISE EXCEPTION 'HXFPCREC1: dispatch lease was already consumed'
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.financial_provider_command_outcome_facts outcome
     WHERE outcome.command_id = NEW.command_id
       AND (
         (outcome.outcome_kind = 'OUTCOME_OBSERVED' AND outcome.retryable = FALSE)
         OR (outcome.outcome_kind = 'FAILED' AND outcome.retryable = FALSE)
       )
  ) THEN
    RAISE EXCEPTION 'HXFPCREC1: terminal command cannot be dispatched'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(MAX(attempt.attempt_number), 0) + 1
    INTO expected_attempt_number
    FROM public.financial_provider_command_dispatch_attempts attempt
   WHERE attempt.command_id = NEW.command_id;
  IF NEW.attempt_number <> expected_attempt_number THEN
    RAISE EXCEPTION 'HXFPCREC1: dispatch attempt number is not contiguous'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_financial_provider_command_outcome_fact()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  lease_action TEXT;
  lease_expiry TIMESTAMPTZ;
  command_provider_kind TEXT;
  command_operation_kind TEXT;
  command_operation_id UUID;
  command_provider_expected_version BIGINT;
  command_amount_cents BIGINT;
  command_currency CHAR(3);
  attempt_lease_id UUID;
  latest_attempt_id UUID;
  authority_now TIMESTAMPTZ;
  expected_provider_result_sha256 CHAR(64);
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext('financial-provider-command-recovery-v1'),
    hashtext(NEW.command_id::TEXT)
  );

  authority_now := clock_timestamp();
  NEW.recorded_at := authority_now;
  NEW.recovery_not_before := CASE
    WHEN NEW.recovery_delay_seconds IS NULL THEN NULL
    ELSE authority_now + make_interval(secs => NEW.recovery_delay_seconds)
  END;

  SELECT lease.recovery_action, lease.expires_at, command.provider_kind,
         command.operation_kind, command.operation_id,
         command.provider_expected_version, command.amount_cents,
         command.currency, attempt.recovery_lease_id
    INTO lease_action, lease_expiry, command_provider_kind,
         command_operation_kind, command_operation_id,
         command_provider_expected_version, command_amount_cents,
         command_currency, attempt_lease_id
    FROM public.financial_provider_command_recovery_leases lease
    JOIN public.financial_provider_command_journal command
      ON command.command_id = lease.command_id
    JOIN public.financial_provider_command_dispatch_attempts attempt
      ON attempt.command_id = command.command_id
     AND attempt.dispatch_attempt_id = NEW.dispatch_attempt_id
   WHERE lease.recovery_lease_id = NEW.recovery_lease_id
     AND lease.command_id = NEW.command_id;
  IF NOT FOUND OR command_provider_kind <> 'FAKE' THEN
    RAISE EXCEPTION 'HXFPCREC1: outcome lacks fake command authority'
      USING ERRCODE = 'P0001';
  END IF;
  IF lease_expiry <= authority_now THEN
    RAISE EXCEPTION 'HXFPCREC1: recovery lease expired before outcome commitment'
      USING ERRCODE = 'P0001';
  END IF;
  IF lease_action = 'DISPATCH' AND attempt_lease_id <> NEW.recovery_lease_id THEN
    RAISE EXCEPTION 'HXFPCREC1: dispatch outcome is not bound to its attempt lease'
      USING ERRCODE = 'P0001';
  END IF;
  IF lease_action = 'RECONCILE' AND EXISTS (
    SELECT 1 FROM public.financial_provider_command_dispatch_attempts attempt
     WHERE attempt.recovery_lease_id = NEW.recovery_lease_id
  ) THEN
    RAISE EXCEPTION 'HXFPCREC1: reconciliation lease cannot create a dispatch attempt'
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.financial_provider_command_outcome_facts outcome
     WHERE outcome.recovery_lease_id = NEW.recovery_lease_id
  ) THEN
    RAISE EXCEPTION 'HXFPCREC1: recovery lease already recorded an outcome'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT attempt.dispatch_attempt_id
    INTO latest_attempt_id
    FROM public.financial_provider_command_dispatch_attempts attempt
   WHERE attempt.command_id = NEW.command_id
   ORDER BY attempt.attempt_number DESC
   LIMIT 1;
  IF latest_attempt_id <> NEW.dispatch_attempt_id THEN
    RAISE EXCEPTION 'HXFPCREC1: outcome does not reference the latest attempt'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.outcome_kind = 'OUTCOME_OBSERVED' AND NOT (
    (
      command_operation_kind IN (
        'PREPARE_PAYMENT_METHOD', 'AUTHORIZE', 'SECURE', 'ADJUST', 'CAPTURE',
        'ONBOARD_PROVIDER', 'REFRESH_PROVIDER_ACCOUNT_STATE', 'SETTLE', 'FUND',
        'PROVIDER_RELEASE', 'PAYOUT', 'OBSERVE_BANK_SETTLEMENT'
      )
      AND NEW.provider_state IN (
        'PENDING', 'SUCCEEDED', 'DECLINED', 'FAILED', 'RETRYABLE_FAILURE'
      )
    )
    OR (
      command_operation_kind = 'VOID'
      AND NEW.provider_state IN (
        'PENDING', 'VOIDED', 'DECLINED', 'FAILED', 'RETRYABLE_FAILURE'
      )
    )
    OR (
      command_operation_kind = 'REFUND'
      AND NEW.provider_state IN (
        'PENDING', 'REFUNDED', 'PARTIALLY_REFUNDED', 'DECLINED', 'FAILED',
        'RETRYABLE_FAILURE'
      )
    )
    OR (
      command_operation_kind = 'REVERSAL'
      AND NEW.provider_state IN (
        'PENDING', 'REVERSED', 'DECLINED', 'FAILED', 'RETRYABLE_FAILURE'
      )
    )
    OR (
      command_operation_kind = 'INGEST_WEBHOOK'
      AND NEW.provider_state IN ('PENDING', 'ACCEPTED', 'REJECTED', 'RETRYABLE_FAILURE')
    )
    OR (
      command_operation_kind = 'RECONCILE'
      AND NEW.provider_state IN ('MATCHED', 'MISMATCH')
    )
  ) THEN
    RAISE EXCEPTION 'HXFPCREC1: observed provider state is invalid for command operation'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.outcome_kind = 'OUTCOME_OBSERVED' THEN
    IF NEW.provider_result_version <> command_provider_expected_version + 1 THEN
      RAISE EXCEPTION 'HXFPCREC1: observed provider version does not advance exact command version'
        USING ERRCODE = 'P0001';
    END IF;
    IF command_operation_kind IN (
      'AUTHORIZE', 'SECURE', 'VOID', 'ADJUST', 'CAPTURE', 'REFUND',
      'REVERSAL', 'SETTLE', 'FUND', 'PROVIDER_RELEASE', 'PAYOUT',
      'OBSERVE_BANK_SETTLEMENT'
    ) THEN
      IF NEW.amount_cents IS DISTINCT FROM command_amount_cents
         OR NEW.currency IS DISTINCT FROM command_currency THEN
        RAISE EXCEPTION 'HXFPCREC1: observed provider value differs from exact command value'
          USING ERRCODE = 'P0001';
      END IF;
    ELSIF NEW.amount_cents IS NOT NULL OR NEW.currency IS NOT NULL THEN
      RAISE EXCEPTION 'HXFPCREC1: non-money provider outcome cannot project value'
        USING ERRCODE = 'P0001';
    END IF;

    expected_provider_result_sha256 := encode(
      digest(
        command_operation_id::TEXT || ':' || command_operation_kind || ':' ||
        command_provider_kind || ':' || NEW.provider_state || ':' ||
        NEW.provider_result_version::TEXT || ':' ||
        COALESCE(NEW.amount_cents::TEXT, '') || ':' ||
        COALESCE(NEW.currency, '') || ':' || NEW.external_reference_sha256 || ':' ||
        NEW.retryable::TEXT,
        'sha256'
      ),
      'hex'
    );
    IF NEW.provider_result_sha256 <> expected_provider_result_sha256 THEN
      RAISE EXCEPTION 'HXFPCREC1: observed provider projection digest mismatch'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.financial_provider_command_outcome_facts outcome
     WHERE outcome.command_id = NEW.command_id
       AND (
         (outcome.outcome_kind = 'OUTCOME_OBSERVED' AND outcome.retryable = FALSE)
         OR (outcome.outcome_kind = 'FAILED' AND outcome.retryable = FALSE)
       )
  ) THEN
    RAISE EXCEPTION 'HXFPCREC1: terminal outcome already exists'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS financial_provider_command_recovery_lease_guard
  ON public.financial_provider_command_recovery_leases;
CREATE TRIGGER financial_provider_command_recovery_lease_guard
BEFORE INSERT ON public.financial_provider_command_recovery_leases
FOR EACH ROW EXECUTE FUNCTION public.assert_financial_provider_command_recovery_lease();

DROP TRIGGER IF EXISTS financial_provider_command_dispatch_attempt_guard
  ON public.financial_provider_command_dispatch_attempts;
CREATE TRIGGER financial_provider_command_dispatch_attempt_guard
BEFORE INSERT ON public.financial_provider_command_dispatch_attempts
FOR EACH ROW EXECUTE FUNCTION public.assert_financial_provider_command_dispatch_attempt();

DROP TRIGGER IF EXISTS financial_provider_command_outcome_fact_guard
  ON public.financial_provider_command_outcome_facts;
CREATE TRIGGER financial_provider_command_outcome_fact_guard
BEFORE INSERT ON public.financial_provider_command_outcome_facts
FOR EACH ROW EXECUTE FUNCTION public.assert_financial_provider_command_outcome_fact();

CREATE OR REPLACE FUNCTION public.reject_financial_provider_command_recovery_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'HXFPCREC1: financial provider command recovery evidence is append-only'
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS financial_provider_command_recovery_lease_no_update_delete
  ON public.financial_provider_command_recovery_leases;
CREATE TRIGGER financial_provider_command_recovery_lease_no_update_delete
BEFORE UPDATE OR DELETE ON public.financial_provider_command_recovery_leases
FOR EACH ROW EXECUTE FUNCTION public.reject_financial_provider_command_recovery_mutation();

DROP TRIGGER IF EXISTS financial_provider_command_recovery_lease_no_truncate
  ON public.financial_provider_command_recovery_leases;
CREATE TRIGGER financial_provider_command_recovery_lease_no_truncate
BEFORE TRUNCATE ON public.financial_provider_command_recovery_leases
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_financial_provider_command_recovery_mutation();

DROP TRIGGER IF EXISTS financial_provider_command_dispatch_attempt_no_update_delete
  ON public.financial_provider_command_dispatch_attempts;
CREATE TRIGGER financial_provider_command_dispatch_attempt_no_update_delete
BEFORE UPDATE OR DELETE ON public.financial_provider_command_dispatch_attempts
FOR EACH ROW EXECUTE FUNCTION public.reject_financial_provider_command_recovery_mutation();

DROP TRIGGER IF EXISTS financial_provider_command_dispatch_attempt_no_truncate
  ON public.financial_provider_command_dispatch_attempts;
CREATE TRIGGER financial_provider_command_dispatch_attempt_no_truncate
BEFORE TRUNCATE ON public.financial_provider_command_dispatch_attempts
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_financial_provider_command_recovery_mutation();

DROP TRIGGER IF EXISTS financial_provider_command_outcome_fact_no_update_delete
  ON public.financial_provider_command_outcome_facts;
CREATE TRIGGER financial_provider_command_outcome_fact_no_update_delete
BEFORE UPDATE OR DELETE ON public.financial_provider_command_outcome_facts
FOR EACH ROW EXECUTE FUNCTION public.reject_financial_provider_command_recovery_mutation();

DROP TRIGGER IF EXISTS financial_provider_command_outcome_fact_no_truncate
  ON public.financial_provider_command_outcome_facts;
CREATE TRIGGER financial_provider_command_outcome_fact_no_truncate
BEFORE TRUNCATE ON public.financial_provider_command_outcome_facts
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_financial_provider_command_recovery_mutation();

COMMENT ON TABLE public.financial_provider_command_recovery_leases IS
  'Append-only, one-shot FAKE command lease facts. An unconsumed lease fences concurrent dispatch or reconciliation until its deadline.';
COMMENT ON TABLE public.financial_provider_command_dispatch_attempts IS
  'Append-only DISPATCH_ATTEMPTED facts committed before fake-provider adapter entry. Presence forbids blind redispatch.';
COMMENT ON TABLE public.financial_provider_command_outcome_facts IS
  'Append-only OUTCOME_OBSERVED, OUTCOME_UNKNOWN, and definite no-effect FAILED facts. Only safe amount/currency projections and an external-reference digest are retained; raw provider payloads and references are not stored.';

REVOKE ALL ON TABLE public.financial_provider_command_recovery_leases FROM PUBLIC;
REVOKE ALL ON TABLE public.financial_provider_command_dispatch_attempts FROM PUBLIC;
REVOKE ALL ON TABLE public.financial_provider_command_outcome_facts FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_financial_provider_command_recovery_lease() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_financial_provider_command_dispatch_attempt() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_financial_provider_command_outcome_fact() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_financial_provider_command_recovery_mutation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assert_financial_provider_command_recovery_lease() TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.assert_financial_provider_command_dispatch_attempt() TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.assert_financial_provider_command_outcome_fact() TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.reject_financial_provider_command_recovery_mutation() TO CURRENT_USER;
