-- Universal V1 Work Order bootstrap seal v1.
--
-- Ordinal146 cannot embed its own digest, and v12 cannot embed its own digest.
-- This deliberately tiny successor closes that cycle after both predecessor
-- byte sequences are frozen. It creates no payment, provider, assignment,
-- deployment, production, or external-communication capability. Runtime
-- callers still require the separately provisioned exact eight-role boundary
-- and startup readback against the signed local migration manifest.

SELECT pg_catalog.set_config('search_path', 'pg_catalog', true);

DO $$
DECLARE
  expected_ordinal146_sha256 CONSTANT TEXT :=
    '3920ac8d3208b9f573dc331cab60c373d0349611700c6e14a6e4c1dd8c53aac4';
  expected_v12_sha256 CONSTANT TEXT :=
    '5bb8ee72b9113146b88c22c6751ebe527ba6246b4463a8611ef9c24b999b7ac5';
  invalid_relation TEXT;
  invalid_migration TEXT;
  evidence_count BIGINT;
  evidence_migration_name TEXT;
  evidence_v12_sha256 TEXT;
  evidence_ordinal146_sha256 TEXT;
  target_count BIGINT;
BEGIN
  SELECT required.relation_name
    INTO invalid_relation
    FROM (VALUES
      ('public.applied_migrations'),
      ('public.hxos_fake_financial_schema_evidence_v12'),
      ('public.hxos_universal_v1_work_order_target_activation_barrier_v1'),
      ('hx_authority.universal_v1_work_order_target_authority_facts')
    ) required(relation_name)
    LEFT JOIN pg_catalog.pg_class relation_state
      ON relation_state.oid = pg_catalog.to_regclass(required.relation_name)::OID
   WHERE relation_state.oid IS NULL
      OR relation_state.relkind IS DISTINCT FROM 'r'
   ORDER BY required.relation_name
   LIMIT 1;
  IF invalid_relation IS NOT NULL THEN
    RAISE EXCEPTION
      'HXUV1-WOCMD-SEAL-1: exact predecessor relation is absent or unsafe: %',
      invalid_relation
      USING ERRCODE = 'P0001';
  END IF;

  -- Prevent ledger/evidence/target mutation between the exact predecessor
  -- read and creation of the immutable seal receipt.
  LOCK TABLE public.applied_migrations IN SHARE MODE;
  LOCK TABLE public.hxos_fake_financial_schema_evidence_v12 IN SHARE MODE;
  LOCK TABLE public.hxos_universal_v1_work_order_target_activation_barrier_v1
    IN SHARE MODE;
  LOCK TABLE hx_authority.universal_v1_work_order_target_authority_facts
    IN SHARE MODE;

  SELECT expected.migration_name
    INTO invalid_migration
    FROM (VALUES
      ('20261014_universal_v1_work_order_command_ports_v1',
       expected_ordinal146_sha256),
      ('20261015_universal_v1_work_order_fake_financial_authority_hardening_v12',
       expected_v12_sha256)
    ) expected(migration_name, expected_sha256)
   WHERE (
          SELECT pg_catalog.count(*)
            FROM public.applied_migrations applied
           WHERE applied.name = expected.migration_name
         ) IS DISTINCT FROM 1::BIGINT
      OR (
          SELECT pg_catalog.min(pg_catalog.btrim(applied.sha256))
            FROM public.applied_migrations applied
           WHERE applied.name = expected.migration_name
         ) IS DISTINCT FROM expected.expected_sha256
   ORDER BY expected.migration_name
   LIMIT 1;
  IF invalid_migration IS NOT NULL THEN
    RAISE EXCEPTION
      'HXUV1-WOCMD-SEAL-2: exact predecessor ledger evidence is absent or changed: %',
      invalid_migration
      USING ERRCODE = 'P0001';
  END IF;

  SELECT pg_catalog.count(*),
         pg_catalog.min(evidence.migration_name),
         pg_catalog.min(pg_catalog.btrim(evidence.migration_sql_sha256)),
         pg_catalog.min(pg_catalog.btrim(evidence.ordinal146_sql_sha256))
    INTO evidence_count,
         evidence_migration_name,
         evidence_v12_sha256,
         evidence_ordinal146_sha256
    FROM public.hxos_fake_financial_schema_evidence_v12 evidence;
  IF evidence_count IS DISTINCT FROM 1::BIGINT
     OR evidence_migration_name IS DISTINCT FROM
          '20261015_universal_v1_work_order_fake_financial_authority_hardening_v12'
     OR evidence_v12_sha256 IS DISTINCT FROM expected_v12_sha256
     OR evidence_ordinal146_sha256 IS DISTINCT FROM expected_ordinal146_sha256 THEN
    RAISE EXCEPTION
      'HXUV1-WOCMD-SEAL-3: exact immutable v12 predecessor evidence is absent or changed'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT pg_catalog.count(*)
    INTO target_count
    FROM hx_authority.universal_v1_work_order_target_authority_facts;
  IF target_count IS DISTINCT FROM 0::BIGINT THEN
    RAISE EXCEPTION
      'HXUV1-WOCMD-SEAL-4: target authority must be empty before bootstrap seal'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- Collision rejection is intentional. Canonical ledger replay skips this SQL;
