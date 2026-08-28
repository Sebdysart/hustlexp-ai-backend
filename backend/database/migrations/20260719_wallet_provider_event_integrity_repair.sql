-- Converges databases where the first provider-event integrity migration was
-- applied before historical receipt versioning was introduced. No existing
-- append-only event row is updated.

ALTER TABLE worker_cash_out_events
  ADD COLUMN IF NOT EXISTS receipt_contract_version SMALLINT NOT NULL DEFAULT 1;

ALTER TABLE worker_cash_out_events
  ALTER COLUMN receipt_contract_version SET DEFAULT 2;

ALTER TABLE worker_cash_out_events
  DROP CONSTRAINT IF EXISTS worker_cash_out_provider_event_requires_reported_state;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'worker_cash_out_event_contract_version_check'
  ) THEN
    ALTER TABLE worker_cash_out_events
      ADD CONSTRAINT worker_cash_out_event_contract_version_check
      CHECK (receipt_contract_version IN (1,2));
  END IF;

  ALTER TABLE worker_cash_out_events
    ADD CONSTRAINT worker_cash_out_provider_event_requires_reported_state
    CHECK (
      receipt_contract_version = 1
      OR source = 'USER_REQUEST'
      OR provider_reported_state IS NOT NULL
    );
END $$;

COMMENT ON COLUMN worker_cash_out_events.receipt_contract_version IS
  'Version 1 marks untouched historical receipts; version 2 requires normalized provider-state attribution.';
