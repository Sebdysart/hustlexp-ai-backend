BEGIN;

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS orchestration_mode TEXT
    NOT NULL DEFAULT 'AUTOMATED';

ALTER TABLE public.tasks
  DROP CONSTRAINT IF EXISTS tasks_orchestration_mode_check;

ALTER TABLE public.tasks
  ADD CONSTRAINT tasks_orchestration_mode_check
  CHECK (orchestration_mode IN ('AUTOMATED', 'OPS_MANUAL'));

CREATE INDEX IF NOT EXISTS tasks_manual_business_idx
  ON public.tasks (business_fulfiller_organization_id, created_at DESC)
  WHERE orchestration_mode = 'OPS_MANUAL';

COMMIT;