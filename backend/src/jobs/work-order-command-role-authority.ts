import { CHANGE_ORDER_REVERSAL_EXECUTION_FUNCTION } from './change-order-reversal-role-plans.js';
import {
  CHANGE_ORDER_RECOVERY_COMPENSATION_INSERT_COLUMNS,
  CHANGE_ORDER_RECOVERY_COMPENSATION_LOCK_COLUMNS,
  CHANGE_ORDER_RECOVERY_COMPENSATION_READ_COLUMNS,
  CHANGE_ORDER_RECOVERY_COMPENSATION_DEPENDENCIES,
  CHANGE_ORDER_RECOVERY_OBSERVATION_READ_COLUMNS,
  CHANGE_ORDER_RECOVERY_OBSERVATION_DEPENDENCIES,
} from './change-order-recovery-role-plans.js';
import {
  CHANGE_ORDER_RECOVERY_CLAIM_INSERT_COLUMNS,
  CHANGE_ORDER_RECOVERY_CLAIM_LOCK_COLUMNS,
} from './change-order-recovery-role-plans.js';
import {
  CHANGE_ORDER_MATERIALIZATION_ADDITIONAL_RELATIONS,
  CHANGE_ORDER_MATERIALIZATION_FUNCTIONS,
  CHANGE_ORDER_MATERIALIZATION_PUBLIC_FUNCTIONS,
  CHANGE_ORDER_MATERIALIZATION_HASH_FUNCTIONS,
  CHANGE_ORDER_MATERIALIZATION_DEFERRED_GUARDS,
  CHANGE_ORDER_MATERIALIZATION_WITNESS_HASH,
  CHANGE_ORDER_MATERIALIZATION_READ_COLUMNS,
  CHANGE_ORDER_MATERIALIZATION_INSERT_COLUMNS,
  CHANGE_ORDER_MATERIALIZATION_UPDATE_COLUMNS,
} from './change-order-materialization-role-plans.js';
import {
  CHANGE_ORDER_COMMAND_FUNCTIONS,
  CHANGE_ORDER_PUBLIC_COMMAND_FUNCTIONS,
  CHANGE_ORDER_HASH_FUNCTIONS,
  CHANGE_ORDER_PROPOSE_COMMAND,
  CHANGE_ORDER_DECIDE_COMMAND,
  CHANGE_ORDER_COMMAND_READ_COLUMNS,
  CHANGE_ORDER_COMMAND_INSERT_COLUMNS,
  CHANGE_ORDER_COMMAND_UPDATE_COLUMNS,
} from './change-order-command-role-plans.js';
import {
  CHANGE_ORDER_HISTORY_COMMAND,
  CHANGE_ORDER_HISTORY_FUNCTIONS,
} from './change-order-history-role-plans.js';
import { financialReadinessFunctionCustody } from './financial-readiness-custody.js';
import {
  WORK_ORDER_HISTORY_COMMAND,
  WORK_ORDER_HISTORY_FUNCTIONS,
} from './work-order-history-role-plans.js';
import {
  FAKE_FINANCIAL_PREDECESSOR_COMMAND,
  FAKE_FINANCIAL_PREDECESSOR_READER,
  FAKE_FINANCIAL_PREDECESSOR_FUNCTIONS,
} from './fake-financial-predecessor-role-plans.js';
import {
  FAKE_FINANCIAL_WEBHOOK_INGRESS,
  FAKE_FINANCIAL_WEBHOOK_FUNCTIONS,
  FAKE_FINANCIAL_WEBHOOK_DEPENDENCIES,
  FAKE_FINANCIAL_WEBHOOK_VERIFICATIONS,
  FAKE_FINANCIAL_WEBHOOK_PROCESSING,
  FAKE_FINANCIAL_WEBHOOK_RELATIONS,
} from './fake-financial-webhook-role-plans.js';
import {
  FAKE_FINANCIAL_PUBLIC_PROGRESS_COMMAND,
  FAKE_FINANCIAL_PUBLIC_PROGRESS_READER,
  FAKE_FINANCIAL_PUBLIC_PROGRESS_FUNCTIONS,
} from './fake-financial-public-progress-role-plans.js';
import {
  FAKE_FINANCIAL_PREPARATION_COMMAND,
  FAKE_FINANCIAL_PREPARATION_BUILDER,
  FAKE_FINANCIAL_PREPARATION_INSERT,
  FAKE_FINANCIAL_PREPARATION_FUNCTIONS,
  FAKE_FINANCIAL_PREPARATION_DEPENDENCY_FUNCTIONS,
  FAKE_FINANCIAL_PREPARATION_PROVENANCE,
  FAKE_FINANCIAL_PREPARATION_PROVENANCE_READ_COLUMNS,
  FAKE_FINANCIAL_PREPARATION_ADDITIONAL_RELATIONS,
  FAKE_FINANCIAL_PREPARATION_READ_COLUMNS,
  FAKE_FINANCIAL_PREPARATION_LOCK_COLUMNS,
} from './fake-financial-preparation-role-plans.js';
import type { QueryFn } from '../database-contracts.js';
import {
  FAKE_FINANCIAL_LIFECYCLE_RELATIONS,
  FAKE_FINANCIAL_LIFECYCLE_TRIGGER_FUNCTIONS,
  FAKE_FINANCIAL_LIFECYCLE_DISPUTE_LOCK_FUNCTION,
  FAKE_FINANCIAL_LIFECYCLE_REVERSAL_FUNCTION,
  FAKE_FINANCIAL_LIFECYCLE_DEPENDENCY_COLUMNS,
  FAKE_FINANCIAL_RUNTIME_AUTHORITY_FUNCTION,
  FAKE_FINANCIAL_RECOVERY_READER_FUNCTION,
  FAKE_FINANCIAL_OUTCOME_ADMISSION_FUNCTION,
  FAKE_FINANCIAL_OUTCOME_DEPENDENCY_COLUMNS,
  FAKE_FINANCIAL_RECOVERY_ADMISSION_FUNCTION,
  FAKE_FINANCIAL_BOOTSTRAP_METADATA_FUNCTIONS,
  FAKE_FINANCIAL_BOOTSTRAP_METADATA_RELATIONS,
  fakeFinancialBootstrapMetadataColumns,
  FAKE_FINANCIAL_OUTBOX_FUNCTIONS,
  FAKE_FINANCIAL_EXECUTION_DOMAIN_FUNCTION,
  FAKE_FINANCIAL_EXECUTION_DISPUTE_FUNCTION,
  FAKE_FINANCIAL_EXECUTION_RAW_RELATIONS,
  FAKE_FINANCIAL_EXECUTION_DOMAIN_RELATIONS,
  FAKE_FINANCIAL_OUTBOX_WORKER_FUNCTIONS,
  FAKE_FINANCIAL_OUTBOX_SUBMISSION_FUNCTIONS,
  FAKE_FINANCIAL_OUTBOX_INVOKER_FUNCTIONS,
  FAKE_FINANCIAL_OUTBOX_DEFINER_FUNCTIONS,
  FAKE_FINANCIAL_OUTBOX_DIGEST_FUNCTION,
  FAKE_FINANCIAL_OUTBOX_RELATIONS,
  FAKE_FINANCIAL_OUTBOX_DEPENDENCY_RELATIONS,
  FAKE_FINANCIAL_OUTBOX_LOCK_COLUMNS,
} from './fake-financial-outbox-role-plans.js';

type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;
declare const workOrderCommandAuthorityTransactionBrand: unique symbol;
export interface WorkOrderCommandAuthorityTransaction {
  <T>(operation: (query: QueryFn) => Promise<T>): Promise<T>;
  readonly [workOrderCommandAuthorityTransactionBrand]: true;
}

export interface WorkOrderCommandAuthoritySession {
  query: QueryFn;
  release: (destroy?: boolean) => void;
}

/**
 * Own one physical session for the complete certification snapshot. Any BEGIN,
 * SET/read, COMMIT, or ROLLBACK failure destroys the session rather than
 * returning ambiguous authority state to a pool.
 */
export function createWorkOrderCommandAuthorityTransaction(
  connect: () => Promise<WorkOrderCommandAuthoritySession>
): WorkOrderCommandAuthorityTransaction {
  const transaction = async <T>(operation: (query: QueryFn) => Promise<T>): Promise<T> => {
    const session = await connect();
    let began = false;
    let result: T;
    try {
      await session.query('BEGIN');
      began = true;
      result = await operation(session.query);
      // Once COMMIT is sent, its result is authoritative but may be
      // ambiguous. Never issue any further SQL on that physical session if
      // COMMIT fails; destroy it and preserve the original commit error.
      began = false;
      await session.query('COMMIT');
    } catch (error) {
      if (began) {
        try {
          await session.query('ROLLBACK');
        } catch {
          // The original certification failure remains authoritative. The
          // poisoned physical session is destroyed before it is rethrown.
        }
      }
      try {
        session.release(true);
      } catch {
        // Preserve the original BEGIN/operation/COMMIT failure. A destroy
        // failure cannot turn failed certification into success.
      }
      throw error;
    }
    session.release(false);
    return result;
  };
  return transaction as WorkOrderCommandAuthorityTransaction;
}

const ROLE_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const FIXED_SEARCH_PATH = 'search_path=pg_catalog';
const FIXED_PUBLIC_SEARCH_PATH = 'search_path=pg_catalog, public';

export const WORK_ORDER_ASSERTION_ISSUER_FUNCTION =
  'public.hxos_issue_universal_v1_actor_assertion_v1(text,text,text,text,jsonb,timestamptz)';
export const WORK_ORDER_ASSERTION_CONSUMER_FUNCTION =
  'hx_authority.consume_universal_v1_actor_assertion_v1(text,text,jsonb,text)';
export const WORK_ORDER_ASSERTION_INTERNAL_FUNCTIONS = [
  'hx_authority.reject_universal_v1_actor_assertion_mutation_v2()',
] as const;
export const WORK_ORDER_BOOTSTRAP_SEAL_FUNCTION =
  'hx_authority.assert_universal_v1_work_order_bootstrap_seal_v1()';
export const WORK_ORDER_COMMAND_INTERNAL_FUNCTIONS = [
  'hx_authority.reject_universal_v1_work_order_authority_mutation_v1()',
  'hx_authority.validate_universal_v1_work_order_target_activation_v1()',
  'hx_authority.read_universal_v1_work_order_target_authority_v1()',
  'hx_authority.build_universal_v1_work_order_command_request_v1(text,jsonb)',
  'hx_authority.record_universal_v1_work_order_command_execution_v1(uuid,uuid,text,text,uuid,text,text,uuid,integer,text,jsonb)',
  'public.hxos_build_universal_v1_work_order_actor_request_v1(text,jsonb)',
] as const;
export const WORK_ORDER_COMMAND_DEPENDENCY_FUNCTIONS = [
  'public.claim_universal_v1_work_order_compensations(integer,integer)',
  'public.universal_v1_work_order_operation_id_v1(text,text)',
  'public.lock_universal_v1_estimate_authority(uuid,uuid,uuid,uuid,uuid)',
  'public.universal_v1_invited_provider_authority_is_current(uuid,uuid,text,uuid,text,text)',
  'public.universal_v1_execution_internal_request_sha256(uuid,uuid,text,text,integer,uuid,uuid,uuid,text,timestamptz,text)',
  'public.bind_universal_work_order_to_task()',
  'public.universal_v1_financial_security_is_current_v1(timestamptz,timestamptz)',
  'public.universal_v1_effective_financial_security_expiry_v1(uuid)',
  'public.enforce_universal_v1_work_order_execution_genesis()',
  'public.hxos_universal_v1_sha256_bytes_v1(text,text)',
  'public.hxos_universal_v1_sha256_bytes_v1(bytea,text)',
] as const;
export const WORK_ORDER_HUMAN_COMMAND_FUNCTIONS = [
  'public.hxos_express_universal_v1_post_estimate_interest_v1(text,uuid,integer,text,timestamptz)',
  'public.hxos_place_universal_v1_conditional_hold_v1(text,uuid,integer,text,timestamptz)',
  'public.hxos_prepare_universal_v1_fake_work_order_v1(text,uuid,integer,text,timestamptz)',
  'public.hxos_materialize_universal_v1_fake_work_order_v1(text,text,text,uuid)',
  'public.hxos_request_universal_v1_fake_work_order_recovery_v1(text,text,text,uuid)',
] as const;
export const WORK_ORDER_WORKER_COMMAND_FUNCTIONS = [
  'public.hxos_claim_universal_v1_work_order_compensation_v2(integer,integer)',
] as const;
export const WORK_ORDER_FINANCE_TRIGGER_FUNCTIONS = [
  'public.require_universal_v1_controlled_fake_lifecycle_bridge()',
] as const;
export const WORK_ORDER_TELEMETRY_FUNCTIONS = [
  'public.mirror_major_action_source_event()',
  'public.mirror_worker_standing_appeal_major_action()',
  'public.record_major_action_event(text,text,text,text,text,text,text,text,text,text,text,text,text,text,uuid,text,text,text,text,text,text,bigint,text,text,text,text,text,text,text,boolean,text,text,timestamptz,integer)',
  'public.record_major_action_outcome(uuid,text,text,text,text,integer,text,text,text,text,timestamptz)',
] as const;
export const WORK_ORDER_TELEMETRY_ENVIRONMENT_FUNCTION =
  'public.hxos_read_universal_v1_telemetry_environment_v1()';
export const WORK_ORDER_TARGET_ACTIVATION_FUNCTION =
  'public.hxos_activate_universal_v1_work_order_target_v1(text,text,uuid,integer)';
export const WORK_ORDER_RUNTIME_AUTHORITY_FUNCTION =
  'public.hxos_read_universal_v1_work_order_runtime_authority_v1()';
export const WORK_ORDER_CORE_SHA_TRANSITIVE_TRIGGER_FUNCTIONS = [
  'public.enforce_provider_estimate_submission()',
  'public.assert_financial_provider_command_outcome_fact()',
  'public.enforce_universal_v1_task_opportunity_interest_v1()',
  'public.record_task_ai_scope_outcome()',
  'public.validate_universal_v1_fake_financial_lifecycle_bridge()',
  'public.validate_universal_v1_fake_terminal_reconcile_command()',
  'public.enforce_universal_v1_fake_expiry_bridge_v9()',
  'public.validate_universal_v1_fake_terminal_lifecycle_intent()',
  'public.validate_universal_v1_fake_provider_account_fact()',
  'public.validate_fake_financial_legacy_expiry_compensation_v9()',
  'public.validate_fake_financial_legacy_expiry_disposition_v9()',
  'public.validate_fake_financial_legacy_expiry_noncompensable_v10()',
] as const;
export const WORK_ORDER_CORE_SHA_TRANSITIVE_DEPENDENCY_FUNCTIONS = [
  'public.universal_v1_relationship_deterministic_uuid(text)',
  'public.ensure_universal_v1_marketplace_relationship_origin(uuid)',
  'public.universal_v1_execution_command_request_sha256(uuid,uuid,text,integer,integer,text,timestamptz,text)',
  'public.universal_v1_task_opportunity_interest_request_sha256(uuid,uuid,integer,uuid,uuid,text)',
  'public.universal_v1_fake_terminal_operation_id_v1(text,text)',
  'public.universal_v1_fake_terminal_reconciliation_snapshot_sha256_v1(uuid)',
] as const;
export const WORK_ORDER_AUTHORITY_FUNCTIONS = [
  ...FAKE_FINANCIAL_WEBHOOK_FUNCTIONS,
  ...FAKE_FINANCIAL_WEBHOOK_DEPENDENCIES,
  ...FAKE_FINANCIAL_PUBLIC_PROGRESS_FUNCTIONS,
  ...FAKE_FINANCIAL_PREDECESSOR_FUNCTIONS,
  ...WORK_ORDER_HISTORY_FUNCTIONS,
  ...CHANGE_ORDER_HISTORY_FUNCTIONS,
  ...CHANGE_ORDER_COMMAND_FUNCTIONS,
  ...CHANGE_ORDER_MATERIALIZATION_FUNCTIONS,
  ...FAKE_FINANCIAL_PREPARATION_FUNCTIONS,
  ...FAKE_FINANCIAL_PREPARATION_DEPENDENCY_FUNCTIONS,
  WORK_ORDER_ASSERTION_ISSUER_FUNCTION,
  WORK_ORDER_ASSERTION_CONSUMER_FUNCTION,
  ...WORK_ORDER_ASSERTION_INTERNAL_FUNCTIONS,
  WORK_ORDER_BOOTSTRAP_SEAL_FUNCTION,
  ...WORK_ORDER_COMMAND_INTERNAL_FUNCTIONS,
  ...WORK_ORDER_COMMAND_DEPENDENCY_FUNCTIONS,
  ...WORK_ORDER_HUMAN_COMMAND_FUNCTIONS,
  ...WORK_ORDER_WORKER_COMMAND_FUNCTIONS,
  ...WORK_ORDER_FINANCE_TRIGGER_FUNCTIONS,
  ...WORK_ORDER_CORE_SHA_TRANSITIVE_TRIGGER_FUNCTIONS,
  ...WORK_ORDER_CORE_SHA_TRANSITIVE_DEPENDENCY_FUNCTIONS,
  WORK_ORDER_TELEMETRY_ENVIRONMENT_FUNCTION,
  WORK_ORDER_TARGET_ACTIVATION_FUNCTION,
  WORK_ORDER_RUNTIME_AUTHORITY_FUNCTION,
  ...WORK_ORDER_TELEMETRY_FUNCTIONS,
  ...FAKE_FINANCIAL_LIFECYCLE_TRIGGER_FUNCTIONS,
  FAKE_FINANCIAL_LIFECYCLE_DISPUTE_LOCK_FUNCTION,
  FAKE_FINANCIAL_LIFECYCLE_REVERSAL_FUNCTION,
  ...FAKE_FINANCIAL_OUTBOX_FUNCTIONS,
  FAKE_FINANCIAL_EXECUTION_DOMAIN_FUNCTION,
  FAKE_FINANCIAL_EXECUTION_DISPUTE_FUNCTION,
] as const;

// Kept as a compatibility alias for callers that identify the materialization
// command specifically. The verifier certifies the complete function family.
export const WORK_ORDER_COMMAND_FUNCTION = WORK_ORDER_HUMAN_COMMAND_FUNCTIONS[3];

