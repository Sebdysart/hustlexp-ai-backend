import { createHash } from 'node:crypto';
import { db } from './db.js';
import {
  CONSTITUTIONAL_BOOTSTRAP_FILE,
  REQUIRED_MIGRATION_FILES,
} from './jobs/engine-automation-migration-files.js';
import {
  engineMigrationArtifactDigest,
  engineMigrationManifest,
} from './jobs/engine-migration-manifest.js';
import { logger } from './logger.js';

type StartupLogger = {
  debug: typeof logger.debug;
  error: typeof logger.error;
  info: typeof logger.info;
  warn: typeof logger.warn;
};

type QueryResult<Row extends Record<string, unknown>> = { rows: Row[] };

export interface StartupSchemaQuery {
  <Row extends Record<string, unknown>>(
    sql: string,
    values?: unknown[]
  ): Promise<QueryResult<Row>>;
}

export type RuntimeSchemaVerification = {
  migrationCount: number;
  schemaVersion: string;
  invariantTriggerCount: number;
  acceptanceTriggerCount: number;
  pinnedFunctionCount: number;
  frozenTableCount: number;
  databaseIdentitySha256: string;
  migrationLedgerSha256: string;
  migrationArtifactSha256: string;
};

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function runtimeDatabaseIdentityDigest(input: {
  databaseName: string;
  databaseOid: string;
  clusterSystemIdentifier: string;
}): string {
  return sha256Json([
    input.databaseName,
    input.databaseOid,
    input.clusterSystemIdentifier,
  ]);
}

export function runtimeMigrationLedgerDigest(
  rows: ReadonlyArray<{ name: string; ordinal: number; source_sha256: string }>,
): string {
  return sha256Json(rows.map((row) => [row.name, row.ordinal, row.source_sha256]));
}

export const RUNTIME_MIGRATION_MANIFEST = [
  CONSTITUTIONAL_BOOTSTRAP_FILE.name,
  ...REQUIRED_MIGRATION_FILES.map(({ name }) => name),
];

export const REQUIRED_RUNTIME_INVARIANT_TRIGGER_MANIFEST = Object.freeze({
  xp_requires_released_escrow: Object.freeze({
    relation: 'public.xp_ledger',
    function: 'public.enforce_xp_requires_released_escrow()',
    enabled: 'A',
    triggerType: 7,
    qualification: null,
    argumentCount: 0,
    definition:
      'CREATE TRIGGER xp_requires_released_escrow BEFORE INSERT ON xp_ledger FOR EACH ROW EXECUTE FUNCTION enforce_xp_requires_released_escrow()',
  }),
  escrow_released_requires_completed_task: Object.freeze({
    relation: 'public.escrows',
    function: 'public.enforce_released_requires_completed()',
    enabled: 'A',
    triggerType: 19,
    qualification: null,
    argumentCount: 0,
    definition:
      'CREATE TRIGGER escrow_released_requires_completed_task BEFORE UPDATE ON escrows FOR EACH ROW EXECUTE FUNCTION enforce_released_requires_completed()',
  }),
  task_completed_requires_accepted_proof: Object.freeze({
    relation: 'public.tasks',
    function: 'public.enforce_completed_requires_accepted_proof()',
    enabled: 'A',
    triggerType: 19,
    qualification: null,
    argumentCount: 0,
    definition:
      'CREATE TRIGGER task_completed_requires_accepted_proof BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION enforce_completed_requires_accepted_proof()',
  }),
  task_terminal_guard: Object.freeze({
    relation: 'public.tasks',
    function: 'public.prevent_task_terminal_mutation()',
    enabled: 'A',
    triggerType: 19,
    qualification: null,
    argumentCount: 0,
    definition:
      'CREATE TRIGGER task_terminal_guard BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION prevent_task_terminal_mutation()',
  }),
  escrow_terminal_guard: Object.freeze({
    relation: 'public.escrows',
    function: 'public.prevent_escrow_terminal_mutation()',
    enabled: 'A',
    triggerType: 19,
    qualification: null,
    argumentCount: 0,
    definition:
      'CREATE TRIGGER escrow_terminal_guard BEFORE UPDATE ON escrows FOR EACH ROW EXECUTE FUNCTION prevent_escrow_terminal_mutation()',
  }),
  escrow_amount_immutable: Object.freeze({
    relation: 'public.escrows',
    function: 'public.prevent_escrow_amount_change()',
    enabled: 'A',
    triggerType: 19,
    qualification: null,
    argumentCount: 0,
    definition:
      'CREATE TRIGGER escrow_amount_immutable BEFORE UPDATE ON escrows FOR EACH ROW EXECUTE FUNCTION prevent_escrow_amount_change()',
  }),
  xp_ledger_no_delete: Object.freeze({
    relation: 'public.xp_ledger',
    function: 'public.prevent_xp_ledger_delete()',
    enabled: 'A',
    triggerType: 11,
    qualification: null,
    argumentCount: 0,
    definition:
      'CREATE TRIGGER xp_ledger_no_delete BEFORE DELETE ON xp_ledger FOR EACH ROW EXECUTE FUNCTION prevent_xp_ledger_delete()',
  }),
  xp_ledger_no_truncate: Object.freeze({
    relation: 'public.xp_ledger',
    function: 'public.prevent_xp_ledger_truncate()',
    enabled: 'A',
    triggerType: 34,
    qualification: null,
    argumentCount: 0,
    definition:
      'CREATE TRIGGER xp_ledger_no_truncate BEFORE TRUNCATE ON xp_ledger FOR EACH STATEMENT EXECUTE FUNCTION prevent_xp_ledger_truncate()',
  }),
  escrow_events_destructive_guard: Object.freeze({
    relation: 'public.escrow_events',
    function: 'public.reject_escrow_event_destructive_mutation()',
    enabled: 'A',
    triggerType: 26,
    qualification: null,
    argumentCount: 0,
    definition:
      'CREATE TRIGGER escrow_events_destructive_guard BEFORE DELETE OR UPDATE ON escrow_events FOR EACH STATEMENT EXECUTE FUNCTION reject_escrow_event_destructive_mutation()',
  }),
  escrow_events_truncate_guard: Object.freeze({
    relation: 'public.escrow_events',
    function: 'public.reject_escrow_event_destructive_mutation()',
    enabled: 'A',
    triggerType: 34,
    qualification: null,
    argumentCount: 0,
    definition:
      'CREATE TRIGGER escrow_events_truncate_guard BEFORE TRUNCATE ON escrow_events FOR EACH STATEMENT EXECUTE FUNCTION reject_escrow_event_destructive_mutation()',
  }),
  admin_actions_destructive_guard: Object.freeze({
    relation: 'public.admin_actions',
    function: 'public.reject_admin_action_destructive_mutation()',
    enabled: 'A',
    triggerType: 27,
    qualification: null,
    argumentCount: 0,
    definition:
      'CREATE TRIGGER admin_actions_destructive_guard BEFORE DELETE OR UPDATE ON admin_actions FOR EACH ROW EXECUTE FUNCTION reject_admin_action_destructive_mutation()',
  }),
  admin_actions_truncate_guard: Object.freeze({
    relation: 'public.admin_actions',
    function: 'public.reject_admin_action_destructive_mutation()',
    enabled: 'A',
    triggerType: 34,
    qualification: null,
    argumentCount: 0,
    definition:
      'CREATE TRIGGER admin_actions_truncate_guard BEFORE TRUNCATE ON admin_actions FOR EACH STATEMENT EXECUTE FUNCTION reject_admin_action_destructive_mutation()',
  }),
  live_task_escrow_check: Object.freeze({
    relation: 'public.tasks',
    function: 'public.live_task_requires_funded_escrow()',
    enabled: 'A',
    triggerType: 19,
    qualification: '(new.live_broadcast_started_at IS DISTINCT FROM old.live_broadcast_started_at)',
    argumentCount: 0,
    definition:
      'CREATE TRIGGER live_task_escrow_check BEFORE UPDATE ON tasks FOR EACH ROW WHEN ((new.live_broadcast_started_at IS DISTINCT FROM old.live_broadcast_started_at)) EXECUTE FUNCTION live_task_requires_funded_escrow()',
  }),
  live_task_price_check: Object.freeze({
    relation: 'public.tasks',
    function: 'public.live_task_price_floor()',
    enabled: 'A',
    triggerType: 23,
    qualification: "(new.mode = 'LIVE'::text)",
    argumentCount: 0,
    definition:
      "CREATE TRIGGER live_task_price_check BEFORE INSERT OR UPDATE ON tasks FOR EACH ROW WHEN ((new.mode = 'LIVE'::text)) EXECUTE FUNCTION live_task_price_floor()",
  }),
} as const);

