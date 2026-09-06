-- Nonproduction fake-finance v9: provider-observed financial-security expiry.
--
-- The fake adapter owns raw recorded_at and expires_at. This successor binds
-- that immutable raw pair to the canonical lifecycle fact and closes the
-- supplemental Phase-A/terminal-intent positive-use edges. It creates no
-- renewal, provider call, money effect, assignment, or production capability.

DO $$
BEGIN
  IF to_regclass('public.hxos_fake_financial_schema_evidence_v8') IS NULL
     OR to_regclass('public.hxos_fake_financial_operation_events_v1') IS NULL
     OR to_regclass('public.universal_v1_fake_financial_lifecycle_bridges') IS NULL
     OR to_regclass('public.universal_v1_change_order_materialization_commands') IS NULL
     OR to_regclass('public.universal_v1_fake_terminal_lifecycle_intents') IS NULL
     OR to_regprocedure(
       'public.universal_v1_financial_security_is_current_v1(timestamp with time zone,timestamp with time zone)'
     ) IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FSE-V9-0: exact fake-finance v8 and core expiry authority must be installed first'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- Preserve the v7 classifier under an explicit historical name, then extend
-- its public compatibility name with the one new permanent revocation class.
-- Existing PL/pgSQL recovery functions continue calling the compatibility
-- name and therefore converge through their already-bounded compensation path.
DO $$
BEGIN
  IF to_regprocedure(
       'public.universal_v1_change_order_recovery_revocation_reason_pre_expiry_v7(uuid)'
     ) IS NULL THEN
    IF to_regprocedure(
         'public.universal_v1_change_order_recovery_revocation_reason_v1(uuid)'
       ) IS NULL THEN
      RAISE EXCEPTION 'HXUV1-FSE-V9-7: exact v7 change-order recovery classifier is required'
        USING ERRCODE = 'P0001';
    END IF;
    ALTER FUNCTION public.universal_v1_change_order_recovery_revocation_reason_v1(UUID)
      RENAME TO universal_v1_change_order_recovery_revocation_reason_pre_expiry_v7;
  END IF;
END;
$$;

ALTER FUNCTION public.universal_v1_change_order_recovery_revocation_reason_pre_expiry_v7(UUID)
  SET search_path = pg_catalog, public;

CREATE OR REPLACE FUNCTION public.universal_v1_change_order_recovery_revocation_reason_v1(
  checked_proposal_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
PARALLEL UNSAFE
SET search_path = pg_catalog, public
AS $$
DECLARE
  legacy_reason TEXT;
  observed_at TIMESTAMPTZ;
  security_expiry TIMESTAMPTZ;
BEGIN
  legacy_reason :=
    public.universal_v1_change_order_recovery_revocation_reason_pre_expiry_v7(
      checked_proposal_id
    );
  IF legacy_reason IS NOT NULL THEN
    RETURN legacy_reason;
  END IF;

  observed_at := clock_timestamp();
  SELECT CASE
           WHEN adjustment.id IS NOT NULL THEN adjustment.expires_at
           ELSE public.universal_v1_effective_financial_security_expiry_v1(
             witness.predecessor_event_id
           )
         END
    INTO security_expiry
    FROM public.universal_v1_change_order_materialization_commands witness
    LEFT JOIN public.task_financial_security_events adjustment
      ON adjustment.operation_id = witness.adjustment_operation_id::TEXT
     AND adjustment.idempotency_key = witness.idempotency_key || ':adjust'
     AND adjustment.event_kind = 'ADJUSTMENT_AUTHORIZED'
     AND adjustment.status = 'SUCCEEDED'
     AND adjustment.provider_kind = 'FAKE'
     AND adjustment.expected_version = witness.expected_financial_version + 1
     AND adjustment.task_draft_id = witness.task_draft_id
     AND adjustment.task_id = witness.task_id
     AND adjustment.eligibility_decision_id = witness.eligibility_decision_id
     AND adjustment.scope_version_id = witness.replacement_scope_version_id
     AND adjustment.change_order_id = witness.proposal_id
     AND adjustment.predecessor_event_id = witness.predecessor_event_id
   WHERE witness.proposal_id = checked_proposal_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NOT public.universal_v1_financial_security_is_current_v1(
    security_expiry,
    observed_at
  ) THEN
    RETURN 'FINANCIAL_SECURITY_EXPIRED';
  END IF;
  RETURN NULL;
END;
$$;

ALTER TABLE public.universal_v1_change_order_compensation_commands
  DROP CONSTRAINT IF EXISTS
    universal_v1_change_order_com_authority_revocation_reason_check;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'universal_v1_change_order_compensation_expiry_reason_v9_chk'
       AND conrelid =
         'public.universal_v1_change_order_compensation_commands'::regclass
  ) THEN
    ALTER TABLE public.universal_v1_change_order_compensation_commands
      ADD CONSTRAINT universal_v1_change_order_compensation_expiry_reason_v9_chk
      CHECK (
        authority_revocation_reason IN (
          'PROPOSAL_NOT_APPROVED',
          'TASK_AUTHORITY_REVOKED',
          'CUSTOMER_ACTOR_AUTHORITY_REVOKED',
          'CUSTOMER_APPROVAL_AUTHORITY_REVOKED',
          'PROVIDER_ACTOR_AUTHORITY_REVOKED',
          'PROVIDER_APPROVAL_AUTHORITY_REVOKED',
          'PROVIDER_ELIGIBILITY_REVOKED',
          'EXECUTION_AUTHORITY_REVOKED',
          'WORK_ORDER_TERMINALIZED',
          'FINANCIAL_SECURITY_EXPIRED'
        )
      ) NOT VALID;
  END IF;
END;
$$;
ALTER TABLE public.universal_v1_change_order_compensation_commands
  VALIDATE CONSTRAINT universal_v1_change_order_compensation_expiry_reason_v9_chk;

ALTER TABLE public.universal_v1_change_order_recovery_terminal_facts
  DROP CONSTRAINT IF EXISTS
    universal_v1_change_order_rec_authority_revocation_reason_check;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'universal_v1_change_order_terminal_expiry_reason_v9_chk'
       AND conrelid =
         'public.universal_v1_change_order_recovery_terminal_facts'::regclass
  ) THEN
    ALTER TABLE public.universal_v1_change_order_recovery_terminal_facts
      ADD CONSTRAINT universal_v1_change_order_terminal_expiry_reason_v9_chk
      CHECK (
        authority_revocation_reason IS NULL
        OR authority_revocation_reason IN (
          'PROPOSAL_NOT_APPROVED',
          'TASK_AUTHORITY_REVOKED',
          'CUSTOMER_ACTOR_AUTHORITY_REVOKED',
          'CUSTOMER_APPROVAL_AUTHORITY_REVOKED',
          'PROVIDER_ACTOR_AUTHORITY_REVOKED',
          'PROVIDER_APPROVAL_AUTHORITY_REVOKED',
          'PROVIDER_ELIGIBILITY_REVOKED',
          'EXECUTION_AUTHORITY_REVOKED',
          'AMENDMENT_CHAIN_CHANGED',
          'FINANCIAL_CHAIN_CHANGED',
          'WORK_ORDER_TERMINALIZED',
          'FINANCIAL_SECURITY_EXPIRED'
        )
      ) NOT VALID;
  END IF;
