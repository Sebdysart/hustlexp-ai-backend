import {
  CHANGE_ORDER_RECOVERY_CLAIM_INSERT_COLUMNS,
  CHANGE_ORDER_RECOVERY_CLAIM_LOCK_COLUMNS,
  CHANGE_ORDER_RECOVERY_OBSERVATION_READ_COLUMNS,
  CHANGE_ORDER_RECOVERY_OBSERVATION_DEPENDENCIES,
} from '../../src/jobs/change-order-recovery-role-plans.js';
import {
  CHANGE_ORDER_MATERIALIZATION_ADDITIONAL_RELATIONS,
  CHANGE_ORDER_MATERIALIZATION_FUNCTIONS,
  CHANGE_ORDER_MATERIALIZATION_PUBLIC_FUNCTIONS,
  CHANGE_ORDER_MATERIALIZATION_HASH_FUNCTIONS,
  CHANGE_ORDER_MATERIALIZATION_DEFERRED_GUARDS,
  CHANGE_ORDER_MATERIALIZATION_WITNESS_HASH,
  CHANGE_ORDER_KIND_COMMAND,
  CHANGE_ORDER_PREPARE_COMMAND,
  CHANGE_ORDER_FINALIZE_COMMAND,
  CHANGE_ORDER_MATERIALIZATION_READ_COLUMNS,
  CHANGE_ORDER_MATERIALIZATION_INSERT_COLUMNS,
  CHANGE_ORDER_MATERIALIZATION_UPDATE_COLUMNS,
} from '../../src/jobs/change-order-materialization-role-plans.js';
import {
  CHANGE_ORDER_COMMAND_FUNCTIONS,
  CHANGE_ORDER_PUBLIC_COMMAND_FUNCTIONS,
  CHANGE_ORDER_HASH_FUNCTIONS,
  CHANGE_ORDER_PROPOSE_COMMAND,
  CHANGE_ORDER_DECIDE_COMMAND,
  CHANGE_ORDER_COMMAND_READ_COLUMNS,
  CHANGE_ORDER_COMMAND_INSERT_COLUMNS,
  CHANGE_ORDER_COMMAND_UPDATE_COLUMNS,
} from '../../src/jobs/change-order-command-role-plans.js';
import {
  CHANGE_ORDER_HISTORY_COMMAND,
  CHANGE_ORDER_HISTORY_FUNCTIONS,
} from '../../src/jobs/change-order-history-role-plans.js';
import {
  WORK_ORDER_HISTORY_COMMAND,
  WORK_ORDER_HISTORY_FUNCTIONS,
} from '../../src/jobs/work-order-history-role-plans.js';
import {
  FAKE_FINANCIAL_PREDECESSOR_COMMAND,
  FAKE_FINANCIAL_PREDECESSOR_READER,
  FAKE_FINANCIAL_PREDECESSOR_FUNCTIONS,
} from '../../src/jobs/fake-financial-predecessor-role-plans.js';
import {
  FAKE_FINANCIAL_WEBHOOK_INGRESS,
  FAKE_FINANCIAL_WEBHOOK_FUNCTIONS,
  FAKE_FINANCIAL_WEBHOOK_DEPENDENCIES,
  FAKE_FINANCIAL_WEBHOOK_RELATIONS,
  FAKE_FINANCIAL_WEBHOOK_VERIFICATIONS,
  FAKE_FINANCIAL_WEBHOOK_PROCESSING,
} from '../../src/jobs/fake-financial-webhook-role-plans.js';
import {
  FAKE_FINANCIAL_PUBLIC_PROGRESS_COMMAND,
  FAKE_FINANCIAL_PUBLIC_PROGRESS_READER,
  FAKE_FINANCIAL_PUBLIC_PROGRESS_FUNCTIONS,
} from '../../src/jobs/fake-financial-public-progress-role-plans.js';
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
} from '../../src/jobs/fake-financial-preparation-role-plans.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import type { QueryFn } from '../../src/db.js';
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
  FAKE_FINANCIAL_OUTBOX_WORKER_FUNCTIONS,
  FAKE_FINANCIAL_OUTBOX_SUBMISSION_FUNCTIONS,
  FAKE_FINANCIAL_OUTBOX_INVOKER_FUNCTIONS,
  FAKE_FINANCIAL_OUTBOX_DIGEST_FUNCTION,
  FAKE_FINANCIAL_OUTBOX_RELATIONS,
  FAKE_FINANCIAL_OUTBOX_DEPENDENCY_RELATIONS,
  FAKE_FINANCIAL_OUTBOX_LOCK_COLUMNS,
  FAKE_FINANCIAL_EXECUTION_DOMAIN_FUNCTION,
  FAKE_FINANCIAL_EXECUTION_DISPUTE_FUNCTION,
  FAKE_FINANCIAL_EXECUTION_RAW_RELATIONS,
  FAKE_FINANCIAL_EXECUTION_DOMAIN_RELATIONS,
} from '../../src/jobs/fake-financial-outbox-role-plans.js';
import {
  FAKE_FINANCIAL_OUTBOX_V13_SQL_SHA256,
  configuredWorkOrderCommandRoles,
  createWorkOrderCommandAuthorityTransaction,
  evaluateWorkOrderCommandAuthority,
  verifyWorkOrderCommandAuthority,
  verifyWorkOrderCommandAuthorityInCurrentSnapshot,
  WORK_ORDER_ASSERTION_CONSUMER_FUNCTION,
  WORK_ORDER_ASSERTION_INTERNAL_FUNCTIONS,
  WORK_ORDER_ASSERTION_ISSUER_FUNCTION,
  WORK_ORDER_ASSERTION_WRITE_RELATIONS,
  WORK_ORDER_AUTHORITY_FUNCTION_CATALOG_SHA256,
  WORK_ORDER_AUTHORITY_LOCK_RELATIONS,
  WORK_ORDER_AUTHORITY_FUNCTIONS,
  WORK_ORDER_BOOTSTRAP_SEAL_FUNCTION,
  WORK_ORDER_BOOTSTRAP_SEAL_SQL_SHA256,
  WORK_ORDER_BOOTSTRAP_READ_RELATIONS,
  WORK_ORDER_COMMAND_AUTHORITY_WRITE_RELATIONS,
  WORK_ORDER_COMMAND_DEPENDENCY_FUNCTIONS,
  WORK_ORDER_COMMAND_FUNCTION,
  WORK_ORDER_COMMAND_INTERNAL_FUNCTIONS,
  WORK_ORDER_COMMAND_WRITE_RELATIONS,
  WORK_ORDER_CORE_SHA_TRANSITIVE_DEPENDENCY_FUNCTIONS,
  WORK_ORDER_CORE_SHA_TRANSITIVE_TRIGGER_FUNCTIONS,
  WORK_ORDER_DOMAIN_WRITE_RELATIONS,
  WORK_ORDER_FINANCIAL_READ_RELATIONS,
  WORK_ORDER_FINANCE_TRIGGER_FUNCTIONS,
  WORK_ORDER_FAKE_FINANCIAL_V12_SQL_SHA256,
  WORK_ORDER_HUMAN_COMMAND_FUNCTIONS,
  WORK_ORDER_ORDINAL146_SQL_SHA256,
  WORK_ORDER_RUNTIME_AUTHORITY_FUNCTION,
  WORK_ORDER_TELEMETRY_FUNCTIONS,
  WORK_ORDER_TELEMETRY_ENVIRONMENT_FUNCTION,
  WORK_ORDER_TELEMETRY_RELATIONS,
  WORK_ORDER_TARGET_ACTIVATION_FUNCTION,
  WORK_ORDER_TARGET_ACTIVATION_BARRIER_RELATIONS,
  WORK_ORDER_TRIGGER_CATALOG_SHA256,
  WORK_ORDER_TRIGGER_CATALOG_COUNT,
  WORK_ORDER_WORKER_COMMAND_FUNCTIONS,
  type WorkOrderCommandAuthorityEvidence,
  type WorkOrderCommandFunctionRow,
  type WorkOrderCommandRelationPrivilegeRow,
  type WorkOrderCommandRoleNames,
} from '../../src/jobs/work-order-command-role-authority.js';

const names: WorkOrderCommandRoleNames = {
  migrationRole: 'hx_migration_candidate',
  apiRole: 'hx_api_candidate',
  workerRole: 'hx_worker_candidate',
  attesterRole: 'hx_attester_candidate',
  commandOwnerRole: 'hx_work_order_owner_candidate',
  assertionOwnerRole: 'hx_assertion_owner_candidate',
  financeOwnerRole: 'hx_finance_owner_candidate',
  telemetryOwnerRole: 'hx_telemetry_owner_candidate',
};

const configuredEnvironment = {
  HX_WORK_ORDER_MIGRATION_DATABASE_ROLE: names.migrationRole,
  HX_WORK_ORDER_API_DATABASE_ROLE: names.apiRole,
  HX_WORK_ORDER_WORKER_DATABASE_ROLE: names.workerRole,
  HX_WORK_ORDER_ATTESTER_DATABASE_ROLE: names.attesterRole,
  HX_WORK_ORDER_COMMAND_OWNER_DATABASE_ROLE: names.commandOwnerRole,
  HX_WORK_ORDER_ASSERTION_OWNER_DATABASE_ROLE: names.assertionOwnerRole,
  HX_FINANCE_COMMAND_OWNER_DATABASE_ROLE: names.financeOwnerRole,
  HX_TELEMETRY_OWNER_DATABASE_ROLE: names.telemetryOwnerRole,
};

const workOrderRepositorySource = readFileSync(
  new URL('../../src/services/UniversalV1WorkOrderPostgresRepository.ts', import.meta.url),
  'utf8'
);
const actorAssertionKernelMigrationSource = readFileSync(
  new URL(
    '../../database/migrations/20261012_universal_v1_work_order_command_authority_v2.sql',
    import.meta.url
  ),
  'utf8'
);
const commandPortsMigrationSource = readFileSync(
  new URL(
    '../../database/migrations/20261014_universal_v1_work_order_command_ports_v1.sql',
    import.meta.url
  ),
  'utf8'
);
const fakeFinancialV12MigrationSource = readFileSync(
  new URL(
    '../../database/migrations/20261015_universal_v1_work_order_fake_financial_authority_hardening_v12.sql',
    import.meta.url
  ),
  'utf8'
);
const bootstrapSealMigrationSource = readFileSync(
  new URL(
    '../../database/migrations/20261015_universal_v1_work_order_bootstrap_seal_v1.sql',
    import.meta.url
  ),
  'utf8'
);

const role = (rolname: string, rolcanlogin: boolean) => ({
  rolname,
  rolcanlogin,
  rolsuper: false,
  rolcreaterole: false,
  rolcreatedb: false,
  rolreplication: false,
  rolbypassrls: false,
  member_of_roles: [],
  inherited_roles: [],
  public_schema_create: false,
  database_temp: false,
});

const issuerDefinition = `
  BEGIN
    verification_time := clock_timestamp();
    expires_at := least(verification_time + interval '60 seconds', bearer_expires_at);
    token_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(assertion_token, 'UTF8')), 'hex');
    auth_facts_sha256 := encode(pg_catalog.sha256(pg_catalog.convert_to(verified_auth_facts::text, 'UTF8')), 'hex');
    INSERT INTO hx_authority.universal_v1_actor_assertion_issuance_facts (
      token_digest, environment, command_kind, canonical_request_sha256,
      verified_subject, auth_facts_sha256, release_manifest_digest, expires_at
    ) VALUES (token_digest, environment, command_kind, canonical_request_sha256,
      verified_subject, auth_facts_sha256, release_manifest_digest, expires_at);
  END
`;

const consumerDefinition = `
  BEGIN
    observed_at := statement_timestamp();
    token_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(assertion_token, 'UTF8')), 'hex');
    SELECT verified_subject, auth_facts_sha256, release_manifest_digest, expires_at
      FROM hx_authority.universal_v1_actor_assertion_issuance_facts
     WHERE token_digest = token_digest
       AND environment = environment
       AND command_kind = command_kind
       AND canonical_request_sha256 = canonical_request_sha256;
    target_authority := canonical_request->'target_authority';
    target_authority_version := (target_authority->>'version')::integer;
    target_database_name := target_authority->>'database';
    target_environment := target_authority->>'environment';
    target_release_manifest := target_authority->>'release';
    INSERT INTO hx_authority.universal_v1_actor_assertion_consumption_facts DEFAULT VALUES;
    SELECT id FROM public.users WHERE firebase_uid = verified_subject;
  END
`;

function humanDefinition(): string {
  return `
    BEGIN
      SELECT * INTO consumed_assertion
        FROM hx_authority.consume_universal_v1_actor_assertion_v1(
          p_actor_assertion_token, p_environment, canonical_request, p_release_manifest_digest
        );
      actor_user_id := consumed_assertion.actor_user_id;
    END
  `;
}

