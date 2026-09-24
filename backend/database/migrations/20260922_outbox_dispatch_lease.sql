-- The dispatcher now reclaims all expired enqueue leases, not just selected
-- event names. Support its exact bounded lease scan without scanning history.
CREATE INDEX IF NOT EXISTS outbox_dispatch_lease_idx
  ON outbox_events (COALESCE(enqueued_at, created_at), id)
  WHERE status = 'enqueued';
