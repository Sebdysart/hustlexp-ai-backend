export const WORKER_CHANGE_ORDER_ADJUSTMENT_PREPARATION =
  'public.hxos_prepare_worker_change_order_adjustment_v13(uuid,text,text,text,uuid,uuid,uuid,text,uuid,text)';
export const WORKER_CHANGE_ORDER_ADJUSTMENT_INTERNAL_FUNCTIONS = [
  'hx_authority.assert_worker_change_order_adjustment_v13(uuid,text,text,text,uuid,uuid,uuid,text,uuid,boolean)',
  'hx_authority.assert_worker_change_order_adjustment_request_v13(uuid,uuid,text)',
  'hx_authority.require_worker_change_order_adjustment_request_v13()',
] as const;
export const WORKER_CHANGE_ORDER_ADJUSTMENT_PREPARATIONS =
  'hx_authority.fake_financial_change_order_adjustment_preparations_v13';
export const WORKER_CHANGE_ORDER_ADJUSTMENT_DEPENDENCIES = [
  'public.universal_v1_change_scope_sha256(text,text,text,jsonb,integer,integer,character)',
  'public.universal_v1_work_order_operation_id_v1(text,text)',
] as const;
export const WORKER_CHANGE_ORDER_ADJUSTMENT_READ_COLUMNS: Readonly<
  Record<string, readonly string[]>
> = {
  'public.task_scope_versions': [
    'title',
    'description',
    'requirements',
    'checklist',
    'created_by',
    'change_summary',
  ],
  'public.task_scope_change_proposals': [
    'observed_scope_summary',
    'proposed_title',
    'proposed_description',
    'proposed_requirements',
    'proposed_checklist',
  ],
  'public.users': ['trust_hold', 'trust_hold_until'],
  'public.task_provider_eligibility_decisions': ['task_eligible'],
  'public.task_scope_change_approvals': ['expected_proposal_version'],
};
export const WORKER_CHANGE_ORDER_ADJUSTMENT_LOCK_COLUMNS: Readonly<
  Record<string, readonly string[]>
> = {
  'public.universal_v1_change_order_recovery_leases': ['recovery_lease_id'],
};
