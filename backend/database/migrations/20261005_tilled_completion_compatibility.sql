BEGIN;

-- Retain historical columns for already-deployed triggers/audit records. Active
-- application code reads neutral names; copy existing identifiers without loss.
ALTER TABLE escrows ADD COLUMN IF NOT EXISTS provider_payment_id TEXT;
ALTER TABLE escrows ADD COLUMN IF NOT EXISTS provider_refund_id TEXT;
UPDATE escrows SET provider_payment_id = stripe_payment_intent_id
 WHERE provider_payment_id IS NULL AND stripe_payment_intent_id IS NOT NULL;
UPDATE escrows SET provider_refund_id = stripe_refund_id
 WHERE provider_refund_id IS NULL AND stripe_refund_id IS NOT NULL;
UPDATE escrows SET provider_transfer_id = stripe_transfer_id
 WHERE provider_transfer_id IS NULL AND stripe_transfer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS escrows_provider_payment_id_uq
 ON escrows(provider_payment_id) WHERE provider_payment_id IS NOT NULL;

-- Historical state-policy triggers still consult the old payment-ID column.
-- One-way mirroring preserves those guards without any deprecated provider API.
CREATE OR REPLACE FUNCTION sync_escrow_legacy_payment_identifier() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.stripe_payment_intent_id := NEW.provider_payment_id;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS aa_escrow_legacy_payment_identifier ON escrows;
CREATE TRIGGER aa_escrow_legacy_payment_identifier
 BEFORE INSERT OR UPDATE OF provider_payment_id ON escrows
 FOR EACH ROW EXECUTE FUNCTION sync_escrow_legacy_payment_identifier();

ALTER TABLE escrows DROP CONSTRAINT IF EXISTS escrows_payout_provider_ck;
-- Historical provider value remains readable; the release evidence trigger below
-- refuses NEW releases using a deprecated provider.
ALTER TABLE escrows ADD CONSTRAINT escrows_payout_provider_ck CHECK (
 payout_provider IS NULL OR payout_provider IN ('STRIPE', 'LOCAL_CERTIFICATION_TEST', 'MANUAL_RECONCILIATION', 'TILLED')
);
ALTER TABLE escrows DROP CONSTRAINT IF EXISTS escrows_provider_transfer_status_ck;
ALTER TABLE escrows ADD CONSTRAINT escrows_provider_transfer_status_ck CHECK (
 provider_transfer_status IS NULL OR provider_transfer_status IN ('submitted','processing','paid','manual_reconciliation','not_applicable')
);

CREATE OR REPLACE FUNCTION enforce_escrow_payout_provider_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  task_row RECORD;
  has_worker_evidence BOOLEAN := FALSE;
  has_business_evidence BOOLEAN := FALSE;
BEGIN
  IF NEW.state <> 'RELEASED' OR OLD.state = 'RELEASED' THEN
    RETURN NEW;
  END IF;

  SELECT
    state,
    worker_id,
    business_fulfiller_organization_id,
    orchestration_mode,
    automation_classification
  INTO task_row
  FROM tasks
  WHERE id = NEW.task_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXLPO13: completion bookkeeping requires an existing task';
  END IF;

  IF NEW.payout_provider = 'LOCAL_CERTIFICATION_TEST' THEN

    IF task_row.worker_id IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1
        FROM hxos_local_test_payout_transfers transfer
        WHERE transfer.id = NEW.provider_transfer_id
          AND transfer.task_id = NEW.task_id
          AND transfer.escrow_id = NEW.id
          AND transfer.worker_id = task_row.worker_id
          AND transfer.status = 'paid'
          AND transfer.paid_at IS NOT NULL
          AND transfer.is_test IS TRUE
      )
      INTO has_worker_evidence;
    END IF;

    IF task_row.orchestration_mode = 'OPS_MANUAL'
       AND task_row.business_fulfiller_organization_id IS NOT NULL
       AND task_row.worker_id IS NULL THEN

      SELECT EXISTS (
        SELECT 1
        FROM hxos_local_test_business_payout_transfers transfer
        JOIN hxos_local_test_business_payout_destinations destination
          ON destination.id = transfer.destination_id
        WHERE transfer.id = NEW.provider_transfer_id
          AND transfer.task_id = NEW.task_id
          AND transfer.escrow_id = NEW.id
          AND transfer.organization_id =
              task_row.business_fulfiller_organization_id
          AND transfer.status = 'paid'
          AND transfer.paid_at IS NOT NULL
          AND transfer.is_test IS TRUE
          AND destination.organization_id =
              transfer.organization_id
          AND destination.payout_recipient_user_id =
              transfer.payout_recipient_user_id
          AND destination.status = 'ACTIVE'
          AND destination.is_test IS TRUE
      )
      INTO has_business_evidence;
    END IF;

    IF task_row.automation_classification IS DISTINCT FROM 'CONTROLLED_TEST'
       OR NEW.stripe_transfer_id IS NOT NULL
       OR NEW.provider_transfer_status IS DISTINCT FROM 'paid'
       OR NEW.provider_transfer_paid_at IS NULL
       OR NOT (has_worker_evidence OR has_business_evidence) THEN

      RAISE EXCEPTION
        'HXLPO8: local TEST escrow release lacks exact paid provider evidence';
    END IF;

  ELSIF NEW.payout_provider = 'TILLED' THEN
    -- The charge already paid the business merchant. This is internal bookkeeping.
    IF task_row.business_fulfiller_organization_id IS NULL
       OR (task_row.state IS DISTINCT FROM 'COMPLETED' AND OLD.state IS DISTINCT FROM 'LOCKED_DISPUTE')
       OR NEW.stripe_transfer_id IS NOT NULL
       OR NEW.provider_transfer_id IS NOT NULL
       OR NEW.provider_transfer_status IS DISTINCT FROM 'not_applicable'
       OR NEW.provider_transfer_paid_at IS NOT NULL
       OR NOT EXISTS (
         SELECT 1 FROM quote_payments payment
         JOIN quotes quote ON quote.id = payment.quote_id
         JOIN quote_versions version ON version.id = payment.quote_version_id AND version.quote_id = quote.id
         WHERE payment.task_id = NEW.task_id
           AND payment.provider = 'tilled' AND payment.status = 'SUCCEEDED'
           AND payment.finalization_state = 'FINALIZED'
           AND payment.intent_creation_state = 'BOUND'
           AND payment.provider_status = 'succeeded'
           AND payment.amount_cents = NEW.amount
           AND payment.business_organization_id = task_row.business_fulfiller_organization_id
           AND payment.provider_payment_id = NEW.provider_payment_id
           AND quote.business_organization_id = task_row.business_fulfiller_organization_id
           AND version.total_cents = NEW.amount
       ) THEN
      RAISE EXCEPTION 'HXLPO12: Tilled completion lacks exact successful business payment evidence';
    END IF;

  ELSIF NEW.payout_provider = 'MANUAL_RECONCILIATION' THEN

    IF NEW.provider_transfer_status IS DISTINCT FROM 'manual_reconciliation'
       OR NEW.provider_transfer_paid_at IS NOT NULL THEN
      RAISE EXCEPTION
        'HXLPO10: manual release must remain visibly unreconciled';
    END IF;

  ELSE
    RAISE EXCEPTION
      'HXLPO11: released escrow requires an explicit payout provider';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON COLUMN escrows.provider_payment_id IS 'Canonical provider payment reference; legacy column mirrored only for historical database guards';
COMMENT ON COLUMN escrows.provider_transfer_status IS 'not_applicable denotes internal completion bookkeeping for merchant-direct Tilled charges; no external transfer';
COMMIT;
