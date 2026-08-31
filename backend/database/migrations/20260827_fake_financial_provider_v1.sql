-- Deterministic nonproduction financial provider evidence store.
--
-- This append-only migration depends on the v7 payment-underwriting contracts.
-- It is intentionally not in the production startup registry. Registration is
-- allowed only after the application/migration role boundary and exact release
-- manifest are independently approved. No row in these tables represents money.

CREATE TABLE IF NOT EXISTS hxos_fake_financial_schema_evidence_v1 (
  migration_name TEXT PRIMARY KEY CHECK (
    migration_name = '20260827_fake_financial_provider_v1'
  ),
  migration_sql_sha256 CHAR(64) NOT NULL CHECK (
    migration_sql_sha256 ~ '^[0-9a-f]{64}$'
  ),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS hxos_fake_financial_operations_v1 (
  operation_id UUID PRIMARY KEY,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN (
    'PREPARE_PAYMENT_METHOD', 'AUTHORIZE', 'SECURE', 'VOID', 'ADJUST',
    'CAPTURE', 'REFUND', 'REVERSAL', 'ONBOARD_PROVIDER', 'SETTLE',
    'FUND', 'PAYOUT', 'INGEST_WEBHOOK', 'RECONCILE'
  )),
  provider_kind TEXT NOT NULL DEFAULT 'FAKE' CHECK (provider_kind = 'FAKE'),
  identity_sha256 CHAR(64) NOT NULL CHECK (identity_sha256 ~ '^[0-9a-f]{64}$'),
  external_reference TEXT NOT NULL UNIQUE CHECK (
    external_reference ~ '^fake_[a-z_]+_[0-9a-f]{24}$'
  ),
  amount_cents BIGINT CHECK (amount_cents > 0),
  currency CHAR(3) CHECK (currency ~ '^[a-z]{3}$'),
  related_operation_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (operation_id, operation_kind),
  UNIQUE (operation_id, external_reference),
  CHECK ((amount_cents IS NULL) = (currency IS NULL))
);

CREATE TABLE IF NOT EXISTS hxos_fake_financial_operation_events_v1 (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID NOT NULL,
  operation_kind TEXT NOT NULL,
  event_version INTEGER NOT NULL CHECK (event_version > 0),
  state TEXT NOT NULL CHECK (state IN (
    'PENDING', 'SUCCEEDED', 'DECLINED', 'FAILED', 'RETRYABLE_FAILURE',
    'VOIDED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'REVERSED', 'ACCEPTED',
    'REJECTED', 'MATCHED', 'MISMATCH'
  )),
  scenario TEXT NOT NULL CHECK (scenario IN (
    'SUCCESS', 'DECLINE', 'TIMEOUT', 'DUPLICATE_WEBHOOK', 'RETRY',
    'REVERSAL', 'PARTIAL_REFUND', 'DELAYED_SETTLEMENT',
    'RECONCILIATION_MISMATCH', 'PROVIDER_ACCOUNT_FAILURE'
  )),
  amount_cents BIGINT CHECK (amount_cents > 0),
  currency CHAR(3) CHECK (currency ~ '^[a-z]{3}$'),
  related_operation_id UUID,
  external_reference TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 16 AND 160),
  identity_sha256 CHAR(64) NOT NULL CHECK (identity_sha256 ~ '^[0-9a-f]{64}$'),
  request_sha256 CHAR(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  response_sha256 CHAR(64) NOT NULL CHECK (response_sha256 ~ '^[0-9a-f]{64}$'),
  retryable BOOLEAN NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (operation_id, event_version),
  FOREIGN KEY (operation_id, operation_kind)
    REFERENCES hxos_fake_financial_operations_v1(operation_id, operation_kind)
    ON DELETE RESTRICT,
  FOREIGN KEY (operation_id, external_reference)
    REFERENCES hxos_fake_financial_operations_v1(operation_id, external_reference)
    ON DELETE RESTRICT,
  CHECK ((amount_cents IS NULL) = (currency IS NULL))
);

CREATE INDEX IF NOT EXISTS hxos_fake_financial_events_operation_idx
  ON hxos_fake_financial_operation_events_v1(operation_id, event_version DESC);
CREATE INDEX IF NOT EXISTS hxos_fake_financial_events_state_idx
  ON hxos_fake_financial_operation_events_v1(state, recorded_at DESC);

