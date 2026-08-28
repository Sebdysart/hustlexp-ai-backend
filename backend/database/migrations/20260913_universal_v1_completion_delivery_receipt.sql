-- Provider-authenticated Universal V1 completion-notice receipts.
--
-- This migration extends the existing append-only delivery evidence rail with
-- an exact Work Order/completion/execution binding. It creates no assignment,
-- payment, capture, settlement, payout, or production-money capability.

ALTER TABLE public.task_completion_delivery_events
  ADD COLUMN IF NOT EXISTS work_order_id UUID,
  ADD COLUMN IF NOT EXISTS expected_completion_fact_id UUID,
  ADD COLUMN IF NOT EXISTS expected_completion_version INTEGER,
  ADD COLUMN IF NOT EXISTS expected_execution_version INTEGER,
  ADD COLUMN IF NOT EXISTS provider_kind TEXT,
  ADD COLUMN IF NOT EXISTS provider_service_identity TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS request_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS provider_callback_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS authenticated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS policy_version TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'task_completion_delivery_work_order_fk'
      AND conrelid = 'public.task_completion_delivery_events'::regclass
  ) THEN
    ALTER TABLE public.task_completion_delivery_events
      ADD CONSTRAINT task_completion_delivery_work_order_fk
      FOREIGN KEY (work_order_id)
      REFERENCES public.task_work_orders(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'task_completion_delivery_completion_fact_fk'
      AND conrelid = 'public.task_completion_delivery_events'::regclass
  ) THEN
    ALTER TABLE public.task_completion_delivery_events
      ADD CONSTRAINT task_completion_delivery_completion_fact_fk
      FOREIGN KEY (expected_completion_fact_id)
      REFERENCES public.task_completion_facts(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'task_completion_delivery_idempotency_unique'
      AND conrelid = 'public.task_completion_delivery_events'::regclass
  ) THEN
    ALTER TABLE public.task_completion_delivery_events
      ADD CONSTRAINT task_completion_delivery_idempotency_unique
      UNIQUE (idempotency_key);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'task_completion_delivery_universal_v1_shape_check'
      AND conrelid = 'public.task_completion_delivery_events'::regclass
  ) THEN
    ALTER TABLE public.task_completion_delivery_events
      ADD CONSTRAINT task_completion_delivery_universal_v1_shape_check
      CHECK (
        (
          work_order_id IS NULL
          AND expected_completion_fact_id IS NULL
          AND expected_completion_version IS NULL
          AND expected_execution_version IS NULL
          AND provider_kind IS NULL
          AND provider_service_identity IS NULL
          AND idempotency_key IS NULL
          AND request_sha256 IS NULL
          AND provider_callback_at IS NULL
          AND authenticated_at IS NULL
          AND policy_version IS NULL
        )
        OR (
          work_order_id IS NOT NULL
          AND expected_completion_fact_id IS NOT NULL
          AND expected_completion_version > 0
          AND expected_execution_version > 0
          AND provider_kind = 'SYNTHETIC_SINK'
          AND provider_service_identity ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
          AND idempotency_key ~ '^[A-Za-z0-9:_-]{16,96}$'
          AND request_sha256 ~ '^[a-f0-9]{64}$'
          AND provider_callback_at IS NOT NULL
          AND authenticated_at IS NOT NULL
          AND policy_version = 'universal-v1-completion-delivery-receipt-1.0.0'
        )
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS task_completion_delivery_work_order_idx
  ON public.task_completion_delivery_events(work_order_id, delivered_at DESC)
  WHERE work_order_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_completion_delivery_receipt()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  work_order public.task_work_orders%ROWTYPE;
  task_record public.tasks%ROWTYPE;
  completion public.task_completion_facts%ROWTYPE;
  execution public.task_work_order_execution_facts%ROWTYPE;
BEGIN
  -- Historical/legacy receipt inserts retain their original task-only shape.
  IF NEW.work_order_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Database time, not the signed provider payload, owns authentication time.
  NEW.authenticated_at := clock_timestamp();

  SELECT * INTO work_order
  FROM public.task_work_orders
  WHERE id = NEW.work_order_id
  FOR SHARE;

  SELECT * INTO task_record
  FROM public.tasks
  WHERE id = NEW.task_id
  FOR SHARE;

  SELECT * INTO completion
  FROM public.task_completion_facts
  WHERE id = NEW.expected_completion_fact_id
  FOR SHARE;

  SELECT * INTO execution
  FROM public.task_work_order_execution_facts
  WHERE work_order_id = NEW.work_order_id
  ORDER BY execution_version DESC
  LIMIT 1
  FOR SHARE;

  IF work_order.id IS NULL
     OR task_record.id IS NULL
     OR completion.id IS NULL
     OR execution.id IS NULL
     OR work_order.task_id <> NEW.task_id
     OR task_record.work_order_id <> NEW.work_order_id
     OR completion.work_order_id <> NEW.work_order_id
     OR completion.task_id <> NEW.task_id
     OR completion.id <> NEW.expected_completion_fact_id
     OR completion.completion_version <> NEW.expected_completion_version
     OR completion.fact_kind <> 'SUBMITTED'
     OR execution.execution_version <> NEW.expected_execution_version
     OR execution.state <> 'COMPLETION_SUBMITTED'
     OR execution.completion_fact_id <> NEW.expected_completion_fact_id
     OR execution.scope_version_id <> completion.scope_version_id
     OR work_order.execution_contract_version <> 1
     OR task_record.universal_contract_version <> 1
     OR task_record.automation_classification <> 'CONTROLLED_TEST'
     OR task_record.universal_payment_posture <> 'PAYMENT_CREATION_FROZEN'
     OR task_record.worker_id IS NOT NULL
     OR NEW.provider_service_identity <>
        'hustlexp.synthetic-communications-sink.v1:' || NEW.recorded_by::TEXT THEN
    RAISE EXCEPTION 'HXUV1-DELIVERY-1: receipt must bind the exact current unassigned Universal V1 completion submission'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.users service_actor
    WHERE service_actor.id = NEW.recorded_by
      AND service_actor.account_status = 'ACTIVE'
      AND service_actor.is_minor IS FALSE
      AND COALESCE(service_actor.is_banned, FALSE) IS FALSE
  ) THEN
    RAISE EXCEPTION 'HXUV1-DELIVERY-2: receipt requires an active authenticated service actor'
      USING ERRCODE = 'P0001';
  END IF;

  IF abs(extract(epoch FROM (clock_timestamp() - NEW.provider_callback_at))) > 300 THEN
    RAISE EXCEPTION 'HXUV1-DELIVERY-3: provider callback timestamp is outside the accepted window'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.delivered_at > clock_timestamp() + INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'HXUV1-DELIVERY-4: provider delivery timestamp cannot be in the future'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS enforce_universal_v1_completion_delivery_receipt
  ON public.task_completion_delivery_events;
CREATE TRIGGER enforce_universal_v1_completion_delivery_receipt
BEFORE INSERT ON public.task_completion_delivery_events
FOR EACH ROW
EXECUTE FUNCTION public.enforce_universal_v1_completion_delivery_receipt();

COMMENT ON FUNCTION public.enforce_universal_v1_completion_delivery_receipt() IS
  'Binds an HMAC-authenticated sink receipt to one exact Universal V1 task, Work Order, submitted completion fact, and execution version; performs no assignment or money effect.';
