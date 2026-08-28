-- Reconcile expired/unfilled tasks whose latest escrow never reached Stripe.
-- There is no PaymentIntent, charge, refund, or payout to perform. The prior
-- blocker represented missing automation, not an outstanding financial action.

UPDATE tasks t
SET refund_state = 'NOT_REQUIRED',
    refund_blocker = NULL,
    updated_at = NOW()
WHERE t.state = 'EXPIRED'
  AND t.expiration_reason = 'UNFILLED'
  AND t.refund_state = 'BLOCKED'
  AND t.refund_blocker = 'BLOCKED_PENDING_ESCROW_CANCELLATION'
  AND EXISTS (
    SELECT 1
    FROM LATERAL (
      SELECT state, stripe_payment_intent_id, stripe_refund_id
      FROM escrows
      WHERE task_id = t.id
      ORDER BY created_at DESC
      LIMIT 1
    ) e
    WHERE e.state = 'PENDING'
      AND e.stripe_payment_intent_id IS NULL
      AND e.stripe_refund_id IS NULL
  );
