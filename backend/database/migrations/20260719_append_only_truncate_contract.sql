-- Row-level UPDATE/DELETE triggers do not fire for TRUNCATE. Close that owner-
-- level bypass for every durable ledger, decision snapshot, and audit/event rail.

CREATE OR REPLACE FUNCTION prevent_append_only_truncate()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HXAO1: % is an append-only evidence table and cannot be truncated', TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END;
$$;

CREATE OR REPLACE FUNCTION prevent_xp_ledger_truncate()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'XP ledger is append-only and cannot be truncated' USING ERRCODE = 'HX102';
END;
$$;

CREATE OR REPLACE FUNCTION prevent_badges_truncate()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Badges are append-only and cannot be truncated' USING ERRCODE = 'HX401';
END;
$$;

DROP TRIGGER IF EXISTS xp_ledger_no_truncate ON xp_ledger;
CREATE TRIGGER xp_ledger_no_truncate
BEFORE TRUNCATE ON xp_ledger
FOR EACH STATEMENT EXECUTE FUNCTION prevent_xp_ledger_truncate();

DROP TRIGGER IF EXISTS badges_no_truncate ON badges;
CREATE TRIGGER badges_no_truncate
BEFORE TRUNCATE ON badges
FOR EACH STATEMENT EXECUTE FUNCTION prevent_badges_truncate();

CREATE OR REPLACE FUNCTION prevent_append_only_row_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HXAO2: % is append-only; insert a compensating event instead', TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END;
$$;

DO $$
DECLARE
  v_table TEXT;
BEGIN
  -- These rails were described and consumed as immutable but previously had
  -- no row-level protection at all.
  FOREACH v_table IN ARRAY ARRAY[
    'trust_ledger',
    'task_location_access_log',
    'task_completion_delivery_events',
    'task_unattended_completion_requests',
    'task_reservation_requests',
    'engine_automation_events',
    'ai_agent_decisions',
    'escrow_events'
  ] LOOP
    IF to_regclass('public.' || v_table) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS append_only_no_mutation ON %I', v_table);
      EXECUTE format(
        'CREATE TRIGGER append_only_no_mutation BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION prevent_append_only_row_mutation()',
        v_table
      );
    END IF;
  END LOOP;

  -- All of these tables already have row-level lifecycle/immutability guards;
  -- add the missing statement-level TRUNCATE protection without changing their
  -- existing error contracts.
  FOREACH v_table IN ARRAY ARRAY[
    'trust_ledger',
    'admin_actions',
    'revenue_ledger',
    'payment_disputes',
    'task_location_access_log',
    'task_completion_delivery_events',
    'task_unattended_completion_requests',
    'task_reservation_requests',
    'engine_automation_events',
    'task_safety_location_access_log',
    'task_safety_incident_events',
    'task_safety_checkin_events',
    'recommendations',
    'recommendation_events',
    'recommendation_outcomes',
    'worker_offer_decisions',
    'worker_offer_events',
    'worker_decision_appeal_events',
    'worker_screening_events',
    'worker_screening_notices',
    'business_approval_decisions',
    'business_spend_ledger',
    'business_service_activation_events',
    'business_audit_events',
    'business_invoice_snapshots',
    'business_invoice_snapshot_lines',
    'zone_category_cell_events',
    'recurring_task_template_revisions',
    'recurring_template_pause_events',
    'recurring_template_recovery_events',
    'recurring_schedule_exceptions',
    'region_policies',
    'region_policy_events',
    'task_external_bridge_events',
    'task_direct_invite_claims',
    'worker_cash_out_events',
    'worker_cash_out_requests',
    'ai_agent_decisions',
    'escrow_events'
  ] LOOP
    IF to_regclass('public.' || v_table) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS append_only_no_truncate ON %I', v_table);
      EXECUTE format(
        'CREATE TRIGGER append_only_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_truncate()',
        v_table
      );
    END IF;
  END LOOP;
END;
$$;
