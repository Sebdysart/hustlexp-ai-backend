-- Universal V1 payment-free provider-estimate acceptance and Task materialization.
--
-- This append-only contract closes the first canonical estimate golden path.
-- A customer may accept one exact immutable provider estimate and materialize
-- one unassigned Task without creating an escrow, payment authorization,
-- capture, settlement, payout, or other financial effect. Production money
-- creation and hard assignment remain separately frozen.

-- ---------------------------------------------------------------------------
-- Provider-estimate quote versions are payment-free, provider-neutral facts.
-- ---------------------------------------------------------------------------

ALTER TABLE public.quote_versions
  ADD COLUMN IF NOT EXISTS universal_contract_version SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_posture TEXT;

-- These legacy columns were declared NOT NULL even for quote versions that do
-- not and must not create a payment. Legacy quote creation may continue to set
-- them; Universal V1 PROVIDER_ESTIMATE versions must explicitly leave every
-- payment artifact NULL.
ALTER TABLE public.quote_versions
  ALTER COLUMN pay_token DROP NOT NULL,
  ALTER COLUMN stripe_mode DROP NOT NULL;

-- The 20260827 contract introduced PROVIDER_ESTIMATE classification before it
-- could classify quote-version payment posture. Do not infer or rewrite any
-- such precontract row. A reviewed adoption migration must classify it first.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.quote_versions quote_version
    JOIN public.quotes quote ON quote.id = quote_version.quote_id
    WHERE quote.quote_kind = 'PROVIDER_ESTIMATE'
      AND (
        quote_version.universal_contract_version <> 1
        OR quote_version.payment_posture IS DISTINCT FROM 'PAYMENT_FREE_ESTIMATE'
        OR quote_version.pay_token IS NOT NULL
        OR quote_version.stripe_payment_link_url IS NOT NULL
        OR quote_version.stripe_checkout_session_id IS NOT NULL
        OR quote_version.stripe_payment_intent_id IS NOT NULL
        OR quote_version.stripe_mode IS NOT NULL
        OR quote_version.paid_at IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'HXUV1-EST-9: precontract provider-estimate quote version requires reviewed payment-posture adoption evidence'
      USING ERRCODE = 'P0001';
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'quote_versions_universal_payment_posture_check'
      AND conrelid = 'public.quote_versions'::regclass
  ) THEN
    ALTER TABLE public.quote_versions
      ADD CONSTRAINT quote_versions_universal_payment_posture_check CHECK (
        (universal_contract_version = 0 AND payment_posture IS NULL)
        OR (
          universal_contract_version = 1
          AND payment_posture IS NOT NULL
          AND payment_posture = 'PAYMENT_FREE_ESTIMATE'
        )
      );
  END IF;
END
$$;

ALTER TABLE public.provider_estimate_submissions
  ADD COLUMN IF NOT EXISTS work_category_code TEXT;

-- Existing immutable submissions cannot be assigned a category by inference.
-- Refuse an ambiguous upgrade rather than rewriting historical evidence.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.provider_estimate_submissions
    WHERE work_category_code IS NULL
  ) THEN
    RAISE EXCEPTION 'HXUV1-EST-4: precontract provider estimate requires reviewed work-category adoption evidence'
      USING ERRCODE = 'P0001';
  END IF;
END
$$;

