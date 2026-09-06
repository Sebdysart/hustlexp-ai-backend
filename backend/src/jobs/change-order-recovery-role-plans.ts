export const CHANGE_ORDER_RECOVERY_CLAIM_FUNCTION =
  'public.hxos_claim_fake_financial_change_order_recovery_v13(uuid,text,text,text,uuid,integer,integer,integer)';

// Claiming a lease is observation authority only. Runtime logins receive only
// EXECUTE on the sealed port; these exact columns belong to its finance owner.
export const CHANGE_ORDER_RECOVERY_CLAIM_INSERT_COLUMNS: Readonly<
  Record<string, readonly string[]>
> = {
  'public.universal_v1_change_order_recovery_leases': [
    'proposal_id',
    'lease_owner_id',
    'lease_duration_seconds',
    'expires_at',
  ],
};
export const CHANGE_ORDER_RECOVERY_CLAIM_LOCK_COLUMNS: Readonly<Record<string, readonly string[]>> =
  {
    'public.universal_v1_change_order_materialization_commands': ['proposal_id'],
  };

export const CHANGE_ORDER_RECOVERY_OBSERVATION_FUNCTION =
  'public.hxos_observe_fake_financial_change_order_recovery_v13(uuid,text,text,text,uuid,uuid,uuid,text,uuid)';
export const CHANGE_ORDER_RECOVERY_OBSERVATION_DEPENDENCIES = [
  // PostgreSQL stores the legacy migration's longer identifier at NAMEDATALEN-1.
  'public.universal_v1_change_order_recovery_revocation_reason_pre_expiry(uuid)',
  'public.universal_v1_effective_work_order_scope_id(uuid)',
  'public.business_membership_has_action(uuid,uuid,text)',
  'public.universal_v1_invited_provider_authority_is_current(uuid,uuid,text,uuid,text,text)',
] as const;
// Exact additional reads needed by the retained revocation classifier and projection.
// Named columns complete the frozen witness SELECT *, without exposing raw runtime reads.
export const CHANGE_ORDER_RECOVERY_OBSERVATION_READ_COLUMNS: Readonly<
  Record<string, readonly string[]>
> = {
  'public.universal_v1_change_order_materialization_commands': [
    'expected_proposal_version',
    'expected_scope_version',
    'expected_amendment_version',
    'expected_execution_version',
    'predecessor_operation_id',
    'provider_payout_cents',
    'occurred_at',
  ],
  'public.universal_v1_change_order_compensation_commands': [
    'compensation_command_id',
    'created_at',
    'semantic_limitation',
  ],
  'public.task_scope_change_proposals': [
    'application_contract_version',
    'proposal_version',
    'reviewed_by',
    'proposed_provider_payout_cents',
    'proposed_scope_sha256',
  ],
  'public.task_scope_versions': ['version', 'supersedes_version_id', 'source', 'scope_hash'],
  'public.task_work_order_amendments': ['id', 'change_order_id'],
  'public.tasks': [
    'work_order_id',
    'active_scope_version_id',
    'universal_payment_posture',
    'business_organization_id',
    'poster_id',
    'category',
    'region_code',
  ],
  'public.task_work_orders': ['provider_user_id', 'provider_organization_id'],
  'public.task_scope_change_approvals': ['actor_id'],
  'public.task_provider_eligibility_decisions': [
    'provider_user_id',
    'provider_organization_id',
    'provider_class',
    'trade_credential_id',
  ],
  'public.task_work_order_execution_facts': ['scope_version_id'],
  'public.task_reconciliation_facts': ['work_order_id'],
  'public.users': ['id', 'account_status', 'is_minor', 'is_banned'],
  'public.business_organizations': [
    'id',
    'status',
    'client_enabled',
    'provider_enabled',
    'provider_class',
    'verification_status',
  ],
  'public.business_memberships': ['organization_id', 'user_id', 'status', 'role'],
  'public.capability_profiles': ['user_id', 'provider_class'],
  'public.current_verified_trade_qualifications': [
    'business_credential_id',
    'provider_user_id',
    'organization_id',
    'jurisdiction_code',
    'permitted_work_categories',
  ],
};
