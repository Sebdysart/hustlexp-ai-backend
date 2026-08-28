\set ON_ERROR_STOP on

BEGIN;

CREATE TEMP TABLE hx_unit_economics_context(
  task_id UUID NOT NULL,
  worker_id UUID NOT NULL,
  cell_id UUID NOT NULL
) ON COMMIT DROP;

INSERT INTO hx_unit_economics_context(task_id,worker_id,cell_id)
SELECT task.id, worker.id, cell.id
  FROM tasks task
  JOIN zone_category_cells cell
    ON cell.environment='PRODUCTION' AND cell.is_test IS FALSE
   AND cell.category='moving'
  JOIN LATERAL (
    SELECT candidate.id FROM users candidate
     WHERE candidate.id<>task.poster_id
     ORDER BY candidate.created_at NULLS LAST,candidate.id
     LIMIT 1
  ) worker ON TRUE
 WHERE task.state='OPEN' AND task.category='moving'
 ORDER BY task.created_at DESC
 LIMIT 1;

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM hx_unit_economics_context)<>1 THEN
    RAISE EXCEPTION 'unit-economics fixture context is unavailable';
  END IF;
END;
$$;

-- This harness isolates the two target acceptance triggers. All production
-- constraints remain enabled; unrelated task triggers are restored by ROLLBACK.
ALTER TABLE tasks DISABLE TRIGGER USER;

UPDATE zone_category_cells
   SET state='LIMITED',launch_cell_enabled=TRUE,green_category=TRUE,
       metrics_computed_at=NOW(),evaluated_at=NOW(),stable_since=NOW()-INTERVAL '30 days',
       completed_tasks_total=29,paid_tasks_30d=29,fill_rate_30d=0.90,
       active_verified_providers=5,anchor_demand_accounts=2,
       average_contribution_cents=1200,
       minimum_provider_net_hourly_cents=2000,
       provider_earnings_policy_version='hxos-provider-economics-approved-test-v1',
       provider_earnings_policy_state='APPROVED',
       provider_earnings_policy_reference='local-contract-harness-only',
       provider_earnings_sample_size=29,average_provider_net_hourly_cents=3500,
       dispute_rate_30d=0,no_show_rate_30d=0,cancellation_rate_30d=0,
       repeat_demand_rate_30d=0.30,dispatch_allowed=TRUE,
       public_instant_requests_allowed=FALSE,expansion_eligible=FALSE,
       max_concurrent_dispatches=10,updated_at=NOW()
 WHERE environment='PRODUCTION' AND is_test IS FALSE;

INSERT INTO zone_category_cells(
  id,geo_zone,geography_label,category,operating_window,state,policy_version,
  launch_cell_enabled,green_category,environment,is_test,
  metrics_computed_at,evaluated_at,stable_since,state_reasons,
  completed_tasks_total,paid_tasks_30d,fill_rate_30d,
  active_verified_providers,anchor_demand_accounts,average_contribution_cents,
  minimum_provider_net_hourly_cents,provider_earnings_policy_version,
  provider_earnings_policy_state,provider_earnings_policy_reference,
  provider_earnings_sample_size,average_provider_net_hourly_cents,
  dispute_rate_30d,no_show_rate_30d,cancellation_rate_30d,repeat_demand_rate_30d,
  dispatch_allowed,public_instant_requests_allowed,expansion_eligible,max_concurrent_dispatches
)
SELECT gen_random_uuid(),source.geo_zone,'Contract harness','cleaning','always',
       'LIMITED','hxos-launch-cell-v1',TRUE,TRUE,'PRODUCTION',FALSE,
       NOW(),NOW(),NOW()-INTERVAL '30 days','["contract_harness"]'::jsonb,
       29,29,0.90,5,2,1200,2000,'hxos-provider-economics-approved-test-v1',
       'APPROVED','local-contract-harness-only',29,3500,0,0,0,0.30,
       TRUE,FALSE,FALSE,10
  FROM zone_category_cells source
 WHERE source.id=(SELECT cell_id FROM hx_unit_economics_context);

UPDATE tasks task
   SET state='OPEN',worker_id=NULL,automation_classification='PRODUCTION',
       geo_zone=cell.geo_zone,liquidity_cell_id=cell.id,
       price=10000,hustler_payout_cents=7500,platform_margin_cents=2500,
       estimated_duration_minutes=60,
       scope_hash=repeat('a',64),cancellation_policy_version='task-template-v2:standard_physical:0',
       updated_at=NOW()
  FROM hx_unit_economics_context context
  JOIN zone_category_cells cell ON cell.id=context.cell_id
 WHERE task.id=context.task_id;

