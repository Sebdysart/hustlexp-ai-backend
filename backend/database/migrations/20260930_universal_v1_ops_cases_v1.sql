-- HustleXP Universal V1 authoritative Operations cases.
--
-- This successor is deliberately observation-only with respect to business
-- lifecycle state. It can read one immutable major_action_events occurrence
-- and can write only the case, transition-request, timeline, and access-audit
-- relations declared below. It grants no task, assignment, financial,
-- credential, deployment, or provider-command mutation authority.
--
-- Actor assurance limitation: the application binds a verified named token
-- and fresh MFA assertion to p_actor_id, while these functions independently
-- recheck current database RBAC and distinct-approver evidence. The present
-- shared runtime login does not let PostgreSQL attest that p_actor_id is the
-- physical database caller. Direct command-role invocation remains held until
-- dedicated runtime/command roles are separately provisioned and certified.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.universal_v1_ops_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_schema_version TEXT NOT NULL DEFAULT 'HX_UNIVERSAL_V1_OPS_CASE_V1'
    CHECK (case_schema_version = 'HX_UNIVERSAL_V1_OPS_CASE_V1'),
  occurrence_id UUID NOT NULL UNIQUE
    REFERENCES public.major_action_events(id) ON DELETE RESTRICT,
  occurrence_event_name TEXT NOT NULL
    CHECK (occurrence_event_name ~ '^[a-z][a-z0-9_.-]{2,119}$'),
  occurrence_version INTEGER NOT NULL CHECK (occurrence_version > 0),
  aggregate_kind TEXT NOT NULL CHECK (aggregate_kind ~ '^[a-z][a-z0-9_]{1,63}$'),
  aggregate_id TEXT NOT NULL CHECK (aggregate_id ~ '^[A-Za-z0-9:_-]{2,200}$'),
  aggregate_version BIGINT NOT NULL CHECK (aggregate_version > 0),
  category TEXT NOT NULL CHECK (category IN (
    'SAFETY', 'MONEY', 'FULFILLMENT', 'CREDENTIAL',
    'COMMUNICATION', 'DATA_INTEGRITY', 'POLICY'
  )),
  severity TEXT NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  opening_reason TEXT NOT NULL CHECK (char_length(opening_reason) BETWEEN 10 AND 500),
  opening_evidence_digest CHAR(64) NOT NULL
    CHECK (opening_evidence_digest ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'CONTAINED', 'RESOLVED')),
  opened_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  acknowledged_by UUID REFERENCES public.users(id) ON DELETE RESTRICT,
  contained_by UUID REFERENCES public.users(id) ON DELETE RESTRICT,
  resolved_by UUID REFERENCES public.users(id) ON DELETE RESTRICT,
  contained_transition_request_id UUID,
  resolved_transition_request_id UUID,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  acknowledged_at TIMESTAMPTZ,
  contained_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  last_transition_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  idempotency_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  UNIQUE (opened_by, idempotency_key),
  CHECK (last_transition_at >= opened_at),
  CHECK (
    (status = 'OPEN'
      AND acknowledged_by IS NULL AND acknowledged_at IS NULL
      AND contained_by IS NULL AND contained_at IS NULL
      AND resolved_by IS NULL AND resolved_at IS NULL
      AND contained_transition_request_id IS NULL
      AND resolved_transition_request_id IS NULL)
    OR
    (status = 'ACKNOWLEDGED'
      AND acknowledged_by IS NOT NULL AND acknowledged_at IS NOT NULL
      AND contained_by IS NULL AND contained_at IS NULL
      AND resolved_by IS NULL AND resolved_at IS NULL
      AND contained_transition_request_id IS NULL
      AND resolved_transition_request_id IS NULL)
    OR
    (status = 'CONTAINED'
      AND acknowledged_by IS NOT NULL AND acknowledged_at IS NOT NULL
      AND contained_by IS NOT NULL AND contained_at IS NOT NULL
      AND resolved_by IS NULL AND resolved_at IS NULL
      AND contained_transition_request_id IS NOT NULL
      AND resolved_transition_request_id IS NULL)
    OR
    (status = 'RESOLVED'
      AND acknowledged_by IS NOT NULL AND acknowledged_at IS NOT NULL
      AND contained_by IS NOT NULL AND contained_at IS NOT NULL
      AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL
      AND contained_transition_request_id IS NOT NULL
      AND resolved_transition_request_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS universal_v1_ops_cases_queue
  ON public.universal_v1_ops_cases(status, severity, opened_at, id);
CREATE INDEX IF NOT EXISTS universal_v1_ops_cases_aggregate
  ON public.universal_v1_ops_cases(aggregate_kind, aggregate_id, aggregate_version);

CREATE TABLE IF NOT EXISTS public.universal_v1_ops_case_transition_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL
    REFERENCES public.universal_v1_ops_cases(id) ON DELETE RESTRICT,
  transition_kind TEXT NOT NULL CHECK (transition_kind IN ('CONTAIN', 'RESOLVE')),
  target_status TEXT NOT NULL CHECK (
    (transition_kind = 'CONTAIN' AND target_status = 'CONTAINED')
    OR (transition_kind = 'RESOLVE' AND target_status = 'RESOLVED')
  ),
  case_expected_version BIGINT NOT NULL CHECK (case_expected_version > 0),
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 500),
  evidence_digest CHAR(64) NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  requested_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  idempotency_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  decided_by UUID REFERENCES public.users(id) ON DELETE RESTRICT,
  decision_reason TEXT CHECK (
    decision_reason IS NULL OR char_length(decision_reason) BETWEEN 10 AND 500
  ),
  decision_evidence_digest CHAR(64) CHECK (
    decision_evidence_digest IS NULL
    OR decision_evidence_digest ~ '^[a-f0-9]{64}$'
  ),
  decision_idempotency_key UUID,
  decision_hash CHAR(64) CHECK (
    decision_hash IS NULL OR decision_hash ~ '^[a-f0-9]{64}$'
  ),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  decided_at TIMESTAMPTZ,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (requested_by, idempotency_key),
  UNIQUE (decided_by, decision_idempotency_key),
  CHECK (requested_by IS DISTINCT FROM decided_by),
  CHECK (
    (status = 'PENDING'
      AND decided_by IS NULL
      AND decision_reason IS NULL
      AND decision_evidence_digest IS NULL
      AND decision_idempotency_key IS NULL
      AND decision_hash IS NULL
      AND decided_at IS NULL)
    OR
    (status IN ('APPROVED', 'REJECTED')
      AND decided_by IS NOT NULL
      AND decision_reason IS NOT NULL
      AND decision_evidence_digest IS NOT NULL
      AND decision_idempotency_key IS NOT NULL
      AND decision_hash IS NOT NULL
      AND decided_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS universal_v1_ops_case_one_pending_transition
  ON public.universal_v1_ops_case_transition_requests(case_id)
  WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS universal_v1_ops_case_transition_history
  ON public.universal_v1_ops_case_transition_requests(case_id, requested_at, id);

ALTER TABLE public.universal_v1_ops_cases
  DROP CONSTRAINT IF EXISTS universal_v1_ops_cases_contained_transition_fk,
  DROP CONSTRAINT IF EXISTS universal_v1_ops_cases_resolved_transition_fk;
ALTER TABLE public.universal_v1_ops_cases
  ADD CONSTRAINT universal_v1_ops_cases_contained_transition_fk
    FOREIGN KEY (contained_transition_request_id)
    REFERENCES public.universal_v1_ops_case_transition_requests(id) ON DELETE RESTRICT,
  ADD CONSTRAINT universal_v1_ops_cases_resolved_transition_fk
    FOREIGN KEY (resolved_transition_request_id)
    REFERENCES public.universal_v1_ops_case_transition_requests(id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS public.universal_v1_ops_case_timeline (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL
    REFERENCES public.universal_v1_ops_cases(id) ON DELETE RESTRICT,
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  case_version BIGINT NOT NULL CHECK (case_version > 0),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'OPENED', 'ACKNOWLEDGED',
    'CONTAINMENT_REQUESTED', 'CONTAINED',
    'RESOLUTION_REQUESTED', 'RESOLVED',
    'TRANSITION_REJECTED'
  )),
  from_status TEXT CHECK (
    from_status IS NULL OR from_status IN ('OPEN', 'ACKNOWLEDGED', 'CONTAINED', 'RESOLVED')
  ),
  to_status TEXT NOT NULL
    CHECK (to_status IN ('OPEN', 'ACKNOWLEDGED', 'CONTAINED', 'RESOLVED')),
  requested_status TEXT CHECK (
    requested_status IS NULL OR requested_status IN ('CONTAINED', 'RESOLVED')
  ),
  transition_request_id UUID
    REFERENCES public.universal_v1_ops_case_transition_requests(id) ON DELETE RESTRICT,
  actor_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 500),
  evidence_digest CHAR(64) NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  idempotency_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (case_id, sequence),
  UNIQUE (actor_id, idempotency_key),
  CHECK (
    (event_type = 'OPENED'
      AND from_status IS NULL AND to_status = 'OPEN'
      AND requested_status IS NULL AND transition_request_id IS NULL)
    OR
    (event_type = 'ACKNOWLEDGED'
      AND from_status = 'OPEN' AND to_status = 'ACKNOWLEDGED'
      AND requested_status IS NULL AND transition_request_id IS NULL)
    OR
    (event_type = 'CONTAINMENT_REQUESTED'
      AND from_status = 'ACKNOWLEDGED' AND to_status = 'ACKNOWLEDGED'
      AND requested_status = 'CONTAINED' AND transition_request_id IS NOT NULL)
    OR
    (event_type = 'CONTAINED'
      AND from_status = 'ACKNOWLEDGED' AND to_status = 'CONTAINED'
      AND requested_status = 'CONTAINED' AND transition_request_id IS NOT NULL)
    OR
    (event_type = 'RESOLUTION_REQUESTED'
      AND from_status = 'CONTAINED' AND to_status = 'CONTAINED'
      AND requested_status = 'RESOLVED' AND transition_request_id IS NOT NULL)
    OR
    (event_type = 'RESOLVED'
      AND from_status = 'CONTAINED' AND to_status = 'RESOLVED'
      AND requested_status = 'RESOLVED' AND transition_request_id IS NOT NULL)
    OR
    (event_type = 'TRANSITION_REJECTED'
      AND from_status = to_status
      AND requested_status IS NOT NULL AND transition_request_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS universal_v1_ops_case_timeline_order
  ON public.universal_v1_ops_case_timeline(case_id, sequence, id);

CREATE TABLE IF NOT EXISTS public.universal_v1_ops_case_access_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL
    REFERENCES public.universal_v1_ops_cases(id) ON DELETE RESTRICT,
  case_version BIGINT NOT NULL CHECK (case_version > 0),
  actor_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  purpose TEXT NOT NULL CHECK (char_length(purpose) BETWEEN 10 AND 500),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS universal_v1_ops_case_access_time
  ON public.universal_v1_ops_case_access_audit(case_id, observed_at, id);

CREATE OR REPLACE FUNCTION public.assert_universal_v1_ops_case_operator_v1(
  p_actor_id UUID,
  p_require_admin BOOLEAN DEFAULT FALSE
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role TEXT;
BEGIN
  SELECT operator_role.role
    INTO v_role
    FROM public.users operator_user
    JOIN public.admin_roles operator_role ON operator_role.user_id = operator_user.id
   WHERE operator_user.id = p_actor_id
     AND operator_user.account_status = 'ACTIVE'
     AND operator_user.is_minor IS FALSE
     AND COALESCE(operator_user.is_banned, FALSE) IS FALSE
     AND operator_role.role IN ('admin', 'support', 'finance', 'moderator', 'founder')
     AND (
       operator_role.role IN ('admin', 'founder')
       OR operator_role.can_manage_operations IS TRUE
     )
   LIMIT 1;

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'HXUOC1: current named Operations authority is required'
      USING ERRCODE = 'P0001';
  END IF;
  IF p_require_admin AND v_role NOT IN ('admin', 'founder') THEN
    RAISE EXCEPTION 'HXUOC2: independent operator-admin authority is required'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN v_role;
END;
$$;

CREATE OR REPLACE FUNCTION public.universal_v1_ops_case_request_digest_v1(
  p_payload JSONB
)
RETURNS CHAR(64)
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
  SELECT encode(public.digest(p_payload::text, 'sha256'), 'hex')::char(64)
$$;

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_ops_case_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_occurrence public.major_action_events%ROWTYPE;
  v_request public.universal_v1_ops_case_transition_requests%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'OPEN' OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'HXUOC3: a case must begin at OPEN version 1'
        USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_occurrence
      FROM public.major_action_events occurrence
     WHERE occurrence.id = NEW.occurrence_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'HXUOC4: exact source occurrence is unavailable'
        USING ERRCODE = 'P0001';
    END IF;
    IF NEW.occurrence_event_name IS DISTINCT FROM v_occurrence.event_name
       OR NEW.occurrence_version IS DISTINCT FROM v_occurrence.event_version
       OR NEW.aggregate_kind IS DISTINCT FROM v_occurrence.aggregate_type
       OR NEW.aggregate_id IS DISTINCT FROM v_occurrence.aggregate_id
       OR NEW.aggregate_version IS DISTINCT FROM v_occurrence.source_sequence THEN
      RAISE EXCEPTION 'HXUOC5: occurrence aggregate binding or version mismatched'
        USING ERRCODE = 'P0001';
    END IF;
    PERFORM public.assert_universal_v1_ops_case_operator_v1(NEW.opened_by, FALSE);
    RETURN NEW;
  END IF;

  IF NEW.case_schema_version IS DISTINCT FROM OLD.case_schema_version
     OR NEW.occurrence_id IS DISTINCT FROM OLD.occurrence_id
     OR NEW.occurrence_event_name IS DISTINCT FROM OLD.occurrence_event_name
     OR NEW.occurrence_version IS DISTINCT FROM OLD.occurrence_version
     OR NEW.aggregate_kind IS DISTINCT FROM OLD.aggregate_kind
     OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id
     OR NEW.aggregate_version IS DISTINCT FROM OLD.aggregate_version
     OR NEW.category IS DISTINCT FROM OLD.category
     OR NEW.severity IS DISTINCT FROM OLD.severity
     OR NEW.opening_reason IS DISTINCT FROM OLD.opening_reason
     OR NEW.opening_evidence_digest IS DISTINCT FROM OLD.opening_evidence_digest
     OR NEW.opened_by IS DISTINCT FROM OLD.opened_by
     OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash THEN
    RAISE EXCEPTION 'HXUOC6: immutable case authority fields cannot change'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'HXUOC7: case version must advance exactly once'
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.status = 'OPEN' AND NEW.status = 'ACKNOWLEDGED' THEN
    PERFORM public.assert_universal_v1_ops_case_operator_v1(NEW.acknowledged_by, FALSE);
    IF NEW.acknowledged_at IS NULL
       OR NEW.contained_by IS NOT NULL OR NEW.contained_at IS NOT NULL
       OR NEW.resolved_by IS NOT NULL OR NEW.resolved_at IS NOT NULL
       OR NEW.contained_transition_request_id IS NOT NULL
       OR NEW.resolved_transition_request_id IS NOT NULL THEN
      RAISE EXCEPTION 'HXUOC8: acknowledgment evidence is incomplete'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF OLD.status = 'ACKNOWLEDGED' AND NEW.status = 'CONTAINED' THEN
    SELECT * INTO v_request
      FROM public.universal_v1_ops_case_transition_requests request
     WHERE request.id = NEW.contained_transition_request_id
       AND request.case_id = OLD.id
       AND request.transition_kind = 'CONTAIN'
       AND request.target_status = 'CONTAINED'
       AND request.case_expected_version = OLD.version
       AND request.status = 'APPROVED'
       AND request.decided_by = NEW.contained_by;
    IF NOT FOUND OR NEW.contained_at IS NULL THEN
      RAISE EXCEPTION 'HXUOC9: containment requires an exact independently approved request'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF OLD.status = 'CONTAINED' AND NEW.status = 'RESOLVED' THEN
    SELECT * INTO v_request
      FROM public.universal_v1_ops_case_transition_requests request
     WHERE request.id = NEW.resolved_transition_request_id
       AND request.case_id = OLD.id
       AND request.transition_kind = 'RESOLVE'
       AND request.target_status = 'RESOLVED'
       AND request.case_expected_version = OLD.version
       AND request.status = 'APPROVED'
       AND request.decided_by = NEW.resolved_by;
    IF NOT FOUND OR NEW.resolved_at IS NULL THEN
      RAISE EXCEPTION 'HXUOC10: resolution requires an exact independently approved request'
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    RAISE EXCEPTION 'HXUOC11: invalid or backward case transition'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.last_transition_at < OLD.last_transition_at THEN
    RAISE EXCEPTION 'HXUOC12: case transition time cannot move backward'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_ops_case_guard
  ON public.universal_v1_ops_cases;
CREATE TRIGGER universal_v1_ops_case_guard
BEFORE INSERT OR UPDATE ON public.universal_v1_ops_cases
FOR EACH ROW EXECUTE FUNCTION public.enforce_universal_v1_ops_case_v1();

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_ops_case_transition_request_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING' OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'HXUOC13: transition request must begin pending at version 1'
        USING ERRCODE = 'P0001';
    END IF;
    PERFORM public.assert_universal_v1_ops_case_operator_v1(NEW.requested_by, FALSE);
    RETURN NEW;
  END IF;

  IF NEW.case_id IS DISTINCT FROM OLD.case_id
     OR NEW.transition_kind IS DISTINCT FROM OLD.transition_kind
     OR NEW.target_status IS DISTINCT FROM OLD.target_status
     OR NEW.case_expected_version IS DISTINCT FROM OLD.case_expected_version
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.evidence_digest IS DISTINCT FROM OLD.evidence_digest
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'HXUOC14: immutable transition-request fields cannot change'
      USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'PENDING'
     OR NEW.status NOT IN ('APPROVED', 'REJECTED')
     OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'HXUOC15: invalid transition-request decision'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.requested_by = NEW.decided_by THEN
    RAISE EXCEPTION 'HXUOC16: a transition requester cannot approve or reject their own request'
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM public.assert_universal_v1_ops_case_operator_v1(NEW.decided_by, TRUE);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_ops_case_transition_request_guard
  ON public.universal_v1_ops_case_transition_requests;
CREATE TRIGGER universal_v1_ops_case_transition_request_guard
BEFORE INSERT OR UPDATE ON public.universal_v1_ops_case_transition_requests
FOR EACH ROW EXECUTE FUNCTION public.enforce_universal_v1_ops_case_transition_request_v1();

CREATE OR REPLACE FUNCTION public.enforce_approved_universal_v1_ops_case_transition_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status <> 'APPROVED' THEN
    RETURN NULL;
  END IF;
  IF NEW.target_status = 'CONTAINED' AND NOT EXISTS (
    SELECT 1 FROM public.universal_v1_ops_cases ops_case
     WHERE ops_case.id = NEW.case_id
       AND ops_case.status IN ('CONTAINED', 'RESOLVED')
       AND ops_case.version >= NEW.case_expected_version + 1
       AND ops_case.contained_transition_request_id = NEW.id
       AND ops_case.contained_by = NEW.decided_by
  ) THEN
    RAISE EXCEPTION 'HXUOC17: approved containment must transition its exact case before commit'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.target_status = 'RESOLVED' AND NOT EXISTS (
    SELECT 1 FROM public.universal_v1_ops_cases ops_case
     WHERE ops_case.id = NEW.case_id
       AND ops_case.status = 'RESOLVED'
       AND ops_case.version = NEW.case_expected_version + 1
       AND ops_case.resolved_transition_request_id = NEW.id
       AND ops_case.resolved_by = NEW.decided_by
  ) THEN
    RAISE EXCEPTION 'HXUOC18: approved resolution must transition its exact case before commit'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_ops_case_approved_transition_guard
  ON public.universal_v1_ops_case_transition_requests;
CREATE CONSTRAINT TRIGGER universal_v1_ops_case_approved_transition_guard
AFTER INSERT OR UPDATE ON public.universal_v1_ops_case_transition_requests
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.enforce_approved_universal_v1_ops_case_transition_v1();

CREATE OR REPLACE FUNCTION public.prevent_universal_v1_ops_case_evidence_mutation_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'HXUOC19: Operations case evidence is append-only'
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_ops_case_no_delete
  ON public.universal_v1_ops_cases;
CREATE TRIGGER universal_v1_ops_case_no_delete
BEFORE DELETE ON public.universal_v1_ops_cases
FOR EACH ROW EXECUTE FUNCTION public.prevent_universal_v1_ops_case_evidence_mutation_v1();
DROP TRIGGER IF EXISTS universal_v1_ops_case_no_truncate
  ON public.universal_v1_ops_cases;
CREATE TRIGGER universal_v1_ops_case_no_truncate
BEFORE TRUNCATE ON public.universal_v1_ops_cases
FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_universal_v1_ops_case_evidence_mutation_v1();

DROP TRIGGER IF EXISTS universal_v1_ops_case_transition_no_delete
  ON public.universal_v1_ops_case_transition_requests;
CREATE TRIGGER universal_v1_ops_case_transition_no_delete
BEFORE DELETE ON public.universal_v1_ops_case_transition_requests
FOR EACH ROW EXECUTE FUNCTION public.prevent_universal_v1_ops_case_evidence_mutation_v1();
DROP TRIGGER IF EXISTS universal_v1_ops_case_transition_no_truncate
  ON public.universal_v1_ops_case_transition_requests;
CREATE TRIGGER universal_v1_ops_case_transition_no_truncate
BEFORE TRUNCATE ON public.universal_v1_ops_case_transition_requests
FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_universal_v1_ops_case_evidence_mutation_v1();

DO $$
DECLARE
  v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'universal_v1_ops_case_timeline',
    'universal_v1_ops_case_access_audit'
  ] LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS universal_v1_ops_case_evidence_no_mutation ON public.%I',
      v_table
    );
    EXECUTE format(
      'CREATE TRIGGER universal_v1_ops_case_evidence_no_mutation BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.prevent_universal_v1_ops_case_evidence_mutation_v1()',
      v_table
    );
    EXECUTE format(
      'DROP TRIGGER IF EXISTS universal_v1_ops_case_evidence_no_truncate ON public.%I',
      v_table
    );
    EXECUTE format(
      'CREATE TRIGGER universal_v1_ops_case_evidence_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_universal_v1_ops_case_evidence_mutation_v1()',
      v_table
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.open_universal_v1_ops_case_v1(
  p_occurrence_id UUID,
  p_occurrence_event_name TEXT,
  p_occurrence_version INTEGER,
  p_aggregate_kind TEXT,
  p_aggregate_id TEXT,
  p_aggregate_version BIGINT,
  p_category TEXT,
  p_severity TEXT,
  p_reason TEXT,
  p_evidence_digest CHAR(64),
  p_actor_id UUID,
  p_idempotency_key UUID
)
RETURNS TABLE(case_id UUID, case_status TEXT, case_version BIGINT, idempotency_replayed BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_hash CHAR(64);
  v_existing public.universal_v1_ops_cases%ROWTYPE;
  v_occurrence public.major_action_events%ROWTYPE;
  v_case public.universal_v1_ops_cases%ROWTYPE;
BEGIN
  PERFORM public.assert_universal_v1_ops_case_operator_v1(p_actor_id, FALSE);
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'universal-v1-ops-case-open:' || p_actor_id::text || ':' || p_idempotency_key::text,
    0
  ));
  v_hash := public.universal_v1_ops_case_request_digest_v1(jsonb_build_object(
    'occurrence_id', p_occurrence_id,
    'occurrence_event_name', p_occurrence_event_name,
    'occurrence_version', p_occurrence_version,
    'aggregate_kind', p_aggregate_kind,
    'aggregate_id', p_aggregate_id,
    'aggregate_version', p_aggregate_version,
    'category', p_category,
    'severity', p_severity,
    'reason', p_reason,
    'evidence_digest', p_evidence_digest,
    'actor_id', p_actor_id,
    'idempotency_key', p_idempotency_key
  ));

  SELECT * INTO v_existing
    FROM public.universal_v1_ops_cases ops_case
   WHERE ops_case.opened_by = p_actor_id
     AND ops_case.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_hash <> v_hash THEN
      RAISE EXCEPTION 'HXUOC20: case-open idempotency key was reused with different input'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY SELECT v_existing.id, v_existing.status, v_existing.version, TRUE;
    RETURN;
  END IF;

  SELECT * INTO v_occurrence
    FROM public.major_action_events occurrence
   WHERE occurrence.id = p_occurrence_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUOC4: exact source occurrence is unavailable'
      USING ERRCODE = 'P0001';
  END IF;
  IF p_occurrence_event_name IS DISTINCT FROM v_occurrence.event_name
     OR p_occurrence_version IS DISTINCT FROM v_occurrence.event_version
     OR p_aggregate_kind IS DISTINCT FROM v_occurrence.aggregate_type
     OR p_aggregate_id IS DISTINCT FROM v_occurrence.aggregate_id
     OR p_aggregate_version IS DISTINCT FROM v_occurrence.source_sequence THEN
    RAISE EXCEPTION 'HXUOC5: occurrence aggregate binding or version mismatched'
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.universal_v1_ops_cases ops_case
     WHERE ops_case.occurrence_id = p_occurrence_id
  ) THEN
    RAISE EXCEPTION 'HXUOC21: source occurrence already has an authoritative case'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.universal_v1_ops_cases(
    occurrence_id, occurrence_event_name, occurrence_version,
    aggregate_kind, aggregate_id, aggregate_version,
    category, severity, opening_reason, opening_evidence_digest,
    opened_by, idempotency_key, request_hash
  ) VALUES (
    p_occurrence_id, p_occurrence_event_name, p_occurrence_version,
    p_aggregate_kind, p_aggregate_id, p_aggregate_version,
    p_category, p_severity, p_reason, p_evidence_digest,
    p_actor_id, p_idempotency_key, v_hash
  ) RETURNING * INTO v_case;

  INSERT INTO public.universal_v1_ops_case_timeline(
    case_id, sequence, case_version, event_type, from_status, to_status,
    requested_status, transition_request_id, actor_id, reason,
    evidence_digest, idempotency_key, request_hash
  ) VALUES (
    v_case.id, 1, 1, 'OPENED', NULL, 'OPEN',
    NULL, NULL, p_actor_id, p_reason,
    p_evidence_digest, p_idempotency_key, v_hash
  );
  RETURN QUERY SELECT v_case.id, v_case.status, v_case.version, FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.acknowledge_universal_v1_ops_case_v1(
  p_case_id UUID,
  p_expected_version BIGINT,
  p_reason TEXT,
  p_evidence_digest CHAR(64),
  p_actor_id UUID,
  p_idempotency_key UUID
)
RETURNS TABLE(case_id UUID, case_status TEXT, case_version BIGINT, idempotency_replayed BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_hash CHAR(64);
  v_case public.universal_v1_ops_cases%ROWTYPE;
  v_event public.universal_v1_ops_case_timeline%ROWTYPE;
  v_sequence BIGINT;
BEGIN
  PERFORM public.assert_universal_v1_ops_case_operator_v1(p_actor_id, FALSE);
  v_hash := public.universal_v1_ops_case_request_digest_v1(jsonb_build_object(
    'case_id', p_case_id,
    'expected_version', p_expected_version,
    'reason', p_reason,
    'evidence_digest', p_evidence_digest,
    'actor_id', p_actor_id,
    'idempotency_key', p_idempotency_key,
    'transition', 'ACKNOWLEDGED'
  ));
  SELECT * INTO v_case
    FROM public.universal_v1_ops_cases ops_case
   WHERE ops_case.id = p_case_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUOC22: Operations case was not found'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_event
    FROM public.universal_v1_ops_case_timeline event
   WHERE event.actor_id = p_actor_id
     AND event.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_event.case_id <> p_case_id
       OR v_event.event_type <> 'ACKNOWLEDGED'
       OR v_event.request_hash <> v_hash THEN
      RAISE EXCEPTION 'HXUOC23: acknowledgment idempotency key was reused with different input'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY SELECT v_case.id, v_case.status, v_case.version, TRUE;
    RETURN;
  END IF;
  IF v_case.version <> p_expected_version OR v_case.status <> 'OPEN' THEN
    RAISE EXCEPTION 'HXUOC24: acknowledgment requires the exact OPEN case version'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.universal_v1_ops_cases ops_case
     SET status = 'ACKNOWLEDGED',
         acknowledged_by = p_actor_id,
         acknowledged_at = clock_timestamp(),
         last_transition_at = clock_timestamp(),
         version = version + 1
   WHERE ops_case.id = p_case_id
     AND ops_case.status = 'OPEN'
     AND ops_case.version = p_expected_version
   RETURNING * INTO v_case;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUOC25: case changed during acknowledgment'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(MAX(event.sequence), 0) + 1 INTO v_sequence
    FROM public.universal_v1_ops_case_timeline event
   WHERE event.case_id = p_case_id;
  INSERT INTO public.universal_v1_ops_case_timeline(
    case_id, sequence, case_version, event_type, from_status, to_status,
    actor_id, reason, evidence_digest, idempotency_key, request_hash
  ) VALUES (
    p_case_id, v_sequence, v_case.version, 'ACKNOWLEDGED', 'OPEN', 'ACKNOWLEDGED',
    p_actor_id, p_reason, p_evidence_digest, p_idempotency_key, v_hash
  );
  RETURN QUERY SELECT v_case.id, v_case.status, v_case.version, FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.request_universal_v1_ops_case_transition_v1(
  p_case_id UUID,
  p_expected_case_version BIGINT,
  p_transition_kind TEXT,
  p_reason TEXT,
  p_evidence_digest CHAR(64),
  p_actor_id UUID,
  p_idempotency_key UUID
)
RETURNS TABLE(
  transition_request_id UUID,
  request_status TEXT,
  request_version BIGINT,
  case_version BIGINT,
  idempotency_replayed BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_hash CHAR(64);
  v_target_status TEXT;
  v_event_type TEXT;
  v_case public.universal_v1_ops_cases%ROWTYPE;
  v_existing public.universal_v1_ops_case_transition_requests%ROWTYPE;
  v_request public.universal_v1_ops_case_transition_requests%ROWTYPE;
  v_sequence BIGINT;
BEGIN
  PERFORM public.assert_universal_v1_ops_case_operator_v1(p_actor_id, FALSE);
  IF p_transition_kind = 'CONTAIN' THEN
    v_target_status := 'CONTAINED';
    v_event_type := 'CONTAINMENT_REQUESTED';
  ELSIF p_transition_kind = 'RESOLVE' THEN
    v_target_status := 'RESOLVED';
    v_event_type := 'RESOLUTION_REQUESTED';
  ELSE
    RAISE EXCEPTION 'HXUOC26: unsupported case transition request'
      USING ERRCODE = 'P0001';
  END IF;
  v_hash := public.universal_v1_ops_case_request_digest_v1(jsonb_build_object(
    'case_id', p_case_id,
    'expected_case_version', p_expected_case_version,
    'transition_kind', p_transition_kind,
    'reason', p_reason,
    'evidence_digest', p_evidence_digest,
    'actor_id', p_actor_id,
    'idempotency_key', p_idempotency_key
  ));
  SELECT * INTO v_case
    FROM public.universal_v1_ops_cases ops_case
   WHERE ops_case.id = p_case_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUOC22: Operations case was not found'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_existing
    FROM public.universal_v1_ops_case_transition_requests request
   WHERE request.requested_by = p_actor_id
     AND request.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.case_id <> p_case_id
       OR v_existing.transition_kind <> p_transition_kind
       OR v_existing.request_hash <> v_hash THEN
      RAISE EXCEPTION 'HXUOC27: transition-request idempotency key was reused with different input'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY SELECT
      v_existing.id, v_existing.status, v_existing.version, v_case.version, TRUE;
    RETURN;
  END IF;
  IF v_case.version <> p_expected_case_version
     OR (p_transition_kind = 'CONTAIN' AND v_case.status <> 'ACKNOWLEDGED')
     OR (p_transition_kind = 'RESOLVE' AND v_case.status <> 'CONTAINED') THEN
    RAISE EXCEPTION 'HXUOC28: transition request requires the exact predecessor case version'
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.universal_v1_ops_case_transition_requests pending
     WHERE pending.case_id = p_case_id AND pending.status = 'PENDING'
  ) THEN
    RAISE EXCEPTION 'HXUOC29: case already has a pending consequential transition'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.universal_v1_ops_case_transition_requests(
    case_id, transition_kind, target_status, case_expected_version,
    reason, evidence_digest, requested_by, idempotency_key, request_hash
  ) VALUES (
    p_case_id, p_transition_kind, v_target_status, p_expected_case_version,
    p_reason, p_evidence_digest, p_actor_id, p_idempotency_key, v_hash
  ) RETURNING * INTO v_request;
  SELECT COALESCE(MAX(event.sequence), 0) + 1 INTO v_sequence
    FROM public.universal_v1_ops_case_timeline event
   WHERE event.case_id = p_case_id;
  INSERT INTO public.universal_v1_ops_case_timeline(
    case_id, sequence, case_version, event_type, from_status, to_status,
    requested_status, transition_request_id, actor_id, reason,
    evidence_digest, idempotency_key, request_hash
  ) VALUES (
    p_case_id, v_sequence, v_case.version, v_event_type,
    v_case.status, v_case.status, v_target_status, v_request.id,
    p_actor_id, p_reason, p_evidence_digest, p_idempotency_key, v_hash
  );
  RETURN QUERY SELECT v_request.id, v_request.status, v_request.version, v_case.version, FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.decide_universal_v1_ops_case_transition_v1(
  p_transition_request_id UUID,
  p_expected_request_version BIGINT,
  p_expected_case_version BIGINT,
  p_decision TEXT,
  p_reason TEXT,
  p_evidence_digest CHAR(64),
  p_actor_id UUID,
  p_idempotency_key UUID
)
RETURNS TABLE(
  case_id UUID,
  case_status TEXT,
  case_version BIGINT,
  request_status TEXT,
  request_version BIGINT,
  idempotency_replayed BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_hash CHAR(64);
  v_decided_status TEXT;
  v_event_type TEXT;
  v_request public.universal_v1_ops_case_transition_requests%ROWTYPE;
  v_case public.universal_v1_ops_cases%ROWTYPE;
  v_sequence BIGINT;
BEGIN
  PERFORM public.assert_universal_v1_ops_case_operator_v1(p_actor_id, TRUE);
  IF p_decision = 'APPROVE' THEN
    v_decided_status := 'APPROVED';
  ELSIF p_decision = 'REJECT' THEN
    v_decided_status := 'REJECTED';
    v_event_type := 'TRANSITION_REJECTED';
  ELSE
    RAISE EXCEPTION 'HXUOC30: transition decision must be APPROVE or REJECT'
      USING ERRCODE = 'P0001';
  END IF;
  v_hash := public.universal_v1_ops_case_request_digest_v1(jsonb_build_object(
    'transition_request_id', p_transition_request_id,
    'expected_request_version', p_expected_request_version,
    'expected_case_version', p_expected_case_version,
    'decision', p_decision,
    'reason', p_reason,
    'evidence_digest', p_evidence_digest,
    'actor_id', p_actor_id,
    'idempotency_key', p_idempotency_key
  ));
  SELECT * INTO v_request
    FROM public.universal_v1_ops_case_transition_requests request
   WHERE request.id = p_transition_request_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUOC31: transition request was not found'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_case
    FROM public.universal_v1_ops_cases ops_case
   WHERE ops_case.id = v_request.case_id
   FOR UPDATE;
  IF v_request.status <> 'PENDING' THEN
    IF v_request.status = v_decided_status
       AND v_request.decided_by = p_actor_id
       AND v_request.decision_idempotency_key = p_idempotency_key
       AND v_request.decision_hash = v_hash THEN
      RETURN QUERY SELECT
        v_case.id, v_case.status, v_case.version,
        v_request.status, v_request.version, TRUE;
      RETURN;
    END IF;
    RAISE EXCEPTION 'HXUOC32: transition request is no longer pending'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_request.requested_by = p_actor_id THEN
    RAISE EXCEPTION 'HXUOC16: a transition requester cannot approve or reject their own request'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_request.version <> p_expected_request_version
     OR v_request.case_expected_version <> p_expected_case_version
     OR v_case.version <> p_expected_case_version THEN
    RAISE EXCEPTION 'HXUOC33: exact request or case version is stale'
      USING ERRCODE = 'P0001';
  END IF;
  IF (v_request.transition_kind = 'CONTAIN' AND v_case.status <> 'ACKNOWLEDGED')
     OR (v_request.transition_kind = 'RESOLVE' AND v_case.status <> 'CONTAINED') THEN
    RAISE EXCEPTION 'HXUOC34: case predecessor state no longer authorizes this transition'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.universal_v1_ops_case_transition_requests request
     SET status = v_decided_status,
         decided_by = p_actor_id,
         decision_reason = p_reason,
         decision_evidence_digest = p_evidence_digest,
         decision_idempotency_key = p_idempotency_key,
         decision_hash = v_hash,
         decided_at = clock_timestamp(),
         version = version + 1
   WHERE request.id = p_transition_request_id
     AND request.status = 'PENDING'
     AND request.version = p_expected_request_version
   RETURNING * INTO v_request;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUOC35: transition request changed during decision'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_decision = 'APPROVE' THEN
    IF v_request.transition_kind = 'CONTAIN' THEN
      UPDATE public.universal_v1_ops_cases ops_case
         SET status = 'CONTAINED',
             contained_by = p_actor_id,
             contained_at = clock_timestamp(),
             contained_transition_request_id = v_request.id,
             last_transition_at = clock_timestamp(),
             version = version + 1
       WHERE ops_case.id = v_case.id
         AND ops_case.status = 'ACKNOWLEDGED'
         AND ops_case.version = p_expected_case_version
       RETURNING * INTO v_case;
      v_event_type := 'CONTAINED';
    ELSE
      UPDATE public.universal_v1_ops_cases ops_case
         SET status = 'RESOLVED',
             resolved_by = p_actor_id,
             resolved_at = clock_timestamp(),
             resolved_transition_request_id = v_request.id,
             last_transition_at = clock_timestamp(),
             version = version + 1
       WHERE ops_case.id = v_case.id
         AND ops_case.status = 'CONTAINED'
         AND ops_case.version = p_expected_case_version
       RETURNING * INTO v_case;
      v_event_type := 'RESOLVED';
    END IF;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'HXUOC36: case changed during approved transition'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT COALESCE(MAX(event.sequence), 0) + 1 INTO v_sequence
    FROM public.universal_v1_ops_case_timeline event
   WHERE event.case_id = v_case.id;
  INSERT INTO public.universal_v1_ops_case_timeline(
    case_id, sequence, case_version, event_type, from_status, to_status,
    requested_status, transition_request_id, actor_id, reason,
    evidence_digest, idempotency_key, request_hash
  ) VALUES (
    v_case.id,
    v_sequence,
    v_case.version,
    v_event_type,
    CASE v_request.transition_kind WHEN 'CONTAIN' THEN 'ACKNOWLEDGED' ELSE 'CONTAINED' END,
    CASE
      WHEN p_decision = 'REJECT' THEN v_case.status
      ELSE v_request.target_status
    END,
    v_request.target_status,
    v_request.id,
    p_actor_id,
    p_reason,
    p_evidence_digest,
    p_idempotency_key,
    v_hash
  );
  RETURN QUERY SELECT
    v_case.id, v_case.status, v_case.version,
    v_request.status, v_request.version, FALSE;
END;
$$;

REVOKE ALL ON TABLE public.universal_v1_ops_cases FROM PUBLIC;
REVOKE ALL ON TABLE public.universal_v1_ops_case_transition_requests FROM PUBLIC;
REVOKE ALL ON TABLE public.universal_v1_ops_case_timeline FROM PUBLIC;
REVOKE ALL ON TABLE public.universal_v1_ops_case_access_audit FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_universal_v1_ops_case_operator_v1(UUID, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.open_universal_v1_ops_case_v1(
  UUID, TEXT, INTEGER, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, CHAR(64), UUID, UUID
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.acknowledge_universal_v1_ops_case_v1(
  UUID, BIGINT, TEXT, CHAR(64), UUID, UUID
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_universal_v1_ops_case_transition_v1(
  UUID, BIGINT, TEXT, TEXT, CHAR(64), UUID, UUID
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.decide_universal_v1_ops_case_transition_v1(
  UUID, BIGINT, BIGINT, TEXT, TEXT, CHAR(64), UUID, UUID
) FROM PUBLIC;

DO $$
DECLARE
  v_role TEXT;
  v_relation TEXT;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      FOREACH v_relation IN ARRAY ARRAY[
        'universal_v1_ops_cases',
        'universal_v1_ops_case_transition_requests',
        'universal_v1_ops_case_timeline',
        'universal_v1_ops_case_access_audit'
      ] LOOP
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', v_relation, v_role);
      END LOOP;
    END IF;
  END LOOP;
END;
$$;

COMMENT ON TABLE public.universal_v1_ops_cases IS
  'Authoritative versioned Universal V1 Operations cases bound to one exact immutable occurrence and aggregate version; no business-lifecycle write authority.';
COMMENT ON TABLE public.universal_v1_ops_case_transition_requests IS
  'Two-person expected-version authority for consequential case containment and resolution only.';
COMMENT ON TABLE public.universal_v1_ops_case_timeline IS
  'Append-only immutable timeline for every case observation, request, rejection, and transition.';
COMMENT ON TABLE public.universal_v1_ops_case_access_audit IS
  'Append-only purpose-bound audit of named-operator case-detail observation.';
COMMENT ON FUNCTION public.open_universal_v1_ops_case_v1(
  UUID, TEXT, INTEGER, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, CHAR(64), UUID, UUID
) IS
  'Application-bound named-operator command with DB RBAC recheck; PostgreSQL caller-to-actor attestation remains held pending a dedicated command role.';
