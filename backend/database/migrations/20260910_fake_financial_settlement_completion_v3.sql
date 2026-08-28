-- Append-only nonproduction fake-provider operation vocabulary repair.
--
-- Universal V1 distinguishes funding, provider release, payout, and observed
-- bank settlement. The original fake-provider vocabulary omitted the release
-- and bank-observation operations even though the canonical lifecycle facts
-- already distinguish them. This repair adds those provider-neutral operation
-- names without creating external value or enabling production finance.

DO $$
BEGIN
  IF to_regclass('public.hxos_fake_financial_operations_v1') IS NULL
     OR to_regclass('public.hxos_fake_financial_operation_events_v1') IS NULL
     OR to_regclass('public.hxos_fake_financial_schema_evidence_v2') IS NULL THEN
    RAISE EXCEPTION 'HXFV30: fake financial provider v2 must be installed first'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

ALTER TABLE hxos_fake_financial_operations_v1
  DROP CONSTRAINT IF EXISTS hxos_fake_financial_operations_operation_kind_v2_check;

ALTER TABLE hxos_fake_financial_operations_v1
  DROP CONSTRAINT IF EXISTS hxos_fake_financial_operations_operation_kind_v3_check;

ALTER TABLE hxos_fake_financial_operations_v1
  ADD CONSTRAINT hxos_fake_financial_operations_operation_kind_v3_check CHECK (
    operation_kind IN (
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
    )
  ) NOT VALID;

ALTER TABLE hxos_fake_financial_operations_v1
  VALIDATE CONSTRAINT hxos_fake_financial_operations_operation_kind_v3_check;

CREATE TABLE IF NOT EXISTS hxos_fake_financial_schema_evidence_v3 (
  migration_name TEXT PRIMARY KEY CHECK (
    migration_name = '20260910_fake_financial_settlement_completion_v3'
  ),
  migration_sql_sha256 CHAR(64) NOT NULL CHECK (
    migration_sql_sha256 ~ '^[0-9a-f]{64}$'
  ),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

DROP TRIGGER IF EXISTS hxos_fake_financial_schema_evidence_append_only_v3
  ON hxos_fake_financial_schema_evidence_v3;
CREATE TRIGGER hxos_fake_financial_schema_evidence_append_only_v3
BEFORE UPDATE OR DELETE ON hxos_fake_financial_schema_evidence_v3
FOR EACH ROW EXECUTE FUNCTION hxos_reject_fake_financial_mutation_v1();

DROP TRIGGER IF EXISTS hxos_fake_financial_schema_evidence_no_truncate_v3
  ON hxos_fake_financial_schema_evidence_v3;
CREATE TRIGGER hxos_fake_financial_schema_evidence_no_truncate_v3
BEFORE TRUNCATE ON hxos_fake_financial_schema_evidence_v3
FOR EACH STATEMENT EXECUTE FUNCTION hxos_reject_fake_financial_mutation_v1();

REVOKE ALL ON TABLE hxos_fake_financial_schema_evidence_v3 FROM PUBLIC;

COMMENT ON CONSTRAINT hxos_fake_financial_operations_operation_kind_v3_check
  ON hxos_fake_financial_operations_v1 IS
  'Nonproduction fake-provider operations keep provider release and observed bank settlement distinct.';

COMMENT ON TABLE hxos_fake_financial_schema_evidence_v3 IS
  'Append-only checksum evidence for the complete Universal V1 fake settlement vocabulary.';
