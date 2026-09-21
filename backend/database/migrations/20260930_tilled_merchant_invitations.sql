ALTER TABLE business_payment_accounts
  ADD COLUMN IF NOT EXISTS provider_user_invitation_id TEXT,
  ADD COLUMN IF NOT EXISTS invitation_state TEXT NOT NULL DEFAULT 'NOT_CREATED'
    CHECK (invitation_state IN ('NOT_CREATED', 'CREATING', 'CREATED', 'RECONCILE_REQUIRED')),
  ADD COLUMN IF NOT EXISTS invitation_email TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS business_payment_accounts_user_invitation_uq
  ON business_payment_accounts(provider, environment, provider_user_invitation_id)
  WHERE provider_user_invitation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS business_payment_accounts_invitation_state_idx
  ON business_payment_accounts(provider, environment, invitation_state)
  WHERE invitation_state IN ('CREATING', 'RECONCILE_REQUIRED');
