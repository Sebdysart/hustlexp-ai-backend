import { CHANGE_ORDER_RECOVERY_CLAIM_FUNCTION, CHANGE_ORDER_RECOVERY_OBSERVATION_FUNCTION } from './change-order-recovery-role-plans.js';
/** Exact additive v13 surface for the existing eight-role authority model. */
export const FAKE_FINANCIAL_RUNTIME_AUTHORITY_FUNCTION =
  'public.hxos_read_universal_v1_fake_financial_runtime_authority_v13()';

export const FAKE_FINANCIAL_BOOTSTRAP_METADATA_FUNCTIONS = [
  'public.hxos_read_fake_financial_schema_evidence_v13()',
  'public.hxos_read_fake_financial_applied_migrations_v13()',
  'public.hxos_read_fake_financial_bootstrap_completion_v13(text,text)',
] as const;

export const FAKE_FINANCIAL_BOOTSTRAP_METADATA_RELATIONS = [
  'public.hxos_fake_financial_schema_evidence_v1',
  'public.hxos_fake_financial_schema_evidence_v2',
  'public.hxos_fake_financial_schema_evidence_v3',
  'public.hxos_fake_financial_schema_evidence_v4',
  'public.hxos_fake_financial_schema_evidence_v5',
  'public.hxos_fake_financial_schema_evidence_v6',
  'public.hxos_fake_financial_schema_evidence_v7',
  'public.hxos_fake_financial_schema_evidence_v8',
  'public.hxos_fake_financial_schema_evidence_v9',
  'public.hxos_fake_financial_schema_evidence_v10',
  'public.hxos_fake_financial_schema_evidence_v11',
  'public.hxos_nonproduction_bootstrap_completion_v1',
] as const;

/** Exact columns consumed by the fixed metadata ports; no runtime table grant. */
export function fakeFinancialBootstrapMetadataColumns(relation: string): readonly string[] {
  if (!(FAKE_FINANCIAL_BOOTSTRAP_METADATA_RELATIONS as readonly string[]).includes(relation)) {
    throw new Error('UNKNOWN_FAKE_FINANCIAL_BOOTSTRAP_METADATA_RELATION');
  }
  return relation === 'public.hxos_nonproduction_bootstrap_completion_v1'
    ? [
        'completed_at',
        'financial_migration_status',
        'migration_artifact_digest',
        'release_environment',
        'release_id',
        'release_manifest_digest',
        'required_migration_count',
      ]
    : ['migration_name', 'migration_sql_sha256'];
}

export const FAKE_FINANCIAL_RECOVERY_READER_FUNCTION =
  'public.hxos_read_fake_financial_recovery_evidence_v13(uuid,text,text)';
export const FAKE_FINANCIAL_RECOVERY_ADMISSION_FUNCTION =
  'hx_authority.read_fake_financial_admission_evidence_v13(uuid,uuid)';

export const FAKE_FINANCIAL_OUTBOX_WORKER_FUNCTIONS = [
  CHANGE_ORDER_RECOVERY_CLAIM_FUNCTION,
  CHANGE_ORDER_RECOVERY_OBSERVATION_FUNCTION,
  'public.hxos_scan_fake_financial_recovery_v13(uuid,integer)',
  'public.hxos_read_fake_financial_restoration_v13(uuid,text,text)',
  'public.hxos_read_fake_financial_progress_v13(uuid,text,text)',
  'public.hxos_materialize_fake_financial_event_v13(uuid,uuid)',
  'public.hxos_acquire_fake_financial_reconcile_lease_v13(uuid,uuid,uuid,integer)',
  'public.hxos_record_fake_financial_outcome_v13(uuid,uuid,uuid)',
  FAKE_FINANCIAL_RECOVERY_READER_FUNCTION,
  'public.hxos_execute_admitted_fake_financial_request_v13(uuid,uuid)',
  'public.hxos_read_admitted_fake_financial_request_v13(uuid,uuid)',
  'public.hxos_claim_fake_financial_outbox_v13(uuid,integer)',
  'public.hxos_record_fake_financial_publish_outcome_v13(uuid,text,text,text,text,integer)',
  'hx_authority.record_fake_financial_job_dispatch_evidence_v13(uuid,text,text,uuid,integer,integer,integer)',
] as const;

