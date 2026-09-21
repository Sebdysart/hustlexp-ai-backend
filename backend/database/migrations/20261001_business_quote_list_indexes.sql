-- Stable organization-scoped quote pagination.
CREATE INDEX IF NOT EXISTS quotes_business_org_created_idx
  ON public.quotes(business_organization_id, created_at DESC, id DESC)
  WHERE business_organization_id IS NOT NULL;

-- Bounded route resolution without joining proposal history into quote rows.
CREATE INDEX IF NOT EXISTS business_task_proposals_quote_route_idx
  ON public.business_task_proposals(quote_id, created_at DESC, id DESC)
  WHERE quote_id IS NOT NULL;

-- Bounded route resolution for claim-origin and legacy organization quotes.
CREATE INDEX IF NOT EXISTS ops_business_claim_links_quote_route_idx
  ON public.ops_business_claim_links(quote_id, created_at DESC, id DESC)
  WHERE quote_id IS NOT NULL;
