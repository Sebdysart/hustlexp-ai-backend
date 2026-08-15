BEGIN;

-- ============================================================
-- quotes: automated quote-generation contract
-- ============================================================

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS task_draft_id UUID,
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS active_version_id UUID,
  ADD COLUMN IF NOT EXISTS automation_idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'PRODUCTION',
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS task_supply_confidence_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS task_supply_confidence_evaluated_at TIMESTAMPTZ;

-- Existing projects may already have these constraints/FKs.
-- Create them only when absent.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.quotes'::regclass
      AND conname = 'quotes_task_draft_id_fkey'
  ) THEN
    ALTER TABLE public.quotes
      ADD CONSTRAINT quotes_task_draft_id_fkey
      FOREIGN KEY (task_draft_id)
      REFERENCES public.task_drafts(id)
      ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.quotes'::regclass
      AND conname = 'quotes_active_version_id_fkey'
  ) THEN
    ALTER TABLE public.quotes
      ADD CONSTRAINT quotes_active_version_id_fkey
      FOREIGN KEY (active_version_id)
      REFERENCES public.quote_versions(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS quotes_automation_idempotency_key_uq
  ON public.quotes (automation_idempotency_key)
  WHERE automation_idempotency_key IS NOT NULL;


-- ============================================================
-- quote_versions: quote timing contract
-- ============================================================

ALTER TABLE public.quote_versions
  ADD COLUMN IF NOT EXISTS arrival_window_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS arrival_window_end TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dispatch_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;


-- ============================================================
-- task_drafts: fields touched by automated quote creation
-- ============================================================

ALTER TABLE public.task_drafts
  ADD COLUMN IF NOT EXISTS quote_send_ready_at TIMESTAMPTZ;


-- ============================================================
-- Quote/supply linkage validation
-- ============================================================

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS task_supply_confidence_evaluated_at TIMESTAMPTZ;

COMMIT;