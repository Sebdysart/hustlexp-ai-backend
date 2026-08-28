-- W-16 Fix: Add partial unique index on notification_log to prevent TOCTOU
-- double-send race in xp-tax-reminder-worker.
--
-- The prior SELECT→INSERT pattern allowed concurrent workers to both pass the
-- SELECT check and both insert a row. This partial unique index ensures only
-- one row per (user_id, xp_tax_reminder) can exist at a time, so the atomic
-- INSERT ... ON CONFLICT DO NOTHING RETURNING id pattern in the worker will
-- return 0 rows for the losing worker, causing it to skip the send.
--
-- Partial index (WHERE type = 'xp_tax_reminder') keeps the constraint narrow
-- so other notification types in the same table are unaffected.

CREATE UNIQUE INDEX IF NOT EXISTS notification_log_user_type_unique
ON notification_log(user_id, notification_type)
WHERE notification_type = 'xp_tax_reminder';
