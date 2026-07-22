-- HX/OS Focus suppression for P3-P5 notification traffic.
--
-- External opportunity, digest, and optional-growth work remains persisted but
-- unavailable until canonical active execution ends. In-app rows remain
-- inspectable when the Hustler intentionally opens the inbox.

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS focus_task_id UUID,
  ADD COLUMN IF NOT EXISTS focus_deferred_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS focus_released_at TIMESTAMPTZ,
  DROP CONSTRAINT IF EXISTS notifications_focus_task_fk,
  ADD CONSTRAINT notifications_focus_task_fk
    FOREIGN KEY (focus_task_id) REFERENCES public.tasks(id) ON DELETE SET NULL,
  DROP CONSTRAINT IF EXISTS notifications_delivery_state_chk,
  ADD CONSTRAINT notifications_delivery_state_chk CHECK (delivery_state IN (
    'pending','deferred_quiet_hours','deferred_focus','queued','partially_queued',
    'provider_accepted','delivered','retry_pending','failed_terminal','suppressed',
    'cancelled_superseded'
  ));

ALTER TABLE public.notification_deliveries
  DROP CONSTRAINT IF EXISTS notification_deliveries_state_check,
  DROP CONSTRAINT IF EXISTS notification_deliveries_state_chk,
  ADD CONSTRAINT notification_deliveries_state_chk CHECK (state IN (
    'pending','deferred_quiet_hours','deferred_focus','queued','provider_accepted',
    'delivered','retry_pending','failed_terminal','suppressed','cancelled_superseded'
  ));

CREATE INDEX IF NOT EXISTS idx_notifications_focus_deferred
  ON public.notifications(user_id, focus_deferred_at, id)
  WHERE delivery_state = 'deferred_focus';

COMMENT ON COLUMN public.notifications.focus_task_id IS
  'Canonical active task that caused P3-P5 external delivery to defer.';
COMMENT ON COLUMN public.notifications.focus_deferred_at IS
  'Database time at which external delivery entered HX/OS Focus deferral.';
COMMENT ON COLUMN public.notifications.focus_released_at IS
  'Database time at which no active execution remained and deferred delivery was released.';
