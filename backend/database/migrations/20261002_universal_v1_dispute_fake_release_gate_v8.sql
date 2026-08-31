-- Nonproduction fake-finance v8: Universal V1 material-dispute release gate.
--
-- The registered dispute engine installs before nonproduction fake fixtures and
-- therefore cannot attach a trigger to the fake terminal-intent table itself.
-- This append-only fixture successor attaches that one fake-only edge after the
-- complete v7 chain exists. It creates no terminal intent, provider call, money
-- effect, production capability, assignment, refund, reversal, release, or payout.

DO $$
BEGIN
  IF to_regclass('public.hxos_fake_financial_schema_evidence_v7') IS NULL
     OR to_regclass('public.universal_v1_fake_terminal_lifecycle_intents') IS NULL
     OR to_regclass('public.universal_v1_dispute_incidents') IS NULL
     OR to_regprocedure(
       'public.enforce_universal_v1_dispute_release_gate_v1()'
     ) IS NULL THEN
    RAISE EXCEPTION 'HXUDR-V8-0: exact fake-finance v7 and registered dispute engine authority must be installed first'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.hxos_fake_financial_schema_evidence_v8 (
  migration_name TEXT PRIMARY KEY CHECK (
    migration_name = '20261002_universal_v1_dispute_fake_release_gate_v8'
  ),
  migration_sql_sha256 CHAR(64) NOT NULL CHECK (
    migration_sql_sha256 ~ '^[0-9a-f]{64}$'
  ),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

DROP TRIGGER IF EXISTS hxos_fake_financial_schema_evidence_append_only_v8
  ON public.hxos_fake_financial_schema_evidence_v8;
CREATE TRIGGER hxos_fake_financial_schema_evidence_append_only_v8
BEFORE UPDATE OR DELETE ON public.hxos_fake_financial_schema_evidence_v8
FOR EACH ROW EXECUTE FUNCTION public.hxos_reject_fake_financial_mutation_v1();

DROP TRIGGER IF EXISTS hxos_fake_financial_schema_evidence_no_truncate_v8
  ON public.hxos_fake_financial_schema_evidence_v8;
CREATE TRIGGER hxos_fake_financial_schema_evidence_no_truncate_v8
BEFORE TRUNCATE ON public.hxos_fake_financial_schema_evidence_v8
FOR EACH STATEMENT EXECUTE FUNCTION public.hxos_reject_fake_financial_mutation_v1();

DROP TRIGGER IF EXISTS aa_universal_v1_dispute_terminal_intent_gate
  ON public.universal_v1_fake_terminal_lifecycle_intents;
CREATE TRIGGER aa_universal_v1_dispute_terminal_intent_gate
BEFORE INSERT ON public.universal_v1_fake_terminal_lifecycle_intents
FOR EACH ROW
EXECUTE FUNCTION public.enforce_universal_v1_dispute_release_gate_v1();

COMMENT ON TABLE public.hxos_fake_financial_schema_evidence_v8 IS
  'Append-only proof that fake terminal SETTLED intent creation is gated by current material disputes after engine-first installation.';

REVOKE ALL ON TABLE public.hxos_fake_financial_schema_evidence_v8 FROM PUBLIC;
