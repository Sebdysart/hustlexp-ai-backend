BEGIN;

-- Pending-phone claims now expose their secure continuation URL to Ops for
-- manual delivery. Retire only the automatic SMS records created by that flow.
DELETE FROM outbox_events
WHERE event_type = 'sms.send_requested'
  AND aggregate_type = 'pending_phone_draft_claim';

DELETE FROM sms_outbox
WHERE recipient_kind = 'pending_phone_claim';

DROP INDEX IF EXISTS sms_outbox_pending_claim_idempotency;

ALTER TABLE sms_outbox
  DROP CONSTRAINT IF EXISTS sms_outbox_pending_claim_fk,
  DROP CONSTRAINT IF EXISTS sms_outbox_recipient_shape_chk,
  DROP CONSTRAINT IF EXISTS sms_outbox_recipient_kind_chk;

-- All remaining SMS rows belong to authenticated users. Fail closed if an
-- unexpected accountless row exists instead of silently deleting it.
ALTER TABLE sms_outbox
  ALTER COLUMN user_id SET NOT NULL,
  DROP COLUMN IF EXISTS recipient_context_id,
  DROP COLUMN IF EXISTS recipient_kind;

COMMIT;