END;
$$;
ALTER TABLE public.universal_v1_change_order_recovery_terminal_facts
  VALIDATE CONSTRAINT universal_v1_change_order_terminal_expiry_reason_v9_chk;

CREATE TABLE IF NOT EXISTS public.hxos_fake_financial_schema_evidence_v9 (
  migration_name TEXT PRIMARY KEY CHECK (
    migration_name = '20261010_universal_v1_fake_financial_expiry_v9'
  ),
  migration_sql_sha256 CHAR(64) NOT NULL CHECK (
    migration_sql_sha256 ~ '^[0-9a-f]{64}$'
  ),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

DROP TRIGGER IF EXISTS hxos_fake_financial_schema_evidence_append_only_v9
  ON public.hxos_fake_financial_schema_evidence_v9;
CREATE TRIGGER hxos_fake_financial_schema_evidence_append_only_v9
BEFORE UPDATE OR DELETE ON public.hxos_fake_financial_schema_evidence_v9
FOR EACH ROW EXECUTE FUNCTION public.hxos_reject_fake_financial_mutation_v1();

DROP TRIGGER IF EXISTS hxos_fake_financial_schema_evidence_no_truncate_v9
  ON public.hxos_fake_financial_schema_evidence_v9;
CREATE TRIGGER hxos_fake_financial_schema_evidence_no_truncate_v9
BEFORE TRUNCATE ON public.hxos_fake_financial_schema_evidence_v9
FOR EACH STATEMENT EXECUTE FUNCTION public.hxos_reject_fake_financial_mutation_v1();

ALTER TABLE public.hxos_fake_financial_operation_events_v1
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Pre-v9 fake security successes have an immutable provider occurrence but no
-- provider-authored expiry. Preserve that truth without synthesizing a TTL:
-- each such row is retired from positive use under one append-only disposition.
-- Exact recovery may observe the committed fake effect; it may never turn this
-- disposition into AUTHORIZED/SECURED/ADJUSTMENT_AUTHORIZED authority.
CREATE TABLE IF NOT EXISTS public.hxos_fake_financial_legacy_expiry_dispositions_v9 (
  fake_operation_event_id UUID PRIMARY KEY
    REFERENCES public.hxos_fake_financial_operation_events_v1(event_id)
    ON DELETE RESTRICT,
  operation_id UUID NOT NULL,
  operation_kind TEXT NOT NULL CHECK (
    operation_kind IN ('AUTHORIZE', 'SECURE', 'ADJUST')
  ),
  provider_state TEXT NOT NULL CHECK (provider_state = 'SUCCEEDED'),
  provider_recorded_at TIMESTAMPTZ NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition = 'LEGACY_EXPIRY_UNPROVEN'),
  recovery_state TEXT NOT NULL CHECK (
    recovery_state IN ('EXACT_REPLAY_ONLY', 'COMPENSATION_REQUIRED')
  ),
  recovery_terminal BOOLEAN NOT NULL CHECK (
    recovery_terminal = (recovery_state = 'EXACT_REPLAY_ONLY')
  ),
  recovery_retryable BOOLEAN NOT NULL CHECK (
    recovery_retryable = (recovery_state = 'COMPENSATION_REQUIRED')
  ),
  classified_at TIMESTAMPTZ NOT NULL CHECK (classified_at >= provider_recorded_at),
  authority_sha256 CHAR(64) NOT NULL CHECK (
    authority_sha256 ~ '^[0-9a-f]{64}$'
  )
);

CREATE OR REPLACE FUNCTION public.validate_fake_financial_legacy_expiry_disposition_v9()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  raw public.hxos_fake_financial_operation_events_v1%ROWTYPE;
  exact_authority_sha256 CHAR(64);
  has_existing_canonical_bridge BOOLEAN;
BEGIN
  SELECT *
    INTO raw
    FROM public.hxos_fake_financial_operation_events_v1
   WHERE event_id = NEW.fake_operation_event_id
   FOR SHARE;

  SELECT EXISTS (
    SELECT 1
      FROM public.universal_v1_fake_financial_lifecycle_bridges bridge
      JOIN public.task_financial_security_events lifecycle
        ON lifecycle.id = bridge.task_financial_security_event_id
     WHERE bridge.fake_operation_event_id = NEW.fake_operation_event_id
       AND lifecycle.provider_kind = 'FAKE'
       AND lifecycle.expires_at IS NULL
       AND lifecycle.occurred_at IS NOT DISTINCT FROM raw.recorded_at
  ) INTO has_existing_canonical_bridge;

  IF raw.event_id IS NULL
     OR raw.state <> 'SUCCEEDED'
     OR raw.operation_kind NOT IN ('AUTHORIZE', 'SECURE', 'ADJUST')
     OR raw.expires_at IS NOT NULL
     OR NEW.operation_id IS DISTINCT FROM raw.operation_id
     OR NEW.operation_kind IS DISTINCT FROM raw.operation_kind
     OR NEW.provider_state IS DISTINCT FROM raw.state
     OR NEW.provider_recorded_at IS DISTINCT FROM raw.recorded_at
     OR NEW.disposition <> 'LEGACY_EXPIRY_UNPROVEN'
     OR NEW.recovery_state IS DISTINCT FROM (
          CASE
            WHEN has_existing_canonical_bridge THEN 'EXACT_REPLAY_ONLY'
            ELSE 'COMPENSATION_REQUIRED'
          END
        )
     OR NEW.recovery_terminal IS DISTINCT FROM
          (NEW.recovery_state = 'EXACT_REPLAY_ONLY')
     OR NEW.recovery_retryable IS DISTINCT FROM
          (NEW.recovery_state = 'COMPENSATION_REQUIRED')
     OR NEW.classified_at < raw.recorded_at THEN
    RAISE EXCEPTION 'HXUV1-FSE-V9-8: legacy expiry disposition is not exact bounded provider truth'
      USING ERRCODE = 'P0001';
  END IF;

  exact_authority_sha256 := encode(
    digest(
      NEW.fake_operation_event_id::TEXT || ':' ||
      raw.operation_id::TEXT || ':' ||
      raw.operation_kind || ':' ||
      raw.state || ':' ||
      ((extract(epoch FROM raw.recorded_at) * 1000000)::BIGINT)::TEXT || ':' ||
      raw.identity_sha256 || ':' ||
      raw.request_sha256 || ':' ||
      raw.response_sha256 || ':' ||
      NEW.disposition || ':' ||
      NEW.recovery_state || ':' ||
      NEW.recovery_terminal::TEXT || ':' ||
      NEW.recovery_retryable::TEXT || ':' ||
      ((extract(epoch FROM NEW.classified_at) * 1000000)::BIGINT)::TEXT,
      'sha256'
    ),
    'hex'
  );
  IF NEW.authority_sha256 IS DISTINCT FROM exact_authority_sha256 THEN
    RAISE EXCEPTION 'HXUV1-FSE-V9-9: legacy expiry disposition digest is not exact'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_fake_financial_legacy_expiry_disposition_v9
  ON public.hxos_fake_financial_legacy_expiry_dispositions_v9;
