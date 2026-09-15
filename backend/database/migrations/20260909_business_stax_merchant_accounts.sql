CREATE TABLE IF NOT EXISTS business_stax_merchant_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES business_organizations(id) ON DELETE RESTRICT,
  stax_merchant_id TEXT NOT NULL,
  hosted_payments_token TEXT NOT NULL,
  encrypted_api_key TEXT NOT NULL,
  api_key_fingerprint CHAR(64) NOT NULL CHECK (api_key_fingerprint ~ '^[a-f0-9]{64}$'),
  onboarding_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (onboarding_status IN ('PENDING','UNDER_REVIEW','ACTIVE','RESTRICTED','REJECTED','DISABLED')),
  payments_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  provider_status_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provider_status_snapshot) = 'object'),
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id),
  UNIQUE (stax_merchant_id)
);
CREATE INDEX IF NOT EXISTS business_stax_merchant_accounts_status_idx ON business_stax_merchant_accounts (onboarding_status, payments_enabled);