export const FAKE_FINANCIAL_OUTBOX_SUBMISSION_FUNCTIONS = [
  'public.hxos_request_fake_financial_command_v13(text,text)',
] as const;

export const FAKE_FINANCIAL_OUTBOX_INVOKER_FUNCTIONS = [
  'hx_authority.claim_fake_financial_outbox_v13(uuid,integer)',
  'hx_authority.record_fake_financial_publish_outcome_v13(uuid,text,text,text,text,integer)',
  'hx_authority.record_fake_financial_webhook_rejection_v13(uuid,text,text,text,text,text)',
  'public.assert_financial_provider_command_recovery_lease()',
] as const;

export const FAKE_FINANCIAL_OUTCOME_ADMISSION_FUNCTION =
  'hx_authority.read_fake_financial_outcome_admission_v13(uuid)';

export const FAKE_FINANCIAL_OUTBOX_DEFINER_FUNCTIONS = [
  'hx_authority.read_fake_financial_terminal_observation_v13(uuid,uuid,uuid)',
  'hx_authority.read_fake_financial_materialization_evidence_v13(uuid,uuid)',
  FAKE_FINANCIAL_OUTCOME_ADMISSION_FUNCTION,
  FAKE_FINANCIAL_RECOVERY_ADMISSION_FUNCTION,
  'hx_authority.derive_fake_financial_projection_v13(text,text)',
  'hx_authority.derive_fake_financial_projection_v13(text,text,smallint)',
  'hx_authority.parse_fake_financial_request_v13(text,text)',
  'hx_authority.parse_fake_financial_identity_v13(text)',
  'hx_authority.mark_fake_financial_request_transaction_v13()',
  'hx_authority.validate_fake_financial_exact_request_v13()',
  'hx_authority.require_fake_financial_exact_request_v13()',
  'hx_authority.reject_fake_financial_outbox_mutation_v13()',
  'hx_authority.assert_fake_financial_outbox_target_v13(uuid,text,text,text)',
  'hx_authority.validate_fake_financial_outbox_request_v13()',
  'hx_authority.capture_fake_financial_outbox_request_v13()',
  'hx_authority.validate_fake_financial_outbox_disposition_v13()',
  'hx_authority.validate_fake_financial_publish_claim_v13()',
  'hx_authority.assert_fake_financial_publish_open_v13(uuid)',
  'hx_authority.validate_fake_financial_publish_exhaustion_v13()',
  'hx_authority.validate_fake_financial_publish_outcome_v13()',
  'hx_authority.validate_fake_financial_dispatch_admission_v13()',
  'hx_authority.validate_fake_financial_job_validation_v13()',
  'hx_authority.validate_fake_financial_webhook_rejection_v13()',
  'hx_authority.validate_fake_financial_webhook_inert_v13()',
  'hx_authority.capture_fake_financial_webhook_inert_v13()',
] as const;

export const FAKE_FINANCIAL_OUTBOX_DIGEST_FUNCTION =
  'hx_authority.fake_financial_job_digest_v13(text[])';

export const FAKE_FINANCIAL_OUTBOX_FUNCTIONS = [
  FAKE_FINANCIAL_RUNTIME_AUTHORITY_FUNCTION,
  ...FAKE_FINANCIAL_BOOTSTRAP_METADATA_FUNCTIONS,
  ...FAKE_FINANCIAL_OUTBOX_WORKER_FUNCTIONS,
  ...FAKE_FINANCIAL_OUTBOX_SUBMISSION_FUNCTIONS,
  ...FAKE_FINANCIAL_OUTBOX_INVOKER_FUNCTIONS,
  ...FAKE_FINANCIAL_OUTBOX_DEFINER_FUNCTIONS,
  FAKE_FINANCIAL_OUTBOX_DIGEST_FUNCTION,
] as const;

