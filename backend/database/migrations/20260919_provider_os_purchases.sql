-- Standalone business product purchases; no task, quote, escrow or payout links.
CREATE TABLE provider_os_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES business_organizations(id) ON DELETE RESTRICT,
  purchaser_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  product_code TEXT NOT NULL DEFAULT 'provider_os' CHECK (product_code = 'provider_os'),
  provider TEXT NOT NULL CHECK (provider = 'local_test'),
  provider_payment_id TEXT UNIQUE,
  provider_transaction_id TEXT UNIQUE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL CHECK (currency = 'usd'),
  period_days INTEGER NOT NULL CHECK (period_days BETWEEN 1 AND 366),
  test_mode BOOLEAN NOT NULL CHECK (test_mode),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed','canceled')),
  paid_at TIMESTAMPTZ,
  granted_starts_at TIMESTAMPTZ,
  granted_expires_at TIMESTAMPTZ,
  resolution_reason TEXT,
  next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status <> 'succeeded' OR (paid_at IS NOT NULL AND granted_expires_at IS NOT NULL))
);
CREATE UNIQUE INDEX provider_os_purchase_pending_org ON provider_os_purchases(organization_id) WHERE status = 'pending';
CREATE INDEX provider_os_purchase_org_history ON provider_os_purchases(organization_id,created_at DESC);
CREATE INDEX provider_os_purchase_due ON provider_os_purchases(next_check_at) WHERE status = 'pending';
ALTER TABLE provider_os_entitlements DROP CONSTRAINT provider_os_entitlements_grant_source_check;
ALTER TABLE provider_os_entitlements ADD CONSTRAINT provider_os_entitlements_grant_source_check CHECK (grant_source IN ('manual_ops','purchase'));
ALTER TABLE provider_os_entitlements ADD COLUMN source_purchase_id UUID REFERENCES provider_os_purchases(id) ON DELETE RESTRICT;

-- Separate provider ledger: controlled-test product payments cannot impersonate task/escrow intents.
CREATE TABLE hxos_local_test_product_intents (
  id TEXT PRIMARY KEY,
  purchase_id UUID NOT NULL UNIQUE REFERENCES provider_os_purchases(id) ON DELETE RESTRICT,
  organization_id UUID NOT NULL REFERENCES business_organizations(id) ON DELETE RESTRICT,
  purchaser_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  product_code TEXT NOT NULL CHECK (product_code = 'provider_os'),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL CHECK (currency = 'usd'),
  period_days INTEGER NOT NULL CHECK (period_days BETWEEN 1 AND 366),
  is_test BOOLEAN NOT NULL DEFAULT true CHECK (is_test),
  client_secret_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requires_confirmation' CHECK (status IN ('requires_confirmation','succeeded','failed','canceled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  succeeded_at TIMESTAMPTZ
);
CREATE TABLE hxos_local_test_product_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_intent_id TEXT NOT NULL REFERENCES hxos_local_test_product_intents(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('intent_created','intent_succeeded')),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