-- a precreated object cannot be normalized into a trusted receipt.
CREATE TABLE public.hxos_work_order_bootstrap_seal_evidence_v1 (
  migration_name TEXT PRIMARY KEY CHECK (
    migration_name = '20261015_universal_v1_work_order_bootstrap_seal_v1'
  ),
  migration_sql_sha256 CHAR(64) NOT NULL CHECK (
    migration_sql_sha256 ~ '^[0-9a-f]{64}$'
    AND migration_sql_sha256 <> pg_catalog.repeat('0', 64)
  ),
  ordinal146_sql_sha256 CHAR(64) NOT NULL DEFAULT
    '3920ac8d3208b9f573dc331cab60c373d0349611700c6e14a6e4c1dd8c53aac4'
    CHECK (
      ordinal146_sql_sha256 =
        '3920ac8d3208b9f573dc331cab60c373d0349611700c6e14a6e4c1dd8c53aac4'
    ),
  v12_sql_sha256 CHAR(64) NOT NULL DEFAULT
    '5bb8ee72b9113146b88c22c6751ebe527ba6246b4463a8611ef9c24b999b7ac5'
    CHECK (
      v12_sql_sha256 =
        '5bb8ee72b9113146b88c22c6751ebe527ba6246b4463a8611ef9c24b999b7ac5'
    ),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TRIGGER hxos_work_order_bootstrap_seal_append_only_v1
BEFORE UPDATE OR DELETE ON public.hxos_work_order_bootstrap_seal_evidence_v1
FOR EACH ROW EXECUTE FUNCTION public.hxos_reject_fake_financial_mutation_v1();

CREATE TRIGGER hxos_work_order_bootstrap_seal_no_truncate_v1
BEFORE TRUNCATE ON public.hxos_work_order_bootstrap_seal_evidence_v1
FOR EACH STATEMENT EXECUTE FUNCTION public.hxos_reject_fake_financial_mutation_v1();

COMMENT ON TABLE public.hxos_work_order_bootstrap_seal_evidence_v1 IS
  'Append-only receipt closing the exact ordinal146/v12 Work Order bootstrap hash cycle. It grants no money, assignment, provider, deployment, or production capability.';

REVOKE ALL ON TABLE public.hxos_work_order_bootstrap_seal_evidence_v1 FROM PUBLIC;

CREATE OR REPLACE FUNCTION hx_authority.assert_universal_v1_work_order_bootstrap_seal_v1()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
DECLARE
  expected_ordinal146_sha256 CONSTANT TEXT :=
    '3920ac8d3208b9f573dc331cab60c373d0349611700c6e14a6e4c1dd8c53aac4';
  expected_v12_sha256 CONSTANT TEXT :=
    '5bb8ee72b9113146b88c22c6751ebe527ba6246b4463a8611ef9c24b999b7ac5';
  v12_count BIGINT;
  v12_migration_name TEXT;
  v12_sha256 TEXT;
  v12_ordinal146_sha256 TEXT;
  seal_count BIGINT;
  seal_migration_name TEXT;
  seal_sha256 TEXT;
  seal_ordinal146_sha256 TEXT;
  seal_v12_sha256 TEXT;
BEGIN
  SELECT pg_catalog.count(*),
         pg_catalog.min(evidence.migration_name),
         pg_catalog.min(pg_catalog.btrim(evidence.migration_sql_sha256)),
         pg_catalog.min(pg_catalog.btrim(evidence.ordinal146_sql_sha256))
    INTO v12_count,
         v12_migration_name,
         v12_sha256,
         v12_ordinal146_sha256
    FROM public.hxos_fake_financial_schema_evidence_v12 evidence;

  SELECT pg_catalog.count(*),
         pg_catalog.min(evidence.migration_name),
         pg_catalog.min(pg_catalog.btrim(evidence.migration_sql_sha256)),
         pg_catalog.min(pg_catalog.btrim(evidence.ordinal146_sql_sha256)),
         pg_catalog.min(pg_catalog.btrim(evidence.v12_sql_sha256))
    INTO seal_count,
         seal_migration_name,
         seal_sha256,
         seal_ordinal146_sha256,
         seal_v12_sha256
    FROM public.hxos_work_order_bootstrap_seal_evidence_v1 evidence;

  IF v12_count IS DISTINCT FROM 1::BIGINT
     OR v12_migration_name IS DISTINCT FROM
          '20261015_universal_v1_work_order_fake_financial_authority_hardening_v12'
     OR v12_sha256 IS DISTINCT FROM expected_v12_sha256
     OR v12_ordinal146_sha256 IS DISTINCT FROM expected_ordinal146_sha256
     OR seal_count IS DISTINCT FROM 1::BIGINT
     OR seal_migration_name IS DISTINCT FROM
          '20261015_universal_v1_work_order_bootstrap_seal_v1'
     OR seal_sha256 IS NULL
     OR seal_sha256 !~ '^[0-9a-f]{64}$'
     OR seal_sha256 = pg_catalog.repeat('0', 64)
     OR seal_ordinal146_sha256 IS DISTINCT FROM expected_ordinal146_sha256
     OR seal_v12_sha256 IS DISTINCT FROM expected_v12_sha256 THEN
    RAISE EXCEPTION
      'HXUV1-WOCMD-SEAL-5: exact immutable Work Order bootstrap seal is absent or changed'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION
  hx_authority.assert_universal_v1_work_order_bootstrap_seal_v1()
  FROM PUBLIC;

-- Canonical runtime certification port. LOGIN roles can prove the sealed
-- target and fake-finance relation identities without SELECT on any authority
-- or evidence table. The seal hash is returned from its collision-created,
-- append-only receipt and must be compared with the packaged local bytes by
-- the startup/capability caller; H146 and Hv12 are already embedded and
-- enforced by the sealed helper above.
CREATE OR REPLACE FUNCTION public.hxos_read_universal_v1_work_order_runtime_authority_v1()
RETURNS TABLE (
  session_database_role TEXT,
  target_authority_id UUID,
  authority_version INTEGER,
  target_database_name TEXT,
  environment TEXT,
  release_manifest_sha256 TEXT,
  ordinal146_sql_sha256 TEXT,
  v12_sql_sha256 TEXT,
  seal_sql_sha256 TEXT,
  fake_financial_operations_relation TEXT,
  fake_financial_operation_events_relation TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
DECLARE
  target RECORD;
  seal_receipt RECORD;
  operations_relation_kind "char";
  events_relation_kind "char";
BEGIN
  PERFORM hx_authority.assert_universal_v1_work_order_bootstrap_seal_v1();
  SELECT * INTO STRICT target
    FROM hx_authority.read_universal_v1_work_order_target_authority_v1();
  SELECT pg_catalog.btrim(evidence.ordinal146_sql_sha256) AS ordinal146_sha256,
         pg_catalog.btrim(evidence.v12_sql_sha256) AS v12_sha256,
         pg_catalog.btrim(evidence.migration_sql_sha256) AS seal_sha256
    INTO STRICT seal_receipt
    FROM public.hxos_work_order_bootstrap_seal_evidence_v1 evidence;

  SELECT relation_state.relkind
    INTO operations_relation_kind
    FROM pg_catalog.pg_class relation_state
   WHERE relation_state.oid = pg_catalog.to_regclass(
     'public.hxos_fake_financial_operations_v1'
   );
  SELECT relation_state.relkind
    INTO events_relation_kind
    FROM pg_catalog.pg_class relation_state
   WHERE relation_state.oid = pg_catalog.to_regclass(
     'public.hxos_fake_financial_operation_events_v1'
   );
  IF operations_relation_kind IS DISTINCT FROM 'r'::"char"
     OR events_relation_kind IS DISTINCT FROM 'r'::"char" THEN
    RAISE EXCEPTION
      'HXUV1-WOCMD-SEAL-6: canonical fake-finance operation relations are absent or changed'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY SELECT
    SESSION_USER::TEXT,
    target.target_authority_id::UUID,
    target.authority_version::INTEGER,
    target.target_database_name::TEXT,
    target.environment::TEXT,
    target.release_manifest_sha256::TEXT,
    seal_receipt.ordinal146_sha256::TEXT,
    seal_receipt.v12_sha256::TEXT,
    seal_receipt.seal_sha256::TEXT,
    'public.hxos_fake_financial_operations_v1'::TEXT,
    'public.hxos_fake_financial_operation_events_v1'::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION
  public.hxos_read_universal_v1_work_order_runtime_authority_v1()
  FROM PUBLIC;
