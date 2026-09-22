-- Ordinary lifecycle notification requests reuse the canonical outbox. Keep
-- their bounded lease recovery indexed alongside the existing premium index.
CREATE INDEX outbox_notification_request_dispatch_lease
  ON outbox_events(enqueued_at)
  WHERE status = 'enqueued' AND event_type = 'notification.create_requested';
