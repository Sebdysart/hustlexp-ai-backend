BEGIN;

CREATE TABLE IF NOT EXISTS public.hxos_local_test_business_payout_destinations (
  id TEXT PRIMARY KEY,
  organization_id UUID NOT NULL
    REFERENCES public.business_organizations(id) ON DELETE RESTRICT,
  payout_recipient_user_id UUID NOT NULL
    REFERENCES public.users(id) ON DELETE RESTRICT,
  destination_fingerprint TEXT NOT NULL
    CHECK (destination_fingerprint ~ '^[a-f0-9]{64}$'),
  provider_mode TEXT NOT NULL DEFAULT 'local_certification_test'
    CHECK (provider_mode = 'local_certification_test'),
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status = 'ACTIVE'),
  is_test BOOLEAN NOT NULL DEFAULT TRUE
    CHECK (is_test IS TRUE),
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id)
);

CREATE TABLE IF NOT EXISTS public.hxos_local_test_business_payout_transfers (
  id TEXT PRIMARY KEY,
  task_id UUID NOT NULL
    REFERENCES public.tasks(id) ON DELETE RESTRICT,
  escrow_id UUID NOT NULL
    REFERENCES public.escrows(id) ON DELETE RESTRICT,
  organization_id UUID NOT NULL
    REFERENCES public.business_organizations(id) ON DELETE RESTRICT,
  payout_recipient_user_id UUID NOT NULL
    REFERENCES public.users(id) ON DELETE RESTRICT,
  destination_id TEXT NOT NULL
    REFERENCES public.hxos_local_test_business_payout_destinations(id) ON DELETE RESTRICT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'usd'
    CHECK (currency = 'usd'),
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','processing','paid')),
  provider_mode TEXT NOT NULL DEFAULT 'local_certification_test'
    CHECK (provider_mode = 'local_certification_test'),
  is_test BOOLEAN NOT NULL DEFAULT TRUE
    CHECK (is_test IS TRUE),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL
    CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processing_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_id),
  UNIQUE (escrow_id),
  CHECK (
    (status = 'submitted' AND processing_at IS NULL AND paid_at IS NULL)
    OR
    (status = 'processing' AND processing_at IS NOT NULL AND paid_at IS NULL)
    OR
    (status = 'paid' AND processing_at IS NOT NULL AND paid_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS hxos_local_test_business_payout_org_idx
  ON public.hxos_local_test_business_payout_destinations(organization_id);

COMMIT;