-- Exact addresses are encrypted with the existing location key ring.
CREATE TABLE IF NOT EXISTS customer_saved_addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_ciphertext TEXT NOT NULL,
  location_nonce TEXT NOT NULL,
  location_auth_tag TEXT NOT NULL,
  location_key_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS customer_saved_addresses_user_idx
  ON customer_saved_addresses(user_id, created_at DESC);

-- A durable checkout handoff, not a second task-location source of truth.
-- The encrypted payload is erased in the transaction that writes the task vault.
CREATE TABLE IF NOT EXISTS quote_service_addresses (
  quote_version_id UUID PRIMARY KEY REFERENCES quote_versions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_ciphertext TEXT,
  location_nonce TEXT,
  location_auth_tag TEXT,
  location_key_id TEXT,
  locked_at TIMESTAMPTZ,
  task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (task_id IS NULL AND location_ciphertext IS NOT NULL AND location_nonce IS NOT NULL
      AND location_auth_tag IS NOT NULL AND location_key_id IS NOT NULL)
    OR
    (task_id IS NOT NULL AND location_ciphertext IS NULL AND location_nonce IS NULL
      AND location_auth_tag IS NULL AND location_key_id IS NULL)
  )
);
