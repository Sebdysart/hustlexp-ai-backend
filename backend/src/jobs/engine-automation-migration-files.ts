import { FOUNDATIONAL_REQUIRED_MIGRATION_FILES } from './engine-automation-migration-files-foundation.js';

export const REQUIRED_MIGRATION_FILES = [
  ...FOUNDATIONAL_REQUIRED_MIGRATION_FILES,
  {
    name: '20260719_compliance_guardian_persistence_contract',
    fileName: '20260719_compliance_guardian_persistence_contract.sql',
  },
  {
    name: '20260719_worker_offer_retake_contract',
    fileName: '20260719_worker_offer_retake_contract.sql',
  },
  {
    name: '20260719_liquidity_expansion_contract',
    fileName: '20260719_liquidity_expansion_contract.sql',
  },
  {
    name: '20260719_liquidity_expansion_fk_repair',
    fileName: '20260719_liquidity_expansion_fk_repair.sql',
  },
  {
    name: '20260719_worker_counter_offer_contract',
    fileName: '20260719_worker_counter_offer_contract.sql',
  },
  {
    name: '20260719_worker_counter_offer_exclusivity',
    fileName: '20260719_worker_counter_offer_exclusivity.sql',
  },
  {
    name: '20260719_external_task_bridge_contract',
    fileName: '20260719_external_task_bridge_contract.sql',
  },
  {
    name: '20260720_task_geofence_event_contract',
    fileName: '20260720_task_geofence_event_contract.sql',
  },
  {
    name: '20260720_major_action_telemetry_contract',
    fileName: '20260720_major_action_telemetry_contract.sql',
  },
  {
    name: '20260720_major_action_telemetry_contract_repair',
    fileName: '20260720_major_action_telemetry_contract_repair.sql',
  },
  {
    name: '20260720_major_action_source_registry_repair',
    fileName: '20260720_major_action_source_registry_repair.sql',
  },
  {
    name: '20260720_offline_action_sync_contract',
    fileName: '20260720_offline_action_sync_contract.sql',
  },
  {
    name: '20260720_offline_action_sync_contract_repair',
    fileName: '20260720_offline_action_sync_contract_repair.sql',
  },
  {
    name: '20260720_proof_verification_signal_contract',
    fileName: '20260720_proof_verification_signal_contract.sql',
  },
  {
    name: '20260720_proof_media_metadata_minimization',
    fileName: '20260720_proof_media_metadata_minimization.sql',
  },
  {
    name: '20260720_media_upload_finalization_contract',
    fileName: '20260720_media_upload_finalization_contract.sql',
  },
  {
    name: '20260720_private_media_delivery_contract',
    fileName: '20260720_private_media_delivery_contract.sql',
  },
  { name: '20260720_worker_standing_appeals', fileName: '20260720_worker_standing_appeals.sql' },
  {
    name: '20260720_offline_action_reconciliation',
    fileName: '20260720_offline_action_reconciliation.sql',
  },
  {
    name: '20260720_dispute_release_authority_contract',
    fileName: '20260720_dispute_release_authority_contract.sql',
  },
  {
    name: '20260720_notification_delivery_contract',
    fileName: '20260720_notification_delivery_contract.sql',
  },
  {
    name: '20260720_notification_delivery_contract_repair',
    fileName: '20260720_notification_delivery_contract_repair.sql',
  },
  {
    name: '20260720_notification_focus_suppression',
    fileName: '20260720_notification_focus_suppression.sql',
  },
  {
    name: '20260720_schema_convergence_repair',
    fileName: '20260720_schema_convergence_repair.sql',
  },
  {
    name: '20260720_local_certification_payment_provider',
    fileName: '20260720_local_certification_payment_provider.sql',
  },
  {
    name: '20260720_region_policy_price_book_alignment',
    fileName: '20260720_region_policy_price_book_alignment.sql',
  },
  {
    name: '20260720_local_certification_payout_provider',
    fileName: '20260720_local_certification_payout_provider.sql',
  },
  {
    name: '20260720_local_certification_screening_provider',
    fileName: '20260720_local_certification_screening_provider.sql',
  },
  {
    name: '20260720_controlled_test_liquidity_cell',
    fileName: '20260720_controlled_test_liquidity_cell.sql',
  },
  {
    name: '20260720_controlled_test_liquidity_marker_repair',
    fileName: '20260720_controlled_test_liquidity_marker_repair.sql',
  },
  {
    name: '20260720_controlled_test_liquidity_lifecycle_repair',
    fileName: '20260720_controlled_test_liquidity_lifecycle_repair.sql',
  },
  {
    name: '20260720_controlled_test_duration_evidence',
    fileName: '20260720_controlled_test_duration_evidence.sql',
  },
  {
    name: '20260720_controlled_test_provider_capability',
    fileName: '20260720_controlled_test_provider_capability.sql',
  },
  {
    name: '20260720_controlled_test_provider_capability_expiry',
    fileName: '20260720_controlled_test_provider_capability_expiry.sql',
  },
  {
    name: '20260720_controlled_test_provider_capability_refresh',
    fileName: '20260720_controlled_test_provider_capability_refresh.sql',
  },
  {
    name: '20260720_controlled_test_provider_capability_refresh_repair',
    fileName: '20260720_controlled_test_provider_capability_refresh_repair.sql',
  },
  {
    name: '20260720_controlled_test_offer_review',
    fileName: '20260720_controlled_test_offer_review.sql',
  },
  {
    name: '20260720_task_safety_state_integrity',
    fileName: '20260720_task_safety_state_integrity.sql',
  },
  {
    name: '20260720_task_safety_resolution_integrity',
    fileName: '20260720_task_safety_resolution_integrity.sql',
  },
  {
    name: '20260720_task_safety_case_access_integrity',
    fileName: '20260720_task_safety_case_access_integrity.sql',
  },
  {
    name: '20260720_operations_exception_contract',
    fileName: '20260720_operations_exception_contract.sql',
  },
  {
    name: '20260721_hustler_trust_progression_contract',
    fileName: '20260721_hustler_trust_progression_contract.sql',
  },
  {
    name: '20260721_task_quote_shortlist_messaging_contract',
    fileName: '20260721_task_quote_shortlist_messaging_contract.sql',
  },
  {
    name: '20260721_unit_economics_guardrails',
    fileName: '20260721_unit_economics_guardrails.sql',
  },
  {
    name: '20260721_build_now_spend_promotion_guardrails',
    fileName: '20260721_build_now_spend_promotion_guardrails.sql',
  },
  {
    name: '20260721_private_identity_verification_contract',
    fileName: '20260721_private_identity_verification_contract.sql',
  },
  {
    name: '20260721_sensitive_media_ingestion_shutdown',
    fileName: '20260721_sensitive_media_ingestion_shutdown.sql',
  },
  {
    name: '20260721_ai_observability_contract',
    fileName: '20260721_ai_observability_contract.sql',
  },
  {
    name: '20260721_controlled_test_retake_acceptance_repair',
    fileName: '20260721_controlled_test_retake_acceptance_repair.sql',
  },
  {
    name: '20260721_controlled_test_retake_liquidity_repair',
    fileName: '20260721_controlled_test_retake_liquidity_repair.sql',
  },
  {
    name: '20260721_controlled_test_retake_guard_convergence',
    fileName: '20260721_controlled_test_retake_guard_convergence.sql',
  },
  {
    name: '20260721_same_worker_retake_assignment_guard_repair',
    fileName: '20260721_same_worker_retake_assignment_guard_repair.sql',
  },
  {
    name: '20260722_region_policy_legal_approval_activation',
    fileName: '20260722_region_policy_legal_approval_activation.sql',
  },
  {
    name: '20260722_recurring_payment_dispatch_gate',
    fileName: '20260722_recurring_payment_dispatch_gate.sql',
  },
  {
    name: '20260722_service_business_assignment_contract',
    fileName: '20260722_service_business_assignment_contract.sql',
  },
  { name: '010_web_platform_tables', fileName: '010_web_platform_tables.sql' },
  { name: '20260814_quote_price_book', fileName: '20260814_quote_price_book.sql' },
  {
    name: '20260814_price_book_quote_decisions',
    fileName: '20260814_price_book_quote_decisions.sql',
  },
  { name: '20260814_task_supply_confidence', fileName: '20260814_task_supply_confidence.sql' },
  { name: '20260815_quote_columns_extra_v4', fileName: '20260815_quote_columns_extra_v4.sql' },
  { name: '20260819_quote_payments', fileName: '20260819_quote_payments.sql' },
  { name: '20260823_quote_payment_recovery', fileName: '20260823_quote_payment_recovery.sql' },
  {
    name: '20260827_universal_v1_lifecycle_contract',
    fileName: '20260827_universal_v1_lifecycle_contract.sql',
  },
  {
    name: '20260828_operator_authority_contract',
    fileName: '20260828_operator_authority_contract.sql',
  },
  {
    name: '20260829_task_matching_state_contract',
    fileName: '20260829_task_matching_state_contract.sql',
  },
  {
    name: '20260830_ai_agent_judge_audit_convergence',
    fileName: '20260830_ai_agent_judge_audit_convergence.sql',
  },
  {
    name: '20260831_provider_neutral_outbound_communication',
    fileName: '20260831_provider_neutral_outbound_communication.sql',
  },
  {
    name: '20260901_universal_v1_lead_ingress_port',
    fileName: '20260901_universal_v1_lead_ingress_port.sql',
  },
  {
    name: '20260902_universal_v1_task_draft_public_port',
    fileName: '20260902_universal_v1_task_draft_public_port.sql',
  },
  {
    name: '20260903_universal_v1_task_draft_account_claim',
    fileName: '20260903_universal_v1_task_draft_account_claim.sql',
  },
  {
    name: '20260904_canonical_user_email_identity',
    fileName: '20260904_canonical_user_email_identity.sql',
  },
  {
    name: '20260905_universal_v1_task_draft_legacy_claim_import_repair',
    fileName: '20260905_universal_v1_task_draft_legacy_claim_import_repair.sql',
  },
  {
    name: '20260906_universal_v1_estimate_acceptance_materialization',
    fileName: '20260906_universal_v1_estimate_acceptance_materialization.sql',
  },
  {
    name: '20260907_universal_v1_provider_estimate_invitation',
    fileName: '20260907_universal_v1_provider_estimate_invitation.sql',
  },
  {
    name: '20260908_universal_v1_provider_work_order_authority',
    fileName: '20260908_universal_v1_provider_work_order_authority.sql',
  },
  {
    name: '20260909_universal_v1_reconciliation_alias_repair',
    fileName: '20260909_universal_v1_reconciliation_alias_repair.sql',
  },
  {
    name: '20260911_universal_v1_change_order_application',
    fileName: '20260911_universal_v1_change_order_application.sql',
  },
  {
    name: '20260912_universal_v1_work_order_execution_facts',
    fileName: '20260912_universal_v1_work_order_execution_facts.sql',
  },
  {
    name: '20260913_universal_v1_completion_delivery_receipt',
    fileName: '20260913_universal_v1_completion_delivery_receipt.sql',
  },
  {
    name: '20260914_notification_provider_in_flight',
    fileName: '20260914_notification_provider_in_flight.sql',
  },
  {
    name: '20260915_ai_spend_attempt_ledger',
    fileName: '20260915_ai_spend_attempt_ledger.sql',
  },
  {
    name: '20260916_provider_event_inbox_v1',
    fileName: '20260916_provider_event_inbox_v1.sql',
  },
  {
    name: '20260917_financial_provider_command_journal_v1',
    fileName: '20260917_financial_provider_command_journal_v1.sql',
  },
  {
    name: '20260918_universal_v1_prepared_financial_command_v1',
    fileName: '20260918_universal_v1_prepared_financial_command_v1.sql',
  },
  {
    name: '20260919_provider_event_processing_v1',
    fileName: '20260919_provider_event_processing_v1.sql',
  },
  {
    name: '20260920_financial_provider_command_recovery_v1',
    fileName: '20260920_financial_provider_command_recovery_v1.sql',
  },
  {
    name: '20260923_legacy_escrow_insert_containment_v1',
    fileName: '20260923_legacy_escrow_insert_containment_v1.sql',
  },
  {
    name: '20260924_universal_v1_task_draft_route_context_v1',
    fileName: '20260924_universal_v1_task_draft_route_context_v1.sql',
  },
  {
    name: '20260925_universal_v1_work_order_compensation_v1',
    fileName: '20260925_universal_v1_work_order_compensation_v1.sql',
  },
  {
    name: '20260928_provider_observation_normalization_v1',
    fileName: '20260928_provider_observation_normalization_v1.sql',
  },
  {
    name: '20260929_universal_v1_double_entry_ledger_v1',
    fileName: '20260929_universal_v1_double_entry_ledger_v1.sql',
  },
  {
    name: '20260930_universal_v1_ops_cases_v1',
    fileName: '20260930_universal_v1_ops_cases_v1.sql',
  },
  {
    name: '20261001_universal_v1_relationship_origin_v1',
    fileName: '20261001_universal_v1_relationship_origin_v1.sql',
  },
  {
    name: '20261002_universal_v1_dispute_recovery_v1',
    fileName: '20261002_universal_v1_dispute_recovery_v1.sql',
  },
  {
    name: '20261003_universal_v1_task_opportunities_v1',
    fileName: '20261003_universal_v1_task_opportunities_v1.sql',
  },
  {
    name: '20261004_universal_v1_completion_notice_dispatch_v1',
    fileName: '20261004_universal_v1_completion_notice_dispatch_v1.sql',
  },
  {
    name: '20261005_universal_v1_occurrence_access_audit_v1',
    fileName: '20261005_universal_v1_occurrence_access_audit_v1.sql',
  },
  {
    name: '20261006_stage1_legacy_authority_containment_v1',
    fileName: '20261006_stage1_legacy_authority_containment_v1.sql',
  },
  {
    name: '20261007_subscription_cancellation_recovery_v1',
    fileName: '20261007_subscription_cancellation_recovery_v1.sql',
  },
  {
    name: '20261008_universal_v1_work_order_task_state_containment_v1',
    fileName: '20261008_universal_v1_work_order_task_state_containment_v1.sql',
  },
  {
    name: '20261009_universal_v1_standardized_quote_readiness_v1',
    fileName: '20261009_universal_v1_standardized_quote_readiness_v1.sql',
  },
  {
    name: '20261010_universal_v1_financial_security_event_expiry_v1',
    fileName: '20261010_universal_v1_financial_security_event_expiry_v1.sql',
  },
  {
    name: '20261012_universal_v1_work_order_command_authority_v2',
    fileName: '20261012_universal_v1_work_order_command_authority_v2.sql',
  },
  {
    name: '20261014_universal_v1_work_order_command_ports_v1',
    fileName: '20261014_universal_v1_work_order_command_ports_v1.sql',
  },
] as const;
