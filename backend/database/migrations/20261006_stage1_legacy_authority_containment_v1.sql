-- Forward-only containment for the twelve retired Stage-1/Martin migration
-- paths that existed on public main but are intentionally absent from the
-- reconstructed Universal V1 chain.
--
-- This migration never deletes legacy rows, tables, columns, or
-- applied_migrations receipts. Where contaminated objects exist, it removes
-- their writer authority, restores the last pre-Stage-1 task/escrow gates,
-- and freezes legacy task/quote shapes for later adjudication. Fresh databases
-- receive the same safe gate definitions without recreating retired objects.
-- It grants no assignment, payment, payout, deployment, or production effect.

-- Retire the feature_flags.key compatibility writer while preserving the
-- historical column and values. Current code reads feature_flags.name.
DROP TRIGGER IF EXISTS trg_feature_flags_sync_key ON public.feature_flags;
DROP FUNCTION IF EXISTS public.sync_feature_flags_key_from_name();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'feature_flags'
       AND column_name = 'key'
  ) THEN
    ALTER TABLE public.feature_flags ALTER COLUMN key DROP NOT NULL;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_stage1_feature_flag_key_writer_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.key IS NOT NULL THEN
    RAISE EXCEPTION 'HXUV1S140-1: retired feature_flags.key writer is contained'
      USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.key IS DISTINCT FROM OLD.key THEN
    RAISE EXCEPTION 'HXUV1S140-1: retired feature_flags.key writer is contained'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'feature_flags'
       AND column_name = 'key'
  ) THEN
    DROP TRIGGER IF EXISTS stage1_feature_flag_key_writer_containment
      ON public.feature_flags;
    CREATE TRIGGER stage1_feature_flag_key_writer_containment
    BEFORE INSERT OR UPDATE OF key ON public.feature_flags
    FOR EACH ROW EXECUTE FUNCTION public.prevent_stage1_feature_flag_key_writer_v1();
    ALTER TABLE public.feature_flags
      ENABLE ALWAYS TRIGGER stage1_feature_flag_key_writer_containment;
  END IF;
END;
$$;

-- Freeze every retired standalone relation. Rows remain readable evidence;
-- INSERT, UPDATE, DELETE, and TRUNCATE all fail even for the table owner while
-- triggers are enabled. No dependency-propagating drop is used in this containment.
CREATE OR REPLACE FUNCTION public.prevent_stage1_retired_relation_write_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'HXUV1S140-2: retired Stage-1 relation is immutable evidence'
    USING ERRCODE = 'P0001';
END;
$$;

DO $$
DECLARE
  v_relation TEXT;
  v_role TEXT;
BEGIN
  FOREACH v_relation IN ARRAY ARRAY[
    'ops_action_audit',
    'ops_business_claim_links',
    'hxos_local_test_business_payout_destinations',
    'hxos_local_test_business_payout_transfers'
  ] LOOP
    IF to_regclass('public.' || v_relation) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'DROP TRIGGER IF EXISTS stage1_retired_relation_row_containment ON public.%I',
      v_relation
    );
    EXECUTE format(
      'CREATE TRIGGER stage1_retired_relation_row_containment '
      'BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.prevent_stage1_retired_relation_write_v1()',
      v_relation
    );
    EXECUTE format(
      'ALTER TABLE public.%I ENABLE ALWAYS TRIGGER stage1_retired_relation_row_containment',
      v_relation
    );
    EXECUTE format(
      'DROP TRIGGER IF EXISTS stage1_retired_relation_truncate_containment ON public.%I',
      v_relation
    );
    EXECUTE format(
      'CREATE TRIGGER stage1_retired_relation_truncate_containment '
      'BEFORE TRUNCATE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_stage1_retired_relation_write_v1()',
      v_relation
    );
    EXECUTE format(
      'ALTER TABLE public.%I ENABLE ALWAYS TRIGGER stage1_retired_relation_truncate_containment',
      v_relation
    );
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', v_relation);
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', v_relation, v_role);
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

-- TRUNCATE bypasses row-level DELETE triggers. Block it on the two live core
-- relations so neither contaminated quote/task evidence nor clean companion
-- rows can be erased through a statement-level owner or replication-role path.
CREATE OR REPLACE FUNCTION public.prevent_stage1_core_evidence_truncate_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'HXUV1S140-7: core task/quote evidence cannot be truncated'
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS stage1_quote_evidence_truncate_containment ON public.quotes;
CREATE TRIGGER stage1_quote_evidence_truncate_containment
BEFORE TRUNCATE ON public.quotes
FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_stage1_core_evidence_truncate_v1();
ALTER TABLE public.quotes
  ENABLE ALWAYS TRIGGER stage1_quote_evidence_truncate_containment;