export const FAKE_FINANCIAL_OUTBOX_RELATIONS = [
  'hx_authority.fake_financial_exact_requests_v13',
  'hx_authority.fake_financial_command_outbox_requests_v13',
  'hx_authority.fake_financial_outbox_publish_claims_v13',
  'hx_authority.fake_financial_outbox_publish_outcomes_v13',
  'hx_authority.fake_financial_outbox_dispositions_v13',
  'hx_authority.fake_financial_publish_exhaustions_v13',
  'hx_authority.fake_financial_dispatch_admissions_v13',
  'hx_authority.fake_financial_job_validations_v13',
  'hx_authority.fake_financial_webhook_inert_evidence_v13',
  'hx_authority.fake_financial_webhook_rejection_receipts_v13',
] as const;

export const FAKE_FINANCIAL_OUTBOX_DEPENDENCY_RELATIONS = [
  'public.applied_migrations',
  'public.universal_v1_prepared_financial_commands',
  'public.financial_provider_command_recovery_leases',
  'public.financial_provider_command_dispatch_attempts',
  'public.provider_event_inbox_observations',
  'public.provider_event_inbox_receipts',
] as const;

/** PostgreSQL row locks require UPDATE privilege; immutable triggers still deny mutations. */
export const FAKE_FINANCIAL_OUTBOX_LOCK_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  'hx_authority.universal_v1_work_order_target_authority_facts': ['target_authority_id'],
  'public.universal_v1_prepared_financial_commands': ['prepared_command_id'],
  'public.financial_provider_command_recovery_leases': ['recovery_lease_id'],
  'public.financial_provider_command_dispatch_attempts': ['dispatch_attempt_id'],
  'public.provider_event_inbox_observations': ['observation_id'],
  'public.provider_event_inbox_receipts': ['receipt_id'],
};

export const FAKE_FINANCIAL_EXECUTION_DOMAIN_FUNCTION =
  'hx_authority.assert_fake_financial_execution_domain_v13(uuid,text)';
export const FAKE_FINANCIAL_EXECUTION_DISPUTE_FUNCTION =
  'public.universal_v1_has_open_material_dispute_v1(uuid)';
export const FAKE_FINANCIAL_EXECUTION_RAW_RELATIONS = [
  'public.hxos_fake_financial_operations_v1',
  'public.hxos_fake_financial_operation_events_v1',
] as const;
export const FAKE_FINANCIAL_EXECUTION_DOMAIN_RELATIONS = [
  'public.universal_v1_fake_terminal_lifecycle_intents',
  'public.universal_v1_fake_provider_account_facts',
  'public.task_safety_incidents',
  'public.universal_v1_dispute_incidents',
  'public.universal_v1_dispute_timeline_events',
  'public.universal_v1_dispute_current_v1',
] as const;

export const FAKE_FINANCIAL_OUTCOME_DEPENDENCY_COLUMNS: Readonly<
  Record<string, readonly string[]>
> = {
  'public.hxos_fake_financial_legacy_expiry_dispositions_v9': [
    'fake_operation_event_id',
    'recovery_state',
  ],
  'public.hxos_fake_financial_legacy_expiry_compensations_v9': ['source_fake_operation_event_id'],
  'public.hxos_fake_financial_legacy_expiry_noncompensable_facts_v10': [
    'source_fake_operation_event_id',
  ],
};

/** Existing canonical lifecycle trigger dependencies; no login gets direct DML. */
export const FAKE_FINANCIAL_LIFECYCLE_RELATIONS = [
  'public.universal_v1_change_order_recovery_leases',
  'public.task_financial_operations',
  'public.task_scope_change_proposals',
  'public.task_scope_change_approvals',
  'public.task_work_order_amendments',
  'public.task_completion_facts',
  'public.universal_v1_change_order_compensation_commands',
  'public.universal_v1_change_order_materialization_commands',
] as const;
export const FAKE_FINANCIAL_LIFECYCLE_REVERSAL_FUNCTION =
  'public.universal_v1_change_order_compensating_reversal_is_exact_v1(public.task_financial_security_events,public.task_financial_security_events)';