function baseFunctionRow(
  functionIdentity: (typeof WORK_ORDER_AUTHORITY_FUNCTIONS)[number]
): WorkOrderCommandFunctionRow {
  if (FAKE_FINANCIAL_OUTBOX_FUNCTIONS.some((identity) => identity === functionIdentity)) {
    const reader =
      functionIdentity === FAKE_FINANCIAL_RUNTIME_AUTHORITY_FUNCTION ||
      FAKE_FINANCIAL_BOOTSTRAP_METADATA_FUNCTIONS.some((identity) => identity === functionIdentity);
    const worker = FAKE_FINANCIAL_OUTBOX_WORKER_FUNCTIONS.some(
      (identity) => identity === functionIdentity
    );
    const submission = FAKE_FINANCIAL_OUTBOX_SUBMISSION_FUNCTIONS.some(
      (identity) => identity === functionIdentity
    );
    const immutable = functionIdentity === FAKE_FINANCIAL_OUTBOX_DIGEST_FUNCTION;
    const invoker =
      immutable ||
      FAKE_FINANCIAL_OUTBOX_INVOKER_FUNCTIONS.some((identity) => identity === functionIdentity);
    return {
      function_identity: functionIdentity,
      function_oid: String(4_200 + WORK_ORDER_AUTHORITY_FUNCTIONS.indexOf(functionIdentity)),
      owner_role: reader ? names.commandOwnerRole : names.financeOwnerRole,
      security_definer: !invoker,
      volatility:
        reader ||
        functionIdentity === FAKE_FINANCIAL_RECOVERY_READER_FUNCTION ||
        functionIdentity === FAKE_FINANCIAL_RECOVERY_ADMISSION_FUNCTION ||
        functionIdentity === FAKE_FINANCIAL_OUTCOME_ADMISSION_FUNCTION
          ? 's'
          : immutable
            ? 'i'
            : 'v',
      parallel_safety: reader || immutable ? 's' : 'u',
      configuration: ['search_path=pg_catalog'],
      argument_names: [],
      definition: 'BEGIN RETURN; END',
      migration_execute: reader,
      api_execute: reader || submission,
      worker_execute: reader || worker || submission,
      attester_execute: reader,
      command_owner_execute: reader,
      assertion_owner_execute: false,
      finance_owner_execute: !reader,
      telemetry_owner_execute: false,
      public_execute: false,
      execute_grantees: reader
        ? [
            names.migrationRole,
            names.apiRole,
            names.workerRole,
            names.attesterRole,
            names.commandOwnerRole,
          ]
        : submission
          ? [names.apiRole, names.workerRole, names.financeOwnerRole]
          : worker
            ? [names.workerRole, names.financeOwnerRole]
            : [names.financeOwnerRole],
    };
  }
  if (
    functionIdentity === FAKE_FINANCIAL_EXECUTION_DOMAIN_FUNCTION ||
    functionIdentity === FAKE_FINANCIAL_EXECUTION_DISPUTE_FUNCTION
  ) {
    const domain = functionIdentity === FAKE_FINANCIAL_EXECUTION_DOMAIN_FUNCTION;
    return {
      function_identity: functionIdentity,
      function_oid: String(4_200 + WORK_ORDER_AUTHORITY_FUNCTIONS.indexOf(functionIdentity)),
      owner_role: domain ? names.commandOwnerRole : names.migrationRole,
      security_definer: true,
      volatility: domain ? 'v' : 's',
      parallel_safety: 'u',
      configuration: [domain ? 'search_path=pg_catalog' : 'search_path=pg_catalog, public'],
      argument_names: [],
      definition: 'BEGIN RETURN; END',
      migration_execute: !domain,
      api_execute: false,
      worker_execute: false,
      attester_execute: false,
      command_owner_execute: true,
      assertion_owner_execute: false,
      finance_owner_execute: true,
      telemetry_owner_execute: false,
      public_execute: false,
      execute_grantees: [
        names.commandOwnerRole,
        names.financeOwnerRole,
        ...(!domain ? [names.migrationRole] : []),
      ],
    };
  }
  if (
    FAKE_FINANCIAL_LIFECYCLE_TRIGGER_FUNCTIONS.some((identity) => identity === functionIdentity) ||
    functionIdentity === FAKE_FINANCIAL_LIFECYCLE_DISPUTE_LOCK_FUNCTION ||
    functionIdentity === FAKE_FINANCIAL_LIFECYCLE_REVERSAL_FUNCTION
  ) {
    const lock = functionIdentity === FAKE_FINANCIAL_LIFECYCLE_DISPUTE_LOCK_FUNCTION;
    const reversal = functionIdentity === FAKE_FINANCIAL_LIFECYCLE_REVERSAL_FUNCTION;
    return {
      function_identity: functionIdentity,
      function_oid: String(4_200 + WORK_ORDER_AUTHORITY_FUNCTIONS.indexOf(functionIdentity)),
      owner_role: names.migrationRole,
      security_definer: false,
      volatility: reversal ? 's' : 'v',
      parallel_safety: 'u',
      configuration: [
        functionIdentity === 'public.serialize_universal_v1_financial_security_task_v12()'
          ? 'search_path=pg_catalog'
          : 'search_path=pg_catalog, public',
      ],
      argument_names: [],
      definition: 'BEGIN RETURN; END',
      migration_execute: true,
      api_execute: false,
      worker_execute: false,
      attester_execute: false,
      command_owner_execute: lock,
      assertion_owner_execute: false,
      finance_owner_execute: lock || reversal,
      telemetry_owner_execute: false,
      public_execute: false,
      execute_grantees: lock
        ? [names.migrationRole, names.commandOwnerRole, names.financeOwnerRole]
        : reversal
          ? [names.migrationRole, names.financeOwnerRole]
          : [names.migrationRole],
    };
  }
  const issuer = functionIdentity === WORK_ORDER_ASSERTION_ISSUER_FUNCTION;
  const consumer = functionIdentity === WORK_ORDER_ASSERTION_CONSUMER_FUNCTION;
  const assertionInternal = WORK_ORDER_ASSERTION_INTERNAL_FUNCTIONS.some(
    (identity) => identity === functionIdentity
  );
  const commandInternalIndex = WORK_ORDER_COMMAND_INTERNAL_FUNCTIONS.findIndex(
    (identity) => identity === functionIdentity
  );
  const dependencyIndex = WORK_ORDER_COMMAND_DEPENDENCY_FUNCTIONS.findIndex(
    (identity) => identity === functionIdentity
  );
  const human = WORK_ORDER_HUMAN_COMMAND_FUNCTIONS.some(
    (identity) => identity === functionIdentity
  );
  const worker = WORK_ORDER_WORKER_COMMAND_FUNCTIONS.some(
    (identity) => identity === functionIdentity
  );
  const financeTrigger = WORK_ORDER_FINANCE_TRIGGER_FUNCTIONS.some(
    (identity) => identity === functionIdentity
  );
  const coreShaTransitiveTrigger = WORK_ORDER_CORE_SHA_TRANSITIVE_TRIGGER_FUNCTIONS.some(
    (identity) => identity === functionIdentity
  );
  const coreShaTransitiveDependencyIndex =
    WORK_ORDER_CORE_SHA_TRANSITIVE_DEPENDENCY_FUNCTIONS.findIndex(
      (identity) => identity === functionIdentity
    );
  const coreShaTransitiveDependency = coreShaTransitiveDependencyIndex >= 0;
  const financeCoreShaDependency = coreShaTransitiveDependencyIndex >= 4;
  const telemetry = WORK_ORDER_TELEMETRY_FUNCTIONS.some(
    (identity) => identity === functionIdentity
  );
  const telemetryEnvironment = functionIdentity === WORK_ORDER_TELEMETRY_ENVIRONMENT_FUNCTION;
  const targetActivation = functionIdentity === WORK_ORDER_TARGET_ACTIVATION_FUNCTION;
  const bootstrapSeal = functionIdentity === WORK_ORDER_BOOTSTRAP_SEAL_FUNCTION;
  const runtimeAuthority = functionIdentity === WORK_ORDER_RUNTIME_AUTHORITY_FUNCTION;
  const dependency = dependencyIndex >= 0;
  const taskProjection = dependencyIndex === 5;
  const deferredGenesis = dependencyIndex === 8;
  const hashHelper = dependencyIndex === 9 || dependencyIndex === 10;
  const sealedCommandDependency = dependencyIndex === 2 || taskProjection || deferredGenesis;
  const financialCurrent = dependencyIndex === 6;
  const effectiveExpiry = dependencyIndex === 7;
  const stableInternal = commandInternalIndex === 2;
  const actorRequestBuilder = commandInternalIndex === 5;
  const executeGrantees = issuer
    ? [names.attesterRole, names.assertionOwnerRole]
    : consumer
      ? [names.assertionOwnerRole, names.commandOwnerRole]
      : assertionInternal
        ? [names.assertionOwnerRole]
        : commandInternalIndex >= 0
          ? actorRequestBuilder
            ? [names.apiRole, names.commandOwnerRole]
            : [names.commandOwnerRole]
          : human
            ? [names.apiRole, names.commandOwnerRole]
            : worker
              ? [names.commandOwnerRole, names.workerRole]
              : financeTrigger
                ? [names.financeOwnerRole]
                : coreShaTransitiveTrigger
                  ? [names.migrationRole]
                  : coreShaTransitiveDependency
                    ? financeCoreShaDependency
                      ? [names.financeOwnerRole]
                      : [names.commandOwnerRole, names.migrationRole]
                    : telemetry
                      ? [names.telemetryOwnerRole]
                      : telemetryEnvironment
                        ? [names.commandOwnerRole, names.telemetryOwnerRole]
                        : targetActivation
                          ? [names.commandOwnerRole, names.migrationRole]
                          : bootstrapSeal
                            ? [names.commandOwnerRole]
                            : runtimeAuthority
                              ? [
                                  names.apiRole,
                                  names.attesterRole,
                                  names.commandOwnerRole,
                                  names.migrationRole,
                                  names.workerRole,
                                ]
                              : hashHelper
                                ? [
                                    names.commandOwnerRole,
                                    names.financeOwnerRole,
                                    names.migrationRole,
                                    names.telemetryOwnerRole,
                                  ]
                                : sealedCommandDependency
                                  ? [names.commandOwnerRole]
                                  : effectiveExpiry || financialCurrent
                                    ? [
                                        names.commandOwnerRole,
                                        names.migrationRole,
                                        names.financeOwnerRole,
                                      ]
                                    : [names.commandOwnerRole, names.migrationRole];
  return {
    function_identity: functionIdentity,
    function_oid: String(4_200 + WORK_ORDER_AUTHORITY_FUNCTIONS.indexOf(functionIdentity)),
    owner_role:
      issuer || consumer || assertionInternal
        ? names.assertionOwnerRole
        : financeTrigger || financeCoreShaDependency
          ? names.financeOwnerRole
          : telemetry
            ? names.telemetryOwnerRole
            : (dependency && !sealedCommandDependency && !hashHelper) || coreShaTransitiveTrigger
              ? names.migrationRole
              : names.commandOwnerRole,
    security_definer:
      financeTrigger ||
      telemetry ||
      (!dependency && !coreShaTransitiveTrigger && !coreShaTransitiveDependency) ||
      sealedCommandDependency,
    volatility: dependency
      ? hashHelper || dependencyIndex === 1 || dependencyIndex === 4 || financialCurrent
        ? 'i'
        : dependencyIndex === 3 || effectiveExpiry
          ? 's'
          : 'v'
      : coreShaTransitiveTrigger
        ? 'v'
        : coreShaTransitiveDependency
          ? coreShaTransitiveDependencyIndex === 1
            ? 'v'
            : coreShaTransitiveDependencyIndex === 5
              ? 's'
              : 'i'
          : stableInternal || bootstrapSeal || runtimeAuthority
            ? 's'
            : 'v',
    parallel_safety: dependency
      ? hashHelper || dependencyIndex === 1 || financialCurrent || effectiveExpiry
        ? 's'
        : 'u'
      : coreShaTransitiveTrigger
        ? 'u'
        : coreShaTransitiveDependency
          ? coreShaTransitiveDependencyIndex === 1 || coreShaTransitiveDependencyIndex === 2
            ? 'u'
            : 's'
          : stableInternal || bootstrapSeal || runtimeAuthority
            ? 's'
            : 'u',
    configuration:
      functionIdentity === 'public.validate_fake_financial_legacy_expiry_noncompensable_v10()'
        ? ['search_path=pg_catalog']
        : dependency
          ? dependencyIndex === 1 ||
            dependencyIndex === 2 ||
            dependencyIndex === 4 ||
            taskProjection ||
            deferredGenesis ||
            financialCurrent ||
            effectiveExpiry
            ? ['search_path=pg_catalog, public']
            : hashHelper
              ? ['search_path=pg_catalog']
              : null
          : financeTrigger || telemetry || coreShaTransitiveTrigger || coreShaTransitiveDependency
            ? ['search_path=pg_catalog, public']
            : ['search_path=pg_catalog'],
    argument_names: human
      ? ['p_actor_assertion_token', 'p_domain_id', 'p_expected_version', 'p_idempotency_key']
      : [],
    definition: issuer
      ? issuerDefinition
      : consumer
        ? consumerDefinition
        : human
          ? humanDefinition()
          : 'BEGIN PERFORM public.hxos_claim_universal_v1_work_order_compensation_v2; END',
    migration_execute:
      (dependency && (!sealedCommandDependency || hashHelper)) ||
      coreShaTransitiveTrigger ||
      (coreShaTransitiveDependency && !financeCoreShaDependency) ||
      targetActivation ||
      runtimeAuthority,
    api_execute: human || actorRequestBuilder || runtimeAuthority,
    worker_execute: worker || runtimeAuthority,
    attester_execute: issuer || runtimeAuthority,
    command_owner_execute:
      consumer ||
      commandInternalIndex >= 0 ||
      dependency ||
      human ||
      worker ||
      (coreShaTransitiveDependency && !financeCoreShaDependency) ||
      telemetryEnvironment ||
      targetActivation ||
      bootstrapSeal ||
      runtimeAuthority,
    assertion_owner_execute: issuer || consumer || assertionInternal,
    finance_owner_execute:
      financeTrigger ||
      hashHelper ||
      financeCoreShaDependency ||
      effectiveExpiry ||
      financialCurrent,
    telemetry_owner_execute: telemetry || telemetryEnvironment || hashHelper,
    public_execute: false,
    execute_grantees: executeGrantees,
  };
}