// This is the exact direct dependency surface of this sealed Work Order port
// family: direct writes, mutable authority/read rows used by its lock helper,
// fake-finance witness inputs, and the major-action telemetry dependencies
// reached by its scope-version trigger. The narrowly granted UPDATE columns on
// lock inputs exist only because PostgreSQL requires UPDATE privilege to take
// FOR SHARE row locks. This is not the complete transitive lifecycle graph and
// does not claim that unrelated legacy, execution, fulfillment, change-order,
// completion/reconciliation, escrow, quote, or privacy writers are retired.
export const WORK_ORDER_ASSERTION_WRITE_RELATIONS = [
  'hx_authority.universal_v1_actor_assertion_issuance_facts',
  'hx_authority.universal_v1_actor_assertion_consumption_facts',
] as const;
export const WORK_ORDER_DOMAIN_WRITE_RELATIONS = [
  'public.tasks',
  'public.task_drafts',
  'public.task_scope_versions',
  'public.task_routing_decisions',
  'public.universal_v1_service_cell_authorities',
  'public.task_estimate_acceptance_materializations',
  'public.provider_estimate_submissions',
  'public.users',
  'public.task_work_order_command_requests',
  'public.task_provider_eligibility_decisions',
  'public.task_work_orders',
  'public.task_work_order_execution_facts',
  'public.task_reservations',
  'public.task_reservation_requests',
  'public.task_applications',
  'public.universal_v1_work_order_compensation_commands',
] as const;
export const WORK_ORDER_AUTHORITY_LOCK_RELATIONS = [
  'public.admin_roles',
  'public.capability_profiles',
  'public.business_organizations',
  'public.business_memberships',
  'public.business_credentials',
  'public.verified_trades',
  'public.current_verified_trade_qualifications',
] as const;
export const WORK_ORDER_BOOTSTRAP_READ_RELATIONS = [
  'public.hxos_fake_financial_schema_evidence_v12',
  'public.hxos_work_order_bootstrap_seal_evidence_v1',
  'public.hxos_fake_financial_schema_evidence_v13',
] as const;
export const WORK_ORDER_FINANCIAL_READ_RELATIONS = [
  'public.financial_provider_command_journal',
  'public.financial_provider_command_outcome_facts',
  'public.task_financial_security_events',
  'public.universal_v1_fake_financial_lifecycle_bridges',
] as const;
export const WORK_ORDER_TELEMETRY_RELATIONS = [
  'public.major_action_class_contracts',
  'public.major_action_events',
  'public.major_action_outcomes',
  'public.recommendations',
  'public.worker_offer_decisions',
  'public.worker_counter_offers',
] as const;
export const WORK_ORDER_TARGET_ACTIVATION_BARRIER_RELATIONS = [
  'public.hxos_universal_v1_work_order_target_activation_barrier_v1',
] as const;
export const WORK_ORDER_COMMAND_AUTHORITY_WRITE_RELATIONS = [
  'hx_authority.universal_v1_work_order_target_authority_facts',
  'hx_authority.universal_v1_work_order_command_execution_facts',
] as const;
export const WORK_ORDER_COMMAND_WRITE_RELATIONS = [
  ...CHANGE_ORDER_MATERIALIZATION_ADDITIONAL_RELATIONS,
  ...FAKE_FINANCIAL_WEBHOOK_RELATIONS,
  FAKE_FINANCIAL_PREPARATION_PROVENANCE,
  ...FAKE_FINANCIAL_PREPARATION_ADDITIONAL_RELATIONS,
  ...WORK_ORDER_ASSERTION_WRITE_RELATIONS,
  ...WORK_ORDER_DOMAIN_WRITE_RELATIONS,
  ...WORK_ORDER_AUTHORITY_LOCK_RELATIONS,
  ...WORK_ORDER_BOOTSTRAP_READ_RELATIONS,
  ...WORK_ORDER_FINANCIAL_READ_RELATIONS,
  ...WORK_ORDER_TELEMETRY_RELATIONS,
  ...WORK_ORDER_TARGET_ACTIVATION_BARRIER_RELATIONS,
  ...WORK_ORDER_COMMAND_AUTHORITY_WRITE_RELATIONS,
  ...FAKE_FINANCIAL_OUTBOX_RELATIONS,
  ...FAKE_FINANCIAL_LIFECYCLE_RELATIONS,
  ...FAKE_FINANCIAL_EXECUTION_RAW_RELATIONS,
  ...FAKE_FINANCIAL_EXECUTION_DOMAIN_RELATIONS,
  ...Object.keys(FAKE_FINANCIAL_OUTCOME_DEPENDENCY_COLUMNS),
  ...FAKE_FINANCIAL_OUTBOX_DEPENDENCY_RELATIONS,
  ...FAKE_FINANCIAL_BOOTSTRAP_METADATA_RELATIONS,
] as const;

// Trigger certification is structurally closed over the complete protected
// relation surface, including read/lock inputs whose integrity is authority for
// a sealed command. Relations without triggers contribute no catalog rows.
export const WORK_ORDER_TRIGGER_RELATIONS = WORK_ORDER_COMMAND_WRITE_RELATIONS;

export const WORK_ORDER_TRIGGER_CATALOG_COUNT = 348;

// Re-captured from a clean PG16 ordinal-146 + sealed v13 catalog after every trigger edge,
// owner class, SECURITY mode, and fixed path is canonicalized by the readback
// query below.  A migration changing even one edge must deliberately recapture
// this value and its focused PostgreSQL proof.
export const WORK_ORDER_TRIGGER_CATALOG_SHA256 =
  '93778ce6221d6403acff17c8afef32cd6a15f66dccb47de4719b799cb07f05fd';

// Re-captured from the exact PG16 ordinal-146 + v13 function family. Flags, owners,
// paths, and ACLs are checked independently; this digest closes source-body
// drift that could otherwise preserve superficial protocol fragments.
export const WORK_ORDER_AUTHORITY_FUNCTION_CATALOG_SHA256 =
  '7df21a11505d8269845bd85949b0e86836124fa11106021c2724895fddbf86be';

export const WORK_ORDER_ORDINAL146_SQL_SHA256 =
  '3920ac8d3208b9f573dc331cab60c373d0349611700c6e14a6e4c1dd8c53aac4';
export const WORK_ORDER_FAKE_FINANCIAL_V12_SQL_SHA256 =
  '5bb8ee72b9113146b88c22c6751ebe527ba6246b4463a8611ef9c24b999b7ac5';
export const WORK_ORDER_BOOTSTRAP_SEAL_SQL_SHA256 =
  'c69825589193885d0f6a3b93930880998e95e1c5cd44bb9b5999cb457192b2bd';
export const FAKE_FINANCIAL_OUTBOX_V13_SQL_SHA256 =
  '2449f38909588940089f50fa34de4c01b08bf8f449f1840579836fd37e083ff0';

export interface WorkOrderCommandRoleNames {
  migrationRole: string;
  apiRole: string;
  workerRole: string;
  attesterRole: string;
  commandOwnerRole: string;
  assertionOwnerRole: string;
  financeOwnerRole: string;
  telemetryOwnerRole: string;
}

type RoleKey = keyof WorkOrderCommandRoleNames;
export type WorkOrderCommandAuthorityVerifierRole =
  | 'migrationRole'
  | 'apiRole'
  | 'workerRole'
  | 'attesterRole';

export interface WorkOrderCommandRoleRow extends Record<string, unknown> {
  rolname: string;
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  database_owner?: boolean;
  member_of_roles: string[] | null;
  inherited_roles: string[] | null;
  public_schema_create: boolean;
  database_temp: boolean;
}

export interface WorkOrderCommandFunctionRow extends Record<string, unknown> {
  function_identity: string;
  function_oid: string | null;
  owner_role: string | null;
  security_definer: boolean | null;
  volatility: string | null;
  parallel_safety: string | null;
  configuration: string[] | null;
  argument_names: string[] | null;
  definition: string | null;
  migration_execute: boolean;
  api_execute: boolean;
  worker_execute: boolean;
  attester_execute: boolean;
  command_owner_execute: boolean;
  assertion_owner_execute: boolean;
  finance_owner_execute: boolean;
  telemetry_owner_execute: boolean;
  public_execute: boolean;
  execute_grantees: string[] | null;
}

export interface WorkOrderCommandRelationPrivilegeRow extends Record<string, unknown> {
  relation_name: string;
  owner_role: string | null;
  migration_insert: boolean;
  migration_update: boolean;
  migration_delete: boolean;
  migration_truncate: boolean;
  api_insert: boolean;
  api_update: boolean;
  api_delete: boolean;
  api_truncate: boolean;
  worker_insert: boolean;
  worker_update: boolean;
  worker_delete: boolean;
  worker_truncate: boolean;
  attester_insert: boolean;
  attester_update: boolean;
  attester_delete: boolean;
  attester_truncate: boolean;
  command_owner_insert: boolean;
  command_owner_update: boolean;
  command_owner_delete: boolean;
  command_owner_truncate: boolean;
  migration_any_column_update: boolean;
  api_any_column_update: boolean;
  worker_any_column_update: boolean;
  attester_any_column_update: boolean;
  command_owner_any_column_update: boolean;
  assertion_owner_any_column_update: boolean;
  finance_owner_any_column_update: boolean;
  telemetry_owner_any_column_update: boolean;
  command_owner_update_columns: string[] | null;
  assertion_owner_insert: boolean;
  assertion_owner_update: boolean;
  assertion_owner_delete: boolean;
  assertion_owner_truncate: boolean;
  finance_owner_insert: boolean;
  finance_owner_update: boolean;
  finance_owner_delete: boolean;
  finance_owner_truncate: boolean;
  telemetry_owner_insert: boolean;
  telemetry_owner_update: boolean;
  telemetry_owner_delete: boolean;
  telemetry_owner_truncate: boolean;
  acl_grants: string[] | null;
}

export interface WorkOrderCommandMembershipEdgeRow extends Record<string, unknown> {
  granted_role: string;
  member_role: string;
}

export interface WorkOrderCommandEffectiveRoleRow extends Record<string, unknown> {
  login_role: string;
  protected_role: string;
}

export interface WorkOrderCommandSchemaRow extends Record<string, unknown> {
  schema_name: string;
  owner_role: string | null;
  create_grantees: string[] | null;
}

export interface WorkOrderCommandTriggerCatalogRow extends Record<string, unknown> {
  trigger_count: number;
  trigger_catalog_sha256: string;
}

export interface WorkOrderCommandFunctionCatalogRow extends Record<string, unknown> {
  function_count: number;
  function_catalog_sha256: string;
}

export interface WorkOrderCommandLegacyDigestCallerRow extends Record<string, unknown> {
  function_identity: string;
  legacy_digest_definition: string;
}

export interface WorkOrderCommandDefaultPrivilegeRow extends Record<string, unknown> {
  owner_role: string;
  scope_name: string;
  object_kind: string;
  grants: string[] | null;
}

export interface WorkOrderCommandOwnedFunctionRow extends Record<string, unknown> {
  function_oid: string;
  function_identity: string;
  owner_role: string;
  protected_authority: boolean;
  protected_trigger: boolean;
  retained_custody_valid?: boolean;
}

export interface WorkOrderCommandBootstrapEvidenceRow extends Record<string, unknown> {
  evidence_row_count: number;
  evidence_v12_sha256: string | null;
  evidence_ordinal146_sha256: string | null;
  seal_evidence_row_count: number;
  seal_evidence_sha256: string | null;
  seal_evidence_ordinal146_sha256: string | null;
  seal_evidence_v12_sha256: string | null;
  v13_evidence_row_count: number;
  v13_evidence_sha256: string | null;
}

export interface WorkOrderCommandAuthorityEvidence {
  currentRole: string;
  sessionRole: string;
  backendPid: number;
  transactionIsolation: string;
  transactionReadOnly: boolean;
  searchPath: string;
  snapshotStable: boolean;
  roles: WorkOrderCommandRoleRow[];
  commandFunctions: WorkOrderCommandFunctionRow[];
  functionCatalog: WorkOrderCommandFunctionCatalogRow[];
  legacyDigestCallers: WorkOrderCommandLegacyDigestCallerRow[];
  webhookVerifier: { webhook_verifier_valid: boolean }[];
  ownedAuthorityFunctions: WorkOrderCommandOwnedFunctionRow[];
  relationPrivileges: WorkOrderCommandRelationPrivilegeRow[];
  membershipEdges: WorkOrderCommandMembershipEdgeRow[];
  effectiveRoleReachability: WorkOrderCommandEffectiveRoleRow[];
  schemas: WorkOrderCommandSchemaRow[];
  defaultPrivileges: WorkOrderCommandDefaultPrivilegeRow[];
  triggerCatalog: WorkOrderCommandTriggerCatalogRow[];
  bootstrapEvidence: WorkOrderCommandBootstrapEvidenceRow[];
}

export interface WorkOrderCommandAuthorityReport {
  status: 'READY' | 'BLOCKED';
  reasons: string[];
  roles: WorkOrderCommandRoleNames;
  functionIdentities: typeof WORK_ORDER_AUTHORITY_FUNCTIONS;
  protectedWriteRelations: typeof WORK_ORDER_COMMAND_WRITE_RELATIONS;
  actorBindingProven: boolean;
  currentRole: string;
  sessionRole: string;
}

interface FunctionPlan {
  identity: (typeof WORK_ORDER_AUTHORITY_FUNCTIONS)[number];
  owner:
    | 'migrationRole'
    | 'commandOwnerRole'
    | 'assertionOwnerRole'
    | 'financeOwnerRole'
    | 'telemetryOwnerRole';
  permittedExecute: ReadonlySet<RoleKey>;
  sourceKind: 'issuer' | 'consumer' | 'human' | 'worker' | 'internal' | 'dependency';
  securityDefiner: boolean;
  volatility: 'i' | 's' | 'v';
  parallelSafety: 's' | 'u';
  configuration: readonly string[] | null;
}

const SEALED_VOLATILE = {
  securityDefiner: true,
  volatility: 'v',
  parallelSafety: 'u',
  configuration: [FIXED_SEARCH_PATH],
} as const;

