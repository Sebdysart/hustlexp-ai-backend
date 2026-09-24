-- A direct business proposal has no claim-link row. Keep the claim-link FK for
-- claim-origin assessments while allowing proposal-origin assessment requests.
ALTER TABLE public.business_assessment_requests
  ALTER COLUMN claim_link_id DROP NOT NULL;
