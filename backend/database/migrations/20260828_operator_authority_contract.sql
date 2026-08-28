-- Universal V1 named-operator authority.
--
-- This rail intentionally authorizes only two non-money, non-assignment
-- containment operations: expire an action link and disable a feature flag.
-- Payment creation, settlement, assignment, deployment, production migration,
-- and TestFlight authority are not represented and therefore cannot be
-- requested or approved through this contract.

ALTER TABLE public.action_links
  ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0);

ALTER TABLE public.feature_flags
  ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0);

CREATE OR REPLACE FUNCTION public.bump_operator_target_version()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS action_links_operator_version ON public.action_links;
CREATE TRIGGER action_links_operator_version
BEFORE UPDATE ON public.action_links
FOR EACH ROW EXECUTE FUNCTION public.bump_operator_target_version();

DROP TRIGGER IF EXISTS feature_flags_operator_version ON public.feature_flags;
CREATE TRIGGER feature_flags_operator_version
BEFORE UPDATE ON public.feature_flags
FOR EACH ROW EXECUTE FUNCTION public.bump_operator_target_version();

CREATE TABLE IF NOT EXISTS public.operator_command_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_type TEXT NOT NULL CHECK (operation_type IN (
    'EXPIRE_ACTION_LINK',
    'DISABLE_FEATURE_FLAG'
  )),
  authority_scope TEXT NOT NULL CHECK (authority_scope IN (
    'ACTION_LINK_STATUS',
    'FEATURE_FLAGS'
  )),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('ACTION_LINK', 'FEATURE_FLAG')),
  target_id TEXT NOT NULL CHECK (char_length(target_id) BETWEEN 1 AND 240),
  target_expected_version BIGINT NOT NULL CHECK (target_expected_version > 0),
  command_payload JSONB NOT NULL,
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 500),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'EXECUTED', 'REJECTED')),
  requested_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  approved_by UUID REFERENCES public.users(id) ON DELETE RESTRICT,
  approval_reason TEXT CHECK (approval_reason IS NULL OR char_length(approval_reason) BETWEEN 10 AND 500),
  decision_idempotency_key UUID,
  idempotency_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  execution_result JSONB,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  decided_at TIMESTAMPTZ,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (requested_by, idempotency_key),
  UNIQUE (approved_by, decision_idempotency_key),
  CHECK (requested_by IS DISTINCT FROM approved_by),
  CHECK (
    (operation_type = 'EXPIRE_ACTION_LINK'
      AND authority_scope = 'ACTION_LINK_STATUS'
      AND target_kind = 'ACTION_LINK'
      AND command_payload = '{"status":"expired"}'::jsonb)
    OR
    (operation_type = 'DISABLE_FEATURE_FLAG'
      AND authority_scope = 'FEATURE_FLAGS'
      AND target_kind = 'FEATURE_FLAG'
      AND command_payload = '{"enabled":false}'::jsonb)
  ),
  CHECK (
    (status = 'PENDING' AND approved_by IS NULL AND approval_reason IS NULL
      AND decision_idempotency_key IS NULL
      AND decided_at IS NULL AND execution_result IS NULL)
    OR
    (status IN ('EXECUTED', 'REJECTED') AND approved_by IS NOT NULL
      AND approval_reason IS NOT NULL AND decision_idempotency_key IS NOT NULL
      AND decided_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS operator_command_pending_time
  ON public.operator_command_requests(requested_at, id)
  WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS operator_command_target_time
  ON public.operator_command_requests(target_kind, target_id, requested_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS operator_command_one_pending_target
  ON public.operator_command_requests(operation_type, target_kind, target_id)
  WHERE status = 'PENDING';

CREATE TABLE IF NOT EXISTS public.operator_command_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id UUID NOT NULL REFERENCES public.operator_command_requests(id) ON DELETE RESTRICT,
  command_version BIGINT NOT NULL CHECK (command_version > 0),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'REQUESTED',
    'APPROVED_AND_EXECUTED',
    'REJECTED'
  )),
  actor_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  authority_scope TEXT NOT NULL CHECK (authority_scope IN (
    'ACTION_LINK_STATUS',
    'FEATURE_FLAGS'
  )),
  event_details JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (command_id, command_version, event_type)
);

CREATE INDEX IF NOT EXISTS operator_command_audit_command_time
  ON public.operator_command_audit(command_id, created_at, id);

CREATE OR REPLACE FUNCTION public.enforce_operator_command_transition()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.operation_type IS DISTINCT FROM OLD.operation_type
     OR NEW.authority_scope IS DISTINCT FROM OLD.authority_scope
     OR NEW.target_kind IS DISTINCT FROM OLD.target_kind
     OR NEW.target_id IS DISTINCT FROM OLD.target_id
     OR NEW.target_expected_version IS DISTINCT FROM OLD.target_expected_version
     OR NEW.command_payload IS DISTINCT FROM OLD.command_payload
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'HXOPA1: immutable operator command fields cannot change' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'PENDING' OR NEW.status NOT IN ('EXECUTED', 'REJECTED') THEN
    RAISE EXCEPTION 'HXOPA2: invalid operator command transition' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.requested_by = NEW.approved_by THEN
    RAISE EXCEPTION 'HXOPA3: requester cannot approve their own operator command' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'HXOPA4: operator command version must advance exactly once' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS operator_command_transition_guard ON public.operator_command_requests;
CREATE TRIGGER operator_command_transition_guard
BEFORE UPDATE ON public.operator_command_requests
FOR EACH ROW EXECUTE FUNCTION public.enforce_operator_command_transition();

CREATE OR REPLACE FUNCTION public.prevent_operator_authority_evidence_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HXOPA5: operator authority evidence is immutable' USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS operator_command_no_delete ON public.operator_command_requests;
CREATE TRIGGER operator_command_no_delete
BEFORE DELETE ON public.operator_command_requests
FOR EACH ROW EXECUTE FUNCTION public.prevent_operator_authority_evidence_mutation();

DROP TRIGGER IF EXISTS operator_command_no_truncate ON public.operator_command_requests;
CREATE TRIGGER operator_command_no_truncate
BEFORE TRUNCATE ON public.operator_command_requests
FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_operator_authority_evidence_mutation();

DROP TRIGGER IF EXISTS operator_command_audit_no_mutation ON public.operator_command_audit;
CREATE TRIGGER operator_command_audit_no_mutation
BEFORE UPDATE OR DELETE ON public.operator_command_audit
FOR EACH ROW EXECUTE FUNCTION public.prevent_operator_authority_evidence_mutation();

DROP TRIGGER IF EXISTS operator_command_audit_no_truncate ON public.operator_command_audit;
CREATE TRIGGER operator_command_audit_no_truncate
BEFORE TRUNCATE ON public.operator_command_audit
FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_operator_authority_evidence_mutation();

COMMENT ON TABLE public.operator_command_requests IS
  'Versioned two-person Operations commands; only containment operations exist in Universal V1.';
COMMENT ON TABLE public.operator_command_audit IS
  'Append-only transactional evidence for every operator command request and decision.';
