-- Durable notification provider-call authority.
--
-- `provider_in_flight` is recorded immediately before external provider I/O and
-- committed without holding a transaction open across that I/O. Supersession
-- may mark the notification stale, but cannot misreport an already-started
-- provider attempt as cancelled.

ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_delivery_state_chk,
  ADD CONSTRAINT notifications_delivery_state_chk CHECK (delivery_state IN (
    'pending','deferred_quiet_hours','deferred_focus','queued','partially_queued',
    'provider_in_flight','provider_outcome_unknown','provider_accepted','delivered','retry_pending',
    'failed_terminal','suppressed','cancelled_superseded'
  ));

ALTER TABLE public.notification_deliveries
  ADD COLUMN IF NOT EXISTS provider_attempt_id UUID,
  ADD COLUMN IF NOT EXISTS provider_attempt_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_attempt_deadline_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recovery_claim_id UUID,
  ADD COLUMN IF NOT EXISTS recovery_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recovery_claim_deadline_at TIMESTAMPTZ,
  DROP CONSTRAINT IF EXISTS notification_deliveries_state_check,
  DROP CONSTRAINT IF EXISTS notification_deliveries_state_chk,
  ADD CONSTRAINT notification_deliveries_state_chk CHECK (state IN (
    'pending','deferred_quiet_hours','deferred_focus','queued','provider_in_flight',
    'provider_outcome_unknown','provider_accepted','delivered','retry_pending','failed_terminal','suppressed',
    'cancelled_superseded'
  )),
  DROP CONSTRAINT IF EXISTS notification_deliveries_provider_attempt_truth_chk,
  ADD CONSTRAINT notification_deliveries_provider_attempt_truth_chk CHECK (
    state NOT IN ('provider_in_flight','provider_outcome_unknown')
    OR (
      provider_attempt_id IS NOT NULL
      AND provider_attempt_started_at IS NOT NULL
      AND provider_attempt_deadline_at IS NOT NULL
      AND provider_attempt_deadline_at > provider_attempt_started_at
    )
  );

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_in_flight_deadline
  ON public.notification_deliveries(provider_attempt_deadline_at, notification_id)
  WHERE state = 'provider_in_flight';

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_recovery_claim_deadline
  ON public.notification_deliveries(recovery_claim_deadline_at, notification_id)
  WHERE state = 'retry_pending' AND recovery_claim_id IS NOT NULL;

COMMENT ON CONSTRAINT notifications_delivery_state_chk ON public.notifications IS
  'Aggregate delivery truth, including a provider call that has started but has no provider receipt yet.';
COMMENT ON CONSTRAINT notification_deliveries_state_chk ON public.notification_deliveries IS
  'Per-channel delivery truth; provider_in_flight is a durable pre-I/O claim, not provider acceptance.';
COMMENT ON COLUMN public.notification_deliveries.provider_attempt_id IS
  'Unique token binding provider callbacks to the exact durable pre-I/O claim.';
COMMENT ON COLUMN public.notification_deliveries.provider_attempt_started_at IS
  'Database time at which the token-bound provider attempt began.';
COMMENT ON COLUMN public.notification_deliveries.provider_attempt_deadline_at IS
  'Bound after which an unresolved provider attempt becomes provider_outcome_unknown and cannot auto-retry.';

-- Queue dispatch and channel claims are durable leases. They are distinct from
-- `notification_deliveries.provider_in_flight`: these leases prove only that a
-- worker owns pre-provider preparation. `provider_io_started_at` closes the
-- safely-retryable crash window immediately before external I/O.
ALTER TABLE public.outbox_events
  ADD COLUMN IF NOT EXISTS dispatch_attempt_id UUID,
  ADD COLUMN IF NOT EXISTS dispatch_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dispatch_deadline_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pre_provider_claim_id UUID,
  ADD COLUMN IF NOT EXISTS pre_provider_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pre_provider_claim_deadline_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_io_started_at TIMESTAMPTZ;

ALTER TABLE public.email_outbox
  ADD COLUMN IF NOT EXISTS pre_provider_claim_id UUID,
  ADD COLUMN IF NOT EXISTS pre_provider_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pre_provider_claim_deadline_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_io_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notification_provider_attempt_id UUID;

ALTER TABLE public.sms_outbox
  ADD COLUMN IF NOT EXISTS pre_provider_claim_id UUID,
  ADD COLUMN IF NOT EXISTS pre_provider_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pre_provider_claim_deadline_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_io_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notification_provider_attempt_id UUID;

-- A provider call can time out after the provider has accepted it.  Channel
-- rows need a terminal, operator-reconciled state of their own, including for
-- direct/lead deliveries that intentionally have no notification aggregate.
ALTER TABLE public.email_outbox
  DROP CONSTRAINT IF EXISTS email_outbox_status_check;
ALTER TABLE public.email_outbox
  ALTER COLUMN status TYPE VARCHAR(32);
ALTER TABLE public.email_outbox
  ADD CONSTRAINT email_outbox_status_check CHECK (
    status IN ('pending','sending','sent','failed','suppressed','provider_outcome_unknown')
  );

ALTER TABLE public.sms_outbox
  DROP CONSTRAINT IF EXISTS sms_outbox_status_chk;
ALTER TABLE public.sms_outbox
  ALTER COLUMN status TYPE VARCHAR(32);
ALTER TABLE public.sms_outbox
  ADD CONSTRAINT sms_outbox_status_chk CHECK (
    status IN ('pending','sending','sent','failed','suppressed','provider_outcome_unknown')
  );

CREATE INDEX IF NOT EXISTS idx_outbox_dispatch_deadline
  ON public.outbox_events(dispatch_deadline_at, id)
  WHERE status = 'enqueued';
CREATE INDEX IF NOT EXISTS idx_outbox_pre_provider_deadline
  ON public.outbox_events(pre_provider_claim_deadline_at, id)
  WHERE status = 'processing' AND provider_io_started_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_email_outbox_pre_provider_deadline
  ON public.email_outbox(pre_provider_claim_deadline_at, id)
  WHERE status = 'sending' AND provider_io_started_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sms_outbox_pre_provider_deadline
  ON public.sms_outbox(pre_provider_claim_deadline_at, id)
  WHERE status = 'sending' AND provider_io_started_at IS NULL;

COMMENT ON COLUMN public.outbox_events.dispatch_attempt_id IS
  'Stable identity for one ambiguous database-to-BullMQ dispatch attempt; stale recovery reuses its exact BullMQ job ID.';
COMMENT ON COLUMN public.outbox_events.pre_provider_claim_id IS
  'Token for a worker lease that has not yet crossed the external provider I/O boundary.';
COMMENT ON COLUMN public.email_outbox.notification_provider_attempt_id IS
  'Exact notification provider claim token bound to the persisted provider receipt.';
COMMENT ON COLUMN public.sms_outbox.notification_provider_attempt_id IS
  'Exact notification provider claim token bound to the persisted provider receipt.';
