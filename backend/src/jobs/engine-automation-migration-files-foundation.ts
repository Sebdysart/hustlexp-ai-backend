export const FOUNDATIONAL_REQUIRED_MIGRATION_FILES = [
  { name: 'add_missing_tables_v2', fileName: 'add_missing_tables_v2.sql' },
  {
    name: '20260710_engine_automation_contracts',
    fileName: '20260710_engine_automation_contracts.sql',
  },
  { name: '20260711_required_proof_alignment', fileName: '011-proof-alignment.sql' },
  { name: '20260711_required_expertise_supply', fileName: 'expertise_supply_control.sql' },
  {
    name: '20260711_task_outcome_classification',
    fileName: '20260711_task_outcome_classification.sql',
  },
  { name: '20260712_hustler_identity_link', fileName: '20260712_hustler_identity_link.sql' },
  {
    name: '20260712_dispatch_expiry_pending_payment_cancel',
    fileName: '20260712_dispatch_expiry_pending_payment_cancel.sql',
  },
  {
    name: '20260712_dispatch_expiry_no_payment_reconcile',
    fileName: '20260712_dispatch_expiry_no_payment_reconcile.sql',
  },
  { name: 'performance_indexes_v1', fileName: '20260713_performance_indexes_alignment.sql' },
  { name: 'chargeback_lifecycle_v1', fileName: 'chargeback_lifecycle.sql' },
  { name: '20260718_revenue_audit_rail', fileName: '20260718_revenue_audit_rail.sql' },
  { name: '20260718_quote_economics_contract', fileName: '20260718_quote_economics_contract.sql' },
  { name: '20260718_task_scope_versions', fileName: '20260718_task_scope_versions.sql' },
  { name: '20260718_task_location_encryption', fileName: '20260718_task_location_encryption.sql' },
  {
    name: '20260718_proof_submission_atomicity',
    fileName: '20260718_proof_submission_atomicity.sql',
  },
  {
    name: '20260718_task_safety_incident_cases',
    fileName: '20260718_task_safety_incident_cases.sql',
  },
  {
    name: '20260718_task_safety_delivery_contract',
    fileName: '20260718_task_safety_delivery_contract.sql',
  },
  { name: '20260718_task_safety_checkins', fileName: '20260718_task_safety_checkins.sql' },
  {
    name: '20260718_task_safety_location_encryption',
    fileName: '20260718_task_safety_location_encryption.sql',
  },
  {
    name: '20260718_zone_category_liquidity_cells',
    fileName: '20260718_zone_category_liquidity_cells.sql',
  },
  {
    name: '20260718_worker_offer_decision_contract',
    fileName: '20260718_worker_offer_decision_contract.sql',
  },
  {
    name: '20260718_worker_screening_rights_contract',
    fileName: '20260718_worker_screening_rights_contract.sql',
  },
  { name: '20260718_region_policy_contract', fileName: '20260718_region_policy_contract.sql' },
  {
    name: '20260718_completion_retention_contract',
    fileName: '20260718_completion_retention_contract.sql',
  },
  {
    name: '20260718_task_public_clarifications',
    fileName: '20260718_task_public_clarifications.sql',
  },
  {
    name: '20260718_marketplace_reputation_contract',
    fileName: '20260718_marketplace_reputation_contract.sql',
  },
  {
    name: '20260718_business_workspace_contract',
    fileName: '20260718_business_workspace_contract.sql',
  },
  {
    name: '20260718_business_operations_contract',
    fileName: '20260718_business_operations_contract.sql',
  },
  {
    name: '20260718_business_execution_contract',
    fileName: '20260718_business_execution_contract.sql',
  },
  { name: '20260718_recurring_work_contract', fileName: '20260718_recurring_work_contract.sql' },
  {
    name: '20260718_business_recurring_contract',
    fileName: '20260718_business_recurring_contract.sql',
  },
  { name: '20260719_recommendation_contract', fileName: '20260719_recommendation_contract.sql' },
  { name: '20260719_hustler_wallet_contract', fileName: '20260719_hustler_wallet_contract.sql' },
  {
    name: '20260719_wallet_provider_event_integrity',
    fileName: '20260719_wallet_provider_event_integrity.sql',
  },
  {
    name: '20260719_wallet_provider_event_integrity_repair',
    fileName: '20260719_wallet_provider_event_integrity_repair.sql',
  },
  {
    name: '20260719_lifecycle_service_foundations',
    fileName: '20260719_lifecycle_service_foundations.sql',
  },
  {
    name: '20260719_task_worker_eligibility_contract',
    fileName: '20260719_task_worker_eligibility_contract.sql',
  },
  {
    name: '20260719_append_only_truncate_contract',
    fileName: '20260719_append_only_truncate_contract.sql',
  },
  {
    name: '20260719_admin_user_search_trigram_contract',
    fileName: '20260719_admin_user_search_trigram_contract.sql',
  },
  {
    name: '20260719_admin_capability_contract',
    fileName: '20260719_admin_capability_contract.sql',
  },
  {
    name: '20260719_tier0_browse_only_contract',
    fileName: '20260719_tier0_browse_only_contract.sql',
  },
  {
    name: '20260719_task_template_policy_contract',
    fileName: '20260719_task_template_policy_contract.sql',
  },
] as const;
