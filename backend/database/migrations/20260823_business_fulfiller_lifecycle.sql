BEGIN;

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS business_fulfiller_organization_id UUID
    REFERENCES public.business_organizations(id)
    ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS tasks_business_fulfiller_org_idx
  ON public.tasks (business_fulfiller_organization_id, created_at DESC)
  WHERE business_fulfiller_organization_id IS NOT NULL;

ALTER TABLE public.tasks
  DROP CONSTRAINT IF EXISTS tasks_fulfiller_entity_check;

ALTER TABLE public.tasks
  ADD CONSTRAINT tasks_fulfiller_entity_check
  CHECK (
    NOT (
      worker_id IS NOT NULL
      AND business_fulfiller_organization_id IS NOT NULL
    )
  );

COMMIT;