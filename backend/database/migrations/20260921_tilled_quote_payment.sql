-- Provider-neutral organization merchant identity. A payout account is not a
-- customer-charge merchant account and must never be used as a fallback.
CREATE TABLE IF NOT EXISTS business_payment_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES business_organizations(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
  provider_account_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'ACTIVE', 'IN_REVIEW', 'DISABLED', 'REJECTED', 'WITHDRAWN')),
  charges_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  application_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, provider, environment),
  UNIQUE (provider, environment, provider_account_id)
);

CREATE INDEX IF NOT EXISTS business_payment_accounts_organization_idx
  ON business_payment_accounts(organization_id);

-- provider_payment_id remains NOT NULL for historical quote payments. Tilled
-- attempts initially use a deterministic local reservation reference, which is
-- replaced by the provider ID only after the provider call succeeds.
ALTER TABLE quote_payments
  ADD COLUMN IF NOT EXISTS provider_environment TEXT
    CHECK (provider_environment IS NULL OR provider_environment IN ('sandbox', 'production')),
  ADD COLUMN IF NOT EXISTS provider_status TEXT,
  ADD COLUMN IF NOT EXISTS intent_creation_state TEXT
    CHECK (intent_creation_state IS NULL OR intent_creation_state IN ('RESERVED', 'CREATING', 'BOUND', 'RECONCILE_REQUIRED'));

CREATE TABLE IF NOT EXISTS payment_provider_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'RECEIVED'
    CHECK (processing_status IN ('RECEIVED', 'PROCESSED', 'DEFERRED', 'FAILED')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  last_error TEXT,
  UNIQUE (provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS payment_provider_events_unprocessed_idx
  ON payment_provider_events(provider, received_at)
  WHERE processing_status IN ('RECEIVED', 'FAILED');
