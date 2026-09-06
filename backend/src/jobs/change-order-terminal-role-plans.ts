export const CHANGE_ORDER_TERMINAL_FUNCTIONS = [
  'public.hxos_record_fake_financial_change_order_materialized_v13(uuid,text,text,text,uuid,uuid,uuid,text,uuid,uuid,uuid)',
  'public.hxos_record_fake_financial_change_order_compensated_v13(uuid,text,text,text,uuid,uuid,uuid,text,uuid,uuid,uuid)',
  'public.hxos_record_fake_financial_change_order_no_effect_v13(uuid,text,text,text,uuid,uuid,uuid,text,uuid,uuid,text)',
] as const;
export const CHANGE_ORDER_TERMINAL_INTERNAL_FUNCTION =
  'hx_authority.record_fake_financial_change_order_terminal_v13(uuid,text,text,text,uuid,uuid,uuid,text,uuid,text,uuid,uuid,uuid,uuid,uuid,text)';

export const CHANGE_ORDER_TERMINAL_DEPENDENCIES = [
  'public.universal_v1_change_amendment_request_sha256(uuid,integer,uuid,uuid,uuid,uuid,integer,uuid,text)',
  'public.universal_v1_execution_internal_request_sha256(uuid,uuid,text,text,integer,uuid,uuid,uuid,text,timestamptz,text)',
] as const;

// Only the NOLOGIN finance owner receives these named grants. Runtime workers
// receive the three sealed commands; the legacy writers remain closed.
export const CHANGE_ORDER_TERMINAL_INSERT_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  'public.universal_v1_change_order_recovery_terminal_facts': [
    'proposal_id',
    'witness_request_sha256',
    'recovery_lease_id',
    'lease_owner_id',
    'outcome_state',
    'recovery_state',
    'amendment_id',
    'adjustment_event_id',
    'compensation_command_id',
    'compensation_event_id',
    'no_effect_outcome_fact_id',
    'authority_revocation_reason',
    'hold_clearance_kind',
    'execution_resume_authorized',
    'recorded_by',
  ],
};
export const CHANGE_ORDER_TERMINAL_LOCK_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  'public.universal_v1_change_order_compensation_commands': ['compensation_command_id'],
  'public.universal_v1_change_order_recovery_leases': ['recovery_lease_id'],
  'public.task_work_order_amendments': ['id'],
};
export const CHANGE_ORDER_TERMINAL_READ_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  'public.universal_v1_change_order_recovery_terminal_facts': [
    'terminal_fact_id',
    'witness_request_sha256',
    'recovery_lease_id',
    'lease_owner_id',
    'amendment_id',
    'adjustment_event_id',
    'compensation_command_id',
    'compensation_event_id',
    'no_effect_outcome_fact_id',
    'authority_revocation_reason',
    'resolution_evidence_kind',
    'hold_clearance_kind',
    'prior_secured_state_restored',
    'execution_resume_authorized',
    'capture_resume_authorized',
    'payment_creation_performed',
    'hard_assignment_created',
    'recorded_by',
    'recorded_at',
    'terminal_fact_sha256',
  ],
  'public.task_work_order_amendments': [
    'supersedes_amendment_id',
    'idempotency_key',
    'materialized_by',
    'materialized_at',
    'request_sha256',
    'expected_financial_version',
  ],
  'public.task_work_order_execution_facts': [
    'id',
    'work_order_id',
    'task_id',
    'scope_version_id',
    'execution_version',
    'supersedes_fact_id',
    'state',
    'transition_kind',
    'completion_fact_id',
    'work_order_amendment_id',
    'actor_role',
    'actor_user_id',
    'reason',
    'idempotency_key',
    'request_sha256',
    'client_occurred_at',
    'policy_version',
  ],
};