DROP TRIGGER IF EXISTS stage1_task_evidence_truncate_containment ON public.tasks;
CREATE TRIGGER stage1_task_evidence_truncate_containment
BEFORE TRUNCATE ON public.tasks
FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_stage1_core_evidence_truncate_v1();
ALTER TABLE public.tasks
  ENABLE ALWAYS TRIGGER stage1_task_evidence_truncate_containment;

-- Preserve ambiguous quote ownership fields but prohibit new or changed
-- values. Existing non-null values remain intact for incident adjudication.
CREATE OR REPLACE FUNCTION public.prevent_stage1_quote_authority_write_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.business_organization_id IS NOT NULL
       OR OLD.business_location_id IS NOT NULL
       OR OLD.provider_service_profile_id IS NOT NULL
       OR OLD.claimed_by_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'HXUV1S140-3: contaminated Stage-1 quote is immutable evidence'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' AND (
    NEW.business_organization_id IS NOT NULL
    OR NEW.business_location_id IS NOT NULL
    OR NEW.provider_service_profile_id IS NOT NULL
    OR NEW.claimed_by_user_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'HXUV1S140-3: retired quote claim authority is contained'
      USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.business_organization_id IS DISTINCT FROM OLD.business_organization_id
    OR NEW.business_location_id IS DISTINCT FROM OLD.business_location_id
    OR NEW.provider_service_profile_id IS DISTINCT FROM OLD.provider_service_profile_id
    OR NEW.claimed_by_user_id IS DISTINCT FROM OLD.claimed_by_user_id
  ) THEN
    RAISE EXCEPTION 'HXUV1S140-3: retired quote claim authority is contained'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  v_stage1_quote_column_count INTEGER;
BEGIN
  SELECT count(*)
    INTO v_stage1_quote_column_count
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'quotes'
     AND column_name IN (
       'business_organization_id',
       'business_location_id',
       'provider_service_profile_id',
       'claimed_by_user_id'
     );

  IF v_stage1_quote_column_count BETWEEN 1 AND 3 THEN
    RAISE EXCEPTION
      'HXUV1S140-6: partial Stage-1 quote authority schema requires explicit adjudication'
      USING ERRCODE = 'P0001';
  ELSIF v_stage1_quote_column_count = 4 THEN
    DROP TRIGGER IF EXISTS stage1_quote_authority_containment ON public.quotes;
    CREATE TRIGGER stage1_quote_authority_containment
    BEFORE INSERT OR UPDATE OF
      business_organization_id,
      business_location_id,
      provider_service_profile_id,
      claimed_by_user_id
    ON public.quotes
    FOR EACH ROW EXECUTE FUNCTION public.prevent_stage1_quote_authority_write_v1();
    ALTER TABLE public.quotes
      ENABLE ALWAYS TRIGGER stage1_quote_authority_containment;

    DROP TRIGGER IF EXISTS stage1_quote_authority_delete_containment ON public.quotes;
    CREATE TRIGGER stage1_quote_authority_delete_containment
    BEFORE DELETE ON public.quotes
    FOR EACH ROW EXECUTE FUNCTION public.prevent_stage1_quote_authority_write_v1();
    ALTER TABLE public.quotes
      ENABLE ALWAYS TRIGGER stage1_quote_authority_delete_containment;
  END IF;
END;
$$;

-- Freeze contaminated Task rows. Normal AUTOMATED, worker-bound rows remain
-- writable. Any existing business-only or OPS_MANUAL row becomes immutable
-- evidence until a separately approved adjudication migration exists.
CREATE OR REPLACE FUNCTION public.prevent_stage1_task_authority_write_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.business_fulfiller_organization_id IS NOT NULL
       OR OLD.orchestration_mode IS DISTINCT FROM 'AUTOMATED' THEN
      RAISE EXCEPTION 'HXUV1S140-4: contaminated Stage-1 task is immutable evidence'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND (
    OLD.business_fulfiller_organization_id IS NOT NULL
    OR OLD.orchestration_mode IS DISTINCT FROM 'AUTOMATED'
  ) THEN
    RAISE EXCEPTION 'HXUV1S140-4: contaminated Stage-1 task is immutable evidence'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.business_fulfiller_organization_id IS NOT NULL
     OR NEW.orchestration_mode IS DISTINCT FROM 'AUTOMATED' THEN
    RAISE EXCEPTION 'HXUV1S140-4: retired business/OPS task authority is contained'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  v_stage1_task_column_count INTEGER;
