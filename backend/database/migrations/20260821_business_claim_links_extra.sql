ALTER TABLE public.ops_business_claim_links
  ADD COLUMN IF NOT EXISTS claimed_by_organization_id UUID
    REFERENCES public.business_organizations(id) ON DELETE RESTRICT;

ALTER TABLE public.ops_business_claim_links
  ADD COLUMN IF NOT EXISTS claimed_by_service_profile_id UUID
    REFERENCES public.business_service_profiles(id) ON DELETE RESTRICT;

ALTER TABLE public.ops_business_claim_links
  ADD COLUMN IF NOT EXISTS claimed_by_business_location_id UUID
    REFERENCES public.business_locations(id) ON DELETE RESTRICT;

ALTER TABLE public.ops_business_claim_links
  ADD COLUMN IF NOT EXISTS proposed_customer_total_cents INTEGER;

ALTER TABLE public.ops_business_claim_links
  ADD COLUMN IF NOT EXISTS proposed_payout_cents INTEGER;
