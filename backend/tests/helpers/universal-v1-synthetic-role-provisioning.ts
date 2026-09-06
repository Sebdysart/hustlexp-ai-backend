import {
  CHANGE_ORDER_RECOVERY_OBSERVATION_READ_COLUMNS,
  CHANGE_ORDER_RECOVERY_OBSERVATION_DEPENDENCIES,
} from '../../src/jobs/change-order-recovery-role-plans.js';
import {
  CHANGE_ORDER_RECOVERY_CLAIM_INSERT_COLUMNS,
  CHANGE_ORDER_RECOVERY_CLAIM_LOCK_COLUMNS,
} from '../../src/jobs/change-order-recovery-role-plans.js';
import {
  CHANGE_ORDER_MATERIALIZATION_ADDITIONAL_RELATIONS,
  CHANGE_ORDER_MATERIALIZATION_FUNCTIONS,
  CHANGE_ORDER_MATERIALIZATION_PUBLIC_FUNCTIONS,
  CHANGE_ORDER_MATERIALIZATION_WITNESS_HASH,
  CHANGE_ORDER_MATERIALIZATION_READ_COLUMNS,
  CHANGE_ORDER_MATERIALIZATION_INSERT_COLUMNS,
  CHANGE_ORDER_MATERIALIZATION_UPDATE_COLUMNS,
} from '../../src/jobs/change-order-materialization-role-plans.js';
import { CHANGE_ORDER_HISTORY_FUNCTIONS } from '../../src/jobs/change-order-history-role-plans.js';
import {
  CHANGE_ORDER_COMMAND_FUNCTIONS,
  CHANGE_ORDER_PUBLIC_COMMAND_FUNCTIONS,
  CHANGE_ORDER_COMMAND_READ_COLUMNS,
  CHANGE_ORDER_COMMAND_INSERT_COLUMNS,
  CHANGE_ORDER_COMMAND_UPDATE_COLUMNS,
} from '../../src/jobs/change-order-command-role-plans.js';
import {
  FINANCIAL_READINESS_DEFERRED_GUARDS,
  FINANCIAL_READINESS_STORAGE,
  financialReadinessFunctionCustody,
} from '../../src/jobs/financial-readiness-custody.js';
import { WORK_ORDER_HISTORY_FUNCTIONS } from '../../src/jobs/work-order-history-role-plans.js';
import {
  FAKE_FINANCIAL_PREDECESSOR_READER,
  FAKE_FINANCIAL_PREDECESSOR_FUNCTIONS,
} from '../../src/jobs/fake-financial-predecessor-role-plans.js';
import {
  FAKE_FINANCIAL_WEBHOOK_INGRESS,
  FAKE_FINANCIAL_WEBHOOK_FUNCTIONS,
  FAKE_FINANCIAL_WEBHOOK_DEPENDENCIES,
  FAKE_FINANCIAL_WEBHOOK_KEYS,
  FAKE_FINANCIAL_WEBHOOK_REVOCATIONS,
  FAKE_FINANCIAL_WEBHOOK_VERIFICATIONS,
  FAKE_FINANCIAL_WEBHOOK_PROCESSING,
  FAKE_FINANCIAL_WEBHOOK_RELATIONS,
} from '../../src/jobs/fake-financial-webhook-role-plans.js';
import {
  FAKE_FINANCIAL_PUBLIC_PROGRESS_READER,
  FAKE_FINANCIAL_PUBLIC_PROGRESS_FUNCTIONS,
} from '../../src/jobs/fake-financial-public-progress-role-plans.js';
import {
  FAKE_FINANCIAL_PREPARATION_COMMAND,
  FAKE_FINANCIAL_PREPARATION_BUILDER,
  FAKE_FINANCIAL_PREPARATION_FUNCTIONS,
  FAKE_FINANCIAL_PREPARATION_DEPENDENCY_FUNCTIONS,
  FAKE_FINANCIAL_PREPARATION_PROVENANCE,
  FAKE_FINANCIAL_PREPARATION_PROVENANCE_READ_COLUMNS,
  FAKE_FINANCIAL_PREPARATION_ADDITIONAL_RELATIONS,
  FAKE_FINANCIAL_PREPARATION_READ_COLUMNS,
  FAKE_FINANCIAL_PREPARATION_LOCK_COLUMNS,
} from '../../src/jobs/fake-financial-preparation-role-plans.js';
import type pg from 'pg';
import {
  WORK_ORDER_CORE_SHA_TRANSITIVE_DEPENDENCY_FUNCTIONS,
  WORK_ORDER_RUNTIME_AUTHORITY_FUNCTION,
  WORK_ORDER_TELEMETRY_ENVIRONMENT_FUNCTION,
  WORK_ORDER_TELEMETRY_FUNCTIONS,
  WORK_ORDER_TARGET_ACTIVATION_FUNCTION,
  WORK_ORDER_TRIGGER_RELATIONS,
  type WorkOrderCommandRoleNames,
} from '../../src/jobs/work-order-command-role-authority.js';
import {
  FAKE_FINANCIAL_LIFECYCLE_RELATIONS,
  FAKE_FINANCIAL_LIFECYCLE_TRIGGER_FUNCTIONS,
  FAKE_FINANCIAL_LIFECYCLE_DISPUTE_LOCK_FUNCTION,
  FAKE_FINANCIAL_LIFECYCLE_REVERSAL_FUNCTION,
  FAKE_FINANCIAL_LIFECYCLE_DEPENDENCY_COLUMNS,
  FAKE_FINANCIAL_RUNTIME_AUTHORITY_FUNCTION,
  FAKE_FINANCIAL_BOOTSTRAP_METADATA_FUNCTIONS,
  FAKE_FINANCIAL_BOOTSTRAP_METADATA_RELATIONS,
  fakeFinancialBootstrapMetadataColumns,
  FAKE_FINANCIAL_OUTBOX_FUNCTIONS,
  FAKE_FINANCIAL_OUTBOX_WORKER_FUNCTIONS,
  FAKE_FINANCIAL_OUTBOX_SUBMISSION_FUNCTIONS,
  FAKE_FINANCIAL_OUTBOX_RELATIONS,
  FAKE_FINANCIAL_OUTBOX_DEPENDENCY_RELATIONS,
  FAKE_FINANCIAL_OUTBOX_LOCK_COLUMNS,
  FAKE_FINANCIAL_EXECUTION_RAW_RELATIONS,
  FAKE_FINANCIAL_OUTCOME_DEPENDENCY_COLUMNS,
  FAKE_FINANCIAL_EXECUTION_DOMAIN_RELATIONS,
  FAKE_FINANCIAL_EXECUTION_DOMAIN_FUNCTION,
  FAKE_FINANCIAL_EXECUTION_DISPUTE_FUNCTION,
} from '../../src/jobs/fake-financial-outbox-role-plans.js';

