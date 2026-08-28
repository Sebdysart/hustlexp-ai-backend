BEGIN;

DROP TRIGGER IF EXISTS task_worker_offer_accept_gate
ON public.tasks;

CREATE TRIGGER task_worker_offer_accept_gate
BEFORE INSERT OR UPDATE OF
  state,
  worker_id,
  orchestration_mode
ON public.tasks
FOR EACH ROW
WHEN (
  NEW.orchestration_mode <> 'OPS_MANUAL'
)
EXECUTE FUNCTION public.enforce_worker_offer_decision_on_accept();

<<<<<<< HEAD
COMMIT;
=======
COMMIT;
>>>>>>> integrate/stage1-backbone