function baseRelationRow(
  relation_name: (typeof WORK_ORDER_COMMAND_WRITE_RELATIONS)[number]
): WorkOrderCommandRelationPrivilegeRow {
  const lifecycle = FAKE_FINANCIAL_LIFECYCLE_RELATIONS.some(
    (relation) => relation === relation_name
  );
  const lifecycleColumns = FAKE_FINANCIAL_LIFECYCLE_DEPENDENCY_COLUMNS[relation_name] ?? [];
  const outcomeColumns = FAKE_FINANCIAL_OUTCOME_DEPENDENCY_COLUMNS[relation_name] ?? [];
  const metadata = FAKE_FINANCIAL_BOOTSTRAP_METADATA_RELATIONS.some(
    (relation) => relation === relation_name
  );
  const outbox = FAKE_FINANCIAL_OUTBOX_RELATIONS.some((relation) => relation === relation_name);
  const dependency = FAKE_FINANCIAL_OUTBOX_DEPENDENCY_RELATIONS.some(
    (relation) => relation === relation_name
  );
  const executionRaw = FAKE_FINANCIAL_EXECUTION_RAW_RELATIONS.some((r) => r === relation_name);
  const executionDomain = FAKE_FINANCIAL_EXECUTION_DOMAIN_RELATIONS.some(
    (r) => r === relation_name
  );
  const financeLockColumns =
    relation_name === 'public.hxos_fake_financial_operations_v1'
      ? ['operation_id']
      : relation_name === 'public.hxos_fake_financial_operation_events_v1'
        ? ['event_id']
        : (FAKE_FINANCIAL_OUTBOX_LOCK_COLUMNS[relation_name] ?? []);
  const financeInsert =
    relation_name === 'public.task_financial_operations' ||
    executionRaw ||
    relation_name === 'public.financial_provider_command_recovery_leases' ||
    relation_name === 'public.financial_provider_command_dispatch_attempts';
  const assertion = (WORK_ORDER_ASSERTION_WRITE_RELATIONS as readonly string[]).includes(
    relation_name
  );
  const authority = (WORK_ORDER_COMMAND_AUTHORITY_WRITE_RELATIONS as readonly string[]).includes(
    relation_name
  );
  const domain = (WORK_ORDER_DOMAIN_WRITE_RELATIONS as readonly string[]).includes(relation_name);
  const authorityLock = (WORK_ORDER_AUTHORITY_LOCK_RELATIONS as readonly string[]).includes(
    relation_name
  );
  const financialRead = (WORK_ORDER_FINANCIAL_READ_RELATIONS as readonly string[]).includes(
    relation_name
  );
  const bootstrapRead = (WORK_ORDER_BOOTSTRAP_READ_RELATIONS as readonly string[]).includes(
    relation_name
  );
  const telemetry = (WORK_ORDER_TELEMETRY_RELATIONS as readonly string[]).includes(relation_name);
  const targetBarrier = (
    WORK_ORDER_TARGET_ACTIVATION_BARRIER_RELATIONS as readonly string[]
  ).includes(relation_name);
  const commandUpdateColumns: Readonly<Record<string, readonly string[]>> = {
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
    'public.task_reservations': ['status'],
    'public.task_applications': ['status'],
    'public.admin_roles': ['id'],
    'public.capability_profiles': ['user_id'],
    'public.business_organizations': ['id'],
    'public.business_memberships': ['id'],
    'public.business_credentials': ['id'],
    'public.verified_trades': ['id'],
    'public.financial_provider_command_journal': ['command_id'],
    'public.universal_v1_prepared_financial_commands': ['prepared_command_id'],
    'public.universal_v1_fake_terminal_lifecycle_intents': ['terminal_intent_id'],
    'public.universal_v1_fake_provider_account_facts': ['provider_account_fact_id'],
    'public.task_financial_security_events': ['id'],
    'public.universal_v1_fake_financial_lifecycle_bridges': ['bridge_id'],
  };
  const updateColumns = commandUpdateColumns[relation_name] ?? [];
  const commandInsert = [
    'public.task_work_order_command_requests',
    'public.task_provider_eligibility_decisions',
    'public.task_work_orders',
    'public.task_work_order_execution_facts',
    'public.task_reservations',
    'public.task_reservation_requests',
    'public.task_applications',
    'public.universal_v1_work_order_compensation_commands',
  ].includes(relation_name);
  const telemetryInsert =
    relation_name === 'public.major_action_events' ||
    relation_name === 'public.major_action_outcomes';
  const aclGrants = targetBarrier
    ? [
        `${names.migrationRole}|SELECT|*`,
        `${names.apiRole}|SELECT|*`,
        `${names.workerRole}|SELECT|*`,
        `${names.attesterRole}|SELECT|*`,
      ]
    : domain ||
        authorityLock ||
        bootstrapRead ||
        financialRead ||
        (updateColumns.length > 0 && !authority)
      ? [
          `${names.commandOwnerRole}|SELECT|*`,
          ...(bootstrapRead
            ? [`${names.migrationRole}|SELECT|*`, `${names.financeOwnerRole}|SELECT|*`]
            : []),
          ...(commandInsert ? [`${names.commandOwnerRole}|INSERT|*`] : []),
          ...updateColumns.map((column) => `${names.commandOwnerRole}|UPDATE|${column}`),
          ...(relation_name === 'public.users'
            ? ['id', 'firebase_uid', 'account_status', 'is_minor', 'is_banned'].map(
                (column) => `${names.assertionOwnerRole}|SELECT|${column}`
              )
            : []),
        ]
      : telemetry
        ? [
            `${names.telemetryOwnerRole}|SELECT|*`,
            ...(telemetryInsert ? [`${names.telemetryOwnerRole}|INSERT|*`] : []),
          ]
        : [];
  for (const column of lifecycleColumns)
    aclGrants.push(`${names.financeOwnerRole}|SELECT|${column}`);
  if (lifecycle && financeInsert) aclGrants.push(`${names.financeOwnerRole}|INSERT|*`);
  if (relation_name === 'public.tasks') aclGrants.push(`${names.financeOwnerRole}|UPDATE|id`);
  for (const column of outcomeColumns) aclGrants.push(`${names.financeOwnerRole}|SELECT|${column}`);
  if (metadata) {
    for (const column of fakeFinancialBootstrapMetadataColumns(relation_name))
      aclGrants.push(`${names.commandOwnerRole}|SELECT|${column}`);
  }
  if (relation_name === 'public.task_safety_incidents') {
    for (const column of ['task_id', 'status'])
      aclGrants.push(`${names.commandOwnerRole}|SELECT|${column}`);
  }
  if (dependency || executionRaw || financeLockColumns.length > 0) {
    if (relation_name === 'public.applied_migrations') {
      for (const role of [names.commandOwnerRole, names.financeOwnerRole]) {
        for (const column of ['name', 'sha256']) aclGrants.push(`${role}|SELECT|${column}`);
      }
    } else aclGrants.push(`${names.financeOwnerRole}|SELECT|*`);
    if (financeInsert) aclGrants.push(`${names.financeOwnerRole}|INSERT|*`);
    for (const column of financeLockColumns)
      aclGrants.push(`${names.financeOwnerRole}|UPDATE|${column}`);
  }
  return {
    relation_name,
    owner_role: assertion
      ? names.assertionOwnerRole
      : authority || targetBarrier
        ? names.commandOwnerRole
        : bootstrapRead
          ? names.commandOwnerRole
          : financialRead || outbox
            ? names.financeOwnerRole
            : names.migrationRole,
    migration_insert:
      domain ||
      authorityLock ||
      telemetry ||
      dependency ||
      metadata ||
      executionRaw ||
      executionDomain ||
      lifecycle ||
      outcomeColumns.length > 0,
    migration_update:
      domain ||
      authorityLock ||
      telemetry ||
      dependency ||
      metadata ||
      executionRaw ||
      executionDomain ||
      lifecycle ||
      outcomeColumns.length > 0,
    migration_delete:
      domain ||
      authorityLock ||
      telemetry ||
      dependency ||
      metadata ||
      executionRaw ||
      executionDomain ||
      lifecycle ||
      outcomeColumns.length > 0,
    migration_truncate:
      domain ||
      authorityLock ||
      telemetry ||
      dependency ||
      metadata ||
      executionRaw ||
      executionDomain ||
      lifecycle ||
      outcomeColumns.length > 0,
    api_insert: false,
    api_update: false,
    api_delete: false,
    api_truncate: false,
    worker_insert: false,
    worker_update: false,
    worker_delete: false,
    worker_truncate: false,
    attester_insert: false,
    attester_update: false,
    attester_delete: false,
    attester_truncate: false,
    command_owner_insert: commandInsert || authority || bootstrapRead || targetBarrier,
    command_owner_update: authority || bootstrapRead || targetBarrier,
    command_owner_delete: authority || bootstrapRead || targetBarrier,
    command_owner_truncate: authority || bootstrapRead || targetBarrier,
    migration_any_column_update:
      domain ||
      authorityLock ||
      telemetry ||
      dependency ||
      metadata ||
      executionRaw ||
      executionDomain ||
      lifecycle ||
      outcomeColumns.length > 0,
    api_any_column_update: false,
    worker_any_column_update: false,
    attester_any_column_update: false,
    command_owner_any_column_update: authority || bootstrapRead || updateColumns.length > 0,
    assertion_owner_any_column_update: assertion,
    finance_owner_any_column_update:
      relation_name === 'public.tasks' || financialRead || outbox || financeLockColumns.length > 0,
    telemetry_owner_any_column_update: false,
    command_owner_update_columns: [...updateColumns],
    assertion_owner_insert: assertion,
    assertion_owner_update: assertion,
    assertion_owner_delete: assertion,
    assertion_owner_truncate: assertion,
    finance_owner_insert: financialRead || outbox || financeInsert,
    finance_owner_update: financialRead || outbox,
    finance_owner_delete: financialRead || outbox,
    finance_owner_truncate: financialRead || outbox,
    telemetry_owner_insert: telemetryInsert,
    telemetry_owner_update: false,
    telemetry_owner_delete: false,
    telemetry_owner_truncate: false,
    acl_grants: aclGrants,
  };
}

