CREATE OR REPLACE FUNCTION enforce_controlled_test_business_acceptance()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.state = 'ACCEPTED'
     AND NEW.automation_classification = 'CONTROLLED_TEST'
  THEN
    IF NEW.business_fulfiller_organization_id IS NULL
       OR NEW.worker_id IS NOT NULL THEN
      RETURN NEW;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM business_organizations organization
      WHERE organization.id = NEW.business_fulfiller_organization_id
        AND organization.status = 'ACTIVE'
        AND organization.provider_enabled = TRUE
    ) THEN
      RAISE EXCEPTION
        'HXBC1: Business fulfiller is not active or provider-enabled'
        USING ERRCODE = 'P0001';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM escrows escrow
      WHERE escrow.task_id = NEW.id
        AND escrow.state = 'FUNDED'
    ) THEN
      RAISE EXCEPTION
        'HXBC2: Business task is not funded'
        USING ERRCODE = 'P0001';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM hxos_local_test_business_payout_destinations destination
      WHERE destination.organization_id = NEW.business_fulfiller_organization_id
        AND destination.status = 'ACTIVE'
        AND destination.is_test IS TRUE
    ) THEN
      RAISE EXCEPTION
        'HXBC3: Business TEST payout destination is not active'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS controlled_test_business_acceptance_guard ON public.tasks;

CREATE TRIGGER controlled_test_business_acceptance_guard
BEFORE INSERT OR UPDATE OF
  state,
  worker_id,
  business_fulfiller_organization_id
ON public.tasks
FOR EACH ROW
EXECUTE FUNCTION enforce_controlled_test_business_acceptance(); 