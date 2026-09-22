ALTER TABLE business_payment_accounts
  ADD COLUMN IF NOT EXISTS provider_onboarding_status TEXT,
  ADD COLUMN IF NOT EXISTS onboarding_state TEXT NOT NULL DEFAULT 'BOUND'
    CHECK (onboarding_state IN ('RESERVED', 'CREATING', 'BOUND', 'RECONCILE_REQUIRED')),
  ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS business_payment_accounts_application_uq
  ON business_payment_accounts(provider, environment, application_id)
  WHERE application_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS business_payment_accounts_onboarding_state_idx
  ON business_payment_accounts(provider, environment, onboarding_state)
  WHERE onboarding_state <> 'BOUND';
