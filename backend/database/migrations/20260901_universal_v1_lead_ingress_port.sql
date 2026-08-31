-- Canonical backend/PostgreSQL replacement for the contained Supabase
-- lead-submit writer. Existing rows remain legacy version 0; new backend rows
-- bind an exact request hash, privacy evidence, and asynchronous confirmation.

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS ingress_request_hash TEXT,
  ADD COLUMN IF NOT EXISTS ingress_contract_version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS execution_environment TEXT,
  ADD COLUMN IF NOT EXISTS turnstile_action TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'leads_ingress_request_hash_shape'
       AND conrelid = 'public.leads'::regclass
  ) THEN
    ALTER TABLE public.leads
      ADD CONSTRAINT leads_ingress_request_hash_shape
      CHECK (ingress_request_hash IS NULL OR ingress_request_hash ~ '^[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'leads_ingress_contract_version_shape'
       AND conrelid = 'public.leads'::regclass
  ) THEN
    ALTER TABLE public.leads
      ADD CONSTRAINT leads_ingress_contract_version_shape
      CHECK (ingress_contract_version IN (0, 1));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_leads_ingress_rate_window
  ON public.leads(ip_hash, lead_type, created_at DESC)
  WHERE ip_hash IS NOT NULL;

-- The provider-neutral email worker already accepts an absent user identity.
-- Add a lead owner so anonymous intake confirmations use the same durable
-- outbox, retry, sink isolation, and provider receipt path as account email.
ALTER TABLE public.email_outbox
  ALTER COLUMN user_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS lead_id UUID REFERENCES public.leads(id) ON DELETE RESTRICT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'email_outbox_exactly_one_owner'
       AND conrelid = 'public.email_outbox'::regclass
  ) THEN
    ALTER TABLE public.email_outbox
      ADD CONSTRAINT email_outbox_exactly_one_owner
      CHECK (num_nonnulls(user_id, lead_id) = 1) NOT VALID;
  END IF;
END
$$;

ALTER TABLE public.email_outbox
  VALIDATE CONSTRAINT email_outbox_exactly_one_owner;

CREATE INDEX IF NOT EXISTS idx_email_outbox_lead
  ON public.email_outbox(lead_id, created_at DESC)
  WHERE lead_id IS NOT NULL;
