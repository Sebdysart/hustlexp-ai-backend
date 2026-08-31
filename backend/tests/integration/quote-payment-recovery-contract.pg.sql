\set ON_ERROR_STOP on

INSERT INTO leads(id, submission_id, lead_type, email)
VALUES (
  'c1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000002',
  'poster',
  'hxupgrade-poster@e2e.invalid'
);

INSERT INTO task_drafts(
  id, submission_id, card_token_hash, raw_input, lead_id
) VALUES (
  'c2000000-0000-4000-8000-000000000001',
  'c2000000-0000-4000-8000-000000000002',
  repeat('c', 64),
  'Recovery contract fixture',
  'c1000000-0000-4000-8000-000000000001'
);

INSERT INTO quotes(id, lead_id, task_draft_id, title, status)
VALUES (
  'c3000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'c2000000-0000-4000-8000-000000000001',
  'Recovery contract quote',
  'quote_ready'
);

INSERT INTO quote_versions(
  id, quote_id, version_number, customer_description, total_cents, pay_token
) VALUES (
  'c4000000-0000-4000-8000-000000000001',
  'c3000000-0000-4000-8000-000000000001',
  1,
  'Recovery contract quote version',
  12500,
  repeat('d', 32)
);

UPDATE quotes
SET active_version_id = 'c4000000-0000-4000-8000-000000000001'
WHERE id = 'c3000000-0000-4000-8000-000000000001';

INSERT INTO quote_payments(
  id, quote_id, quote_version_id, provider, provider_payment_id,
  amount_cents, status
) VALUES (
  'c5000000-0000-4000-8000-000000000001',
  'c3000000-0000-4000-8000-000000000001',
  'c4000000-0000-4000-8000-000000000001',
  'stripe',
  'pi_quote_recovery_pg_contract',
  12500,
  'PENDING'
);

INSERT INTO quote_payment_recovery_operations(
  id, quote_payment_id, actor_id, reason_code, expected_status,
  expected_payment_updated_at, claim_token, correlation_id,
  lease_expires_at, idempotency_key
) VALUES (
  'c6000000-0000-4000-8000-000000000001',
  'c5000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000001',
  'UNDERWRITING_CONTAINMENT',
  'PENDING',
  (SELECT updated_at FROM quote_payments
   WHERE id = 'c5000000-0000-4000-8000-000000000001'),
  'c6000000-0000-4000-8000-000000000002',
  'c6000000-0000-4000-8000-000000000003',
  NOW() + INTERVAL '5 minutes',
  'quote-payment-recovery:c5000000-0000-4000-8000-000000000001'
);

INSERT INTO quote_payment_recovery_events(
  recovery_operation_id, quote_payment_id, actor_id, event_type,
  reason_code, from_status, canonical_status, idempotency_key
) VALUES (
  'c6000000-0000-4000-8000-000000000001',
  'c5000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000001',
  'CLAIMED',
  'UNDERWRITING_CONTAINMENT',
  'PENDING',
  'PENDING',
  'quote-payment-recovery:c5000000-0000-4000-8000-000000000001:claim'
);

DO $$
BEGIN
  BEGIN
    UPDATE quote_payment_recovery_events SET canonical_status = 'SUCCEEDED';
    RAISE EXCEPTION 'append-only UPDATE unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'HXQPR5:%' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM quote_payment_recovery_events;
    RAISE EXCEPTION 'append-only DELETE unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'HXQPR5:%' THEN RAISE; END IF;
  END;
  BEGIN
    TRUNCATE quote_payment_recovery_events;
    RAISE EXCEPTION 'append-only TRUNCATE unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'HXQPR5:%' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM quote_payment_recovery_operations;
    RAISE EXCEPTION 'operation DELETE unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'HXQPR1:%' THEN RAISE; END IF;
  END;
END;
$$;

UPDATE quote_payments SET status = 'FAILED'
WHERE id = 'c5000000-0000-4000-8000-000000000001';

UPDATE quote_payment_recovery_operations
SET operation_state = 'COMPLETED',
    recovery_action = 'VOIDED',
    provider_status = 'canceled',
    provider_operation_id = 'pi_quote_recovery_pg_contract'
WHERE id = 'c6000000-0000-4000-8000-000000000001';

INSERT INTO quote_payment_recovery_events(
  recovery_operation_id, quote_payment_id, actor_id, event_type,
  reason_code, recovery_action, from_status, canonical_status,
  provider_status, provider_operation_id, idempotency_key
) VALUES (
  'c6000000-0000-4000-8000-000000000001',
  'c5000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000001',
  'COMPLETED',
  'UNDERWRITING_CONTAINMENT',
  'VOIDED',
  'PENDING',
  'FAILED',
  'canceled',
  'pi_quote_recovery_pg_contract',
  'quote-payment-recovery:c6000000-0000-4000-8000-000000000001:completed'
);

DO $$
BEGIN
  BEGIN
    UPDATE quote_payment_recovery_operations SET attempt_count = attempt_count + 1;
    RAISE EXCEPTION 'terminal operation mutation unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'HXQPR3:%' THEN RAISE; END IF;
  END;
END;
$$;

SELECT 'HXOS_QUOTE_PAYMENT_RECOVERY_CONTRACT_OK' AS result;
