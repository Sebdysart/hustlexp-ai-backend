/** Exact privileges for actor-attested preparation; no runtime login owns raw facts. */
export const FAKE_FINANCIAL_PREPARATION_COMMAND =
  'public.hxos_prepare_authenticated_fake_financial_command_v13(text,jsonb)';
export const FAKE_FINANCIAL_PREPARATION_BUILDER =
  'public.hxos_build_fake_financial_preparation_actor_request_v13(text,jsonb)';
export const FAKE_FINANCIAL_PREPARATION_VALIDATOR =
  'hx_authority.validate_fake_financial_preparation_payload_v13(jsonb)';
export const FAKE_FINANCIAL_PREPARATION_INSERT =
  'public.hxos_prepare_universal_v1_financial_command_v1(uuid,text,uuid,text,text,bigint,bigint,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,bigint,text,uuid)';
export const FAKE_FINANCIAL_PREPARATION_FUNCTIONS = [
  FAKE_FINANCIAL_PREPARATION_COMMAND,
  FAKE_FINANCIAL_PREPARATION_BUILDER,
  FAKE_FINANCIAL_PREPARATION_VALIDATOR,
  FAKE_FINANCIAL_PREPARATION_INSERT,
] as const;
export const FAKE_FINANCIAL_PREPARATION_DEPENDENCY_FUNCTIONS = [
  'public.universal_v1_effective_work_order_scope_id(uuid)',
  'public.universal_v1_pre_work_order_void_is_authorized(uuid,text,text,bigint,bigint,uuid,uuid,uuid,uuid,uuid,uuid,bigint,text,uuid)',
  'public.universal_v1_fake_terminal_plan_v1(text)',
  'public.business_membership_has_action(uuid,uuid,text)',
] as const;
export const FAKE_FINANCIAL_PREPARATION_PROVENANCE =
  'hx_authority.fake_financial_preparation_authority_v13';
export const FAKE_FINANCIAL_PREPARATION_PROVENANCE_READ_COLUMNS = [
  'prepared_command_id',
  'actor_user_id',
  'target_authority_id',
  'release_manifest_sha256',
] as const;
export const FAKE_FINANCIAL_PREPARATION_ADDITIONAL_RELATIONS = [
  'public.universal_v1_change_order_recovery_terminal_facts',
  'public.task_reconciliation_facts',
] as const;
export const FAKE_FINANCIAL_PREPARATION_READ_COLUMNS: Readonly<Record<string, readonly string[]>> =
  {
    'public.task_financial_operations': [
      'operation_id',
      'task_draft_id',
      'task_id',
      'eligibility_decision_id',
      'scope_version_id',
      'change_order_id',
      'event_kind',
      'provider_kind',
      'amount_cents',
      'currency',
      'completion_fact_id',
    ],
    'public.task_scope_change_proposals': ['*'],
    'public.task_scope_change_approvals': ['proposal_id', 'approver_role', 'decision', 'actor_id'],
    'public.task_work_order_amendments': [
      'id',
      'adjustment_event_id',
      'expected_financial_version',
      'idempotency_key',
      'request_sha256',
      'materialized_by',
      'change_order_id',
      'scope_version_id',
      'work_order_id',
      'amendment_version',
    ],
    'public.task_completion_facts': ['*'],
    'public.universal_v1_change_order_materialization_commands': ['*'],
    'public.universal_v1_change_order_compensation_commands': [
      'compensation_command_id',
      'created_at',
      'semantic_limitation',
      'adjustment_event_id',
      'adjustment_operation_id',
      'amount_cents',
      'base_scope_version_id',
      'currency',
      'eligibility_decision_id',
      'lifecycle_expected_version',
      'proposal_id',
      'requested_by',
      'reversal_idempotency_key',
      'reversal_operation_id',
      'task_draft_id',
      'task_id',
      'witness_request_sha256',
      'work_order_id',
    ],
    'public.universal_v1_change_order_recovery_terminal_facts': [
      'terminal_fact_id',
      'witness_request_sha256',
      'amendment_id',
      'adjustment_event_id',
      'compensation_command_id',
      'compensation_event_id',
      'resolution_evidence_kind',
      'prior_secured_state_restored',
      'execution_resume_authorized',
      'capture_resume_authorized',
      'payment_creation_performed',
      'hard_assignment_created',
      'proposal_id',
      'outcome_state',
      'recovery_state',
    ],
    'public.task_reconciliation_facts': ['work_order_id'],
    'public.hxos_fake_financial_operation_events_v1': ['*'],
  };
export const FAKE_FINANCIAL_PREPARATION_LOCK_COLUMNS: Readonly<Record<string, readonly string[]>> =
  {
    'public.task_scope_change_proposals': ['id'],
    'public.task_completion_facts': ['id'],
    'public.hxos_fake_financial_operation_events_v1': ['event_id'],
  };