ALTER TABLE public.provider_estimate_submissions
  ALTER COLUMN work_category_code SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'provider_estimate_work_category_code_check'
      AND conrelid = 'public.provider_estimate_submissions'::regclass
  ) THEN
    ALTER TABLE public.provider_estimate_submissions
      ADD CONSTRAINT provider_estimate_work_category_code_check CHECK (
        work_category_code ~ '^[a-z][a-z0-9_]{1,63}$'
      );
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION enforce_universal_provider_estimate_quote_version()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  provider_estimate BOOLEAN;
BEGIN
  SELECT quote.quote_kind = 'PROVIDER_ESTIMATE'
  INTO provider_estimate
  FROM public.quotes quote
  WHERE quote.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.quote_id ELSE NEW.quote_id END;

  provider_estimate := COALESCE(provider_estimate, FALSE);

  IF TG_OP IN ('UPDATE', 'DELETE')
     AND (OLD.universal_contract_version = 1 OR provider_estimate) THEN
    RAISE EXCEPTION 'HXUV1-EST-6: Universal V1 provider-estimate quote versions are append-only'
      USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF provider_estimate AND (
    NEW.universal_contract_version <> 1
    OR NEW.payment_posture IS DISTINCT FROM 'PAYMENT_FREE_ESTIMATE'
    OR NEW.pay_token IS NOT NULL
    OR NEW.stripe_payment_link_url IS NOT NULL
    OR NEW.stripe_checkout_session_id IS NOT NULL
    OR NEW.stripe_payment_intent_id IS NOT NULL
    OR NEW.stripe_mode IS NOT NULL
    OR NEW.paid_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'HXUV1-EST-7: PROVIDER_ESTIMATE quote version must be payment-free and provider-neutral'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.universal_contract_version = 1 AND NOT provider_estimate THEN
    RAISE EXCEPTION 'HXUV1-EST-8: Universal V1 estimate version must belong to a PROVIDER_ESTIMATE quote'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_provider_estimate_quote_version_guard
  ON public.quote_versions;
CREATE TRIGGER universal_provider_estimate_quote_version_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.quote_versions
FOR EACH ROW EXECUTE FUNCTION enforce_universal_provider_estimate_quote_version();

CREATE OR REPLACE FUNCTION prevent_universal_provider_estimate_quote_version_truncate()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.quote_versions
    WHERE universal_contract_version = 1
  ) THEN
    RAISE EXCEPTION 'HXUV1-EST-6: Universal V1 provider-estimate quote versions are append-only'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS universal_provider_estimate_quote_versions_no_truncate
  ON public.quote_versions;
CREATE TRIGGER universal_provider_estimate_quote_versions_no_truncate
BEFORE TRUNCATE ON public.quote_versions
FOR EACH STATEMENT EXECUTE FUNCTION prevent_universal_provider_estimate_quote_version_truncate();

-- Replace the original provider-estimate guard so the normalized work category
-- is part of the immutable digest. Credentialed trade routes must bind a current
-- government-backed qualification for that exact category; ordinary estimate
-- routes remain available to GENERAL_SERVICE_PROVIDER providers.
CREATE OR REPLACE FUNCTION enforce_provider_estimate_submission()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  route_reason_codes TEXT[];
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.quotes quote
    JOIN public.quote_versions quote_version
      ON quote_version.id = NEW.quote_version_id
     AND quote_version.quote_id = quote.id
    JOIN public.task_routing_decisions routing
      ON routing.id = NEW.routing_decision_id
    JOIN public.task_drafts draft
      ON draft.id = routing.task_draft_id
    WHERE quote.id = NEW.quote_id
      AND quote.quote_kind = 'PROVIDER_ESTIMATE'
      AND quote.routing_decision_id = NEW.routing_decision_id
      AND quote.task_draft_id = routing.task_draft_id
      AND draft.active_routing_decision_id = routing.id
      AND routing.outcome = 'ESTIMATE_REQUIRED'
      AND routing.category_snapshot = NEW.work_category_code
      AND quote_version.version_number = NEW.expected_quote_version
      AND quote_version.expected_quote_version = NEW.expected_quote_version
      AND quote_version.provider_submitted_at IS NOT NULL
      AND quote_version.universal_contract_version = 1
      AND quote_version.payment_posture = 'PAYMENT_FREE_ESTIMATE'
      AND quote_version.pay_token IS NULL
      AND quote_version.stripe_payment_link_url IS NULL
      AND quote_version.stripe_checkout_session_id IS NULL
      AND quote_version.stripe_payment_intent_id IS NULL
      AND quote_version.stripe_mode IS NULL
      AND quote_version.paid_at IS NULL
      AND quote_version.scope_json = NEW.scope_snapshot
      AND quote_version.scope_hash = NEW.scope_hash
      AND quote_version.total_cents = NEW.customer_total_cents
      AND quote_version.hustler_payout_cents = NEW.provider_payout_cents
      AND (
        quote_version.scope_version_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM public.task_scope_versions scope
          WHERE scope.id = quote_version.scope_version_id
            AND scope.scope_hash = NEW.scope_hash
        )
      )
      AND quote.active_version_id = quote_version.id
      AND quote.provider_user_id IS NOT DISTINCT FROM NEW.provider_user_id
      AND quote.provider_organization_id IS NOT DISTINCT FROM NEW.provider_organization_id
  ) THEN
    RAISE EXCEPTION 'HXUV1-EST-1: provider estimate must bind the routed payment-free quote and exact version'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.scope_hash <> encode(digest(NEW.scope_snapshot::text, 'sha256'), 'hex')
     OR NEW.payload_hash <> encode(digest(jsonb_build_object(
       'scopeSnapshot', NEW.scope_snapshot,
       'scopeHash', NEW.scope_hash,
       'workCategoryCode', NEW.work_category_code,
       'lineItems', NEW.line_items,
       'customerTotalCents', NEW.customer_total_cents,
       'providerPayoutCents', NEW.provider_payout_cents,
       'currency', NEW.currency
     )::text, 'sha256'), 'hex') THEN
    RAISE EXCEPTION 'HXUV1-EST-2: immutable estimate scope or payload digest mismatch'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.submitted_by IS DISTINCT FROM NEW.provider_user_id
     AND NOT EXISTS (
       SELECT 1
       FROM public.business_memberships membership
       WHERE membership.organization_id = NEW.provider_organization_id
         AND membership.user_id = NEW.submitted_by
         AND membership.status = 'ACTIVE'
         AND membership.role IN ('OWNER','ADMIN','DISPATCHER','CREW')
     ) THEN
    RAISE EXCEPTION 'HXUV1-EST-3: estimate submitter lacks provider authority'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT routing.reason_codes
  INTO route_reason_codes
  FROM public.task_routing_decisions routing
  WHERE routing.id = NEW.routing_decision_id;

  IF 'CREDENTIALED_TRADE_REVIEW_REQUIRED' = ANY(route_reason_codes)
     AND NOT EXISTS (
       SELECT 1
       FROM public.current_verified_trade_qualifications qualification
       CROSS JOIN LATERAL unnest(qualification.permitted_work_categories) permitted(category)
       WHERE qualification.provider_user_id = NEW.provider_user_id
         AND qualification.organization_id = NEW.provider_organization_id
         AND lower(permitted.category) = NEW.work_category_code
     ) THEN
    RAISE EXCEPTION 'HXUV1-EST-5: credentialed trade estimate requires a current verified qualification for the exact work category'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- One immutable acceptance fact materializes one payment-frozen Task.
