export const CHANGE_ORDER_COMMAND_BUILDER =
  'public.hxos_build_change_order_actor_request_v13(text,jsonb)';
export const CHANGE_ORDER_PROPOSE_COMMAND =
  'public.hxos_propose_authenticated_change_order_v13(text,jsonb)';
export const CHANGE_ORDER_DECIDE_COMMAND =
  'public.hxos_decide_authenticated_change_order_v13(text,jsonb)';
export const CHANGE_ORDER_CONTEXT_FUNCTION =
  'hx_authority.lock_change_order_write_context_v13(text,uuid,uuid)';
export const CHANGE_ORDER_PUBLIC_COMMAND_FUNCTIONS = [
  CHANGE_ORDER_COMMAND_BUILDER,
  CHANGE_ORDER_PROPOSE_COMMAND,
  CHANGE_ORDER_DECIDE_COMMAND,
] as const;
export const CHANGE_ORDER_HASH_FUNCTIONS = [
  'public.universal_v1_change_scope_sha256(text,text,text,jsonb,integer,integer,character)',
  'public.universal_v1_change_proposal_request_sha256(uuid,uuid,uuid,text,integer,uuid,text,text,character,text)',
  'public.universal_v1_change_decision_request_sha256(uuid,integer,text,text,uuid,text,text)',
] as const;
export const CHANGE_ORDER_COMMAND_FUNCTIONS = [
  ...CHANGE_ORDER_PUBLIC_COMMAND_FUNCTIONS,
  CHANGE_ORDER_CONTEXT_FUNCTION,
  ...CHANGE_ORDER_HASH_FUNCTIONS,
] as const;
export const CHANGE_ORDER_COMMAND_READ_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  'public.task_scope_change_approvals': [
    'id',
    'expected_proposal_version',
    'reason',
    'idempotency_key',
    'request_sha256',
  ],
};
export const CHANGE_ORDER_COMMAND_INSERT_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  'public.task_scope_change_proposals': [
    'task_id',
    'base_version_id',
    'proposed_by',
    'proposer_role',
    'observed_scope_summary',
    'proposed_checklist',
    'status',
    'universal_contract_version',
    'application_contract_version',
    'proposal_version',
    'supersedes_proposal_id',
    'change_order_kind',
    'proposed_customer_total_cents',
    'proposed_provider_payout_cents',
    'proposed_title',
    'proposed_description',
    'proposed_requirements',
    'proposed_scope_sha256',
    'schedule_effect',
    'financial_adjustment_required',
    'idempotency_key',
    'request_sha256',
  ],
  'public.task_scope_change_approvals': [
    'proposal_id',
    'approver_role',
    'decision',
    'actor_id',
    'expected_proposal_version',
    'reason',
    'idempotency_key',
    'request_sha256',
  ],
};
export const CHANGE_ORDER_COMMAND_UPDATE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  'public.task_scope_change_proposals': [
    'status',
    'reviewed_by',
    'reviewed_at',
    'decision_reason',
    'updated_at',
  ],
};
