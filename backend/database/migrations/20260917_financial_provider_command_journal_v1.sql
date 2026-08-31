-- Provider-neutral financial provider command journal v1.
--
-- One immutable REQUESTED fact must be committed before any adapter invocation.
-- The exact canonical request is represented only by its SHA-256 digest; raw
-- payment-method and provider-account material is intentionally not persisted.
-- Fixed domain bindings provide safe correlation evidence. A row records an
-- intent only: it grants no provider, payment, deployment, or production
-- capability and performs no provider I/O.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.financial_provider_command_journal (
  command_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  command_state TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (
    command_state = 'REQUESTED'
  ),
  operation_kind TEXT NOT NULL CHECK (operation_kind IN (
    'PREPARE_PAYMENT_METHOD',
    'AUTHORIZE',
    'SECURE',
    'VOID',
    'ADJUST',
    'CAPTURE',
    'REFUND',
    'REVERSAL',
    'ONBOARD_PROVIDER',
    'REFRESH_PROVIDER_ACCOUNT_STATE',
    'SETTLE',
    'FUND',
    'PROVIDER_RELEASE',
    'PAYOUT',
    'OBSERVE_BANK_SETTLEMENT',
    'INGEST_WEBHOOK',
    'RECONCILE'
  )),
  operation_id UUID NOT NULL,
  provider_kind TEXT NOT NULL CHECK (
    provider_kind IN ('FAKE', 'APPROVED_PROVIDER')
  ),
  idempotency_key TEXT NOT NULL CHECK (
    idempotency_key ~ '^[A-Za-z0-9:_-]{16,128}$'
  ),
  provider_expected_version BIGINT NOT NULL CHECK (
    provider_expected_version BETWEEN 0 AND 9007199254740991
  ),
  request_sha256 CHAR(64) NOT NULL CHECK (
    request_sha256 ~ '^[0-9a-f]{64}$'
  ),
  command_identity_sha256 CHAR(64) NOT NULL CHECK (
    command_identity_sha256 ~ '^[0-9a-f]{64}$'
  ),

  -- Safe, fixed domain evidence only. Provider payment/account references and
  -- arbitrary request payloads have no storage column in this table.
  task_draft_id UUID,
  task_id UUID,
  work_order_id UUID,
  related_operation_id UUID,
  amount_cents BIGINT CHECK (
    amount_cents IS NULL OR amount_cents BETWEEN 0 AND 9007199254740991
  ),
  currency CHAR(3) CHECK (
    currency IS NULL OR currency ~ '^[A-Z]{3}$'
  ),
  CONSTRAINT financial_provider_command_amount_currency_pair_chk CHECK (
    (amount_cents IS NULL) = (currency IS NULL)
  ),

  recorded_actor_id UUID,
  recorded_actor_kind TEXT CHECK (
    recorded_actor_kind IS NULL
    OR recorded_actor_kind IN ('NAMED_OPERATOR', 'SERVICE_PRINCIPAL')
  ),
  CONSTRAINT financial_provider_command_actor_bundle_chk CHECK (
    (recorded_actor_id IS NULL) = (recorded_actor_kind IS NULL)
  ),

  release_manifest_digest TEXT CHECK (
    release_manifest_digest IS NULL
    OR (
      release_manifest_digest ~ '^sha256:[0-9a-f]{64}$'
      AND release_manifest_digest <> ('sha256:' || repeat('0', 64))
    )
  ),
  release_id TEXT CHECK (
    release_id IS NULL
    OR release_id ~ '^[a-z0-9][a-z0-9._-]{7,127}$'
  ),
  release_revision CHAR(40) CHECK (
    release_revision IS NULL
    OR (
      release_revision ~ '^[0-9a-f]{40}$'
      AND release_revision <> repeat('0', 40)
    )
  ),
  release_environment TEXT CHECK (
    release_environment IS NULL
    OR release_environment IN ('local', 'preview', 'staging', 'production')
  ),
  release_authentication_status TEXT CHECK (
    release_authentication_status IS NULL
    OR release_authentication_status IN ('VERIFIED', 'MISSING', 'INVALID', 'UNTRUSTED_KEY')
  ),
  CONSTRAINT financial_provider_command_release_bundle_chk CHECK (
    num_nonnulls(
      release_manifest_digest,
      release_id,
      release_revision,
      release_environment,
      release_authentication_status
    ) IN (0, 5)
  ),
  CONSTRAINT financial_provider_command_approved_provider_evidence_chk CHECK (
    provider_kind <> 'APPROVED_PROVIDER'
    OR (
      recorded_actor_id IS NOT NULL
      AND release_authentication_status = 'VERIFIED'
    )
  ),

  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT financial_provider_command_idempotency_uniq UNIQUE (idempotency_key),
  CONSTRAINT financial_provider_command_operation_version_uniq
    UNIQUE (provider_kind, operation_kind, operation_id, provider_expected_version)
);

CREATE INDEX IF NOT EXISTS financial_provider_command_operation_time_idx
  ON public.financial_provider_command_journal(operation_id, recorded_at);

CREATE OR REPLACE FUNCTION public.reject_financial_provider_command_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'HXFPCJ1: financial provider command evidence is append-only'
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS financial_provider_command_no_update_delete
  ON public.financial_provider_command_journal;
CREATE TRIGGER financial_provider_command_no_update_delete
BEFORE UPDATE OR DELETE ON public.financial_provider_command_journal
FOR EACH ROW EXECUTE FUNCTION public.reject_financial_provider_command_mutation();

DROP TRIGGER IF EXISTS financial_provider_command_no_truncate
  ON public.financial_provider_command_journal;
CREATE TRIGGER financial_provider_command_no_truncate
BEFORE TRUNCATE ON public.financial_provider_command_journal
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_financial_provider_command_mutation();

COMMENT ON TABLE public.financial_provider_command_journal IS
  'Append-only provider-neutral REQUESTED facts committed before adapter I/O. A row is non-authorizing and proves no provider effect.';
COMMENT ON COLUMN public.financial_provider_command_journal.request_sha256 IS
  'SHA-256 of the exact deterministic canonical provider request; raw payment and provider-account material is never stored here.';
COMMENT ON COLUMN public.financial_provider_command_journal.command_identity_sha256 IS
  'SHA-256 binding operation, provider, idempotency, expected version, request digest, safe domain evidence, actor, and release evidence.';

REVOKE ALL ON TABLE public.financial_provider_command_journal FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_financial_provider_command_mutation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reject_financial_provider_command_mutation() TO CURRENT_USER;