-- ---------------------------------------------------------------------------

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS universal_payment_posture TEXT;

ALTER TABLE public.tasks
  DROP CONSTRAINT IF EXISTS tasks_payment_method_check;

ALTER TABLE public.tasks
  ADD CONSTRAINT tasks_payment_method_check CHECK (
    payment_method IN (
      'escrow',
      'offline_cash',
      'offline_venmo',
      'offline_cashapp',
      'universal_financial_security'
    )
  ) NOT VALID;

ALTER TABLE public.tasks
  VALIDATE CONSTRAINT tasks_payment_method_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'tasks_universal_payment_posture_check'
      AND conrelid = 'public.tasks'::regclass
  ) THEN
    ALTER TABLE public.tasks
      ADD CONSTRAINT tasks_universal_payment_posture_check CHECK (
        (universal_contract_version = 0 AND universal_payment_posture IS NULL)
        OR (
          universal_contract_version = 1
          AND payment_method = 'universal_financial_security'
          AND universal_payment_posture IS NOT NULL
          AND universal_payment_posture = 'PAYMENT_CREATION_FROZEN'
        )
      );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.task_estimate_acceptance_materializations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_draft_id UUID NOT NULL
    REFERENCES public.task_drafts(id) ON DELETE RESTRICT,
  provider_estimate_submission_id UUID NOT NULL
    REFERENCES public.provider_estimate_submissions(id) ON DELETE RESTRICT,
  quote_id UUID NOT NULL
    REFERENCES public.quotes(id) ON DELETE RESTRICT,
  quote_version_id UUID NOT NULL
    REFERENCES public.quote_versions(id) ON DELETE RESTRICT,
  poster_user_id UUID NOT NULL
    REFERENCES public.users(id) ON DELETE RESTRICT,
  prior_routing_decision_id UUID NOT NULL
    REFERENCES public.task_routing_decisions(id) ON DELETE RESTRICT,
  resulting_routing_decision_id UUID NOT NULL
    REFERENCES public.task_routing_decisions(id) ON DELETE RESTRICT,
  task_id UUID NOT NULL
    REFERENCES public.tasks(id) ON DELETE RESTRICT,
  scope_version_id UUID NOT NULL
    REFERENCES public.task_scope_versions(id) ON DELETE RESTRICT,
  expected_draft_version INTEGER NOT NULL CHECK (expected_draft_version > 0),
  materialization_version INTEGER NOT NULL CHECK (materialization_version = 1),
  idempotency_key TEXT NOT NULL CHECK (
    idempotency_key ~ '^[A-Za-z0-9:_-]{8,128}$'
  ),
  request_sha256 CHAR(64) NOT NULL CHECK (
    request_sha256 ~ '^[a-f0-9]{64}$'
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT task_estimate_acceptance_one_per_draft UNIQUE (task_draft_id),
  CONSTRAINT task_estimate_acceptance_one_per_submission UNIQUE (
    provider_estimate_submission_id
  ),
  CONSTRAINT task_estimate_acceptance_one_per_task UNIQUE (task_id),
  CONSTRAINT task_estimate_acceptance_one_per_quote_version UNIQUE (quote_version_id),
  CONSTRAINT task_estimate_acceptance_actor_idempotency UNIQUE (
    poster_user_id,
    idempotency_key
  ),
  CONSTRAINT task_estimate_acceptance_routes_distinct CHECK (
    prior_routing_decision_id <> resulting_routing_decision_id
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS task_drafts_universal_task_binding_unique
  ON public.task_drafts(task_id)
  WHERE universal_contract_version = 1 AND task_id IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_universal_task_payment_posture()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.universal_contract_version = 1
     AND (
       NEW.universal_contract_version <> 1
       OR NEW.payment_method IS DISTINCT FROM OLD.payment_method
       OR NEW.universal_payment_posture IS DISTINCT FROM OLD.universal_payment_posture
     ) THEN
    RAISE EXCEPTION 'HXUV1-MAT-1: Universal V1 Task payment authority and posture are immutable'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.universal_contract_version = 1 AND (
    NEW.payment_method IS DISTINCT FROM 'universal_financial_security'
    OR NEW.universal_payment_posture IS DISTINCT FROM 'PAYMENT_CREATION_FROZEN'
  ) THEN
    RAISE EXCEPTION 'HXUV1-MAT-2: Universal V1 Task must remain provider-neutral with payment creation frozen'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.universal_contract_version = 1
     AND EXISTS (
       SELECT 1
       FROM public.escrows escrow
       WHERE escrow.task_id = NEW.id
     ) THEN
    RAISE EXCEPTION 'HXUV1-MAT-3: Universal V1 Task cannot bind a legacy escrow'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_task_payment_posture_guard ON public.tasks;
CREATE TRIGGER universal_task_payment_posture_guard
BEFORE INSERT OR UPDATE ON public.tasks
FOR EACH ROW EXECUTE FUNCTION enforce_universal_task_payment_posture();

CREATE OR REPLACE FUNCTION prevent_universal_task_escrow_binding()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.tasks task
    WHERE task.id = NEW.task_id
      AND task.universal_contract_version = 1
  ) THEN
    RAISE EXCEPTION 'HXUV1-MAT-3: Universal V1 Task cannot bind a legacy escrow'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_task_escrow_binding_guard ON public.escrows;
CREATE TRIGGER universal_task_escrow_binding_guard
BEFORE INSERT OR UPDATE OF task_id ON public.escrows
FOR EACH ROW EXECUTE FUNCTION prevent_universal_task_escrow_binding();

CREATE OR REPLACE FUNCTION enforce_universal_task_draft_one_time_binding()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.universal_contract_version = 1 AND NEW.task_id IS NOT NULL THEN
      RAISE EXCEPTION 'HXUV1-MAT-4: Universal V1 TaskDraft must begin without a materialized Task'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.universal_contract_version = 1
     AND OLD.task_id IS NOT NULL
     AND NEW.task_id IS DISTINCT FROM OLD.task_id THEN
    RAISE EXCEPTION 'HXUV1-MAT-5: Universal V1 TaskDraft Task binding is one-time and immutable'
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.universal_contract_version <> 1
     AND NEW.universal_contract_version = 1
     AND NEW.task_id IS NOT NULL THEN
    RAISE EXCEPTION 'HXUV1-MAT-4: Universal V1 TaskDraft promotion must begin without a materialized Task'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_task_draft_one_time_binding_guard
  ON public.task_drafts;
CREATE TRIGGER universal_task_draft_one_time_binding_guard
BEFORE INSERT OR UPDATE OF universal_contract_version, task_id ON public.task_drafts
FOR EACH ROW EXECUTE FUNCTION enforce_universal_task_draft_one_time_binding();

CREATE OR REPLACE FUNCTION enforce_task_estimate_acceptance_materialization()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.task_drafts draft
    JOIN public.task_routing_decisions prior_route
      ON prior_route.id = NEW.prior_routing_decision_id
     AND prior_route.task_draft_id = draft.id
    JOIN public.task_routing_decisions resulting_route
      ON resulting_route.id = NEW.resulting_routing_decision_id
     AND resulting_route.task_draft_id = draft.id
    JOIN public.provider_estimate_submissions estimate
      ON estimate.id = NEW.provider_estimate_submission_id
     AND estimate.routing_decision_id = prior_route.id
    JOIN public.quotes quote
      ON quote.id = NEW.quote_id
     AND quote.task_draft_id = draft.id
     AND quote.routing_decision_id = prior_route.id
    JOIN public.quote_versions quote_version
      ON quote_version.id = NEW.quote_version_id
     AND quote_version.quote_id = quote.id
    JOIN public.task_scope_versions scope
      ON scope.id = NEW.scope_version_id
     AND scope.task_id = NEW.task_id
    JOIN public.tasks task
      ON task.id = NEW.task_id
    WHERE draft.id = NEW.task_draft_id
      AND draft.ingress_origin = 'BACKEND_POSTGRESQL'
      AND draft.universal_contract_version = 1
      AND draft.status = 'account_claimed'
      AND draft.poster_user_id = NEW.poster_user_id
      AND draft.task_id = NEW.task_id
      AND draft.quote_id = NEW.quote_id
      AND draft.active_routing_decision_id = resulting_route.id
      AND prior_route.outcome = 'ESTIMATE_REQUIRED'
      AND prior_route.decision_version = NEW.expected_draft_version
      AND resulting_route.outcome = 'FULFILLMENT_CANDIDATE'
      AND resulting_route.supersedes_decision_id = prior_route.id
      AND resulting_route.decision_version = prior_route.decision_version + 1
      AND quote.quote_kind = 'PROVIDER_ESTIMATE'
      AND quote.active_version_id = quote_version.id
      AND quote.task_id = task.id
      AND estimate.quote_id = quote.id
      AND estimate.quote_version_id = quote_version.id
      AND quote.provider_user_id IS NOT DISTINCT FROM estimate.provider_user_id
      AND quote.provider_organization_id IS NOT DISTINCT FROM estimate.provider_organization_id
      AND estimate.expected_quote_version = quote_version.expected_quote_version
      AND quote_version.version_number = estimate.expected_quote_version
      AND quote_version.universal_contract_version = 1
      AND quote_version.payment_posture = 'PAYMENT_FREE_ESTIMATE'
      AND quote_version.pay_token IS NULL
      AND quote_version.stripe_payment_link_url IS NULL
      AND quote_version.stripe_checkout_session_id IS NULL
      AND quote_version.stripe_payment_intent_id IS NULL
      AND quote_version.stripe_mode IS NULL
      AND quote_version.paid_at IS NULL
      AND quote_version.scope_version_id IS NULL
      AND quote_version.scope_hash = estimate.scope_hash
      AND quote_version.total_cents = estimate.customer_total_cents
      AND quote_version.hustler_payout_cents = estimate.provider_payout_cents
      AND scope.universal_contract_version = 1
      AND scope.version = 1
      AND scope.source = 'INITIAL'
      AND scope.supersedes_version_id IS NULL
      AND scope.scope_hash = estimate.scope_hash
      AND scope.title = estimate.scope_snapshot ->> 'title'
      AND scope.description = estimate.scope_snapshot ->> 'description'
      AND scope.requirements IS NOT DISTINCT FROM
          estimate.scope_snapshot ->> 'requirements'
      AND scope.checklist = estimate.scope_snapshot -> 'checklist'
      AND scope.customer_total_cents = estimate.customer_total_cents
      AND scope.hustler_payout_cents = estimate.provider_payout_cents
      AND scope.currency = estimate.currency
      AND scope.created_by = NEW.poster_user_id
      AND task.poster_id = NEW.poster_user_id
      AND task.universal_contract_version = 1
      AND task.active_scope_version_id = scope.id
      AND task.scope_hash = estimate.scope_hash
      AND task.title = estimate.scope_snapshot ->> 'title'
      AND task.description = estimate.scope_snapshot ->> 'description'
      AND task.requirements IS NOT DISTINCT FROM
          estimate.scope_snapshot ->> 'requirements'
      AND task.location = estimate.scope_snapshot ->> 'rough_location'
      AND task.rough_location = estimate.scope_snapshot ->> 'rough_location'
      AND task.price = estimate.customer_total_cents
      AND task.hustler_payout_cents = estimate.provider_payout_cents
      AND task.platform_margin_cents =
          estimate.customer_total_cents - estimate.provider_payout_cents
      AND task.category = estimate.work_category_code
      AND task.region_code = estimate.scope_snapshot ->> 'region_code'
      AND task.risk_level = estimate.scope_snapshot ->> 'risk_level'
      AND task.requires_proof =
          (estimate.scope_snapshot ->> 'requires_proof')::BOOLEAN
      AND upper(task.currency) = estimate.currency
      AND task.state = 'OPEN'
      AND task.progress_state = 'POSTED'
      AND task.automation_classification = 'CONTROLLED_TEST'
      AND task.instant_mode IS FALSE
      AND task.worker_id IS NULL
      AND task.work_order_id IS NULL
      AND task.payment_method = 'universal_financial_security'
      AND task.universal_payment_posture = 'PAYMENT_CREATION_FROZEN'
      AND NOT EXISTS (
        SELECT 1
        FROM public.escrows escrow
        WHERE escrow.task_id = task.id
      )
  ) THEN
    RAISE EXCEPTION 'HXUV1-MAT-6: estimate acceptance must bind the exact customer, route transition, payment-free estimate, scope, and unassigned Task'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_estimate_acceptance_materialization_guard
  ON public.task_estimate_acceptance_materializations;
