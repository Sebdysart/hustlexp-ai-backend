-- Post-estimate authority repair. Additive only; no production money authority.
ALTER TABLE task_applications ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE task_applications ADD COLUMN IF NOT EXISTS request_sha256 CHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS task_applications_universal_interest_replay
  ON task_applications(hustler_id,idempotency_key) WHERE universal_contract_version=1;
ALTER TABLE task_applications DROP CONSTRAINT IF EXISTS task_applications_universal_interest_replay_shape;
ALTER TABLE task_applications ADD CONSTRAINT task_applications_universal_interest_replay_shape CHECK (
  universal_contract_version<>1 OR (
    (idempotency_key IS NULL AND request_sha256 IS NULL)
    OR (idempotency_key~'^[A-Za-z0-9:_-]{16,96}$' AND request_sha256~'^[a-f0-9]{64}$')
  ));

-- PostgreSQL ordinary UNIQUE treats NULL organizations as distinct. Replace
-- that loophole with one exact provider chain for both people and businesses.
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='task_provider_eligibility_decisions'::regclass AND contype='u'
    AND pg_get_constraintdef(oid)='UNIQUE (task_draft_id, provider_user_id, decision_version)'
  LOOP EXECUTE format('ALTER TABLE task_provider_eligibility_decisions DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS task_provider_eligibility_exact_chain
  ON task_provider_eligibility_decisions
  (task_draft_id,provider_user_id,provider_organization_id,decision_version)
  NULLS NOT DISTINCT;

CREATE TABLE IF NOT EXISTS task_work_order_command_requests (
 idempotency_key TEXT PRIMARY KEY CHECK(idempotency_key~'^[A-Za-z0-9:_-]{16,96}$'),
 request_sha256 CHAR(64) NOT NULL CHECK(request_sha256~'^[a-f0-9]{64}$'),
 actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 conditional_hold_id UUID NOT NULL REFERENCES task_reservations(id) ON DELETE RESTRICT,
 task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
 task_draft_id UUID NOT NULL REFERENCES task_drafts(id) ON DELETE RESTRICT,
 provider_estimate_submission_id UUID NOT NULL REFERENCES provider_estimate_submissions(id) ON DELETE RESTRICT,
 routing_decision_id UUID NOT NULL REFERENCES task_routing_decisions(id) ON DELETE RESTRICT,
 scope_version_id UUID NOT NULL REFERENCES task_scope_versions(id) ON DELETE RESTRICT,
 provider_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 provider_organization_id UUID REFERENCES business_organizations(id) ON DELETE RESTRICT,
 eligibility_decision_id UUID NOT NULL REFERENCES task_provider_eligibility_decisions(id) ON DELETE RESTRICT,
 eligibility_version INTEGER NOT NULL CHECK(eligibility_version>0),
 amount_cents BIGINT NOT NULL CHECK(amount_cents>0), currency CHAR(3) NOT NULL CHECK(currency~'^[A-Z]{3}$'),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
COMMENT ON TABLE task_work_order_command_requests IS
 'Immutable application-command witness. The transaction-local digest is write provenance, not a substitute for a future dedicated least-privilege database command-owner role.';
CREATE OR REPLACE FUNCTION forbid_work_order_request_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'HXUV1-WO-REQ-1: Work Order command witnesses are append-only' USING ERRCODE='P0001';
END $$;
DROP TRIGGER IF EXISTS work_order_request_append_only ON task_work_order_command_requests;
CREATE TRIGGER work_order_request_append_only BEFORE UPDATE OR DELETE ON task_work_order_command_requests FOR EACH ROW EXECUTE FUNCTION forbid_work_order_request_mutation();
DROP TRIGGER IF EXISTS task_work_order_command_requests_no_truncate ON task_work_order_command_requests;
CREATE TRIGGER task_work_order_command_requests_no_truncate BEFORE TRUNCATE ON task_work_order_command_requests
FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_truncate();

DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='task_reservations'::regclass AND contype='u'
    AND pg_get_constraintdef(oid)='UNIQUE (task_id)' LOOP EXECUTE format('ALTER TABLE task_reservations DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE task_reservations DROP CONSTRAINT IF EXISTS task_reservations_status_check;
ALTER TABLE task_reservations ADD CONSTRAINT task_reservations_status_check CHECK(status IN('ACTIVE','RELEASED','CANCELLED','EXPIRED'));
CREATE UNIQUE INDEX IF NOT EXISTS task_reservations_one_active_task ON task_reservations(task_id) WHERE status='ACTIVE';

-- Retain the established full insert proof, while replacing only its update
-- transition rule so an elapsed hold can become the explicit EXPIRED fact.
DROP TRIGGER IF EXISTS universal_conditional_hold_guard ON task_reservations;
CREATE TRIGGER universal_conditional_hold_guard BEFORE INSERT ON task_reservations
FOR EACH ROW EXECUTE FUNCTION enforce_universal_conditional_hold();
CREATE OR REPLACE FUNCTION enforce_universal_conditional_hold_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.universal_contract_version<>1 THEN RETURN NEW; END IF;
 IF OLD.task_id IS DISTINCT FROM NEW.task_id OR OLD.hustler_id IS DISTINCT FROM NEW.hustler_id
   OR OLD.reserved_by IS DISTINCT FROM NEW.reserved_by OR OLD.reserved_at IS DISTINCT FROM NEW.reserved_at
   OR OLD.universal_contract_version IS DISTINCT FROM NEW.universal_contract_version OR OLD.hold_kind IS DISTINCT FROM NEW.hold_kind
   OR OLD.interest_application_id IS DISTINCT FROM NEW.interest_application_id OR OLD.eligibility_decision_id IS DISTINCT FROM NEW.eligibility_decision_id
   OR OLD.expires_at IS DISTINCT FROM NEW.expires_at THEN RAISE EXCEPTION 'HXUV1-HOLD-2: conditional-hold identity and authority bindings are immutable' USING ERRCODE='P0001'; END IF;
 IF NEW.status=OLD.status OR (OLD.status='ACTIVE' AND NEW.status IN('RELEASED','CANCELLED'))
   OR (OLD.status='ACTIVE' AND NEW.status='EXPIRED' AND OLD.expires_at<=clock_timestamp()) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'HXUV1-HOLD-3: invalid conditional-hold transition' USING ERRCODE='P0001';
END $$;
DROP TRIGGER IF EXISTS universal_conditional_hold_update_guard ON task_reservations;
CREATE TRIGGER universal_conditional_hold_update_guard BEFORE UPDATE ON task_reservations
FOR EACH ROW EXECUTE FUNCTION enforce_universal_conditional_hold_update();

CREATE OR REPLACE FUNCTION enforce_universal_post_estimate_interest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.universal_contract_version<>1 THEN RETURN NEW; END IF;
 IF NEW.idempotency_key IS NULL OR NEW.request_sha256 IS NULL
 THEN RAISE EXCEPTION 'HXUV1-INTEREST-3: new Universal V1 interest requires an immutable request witness' USING ERRCODE='P0001'; END IF;
 IF NOT EXISTS(SELECT 1 FROM tasks t JOIN task_drafts d ON d.task_id=t.id JOIN task_routing_decisions r ON r.id=d.active_routing_decision_id
   JOIN task_scope_versions s ON s.id=t.active_scope_version_id WHERE t.id=NEW.task_id AND t.worker_id IS NULL
   AND t.automation_classification='CONTROLLED_TEST' AND r.outcome='FULFILLMENT_CANDIDATE'
   AND s.id=NEW.interest_scope_version_id) THEN RAISE EXCEPTION 'HXUV1-INTEREST-2: interest requires the current unassigned controlled-test task, route, and scope' USING ERRCODE='P0001'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS universal_post_estimate_interest_guard ON task_applications;
CREATE TRIGGER universal_post_estimate_interest_guard BEFORE INSERT ON task_applications FOR EACH ROW EXECUTE FUNCTION enforce_universal_post_estimate_interest();

CREATE OR REPLACE FUNCTION enforce_universal_post_estimate_hold() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE until_at timestamptz; poster uuid;
BEGIN
 IF NEW.universal_contract_version<>1 THEN RETURN NEW; END IF;
 SELECT e.valid_until,t.poster_id INTO until_at,poster FROM task_provider_eligibility_decisions e JOIN tasks t ON t.id=e.task_id WHERE e.id=NEW.eligibility_decision_id;
 IF NEW.reserved_by IS DISTINCT FROM poster OR NEW.expires_at>until_at THEN RAISE EXCEPTION 'HXUV1-HOLD-6: Poster authority and eligibility-bounded expiry are required' USING ERRCODE='P0001'; END IF;
 IF TG_OP='UPDATE' AND OLD.status='ACTIVE' AND NEW.status='EXPIRED' AND OLD.expires_at>clock_timestamp() THEN RAISE EXCEPTION 'HXUV1-HOLD-7: unexpired hold cannot expire' USING ERRCODE='P0001'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS universal_post_estimate_hold_guard ON task_reservations;
CREATE TRIGGER universal_post_estimate_hold_guard BEFORE INSERT OR UPDATE ON task_reservations FOR EACH ROW EXECUTE FUNCTION enforce_universal_post_estimate_hold();

CREATE OR REPLACE FUNCTION enforce_universal_fake_finance_boundary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.provider_kind='FAKE' AND NEW.task_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM tasks WHERE id=NEW.task_id AND universal_contract_version=1 AND automation_classification='CONTROLLED_TEST' AND worker_id IS NULL)
 THEN RAISE EXCEPTION 'HXUV1-FIN-FAKE-1: fake finance is confined to unassigned controlled-test tasks' USING ERRCODE='P0001'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS universal_fake_finance_boundary_guard ON task_financial_security_events;
CREATE TRIGGER universal_fake_finance_boundary_guard BEFORE INSERT ON task_financial_security_events FOR EACH ROW EXECUTE FUNCTION enforce_universal_fake_finance_boundary();

CREATE OR REPLACE FUNCTION enforce_universal_post_estimate_work_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM tasks t JOIN task_estimate_acceptance_materializations m ON m.task_id=t.id
   WHERE t.id=NEW.task_id AND t.poster_id=NEW.materialized_by AND t.worker_id IS NULL
   AND t.automation_classification='CONTROLLED_TEST' AND m.provider_estimate_submission_id=NEW.provider_estimate_submission_id
   AND m.scope_version_id=NEW.scope_version_id AND m.task_draft_id=NEW.task_draft_id)
 THEN RAISE EXCEPTION 'HXUV1-WO-12: Poster must materialize the exact accepted estimate without assignment' USING ERRCODE='P0001'; END IF;
 IF NOT EXISTS(SELECT 1 FROM task_work_order_command_requests request
   JOIN task_provider_eligibility_decisions e ON e.id=request.eligibility_decision_id
   JOIN task_financial_security_events financial ON financial.id=NEW.financial_security_event_id
   JOIN users poster ON poster.id=request.actor_user_id JOIN users provider ON provider.id=request.provider_user_id
   WHERE request.idempotency_key=NEW.idempotency_key AND request.request_sha256=current_setting('hustlexp.work_order_command_sha256',true)
   AND request.actor_user_id=NEW.materialized_by AND request.conditional_hold_id=NEW.conditional_hold_id
   AND request.task_id=NEW.task_id AND request.task_draft_id=NEW.task_draft_id
   AND request.provider_estimate_submission_id=NEW.provider_estimate_submission_id AND request.routing_decision_id=NEW.routing_decision_id
   AND request.scope_version_id=NEW.scope_version_id AND request.provider_user_id=NEW.provider_user_id
   AND request.provider_organization_id IS NOT DISTINCT FROM NEW.provider_organization_id
   AND request.eligibility_decision_id=NEW.eligibility_decision_id AND request.eligibility_version=e.decision_version
   AND financial.provider_kind='FAKE' AND financial.event_kind='SECURED' AND financial.status='SUCCEEDED'
   AND financial.amount_cents=request.amount_cents AND financial.currency=request.currency
   AND e.processor_payment_eligible=false AND e.payout_funding_eligible=false
   AND poster.account_status='ACTIVE' AND poster.is_minor IS FALSE AND COALESCE(poster.is_banned,false)=false
   AND provider.account_status='ACTIVE' AND provider.is_minor IS FALSE AND COALESCE(provider.is_banned,false)=false)
 THEN RAISE EXCEPTION 'HXUV1-WO-13: exact fake-only command witness and current actor authority are required' USING ERRCODE='P0001'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS universal_post_estimate_work_order_guard ON task_work_orders;
CREATE TRIGGER universal_post_estimate_work_order_guard BEFORE INSERT ON task_work_orders FOR EACH ROW EXECUTE FUNCTION enforce_universal_post_estimate_work_order();

REVOKE ALL ON FUNCTION enforce_universal_post_estimate_interest() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_universal_post_estimate_hold() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_universal_conditional_hold_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_universal_fake_finance_boundary() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_universal_post_estimate_work_order() FROM PUBLIC;
REVOKE ALL ON FUNCTION forbid_work_order_request_mutation() FROM PUBLIC;
