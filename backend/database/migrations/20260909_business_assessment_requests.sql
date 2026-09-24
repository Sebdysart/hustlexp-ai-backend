CREATE TABLE IF NOT EXISTS public.business_assessment_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_draft_id UUID NOT NULL REFERENCES public.task_drafts(id) ON DELETE RESTRICT,
  business_organization_id UUID NOT NULL REFERENCES public.business_organizations(id) ON DELETE RESTRICT,
  claim_link_id UUID NOT NULL REFERENCES public.ops_business_claim_links(id) ON DELETE RESTRICT,
  requested_by_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  business_message TEXT NOT NULL,
  proposed_window_start TIMESTAMPTZ NOT NULL,
  proposed_window_end TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING_ADMIN'
    CHECK (status IN ('PENDING_ADMIN', 'ADMIN_REJECTED', 'AWAITING_CUSTOMER', 'SCHEDULED', 'COMPLETED', 'CANCELLED')),
  customer_message TEXT NULL,
  reviewed_by_user_id UUID NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  reviewed_at TIMESTAMPTZ NULL,
  scheduled_date DATE NULL,
  customer_selected_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (length(trim(business_message)) > 0),
  CHECK (proposed_window_end > proposed_window_start)
);

CREATE INDEX IF NOT EXISTS business_assessment_requests_draft_idx
  ON public.business_assessment_requests(task_draft_id);
CREATE INDEX IF NOT EXISTS business_assessment_requests_business_idx
  ON public.business_assessment_requests(business_organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS business_assessment_requests_one_active_per_business_draft_uq
  ON public.business_assessment_requests(task_draft_id, business_organization_id)
  WHERE status IN ('PENDING_ADMIN', 'AWAITING_CUSTOMER', 'SCHEDULED');
