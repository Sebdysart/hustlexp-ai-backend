-- HustleXP Business canonical execution contract v1.
-- Business policy authorizes work; canonical tasks, escrows, proof, disputes,
-- reviews, and immutable snapshots remain the only execution and money truth.

BEGIN;

ALTER TABLE business_approval_requests
  ADD COLUMN IF NOT EXISTS canonical_task_id UUID REFERENCES tasks(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS committed_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS business_approval_canonical_task_unique
  ON business_approval_requests(canonical_task_id) WHERE canonical_task_id IS NOT NULL;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS business_organization_id UUID REFERENCES business_organizations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS business_location_id UUID REFERENCES business_locations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS business_approval_request_id UUID REFERENCES business_approval_requests(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS business_requester_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS business_approver_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS business_policy_snapshot JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS task_business_approval_unique
  ON tasks(business_approval_request_id) WHERE business_approval_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS task_business_org_created_idx
  ON tasks(business_organization_id,created_at DESC)
  WHERE business_organization_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS business_provider_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES business_organizations(id) ON DELETE RESTRICT,
  location_id UUID REFERENCES business_locations(id) ON DELETE RESTRICT,
  service_category TEXT NOT NULL DEFAULT '*'
    CHECK (char_length(btrim(service_category)) BETWEEN 1 AND 80),
  provider_worker_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  priority TEXT NOT NULL CHECK (priority IN ('PRIMARY','BACKUP')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS business_provider_preference_worker_unique
  ON business_provider_preferences(
    organization_id,
    COALESCE(location_id,'00000000-0000-0000-0000-000000000000'::UUID),
    lower(service_category),provider_worker_id
  );
CREATE UNIQUE INDEX IF NOT EXISTS business_provider_primary_scope_unique
  ON business_provider_preferences(
    organization_id,
    COALESCE(location_id,'00000000-0000-0000-0000-000000000000'::UUID),
    lower(service_category)
  ) WHERE priority='PRIMARY' AND active=TRUE;

CREATE TABLE IF NOT EXISTS business_invoice_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES business_organizations(id) ON DELETE RESTRICT,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL CHECK (period_end>period_start),
  currency TEXT NOT NULL DEFAULT 'usd' CHECK (currency='usd'),
  status TEXT NOT NULL DEFAULT 'SNAPSHOT' CHECK (status='SNAPSHOT'),
  transaction_count INTEGER NOT NULL CHECK (transaction_count>=0),
  customer_total_cents BIGINT NOT NULL CHECK (customer_total_cents>=0),
  refunded_total_cents BIGINT NOT NULL CHECK (refunded_total_cents>=0),
  settled_total_cents BIGINT NOT NULL CHECK (settled_total_cents>=0),
  grouping_snapshot JSONB NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{8,128}$'),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id,idempotency_key)
);

CREATE TABLE IF NOT EXISTS business_invoice_snapshot_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_snapshot_id UUID NOT NULL REFERENCES business_invoice_snapshots(id) ON DELETE RESTRICT,
  organization_id UUID NOT NULL REFERENCES business_organizations(id) ON DELETE RESTRICT,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  location_id UUID REFERENCES business_locations(id) ON DELETE RESTRICT,
  service_category TEXT,
  escrow_state TEXT NOT NULL CHECK (escrow_state IN ('RELEASED','REFUNDED','REFUND_PARTIAL')),
  customer_total_cents BIGINT NOT NULL CHECK (customer_total_cents>0),
  refunded_cents BIGINT NOT NULL CHECK (refunded_cents>=0),
  settled_cents BIGINT NOT NULL CHECK (settled_cents>=0),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (invoice_snapshot_id,task_id)
);

CREATE OR REPLACE FUNCTION prevent_business_execution_evidence_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HXBUS40: business execution evidence is append-only';
END $$;

DROP TRIGGER IF EXISTS business_invoice_snapshot_immutable ON business_invoice_snapshots;
CREATE TRIGGER business_invoice_snapshot_immutable
BEFORE UPDATE OR DELETE ON business_invoice_snapshots
FOR EACH ROW EXECUTE FUNCTION prevent_business_execution_evidence_mutation();

DROP TRIGGER IF EXISTS business_invoice_snapshot_line_immutable ON business_invoice_snapshot_lines;
CREATE TRIGGER business_invoice_snapshot_line_immutable
BEFORE UPDATE OR DELETE ON business_invoice_snapshot_lines
FOR EACH ROW EXECUTE FUNCTION prevent_business_execution_evidence_mutation();

CREATE OR REPLACE FUNCTION bind_business_work_order(
  p_organization_id UUID,
  p_actor_id UUID,
  p_approval_request_id UUID,
  p_task_id UUID
) RETURNS TABLE(canonical_task_id UUID, idempotency_replayed BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_request business_approval_requests%ROWTYPE;
  v_task tasks%ROWTYPE;
  v_month_spend BIGINT := 0;
  v_monthly_cap BIGINT;
  v_approver_id UUID;
BEGIN
  PERFORM business_require_action(p_organization_id,p_actor_id,'CREATE_WORK_ORDER');
  SELECT * INTO v_request FROM business_approval_requests
  WHERE id=p_approval_request_id AND organization_id=p_organization_id
  FOR UPDATE;
  IF v_request.id IS NULL OR v_request.requester_id<>p_actor_id THEN
    RAISE EXCEPTION 'HXBUS31: approval request is outside actor authority';
  END IF;
  IF v_request.canonical_task_id IS NOT NULL THEN
    IF v_request.canonical_task_id<>p_task_id THEN
      RAISE EXCEPTION 'HXBUS4: approval request is already bound to another task';
    END IF;
    RETURN QUERY SELECT v_request.canonical_task_id,TRUE;
    RETURN;
  END IF;
  IF v_request.status NOT IN ('AUTO_APPROVED','APPROVED') THEN
    RAISE EXCEPTION 'HXBUS32: spend is not approved for work-order creation';
  END IF;

  SELECT * INTO v_task FROM tasks WHERE id=p_task_id FOR UPDATE;
  IF v_task.id IS NULL OR v_task.poster_id<>p_actor_id
     OR v_task.price<>v_request.amount_cents
     OR lower(COALESCE(v_task.category,''))<>lower(v_request.service_category)
     OR v_task.business_organization_id IS NOT NULL
     OR NOT EXISTS (
       SELECT 1 FROM escrows escrow
       WHERE escrow.task_id=v_task.id AND escrow.state='PENDING' AND escrow.amount=v_task.price
     ) THEN
    RAISE EXCEPTION 'HXBUS34: canonical task does not reconcile to approved demand';
  END IF;

  v_monthly_cap := COALESCE((v_request.policy_snapshot->>'monthly_cap_cents')::BIGINT,0);
  SELECT COALESCE(SUM(amount_cents),0) INTO v_month_spend
  FROM business_spend_ledger
  WHERE organization_id=p_organization_id
    AND created_at>=date_trunc('month',NOW())
    AND entry_type IN ('COMMITTED','SETTLED','REVERSED','REFUNDED');
  IF v_monthly_cap<=0 OR v_month_spend+v_request.amount_cents>v_monthly_cap THEN
    RAISE EXCEPTION 'HXBUS33: BIND_BUDGET_CAP_EXCEEDED';
  END IF;

  SELECT actor_id INTO v_approver_id FROM business_approval_decisions
  WHERE approval_request_id=v_request.id AND decision='APPROVED';
  UPDATE tasks SET
    business_organization_id=p_organization_id,
    business_location_id=v_request.location_id,
    business_approval_request_id=v_request.id,
    business_requester_id=v_request.requester_id,
    business_approver_id=v_approver_id,
    business_policy_snapshot=v_request.policy_snapshot,
    preferred_worker_id=COALESCE(preferred_worker_id,(
      SELECT preference.provider_worker_id
      FROM business_provider_preferences preference
      WHERE preference.organization_id=p_organization_id AND preference.active=TRUE
        AND preference.priority='PRIMARY'
        AND (preference.location_id IS NULL OR preference.location_id=v_request.location_id)
        AND (preference.service_category='*'
             OR lower(preference.service_category)=lower(v_request.service_category))
      ORDER BY (preference.location_id IS NOT NULL)::INTEGER DESC,
               (preference.service_category<>'*')::INTEGER DESC,
               preference.updated_at DESC
      LIMIT 1
    ))
  WHERE id=v_task.id;
  UPDATE business_approval_requests
  SET canonical_task_id=v_task.id,committed_at=NOW()
  WHERE id=v_request.id;
  INSERT INTO business_spend_ledger(
    organization_id,location_id,approval_request_id,work_order_id,amount_cents,
    entry_type,source_event_id,created_by
  ) VALUES (
    p_organization_id,v_request.location_id,v_request.id,v_task.id,v_request.amount_cents,
    'COMMITTED','business-work-order:'||v_task.id,p_actor_id
  );
  INSERT INTO business_audit_events(
    organization_id,actor_id,action,object_type,object_id,after_state
  ) VALUES (
    p_organization_id,p_actor_id,'WORK_ORDER_BOUND','TASK',v_task.id,
    jsonb_build_object('approval_request_id',v_request.id,'amount_cents',v_request.amount_cents,
      'location_id',v_request.location_id,'policy_snapshot',v_request.policy_snapshot)
  );
  RETURN QUERY SELECT v_task.id,FALSE;
END $$;

CREATE OR REPLACE FUNCTION set_business_provider_preference(
  p_organization_id UUID,
  p_actor_id UUID,
  p_location_id UUID,
  p_service_category TEXT,
  p_provider_worker_id UUID,
  p_priority TEXT
) RETURNS TABLE(preference_id UUID, preference_priority TEXT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE v_preference business_provider_preferences%ROWTYPE;
BEGIN
  PERFORM business_require_action(p_organization_id,p_actor_id,'MANAGE_ORGANIZATION');
  IF p_priority NOT IN ('PRIMARY','BACKUP') THEN
    RAISE EXCEPTION 'HXBUS35: invalid provider preference priority';
  END IF;
  IF p_location_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM business_locations
    WHERE id=p_location_id AND organization_id=p_organization_id AND status='ACTIVE'
  ) THEN
    RAISE EXCEPTION 'HXBUS22: location is outside this organization';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id=p_provider_worker_id) THEN
    RAISE EXCEPTION 'HXBUS36: provider account was not found';
  END IF;
  IF p_priority='PRIMARY' THEN
    UPDATE business_provider_preferences SET active=FALSE,updated_at=NOW()
    WHERE organization_id=p_organization_id AND active=TRUE AND priority='PRIMARY'
      AND location_id IS NOT DISTINCT FROM p_location_id
      AND lower(service_category)=lower(btrim(p_service_category));
  END IF;
  INSERT INTO business_provider_preferences(
    organization_id,location_id,service_category,provider_worker_id,priority,created_by
  ) VALUES (
    p_organization_id,p_location_id,btrim(p_service_category),p_provider_worker_id,
    p_priority,p_actor_id
  ) ON CONFLICT (
    organization_id,
    (COALESCE(location_id,'00000000-0000-0000-0000-000000000000'::UUID)),
    (lower(service_category)),provider_worker_id
  ) DO UPDATE SET priority=p_priority,active=TRUE,updated_at=NOW()
  RETURNING * INTO v_preference;
  INSERT INTO business_audit_events(
    organization_id,actor_id,action,object_type,object_id,after_state
  ) VALUES (
    p_organization_id,p_actor_id,'PROVIDER_PREFERENCE_SET','PROVIDER_PREFERENCE',v_preference.id,
    jsonb_build_object('location_id',v_preference.location_id,
      'service_category',v_preference.service_category,
      'provider_worker_id',v_preference.provider_worker_id,'priority',v_preference.priority)
  );
  RETURN QUERY SELECT v_preference.id,v_preference.priority;
END $$;

CREATE OR REPLACE FUNCTION set_business_provider_preference_by_email(
  p_organization_id UUID,
  p_actor_id UUID,
  p_location_id UUID,
  p_service_category TEXT,
  p_provider_email TEXT,
  p_priority TEXT
) RETURNS TABLE(preference_id UUID, preference_priority TEXT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE v_provider_id UUID;
BEGIN
  -- Establish authority before resolving account existence to prevent email enumeration.
  PERFORM business_require_action(p_organization_id,p_actor_id,'MANAGE_ORGANIZATION');
  SELECT id INTO v_provider_id FROM users
  WHERE lower(email)=lower(btrim(p_provider_email)) LIMIT 1;
  IF v_provider_id IS NULL THEN
    RAISE EXCEPTION 'HXBUS36: no eligible provider account matched';
  END IF;
  RETURN QUERY SELECT assigned.preference_id,assigned.preference_priority
  FROM set_business_provider_preference(
    p_organization_id,p_actor_id,p_location_id,p_service_category,v_provider_id,p_priority
  ) assigned;
END $$;

CREATE OR REPLACE VIEW business_work_order_reporting AS
SELECT
  task.business_organization_id AS organization_id,
  task.id AS task_id,
  task.business_location_id AS location_id,
  location.name AS location_name,
  task.title,
  task.category,
  task.state AS task_state,
  task.progress_state,
  task.worker_id,
  worker.full_name AS worker_name,
  task.price AS customer_total_cents,
  escrow.state AS escrow_state,
  COALESCE(escrow.refund_amount,CASE WHEN escrow.state='REFUNDED' THEN escrow.amount ELSE 0 END) AS refunded_cents,
  task.deadline,
  task.completed_at,
  CASE WHEN task.completed_at IS NULL OR task.deadline IS NULL THEN NULL
       ELSE task.completed_at<=task.deadline END AS completed_on_time,
  task.created_at
FROM tasks task
JOIN escrows escrow ON escrow.task_id=task.id
LEFT JOIN business_locations location ON location.id=task.business_location_id
LEFT JOIN users worker ON worker.id=task.worker_id
WHERE task.business_organization_id IS NOT NULL;

CREATE OR REPLACE VIEW business_provider_performance_reporting AS
SELECT
  task.business_organization_id AS organization_id,
  task.worker_id,
  worker.full_name AS worker_name,
  task.category,
  COUNT(*) AS assigned_count,
  COUNT(*) FILTER (WHERE task.state='COMPLETED') AS completed_count,
  COUNT(*) FILTER (WHERE task.state='DISPUTED') AS disputed_count,
  COUNT(*) FILTER (
    WHERE task.state='COMPLETED' AND task.deadline IS NOT NULL
      AND task.completed_at<=task.deadline
  ) AS on_time_count,
  COUNT(*) FILTER (WHERE task.state='CANCELLED') AS cancelled_count
FROM tasks task
LEFT JOIN users worker ON worker.id=task.worker_id
WHERE task.business_organization_id IS NOT NULL AND task.worker_id IS NOT NULL
GROUP BY task.business_organization_id,task.worker_id,worker.full_name,task.category;

CREATE OR REPLACE FUNCTION create_business_invoice_snapshot(
  p_organization_id UUID,
  p_actor_id UUID,
  p_period_start TIMESTAMPTZ,
  p_period_end TIMESTAMPTZ,
  p_grouping JSONB,
  p_idempotency_key TEXT
) RETURNS TABLE(invoice_snapshot_id UUID, transaction_count INTEGER, settled_total_cents BIGINT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_snapshot business_invoice_snapshots%ROWTYPE;
  v_count INTEGER;
  v_customer BIGINT;
  v_refunded BIGINT;
  v_settled BIGINT;
BEGIN
  PERFORM business_require_action(p_organization_id,p_actor_id,'MANAGE_BILLING');
  IF p_period_end<=p_period_start OR p_period_end>NOW()+INTERVAL '1 day' THEN
    RAISE EXCEPTION 'HXBUS37: invalid invoice snapshot period';
  END IF;
  SELECT * INTO v_snapshot FROM business_invoice_snapshots
  WHERE organization_id=p_organization_id AND idempotency_key=p_idempotency_key;
  IF v_snapshot.id IS NOT NULL THEN
    IF v_snapshot.period_start<>p_period_start OR v_snapshot.period_end<>p_period_end
       OR v_snapshot.grouping_snapshot<>p_grouping THEN
      RAISE EXCEPTION 'HXBUS4: invoice idempotency key payload conflict';
    END IF;
    RETURN QUERY SELECT v_snapshot.id,v_snapshot.transaction_count,v_snapshot.settled_total_cents;
    RETURN;
  END IF;

  SELECT COUNT(*)::INTEGER,COALESCE(SUM(escrow.amount),0)::BIGINT,
         COALESCE(SUM(CASE
           WHEN escrow.state='REFUNDED' THEN escrow.amount
           WHEN escrow.state='REFUND_PARTIAL' THEN escrow.refund_amount
           ELSE 0 END),0)::BIGINT,
         COALESCE(SUM(CASE
           WHEN escrow.state='RELEASED' THEN escrow.amount
           WHEN escrow.state='REFUND_PARTIAL' THEN escrow.release_amount
           ELSE 0 END),0)::BIGINT
  INTO v_count,v_customer,v_refunded,v_settled
  FROM tasks task JOIN escrows escrow ON escrow.task_id=task.id
  WHERE task.business_organization_id=p_organization_id
    AND task.created_at>=p_period_start AND task.created_at<p_period_end
    AND escrow.state IN ('RELEASED','REFUNDED','REFUND_PARTIAL');

  INSERT INTO business_invoice_snapshots(
    organization_id,period_start,period_end,transaction_count,customer_total_cents,
    refunded_total_cents,settled_total_cents,grouping_snapshot,idempotency_key,created_by
  ) VALUES (
    p_organization_id,p_period_start,p_period_end,v_count,v_customer,v_refunded,
    v_settled,COALESCE(p_grouping,'{}'::JSONB),p_idempotency_key,p_actor_id
  ) RETURNING * INTO v_snapshot;

  INSERT INTO business_invoice_snapshot_lines(
    invoice_snapshot_id,organization_id,task_id,location_id,service_category,
    escrow_state,customer_total_cents,refunded_cents,settled_cents,completed_at
  ) SELECT
    v_snapshot.id,p_organization_id,task.id,task.business_location_id,task.category,
    escrow.state,escrow.amount,
    CASE WHEN escrow.state='REFUNDED' THEN escrow.amount
         WHEN escrow.state='REFUND_PARTIAL' THEN escrow.refund_amount ELSE 0 END,
    CASE WHEN escrow.state='RELEASED' THEN escrow.amount
         WHEN escrow.state='REFUND_PARTIAL' THEN escrow.release_amount ELSE 0 END,
    task.completed_at
  FROM tasks task JOIN escrows escrow ON escrow.task_id=task.id
  WHERE task.business_organization_id=p_organization_id
    AND task.created_at>=p_period_start AND task.created_at<p_period_end
    AND escrow.state IN ('RELEASED','REFUNDED','REFUND_PARTIAL')
  ORDER BY task.created_at,task.id;

  INSERT INTO business_audit_events(
    organization_id,actor_id,action,object_type,object_id,after_state
  ) VALUES (
    p_organization_id,p_actor_id,'INVOICE_SNAPSHOT_CREATED','INVOICE_SNAPSHOT',v_snapshot.id,
    jsonb_build_object('period_start',p_period_start,'period_end',p_period_end,
      'transaction_count',v_count,'customer_total_cents',v_customer,
      'refunded_total_cents',v_refunded,'settled_total_cents',v_settled)
  );
  RETURN QUERY SELECT v_snapshot.id,v_snapshot.transaction_count,v_snapshot.settled_total_cents;
END $$;

REVOKE ALL ON FUNCTION public.bind_business_work_order(UUID,UUID,UUID,UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_business_provider_preference(UUID,UUID,UUID,TEXT,UUID,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_business_provider_preference_by_email(UUID,UUID,UUID,TEXT,TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_business_invoice_snapshot(UUID,UUID,TIMESTAMPTZ,TIMESTAMPTZ,JSONB,TEXT) FROM PUBLIC;

COMMIT;