function functionRowBeforeRecoveryObservation(
  identity: (typeof WORK_ORDER_AUTHORITY_FUNCTIONS)[number]
): WorkOrderCommandFunctionRow {
  if (
    [...FAKE_FINANCIAL_WEBHOOK_FUNCTIONS, ...FAKE_FINANCIAL_WEBHOOK_DEPENDENCIES].some(
      (item) => item === identity
    )
  ) {
    const dependency = FAKE_FINANCIAL_WEBHOOK_DEPENDENCIES.some((item) => item === identity);
    const api = identity === FAKE_FINANCIAL_WEBHOOK_INGRESS;
    return {
      function_identity: identity,
      function_oid: String(4200 + WORK_ORDER_AUTHORITY_FUNCTIONS.indexOf(identity)),
      owner_role: dependency ? names.migrationRole : names.financeOwnerRole,
      security_definer: !dependency,
      volatility: 'v',
      parallel_safety: 'u',
      configuration: [dependency ? 'search_path=pg_catalog, public' : 'search_path=pg_catalog'],
      argument_names: [],
      definition: 'BEGIN RETURN; END',
      migration_execute: dependency,
      api_execute: api,
      worker_execute: false,
      attester_execute: false,
      command_owner_execute: false,
      assertion_owner_execute: false,
      finance_owner_execute: true,
      telemetry_owner_execute: false,
      public_execute: false,
      execute_grantees: [
        names.financeOwnerRole,
        ...(dependency ? [names.migrationRole] : []),
        ...(api ? [names.apiRole] : []),
      ],
    };
  }
  if (FAKE_FINANCIAL_PUBLIC_PROGRESS_FUNCTIONS.some((item) => item === identity)) {
    const internal = identity === FAKE_FINANCIAL_PUBLIC_PROGRESS_READER;
    const human = identity === FAKE_FINANCIAL_PUBLIC_PROGRESS_COMMAND;
    return {
      function_identity: identity,
      function_oid: String(4_200 + WORK_ORDER_AUTHORITY_FUNCTIONS.indexOf(identity)),
      owner_role: internal ? names.financeOwnerRole : names.commandOwnerRole,
      security_definer: true,
      volatility: 'v',
      parallel_safety: 'u',
      configuration: ['search_path=pg_catalog'],
      argument_names: human ? ['actor_assertion_token', 'command_payload'] : [],
      definition: human ? humanDefinition() : 'BEGIN RETURN; END',
      migration_execute: false,
      api_execute: !internal,
      worker_execute: false,
      attester_execute: false,
      command_owner_execute: true,
      assertion_owner_execute: false,
      finance_owner_execute: internal,
      telemetry_owner_execute: false,
      public_execute: false,
      execute_grantees: [names.commandOwnerRole, internal ? names.financeOwnerRole : names.apiRole],
    };
  }
  if (FAKE_FINANCIAL_PREDECESSOR_FUNCTIONS.some((item) => item === identity)) {
    const internal = identity === FAKE_FINANCIAL_PREDECESSOR_READER;
    const human = identity === FAKE_FINANCIAL_PREDECESSOR_COMMAND;
    return {
      function_identity: identity,
      function_oid: String(4_200 + WORK_ORDER_AUTHORITY_FUNCTIONS.indexOf(identity)),
      owner_role: internal ? names.financeOwnerRole : names.commandOwnerRole,
      security_definer: true,
      volatility: 'v',
      parallel_safety: 'u',
      configuration: ['search_path=pg_catalog'],
      argument_names: human ? ['actor_assertion_token', 'command_payload'] : [],
      definition: human ? humanDefinition() : 'BEGIN RETURN; END',
      migration_execute: false,
      api_execute: !internal,
      worker_execute: false,
      attester_execute: false,
      command_owner_execute: true,
      assertion_owner_execute: false,
      finance_owner_execute: internal,
      telemetry_owner_execute: false,
      public_execute: false,
      execute_grantees: [names.commandOwnerRole, internal ? names.financeOwnerRole : names.apiRole],
    };
  }
  if (
    [...WORK_ORDER_HISTORY_FUNCTIONS, ...CHANGE_ORDER_HISTORY_FUNCTIONS].some(
      (item) => item === identity
    )
  ) {
    const internal = false;
    const human =
      identity === WORK_ORDER_HISTORY_COMMAND || identity === CHANGE_ORDER_HISTORY_COMMAND;
    return {
      function_identity: identity,
      function_oid: String(4_200 + WORK_ORDER_AUTHORITY_FUNCTIONS.indexOf(identity)),
      owner_role: internal ? names.financeOwnerRole : names.commandOwnerRole,
      security_definer: true,
      volatility: 'v',
      parallel_safety: 'u',
      configuration: ['search_path=pg_catalog'],
      argument_names: human ? ['actor_assertion_token', 'command_payload'] : [],
      definition: human ? humanDefinition() : 'BEGIN RETURN; END',
      migration_execute: false,
      api_execute: !internal,
      worker_execute: false,
      attester_execute: false,
      command_owner_execute: true,
      assertion_owner_execute: false,
      finance_owner_execute: internal,
      telemetry_owner_execute: false,
      public_execute: false,
      execute_grantees: [names.commandOwnerRole, internal ? names.financeOwnerRole : names.apiRole],
    };
  }
  if (CHANGE_ORDER_MATERIALIZATION_FUNCTIONS.some((value) => value === identity)) {
    const hash = CHANGE_ORDER_MATERIALIZATION_HASH_FUNCTIONS.some((value) => value === identity);
    const deferred = CHANGE_ORDER_MATERIALIZATION_DEFERRED_GUARDS.some(
      (value) => value === identity
    );
    const shared = identity === CHANGE_ORDER_MATERIALIZATION_WITNESS_HASH;
    const api = CHANGE_ORDER_MATERIALIZATION_PUBLIC_FUNCTIONS.some((value) => value === identity);
    const human = [
      CHANGE_ORDER_KIND_COMMAND,
      CHANGE_ORDER_PREPARE_COMMAND,
      CHANGE_ORDER_FINALIZE_COMMAND,
    ].some((value) => value === identity);
    return {
      function_identity: identity,
      function_oid: String(4200 + WORK_ORDER_AUTHORITY_FUNCTIONS.indexOf(identity)),
      owner_role: shared ? names.migrationRole : names.commandOwnerRole,
      security_definer: !hash,
      volatility: hash ? 'i' : 'v',
      parallel_safety: hash ? 's' : 'u',
      configuration: [deferred ? 'search_path=pg_catalog, public' : 'search_path=pg_catalog'],
      argument_names: human ? ['actor_assertion_token', 'command_payload'] : [],
      definition: human ? humanDefinition() : 'BEGIN RETURN; END',
      migration_execute: shared,
      api_execute: api,
      worker_execute: false,
      attester_execute: false,
      command_owner_execute: true,
      assertion_owner_execute: false,
      finance_owner_execute: shared,
      telemetry_owner_execute: false,
      public_execute: false,
      execute_grantees: [
        names.commandOwnerRole,
        ...(shared ? [names.migrationRole, names.financeOwnerRole] : []),
        ...(api ? [names.apiRole] : []),
      ],
    };
  }
  if (CHANGE_ORDER_COMMAND_FUNCTIONS.some((value) => value === identity)) {
    const hash = CHANGE_ORDER_HASH_FUNCTIONS.some((value) => value === identity);
    const api = CHANGE_ORDER_PUBLIC_COMMAND_FUNCTIONS.some((value) => value === identity);
    const human =
      identity === CHANGE_ORDER_PROPOSE_COMMAND || identity === CHANGE_ORDER_DECIDE_COMMAND;
    return {
      function_identity: identity,
      function_oid: String(4200 + WORK_ORDER_AUTHORITY_FUNCTIONS.indexOf(identity)),
      owner_role: names.commandOwnerRole,
      security_definer: !hash,
      volatility: hash ? 'i' : 'v',
      parallel_safety: hash ? 's' : 'u',
      configuration: ['search_path=pg_catalog'],
      argument_names: human ? ['actor_assertion_token', 'command_payload'] : [],
      definition: human ? humanDefinition() : 'BEGIN RETURN; END',
      migration_execute: false,
      api_execute: api,
      worker_execute: false,
      attester_execute: false,
      command_owner_execute: true,
      assertion_owner_execute: false,
      finance_owner_execute: false,
      telemetry_owner_execute: false,
      public_execute: false,
      execute_grantees: [names.commandOwnerRole, ...(api ? [names.apiRole] : [])],
    };
  }
  const preparation = FAKE_FINANCIAL_PREPARATION_FUNCTIONS.some((item) => item === identity);
  const dependency = FAKE_FINANCIAL_PREPARATION_DEPENDENCY_FUNCTIONS.some(
    (item) => item === identity
  );
  if (!preparation && !dependency) {
    const row = baseFunctionRow(identity);
    return identity === 'public.universal_v1_fake_terminal_operation_id_v1(text,text)'
      ? {
          ...row,
          command_owner_execute: true,
          execute_grantees: [...row.execute_grantees!, names.commandOwnerRole],
        }
      : row;
  }
  const api =
    identity === FAKE_FINANCIAL_PREPARATION_COMMAND ||
    identity === FAKE_FINANCIAL_PREPARATION_BUILDER;
  const immutable = identity === 'public.universal_v1_fake_terminal_plan_v1(text)';
  return {
    function_identity: identity,
    function_oid: String(4_200 + WORK_ORDER_AUTHORITY_FUNCTIONS.indexOf(identity)),
    owner_role: dependency ? names.migrationRole : names.commandOwnerRole,
    security_definer:
      preparation || identity === 'public.business_membership_has_action(uuid,uuid,text)',
    volatility: preparation ? 'v' : immutable ? 'i' : 's',
    parallel_safety: immutable ? 's' : 'u',
    configuration: [
      dependency || identity === FAKE_FINANCIAL_PREPARATION_INSERT
        ? 'search_path=pg_catalog, public'
        : 'search_path=pg_catalog',
    ],
    argument_names:
      identity === FAKE_FINANCIAL_PREPARATION_COMMAND
        ? ['actor_assertion_token', 'command_payload']
        : [],
    definition:
      identity === FAKE_FINANCIAL_PREPARATION_COMMAND ? humanDefinition() : 'BEGIN RETURN; END',
    migration_execute: dependency,
    api_execute: api,
    worker_execute: false,
    attester_execute: false,
    command_owner_execute: true,
    assertion_owner_execute: false,
    finance_owner_execute: false,
    telemetry_owner_execute: false,
    public_execute: false,
    execute_grantees: [
      names.commandOwnerRole,
      ...(dependency ? [names.migrationRole] : []),
      ...(api ? [names.apiRole] : []),
    ],
  };
}

function functionRow(identity: (typeof WORK_ORDER_AUTHORITY_FUNCTIONS)[number]) {
  const row = functionRowBeforeRecoveryObservation(identity);
  if (!CHANGE_ORDER_RECOVERY_OBSERVATION_DEPENDENCIES.some((dependency) => dependency === identity))
    return row;
  return {
    ...row,
    finance_owner_execute: true,
    execute_grantees: [...new Set([...row.execute_grantees!, names.financeOwnerRole])],
  };
}

function relationRow(
  relation: (typeof WORK_ORDER_COMMAND_WRITE_RELATIONS)[number]
): WorkOrderCommandRelationPrivilegeRow {
  const row = baseRelationRow(relation);
  if (FAKE_FINANCIAL_WEBHOOK_RELATIONS.some((item) => item === relation)) {
    const provenance = relation === FAKE_FINANCIAL_WEBHOOK_VERIFICATIONS,
      processing = relation === FAKE_FINANCIAL_WEBHOOK_PROCESSING;
    row.owner_role = provenance ? names.financeOwnerRole : names.migrationRole;
    row.migration_insert =
      row.migration_update =
      row.migration_delete =
      row.migration_truncate =
      row.migration_any_column_update =
        !provenance;
    row.finance_owner_insert = provenance || processing;
    row.finance_owner_update =
      row.finance_owner_delete =
      row.finance_owner_truncate =
      row.finance_owner_any_column_update =
        provenance;
    row.acl_grants = provenance
      ? []
      : [
          names.financeOwnerRole + '|SELECT|' + (processing ? 'observation_id' : '*'),
          ...(processing ? [names.financeOwnerRole + '|INSERT|*'] : []),
        ];
    return row;
  }
  if (
    relation === 'public.provider_event_inbox_observations' ||
    relation === 'public.provider_event_inbox_receipts'
  ) {
    row.finance_owner_insert = true;
    row.acl_grants!.push(names.financeOwnerRole + '|INSERT|*');
  }
  const provenance = relation === FAKE_FINANCIAL_PREPARATION_PROVENANCE;
  const additional = [
    ...FAKE_FINANCIAL_PREPARATION_ADDITIONAL_RELATIONS,
    ...CHANGE_ORDER_MATERIALIZATION_ADDITIONAL_RELATIONS,
  ].some((item) => item === relation);
  if (provenance) {
    row.owner_role = names.commandOwnerRole;
    row.command_owner_insert =
      row.command_owner_update =
      row.command_owner_delete =
      row.command_owner_truncate =
        true;
    row.command_owner_any_column_update = true;
    for (const column of FAKE_FINANCIAL_PREPARATION_PROVENANCE_READ_COLUMNS)
      row.acl_grants!.push(names.financeOwnerRole + '|SELECT|' + column);
  }
  if (additional) {
    row.migration_insert =
      row.migration_update =
      row.migration_delete =
      row.migration_truncate =
        true;
    row.migration_any_column_update = true;
  }
  const columns = FAKE_FINANCIAL_PREPARATION_READ_COLUMNS[relation];
  if (columns)
    for (const column of columns)
      row.acl_grants!.push(names.commandOwnerRole + '|SELECT|' + column);
  const locks = [
    ...(FAKE_FINANCIAL_PREPARATION_LOCK_COLUMNS[relation] ?? []),
    ...(CHANGE_ORDER_COMMAND_UPDATE_COLUMNS[relation] ?? []),
    ...(CHANGE_ORDER_MATERIALIZATION_UPDATE_COLUMNS[relation] ?? []),
  ];
  if (locks.length) {
    row.command_owner_any_column_update = true;
    row.command_owner_update_columns = [
      ...new Set([...row.command_owner_update_columns!, ...locks]),
    ];
    for (const column of locks) row.acl_grants!.push(names.commandOwnerRole + '|UPDATE|' + column);
  }
  if (relation === 'public.universal_v1_prepared_financial_commands') {
    row.command_owner_insert = true;
    row.acl_grants!.push(names.commandOwnerRole + '|INSERT|*');
  }
  for (const column of CHANGE_ORDER_COMMAND_READ_COLUMNS[relation] ?? [])
    row.acl_grants!.push(names.commandOwnerRole + '|SELECT|' + column);
  for (const column of CHANGE_ORDER_COMMAND_INSERT_COLUMNS[relation] ?? [])
    row.acl_grants!.push(names.commandOwnerRole + '|INSERT|' + column);
  for (const column of CHANGE_ORDER_MATERIALIZATION_READ_COLUMNS[relation] ?? [])
    row.acl_grants!.push(names.commandOwnerRole + '|SELECT|' + column);
  for (const column of CHANGE_ORDER_MATERIALIZATION_INSERT_COLUMNS[relation] ?? [])
    row.acl_grants!.push(names.commandOwnerRole + '|INSERT|' + column);
  for (const column of CHANGE_ORDER_RECOVERY_CLAIM_INSERT_COLUMNS[relation] ?? [])
    row.acl_grants!.push(names.financeOwnerRole + '|INSERT|' + column);
  for (const column of CHANGE_ORDER_RECOVERY_OBSERVATION_READ_COLUMNS[relation] ?? [])
    row.acl_grants!.push(names.financeOwnerRole + '|SELECT|' + column);
  for (const column of CHANGE_ORDER_RECOVERY_CLAIM_LOCK_COLUMNS[relation] ?? []) {
    row.finance_owner_any_column_update = true;
    row.acl_grants!.push(names.financeOwnerRole + '|UPDATE|' + column);
  }
  return row;
}

