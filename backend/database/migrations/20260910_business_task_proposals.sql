CREATE TABLE IF NOT EXISTS public.business_task_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_draft_id UUID NOT NULL REFERENCES task_drafts(id) ON DELETE CASCADE,
  business_organization_id UUID NOT NULL REFERENCES business_organizations(id) ON DELETE CASCADE,
  created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','VIEWED','QUOTED','REJECTED','CANCELLED','EXPIRED')),
  quote_id UUID REFERENCES quotes(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  viewed_at TIMESTAMPTZ,
  responded_at TIMESTAMPTZ,
  rejection_reason TEXT,
  cancelled_at TIMESTAMPTZ,
  cancelled_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS business_task_proposals_draft_idx ON public.business_task_proposals(task_draft_id, created_at DESC);
CREATE INDEX IF NOT EXISTS business_task_proposals_business_idx ON public.business_task_proposals(business_organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS business_task_proposals_status_idx ON public.business_task_proposals(status, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS business_task_proposals_one_active_per_business_draft_idx ON public.business_task_proposals(task_draft_id, business_organization_id) WHERE status IN ('PENDING','VIEWED');