-- Offer economics are downstream of identity eligibility. Establish a
-- provider-attested production identity so this harness isolates economics
-- without bypassing the environment-matched identity boundary.
INSERT INTO identity_verification_consents(
  id,user_id,provider,provider_environment,is_test,policy_version,
  disclosure_hash,purpose,idempotency_key
)
SELECT '86100000-0000-4000-8000-000000000001',worker_id,
       'unit_economics_identity_provider','PRODUCTION',FALSE,
       'hxos-unit-economics-identity-v1',repeat('4',64),
       'Production identity evidence for the rollback-only unit economics database contract harness.',
       'unit-economics-identity-consent-v1'
  FROM hx_unit_economics_context;

CREATE TEMP TABLE hx_unit_economics_identity_case AS
SELECT * FROM begin_identity_verification_case_v1(
  (SELECT worker_id FROM hx_unit_economics_context),
  '86100000-0000-4000-8000-000000000001',
  'unit_economics_identity_provider','unit_economics_identity_case_0001',
  'PRODUCTION',FALSE,'hxos-unit-economics-identity-v1',repeat('5',64),
  NOW()+INTERVAL '90 days'
);

SELECT * FROM record_identity_verification_event_v1(
  (SELECT worker_id FROM hx_unit_economics_context),
  (SELECT case_id FROM hx_unit_economics_identity_case),
  'unit-economics-identity-verified-0001','VERIFIED',
  repeat('6',64),repeat('7',64),NOW(),NOW()+INTERVAL '90 days',
  (SELECT worker_id FROM hx_unit_economics_context)
);

ALTER TABLE tasks ENABLE TRIGGER task_liquidity_cell_accept_gate;
ALTER TABLE tasks ENABLE TRIGGER task_worker_offer_accept_gate;

DO $$
DECLARE
  v_context hx_unit_economics_context%ROWTYPE;
BEGIN
  SELECT * INTO v_context FROM hx_unit_economics_context;
  BEGIN
    INSERT INTO worker_offer_decisions(
      task_id,worker_id,policy_version,payload_hash,decision_ready,blocking_reasons,
      customer_total_cents,payout_cents,insurance_adjustment_cents,net_payout_cents,
      estimated_net_hourly_cents,minimum_net_hourly_cents,
      provider_earnings_policy_version,provider_earnings_floor_met,
      distance_miles,estimated_travel_time_minutes,travel_time_policy_version,
      estimated_duration_minutes,scope_hash,cancellation_policy_version,
      rank_score,rank_reasons,snapshot,expires_at
    ) VALUES (
      v_context.task_id,v_context.worker_id,'hxos-worker-offer-v3',repeat('1',64),
      TRUE,'[]'::jsonb,10000,7500,200,7300,5840,2000,
      'hxos-provider-economics-approved-test-v1',TRUE,5,NULL,NULL,60,repeat('a',64),
      'task-template-v2:standard_physical:0',0.8,'["distance"]'::jsonb,'{}'::jsonb,
      NOW()+INTERVAL '30 minutes'
    );
    RAISE EXCEPTION 'accept-ready offer without travel unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%worker_offer_decisions_provider_economics_ready%' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    INSERT INTO worker_offer_decisions(
      task_id,worker_id,policy_version,payload_hash,decision_ready,blocking_reasons,
      customer_total_cents,payout_cents,insurance_adjustment_cents,net_payout_cents,
      estimated_net_hourly_cents,minimum_net_hourly_cents,
      provider_earnings_policy_version,provider_earnings_floor_met,
      distance_miles,estimated_travel_time_minutes,travel_time_policy_version,
      estimated_duration_minutes,scope_hash,cancellation_policy_version,
      rank_score,rank_reasons,snapshot,expires_at
    ) VALUES (
      v_context.task_id,v_context.worker_id,'hxos-worker-offer-v3',repeat('2',64),
      TRUE,'[]'::jsonb,10000,7500,200,7300,1999,2000,
      'hxos-provider-economics-approved-test-v1',FALSE,5,15,
      'hxos-conservative-travel-v1',60,repeat('a',64),
      'task-template-v2:standard_physical:0',0.8,'["distance"]'::jsonb,'{}'::jsonb,
      NOW()+INTERVAL '30 minutes'
    );
    RAISE EXCEPTION 'below-floor accept-ready offer unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%worker_offer_decisions_provider_economics_ready%' THEN
      RAISE;
    END IF;
  END;