export const FAKE_FINANCIAL_LIFECYCLE_TRIGGER_FUNCTIONS = [
  'public.enforce_universal_financial_event_sequence()',
  'public.enforce_universal_fake_finance_boundary()',
  'public.enforce_universal_v1_financial_execution_completion()',
  'public.enforce_financial_operation_trigger_only()',
  'public.serialize_universal_v1_financial_security_task_v12()',
  'public.enforce_universal_v1_dispute_release_gate_v1()',
] as const;
export const FAKE_FINANCIAL_LIFECYCLE_DISPUTE_LOCK_FUNCTION =
  'public.universal_v1_dispute_lock_v1(uuid)';
export const FAKE_FINANCIAL_LIFECYCLE_DEPENDENCY_COLUMNS: Readonly<
  Record<string, readonly string[]>
> = {
  'public.universal_v1_change_order_recovery_leases': [
    'recovery_lease_id',
    'proposal_id',
    'lease_owner_id',
    'lease_duration_seconds',
    'acquired_at',
    'expires_at',
    'lease_identity_sha256',
  ],
  // The existing journal trigger refuses ADJUST after terminal recovery.
  'public.universal_v1_change_order_recovery_terminal_facts': [
    'proposal_id',
    'outcome_state',
    'recovery_state',
  ],
  'public.universal_v1_change_order_compensation_commands': [
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
  'public.universal_v1_change_order_materialization_commands': [
    'prepared_at',
    'actor_user_id',
    'adjustment_operation_id',
    'base_scope_version_id',
    'currency',
    'customer_total_cents',
    'eligibility_decision_id',
    'expected_financial_version',
    'idempotency_key',
    'predecessor_event_id',
    'proposal_id',
    'replacement_scope_version_id',
    'request_sha256',
    'task_draft_id',
    'task_id',
    'work_order_id',
  ],
  'public.task_financial_operations': [
    'operation_id',
    'task_draft_id',
    'task_id',
    'eligibility_decision_id',
    'scope_version_id',
    'change_order_id',
    'event_kind',
    'provider_kind',
    'external_reference',
    'amount_cents',
    'currency',
    'completion_fact_id',
  ],
  'public.task_drafts': ['id', 'task_id', 'universal_contract_version'],
  'public.task_provider_eligibility_decisions': [
    'id',
    'task_draft_id',
    'task_id',
    'scope_version_id',
  ],
  'public.tasks': ['id', 'universal_contract_version', 'automation_classification', 'worker_id'],
  'public.task_work_orders': [
    'id',
    'task_draft_id',
    'task_id',
    'eligibility_decision_id',
    'scope_version_id',
    'execution_contract_version',
  ],
  'public.task_scope_change_proposals': [
    'id',
    'task_id',
    'universal_contract_version',
    'status',
    'change_order_kind',
    'financial_adjustment_required',
    'approved_version_id',
    'base_version_id',
    'proposed_customer_total_cents',
  ],
  'public.task_scope_versions': [
    'id',
    'task_id',
    'universal_contract_version',
    'customer_total_cents',
    'currency',
    'hustler_payout_cents',
  ],
  'public.task_work_order_amendments': ['work_order_id', 'scope_version_id', 'amendment_version'],
  'public.task_scope_change_approvals': ['proposal_id', 'approver_role', 'decision'],
  'public.task_completion_facts': [
    'id',
    'work_order_id',
    'scope_version_id',
    'fact_kind',
    'incident_gate',
    'customer_notice_at',
    'amount_approved_cents',
    'completion_version',
  ],
  'public.task_safety_incidents': ['task_id', 'status'],
  'public.task_work_order_execution_facts': [
    'work_order_id',
    'state',
    'transition_kind',
    'completion_fact_id',
    'execution_version',
  ],
};