const FUNCTION_PLANS: readonly FunctionPlan[] = [
  ...CHANGE_ORDER_MATERIALIZATION_FUNCTIONS.map((identity): FunctionPlan => {
    const hash = CHANGE_ORDER_MATERIALIZATION_HASH_FUNCTIONS.some((value) => value === identity);
    const deferred = CHANGE_ORDER_MATERIALIZATION_DEFERRED_GUARDS.some(
      (value) => value === identity
    );
    const shared = identity === CHANGE_ORDER_MATERIALIZATION_WITNESS_HASH;
    return {
      identity,
      owner: shared ? 'migrationRole' : 'commandOwnerRole',
      permittedExecute: new Set<RoleKey>(
        shared
          ? ['migrationRole', 'commandOwnerRole', 'financeOwnerRole']
          : CHANGE_ORDER_MATERIALIZATION_PUBLIC_FUNCTIONS.some((value) => value === identity)
            ? ['commandOwnerRole', 'apiRole']
            : ['commandOwnerRole']
      ),
      sourceKind:
        hash || deferred
          ? 'dependency'
          : identity === CHANGE_ORDER_MATERIALIZATION_PUBLIC_FUNCTIONS[0]
            ? 'internal'
            : 'human',
      securityDefiner: !hash,
      volatility: hash ? 'i' : 'v',
      parallelSafety: hash ? 's' : 'u',
      configuration: [deferred ? FIXED_PUBLIC_SEARCH_PATH : FIXED_SEARCH_PATH],
    };
  }),
  ...CHANGE_ORDER_COMMAND_FUNCTIONS.map((identity): FunctionPlan => {
    const hash = CHANGE_ORDER_HASH_FUNCTIONS.some((value) => value === identity);
    return {
      identity,
      owner: 'commandOwnerRole',
      permittedExecute: new Set<RoleKey>(
        CHANGE_ORDER_PUBLIC_COMMAND_FUNCTIONS.some((value) => value === identity)
          ? ['commandOwnerRole', 'apiRole']
          : ['commandOwnerRole']
      ),
      sourceKind:
        identity === CHANGE_ORDER_PROPOSE_COMMAND || identity === CHANGE_ORDER_DECIDE_COMMAND
          ? 'human'
          : hash
            ? 'dependency'
            : 'internal',
      securityDefiner: !hash,
      volatility: hash ? 'i' : 'v',
      parallelSafety: hash ? 's' : 'u',
      configuration: [FIXED_SEARCH_PATH],
    };
  }),
  ...FAKE_FINANCIAL_WEBHOOK_FUNCTIONS.map(
    (identity): FunctionPlan => ({
      identity,
      owner: 'financeOwnerRole',
      permittedExecute: new Set<RoleKey>(
        identity === FAKE_FINANCIAL_WEBHOOK_INGRESS
          ? ['financeOwnerRole', 'apiRole']
          : ['financeOwnerRole']
      ),
      sourceKind: 'internal',
      ...SEALED_VOLATILE,
    })
  ),
  ...FAKE_FINANCIAL_WEBHOOK_DEPENDENCIES.map(
    (identity): FunctionPlan => ({
      identity,
      owner: 'migrationRole',
      permittedExecute: new Set<RoleKey>(['migrationRole', 'financeOwnerRole']),
      sourceKind: 'dependency',
      securityDefiner: false,
      volatility: 'v',
      parallelSafety: 'u',
      configuration: [FIXED_PUBLIC_SEARCH_PATH],
    })
  ),
  ...FAKE_FINANCIAL_PUBLIC_PROGRESS_FUNCTIONS.map(
    (identity): FunctionPlan => ({
      identity,
      owner:
        identity === FAKE_FINANCIAL_PUBLIC_PROGRESS_READER
          ? 'financeOwnerRole'
          : 'commandOwnerRole',
      permittedExecute: new Set<RoleKey>(
        identity === FAKE_FINANCIAL_PUBLIC_PROGRESS_READER
          ? ['financeOwnerRole', 'commandOwnerRole']
          : ['commandOwnerRole', 'apiRole']
      ),
      sourceKind: identity === FAKE_FINANCIAL_PUBLIC_PROGRESS_COMMAND ? 'human' : 'internal',
      ...SEALED_VOLATILE,
    })
  ),
  ...[...WORK_ORDER_HISTORY_FUNCTIONS, ...CHANGE_ORDER_HISTORY_FUNCTIONS].map(
    (identity): FunctionPlan => ({
      identity,
      owner: 'commandOwnerRole',
      permittedExecute: new Set<RoleKey>(['commandOwnerRole', 'apiRole']),
      sourceKind:
        identity === WORK_ORDER_HISTORY_COMMAND || identity === CHANGE_ORDER_HISTORY_COMMAND
          ? 'human'
          : 'internal',
      ...SEALED_VOLATILE,
    })
  ),
  ...FAKE_FINANCIAL_PREDECESSOR_FUNCTIONS.map(
    (identity): FunctionPlan => ({
      identity,
      owner:
        identity === FAKE_FINANCIAL_PREDECESSOR_READER ? 'financeOwnerRole' : 'commandOwnerRole',
      permittedExecute: new Set<RoleKey>(
        identity === FAKE_FINANCIAL_PREDECESSOR_READER
          ? ['financeOwnerRole', 'commandOwnerRole']
          : ['commandOwnerRole', 'apiRole']
      ),
      sourceKind: identity === FAKE_FINANCIAL_PREDECESSOR_COMMAND ? 'human' : 'internal',
      ...SEALED_VOLATILE,
    })
  ),
  ...FAKE_FINANCIAL_PREPARATION_FUNCTIONS.map(
    (identity): FunctionPlan => ({
      identity,
      owner: 'commandOwnerRole',
      permittedExecute: new Set<RoleKey>(
        identity === FAKE_FINANCIAL_PREPARATION_COMMAND ||
          identity === FAKE_FINANCIAL_PREPARATION_BUILDER
          ? ['commandOwnerRole', 'apiRole']
          : identity === FAKE_FINANCIAL_PREPARATION_INSERT
            ? ['commandOwnerRole', 'financeOwnerRole']
            : ['commandOwnerRole']
      ),
      sourceKind: identity === FAKE_FINANCIAL_PREPARATION_COMMAND ? 'human' : 'internal',
      ...SEALED_VOLATILE,
      configuration: [
        identity === FAKE_FINANCIAL_PREPARATION_INSERT
          ? FIXED_PUBLIC_SEARCH_PATH
          : FIXED_SEARCH_PATH,
      ],
    })
  ),
  ...FAKE_FINANCIAL_PREPARATION_DEPENDENCY_FUNCTIONS.map(
    (identity): FunctionPlan => ({
      identity,
      owner: 'migrationRole',
      permittedExecute: new Set<RoleKey>([
        'migrationRole',
        'commandOwnerRole',
        ...([
          ...CHANGE_ORDER_RECOVERY_OBSERVATION_DEPENDENCIES,
          ...CHANGE_ORDER_RECOVERY_COMPENSATION_DEPENDENCIES,
        ].some((dependency) => dependency === identity)
          ? ['financeOwnerRole' as const]
          : []),
      ]),
      sourceKind: 'dependency',
      securityDefiner: identity === 'public.business_membership_has_action(uuid,uuid,text)',
      volatility: identity === 'public.universal_v1_fake_terminal_plan_v1(text)' ? 'i' : 's',
      parallelSafety: identity === 'public.universal_v1_fake_terminal_plan_v1(text)' ? 's' : 'u',
      configuration: [FIXED_PUBLIC_SEARCH_PATH],
    })
  ),

  ...(
    [
      FAKE_FINANCIAL_RUNTIME_AUTHORITY_FUNCTION,
      ...FAKE_FINANCIAL_BOOTSTRAP_METADATA_FUNCTIONS,
    ] as const
  ).map(
    (identity): FunctionPlan => ({
      identity,
      owner: 'commandOwnerRole',
      permittedExecute: new Set<RoleKey>([
        'migrationRole',
        'apiRole',
        'workerRole',
        'attesterRole',
        'commandOwnerRole',
      ]),
      sourceKind: 'internal',
      securityDefiner: true,
      volatility: 's',
      parallelSafety: 's',
      configuration: [FIXED_SEARCH_PATH],
    })
  ),
  {
    identity: FAKE_FINANCIAL_EXECUTION_DOMAIN_FUNCTION,
    owner: 'commandOwnerRole',
    permittedExecute: new Set<RoleKey>(['commandOwnerRole', 'financeOwnerRole']),
    sourceKind: 'internal',
    ...SEALED_VOLATILE,
  },
  {
    identity: FAKE_FINANCIAL_EXECUTION_DISPUTE_FUNCTION,
    owner: 'migrationRole',
    permittedExecute: new Set<RoleKey>(['migrationRole', 'commandOwnerRole', 'financeOwnerRole']),
    sourceKind: 'dependency',
    securityDefiner: true,
    volatility: 's',
    parallelSafety: 'u',
    configuration: [FIXED_PUBLIC_SEARCH_PATH],
  },
  ...FAKE_FINANCIAL_LIFECYCLE_TRIGGER_FUNCTIONS.map(
    (identity): FunctionPlan => ({
      identity,
      owner: 'migrationRole',
      permittedExecute: new Set<RoleKey>(['migrationRole']),
      sourceKind: 'dependency',
      securityDefiner: false,
      volatility: 'v',
      parallelSafety: 'u',
      configuration: [
        identity === 'public.serialize_universal_v1_financial_security_task_v12()'
          ? FIXED_SEARCH_PATH
          : FIXED_PUBLIC_SEARCH_PATH,
      ],
    })
  ),
  {
    identity: FAKE_FINANCIAL_LIFECYCLE_DISPUTE_LOCK_FUNCTION,
    owner: 'migrationRole',
    permittedExecute: new Set<RoleKey>(['migrationRole', 'commandOwnerRole', 'financeOwnerRole']),
    sourceKind: 'dependency',
    securityDefiner: false,
    volatility: 'v',
    parallelSafety: 'u',
    configuration: [FIXED_PUBLIC_SEARCH_PATH],
  },
  {
    identity: FAKE_FINANCIAL_LIFECYCLE_REVERSAL_FUNCTION,
    owner: 'migrationRole',
    permittedExecute: new Set<RoleKey>(['migrationRole', 'financeOwnerRole']),
    sourceKind: 'dependency',
    securityDefiner: false,
    volatility: 's',
    parallelSafety: 'u',
    configuration: [FIXED_PUBLIC_SEARCH_PATH],
  },
  ...FAKE_FINANCIAL_OUTBOX_SUBMISSION_FUNCTIONS.map(
    (identity): FunctionPlan => ({
      identity,
      owner: 'financeOwnerRole',
      permittedExecute: new Set<RoleKey>(['apiRole', 'workerRole', 'financeOwnerRole']),
      sourceKind: 'internal',
      ...SEALED_VOLATILE,
    })
  ),
  ...FAKE_FINANCIAL_OUTBOX_WORKER_FUNCTIONS.map(
    (identity): FunctionPlan => ({
      identity,
      owner: 'financeOwnerRole',
      permittedExecute: new Set<RoleKey>(['workerRole', 'financeOwnerRole']),
      sourceKind: 'internal',
      ...SEALED_VOLATILE,
      volatility: identity === FAKE_FINANCIAL_RECOVERY_READER_FUNCTION ? 's' : 'v',
    })
  ),
  ...FAKE_FINANCIAL_OUTBOX_INVOKER_FUNCTIONS.map(
    (identity): FunctionPlan => ({
      identity,
      owner: 'financeOwnerRole',
      permittedExecute: new Set<RoleKey>(['financeOwnerRole']),
      sourceKind: 'internal',
      ...SEALED_VOLATILE,
      securityDefiner: false,
    })
  ),
  ...FAKE_FINANCIAL_OUTBOX_DEFINER_FUNCTIONS.map(
    (identity): FunctionPlan => ({
      identity,
      owner: 'financeOwnerRole',
      permittedExecute: new Set<RoleKey>(
        identity === CHANGE_ORDER_REVERSAL_EXECUTION_FUNCTION
          ? ['financeOwnerRole', 'commandOwnerRole']
          : ['financeOwnerRole']
      ),
      sourceKind: 'internal',
      ...SEALED_VOLATILE,
      volatility:
        identity === FAKE_FINANCIAL_RECOVERY_ADMISSION_FUNCTION ||
        identity === FAKE_FINANCIAL_OUTCOME_ADMISSION_FUNCTION
          ? 's'
          : 'v',
    })
  ),
  {
    identity: FAKE_FINANCIAL_OUTBOX_DIGEST_FUNCTION,
    owner: 'financeOwnerRole',
    permittedExecute: new Set<RoleKey>(['financeOwnerRole']),
    sourceKind: 'internal',
    securityDefiner: false,
    volatility: 'i',
    parallelSafety: 's',
    configuration: [FIXED_SEARCH_PATH],
  },
  {
    identity: WORK_ORDER_ASSERTION_ISSUER_FUNCTION,
    owner: 'assertionOwnerRole',
    permittedExecute: new Set<RoleKey>(['attesterRole', 'assertionOwnerRole']),
    sourceKind: 'issuer',
    ...SEALED_VOLATILE,
  },
  {
    identity: WORK_ORDER_ASSERTION_CONSUMER_FUNCTION,
    owner: 'assertionOwnerRole',
    permittedExecute: new Set<RoleKey>(['commandOwnerRole', 'assertionOwnerRole']),
    sourceKind: 'consumer',
    ...SEALED_VOLATILE,
  },
  ...WORK_ORDER_ASSERTION_INTERNAL_FUNCTIONS.map(
    (identity): FunctionPlan => ({
      identity,
      owner: 'assertionOwnerRole',
      permittedExecute: new Set<RoleKey>(['assertionOwnerRole']),
      sourceKind: 'internal',
      ...SEALED_VOLATILE,
    })
  ),
  {
    identity: WORK_ORDER_BOOTSTRAP_SEAL_FUNCTION,
    owner: 'commandOwnerRole',
    permittedExecute: new Set<RoleKey>(['commandOwnerRole']),
    sourceKind: 'internal',
    securityDefiner: true,
    volatility: 's',
    parallelSafety: 's',
    configuration: [FIXED_SEARCH_PATH],
  },
  ...WORK_ORDER_COMMAND_INTERNAL_FUNCTIONS.map(
    (identity, index): FunctionPlan => ({
      identity,
      owner: 'commandOwnerRole',
      permittedExecute: new Set<RoleKey>(
        index === 5 ? ['apiRole', 'commandOwnerRole'] : ['commandOwnerRole']
      ),
      sourceKind: 'internal',
      securityDefiner: true,
      volatility: index === 2 ? 's' : 'v',
      parallelSafety: index === 2 ? 's' : 'u',
      configuration: [FIXED_SEARCH_PATH],
    })
  ),
  {
    identity: WORK_ORDER_RUNTIME_AUTHORITY_FUNCTION,
    owner: 'commandOwnerRole',
    permittedExecute: new Set<RoleKey>([
      'migrationRole',
      'apiRole',
      'workerRole',
      'attesterRole',
      'commandOwnerRole',
    ]),
    sourceKind: 'internal',
    securityDefiner: true,
    volatility: 's',
    parallelSafety: 's',
    configuration: [FIXED_SEARCH_PATH],
  },
  ...WORK_ORDER_COMMAND_DEPENDENCY_FUNCTIONS.map((identity): FunctionPlan => {
    const isLock = identity === WORK_ORDER_COMMAND_DEPENDENCY_FUNCTIONS[2];
    const isOperationId = identity === WORK_ORDER_COMMAND_DEPENDENCY_FUNCTIONS[1];
    const isCurrentAuthority = identity === WORK_ORDER_COMMAND_DEPENDENCY_FUNCTIONS[3];
    const isExecutionDigest = identity === WORK_ORDER_COMMAND_DEPENDENCY_FUNCTIONS[4];
    const isFinancialCurrent = identity === WORK_ORDER_COMMAND_DEPENDENCY_FUNCTIONS[6];
    const isEffectiveExpiry = identity === WORK_ORDER_COMMAND_DEPENDENCY_FUNCTIONS[7];
    const isDeferredGenesis = identity === WORK_ORDER_COMMAND_DEPENDENCY_FUNCTIONS[8];
    const isHashHelper =
      identity === WORK_ORDER_COMMAND_DEPENDENCY_FUNCTIONS[9] ||
      identity === WORK_ORDER_COMMAND_DEPENDENCY_FUNCTIONS[10];
    const isImmutable =
      identity === WORK_ORDER_COMMAND_DEPENDENCY_FUNCTIONS[1] ||
      identity === WORK_ORDER_COMMAND_DEPENDENCY_FUNCTIONS[4] ||
      isFinancialCurrent;
    const isTaskProjection = identity === WORK_ORDER_COMMAND_DEPENDENCY_FUNCTIONS[5];
    const isSealedTriggerDependency = isTaskProjection || isDeferredGenesis;
    return {
      identity,
      owner:
        isLock || isSealedTriggerDependency || isHashHelper ? 'commandOwnerRole' : 'migrationRole',
      permittedExecute: new Set<RoleKey>(
        isHashHelper
          ? ['migrationRole', 'commandOwnerRole', 'financeOwnerRole', 'telemetryOwnerRole']
          : isLock || isSealedTriggerDependency
            ? ['commandOwnerRole']
            : isEffectiveExpiry || isFinancialCurrent || isCurrentAuthority
              ? ['migrationRole', 'commandOwnerRole', 'financeOwnerRole']
              : ['migrationRole', 'commandOwnerRole']
      ),
      sourceKind: 'dependency',
      securityDefiner: isLock || isSealedTriggerDependency,
      volatility:
        isHashHelper || isImmutable ? 'i' : isCurrentAuthority || isEffectiveExpiry ? 's' : 'v',
      parallelSafety:
        isHashHelper || isOperationId || isFinancialCurrent || isEffectiveExpiry ? 's' : 'u',
      configuration:
        isLock ||
        isOperationId ||
        isExecutionDigest ||
        isSealedTriggerDependency ||
        isFinancialCurrent ||
        isEffectiveExpiry
          ? [FIXED_PUBLIC_SEARCH_PATH]
          : isHashHelper
            ? [FIXED_SEARCH_PATH]
            : null,
    };
  }),
  ...WORK_ORDER_HUMAN_COMMAND_FUNCTIONS.map(
    (identity): FunctionPlan => ({
      identity,
      owner: 'commandOwnerRole',
      permittedExecute: new Set<RoleKey>(['apiRole', 'commandOwnerRole']),
      sourceKind: 'human',
      ...SEALED_VOLATILE,
    })
  ),
  ...WORK_ORDER_WORKER_COMMAND_FUNCTIONS.map(
    (identity): FunctionPlan => ({
      identity,
      owner: 'commandOwnerRole',
      permittedExecute: new Set<RoleKey>(['workerRole', 'commandOwnerRole']),
      sourceKind: 'worker',
      ...SEALED_VOLATILE,
    })
  ),
  ...WORK_ORDER_FINANCE_TRIGGER_FUNCTIONS.map(
    (identity): FunctionPlan => ({
      identity,
      owner: 'financeOwnerRole',
      permittedExecute: new Set<RoleKey>(['financeOwnerRole']),
      sourceKind: 'dependency',
      securityDefiner: true,
      volatility: 'v',
      parallelSafety: 'u',
      configuration: [FIXED_PUBLIC_SEARCH_PATH],
    })
  ),
  ...WORK_ORDER_CORE_SHA_TRANSITIVE_TRIGGER_FUNCTIONS.map(
    (identity): FunctionPlan => ({
      identity,
      owner: 'migrationRole',
      permittedExecute: new Set<RoleKey>(['migrationRole']),
      sourceKind: 'dependency',
      securityDefiner: false,
      volatility: 'v',
      parallelSafety: 'u',
      configuration: [
        identity === 'public.validate_fake_financial_legacy_expiry_noncompensable_v10()'
          ? FIXED_SEARCH_PATH
          : FIXED_PUBLIC_SEARCH_PATH,
      ],
    })
  ),
  ...WORK_ORDER_CORE_SHA_TRANSITIVE_DEPENDENCY_FUNCTIONS.map((identity): FunctionPlan => {
    const financeDependency =
      identity === WORK_ORDER_CORE_SHA_TRANSITIVE_DEPENDENCY_FUNCTIONS[4] ||
      identity === WORK_ORDER_CORE_SHA_TRANSITIVE_DEPENDENCY_FUNCTIONS[5];
    const stableDependency = identity === WORK_ORDER_CORE_SHA_TRANSITIVE_DEPENDENCY_FUNCTIONS[5];
    const volatileDependency = identity === WORK_ORDER_CORE_SHA_TRANSITIVE_DEPENDENCY_FUNCTIONS[1];
    const parallelSafe =
      identity !== WORK_ORDER_CORE_SHA_TRANSITIVE_DEPENDENCY_FUNCTIONS[1] &&
      identity !== WORK_ORDER_CORE_SHA_TRANSITIVE_DEPENDENCY_FUNCTIONS[2];
    return {
      identity,
      owner: financeDependency ? 'financeOwnerRole' : 'commandOwnerRole',
      permittedExecute: new Set<RoleKey>(
        financeDependency
          ? identity === 'public.universal_v1_fake_terminal_operation_id_v1(text,text)'
            ? ['financeOwnerRole', 'commandOwnerRole']
            : ['financeOwnerRole']
          : ['migrationRole', 'commandOwnerRole']
      ),
      sourceKind: 'dependency',
      securityDefiner: false,
      volatility: volatileDependency ? 'v' : stableDependency ? 's' : 'i',
      parallelSafety: parallelSafe ? 's' : 'u',
      configuration: [FIXED_PUBLIC_SEARCH_PATH],
    };
  }),
  {
    identity: WORK_ORDER_TELEMETRY_ENVIRONMENT_FUNCTION,
    owner: 'commandOwnerRole',
    permittedExecute: new Set<RoleKey>(['commandOwnerRole', 'telemetryOwnerRole']),
    sourceKind: 'dependency',
    ...SEALED_VOLATILE,
  },
  {
    identity: WORK_ORDER_TARGET_ACTIVATION_FUNCTION,
    owner: 'commandOwnerRole',
    permittedExecute: new Set<RoleKey>(['migrationRole', 'commandOwnerRole']),
    sourceKind: 'internal',
    ...SEALED_VOLATILE,
  },
  ...WORK_ORDER_TELEMETRY_FUNCTIONS.map(
    (identity): FunctionPlan => ({
      identity,
      owner: 'telemetryOwnerRole',
      permittedExecute: new Set<RoleKey>(['telemetryOwnerRole']),
      sourceKind: 'dependency',
      securityDefiner: true,
      volatility: 'v',
      parallelSafety: 'u',
      configuration: [FIXED_PUBLIC_SEARCH_PATH],
    })
  ),
];

const ROLE_ENVIRONMENT_VARIABLES: Readonly<Record<RoleKey, string>> = {
  migrationRole: 'HX_WORK_ORDER_MIGRATION_DATABASE_ROLE',
  apiRole: 'HX_WORK_ORDER_API_DATABASE_ROLE',
  workerRole: 'HX_WORK_ORDER_WORKER_DATABASE_ROLE',
  attesterRole: 'HX_WORK_ORDER_ATTESTER_DATABASE_ROLE',
  commandOwnerRole: 'HX_WORK_ORDER_COMMAND_OWNER_DATABASE_ROLE',
  assertionOwnerRole: 'HX_WORK_ORDER_ASSERTION_OWNER_DATABASE_ROLE',
  financeOwnerRole: 'HX_FINANCE_COMMAND_OWNER_DATABASE_ROLE',
  telemetryOwnerRole: 'HX_TELEMETRY_OWNER_DATABASE_ROLE',
};

const ROLE_LABELS: Readonly<Record<RoleKey, string>> = {
  migrationRole: 'MIGRATION',
  apiRole: 'API',
  workerRole: 'WORKER',
  attesterRole: 'ATTESTER',
  commandOwnerRole: 'COMMAND_OWNER',
  assertionOwnerRole: 'ASSERTION_OWNER',
  financeOwnerRole: 'FINANCE_OWNER',
  telemetryOwnerRole: 'TELEMETRY_OWNER',
};

