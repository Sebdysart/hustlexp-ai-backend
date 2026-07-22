-- Assignment-time policy gates must run on initial acceptance and worker
-- changes, but a proof retake is not a new assignment. Split insert and update
-- triggers so the shared retake predicate excludes only that continuation.

BEGIN;

DROP TRIGGER IF EXISTS task_region_policy_accept_gate ON tasks;
DROP TRIGGER IF EXISTS task_region_policy_accept_insert_gate ON tasks;
CREATE TRIGGER task_region_policy_accept_insert_gate
BEFORE INSERT ON tasks
FOR EACH ROW WHEN (NEW.state='ACCEPTED')
EXECUTE FUNCTION enforce_task_region_policy_on_accept();
CREATE TRIGGER task_region_policy_accept_gate
BEFORE UPDATE OF state,worker_id ON tasks
FOR EACH ROW WHEN (
  NEW.state='ACCEPTED'
  AND NOT hxos_same_worker_proof_retake_continuation(
    OLD.state::TEXT,NEW.state::TEXT,OLD.worker_id,NEW.worker_id
  )
)
EXECUTE FUNCTION enforce_task_region_policy_on_accept();

DROP TRIGGER IF EXISTS task_worker_eligibility_accept_gate ON tasks;
DROP TRIGGER IF EXISTS task_worker_eligibility_accept_insert_gate ON tasks;
CREATE TRIGGER task_worker_eligibility_accept_insert_gate
BEFORE INSERT ON tasks
FOR EACH ROW WHEN (NEW.state='ACCEPTED')
EXECUTE FUNCTION enforce_task_worker_eligibility_on_accept();
CREATE TRIGGER task_worker_eligibility_accept_gate
BEFORE UPDATE OF state,worker_id ON tasks
FOR EACH ROW WHEN (
  NEW.state='ACCEPTED'
  AND NOT hxos_same_worker_proof_retake_continuation(
    OLD.state::TEXT,NEW.state::TEXT,OLD.worker_id,NEW.worker_id
  )
)
EXECUTE FUNCTION enforce_task_worker_eligibility_on_accept();

DROP TRIGGER IF EXISTS task_template_policy_accept_gate ON tasks;
DROP TRIGGER IF EXISTS task_template_policy_accept_insert_gate ON tasks;
CREATE TRIGGER task_template_policy_accept_insert_gate
BEFORE INSERT ON tasks
FOR EACH ROW WHEN (NEW.state='ACCEPTED')
EXECUTE FUNCTION enforce_task_template_policy_on_accept();
CREATE TRIGGER task_template_policy_accept_gate
BEFORE UPDATE OF state,worker_id,mutual_consent_accepted ON tasks
FOR EACH ROW WHEN (
  NEW.state='ACCEPTED'
  AND NOT hxos_same_worker_proof_retake_continuation(
    OLD.state::TEXT,NEW.state::TEXT,OLD.worker_id,NEW.worker_id
  )
)
EXECUTE FUNCTION enforce_task_template_policy_on_accept();

DROP TRIGGER IF EXISTS task_clarification_accept_gate ON tasks;
CREATE TRIGGER task_clarification_accept_gate
BEFORE UPDATE OF state,worker_id ON tasks
FOR EACH ROW WHEN (
  NEW.state='ACCEPTED'
  AND NOT hxos_same_worker_proof_retake_continuation(
    OLD.state::TEXT,NEW.state::TEXT,OLD.worker_id,NEW.worker_id
  )
)
EXECUTE FUNCTION enforce_task_clarification_on_accept();

COMMIT;
