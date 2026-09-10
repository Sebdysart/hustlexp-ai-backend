ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS type TEXT,
  ADD COLUMN IF NOT EXISTS message TEXT,
  ADD COLUMN IF NOT EXISTS entity_type TEXT,
  ADD COLUMN IF NOT EXISTS entity_id UUID,
  ADD COLUMN IF NOT EXISTS action_url TEXT;

UPDATE public.notifications
SET type = COALESCE(type, category),
    message = COALESCE(message, body)
WHERE type IS NULL OR message IS NULL;

ALTER TABLE public.notifications
  ALTER COLUMN type SET DEFAULT 'general',
  ALTER COLUMN message SET DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS notifications_user_dedupe_idx
  ON public.notifications (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

ALTER TABLE public.business_assessment_requests
  DROP CONSTRAINT IF EXISTS business_assessment_requests_status_check;

ALTER TABLE public.business_assessment_requests
  ADD CONSTRAINT business_assessment_requests_status_check
  CHECK (status IN (
    'PENDING_ADMIN', 'ADMIN_REJECTED', 'AWAITING_CUSTOMER',
    'SCHEDULED', 'COMPLETED', 'CANCELLED', 'CUSTOMER_DECLINED'
  ));