CREATE CONSTRAINT TRIGGER task_estimate_acceptance_materialization_guard
AFTER INSERT ON public.task_estimate_acceptance_materializations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_task_estimate_acceptance_materialization();

CREATE OR REPLACE FUNCTION enforce_universal_task_draft_materialization_presence()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.universal_contract_version = 1
     AND NEW.task_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM public.task_estimate_acceptance_materializations materialization
       WHERE materialization.task_draft_id = NEW.id
         AND materialization.task_id = NEW.task_id
         AND materialization.poster_user_id = NEW.poster_user_id
     ) THEN
    RAISE EXCEPTION 'HXUV1-MAT-7: Universal V1 TaskDraft binding requires its exact immutable materialization fact'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_task_draft_materialization_presence_guard
  ON public.task_drafts;
CREATE CONSTRAINT TRIGGER universal_task_draft_materialization_presence_guard
AFTER INSERT OR UPDATE OF task_id ON public.task_drafts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_universal_task_draft_materialization_presence();

DROP TRIGGER IF EXISTS task_estimate_acceptance_materializations_immutable
  ON public.task_estimate_acceptance_materializations;
CREATE TRIGGER task_estimate_acceptance_materializations_immutable
BEFORE UPDATE OR DELETE ON public.task_estimate_acceptance_materializations
FOR EACH ROW EXECUTE FUNCTION prevent_universal_v1_fact_mutation();

