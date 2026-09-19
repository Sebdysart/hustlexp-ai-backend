CREATE TABLE IF NOT EXISTS public.support_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opened_by_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  business_organization_id UUID NULL REFERENCES public.business_organizations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'IN_PROGRESS', 'RESOLVED')),
  subject TEXT NOT NULL,
  context_type TEXT NOT NULL DEFAULT 'GENERAL' CHECK (context_type IN ('GENERAL', 'TASK_DRAFT', 'TASK', 'PROPOSAL', 'QUOTE')),
  task_draft_id UUID NULL REFERENCES public.task_drafts(id) ON DELETE SET NULL,
  task_id UUID NULL REFERENCES public.tasks(id) ON DELETE SET NULL,
  proposal_id UUID NULL REFERENCES public.business_task_proposals(id) ON DELETE SET NULL,
  quote_id UUID NULL REFERENCES public.quotes(id) ON DELETE SET NULL,
  source_route TEXT NULL,
  resolved_by_user_id UUID NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  resolved_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (length(trim(subject)) > 0)
);

CREATE TABLE IF NOT EXISTS public.support_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES public.support_threads(id) ON DELETE CASCADE,
  sender_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  sender_kind TEXT NOT NULL CHECK (sender_kind IN ('USER', 'OPS')),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (length(trim(body)) > 0)
);

CREATE INDEX IF NOT EXISTS support_threads_status_idx ON public.support_threads(status);
CREATE INDEX IF NOT EXISTS support_threads_opened_by_idx ON public.support_threads(opened_by_user_id);
CREATE INDEX IF NOT EXISTS support_threads_business_idx ON public.support_threads(business_organization_id);
CREATE INDEX IF NOT EXISTS support_threads_task_draft_idx ON public.support_threads(task_draft_id);
CREATE INDEX IF NOT EXISTS support_threads_updated_idx ON public.support_threads(updated_at DESC);
CREATE INDEX IF NOT EXISTS support_messages_thread_idx ON public.support_messages(thread_id, created_at);
