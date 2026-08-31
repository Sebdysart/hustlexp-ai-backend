-- Purpose-bound, append-only Operations access audit for the Universal V1
-- occurrence projection.
--
-- Customer and provider occurrence reads remain participant-authorized GETs.
-- An Operations projection may leave PostgreSQL only after the current named
-- operator has been rechecked and the exact projection digest has been
-- appended in the same primary transaction. This table grants no lifecycle,
-- assignment, private-address, provider, financial, or production authority.
--
-- Actor-attestation limitation: the shared runtime login still cannot prove
-- that the supplied actor UUID is the physical database caller. This audit
-- strengthens observation integrity but does not resolve the separately held
-- Work Order command-authority decision.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

DO $$
BEGIN
  IF to_regclass('public.task_drafts') IS NULL
     OR to_regclass('public.users') IS NULL
     OR to_regprocedure(
       'public.assert_universal_v1_ops_case_operator_v1(uuid,boolean)'
     ) IS NULL THEN
    RAISE EXCEPTION 'HXUVOA0: TaskDraft, user, and named Operations authority must install first'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.universal_v1_occurrence_access_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_draft_id UUID NOT NULL
    REFERENCES public.task_drafts(id) ON DELETE RESTRICT,
  projection_perspective TEXT NOT NULL DEFAULT 'OPERATIONS'
    CHECK (projection_perspective = 'OPERATIONS'),
  projection_contract_version SMALLINT NOT NULL DEFAULT 1
    CHECK (projection_contract_version = 1),
  actor_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  actor_role TEXT NOT NULL
    CHECK (actor_role IN ('admin', 'support', 'finance', 'moderator', 'founder')),
  purpose TEXT NOT NULL CHECK (
    purpose = btrim(purpose)
    AND char_length(purpose) BETWEEN 10 AND 500
  ),
  projection_sha256 CHAR(64) NOT NULL CHECK (
    projection_sha256 ~ '^[a-f0-9]{64}$'
    AND projection_sha256 <> repeat('0', 64)
  ),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS universal_v1_occurrence_access_task_time
  ON public.universal_v1_occurrence_access_audit(task_draft_id, observed_at, id);
CREATE INDEX IF NOT EXISTS universal_v1_occurrence_access_actor_time
  ON public.universal_v1_occurrence_access_audit(actor_id, observed_at, id);

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_occurrence_access_audit_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_current_role TEXT;
BEGIN
  v_current_role := public.assert_universal_v1_ops_case_operator_v1(
    NEW.actor_id,
    FALSE
  );
  IF NEW.actor_role IS DISTINCT FROM v_current_role THEN
    RAISE EXCEPTION 'HXUVOA1: observed operator role does not match current database authority'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.projection_perspective IS DISTINCT FROM 'OPERATIONS'
     OR NEW.projection_contract_version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'HXUVOA2: only the exact Operations projection contract may be audited'
      USING ERRCODE = 'P0001';
  END IF;
  NEW.observed_at := clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_occurrence_access_insert_guard
  ON public.universal_v1_occurrence_access_audit;
CREATE TRIGGER universal_v1_occurrence_access_insert_guard
BEFORE INSERT ON public.universal_v1_occurrence_access_audit
FOR EACH ROW EXECUTE FUNCTION public.enforce_universal_v1_occurrence_access_audit_v1();

CREATE OR REPLACE FUNCTION public.prevent_universal_v1_occurrence_access_mutation_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'HXUVOA3: Universal V1 occurrence access evidence is append-only'
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_occurrence_access_no_mutation
  ON public.universal_v1_occurrence_access_audit;
CREATE TRIGGER universal_v1_occurrence_access_no_mutation
BEFORE UPDATE OR DELETE ON public.universal_v1_occurrence_access_audit
FOR EACH ROW EXECUTE FUNCTION public.prevent_universal_v1_occurrence_access_mutation_v1();

DROP TRIGGER IF EXISTS universal_v1_occurrence_access_no_truncate
  ON public.universal_v1_occurrence_access_audit;
CREATE TRIGGER universal_v1_occurrence_access_no_truncate
BEFORE TRUNCATE ON public.universal_v1_occurrence_access_audit
FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_universal_v1_occurrence_access_mutation_v1();

REVOKE ALL ON TABLE public.universal_v1_occurrence_access_audit FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_occurrence_access_audit_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prevent_universal_v1_occurrence_access_mutation_v1() FROM PUBLIC;

DO $$
DECLARE
  v_role TEXT;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format(
        'REVOKE ALL ON TABLE public.universal_v1_occurrence_access_audit FROM %I',
        v_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.enforce_universal_v1_occurrence_access_audit_v1() FROM %I',
        v_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.prevent_universal_v1_occurrence_access_mutation_v1() FROM %I',
        v_role
      );
    END IF;
  END LOOP;
END;
$$;

COMMENT ON TABLE public.universal_v1_occurrence_access_audit IS
  'Append-only purpose-bound digest evidence for each returned named-operator Universal V1 Operations occurrence projection; grants no command or effect authority.';
COMMENT ON COLUMN public.universal_v1_occurrence_access_audit.projection_sha256 IS
  'SHA-256 of the recursively key-sorted exact Operations projection returned in the same primary transaction.';
COMMENT ON COLUMN public.universal_v1_occurrence_access_audit.purpose IS
  'Explicit operator-supplied business purpose required before the sensitive projection is read.';

