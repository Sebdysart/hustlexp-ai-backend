-- Durable provider-event normalization processing v1.
--
-- Mutable state coordinates bounded leases only. Every attempt and outcome is
-- separately append-only, so a crash cannot erase what was claimed and a
-- lease-expiry replay cannot masquerade as the original attempt. This contract
-- performs no provider I/O and grants no payment or production capability.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.provider_event_processing_state (
  observation_id UUID PRIMARY KEY
    REFERENCES public.provider_event_inbox_observations(observation_id) ON DELETE RESTRICT,
  processing_state TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    processing_state IN (
      'PENDING', 'LEASED', 'RETRY_PENDING', 'SUCCEEDED', 'TERMINAL_FAILED'
    )
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  retryable_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (
    retryable_failure_count BETWEEN 0 AND 32
  ),
  available_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  active_attempt_id UUID,
  active_lease_token UUID,
  leased_by TEXT CHECK (
    leased_by IS NULL OR leased_by ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{2,127}$'
  ),
  leased_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT provider_event_processing_lease_bundle_chk CHECK (
    (
      processing_state = 'LEASED'
      AND num_nonnulls(
        active_attempt_id, active_lease_token, leased_by, leased_at, lease_expires_at
      ) = 5
    ) OR (
      processing_state <> 'LEASED'
      AND num_nonnulls(
        active_attempt_id, active_lease_token, leased_by, leased_at, lease_expires_at
      ) = 0
    )
  ),
  CONSTRAINT provider_event_processing_lease_time_chk CHECK (
    lease_expires_at IS NULL
    OR (
      lease_expires_at > leased_at
      AND lease_expires_at <= leased_at + INTERVAL '5 minutes'
    )
  ),
  CONSTRAINT provider_event_processing_completion_chk CHECK (
    (processing_state IN ('SUCCEEDED', 'TERMINAL_FAILED')) = (completed_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.provider_event_processing_attempts (
  attempt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id UUID NOT NULL
    REFERENCES public.provider_event_inbox_observations(observation_id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  lease_token UUID NOT NULL UNIQUE,
  leased_by TEXT NOT NULL CHECK (
    leased_by ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{2,127}$'
  ),
  leased_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  lease_expires_at TIMESTAMPTZ NOT NULL CHECK (
    lease_expires_at > leased_at
    AND lease_expires_at <= leased_at + INTERVAL '5 minutes'
  ),
  normalization_idempotency_key TEXT NOT NULL CHECK (
    normalization_idempotency_key ~ '^provider-event:[0-9a-f]{64}$'
  ),
  CONSTRAINT provider_event_processing_attempt_number_uniq
    UNIQUE (observation_id, attempt_number),
  CONSTRAINT provider_event_processing_attempt_observation_uniq
    UNIQUE (attempt_id, observation_id),
  CONSTRAINT provider_event_processing_attempt_lease_identity_uniq
    UNIQUE (attempt_id, observation_id, lease_token)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'provider_event_processing_active_attempt_fk'
       AND conrelid = 'public.provider_event_processing_state'::regclass
  ) THEN
    ALTER TABLE public.provider_event_processing_state
      ADD CONSTRAINT provider_event_processing_active_attempt_fk
      FOREIGN KEY (active_attempt_id, observation_id)
      REFERENCES public.provider_event_processing_attempts(attempt_id, observation_id)
      ON DELETE RESTRICT;
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.provider_event_processing_outcomes (
  outcome_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL,
  observation_id UUID NOT NULL,
  lease_token UUID NOT NULL,
  outcome_kind TEXT NOT NULL CHECK (
    outcome_kind IN (
      'SUCCEEDED', 'RETRYABLE_FAILED', 'TERMINAL_FAILED', 'LEASE_EXPIRED'
    )
  ),
  normalized_operation_id UUID,
  normalized_operation_version BIGINT CHECK (
    normalized_operation_version IS NULL
    OR normalized_operation_version BETWEEN 0 AND 9007199254740991
  ),
  normalized_state TEXT CHECK (
    normalized_state IS NULL OR normalized_state IN (
      'PENDING', 'SUCCEEDED', 'DECLINED', 'FAILED', 'RETRYABLE_FAILURE',
      'VOIDED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'REVERSED', 'ACCEPTED',
      'REJECTED', 'MATCHED', 'MISMATCH'
    )
  ),
  normalization_idempotency_replayed BOOLEAN,
  detail_code TEXT CHECK (
    detail_code IS NULL OR detail_code ~ '^[A-Z][A-Z0-9:_-]{2,127}$'
  ),
  retry_at TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT provider_event_processing_outcome_attempt_uniq UNIQUE (attempt_id),
  CONSTRAINT provider_event_processing_outcome_attempt_fk
    FOREIGN KEY (attempt_id, observation_id, lease_token)
    REFERENCES public.provider_event_processing_attempts(
      attempt_id, observation_id, lease_token
    )
    ON DELETE RESTRICT,
  CONSTRAINT provider_event_processing_outcome_bundle_chk CHECK (
    (
      outcome_kind = 'SUCCEEDED'
      AND num_nonnulls(
        normalized_operation_id,
        normalized_operation_version,
        normalized_state,
        normalization_idempotency_replayed
      ) = 4
      AND detail_code IS NULL
      AND retry_at IS NULL
    ) OR (
      outcome_kind = 'RETRYABLE_FAILED'
      AND num_nonnulls(
        normalized_operation_id,
        normalized_operation_version,
        normalized_state,
        normalization_idempotency_replayed
      ) = 0
      AND detail_code IS NOT NULL
      AND retry_at IS NOT NULL
      AND retry_at > recorded_at
    ) OR (
      outcome_kind IN ('TERMINAL_FAILED', 'LEASE_EXPIRED')
      AND num_nonnulls(
        normalized_operation_id,
        normalized_operation_version,
        normalized_state,
        normalization_idempotency_replayed
      ) = 0
      AND detail_code IS NOT NULL
      AND retry_at IS NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS provider_event_processing_claim_idx
  ON public.provider_event_processing_state(processing_state, available_at, updated_at);
CREATE INDEX IF NOT EXISTS provider_event_processing_attempt_observation_idx
  ON public.provider_event_processing_attempts(observation_id, attempt_number);
CREATE INDEX IF NOT EXISTS provider_event_processing_outcome_observation_idx
  ON public.provider_event_processing_outcomes(observation_id, recorded_at);

CREATE OR REPLACE FUNCTION public.initialize_provider_event_processing_state()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.provider_event_processing_state(observation_id)
  VALUES (NEW.observation_id)
  ON CONFLICT (observation_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS provider_event_processing_initialize
  ON public.provider_event_inbox_observations;
CREATE TRIGGER provider_event_processing_initialize
AFTER INSERT ON public.provider_event_inbox_observations
FOR EACH ROW EXECUTE FUNCTION public.initialize_provider_event_processing_state();

INSERT INTO public.provider_event_processing_state(observation_id)
SELECT observation_id FROM public.provider_event_inbox_observations
ON CONFLICT (observation_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.validate_provider_event_processing_state_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  lease_matches_attempt BOOLEAN;
  transition_has_outcome BOOLEAN;
  required_outcome_kind TEXT;
BEGIN
  IF OLD.processing_state IN ('SUCCEEDED', 'TERMINAL_FAILED') THEN
    RAISE EXCEPTION 'HXPEP1: terminal provider event processing state is immutable'
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT (
    (OLD.processing_state IN ('PENDING', 'RETRY_PENDING') AND NEW.processing_state = 'LEASED')
    OR (OLD.processing_state = 'LEASED' AND NEW.processing_state IN (
      'LEASED', 'RETRY_PENDING', 'SUCCEEDED', 'TERMINAL_FAILED'
    ))
  ) THEN
    RAISE EXCEPTION 'HXPEP2: invalid provider event processing transition'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.attempt_count < OLD.attempt_count
     OR NEW.retryable_failure_count < OLD.retryable_failure_count THEN
    RAISE EXCEPTION 'HXPEP3: provider event processing counters are monotonic'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.processing_state = 'LEASED' AND NEW.attempt_count <> OLD.attempt_count + 1 THEN
    RAISE EXCEPTION 'HXPEP4: each lease requires exactly one new attempt'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.processing_state <> 'LEASED' AND NEW.attempt_count <> OLD.attempt_count THEN
    RAISE EXCEPTION 'HXPEP5: only a lease may advance the attempt counter'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.processing_state = 'RETRY_PENDING'
     AND NEW.retryable_failure_count <> OLD.retryable_failure_count + 1 THEN
    RAISE EXCEPTION 'HXPEP6: retry outcome must advance its counter once'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.processing_state <> 'RETRY_PENDING'
     AND NEW.retryable_failure_count <> OLD.retryable_failure_count THEN
    RAISE EXCEPTION 'HXPEP7: only retry outcome may advance its counter'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.processing_state = 'LEASED' THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.provider_event_processing_attempts attempt
       WHERE attempt.attempt_id = NEW.active_attempt_id
         AND attempt.observation_id = NEW.observation_id
         AND attempt.attempt_number = NEW.attempt_count
         AND attempt.lease_token = NEW.active_lease_token
         AND attempt.leased_by = NEW.leased_by
         AND attempt.leased_at = NEW.leased_at
         AND attempt.lease_expires_at = NEW.lease_expires_at
    ) INTO lease_matches_attempt;
    IF NOT lease_matches_attempt THEN
      RAISE EXCEPTION 'HXPEP15: active lease must match its append-only attempt'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF OLD.processing_state = 'LEASED' THEN
    required_outcome_kind := CASE NEW.processing_state
      WHEN 'LEASED' THEN 'LEASE_EXPIRED'
      WHEN 'RETRY_PENDING' THEN 'RETRYABLE_FAILED'
      WHEN 'SUCCEEDED' THEN 'SUCCEEDED'
      WHEN 'TERMINAL_FAILED' THEN 'TERMINAL_FAILED'
      ELSE NULL
    END;
    SELECT EXISTS (
      SELECT 1
        FROM public.provider_event_processing_outcomes outcome
       WHERE outcome.attempt_id = OLD.active_attempt_id
         AND outcome.observation_id = OLD.observation_id
         AND outcome.outcome_kind = required_outcome_kind
         AND (
           required_outcome_kind <> 'RETRYABLE_FAILED'
           OR outcome.retry_at = NEW.available_at
         )
    ) INTO transition_has_outcome;
    IF NOT transition_has_outcome THEN
      RAISE EXCEPTION 'HXPEP16: lease transition requires append-only outcome evidence'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS provider_event_processing_state_transition
  ON public.provider_event_processing_state;
CREATE TRIGGER provider_event_processing_state_transition
BEFORE UPDATE ON public.provider_event_processing_state
FOR EACH ROW EXECUTE FUNCTION public.validate_provider_event_processing_state_transition();

CREATE OR REPLACE FUNCTION public.validate_provider_event_processing_attempt()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  inbox_provider_kind TEXT;
  inbox_event_reference TEXT;
  expected_key TEXT;
  expected_attempt INTEGER;
  requested_lease_duration INTERVAL;
BEGIN
  requested_lease_duration := NEW.lease_expires_at - NEW.leased_at;
  IF requested_lease_duration < INTERVAL '100 milliseconds'
     OR requested_lease_duration > INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'HXPEP19: processing lease duration is outside its bounded window'
      USING ERRCODE = 'P0001';
  END IF;
  NEW.leased_at := clock_timestamp();
  NEW.lease_expires_at := NEW.leased_at + requested_lease_duration;
  SELECT provider_kind, provider_event_reference
    INTO inbox_provider_kind, inbox_event_reference
    FROM public.provider_event_inbox_observations
   WHERE observation_id = NEW.observation_id;
  IF inbox_provider_kind <> 'FAKE' THEN
    RAISE EXCEPTION 'HXPEP8: only fake provider observations may be replayed'
      USING ERRCODE = 'P0001';
  END IF;
  expected_key := 'provider-event:' || encode(
    digest(
      convert_to(inbox_provider_kind, 'UTF8')
      || decode('00', 'hex')
      || convert_to(inbox_event_reference, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
  IF NEW.normalization_idempotency_key <> expected_key THEN
    RAISE EXCEPTION 'HXPEP9: normalization idempotency identity mismatch'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(MAX(attempt_number), 0) + 1
    INTO expected_attempt
    FROM public.provider_event_processing_attempts
   WHERE observation_id = NEW.observation_id;
  IF NEW.attempt_number <> expected_attempt THEN
    RAISE EXCEPTION 'HXPEP10: processing attempt sequence mismatch'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS provider_event_processing_attempt_validate
  ON public.provider_event_processing_attempts;
CREATE TRIGGER provider_event_processing_attempt_validate
BEFORE INSERT ON public.provider_event_processing_attempts
FOR EACH ROW EXECUTE FUNCTION public.validate_provider_event_processing_attempt();

CREATE OR REPLACE FUNCTION public.validate_provider_event_processing_outcome()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  expected_operation_id UUID;
  expected_lease_expiry TIMESTAMPTZ;
  expected_lease_token UUID;
  active_processing_state TEXT;
  active_attempt_id UUID;
  active_lease_token UUID;
  requested_retry_delay INTERVAL;
BEGIN
  IF NEW.outcome_kind = 'RETRYABLE_FAILED' THEN
    requested_retry_delay := NEW.retry_at - NEW.recorded_at;
    IF requested_retry_delay < INTERVAL '100 milliseconds'
       OR requested_retry_delay > INTERVAL '1 day' THEN
      RAISE EXCEPTION 'HXPEP20: retry delay is outside its bounded window'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  NEW.recorded_at := clock_timestamp();
  IF NEW.outcome_kind = 'RETRYABLE_FAILED' THEN
    NEW.retry_at := NEW.recorded_at + requested_retry_delay;
  END IF;
  SELECT
      observation.operation_id,
      attempt.lease_expires_at,
      attempt.lease_token,
      processing.processing_state,
      processing.active_attempt_id,
      processing.active_lease_token
    INTO
      expected_operation_id,
      expected_lease_expiry,
      expected_lease_token,
      active_processing_state,
      active_attempt_id,
      active_lease_token
    FROM public.provider_event_processing_attempts attempt
    JOIN public.provider_event_inbox_observations observation
      ON observation.observation_id = attempt.observation_id
    JOIN public.provider_event_processing_state processing
      ON processing.observation_id = attempt.observation_id
   WHERE attempt.attempt_id = NEW.attempt_id
     AND attempt.observation_id = NEW.observation_id
   FOR UPDATE OF processing;
  IF active_processing_state IS DISTINCT FROM 'LEASED'
     OR active_attempt_id IS DISTINCT FROM NEW.attempt_id
     OR active_lease_token IS DISTINCT FROM NEW.lease_token
     OR expected_lease_token IS DISTINCT FROM NEW.lease_token THEN
    RAISE EXCEPTION 'HXPEP17: outcome must close the active leased attempt'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.outcome_kind = 'SUCCEEDED'
     AND NEW.normalized_operation_id <> expected_operation_id THEN
    RAISE EXCEPTION 'HXPEP11: normalized operation identity mismatch'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.outcome_kind = 'LEASE_EXPIRED'
     AND expected_lease_expiry > clock_timestamp() THEN
    RAISE EXCEPTION 'HXPEP12: active lease cannot expire early'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.outcome_kind <> 'LEASE_EXPIRED'
     AND expected_lease_expiry <= clock_timestamp() THEN
    RAISE EXCEPTION 'HXPEP18: expired lease cannot record a processing outcome'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS provider_event_processing_outcome_validate
  ON public.provider_event_processing_outcomes;
CREATE TRIGGER provider_event_processing_outcome_validate
BEFORE INSERT ON public.provider_event_processing_outcomes
FOR EACH ROW EXECUTE FUNCTION public.validate_provider_event_processing_outcome();

CREATE OR REPLACE FUNCTION public.reject_provider_event_processing_evidence_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'HXPEP13: provider event processing evidence is append-only'
    USING ERRCODE = 'P0001';
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_provider_event_processing_state_removal()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'HXPEP14: provider event processing state cannot be removed'
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS provider_event_processing_attempt_no_update_delete
  ON public.provider_event_processing_attempts;
CREATE TRIGGER provider_event_processing_attempt_no_update_delete
BEFORE UPDATE OR DELETE ON public.provider_event_processing_attempts
FOR EACH ROW EXECUTE FUNCTION public.reject_provider_event_processing_evidence_mutation();
DROP TRIGGER IF EXISTS provider_event_processing_attempt_no_truncate
  ON public.provider_event_processing_attempts;
CREATE TRIGGER provider_event_processing_attempt_no_truncate
BEFORE TRUNCATE ON public.provider_event_processing_attempts
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_provider_event_processing_evidence_mutation();

DROP TRIGGER IF EXISTS provider_event_processing_outcome_no_update_delete
  ON public.provider_event_processing_outcomes;
CREATE TRIGGER provider_event_processing_outcome_no_update_delete
BEFORE UPDATE OR DELETE ON public.provider_event_processing_outcomes
FOR EACH ROW EXECUTE FUNCTION public.reject_provider_event_processing_evidence_mutation();
DROP TRIGGER IF EXISTS provider_event_processing_outcome_no_truncate
  ON public.provider_event_processing_outcomes;
CREATE TRIGGER provider_event_processing_outcome_no_truncate
BEFORE TRUNCATE ON public.provider_event_processing_outcomes
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_provider_event_processing_evidence_mutation();

DROP TRIGGER IF EXISTS provider_event_processing_state_no_delete
  ON public.provider_event_processing_state;
CREATE TRIGGER provider_event_processing_state_no_delete
BEFORE DELETE ON public.provider_event_processing_state
FOR EACH ROW EXECUTE FUNCTION public.reject_provider_event_processing_state_removal();
DROP TRIGGER IF EXISTS provider_event_processing_state_no_truncate
  ON public.provider_event_processing_state;
CREATE TRIGGER provider_event_processing_state_no_truncate
BEFORE TRUNCATE ON public.provider_event_processing_state
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_provider_event_processing_state_removal();

COMMENT ON TABLE public.provider_event_processing_state IS
  'Mutable lease coordination only; financial/provider truth remains in append-only inbox, attempt, outcome, command, lifecycle, and reconciliation facts.';
COMMENT ON TABLE public.provider_event_processing_attempts IS
  'Append-only bounded replay leases with deterministic provider-event normalization identity.';
COMMENT ON TABLE public.provider_event_processing_outcomes IS
  'Append-only success, retryable failure, terminal failure, and expired-lease outcomes. No row grants provider or production capability.';

REVOKE ALL ON TABLE
  public.provider_event_processing_state,
  public.provider_event_processing_attempts,
  public.provider_event_processing_outcomes
FROM PUBLIC;
REVOKE ALL ON FUNCTION public.initialize_provider_event_processing_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_provider_event_processing_state_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_provider_event_processing_attempt() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_provider_event_processing_outcome() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_provider_event_processing_evidence_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_provider_event_processing_state_removal() FROM PUBLIC;
