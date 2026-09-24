-- Preserve Provider OS consent provenance on canonical assessment requests.
-- Existing claim/proposal rows remain unchanged. Historical unbound rows are
-- not guessed into a Provider OS relationship.
ALTER TABLE public.business_assessment_requests
  ADD COLUMN IF NOT EXISTS provider_os_relationship_id UUID
  REFERENCES public.provider_os_relationships(id) ON DELETE RESTRICT;

ALTER TABLE public.business_assessment_requests
  DROP CONSTRAINT IF EXISTS business_assessment_requests_source_xor_ck;

-- NOT VALID preserves historical ambiguous rows; new requests must name
-- exactly one acquisition source.
ALTER TABLE public.business_assessment_requests
  ADD CONSTRAINT business_assessment_requests_source_one_ck
  CHECK (num_nonnulls(claim_link_id, proposal_id, provider_os_relationship_id) = 1) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS business_assessment_requests_provider_os_source_uq
  ON public.business_assessment_requests(provider_os_relationship_id, task_draft_id)
  WHERE provider_os_relationship_id IS NOT NULL;
