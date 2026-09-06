export const CHANGE_ORDER_MATERIALIZATION_BUILDER =
  'public.hxos_build_change_order_materialization_actor_request_v13(text,jsonb)';
export const CHANGE_ORDER_KIND_COMMAND =
  'public.hxos_read_authenticated_change_order_kind_v13(text,jsonb)';
export const CHANGE_ORDER_PREPARE_COMMAND =
  'public.hxos_prepare_authenticated_change_order_v13(text,jsonb)';
export const CHANGE_ORDER_FINALIZE_COMMAND =
  'public.hxos_finalize_authenticated_change_order_v13(text,jsonb)';
export const CHANGE_ORDER_MATERIALIZATION_PUBLIC_FUNCTIONS = [
  CHANGE_ORDER_MATERIALIZATION_BUILDER,
  CHANGE_ORDER_KIND_COMMAND,
  CHANGE_ORDER_PREPARE_COMMAND,
  CHANGE_ORDER_FINALIZE_COMMAND,
] as const;
export const CHANGE_ORDER_MATERIALIZATION_WITNESS_HASH =
  'public.universal_v1_change_order_materialization_request_sha256(uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer,integer,integer,integer,integer,uuid,uuid,uuid)';
export const CHANGE_ORDER_MATERIALIZATION_HASH_FUNCTIONS = [
  'public.universal_v1_change_amendment_request_sha256(uuid,integer,uuid,uuid,uuid,uuid,integer,uuid,text)',
  CHANGE_ORDER_MATERIALIZATION_WITNESS_HASH,
] as const;
export const CHANGE_ORDER_MATERIALIZATION_DEFERRED_GUARDS = [
  'public.enforce_universal_active_scope_transition()',
  'public.enforce_universal_v1_amendment_execution_fact()',
] as const;
export const CHANGE_ORDER_MATERIALIZATION_FUNCTIONS = [
  ...CHANGE_ORDER_MATERIALIZATION_PUBLIC_FUNCTIONS,
  ...CHANGE_ORDER_MATERIALIZATION_HASH_FUNCTIONS,
  ...CHANGE_ORDER_MATERIALIZATION_DEFERRED_GUARDS,
] as const;
export const CHANGE_ORDER_MATERIALIZATION_ADDITIONAL_RELATIONS = [
  'public.task_public_questions',
  'public.task_clarification_revisions',
  'public.region_policies',
] as const;
export const CHANGE_ORDER_MATERIALIZATION_READ_COLUMNS: Readonly<
  Record<string, readonly string[]>
> = {
  'public.task_work_order_amendments': ['supersedes_amendment_id', 'materialized_at'],
  // Existing task projection guards inspect READY clarification state and lock the exact region policy.
  'public.task_public_questions': ['task_id', 'status'],
  'public.task_clarification_revisions': ['task_id', 'status'],
  'public.region_policies': [
    'id',
    'region_code',
    'version',
    'policy_state',
    'production_enabled',
    'approval_state',
    'approval_reference',
    'effective_from',
    'effective_until',
    'policy_document',
    'policy_hash',
    'created_at',
  ],
};
export const CHANGE_ORDER_MATERIALIZATION_INSERT_COLUMNS: Readonly<
  Record<string, readonly string[]>
> = {
  'public.task_scope_versions': [
    'task_id',
    'version',
    'scope_hash',
    'title',
    'description',
    'requirements',
    'checklist',
    'customer_total_cents',
    'hustler_payout_cents',
    'source',
    'change_summary',
    'created_by',
    'supersedes_version_id',
    'universal_contract_version',
    'currency',
  ],
  'public.universal_v1_change_order_materialization_commands': [
    'proposal_id',
    'idempotency_key',
    'request_sha256',
    'actor_user_id',
    'work_order_id',
    'task_id',
    'task_draft_id',
    'eligibility_decision_id',
    'base_scope_version_id',
    'replacement_scope_version_id',
    'expected_proposal_version',
    'expected_scope_version',
    'expected_amendment_version',
    'expected_execution_version',
    'expected_financial_version',
    'predecessor_event_id',
    'predecessor_operation_id',
    'adjustment_operation_id',
    'customer_total_cents',
    'provider_payout_cents',
    'currency',
    'occurred_at',
  ],
  'public.task_work_order_amendments': [
    'work_order_id',
    'amendment_version',
    'supersedes_amendment_id',
    'change_order_id',
    'scope_version_id',
    'adjustment_event_id',
    'expected_financial_version',
    'idempotency_key',
    'request_sha256',
    'materialized_by',
  ],
};
export const CHANGE_ORDER_MATERIALIZATION_UPDATE_COLUMNS: Readonly<
  Record<string, readonly string[]>
> = {
  'public.region_policies': ['id'],
  'public.task_scope_change_proposals': ['approved_version_id'],
  'public.tasks': [
    'title',
    'description',
    'requirements',
    'price',
    'hustler_payout_cents',
    'platform_margin_cents',
    'scope_hash',
    'active_scope_version_id',
  ],
  // Lock-only authority; immutable UPDATE/DELETE guards continue to reject writes.
  'public.task_scope_change_approvals': ['id'],
  'public.task_work_order_amendments': ['id'],
  'public.task_work_order_execution_facts': ['id'],
};
