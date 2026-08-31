-- Legacy escrow insert containment v1.
--
-- Historical legacy escrows remain available for refund, void, dispute,
-- cancellation, and reconciliation recovery. New legacy escrow creation is
-- retired. This migration grants no payment, provider, deployment, assignment,
-- or production capability.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class relation
      JOIN pg_catalog.pg_namespace namespace
        ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND relation.relname = 'escrows'
       AND relation.relkind = 'r'
  ) THEN
    RAISE EXCEPTION 'HXUV1-ESCROW-0: public.escrows must be a regular table before containment'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_inherits inheritance
     WHERE inheritance.inhparent = 'public.escrows'::pg_catalog.regclass
        OR inheritance.inhrelid = 'public.escrows'::pg_catalog.regclass
  ) THEN
    RAISE EXCEPTION 'HXUV1-ESCROW-0: public.escrows must not participate in table inheritance'
      USING ERRCODE = 'P0001';
  END IF;

  IF pg_catalog.to_regclass('public.escrow') IS NOT NULL THEN
    RAISE EXCEPTION 'HXUV1-ESCROW-0: singular public.escrow lineage requires explicit review'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_legacy_escrow_insert_containment_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF session_user = 'hx_ci_runner'
     AND current_user = 'hx_ci_runner'
     AND current_database() IN (
       'hx_ci_invariant_test',
       'hx_ci_system_test'
     ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'HXUV1-ESCROW-1: new legacy escrow creation is retired; only recovery transitions on pre-existing rows remain available'
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS legacy_escrow_insert_containment_v1 ON public.escrows;
CREATE TRIGGER legacy_escrow_insert_containment_v1
BEFORE INSERT ON public.escrows
FOR EACH ROW EXECUTE FUNCTION public.enforce_legacy_escrow_insert_containment_v1();

ALTER TABLE public.escrows
  ENABLE ALWAYS TRIGGER legacy_escrow_insert_containment_v1;

REVOKE ALL ON FUNCTION public.enforce_legacy_escrow_insert_containment_v1() FROM PUBLIC;

COMMENT ON FUNCTION public.enforce_legacy_escrow_insert_containment_v1() IS
  'Denies new legacy escrow inserts outside exact isolated CI databases; existing escrow recovery remains governed by the current update guards.';
COMMENT ON TRIGGER legacy_escrow_insert_containment_v1 ON public.escrows IS
  'Retires new legacy escrow creation without changing historical rows or recovery transitions.';