export const REQUIRED_RUNTIME_INVARIANT_TRIGGERS = Object.freeze(
  Object.keys(REQUIRED_RUNTIME_INVARIANT_TRIGGER_MANIFEST) as Array<
    keyof typeof REQUIRED_RUNTIME_INVARIANT_TRIGGER_MANIFEST
  >
);

export const REQUIRED_RUNTIME_ACCEPTANCE_TRIGGERS = Object.freeze({
  active_refund_claim_accept_gate: 'A',
  task_region_policy_accept_insert_gate: 'A',
  task_region_policy_accept_gate: 'A',
  task_worker_eligibility_accept_insert_gate: 'A',
  task_worker_eligibility_accept_gate: 'A',
  controlled_test_provider_capability_accept_guard: 'A',
  controlled_test_offer_accept_guard: 'A',
  task_liquidity_cell_accept_gate: 'A',
  task_worker_offer_accept_gate: 'A',
} as const);

export const REQUIRED_RUNTIME_ACCEPTANCE_TRIGGER_DEFINITIONS = Object.freeze({
  active_refund_claim_accept_gate:
    'CREATE TRIGGER active_refund_claim_accept_gate BEFORE INSERT OR UPDATE OF state, worker_id ON tasks FOR EACH ROW EXECUTE FUNCTION enforce_no_active_refund_claim_on_accept()',
  task_region_policy_accept_insert_gate:
    "CREATE TRIGGER task_region_policy_accept_insert_gate BEFORE INSERT ON tasks FOR EACH ROW WHEN ((new.state = 'ACCEPTED'::text)) EXECUTE FUNCTION enforce_task_region_policy_on_accept()",
  task_region_policy_accept_gate:
    "CREATE TRIGGER task_region_policy_accept_gate BEFORE UPDATE OF state, worker_id ON tasks FOR EACH ROW WHEN (((new.state = 'ACCEPTED'::text) AND (NOT hxos_same_worker_proof_retake_continuation((old.state)::text, (new.state)::text, old.worker_id, new.worker_id)))) EXECUTE FUNCTION enforce_task_region_policy_on_accept()",
  task_worker_eligibility_accept_insert_gate:
    "CREATE TRIGGER task_worker_eligibility_accept_insert_gate BEFORE INSERT ON tasks FOR EACH ROW WHEN ((new.state = 'ACCEPTED'::text)) EXECUTE FUNCTION enforce_task_worker_eligibility_on_accept()",
  task_worker_eligibility_accept_gate:
    "CREATE TRIGGER task_worker_eligibility_accept_gate BEFORE UPDATE OF state, worker_id ON tasks FOR EACH ROW WHEN (((new.state = 'ACCEPTED'::text) AND (NOT hxos_same_worker_proof_retake_continuation((old.state)::text, (new.state)::text, old.worker_id, new.worker_id)))) EXECUTE FUNCTION enforce_task_worker_eligibility_on_accept()",
  controlled_test_provider_capability_accept_guard:
    'CREATE TRIGGER controlled_test_provider_capability_accept_guard BEFORE INSERT OR UPDATE OF state, worker_id ON tasks FOR EACH ROW EXECUTE FUNCTION enforce_controlled_test_provider_capability_on_accept()',
  controlled_test_offer_accept_guard:
    'CREATE TRIGGER controlled_test_offer_accept_guard BEFORE INSERT OR UPDATE OF state, worker_id ON tasks FOR EACH ROW EXECUTE FUNCTION enforce_controlled_test_offer_acceptance()',
  task_liquidity_cell_accept_gate:
    'CREATE TRIGGER task_liquidity_cell_accept_gate BEFORE INSERT OR UPDATE OF state, worker_id, liquidity_cell_id ON tasks FOR EACH ROW EXECUTE FUNCTION enforce_task_liquidity_cell_on_accept()',
  task_worker_offer_accept_gate:
    'CREATE TRIGGER task_worker_offer_accept_gate BEFORE INSERT OR UPDATE OF state, worker_id ON tasks FOR EACH ROW EXECUTE FUNCTION enforce_worker_offer_decision_on_accept()',
} as const);

