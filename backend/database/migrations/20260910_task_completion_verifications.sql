CREATE TABLE IF NOT EXISTS public.task_completion_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  poster_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  business_organization_id UUID NOT NULL REFERENCES business_organizations(id) ON DELETE RESTRICT,
  code_hash CHAR(64) NOT NULL CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0 AND failed_attempts <= 5),
  verified_at TIMESTAMPTZ,
  verified_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_id)
);

CREATE INDEX IF NOT EXISTS task_completion_verifications_business_idx
  ON public.task_completion_verifications (business_organization_id);
CREATE INDEX IF NOT EXISTS task_completion_verifications_expiry_idx
  ON public.task_completion_verifications (expires_at)
  WHERE verified_at IS NULL;
