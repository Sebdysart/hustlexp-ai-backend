-- Close the unfilled-expiry gap for a PaymentIntent that was created but never
-- confirmed. Expiry remains atomic: the task records a pending financial
-- closeout and the signed critical-payments worker performs the Stripe side
-- effect. Provider evidence is stored separately from the immutable intent id.

ALTER TABLE escrows
  ADD COLUMN IF NOT EXISTS payment_intent_canceled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_escrows_pending_payment_cancel
  ON escrows (task_id, id)
  WHERE state = 'PENDING'
    AND stripe_payment_intent_id IS NOT NULL
    AND payment_intent_canceled_at IS NULL;

-- Repair any already-expired controlled or production task that previously
-- hard-stopped at BLOCKED_PENDING_PAYMENT_INTENT_CANCELLATION. The same stable
-- idempotency key is used by the runtime path, so deploy replay is harmless.
INSERT INTO outbox_events (
  event_type, aggregate_type, aggregate_id, event_version,
  idempotency_key, payload, queue_name, status
)
SELECT
  'escrow.refund_requested', 'escrow', e.id, 1,
  'dispatch-expiry-cancel:' || t.id::text,
  jsonb_build_object(
    'escrow_id', e.id,
    'task_id', t.id,
    'reason', 'dispatch_expired_unfilled',
    'financial_action', 'cancel_pending_payment_intent'
  ),
  'critical_payments', 'pending'
FROM tasks t
JOIN LATERAL (
  SELECT id, state, stripe_payment_intent_id, payment_intent_canceled_at
  FROM escrows
  WHERE task_id = t.id
  ORDER BY created_at DESC
  LIMIT 1
) e ON TRUE
WHERE t.state = 'EXPIRED'
  AND t.expiration_reason = 'UNFILLED'
  AND t.refund_state = 'BLOCKED'
  AND t.refund_blocker = 'BLOCKED_PENDING_PAYMENT_INTENT_CANCELLATION'
  AND e.state = 'PENDING'
  AND e.stripe_payment_intent_id IS NOT NULL
  AND e.payment_intent_canceled_at IS NULL
ON CONFLICT (idempotency_key) DO NOTHING;

UPDATE tasks t
SET refund_state = 'PENDING',
    refund_blocker = NULL,
    refund_requested_at = COALESCE(refund_requested_at, NOW()),
    updated_at = NOW()
WHERE t.state = 'EXPIRED'
  AND t.expiration_reason = 'UNFILLED'
  AND t.refund_state = 'BLOCKED'
  AND t.refund_blocker = 'BLOCKED_PENDING_PAYMENT_INTENT_CANCELLATION'
  AND EXISTS (
    SELECT 1 FROM escrows e
    WHERE e.task_id = t.id
      AND e.state = 'PENDING'
      AND e.stripe_payment_intent_id IS NOT NULL
      AND e.payment_intent_canceled_at IS NULL
  );