export const REQUIRED_RUNTIME_PINNED_FUNCTION_MANIFEST = Object.freeze({
  enforce_task_region_policy_on_accept: '43ed52c845680b2c89aa7fb2c64f8970e1e10763972e4e29637af6936d1b9e97',
  enforce_task_worker_eligibility_on_accept: 'dd012f434e02c4494fb884c33b83c5bdcc32465e7709802752b65134da141823',
  enforce_controlled_test_offer_acceptance: '3b3d759af5c52b1dfd59909fe8098b472bf5053e1ec6e84fedd1a4a143049b7c',
  enforce_controlled_test_provider_capability_on_accept: '762f9ce922b83d1b6b8d733a3a8fe890cc47d9aaeb0a2830c862f0240b9d7016',
  enforce_task_liquidity_cell_on_accept: '3b988eeeb588da82f578eb9fc35ac5452c6452f5dc27b1ec90ab893947993a46',
  enforce_worker_offer_decision_on_accept: '70ab940f11313356c8c8740de23d147339b2ec73516c07006eadfd7278b259a6',
  reject_pr276_incident_table_mutation: 'cc68e89ec9df919e297cfe352566f0a0067f277f6a97dcd5ec09be0ab176ae57',
  reject_control_table_destructive_mutation: '226b6fd1d43e1a567f767c04dfad42a86af418f1abccb3d5710f2a5baa86fa93',
  reject_escrow_event_destructive_mutation: '3f3e2e9a8907a50912b7418e3d8b0eb9e2234fbe54e5e89d8eaa44a56a437f49',
  reject_admin_action_destructive_mutation: 'eee4844d77f5163911eb3070d7a2423bd36e9929e2e36c09981a88cfeaa5fa2c',
  enforce_no_active_refund_claim_on_accept: '3bb20ad8d489715351f6f72b32eb25c9509c5b200ba2ca965f390182326e82c3',
  prevent_task_terminal_mutation: '3b21f6bad8ffda9e0f8776bf85e85e87a7f712c2d566253a78003d483782dba0',
  prevent_escrow_terminal_mutation: '7fc516ac257a887206b2cb3d2f09fd24cddee26f5c4159551311d5efe1a81d78',
  prevent_escrow_amount_change: '1ce478a7834f8252e789177a63f6b4d22b5c5b2689a5c59bd6f32212889f4b6f',
  enforce_xp_requires_released_escrow: 'fdfececc380c64469c5316c36bc77f0d498d1693f450ea886e71c724de5fe1cb',
  prevent_xp_ledger_delete: '20dbb560365a7786d45e8bfdf11396696fc9429c9f294a8b5a31749fb281a153',
  prevent_xp_ledger_truncate: '56420f10e13faca8d666f52c97e8a59e8373156fce6086a0ee14946794933ae2',
  enforce_released_requires_completed: '35cfae4a04ff814e071459ff2ca236267b782c31256d101357297c7589a5b90c',
  enforce_completed_requires_accepted_proof: 'c9439811c1e6e986a42c57c072a0735741c49918f6fda521c58c659262c4c8f4',
  live_task_requires_funded_escrow: 'a057c1152b2a170a8ead6b722102aeea1684a609ab4611db803c4e74894cb3c4',
  live_task_price_floor: '04b8aafc54a8b9edf2b8684e78ed69a93b6da8f7fff6e6387395ad07cd6503e3',
} as const);

export const REQUIRED_RUNTIME_PINNED_FUNCTIONS = Object.freeze(
  Object.keys(REQUIRED_RUNTIME_PINNED_FUNCTION_MANIFEST) as Array<
    keyof typeof REQUIRED_RUNTIME_PINNED_FUNCTION_MANIFEST
  >
);

export const REQUIRED_RUNTIME_PINNED_HELPER_FUNCTION_MANIFEST = Object.freeze({
  'public.hxos_same_worker_proof_retake_continuation(text, text, uuid, uuid)': Object.freeze({
    bodySha256: '74396e06a9f862d24fc8dd3898a7b3eb95be91a338fd9da841a037b7e32d62b3',
    language: 'sql',
    volatility: 'i',
    parallelSafety: 's',
    argumentCount: 4,
    strict: false,
    returnsSet: false,
    returnsBoolean: true,
    functionKind: 'f',
  }),
  'public.hxos_local_test_liquidity_witness_current(uuid, uuid, uuid)': Object.freeze({
    bodySha256: '59ab81cc995dceff319ed18e9d10d565a2543ee5ee0662a0bf1074165813a6d7',
    language: 'sql',
    volatility: 's',
    parallelSafety: 'u',
    argumentCount: 3,
    strict: false,
    returnsSet: false,
    returnsBoolean: true,
    functionKind: 'f',
  }),
  'public.hxos_local_test_provider_capability_current(uuid, uuid, uuid)': Object.freeze({
    bodySha256: '511ff9229d8a6366ded4eb706bc7a32678b069e7640250e03d3a413a9bb3308d',
    language: 'sql',
    volatility: 's',
    parallelSafety: 'u',
    argumentCount: 3,
    strict: false,
    returnsSet: false,
    returnsBoolean: true,
    functionKind: 'f',
  }),
  'public.hxos_local_test_liquidity_witness_current_v2(uuid, uuid, uuid)': Object.freeze({
    bodySha256: 'b742ecbbc1b0e9faf265860e28f8f64398add3d29f71df85bddcb9797f18ef49',
    language: 'sql',
    volatility: 's',
    parallelSafety: 'u',
    argumentCount: 3,
    strict: false,
    returnsSet: false,
    returnsBoolean: true,
    functionKind: 'f',
  }),
  'public.hxos_local_test_offer_action_current(uuid, uuid, uuid, text)': Object.freeze({
    bodySha256: 'cbb001c243e07f0db95e4a305add951c69cbf7b6d16699433e7cb3b75b5032c2',
    language: 'sql',
    volatility: 's',
    parallelSafety: 'u',
    argumentCount: 4,
    strict: false,
    returnsSet: false,
    returnsBoolean: true,
    functionKind: 'f',
  }),
} as const);

export const REQUIRED_RUNTIME_PINNED_HELPER_FUNCTIONS = Object.freeze(
  Object.keys(REQUIRED_RUNTIME_PINNED_HELPER_FUNCTION_MANIFEST) as Array<
    keyof typeof REQUIRED_RUNTIME_PINNED_HELPER_FUNCTION_MANIFEST
  >
);

export const REQUIRED_RUNTIME_CONTROL_TABLES = Object.freeze([
  'public.applied_migrations',
  'public.schema_versions',
  'public.hx_database_identity',
] as const);

