CREATE TABLE IF NOT EXISTS quote_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id UUID NOT NULL REFERENCES quotes(id) ON DELETE RESTRICT,
  quote_version_id UUID NOT NULL REFERENCES quote_versions(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  provider_payment_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  status TEXT NOT NULL CHECK (
    status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_payment_id),
  UNIQUE (quote_id, quote_version_id)
);
ALTER TABLE public.quote_payments
  ADD COLUMN IF NOT EXISTS task_id UUID
    REFERENCES public.tasks(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS quote_payments_task_id_uq
  ON public.quote_payments(task_id)
  WHERE task_id IS NOT NULL;