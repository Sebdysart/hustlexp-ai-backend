BEGIN;

-- ============================================================
-- Business controlled-test acceptance routing
--
-- Existing acceptance functions are intentionally worker-specific.
-- We keep those functions unchanged and make their triggers skip
-- the Business-fulfiller task shape:
--
--   business_fulfiller_organization_id IS NOT NULL
--   worker_id IS NULL
--
-- Business tasks are instead guarded by the dedicated
-- enforce_controlled_test_business_acceptance() trigger.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Region-policy acceptance gates
-- ------------------------------------------------------------

DROP TRIGGER IF EXISTS task_region_policy_accept_insert_gate ON public.tasks;
DROP TRIGGER IF EXISTS task_region_policy_accept_gate ON public.tasks;

CREATE TRIGGER task_region_policy_accept_insert_gate
BEFORE INSERT ON public.tasks
FOR EACH ROW
WHEN (
  NEW.state = 'ACCEPTED'
  AND (
    NEW.business_fulfiller_organization_id IS NULL
    OR NEW.worker_id IS NOT NULL
  )
)
EXECUTE FUNCTION public.enforce_task_region_policy_on_accept();

CREATE TRIGGER task_region_policy_accept_gate
BEFORE UPDATE OF state, worker_id, business_fulfiller_organization_id
ON public.tasks
FOR EACH ROW
WHEN (
  NEW.state = 'ACCEPTED'
  AND (
    NEW.business_fulfiller_organization_id IS NULL
    OR NEW.worker_id IS NOT NULL
  )
  AND NOT hxos_same_worker_proof_retake_continuation(
    OLD.state::TEXT,
    NEW.state::TEXT,
    OLD.worker_id,
    NEW.worker_id
  )
)
EXECUTE FUNCTION public.enforce_task_region_policy_on_accept();


-- ------------------------------------------------------------
-- 2. Worker eligibility acceptance gates
-- ------------------------------------------------------------

DROP TRIGGER IF EXISTS task_worker_eligibility_accept_insert_gate ON public.tasks;
DROP TRIGGER IF EXISTS task_worker_eligibility_accept_gate ON public.tasks;

CREATE TRIGGER task_worker_eligibility_accept_insert_gate
BEFORE INSERT ON public.tasks
FOR EACH ROW
WHEN (
  NEW.state = 'ACCEPTED'
  AND (
    NEW.business_fulfiller_organization_id IS NULL
    OR NEW.worker_id IS NOT NULL
  )
)
EXECUTE FUNCTION public.enforce_task_worker_eligibility_on_accept();

CREATE TRIGGER task_worker_eligibility_accept_gate
BEFORE UPDATE OF state, worker_id, business_fulfiller_organization_id
ON public.tasks
FOR EACH ROW
WHEN (
  NEW.state = 'ACCEPTED'
  AND (
    NEW.business_fulfiller_organization_id IS NULL
    OR NEW.worker_id IS NOT NULL
  )
  AND NOT hxos_same_worker_proof_retake_continuation(
    OLD.state::TEXT,
    NEW.state::TEXT,
    OLD.worker_id,
    NEW.worker_id
  )
)
EXECUTE FUNCTION public.enforce_task_worker_eligibility_on_accept();


-- ------------------------------------------------------------
-- 3. Controlled-test provider capability acceptance gate
-- ------------------------------------------------------------

DROP TRIGGER IF EXISTS controlled_test_provider_capability_accept_guard
ON public.tasks;

CREATE TRIGGER controlled_test_provider_capability_accept_guard
BEFORE INSERT OR UPDATE OF
  state,
  worker_id,
  business_fulfiller_organization_id
ON public.tasks
FOR EACH ROW
WHEN (
  NEW.state = 'ACCEPTED'
  AND NEW.automation_classification = 'CONTROLLED_TEST'
  AND (
    NEW.business_fulfiller_organization_id IS NULL
    OR NEW.worker_id IS NOT NULL
  )
)
EXECUTE FUNCTION public.enforce_controlled_test_provider_capability_on_accept();


-- ------------------------------------------------------------
-- 4. Controlled-test worker-offer acceptance gate
-- ------------------------------------------------------------

DROP TRIGGER IF EXISTS controlled_test_offer_accept_guard
ON public.tasks;

CREATE TRIGGER controlled_test_offer_accept_guard
BEFORE INSERT OR UPDATE OF
  state,
  worker_id,
  business_fulfiller_organization_id
ON public.tasks
FOR EACH ROW
WHEN (
  NEW.state = 'ACCEPTED'
  AND NEW.automation_classification = 'CONTROLLED_TEST'
  AND (
    NEW.business_fulfiller_organization_id IS NULL
    OR NEW.worker_id IS NOT NULL
  )
)
EXECUTE FUNCTION public.enforce_controlled_test_offer_acceptance();


-- ------------------------------------------------------------
-- 5. Business-specific acceptance backstop
--
-- This is the gate that now authorizes the Business entity itself.
-- ------------------------------------------------------------

DROP TRIGGER IF EXISTS controlled_test_business_acceptance_guard
ON public.tasks;

CREATE TRIGGER controlled_test_business_acceptance_guard
BEFORE INSERT OR UPDATE OF
  state,
  worker_id,
  business_fulfiller_organization_id
ON public.tasks
FOR EACH ROW
EXECUTE FUNCTION public.enforce_controlled_test_business_acceptance();


COMMIT;