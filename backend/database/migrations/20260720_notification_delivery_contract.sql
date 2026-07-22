-- HX/OS 2.0 notification delivery contract.
-- Closes class/object truth, replay dedupe, lifecycle supersession, quiet-hour
-- deferment, bounded delivery, provider observability, and operator-visible
-- terminal failure across push, email, SMS, in-app, and digest notifications.

-- The required production migration chain never registered the older ad hoc
-- push/SMS migration. Own these prerequisites here so clean and upgraded
-- databases expose the same delivery surface.
CREATE TABLE IF NOT EXISTS public.device_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  fcm_token TEXT NOT NULL,
  device_type VARCHAR(20) NOT NULL DEFAULT 'ios',
  device_name VARCHAR(100),
  app_version VARCHAR(20),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, fcm_token)
);

CREATE INDEX IF NOT EXISTS idx_device_tokens_user_active
  ON public.device_tokens(user_id) WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS public.sms_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  to_phone VARCHAR(20) NOT NULL,
  body TEXT NOT NULL,
  priority VARCHAR(10) NOT NULL DEFAULT 'MEDIUM',
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  twilio_sid VARCHAR(100),
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  idempotency_key TEXT UNIQUE,
  notification_id UUID,
  provider_status TEXT,
  delivered_at TIMESTAMPTZ,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS notification_class TEXT,
  ADD COLUMN IF NOT EXISTS object_type TEXT,
  ADD COLUMN IF NOT EXISTS object_id TEXT,
  ADD COLUMN IF NOT EXISTS dedupe_key TEXT,
  ADD COLUMN IF NOT EXISTS supersession_key TEXT,
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS superseded_by_notification_id UUID,
  ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS delivery_state TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS delivery_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS terminal_failure_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS terminal_failure_reason TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE public.notification_preferences
  ADD COLUMN IF NOT EXISTS quiet_hours_timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles';

UPDATE public.notifications
SET notification_class = CASE
      WHEN category IN ('account_suspended','security_alert','password_changed','task_cancelled',
                        'refund_issued','dispute_opened','dispute_resolved')
        THEN 'transaction_critical'
      WHEN category IN ('proof_submitted','proof_rejected','message_received','new_matching_task',
                        'live_mode_task','instant_task_available','payment_due')
        THEN 'action_required'
      WHEN category IN ('weekly_recap','unread_messages') THEN 'operational_digest'
      WHEN category IN ('trust_tier_upgraded','badge_earned','welcome') THEN 'growth'
      ELSE 'status'
    END,
    object_type = COALESCE(object_type, CASE WHEN task_id IS NULL THEN 'user' ELSE 'task' END),
    object_id = COALESCE(object_id, task_id::TEXT, user_id::TEXT),
    dedupe_key = COALESCE(dedupe_key, 'legacy-notification:' || id::TEXT),
    supersession_key = COALESCE(
      supersession_key,
      user_id::TEXT || ':' || CASE WHEN task_id IS NULL THEN 'user' ELSE 'task' END || ':' ||
      COALESCE(task_id::TEXT, user_id::TEXT)
    )
WHERE notification_class IS NULL
   OR object_type IS NULL
   OR object_id IS NULL
   OR dedupe_key IS NULL
   OR supersession_key IS NULL;

