import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { buildIdentity, isTrustedBuildIdentity, type BuildIdentity } from '../buildIdentity.js';
import {
  isAuthenticatedReleaseManifest,
  PROMOTABLE_RELEASE_MANIFEST_VERSION,
  readReleaseManifest,
  type ReleaseEnvironment,
  type ReleaseManifestEvidence,
} from '../releaseManifest.js';
import {
  nonproductionRailwayTargetError,
  PINNED_NONPRODUCTION_RAILWAY_PROJECT_ID,
  PINNED_NONPRODUCTION_RAILWAY_STAGING_ENVIRONMENT_ID,
} from '../nonproductionRailwayTarget.js';
import { REQUIRED_MIGRATION_FILES } from './engine-automation-migration-files.js';
import { engineMigrationArtifactDigestFromPayload } from './engine-migration-manifest.js';
import {
  assertConfiguredNonproductionDatabaseTarget,
  assertConnectedNonproductionDatabaseTarget,
  type ExpectedNonproductionDatabaseTarget,
} from './nonproduction-database-target.js';

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const NONPRODUCTION_PROJECT = 'hustlexp-nonprod';
const CONSTITUTIONAL_BASELINE_MIGRATION = 'constitutional_schema_v1';
const LEGACY_LOCATION_BACKFILL_OPERATION = 'legacy_task_location_encryption_backfill_v1';

/**
 * Production target identity is intentionally not enrolled during the release
 * hold. Enrolling it requires a protected source change, not a Railway variable.
 */
export const PINNED_PRODUCTION_RAILWAY_PROJECT_ID: string | null = null;
export const PINNED_PRODUCTION_RAILWAY_ENVIRONMENT_ID: string | null = null;
export {
  PINNED_NONPRODUCTION_RAILWAY_PROJECT_ID,
  PINNED_NONPRODUCTION_RAILWAY_STAGING_ENVIRONMENT_ID,
};

type MigrationPermission = Readonly<{
  name: string;
  sha256: string;
  sourcePaths: readonly string[];
}>;

type MigrationAuthorityBinding = Readonly<{
  databaseTarget: string;
  expectedTarget: ExpectedNonproductionDatabaseTarget | null;
  localTestOnly: boolean;
  permissions: readonly MigrationPermission[];
  baseline: MigrationPermission | null;
}>;

type MigrationOperation = Readonly<
  | { kind: 'baseline'; permission: MigrationPermission }
  | { kind: 'migration'; permission: MigrationPermission }
  | { kind: 'legacy-location-backfill'; name: typeof LEGACY_LOCATION_BACKFILL_OPERATION }
>;

type MigrationSessionBinding = {
  client: object;
  expectedTarget: ExpectedNonproductionDatabaseTarget;
  operations: readonly MigrationOperation[];
  cursor: number;
  activePermit: MigrationOperationPermit | typeof PENDING_MIGRATION_OPERATION | null;
  backendPid: number | null;
  connectionMarker: string;
  completed: boolean;
};

const PENDING_MIGRATION_OPERATION = Symbol('pending-migration-operation');

type MigrationOperationPermitBinding = Readonly<{
  session: MigrationExecutionSession;
  client: object;
  index: number;
}>;

type MigrationExecutionReceiptBinding = Readonly<{
  session: MigrationExecutionSession;
  client: object;
}>;

type SupplementalMigrationConnectionBinding = {
  client: object;
  databaseUrl: string;
  expectedTarget: ExpectedNonproductionDatabaseTarget;
  backendPid: number;
  connectionMarker: string;
};

const issuedMigrationAuthorities = new WeakMap<object, MigrationAuthorityBinding>();
const issuedMigrationSessions = new WeakMap<object, MigrationSessionBinding>();
const issuedMigrationOperationPermits = new WeakMap<object, MigrationOperationPermitBinding>();
const issuedMigrationExecutionReceipts = new WeakMap<object, MigrationExecutionReceiptBinding>();
const issuedSupplementalMigrationConnections = new WeakMap<
  object,
  SupplementalMigrationConnectionBinding
>();
const pendingSupplementalMigrationAuthorities = new WeakSet<object>();

export interface MigrationExecutionAuthorityOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  release?: ReleaseManifestEvidence;
  /**
   * Compatibility input for callers that already carry the runtime identity.
   * Hosted authority accepts only the exact module-owned identity reference.
   */
  identity?: BuildIdentity;
  migrationArtifactDigest: string;
  databaseUrl?: string;
}

export interface MigrationExecutionAuthority {
  environment: ReleaseEnvironment;
  releaseManifestDigest: string | null;
  migrationArtifactDigest: string;
  localOnly: boolean;
  databaseTarget: string;
  membershipDigest: string;
}

export interface MigrationExecutionPlanEntry {
  name: string;
  sql: string;
  sourcePath: string;
}

export interface MigrationExecutionSession {
  environment: ReleaseEnvironment;
  releaseManifestDigest: string | null;
  migrationArtifactDigest: string;
  databaseTarget: string;
  localTestOnly: boolean;
  membershipDigest: string;
}