const ready: WorkOrderCommandAuthorityEvidence = {
  currentRole: names.migrationRole,
  sessionRole: names.migrationRole,
  backendPid: 12_345,
  transactionIsolation: 'repeatable read',
  transactionReadOnly: true,
  searchPath: 'pg_catalog',
  snapshotStable: true,
  roles: [
    role(names.migrationRole, true),
    role(names.apiRole, true),
    role(names.workerRole, true),
    role(names.attesterRole, true),
    role(names.commandOwnerRole, false),
    role(names.assertionOwnerRole, false),
    role(names.financeOwnerRole, false),
    role(names.telemetryOwnerRole, false),
  ],
  commandFunctions: WORK_ORDER_AUTHORITY_FUNCTIONS.map(functionRow),
  functionCatalog: [
    {
      function_count: WORK_ORDER_AUTHORITY_FUNCTIONS.length,
      function_catalog_sha256: WORK_ORDER_AUTHORITY_FUNCTION_CATALOG_SHA256,
    },
  ],
  legacyDigestCallers: [],
  webhookVerifier: [{ webhook_verifier_valid: true }],
  ownedAuthorityFunctions: WORK_ORDER_AUTHORITY_FUNCTIONS.map(functionRow)
    .filter(
      (row) =>
        row.owner_role === names.migrationRole ||
        row.owner_role === names.commandOwnerRole ||
        row.owner_role === names.assertionOwnerRole ||
        row.owner_role === names.financeOwnerRole ||
        row.owner_role === names.telemetryOwnerRole
    )
    .map((row) => ({
      function_oid: row.function_oid!,
      function_identity: row.function_identity,
      owner_role: row.owner_role!,
      protected_authority: true,
      protected_trigger: false,
      retained_custody_valid:
        row.function_identity === CHANGE_ORDER_MATERIALIZATION_WITNESS_HASH ? true : undefined,
    })),
  relationPrivileges: WORK_ORDER_COMMAND_WRITE_RELATIONS.map(relationRow),
  membershipEdges: [],
  effectiveRoleReachability: [],
  schemas: [
    {
      schema_name: 'hx_authority',
      owner_role: names.assertionOwnerRole,
      create_grantees: [names.assertionOwnerRole],
    },
    {
      schema_name: 'public',
      owner_role: names.migrationRole,
      create_grantees: [names.migrationRole],
    },
  ],
  defaultPrivileges: [
    names.migrationRole,
    names.commandOwnerRole,
    names.assertionOwnerRole,
    names.financeOwnerRole,
    names.telemetryOwnerRole,
  ].flatMap((owner_role) =>
    ['GLOBAL', 'public', 'hx_authority'].flatMap((scope_name) =>
      [
        { object_kind: 'FUNCTION', privileges: ['EXECUTE'] },
        {
          object_kind: 'TABLE',
          privileges: ['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'],
        },
        { object_kind: 'SEQUENCE', privileges: ['USAGE'] },
      ].map(({ object_kind, privileges }) => ({
        owner_role,
        scope_name,
        object_kind,
        grants: scope_name === 'GLOBAL' ? privileges.map((value) => `${owner_role}|${value}`) : [],
      }))
    )
  ),
  triggerCatalog: [
    {
      trigger_count: WORK_ORDER_TRIGGER_CATALOG_COUNT,
      trigger_catalog_sha256: WORK_ORDER_TRIGGER_CATALOG_SHA256,
    },
  ],
  bootstrapEvidence: [
    {
      evidence_row_count: 1,
      evidence_v12_sha256: WORK_ORDER_FAKE_FINANCIAL_V12_SQL_SHA256,
      evidence_ordinal146_sha256: WORK_ORDER_ORDINAL146_SQL_SHA256,
      seal_evidence_row_count: 1,
      seal_evidence_sha256: WORK_ORDER_BOOTSTRAP_SEAL_SQL_SHA256,
      seal_evidence_ordinal146_sha256: WORK_ORDER_ORDINAL146_SQL_SHA256,
      seal_evidence_v12_sha256: WORK_ORDER_FAKE_FINANCIAL_V12_SQL_SHA256,
      v13_evidence_row_count: 1,
      v13_evidence_sha256: FAKE_FINANCIAL_OUTBOX_V13_SQL_SHA256,
    },
  ],
};

describe('Work Order database command role configuration', () => {
  it('requires eight explicit, valid, pairwise-distinct role identities', () => {
    expect(configuredWorkOrderCommandRoles(configuredEnvironment)).toEqual(names);

    expect(() =>
      configuredWorkOrderCommandRoles({
        ...configuredEnvironment,
        HX_WORK_ORDER_ATTESTER_DATABASE_ROLE: undefined,
      })
    ).toThrow('WORK_ORDER_COMMAND_AUTHORITY_REFUSED:HX_WORK_ORDER_ATTESTER_DATABASE_ROLE_REQUIRED');
    expect(() =>
      configuredWorkOrderCommandRoles({
        ...configuredEnvironment,
        HX_WORK_ORDER_API_DATABASE_ROLE: names.workerRole,
      })
    ).toThrow('WORK_ORDER_COMMAND_AUTHORITY_REFUSED:ROLES_MUST_BE_PAIRWISE_DISTINCT');
    expect(() =>
      configuredWorkOrderCommandRoles({
        ...configuredEnvironment,
        HX_FINANCE_COMMAND_OWNER_DATABASE_ROLE: 'Role-With-Dashes',
      })
    ).toThrow(
      'WORK_ORDER_COMMAND_AUTHORITY_REFUSED:HX_FINANCE_COMMAND_OWNER_DATABASE_ROLE_INVALID'
    );
    expect(() =>
      configuredWorkOrderCommandRoles({
        ...configuredEnvironment,
        HX_TELEMETRY_OWNER_DATABASE_ROLE: undefined,
      })
    ).toThrow('WORK_ORDER_COMMAND_AUTHORITY_REFUSED:HX_TELEMETRY_OWNER_DATABASE_ROLE_REQUIRED');
  });
});

