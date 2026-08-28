-- HX/OS wallet provider-event integrity.
--
-- Stripe documents that payout.failed can arrive after payout.paid. HustleXP
-- projects that late provider failure as REVERSED, while retaining the raw
-- provider-reported state and whether each webhook changed canonical state.

ALTER TABLE worker_cash_out_events
  ADD COLUMN IF NOT EXISTS provider_reported_state TEXT,
  ADD COLUMN IF NOT EXISTS disposition TEXT NOT NULL DEFAULT 'APPLIED',
  ADD COLUMN IF NOT EXISTS receipt_contract_version SMALLINT NOT NULL DEFAULT 1;

-- Existing append-only receipts remain untouched as contract v1. Every row
-- inserted after this migration is contract v2 and must carry normalized raw
-- provider state when the source is not the user.
ALTER TABLE worker_cash_out_events
  ALTER COLUMN receipt_contract_version SET DEFAULT 2;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'worker_cash_out_event_reported_state_check'
  ) THEN
    ALTER TABLE worker_cash_out_events
      ADD CONSTRAINT worker_cash_out_event_reported_state_check
      CHECK (
        provider_reported_state IS NULL
        OR provider_reported_state IN (
          'INITIATING','SUBMITTED','PROVIDER_PROCESSING','PAID','FAILED','REVERSED'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'worker_cash_out_event_contract_version_check'
  ) THEN
    ALTER TABLE worker_cash_out_events
      ADD CONSTRAINT worker_cash_out_event_contract_version_check
      CHECK (receipt_contract_version IN (1,2));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'worker_cash_out_event_disposition_check'
  ) THEN
    ALTER TABLE worker_cash_out_events
      ADD CONSTRAINT worker_cash_out_event_disposition_check
      CHECK (disposition IN ('APPLIED','NO_STATE_CHANGE','IGNORED_STALE'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'worker_cash_out_provider_event_requires_reported_state'
  ) THEN
    ALTER TABLE worker_cash_out_events
      ADD CONSTRAINT worker_cash_out_provider_event_requires_reported_state
      CHECK (
        receipt_contract_version = 1
        OR source = 'USER_REQUEST'
        OR provider_reported_state IS NOT NULL
      );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION record_worker_cash_out_event()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.state IS DISTINCT FROM OLD.state THEN
    INSERT INTO worker_cash_out_events (
      cash_out_request_id,worker_id,event_type,source,provider_event_id,
      provider_payout_id,amount_cents,fee_cents,net_cents,currency,public_reason,
      provider_reported_state,disposition
    ) VALUES (
      NEW.id,NEW.worker_id,NEW.state,NEW.last_transition_source,NEW.last_provider_event_id,
      NEW.provider_payout_id,NEW.amount_cents,NEW.fee_cents,NEW.net_cents,NEW.currency,
      CASE
        WHEN NEW.state = 'FAILED' THEN COALESCE(NEW.failure_message,'Bank payout failed.')
        WHEN NEW.state = 'REVERSED' THEN COALESCE(
          NEW.failure_message,
          'The provider reversed this bank payout.'
        )
        ELSE NULL
      END,
      CASE WHEN NEW.last_transition_source = 'USER_REQUEST' THEN NULL ELSE NEW.state END,
      'APPLIED'
    )
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_worker_cash_out_provider_identity()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.provider_payout_id IS NOT NULL
     AND NEW.provider_payout_id IS DISTINCT FROM OLD.provider_payout_id THEN
    RAISE EXCEPTION 'HXWAL7: bound provider payout identity cannot change'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.last_provider_event_id IS DISTINCT FROM OLD.last_provider_event_id
     AND NEW.last_provider_event_id IS NOT NULL THEN
    IF NEW.last_transition_source <> 'PROVIDER_WEBHOOK' OR NOT EXISTS (
      SELECT 1
      FROM worker_cash_out_events event
      WHERE event.cash_out_request_id = NEW.id
        AND event.provider_event_id = NEW.last_provider_event_id
        AND event.provider_payout_id = NEW.provider_payout_id
        AND event.amount_cents = NEW.amount_cents
        AND event.fee_cents = NEW.fee_cents
        AND event.net_cents = NEW.net_cents
        AND event.source = 'PROVIDER_WEBHOOK'
    ) THEN
      RAISE EXCEPTION 'HXWAL8: provider event does not reconcile to cash-out request'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS worker_cash_out_provider_identity_guard
  ON worker_cash_out_requests;
CREATE TRIGGER worker_cash_out_provider_identity_guard
BEFORE UPDATE ON worker_cash_out_requests
FOR EACH ROW EXECUTE FUNCTION guard_worker_cash_out_provider_identity();

COMMENT ON COLUMN worker_cash_out_events.provider_reported_state IS
  'Raw normalized provider state retained even when canonical state is unchanged or a late failure projects to REVERSED.';
COMMENT ON COLUMN worker_cash_out_events.disposition IS
  'Whether this provider receipt changed canonical state, confirmed it, or was safely ignored as stale.';
COMMENT ON COLUMN worker_cash_out_events.receipt_contract_version IS
  'Version 1 marks untouched historical receipts; version 2 requires normalized provider-state attribution.';
