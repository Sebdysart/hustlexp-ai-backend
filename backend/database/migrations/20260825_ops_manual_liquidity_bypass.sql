BEGIN;

DROP TRIGGER IF EXISTS task_liquidity_cell_accept_gate
ON public.tasks;

CREATE TRIGGER task_liquidity_cell_accept_gate
BEFORE INSERT OR UPDATE OF
  state,
  worker_id,
  liquidity_cell_id,
  orchestration_mode
ON public.tasks
FOR EACH ROW
WHEN (
  NEW.orchestration_mode <> 'OPS_MANUAL'
)
EXECUTE FUNCTION public.enforce_task_liquidity_cell_on_accept();

COMMIT;