CREATE TRIGGER validate_fake_financial_legacy_expiry_disposition_v9
BEFORE INSERT ON public.hxos_fake_financial_legacy_expiry_dispositions_v9
FOR EACH ROW
EXECUTE FUNCTION public.validate_fake_financial_legacy_expiry_disposition_v9();

WITH migration_observation AS (
  SELECT date_trunc('milliseconds', clock_timestamp()) AS classified_at
), legacy AS (
  SELECT raw.*, migration_observation.classified_at,
         CASE
           WHEN EXISTS (
             SELECT 1
               FROM public.universal_v1_fake_financial_lifecycle_bridges bridge
               JOIN public.task_financial_security_events lifecycle
                 ON lifecycle.id = bridge.task_financial_security_event_id
              WHERE bridge.fake_operation_event_id = raw.event_id
                AND lifecycle.provider_kind = 'FAKE'
                AND lifecycle.expires_at IS NULL
                AND lifecycle.occurred_at IS NOT DISTINCT FROM raw.recorded_at
           ) THEN 'EXACT_REPLAY_ONLY'
           ELSE 'COMPENSATION_REQUIRED'
         END AS recovery_state
    FROM public.hxos_fake_financial_operation_events_v1 raw
    CROSS JOIN migration_observation
   WHERE raw.state = 'SUCCEEDED'
     AND raw.operation_kind IN ('AUTHORIZE', 'SECURE', 'ADJUST')
     AND raw.expires_at IS NULL
)
INSERT INTO public.hxos_fake_financial_legacy_expiry_dispositions_v9 (
  fake_operation_event_id, operation_id, operation_kind, provider_state,
  provider_recorded_at, disposition, recovery_state, recovery_terminal,
  recovery_retryable, classified_at,
  authority_sha256
)
SELECT event_id, operation_id, operation_kind, state, recorded_at,
       'LEGACY_EXPIRY_UNPROVEN', recovery_state,
       recovery_state = 'EXACT_REPLAY_ONLY',
       recovery_state = 'COMPENSATION_REQUIRED',
       classified_at,
       encode(
         digest(
           event_id::TEXT || ':' || operation_id::TEXT || ':' ||
           operation_kind || ':' || state || ':' ||
           ((extract(epoch FROM recorded_at) * 1000000)::BIGINT)::TEXT || ':' ||
           identity_sha256 || ':' || request_sha256 || ':' || response_sha256 || ':' ||
           'LEGACY_EXPIRY_UNPROVEN:' || recovery_state || ':' ||
           (recovery_state = 'EXACT_REPLAY_ONLY')::TEXT || ':' ||
           (recovery_state = 'COMPENSATION_REQUIRED')::TEXT || ':' ||
           ((extract(epoch FROM classified_at) * 1000000)::BIGINT)::TEXT,
           'sha256'
         ),
         'hex'
       )
  FROM legacy
ON CONFLICT (fake_operation_event_id) DO NOTHING;

DROP TRIGGER IF EXISTS hxos_fake_financial_legacy_expiry_append_only_v9
  ON public.hxos_fake_financial_legacy_expiry_dispositions_v9;
CREATE TRIGGER hxos_fake_financial_legacy_expiry_append_only_v9
BEFORE UPDATE OR DELETE ON public.hxos_fake_financial_legacy_expiry_dispositions_v9
FOR EACH ROW EXECUTE FUNCTION public.hxos_reject_fake_financial_mutation_v1();

DROP TRIGGER IF EXISTS hxos_fake_financial_legacy_expiry_no_truncate_v9
  ON public.hxos_fake_financial_legacy_expiry_dispositions_v9;
CREATE TRIGGER hxos_fake_financial_legacy_expiry_no_truncate_v9
BEFORE TRUNCATE ON public.hxos_fake_financial_legacy_expiry_dispositions_v9
FOR EACH STATEMENT EXECUTE FUNCTION public.hxos_reject_fake_financial_mutation_v1();

