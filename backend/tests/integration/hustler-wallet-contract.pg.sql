\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE users (
  id UUID PRIMARY KEY,
  account_status TEXT NOT NULL DEFAULT 'ACTIVE'
);
INSERT INTO users(id) VALUES ('00000000-0000-4000-8000-000000000001');

\ir ../../database/migrations/20260719_hustler_wallet_contract.sql

CREATE OR REPLACE FUNCTION assert_true(condition BOOLEAN, message TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF condition IS NOT TRUE THEN RAISE EXCEPTION 'assertion failed: %', message; END IF;
END $$;

INSERT INTO worker_cash_out_requests (
  id,worker_id,provider_account_id,provider_destination_id,idempotency_key,request_hash,
  amount_cents,fee_cents,net_cents,method,destination_type,destination_last4,
  destination_label,policy_version
) VALUES (
  '10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001',
  'acct_wallet_test','ba_wallet_test','wallet:test:request:1',repeat('a',64),
  5000,0,5000,'STANDARD','BANK_ACCOUNT','4242','Field Bank','hx-wallet-standard-v1'
);

SELECT assert_true(
  (SELECT count(*) = 1 FROM worker_cash_out_events
   WHERE cash_out_request_id='10000000-0000-4000-8000-000000000001'
     AND event_type='INITIATING'),
  'request creation must atomically record INITIATING event'
);

DO $$
BEGIN
  BEGIN
    UPDATE worker_cash_out_requests SET amount_cents=6000
    WHERE id='10000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'immutable amount update unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXWAL2:%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE worker_cash_out_requests SET state='SUBMITTED'
    WHERE id='10000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'submission without provider evidence unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXWAL4:%' THEN RAISE; END IF;
  END;
END $$;

UPDATE worker_cash_out_requests
SET provider_payout_id='po_wallet_test',state='SUBMITTED',
    estimated_arrival_at=NOW()+INTERVAL '2 days',last_transition_source='PROVIDER_API'
WHERE id='10000000-0000-4000-8000-000000000001';

UPDATE worker_cash_out_requests
SET state='PROVIDER_PROCESSING',last_transition_source='PROVIDER_WEBHOOK',
    last_provider_event_id='evt_wallet_transit'
WHERE id='10000000-0000-4000-8000-000000000001';

UPDATE worker_cash_out_requests
SET state='PAID',paid_at=NOW(),last_transition_source='PROVIDER_WEBHOOK',
    last_provider_event_id='evt_wallet_paid'
WHERE id='10000000-0000-4000-8000-000000000001';

SELECT assert_true(
  (SELECT array_agg(event_type ORDER BY CASE event_type
       WHEN 'INITIATING' THEN 1 WHEN 'SUBMITTED' THEN 2
       WHEN 'PROVIDER_PROCESSING' THEN 3 WHEN 'PAID' THEN 4 ELSE 99 END) =
     ARRAY['INITIATING','SUBMITTED','PROVIDER_PROCESSING','PAID']::text[]
   FROM worker_cash_out_events
   WHERE cash_out_request_id='10000000-0000-4000-8000-000000000001'),
  'provider states must have one ordered append-only event trail'
);

DO $$
BEGIN
  BEGIN
    UPDATE worker_cash_out_requests SET state='SUBMITTED'
    WHERE id='10000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'paid-to-submitted regression unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXWAL3:%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE worker_cash_out_events SET amount_cents=1
    WHERE cash_out_request_id='10000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'event mutation unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXWAL6:%' THEN RAISE; END IF;
  END;
END $$;

UPDATE users SET account_status='DELETED'
WHERE id='00000000-0000-4000-8000-000000000001';

SELECT assert_true(
  (SELECT worker_id IS NULL AND provider_account_id IS NULL
          AND provider_destination_id IS NULL AND destination_last4='0000'
          AND amount_cents=5000 AND provider_payout_id='po_wallet_test'
   FROM worker_cash_out_requests
   WHERE id='10000000-0000-4000-8000-000000000001'),
  'GDPR unlink must scrub routing while preserving financial evidence'
);

SELECT 'HUSTLER_WALLET_DATABASE_CONTRACT_OK' AS result;
