ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS business_organization_id UUID
    REFERENCES public.business_organizations(id) ON DELETE RESTRICT;

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS business_location_id UUID
    REFERENCES public.business_locations(id) ON DELETE RESTRICT;

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS provider_service_profile_id UUID
    REFERENCES public.business_service_profiles(id) ON DELETE RESTRICT;

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS claimed_by_user_id UUID
    REFERENCES public.users(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS quotes_business_org_idx
  ON public.quotes(business_organization_id)
  WHERE business_organization_id IS NOT NULL;