ALTER TABLE public.notifications
  ALTER COLUMN notification_class SET NOT NULL,
  ALTER COLUMN object_type SET NOT NULL,
  ALTER COLUMN object_id SET NOT NULL,
  ALTER COLUMN dedupe_key SET NOT NULL,
  ALTER COLUMN supersession_key SET NOT NULL;

ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_class_chk,
  ADD CONSTRAINT notifications_class_chk CHECK (notification_class IN (
    'transaction_critical','action_required','status','operational_digest','growth'
  )),
  DROP CONSTRAINT IF EXISTS notifications_delivery_state_chk,
  ADD CONSTRAINT notifications_delivery_state_chk CHECK (delivery_state IN (
    'pending','deferred_quiet_hours','queued','partially_queued','provider_accepted',
    'delivered','retry_pending','failed_terminal','suppressed','cancelled_superseded'
  )),
  DROP CONSTRAINT IF EXISTS notifications_delivery_attempts_chk,
  ADD CONSTRAINT notifications_delivery_attempts_chk CHECK (delivery_attempts BETWEEN 0 AND 5),
  DROP CONSTRAINT IF EXISTS notifications_superseded_by_fk,
  ADD CONSTRAINT notifications_superseded_by_fk
    FOREIGN KEY (superseded_by_notification_id) REFERENCES public.notifications(id) ON DELETE SET NULL,
  DROP CONSTRAINT IF EXISTS notifications_terminal_failure_truth_chk,
  ADD CONSTRAINT notifications_terminal_failure_truth_chk CHECK (
    (delivery_state = 'failed_terminal' AND terminal_failure_at IS NOT NULL
      AND terminal_failure_reason IS NOT NULL)
    OR
    (delivery_state <> 'failed_terminal' AND terminal_failure_at IS NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe_key
  ON public.notifications(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_notifications_delivery_due
  ON public.notifications(delivery_state, available_at, created_at)
  WHERE delivery_state IN ('pending','deferred_quiet_hours','retry_pending');
CREATE INDEX IF NOT EXISTS idx_notifications_supersession
  ON public.notifications(supersession_key, created_at DESC)
  WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_terminal_failure
  ON public.notifications(terminal_failure_at DESC)
  WHERE delivery_state = 'failed_terminal';

ALTER TABLE public.outbox_events
  ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE public.outbox_events
  DROP CONSTRAINT IF EXISTS outbox_events_status_check,
  DROP CONSTRAINT IF EXISTS outbox_events_status_chk,
  ADD CONSTRAINT outbox_events_status_chk CHECK (status IN (
    'pending','enqueued','processing','processed','failed'
  ));

CREATE INDEX IF NOT EXISTS idx_outbox_delivery_due
  ON public.outbox_events(status, available_at, created_at)
  WHERE status = 'pending';

ALTER TABLE public.email_outbox
  ADD COLUMN IF NOT EXISTS notification_id UUID,
  ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE public.email_outbox email
SET notification_id = (email.params_json->>'notificationId')::UUID
WHERE email.notification_id IS NULL
  AND COALESCE(email.params_json->>'notificationId','') ~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND EXISTS (
    SELECT 1 FROM public.notifications notification
    WHERE notification.id = (email.params_json->>'notificationId')::UUID
  );

ALTER TABLE public.email_outbox
  DROP CONSTRAINT IF EXISTS email_outbox_notification_fk,
  ADD CONSTRAINT email_outbox_notification_fk
    FOREIGN KEY (notification_id) REFERENCES public.notifications(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_email_outbox_notification
  ON public.email_outbox(notification_id) WHERE notification_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_outbox_available
  ON public.email_outbox(status, available_at, created_at)
  WHERE status IN ('pending','failed');

ALTER TABLE public.sms_outbox
  ADD COLUMN IF NOT EXISTS notification_id UUID,
  ADD COLUMN IF NOT EXISTS max_retries INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS provider_status TEXT,
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE public.sms_outbox SET status = 'pending' WHERE status IS NULL;
UPDATE public.sms_outbox SET retry_count = 0 WHERE retry_count IS NULL;

ALTER TABLE public.sms_outbox
  ALTER COLUMN status SET DEFAULT 'pending',
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN retry_count SET DEFAULT 0,
  ALTER COLUMN retry_count SET NOT NULL;

ALTER TABLE public.sms_outbox
  DROP CONSTRAINT IF EXISTS sms_outbox_notification_fk,
  ADD CONSTRAINT sms_outbox_notification_fk
    FOREIGN KEY (notification_id) REFERENCES public.notifications(id) ON DELETE SET NULL,
  DROP CONSTRAINT IF EXISTS sms_outbox_max_retries_chk,
  ADD CONSTRAINT sms_outbox_max_retries_chk CHECK (max_retries BETWEEN 1 AND 5),
  DROP CONSTRAINT IF EXISTS sms_outbox_retry_count_chk,
  ADD CONSTRAINT sms_outbox_retry_count_chk CHECK (retry_count BETWEEN 0 AND 5),
  DROP CONSTRAINT IF EXISTS sms_outbox_status_chk,
  ADD CONSTRAINT sms_outbox_status_chk CHECK (status IN (
    'pending','sending','sent','failed','suppressed'
  )),
  DROP CONSTRAINT IF EXISTS sms_outbox_provider_status_chk,
  ADD CONSTRAINT sms_outbox_provider_status_chk CHECK (
    provider_status IS NULL OR provider_status IN (
      'queued','accepted','sent','delivered','undelivered','failed','canceled'
    )
  );

CREATE INDEX IF NOT EXISTS idx_sms_outbox_notification
  ON public.sms_outbox(notification_id) WHERE notification_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sms_outbox_available
  ON public.sms_outbox(status, available_at, created_at)
  WHERE status IN ('pending','failed');

CREATE TABLE IF NOT EXISTS public.notification_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID NOT NULL REFERENCES public.notifications(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('in_app','push','email','sms')),
  state TEXT NOT NULL CHECK (state IN (
    'pending','deferred_quiet_hours','queued','provider_accepted','delivered',
    'retry_pending','failed_terminal','suppressed','cancelled_superseded'
  )),
  provider_name TEXT,
  provider_message_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 5),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  next_retry_at TIMESTAMPTZ,
  last_error TEXT,
  terminal_failure_at TIMESTAMPTZ,
  terminal_visibility TEXT NOT NULL DEFAULT 'operator_exception'
    CHECK (terminal_visibility = 'operator_exception'),
  provider_accepted_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (notification_id, channel),
  CHECK (
    (state = 'failed_terminal' AND terminal_failure_at IS NOT NULL AND last_error IS NOT NULL)
    OR
    (state <> 'failed_terminal' AND terminal_failure_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_due
  ON public.notification_deliveries(state, available_at, next_retry_at)
  WHERE state IN ('pending','deferred_quiet_hours','retry_pending');
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_provider
  ON public.notification_deliveries(provider_name, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_terminal
  ON public.notification_deliveries(terminal_failure_at DESC)
  WHERE state = 'failed_terminal' AND terminal_visibility = 'operator_exception';

INSERT INTO public.notification_deliveries (
  notification_id, channel, state, attempt_count, max_attempts, available_at,
  provider_accepted_at, delivered_at
)
SELECT notification.id,
       channel,
       CASE
         WHEN notification.superseded_at IS NOT NULL THEN 'cancelled_superseded'
         WHEN notification.delivered_at IS NOT NULL THEN 'delivered'
         WHEN notification.sent_at IS NOT NULL THEN 'queued'
         ELSE 'pending'
       END,
       notification.delivery_attempts,
       3,
       notification.available_at,
       notification.sent_at,
       notification.delivered_at
FROM public.notifications notification
CROSS JOIN LATERAL unnest(notification.channels) AS channel
WHERE channel IN ('in_app','push','email','sms')
ON CONFLICT (notification_id, channel) DO NOTHING;

COMMENT ON TABLE public.notification_deliveries IS
  'HX/OS provider-observable per-channel notification state with bounded retry and operator_exception terminal visibility.';
