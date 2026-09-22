-- A checkout reservation is the immutable identity of an obligation. Paid
-- recovery must not depend on the quote's mutable active-version pointer.
ALTER TABLE quote_payments
  ADD COLUMN IF NOT EXISTS reserved_poster_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),
  ADD COLUMN IF NOT EXISTS provider_succeeded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS finalization_state TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (finalization_state IN ('PENDING', 'FINALIZED', 'MANUAL_COMPENSATION_REQUIRED')),
  ADD COLUMN IF NOT EXISTS finalization_reason TEXT;

-- Previous Tilled checkout locked this exact customer's version-specific service
-- address before inserting a reservation. That durable record, rather than a
-- mutable draft poster or current active version, proves the historical owner.
UPDATE quote_payments payment
SET reserved_poster_id = address.user_id,
    reserved_at = payment.created_at
FROM quote_service_addresses address
WHERE payment.provider = 'tilled'
  AND payment.quote_version_id = address.quote_version_id
  AND address.locked_at IS NOT NULL
  AND payment.reserved_poster_id IS NULL;

UPDATE quote_payments
SET finalization_state = 'FINALIZED',
    provider_succeeded_at = COALESCE(provider_succeeded_at, updated_at)
WHERE provider = 'tilled' AND status = 'SUCCEEDED' AND task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS quote_payments_tilled_recovery_idx
  ON quote_payments(provider_environment, updated_at, id)
  WHERE provider = 'tilled' AND status = 'PENDING' AND finalization_state = 'PENDING';

CREATE INDEX IF NOT EXISTS quote_payments_manual_compensation_idx
  ON quote_payments(updated_at, id)
  WHERE finalization_state = 'MANUAL_COMPENSATION_REQUIRED';

COMMENT ON COLUMN quote_payments.finalization_state IS
  'Canonical task outcome; manual compensation records verified customer payment without claiming a refund or settlement.';