/** Administrative provisioning for a newly created synthetic fixture only.
 * This does not grant membership, rewrite function bodies, or alter security flags.
 * Its full resulting catalog is independently certified through real logins.
 */
export async function provisionUniversalV1SyntheticRoles(
  client: pg.PoolClient,
  databaseName: string,
  roles: WorkOrderCommandRoleNames
): Promise<void> {
  const quote = (value: string): string => {
    if (!/^hx_ci_[a-z0-9_]+$/u.test(value) || value.length > 63)
      throw new Error('UNSAFE_SYNTHETIC_AUTHORITY_IDENTIFIER');
    return '"' + value + '"';
  };
  for (const name of [databaseName, ...Object.values(roles)]) quote(name);
  const identity = await client.query(
    'SELECT current_database() AS database, session_user AS role'
  );
  if (identity.rows[0]?.database !== databaseName || identity.rows[0]?.role !== 'hx_ci_runner')
    throw new Error('SYNTHETIC_ADMINISTRATOR_REQUIRED');
  const assertionFunctions = [
    'public.hxos_issue_universal_v1_actor_assertion_v1(TEXT,TEXT,TEXT,TEXT,JSONB,TIMESTAMPTZ)',
    'hx_authority.consume_universal_v1_actor_assertion_v1(TEXT,TEXT,JSONB,TEXT)',
    'hx_authority.reject_universal_v1_actor_assertion_mutation_v2()',
  ];
  const commandFunctions = [
    'public.hxos_express_universal_v1_post_estimate_interest_v1(TEXT,UUID,INTEGER,TEXT,TIMESTAMPTZ)',
    'public.hxos_place_universal_v1_conditional_hold_v1(TEXT,UUID,INTEGER,TEXT,TIMESTAMPTZ)',
    'public.hxos_prepare_universal_v1_fake_work_order_v1(TEXT,UUID,INTEGER,TEXT,TIMESTAMPTZ)',
    'public.hxos_materialize_universal_v1_fake_work_order_v1(TEXT,TEXT,TEXT,UUID)',
    'public.hxos_request_universal_v1_fake_work_order_recovery_v1(TEXT,TEXT,TEXT,UUID)',
    'public.hxos_claim_universal_v1_work_order_compensation_v2(INTEGER,INTEGER)',
    'hx_authority.reject_universal_v1_work_order_authority_mutation_v1()',
    'hx_authority.validate_universal_v1_work_order_target_activation_v1()',
    'hx_authority.read_universal_v1_work_order_target_authority_v1()',
    'hx_authority.build_universal_v1_work_order_command_request_v1(TEXT,JSONB)',
    'hx_authority.record_universal_v1_work_order_command_execution_v1(UUID,UUID,TEXT,TEXT,UUID,TEXT,TEXT,UUID,INTEGER,TEXT,JSONB)',
    'hx_authority.assert_universal_v1_work_order_bootstrap_seal_v1()',
    'public.hxos_build_universal_v1_work_order_actor_request_v1(TEXT,JSONB)',
    WORK_ORDER_RUNTIME_AUTHORITY_FUNCTION,
    'public.hxos_universal_v1_sha256_bytes_v1(TEXT,TEXT)',
    'public.hxos_universal_v1_sha256_bytes_v1(BYTEA,TEXT)',
    WORK_ORDER_TELEMETRY_ENVIRONMENT_FUNCTION,
    WORK_ORDER_TARGET_ACTIVATION_FUNCTION,
    ...WORK_ORDER_CORE_SHA_TRANSITIVE_DEPENDENCY_FUNCTIONS.slice(0, 4),
    'public.lock_universal_v1_estimate_authority(UUID,UUID,UUID,UUID,UUID)',
    'public.bind_universal_work_order_to_task()',
    'public.enforce_universal_v1_work_order_execution_genesis()',
  ];
  const dependencyFunctions = [
    'public.claim_universal_v1_work_order_compensations(INTEGER,INTEGER)',
    'public.universal_v1_work_order_operation_id_v1(TEXT,TEXT)',
    'public.universal_v1_invited_provider_authority_is_current(UUID,UUID,TEXT,UUID,TEXT,TEXT)',
    'public.universal_v1_execution_internal_request_sha256(UUID,UUID,TEXT,TEXT,INTEGER,UUID,UUID,UUID,TEXT,TIMESTAMPTZ,TEXT)',
    'public.universal_v1_financial_security_is_current_v1(TIMESTAMPTZ,TIMESTAMPTZ)',
    'public.universal_v1_effective_financial_security_expiry_v1(UUID)',
  ];
  const financeFunctions = [
    ...FINANCIAL_READINESS_DEFERRED_GUARDS,
    'public.require_universal_v1_controlled_fake_lifecycle_bridge()',
    ...WORK_ORDER_CORE_SHA_TRANSITIVE_DEPENDENCY_FUNCTIONS.slice(4),
  ];
  await client.query(
    `ALTER SCHEMA public OWNER TO ${quote(roles.migrationRole)};
       ALTER SCHEMA hx_authority OWNER TO ${quote(roles.assertionOwnerRole)};
       ALTER TABLE hx_authority.universal_v1_actor_assertion_issuance_facts OWNER TO ${quote(roles.assertionOwnerRole)};
       ALTER TABLE hx_authority.universal_v1_actor_assertion_consumption_facts OWNER TO ${quote(roles.assertionOwnerRole)};
       ALTER TABLE hx_authority.universal_v1_work_order_target_authority_facts OWNER TO ${quote(roles.commandOwnerRole)};
       ALTER TABLE hx_authority.universal_v1_work_order_command_execution_facts OWNER TO ${quote(roles.commandOwnerRole)};
       ALTER TABLE public.hxos_universal_v1_work_order_target_activation_barrier_v1
         OWNER TO ${quote(roles.commandOwnerRole)};
       ALTER TABLE public.tasks OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.task_drafts OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.task_scope_versions OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.task_routing_decisions OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.universal_v1_service_cell_authorities OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.task_estimate_acceptance_materializations OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.provider_estimate_submissions OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.users OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.admin_roles OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.capability_profiles OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.business_organizations OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.business_memberships OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.business_credentials OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.verified_trades OWNER TO ${quote(roles.migrationRole)};
       ALTER VIEW public.current_verified_trade_qualifications
         OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.hxos_fake_financial_schema_evidence_v12
         OWNER TO ${quote(roles.commandOwnerRole)};
       ALTER TABLE public.hxos_work_order_bootstrap_seal_evidence_v1
         OWNER TO ${quote(roles.commandOwnerRole)};
       ALTER TABLE public.financial_provider_command_journal
         OWNER TO ${quote(roles.financeOwnerRole)};
       ALTER TABLE public.financial_provider_command_outcome_facts
         OWNER TO ${quote(roles.financeOwnerRole)};
       ALTER TABLE public.task_financial_security_events
         OWNER TO ${quote(roles.financeOwnerRole)};
        ALTER TABLE public.universal_v1_fake_financial_lifecycle_bridges
          OWNER TO ${quote(roles.financeOwnerRole)};
        ALTER TABLE public.major_action_class_contracts OWNER TO ${quote(roles.migrationRole)};
        ALTER TABLE public.major_action_events OWNER TO ${quote(roles.migrationRole)};
        ALTER TABLE public.major_action_outcomes OWNER TO ${quote(roles.migrationRole)};
        ALTER TABLE public.recommendations OWNER TO ${quote(roles.migrationRole)};
        ALTER TABLE public.worker_offer_decisions OWNER TO ${quote(roles.migrationRole)};
        ALTER TABLE public.worker_counter_offers OWNER TO ${quote(roles.migrationRole)};
        ALTER TABLE public.task_work_order_command_requests OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.task_provider_eligibility_decisions OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.task_work_orders OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.task_work_order_execution_facts OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.task_reservations OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.task_reservation_requests OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.task_applications OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.universal_v1_work_order_compensation_commands OWNER TO ${quote(roles.migrationRole)}`
  );
  const triggerFunctions = await client.query<{
    configuration: string[] | null;
    identity: string;
    owner_role: string;
    security_definer: boolean;
  }>(
    `SELECT DISTINCT pg_catalog.format(
         '%I.%I(%s)', function_namespace.nspname, function_state.proname,
         pg_catalog.oidvectortypes(function_state.proargtypes)
       ) AS identity,
       function_state.proconfig AS configuration,
       function_state.prosecdef AS security_definer,
       owner_role.rolname AS owner_role
         FROM pg_catalog.pg_trigger trigger_state
         JOIN pg_catalog.pg_class relation_state
           ON relation_state.oid = trigger_state.tgrelid
         JOIN pg_catalog.pg_namespace namespace_state
           ON namespace_state.oid = relation_state.relnamespace
         JOIN pg_catalog.pg_proc function_state
           ON function_state.oid = trigger_state.tgfoid
         JOIN pg_catalog.pg_namespace function_namespace
           ON function_namespace.oid = function_state.pronamespace
         JOIN pg_catalog.pg_roles owner_role
           ON owner_role.oid = function_state.proowner
        WHERE trigger_state.tgisinternal IS FALSE
          AND pg_catalog.format('%I.%I', namespace_state.nspname, relation_state.relname)
                = ANY($1::TEXT[])
        ORDER BY identity`,
    [[...WORK_ORDER_TRIGGER_RELATIONS]]
  );
  for (const row of triggerFunctions.rows) {
    await client.query(`ALTER FUNCTION ${row.identity} OWNER TO ${quote(roles.migrationRole)}`);
  }
  for (const identity of assertionFunctions) {
    await client.query(`ALTER FUNCTION ${identity} OWNER TO ${quote(roles.assertionOwnerRole)}`);
  }
  for (const identity of commandFunctions) {
    await client.query(`ALTER FUNCTION ${identity} OWNER TO ${quote(roles.commandOwnerRole)}`);
  }
  for (const identity of financeFunctions) {
    await client.query(`ALTER FUNCTION ${identity} OWNER TO ${quote(roles.financeOwnerRole)}`);
  }
  for (const identity of WORK_ORDER_TELEMETRY_FUNCTIONS) {
    await client.query(`ALTER FUNCTION ${identity} OWNER TO ${quote(roles.telemetryOwnerRole)}`);
  }
  for (const identity of dependencyFunctions) {
    await client.query(`ALTER FUNCTION ${identity} OWNER TO ${quote(roles.migrationRole)}`);
  }
  for (const identity of WORK_ORDER_CORE_SHA_TRANSITIVE_DEPENDENCY_FUNCTIONS.slice(0, 4)) {
    await client.query(`GRANT EXECUTE ON FUNCTION ${identity} TO ${quote(roles.migrationRole)}`);
  }
  await client.query(
    `REVOKE TEMPORARY ON DATABASE ${quote(databaseName)} FROM PUBLIC;
       REVOKE CREATE ON SCHEMA public FROM PUBLIC;
       REVOKE CREATE ON SCHEMA hx_authority FROM PUBLIC;
       GRANT USAGE ON SCHEMA public TO ${quote(roles.apiRole)}, ${quote(roles.workerRole)},
          ${quote(roles.attesterRole)}, ${quote(roles.commandOwnerRole)},
          ${quote(roles.assertionOwnerRole)}, ${quote(roles.financeOwnerRole)},
          ${quote(roles.telemetryOwnerRole)};
       GRANT USAGE ON SCHEMA hx_authority TO ${quote(roles.migrationRole)},
         ${quote(roles.commandOwnerRole)};
       GRANT EXECUTE ON FUNCTION public.hxos_universal_v1_sha256_bytes_v1(TEXT,TEXT),
         public.hxos_universal_v1_sha256_bytes_v1(BYTEA,TEXT)
         TO ${quote(roles.migrationRole)}, ${quote(roles.commandOwnerRole)},
           ${quote(roles.financeOwnerRole)}, ${quote(roles.telemetryOwnerRole)};
       GRANT EXECUTE ON FUNCTION ${WORK_ORDER_TELEMETRY_ENVIRONMENT_FUNCTION}
         TO ${quote(roles.telemetryOwnerRole)};
       GRANT EXECUTE ON FUNCTION ${WORK_ORDER_TARGET_ACTIVATION_FUNCTION}
         TO ${quote(roles.migrationRole)};
       GRANT EXECUTE ON FUNCTION ${WORK_ORDER_RUNTIME_AUTHORITY_FUNCTION}
         TO ${quote(roles.migrationRole)}, ${quote(roles.apiRole)},
           ${quote(roles.workerRole)}, ${quote(roles.attesterRole)};
       GRANT SELECT ON TABLE
         public.hxos_universal_v1_work_order_target_activation_barrier_v1
         TO ${quote(roles.migrationRole)}, ${quote(roles.apiRole)},
           ${quote(roles.workerRole)}, ${quote(roles.attesterRole)};
       GRANT SELECT ON TABLE
         public.hxos_fake_financial_schema_evidence_v12,
         public.hxos_work_order_bootstrap_seal_evidence_v1
         TO ${quote(roles.migrationRole)};
       GRANT SELECT(id, firebase_uid, account_status, is_minor, is_banned)
         ON TABLE public.users TO ${quote(roles.assertionOwnerRole)};
       GRANT SELECT(id, universal_contract_version, automation_classification)
          ON TABLE public.tasks TO ${quote(roles.financeOwnerRole)};
        GRANT SELECT ON TABLE
          public.major_action_class_contracts,
          public.recommendations,
          public.worker_offer_decisions,
          public.worker_counter_offers
          TO ${quote(roles.telemetryOwnerRole)};
        GRANT SELECT, INSERT ON TABLE
          public.major_action_events,
          public.major_action_outcomes
          TO ${quote(roles.telemetryOwnerRole)};
       GRANT SELECT ON TABLE
         public.admin_roles,
         public.business_memberships,
         public.business_organizations,
         public.business_credentials,
         public.capability_profiles,
         public.current_verified_trade_qualifications,
         public.financial_provider_command_journal,
         public.financial_provider_command_outcome_facts,
         public.hxos_fake_financial_schema_evidence_v12,
         public.hxos_work_order_bootstrap_seal_evidence_v1,
         public.provider_estimate_submissions,
         public.task_drafts,
         public.task_estimate_acceptance_materializations,
         public.task_financial_security_events,
         public.task_routing_decisions,
         public.task_scope_versions,
         public.tasks,
         public.universal_v1_fake_financial_lifecycle_bridges,
         public.universal_v1_service_cell_authorities,
         public.users,
         public.verified_trades
         TO ${quote(roles.commandOwnerRole)};
       GRANT SELECT, INSERT ON TABLE
         public.task_work_order_command_requests,
         public.task_provider_eligibility_decisions,
         public.task_work_order_execution_facts,
         public.task_reservation_requests,
         public.task_work_orders,
         public.universal_v1_work_order_compensation_commands
         TO ${quote(roles.commandOwnerRole)};
       GRANT SELECT, INSERT ON TABLE
         public.task_reservations,
         public.task_applications
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(work_order_id, updated_at) ON TABLE public.tasks
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(id) ON TABLE public.task_drafts
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(id) ON TABLE public.task_scope_versions
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(id) ON TABLE public.task_routing_decisions
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(id) ON TABLE public.universal_v1_service_cell_authorities
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(id) ON TABLE public.task_estimate_acceptance_materializations
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(id) ON TABLE public.provider_estimate_submissions
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(id) ON TABLE public.users
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(id) ON TABLE public.admin_roles
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(user_id) ON TABLE public.capability_profiles
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(id) ON TABLE public.business_organizations
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(id) ON TABLE public.business_memberships
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(id) ON TABLE public.business_credentials
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(id) ON TABLE public.verified_trades
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(id) ON TABLE public.task_financial_security_events
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(bridge_id) ON TABLE public.universal_v1_fake_financial_lifecycle_bridges
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(idempotency_key) ON TABLE public.task_work_order_command_requests
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(id) ON TABLE public.task_provider_eligibility_decisions
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(id) ON TABLE public.task_work_orders
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(status) ON TABLE public.task_reservations
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(status) ON TABLE public.task_applications
         TO ${quote(roles.commandOwnerRole)};
       GRANT EXECUTE ON FUNCTION public.claim_universal_v1_work_order_compensations(
         INTEGER,INTEGER
       ) TO ${quote(roles.commandOwnerRole)};
       GRANT EXECUTE ON FUNCTION public.universal_v1_work_order_operation_id_v1(
         TEXT,TEXT
       ) TO ${quote(roles.commandOwnerRole)};
       GRANT EXECUTE ON FUNCTION public.lock_universal_v1_estimate_authority(
         UUID,UUID,UUID,UUID,UUID
       ) TO ${quote(roles.commandOwnerRole)};
       GRANT EXECUTE ON FUNCTION public.universal_v1_invited_provider_authority_is_current(
         UUID,UUID,TEXT,UUID,TEXT,TEXT
       ) TO ${quote(roles.commandOwnerRole)};
       GRANT EXECUTE ON FUNCTION public.universal_v1_execution_internal_request_sha256(
         UUID,UUID,TEXT,TEXT,INTEGER,UUID,UUID,UUID,TEXT,TIMESTAMPTZ,TEXT
       ) TO ${quote(roles.commandOwnerRole)};
       GRANT EXECUTE ON FUNCTION public.universal_v1_financial_security_is_current_v1(
         TIMESTAMPTZ,TIMESTAMPTZ
       ) TO ${quote(roles.commandOwnerRole)};
       GRANT EXECUTE ON FUNCTION public.universal_v1_effective_financial_security_expiry_v1(
         UUID
       ) TO ${quote(roles.commandOwnerRole)};
       GRANT EXECUTE ON FUNCTION public.hxos_issue_universal_v1_actor_assertion_v1(
         TEXT,TEXT,TEXT,TEXT,JSONB,TIMESTAMPTZ
       ) TO ${quote(roles.attesterRole)};
       GRANT EXECUTE ON FUNCTION hx_authority.consume_universal_v1_actor_assertion_v1(
         TEXT,TEXT,JSONB,TEXT
       ) TO ${quote(roles.commandOwnerRole)}`
  );
  for (const identity of commandFunctions.slice(0, 5)) {
    await client.query(`GRANT EXECUTE ON FUNCTION ${identity} TO ${quote(roles.apiRole)}`);
  }
  await client.query(
    `GRANT EXECUTE ON FUNCTION public.hxos_build_universal_v1_work_order_actor_request_v1(
         TEXT,JSONB
       ) TO ${quote(roles.apiRole)}`
  );
  await client.query(
    `GRANT EXECUTE ON FUNCTION public.hxos_claim_universal_v1_work_order_compensation_v2(
         INTEGER,INTEGER
       ) TO ${quote(roles.workerRole)}`
  );
  for (const ownerRole of [
    roles.migrationRole,
    roles.commandOwnerRole,
    roles.assertionOwnerRole,
    roles.financeOwnerRole,
    roles.telemetryOwnerRole,
  ]) {
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(ownerRole)}
           REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`
    );
  }

  for (const relation of FAKE_FINANCIAL_OUTBOX_DEPENDENCY_RELATIONS) {
    await client.query(`ALTER TABLE ${relation} OWNER TO ${quote(roles.migrationRole)}`);
  }
  for (const relation of FAKE_FINANCIAL_OUTBOX_RELATIONS) {
    await client.query(`ALTER TABLE ${relation} OWNER TO ${quote(roles.financeOwnerRole)}`);
  }
  await client.query(`ALTER TABLE public.hxos_fake_financial_schema_evidence_v13
    OWNER TO ${quote(roles.commandOwnerRole)}`);
  for (const identity of FAKE_FINANCIAL_OUTBOX_FUNCTIONS) {
    const owner =
      identity === FAKE_FINANCIAL_RUNTIME_AUTHORITY_FUNCTION ||
      FAKE_FINANCIAL_BOOTSTRAP_METADATA_FUNCTIONS.some((reader) => reader === identity)
        ? roles.commandOwnerRole
        : roles.financeOwnerRole;
    await client.query(`ALTER FUNCTION ${identity} OWNER TO ${quote(owner)}`);
  }
  await client.query(`GRANT USAGE ON SCHEMA hx_authority
    TO ${quote(roles.financeOwnerRole)}, ${quote(roles.workerRole)}`);
  await client.query(`GRANT SELECT(name,sha256) ON public.applied_migrations
    TO ${quote(roles.commandOwnerRole)}, ${quote(roles.financeOwnerRole)}`);
  await client.query(`GRANT SELECT ON public.hxos_fake_financial_schema_evidence_v13
    TO ${quote(roles.migrationRole)}`);
  await client.query(`GRANT SELECT ON public.hxos_fake_financial_schema_evidence_v12,
    public.hxos_work_order_bootstrap_seal_evidence_v1, public.hxos_fake_financial_schema_evidence_v13
    TO ${quote(roles.financeOwnerRole)}`);
  for (const [relation, columns] of Object.entries(FAKE_FINANCIAL_OUTBOX_LOCK_COLUMNS)) {
    await client.query(`GRANT SELECT, UPDATE(${columns.join(',')}) ON ${relation}
      TO ${quote(roles.financeOwnerRole)}`);
  }
  await client.query(`GRANT INSERT ON public.financial_provider_command_recovery_leases,
    public.financial_provider_command_dispatch_attempts TO ${quote(roles.financeOwnerRole)}`);
  for (const identity of [
    'public.universal_v1_effective_financial_security_expiry_v1(uuid)',
    'public.universal_v1_financial_security_is_current_v1(timestamptz,timestamptz)',
  ])
    await client.query(`GRANT EXECUTE ON FUNCTION ${identity} TO ${quote(roles.financeOwnerRole)}`);
  for (const identity of FAKE_FINANCIAL_OUTBOX_WORKER_FUNCTIONS)
    await client.query(`GRANT EXECUTE ON FUNCTION ${identity} TO ${quote(roles.workerRole)}`);
  for (const identity of FAKE_FINANCIAL_OUTBOX_SUBMISSION_FUNCTIONS)
    await client.query(`GRANT EXECUTE ON FUNCTION ${identity}
      TO ${quote(roles.apiRole)}, ${quote(roles.workerRole)}`);
  for (const relation of FAKE_FINANCIAL_BOOTSTRAP_METADATA_RELATIONS) {
    await client.query(`ALTER TABLE ${relation} OWNER TO ${quote(roles.migrationRole)}`);
    await client.query(`GRANT SELECT(${fakeFinancialBootstrapMetadataColumns(relation).join(',')})
      ON ${relation} TO ${quote(roles.commandOwnerRole)}`);
  }
  for (const role of [roles.migrationRole, roles.apiRole, roles.workerRole, roles.attesterRole]) {
    for (const identity of [
      FAKE_FINANCIAL_RUNTIME_AUTHORITY_FUNCTION,
      ...FAKE_FINANCIAL_BOOTSTRAP_METADATA_FUNCTIONS,
    ]) {
      await client.query(`GRANT EXECUTE ON FUNCTION ${identity} TO ${quote(role)}`);
    }
  }
  await provisionFakeFinancialExecutionDependencies(client, roles);
  // This retained insertion guard is newly in the protected trigger surface.
  // Preserve its body/configuration while closing its exact owner-only ACL.
  await client.query(
    'REVOKE ALL ON FUNCTION public.validate_universal_v1_change_order_recovery_lease() FROM PUBLIC,' +
      Object.values(roles)
        .filter((role) => role !== roles.migrationRole)
        .map(quote)
        .join(',')
  );
  await client.query(
    'GRANT EXECUTE ON FUNCTION public.validate_universal_v1_change_order_recovery_lease() TO ' +
      quote(roles.migrationRole)
  );
  for (const [privilege, grants] of [
    ['INSERT', CHANGE_ORDER_RECOVERY_CLAIM_INSERT_COLUMNS],
    ['UPDATE', CHANGE_ORDER_RECOVERY_CLAIM_LOCK_COLUMNS],
  ] as const)
    for (const [relation, columns] of Object.entries(grants))
      await client.query(
        'GRANT ' +
          privilege +
          '(' +
          columns.join(',') +
          ') ON ' +
          relation +
          ' TO ' +
          quote(roles.financeOwnerRole)
      );
  for (const [relation, columns] of Object.entries(CHANGE_ORDER_RECOVERY_OBSERVATION_READ_COLUMNS))
    await client.query(
      'GRANT SELECT(' +
        columns.join(',') +
        ') ON ' +
        relation +
        ' TO ' +
        quote(roles.financeOwnerRole)
    );
  const retainedClassifier = CHANGE_ORDER_RECOVERY_OBSERVATION_DEPENDENCIES[0];
  await client.query(
    'ALTER FUNCTION ' + retainedClassifier + ' OWNER TO ' + quote(roles.migrationRole)
  );
  await client.query(
    'REVOKE ALL ON FUNCTION ' +
      retainedClassifier +
      ' FROM PUBLIC,' +
      Object.values(roles)
        .filter((role) => role !== roles.migrationRole)
        .map(quote)
        .join(',')
  );
  for (const identity of CHANGE_ORDER_RECOVERY_OBSERVATION_DEPENDENCIES)
    await client.query(
      'GRANT EXECUTE ON FUNCTION ' + identity + ' TO ' + quote(roles.financeOwnerRole)
    );
  await provisionAuthenticatedFinancialPreparationDependencies(client, roles);
  for (const relation of FAKE_FINANCIAL_WEBHOOK_RELATIONS) {
    const owner =
      relation === FAKE_FINANCIAL_WEBHOOK_VERIFICATIONS
        ? roles.financeOwnerRole
        : roles.migrationRole;
    await client.query(`ALTER TABLE ${relation} OWNER TO ${quote(owner)}`);
  }
  for (const identity of FAKE_FINANCIAL_WEBHOOK_FUNCTIONS)
    await client.query(`ALTER FUNCTION ${identity} OWNER TO ${quote(roles.financeOwnerRole)}`);
  for (const identity of FAKE_FINANCIAL_WEBHOOK_DEPENDENCIES) {
    await client.query(`ALTER FUNCTION ${identity} OWNER TO ${quote(roles.migrationRole)}`);
    await client.query(`GRANT EXECUTE ON FUNCTION ${identity} TO ${quote(roles.financeOwnerRole)}`);
  }
  await client.query(
    `GRANT EXECUTE ON FUNCTION ${FAKE_FINANCIAL_WEBHOOK_INGRESS} TO ${quote(roles.apiRole)}`
  );
  await client.query(
    `GRANT SELECT ON ${FAKE_FINANCIAL_WEBHOOK_KEYS},${FAKE_FINANCIAL_WEBHOOK_REVOCATIONS} TO ${quote(roles.financeOwnerRole)}`
  );
  await client.query(
    `GRANT SELECT(observation_id) ON ${FAKE_FINANCIAL_WEBHOOK_PROCESSING} TO ${quote(roles.financeOwnerRole)}`
  );
  await client.query(`GRANT INSERT ON public.provider_event_inbox_observations,public.provider_event_inbox_receipts,
    ${FAKE_FINANCIAL_WEBHOOK_PROCESSING} TO ${quote(roles.financeOwnerRole)}`);
}

/** Exact synthetic grants for the new sealed execution dependency surface. */
export async function provisionFakeFinancialExecutionDependencies(
  client: Pick<pg.Pool, 'query'>,
  roles: WorkOrderCommandRoleNames
): Promise<void> {
  const quote = (value: string) => {
    if (!/^hx_(?:ci|v13)_[a-z0-9_]+$/u.test(value) || value.length > 63)
      throw new Error('UNSAFE_SYNTHETIC_AUTHORITY_IDENTIFIER');
    return `"${value}"`;
  };
  const identity = await client.query(
    'SELECT current_database() AS database, session_user AS role'
  );
  if (
    !/^hx_ci_v13_[a-f0-9]{32}_test$/u.test(identity.rows[0]?.database ?? '') ||
    identity.rows[0]?.role !== 'hx_ci_runner'
  )
    throw new Error('EXACT_SYNTHETIC_EXECUTION_DATABASE_REQUIRED');
  for (const relation of [
    ...FAKE_FINANCIAL_LIFECYCLE_RELATIONS,
    ...FAKE_FINANCIAL_EXECUTION_RAW_RELATIONS,
    ...Object.keys(FAKE_FINANCIAL_OUTCOME_DEPENDENCY_COLUMNS),
    ...FAKE_FINANCIAL_EXECUTION_DOMAIN_RELATIONS,
  ]) {
    await client.query(
      `ALTER ${relation.endsWith('dispute_current_v1') ? 'VIEW' : 'TABLE'} ${relation} OWNER TO ${quote(roles.migrationRole)}`
    );
  }
  await client.query(
    `ALTER FUNCTION ${FAKE_FINANCIAL_LIFECYCLE_REVERSAL_FUNCTION} OWNER TO ${quote(roles.migrationRole)}`
  );
  await client.query(
    `GRANT EXECUTE ON FUNCTION ${FAKE_FINANCIAL_LIFECYCLE_REVERSAL_FUNCTION} TO ${quote(roles.financeOwnerRole)}`
  );
  for (const identity of [
    'public.universal_v1_effective_financial_security_expiry_v1(uuid)',
    'public.universal_v1_financial_security_is_current_v1(timestamptz,timestamptz)',
  ])
    await client.query(`GRANT EXECUTE ON FUNCTION ${identity}
      TO ${quote(roles.commandOwnerRole)}, ${quote(roles.financeOwnerRole)}`);
  for (const [relation, columns] of Object.entries(FAKE_FINANCIAL_LIFECYCLE_DEPENDENCY_COLUMNS))
    await client.query(
      `GRANT SELECT(${columns.join(',')}) ON ${relation} TO ${quote(roles.financeOwnerRole)}`
    );
  await client.query(
    `GRANT INSERT ON public.task_financial_operations TO ${quote(roles.financeOwnerRole)}`
  );
  await client.query(`GRANT UPDATE(id) ON public.tasks TO ${quote(roles.financeOwnerRole)}`);
  for (const identity of [
    ...FAKE_FINANCIAL_LIFECYCLE_TRIGGER_FUNCTIONS,
    FAKE_FINANCIAL_LIFECYCLE_DISPUTE_LOCK_FUNCTION,
  ])
    await client.query(`ALTER FUNCTION ${identity} OWNER TO ${quote(roles.migrationRole)}`);
  for (const identity of [
    FAKE_FINANCIAL_LIFECYCLE_DISPUTE_LOCK_FUNCTION,
    FAKE_FINANCIAL_EXECUTION_DISPUTE_FUNCTION,
  ])
    await client.query(
      `GRANT EXECUTE ON FUNCTION ${identity} TO ${quote(roles.financeOwnerRole)},${quote(roles.commandOwnerRole)}`
    );
  for (const [relation, columns] of Object.entries(FAKE_FINANCIAL_OUTCOME_DEPENDENCY_COLUMNS))
    await client.query(
      `GRANT SELECT(${columns.join(',')}) ON ${relation} TO ${quote(roles.financeOwnerRole)}`
    );
  await client.query(`GRANT EXECUTE ON FUNCTION public.hxos_universal_v1_sha256_bytes_v1(TEXT,TEXT),
    public.hxos_universal_v1_sha256_bytes_v1(BYTEA,TEXT) TO ${quote(roles.financeOwnerRole)}`);
  for (const relation of FAKE_FINANCIAL_EXECUTION_RAW_RELATIONS)
    await client.query(`GRANT SELECT,INSERT ON ${relation} TO ${quote(roles.financeOwnerRole)}`);
  await client.query(
    `GRANT UPDATE(operation_id) ON public.hxos_fake_financial_operations_v1 TO ${quote(roles.financeOwnerRole)}`
  );
  await client.query(
    `GRANT UPDATE(event_id) ON public.hxos_fake_financial_operation_events_v1 TO ${quote(roles.financeOwnerRole)}`
  );
  await client.query(`GRANT SELECT(worker_id) ON public.tasks TO ${quote(roles.financeOwnerRole)}`);
  for (const [relation, column] of [
    ['public.universal_v1_fake_terminal_lifecycle_intents', 'terminal_intent_id'],
    ['public.universal_v1_fake_provider_account_facts', 'provider_account_fact_id'],
    ['public.universal_v1_prepared_financial_commands', 'prepared_command_id'],
    ['public.financial_provider_command_journal', 'command_id'],
  ])
    await client.query(
      `GRANT SELECT,UPDATE(${column}) ON ${relation} TO ${quote(roles.commandOwnerRole)}`
    );
  await client.query(
    `GRANT SELECT(task_id,status) ON public.task_safety_incidents TO ${quote(roles.commandOwnerRole)}`
  );
  await client.query(
    `ALTER FUNCTION ${FAKE_FINANCIAL_EXECUTION_DOMAIN_FUNCTION} OWNER TO ${quote(roles.commandOwnerRole)}`
  );
  await client.query(
    `GRANT EXECUTE ON FUNCTION ${FAKE_FINANCIAL_EXECUTION_DOMAIN_FUNCTION} TO ${quote(roles.financeOwnerRole)}`
  );
  await client.query(
    `ALTER FUNCTION ${FAKE_FINANCIAL_EXECUTION_DISPUTE_FUNCTION} OWNER TO ${quote(roles.migrationRole)}`
  );
  await client.query(
    `GRANT EXECUTE ON FUNCTION ${FAKE_FINANCIAL_EXECUTION_DISPUTE_FUNCTION} TO ${quote(roles.commandOwnerRole)}`
  );
}

/** Administrative fixture setup only, after all generic ownership assignments. */
async function provisionAuthenticatedFinancialPreparationDependencies(
  client: Pick<pg.Pool, 'query'>,
  roles: WorkOrderCommandRoleNames
): Promise<void> {
  const quote = (value: string) => {
    if (!/^hx_(?:ci|v13)_[a-z0-9_]+$/u.test(value) || value.length > 63)
      throw new Error('UNSAFE_SYNTHETIC_AUTHORITY_IDENTIFIER');
    return '"' + value + '"';
  };
  for (const relation of [
    ...FAKE_FINANCIAL_PREPARATION_ADDITIONAL_RELATIONS,
    ...CHANGE_ORDER_MATERIALIZATION_ADDITIONAL_RELATIONS,
  ])
    await client.query('ALTER TABLE ' + relation + ' OWNER TO ' + quote(roles.migrationRole));
  await client.query(
    'ALTER TABLE ' +
      FAKE_FINANCIAL_PREPARATION_PROVENANCE +
      ' OWNER TO ' +
      quote(roles.commandOwnerRole)
  );
  await client.query(
    'GRANT SELECT(' +
      FAKE_FINANCIAL_PREPARATION_PROVENANCE_READ_COLUMNS.join(',') +
      ') ON ' +
      FAKE_FINANCIAL_PREPARATION_PROVENANCE +
      ' TO ' +
      quote(roles.financeOwnerRole)
  );
  for (const identity of FAKE_FINANCIAL_PREPARATION_FUNCTIONS) {
    await client.query('ALTER FUNCTION ' + identity + ' OWNER TO ' + quote(roles.commandOwnerRole));
    if (
      identity === FAKE_FINANCIAL_PREPARATION_COMMAND ||
      identity === FAKE_FINANCIAL_PREPARATION_BUILDER
    )
      await client.query('GRANT EXECUTE ON FUNCTION ' + identity + ' TO ' + quote(roles.apiRole));
  }
  for (const identity of FAKE_FINANCIAL_PUBLIC_PROGRESS_FUNCTIONS) {
    const internal = identity === FAKE_FINANCIAL_PUBLIC_PROGRESS_READER;
    await client.query(
      'ALTER FUNCTION ' +
        identity +
        ' OWNER TO ' +
        quote(internal ? roles.financeOwnerRole : roles.commandOwnerRole)
    );
    await client.query(
      'GRANT EXECUTE ON FUNCTION ' +
        identity +
        ' TO ' +
        quote(internal ? roles.commandOwnerRole : roles.apiRole)
    );
  }
  for (const identity of [...WORK_ORDER_HISTORY_FUNCTIONS, ...CHANGE_ORDER_HISTORY_FUNCTIONS]) {
    await client.query('ALTER FUNCTION ' + identity + ' OWNER TO ' + quote(roles.commandOwnerRole));
    await client.query('GRANT EXECUTE ON FUNCTION ' + identity + ' TO ' + quote(roles.apiRole));
  }
  for (const identity of CHANGE_ORDER_MATERIALIZATION_FUNCTIONS) {
    const shared = identity === CHANGE_ORDER_MATERIALIZATION_WITNESS_HASH;
    await client.query(
      'ALTER FUNCTION ' +
        identity +
        ' OWNER TO ' +
        quote(shared ? roles.migrationRole : roles.commandOwnerRole)
    );
    if (shared)
      await client.query(
        'GRANT EXECUTE ON FUNCTION ' +
          identity +
          ' TO ' +
          quote(roles.commandOwnerRole) +
          ',' +
          quote(roles.financeOwnerRole)
      );
    if (CHANGE_ORDER_MATERIALIZATION_PUBLIC_FUNCTIONS.some((value) => value === identity))
      await client.query('GRANT EXECUTE ON FUNCTION ' + identity + ' TO ' + quote(roles.apiRole));
  }
  for (const identity of CHANGE_ORDER_COMMAND_FUNCTIONS) {
    await client.query('ALTER FUNCTION ' + identity + ' OWNER TO ' + quote(roles.commandOwnerRole));
    if (CHANGE_ORDER_PUBLIC_COMMAND_FUNCTIONS.some((value) => value === identity))
      await client.query('GRANT EXECUTE ON FUNCTION ' + identity + ' TO ' + quote(roles.apiRole));
  }
  for (const [privilege, grants] of [
    ['SELECT', CHANGE_ORDER_COMMAND_READ_COLUMNS],
    ['INSERT', CHANGE_ORDER_COMMAND_INSERT_COLUMNS],
    ['UPDATE', CHANGE_ORDER_COMMAND_UPDATE_COLUMNS],
    ['SELECT', CHANGE_ORDER_MATERIALIZATION_READ_COLUMNS],
    ['INSERT', CHANGE_ORDER_MATERIALIZATION_INSERT_COLUMNS],
    ['UPDATE', CHANGE_ORDER_MATERIALIZATION_UPDATE_COLUMNS],
  ] as const) {
    for (const [relation, columns] of Object.entries(grants))
      await client.query(
        'GRANT ' +
          privilege +
          '(' +
          columns.join(',') +
          ') ON ' +
          relation +
          ' TO ' +
          quote(roles.commandOwnerRole)
      );
  }
  for (const identity of FAKE_FINANCIAL_PREDECESSOR_FUNCTIONS) {
    const internal = identity === FAKE_FINANCIAL_PREDECESSOR_READER;
    await client.query(
      'ALTER FUNCTION ' +
        identity +
        ' OWNER TO ' +
        quote(internal ? roles.financeOwnerRole : roles.commandOwnerRole)
    );
    await client.query(
      'GRANT EXECUTE ON FUNCTION ' +
        identity +
        ' TO ' +
        quote(internal ? roles.commandOwnerRole : roles.apiRole)
    );
  }
  for (const identity of FAKE_FINANCIAL_PREPARATION_DEPENDENCY_FUNCTIONS) {
    await client.query('ALTER FUNCTION ' + identity + ' OWNER TO ' + quote(roles.migrationRole));
    await client.query(
      'GRANT EXECUTE ON FUNCTION ' + identity + ' TO ' + quote(roles.commandOwnerRole)
    );
  }
  await client.query(
    'GRANT EXECUTE ON FUNCTION public.universal_v1_fake_terminal_operation_id_v1(text,text) TO ' +
      quote(roles.commandOwnerRole)
  );
  await client.query(
    'GRANT INSERT ON public.universal_v1_prepared_financial_commands TO ' +
      quote(roles.commandOwnerRole)
  );
  for (const [relation, columns] of Object.entries(FAKE_FINANCIAL_PREPARATION_READ_COLUMNS))
    await client.query(
      'GRANT ' +
        (columns.includes('*') ? 'SELECT' : 'SELECT(' + columns.join(',') + ')') +
        ' ON ' +
        relation +
        ' TO ' +
        quote(roles.commandOwnerRole)
    );
  for (const [relation, columns] of Object.entries(FAKE_FINANCIAL_PREPARATION_LOCK_COLUMNS))
    await client.query(
      'GRANT UPDATE(' +
        columns.join(',') +
        ') ON ' +
        relation +
        ' TO ' +
        quote(roles.commandOwnerRole)
    );
}

/** Complete retained-object custody only in a fresh synthetic readiness fixture. */
export async function provisionFinancialReadinessCustody(
  client: Pick<pg.Pool, 'query'>,
  roles: WorkOrderCommandRoleNames
): Promise<void> {
  const quote = (name: string) => {
    if (!/^hx_ci_[a-f0-9]{20}_[a-z]+$/u.test(name)) throw new Error('UNSAFE_SYNTHETIC_ROLE');
    return '"' + name + '"';
  };
  const identity = await client.query(
    'SELECT current_database() AS database, session_user AS role'
  );
  const database = identity.rows[0]?.database;
  if (
    !/^hx_ci_v13_[a-f0-9]{32}_test$/u.test(database ?? '') ||
    identity.rows[0]?.role !== 'hx_ci_runner'
  )
    throw new Error('EXACT_SYNTHETIC_READINESS_DATABASE_REQUIRED');
  for (const plan of FINANCIAL_READINESS_STORAGE)
    await client.query(
      'ALTER ' +
        (plan.kind === 'view' ? 'VIEW ' : 'TABLE ') +
        plan.relation +
        ' OWNER TO ' +
        quote(roles.migrationRole)
    );
  for (const plan of financialReadinessFunctionCustody(roles)) {
    await client.query('ALTER FUNCTION ' + plan.identity + ' OWNER TO ' + quote(plan.owner));
    await client.query(
      'REVOKE ALL ON FUNCTION ' +
        plan.identity +
        ' FROM PUBLIC,' +
        Object.values(roles)
          .filter((role) => role !== plan.owner)
          .map(quote)
          .join(',')
    );
    for (const grantee of plan.allowed_execute)
      await client.query('GRANT EXECUTE ON FUNCTION ' + plan.identity + ' TO ' + quote(grantee));
  }
  await client.query(
    'GRANT SELECT(reconciliation_fact_id,terminal_intent_id) ON ' +
      'public.universal_v1_fake_reconciliation_bridges TO ' +
      quote(roles.financeOwnerRole)
  );
  await client.query(
    'REVOKE TEMPORARY ON DATABASE "' + database + '" FROM PUBLIC,' + quote(roles.commandOwnerRole)
  );
}