describe('Work Order database command authority evaluation', () => {
  it.each([
    ['missing policy row lock', 'public.region_policies', 'UPDATE|id', true],
    ['extra policy state write', 'public.region_policies', 'UPDATE|policy_state', false],
    ['extra question content read', 'public.task_public_questions', 'SELECT|question_text', false],
    ['whole policy table read', 'public.region_policies', 'SELECT|*', false],
  ] as const)(
    'refuses materialization guard privilege drift: %s',
    (_label, relation, privilege, remove) => {
      const grant = names.commandOwnerRole + '|' + privilege;
      const evidence = {
        ...ready,
        relationPrivileges: ready.relationPrivileges.map((row) =>
          row.relation_name === relation
            ? {
                ...row,
                acl_grants: remove
                  ? row.acl_grants!.filter((value) => value !== grant)
                  : [...row.acl_grants!, grant],
              }
            : row
        ),
      };
      const result = evaluateWorkOrderCommandAuthority(names, evidence);
      expect(result.status).toBe('BLOCKED');
      expect(result.reasons).toContain(
        (remove ? 'RELATION_ACL_GRANT_MISSING:' : 'UNEXPECTED_RELATION_ACL_GRANT:') +
          relation +
          ':' +
          grant
      );
    }
  );
  it('requires exact ChangeOrder INSERT columns and denies whole-table or runtime write grants', () => {
    const relation = 'public.task_scope_change_approvals';
    const missing = names.commandOwnerRole + '|INSERT|actor_id';
    const remove = {
      ...ready,
      relationPrivileges: ready.relationPrivileges.map((row) =>
        row.relation_name === relation
          ? { ...row, acl_grants: row.acl_grants!.filter((grant) => grant !== missing) }
          : row
      ),
    };
    expect(evaluateWorkOrderCommandAuthority(names, remove).reasons).toContain(
      'RELATION_ACL_GRANT_MISSING:' + relation + ':' + missing
    );
    for (const [role, prefix, column] of [
      [names.commandOwnerRole, 'command_owner', '*'],
      [names.commandOwnerRole, 'command_owner', 'id'],
      [names.apiRole, 'api', 'actor_id'],
    ] as const) {
      const extra = role + '|INSERT|' + column;
      const drift = {
        ...ready,
        relationPrivileges: ready.relationPrivileges.map((row) =>
          row.relation_name === relation
            ? {
                ...row,
                ...(column === '*' ? { [prefix + '_insert']: true } : {}),
                acl_grants: [...row.acl_grants!, extra],
              }
            : row
        ),
      };
      expect(evaluateWorkOrderCommandAuthority(names, drift).reasons).toContain(
        'UNEXPECTED_RELATION_ACL_GRANT:' + relation + ':' + extra
      );
    }
  });
  it('denies runtime access to v13 internals and direct ledger writes', () => {
    for (const identity of FAKE_FINANCIAL_OUTBOX_INVOKER_FUNCTIONS) {
      const drifted = {
        ...ready,
        commandFunctions: ready.commandFunctions.map((row) =>
          row.function_identity === identity
            ? {
                ...row,
                worker_execute: true,
                execute_grantees: [...row.execute_grantees!, names.workerRole],
              }
            : row
        ),
      };
      expect(evaluateWorkOrderCommandAuthority(names, drifted).reasons).toContain(
        `FUNCTION_EXECUTE_MUST_BE_REVOKED:WORKER:${identity}`
      );
    }
    for (const relation of FAKE_FINANCIAL_OUTBOX_RELATIONS) {
      const drifted = {
        ...ready,
        relationPrivileges: ready.relationPrivileges.map((row) =>
          row.relation_name === relation
            ? {
                ...row,
                worker_insert: true,
                acl_grants: [...row.acl_grants!, `${names.workerRole}|INSERT|*`],
              }
            : row
        ),
      };
      expect(evaluateWorkOrderCommandAuthority(names, drifted).reasons).toContain(
        `RELATION_WRITE_MUST_BE_REVOKED:WORKER:INSERT:${relation}`
      );
    }
  });

  it('requires exactly the three recovery-terminal reads for the finance owner', () => {
    const relation = 'public.universal_v1_change_order_recovery_terminal_facts';
    const grants = ['proposal_id', 'outcome_state', 'recovery_state'].map(
      (column) => `${names.financeOwnerRole}|SELECT|${column}`
    );
    for (const mutation of [...grants, 'extra_column', 'table_read', 'api_read', 'worker_read']) {
      const drifted = {
        ...ready,
        relationPrivileges: ready.relationPrivileges.map((row) => {
          if (row.relation_name !== relation) return row;
          const acl = [...row.acl_grants!];
          if (grants.includes(mutation)) acl.splice(acl.indexOf(mutation), 1);
          else if (mutation === 'extra_column')
            acl.push(`${names.financeOwnerRole}|SELECT|created_at`);
          else if (mutation === 'table_read') acl.push(`${names.financeOwnerRole}|SELECT|*`);
          else if (mutation === 'api_read') acl.push(`${names.apiRole}|SELECT|proposal_id`);
          else acl.push(`${names.workerRole}|SELECT|proposal_id`);
          return { ...row, acl_grants: acl };
        }),
      };
      expect(
        evaluateWorkOrderCommandAuthority(names, drifted).reasons.some((reason) =>
          reason.includes(relation)
        )
      ).toBe(true);
    }
  });

  it('requires exactly the finance owner lock columns and rejects missing or extra grants', () => {
    for (const [relation, columns] of Object.entries(FAKE_FINANCIAL_OUTBOX_LOCK_COLUMNS)) {
      for (const extra of [false, true]) {
        const drifted = {
          ...ready,
          relationPrivileges: ready.relationPrivileges.map((row) =>
            row.relation_name === relation
              ? {
                  ...row,
                  acl_grants: extra
                    ? [...row.acl_grants!, `${names.financeOwnerRole}|UPDATE|unapproved_column`]
                    : row.acl_grants!.filter(
                        (grant) => grant !== `${names.financeOwnerRole}|UPDATE|${columns[0]}`
                      ),
                }
              : row
          ),
        };
        expect(
          evaluateWorkOrderCommandAuthority(names, drifted).reasons.some((reason) =>
            reason.startsWith(`RELATION_COLUMN_UPDATE_MISMATCH:FINANCE_OWNER:${relation}:`)
          )
        ).toBe(true);
      }
    }
  });

  it.each([null, '0'.repeat(64), 'f'.repeat(64)])(
    'blocks v13 runtime evidence drift: %s',
    (digest) => {
      expect(
        evaluateWorkOrderCommandAuthority(names, {
          ...ready,
          bootstrapEvidence: [{ ...ready.bootstrapEvidence[0]!, v13_evidence_sha256: digest }],
        }).reasons
      ).toContain('V13_EVIDENCE_DIGEST_MISMATCH');
    }
  );

  it('routes repository finalization through the sealed port and covers its direct-write surface', () => {
    const start = workOrderRepositorySource.indexOf('async finalizeMaterialization(');
    const end = workOrderRepositorySource.indexOf('async claimMaterializationCompensation(', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const finalizationSource = workOrderRepositorySource.slice(start, end);
    expect(finalizationSource).toContain('public.hxos_materialize_universal_v1_fake_work_order_v1');
    expect(finalizationSource).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/iu);
    const migrationStart = commandPortsMigrationSource.indexOf(
      'CREATE OR REPLACE FUNCTION public.hxos_materialize_universal_v1_fake_work_order_v1('
    );
    const migrationEnd = commandPortsMigrationSource.indexOf(
      '-- Migration SQL never creates roles',
      migrationStart
    );
    expect(migrationStart).toBeGreaterThanOrEqual(0);
    expect(migrationEnd).toBeGreaterThan(migrationStart);
    const sealedFinalizationSource = commandPortsMigrationSource.slice(
      migrationStart,
      migrationEnd
    );
    const directlyMutatedRelations = new Set(
      [
        ...sealedFinalizationSource.matchAll(
          /\bINSERT\s+INTO\s+public\.([a-z_][a-z0-9_]*)|\b(?<!FOR\s)UPDATE\s+public\.([a-z_][a-z0-9_]*)/giu
        ),
      ].map((match) => `public.${match[1] ?? match[2]}`)
    );

    expect(directlyMutatedRelations).toEqual(
      new Set([
        'public.task_work_orders',
        'public.task_work_order_execution_facts',
        'public.task_reservations',
        'public.task_applications',
      ])
    );
    const protectedRelations = new Set<string>(WORK_ORDER_COMMAND_WRITE_RELATIONS);
    for (const relation of directlyMutatedRelations) {
      expect(protectedRelations.has(relation)).toBe(true);
    }
  });

  it('reports READY only for the exact eight-role, function, ACL, source, and DML topology', () => {
    expect(WORK_ORDER_ORDINAL146_SQL_SHA256).toBe(
      createHash('sha256').update(commandPortsMigrationSource, 'utf8').digest('hex')
    );
    expect(WORK_ORDER_FAKE_FINANCIAL_V12_SQL_SHA256).toBe(
      createHash('sha256').update(fakeFinancialV12MigrationSource, 'utf8').digest('hex')
    );
    expect(WORK_ORDER_BOOTSTRAP_SEAL_SQL_SHA256).toBe(
      createHash('sha256').update(bootstrapSealMigrationSource, 'utf8').digest('hex')
    );
    expect(evaluateWorkOrderCommandAuthority(names, ready)).toEqual(
      expect.objectContaining({
        status: 'READY',
        reasons: [],
        actorBindingProven: true,
        functionIdentities: WORK_ORDER_AUTHORITY_FUNCTIONS,
        protectedWriteRelations: WORK_ORDER_COMMAND_WRITE_RELATIONS,
      })
    );
    expect(WORK_ORDER_COMMAND_FUNCTION).toBe(
      'public.hxos_materialize_universal_v1_fake_work_order_v1(text,text,text,uuid)'
    );
  });

  it('blocks absent, duplicate, or digest-drifted immutable v12 bootstrap evidence', () => {
    const cases: Array<{
      bootstrapEvidence: WorkOrderCommandAuthorityEvidence['bootstrapEvidence'];
      reason: string;
    }> = [
      { bootstrapEvidence: [], reason: 'BOOTSTRAP_EVIDENCE_SNAPSHOT_ROW_COUNT_INVALID' },
      {
        bootstrapEvidence: [ready.bootstrapEvidence[0]!, ready.bootstrapEvidence[0]!],
        reason: 'BOOTSTRAP_EVIDENCE_SNAPSHOT_ROW_COUNT_INVALID',
      },
      {
        bootstrapEvidence: [{ ...ready.bootstrapEvidence[0]!, evidence_row_count: 0 }],
        reason: 'BOOTSTRAP_EVIDENCE_ROW_COUNT_MISMATCH',
      },
      {
        bootstrapEvidence: [
          { ...ready.bootstrapEvidence[0]!, evidence_ordinal146_sha256: 'f'.repeat(64) },
        ],
        reason: 'V12_EVIDENCE_ORDINAL146_DIGEST_MISMATCH',
      },
      {
        bootstrapEvidence: [
          { ...ready.bootstrapEvidence[0]!, evidence_v12_sha256: 'f'.repeat(64) },
        ],
        reason: 'V12_EVIDENCE_DIGEST_MISMATCH',
      },
      {
        bootstrapEvidence: [{ ...ready.bootstrapEvidence[0]!, seal_evidence_row_count: 0 }],
        reason: 'BOOTSTRAP_SEAL_EVIDENCE_ROW_COUNT_MISMATCH',
      },
      {
        bootstrapEvidence: [
          { ...ready.bootstrapEvidence[0]!, seal_evidence_sha256: 'f'.repeat(64) },
        ],
        reason: 'BOOTSTRAP_SEAL_EVIDENCE_DIGEST_MISMATCH',
      },
      {
        bootstrapEvidence: [
          {
            ...ready.bootstrapEvidence[0]!,
            seal_evidence_ordinal146_sha256: 'f'.repeat(64),
          },
        ],
        reason: 'BOOTSTRAP_SEAL_ORDINAL146_DIGEST_MISMATCH',
      },
      {
        bootstrapEvidence: [
          { ...ready.bootstrapEvidence[0]!, seal_evidence_v12_sha256: 'f'.repeat(64) },
        ],
        reason: 'BOOTSTRAP_SEAL_V12_DIGEST_MISMATCH',
      },
    ];

    for (const testCase of cases) {
      const result = evaluateWorkOrderCommandAuthority(names, {
        ...ready,
        bootstrapEvidence: testCase.bootstrapEvidence,
      });
      expect(result.status).toBe('BLOCKED');
      expect(result.reasons).toContain(testCase.reason);
    }
  });

  it('reports missing not-yet-implemented functions as BLOCKED', () => {
    const missing = WORK_ORDER_HUMAN_COMMAND_FUNCTIONS[0];
    const result = evaluateWorkOrderCommandAuthority(names, {
      ...ready,
      commandFunctions: ready.commandFunctions.map((row) =>
        row.function_identity === missing ? { ...row, function_oid: null } : row
      ),
    });
    expect(result.status).toBe('BLOCKED');
    expect(result.actorBindingProven).toBe(false);
    expect(result.reasons).toContain(`FUNCTION_NOT_FOUND:${missing}`);
  });

  it('recognizes the ordinal-145 kernel source while future command functions remain blocked', () => {
    const issuerStart = actorAssertionKernelMigrationSource.indexOf(
      'CREATE OR REPLACE FUNCTION public.hxos_issue_universal_v1_actor_assertion_v1('
    );
    const consumerStart = actorAssertionKernelMigrationSource.indexOf(
      'CREATE OR REPLACE FUNCTION hx_authority.consume_universal_v1_actor_assertion_v1('
    );
    const kernelRevokeStart = actorAssertionKernelMigrationSource.indexOf(
      'REVOKE ALL ON TABLE',
      consumerStart
    );
    expect(issuerStart).toBeGreaterThanOrEqual(0);
    expect(consumerStart).toBeGreaterThan(issuerStart);
    expect(kernelRevokeStart).toBeGreaterThan(consumerStart);

    const futureFunctions = new Set<string>([
      ...WORK_ORDER_HUMAN_COMMAND_FUNCTIONS,
      ...WORK_ORDER_WORKER_COMMAND_FUNCTIONS,
    ]);
    const result = evaluateWorkOrderCommandAuthority(names, {
      ...ready,
      commandFunctions: ready.commandFunctions.map((row) => {
        if (row.function_identity === WORK_ORDER_ASSERTION_ISSUER_FUNCTION) {
          return {
            ...row,
            definition: actorAssertionKernelMigrationSource.slice(issuerStart, consumerStart),
          };
        }
        if (row.function_identity === WORK_ORDER_ASSERTION_CONSUMER_FUNCTION) {
          return {
            ...row,
            definition: actorAssertionKernelMigrationSource.slice(consumerStart, kernelRevokeStart),
          };
        }
        return futureFunctions.has(row.function_identity) ? { ...row, function_oid: null } : row;
      }),
    });

    expect(result.status).toBe('BLOCKED');
    expect(result.actorBindingProven).toBe(false);
    expect(result.reasons).toContain('ACTOR_ASSERTION_ISSUER_PROTOCOL_UNPROVEN');
    expect(result.reasons).toContain('ACTOR_ASSERTION_CONSUMER_PROTOCOL_UNPROVEN');
    for (const identity of futureFunctions) {
      expect(result.reasons).toContain(`FUNCTION_NOT_FOUND:${identity}`);
    }
  });

  it('derives actor-binding proof from issuer, consumer, and human-command source', () => {
    const human = WORK_ORDER_HUMAN_COMMAND_FUNCTIONS[1];
    const result = evaluateWorkOrderCommandAuthority(names, {
      ...ready,
      commandFunctions: ready.commandFunctions.map((row) => {
        if (row.function_identity === WORK_ORDER_ASSERTION_ISSUER_FUNCTION) {
          return { ...row, definition: 'BEGIN RETURN; END' };
        }
        if (row.function_identity === WORK_ORDER_ASSERTION_CONSUMER_FUNCTION) {
          return { ...row, definition: 'BEGIN RETURN; END' };
        }
        if (row.function_identity === human) {
          return {
            ...row,
            definition:
              "BEGIN actor_id := current_setting('hustlexp.authenticated_actor_id', true); END",
            argument_names: ['p_actor_id'],
          };
        }
        return row;
      }),
    });
    expect(result.status).toBe('BLOCKED');
    expect(result.actorBindingProven).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        'ACTOR_ASSERTION_ISSUER_PROTOCOL_UNPROVEN',
        'ACTOR_ASSERTION_CONSUMER_PROTOCOL_UNPROVEN',
        `ACTOR_ASSERTION_CONSUMER_CALL_MISSING:${human}`,
        `CALLER_ACTOR_ARGUMENT_PRESENT:${human}`,
        `RUNTIME_WRITABLE_ACTOR_SETTING_IS_NOT_AUTHORITY:${human}`,
      ])
    );
  });

  it('accepts each exact runtime LOGIN role only when explicitly selected as verifier', () => {
    for (const verifierRole of ['apiRole', 'workerRole', 'attesterRole'] as const) {
      const result = evaluateWorkOrderCommandAuthority(
        names,
        {
          ...ready,
          currentRole: names[verifierRole],
          sessionRole: names[verifierRole],
        },
        verifierRole
      );
      expect(result).toMatchObject({
        status: 'READY',
        reasons: [],
        currentRole: names[verifierRole],
        sessionRole: names[verifierRole],
      });
      expect(evaluateWorkOrderCommandAuthority(names, ready, verifierRole).reasons).toEqual(
        expect.arrayContaining([
          `CURRENT_ROLE_IS_NOT_CONFIGURED_${
            verifierRole === 'apiRole'
              ? 'API'
              : verifierRole === 'workerRole'
                ? 'WORKER'
                : 'ATTESTER'
          }_ROLE`,
          `SESSION_ROLE_IS_NOT_CONFIGURED_${
            verifierRole === 'apiRole'
              ? 'API'
              : verifierRole === 'workerRole'
                ? 'WORKER'
                : 'ATTESTER'
          }_ROLE`,
        ])
      );
    }
  });

  it('blocks invalid role shape, inherited authority, schema creation, TEMP, and wrong session', () => {
    const result = evaluateWorkOrderCommandAuthority(names, {
      ...ready,
      currentRole: names.workerRole,
      sessionRole: names.apiRole,
      transactionIsolation: 'read committed',
      transactionReadOnly: false,
      searchPath: 'attacker_schema, pg_catalog',
      snapshotStable: false,
      roles: ready.roles.map((row) => {
        if (row.rolname === names.apiRole) {
          return {
            ...row,
            rolcanlogin: false,
            rolsuper: true,
            inherited_roles: ['pg_write_all_data'],
            public_schema_create: true,
            database_temp: true,
          };
        }
        if (row.rolname === names.commandOwnerRole) return { ...row, rolcanlogin: true };
        return row;
      }),
    });
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        'CURRENT_ROLE_IS_NOT_CONFIGURED_MIGRATION_ROLE',
        'SESSION_ROLE_IS_NOT_CONFIGURED_MIGRATION_ROLE',
        'AUTHORITY_READBACK_NOT_REPEATABLE_READ',
        'AUTHORITY_READBACK_NOT_READ_ONLY',
        'AUTHORITY_READBACK_SNAPSHOT_SESSION_CHANGED',
        'AUTHORITY_SEARCH_PATH_NOT_FIXED:attacker_schema, pg_catalog',
        'API_ROLE_ELEVATED',
        'API_ROLE_INHERITED_MEMBERSHIP_PRESENT',
        'API_ROLE_CAN_CREATE_TEMP_OBJECTS',
        'API_ROLE_MUST_LOGIN',
        'API_ROLE_CAN_CREATE_IN_PUBLIC_SCHEMA',
        'COMMAND_OWNER_ROLE_MUST_BE_NOLOGIN',
      ])
    );
  });

  it('blocks wrong function owner, flags, search path, and exact role ACLs', () => {
    const target = WORK_ORDER_HUMAN_COMMAND_FUNCTIONS[2];
    const result = evaluateWorkOrderCommandAuthority(names, {
      ...ready,
      commandFunctions: ready.commandFunctions.map((row) =>
        row.function_identity === target
          ? {
              ...row,
              owner_role: names.assertionOwnerRole,
              security_definer: false,
              volatility: 's',
              parallel_safety: 'r',
              configuration: ['search_path=public'],
              api_execute: false,
              worker_execute: true,
              migration_execute: true,
              public_execute: true,
            }
          : row
      ),
    });
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        `FUNCTION_OWNER_MISMATCH:${target}`,
        `FUNCTION_NOT_SECURITY_DEFINER:${target}`,
        `FUNCTION_NOT_VOLATILE:${target}`,
        `FUNCTION_NOT_PARALLEL_UNSAFE:${target}`,
        `FUNCTION_SEARCH_PATH_NOT_FIXED:${target}`,
        `FUNCTION_EXECUTE_MISSING:API:${target}`,
        `FUNCTION_EXECUTE_MUST_BE_REVOKED:WORKER:${target}`,
        `FUNCTION_EXECUTE_MUST_BE_REVOKED:MIGRATION:${target}`,
        `PUBLIC_EXECUTE_MUST_BE_REVOKED:${target}`,
      ])
    );
  });

  it('permits only the exact implicit current database-owner membership', () => {
    const evidence = {
      ...ready,
      roles: ready.roles.map((role) =>
        role.rolname === names.commandOwnerRole
          ? {
              ...role,
              database_owner: true,
              member_of_roles: ['pg_database_owner'],
              inherited_roles: ['pg_database_owner'],
            }
          : role
      ),
    };
    expect(evaluateWorkOrderCommandAuthority(names, evidence).status).toBe('READY');
    for (const override of [
      { database_owner: false },
      { member_of_roles: ['pg_database_owner', 'pg_read_all_data'] },
    ]) {
      const changed = {
        ...evidence,
        roles: evidence.roles.map((role) =>
          role.rolname === names.commandOwnerRole ? { ...role, ...override } : role
        ),
      };
      expect(evaluateWorkOrderCommandAuthority(names, changed).reasons).toContain(
        'COMMAND_OWNER_ROLE_INHERITED_MEMBERSHIP_PRESENT'
      );
    }
  });
  it('requires positive catalog custody evidence for each observed retained function', () => {
    const row = {
      function_oid: '999991',
      function_identity: 'public.digest(text,text)',
      owner_role: names.financeOwnerRole,
      protected_authority: false,
      protected_trigger: false,
      retained_custody_valid: true,
    };
    const evidence = { ...ready, ownedAuthorityFunctions: [...ready.ownedAuthorityFunctions, row] };
    expect(evaluateWorkOrderCommandAuthority(names, evidence).status).toBe('READY');
    row.retained_custody_valid = false;
    expect(evaluateWorkOrderCommandAuthority(names, evidence).reasons).toContain(
      'RETAINED_FUNCTION_CUSTODY_INVALID:public.digest(text,text)'
    );
  });

  it('blocks a rogue function owned by either NOLOGIN authority owner', () => {
    const commandRogue = 'public.hxos_rogue_work_order_command_v1()';
    const financeRogue = 'public.hxos_rogue_finance_command_v1()';
    const result = evaluateWorkOrderCommandAuthority(names, {
      ...ready,
      ownedAuthorityFunctions: [
        ...ready.ownedAuthorityFunctions,
        {
          function_oid: '999998',
          function_identity: commandRogue,
          owner_role: names.commandOwnerRole,
          protected_authority: false,
          protected_trigger: false,
        },
        {
          function_oid: '999999',
          function_identity: financeRogue,
          owner_role: names.financeOwnerRole,
          protected_authority: false,
          protected_trigger: false,
        },
      ],
    });

    expect(result.status).toBe('BLOCKED');
    expect(result.reasons).toContain(
      `UNPLANNED_AUTHORITY_OWNER_FUNCTION:${names.commandOwnerRole}:${commandRogue}`
    );
    expect(result.reasons).toContain(
      `UNPLANNED_AUTHORITY_OWNER_FUNCTION:${names.financeOwnerRole}:${financeRogue}`
    );
  });

  it('fails closed on missing relations, rogue owners, excess DML, and missing owner DML', () => {
    const missing = WORK_ORDER_COMMAND_WRITE_RELATIONS[0];
    const directlyWritable = 'hx_authority.universal_v1_actor_assertion_consumption_facts';
    const result = evaluateWorkOrderCommandAuthority(names, {
      ...ready,
      relationPrivileges: ready.relationPrivileges
        .filter((row) => row.relation_name !== missing)
        .map((row) =>
          row.relation_name === directlyWritable
            ? {
                ...row,
                owner_role: names.apiRole,
                api_insert: true,
                api_any_column_update: true,
                worker_update: true,
                attester_delete: true,
                command_owner_delete: true,
                command_owner_any_column_update: true,
                command_owner_update_columns: ['forged_column'],
                assertion_owner_insert: false,
                finance_owner_truncate: true,
              }
            : row
        ),
    });
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        `PROTECTED_RELATION_NOT_FOUND:${missing}`,
        `PROTECTED_RELATION_OWNER_MISMATCH:${directlyWritable}:ASSERTION_OWNER:${names.apiRole}`,
        `RELATION_WRITE_MUST_BE_REVOKED:API:INSERT:${directlyWritable}`,
        `RELATION_COLUMN_UPDATE_MUST_BE_REVOKED:API:${directlyWritable}`,
        `RELATION_WRITE_MUST_BE_REVOKED:WORKER:UPDATE:${directlyWritable}`,
        `RELATION_WRITE_MUST_BE_REVOKED:ATTESTER:DELETE:${directlyWritable}`,
        `RELATION_WRITE_MUST_BE_REVOKED:COMMAND_OWNER:DELETE:${directlyWritable}`,
        `RELATION_WRITE_MISSING:ASSERTION_OWNER:INSERT:${directlyWritable}`,
        `RELATION_WRITE_MUST_BE_REVOKED:FINANCE_OWNER:TRUNCATE:${directlyWritable}`,
      ])
    );
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          new RegExp(`^RELATION_COLUMN_UPDATE_MISMATCH:COMMAND_OWNER:${directlyWritable}:`, 'u')
        ),
      ])
    );
  });

  it('blocks rogue LOGIN reachability, inbound membership, schema CREATE, and trigger drift', () => {
    const rogue = 'hx_rogue_login';
    const result = evaluateWorkOrderCommandAuthority(names, {
      ...ready,
      membershipEdges: [{ granted_role: names.commandOwnerRole, member_role: rogue }],
      effectiveRoleReachability: [{ login_role: rogue, protected_role: names.commandOwnerRole }],
      schemas: ready.schemas.map((schema) =>
        schema.schema_name === 'public'
          ? { ...schema, create_grantees: [names.migrationRole, rogue] }
          : schema
      ),
      triggerCatalog: [
        {
          trigger_count: WORK_ORDER_TRIGGER_CATALOG_COUNT,
          trigger_catalog_sha256: 'f'.repeat(64),
        },
      ],
      functionCatalog: [
        {
          function_count: WORK_ORDER_AUTHORITY_FUNCTIONS.length,
          function_catalog_sha256: 'e'.repeat(64),
        },
      ],
      defaultPrivileges: ready.defaultPrivileges.map((row) =>
        row.owner_role === names.financeOwnerRole &&
        row.scope_name === 'GLOBAL' &&
        row.object_kind === 'FUNCTION'
          ? { ...row, grants: [...(row.grants ?? []), 'PUBLIC|EXECUTE'] }
          : row
      ),
    });

    expect(result.status).toBe('BLOCKED');
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        `PROTECTED_ROLE_MEMBERSHIP_EDGE:${names.commandOwnerRole}:${rogue}`,
        `UNEXPECTED_LOGIN_ROLE_REACHES_PROTECTED_ROLE:${rogue}:${names.commandOwnerRole}`,
        expect.stringMatching(/^PROTECTED_SCHEMA_CREATE_ACL_MISMATCH:public:/u),
        `WORK_ORDER_AUTHORITY_FUNCTION_CATALOG_MISMATCH:` +
          `${WORK_ORDER_AUTHORITY_FUNCTIONS.length}:${'e'.repeat(64)}`,
        expect.stringMatching(
          new RegExp(
            `^DEFAULT_PRIVILEGE_ACL_MISMATCH:${names.financeOwnerRole}\\|GLOBAL\\|FUNCTION:`,
            'u'
          )
        ),
        `WORK_ORDER_TRIGGER_CATALOG_MISMATCH:${WORK_ORDER_TRIGGER_CATALOG_COUNT}:` +
          `${'f'.repeat(64)}`,
      ])
    );
  });

  it('binds the exact trigger count independently from the trigger digest', () => {
    const result = evaluateWorkOrderCommandAuthority(names, {
      ...ready,
      triggerCatalog: [
        {
          trigger_count: WORK_ORDER_TRIGGER_CATALOG_COUNT - 1,
          trigger_catalog_sha256: WORK_ORDER_TRIGGER_CATALOG_SHA256,
        },
      ],
    });

    expect(result.status).toBe('BLOCKED');
    expect(result.reasons).toContain(
      `WORK_ORDER_TRIGGER_CATALOG_MISMATCH:${WORK_ORDER_TRIGGER_CATALOG_COUNT - 1}:` +
        WORK_ORDER_TRIGGER_CATALOG_SHA256
    );
  });

  it('blocks every protected function that still reaches the legacy digest oracle', () => {
    const target = WORK_ORDER_CORE_SHA_TRANSITIVE_TRIGGER_FUNCTIONS[0];
    const result = evaluateWorkOrderCommandAuthority(names, {
      ...ready,
      legacyDigestCallers: [
        {
          function_identity: target,
          legacy_digest_definition: "SELECT public.digest(payload, 'sha256')",
        },
      ],
    });

    expect(result.status).toBe('BLOCKED');
    expect(result.reasons).toContain(`PROTECTED_LEGACY_DIGEST_CALLER:${target}`);
  });

  it.each([
    { webhookVerifier: [] },
    { webhookVerifier: [{ webhook_verifier_valid: false }] },
    { webhookVerifier: [{ webhook_verifier_valid: true }, { webhook_verifier_valid: true }] },
  ])(
    'blocks absent, invalid or ambiguous independently read HMAC implementation identity: %j',
    ({ webhookVerifier }) => {
      const result = evaluateWorkOrderCommandAuthority(names, { ...ready, webhookVerifier });
      expect(result.status).toBe('BLOCKED');
      expect(result.reasons).toContain('FAKE_FINANCIAL_WEBHOOK_VERIFIER_IDENTITY_INVALID');
    }
  );

  it('blocks every unplanned function or relation ACL grantee', () => {
    const rogue = 'hx_rogue_login';
    const targetFunction = WORK_ORDER_HUMAN_COMMAND_FUNCTIONS[0];
    const targetRelation = 'public.task_work_orders';
    const result = evaluateWorkOrderCommandAuthority(names, {
      ...ready,
      commandFunctions: ready.commandFunctions.map((row) =>
        row.function_identity === targetFunction
          ? { ...row, execute_grantees: [...(row.execute_grantees ?? []), rogue] }
          : row
      ),
      relationPrivileges: ready.relationPrivileges.map((row) =>
        row.relation_name === targetRelation
          ? { ...row, acl_grants: [...(row.acl_grants ?? []), `${rogue}|SELECT|*`] }
          : row
      ),
    });

    expect(result.status).toBe('BLOCKED');
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`FUNCTION_EXECUTE_GRANTEE_SET_MISMATCH:${targetFunction}:`),
        `UNEXPECTED_RELATION_ACL_GRANT:${targetRelation}:${rogue}|SELECT|*`,
      ])
    );
  });

  it('performs parameterized catalog/source readback only and never emits authority DDL', async () => {
    const query = vi.fn(async (sql: string) => {
      expect(sql).not.toMatch(
        /(?:^|;)\s*(?:CREATE|ALTER|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE|TRUNCATE)\b/u
      );
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith('SET TRANSACTION')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql === 'SET LOCAL search_path = pg_catalog') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('current_user::text')) {
        return {
          rows: [
            {
              current_role: names.migrationRole,
              session_role: names.migrationRole,
              backend_pid: ready.backendPid,
              transaction_isolation: ready.transactionIsolation,
              transaction_read_only: ready.transactionReadOnly,
              search_path: ready.searchPath,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('AS function_catalog_sha256')) {
        return { rows: ready.functionCatalog, rowCount: ready.functionCatalog.length };
      }
      if (sql.includes('AS webhook_verifier_valid'))
        return { rows: ready.webhookVerifier, rowCount: 1 };
      if (sql.includes('AS legacy_digest_definition')) {
        return { rows: ready.legacyDigestCallers, rowCount: ready.legacyDigestCallers.length };
      }
      if (sql.includes('WITH requested(function_identity)')) {
        return { rows: ready.commandFunctions, rowCount: ready.commandFunctions.length };
      }
      if (sql.includes('WHERE owner.rolname = ANY')) {
        return {
          rows: ready.ownedAuthorityFunctions,
          rowCount: ready.ownedAuthorityFunctions.length,
        };
      }
      if (sql.includes('WITH requested(relation_name)')) {
        return { rows: ready.relationPrivileges, rowCount: ready.relationPrivileges.length };
      }
      if (sql.includes('AS evidence_row_count')) {
        return { rows: ready.bootstrapEvidence, rowCount: ready.bootstrapEvidence.length };
      }
      if (sql.includes('FROM pg_catalog.pg_auth_members')) {
        return { rows: ready.membershipEdges, rowCount: ready.membershipEdges.length };
      }
      if (sql.includes('CROSS JOIN protected')) {
        return {
          rows: ready.effectiveRoleReachability,
          rowCount: ready.effectiveRoleReachability.length,
        };
      }
      if (sql.includes('SELECT role.rolname::text, role.rolcanlogin')) {
        return { rows: ready.roles, rowCount: ready.roles.length };
      }
      if (sql.includes('FROM pg_catalog.pg_namespace namespace')) {
        return { rows: ready.schemas, rowCount: ready.schemas.length };
      }
      if (sql.includes('object_kinds(acl_kind, object_kind)')) {
        return { rows: ready.defaultPrivileges, rowCount: ready.defaultPrivileges.length };
      }
      if (sql.includes('WITH trigger_rows AS')) {
        return { rows: ready.triggerCatalog, rowCount: ready.triggerCatalog.length };
      }
      throw new Error(`unexpected authority readback SQL: ${sql}`);
    }) as unknown as QueryFn & ReturnType<typeof vi.fn<QueryFn>>;
    const release = vi.fn();
    const transaction = createWorkOrderCommandAuthorityTransaction(async () => ({
      query,
      release,
    }));

    await expect(
      verifyWorkOrderCommandAuthority(transaction, configuredEnvironment)
    ).resolves.toMatchObject({ status: 'READY', reasons: [] });
    expect(query).toHaveBeenCalledTimes(19);
    expect(query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(query).toHaveBeenNthCalledWith(
      2,
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY'
    );
    expect(query).toHaveBeenNthCalledWith(
      6,
      expect.stringMatching(
        /pg_catalog\.oidvectortypes\(procedure\.proargtypes\)[\s\S]*procedure\.proparallel[\s\S]*pg_catalog\.pg_get_functiondef/iu
      ),
      [
        [...WORK_ORDER_AUTHORITY_FUNCTIONS],
        names.migrationRole,
        names.apiRole,
        names.workerRole,
        names.attesterRole,
        names.commandOwnerRole,
        names.assertionOwnerRole,
        names.financeOwnerRole,
        names.telemetryOwnerRole,
      ]
    );
    expect(query.mock.calls[5]?.[0]).not.toContain('false AS actor_binding');
    expect(query).toHaveBeenNthCalledWith(
      10,
      expect.stringMatching(/pg_catalog\.oidvectortypes/iu),
      [
        [...WORK_ORDER_COMMAND_WRITE_RELATIONS],
        [...WORK_ORDER_AUTHORITY_FUNCTIONS],
        [
          names.migrationRole,
          names.commandOwnerRole,
          names.assertionOwnerRole,
          names.financeOwnerRole,
          names.telemetryOwnerRole,
        ],
        expect.any(String),
      ]
    );
    expect(query).toHaveBeenNthCalledWith(
      7,
      expect.stringMatching(/pg_catalog\.pg_get_functiondef[\s\S]*function_catalog_sha256/iu),
      [[...WORK_ORDER_AUTHORITY_FUNCTIONS]]
    );
    expect(query).toHaveBeenNthCalledWith(3, 'SET LOCAL search_path = pg_catalog');
    expect(query).toHaveBeenLastCalledWith('COMMIT');
    expect(release).toHaveBeenCalledWith(false);

    query.mockClear();
    await expect(
      verifyWorkOrderCommandAuthorityInCurrentSnapshot(
        query,
        configuredEnvironment,
        'migrationRole'
      )
    ).resolves.toMatchObject({ status: 'READY', reasons: [] });
    expect(
      query.mock.calls.some(([sql]) =>
        [
          'BEGIN',
          'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
          'SET LOCAL search_path = pg_catalog',
          'COMMIT',
          'ROLLBACK',
        ].includes(sql)
      )
    ).toBe(false);

    const wrongStartingRowCount = (async (sql: string, params?: unknown[]) => {
      const result = await query(sql, params);
      return sql.includes('current_user::text') ? { ...result, rowCount: 2 } : result;
    }) as QueryFn;
    await expect(
      verifyWorkOrderCommandAuthorityInCurrentSnapshot(
        wrongStartingRowCount,
        configuredEnvironment,
        'migrationRole'
      )
    ).rejects.toThrow('SESSION_IDENTITY_ROW_COUNT_INVALID');

    let identityReadCount = 0;
    const wrongEndingRowCount = (async (sql: string, params?: unknown[]) => {
      const result = await query(sql, params);
      if (!sql.includes('current_user::text')) return result;
      identityReadCount += 1;
      return identityReadCount === 2 ? { ...result, rowCount: 2 } : result;
    }) as QueryFn;
    await expect(
      verifyWorkOrderCommandAuthorityInCurrentSnapshot(
        wrongEndingRowCount,
        configuredEnvironment,
        'migrationRole'
      )
    ).rejects.toThrow('ENDING_SESSION_IDENTITY_ROW_COUNT_INVALID');

    const beginFailure = new Error('begin failed');
    const beginRelease = vi.fn();
    const beginQuery = vi.fn(async (sql: string) => {
      if (sql === 'BEGIN') throw beginFailure;
      return { rows: [], rowCount: 0 };
    }) as unknown as QueryFn & ReturnType<typeof vi.fn<QueryFn>>;
    const beginTransaction = createWorkOrderCommandAuthorityTransaction(async () => ({
      query: beginQuery,
      release: beginRelease,
    }));
    await expect(beginTransaction(async () => 'UNREACHABLE')).rejects.toBe(beginFailure);
    expect(beginQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN']);
    expect(beginRelease).toHaveBeenCalledWith(true);

    const readFailure = new Error('snapshot read failed');
    const readRelease = vi.fn();
    const readQuery = vi.fn(async (sql: string) => {
      if (sql.startsWith('SET TRANSACTION')) throw readFailure;
      return { rows: [], rowCount: 0 };
    }) as unknown as QueryFn & ReturnType<typeof vi.fn<QueryFn>>;
    const readTransaction = createWorkOrderCommandAuthorityTransaction(async () => ({
      query: readQuery,
      release: readRelease,
    }));
    await expect(
      readTransaction(async (transactionQuery) => {
        await transactionQuery('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      })
    ).rejects.toBe(readFailure);
    expect(readQuery.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
      'ROLLBACK',
    ]);
    expect(readRelease).toHaveBeenCalledWith(true);

    const originalFailure = new Error('authority readback failed');
    const poisonedRelease = vi.fn();
    const poisonedQuery = vi.fn(async (sql: string) => {
      if (sql === 'ROLLBACK') throw new Error('rollback failed');
      return { rows: [], rowCount: 0 };
    }) as unknown as QueryFn & ReturnType<typeof vi.fn<QueryFn>>;
    const poisonedTransaction = createWorkOrderCommandAuthorityTransaction(async () => ({
      query: poisonedQuery,
      release: poisonedRelease,
    }));
    await expect(
      poisonedTransaction(async () => {
        throw originalFailure;
      })
    ).rejects.toBe(originalFailure);
    expect(poisonedQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'ROLLBACK']);
    expect(poisonedRelease).toHaveBeenCalledWith(true);

    const commitFailure = new Error('commit failed');
    const commitRelease = vi.fn();
    const commitQuery = vi.fn(async (sql: string) => {
      if (sql === 'COMMIT') throw commitFailure;
      return { rows: [], rowCount: 0 };
    }) as unknown as QueryFn & ReturnType<typeof vi.fn<QueryFn>>;
    const commitTransaction = createWorkOrderCommandAuthorityTransaction(async () => ({
      query: commitQuery,
      release: commitRelease,
    }));
    await expect(commitTransaction(async () => 'READY')).rejects.toBe(commitFailure);
    expect(commitQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT']);
    expect(commitRelease).toHaveBeenCalledWith(true);

    const destroyFailure = new Error('destroy failed');
    const preservedFailure = new Error('preserved authority failure');
    const throwingDestroy = vi.fn(() => {
      throw destroyFailure;
    });
    const destroyQuery = vi.fn(async () => ({ rows: [], rowCount: 0 })) as unknown as QueryFn &
      ReturnType<typeof vi.fn<QueryFn>>;
    const destroyTransaction = createWorkOrderCommandAuthorityTransaction(async () => ({
      query: destroyQuery,
      release: throwingDestroy,
    }));
    await expect(
      destroyTransaction(async () => {
        throw preservedFailure;
      })
    ).rejects.toBe(preservedFailure);
    expect(throwingDestroy).toHaveBeenCalledWith(true);

    const healthyReleaseFailure = new Error('healthy release failed');
    const throwingHealthyRelease = vi.fn(() => {
      throw healthyReleaseFailure;
    });
    const healthyQuery = vi.fn(async () => ({ rows: [], rowCount: 0 })) as unknown as QueryFn &
      ReturnType<typeof vi.fn<QueryFn>>;
    const healthyTransaction = createWorkOrderCommandAuthorityTransaction(async () => ({
      query: healthyQuery,
      release: throwingHealthyRelease,
    }));
    await expect(healthyTransaction(async () => 'READY')).rejects.toBe(healthyReleaseFailure);
    expect(throwingHealthyRelease).toHaveBeenCalledWith(false);
  });
});
