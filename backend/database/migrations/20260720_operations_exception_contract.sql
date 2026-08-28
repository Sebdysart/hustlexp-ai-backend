-- HX/OS 2.0 exception-first Operations contract.
--
-- This migration gives Operations a consequence-specific authority, derives a
-- privacy-safe queue from canonical engine state, and records every sensitive
-- detail read, ownership change, and bounded recovery in append-only evidence.

ALTER TABLE public.admin_roles
  ADD COLUMN IF NOT EXISTS can_manage_operations BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE public.admin_roles
   SET can_manage_operations = TRUE
 WHERE role IN ('support', 'admin', 'founder');

ALTER TABLE public.admin_roles
  ALTER COLUMN can_manage_operations SET DEFAULT FALSE,
  ALTER COLUMN can_manage_operations SET NOT NULL;

CREATE TABLE IF NOT EXISTS public.operations_exception_access_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_key TEXT NOT NULL CHECK (char_length(cluster_key) BETWEEN 3 AND 240),
  admin_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  purpose TEXT NOT NULL CHECK (char_length(purpose) BETWEEN 10 AND 500),
  signal_count INTEGER NOT NULL CHECK (signal_count > 0),
  access_scope TEXT NOT NULL DEFAULT 'EXCEPTION_DETAIL'
    CHECK (access_scope = 'EXCEPTION_DETAIL'),
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS operations_exception_access_cluster_time
  ON public.operations_exception_access_log(cluster_key, accessed_at DESC);
CREATE INDEX IF NOT EXISTS operations_exception_access_admin_time
  ON public.operations_exception_access_log(admin_user_id, accessed_at DESC);

