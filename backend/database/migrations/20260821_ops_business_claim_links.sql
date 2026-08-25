-- Ops-generated, opaque business claim links for manual marketplace launch.
-- The raw token is never persisted; only its SHA-256 hash is stored.

CREATE TABLE IF NOT EXISTS public.ops_business_claim_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  task_draft_id UUID NOT NULL
    REFERENCES public.task_drafts(id)
    ON DELETE RESTRICT,

  token_hash TEXT NOT NULL
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),

  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN', 'CLAIMED', 'EXPIRED', 'REVOKED')),

  created_by UUID NOT NULL
    REFERENCES public.users(id)
    ON DELETE RESTRICT,

  claimed_by_business_user_id UUID NULL
    REFERENCES public.users(id)
    ON DELETE RESTRICT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  expires_at TIMESTAMPTZ NOT NULL,

  claimed_at TIMESTAMPTZ NULL,
  revoked_at TIMESTAMPTZ NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS
  ops_business_claim_links_token_hash_uq
ON public.ops_business_claim_links(token_hash);

-- At most one currently-open link per task draft.
CREATE UNIQUE INDEX IF NOT EXISTS
  ops_business_claim_links_one_open_per_draft_uq
ON public.ops_business_claim_links(task_draft_id)
WHERE status = 'OPEN';

CREATE INDEX IF NOT EXISTS
  ops_business_claim_links_draft_idx
ON public.ops_business_claim_links(task_draft_id);

CREATE INDEX IF NOT EXISTS
  ops_business_claim_links_expires_idx
ON public.ops_business_claim_links(status, expires_at);