CREATE TABLE IF NOT EXISTS hxos_nonproduction_bootstrap_completion_v1 (
  completion_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  release_manifest_digest TEXT NOT NULL CHECK (
    release_manifest_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  migration_artifact_digest TEXT NOT NULL CHECK (
    migration_artifact_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  release_id TEXT NOT NULL CHECK (length(release_id) BETWEEN 8 AND 128),
  release_environment TEXT NOT NULL CHECK (
    release_environment IN ('local', 'preview', 'staging')
  ),
  required_migration_count INTEGER NOT NULL CHECK (required_migration_count > 0),
  financial_migration_status TEXT NOT NULL CHECK (
    financial_migration_status IN ('applied', 'already_applied')
  ),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (release_manifest_digest, migration_artifact_digest)
);

CREATE OR REPLACE FUNCTION hxos_reject_fake_financial_mutation_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'HXFV10: fake financial evidence is append-only'
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS hxos_fake_financial_operations_append_only_v1
  ON hxos_fake_financial_operations_v1;
CREATE TRIGGER hxos_fake_financial_operations_append_only_v1
BEFORE UPDATE OR DELETE ON hxos_fake_financial_operations_v1
FOR EACH ROW EXECUTE FUNCTION hxos_reject_fake_financial_mutation_v1();

DROP TRIGGER IF EXISTS hxos_fake_financial_schema_evidence_append_only_v1
  ON hxos_fake_financial_schema_evidence_v1;
CREATE TRIGGER hxos_fake_financial_schema_evidence_append_only_v1
BEFORE UPDATE OR DELETE ON hxos_fake_financial_schema_evidence_v1
FOR EACH ROW EXECUTE FUNCTION hxos_reject_fake_financial_mutation_v1();

DROP TRIGGER IF EXISTS hxos_fake_financial_events_append_only_v1
  ON hxos_fake_financial_operation_events_v1;
CREATE TRIGGER hxos_fake_financial_events_append_only_v1
BEFORE UPDATE OR DELETE ON hxos_fake_financial_operation_events_v1
FOR EACH ROW EXECUTE FUNCTION hxos_reject_fake_financial_mutation_v1();

DROP TRIGGER IF EXISTS hxos_nonproduction_bootstrap_completion_append_only_v1
  ON hxos_nonproduction_bootstrap_completion_v1;
CREATE TRIGGER hxos_nonproduction_bootstrap_completion_append_only_v1
BEFORE UPDATE OR DELETE ON hxos_nonproduction_bootstrap_completion_v1
FOR EACH ROW EXECUTE FUNCTION hxos_reject_fake_financial_mutation_v1();

DROP TRIGGER IF EXISTS hxos_fake_financial_schema_evidence_no_truncate_v1
  ON hxos_fake_financial_schema_evidence_v1;
CREATE TRIGGER hxos_fake_financial_schema_evidence_no_truncate_v1
BEFORE TRUNCATE ON hxos_fake_financial_schema_evidence_v1
FOR EACH STATEMENT EXECUTE FUNCTION hxos_reject_fake_financial_mutation_v1();

DROP TRIGGER IF EXISTS hxos_fake_financial_operations_no_truncate_v1
  ON hxos_fake_financial_operations_v1;
CREATE TRIGGER hxos_fake_financial_operations_no_truncate_v1
BEFORE TRUNCATE ON hxos_fake_financial_operations_v1
FOR EACH STATEMENT EXECUTE FUNCTION hxos_reject_fake_financial_mutation_v1();

DROP TRIGGER IF EXISTS hxos_fake_financial_events_no_truncate_v1
  ON hxos_fake_financial_operation_events_v1;
CREATE TRIGGER hxos_fake_financial_events_no_truncate_v1
BEFORE TRUNCATE ON hxos_fake_financial_operation_events_v1
FOR EACH STATEMENT EXECUTE FUNCTION hxos_reject_fake_financial_mutation_v1();

DROP TRIGGER IF EXISTS hxos_nonproduction_bootstrap_completion_no_truncate_v1
  ON hxos_nonproduction_bootstrap_completion_v1;
CREATE TRIGGER hxos_nonproduction_bootstrap_completion_no_truncate_v1
BEFORE TRUNCATE ON hxos_nonproduction_bootstrap_completion_v1
FOR EACH STATEMENT EXECUTE FUNCTION hxos_reject_fake_financial_mutation_v1();

REVOKE ALL ON TABLE
  hxos_fake_financial_schema_evidence_v1,
  hxos_fake_financial_operations_v1,
  hxos_fake_financial_operation_events_v1,
  hxos_nonproduction_bootstrap_completion_v1
FROM PUBLIC;

REVOKE ALL ON FUNCTION hxos_reject_fake_financial_mutation_v1()
FROM PUBLIC;
