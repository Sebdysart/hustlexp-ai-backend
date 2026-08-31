-- Append-only repair for the deterministic nonproduction fake provider.
--
-- The v1 migration is preserved byte-for-byte as historical evidence. This
-- repair expands only the accepted operation-kind vocabulary so provider
-- onboarding and provider-account state refresh remain separate operations.
-- It creates no external value and remains outside the production registry.

DO $$
BEGIN
  IF to_regclass('public.hxos_fake_financial_operations_v1') IS NULL
     OR to_regclass('public.hxos_fake_financial_operation_events_v1') IS NULL
     OR to_regclass('public.hxos_fake_financial_schema_evidence_v1') IS NULL THEN
    RAISE EXCEPTION 'HXFV20: fake financial provider v1 must be installed first'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

ALTER TABLE hxos_fake_financial_operations_v1
  DROP CONSTRAINT IF EXISTS hxos_fake_financial_operations_v1_operation_kind_check;

ALTER TABLE hxos_fake_financial_operations_v1
  DROP CONSTRAINT IF EXISTS hxos_fake_financial_operations_operation_kind_v2_check;

ALTER TABLE hxos_fake_financial_operations_v1
  ADD CONSTRAINT hxos_fake_financial_operations_operation_kind_v2_check CHECK (
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
      'PAYOUT',
      'INGEST_WEBHOOK',
      'RECONCILE'
    )
  ) NOT VALID;

ALTER TABLE hxos_fake_financial_operations_v1
  VALIDATE CONSTRAINT hxos_fake_financial_operations_operation_kind_v2_check;

CREATE TABLE IF NOT EXISTS hxos_fake_financial_schema_evidence_v2 (
  migration_name TEXT PRIMARY KEY CHECK (
    migration_name = '20260903_fake_financial_provider_account_refresh_v2'
  ),
  migration_sql_sha256 CHAR(64) NOT NULL CHECK (
    migration_sql_sha256 ~ '^[0-9a-f]{64}$'
  ),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

DROP TRIGGER IF EXISTS hxos_fake_financial_schema_evidence_append_only_v2
  ON hxos_fake_financial_schema_evidence_v2;
CREATE TRIGGER hxos_fake_financial_schema_evidence_append_only_v2
BEFORE UPDATE OR DELETE ON hxos_fake_financial_schema_evidence_v2
FOR EACH ROW EXECUTE FUNCTION hxos_reject_fake_financial_mutation_v1();

DROP TRIGGER IF EXISTS hxos_fake_financial_schema_evidence_no_truncate_v2
  ON hxos_fake_financial_schema_evidence_v2;
CREATE TRIGGER hxos_fake_financial_schema_evidence_no_truncate_v2
BEFORE TRUNCATE ON hxos_fake_financial_schema_evidence_v2
FOR EACH STATEMENT EXECUTE FUNCTION hxos_reject_fake_financial_mutation_v1();

REVOKE ALL ON TABLE hxos_fake_financial_schema_evidence_v2 FROM PUBLIC;

COMMENT ON CONSTRAINT hxos_fake_financial_operations_operation_kind_v2_check
  ON hxos_fake_financial_operations_v1 IS
  'Nonproduction fake-provider operation kinds, including distinct provider-account refresh.';

COMMENT ON TABLE hxos_fake_financial_schema_evidence_v2 IS
  'Append-only checksum evidence for the provider-account refresh operation-kind repair.';