export interface MigrationOperationPermit {
  kind: MigrationOperation['kind'];
  operationIndex: number;
  membershipDigest: string;
}

export interface MigrationExecutionReceipt {
  environment: ReleaseEnvironment;
  releaseManifestDigest: string | null;
  migrationArtifactDigest: string;
  databaseTarget: string;
  membershipDigest: string;
  operationCount: number;
  receiptDigest: string;
}

export interface SupplementalMigrationConnection {
  membershipDigest: string;
}

function issueMigrationAuthority(
  authority: MigrationExecutionAuthority,
  binding: MigrationAuthorityBinding
): MigrationExecutionAuthority {
  const issued = Object.freeze(authority);
  issuedMigrationAuthorities.set(issued, binding);
  return issued;
}

export function assertIssuedMigrationExecutionAuthority(
  authority: MigrationExecutionAuthority
): void {
  if (!issuedMigrationAuthorities.has(authority)) refuse('OPAQUE_AUTHORITY_TOKEN_REQUIRED');
}

export function consumeIssuedMigrationExecutionAuthority(
  authority: MigrationExecutionAuthority
): void {
  if (!issuedMigrationAuthorities.delete(authority)) {
    refuse('OPAQUE_AUTHORITY_TOKEN_REQUIRED');
  }
}

