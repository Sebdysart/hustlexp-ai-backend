-- Preserve the acquisition source of an assessment and its eventual canonical quote.
ALTER TABLE public.business_assessment_requests
  ADD COLUMN IF NOT EXISTS proposal_id UUID REFERENCES public.business_task_proposals(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS quote_id UUID REFERENCES public.quotes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS quote_is_net_of_credit BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS business_assessment_requests_proposal_uq
  ON public.business_assessment_requests(proposal_id) WHERE proposal_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS business_assessment_requests_quote_uq
  ON public.business_assessment_requests(quote_id) WHERE quote_id IS NOT NULL;

-- A prior proposal-origin assessment has no source ID. Recover only a unique
-- organization/draft pair; leave any competing or ambiguous history untouched.
WITH unique_proposals AS (
  SELECT task_draft_id, business_organization_id, MIN(id::text)::uuid AS proposal_id
  FROM public.business_task_proposals
  GROUP BY task_draft_id, business_organization_id HAVING COUNT(*) = 1
), unique_unbound_assessments AS (
  SELECT task_draft_id, business_organization_id, MIN(id::text)::uuid AS assessment_id
  FROM public.business_assessment_requests
  WHERE claim_link_id IS NULL AND proposal_id IS NULL
  GROUP BY task_draft_id, business_organization_id HAVING COUNT(*) = 1
)
UPDATE public.business_assessment_requests assessment
SET proposal_id = proposal.proposal_id
FROM unique_unbound_assessments orphan
JOIN unique_proposals proposal USING (task_draft_id, business_organization_id)
WHERE assessment.id = orphan.assessment_id;

-- Existing ambiguous rows remain readable for operations. New writes must
-- bind exactly one acquisition source.
ALTER TABLE public.business_assessment_requests
  ADD CONSTRAINT business_assessment_requests_source_xor_ck
  CHECK ((claim_link_id IS NOT NULL) <> (proposal_id IS NOT NULL)) NOT VALID;

-- Only backfill historical claim quotes when the claim has one unambiguous assessment.
UPDATE public.business_assessment_requests assessment
SET quote_id = claim.quote_id
FROM public.ops_business_claim_links claim
WHERE assessment.claim_link_id = claim.id AND claim.quote_id IS NOT NULL
  AND assessment.quote_id IS NULL
  AND (SELECT COUNT(*) FROM public.business_assessment_requests sibling
       WHERE sibling.claim_link_id = claim.id) = 1
  AND (SELECT COUNT(*) FROM public.business_assessment_requests sibling
       JOIN public.ops_business_claim_links source ON source.id = sibling.claim_link_id
       WHERE source.quote_id = claim.quote_id) = 1
  AND NOT EXISTS (SELECT 1 FROM public.business_assessment_requests other
                  WHERE other.quote_id = claim.quote_id);

ALTER TABLE public.assessment_payments
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE public.assessment_payments
  ADD CONSTRAINT assessment_payments_currency_usd_ck CHECK (currency = 'USD');

-- Controlled certification is a separate assessment provider ledger. It uses
-- the existing local-test secret/gate and never creates task or escrow records.
CREATE TABLE IF NOT EXISTS public.hxos_local_test_assessment_intents (
  id TEXT PRIMARY KEY,
  assessment_payment_id UUID NOT NULL UNIQUE REFERENCES public.assessment_payments(id) ON DELETE RESTRICT,
  assessment_request_id UUID NOT NULL UNIQUE REFERENCES public.business_assessment_requests(id) ON DELETE RESTRICT,
  task_draft_id UUID NOT NULL REFERENCES public.task_drafts(id) ON DELETE RESTRICT,
  business_organization_id UUID NOT NULL REFERENCES public.business_organizations(id) ON DELETE RESTRICT,
  poster_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL CHECK (currency = 'USD'),
  client_secret_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requires_confirmation'
    CHECK (status IN ('requires_confirmation', 'succeeded')),
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.hxos_local_test_assessment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id TEXT NOT NULL REFERENCES public.hxos_local_test_assessment_intents(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('intent_created', 'intent_succeeded')),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS assessment_payments_pending_reconcile_idx
  ON public.assessment_payments(updated_at, id)
  WHERE provider = 'local_test' AND status = 'PENDING';