const LOGIN_ROLE_KEYS: readonly RoleKey[] = [
  'migrationRole',
  'apiRole',
  'workerRole',
  'attesterRole',
];
const NOLOGIN_ROLE_KEYS: readonly RoleKey[] = [
  'commandOwnerRole',
  'assertionOwnerRole',
  'financeOwnerRole',
  'telemetryOwnerRole',
];
const NO_PUBLIC_CREATE_ROLE_KEYS: readonly RoleKey[] = [
  'apiRole',
  'workerRole',
  'attesterRole',
  ...NOLOGIN_ROLE_KEYS,
];
const DEFAULT_PRIVILEGE_OWNER_KEYS = [
  'migrationRole',
  'commandOwnerRole',
  'assertionOwnerRole',
  'financeOwnerRole',
  'telemetryOwnerRole',
] as const satisfies readonly RoleKey[];
const DEFAULT_PRIVILEGE_SCOPES = ['GLOBAL', 'public', 'hx_authority'] as const;
const DEFAULT_PRIVILEGE_OBJECT_KINDS = ['FUNCTION', 'TABLE', 'SEQUENCE'] as const;
const OWNER_DEFAULT_PRIVILEGES: Readonly<
  Record<(typeof DEFAULT_PRIVILEGE_OBJECT_KINDS)[number], readonly string[]>
> = {
  FUNCTION: ['EXECUTE'],
  TABLE: ['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'],
  SEQUENCE: ['USAGE'],
};
const EXECUTE_COLUMNS: Readonly<Record<RoleKey, keyof WorkOrderCommandFunctionRow>> = {
  migrationRole: 'migration_execute',
  apiRole: 'api_execute',
  workerRole: 'worker_execute',
  attesterRole: 'attester_execute',
  commandOwnerRole: 'command_owner_execute',
  assertionOwnerRole: 'assertion_owner_execute',
  financeOwnerRole: 'finance_owner_execute',
  telemetryOwnerRole: 'telemetry_owner_execute',
};

type WritePrivilege = 'insert' | 'update' | 'delete' | 'truncate';
type RelationRolePrefix =
  | 'migration'
  | 'api'
  | 'worker'
  | 'attester'
  | 'command_owner'
  | 'assertion_owner'
  | 'finance_owner'
  | 'telemetry_owner';

interface RelationPlan {
  relation: (typeof WORK_ORDER_COMMAND_WRITE_RELATIONS)[number];
  owner: RoleKey;
  permittedWrites: Readonly<Partial<Record<RoleKey, readonly WritePrivilege[]>>>;
  commandOwnerSelect: boolean;
  permittedCommandOwnerUpdateColumns: readonly string[];
  permittedColumnUpdates?: readonly { role: RoleKey; columns: readonly string[] }[];
  permittedColumnInserts?: readonly { role: RoleKey; columns: readonly string[] }[];
  permittedColumnSelects: readonly {
    role: RoleKey;
    columns: readonly string[];
  }[];
}

const WRITE_PRIVILEGES = ['insert', 'update', 'delete', 'truncate'] as const;
const ALL_WRITES: readonly WritePrivilege[] = WRITE_PRIVILEGES;
const RELATION_ROLE_PREFIXES: Readonly<Record<RoleKey, RelationRolePrefix>> = {
  migrationRole: 'migration',
  apiRole: 'api',
  workerRole: 'worker',
  attesterRole: 'attester',
  commandOwnerRole: 'command_owner',
  assertionOwnerRole: 'assertion_owner',
  financeOwnerRole: 'finance_owner',
  telemetryOwnerRole: 'telemetry_owner',
};
const ANY_COLUMN_UPDATE_COLUMNS: Readonly<
  Record<RoleKey, keyof WorkOrderCommandRelationPrivilegeRow>
> = {
  migrationRole: 'migration_any_column_update',
  apiRole: 'api_any_column_update',
  workerRole: 'worker_any_column_update',
  attesterRole: 'attester_any_column_update',
  commandOwnerRole: 'command_owner_any_column_update',
  assertionOwnerRole: 'assertion_owner_any_column_update',
  financeOwnerRole: 'finance_owner_any_column_update',
  telemetryOwnerRole: 'telemetry_owner_any_column_update',
};
const COMMAND_OWNER_DOMAIN_WRITES: Readonly<
  Record<(typeof WORK_ORDER_DOMAIN_WRITE_RELATIONS)[number], readonly WritePrivilege[]>
> = {
  'public.tasks': [],
  'public.task_drafts': [],
  'public.task_scope_versions': [],
  'public.task_routing_decisions': [],
  'public.universal_v1_service_cell_authorities': [],
  'public.task_estimate_acceptance_materializations': [],
  'public.provider_estimate_submissions': [],
  'public.users': [],
  'public.task_work_order_command_requests': ['insert'],
  'public.task_provider_eligibility_decisions': ['insert'],
  'public.task_work_orders': ['insert'],
  'public.task_work_order_execution_facts': ['insert'],
  'public.task_reservations': ['insert'],
  'public.task_reservation_requests': ['insert'],
  'public.task_applications': ['insert'],
  'public.universal_v1_work_order_compensation_commands': ['insert'],
};
const COMMAND_OWNER_DOMAIN_UPDATE_COLUMNS: Readonly<
  Record<(typeof WORK_ORDER_DOMAIN_WRITE_RELATIONS)[number], readonly string[]>
> = {
  'public.tasks': ['updated_at', 'work_order_id'],
  'public.task_drafts': ['id'],
  'public.task_scope_versions': ['id'],
  'public.task_routing_decisions': ['id'],
  'public.universal_v1_service_cell_authorities': ['id'],
  'public.task_estimate_acceptance_materializations': ['id'],
  'public.provider_estimate_submissions': ['id'],
  'public.users': ['id'],
  'public.task_work_order_command_requests': ['idempotency_key'],
  'public.task_provider_eligibility_decisions': ['id'],
  'public.task_work_orders': ['id'],
  'public.task_work_order_execution_facts': [],
  'public.task_reservations': ['status'],
  'public.task_reservation_requests': [],
  'public.task_applications': ['status'],
  'public.universal_v1_work_order_compensation_commands': [],
};
const COMMAND_OWNER_LOCK_UPDATE_COLUMNS: Readonly<
  Record<(typeof WORK_ORDER_AUTHORITY_LOCK_RELATIONS)[number], readonly string[]>
> = {
  'public.admin_roles': ['id'],
  'public.capability_profiles': ['user_id'],
  'public.business_organizations': ['id'],
  'public.business_memberships': ['id'],
  'public.business_credentials': ['id'],
  'public.verified_trades': ['id'],
  'public.current_verified_trade_qualifications': [],
};
const COMMAND_OWNER_FINANCIAL_LOCK_UPDATE_COLUMNS: Readonly<
  Record<(typeof WORK_ORDER_FINANCIAL_READ_RELATIONS)[number], readonly string[]>
> = {
  'public.financial_provider_command_journal': ['command_id'],
  'public.financial_provider_command_outcome_facts': [],
  'public.task_financial_security_events': ['id'],
  'public.universal_v1_fake_financial_lifecycle_bridges': ['bridge_id'],
};
const BASE_RELATION_PLANS: readonly RelationPlan[] = [
  ...FAKE_FINANCIAL_WEBHOOK_RELATIONS.map(
    (relation): RelationPlan => ({
      relation,
      owner:
        relation === FAKE_FINANCIAL_WEBHOOK_VERIFICATIONS ? 'financeOwnerRole' : 'migrationRole',
      permittedWrites:
        relation === FAKE_FINANCIAL_WEBHOOK_VERIFICATIONS
          ? { financeOwnerRole: ALL_WRITES }
          : {
              migrationRole: ALL_WRITES,
              financeOwnerRole: relation === FAKE_FINANCIAL_WEBHOOK_PROCESSING ? ['insert'] : [],
            },
      commandOwnerSelect: false,
      permittedCommandOwnerUpdateColumns: [],
      permittedColumnSelects:
        relation === FAKE_FINANCIAL_WEBHOOK_VERIFICATIONS
          ? []
          : [
              {
                role: 'financeOwnerRole',
                columns:
                  relation === FAKE_FINANCIAL_WEBHOOK_PROCESSING ? ['observation_id'] : ['*'],
              },
            ],
    })
  ),
  {
    relation: FAKE_FINANCIAL_PREPARATION_PROVENANCE,
    owner: 'commandOwnerRole',
    permittedWrites: { commandOwnerRole: ALL_WRITES },
    commandOwnerSelect: false,
    permittedCommandOwnerUpdateColumns: [],
    permittedColumnSelects: [
      { role: 'financeOwnerRole', columns: FAKE_FINANCIAL_PREPARATION_PROVENANCE_READ_COLUMNS },
    ],
  },
  ...CHANGE_ORDER_MATERIALIZATION_ADDITIONAL_RELATIONS.map(
    (relation): RelationPlan => ({
      relation,
      owner: 'migrationRole',
      permittedWrites: { migrationRole: ALL_WRITES },
      commandOwnerSelect: false,
      permittedCommandOwnerUpdateColumns: [],
      permittedColumnSelects: [],
    })
  ),
  ...FAKE_FINANCIAL_PREPARATION_ADDITIONAL_RELATIONS.map(
    (relation): RelationPlan => ({
      relation,
      owner: 'migrationRole',
      permittedWrites: { migrationRole: ALL_WRITES },
      commandOwnerSelect: false,
      permittedCommandOwnerUpdateColumns: [],
      permittedColumnSelects: FAKE_FINANCIAL_LIFECYCLE_DEPENDENCY_COLUMNS[relation]
        ? [
            {
              role: 'financeOwnerRole',
              columns: FAKE_FINANCIAL_LIFECYCLE_DEPENDENCY_COLUMNS[relation]!,
            },
          ]
        : [],
    })
  ),
  ...Object.entries(FAKE_FINANCIAL_OUTCOME_DEPENDENCY_COLUMNS).map(
    ([relation, columns]): RelationPlan => ({
      relation,
      owner: 'migrationRole',
      permittedWrites: { migrationRole: ALL_WRITES },
      commandOwnerSelect: false,
      permittedCommandOwnerUpdateColumns: [],
      permittedColumnSelects: [{ role: 'financeOwnerRole', columns }],
    })
  ),
  ...FAKE_FINANCIAL_BOOTSTRAP_METADATA_RELATIONS.map(
    (relation): RelationPlan => ({
      relation,
      owner: 'migrationRole',
      permittedWrites: { migrationRole: ALL_WRITES },
      commandOwnerSelect: false,
      permittedCommandOwnerUpdateColumns: [],
      permittedColumnSelects: [
        { role: 'commandOwnerRole', columns: fakeFinancialBootstrapMetadataColumns(relation) },
      ],
    })
  ),
  ...FAKE_FINANCIAL_OUTBOX_RELATIONS.map(
    (relation): RelationPlan => ({
      relation,
      owner: 'financeOwnerRole',
      permittedWrites: { financeOwnerRole: ALL_WRITES },
      commandOwnerSelect: false,
      permittedCommandOwnerUpdateColumns: [],
      permittedColumnSelects: [],
    })
  ),
  ...FAKE_FINANCIAL_LIFECYCLE_RELATIONS.map(
    (relation): RelationPlan => ({
      relation,
      owner: 'migrationRole',
      permittedWrites: {
        migrationRole: ALL_WRITES,
        financeOwnerRole: relation === 'public.task_financial_operations' ? ['insert'] : [],
      },
      commandOwnerSelect: false,
      permittedCommandOwnerUpdateColumns: [],
      permittedColumnSelects: [
        {
          role: 'financeOwnerRole',
          columns: FAKE_FINANCIAL_LIFECYCLE_DEPENDENCY_COLUMNS[relation]!,
        },
      ],
    })
  ),
  ...FAKE_FINANCIAL_EXECUTION_RAW_RELATIONS.map(
    (relation): RelationPlan => ({
      relation,
      owner: 'migrationRole',
      permittedWrites: { migrationRole: ALL_WRITES, financeOwnerRole: ['insert'] },
      commandOwnerSelect: false,
      permittedCommandOwnerUpdateColumns: [],
      permittedColumnSelects: [{ role: 'financeOwnerRole', columns: ['*'] }],
      permittedColumnUpdates: [
        {
          role: 'financeOwnerRole',
          columns:
            relation === 'public.hxos_fake_financial_operations_v1'
              ? ['operation_id']
              : ['event_id'],
        },
      ],
    })
  ),
  ...FAKE_FINANCIAL_EXECUTION_DOMAIN_RELATIONS.map(
    (relation): RelationPlan => ({
      relation,
      owner: 'migrationRole',
      permittedWrites: { migrationRole: ALL_WRITES },
      commandOwnerSelect:
        relation === 'public.universal_v1_fake_terminal_lifecycle_intents' ||
        relation === 'public.universal_v1_fake_provider_account_facts',
      permittedCommandOwnerUpdateColumns:
        relation === 'public.universal_v1_fake_terminal_lifecycle_intents'
          ? ['terminal_intent_id']
          : relation === 'public.universal_v1_fake_provider_account_facts'
            ? ['provider_account_fact_id']
            : [],
      permittedColumnSelects:
        relation === 'public.task_safety_incidents'
          ? [
              { role: 'commandOwnerRole', columns: ['task_id', 'status'] },
              { role: 'financeOwnerRole', columns: ['task_id', 'status'] },
            ]
          : [],
    })
  ),
  ...FAKE_FINANCIAL_OUTBOX_DEPENDENCY_RELATIONS.map(
    (relation): RelationPlan => ({
      relation,
      owner: 'migrationRole',
      permittedWrites: {
        migrationRole: ALL_WRITES,
        financeOwnerRole:
          relation === 'public.financial_provider_command_recovery_leases' ||
          relation === 'public.financial_provider_command_dispatch_attempts' ||
          relation === 'public.provider_event_inbox_observations' ||
          relation === 'public.provider_event_inbox_receipts'
            ? ['insert']
            : [],
      },
      commandOwnerSelect: relation === 'public.universal_v1_prepared_financial_commands',
      permittedCommandOwnerUpdateColumns:
        relation === 'public.universal_v1_prepared_financial_commands'
          ? ['prepared_command_id']
          : [],
      permittedColumnUpdates: [
        { role: 'financeOwnerRole', columns: FAKE_FINANCIAL_OUTBOX_LOCK_COLUMNS[relation] ?? [] },
      ],
      permittedColumnSelects:
        relation === 'public.applied_migrations'
          ? [
              { role: 'financeOwnerRole', columns: ['name', 'sha256'] },
              { role: 'commandOwnerRole', columns: ['name', 'sha256'] },
            ]
          : [{ role: 'financeOwnerRole', columns: ['*'] }],
    })
  ),
  ...WORK_ORDER_ASSERTION_WRITE_RELATIONS.map(
    (relation): RelationPlan => ({
      relation,
      owner: 'assertionOwnerRole',
      permittedWrites: { assertionOwnerRole: ALL_WRITES },
      commandOwnerSelect: false,
      permittedCommandOwnerUpdateColumns: [],
      permittedColumnSelects: [],
    })
  ),
  ...WORK_ORDER_DOMAIN_WRITE_RELATIONS.map(
    (relation): RelationPlan => ({
      relation,
      owner: 'migrationRole',
      permittedWrites: {
        migrationRole: ALL_WRITES,
        commandOwnerRole: COMMAND_OWNER_DOMAIN_WRITES[relation],
      },
      commandOwnerSelect: true,
      permittedCommandOwnerUpdateColumns: COMMAND_OWNER_DOMAIN_UPDATE_COLUMNS[relation],
      permittedColumnSelects: FAKE_FINANCIAL_LIFECYCLE_DEPENDENCY_COLUMNS[relation]
        ? [
            {
              role: 'financeOwnerRole',
              columns: FAKE_FINANCIAL_LIFECYCLE_DEPENDENCY_COLUMNS[relation]!,
            },
          ]
        : [],
      permittedColumnUpdates:
        relation === 'public.tasks' ? [{ role: 'financeOwnerRole', columns: ['id'] }] : [],
    })
  ),
  ...WORK_ORDER_AUTHORITY_LOCK_RELATIONS.map(
    (relation): RelationPlan => ({
      relation,
      owner: 'migrationRole',
      permittedWrites: { migrationRole: ALL_WRITES },
      commandOwnerSelect: true,
      permittedCommandOwnerUpdateColumns: COMMAND_OWNER_LOCK_UPDATE_COLUMNS[relation],
      permittedColumnSelects: [],
    })
  ),
  ...WORK_ORDER_BOOTSTRAP_READ_RELATIONS.map(
    (relation): RelationPlan => ({
      relation,
      owner: 'commandOwnerRole',
      permittedWrites: { commandOwnerRole: ALL_WRITES },
      commandOwnerSelect: false,
      permittedCommandOwnerUpdateColumns: [],
      permittedColumnSelects: [
        { role: 'migrationRole', columns: ['*'] },
        { role: 'financeOwnerRole', columns: ['*'] },
      ],
    })
  ),
  ...WORK_ORDER_FINANCIAL_READ_RELATIONS.map(
    (relation): RelationPlan => ({
      relation,
      owner: 'financeOwnerRole',
      permittedWrites: { financeOwnerRole: ALL_WRITES },
      commandOwnerSelect: true,
      permittedCommandOwnerUpdateColumns: COMMAND_OWNER_FINANCIAL_LOCK_UPDATE_COLUMNS[relation],
      permittedColumnSelects: [],
    })
  ),
  ...WORK_ORDER_TELEMETRY_RELATIONS.map(
    (relation): RelationPlan => ({
      relation,
      owner: 'migrationRole',
      permittedWrites: {
        migrationRole: ALL_WRITES,
        telemetryOwnerRole:
          relation === 'public.major_action_events' || relation === 'public.major_action_outcomes'
            ? ['insert']
            : [],
      },
      commandOwnerSelect: false,
      permittedCommandOwnerUpdateColumns: [],
      permittedColumnSelects: [
        {
          role: 'telemetryOwnerRole',
          columns: ['*'],
        },
      ],
    })
  ),
  ...WORK_ORDER_TARGET_ACTIVATION_BARRIER_RELATIONS.map(
    (relation): RelationPlan => ({
      relation,
      owner: 'commandOwnerRole',
      permittedWrites: { commandOwnerRole: ALL_WRITES },
      commandOwnerSelect: false,
      permittedCommandOwnerUpdateColumns: [],
      permittedColumnSelects: LOGIN_ROLE_KEYS.map((role) => ({ role, columns: ['*'] })),
    })
  ),
  ...WORK_ORDER_COMMAND_AUTHORITY_WRITE_RELATIONS.map(
    (relation): RelationPlan => ({
      relation,
      owner: 'commandOwnerRole',
      permittedWrites: { commandOwnerRole: ALL_WRITES },
      commandOwnerSelect: false,
      permittedCommandOwnerUpdateColumns: [],
      permittedColumnUpdates:
        relation === 'hx_authority.universal_v1_work_order_target_authority_facts'
          ? [{ role: 'financeOwnerRole', columns: FAKE_FINANCIAL_OUTBOX_LOCK_COLUMNS[relation]! }]
          : [],
      permittedColumnSelects:
        relation === 'hx_authority.universal_v1_work_order_target_authority_facts'
          ? [{ role: 'financeOwnerRole', columns: ['*'] }]
          : [],
    })
  ),
];

