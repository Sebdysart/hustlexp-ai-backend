-- Provider-neutral outbound communication receipt projection.
--
-- Keep provider_msg_id and twilio_sid as compatibility columns while new code
-- records the actual adapter kind and a channel-neutral provider message ID.
-- This migration is append-only and converges clean and upgraded databases.

ALTER TABLE public.email_outbox
  ADD COLUMN IF NOT EXISTS provider_name TEXT;

UPDATE public.email_outbox
SET provider_name = 'sendgrid'
WHERE provider_msg_id IS NOT NULL
  AND provider_name IS NULL;

ALTER TABLE public.sms_outbox
  ADD COLUMN IF NOT EXISTS provider_name TEXT,
  ADD COLUMN IF NOT EXISTS provider_message_id TEXT;

UPDATE public.sms_outbox
SET provider_name = COALESCE(provider_name, 'twilio'),
    provider_message_id = COALESCE(provider_message_id, twilio_sid)
WHERE twilio_sid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_email_outbox_provider_receipt
  ON public.email_outbox(provider_name, provider_msg_id)
  WHERE provider_msg_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sms_outbox_provider_receipt
  ON public.sms_outbox(provider_name, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