export const REQUIRED_RUNTIME_CONTAINMENT_CHECKS = Object.freeze({
  task_business_fulfiller: {
    relation: 'public.tasks',
    column: 'business_fulfiller_organization_id',
    constraint: 'tasks_pr276_business_fulfiller_frozen',
    definition: 'CHECK ((business_fulfiller_organization_id IS NULL)) NOT VALID',
  },
  task_orchestration: {
    relation: 'public.tasks',
    column: 'orchestration_mode',
    constraint: 'tasks_pr276_orchestration_frozen',
    definition: "CHECK ((orchestration_mode = 'AUTOMATED'::text)) NOT VALID",
  },
  quote_business_organization: {
    relation: 'public.quotes',
    column: 'business_organization_id',
    constraint: 'quotes_pr276_business_organization_frozen',
    definition: 'CHECK ((business_organization_id IS NULL)) NOT VALID',
  },
  quote_business_location: {
    relation: 'public.quotes',
    column: 'business_location_id',
    constraint: 'quotes_pr276_business_location_frozen',
    definition: 'CHECK ((business_location_id IS NULL)) NOT VALID',
  },
  quote_provider_service_profile: {
    relation: 'public.quotes',
    column: 'provider_service_profile_id',
    constraint: 'quotes_pr276_provider_service_profile_frozen',
    definition: 'CHECK ((provider_service_profile_id IS NULL)) NOT VALID',
  },
  quote_claimed_by_user: {
    relation: 'public.quotes',
    column: 'claimed_by_user_id',
    constraint: 'quotes_pr276_claimed_by_user_frozen',
    definition: 'CHECK ((claimed_by_user_id IS NULL)) NOT VALID',
  },
} as const);

export const CONDITIONAL_RUNTIME_CONTAINMENT_CHECKS = REQUIRED_RUNTIME_CONTAINMENT_CHECKS;

export const REQUIRED_RUNTIME_PROVIDER_TRANSFER_STATUS_CONSTRAINT = Object.freeze({
  relation: 'public.escrows',
  constraint: 'escrows_provider_transfer_status_ck',
  definition:
    "CHECK (((provider_transfer_status IS NULL) OR (provider_transfer_status = ANY (ARRAY['submitted'::text, 'processing'::text, 'paid'::text, 'manual_reconciliation'::text, 'reversed'::text]))))",
  validated: true,
});

export const REQUIRED_RUNTIME_FROZEN_TABLES = [
  'public.ops_business_claim_links',
  'public.hxos_local_test_business_payout_destinations',
  'public.hxos_local_test_business_payout_transfers',
] as const;

export const OPTIONAL_RUNTIME_FROZEN_TABLES = REQUIRED_RUNTIME_FROZEN_TABLES;

function normalizeCatalogDefinition(definition: string): string {
  return definition.replace(/\s+/g, ' ').trim();
}

function normalizeTriggerDefinition(definition: string): string {
  let normalized = normalizeCatalogDefinition(definition)
    .replace(/(?:"public"|public)\./g, '');
  let previous: string;
  do {
    previous = normalized;
    normalized = normalized.replace(/\((new|old)\.state\)::text/gi, '$1.state');
  } while (normalized !== previous);
  return normalized;
}

function normalizeContainmentDefinition(definition: string): string {
  return normalizeCatalogDefinition(definition)
    .replace(/\(orchestration_mode\)::text/gi, 'orchestration_mode');
}

function databaseErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Runtime admission check. Every query is read-only: schema changes belong to
 * the explicit migrator process, never the API or worker process.
 */