END;
$$;

-- Unapproved production policy is rejected before dispatch state is considered.
UPDATE zone_category_cells cell
   SET state='THROTTLED',dispatch_allowed=FALSE,max_concurrent_dispatches=0,
       minimum_provider_net_hourly_cents=NULL,provider_earnings_policy_version=NULL,
       provider_earnings_policy_state=NULL,provider_earnings_policy_reference=NULL
  FROM hx_unit_economics_context context WHERE cell.id=context.cell_id;

DO $$
DECLARE v_context hx_unit_economics_context%ROWTYPE;
BEGIN
  SELECT * INTO v_context FROM hx_unit_economics_context;
  BEGIN
    UPDATE tasks SET state='ACCEPTED',worker_id=v_context.worker_id WHERE id=v_context.task_id;
    RAISE EXCEPTION 'unapproved production earnings policy unexpectedly accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE '%HXLC8:%' THEN RAISE; END IF;
  END;
END;
$$;

-- A mature cell cannot dispatch with an incomplete 30-task earnings sample.
UPDATE zone_category_cells cell
   SET minimum_provider_net_hourly_cents=2000,
       provider_earnings_policy_version='hxos-provider-economics-approved-test-v1',
       provider_earnings_policy_state='APPROVED',
       provider_earnings_policy_reference='local-contract-harness-only',
       paid_tasks_30d=30,provider_earnings_sample_size=29,
       average_provider_net_hourly_cents=3500
  FROM hx_unit_economics_context context WHERE cell.id=context.cell_id;

DO $$
DECLARE v_context hx_unit_economics_context%ROWTYPE;
BEGIN
  SELECT * INTO v_context FROM hx_unit_economics_context;
  BEGIN
    UPDATE tasks SET state='ACCEPTED',worker_id=v_context.worker_id WHERE id=v_context.task_id;
    RAISE EXCEPTION 'incomplete mature earnings sample unexpectedly accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE '%HXLC9:%' THEN RAISE; END IF;
  END;
END;
$$;

-- Healthy policy plus one exact v3 offer is accepted.
UPDATE zone_category_cells cell
   SET state='LIMITED',dispatch_allowed=TRUE,max_concurrent_dispatches=10,
       paid_tasks_30d=29,provider_earnings_sample_size=29,
       average_provider_net_hourly_cents=3500,
       metrics_computed_at=NOW(),evaluated_at=NOW()
  FROM hx_unit_economics_context context WHERE cell.id=context.cell_id;

INSERT INTO worker_offer_decisions(
  task_id,worker_id,policy_version,payload_hash,decision_ready,blocking_reasons,
  customer_total_cents,payout_cents,insurance_adjustment_cents,net_payout_cents,
  estimated_net_hourly_cents,minimum_net_hourly_cents,
  provider_earnings_policy_version,provider_earnings_floor_met,
  distance_miles,estimated_travel_time_minutes,travel_time_policy_version,
  estimated_duration_minutes,scope_hash,cancellation_policy_version,
  rank_score,rank_reasons,snapshot,expires_at
)
SELECT task_id,worker_id,'hxos-worker-offer-v3',repeat('3',64),TRUE,'[]'::jsonb,
       10000,7500,200,7300,5840,2000,'hxos-provider-economics-approved-test-v1',TRUE,
       5,15,'hxos-conservative-travel-v1',60,repeat('a',64),
       'task-template-v2:standard_physical:0',0.8,'["distance"]'::jsonb,'{}'::jsonb,
       NOW()+INTERVAL '30 minutes'
  FROM hx_unit_economics_context;

UPDATE tasks task
   SET state='ACCEPTED',worker_id=context.worker_id
  FROM hx_unit_economics_context context
 WHERE task.id=context.task_id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM tasks task JOIN hx_unit_economics_context context ON context.task_id=task.id
     WHERE task.state='ACCEPTED' AND task.worker_id=context.worker_id
  ) THEN
    RAISE EXCEPTION 'valid provider-economics acceptance did not commit';
  END IF;
END;
$$;

ROLLBACK;

SELECT 'UNIT_ECONOMICS_GUARDRAILS_DATABASE_CONTRACT_OK' AS result;