// Preserve existing owner and finance privileges; add only audited preparation dependencies.
const RELATION_PLANS: readonly RelationPlan[] = BASE_RELATION_PLANS.map((plan) => {
  const columns = FAKE_FINANCIAL_PREPARATION_READ_COLUMNS[plan.relation];
  const fullRead = columns?.includes('*') ?? false;
  return {
    ...plan,
    permittedColumnUpdates: [
      ...(plan.permittedColumnUpdates ?? []),
      ...(CHANGE_ORDER_RECOVERY_COMPENSATION_LOCK_COLUMNS[plan.relation]
        ? [
            {
              role: 'financeOwnerRole' as const,
              columns: CHANGE_ORDER_RECOVERY_COMPENSATION_LOCK_COLUMNS[plan.relation]!,
            },
          ]
        : []),
      ...(CHANGE_ORDER_RECOVERY_CLAIM_LOCK_COLUMNS[plan.relation]
        ? [
            {
              role: 'financeOwnerRole' as const,
              columns: CHANGE_ORDER_RECOVERY_CLAIM_LOCK_COLUMNS[plan.relation]!,
            },
          ]
        : []),
    ],
    permittedWrites:
      plan.relation === 'public.universal_v1_prepared_financial_commands'
        ? { ...plan.permittedWrites, commandOwnerRole: ['insert'] as const }
        : plan.permittedWrites,
    commandOwnerSelect: plan.commandOwnerSelect || fullRead,
    permittedCommandOwnerUpdateColumns: [
      ...new Set([
        ...plan.permittedCommandOwnerUpdateColumns,
        ...(FAKE_FINANCIAL_PREPARATION_LOCK_COLUMNS[plan.relation] ?? []),
        ...(CHANGE_ORDER_COMMAND_UPDATE_COLUMNS[plan.relation] ?? []),
        ...(CHANGE_ORDER_MATERIALIZATION_UPDATE_COLUMNS[plan.relation] ?? []),
      ]),
    ],
    permittedColumnSelects: [
      ...plan.permittedColumnSelects,
      ...(CHANGE_ORDER_RECOVERY_COMPENSATION_READ_COLUMNS[plan.relation]
        ? [
            {
              role: 'financeOwnerRole' as const,
              columns: CHANGE_ORDER_RECOVERY_COMPENSATION_READ_COLUMNS[plan.relation]!,
            },
          ]
        : []),
      ...(CHANGE_ORDER_RECOVERY_OBSERVATION_READ_COLUMNS[plan.relation]
        ? [
            {
              role: 'financeOwnerRole' as const,
              columns: CHANGE_ORDER_RECOVERY_OBSERVATION_READ_COLUMNS[plan.relation]!,
            },
          ]
        : []),
      ...(CHANGE_ORDER_MATERIALIZATION_READ_COLUMNS[plan.relation]
        ? [
            {
              role: 'commandOwnerRole' as const,
              columns: CHANGE_ORDER_MATERIALIZATION_READ_COLUMNS[plan.relation]!,
            },
          ]
        : []),
      ...(columns && !fullRead ? [{ role: 'commandOwnerRole' as const, columns }] : []),
      ...(CHANGE_ORDER_COMMAND_READ_COLUMNS[plan.relation]
        ? [
            {
              role: 'commandOwnerRole' as const,
              columns: CHANGE_ORDER_COMMAND_READ_COLUMNS[plan.relation]!,
            },
          ]
        : []),
    ],
    permittedColumnInserts: [
      ...(plan.permittedColumnInserts ?? []),
      ...(CHANGE_ORDER_RECOVERY_COMPENSATION_INSERT_COLUMNS[plan.relation]
        ? [
            {
              role: 'financeOwnerRole' as const,
              columns: CHANGE_ORDER_RECOVERY_COMPENSATION_INSERT_COLUMNS[plan.relation]!,
            },
          ]
        : []),
      ...(CHANGE_ORDER_RECOVERY_CLAIM_INSERT_COLUMNS[plan.relation]
        ? [
            {
              role: 'financeOwnerRole' as const,
              columns: CHANGE_ORDER_RECOVERY_CLAIM_INSERT_COLUMNS[plan.relation]!,
            },
          ]
        : []),
      ...(CHANGE_ORDER_MATERIALIZATION_INSERT_COLUMNS[plan.relation]
        ? [
            {
              role: 'commandOwnerRole' as const,
              columns: CHANGE_ORDER_MATERIALIZATION_INSERT_COLUMNS[plan.relation]!,
            },
          ]
        : []),
      ...(CHANGE_ORDER_COMMAND_INSERT_COLUMNS[plan.relation]
        ? [
            {
              role: 'commandOwnerRole' as const,
              columns: CHANGE_ORDER_COMMAND_INSERT_COLUMNS[plan.relation]!,
            },
          ]
        : []),
    ],
  };
});

function refuse(reason: string): never {
  throw new Error(`WORK_ORDER_COMMAND_AUTHORITY_REFUSED:${reason}`);
}

function requiredRole(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) return refuse(`${name}_REQUIRED`);
  if (!ROLE_IDENTIFIER.test(value)) return refuse(`${name}_INVALID`);
  return value;
}

/**
 * Resolve eight logical role identities without assigning physical names in
 * source. Role creation and credentials remain outside this verifier.
 */
export function configuredWorkOrderCommandRoles(env: Environment): WorkOrderCommandRoleNames {
  const roles = Object.fromEntries(
    (Object.entries(ROLE_ENVIRONMENT_VARIABLES) as [RoleKey, string][]).map(([key, name]) => [
      key,
      requiredRole(env, name),
    ])
  ) as unknown as WorkOrderCommandRoleNames;
  if (new Set(Object.values(roles)).size !== Object.keys(ROLE_ENVIRONMENT_VARIABLES).length) {
    return refuse('ROLES_MUST_BE_PAIRWISE_DISTINCT');
  }
  return roles;
}

interface WorkOrderCommandSnapshotIdentityRow extends Record<string, unknown> {
  current_role: string;
  session_role: string;
  backend_pid: number;
  transaction_isolation: string;
  transaction_read_only: boolean;
  search_path: string;
}

