-- Merchant-direct Tilled refunds retain the successful original payment row.
ALTER TABLE quote_payments ADD CONSTRAINT quote_payments_id_task_uq UNIQUE (id, task_id);

CREATE TABLE quote_payment_refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_payment_id UUID NOT NULL,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  provider_merchant_id TEXT NOT NULL CHECK (provider_merchant_id ~ '^acct_[A-Za-z0-9_]+$'),
  provider_environment TEXT NOT NULL CHECK (provider_environment IN ('sandbox', 'production')),
  tilled_payment_intent_id TEXT NOT NULL CHECK (tilled_payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),
  tilled_reason TEXT NOT NULL CHECK (tilled_reason IN ('duplicate', 'fraudulent', 'requested_by_customer')),
  internal_reason TEXT NOT NULL CHECK (char_length(btrim(internal_reason)) BETWEEN 10 AND 2000),
  refund_platform_fee BOOLEAN NOT NULL DEFAULT TRUE CHECK (refund_platform_fee),
  expected_platform_fee_refund_cents INTEGER NOT NULL CHECK (expected_platform_fee_refund_cents >= 0),
  ops_actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  local_attempt_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'RESERVED' CHECK (status IN
    ('RESERVED', 'PROCESSING', 'PENDING', 'UNCERTAIN', 'SUCCEEDED', 'FAILED', 'REQUIRES_ACTION', 'CANCELED')),
  tilled_refund_id TEXT UNIQUE,
  tilled_charge_id TEXT,
  failure_code TEXT,
  failure_message TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  terminal_at TIMESTAMPTZ,
  CONSTRAINT quote_payment_refunds_payment_task_fk FOREIGN KEY (quote_payment_id, task_id)
    REFERENCES quote_payments(id, task_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX quote_payment_refunds_one_nonterminal
  ON quote_payment_refunds(quote_payment_id)
  WHERE status IN ('RESERVED', 'PROCESSING', 'PENDING', 'UNCERTAIN', 'REQUIRES_ACTION');
CREATE INDEX quote_payment_refunds_reconcile_due
  ON quote_payment_refunds(updated_at, id)
  WHERE status IN ('PROCESSING', 'PENDING', 'UNCERTAIN', 'REQUIRES_ACTION');
CREATE INDEX quote_payment_refunds_task_history ON quote_payment_refunds(task_id, requested_at DESC);
