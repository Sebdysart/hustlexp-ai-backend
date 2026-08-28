-- HX/OS 2.0 forward-only notification delivery convergence repair.
--
-- Migration 56 created these objects on a clean database through its
-- self-contained table definitions, but did not add them when upgrading the
-- pre-existing email and SMS outboxes. Keep the historical migration intact
-- and converge both database histories idempotently here.

ALTER TABLE public.email_outbox
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_sms_outbox_status
  ON public.sms_outbox(status)
  WHERE status IN ('pending', 'failed');