DROP TRIGGER IF EXISTS task_estimate_acceptance_materializations_no_truncate
  ON public.task_estimate_acceptance_materializations;
CREATE TRIGGER task_estimate_acceptance_materializations_no_truncate
BEFORE TRUNCATE ON public.task_estimate_acceptance_materializations
FOR EACH STATEMENT EXECUTE FUNCTION prevent_universal_v1_fact_mutation();

REVOKE ALL ON TABLE public.task_estimate_acceptance_materializations FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_universal_provider_estimate_quote_version() FROM PUBLIC;
REVOKE ALL ON FUNCTION prevent_universal_provider_estimate_quote_version_truncate() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_universal_task_payment_posture() FROM PUBLIC;
REVOKE ALL ON FUNCTION prevent_universal_task_escrow_binding() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_universal_task_draft_one_time_binding() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_task_estimate_acceptance_materialization() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_universal_task_draft_materialization_presence() FROM PUBLIC;

COMMENT ON COLUMN public.provider_estimate_submissions.work_category_code IS
  'Canonical lowercase work-category identity; credentialed trade routes require a current official qualification for this exact code.';
COMMENT ON COLUMN public.quote_versions.payment_posture IS
  'PAYMENT_FREE_ESTIMATE for Universal V1 provider estimates; never payment authorization or paid state.';
COMMENT ON COLUMN public.tasks.universal_payment_posture IS
  'Provider-neutral Universal V1 posture. This slice remains PAYMENT_CREATION_FROZEN and creates no legacy escrow.';
COMMENT ON TABLE public.task_estimate_acceptance_materializations IS
  'Append-only customer acceptance and Task materialization fact for one exact payment-free provider estimate; no assignment or financial effect.';