BEGIN
  SELECT count(*)
    INTO v_stage1_task_column_count
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'tasks'
     AND column_name IN ('business_fulfiller_organization_id', 'orchestration_mode');

  IF v_stage1_task_column_count = 1 THEN
    RAISE EXCEPTION
      'HXUV1S140-5: partial Stage-1 task authority schema requires explicit adjudication'
      USING ERRCODE = 'P0001';
  ELSIF v_stage1_task_column_count = 2 THEN
    DROP TRIGGER IF EXISTS stage1_task_authority_containment ON public.tasks;
    CREATE TRIGGER stage1_task_authority_containment
    BEFORE INSERT OR UPDATE OR DELETE ON public.tasks
    FOR EACH ROW EXECUTE FUNCTION public.prevent_stage1_task_authority_write_v1();
    ALTER TABLE public.tasks
      ENABLE ALWAYS TRIGGER stage1_task_authority_containment;

    ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_orchestration_mode_check;
    ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_orchestration_mode_contained_check;
    ALTER TABLE public.tasks
      ADD CONSTRAINT tasks_orchestration_mode_contained_check
      CHECK (orchestration_mode = 'AUTOMATED') NOT VALID;

    ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_business_fulfiller_contained_check;
    ALTER TABLE public.tasks
      ADD CONSTRAINT tasks_business_fulfiller_contained_check
      CHECK (business_fulfiller_organization_id IS NULL) NOT VALID;
  END IF;
END;
$$;

-- Remove the business-specific acceptance writer and restore the exact latest
-- pre-Stage-1 worker gates. These definitions contain no business or manual
-- bypass predicate.
DROP TRIGGER IF EXISTS controlled_test_business_acceptance_guard ON public.tasks;
DROP FUNCTION IF EXISTS public.enforce_controlled_test_business_acceptance();

DROP TRIGGER IF EXISTS task_region_policy_accept_gate ON public.tasks;
DROP TRIGGER IF EXISTS task_region_policy_accept_insert_gate ON public.tasks;
CREATE TRIGGER task_region_policy_accept_insert_gate
BEFORE INSERT ON public.tasks
FOR EACH ROW WHEN (NEW.state = 'ACCEPTED')
EXECUTE FUNCTION public.enforce_task_region_policy_on_accept();
CREATE TRIGGER task_region_policy_accept_gate
BEFORE UPDATE OF state, worker_id ON public.tasks
FOR EACH ROW WHEN (
  NEW.state = 'ACCEPTED'
  AND NOT public.hxos_same_worker_proof_retake_continuation(
    OLD.state::TEXT, NEW.state::TEXT, OLD.worker_id, NEW.worker_id
  )
)
EXECUTE FUNCTION public.enforce_task_region_policy_on_accept();

DROP TRIGGER IF EXISTS task_worker_eligibility_accept_gate ON public.tasks;
DROP TRIGGER IF EXISTS task_worker_eligibility_accept_insert_gate ON public.tasks;
CREATE TRIGGER task_worker_eligibility_accept_insert_gate
BEFORE INSERT ON public.tasks
FOR EACH ROW WHEN (NEW.state = 'ACCEPTED')
EXECUTE FUNCTION public.enforce_task_worker_eligibility_on_accept();
CREATE TRIGGER task_worker_eligibility_accept_gate
BEFORE UPDATE OF state, worker_id ON public.tasks
FOR EACH ROW WHEN (
  NEW.state = 'ACCEPTED'
  AND NOT public.hxos_same_worker_proof_retake_continuation(
    OLD.state::TEXT, NEW.state::TEXT, OLD.worker_id, NEW.worker_id
  )
)
EXECUTE FUNCTION public.enforce_task_worker_eligibility_on_accept();

DROP TRIGGER IF EXISTS controlled_test_provider_capability_accept_guard ON public.tasks;
CREATE TRIGGER controlled_test_provider_capability_accept_guard
BEFORE INSERT OR UPDATE OF state, worker_id ON public.tasks
FOR EACH ROW EXECUTE FUNCTION public.enforce_controlled_test_provider_capability_on_accept();

DROP TRIGGER IF EXISTS controlled_test_offer_accept_guard ON public.tasks;
CREATE TRIGGER controlled_test_offer_accept_guard
BEFORE INSERT OR UPDATE OF state, worker_id ON public.tasks
FOR EACH ROW EXECUTE FUNCTION public.enforce_controlled_test_offer_acceptance();

DROP TRIGGER IF EXISTS task_liquidity_cell_accept_gate ON public.tasks;
CREATE TRIGGER task_liquidity_cell_accept_gate
BEFORE INSERT OR UPDATE OF state, worker_id, liquidity_cell_id ON public.tasks
FOR EACH ROW EXECUTE FUNCTION public.enforce_task_liquidity_cell_on_accept();

