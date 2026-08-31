-- Provider-neutral authenticated event inbox foundation.
--
-- One external provider event is one immutable observation, regardless of how
-- many delivery attempts or HustleXP ingress idempotency keys carry it. Each
-- verified delivery is recorded separately. This migration performs no
-- provider I/O, financial transition, assignment, or capability activation.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.provider_event_inbox_observations (
  observation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_kind TEXT NOT NULL CHECK (
    provider_kind ~ '^[A-Z][A-Z0-9_]{1,63}$'
  ),
  provider_event_reference TEXT NOT NULL CHECK (
    length(provider_event_reference) BETWEEN 1 AND 255
    AND provider_event_reference = btrim(provider_event_reference)
    AND provider_event_reference !~ '[[:cntrl:]]'
  ),
  provider_event_kind TEXT NOT NULL CHECK (
    length(provider_event_kind) BETWEEN 1 AND 255
    AND provider_event_kind = btrim(provider_event_kind)
    AND provider_event_kind !~ '[[:cntrl:]]'
  ),
  operation_id UUID NOT NULL,
  raw_payload BYTEA NOT NULL CHECK (
    octet_length(raw_payload) BETWEEN 1 AND 1048576
  ),
  raw_payload_sha256 CHAR(64) NOT NULL CHECK (
    raw_payload_sha256 ~ '^[0-9a-f]{64}$'
    AND raw_payload_sha256 = encode(digest(raw_payload, 'sha256'), 'hex')
  ),
  raw_payload_bytes INTEGER NOT NULL CHECK (
    raw_payload_bytes = octet_length(raw_payload)
  ),
  first_received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT provider_event_inbox_provider_event_uniq
    UNIQUE (provider_kind, provider_event_reference)
);

CREATE TABLE IF NOT EXISTS public.provider_event_inbox_receipts (
  receipt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id UUID NOT NULL REFERENCES public.provider_event_inbox_observations(observation_id)
    ON DELETE RESTRICT,
  ingress_idempotency_key TEXT NOT NULL CHECK (
    ingress_idempotency_key ~ '^[A-Za-z0-9:_-]{16,128}$'
  ),
  request_sha256 CHAR(64) NOT NULL CHECK (
    request_sha256 ~ '^[0-9a-f]{64}$'
  ),
  authentication_status TEXT NOT NULL CHECK (
    authentication_status = 'VERIFIED'
  ),
  authentication_scheme TEXT NOT NULL CHECK (
    authentication_scheme ~ '^[A-Z][A-Z0-9_-]{1,63}$'
  ),
  authentication_evidence_sha256 CHAR(64) NOT NULL CHECK (
    authentication_evidence_sha256 ~ '^[0-9a-f]{64}$'
  ),
  authenticated_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT provider_event_inbox_ingress_idempotency_uniq
    UNIQUE (ingress_idempotency_key),
  CONSTRAINT provider_event_inbox_authentication_time_chk CHECK (
    authenticated_at <= received_at + INTERVAL '5 minutes'
  )
);

ALTER TABLE public.provider_event_inbox_receipts
  ALTER COLUMN authentication_status DROP DEFAULT;

CREATE INDEX IF NOT EXISTS provider_event_inbox_observations_operation_idx
  ON public.provider_event_inbox_observations(operation_id, first_received_at);
CREATE INDEX IF NOT EXISTS provider_event_inbox_receipts_observation_idx
  ON public.provider_event_inbox_receipts(observation_id, received_at);

CREATE OR REPLACE FUNCTION public.reject_provider_event_inbox_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'HXPEI1: provider event inbox evidence is append-only'
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS provider_event_inbox_observations_no_update_delete
  ON public.provider_event_inbox_observations;
CREATE TRIGGER provider_event_inbox_observations_no_update_delete
BEFORE UPDATE OR DELETE ON public.provider_event_inbox_observations
FOR EACH ROW EXECUTE FUNCTION public.reject_provider_event_inbox_mutation();

DROP TRIGGER IF EXISTS provider_event_inbox_observations_no_truncate
  ON public.provider_event_inbox_observations;
CREATE TRIGGER provider_event_inbox_observations_no_truncate
BEFORE TRUNCATE ON public.provider_event_inbox_observations
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_provider_event_inbox_mutation();

DROP TRIGGER IF EXISTS provider_event_inbox_receipts_no_update_delete
  ON public.provider_event_inbox_receipts;
CREATE TRIGGER provider_event_inbox_receipts_no_update_delete
BEFORE UPDATE OR DELETE ON public.provider_event_inbox_receipts
FOR EACH ROW EXECUTE FUNCTION public.reject_provider_event_inbox_mutation();

DROP TRIGGER IF EXISTS provider_event_inbox_receipts_no_truncate
  ON public.provider_event_inbox_receipts;
CREATE TRIGGER provider_event_inbox_receipts_no_truncate
BEFORE TRUNCATE ON public.provider_event_inbox_receipts
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_provider_event_inbox_mutation();

COMMENT ON TABLE public.provider_event_inbox_observations IS
  'One append-only raw authenticated provider-event observation per provider kind and provider event reference. It grants no financial or lifecycle authority.';
COMMENT ON TABLE public.provider_event_inbox_receipts IS
  'Append-only verified delivery receipts. Multiple ingress idempotency keys may point to one provider-event observation without duplicating it.';
COMMENT ON COLUMN public.provider_event_inbox_observations.operation_id IS
  'HustleXP operation identity used only for later normalization and reconciliation correlation.';

REVOKE ALL ON TABLE
  public.provider_event_inbox_observations,
  public.provider_event_inbox_receipts
FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_provider_event_inbox_mutation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reject_provider_event_inbox_mutation() TO CURRENT_USER;