CREATE OR REPLACE FUNCTION public.legacy_fake_expiry_compensation_operation_id_v9(
  source_event_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
DECLARE
  exact_hex TEXT;
BEGIN
  exact_hex := encode(
    digest(
      'hustlexp:legacy-fake-expiry-compensation:v9:' || lower(source_event_id::TEXT),
      'sha256'
    ),
    'hex'
  );
  RETURN (
    substring(exact_hex FROM 1 FOR 8) || '-' ||
    substring(exact_hex FROM 9 FOR 4) || '-4' ||
    substring(exact_hex FROM 14 FOR 3) || '-8' ||
    substring(exact_hex FROM 18 FOR 3) || '-' ||
    substring(exact_hex FROM 21 FOR 12)
  )::UUID;
END;
$$;

CREATE TABLE IF NOT EXISTS public.hxos_fake_financial_legacy_expiry_compensation_commands_v9 (
  command_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_fake_operation_event_id UUID NOT NULL UNIQUE
    REFERENCES public.hxos_fake_financial_legacy_expiry_dispositions_v9(
      fake_operation_event_id
    ) ON DELETE RESTRICT,
  compensation_operation_id UUID NOT NULL UNIQUE,
  compensation_operation_kind TEXT NOT NULL CHECK (
    compensation_operation_kind IN ('VOID', 'REVERSAL')
  ),
  compensation_idempotency_key TEXT NOT NULL UNIQUE,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  provider_request_sha256 CHAR(64) NOT NULL CHECK (
    provider_request_sha256 ~ '^[0-9a-f]{64}$'
  ),
  command_identity_sha256 CHAR(64) NOT NULL CHECK (
    command_identity_sha256 ~ '^[0-9a-f]{64}$'
  ),
  requested_at TIMESTAMPTZ NOT NULL
);

CREATE OR REPLACE FUNCTION public.prepare_fake_financial_legacy_expiry_compensation_v9()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  disposition public.hxos_fake_financial_legacy_expiry_dispositions_v9%ROWTYPE;
  source_event public.hxos_fake_financial_operation_events_v1%ROWTYPE;
BEGIN
  SELECT * INTO disposition
    FROM public.hxos_fake_financial_legacy_expiry_dispositions_v9
   WHERE fake_operation_event_id = NEW.source_fake_operation_event_id
   FOR SHARE;
  SELECT * INTO source_event
    FROM public.hxos_fake_financial_operation_events_v1
   WHERE event_id = NEW.source_fake_operation_event_id
   FOR SHARE;
  IF disposition.recovery_state IS DISTINCT FROM 'COMPENSATION_REQUIRED'
     OR disposition.recovery_terminal
     OR NOT disposition.recovery_retryable
     OR source_event.event_id IS NULL
     OR source_event.amount_cents IS NULL
     OR source_event.currency IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FSE-V9-14: only exact raw-only legacy security can prepare compensation'
      USING ERRCODE = 'P0001';
  END IF;
  NEW.compensation_operation_id :=
    public.legacy_fake_expiry_compensation_operation_id_v9(source_event.event_id);
  NEW.compensation_operation_kind := CASE
    WHEN source_event.operation_kind IN ('AUTHORIZE', 'SECURE') THEN 'VOID'
    WHEN source_event.operation_kind = 'ADJUST' THEN 'REVERSAL'
    ELSE NULL
  END;
  NEW.compensation_idempotency_key :=
    'legacy-expiry-compensation:v9:' || source_event.event_id::TEXT;
  NEW.amount_cents := source_event.amount_cents;
  NEW.currency := source_event.currency;
  NEW.requested_at := date_trunc('milliseconds', clock_timestamp());
  NEW.command_identity_sha256 := encode(
    digest(
      NEW.command_id::TEXT || ':' || source_event.event_id::TEXT || ':' ||
      NEW.compensation_operation_id::TEXT || ':' ||
      NEW.compensation_operation_kind || ':' ||
      NEW.compensation_idempotency_key || ':' ||
      NEW.amount_cents::TEXT || ':' || NEW.currency || ':' ||
      NEW.provider_request_sha256 || ':' ||
      ((extract(epoch FROM NEW.requested_at) * 1000000)::BIGINT)::TEXT,
      'sha256'
    ),
    'hex'
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prepare_fake_financial_legacy_expiry_compensation_v9
  ON public.hxos_fake_financial_legacy_expiry_compensation_commands_v9;
CREATE TRIGGER prepare_fake_financial_legacy_expiry_compensation_v9
BEFORE INSERT ON public.hxos_fake_financial_legacy_expiry_compensation_commands_v9
FOR EACH ROW EXECUTE FUNCTION public.prepare_fake_financial_legacy_expiry_compensation_v9();

CREATE TABLE IF NOT EXISTS public.hxos_fake_financial_legacy_expiry_compensation_attempts_v9 (
  dispatch_attempt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id UUID NOT NULL UNIQUE
    REFERENCES public.hxos_fake_financial_legacy_expiry_compensation_commands_v9(command_id)
    ON DELETE RESTRICT,
  attempted_at TIMESTAMPTZ NOT NULL,
  attempt_identity_sha256 CHAR(64) NOT NULL CHECK (
    attempt_identity_sha256 ~ '^[0-9a-f]{64}$'
  )
);

CREATE OR REPLACE FUNCTION public.prepare_fake_financial_legacy_expiry_attempt_v9()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  command public.hxos_fake_financial_legacy_expiry_compensation_commands_v9%ROWTYPE;
BEGIN
  SELECT * INTO command
    FROM public.hxos_fake_financial_legacy_expiry_compensation_commands_v9
   WHERE command_id = NEW.command_id
   FOR SHARE;
  IF command.command_id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FSE-V9-15: legacy compensation command is missing'
      USING ERRCODE = 'P0001';
  END IF;
  NEW.attempted_at := date_trunc('milliseconds', clock_timestamp());
  NEW.attempt_identity_sha256 := encode(
    digest(
      NEW.dispatch_attempt_id::TEXT || ':' || NEW.command_id::TEXT || ':' ||
      command.command_identity_sha256 || ':' ||
      ((extract(epoch FROM NEW.attempted_at) * 1000000)::BIGINT)::TEXT,
      'sha256'
    ),
    'hex'
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prepare_fake_financial_legacy_expiry_attempt_v9
  ON public.hxos_fake_financial_legacy_expiry_compensation_attempts_v9;
CREATE TRIGGER prepare_fake_financial_legacy_expiry_attempt_v9
BEFORE INSERT ON public.hxos_fake_financial_legacy_expiry_compensation_attempts_v9
FOR EACH ROW EXECUTE FUNCTION public.prepare_fake_financial_legacy_expiry_attempt_v9();

CREATE TABLE IF NOT EXISTS public.hxos_fake_financial_legacy_expiry_compensation_outcomes_v9 (
  outcome_fact_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id UUID NOT NULL UNIQUE
    REFERENCES public.hxos_fake_financial_legacy_expiry_compensation_commands_v9(command_id)
    ON DELETE RESTRICT,
  dispatch_attempt_id UUID NOT NULL UNIQUE
    REFERENCES public.hxos_fake_financial_legacy_expiry_compensation_attempts_v9(
      dispatch_attempt_id
    ) ON DELETE RESTRICT,
  compensation_fake_operation_event_id UUID NOT NULL UNIQUE
    REFERENCES public.hxos_fake_financial_operation_events_v1(event_id)
    ON DELETE RESTRICT,
  provider_state TEXT NOT NULL CHECK (provider_state IN ('VOIDED', 'REVERSED')),
  provider_result_sha256 CHAR(64) NOT NULL CHECK (
    provider_result_sha256 ~ '^[0-9a-f]{64}$'
  ),
  outcome_identity_sha256 CHAR(64) NOT NULL CHECK (
    outcome_identity_sha256 ~ '^[0-9a-f]{64}$'
  ),
  recorded_at TIMESTAMPTZ NOT NULL
);

CREATE OR REPLACE FUNCTION public.validate_fake_financial_legacy_expiry_outcome_v9()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  command public.hxos_fake_financial_legacy_expiry_compensation_commands_v9%ROWTYPE;
  attempt public.hxos_fake_financial_legacy_expiry_compensation_attempts_v9%ROWTYPE;
  provider_event public.hxos_fake_financial_operation_events_v1%ROWTYPE;
BEGIN
  SELECT * INTO command
    FROM public.hxos_fake_financial_legacy_expiry_compensation_commands_v9
   WHERE command_id = NEW.command_id
   FOR SHARE;
  SELECT * INTO attempt
    FROM public.hxos_fake_financial_legacy_expiry_compensation_attempts_v9
   WHERE dispatch_attempt_id = NEW.dispatch_attempt_id
   FOR SHARE;
  SELECT * INTO provider_event
    FROM public.hxos_fake_financial_operation_events_v1
   WHERE event_id = NEW.compensation_fake_operation_event_id
   FOR SHARE;
  IF command.command_id IS NULL
     OR attempt.command_id IS DISTINCT FROM command.command_id
     OR provider_event.event_id IS NULL
     OR provider_event.recorded_at < attempt.attempted_at
     OR provider_event.operation_id IS DISTINCT FROM command.compensation_operation_id
     OR provider_event.operation_kind IS DISTINCT FROM command.compensation_operation_kind
     OR provider_event.idempotency_key IS DISTINCT FROM command.compensation_idempotency_key
     OR provider_event.provider_request_sha256 IS DISTINCT FROM command.provider_request_sha256
     OR provider_event.event_version <> 1
     OR provider_event.scenario <> 'SUCCESS'
     OR provider_event.amount_cents IS DISTINCT FROM command.amount_cents
     OR provider_event.currency IS DISTINCT FROM command.currency
     OR provider_event.expires_at IS NOT NULL
     OR (
       command.compensation_operation_kind = 'VOID'
       AND provider_event.state <> 'VOIDED'
     )
     OR (
       command.compensation_operation_kind = 'REVERSAL'
       AND provider_event.state <> 'REVERSED'
     ) THEN
    RAISE EXCEPTION 'HXUV1-FSE-V9-16: legacy compensation outcome is not exact durable provider truth'
      USING ERRCODE = 'P0001';
  END IF;
  NEW.provider_state := provider_event.state;
  NEW.provider_result_sha256 := encode(
    digest(
      provider_event.operation_id::TEXT || ':' || provider_event.operation_kind || ':' ||
      'FAKE:' || provider_event.state || ':' || provider_event.event_version::TEXT || ':' ||
      provider_event.amount_cents::TEXT || ':' || upper(provider_event.currency) || ':' ||
      encode(digest(provider_event.external_reference, 'sha256'), 'hex') || ':false',
      'sha256'
    ),
    'hex'
  );
  NEW.recorded_at := date_trunc('milliseconds', clock_timestamp());
  NEW.outcome_identity_sha256 := encode(
    digest(
      NEW.outcome_fact_id::TEXT || ':' || command.command_id::TEXT || ':' ||
      attempt.dispatch_attempt_id::TEXT || ':' || provider_event.event_id::TEXT || ':' ||
      command.command_identity_sha256 || ':' || attempt.attempt_identity_sha256 || ':' ||
      NEW.provider_result_sha256 || ':' ||
      ((extract(epoch FROM NEW.recorded_at) * 1000000)::BIGINT)::TEXT,
      'sha256'
    ),
    'hex'
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_fake_financial_legacy_expiry_outcome_v9
  ON public.hxos_fake_financial_legacy_expiry_compensation_outcomes_v9;
CREATE TRIGGER validate_fake_financial_legacy_expiry_outcome_v9
BEFORE INSERT ON public.hxos_fake_financial_legacy_expiry_compensation_outcomes_v9
FOR EACH ROW EXECUTE FUNCTION public.validate_fake_financial_legacy_expiry_outcome_v9();

DROP TRIGGER IF EXISTS hxuv1_legacy_comp_command_append_only_v9
  ON public.hxos_fake_financial_legacy_expiry_compensation_commands_v9;
CREATE TRIGGER hxuv1_legacy_comp_command_append_only_v9
BEFORE UPDATE OR DELETE
ON public.hxos_fake_financial_legacy_expiry_compensation_commands_v9
FOR EACH ROW EXECUTE FUNCTION public.hxos_reject_fake_financial_mutation_v1();
DROP TRIGGER IF EXISTS hxuv1_legacy_comp_command_no_truncate_v9
  ON public.hxos_fake_financial_legacy_expiry_compensation_commands_v9;
CREATE TRIGGER hxuv1_legacy_comp_command_no_truncate_v9
BEFORE TRUNCATE
ON public.hxos_fake_financial_legacy_expiry_compensation_commands_v9
FOR EACH STATEMENT EXECUTE FUNCTION public.hxos_reject_fake_financial_mutation_v1();

DROP TRIGGER IF EXISTS hxuv1_legacy_comp_attempt_append_only_v9
  ON public.hxos_fake_financial_legacy_expiry_compensation_attempts_v9;
CREATE TRIGGER hxuv1_legacy_comp_attempt_append_only_v9
BEFORE UPDATE OR DELETE
ON public.hxos_fake_financial_legacy_expiry_compensation_attempts_v9
FOR EACH ROW EXECUTE FUNCTION public.hxos_reject_fake_financial_mutation_v1();
DROP TRIGGER IF EXISTS hxuv1_legacy_comp_attempt_no_truncate_v9
  ON public.hxos_fake_financial_legacy_expiry_compensation_attempts_v9;
CREATE TRIGGER hxuv1_legacy_comp_attempt_no_truncate_v9
BEFORE TRUNCATE
ON public.hxos_fake_financial_legacy_expiry_compensation_attempts_v9
FOR EACH STATEMENT EXECUTE FUNCTION public.hxos_reject_fake_financial_mutation_v1();

DROP TRIGGER IF EXISTS hxuv1_legacy_comp_outcome_append_only_v9
  ON public.hxos_fake_financial_legacy_expiry_compensation_outcomes_v9;
CREATE TRIGGER hxuv1_legacy_comp_outcome_append_only_v9
BEFORE UPDATE OR DELETE
ON public.hxos_fake_financial_legacy_expiry_compensation_outcomes_v9
FOR EACH ROW EXECUTE FUNCTION public.hxos_reject_fake_financial_mutation_v1();
DROP TRIGGER IF EXISTS hxuv1_legacy_comp_outcome_no_truncate_v9
  ON public.hxos_fake_financial_legacy_expiry_compensation_outcomes_v9;
CREATE TRIGGER hxuv1_legacy_comp_outcome_no_truncate_v9
BEFORE TRUNCATE
ON public.hxos_fake_financial_legacy_expiry_compensation_outcomes_v9
FOR EACH STATEMENT EXECUTE FUNCTION public.hxos_reject_fake_financial_mutation_v1();

-- A raw-only legacy success is a confirmed fake effect, not positive lifecycle
-- authority. It becomes terminal only after an exact compensating fake event is
-- durably bridged here: VOID for AUTHORIZE/SECURE, REVERSAL for ADJUST.
CREATE TABLE IF NOT EXISTS public.hxos_fake_financial_legacy_expiry_compensations_v9 (
  source_fake_operation_event_id UUID PRIMARY KEY
    REFERENCES public.hxos_fake_financial_legacy_expiry_dispositions_v9(
      fake_operation_event_id
    ) ON DELETE RESTRICT,
  compensation_fake_operation_event_id UUID NOT NULL UNIQUE
    REFERENCES public.hxos_fake_financial_operation_events_v1(event_id)
    ON DELETE RESTRICT,
  compensation_command_id UUID NOT NULL UNIQUE
    REFERENCES public.hxos_fake_financial_legacy_expiry_compensation_commands_v9(command_id)
    ON DELETE RESTRICT,
  dispatch_attempt_id UUID NOT NULL UNIQUE
    REFERENCES public.hxos_fake_financial_legacy_expiry_compensation_attempts_v9(
      dispatch_attempt_id
    ) ON DELETE RESTRICT,
  outcome_fact_id UUID NOT NULL UNIQUE
    REFERENCES public.hxos_fake_financial_legacy_expiry_compensation_outcomes_v9(outcome_fact_id)
    ON DELETE RESTRICT,
  source_operation_id UUID NOT NULL,
  source_operation_kind TEXT NOT NULL CHECK (
    source_operation_kind IN ('AUTHORIZE', 'SECURE', 'ADJUST')
  ),
  compensation_operation_id UUID NOT NULL UNIQUE,
  compensation_operation_kind TEXT NOT NULL CHECK (
    compensation_operation_kind IN ('VOID', 'REVERSAL')
  ),
  compensation_provider_state TEXT NOT NULL CHECK (
    compensation_provider_state IN ('VOIDED', 'REVERSED')
  ),
  compensation_idempotency_key TEXT NOT NULL UNIQUE,
  source_recorded_at TIMESTAMPTZ NOT NULL,
  compensation_recorded_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ NOT NULL,
  authority_sha256 CHAR(64) NOT NULL CHECK (
    authority_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CHECK (compensation_recorded_at >= source_recorded_at),
  CHECK (closed_at >= compensation_recorded_at)
);

CREATE OR REPLACE FUNCTION public.validate_fake_financial_legacy_expiry_compensation_v9()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  disposition public.hxos_fake_financial_legacy_expiry_dispositions_v9%ROWTYPE;
  source_event public.hxos_fake_financial_operation_events_v1%ROWTYPE;
  compensation_event public.hxos_fake_financial_operation_events_v1%ROWTYPE;
  command public.hxos_fake_financial_legacy_expiry_compensation_commands_v9%ROWTYPE;
  attempt public.hxos_fake_financial_legacy_expiry_compensation_attempts_v9%ROWTYPE;
  outcome public.hxos_fake_financial_legacy_expiry_compensation_outcomes_v9%ROWTYPE;
  expected_compensation_kind TEXT;
  expected_compensation_state TEXT;
  expected_idempotency_key TEXT;
BEGIN
  SELECT * INTO disposition
    FROM public.hxos_fake_financial_legacy_expiry_dispositions_v9
   WHERE fake_operation_event_id = NEW.source_fake_operation_event_id
   FOR SHARE;
  SELECT * INTO source_event
    FROM public.hxos_fake_financial_operation_events_v1
   WHERE event_id = NEW.source_fake_operation_event_id
   FOR SHARE;
  SELECT * INTO compensation_event
    FROM public.hxos_fake_financial_operation_events_v1
   WHERE event_id = NEW.compensation_fake_operation_event_id
   FOR SHARE;
  SELECT * INTO command
    FROM public.hxos_fake_financial_legacy_expiry_compensation_commands_v9
   WHERE command_id = NEW.compensation_command_id
   FOR SHARE;
  SELECT * INTO attempt
    FROM public.hxos_fake_financial_legacy_expiry_compensation_attempts_v9
   WHERE dispatch_attempt_id = NEW.dispatch_attempt_id
   FOR SHARE;
  SELECT * INTO outcome
    FROM public.hxos_fake_financial_legacy_expiry_compensation_outcomes_v9
   WHERE outcome_fact_id = NEW.outcome_fact_id
   FOR SHARE;

  expected_compensation_kind := CASE
    WHEN source_event.operation_kind IN ('AUTHORIZE', 'SECURE') THEN 'VOID'
    WHEN source_event.operation_kind = 'ADJUST' THEN 'REVERSAL'
    ELSE NULL
  END;
  expected_compensation_state := CASE
    WHEN expected_compensation_kind = 'VOID' THEN 'VOIDED'
    WHEN expected_compensation_kind = 'REVERSAL' THEN 'REVERSED'
    ELSE NULL
  END;
  expected_idempotency_key :=
    'legacy-expiry-compensation:v9:' || source_event.event_id::TEXT;

  IF disposition.fake_operation_event_id IS NULL
     OR disposition.disposition <> 'LEGACY_EXPIRY_UNPROVEN'
     OR disposition.recovery_state <> 'COMPENSATION_REQUIRED'
     OR disposition.recovery_terminal
     OR NOT disposition.recovery_retryable
     OR source_event.event_id IS NULL
     OR compensation_event.event_id IS NULL
     OR command.source_fake_operation_event_id IS DISTINCT FROM source_event.event_id
     OR command.compensation_operation_id IS DISTINCT FROM compensation_event.operation_id
     OR attempt.command_id IS DISTINCT FROM command.command_id
     OR outcome.command_id IS DISTINCT FROM command.command_id
     OR outcome.dispatch_attempt_id IS DISTINCT FROM attempt.dispatch_attempt_id
     OR outcome.compensation_fake_operation_event_id IS DISTINCT FROM compensation_event.event_id
     OR compensation_event.operation_kind IS DISTINCT FROM expected_compensation_kind
     OR compensation_event.state IS DISTINCT FROM expected_compensation_state
     OR compensation_event.scenario <> 'SUCCESS'
     OR compensation_event.event_version <> 1
     OR compensation_event.related_operation_id IS DISTINCT FROM source_event.operation_id
     OR compensation_event.amount_cents IS DISTINCT FROM source_event.amount_cents
     OR compensation_event.currency IS DISTINCT FROM source_event.currency
     OR compensation_event.idempotency_key IS DISTINCT FROM expected_idempotency_key
     OR compensation_event.expires_at IS NOT NULL THEN
    RAISE EXCEPTION 'HXUV1-FSE-V9-10: legacy expiry compensation is not the exact bounded fake recovery event'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.source_operation_id IS NOT NULL
     AND NEW.source_operation_id IS DISTINCT FROM source_event.operation_id THEN
    RAISE EXCEPTION 'HXUV1-FSE-V9-11: supplied legacy source identity differs from provider truth'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.compensation_operation_id IS NOT NULL
     AND NEW.compensation_operation_id IS DISTINCT FROM compensation_event.operation_id THEN
    RAISE EXCEPTION 'HXUV1-FSE-V9-12: supplied legacy compensation identity differs from provider truth'
      USING ERRCODE = 'P0001';
  END IF;

  NEW.source_operation_id := source_event.operation_id;
  NEW.source_operation_kind := source_event.operation_kind;
  NEW.compensation_operation_id := compensation_event.operation_id;
  NEW.compensation_operation_kind := compensation_event.operation_kind;
  NEW.compensation_provider_state := compensation_event.state;
  NEW.compensation_idempotency_key := compensation_event.idempotency_key;
  NEW.source_recorded_at := source_event.recorded_at;
  NEW.compensation_recorded_at := compensation_event.recorded_at;
  NEW.closed_at := COALESCE(
    NEW.closed_at,
    date_trunc('milliseconds', clock_timestamp())
  );
  IF NEW.closed_at < compensation_event.recorded_at THEN
    RAISE EXCEPTION 'HXUV1-FSE-V9-13: legacy compensation closure predates provider truth'
      USING ERRCODE = 'P0001';
  END IF;
  NEW.authority_sha256 := encode(
    digest(
      source_event.event_id::TEXT || ':' ||
      source_event.operation_id::TEXT || ':' ||
      source_event.operation_kind || ':' ||
      compensation_event.event_id::TEXT || ':' ||
      compensation_event.operation_id::TEXT || ':' ||
      compensation_event.operation_kind || ':' ||
      compensation_event.state || ':' ||
      compensation_event.idempotency_key || ':' ||
      command.command_id::TEXT || ':' || command.command_identity_sha256 || ':' ||
      attempt.dispatch_attempt_id::TEXT || ':' || attempt.attempt_identity_sha256 || ':' ||
      outcome.outcome_fact_id::TEXT || ':' || outcome.outcome_identity_sha256 || ':' ||
      ((extract(epoch FROM source_event.recorded_at) * 1000000)::BIGINT)::TEXT || ':' ||
      ((extract(epoch FROM compensation_event.recorded_at) * 1000000)::BIGINT)::TEXT || ':' ||
      ((extract(epoch FROM NEW.closed_at) * 1000000)::BIGINT)::TEXT,
      'sha256'
    ),
    'hex'
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_fake_financial_legacy_expiry_compensation_v9
  ON public.hxos_fake_financial_legacy_expiry_compensations_v9;
CREATE TRIGGER validate_fake_financial_legacy_expiry_compensation_v9
BEFORE INSERT ON public.hxos_fake_financial_legacy_expiry_compensations_v9
FOR EACH ROW
EXECUTE FUNCTION public.validate_fake_financial_legacy_expiry_compensation_v9();

DROP TRIGGER IF EXISTS hxos_fake_financial_legacy_compensation_append_only_v9
  ON public.hxos_fake_financial_legacy_expiry_compensations_v9;
CREATE TRIGGER hxos_fake_financial_legacy_compensation_append_only_v9
BEFORE UPDATE OR DELETE ON public.hxos_fake_financial_legacy_expiry_compensations_v9
FOR EACH ROW EXECUTE FUNCTION public.hxos_reject_fake_financial_mutation_v1();

DROP TRIGGER IF EXISTS hxos_fake_financial_legacy_compensation_no_truncate_v9
  ON public.hxos_fake_financial_legacy_expiry_compensations_v9;
CREATE TRIGGER hxos_fake_financial_legacy_compensation_no_truncate_v9
BEFORE TRUNCATE ON public.hxos_fake_financial_legacy_expiry_compensations_v9
FOR EACH STATEMENT EXECUTE FUNCTION public.hxos_reject_fake_financial_mutation_v1();

CREATE OR REPLACE FUNCTION public.require_legacy_expiry_compensation_before_terminal_outcome_v9()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
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
            )
          )
     ) THEN
    RAISE EXCEPTION 'HXUV1-FSE-V9-17: raw-only legacy success cannot acquire a contradictory terminal outcome'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_require_legacy_expiry_compensation_v9
  ON public.financial_provider_command_outcome_facts;
CREATE TRIGGER zz_require_legacy_expiry_compensation_v9
BEFORE INSERT ON public.financial_provider_command_outcome_facts
FOR EACH ROW
EXECUTE FUNCTION public.require_legacy_expiry_compensation_before_terminal_outcome_v9();

ALTER TABLE public.universal_v1_fake_financial_lifecycle_bridges
  ADD COLUMN IF NOT EXISTS provider_recorded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expiry_authority_sha256 CHAR(64);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'universal_v1_fake_financial_bridge_expiry_bundle_v9_chk'
       AND conrelid = 'public.universal_v1_fake_financial_lifecycle_bridges'::regclass
  ) THEN
    ALTER TABLE public.universal_v1_fake_financial_lifecycle_bridges
      ADD CONSTRAINT universal_v1_fake_financial_bridge_expiry_bundle_v9_chk CHECK (
        (
          provider_recorded_at IS NULL
          AND provider_expires_at IS NULL
          AND expiry_authority_sha256 IS NULL
        )
        OR
        (
          provider_recorded_at IS NOT NULL
          AND expiry_authority_sha256 ~ '^[0-9a-f]{64}$'
        )
      ) NOT VALID;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'hxos_fake_financial_event_expiry_v9_chk'
       AND conrelid = 'public.hxos_fake_financial_operation_events_v1'::regclass
  ) THEN
    ALTER TABLE public.hxos_fake_financial_operation_events_v1
      ADD CONSTRAINT hxos_fake_financial_event_expiry_v9_chk CHECK (
        (
          state = 'SUCCEEDED'
          AND operation_kind IN ('AUTHORIZE', 'SECURE', 'ADJUST')
          AND expires_at IS NOT NULL
          AND expires_at > recorded_at
        )
        OR
        (
          NOT (
            state = 'SUCCEEDED'
            AND operation_kind IN ('AUTHORIZE', 'SECURE', 'ADJUST')
          )
          AND expires_at IS NULL
        )
      ) NOT VALID;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_fake_expiry_bridge_v9()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  raw_recorded_at TIMESTAMPTZ;
  raw_expiry TIMESTAMPTZ;
  lifecycle_occurred_at TIMESTAMPTZ;
  lifecycle_expiry TIMESTAMPTZ;
  exact_expiry_authority_sha256 CHAR(64);
BEGIN
  SELECT raw.recorded_at, raw.expires_at
    INTO raw_recorded_at, raw_expiry
    FROM public.hxos_fake_financial_operation_events_v1 raw
   WHERE raw.event_id = NEW.fake_operation_event_id
   FOR SHARE;
  SELECT lifecycle.occurred_at, lifecycle.expires_at
    INTO lifecycle_occurred_at, lifecycle_expiry
    FROM public.task_financial_security_events lifecycle
   WHERE lifecycle.id = NEW.task_financial_security_event_id
   FOR SHARE;

  IF raw_recorded_at IS NULL
     OR raw_recorded_at IS DISTINCT FROM lifecycle_occurred_at
     OR raw_expiry IS DISTINCT FROM lifecycle_expiry THEN
    RAISE EXCEPTION 'HXUV1-FSE-V9-1: canonical provider time and expiry are not the exact raw fake-provider facts'
      USING ERRCODE = 'P0001';
  END IF;

  exact_expiry_authority_sha256 := encode(
    digest(
      NEW.fake_operation_event_id::TEXT || ':' ||
      NEW.task_financial_security_event_id::TEXT || ':' ||
      ((extract(epoch FROM raw_recorded_at) * 1000000)::BIGINT)::TEXT || ':' ||
      COALESCE(
        ((extract(epoch FROM raw_expiry) * 1000000)::BIGINT)::TEXT,
        'NO_EXPIRY'
      ),
      'sha256'
    ),
    'hex'
  );

  IF NEW.provider_recorded_at IS NOT NULL
     AND NEW.provider_recorded_at IS DISTINCT FROM raw_recorded_at THEN
    RAISE EXCEPTION 'HXUV1-FSE-V9-2: bridge provider occurrence differs from raw provider truth'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.provider_expires_at IS NOT NULL
     AND NEW.provider_expires_at IS DISTINCT FROM raw_expiry THEN
    RAISE EXCEPTION 'HXUV1-FSE-V9-3: bridge provider expiry differs from raw provider truth'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.expiry_authority_sha256 IS NOT NULL
     AND NEW.expiry_authority_sha256 IS DISTINCT FROM exact_expiry_authority_sha256 THEN
    RAISE EXCEPTION 'HXUV1-FSE-V9-4: bridge expiry authority digest differs from exact facts'
      USING ERRCODE = 'P0001';
  END IF;

  NEW.provider_recorded_at := raw_recorded_at;
  NEW.provider_expires_at := raw_expiry;
  NEW.expiry_authority_sha256 := exact_expiry_authority_sha256;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_universal_v1_fake_expiry_bridge_v9
  ON public.universal_v1_fake_financial_lifecycle_bridges;
CREATE TRIGGER zz_universal_v1_fake_expiry_bridge_v9
BEFORE INSERT ON public.universal_v1_fake_financial_lifecycle_bridges
FOR EACH ROW
EXECUTE FUNCTION public.enforce_universal_v1_fake_expiry_bridge_v9();

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_change_order_predecessor_expiry_v9()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  predecessor_expiry TIMESTAMPTZ;
BEGIN
  SELECT public.universal_v1_effective_financial_security_expiry_v1(
           NEW.predecessor_event_id
         )
    INTO predecessor_expiry
  ;

  IF NOT public.universal_v1_financial_security_is_current_v1(
    predecessor_expiry,
    NEW.prepared_at
  ) THEN
    RAISE EXCEPTION 'HXUV1-FSE-V9-5: expired financial security cannot prepare a change order'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS v_universal_v1_change_order_predecessor_expiry_v9
  ON public.universal_v1_change_order_materialization_commands;
CREATE TRIGGER v_universal_v1_change_order_predecessor_expiry_v9
BEFORE INSERT ON public.universal_v1_change_order_materialization_commands
FOR EACH ROW
EXECUTE FUNCTION public.enforce_universal_v1_change_order_predecessor_expiry_v9();

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_terminal_intent_expiry_v9()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  starting_expiry TIMESTAMPTZ;
BEGIN
  SELECT financial.expires_at
    INTO starting_expiry
    FROM public.task_financial_security_events financial
   WHERE financial.id = NEW.starting_financial_event_id
   FOR SHARE;

  IF NOT public.universal_v1_financial_security_is_current_v1(
    starting_expiry,
    NEW.materialized_at
  ) THEN
    RAISE EXCEPTION 'HXUV1-FSE-V9-6: expired financial security cannot create a terminal lifecycle intent'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS v_universal_v1_terminal_intent_expiry_v9
  ON public.universal_v1_fake_terminal_lifecycle_intents;
CREATE TRIGGER v_universal_v1_terminal_intent_expiry_v9
BEFORE INSERT ON public.universal_v1_fake_terminal_lifecycle_intents
FOR EACH ROW
EXECUTE FUNCTION public.enforce_universal_v1_terminal_intent_expiry_v9();

COMMENT ON COLUMN public.hxos_fake_financial_operation_events_v1.expires_at IS
  'Exact fake-provider expiry derived with recorded_at from one provider repository observation. NULL for every non-security or non-success result.';
COMMENT ON TABLE public.hxos_fake_financial_legacy_expiry_dispositions_v9 IS
  'Append-only classification for pre-v9 successful fake security events whose provider-authored expiry is permanently unproven. Existing canonical bridges are replay-only; raw-only effects require exact fake compensation. These rows grant zero positive-use authority.';
COMMENT ON TABLE public.hxos_fake_financial_legacy_expiry_compensations_v9 IS
  'Append-only terminal bridge from a raw-only legacy expiry-unproven fake security effect to its exact fake VOID or REVERSAL containment event.';
COMMENT ON TABLE public.hxos_fake_financial_legacy_expiry_compensation_commands_v9 IS
  'Sealed fake-only recovery command prepared before any adapter entry for one raw-only legacy expiry-unproven effect.';
COMMENT ON TABLE public.hxos_fake_financial_legacy_expiry_compensation_attempts_v9 IS
  'Append-only DISPATCH_ATTEMPTED boundary for one sealed legacy expiry compensation command.';
COMMENT ON TABLE public.hxos_fake_financial_legacy_expiry_compensation_outcomes_v9 IS
  'Append-only exact OUTCOME_OBSERVED fact binding a legacy compensation attempt to its immutable fake-provider event.';
COMMENT ON COLUMN public.universal_v1_fake_financial_lifecycle_bridges.provider_recorded_at IS
  'Immutable exact raw fake-provider recorded_at copied by the v9 bridge guard.';
COMMENT ON COLUMN public.universal_v1_fake_financial_lifecycle_bridges.provider_expires_at IS
  'Immutable exact raw fake-provider expiry copied by the v9 bridge guard; NULL for non-security results.';
COMMENT ON COLUMN public.universal_v1_fake_financial_lifecycle_bridges.expiry_authority_sha256 IS
  'SHA-256 binding fake event, canonical event, provider occurrence, and provider expiry with timestamps encoded as timezone-independent epoch microseconds.';
COMMENT ON TABLE public.hxos_fake_financial_schema_evidence_v9 IS
  'Append-only proof of fake-provider expiry origin, canonical parity, and supplemental positive-consumer denial.';

REVOKE ALL ON TABLE public.hxos_fake_financial_schema_evidence_v9 FROM PUBLIC;
REVOKE ALL ON TABLE public.hxos_fake_financial_legacy_expiry_dispositions_v9
  FROM PUBLIC;
REVOKE ALL ON TABLE public.hxos_fake_financial_legacy_expiry_compensations_v9
  FROM PUBLIC;
REVOKE ALL ON TABLE public.hxos_fake_financial_legacy_expiry_compensation_commands_v9
  FROM PUBLIC;
REVOKE ALL ON TABLE public.hxos_fake_financial_legacy_expiry_compensation_attempts_v9
  FROM PUBLIC;
REVOKE ALL ON TABLE public.hxos_fake_financial_legacy_expiry_compensation_outcomes_v9
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_fake_financial_legacy_expiry_disposition_v9()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.legacy_fake_expiry_compensation_operation_id_v9(UUID)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prepare_fake_financial_legacy_expiry_compensation_v9()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prepare_fake_financial_legacy_expiry_attempt_v9()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_fake_financial_legacy_expiry_outcome_v9()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_fake_financial_legacy_expiry_compensation_v9()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.require_legacy_expiry_compensation_before_terminal_outcome_v9()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_fake_expiry_bridge_v9()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_change_order_predecessor_expiry_v9()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_terminal_intent_expiry_v9()
  FROM PUBLIC;