export async function verifyRuntimeSchema(
  startLog: StartupLogger,
  query: StartupSchemaQuery = db.query.bind(db) as StartupSchemaQuery
): Promise<RuntimeSchemaVerification> {
  try {
    const identity = await query<{
      database_name: string;
      database_oid: string;
      cluster_system_identifier: string;
      database_role: string;
      session_role: string;
      recorded_database_name: string;
      recorded_database_oid: string;
      recorded_cluster_system_identifier: string;
      migration_owner: string;
      can_assume_migration_owner: boolean;
    }>(`
      SELECT
        pg_catalog.current_database() AS database_name,
        database_row.oid::text AS database_oid,
        control.system_identifier::text AS cluster_system_identifier,
        current_user AS database_role,
        session_user AS session_role,
        identity.database_name::text AS recorded_database_name,
        identity.database_oid::text AS recorded_database_oid,
        identity.cluster_system_identifier AS recorded_cluster_system_identifier,
        identity.migration_owner::text AS migration_owner,
        pg_catalog.pg_has_role(current_user, identity.migration_owner, 'MEMBER')
          AS can_assume_migration_owner
      FROM pg_catalog.pg_database database_row
      CROSS JOIN pg_catalog.pg_control_system() control
      CROSS JOIN public.hx_database_identity identity
      WHERE database_row.datname = pg_catalog.current_database()
        AND identity.singleton IS TRUE
    `);
    const runtimeIdentity = identity.rows[0];
    if (
      identity.rows.length !== 1
      || !runtimeIdentity
      || runtimeIdentity.database_role !== runtimeIdentity.session_role
      || runtimeIdentity.database_role === runtimeIdentity.migration_owner
      || runtimeIdentity.can_assume_migration_owner
      || runtimeIdentity.database_name !== runtimeIdentity.recorded_database_name
      || runtimeIdentity.database_oid !== runtimeIdentity.recorded_database_oid
      || runtimeIdentity.cluster_system_identifier
        !== runtimeIdentity.recorded_cluster_system_identifier
    ) {
      throw new Error('runtime_database_identity_drift');
    }

    const privilege = await query<{
      elevated_role: boolean;
      can_create_database_objects: boolean;
      can_create_public_objects: boolean;
      can_create_temporary_objects: boolean;
      can_create_triggers: boolean;
      can_set_session_replication_role: boolean;
      has_role_memberships: boolean;
      owns_database: boolean;
      owns_public_schema: boolean;
      owns_public_objects: boolean;
      trusted_search_path: boolean;
      replication_role_is_origin: boolean;
    }>(`
      SELECT
        (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
          AS elevated_role,
        pg_catalog.has_database_privilege(pg_catalog.current_database(), 'CREATE')
          AS can_create_database_objects,
        pg_catalog.has_schema_privilege('public', 'CREATE') AS can_create_public_objects,
        pg_catalog.has_database_privilege(pg_catalog.current_database(), 'TEMPORARY')
          AS can_create_temporary_objects,
        pg_catalog.has_parameter_privilege(current_user, 'session_replication_role', 'SET')
          AS can_set_session_replication_role,
        pg_catalog.current_setting('search_path') = 'pg_catalog, public' AS trusted_search_path,
        pg_catalog.current_setting('session_replication_role') = 'origin'
          AS replication_role_is_origin,
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_class trigger_target
          JOIN pg_catalog.pg_namespace trigger_namespace
            ON trigger_namespace.oid = trigger_target.relnamespace
          WHERE trigger_namespace.nspname = 'public'
            AND trigger_target.relkind IN ('r', 'p')
            AND pg_catalog.has_table_privilege(current_user, trigger_target.oid, 'TRIGGER')
        ) AS can_create_triggers,
        EXISTS (
          SELECT 1 FROM pg_catalog.pg_auth_members membership WHERE membership.member = r.oid
        ) AS has_role_memberships,
        EXISTS (
          SELECT 1 FROM pg_catalog.pg_database d
          WHERE d.datname = pg_catalog.current_database()
            AND pg_catalog.pg_has_role(current_user, d.datdba, 'MEMBER')
        )
          AS owns_database,
        EXISTS (
          SELECT 1 FROM pg_catalog.pg_namespace n
          WHERE n.nspname = 'public'
            AND pg_catalog.pg_has_role(current_user, n.nspowner, 'MEMBER')
        )
          AS owns_public_schema,
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND pg_catalog.pg_has_role(current_user, c.relowner, 'MEMBER')
        ) OR EXISTS (
          SELECT 1
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND pg_catalog.pg_has_role(current_user, p.proowner, 'MEMBER')
        ) OR EXISTS (
          SELECT 1
          FROM pg_catalog.pg_type t
          JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = 'public'
            AND pg_catalog.pg_has_role(current_user, t.typowner, 'MEMBER')
        ) OR EXISTS (
          SELECT 1
          FROM pg_catalog.pg_collation c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.collnamespace
          WHERE n.nspname = 'public'
            AND pg_catalog.pg_has_role(current_user, c.collowner, 'MEMBER')
        ) OR EXISTS (
          SELECT 1
          FROM pg_catalog.pg_conversion c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.connamespace
          WHERE n.nspname = 'public'
            AND pg_catalog.pg_has_role(current_user, c.conowner, 'MEMBER')
        ) OR EXISTS (
          SELECT 1
          FROM pg_catalog.pg_operator o
          JOIN pg_catalog.pg_namespace n ON n.oid = o.oprnamespace
          WHERE n.nspname = 'public'
            AND pg_catalog.pg_has_role(current_user, o.oprowner, 'MEMBER')
        ) AS owns_public_objects
      FROM pg_catalog.pg_roles r
      WHERE r.rolname = current_user
    `);
    const runtimePrivilege = privilege.rows[0];
    if (
      !runtimePrivilege
      || runtimePrivilege.elevated_role
      || runtimePrivilege.can_create_database_objects
      || runtimePrivilege.can_create_public_objects
      || runtimePrivilege.can_create_temporary_objects
      || runtimePrivilege.can_create_triggers
      || runtimePrivilege.can_set_session_replication_role
      || runtimePrivilege.has_role_memberships
      || runtimePrivilege.owns_database
      || runtimePrivilege.owns_public_schema
      || runtimePrivilege.owns_public_objects
      || !runtimePrivilege.trusted_search_path
      || !runtimePrivilege.replication_role_is_origin
    ) {
      throw new Error('runtime_database_privilege_boundary');
    }

    const acceptanceTriggers = await query<{
      trigger_name: string;
      enabled: string;
      definition: string;
    }>(
      `SELECT
         tgname AS trigger_name,
         tgenabled AS enabled,
         pg_get_triggerdef(oid, false) AS definition
       FROM pg_trigger
       WHERE tgrelid = 'public.tasks'::regclass
         AND NOT tgisinternal
         AND tgname = ANY($1::text[])
       ORDER BY tgname`,
      [Object.keys(REQUIRED_RUNTIME_ACCEPTANCE_TRIGGERS)]
    );
    const acceptanceByName = new Map(
      acceptanceTriggers.rows.map((row) => [row.trigger_name, row])
    );
    if (
      acceptanceByName.size !== Object.keys(REQUIRED_RUNTIME_ACCEPTANCE_TRIGGERS).length
      || Object.entries(REQUIRED_RUNTIME_ACCEPTANCE_TRIGGERS).some(
        ([triggerName, expectedEnabled]) => {
          const actual = acceptanceByName.get(triggerName);
          const expectedDefinition = REQUIRED_RUNTIME_ACCEPTANCE_TRIGGER_DEFINITIONS[
            triggerName as keyof typeof REQUIRED_RUNTIME_ACCEPTANCE_TRIGGER_DEFINITIONS
          ];
          return !actual
            || actual.enabled !== expectedEnabled
            || normalizeTriggerDefinition(actual.definition)
              !== normalizeTriggerDefinition(expectedDefinition);
        }
      )
    ) {
      throw new Error('runtime_acceptance_trigger_drift');
    }

    const pinnedFunctions = await query<{
      function_name: string;
      configuration: string[] | null;
      owner_name: string;
      language_name: string;
      security_definer: boolean;
      volatility: string;
      argument_count: number;
      body_sha256: string;
    }>(
      `SELECT
         procedure_row.proname AS function_name,
         procedure_row.proconfig AS configuration,
         owner_role.rolname AS owner_name,
         language_row.lanname AS language_name,
         procedure_row.prosecdef AS security_definer,
         procedure_row.provolatile::text AS volatility,
         procedure_row.pronargs::integer AS argument_count,
         encode(
           sha256(
             convert_to(
               btrim(regexp_replace(procedure_row.prosrc, '\\s+', ' ', 'g')),
               'UTF8'
             )
           ),
           'hex'
         ) AS body_sha256
       FROM pg_catalog.pg_proc procedure_row
       JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = procedure_row.proowner
       JOIN pg_catalog.pg_language language_row ON language_row.oid = procedure_row.prolang
       WHERE procedure_row.pronamespace = 'public'::regnamespace
         AND procedure_row.proname = ANY($1::text[])
         AND procedure_row.pronargs = 0
       ORDER BY procedure_row.proname`,
      [[...REQUIRED_RUNTIME_PINNED_FUNCTIONS]]
    );
    const pinnedByName = new Map(
      pinnedFunctions.rows.map((row) => [row.function_name, row])
    );
    if (
      pinnedByName.size !== REQUIRED_RUNTIME_PINNED_FUNCTIONS.length
      || REQUIRED_RUNTIME_PINNED_FUNCTIONS.some((functionName) => {
        const actual = pinnedByName.get(functionName);
        const expectedBodySha256 = REQUIRED_RUNTIME_PINNED_FUNCTION_MANIFEST[functionName];
        return !actual
          || !actual.configuration
          || actual.configuration.length !== 1
          || actual.configuration[0] !== 'search_path=pg_catalog, public'
          || actual.owner_name !== runtimeIdentity.migration_owner
          || actual.language_name !== 'plpgsql'
          || actual.security_definer
          || actual.volatility !== 'v'
          || actual.argument_count !== 0
          || actual.body_sha256 !== expectedBodySha256;
      })
    ) {
      throw new Error('runtime_function_search_path_drift');
    }

    const pinnedHelperFunctions = await query<{
      function_identity: string;
      configuration: string[] | null;
      owner_name: string;
      language_name: string;
      security_definer: boolean;
      volatility: string;
      parallel_safety: string;
      argument_count: number;
      is_strict: boolean;
      returns_set: boolean;
      returns_boolean: boolean;
      function_kind: string;
      body_sha256: string;
    }>(
      `SELECT
         pg_catalog.format(
           '%I.%I(%s)',
           function_namespace.nspname,
           procedure_row.proname,
           pg_catalog.oidvectortypes(procedure_row.proargtypes)
         ) AS function_identity,
         procedure_row.proconfig AS configuration,
         owner_role.rolname AS owner_name,
         language_row.lanname AS language_name,
         procedure_row.prosecdef AS security_definer,
         procedure_row.provolatile::text AS volatility,
         procedure_row.proparallel::text AS parallel_safety,
         procedure_row.pronargs::integer AS argument_count,
         procedure_row.proisstrict AS is_strict,
         procedure_row.proretset AS returns_set,
         procedure_row.prorettype = 'pg_catalog.bool'::pg_catalog.regtype AS returns_boolean,
         procedure_row.prokind::text AS function_kind,
         pg_catalog.encode(
           pg_catalog.sha256(
             pg_catalog.convert_to(
               pg_catalog.btrim(pg_catalog.regexp_replace(procedure_row.prosrc, '\\s+', ' ', 'g')),
               'UTF8'
             )
           ),
           'hex'
         ) AS body_sha256
       FROM pg_catalog.pg_proc procedure_row
       JOIN pg_catalog.pg_namespace function_namespace
         ON function_namespace.oid = procedure_row.pronamespace
       JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = procedure_row.proowner
       JOIN pg_catalog.pg_language language_row ON language_row.oid = procedure_row.prolang
       WHERE procedure_row.oid = ANY($1::pg_catalog.regprocedure[])
       ORDER BY function_identity`,
      [[...REQUIRED_RUNTIME_PINNED_HELPER_FUNCTIONS]]
    );
    const pinnedHelperByIdentity = new Map(
      pinnedHelperFunctions.rows.map((row) => [row.function_identity, row])
    );
    if (
      pinnedHelperByIdentity.size !== REQUIRED_RUNTIME_PINNED_HELPER_FUNCTIONS.length
      || REQUIRED_RUNTIME_PINNED_HELPER_FUNCTIONS.some((functionIdentity) => {
        const actual = pinnedHelperByIdentity.get(functionIdentity);
        const expected = REQUIRED_RUNTIME_PINNED_HELPER_FUNCTION_MANIFEST[functionIdentity];
        return !actual
          || !actual.configuration
          || actual.configuration.length !== 1
          || actual.configuration[0] !== 'search_path=pg_catalog, public'
          || actual.owner_name !== runtimeIdentity.migration_owner
          || actual.language_name !== expected.language
          || actual.security_definer
          || actual.volatility !== expected.volatility
          || actual.parallel_safety !== expected.parallelSafety
          || actual.argument_count !== expected.argumentCount
          || actual.is_strict !== expected.strict
          || actual.returns_set !== expected.returnsSet
          || actual.returns_boolean !== expected.returnsBoolean
          || actual.function_kind !== expected.functionKind
          || actual.body_sha256 !== expected.bodySha256;
      })
    ) {
      throw new Error('runtime_helper_function_identity_drift');
    }

    const containmentChecks = await query<{
      check_name: string;
      column_exists: boolean;
      constraint_exists: boolean;
      convalidated: boolean | null;
      definition: string | null;
    }>(`
      WITH expected(check_name, relation_name, column_name, constraint_name) AS (
        VALUES
          ('task_business_fulfiller', 'public.tasks', 'business_fulfiller_organization_id', 'tasks_pr276_business_fulfiller_frozen'),
          ('task_orchestration', 'public.tasks', 'orchestration_mode', 'tasks_pr276_orchestration_frozen'),
          ('quote_business_organization', 'public.quotes', 'business_organization_id', 'quotes_pr276_business_organization_frozen'),
          ('quote_business_location', 'public.quotes', 'business_location_id', 'quotes_pr276_business_location_frozen'),
          ('quote_provider_service_profile', 'public.quotes', 'provider_service_profile_id', 'quotes_pr276_provider_service_profile_frozen'),
          ('quote_claimed_by_user', 'public.quotes', 'claimed_by_user_id', 'quotes_pr276_claimed_by_user_frozen')
      )
      SELECT
        expected.check_name,
        EXISTS (
          SELECT 1 FROM pg_attribute attribute
          WHERE attribute.attrelid = to_regclass(expected.relation_name)
            AND attribute.attname = expected.column_name
            AND NOT attribute.attisdropped
        ) AS column_exists,
        containment.oid IS NOT NULL AS constraint_exists,
        containment.convalidated,
        pg_get_constraintdef(containment.oid, false) AS definition
      FROM expected
      LEFT JOIN LATERAL (
        SELECT constraint_row.oid, constraint_row.convalidated
        FROM pg_constraint constraint_row
        WHERE constraint_row.conrelid = to_regclass(expected.relation_name)
          AND constraint_row.conname = expected.constraint_name
          AND constraint_row.contype = 'c'
          AND NOT constraint_row.condeferrable
          AND NOT constraint_row.condeferred
          AND NOT constraint_row.connoinherit
      ) containment ON true
      ORDER BY expected.check_name
    `);
    const containmentByName = new Map(
      containmentChecks.rows.map((row) => [row.check_name, row])
    );
    if (
      containmentByName.size !== Object.keys(REQUIRED_RUNTIME_CONTAINMENT_CHECKS).length
      || Object.entries(REQUIRED_RUNTIME_CONTAINMENT_CHECKS).some(([checkName, expected]) => {
        const actual = containmentByName.get(checkName);
        return !actual
          || !actual.column_exists
          || (
            !actual.constraint_exists
            || actual.convalidated !== false
            || actual.definition === null
            || normalizeContainmentDefinition(actual.definition) !== expected.definition
          );
      })
    ) {
      throw new Error('runtime_conditional_containment_drift');
    }

    const providerTransferStatusConstraint = await query<{
      relation_name: string;
      constraint_name: string;
      convalidated: boolean;
      definition: string;
    }>(`
      SELECT
        format('%I.%I', namespace_row.nspname, relation_row.relname) AS relation_name,
        constraint_row.conname AS constraint_name,
        constraint_row.convalidated,
        pg_get_constraintdef(constraint_row.oid, false) AS definition
      FROM pg_catalog.pg_constraint constraint_row
      JOIN pg_catalog.pg_class relation_row ON relation_row.oid = constraint_row.conrelid
      JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
      WHERE constraint_row.conrelid = 'public.escrows'::regclass
        AND constraint_row.conname = 'escrows_provider_transfer_status_ck'
        AND constraint_row.contype = 'c'
        AND NOT constraint_row.condeferrable
        AND NOT constraint_row.condeferred
        AND NOT constraint_row.connoinherit
    `);
    const providerStatus = providerTransferStatusConstraint.rows[0];
    if (
      providerTransferStatusConstraint.rows.length !== 1
      || !providerStatus
      || providerStatus.relation_name
        !== REQUIRED_RUNTIME_PROVIDER_TRANSFER_STATUS_CONSTRAINT.relation
      || providerStatus.constraint_name
        !== REQUIRED_RUNTIME_PROVIDER_TRANSFER_STATUS_CONSTRAINT.constraint
      || providerStatus.convalidated
        !== REQUIRED_RUNTIME_PROVIDER_TRANSFER_STATUS_CONSTRAINT.validated
      || normalizeCatalogDefinition(providerStatus.definition)
        !== REQUIRED_RUNTIME_PROVIDER_TRANSFER_STATUS_CONSTRAINT.definition
    ) {
      throw new Error('runtime_provider_transfer_status_constraint_drift');
    }

    const frozenTables = await query<{
      relation_name: string;
      relation_exists: boolean;
      guards_valid: boolean;
    }>(`
      WITH expected(relation_name) AS (
        VALUES
          ('public.ops_business_claim_links'),
          ('public.hxos_local_test_business_payout_destinations'),
          ('public.hxos_local_test_business_payout_transfers')
      )
      SELECT
        expected.relation_name,
        to_regclass(expected.relation_name) IS NOT NULL AS relation_exists,
        (
          EXISTS (
            SELECT 1 FROM pg_trigger dml_guard
            WHERE dml_guard.tgrelid = to_regclass(expected.relation_name)
              AND NOT dml_guard.tgisinternal
              AND dml_guard.tgname = 'pr276_incident_dml_guard'
              AND dml_guard.tgenabled = 'A'
              AND dml_guard.tgtype = 30
              AND dml_guard.tgqual IS NULL
              AND dml_guard.tgnargs = 0
              AND dml_guard.tgfoid = to_regprocedure('public.reject_pr276_incident_table_mutation()')
          )
          AND EXISTS (
            SELECT 1 FROM pg_trigger truncate_guard
            WHERE truncate_guard.tgrelid = to_regclass(expected.relation_name)
              AND NOT truncate_guard.tgisinternal
              AND truncate_guard.tgname = 'pr276_incident_truncate_guard'
              AND truncate_guard.tgenabled = 'A'
              AND truncate_guard.tgtype = 34
              AND truncate_guard.tgqual IS NULL
              AND truncate_guard.tgnargs = 0
              AND truncate_guard.tgfoid = to_regprocedure('public.reject_pr276_incident_table_mutation()')
          )
        ) AS guards_valid
      FROM expected
      ORDER BY expected.relation_name
    `);
    if (
      frozenTables.rows.length !== REQUIRED_RUNTIME_FROZEN_TABLES.length
      || frozenTables.rows.some(({ relation_exists, guards_valid }) => !relation_exists || !guards_valid)
    ) {
      throw new Error('runtime_frozen_table_guard_drift');
    }

    const controlTables = await query<{
      relation_name: string;
      relation_exists: boolean;
      owner_valid: boolean;
      runtime_mutation_privileges: boolean;
      guards_valid: boolean;
      ledger_ordinal_unique: boolean;
    }>(`
      WITH expected_control(relation_name) AS (
        VALUES
          ('public.applied_migrations'),
          ('public.schema_versions'),
          ('public.hx_database_identity')
      )
      SELECT
        expected_control.relation_name,
        control_relation.oid IS NOT NULL AS relation_exists,
        control_relation.relowner = to_regrole($1) AS owner_valid,
        (
          has_table_privilege(current_user, control_relation.oid, 'INSERT')
          OR has_table_privilege(current_user, control_relation.oid, 'UPDATE')
          OR has_table_privilege(current_user, control_relation.oid, 'DELETE')
          OR has_table_privilege(current_user, control_relation.oid, 'TRUNCATE')
          OR has_table_privilege(current_user, control_relation.oid, 'REFERENCES')
          OR has_table_privilege(current_user, control_relation.oid, 'TRIGGER')
          OR has_any_column_privilege(current_user, control_relation.oid, 'INSERT')
          OR has_any_column_privilege(current_user, control_relation.oid, 'UPDATE')
          OR has_any_column_privilege(current_user, control_relation.oid, 'REFERENCES')
        ) AS runtime_mutation_privileges,
        (
          EXISTS (
            SELECT 1 FROM pg_catalog.pg_trigger destructive_guard
            WHERE destructive_guard.tgrelid = control_relation.oid
              AND NOT destructive_guard.tgisinternal
              AND destructive_guard.tgname = 'migration_control_destructive_guard'
              AND destructive_guard.tgenabled = 'A'
              AND destructive_guard.tgtype = 26
              AND destructive_guard.tgqual IS NULL
              AND destructive_guard.tgnargs = 0
              AND destructive_guard.tgfoid =
                to_regprocedure('public.reject_control_table_destructive_mutation()')
          )
          AND EXISTS (
            SELECT 1 FROM pg_catalog.pg_trigger truncate_guard
            WHERE truncate_guard.tgrelid = control_relation.oid
              AND NOT truncate_guard.tgisinternal
              AND truncate_guard.tgname = 'migration_control_truncate_guard'
              AND truncate_guard.tgenabled = 'A'
              AND truncate_guard.tgtype = 34
              AND truncate_guard.tgqual IS NULL
              AND truncate_guard.tgnargs = 0
              AND truncate_guard.tgfoid =
                to_regprocedure('public.reject_control_table_destructive_mutation()')
          )
        ) AS guards_valid,
        CASE
          WHEN expected_control.relation_name = 'public.applied_migrations' THEN EXISTS (
            SELECT 1
            FROM pg_catalog.pg_index index_row
            JOIN pg_catalog.pg_attribute attribute_row
              ON attribute_row.attrelid = index_row.indrelid
             AND attribute_row.attnum = ANY(index_row.indkey::smallint[])
            WHERE index_row.indrelid = control_relation.oid
              AND index_row.indisunique
              AND index_row.indisvalid
              AND index_row.indisready
              AND index_row.indislive
              AND index_row.indimmediate
              AND index_row.indnatts = 1
              AND index_row.indnkeyatts = 1
              AND index_row.indexprs IS NULL
              AND index_row.indpred IS NULL
              AND index_row.indkey::smallint[] = ARRAY[attribute_row.attnum]::smallint[]
              AND attribute_row.attname = 'ordinal'
          )
          ELSE TRUE
        END AS ledger_ordinal_unique
      FROM expected_control
      LEFT JOIN pg_catalog.pg_class control_relation
        ON control_relation.oid = to_regclass(expected_control.relation_name)
       AND control_relation.relkind IN ('r', 'p')
      ORDER BY expected_control.relation_name
    `, [runtimeIdentity.migration_owner]);
    if (
      controlTables.rows.length !== REQUIRED_RUNTIME_CONTROL_TABLES.length
      || controlTables.rows.some((row) =>
        !row.relation_exists
        || !row.owner_valid
        || row.runtime_mutation_privileges
        || !row.guards_valid
        || !row.ledger_ordinal_unique
      )
    ) {
      throw new Error('runtime_migration_control_boundary_drift');
    }

    const expectedLedger = await engineMigrationManifest();
    const ledger = await query<{ name: string; ordinal: number; source_sha256: string }>(
      `SELECT name, ordinal, source_sha256
       FROM public.applied_migrations
       ORDER BY ordinal`
    );
    if (
      ledger.rows.length !== expectedLedger.length
      || ledger.rows.some((row, index) => {
        const expected = expectedLedger[index];
        return !expected
          || row.name !== expected.name
          || row.ordinal !== expected.ordinal
          || row.source_sha256 !== expected.sha256;
      })
    ) {
      throw new Error('runtime_migration_manifest_drift');
    }

    const version = await query<{ version: string }>(
      `SELECT version
       FROM public.schema_versions
       ORDER BY applied_at DESC
       LIMIT 1`
    );
    const schemaVersion = version.rows[0]?.version?.trim();
    if (!schemaVersion) throw new Error('runtime_schema_version_missing');

    const triggers = await query<{
      trigger_name: string;
      relation_name: string;
      function_name: string;
      enabled: string;
      trigger_type: number;
      qualification: string | null;
      argument_count: number;
      definition: string;
    }>(
      `SELECT
         invariant_trigger.tgname AS trigger_name,
         format('%I.%I', relation_namespace.nspname, trigger_relation.relname)
           AS relation_name,
         format(
           '%I.%I(%s)',
           function_namespace.nspname,
           trigger_function.proname,
           pg_get_function_identity_arguments(trigger_function.oid)
         ) AS function_name,
         invariant_trigger.tgenabled AS enabled,
         invariant_trigger.tgtype::integer AS trigger_type,
         pg_get_expr(invariant_trigger.tgqual, invariant_trigger.tgrelid)
           AS qualification,
         invariant_trigger.tgnargs::integer AS argument_count,
         pg_get_triggerdef(invariant_trigger.oid, false) AS definition
       FROM pg_trigger invariant_trigger
       JOIN pg_class trigger_relation
         ON trigger_relation.oid = invariant_trigger.tgrelid
       JOIN pg_namespace relation_namespace
         ON relation_namespace.oid = trigger_relation.relnamespace
       JOIN pg_proc trigger_function
         ON trigger_function.oid = invariant_trigger.tgfoid
       JOIN pg_namespace function_namespace
         ON function_namespace.oid = trigger_function.pronamespace
       WHERE NOT invariant_trigger.tgisinternal
         AND invariant_trigger.tgname = ANY($1::text[])
       ORDER BY invariant_trigger.tgname, relation_namespace.nspname, trigger_relation.relname`,
      [[...REQUIRED_RUNTIME_INVARIANT_TRIGGERS]]
    );
    const invariantByName = new Map(
      triggers.rows.map((trigger) => [trigger.trigger_name, trigger])
    );
    if (
      triggers.rows.length !== REQUIRED_RUNTIME_INVARIANT_TRIGGERS.length
      || invariantByName.size !== REQUIRED_RUNTIME_INVARIANT_TRIGGERS.length
      || Object.entries(REQUIRED_RUNTIME_INVARIANT_TRIGGER_MANIFEST).some(
        ([triggerName, expected]) => {
          const actual = invariantByName.get(triggerName);
          return !actual
            || actual.relation_name !== expected.relation
            || actual.function_name !== expected.function
            || actual.enabled !== expected.enabled
            || actual.trigger_type !== expected.triggerType
            || actual.qualification !== expected.qualification
            || actual.argument_count !== expected.argumentCount
            || normalizeTriggerDefinition(actual.definition)
              !== normalizeTriggerDefinition(expected.definition);
        }
      )
    ) {
      throw new Error('runtime_invariant_trigger_drift');
    }

    const verified = {
      migrationCount: ledger.rows.length,
      schemaVersion,
      invariantTriggerCount: invariantByName.size,
      acceptanceTriggerCount: acceptanceByName.size,
      pinnedFunctionCount: pinnedByName.size + pinnedHelperByIdentity.size,
      frozenTableCount: frozenTables.rows.filter(({ relation_exists }) => relation_exists).length,
      databaseIdentitySha256: runtimeDatabaseIdentityDigest({
        databaseName: runtimeIdentity.database_name,
        databaseOid: runtimeIdentity.database_oid,
        clusterSystemIdentifier: runtimeIdentity.cluster_system_identifier,
      }),
      migrationLedgerSha256: runtimeMigrationLedgerDigest(ledger.rows),
      migrationArtifactSha256: await engineMigrationArtifactDigest(),
    };
    startLog.info(verified, 'Runtime database schema manifest verified');
    return verified;
  } catch (error) {
    startLog.error(
      { code: databaseErrorCode(error) },
      'Runtime database schema verification failed closed'
    );
    throw new Error('Runtime database schema verification failed');
  }
}