DROP TRIGGER IF EXISTS task_worker_offer_accept_gate ON public.tasks;
CREATE TRIGGER task_worker_offer_accept_gate
BEFORE INSERT OR UPDATE OF state, worker_id ON public.tasks
FOR EACH ROW EXECUTE FUNCTION public.enforce_worker_offer_decision_on_accept();

-- Restore the canonical worker-only local-certification payout evidence gate.
-- Legacy business payout rows remain preserved but can no longer satisfy an
-- escrow release.
CREATE OR REPLACE FUNCTION public.enforce_escrow_payout_provider_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  task_row RECORD;
BEGIN
  IF NEW.state <> 'RELEASED' OR OLD.state = 'RELEASED' THEN
    RETURN NEW;
  END IF;

  SELECT worker_id, automation_classification
    INTO task_row
  FROM public.tasks
  WHERE id = NEW.task_id;

  IF NEW.payout_provider = 'LOCAL_CERTIFICATION_TEST' THEN
    IF task_row.automation_classification IS DISTINCT FROM 'CONTROLLED_TEST'
       OR NEW.stripe_transfer_id IS NOT NULL
       OR NEW.provider_transfer_status IS DISTINCT FROM 'paid'
       OR NEW.provider_transfer_paid_at IS NULL
       OR NOT EXISTS (
         SELECT 1
         FROM public.hxos_local_test_payout_transfers transfer
         WHERE transfer.id = NEW.provider_transfer_id
           AND transfer.task_id = NEW.task_id
           AND transfer.escrow_id = NEW.id
           AND transfer.worker_id = task_row.worker_id
           AND transfer.status = 'paid'
           AND transfer.is_test IS TRUE
       ) THEN
      RAISE EXCEPTION 'HXLPO8: local TEST escrow release lacks exact paid provider evidence';
    END IF;
  ELSIF NEW.payout_provider = 'STRIPE' THEN
    IF NEW.stripe_transfer_id IS NULL
       OR NEW.provider_transfer_id IS DISTINCT FROM NEW.stripe_transfer_id
       OR NEW.provider_transfer_status IS NULL
       OR NEW.provider_transfer_status NOT IN ('submitted', 'processing', 'paid') THEN
      RAISE EXCEPTION 'HXLPO9: Stripe escrow release lacks provider transfer identity';
    END IF;
  ELSIF NEW.payout_provider = 'MANUAL_RECONCILIATION' THEN
    IF NEW.provider_transfer_status IS DISTINCT FROM 'manual_reconciliation'
       OR NEW.provider_transfer_paid_at IS NOT NULL THEN
      RAISE EXCEPTION 'HXLPO10: manual release must remain visibly unreconciled';
    END IF;
  ELSE
    RAISE EXCEPTION 'HXLPO11: released escrow requires an explicit payout provider';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS escrow_payout_provider_evidence_gate ON public.escrows;
CREATE TRIGGER escrow_payout_provider_evidence_gate
BEFORE UPDATE OF state, payout_provider, provider_transfer_id,
  provider_transfer_status, provider_transfer_paid_at ON public.escrows
FOR EACH ROW EXECUTE FUNCTION public.enforce_escrow_payout_provider_evidence();
ALTER TABLE public.escrows
  ENABLE ALWAYS TRIGGER escrow_payout_provider_evidence_gate;

REVOKE ALL ON FUNCTION public.prevent_stage1_feature_flag_key_writer_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prevent_stage1_retired_relation_write_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prevent_stage1_core_evidence_truncate_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prevent_stage1_quote_authority_write_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prevent_stage1_task_authority_write_v1() FROM PUBLIC;

DO $$
DECLARE
  v_role TEXT;
  v_function TEXT;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      CONTINUE;
    END IF;
    FOREACH v_function IN ARRAY ARRAY[
      'prevent_stage1_feature_flag_key_writer_v1()',
      'prevent_stage1_retired_relation_write_v1()',
      'prevent_stage1_core_evidence_truncate_v1()',
      'prevent_stage1_quote_authority_write_v1()',
      'prevent_stage1_task_authority_write_v1()'
    ] LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM %I', v_function, v_role);
    END LOOP;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.prevent_stage1_retired_relation_write_v1() IS
  'Migration-140 fail-closed preservation guard for retired Stage-1 relation evidence; grants no lifecycle or money authority.';
COMMENT ON FUNCTION public.prevent_stage1_task_authority_write_v1() IS
  'Migration-140 quarantine guard: normal AUTOMATED worker tasks remain writable; contaminated business-only or OPS_MANUAL rows remain immutable evidence.';