function refuse(reason: string): never {
  throw new Error(`MIGRATION_EXECUTION_REFUSED:${reason}`);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function exactSourcePath(value: string): string {
  const normalized = path.resolve(value).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function immutablePermission(
  name: string,
  sql: string,
  sourcePaths: readonly string[]
): MigrationPermission {
  return Object.freeze({
    name,
    sha256: sha256(sql),
    sourcePaths: Object.freeze([...new Set(sourcePaths.map(exactSourcePath))]),
  });
}

function firstReadableSql(paths: readonly string[]): { sql: string; sourcePath: string } {
  for (const candidate of paths) {
    try {
      return { sql: readFileSync(candidate, 'utf8'), sourcePath: candidate };
    } catch {
      // Continue to the immutable image path.
    }
  }
  return refuse('CANONICAL_MIGRATION_ARTIFACT_UNAVAILABLE');
}

function canonicalArtifactBinding(root = process.cwd()): {
  artifactDigest: string;
  permissions: readonly MigrationPermission[];
  baseline: MigrationPermission;
  membershipDigest: string;
} {
  const migrationDirectory = path.join(root, 'backend/database/migrations');
  const permissions = REQUIRED_MIGRATION_FILES.map(({ name, fileName }) => {
    const sourcePaths = [
      path.join(migrationDirectory, fileName),
      path.join('/app/backend/database/migrations', fileName),
    ];
    const loaded = firstReadableSql(sourcePaths);
    return immutablePermission(name, loaded.sql, sourcePaths);
  });
  const registered = permissions.map((permission, index) => ({
    name: permission.name,
    fileName: REQUIRED_MIGRATION_FILES[index]!.fileName,
    sha256: permission.sha256,
  }));
  let directoryFiles: string[];
  try {
    directoryFiles = readdirSync(migrationDirectory)
      .filter((fileName) => fileName.endsWith('.sql'))
      .sort();
  } catch {
    return refuse('CANONICAL_MIGRATION_DIRECTORY_UNAVAILABLE');
  }
  const directory = directoryFiles.map((fileName) => ({
    fileName,
    sha256: sha256(readFileSync(path.join(migrationDirectory, fileName))),
  }));
  const baselinePaths = [
    path.join(root, 'backend/database/constitutional-schema.sql'),
    path.join('/app/backend/database/constitutional-schema.sql'),
  ];
  const baselineSql = firstReadableSql(baselinePaths).sql;
  const baseline = immutablePermission(
    CONSTITUTIONAL_BASELINE_MIGRATION,
    baselineSql,
    baselinePaths
  );
  const artifactDigest = `sha256:${engineMigrationArtifactDigestFromPayload({
    constitutionalBaseline: {
      fileName: 'constitutional-schema.sql',
      sha256: baseline.sha256,
    },
    registered,
    directory,
  })}`;
  const membershipDigest = `sha256:${sha256(
    JSON.stringify({
      artifactDigest,
      permissions,
      baseline,
      legacyLocationBackfill: LEGACY_LOCATION_BACKFILL_OPERATION,
    })
  )}`;
  return {
    artifactDigest,
    permissions: Object.freeze(permissions),
    baseline,
    membershipDigest,
  };
}

function databaseTargetDigest(databaseUrl: string | undefined): string {
  const exact = databaseUrl?.trim();
  if (!exact) return refuse('EXACT_DATABASE_TARGET_REQUIRED');
  return `sha256:${sha256(`hustlexp-migration-database-target-v1\n${exact}\n`)}`;
}

const LOCAL_ENGINE_CI_DATABASES = new Set([
  'hx_ci_invariant_test',
  'hx_ci_system_test',
  'hx_ci_fresh_test',
  'hx_ci_upgrade_test',
]);
const STAGE1_CONTAINMENT_DATABASE = /^hx_ci_stage1_containment_[a-f0-9]{20}$/u;

function assertEngineLocalDatabaseTarget(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  databaseUrl: string
): ExpectedNonproductionDatabaseTarget {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return refuse('LOCAL_ENGINE_DATABASE_URL_INVALID');
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  let databaseName: string;
  let roleName: string;
  try {
    databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
    roleName = decodeURIComponent(parsed.username);
  } catch {
    return refuse('LOCAL_ENGINE_DATABASE_URL_ENCODING_INVALID');
  }
  const port = parsed.port ? Number(parsed.port) : 5432;
  const loopback = hostname === '127.0.0.1' || hostname === '::1';
  const exactCi =
    LOCAL_ENGINE_CI_DATABASES.has(databaseName) &&
    roleName === 'hx_ci_runner' &&
    loopback &&
    port === 5432;
  const stage1Gate =
    (env.HX_ALLOW_TASK_DRAFT_INGRESS_PG ?? process.env.HX_ALLOW_TASK_DRAFT_INGRESS_PG) === '1';
  const exactStage1 =
    STAGE1_CONTAINMENT_DATABASE.test(databaseName) &&
    roleName === 'hx_ci_runner' &&
    loopback &&
    port === 5432 &&
    stage1Gate &&
    isIsolatedVitestRuntime();
  const exactPlatform =
    databaseName === 'hustlexp_startup_test' &&
    roleName === 'hustlexp_local_runner' &&
    (loopback || hostname === 'postgres') &&
    port === 5432;
  if (!exactCi && !exactStage1 && !exactPlatform) {
    return refuse('LOCAL_ENGINE_DATABASE_TARGET_NOT_ALLOWLISTED');
  }
  return assertConfiguredNonproductionDatabaseTarget(
    {
      ...env,
      HX_ENVIRONMENT: 'local',
      HXOS_LOCAL_TEST_DATABASE_NAME: databaseName,
      HXOS_LOCAL_TEST_DATABASE_ROLE: roleName,
    },
    databaseUrl
  );
}

function isIsolatedVitestRuntime(): boolean {
  const runnerEvidence = [...process.argv, ...process.execArgv].some((argument) =>
    /(?:^|[/\\])(?:@?vitest|vite-node)(?:[/\\]|\.|$)/u.test(argument)
  );
  const stack = new Error().stack ?? '';
  const stackEvidence =
    stack.includes('/node_modules/@vitest/') || stack.includes('\\node_modules\\@vitest\\');
  return (
    process.env.VITEST === 'true' &&
    typeof process.env.VITEST_WORKER_ID === 'string' &&
    (runnerEvidence || stackEvidence)
  );
}

function permissionMatches(
  permission: MigrationPermission,
  entry: MigrationExecutionPlanEntry
): boolean {
  return (
    permission.name === entry.name &&
    permission.sha256 === sha256(entry.sql) &&
    permission.sourcePaths.includes(exactSourcePath(entry.sourcePath))
  );
}

export function authorizeMigrationExecutionPlan(
  authority: MigrationExecutionAuthority,
  input: {
    databaseUrl: string;
    client: object;
    migrations: readonly MigrationExecutionPlanEntry[];
    baseline?: MigrationExecutionPlanEntry;
  }
): MigrationExecutionSession {
  const authorityBinding = issuedMigrationAuthorities.get(authority);
  if (!authorityBinding) refuse('OPAQUE_AUTHORITY_TOKEN_REQUIRED');
  const databaseTarget = databaseTargetDigest(input.databaseUrl);
  if (databaseTarget !== authorityBinding.databaseTarget) refuse('DATABASE_TARGET_MISMATCH');
  if (!authorityBinding.expectedTarget) refuse('LIVE_DATABASE_TARGET_NOT_ENROLLED');
  if (input.databaseUrl !== authorityBinding.expectedTarget.databaseUrl) {
    refuse('EXACT_DATABASE_URL_MISMATCH');
  }

  const seen = new Set<string>();
  for (const entry of input.migrations) {
    if (seen.has(entry.name)) refuse('MIGRATION_PLAN_DUPLICATE_NAME');
    seen.add(entry.name);
  }

  let permissions: readonly MigrationPermission[];
  let baseline: MigrationPermission | null;
  if (authorityBinding.localTestOnly) {
    permissions = Object.freeze(
      input.migrations.map((entry) =>
        immutablePermission(entry.name, entry.sql, [entry.sourcePath])
      )
    );
    baseline = input.baseline
      ? immutablePermission(input.baseline.name, input.baseline.sql, [input.baseline.sourcePath])
      : null;
  } else {
    if (
      input.migrations.length !== authorityBinding.permissions.length ||
      input.migrations.some(
        (entry, index) => !permissionMatches(authorityBinding.permissions[index]!, entry)
      )
    ) {
      refuse('EXACT_CANONICAL_MIGRATION_PLAN_REQUIRED');
    }
    if (
      !input.baseline ||
      !authorityBinding.baseline ||
      !permissionMatches(authorityBinding.baseline, input.baseline)
    ) {
      refuse('EXACT_CONSTITUTIONAL_BASELINE_REQUIRED');
    }
    permissions = authorityBinding.permissions;
    baseline = authorityBinding.baseline;
  }

  const membershipDigest = `sha256:${sha256(
    JSON.stringify({
      databaseTarget,
      permissions,
      baseline,
      legacyLocationBackfill: LEGACY_LOCATION_BACKFILL_OPERATION,
    })
  )}`;
  const operations = Object.freeze<MigrationOperation[]>([
    ...(baseline ? [{ kind: 'baseline' as const, permission: baseline }] : []),
    ...permissions.map((permission) => ({ kind: 'migration' as const, permission })),
    { kind: 'legacy-location-backfill' as const, name: LEGACY_LOCATION_BACKFILL_OPERATION },
  ]);
  const session = Object.freeze<MigrationExecutionSession>({
    environment: authority.environment,
    releaseManifestDigest: authority.releaseManifestDigest,
    migrationArtifactDigest: authority.migrationArtifactDigest,
    databaseTarget,
    localTestOnly: authorityBinding.localTestOnly,
    membershipDigest,
  });
  consumeIssuedMigrationExecutionAuthority(authority);
  issuedMigrationSessions.set(session, {
    client: input.client,
    expectedTarget: authorityBinding.expectedTarget,
    operations,
    cursor: 0,
    activePermit: null,
    backendPid: null,
    connectionMarker: `hustlexp-migration-session-${randomUUID()}`,
    completed: false,
  });
  return session;
}

export function assertMigrationExecutionSession(session: MigrationExecutionSession): void {
  const binding = issuedMigrationSessions.get(session);
  if (!binding || binding.completed) refuse('OPAQUE_EXECUTION_SESSION_REQUIRED');
}

interface ConnectionMarkerRow extends Record<string, unknown> {
  backend_pid: number | string;
  session_marker: string | null;
}

async function assertSameLiveConnection(binding: MigrationSessionBinding): Promise<void> {
  await assertConnectedNonproductionDatabaseTarget(
    binding.client as Parameters<typeof assertConnectedNonproductionDatabaseTarget>[0],
    binding.expectedTarget
  );
  const client = binding.client as Parameters<typeof assertConnectedNonproductionDatabaseTarget>[0];
  const result =
    binding.backendPid === null
      ? await client.query<ConnectionMarkerRow>(
          `SELECT pg_backend_pid()::integer AS backend_pid,
              set_config('hustlexp.migration_session', $1, false) AS session_marker`,
          [binding.connectionMarker]
        )
      : await client.query<ConnectionMarkerRow>(
          `SELECT pg_backend_pid()::integer AS backend_pid,
              current_setting('hustlexp.migration_session', true) AS session_marker`
        );
  if (result.rows.length !== 1) refuse('LIVE_CONNECTION_IDENTITY_ROW_COUNT_INVALID');
  const row = result.rows[0];
  const backendPid = Number(row?.backend_pid);
  if (!Number.isInteger(backendPid) || backendPid <= 0) refuse('LIVE_CONNECTION_PID_INVALID');
  if (row?.session_marker !== binding.connectionMarker) refuse('LIVE_CONNECTION_MARKER_MISMATCH');
  if (binding.backendPid !== null && backendPid !== binding.backendPid) {
    refuse('CONNECTED_MIGRATION_SESSION_CHANGED');
  }
  binding.backendPid = backendPid;
}

async function beginMigrationOperation(
  session: MigrationExecutionSession,
  kind: MigrationOperation['kind'],
  entry: MigrationExecutionPlanEntry | null,
  client: object
): Promise<MigrationOperationPermit> {
  const binding = issuedMigrationSessions.get(session);
  if (!binding || binding.completed) refuse('OPAQUE_EXECUTION_SESSION_REQUIRED');
  if (binding.client !== client) refuse('CONNECTED_MIGRATION_CLIENT_MISMATCH');
  if (binding.activePermit) refuse('MIGRATION_OPERATION_ALREADY_ACTIVE');
  const expected = binding.operations[binding.cursor];
  if (!expected) refuse('MIGRATION_EXECUTION_PLAN_ALREADY_COMPLETE');
  if (expected.kind !== kind) refuse('MIGRATION_OPERATION_OUT_OF_ORDER');
  if (expected.kind === 'baseline') {
    if (!entry || !permissionMatches(expected.permission, entry)) {
      refuse('CONSTITUTIONAL_BASELINE_NOT_AUTHORIZED');
    }
  } else if (expected.kind === 'migration') {
    if (!entry || !permissionMatches(expected.permission, entry)) {
      refuse('MIGRATION_NOT_IN_EXACT_AUTHORIZED_ARTIFACT');
    }
  } else if (entry) {
    refuse('LEGACY_LOCATION_BACKFILL_NOT_AUTHORIZED');
  }
  // Reserve the operation synchronously before the first await. Otherwise two
  // concurrent callers can both pass the null check, complete live readback,
  // and receive permits for the same cursor.
  binding.activePermit = PENDING_MIGRATION_OPERATION;
  try {
    await assertSameLiveConnection(binding);
    const permit = Object.freeze<MigrationOperationPermit>({
      kind,
      operationIndex: binding.cursor,
      membershipDigest: session.membershipDigest,
    });
    binding.activePermit = permit;
    issuedMigrationOperationPermits.set(
      permit,
      Object.freeze({
        session,
        client,
        index: binding.cursor,
      })
    );
    return permit;
  } catch (error) {
    if (binding.activePermit === PENDING_MIGRATION_OPERATION) {
      binding.activePermit = null;
    }
    throw error;
  }
}

export function beginMigrationArtifactOperation(
  session: MigrationExecutionSession,
  entry: MigrationExecutionPlanEntry,
  client: object
): Promise<MigrationOperationPermit> {
  return beginMigrationOperation(session, 'migration', entry, client);
}

export function beginConstitutionalBaselineOperation(
  session: MigrationExecutionSession,
  entry: MigrationExecutionPlanEntry,
  client: object
): Promise<MigrationOperationPermit> {
  return beginMigrationOperation(session, 'baseline', entry, client);
}

export function beginLegacyLocationBackfillOperation(
  session: MigrationExecutionSession,
  client: object
): Promise<MigrationOperationPermit> {
  return beginMigrationOperation(session, 'legacy-location-backfill', null, client);
}

function exactActivePermit(
  session: MigrationExecutionSession,
  permit: MigrationOperationPermit,
  client: object
): MigrationSessionBinding {
  const binding = issuedMigrationSessions.get(session);
  const permitBinding = issuedMigrationOperationPermits.get(permit);
  if (!binding || binding.completed || !permitBinding) refuse('OPAQUE_OPERATION_PERMIT_REQUIRED');
  if (binding.client !== client) refuse('CONNECTED_MIGRATION_CLIENT_MISMATCH');
  if (
    permitBinding.session !== session ||
    permitBinding.client !== client ||
    permitBinding.index !== binding.cursor ||
    binding.activePermit !== permit
  ) {
    refuse('MIGRATION_OPERATION_PERMIT_MISMATCH');
  }
  return binding;
}

export function completeMigrationOperation(
  session: MigrationExecutionSession,
  permit: MigrationOperationPermit,
  client: object
): void {
  const binding = exactActivePermit(session, permit, client);
  issuedMigrationOperationPermits.delete(permit);
  binding.activePermit = null;
  binding.cursor += 1;
}

export function abortMigrationOperation(
  session: MigrationExecutionSession,
  permit: MigrationOperationPermit,
  client: object
): void {
  const binding = exactActivePermit(session, permit, client);
  issuedMigrationOperationPermits.delete(permit);
  binding.activePermit = null;
}

export function completeMigrationExecutionSession(
  session: MigrationExecutionSession,
  client: object
): MigrationExecutionReceipt {
  const binding = issuedMigrationSessions.get(session);
  if (!binding || binding.completed) refuse('OPAQUE_EXECUTION_SESSION_REQUIRED');
  if (binding.client !== client) refuse('CONNECTED_MIGRATION_CLIENT_MISMATCH');
  if (binding.activePermit) refuse('MIGRATION_OPERATION_ALREADY_ACTIVE');
  if (binding.cursor !== binding.operations.length) refuse('MIGRATION_EXECUTION_PLAN_INCOMPLETE');
  binding.completed = true;
  issuedMigrationSessions.delete(session);
  const operationCount = binding.operations.length;
  const receiptDigest = `sha256:${sha256(
    JSON.stringify({
      environment: session.environment,
      releaseManifestDigest: session.releaseManifestDigest,
      migrationArtifactDigest: session.migrationArtifactDigest,
      databaseTarget: session.databaseTarget,
      membershipDigest: session.membershipDigest,
      operationCount,
      backendPid: binding.backendPid,
      connectionMarker: binding.connectionMarker,
    })
  )}`;
  const receipt = Object.freeze<MigrationExecutionReceipt>({
    environment: session.environment,
    releaseManifestDigest: session.releaseManifestDigest,
    migrationArtifactDigest: session.migrationArtifactDigest,
    databaseTarget: session.databaseTarget,
    membershipDigest: session.membershipDigest,
    operationCount,
    receiptDigest,
  });
  issuedMigrationExecutionReceipts.set(receipt, Object.freeze({ session, client }));
  return receipt;
}

export function assertMigrationExecutionReceipt(receipt: MigrationExecutionReceipt): void {
  if (!issuedMigrationExecutionReceipts.has(receipt)) {
    refuse('OPAQUE_EXECUTION_RECEIPT_REQUIRED');
  }
}

async function assertSameSupplementalMigrationConnection(
  binding: SupplementalMigrationConnectionBinding
): Promise<void> {
  const client = binding.client as Parameters<typeof assertConnectedNonproductionDatabaseTarget>[0];
  await assertConnectedNonproductionDatabaseTarget(client, binding.expectedTarget);
  const result = await client.query<ConnectionMarkerRow>(
    `SELECT pg_backend_pid()::integer AS backend_pid,
            current_setting('hustlexp.supplemental_migration_session', true)
              AS session_marker`
  );
  if (result.rows.length !== 1) refuse('LIVE_CONNECTION_IDENTITY_ROW_COUNT_INVALID');
  const row = result.rows[0];
  const backendPid = Number(row?.backend_pid);
  if (!Number.isInteger(backendPid) || backendPid <= 0) {
    refuse('LIVE_CONNECTION_PID_INVALID');
  }
  if (backendPid !== binding.backendPid) refuse('CONNECTED_MIGRATION_SESSION_CHANGED');
  if (row?.session_marker !== binding.connectionMarker) {
    refuse('LIVE_CONNECTION_MARKER_MISMATCH');
  }
}

/**
 * Consume a migration authority into a connection-only supplemental session.
 * The hidden configured target remains owned by this module; this grants no
 * SQL permission and is usable only with a separate exact artifact binding.
 */
export async function authorizeSupplementalMigrationConnection(
  authority: MigrationExecutionAuthority,
  input: {
    scope: 'fake-financial-v1';
    databaseUrl: string;
    client: object;
  }
): Promise<SupplementalMigrationConnection> {
  if (pendingSupplementalMigrationAuthorities.has(authority)) {
    refuse('AUTHORITY_SESSION_AUTHORIZATION_ALREADY_ACTIVE');
  }
  const authorityBinding = issuedMigrationAuthorities.get(authority);
  if (!authorityBinding) refuse('OPAQUE_AUTHORITY_TOKEN_REQUIRED');
  const databaseTarget = databaseTargetDigest(input.databaseUrl);
  if (databaseTarget !== authorityBinding.databaseTarget) refuse('DATABASE_TARGET_MISMATCH');
  if (!authorityBinding.expectedTarget) refuse('LIVE_DATABASE_TARGET_NOT_ENROLLED');
  if (input.databaseUrl !== authorityBinding.expectedTarget.databaseUrl) {
    refuse('EXACT_DATABASE_URL_MISMATCH');
  }
  if (!input.client || typeof input.client !== 'object') refuse('CONNECTED_CLIENT_REQUIRED');

  pendingSupplementalMigrationAuthorities.add(authority);
  try {
    const expectedTarget = Object.freeze({ ...authorityBinding.expectedTarget });
    const connectionMarker = `hustlexp-supplemental-migration-${randomUUID()}`;
    const client = input.client as Parameters<typeof assertConnectedNonproductionDatabaseTarget>[0];
    await assertConnectedNonproductionDatabaseTarget(client, expectedTarget);
    const pinned = await client.query<ConnectionMarkerRow>(
      `SELECT pg_backend_pid()::integer AS backend_pid,
              set_config('hustlexp.supplemental_migration_session', $1, false)
                AS session_marker`,
      [connectionMarker]
    );
    if (pinned.rows.length !== 1) refuse('LIVE_CONNECTION_IDENTITY_ROW_COUNT_INVALID');
    const backendPid = Number(pinned.rows[0]?.backend_pid);
    if (!Number.isInteger(backendPid) || backendPid <= 0) {
      refuse('LIVE_CONNECTION_PID_INVALID');
    }
    if (pinned.rows[0]?.session_marker !== connectionMarker) {
      refuse('LIVE_CONNECTION_MARKER_MISMATCH');
    }
    const membershipDigest = `sha256:${sha256(
      JSON.stringify({
        scope: input.scope,
        databaseTarget,
        authorityMembership: authority.membershipDigest,
        backendPid,
        connectionMarker,
      })
    )}`;
    const connection = Object.freeze<SupplementalMigrationConnection>({ membershipDigest });
    consumeIssuedMigrationExecutionAuthority(authority);
    issuedSupplementalMigrationConnections.set(connection, {
      client: input.client,
      databaseUrl: input.databaseUrl,
      expectedTarget,
      backendPid,
      connectionMarker,
    });
    return connection;
  } finally {
    pendingSupplementalMigrationAuthorities.delete(authority);
  }
}

export async function assertSupplementalMigrationConnection(
  connection: SupplementalMigrationConnection,
  client: object,
  databaseUrl: string
): Promise<void> {
  const binding = issuedSupplementalMigrationConnections.get(connection);
  if (!binding) refuse('OPAQUE_SUPPLEMENTAL_CONNECTION_REQUIRED');
  if (binding.client !== client) refuse('CONNECTED_MIGRATION_CLIENT_MISMATCH');
  if (binding.databaseUrl !== databaseUrl) refuse('EXACT_DATABASE_URL_MISMATCH');
  await assertSameSupplementalMigrationConnection(binding);
}

export function completeSupplementalMigrationConnection(
  connection: SupplementalMigrationConnection,
  client: object,
  databaseUrl: string
): void {
  const binding = issuedSupplementalMigrationConnections.get(connection);
  if (!binding) refuse('OPAQUE_SUPPLEMENTAL_CONNECTION_REQUIRED');
  if (binding.client !== client) refuse('CONNECTED_MIGRATION_CLIENT_MISMATCH');
  if (binding.databaseUrl !== databaseUrl) refuse('EXACT_DATABASE_URL_MISMATCH');
  issuedSupplementalMigrationConnections.delete(connection);
}

function environmentOf(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): ReleaseEnvironment {
  const raw = (env.HX_ENVIRONMENT || env.NODE_ENV || 'local').trim().toLowerCase();
  if (raw === 'test' || raw === 'development' || raw === 'local') return 'local';
  if (raw === 'preview' || raw === 'staging' || raw === 'production') return raw;
  return refuse('ENVIRONMENT_INVALID');
}

function hasRailwayEvidence(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  return Object.entries(env).some(
    ([name, value]) => name.startsWith('RAILWAY_') && Boolean(value?.trim())
  );
}

function localMigrationAuthorityEnvironment(
  options: MigrationExecutionAuthorityOptions
): NodeJS.ProcessEnv | Record<string, string | undefined> {
  const ambientEnvironment = environmentOf(process.env);
  const ambientNodeEnvironment = process.env.NODE_ENV?.trim().toLowerCase();
  if (
    ambientEnvironment !== 'local' ||
    ambientNodeEnvironment === 'production' ||
    hasRailwayEvidence(process.env)
  ) {
    return process.env;
  }

  const candidate = options.env ?? process.env;
  if (environmentOf(candidate) !== 'local') {
    refuse('CALLER_SHAPED_DEPLOYED_ENVIRONMENT_REFUSED');
  }
  if (candidate.NODE_ENV?.trim().toLowerCase() === 'production') {
    refuse('PRODUCTION_RUNTIME_CANNOT_CLAIM_LOCAL');
  }
  if (hasRailwayEvidence(candidate)) refuse('LOCAL_EXECUTION_CANNOT_TARGET_RAILWAY');
  return candidate;
}

function assertRailwayTarget(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  environment: Exclude<ReleaseEnvironment, 'local'>
): void {
  const projectId = env.RAILWAY_PROJECT_ID?.trim();
  const projectName = env.RAILWAY_PROJECT_NAME?.trim();
  const environmentId = env.RAILWAY_ENVIRONMENT_ID?.trim();
  const environmentName = (env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT || '')
    .trim()
    .toLowerCase();
  if (!projectId || !environmentId || !environmentName) refuse('EXACT_RAILWAY_TARGET_REQUIRED');

  if (environment === 'production') {
    if (!PINNED_PRODUCTION_RAILWAY_PROJECT_ID) refuse('PRODUCTION_TARGET_NOT_ENROLLED');
    if (!PINNED_PRODUCTION_RAILWAY_ENVIRONMENT_ID) refuse('PRODUCTION_TARGET_NOT_ENROLLED');
    if (projectId !== PINNED_PRODUCTION_RAILWAY_PROJECT_ID) refuse('PRODUCTION_PROJECT_MISMATCH');
    if (environmentId !== PINNED_PRODUCTION_RAILWAY_ENVIRONMENT_ID) {
      refuse('PRODUCTION_ENVIRONMENT_ID_MISMATCH');
    }
    if (environmentName !== 'production') refuse('PRODUCTION_ENVIRONMENT_MISMATCH');
    return;
  }

  if (projectName !== NONPRODUCTION_PROJECT) refuse('NONPRODUCTION_PROJECT_MISMATCH');
  const identityError = nonproductionRailwayTargetError({
    environment,
    projectId,
    environmentId,
    environmentName,
  });
  if (identityError) refuse(identityError);
}

/**
 * Fail-closed preflight for the only deployed schema-writing role.
 *
 * This function performs no database operation. All nonlocal authority is
 * bound to a signed manifest, a runtime-measured artifact, an exact migration
 * digest, and an environment approval that names that signed manifest digest.
 */
export function assertMigrationExecutionAuthorized(
  options: MigrationExecutionAuthorityOptions
): MigrationExecutionAuthority {
  const env = localMigrationAuthorityEnvironment(options);
  const environment = environmentOf(env);
  const migrationArtifactDigest = options.migrationArtifactDigest.startsWith('sha256:')
    ? options.migrationArtifactDigest
    : `sha256:${options.migrationArtifactDigest}`;
  if (!DIGEST.test(migrationArtifactDigest)) refuse('MIGRATION_ARTIFACT_DIGEST_INVALID');

  const role = env.SERVICE_ROLE?.trim().toLowerCase();
  if (role && role !== 'migration') refuse('SERVICE_ROLE_MUST_BE_MIGRATION');
  if (environment === 'local') {
    if (
      env.NODE_ENV?.trim().toLowerCase() === 'production' ||
      process.env.NODE_ENV?.trim().toLowerCase() === 'production'
    ) {
      refuse('PRODUCTION_RUNTIME_CANNOT_CLAIM_LOCAL');
    }
    const railwayPresent = [env, process.env].some(hasRailwayEvidence);
    if (railwayPresent) refuse('LOCAL_EXECUTION_CANNOT_TARGET_RAILWAY');
    const databaseUrl = options.databaseUrl ?? env.DATABASE_URL;
    const expectedTarget = assertEngineLocalDatabaseTarget(env, databaseUrl ?? '');
    const databaseTarget = databaseTargetDigest(databaseUrl);
    const isolatedLocalTest =
      isIsolatedVitestRuntime() &&
      (env.NODE_ENV ?? process.env.NODE_ENV)?.trim().toLowerCase() === 'test';
    if (isolatedLocalTest) {
      const membershipDigest = `sha256:${sha256('hustlexp-local-test-migration-membership-v1')}`;
      return issueMigrationAuthority(
        {
          environment,
          releaseManifestDigest: null,
          migrationArtifactDigest,
          localOnly: true,
          databaseTarget,
          membershipDigest,
        },
        Object.freeze({
          databaseTarget,
          expectedTarget,
          localTestOnly: true,
          permissions: Object.freeze([]),
          baseline: null,
        })
      );
    }
    const canonical = canonicalArtifactBinding();
    if (canonical.artifactDigest !== migrationArtifactDigest) {
      refuse('MIGRATION_ARTIFACT_CONTENT_MISMATCH');
    }
    return issueMigrationAuthority(
      {
        environment,
        releaseManifestDigest: null,
        migrationArtifactDigest,
        localOnly: true,
        databaseTarget,
        membershipDigest: canonical.membershipDigest,
      },
      Object.freeze({
        databaseTarget,
        expectedTarget,
        localTestOnly: false,
        permissions: canonical.permissions,
        baseline: canonical.baseline,
      })
    );
  }

  if (env.NODE_ENV !== 'production') refuse('DEPLOYED_RUNTIME_MUST_USE_NODE_ENV_PRODUCTION');
  if (role !== 'migration') refuse('SERVICE_ROLE_MUST_BE_MIGRATION');
  const release = readReleaseManifest();
  if (!isAuthenticatedReleaseManifest(release, env) || !release.manifest) {
    refuse('AUTHENTICATED_RELEASE_MANIFEST_REQUIRED');
  }
  if (release.manifest.version !== PROMOTABLE_RELEASE_MANIFEST_VERSION) {
    refuse('PROMOTABLE_RELEASE_MANIFEST_V2_REQUIRED');
  }
  if (options.identity && options.identity !== buildIdentity) {
    refuse('MODULE_MEASURED_BUILD_IDENTITY_REQUIRED');
  }
  const identity = buildIdentity;
  if (!isTrustedBuildIdentity(identity)) refuse('MEASURED_IMMUTABLE_BUILD_REQUIRED');
  const manifest = release.manifest;
  if (manifest.environment !== environment) refuse('MANIFEST_ENVIRONMENT_MISMATCH');
  if (manifest.components.migration.revision !== identity.revision) {
    refuse('MIGRATION_REVISION_MISMATCH');
  }
  if (manifest.components.backend.revision !== identity.revision) {
    refuse('EXECUTABLE_REVISION_MISMATCH');
  }
  if (manifest.components.backend.artifactDigest !== identity.artifact_digest) {
    refuse('EXECUTABLE_ARTIFACT_MISMATCH');
  }
  if (manifest.components.migration.artifactDigest !== migrationArtifactDigest) {
    refuse('MIGRATION_ARTIFACT_MISMATCH');
  }
  if (env.HX_MIGRATION_ENVIRONMENT_APPROVAL_DIGEST !== release.digest) {
    refuse('EXACT_ENVIRONMENT_APPROVAL_REQUIRED');
  }
  assertRailwayTarget(env, environment);
  const canonical = canonicalArtifactBinding();
  if (canonical.artifactDigest !== migrationArtifactDigest) {
    refuse('MIGRATION_ARTIFACT_CONTENT_MISMATCH');
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (options.databaseUrl && options.databaseUrl !== databaseUrl) {
    refuse('CALLER_DATABASE_TARGET_MISMATCH');
  }
  const databaseTarget = databaseTargetDigest(databaseUrl);
  const expectedTarget = assertConfiguredNonproductionDatabaseTarget(
    { ...env, HX_ENVIRONMENT: environment },
    databaseUrl ?? ''
  );
  return issueMigrationAuthority(
    {
      environment,
      releaseManifestDigest: release.digest,
      migrationArtifactDigest,
      localOnly: false,
      databaseTarget,
      membershipDigest: canonical.membershipDigest,
    },
    Object.freeze({
      databaseTarget,
      expectedTarget,
      localTestOnly: false,
      permissions: canonical.permissions,
      baseline: canonical.baseline,
    })
  );
}