CREATE TABLE IF NOT EXISTS public.operations_exception_ownership (
  cluster_key TEXT PRIMARY KEY CHECK (char_length(cluster_key) BETWEEN 3 AND 240),
  assigned_admin_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS operations_exception_ownership_admin_time
  ON public.operations_exception_ownership(assigned_admin_id, assigned_at);

CREATE TABLE IF NOT EXISTS public.operations_exception_ownership_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_key TEXT NOT NULL CHECK (char_length(cluster_key) BETWEEN 3 AND 240),
  actor_admin_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('CLAIMED', 'RELEASED')),
  previous_assignee_id UUID REFERENCES public.users(id) ON DELETE RESTRICT,
  new_assignee_id UUID REFERENCES public.users(id) ON DELETE RESTRICT,
  reason_code TEXT NOT NULL CHECK (reason_code IN ('OPERATOR_CLAIM', 'OPERATOR_RELEASE')),
  idempotency_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (actor_admin_id, idempotency_key),
  CHECK (
    (event_type = 'CLAIMED' AND new_assignee_id IS NOT NULL)
    OR (event_type = 'RELEASED' AND previous_assignee_id IS NOT NULL AND new_assignee_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS operations_exception_ownership_event_cluster_time
  ON public.operations_exception_ownership_events(cluster_key, created_at DESC);

CREATE TABLE IF NOT EXISTS public.operations_exception_action_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_key TEXT NOT NULL CHECK (char_length(cluster_key) BETWEEN 3 AND 240),
  actor_admin_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  action_type TEXT NOT NULL CHECK (action_type IN (
    'NOTIFICATION_RETRY_SCHEDULED', 'NOTIFICATION_RETRY_CANCELLED'
  )),
  notification_delivery_id UUID NOT NULL
    REFERENCES public.notification_deliveries(id) ON DELETE RESTRICT,
  idempotency_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'OPERATOR_MISSING_WORK_RETRY', 'OPERATOR_RETRY_CANCELLED'
  )),
  previous_state TEXT NOT NULL,
  new_state TEXT NOT NULL,
  previous_attempt_count INTEGER NOT NULL CHECK (previous_attempt_count BETWEEN 0 AND 5),
  new_attempt_count INTEGER NOT NULL CHECK (new_attempt_count BETWEEN 0 AND 5),
  previous_max_attempts INTEGER NOT NULL CHECK (previous_max_attempts BETWEEN 1 AND 5),
  new_max_attempts INTEGER NOT NULL CHECK (new_max_attempts BETWEEN 1 AND 5),
  previous_available_at TIMESTAMPTZ NOT NULL,
  new_available_at TIMESTAMPTZ NOT NULL,
  previous_next_retry_at TIMESTAMPTZ,
  new_next_retry_at TIMESTAMPTZ,
  previous_terminal_failure_at TIMESTAMPTZ,
  new_terminal_failure_at TIMESTAMPTZ,
  reversal_of_action_id UUID REFERENCES public.operations_exception_action_events(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (actor_admin_id, idempotency_key),
  CHECK (
    (action_type = 'NOTIFICATION_RETRY_SCHEDULED'
      AND previous_state = 'failed_terminal'
      AND new_state = 'retry_pending'
      AND previous_terminal_failure_at IS NOT NULL
      AND new_terminal_failure_at IS NULL
      AND new_max_attempts > previous_max_attempts
      AND reversal_of_action_id IS NULL)
    OR
    (action_type = 'NOTIFICATION_RETRY_CANCELLED'
      AND previous_state = 'retry_pending'
      AND new_state = 'failed_terminal'
      AND new_terminal_failure_at IS NOT NULL
      AND reversal_of_action_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS operations_exception_action_cluster_time
  ON public.operations_exception_action_events(cluster_key, created_at DESC);
CREATE INDEX IF NOT EXISTS operations_exception_action_delivery_time
  ON public.operations_exception_action_events(notification_delivery_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.prevent_operations_exception_evidence_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'HX830: Operations exception evidence is append-only'
    USING ERRCODE = 'HX830';
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'operations_exception_access_log',
    'operations_exception_ownership_events',
    'operations_exception_action_events'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS operations_exception_no_update ON public.%I', v_table);
    EXECUTE format(
      'CREATE TRIGGER operations_exception_no_update BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.prevent_operations_exception_evidence_mutation()',
      v_table
    );
    EXECUTE format('DROP TRIGGER IF EXISTS operations_exception_no_delete ON public.%I', v_table);
    EXECUTE format(
      'CREATE TRIGGER operations_exception_no_delete BEFORE DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.prevent_operations_exception_evidence_mutation()',
      v_table
    );
    EXECUTE format('DROP TRIGGER IF EXISTS operations_exception_no_truncate ON public.%I', v_table);
    EXECUTE format(
      'CREATE TRIGGER operations_exception_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_operations_exception_evidence_mutation()',
      v_table
    );
  END LOOP;
END
$$;

CREATE OR REPLACE VIEW public.operations_exception_signals AS
SELECT
  'safety:' || incident.id::TEXT AS signal_id,
  'safety_case:' || incident.id::TEXT AS cluster_key,
  1::INTEGER AS priority_rank,
  'SAFETY'::TEXT AS priority_class,
  upper(incident.category) AS root_cause_code,
  'Participant safety case'::TEXT AS root_cause_label,
  'task_safety_incidents'::TEXT AS source_type,
  incident.id::TEXT AS source_id,
  incident.task_id,
  CASE incident.urgency WHEN 'urgent' THEN 'CRITICAL' WHEN 'high' THEN 'HIGH' ELSE 'MEDIUM' END::TEXT AS severity,
  incident.status::TEXT AS lifecycle_state,
  incident.created_at AS detected_at,
  NULL::BIGINT AS amount_cents,
  task.currency::TEXT AS currency,
  COALESCE(task.region_policy_version, 'UNATTRIBUTED')::TEXT AS policy_version,
  'NOT_APPLICABLE'::TEXT AS model_version,
  'NOT_APPLICABLE'::TEXT AS model_applicability,
  'A4'::TEXT AS automation_class,
  0::INTEGER AS attempt_count,
  0::INTEGER AS max_attempts,
  FALSE AS recovery_eligible,
  NULL::TEXT AS recovery_kind,
  ('Canonical ' || incident.urgency || ' safety case; narrative, identity, and location are masked.')::TEXT AS evidence_summary,
  NULL::TEXT AS provider_name
FROM public.task_safety_incidents incident
JOIN public.tasks task ON task.id = incident.task_id
WHERE incident.status NOT IN ('resolved', 'closed')

UNION ALL

SELECT
  'money:' || escrow.id::TEXT,
  'money_exception:' || escrow.id::TEXT,
  2,
  'MONEY',
  CASE WHEN escrow.state = 'LOCKED_DISPUTE' THEN 'ESCROW_DISPUTE_LOCK' ELSE 'PAYOUT_MANUAL_RECONCILIATION' END,
  CASE WHEN escrow.state = 'LOCKED_DISPUTE' THEN 'Escrow locked for dispute' ELSE 'Payout requires manual reconciliation' END,
  'escrows',
  escrow.id::TEXT,
  escrow.task_id,
  'CRITICAL',
  CASE WHEN escrow.state = 'LOCKED_DISPUTE' THEN escrow.state::TEXT ELSE escrow.provider_transfer_status END,
  escrow.updated_at,
  escrow.amount::BIGINT,
  COALESCE(task.currency, 'USD'),
  COALESCE(task.region_policy_version, 'UNATTRIBUTED'),
  'NOT_APPLICABLE',
  'NOT_APPLICABLE',
  'A3',
  0,
  0,
  FALSE,
  NULL::TEXT,
  'Canonical escrow state requires specialized financial or dispute authority.',
  escrow.payout_provider
FROM public.escrows escrow
JOIN public.tasks task ON task.id = escrow.task_id
WHERE escrow.state = 'LOCKED_DISPUTE'
   OR escrow.provider_transfer_status = 'manual_reconciliation'

UNION ALL

SELECT
  'active_task:' || task.id::TEXT,
  'active_task:' || task.id::TEXT,
  3,
  'ACTIVE_TASK',
  CASE WHEN task.deadline IS NOT NULL AND task.deadline < NOW()
    THEN 'ACTIVE_TASK_DEADLINE_BREACH' ELSE 'ACTIVE_TASK_STALE_PROGRESS' END,
  CASE WHEN task.deadline IS NOT NULL AND task.deadline < NOW()
    THEN 'Active task passed its deadline' ELSE 'Active task progress is stale' END,
  'tasks',
  task.id::TEXT,
  task.id,
  CASE WHEN task.deadline IS NOT NULL AND task.deadline < NOW() THEN 'CRITICAL' ELSE 'HIGH' END,
  task.state::TEXT || ':' || task.progress_state::TEXT,
  COALESCE(task.deadline, task.progress_updated_at, task.started_at, task.accepted_at, task.updated_at),
  task.price::BIGINT,
  COALESCE(task.currency, 'USD'),
  COALESCE(task.region_policy_version, 'UNATTRIBUTED'),
  'NOT_APPLICABLE',
  'NOT_APPLICABLE',
  'A2',
  0,
  0,
  FALSE,
  NULL::TEXT,
  'Canonical active-task timestamps exceed the Operations threshold; exact location and task content are masked.',
  NULL::TEXT
FROM public.tasks task
WHERE task.state = 'ACCEPTED'
  AND task.progress_state IN ('ACCEPTED', 'TRAVELING', 'WORKING')
  AND (
    (task.deadline IS NOT NULL AND task.deadline < NOW())
    OR COALESCE(task.progress_updated_at, task.started_at, task.accepted_at, task.updated_at)
       < NOW() - INTERVAL '2 hours'
  )

UNION ALL

SELECT
  'sla:' || task.id::TEXT,
  'sla_risk:' || task.id::TEXT,
  4,
  'SLA',
  CASE WHEN task.dispatch_expires_at < NOW() THEN 'DISPATCH_SLA_BREACH' ELSE 'DISPATCH_SLA_AT_RISK' END,
  CASE WHEN task.dispatch_expires_at < NOW() THEN 'Dispatch window expired without acceptance' ELSE 'Dispatch window nearing expiry' END,
  'tasks',
  task.id::TEXT,
  task.id,
  CASE WHEN task.dispatch_expires_at < NOW() THEN 'HIGH' ELSE 'MEDIUM' END,
  task.state::TEXT,
  task.dispatch_expires_at,
  task.price::BIGINT,
  COALESCE(task.currency, 'USD'),
  COALESCE(task.region_policy_version, 'UNATTRIBUTED'),
  'NOT_APPLICABLE',
  'NOT_APPLICABLE',
  'A2',
  0,
  0,
  FALSE,
  NULL::TEXT,
  'Canonical dispatch expiry is within the 15-minute Operations threshold.',
  NULL::TEXT
FROM public.tasks task
WHERE task.state = 'OPEN'
  AND task.dispatch_expires_at IS NOT NULL
  AND task.dispatch_expires_at <= NOW() + INTERVAL '15 minutes'

UNION ALL

SELECT
  'communication:' || delivery.id::TEXT,
  'communication_failure:' || COALESCE(delivery.provider_name, 'unattributed') || ':' || delivery.channel,
  6,
  'COMMUNICATION',
  'TERMINAL_' || upper(delivery.channel) || '_DELIVERY_FAILURE',
  'Terminal communication delivery failure',
  'notification_deliveries',
  delivery.id::TEXT,
  notification.task_id,
  CASE WHEN notification.notification_class = 'transaction_critical' THEN 'HIGH' ELSE 'MEDIUM' END,
  delivery.state,
  delivery.terminal_failure_at,
  NULL::BIGINT,
  NULL::TEXT,
  'hxos-notification-delivery-v1',
  'NOT_APPLICABLE',
  'NOT_APPLICABLE',
  'A2',
  delivery.attempt_count,
  delivery.max_attempts,
  (
    delivery.channel IN ('email', 'push', 'sms')
    AND delivery.max_attempts < 5
    AND delivery.attempt_count < 5
    AND notification.superseded_at IS NULL
    AND (notification.expires_at IS NULL OR notification.expires_at > NOW())
    AND (
      (delivery.channel = 'email' AND NOT EXISTS (
        SELECT 1 FROM public.email_outbox item WHERE item.notification_id = delivery.notification_id
      ))
      OR (delivery.channel = 'sms' AND NOT EXISTS (
        SELECT 1 FROM public.sms_outbox item WHERE item.notification_id = delivery.notification_id
      ))
      OR (delivery.channel = 'push' AND NOT EXISTS (
        SELECT 1 FROM public.outbox_events item
         WHERE item.event_type = 'push.send_requested'
           AND item.aggregate_id = delivery.notification_id
      ))
    )
  ),
  CASE WHEN delivery.channel IN ('email', 'push', 'sms')
    THEN 'MISSING_NOTIFICATION_WORK_RETRY' ELSE NULL END,
  ('Provider-observable terminal failure after ' || delivery.attempt_count::TEXT || ' of '
    || delivery.max_attempts::TEXT || ' attempts; destination and raw provider error are masked.'),
  delivery.provider_name
FROM public.notification_deliveries delivery
JOIN public.notifications notification ON notification.id = delivery.notification_id
WHERE delivery.state = 'failed_terminal'
  AND delivery.terminal_visibility = 'operator_exception'

UNION ALL

SELECT
  'major_action:' || action.id::TEXT,
  'engine_failure:' || action.action_class || ':' || action.failure_reason_code,
  CASE
    WHEN action.action_class = 'SAFETY' THEN 1
    WHEN action.action_class IN ('PAYMENT', 'SETTLEMENT', 'PAYOUT', 'DISPUTE') THEN 2
    WHEN action.action_class IN ('EXECUTION', 'PROOF_COMPLETION', 'OFFLINE_SYNC') THEN 3
    WHEN action.action_class IN ('DISPATCH', 'OFFER_ASSIGNMENT') THEN 4
    WHEN action.action_class = 'TRUST_IDENTITY' THEN 5
    WHEN action.action_class = 'NOTIFICATION' THEN 6
    ELSE 7
  END,
  CASE
    WHEN action.action_class = 'SAFETY' THEN 'SAFETY'
    WHEN action.action_class IN ('PAYMENT', 'SETTLEMENT', 'PAYOUT', 'DISPUTE') THEN 'MONEY'
    WHEN action.action_class IN ('EXECUTION', 'PROOF_COMPLETION', 'OFFLINE_SYNC') THEN 'ACTIVE_TASK'
    WHEN action.action_class IN ('DISPATCH', 'OFFER_ASSIGNMENT') THEN 'SLA'
    WHEN action.action_class = 'TRUST_IDENTITY' THEN 'TRUST'
    WHEN action.action_class = 'NOTIFICATION' THEN 'COMMUNICATION'
    ELSE 'DATA'
  END,
  action.failure_reason_code,
  'Engine action failure cluster',
  action.source_table,
  action.source_event_id,
  CASE WHEN action.aggregate_type = 'task' AND action.aggregate_id ~*
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    THEN action.aggregate_id::UUID ELSE NULL::UUID END,
  action.risk_class,
  action.lifecycle_state,
  action.occurred_at,
  NULL::BIGINT,
  NULL::TEXT,
  action.policy_version,
  action.model_version,
  action.model_applicability,
  action.automation_class,
  1,
  1,
  FALSE,
  NULL::TEXT,
  ('Append-only engine result ' || action.result || '; recovery code ' || action.recovery_action_code || '.'),
  NULL::TEXT
FROM public.major_action_events action
WHERE action.result IN ('FAILURE', 'REJECTED', 'CONFLICT')
  AND action.occurred_at >= NOW() - INTERVAL '30 days';

COMMENT ON VIEW public.operations_exception_signals IS
  'HX/OS canonical privacy-safe Operations signals ordered safety, money, active-task, SLA, trust, communications, and data.';

REVOKE ALL ON TABLE public.operations_exception_access_log FROM PUBLIC;
REVOKE ALL ON TABLE public.operations_exception_ownership FROM PUBLIC;
REVOKE ALL ON TABLE public.operations_exception_ownership_events FROM PUBLIC;
REVOKE ALL ON TABLE public.operations_exception_action_events FROM PUBLIC;
REVOKE ALL ON TABLE public.operations_exception_signals FROM PUBLIC;

DO $$
DECLARE
  v_role TEXT;
  v_relation TEXT;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      FOREACH v_relation IN ARRAY ARRAY[
        'operations_exception_access_log',
        'operations_exception_ownership',
        'operations_exception_ownership_events',
        'operations_exception_action_events',
        'operations_exception_signals'
      ] LOOP
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', v_relation, v_role);
      END LOOP;
    END IF;
  END LOOP;
END
$$;

COMMENT ON TABLE public.operations_exception_access_log IS
  'Purpose-bound append-only evidence for sensitive Operations detail reads.';
COMMENT ON TABLE public.operations_exception_action_events IS
  'Append-only exact before/after evidence for bounded, reversible Operations recovery.';
