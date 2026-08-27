BEGIN;

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
    worker_id,
    business_fulfiller_organization_id,
    orchestration_mode,
    automation_classification
  INTO task_row
  FROM tasks
  WHERE id = NEW.task_id;

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

    IF task_row.automation_classification <> 'CONTROLLED_TEST'
       OR NEW.stripe_transfer_id IS NOT NULL
       OR NEW.provider_transfer_status <> 'paid'
       OR NEW.provider_transfer_paid_at IS NULL
       OR NOT (has_worker_evidence OR has_business_evidence) THEN

      RAISE EXCEPTION
        'HXLPO8: local TEST escrow release lacks exact paid provider evidence';
    END IF;

  ELSIF NEW.payout_provider = 'STRIPE' THEN

    IF NEW.stripe_transfer_id IS NULL
       OR NEW.provider_transfer_id IS DISTINCT FROM NEW.stripe_transfer_id
       OR NEW.provider_transfer_status NOT IN ('submitted', 'processing', 'paid') THEN
      RAISE EXCEPTION
        'HXLPO9: Stripe escrow release lacks provider transfer identity';
    END IF;

  ELSIF NEW.payout_provider = 'MANUAL_RECONCILIATION' THEN

    IF NEW.provider_transfer_status <> 'manual_reconciliation'
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

COMMIT;
