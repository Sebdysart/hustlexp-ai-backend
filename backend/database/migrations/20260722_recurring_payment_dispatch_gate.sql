-- HX/OS recurring payment-before-dispatch repair.
-- A generated occurrence is demand, not a provider offer. Provider response
-- windows begin only after the canonical escrow is FUNDED.

BEGIN;

ALTER TABLE recurring_provider_reservations
  DROP CONSTRAINT IF EXISTS recurring_provider_reservations_status_check;

ALTER TABLE recurring_provider_reservations
  ADD CONSTRAINT recurring_provider_reservations_status_check
  CHECK (status IN (
    'AWAITING_PAYMENT','PENDING','ACCEPTED','DECLINED','TIMED_OUT','CANCELLED'
  ));

UPDATE recurring_provider_reservations reservation
SET status='AWAITING_PAYMENT',expires_at=NOW()
FROM recurring_task_occurrences occurrence
WHERE occurrence.id=reservation.occurrence_id
  AND reservation.status='PENDING'
  AND NOT EXISTS (
    SELECT 1 FROM escrows escrow
    WHERE escrow.task_id=occurrence.task_id AND escrow.state='FUNDED'
  );

UPDATE recurring_task_occurrences occurrence
SET reservation_state=reservation.pool_type||'_AWAITING_PAYMENT',updated_at=NOW()
FROM recurring_provider_reservations reservation
WHERE reservation.occurrence_id=occurrence.id
  AND reservation.status='AWAITING_PAYMENT';

CREATE INDEX IF NOT EXISTS recurring_provider_awaiting_payment_idx
  ON recurring_provider_reservations(created_at,id)
  WHERE status='AWAITING_PAYMENT';

COMMIT;
