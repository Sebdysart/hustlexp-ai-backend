-- Forward-only containment for legacy Task lifecycle writers at the Universal
-- V1 Work Order boundary. This migration grants no Work Order command role,
-- actor authority, assignment, payment, payout, deployment, or production
-- capability. It only makes the already-declared split of authority fail
-- closed in PostgreSQL:
--
-- * a Work Order may bind only an OPEN, unassigned, unbound Universal task;
-- * once bound, the legacy tasks.state/worker_id/work_order_id projection is
--   immutable and the task row cannot be deleted;
-- * Work Order execution continues through append-only execution facts.

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_work_order_preinsert_task_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.tasks task
     WHERE task.id = NEW.task_id
       AND task.state = 'OPEN'
       AND task.worker_id IS NULL
       AND task.work_order_id IS NULL
       AND task.universal_contract_version = 1
       AND task.automation_classification = 'CONTROLLED_TEST'
  ) THEN
    RAISE EXCEPTION
      'HXUV1-WO-STATE-1: Work Order requires an OPEN, unassigned, unbound Universal task'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_work_order_preinsert_task_containment
  ON public.task_work_orders;
CREATE TRIGGER universal_v1_work_order_preinsert_task_containment
BEFORE INSERT ON public.task_work_orders
FOR EACH ROW EXECUTE FUNCTION public.enforce_universal_v1_work_order_preinsert_task_v1();
ALTER TABLE public.task_work_orders
  ENABLE ALWAYS TRIGGER universal_v1_work_order_preinsert_task_containment;

CREATE OR REPLACE FUNCTION public.freeze_universal_v1_work_order_task_projection_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.work_order_id IS NOT NULL THEN
    IF NEW.work_order_id IS DISTINCT FROM OLD.work_order_id
       OR NEW.state IS DISTINCT FROM OLD.state
       OR NEW.worker_id IS DISTINCT FROM OLD.worker_id THEN
      RAISE EXCEPTION
        'HXUV1-WO-STATE-2: Work Order-bound legacy task lifecycle projection is immutable'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.work_order_id IS NOT NULL THEN
    IF OLD.state IS DISTINCT FROM 'OPEN'
       OR NEW.state IS DISTINCT FROM 'OPEN'
       OR OLD.worker_id IS NOT NULL
       OR NEW.worker_id IS NOT NULL
       OR NOT EXISTS (
         SELECT 1
           FROM public.task_work_orders work_order
          WHERE work_order.id = NEW.work_order_id
            AND work_order.task_id = NEW.id
       ) THEN
      RAISE EXCEPTION
        'HXUV1-WO-STATE-3: invalid Work Order binding transition on legacy task projection'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_work_order_task_projection_containment
  ON public.tasks;
CREATE TRIGGER universal_v1_work_order_task_projection_containment
BEFORE UPDATE OF state, worker_id, work_order_id ON public.tasks
FOR EACH ROW EXECUTE FUNCTION public.freeze_universal_v1_work_order_task_projection_v1();
ALTER TABLE public.tasks
  ENABLE ALWAYS TRIGGER universal_v1_work_order_task_projection_containment;

CREATE OR REPLACE FUNCTION public.prevent_universal_v1_work_order_task_delete_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.work_order_id IS NOT NULL THEN
    RAISE EXCEPTION
      'HXUV1-WO-STATE-4: Work Order-bound task evidence cannot be deleted'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_work_order_task_delete_containment
  ON public.tasks;
CREATE TRIGGER universal_v1_work_order_task_delete_containment
BEFORE DELETE ON public.tasks
FOR EACH ROW EXECUTE FUNCTION public.prevent_universal_v1_work_order_task_delete_v1();
ALTER TABLE public.tasks
  ENABLE ALWAYS TRIGGER universal_v1_work_order_task_delete_containment;

REVOKE ALL ON FUNCTION public.enforce_universal_v1_work_order_preinsert_task_v1()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.freeze_universal_v1_work_order_task_projection_v1()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prevent_universal_v1_work_order_task_delete_v1()
  FROM PUBLIC;

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
      'enforce_universal_v1_work_order_preinsert_task_v1()',
      'freeze_universal_v1_work_order_task_projection_v1()',
      'prevent_universal_v1_work_order_task_delete_v1()'
    ] LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM %I', v_function, v_role);
    END LOOP;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.enforce_universal_v1_work_order_preinsert_task_v1() IS
  'Migration-142 fail-closed preinsert guard: only an OPEN, unassigned, unbound Universal task may receive a Work Order.';
COMMENT ON FUNCTION public.freeze_universal_v1_work_order_task_projection_v1() IS
  'Migration-142 containment guard: after Work Order binding, legacy task lifecycle columns cannot compete with append-only Work Order execution facts.';
COMMENT ON FUNCTION public.prevent_universal_v1_work_order_task_delete_v1() IS
  'Migration-142 evidence guard: Work Order-bound task rows cannot be deleted.';