/** Read-only evidence; only invoked with the transaction-bound query below. */
async function readWorkOrderCommandAuthority(
  query: QueryFn,
  roles: WorkOrderCommandRoleNames
): Promise<WorkOrderCommandAuthorityEvidence> {
  const identity = await query<WorkOrderCommandSnapshotIdentityRow>(
    `SELECT current_user::text AS current_role,
            session_user::text AS session_role,
            pg_catalog.pg_backend_pid()::integer AS backend_pid,
            pg_catalog.current_setting('transaction_isolation')::text
              AS transaction_isolation,
            pg_catalog.current_setting('transaction_read_only')::boolean
              AS transaction_read_only,
            pg_catalog.current_setting('search_path')::text AS search_path`
  );
  if (identity.rowCount !== 1 || identity.rows.length !== 1) {
    return refuse('SESSION_IDENTITY_ROW_COUNT_INVALID');
  }

  const roleNames = Object.values(roles);
  const roleEvidence = await query<WorkOrderCommandRoleRow>(
    `SELECT role.rolname::text, role.rolcanlogin, role.rolsuper, role.rolcreaterole,
            role.rolcreatedb, role.rolreplication, role.rolbypassrls,
            EXISTS(SELECT 1 FROM pg_catalog.pg_database d
              WHERE d.datname=pg_catalog.current_database() AND d.datdba=role.oid) AS database_owner,
            COALESCE(ARRAY(
              SELECT inherited.rolname::text
                FROM pg_catalog.pg_roles inherited
               WHERE inherited.oid <> role.oid
                 AND pg_catalog.pg_has_role(role.oid, inherited.oid, 'MEMBER')
               ORDER BY inherited.rolname
            ), ARRAY[]::text[]) AS member_of_roles,
            COALESCE(ARRAY(
              SELECT inherited.rolname::text
                FROM pg_catalog.pg_roles inherited
               WHERE inherited.oid <> role.oid
                 AND pg_catalog.pg_has_role(role.oid, inherited.oid, 'USAGE')
               ORDER BY inherited.rolname
            ), ARRAY[]::text[]) AS inherited_roles,
            COALESCE(pg_catalog.has_schema_privilege(role.oid, 'public', 'CREATE'), false)
              AS public_schema_create,
            COALESCE(pg_catalog.has_database_privilege(
              role.oid, pg_catalog.current_database(), 'TEMP'
            ), false) AS database_temp
       FROM pg_catalog.pg_roles role
      WHERE role.rolname = ANY($1::text[])
      ORDER BY role.rolname`,
    [roleNames]
  );

  const functionEvidence = await query<WorkOrderCommandFunctionRow>(
    `WITH requested(function_identity) AS (
       SELECT pg_catalog.unnest($1::text[])
     ), function_catalog AS (
       SELECT procedure.oid AS function_oid,
              pg_catalog.replace(pg_catalog.replace(pg_catalog.format(
                '%I.%I(%s)', namespace.nspname, procedure.proname,
                pg_catalog.oidvectortypes(procedure.proargtypes)
              ), 'timestamp with time zone', 'timestamptz'), ', ', ',')
                AS function_identity
         FROM pg_catalog.pg_proc procedure
         JOIN pg_catalog.pg_namespace namespace
           ON namespace.oid = procedure.pronamespace
     ), target AS (
       SELECT requested.function_identity,
              function_catalog.function_oid
         FROM requested
         LEFT JOIN function_catalog
           ON function_catalog.function_identity = requested.function_identity
     )
     SELECT target.function_identity,
            procedure.oid::text AS function_oid,
            owner.rolname::text AS owner_role,
            procedure.prosecdef AS security_definer,
            procedure.provolatile::text AS volatility,
            procedure.proparallel::text AS parallel_safety,
            procedure.proconfig AS configuration,
            CASE WHEN procedure.proargmodes IS NULL THEN procedure.proargnames
                 ELSE ARRAY(
                   SELECT argument.name
                     FROM pg_catalog.unnest(procedure.proargnames) WITH ORDINALITY
                       AS argument(name, position)
                    WHERE procedure.proargmodes[argument.position::INTEGER] IN ('i','b','v')
                    ORDER BY argument.position
                 ) END AS argument_names,
            CASE WHEN procedure.oid IS NULL THEN NULL
              ELSE pg_catalog.pg_get_functiondef(procedure.oid)
            END AS definition,
            COALESCE((SELECT pg_catalog.has_function_privilege(role.oid, procedure.oid, 'EXECUTE')
                        FROM pg_catalog.pg_roles role WHERE role.rolname = $2), false)
              AS migration_execute,
            COALESCE((SELECT pg_catalog.has_function_privilege(role.oid, procedure.oid, 'EXECUTE')
                        FROM pg_catalog.pg_roles role WHERE role.rolname = $3), false)
              AS api_execute,
            COALESCE((SELECT pg_catalog.has_function_privilege(role.oid, procedure.oid, 'EXECUTE')
                        FROM pg_catalog.pg_roles role WHERE role.rolname = $4), false)
              AS worker_execute,
            COALESCE((SELECT pg_catalog.has_function_privilege(role.oid, procedure.oid, 'EXECUTE')
                        FROM pg_catalog.pg_roles role WHERE role.rolname = $5), false)
              AS attester_execute,
            COALESCE((SELECT pg_catalog.has_function_privilege(role.oid, procedure.oid, 'EXECUTE')
                        FROM pg_catalog.pg_roles role WHERE role.rolname = $6), false)
              AS command_owner_execute,
            COALESCE((SELECT pg_catalog.has_function_privilege(role.oid, procedure.oid, 'EXECUTE')
                        FROM pg_catalog.pg_roles role WHERE role.rolname = $7), false)
              AS assertion_owner_execute,
            COALESCE((SELECT pg_catalog.has_function_privilege(role.oid, procedure.oid, 'EXECUTE')
                        FROM pg_catalog.pg_roles role WHERE role.rolname = $8), false)
              AS finance_owner_execute,
            COALESCE((SELECT pg_catalog.has_function_privilege(role.oid, procedure.oid, 'EXECUTE')
                        FROM pg_catalog.pg_roles role WHERE role.rolname = $9), false)
              AS telemetry_owner_execute,
             CASE WHEN procedure.oid IS NULL THEN false ELSE COALESCE((
               SELECT bool_or(privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE')
                 FROM pg_catalog.aclexplode(COALESCE(
                   procedure.proacl,
                   pg_catalog.acldefault('f', procedure.proowner)
                 )) privilege
             ), false) END AS public_execute,
             CASE WHEN procedure.oid IS NULL THEN ARRAY[]::text[] ELSE COALESCE(ARRAY(
               SELECT CASE
                        WHEN privilege.grantee = 0 THEN 'PUBLIC'
                        ELSE grantee.rolname::text
                      END || CASE WHEN privilege.is_grantable
                                   THEN '|WITH_GRANT_OPTION'
                                   ELSE ''
                                 END
                 FROM pg_catalog.aclexplode(COALESCE(
                   procedure.proacl,
                   pg_catalog.acldefault('f', procedure.proowner)
                 )) privilege
                 LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid = privilege.grantee
                WHERE privilege.privilege_type = 'EXECUTE'
                ORDER BY 1
             ), ARRAY[]::text[]) END AS execute_grantees
       FROM target
       LEFT JOIN pg_catalog.pg_proc procedure ON procedure.oid = target.function_oid
       LEFT JOIN pg_catalog.pg_roles owner ON owner.oid = procedure.proowner
      ORDER BY target.function_identity`,
    [
      [...WORK_ORDER_AUTHORITY_FUNCTIONS],
      roles.migrationRole,
      roles.apiRole,
      roles.workerRole,
      roles.attesterRole,
      roles.commandOwnerRole,
      roles.assertionOwnerRole,
      roles.financeOwnerRole,
      roles.telemetryOwnerRole,
    ]
  );

  const functionCatalogEvidence = await query<WorkOrderCommandFunctionCatalogRow>(
    `WITH requested(function_identity) AS (
       SELECT pg_catalog.unnest($1::text[])
     ), function_catalog AS (
       SELECT procedure.oid AS function_oid,
              pg_catalog.replace(pg_catalog.replace(pg_catalog.format(
                '%I.%I(%s)', namespace.nspname, procedure.proname,
                pg_catalog.oidvectortypes(procedure.proargtypes)
              ), 'timestamp with time zone', 'timestamptz'), ', ', ',')
                AS function_identity
         FROM pg_catalog.pg_proc procedure
         JOIN pg_catalog.pg_namespace namespace
           ON namespace.oid = procedure.pronamespace
     ), canonical AS (
       SELECT requested.function_identity || '|' || COALESCE(
                pg_catalog.pg_get_functiondef(function_catalog.function_oid),
                '<MISSING>'
              ) AS line,
              function_catalog.function_oid IS NOT NULL AS present
         FROM requested
         LEFT JOIN function_catalog
           ON function_catalog.function_identity = requested.function_identity
     )
     SELECT (pg_catalog.count(*) FILTER (WHERE present))::integer AS function_count,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(
              pg_catalog.string_agg(line, E'\n' ORDER BY line), ''
            ), 'UTF8')), 'hex') AS function_catalog_sha256
       FROM canonical`,
    [[...WORK_ORDER_AUTHORITY_FUNCTIONS]]
  );

  const legacyDigestCallerEvidence = await query<WorkOrderCommandLegacyDigestCallerRow>(
    `WITH requested_authority_identity(function_identity) AS (
       SELECT pg_catalog.unnest($1::text[])
     ), function_catalog AS (
       SELECT procedure.oid AS function_oid,
              pg_catalog.replace(pg_catalog.replace(pg_catalog.format(
                '%I.%I(%s)', namespace.nspname, procedure.proname,
                pg_catalog.oidvectortypes(procedure.proargtypes)
              ), 'timestamp with time zone', 'timestamptz'), ', ', ',')
                AS function_identity
         FROM pg_catalog.pg_proc procedure
         JOIN pg_catalog.pg_namespace namespace
           ON namespace.oid = procedure.pronamespace
     ), requested_authority(function_oid) AS (
       SELECT function_catalog.function_oid
         FROM requested_authority_identity requested
         JOIN function_catalog
           ON function_catalog.function_identity = requested.function_identity
     ), protected_trigger(function_oid) AS (
       SELECT DISTINCT trigger_state.tgfoid
         FROM pg_catalog.pg_trigger trigger_state
         JOIN pg_catalog.pg_class relation_state
           ON relation_state.oid = trigger_state.tgrelid
         JOIN pg_catalog.pg_namespace namespace_state
           ON namespace_state.oid = relation_state.relnamespace
        WHERE trigger_state.tgisinternal IS FALSE
          AND pg_catalog.format('%I.%I', namespace_state.nspname, relation_state.relname)
                = ANY($2::text[])
     ), protected(function_oid) AS (
       SELECT function_oid FROM requested_authority
       UNION
       SELECT function_oid FROM protected_trigger
     )
     SELECT pg_catalog.replace(pg_catalog.replace(pg_catalog.format(
              '%I.%I(%s)', namespace.nspname, procedure.proname,
              pg_catalog.oidvectortypes(procedure.proargtypes)
            ), 'timestamp with time zone', 'timestamptz'), ', ', ',')
              AS function_identity,
            pg_catalog.pg_get_functiondef(procedure.oid) AS legacy_digest_definition
       FROM protected
       JOIN pg_catalog.pg_proc procedure ON procedure.oid = protected.function_oid
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
      WHERE procedure.prokind = 'f'
        AND pg_catalog.lower(pg_catalog.pg_get_functiondef(procedure.oid))
              ~ '(^|[^a-z0-9_])(public[.])?digest[[:space:]]*[(]'
      ORDER BY function_identity`,
    [[...WORK_ORDER_AUTHORITY_FUNCTIONS], [...WORK_ORDER_TRIGGER_RELATIONS]]
  );

  const webhookVerifierEvidence = await query<{ webhook_verifier_valid: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_language l ON l.oid=p.prolang
       JOIN pg_catalog.pg_depend d ON d.classid='pg_catalog.pg_proc'::pg_catalog.regclass
         AND d.objid=p.oid AND d.refclassid='pg_catalog.pg_extension'::pg_catalog.regclass AND d.deptype='e'
       JOIN pg_catalog.pg_extension e ON e.oid=d.refobjid
       WHERE p.oid=pg_catalog.to_regprocedure('public.hmac(bytea,bytea,text)')
         AND e.extname='pgcrypto' AND e.extversion='1.3' AND p.pronargdefaults=0 AND p.provariadic=0
         AND e.extnamespace='public'::pg_catalog.regnamespace
         AND l.lanname='c' AND p.prosrc='pg_hmac' AND p.probin='$libdir/pgcrypto'
         AND p.prorettype='bytea'::pg_catalog.regtype AND p.prokind='f'
         AND p.proisstrict AND NOT p.prosecdef AND p.provolatile='i' AND p.proparallel='s'
         AND p.proconfig IS NULL) AS webhook_verifier_valid`
  );
  const ownedFunctionEvidence = await query<WorkOrderCommandOwnedFunctionRow>(
    `WITH requested_authority_identity(function_identity) AS (
       SELECT pg_catalog.unnest($2::text[])
     ), retained_custody AS (
       SELECT * FROM pg_catalog.jsonb_to_recordset($4::jsonb)
         AS x(identity text, owner text, security_definer boolean, configuration text[], allowed_execute jsonb)
     ), function_catalog AS (
       SELECT procedure.oid AS function_oid,
              pg_catalog.replace(pg_catalog.replace(pg_catalog.format(
                '%I.%I(%s)', namespace.nspname, procedure.proname,
                pg_catalog.oidvectortypes(procedure.proargtypes)
              ), 'timestamp with time zone', 'timestamptz'), ', ', ',')
                AS function_identity
         FROM pg_catalog.pg_proc procedure
         JOIN pg_catalog.pg_namespace namespace
           ON namespace.oid = procedure.pronamespace
     ), requested_authority(function_oid) AS (
       SELECT function_catalog.function_oid
         FROM requested_authority_identity requested
         JOIN function_catalog
           ON function_catalog.function_identity = requested.function_identity
     ), protected_trigger(function_oid) AS (
       SELECT DISTINCT trigger_state.tgfoid
         FROM pg_catalog.pg_trigger trigger_state
         JOIN pg_catalog.pg_class relation_state
           ON relation_state.oid = trigger_state.tgrelid
         JOIN pg_catalog.pg_namespace namespace_state
           ON namespace_state.oid = relation_state.relnamespace
        WHERE trigger_state.tgisinternal IS FALSE
          AND pg_catalog.format('%I.%I', namespace_state.nspname, relation_state.relname)
                = ANY($1::text[])
     )
     SELECT procedure.oid::text AS function_oid,
            pg_catalog.replace(pg_catalog.replace(pg_catalog.format(
              '%I.%I(%s)',
              namespace.nspname,
              procedure.proname,
              pg_catalog.oidvectortypes(procedure.proargtypes)
            ), 'timestamp with time zone', 'timestamptz'), ', ', ',')
              AS function_identity,
            owner.rolname::text AS owner_role,
            requested_authority.function_oid IS NOT NULL AS protected_authority,
            protected_trigger.function_oid IS NOT NULL AS protected_trigger,
            (custody.identity IS NOT NULL AND owner.rolname=custody.owner
              AND procedure.prosecdef=custody.security_definer
              AND (NOT custody.security_definer OR
                procedure.proconfig=custody.configuration)
              AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(
                procedure.proacl,pg_catalog.acldefault('f',procedure.proowner))) a
                LEFT JOIN pg_catalog.pg_roles gr ON gr.oid=a.grantee
                WHERE a.grantee=0 OR NOT(custody.allowed_execute ? gr.rolname)
                  OR (a.is_grantable AND a.grantee<>procedure.proowner))
              AND NOT EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements_text(custody.allowed_execute) gr(role_name)
                WHERE NOT pg_catalog.has_function_privilege(gr.role_name,procedure.oid,'EXECUTE'))
            ) AS retained_custody_valid
       FROM pg_catalog.pg_proc procedure
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
       JOIN pg_catalog.pg_roles owner ON owner.oid = procedure.proowner
       LEFT JOIN function_catalog catalog ON catalog.function_oid=procedure.oid
       LEFT JOIN retained_custody custody ON custody.identity=catalog.function_identity
       LEFT JOIN requested_authority ON requested_authority.function_oid = procedure.oid
       LEFT JOIN protected_trigger ON protected_trigger.function_oid = procedure.oid
      WHERE owner.rolname = ANY($3::text[])
         OR requested_authority.function_oid IS NOT NULL
         OR protected_trigger.function_oid IS NOT NULL
      ORDER BY owner.rolname, function_identity`,
    [
      [...WORK_ORDER_TRIGGER_RELATIONS],
      [...WORK_ORDER_AUTHORITY_FUNCTIONS],
      [
        roles.migrationRole,
        roles.commandOwnerRole,
        roles.assertionOwnerRole,
        roles.financeOwnerRole,
        roles.telemetryOwnerRole,
      ],
      JSON.stringify(financialReadinessFunctionCustody(roles)),
    ]
  );

  const relationEvidence = await query<WorkOrderCommandRelationPrivilegeRow>(
    `WITH requested(relation_name) AS (
       SELECT pg_catalog.unnest($1::text[])
     ), relation_catalog AS (
       SELECT relation.oid AS relation_oid,
              pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
                AS relation_name
         FROM pg_catalog.pg_class relation
         JOIN pg_catalog.pg_namespace namespace
           ON namespace.oid = relation.relnamespace
     ), target AS (
       SELECT requested.relation_name,
              relation_catalog.relation_oid
         FROM requested
         LEFT JOIN relation_catalog
           ON relation_catalog.relation_name = requested.relation_name
     )
     SELECT target.relation_name,
            owner.rolname::text AS owner_role,
            COALESCE(pg_catalog.has_table_privilege(
              migration.oid, target.relation_oid, 'INSERT'
            ), false) AS migration_insert,
            COALESCE(pg_catalog.has_table_privilege(
              migration.oid, target.relation_oid, 'UPDATE'
            ), false) AS migration_update,
            COALESCE(pg_catalog.has_table_privilege(
              migration.oid, target.relation_oid, 'DELETE'
            ), false) AS migration_delete,
            COALESCE(pg_catalog.has_table_privilege(
              migration.oid, target.relation_oid, 'TRUNCATE'
            ), false) AS migration_truncate,
            COALESCE(pg_catalog.has_table_privilege(api.oid, target.relation_oid, 'INSERT'), false)
              AS api_insert,
            COALESCE(pg_catalog.has_table_privilege(api.oid, target.relation_oid, 'UPDATE'), false)
              AS api_update,
            COALESCE(pg_catalog.has_table_privilege(api.oid, target.relation_oid, 'DELETE'), false)
              AS api_delete,
            COALESCE(pg_catalog.has_table_privilege(api.oid, target.relation_oid, 'TRUNCATE'), false)
              AS api_truncate,
            COALESCE(pg_catalog.has_table_privilege(worker.oid, target.relation_oid, 'INSERT'), false)
              AS worker_insert,
            COALESCE(pg_catalog.has_table_privilege(worker.oid, target.relation_oid, 'UPDATE'), false)
              AS worker_update,
            COALESCE(pg_catalog.has_table_privilege(worker.oid, target.relation_oid, 'DELETE'), false)
              AS worker_delete,
            COALESCE(pg_catalog.has_table_privilege(worker.oid, target.relation_oid, 'TRUNCATE'), false)
              AS worker_truncate,
            COALESCE(pg_catalog.has_table_privilege(attester.oid, target.relation_oid, 'INSERT'), false)
              AS attester_insert,
            COALESCE(pg_catalog.has_table_privilege(attester.oid, target.relation_oid, 'UPDATE'), false)
              AS attester_update,
            COALESCE(pg_catalog.has_table_privilege(attester.oid, target.relation_oid, 'DELETE'), false)
              AS attester_delete,
            COALESCE(pg_catalog.has_table_privilege(attester.oid, target.relation_oid, 'TRUNCATE'), false)
              AS attester_truncate,
            COALESCE(pg_catalog.has_table_privilege(
              command_owner.oid, target.relation_oid, 'INSERT'
            ), false) AS command_owner_insert,
            COALESCE(pg_catalog.has_table_privilege(
              command_owner.oid, target.relation_oid, 'UPDATE'
            ), false) AS command_owner_update,
            COALESCE(pg_catalog.has_table_privilege(
              command_owner.oid, target.relation_oid, 'DELETE'
            ), false) AS command_owner_delete,
            COALESCE(pg_catalog.has_table_privilege(
              command_owner.oid, target.relation_oid, 'TRUNCATE'
            ), false) AS command_owner_truncate,
            COALESCE(pg_catalog.has_table_privilege(assertion_owner.oid, target.relation_oid, 'INSERT'), false)
              AS assertion_owner_insert,
            COALESCE(pg_catalog.has_table_privilege(assertion_owner.oid, target.relation_oid, 'UPDATE'), false)
              AS assertion_owner_update,
            COALESCE(pg_catalog.has_table_privilege(assertion_owner.oid, target.relation_oid, 'DELETE'), false)
              AS assertion_owner_delete,
            COALESCE(pg_catalog.has_table_privilege(assertion_owner.oid, target.relation_oid, 'TRUNCATE'), false)
              AS assertion_owner_truncate,
            COALESCE(pg_catalog.has_table_privilege(finance_owner.oid, target.relation_oid, 'INSERT'), false)
              AS finance_owner_insert,
            COALESCE(pg_catalog.has_table_privilege(finance_owner.oid, target.relation_oid, 'UPDATE'), false)
              AS finance_owner_update,
            COALESCE(pg_catalog.has_table_privilege(finance_owner.oid, target.relation_oid, 'DELETE'), false)
              AS finance_owner_delete,
            COALESCE(pg_catalog.has_table_privilege(finance_owner.oid, target.relation_oid, 'TRUNCATE'), false)
              AS finance_owner_truncate,
            COALESCE(pg_catalog.has_table_privilege(telemetry_owner.oid, target.relation_oid, 'INSERT'), false)
              AS telemetry_owner_insert,
            COALESCE(pg_catalog.has_table_privilege(telemetry_owner.oid, target.relation_oid, 'UPDATE'), false)
              AS telemetry_owner_update,
            COALESCE(pg_catalog.has_table_privilege(telemetry_owner.oid, target.relation_oid, 'DELETE'), false)
              AS telemetry_owner_delete,
            COALESCE(pg_catalog.has_table_privilege(telemetry_owner.oid, target.relation_oid, 'TRUNCATE'), false)
              AS telemetry_owner_truncate,
            COALESCE(pg_catalog.has_any_column_privilege(
              migration.oid, target.relation_oid, 'UPDATE'
            ), false) AS migration_any_column_update,
            COALESCE(pg_catalog.has_any_column_privilege(
              api.oid, target.relation_oid, 'UPDATE'
            ), false) AS api_any_column_update,
            COALESCE(pg_catalog.has_any_column_privilege(
              worker.oid, target.relation_oid, 'UPDATE'
            ), false) AS worker_any_column_update,
            COALESCE(pg_catalog.has_any_column_privilege(
              attester.oid, target.relation_oid, 'UPDATE'
            ), false) AS attester_any_column_update,
            COALESCE(pg_catalog.has_any_column_privilege(
              command_owner.oid, target.relation_oid, 'UPDATE'
            ), false) AS command_owner_any_column_update,
            COALESCE(pg_catalog.has_any_column_privilege(
              assertion_owner.oid, target.relation_oid, 'UPDATE'
            ), false) AS assertion_owner_any_column_update,
            COALESCE(pg_catalog.has_any_column_privilege(
              finance_owner.oid, target.relation_oid, 'UPDATE'
            ), false) AS finance_owner_any_column_update,
            COALESCE(pg_catalog.has_any_column_privilege(
              telemetry_owner.oid, target.relation_oid, 'UPDATE'
            ), false) AS telemetry_owner_any_column_update,
             COALESCE(ARRAY(
               SELECT attribute.attname::text
                FROM pg_catalog.pg_attribute attribute
               WHERE attribute.attrelid = target.relation_oid
                 AND attribute.attnum > 0
                 AND attribute.attisdropped IS FALSE
                 AND pg_catalog.has_column_privilege(
                   command_owner.oid,
                   target.relation_oid,
                   attribute.attnum,
                   'UPDATE'
                 )
                ORDER BY attribute.attname
             ), ARRAY[]::text[]) AS command_owner_update_columns,
             COALESCE(ARRAY(
               SELECT grant_state.grant_identity
                 FROM (
                   SELECT (
                     CASE WHEN privilege.grantee = 0
                       THEN 'PUBLIC'
                       ELSE grantee.rolname::text
                     END || '|' || privilege.privilege_type || '|*'
                         || CASE WHEN privilege.is_grantable
                                  THEN '|WITH_GRANT_OPTION'
                                  ELSE ''
                            END
                   ) AS grant_identity
                     FROM pg_catalog.aclexplode(COALESCE(
                       class.relacl,
                       pg_catalog.acldefault('r', class.relowner)
                     )) privilege
                     LEFT JOIN pg_catalog.pg_roles grantee
                       ON grantee.oid = privilege.grantee
                   UNION ALL
                   SELECT (
                     CASE WHEN privilege.grantee = 0
                       THEN 'PUBLIC'
                       ELSE grantee.rolname::text
                     END || '|' || privilege.privilege_type || '|' || attribute.attname
                         || CASE WHEN privilege.is_grantable
                                  THEN '|WITH_GRANT_OPTION'
                                  ELSE ''
                            END
                   ) AS grant_identity
                     FROM pg_catalog.pg_attribute attribute
                     CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) privilege
                     LEFT JOIN pg_catalog.pg_roles grantee
                       ON grantee.oid = privilege.grantee
                    WHERE attribute.attrelid = target.relation_oid
                      AND attribute.attnum > 0
                      AND attribute.attisdropped IS FALSE
                 ) grant_state
                ORDER BY grant_state.grant_identity
             ), ARRAY[]::text[]) AS acl_grants
       FROM target
       LEFT JOIN pg_catalog.pg_class class ON class.oid = target.relation_oid
       LEFT JOIN pg_catalog.pg_roles owner ON owner.oid = class.relowner
       LEFT JOIN pg_catalog.pg_roles migration ON migration.rolname = $2
       LEFT JOIN pg_catalog.pg_roles api ON api.rolname = $3
       LEFT JOIN pg_catalog.pg_roles worker ON worker.rolname = $4
       LEFT JOIN pg_catalog.pg_roles attester ON attester.rolname = $5
       LEFT JOIN pg_catalog.pg_roles command_owner ON command_owner.rolname = $6
       LEFT JOIN pg_catalog.pg_roles assertion_owner ON assertion_owner.rolname = $7
       LEFT JOIN pg_catalog.pg_roles finance_owner ON finance_owner.rolname = $8
       LEFT JOIN pg_catalog.pg_roles telemetry_owner ON telemetry_owner.rolname = $9
      ORDER BY target.relation_name`,
    [
      [...WORK_ORDER_COMMAND_WRITE_RELATIONS],
      roles.migrationRole,
      roles.apiRole,
      roles.workerRole,
      roles.attesterRole,
      roles.commandOwnerRole,
      roles.assertionOwnerRole,
      roles.financeOwnerRole,
      roles.telemetryOwnerRole,
    ]
  );

  let bootstrapEvidence: { rows: WorkOrderCommandBootstrapEvidenceRow[] } = {
    rows: [
      {
        evidence_row_count: 0,
        evidence_v12_sha256: null,
        evidence_ordinal146_sha256: null,
        seal_evidence_row_count: 0,
        seal_evidence_sha256: null,
        seal_evidence_ordinal146_sha256: null,
        seal_evidence_v12_sha256: null,
        v13_evidence_row_count: 0,
        v13_evidence_sha256: null,
      },
    ],
  };
  if (
    relationEvidence.rows.some(
      (relation) =>
        relation.relation_name === 'public.hxos_fake_financial_schema_evidence_v12' &&
        relation.owner_role !== null
    ) &&
    relationEvidence.rows.some(
      (relation) =>
        relation.relation_name === 'public.hxos_work_order_bootstrap_seal_evidence_v1' &&
        relation.owner_role !== null
    ) &&
    functionEvidence.rows.some(
      (functionRow) =>
        functionRow.function_identity === FAKE_FINANCIAL_RUNTIME_AUTHORITY_FUNCTION &&
        functionRow.function_oid !== null
    )
  ) {
    bootstrapEvidence = await query<WorkOrderCommandBootstrapEvidenceRow>(
      `SELECT 1::integer AS evidence_row_count,
              runtime.v12_sql_sha256 AS evidence_v12_sha256,
              runtime.ordinal146_sql_sha256 AS evidence_ordinal146_sha256,
              1::integer AS seal_evidence_row_count,
              runtime.seal_sql_sha256 AS seal_evidence_sha256,
              runtime.ordinal146_sql_sha256 AS seal_evidence_ordinal146_sha256,
              runtime.v12_sql_sha256 AS seal_evidence_v12_sha256,
              1::integer AS v13_evidence_row_count,
              runtime.v13_sql_sha256 AS v13_evidence_sha256
         FROM public.hxos_read_universal_v1_fake_financial_runtime_authority_v13()
                runtime`
    );
  }

  const membershipEvidence = await query<WorkOrderCommandMembershipEdgeRow>(
    `SELECT granted.rolname::text AS granted_role,
            member.rolname::text AS member_role
       FROM pg_catalog.pg_auth_members membership
       JOIN pg_catalog.pg_roles granted ON granted.oid = membership.roleid
       JOIN pg_catalog.pg_roles member ON member.oid = membership.member
      WHERE granted.rolname = ANY($1::text[])
         OR member.rolname = ANY($1::text[])
      ORDER BY granted.rolname, member.rolname`,
    [roleNames]
  );

  const effectiveRoleEvidence = await query<WorkOrderCommandEffectiveRoleRow>(
    `WITH protected AS (
       SELECT role.oid, role.rolname
         FROM pg_catalog.pg_roles role
        WHERE role.rolname = ANY($1::text[])
     )
     SELECT login.rolname::text AS login_role,
            protected.rolname::text AS protected_role
       FROM pg_catalog.pg_roles login
       CROSS JOIN protected
      WHERE login.rolcanlogin IS TRUE
        AND login.rolsuper IS FALSE
        AND login.oid <> protected.oid
        AND (
          pg_catalog.pg_has_role(login.oid, protected.oid, 'MEMBER')
          OR pg_catalog.pg_has_role(login.oid, protected.oid, 'USAGE')
          OR pg_catalog.pg_has_role(login.oid, protected.oid, 'SET')
        )
      ORDER BY login.rolname, protected.rolname`,
    [roleNames]
  );

  const schemaEvidence = await query<WorkOrderCommandSchemaRow>(
    `SELECT namespace.nspname::text AS schema_name,
            owner.rolname::text AS owner_role,
            COALESCE(ARRAY(
              SELECT CASE WHEN privilege.grantee = 0
                       THEN 'PUBLIC'
                       ELSE grantee.rolname::text
                     END || CASE WHEN privilege.is_grantable
                                  THEN '|WITH_GRANT_OPTION'
                                  ELSE ''
                                END
                FROM pg_catalog.aclexplode(COALESCE(
                  namespace.nspacl,
                  pg_catalog.acldefault('n', namespace.nspowner)
                )) privilege
                LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid = privilege.grantee
               WHERE privilege.privilege_type = 'CREATE'
               ORDER BY 1
            ), ARRAY[]::text[]) AS create_grantees
       FROM pg_catalog.pg_namespace namespace
       LEFT JOIN pg_catalog.pg_roles owner ON owner.oid = namespace.nspowner
      WHERE namespace.nspname = ANY(ARRAY['public','hx_authority']::text[])
      ORDER BY namespace.nspname`,
    []
  );

  const defaultPrivilegeEvidence = await query<WorkOrderCommandDefaultPrivilegeRow>(
    `WITH owners AS (
       SELECT role.oid AS owner_oid, role.rolname::text AS owner_role
         FROM pg_catalog.pg_roles role
        WHERE role.rolname = ANY($1::text[])
     ), scopes(scope_name) AS (
       SELECT pg_catalog.unnest(ARRAY['GLOBAL','public','hx_authority']::text[])
     ), object_kinds(acl_kind, object_kind) AS (
       VALUES ('f'::pg_catalog."char", 'FUNCTION'::text),
              ('r'::pg_catalog."char", 'TABLE'::text),
              ('S'::pg_catalog."char", 'SEQUENCE'::text)
     ), targets AS (
       SELECT owner.owner_oid, owner.owner_role, scope.scope_name,
              namespace.oid AS schema_oid, object_kind.acl_kind,
              object_kind.object_kind
         FROM owners owner
         CROSS JOIN scopes scope
         CROSS JOIN object_kinds object_kind
         LEFT JOIN pg_catalog.pg_namespace namespace
           ON namespace.nspname = scope.scope_name
          AND scope.scope_name <> 'GLOBAL'
     )
     SELECT target.owner_role, target.scope_name, target.object_kind,
            COALESCE(ARRAY(
              SELECT (
                       CASE WHEN privilege.grantee = 0 THEN 'PUBLIC'
                            ELSE COALESCE(grantee.rolname::text,
                              'OID_' || privilege.grantee::text)
                        END || '|' || privilege.privilege_type ||
                       CASE WHEN privilege.is_grantable
                              THEN '|WITH_GRANT_OPTION' ELSE '' END
                     )
                FROM pg_catalog.aclexplode(
                  CASE WHEN target.scope_name = 'GLOBAL'
                    THEN COALESCE(
                      default_acl.defaclacl,
                      pg_catalog.acldefault(target.acl_kind, target.owner_oid)
                    )
                    ELSE default_acl.defaclacl
                  END
                ) privilege
                LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid = privilege.grantee
               ORDER BY 1
            ), ARRAY[]::text[]) AS grants
       FROM targets target
       LEFT JOIN pg_catalog.pg_default_acl default_acl
         ON default_acl.defaclrole = target.owner_oid
        AND default_acl.defaclobjtype = target.acl_kind
        AND default_acl.defaclnamespace = CASE
              WHEN target.scope_name = 'GLOBAL' THEN 0::pg_catalog.oid
              ELSE target.schema_oid
            END
      ORDER BY target.owner_role, target.scope_name, target.object_kind`,
    [
      [
        roles.migrationRole,
        roles.commandOwnerRole,
        roles.assertionOwnerRole,
        roles.financeOwnerRole,
        roles.telemetryOwnerRole,
      ],
    ]
  );

  const triggerCatalogEvidence = await query<WorkOrderCommandTriggerCatalogRow>(
    `WITH trigger_rows AS (
       SELECT namespace.nspname,
              relation.relname,
              trigger_state.tgname,
              pg_catalog.format(
                '%I.%I(%s)', function_namespace.nspname, function_state.proname,
                pg_catalog.oidvectortypes(function_state.proargtypes)
              ) AS function_identity,
              pg_catalog.pg_get_triggerdef(trigger_state.oid, false) AS trigger_definition,
              trigger_state.tgenabled AS trigger_enabled,
              pg_catalog.pg_get_functiondef(function_state.oid) AS function_definition,
              CASE WHEN owner.rolname = $2 THEN 'EXPECTED:MIGRATION'
                   WHEN owner.rolname = $3 THEN 'EXPECTED:API'
                   WHEN owner.rolname = $4 THEN 'EXPECTED:WORKER'
                   WHEN owner.rolname = $5 THEN 'EXPECTED:ATTESTER'
                   WHEN owner.rolname = $6 THEN 'EXPECTED:COMMAND'
                   WHEN owner.rolname = $7 THEN 'EXPECTED:ASSERTION'
                   WHEN owner.rolname = $8 THEN 'EXPECTED:FINANCE'
                   WHEN owner.rolname = $9 THEN 'EXPECTED:TELEMETRY'
                   WHEN owner.rolname IS NULL THEN 'ABSENT'
                   ELSE 'UNEXPECTED:' ||
                        pg_catalog.octet_length(owner.rolname)::text || ':' || owner.rolname
               END AS owner_class,
              function_state.prosecdef,
              function_state.provolatile,
              function_state.proparallel,
              function_state.prosrc AS function_source,
              COALESCE(pg_catalog.array_to_string(function_state.proconfig, ','), 'NULL')
                AS function_configuration
         FROM pg_catalog.pg_trigger trigger_state
         JOIN pg_catalog.pg_class relation ON relation.oid = trigger_state.tgrelid
         JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
         JOIN pg_catalog.pg_proc function_state ON function_state.oid = trigger_state.tgfoid
         JOIN pg_catalog.pg_namespace function_namespace
           ON function_namespace.oid = function_state.pronamespace
         LEFT JOIN pg_catalog.pg_roles owner ON owner.oid = function_state.proowner
        WHERE trigger_state.tgisinternal IS FALSE
          AND pg_catalog.format('%I.%I', namespace.nspname, relation.relname) =
                ANY($1::text[])
     ), canonical AS (
       SELECT pg_catalog.concat_ws(
                '|', nspname, relname, tgname, function_identity,
                trigger_definition, trigger_enabled::text, function_definition,
                owner_class, prosecdef::text,
                provolatile::text, proparallel::text, function_configuration,
                function_source
              ) AS line
         FROM trigger_rows
     )
     SELECT (SELECT pg_catalog.count(*)::integer FROM canonical) AS trigger_count,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE((
              SELECT pg_catalog.string_agg(line, E'\n' ORDER BY line) FROM canonical
            ), ''), 'UTF8')), 'hex') AS trigger_catalog_sha256`,
    [
      [...WORK_ORDER_TRIGGER_RELATIONS],
      roles.migrationRole,
      roles.apiRole,
      roles.workerRole,
      roles.attesterRole,
      roles.commandOwnerRole,
      roles.assertionOwnerRole,
      roles.financeOwnerRole,
      roles.telemetryOwnerRole,
    ]
  );

  const endingIdentity = await query<WorkOrderCommandSnapshotIdentityRow>(
    `SELECT current_user::text AS current_role,
            session_user::text AS session_role,
            pg_catalog.pg_backend_pid()::integer AS backend_pid,
            pg_catalog.current_setting('transaction_isolation')::text
              AS transaction_isolation,
            pg_catalog.current_setting('transaction_read_only')::boolean
              AS transaction_read_only,
            pg_catalog.current_setting('search_path')::text AS search_path`
  );
  if (endingIdentity.rowCount !== 1 || endingIdentity.rows.length !== 1) {
    return refuse('ENDING_SESSION_IDENTITY_ROW_COUNT_INVALID');
  }
  const start = identity.rows[0]!;
  const end = endingIdentity.rows[0]!;

  return {
    currentRole: start.current_role,
    sessionRole: start.session_role,
    backendPid: start.backend_pid,
    transactionIsolation: start.transaction_isolation,
    transactionReadOnly: start.transaction_read_only,
    searchPath: start.search_path,
    snapshotStable:
      start.current_role === end.current_role &&
      start.session_role === end.session_role &&
      start.backend_pid === end.backend_pid &&
      start.transaction_isolation === end.transaction_isolation &&
      start.transaction_read_only === end.transaction_read_only &&
      start.search_path === end.search_path,
    roles: roleEvidence.rows,
    commandFunctions: functionEvidence.rows,
    functionCatalog: functionCatalogEvidence.rows,
    legacyDigestCallers: legacyDigestCallerEvidence.rows,
    webhookVerifier: webhookVerifierEvidence.rows,
    ownedAuthorityFunctions: ownedFunctionEvidence.rows,
    relationPrivileges: relationEvidence.rows,
    membershipEdges: membershipEvidence.rows,
    effectiveRoleReachability: effectiveRoleEvidence.rows,
    schemas: schemaEvidence.rows,
    defaultPrivileges: defaultPrivilegeEvidence.rows,
    triggerCatalog: triggerCatalogEvidence.rows,
    bootstrapEvidence: bootstrapEvidence.rows,
  };
}

function elevated(role: WorkOrderCommandRoleRow): boolean {
  return (
    role.rolsuper ||
    role.rolcreaterole ||
    role.rolcreatedb ||
    role.rolreplication ||
    role.rolbypassrls
  );
}

function normalizedDefinition(definition: string | null): string {
  return (
    definition
      ?.replace(/\/\*[\s\S]*?\*\//gu, ' ')
      .replace(/--[^\r\n]*/gu, ' ')
      .toLowerCase()
      .replace(/\s+/gu, ' ')
      .trim() ?? ''
  );
}

function hasAll(definition: string, fragments: readonly string[]): boolean {
  return fragments.every((fragment) => definition.includes(fragment));
}

function issuerProtocolProven(definition: string): boolean {
  return (
    hasAll(definition, [
      'pg_catalog.sha256(',
      'pg_catalog.convert_to(',
      'least(',
      'environment',
      'command_kind',
      'canonical_request_sha256',
      'verified_subject',
      'verified_auth_facts',
      'auth_facts_sha256',
      'release_manifest',
      'expires_at',
    ]) &&
    /(?:token_digest|token_sha256|assertion_token_sha256)/u.test(definition) &&
    /interval\s*'60 seconds'/u.test(definition) &&
    /(?:clock_timestamp|statement_timestamp)\s*\(/u.test(definition)
  );
}

function consumerProtocolProven(definition: string): boolean {
  return (
    hasAll(definition, [
      'pg_catalog.sha256(',
      'pg_catalog.convert_to(',
      'environment',
      'command_kind',
      'canonical_request_sha256',
      'verified_subject',
      'release_manifest',
      'target_authority',
      'target_authority_version',
      'target_database_name',
      'target_environment',
      'target_release_manifest',
      'expires_at',
      'firebase_uid',
    ]) &&
    /(?:token_digest|token_sha256|assertion_token_sha256)/u.test(definition) &&
    /insert\s+into\s+hx_authority\.universal_v1_actor_assertion_consumption_facts\b/u.test(
      definition
    ) &&
    /(?:clock_timestamp|statement_timestamp)\s*\(/u.test(definition)
  );
}

function callsAssertionConsumer(definition: string): boolean {
  return definition.includes('hx_authority.consume_universal_v1_actor_assertion_v1');
}

function usesRuntimeWritableActorSetting(definition: string): boolean {
  return /current_setting\s*\([^)]*hustlexp\.[^)]*actor/iu.test(definition);
}

function usesDynamicSql(definition: string): boolean {
  return /\bexecute\b/iu.test(definition);
}

function acceptsCallerActor(argumentNames: string[] | null): boolean {
  return (argumentNames ?? []).some((name) =>
    /^(?:p_)?(?:authenticated_)?actor(?:_user)?_id$/iu.test(name)
  );
}

function functionExecute(row: WorkOrderCommandFunctionRow, key: RoleKey): boolean {
  return Boolean(row[EXECUTE_COLUMNS[key]]);
}

function relationWritePresent(
  relation: WorkOrderCommandRelationPrivilegeRow,
  prefix: RelationRolePrefix,
  privilege: WritePrivilege
): boolean {
  return Boolean(relation[`${prefix}_${privilege}`]);
}

/**
 * Evaluate exact live evidence. Absence is a blocker; this routine never
 * creates roles, changes ownership, grants privileges, or mutates data.
 */
export function evaluateWorkOrderCommandAuthority(
  roles: WorkOrderCommandRoleNames,
  evidence: WorkOrderCommandAuthorityEvidence,
  verifierRole: WorkOrderCommandAuthorityVerifierRole = 'migrationRole'
): WorkOrderCommandAuthorityReport {
  const reasons: string[] = [];
  const byName = new Map(evidence.roles.map((role) => [role.rolname, role]));
  const expectedVerifierRole = roles[verifierRole];
  const verifierLabel = ROLE_LABELS[verifierRole];

  if (evidence.currentRole !== expectedVerifierRole) {
    reasons.push(`CURRENT_ROLE_IS_NOT_CONFIGURED_${verifierLabel}_ROLE`);
  }
  if (evidence.sessionRole !== expectedVerifierRole) {
    reasons.push(`SESSION_ROLE_IS_NOT_CONFIGURED_${verifierLabel}_ROLE`);
  }
  if (evidence.transactionIsolation !== 'repeatable read') {
    reasons.push('AUTHORITY_READBACK_NOT_REPEATABLE_READ');
  }
  if (!evidence.transactionReadOnly) {
    reasons.push('AUTHORITY_READBACK_NOT_READ_ONLY');
  }
  if (!evidence.snapshotStable) {
    reasons.push('AUTHORITY_READBACK_SNAPSHOT_SESSION_CHANGED');
  }
  if (evidence.searchPath !== 'pg_catalog') {
    reasons.push(`AUTHORITY_SEARCH_PATH_NOT_FIXED:${evidence.searchPath}`);
  }

  for (const roleKey of Object.keys(ROLE_ENVIRONMENT_VARIABLES) as RoleKey[]) {
    const label = ROLE_LABELS[roleKey];
    const role = byName.get(roles[roleKey]);
    if (!role) {
      reasons.push(`${label}_ROLE_NOT_FOUND`);
      continue;
    }
    if (elevated(role)) reasons.push(`${label}_ROLE_ELEVATED`);
    // PostgreSQL implicitly associates the current database owner with this built-in
    // role; this is not a grant in pg_auth_members. All actual edges still fail below.
    const unexpectedMembership = [
      ...(role.member_of_roles ?? []),
      ...(role.inherited_roles ?? []),
    ].some(
      (name) =>
        !(
          roleKey === 'commandOwnerRole' &&
          role.database_owner === true &&
          name === 'pg_database_owner'
        )
    );
    if (unexpectedMembership) {
      reasons.push(`${label}_ROLE_INHERITED_MEMBERSHIP_PRESENT`);
    }
    if (role.database_temp) reasons.push(`${label}_ROLE_CAN_CREATE_TEMP_OBJECTS`);
  }

  for (const roleKey of LOGIN_ROLE_KEYS) {
    const role = byName.get(roles[roleKey]);
    if (role && !role.rolcanlogin) reasons.push(`${ROLE_LABELS[roleKey]}_ROLE_MUST_LOGIN`);
  }
  for (const roleKey of NOLOGIN_ROLE_KEYS) {
    const role = byName.get(roles[roleKey]);
    if (role?.rolcanlogin) reasons.push(`${ROLE_LABELS[roleKey]}_ROLE_MUST_BE_NOLOGIN`);
  }
  for (const roleKey of NO_PUBLIC_CREATE_ROLE_KEYS) {
    const role = byName.get(roles[roleKey]);
    if (role?.public_schema_create) {
      reasons.push(`${ROLE_LABELS[roleKey]}_ROLE_CAN_CREATE_IN_PUBLIC_SCHEMA`);
    }
  }

  for (const edge of evidence.membershipEdges) {
    reasons.push(`PROTECTED_ROLE_MEMBERSHIP_EDGE:${edge.granted_role}:${edge.member_role}`);
  }
  for (const reachability of evidence.effectiveRoleReachability) {
    reasons.push(
      `UNEXPECTED_LOGIN_ROLE_REACHES_PROTECTED_ROLE:` +
        `${reachability.login_role}:${reachability.protected_role}`
    );
  }

  const schemas = new Map(evidence.schemas.map((schema) => [schema.schema_name, schema]));
  for (const [schemaName, ownerKey] of [
    ['public', 'migrationRole'],
    ['hx_authority', 'assertionOwnerRole'],
  ] as const) {
    const schema = schemas.get(schemaName);
    if (!schema) {
      reasons.push(`PROTECTED_SCHEMA_NOT_FOUND:${schemaName}`);
      continue;
    }
    const expectedOwner = roles[ownerKey];
    if (schema.owner_role !== expectedOwner) {
      reasons.push(
        `PROTECTED_SCHEMA_OWNER_MISMATCH:${schemaName}:${expectedOwner}:${schema.owner_role}`
      );
    }
    const actualCreate = [...(schema.create_grantees ?? [])].sort();
    const expectedCreate = [expectedOwner];
    if (
      actualCreate.length !== expectedCreate.length ||
      expectedCreate.some((role, index) => actualCreate[index] !== role)
    ) {
      reasons.push(
        `PROTECTED_SCHEMA_CREATE_ACL_MISMATCH:${schemaName}:` +
          `EXPECTED_${expectedCreate.join(',')}:ACTUAL_${actualCreate.join(',') || 'NONE'}`
      );
    }
  }

  const expectedDefaultPrivileges = new Map<string, readonly string[]>();
  for (const ownerKey of DEFAULT_PRIVILEGE_OWNER_KEYS) {
    const owner = roles[ownerKey];
    for (const scope of DEFAULT_PRIVILEGE_SCOPES) {
      for (const objectKind of DEFAULT_PRIVILEGE_OBJECT_KINDS) {
        expectedDefaultPrivileges.set(
          `${owner}|${scope}|${objectKind}`,
          scope === 'GLOBAL'
            ? OWNER_DEFAULT_PRIVILEGES[objectKind].map((privilege) => `${owner}|${privilege}`)
            : []
        );
      }
    }
  }
  const observedDefaultPrivileges = new Map<string, WorkOrderCommandDefaultPrivilegeRow>();
  for (const row of evidence.defaultPrivileges) {
    const key = `${row.owner_role}|${row.scope_name}|${row.object_kind}`;
    if (observedDefaultPrivileges.has(key)) {
      reasons.push(`DUPLICATE_DEFAULT_PRIVILEGE_TARGET:${key}`);
    }
    observedDefaultPrivileges.set(key, row);
    if (!expectedDefaultPrivileges.has(key)) {
      reasons.push(`UNEXPECTED_DEFAULT_PRIVILEGE_TARGET:${key}`);
    }
  }
  if (evidence.defaultPrivileges.length !== expectedDefaultPrivileges.size) {
    reasons.push(
      `DEFAULT_PRIVILEGE_ROW_COUNT_MISMATCH:` +
        `EXPECTED_${expectedDefaultPrivileges.size}:ACTUAL_${evidence.defaultPrivileges.length}`
    );
  }
  for (const [key, expectedGrants] of expectedDefaultPrivileges) {
    const actualGrants = [...(observedDefaultPrivileges.get(key)?.grants ?? [])].sort();
    const expected = [...expectedGrants].sort();
    if (
      actualGrants.length !== expected.length ||
      expected.some((grant, index) => actualGrants[index] !== grant)
    ) {
      reasons.push(
        `DEFAULT_PRIVILEGE_ACL_MISMATCH:${key}:` +
          `EXPECTED_${expected.join(',') || 'NONE'}:` +
          `ACTUAL_${actualGrants.join(',') || 'NONE'}`
      );
    }
  }

  if (
    evidence.functionCatalog.length !== 1 ||
    evidence.functionCatalog[0]?.function_count !== WORK_ORDER_AUTHORITY_FUNCTIONS.length ||
    evidence.functionCatalog[0]?.function_catalog_sha256 !==
      WORK_ORDER_AUTHORITY_FUNCTION_CATALOG_SHA256
  ) {
    reasons.push(
      `WORK_ORDER_AUTHORITY_FUNCTION_CATALOG_MISMATCH:` +
        `${evidence.functionCatalog[0]?.function_count ?? 0}:` +
        `${evidence.functionCatalog[0]?.function_catalog_sha256 ?? 'MISSING'}`
    );
  }

  for (const caller of evidence.legacyDigestCallers) {
    reasons.push(`PROTECTED_LEGACY_DIGEST_CALLER:${caller.function_identity}`);
  }
  if (
    evidence.webhookVerifier?.length !== 1 ||
    evidence.webhookVerifier[0]?.webhook_verifier_valid !== true
  ) {
    reasons.push('FAKE_FINANCIAL_WEBHOOK_VERIFIER_IDENTITY_INVALID');
  }

  if (
    evidence.triggerCatalog.length !== 1 ||
    evidence.triggerCatalog[0]?.trigger_count !== WORK_ORDER_TRIGGER_CATALOG_COUNT ||
    evidence.triggerCatalog[0]?.trigger_catalog_sha256 !== WORK_ORDER_TRIGGER_CATALOG_SHA256
  ) {
    reasons.push(
      `WORK_ORDER_TRIGGER_CATALOG_MISMATCH:` +
        `${evidence.triggerCatalog[0]?.trigger_count ?? 0}:` +
        `${evidence.triggerCatalog[0]?.trigger_catalog_sha256 ?? 'MISSING'}`
    );
  }

  const functions = new Map(evidence.commandFunctions.map((row) => [row.function_identity, row]));
  let actorBindingProven = true;
  for (const plan of FUNCTION_PLANS) {
    const row = functions.get(plan.identity);
    if (!row?.function_oid) {
      reasons.push(`FUNCTION_NOT_FOUND:${plan.identity}`);
      if (plan.sourceKind !== 'worker') actorBindingProven = false;
      continue;
    }
    if (row.owner_role !== roles[plan.owner]) {
      reasons.push(`FUNCTION_OWNER_MISMATCH:${plan.identity}`);
    }
    if (row.security_definer !== plan.securityDefiner) {
      reasons.push(
        `${plan.securityDefiner ? 'FUNCTION_NOT_SECURITY_DEFINER' : 'FUNCTION_UNEXPECTED_SECURITY_DEFINER'}:` +
          plan.identity
      );
    }
    if (row.volatility !== plan.volatility) {
      reasons.push(
        `FUNCTION_${plan.volatility === 'v' ? 'NOT_VOLATILE' : plan.volatility === 's' ? 'NOT_STABLE' : 'NOT_IMMUTABLE'}:` +
          plan.identity
      );
    }
    if (row.parallel_safety !== plan.parallelSafety) {
      reasons.push(
        `FUNCTION_NOT_PARALLEL_${plan.parallelSafety === 'u' ? 'UNSAFE' : 'SAFE'}:` + plan.identity
      );
    }
    const actualConfiguration = row.configuration ?? null;
    if (
      (plan.configuration === null && actualConfiguration !== null) ||
      (plan.configuration !== null &&
        (actualConfiguration === null ||
          actualConfiguration.length !== plan.configuration.length ||
          plan.configuration.some((value, index) => actualConfiguration[index] !== value)))
    ) {
      reasons.push(`FUNCTION_SEARCH_PATH_NOT_FIXED:${plan.identity}`);
    }
    if (row.public_execute) reasons.push(`PUBLIC_EXECUTE_MUST_BE_REVOKED:${plan.identity}`);
    const expectedExecuteGrantees = [...plan.permittedExecute]
      .map((roleKey) => roles[roleKey])
      .sort();
    const actualExecuteGrantees = [...(row.execute_grantees ?? [])].sort();
    if (
      expectedExecuteGrantees.length !== actualExecuteGrantees.length ||
      expectedExecuteGrantees.some((grantee, index) => actualExecuteGrantees[index] !== grantee)
    ) {
      reasons.push(
        `FUNCTION_EXECUTE_GRANTEE_SET_MISMATCH:${plan.identity}:` +
          `EXPECTED_${expectedExecuteGrantees.join(',')}:` +
          `ACTUAL_${actualExecuteGrantees.join(',') || 'NONE'}`
      );
    }

    for (const roleKey of Object.keys(EXECUTE_COLUMNS) as RoleKey[]) {
      const actual = functionExecute(row, roleKey);
      const expected = plan.permittedExecute.has(roleKey);
      if (expected && !actual) {
        reasons.push(`FUNCTION_EXECUTE_MISSING:${ROLE_LABELS[roleKey]}:${plan.identity}`);
      } else if (!expected && actual) {
        reasons.push(`FUNCTION_EXECUTE_MUST_BE_REVOKED:${ROLE_LABELS[roleKey]}:${plan.identity}`);
      }
    }

    const definition = normalizedDefinition(row.definition);
    if (usesRuntimeWritableActorSetting(definition)) {
      reasons.push(`RUNTIME_WRITABLE_ACTOR_SETTING_IS_NOT_AUTHORITY:${plan.identity}`);
      if (plan.sourceKind !== 'worker') actorBindingProven = false;
    }
    if (usesDynamicSql(definition)) {
      reasons.push(`DYNAMIC_SQL_NOT_ALLOWED:${plan.identity}`);
      if (plan.sourceKind !== 'worker') actorBindingProven = false;
    }
    if (plan.sourceKind === 'issuer' && !issuerProtocolProven(definition)) {
      reasons.push('ACTOR_ASSERTION_ISSUER_PROTOCOL_UNPROVEN');
      actorBindingProven = false;
    }
    if (plan.sourceKind === 'consumer' && !consumerProtocolProven(definition)) {
      reasons.push('ACTOR_ASSERTION_CONSUMER_PROTOCOL_UNPROVEN');
      actorBindingProven = false;
    }
    if (plan.sourceKind === 'human') {
      if (!callsAssertionConsumer(definition)) {
        reasons.push(`ACTOR_ASSERTION_CONSUMER_CALL_MISSING:${plan.identity}`);
        actorBindingProven = false;
      }
      if (acceptsCallerActor(row.argument_names)) {
        reasons.push(`CALLER_ACTOR_ARGUMENT_PRESENT:${plan.identity}`);
        actorBindingProven = false;
      }
    }
  }

  const expectedOwnerByOid = new Map<string, string>();
  const expectedIdentityByOid = new Map<string, string>();
  for (const plan of FUNCTION_PLANS) {
    const functionOid = functions.get(plan.identity)?.function_oid;
    if (!functionOid) continue;
    expectedOwnerByOid.set(functionOid, roles[plan.owner]);
    expectedIdentityByOid.set(functionOid, plan.identity);
  }
  const retainedCustody = new Map<
    string,
    ReturnType<typeof financialReadinessFunctionCustody>[number]
  >(financialReadinessFunctionCustody(roles).map((plan) => [plan.identity, plan]));
  for (const row of evidence.ownedAuthorityFunctions) {
    const custody = retainedCustody.get(row.function_identity);
    if (custody) {
      if (row.retained_custody_valid !== true)
        reasons.push('RETAINED_FUNCTION_CUSTODY_INVALID:' + row.function_identity);
      expectedOwnerByOid.set(row.function_oid, custody.owner);
      expectedIdentityByOid.set(row.function_oid, row.function_identity);
    }
    if (row.protected_trigger && !expectedOwnerByOid.has(row.function_oid)) {
      expectedOwnerByOid.set(row.function_oid, roles.migrationRole);
      expectedIdentityByOid.set(row.function_oid, row.function_identity);
    }
  }
  const observedOwnedFunctions = new Map<string, WorkOrderCommandOwnedFunctionRow>();
  for (const row of evidence.ownedAuthorityFunctions) {
    if (observedOwnedFunctions.has(row.function_oid)) {
      reasons.push(`DUPLICATE_AUTHORITY_OWNER_FUNCTION:${row.function_identity}`);
    }
    observedOwnedFunctions.set(row.function_oid, row);
  }
  for (const [functionOid, expectedOwner] of expectedOwnerByOid) {
    if (observedOwnedFunctions.get(functionOid)?.owner_role !== expectedOwner) {
      reasons.push(
        `AUTHORITY_OWNER_FUNCTION_INVENTORY_MISSING:${expectedOwner}:` +
          `${expectedIdentityByOid.get(functionOid) ?? functionOid}`
      );
    }
  }
  for (const row of evidence.ownedAuthorityFunctions) {
    if (expectedOwnerByOid.get(row.function_oid) !== row.owner_role) {
      reasons.push(`UNPLANNED_AUTHORITY_OWNER_FUNCTION:${row.owner_role}:${row.function_identity}`);
    }
  }

  const privileges = new Map(
    evidence.relationPrivileges.map((relation) => [relation.relation_name, relation])
  );
  for (const plan of RELATION_PLANS) {
    const relation = privileges.get(plan.relation);
    if (!relation?.owner_role) {
      reasons.push(`PROTECTED_RELATION_NOT_FOUND:${plan.relation}`);
      continue;
    }
    const expectedOwner = roles[plan.owner];
    if (relation.owner_role !== expectedOwner) {
      reasons.push(
        `PROTECTED_RELATION_OWNER_MISMATCH:${plan.relation}:` +
          `${ROLE_LABELS[plan.owner]}:${relation.owner_role}`
      );
    }
    for (const roleKey of Object.keys(RELATION_ROLE_PREFIXES) as RoleKey[]) {
      const expectedWrites = new Set(plan.permittedWrites[roleKey] ?? []);
      for (const privilege of WRITE_PRIVILEGES) {
        const actual = relationWritePresent(relation, RELATION_ROLE_PREFIXES[roleKey], privilege);
        const expected = expectedWrites.has(privilege);
        if (expected && !actual) {
          reasons.push(
            `RELATION_WRITE_MISSING:${ROLE_LABELS[roleKey]}:` +
              `${privilege.toUpperCase()}:${plan.relation}`
          );
        } else if (!expected && actual) {
          reasons.push(
            `RELATION_WRITE_MUST_BE_REVOKED:${ROLE_LABELS[roleKey]}:` +
              `${privilege.toUpperCase()}:${plan.relation}`
          );
        }
      }
      if (!expectedWrites.has('update')) {
        const additionalColumns = (plan.permittedColumnUpdates ?? [])
          .filter((grant) => grant.role === roleKey)
          .flatMap((grant) => grant.columns);
        if (roleKey === 'commandOwnerRole' || additionalColumns.length > 0) {
          const expectedColumns = [
            ...new Set([
              ...additionalColumns,
              ...(roleKey === 'commandOwnerRole' ? plan.permittedCommandOwnerUpdateColumns : []),
            ]),
          ].sort();
          const actualColumns =
            roleKey === 'commandOwnerRole'
              ? [...(relation.command_owner_update_columns ?? [])].sort()
              : (relation.acl_grants ?? [])
                  .filter((grant) => grant.startsWith(`${roles[roleKey]}|UPDATE|`))
                  .map((grant) => grant.split('|')[2]!)
                  .sort();
          if (
            expectedColumns.length !== actualColumns.length ||
            expectedColumns.some((column, index) => column !== actualColumns[index]) ||
            (expectedColumns.length > 0 && relation[ANY_COLUMN_UPDATE_COLUMNS[roleKey]] !== true)
          ) {
            reasons.push(
              `RELATION_COLUMN_UPDATE_MISMATCH:${ROLE_LABELS[roleKey]}:${plan.relation}:` +
                `EXPECTED_${expectedColumns.join(',') || 'NONE'}:` +
                `ACTUAL_${actualColumns.join(',') || 'NONE'}`
            );
          }
        } else if (relation[ANY_COLUMN_UPDATE_COLUMNS[roleKey]]) {
          reasons.push(
            `RELATION_COLUMN_UPDATE_MUST_BE_REVOKED:${ROLE_LABELS[roleKey]}:` + plan.relation
          );
        }
      }
    }

    const relationOwner = relation.owner_role;
    const allowedNonOwnerGrants = new Set<string>();
    for (const roleKey of Object.keys(RELATION_ROLE_PREFIXES) as RoleKey[]) {
      if (roles[roleKey] === relationOwner) continue;
      for (const privilege of plan.permittedWrites[roleKey] ?? []) {
        allowedNonOwnerGrants.add(`${roles[roleKey]}|${privilege.toUpperCase()}|*`);
      }
    }
    if (plan.commandOwnerSelect) {
      allowedNonOwnerGrants.add(`${roles.commandOwnerRole}|SELECT|*`);
      if (plan.relation === 'public.users') {
        for (const column of ['id', 'firebase_uid', 'account_status', 'is_minor', 'is_banned']) {
          allowedNonOwnerGrants.add(`${roles.assertionOwnerRole}|SELECT|${column}`);
        }
      }
    }
    for (const column of plan.permittedCommandOwnerUpdateColumns) {
      allowedNonOwnerGrants.add(`${roles.commandOwnerRole}|UPDATE|${column}`);
    }
    for (const read of plan.permittedColumnSelects) {
      for (const column of read.columns) {
        allowedNonOwnerGrants.add(`${roles[read.role]}|SELECT|${column}`);
      }
    }
    for (const update of plan.permittedColumnUpdates ?? []) {
      for (const column of update.columns) {
        allowedNonOwnerGrants.add(`${roles[update.role]}|UPDATE|${column}`);
      }
    }
    for (const insert of plan.permittedColumnInserts ?? []) {
      for (const column of insert.columns) {
        allowedNonOwnerGrants.add(`${roles[insert.role]}|INSERT|${column}`);
      }
    }
    for (const grant of relation.acl_grants ?? []) {
      const [grantee] = grant.split('|', 1);
      if (grantee === relationOwner) continue;
      if (!allowedNonOwnerGrants.has(grant)) {
        reasons.push(`UNEXPECTED_RELATION_ACL_GRANT:${plan.relation}:${grant}`);
      }
    }
    for (const expectedGrant of allowedNonOwnerGrants) {
      if (!(relation.acl_grants ?? []).includes(expectedGrant)) {
        reasons.push(`RELATION_ACL_GRANT_MISSING:${plan.relation}:${expectedGrant}`);
      }
    }
  }

  if (evidence.bootstrapEvidence.length !== 1) {
    reasons.push('BOOTSTRAP_EVIDENCE_SNAPSHOT_ROW_COUNT_INVALID');
  } else {
    const bootstrap = evidence.bootstrapEvidence[0]!;
    if (
      bootstrap.v13_evidence_row_count !== 1 ||
      bootstrap.v13_evidence_sha256 !== FAKE_FINANCIAL_OUTBOX_V13_SQL_SHA256
    ) {
      reasons.push('V13_EVIDENCE_DIGEST_MISMATCH');
    }
    if (bootstrap.evidence_row_count !== 1) {
      reasons.push('BOOTSTRAP_EVIDENCE_ROW_COUNT_MISMATCH');
    }
    if (bootstrap.evidence_ordinal146_sha256 !== WORK_ORDER_ORDINAL146_SQL_SHA256) {
      reasons.push('V12_EVIDENCE_ORDINAL146_DIGEST_MISMATCH');
    }
    if (bootstrap.evidence_v12_sha256 !== WORK_ORDER_FAKE_FINANCIAL_V12_SQL_SHA256) {
      reasons.push('V12_EVIDENCE_DIGEST_MISMATCH');
    }
    if (bootstrap.seal_evidence_row_count !== 1) {
      reasons.push('BOOTSTRAP_SEAL_EVIDENCE_ROW_COUNT_MISMATCH');
    }
    if (bootstrap.seal_evidence_sha256 !== WORK_ORDER_BOOTSTRAP_SEAL_SQL_SHA256) {
      reasons.push('BOOTSTRAP_SEAL_EVIDENCE_DIGEST_MISMATCH');
    }
    if (bootstrap.seal_evidence_ordinal146_sha256 !== WORK_ORDER_ORDINAL146_SQL_SHA256) {
      reasons.push('BOOTSTRAP_SEAL_ORDINAL146_DIGEST_MISMATCH');
    }
    if (bootstrap.seal_evidence_v12_sha256 !== WORK_ORDER_FAKE_FINANCIAL_V12_SQL_SHA256) {
      reasons.push('BOOTSTRAP_SEAL_V12_DIGEST_MISMATCH');
    }
  }

  return {
    status: reasons.length === 0 ? 'READY' : 'BLOCKED',
    reasons,
    roles,
    functionIdentities: WORK_ORDER_AUTHORITY_FUNCTIONS,
    protectedWriteRelations: WORK_ORDER_COMMAND_WRITE_RELATIONS,
    actorBindingProven,
    currentRole: evidence.currentRole,
    sessionRole: evidence.sessionRole,
  };
}

export async function verifyWorkOrderCommandAuthority(
  transaction: WorkOrderCommandAuthorityTransaction,
  env: Environment,
  verifierRole: WorkOrderCommandAuthorityVerifierRole = 'migrationRole'
): Promise<WorkOrderCommandAuthorityReport> {
  return transaction(async (query) => {
    await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    await query('SET LOCAL search_path = pg_catalog');
    return verifyWorkOrderCommandAuthorityInCurrentSnapshot(query, env, verifierRole);
  });
}

/**
 * Certify within a caller-owned snapshot. The caller must already own one
 * physical session, establish REPEATABLE READ READ ONLY with pg_catalog as the
 * local search path, and take any boundary lock that must precede the first
 * snapshot read. This helper intentionally emits no transaction/session SQL.
 */
export async function verifyWorkOrderCommandAuthorityInCurrentSnapshot(
  query: QueryFn,
  env: Environment,
  verifierRole: WorkOrderCommandAuthorityVerifierRole = 'migrationRole'
): Promise<WorkOrderCommandAuthorityReport> {
  const roles = configuredWorkOrderCommandRoles(env);
  return evaluateWorkOrderCommandAuthority(
    roles,
    await readWorkOrderCommandAuthority(query, roles),
    verifierRole
  );
}
