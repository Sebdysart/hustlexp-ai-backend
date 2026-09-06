import { createHash } from 'node:crypto';

import type { QueryFn } from '../database-contracts.js';
import {
  FAKE_FINANCIAL_OUTBOX_V13_SQL_SHA256,
  verifyWorkOrderCommandAuthorityInCurrentSnapshot,
  WORK_ORDER_BOOTSTRAP_SEAL_SQL_SHA256,
  WORK_ORDER_FAKE_FINANCIAL_V12_SQL_SHA256,
  WORK_ORDER_ORDINAL146_SQL_SHA256,
  type WorkOrderCommandAuthorityVerifierRole,
} from './work-order-command-role-authority.js';

const POSTGRES_PROTOCOLS = new Set(['postgres:', 'postgresql:']);
const ROLE_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const KEY_IDENTIFIER = /^[a-z0-9][a-z0-9._-]{2,127}$/u;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const ZERO_SHA256_DIGEST = /^sha256:0{64}$/u;
const REVISION = /^[0-9a-f]{40}$/u;
const ZERO_REVISION = /^0{40}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RUNTIME_ENVIRONMENTS = new Set(['local', 'preview', 'staging', 'production']);

export const RUNTIME_DATABASE_AUTHORITY_COMPONENTS = ['api', 'worker', 'attester'] as const;
export type RuntimeDatabaseAuthorityComponent =
  (typeof RUNTIME_DATABASE_AUTHORITY_COMPONENTS)[number];
export type RuntimeDatabaseAuthorityEnvironment = 'local' | 'preview' | 'staging' | 'production';
export type RuntimeDatabaseTlsMode = 'disable' | 'verify-full';
export type RuntimeDatabaseChannelBinding = 'require' | 'disabled';
export type RuntimeDatabaseTransactionStatus =
  | 'IDLE'
  | 'IN_TRANSACTION'
  | 'FAILED_TRANSACTION'
  | 'UNKNOWN';

export type RuntimeDatabaseAuthorityFailureCode =
  | 'REPLICA_DATABASE_CONFIGURED'
  | 'ROLE_TOPOLOGY_INVALID'
  | 'EXPECTED_TARGET_INVALID'
  | 'PRIMARY_DATABASE_URL_REQUIRED'
  | 'PRIMARY_DATABASE_URL_INVALID'
  | 'PRIMARY_DATABASE_URL_PROTOCOL_INVALID'
  | 'PRIMARY_DATABASE_URL_OPTION_UNSUPPORTED'
  | 'PRIMARY_DATABASE_URL_TLS_INVALID'
  | 'PRIMARY_DATABASE_LOCAL_SOCKET_UNSUPPORTED'
  | 'PRIMARY_DATABASE_USER_INVALID'
  | 'PRIMARY_DATABASE_HOST_INVALID'
  | 'PRIMARY_DATABASE_NAME_INVALID'
  | 'CONFIGURED_DATABASE_USER_MISMATCH'
  | 'CONFIGURED_DATABASE_HOST_MISMATCH'
  | 'CONFIGURED_DATABASE_PORT_MISMATCH'
  | 'CONFIGURED_DATABASE_NAME_MISMATCH'
  | 'CONFIGURED_DATABASE_TLS_MISMATCH'
  | 'TARGET_DIGEST_INVALID'
  | 'TARGET_DIGEST_MISMATCH'
  | 'RELEASE_PIN_INVALID'
  | 'RELEASE_AUTHORITY_VERIFICATION_FAILED'
  | 'RELEASE_PROOF_INVALID'
  | 'RELEASE_MANIFEST_DIGEST_MISMATCH'
  | 'RELEASE_SIGNER_MISMATCH'
  | 'RELEASE_ENVIRONMENT_MISMATCH'
  | 'RELEASE_COMPONENT_MISMATCH'
  | 'RELEASE_REVISION_MISMATCH'
  | 'RELEASE_ARTIFACT_DIGEST_MISMATCH'
  | 'RELEASE_DATABASE_TARGET_MISMATCH'
  | 'BUILD_PROOF_MISMATCH'
  | 'DATABASE_SESSION_UNAVAILABLE'
  | 'DATABASE_SESSION_BINDING_MISMATCH'
  | 'DATABASE_SESSION_NOT_FRESH'
  | 'DATABASE_SESSION_STATUS_UNAVAILABLE'
  | 'SNAPSHOT_BEGIN_AMBIGUOUS'
  | 'TRANSACTION_STATE_READ_FAILED'
  | 'TRANSACTION_STATE_MISMATCH'
  | 'LIVE_IDENTITY_READ_FAILED'
  | 'LIVE_IDENTITY_ROW_COUNT_INVALID'
  | 'LIVE_DATABASE_NAME_MISMATCH'
  | 'LIVE_CURRENT_USER_MISMATCH'
  | 'LIVE_SESSION_USER_MISMATCH'
  | 'LIVE_SERVER_ADDRESS_MISMATCH'
  | 'LIVE_SERVER_PORT_MISMATCH'
  | 'LIVE_ATTESTED_AT_INVALID'
  | 'ROLE_TOPOLOGY_VERIFICATION_FAILED'
  | 'WORK_ORDER_TARGET_TIP_VERIFICATION_FAILED'
  | 'WORK_ORDER_TARGET_LOCK_FAILED'
  | 'WORK_ORDER_RUNTIME_AUTHORITY_READ_FAILED'
  | 'WORK_ORDER_RUNTIME_AUTHORITY_INVALID'
  | 'WORK_ORDER_RUNTIME_AUTHORITY_DRIFT'
  | 'VERIFIER_QUERY_PROTOCOL_VIOLATION'
  | 'SNAPSHOT_COMMIT_AMBIGUOUS'
  | 'SNAPSHOT_ROLLBACK_AMBIGUOUS'
  | 'DATABASE_SESSION_RELEASE_FAILED'
  | 'DATABASE_SESSION_DESTROY_FAILED'
  | 'DATABASE_AUTHORITY_EVALUATION_FAILED'
  | 'TEST_ONLY_AUTHORITY_KERNEL_FORBIDDEN';

export class RuntimeDatabaseAuthorityError extends Error {
  constructor(readonly code: RuntimeDatabaseAuthorityFailureCode) {
    super(`RUNTIME_DATABASE_AUTHORITY_REFUSED:${code}`);
    this.name = 'RuntimeDatabaseAuthorityError';
  }
}

export interface RuntimeDatabaseRoleTopology {
  readonly migrationRole: string;
  readonly apiRole: string;
  readonly workerRole: string;
  readonly attesterRole: string;
  readonly commandOwnerRole: string;
  readonly assertionOwnerRole: string;
  readonly financeOwnerRole: string;
  readonly telemetryOwnerRole: string;
}

export interface RuntimeDatabaseExpectedTarget {
  readonly environment: RuntimeDatabaseAuthorityEnvironment;
  readonly databaseName: string;
  readonly hostname: string;
  readonly port: number;
  readonly serverAddress: string;
  readonly tlsMode: RuntimeDatabaseTlsMode;
  readonly channelBinding: RuntimeDatabaseChannelBinding;
}

export interface RuntimeDatabaseTargetBinding extends RuntimeDatabaseExpectedTarget {
  readonly component: RuntimeDatabaseAuthorityComponent;
  readonly serviceLogin: string;
  readonly roleTopologyDigest: string;
}

export interface RuntimeDatabaseReleasePins {
  readonly manifestDigest: string;
  readonly signerKeyId: string;
  readonly signerKeyFingerprint: string;
  readonly revision: string;
  readonly artifactDigest: string;
}

export interface RuntimeDatabaseReleaseVerificationRequest {
  readonly component: RuntimeDatabaseAuthorityComponent;
  readonly releaseComponent: 'backend' | 'worker';
  readonly environment: RuntimeDatabaseAuthorityEnvironment;
  readonly databaseTargetDigest: string;
  readonly pins: RuntimeDatabaseReleasePins;
}

export interface RuntimeDatabaseCanonicalBuildProof {
  readonly identityDigest: string;
  readonly releaseManifestDigest: string;
  readonly environment: RuntimeDatabaseAuthorityEnvironment;
  readonly component: 'backend' | 'worker';
  readonly revision: string;
  readonly artifactDigest: string;
  readonly databaseTargetDigest: string;
}

/** Returned only by trusted code that recomputes and authenticates canonical bytes. */
export interface RuntimeDatabaseCanonicalReleaseProof {
  readonly schemaVersion: 1;
  readonly signatureAlgorithm: 'ed25519';
  readonly canonicalManifestDigest: string;
  readonly manifestDigest: string;
  readonly signerKeyId: string;
  readonly signerKeyFingerprint: string;
  readonly environment: RuntimeDatabaseAuthorityEnvironment;
  readonly component: 'backend' | 'worker';
  readonly revision: string;
  readonly artifactDigest: string;
  readonly databaseTargetDigest: string;
  readonly build: RuntimeDatabaseCanonicalBuildProof;
}

export type RuntimeDatabaseTrustedReleaseAuthorityVerifier = (
  request: Readonly<RuntimeDatabaseReleaseVerificationRequest>
) => Promise<RuntimeDatabaseCanonicalReleaseProof>;

export interface RuntimeDatabaseAuthorityInput {
  readonly component: RuntimeDatabaseAuthorityComponent;
  readonly primaryDatabaseUrl: string;
  readonly replicaDatabaseUrl?: string | null;
  readonly expectedTarget: RuntimeDatabaseExpectedTarget;
  readonly expectedTargetDigest: string;
  readonly roleTopology: RuntimeDatabaseRoleTopology;
  readonly releasePins: RuntimeDatabaseReleasePins;
}

export interface RuntimeDatabaseAuthorityQuery {
  <Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[]
  ): Promise<{ rows: Row[]; rowCount: number }>;
}

export interface RuntimeDatabaseAuthoritySession {
  readonly adapterBinding: object;
  readonly poolBinding: object;
  readonly sessionBinding: object;
  readonly adapterBindingDigest: string;
  readonly poolBindingDigest: string;
  readonly sessionBindingDigest: string;
  readonly connectionBindingDigest: string;
  readonly targetDigest: string;
  transactionStatus(): RuntimeDatabaseTransactionStatus;
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[]
  ): Promise<{ rows: Row[]; rowCount: number }>;
  /** Application statements must use PostgreSQL's one-statement extended protocol. */
  applicationQuery?<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[]
  ): Promise<{ rows: Row[]; rowCount: number }>;
  release(): Promise<void> | void;
  destroy(): Promise<void> | void;
}

export interface RuntimeDatabaseAuthorityAdapter {
  readonly adapterBinding: object;
  readonly poolBinding: object;
  readonly adapterBindingDigest: string;
  readonly poolBindingDigest: string;
  connect(
    exactPrimaryDatabaseUrl: string,
    immutableTarget: Readonly<RuntimeDatabaseTargetBinding>,
    connectionBindingDigest: string
  ): Promise<RuntimeDatabaseAuthoritySession>;
}

export interface RuntimeDatabaseObservedIdentity {
  readonly databaseName: string;
  readonly currentUser: string;
  readonly sessionUser: string;
  readonly serverAddress: string;
  readonly serverPort: number;
  readonly attestedAt: string;
}

export interface RuntimeDatabaseAuthorityVerifierContext {
  readonly query: RuntimeDatabaseAuthorityQuery;
  readonly component: RuntimeDatabaseAuthorityComponent;
  readonly roleTopology: RuntimeDatabaseRoleTopology;
  readonly expectedServiceLogin: string;
  readonly target: RuntimeDatabaseTargetBinding;
  readonly targetDigest: string;
  readonly releaseManifestDigest: string;
  readonly observed: RuntimeDatabaseObservedIdentity;
}

export interface RuntimeDatabaseAuthorityVerifierVerdict {
  readonly status: 'READY' | 'BLOCKED';
}

export type RuntimeDatabaseAuthorityVerifier = (
  context: RuntimeDatabaseAuthorityVerifierContext
) => Promise<RuntimeDatabaseAuthorityVerifierVerdict>;

export interface RuntimeDatabaseAuthorityVerifiers {
  readonly verifyReleaseAuthority: RuntimeDatabaseTrustedReleaseAuthorityVerifier;
  readonly verifyEightRoleTopology: RuntimeDatabaseAuthorityVerifier;
  readonly verifyWorkOrderTargetTip: RuntimeDatabaseAuthorityVerifier;
}

export interface RuntimeDatabaseReleaseAuthorityVerifier {
  readonly verifyReleaseAuthority: RuntimeDatabaseTrustedReleaseAuthorityVerifier;
}

export interface RuntimeDatabaseAuthorityHealth {
  readonly component: RuntimeDatabaseAuthorityComponent;
  readonly environment: RuntimeDatabaseAuthorityEnvironment;
  readonly authorityDigest: string;
  readonly databaseTargetDigest: string;
  readonly roleTopologyDigest: string;
  readonly manifestDigest: string;
  readonly revision: string;
  readonly artifactDigest: string;
  readonly workOrderTargetAuthorityId: string;
  readonly workOrderTargetAuthorityVersion: number;
  readonly workOrderTargetDigest: string;
  readonly workOrderSealDigest: string;
  readonly attestedAt: string;
}

export interface RuntimeDatabaseWorkOrderAuthorityBinding {
  readonly sessionDatabaseRole: string;
  readonly targetAuthorityId: string;
  readonly authorityVersion: number;
  readonly targetDatabaseName: string;
  readonly environment: RuntimeDatabaseAuthorityEnvironment;
  readonly releaseManifestSha256: string;
  readonly ordinal146SqlSha256: string;
  readonly v12SqlSha256: string;
  readonly sealSqlSha256: string;
  readonly v13SqlSha256: string;
  readonly fakeFinancialOperationsRelation: 'public.hxos_fake_financial_operations_v1';
  readonly fakeFinancialOperationEventsRelation: 'public.hxos_fake_financial_operation_events_v1';
  readonly bindingDigest: string;
}

declare const RUNTIME_DATABASE_CAPABILITY_BRAND: unique symbol;
export interface RuntimeDatabaseAuthorityCapability {
  readonly [RUNTIME_DATABASE_CAPABILITY_BRAND]: true;
}

interface CapabilityBinding {
  readonly adapter: RuntimeDatabaseAuthorityAdapter;
  readonly adapterBinding: object;
  readonly poolBinding: object;
  readonly adapterBindingDigest: string;
  readonly poolBindingDigest: string;
  readonly sessionBinding: object;
  readonly sessionBindingDigest: string;
  readonly connectionBindingDigest: string;
  readonly targetDigest: string;
  readonly workOrderAuthority: RuntimeDatabaseWorkOrderAuthorityBinding;
  readonly health: RuntimeDatabaseAuthorityHealth;
}

interface ParsedDatabaseTarget {
  readonly username: string;
  readonly hostname: string;
  readonly port: number;
  readonly databaseName: string;
  readonly tlsMode: RuntimeDatabaseTlsMode;
  readonly channelBinding: RuntimeDatabaseChannelBinding;
}

interface RuntimeDatabaseIdentityRow extends Record<string, unknown> {
  database_name: string;
  current_user: string;
  session_user: string;
  server_address: string;
  server_port: number | string;
  attested_at: Date | string;
}

interface RuntimeDatabaseTransactionStateRow extends Record<string, unknown> {
  transaction_isolation: string;
  transaction_read_only: string;
}

interface RuntimeDatabaseWorkOrderAuthorityRow extends Record<string, unknown> {
  session_database_role: string;
  target_authority_id: string;
  authority_version: number;
  target_database_name: string;
  environment: string;
  release_manifest_sha256: string;
  ordinal146_sql_sha256: string;
  v12_sql_sha256: string;
  seal_sql_sha256: string;
  v13_sql_sha256: string;
  fake_financial_operations_relation: string;
  fake_financial_operation_events_relation: string;
}

interface PreparedAuthorityInput {
  readonly component: RuntimeDatabaseAuthorityComponent;
  readonly primaryDatabaseUrl: string;
  readonly target: Readonly<RuntimeDatabaseTargetBinding>;
  readonly targetDigest: string;
  readonly roleTopology: Readonly<RuntimeDatabaseRoleTopology>;
  readonly roleTopologyDigest: string;
  readonly releasePins: Readonly<RuntimeDatabaseReleasePins>;
  readonly connectionBindingDigest: string;
}

const COMPONENT_ROLE: Readonly<
  Record<RuntimeDatabaseAuthorityComponent, keyof RuntimeDatabaseRoleTopology>
> = { api: 'apiRole', worker: 'workerRole', attester: 'attesterRole' };
const COMPONENT_VERIFIER_ROLE: Readonly<
  Record<RuntimeDatabaseAuthorityComponent, WorkOrderCommandAuthorityVerifierRole>
> = { api: 'apiRole', worker: 'workerRole', attester: 'attesterRole' };
const ROLE_TOPOLOGY_KEYS = [
  'migrationRole',
  'apiRole',
  'workerRole',
  'attesterRole',
  'commandOwnerRole',
  'assertionOwnerRole',
  'financeOwnerRole',
  'telemetryOwnerRole',
] as const satisfies readonly (keyof RuntimeDatabaseRoleTopology)[];
const EXPECTED_TARGET_KEYS = [
  'environment',
  'databaseName',
  'hostname',
  'port',
  'serverAddress',
  'tlsMode',
  'channelBinding',
] as const satisfies readonly (keyof RuntimeDatabaseExpectedTarget)[];
const RELEASE_PIN_KEYS = [
  'manifestDigest',
  'signerKeyId',
  'signerKeyFingerprint',
  'revision',
  'artifactDigest',
] as const satisfies readonly (keyof RuntimeDatabaseReleasePins)[];
const RELEASE_PROOF_KEYS = [
  'schemaVersion',
  'signatureAlgorithm',
  'canonicalManifestDigest',
  'manifestDigest',
  'signerKeyId',
  'signerKeyFingerprint',
  'environment',
  'component',
  'revision',
  'artifactDigest',
  'databaseTargetDigest',
  'build',
] as const satisfies readonly (keyof RuntimeDatabaseCanonicalReleaseProof)[];
const BUILD_PROOF_KEYS = [
  'identityDigest',
  'releaseManifestDigest',
  'environment',
  'component',
  'revision',
  'artifactDigest',
  'databaseTargetDigest',
] as const satisfies readonly (keyof RuntimeDatabaseCanonicalBuildProof)[];
const AUTHORITY_INPUT_REQUIRED_KEYS = [
  'component',
  'primaryDatabaseUrl',
  'expectedTarget',
  'expectedTargetDigest',
  'roleTopology',
  'releasePins',
] as const satisfies readonly (keyof RuntimeDatabaseAuthorityInput)[];
const RELEASE_COMPONENT: Readonly<
  Record<RuntimeDatabaseAuthorityComponent, RuntimeDatabaseCanonicalReleaseProof['component']>
> = { api: 'backend', worker: 'worker', attester: 'backend' };
const capabilities = new WeakMap<object, CapabilityBinding>();

export const RUNTIME_DATABASE_IDENTITY_SQL = `SELECT current_database()::text AS database_name,
       CURRENT_USER::text AS current_user,
       SESSION_USER::text AS session_user,
       COALESCE(pg_catalog.host(pg_catalog.inet_server_addr()), 'local_socket') AS server_address,
       COALESCE(pg_catalog.inet_server_port(), 0)::integer AS server_port,
       pg_catalog.transaction_timestamp() AS attested_at`;
export const RUNTIME_DATABASE_TRANSACTION_STATE_SQL = `SELECT
       pg_catalog.current_setting('transaction_isolation')::text AS transaction_isolation,
       pg_catalog.current_setting('transaction_read_only')::text AS transaction_read_only`;

// Utility lock, deliberately not SELECT pg_advisory_xact_lock(...): a
// REPEATABLE READ SELECT fixes its snapshot before an advisory wait completes.
// The empty public barrier carries no authority data; target activation takes
// ACCESS EXCLUSIVE while runtime transactions take this read-only-safe lock
// before the first snapshot-producing statement.
export const RUNTIME_DATABASE_WORK_ORDER_TARGET_LOCK_SQL =
  'LOCK TABLE public.hxos_universal_v1_work_order_target_activation_barrier_v1 IN ACCESS SHARE MODE';

export const RUNTIME_DATABASE_WORK_ORDER_AUTHORITY_SQL = `SELECT
       runtime.session_database_role,
       runtime.target_authority_id::text AS target_authority_id,
       runtime.authority_version,
       runtime.target_database_name,
       runtime.environment,
       runtime.release_manifest_sha256,
       runtime.ordinal146_sql_sha256,
       runtime.v12_sql_sha256,
       runtime.seal_sql_sha256,
       runtime.v13_sql_sha256,
       runtime.fake_financial_operations_relation,
       runtime.fake_financial_operation_events_relation
  FROM public.hxos_read_universal_v1_fake_financial_runtime_authority_v13() runtime`;

export const RUNTIME_DATABASE_WORK_ORDER_AUTHORITY_ROW_KEYS = [
  'session_database_role',
  'target_authority_id',
  'authority_version',
  'target_database_name',
  'environment',
  'release_manifest_sha256',
  'ordinal146_sql_sha256',
  'v12_sql_sha256',
  'seal_sql_sha256',
  'v13_sql_sha256',
  'fake_financial_operations_relation',
  'fake_financial_operation_events_relation',
] as const;

function refuse(code: RuntimeDatabaseAuthorityFailureCode): never {
  throw new RuntimeDatabaseAuthorityError(code);
}
function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export function runtimeDatabaseConnectionBindingDigest(exactPrimaryDatabaseUrl: string): string {
  if (typeof exactPrimaryDatabaseUrl !== 'string' || exactPrimaryDatabaseUrl.length === 0) {
    return refuse('PRIMARY_DATABASE_URL_REQUIRED');
  }
  return sha256(`hustlexp-runtime-database-connection-v1\n${exactPrimaryDatabaseUrl}`);
}
function nonzeroDigest(value: string): boolean {
  return SHA256_DIGEST.test(value) && !ZERO_SHA256_DIGEST.test(value);
}
function nonzeroRevision(value: string): boolean {
  return REVISION.test(value) && !ZERO_REVISION.test(value);
}
function normalizedHost(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, '');
}
function safeExactText(value: string, maximumLength = 255): boolean {
  if (value.length === 0 || value.length > maximumLength) return false;
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint > 31 && codePoint !== 127;
  });
}
function decoded(value: string, code: RuntimeDatabaseAuthorityFailureCode): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return refuse(code);
  }
}

function exactOwnKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return false;
  }
  if (keys.some((key) => typeof key !== 'string')) return false;
  const strings = keys as readonly string[];
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => strings.includes(key)) &&
    strings.length <= allowed.size &&
    strings.every((key) => allowed.has(key))
  );
}

function exactTlsOptions(parsed: URL): {
  tlsMode: RuntimeDatabaseTlsMode;
  channelBinding: RuntimeDatabaseChannelBinding;
} {
  const allowed = new Set(['sslmode', 'application_name', 'channel_binding']);
  for (const key of parsed.searchParams.keys()) {
    if (!allowed.has(key) || parsed.searchParams.getAll(key).length !== 1) {
      return refuse('PRIMARY_DATABASE_URL_OPTION_UNSUPPORTED');
    }
  }
  const applicationName = parsed.searchParams.get('application_name');
  if (applicationName !== null && !safeExactText(applicationName, 64)) {
    return refuse('PRIMARY_DATABASE_URL_OPTION_UNSUPPORTED');
  }
  const configuredChannelBinding = parsed.searchParams.get('channel_binding');
  if (configuredChannelBinding !== null && configuredChannelBinding !== 'require') {
    return refuse('PRIMARY_DATABASE_URL_TLS_INVALID');
  }
  const tlsMode = parsed.searchParams.get('sslmode');
  if (tlsMode !== 'disable' && tlsMode !== 'verify-full') {
    return refuse('PRIMARY_DATABASE_URL_TLS_INVALID');
  }
  if (
    (tlsMode === 'disable' && configuredChannelBinding !== null) ||
    (tlsMode === 'verify-full' && configuredChannelBinding !== 'require')
  ) {
    return refuse('PRIMARY_DATABASE_URL_TLS_INVALID');
  }
  return {
    tlsMode,
    channelBinding: configuredChannelBinding === 'require' ? 'require' : 'disabled',
  };
}

function parsePrimaryDatabaseUrl(databaseUrl: string): ParsedDatabaseTarget {
  if (!databaseUrl.trim()) return refuse('PRIMARY_DATABASE_URL_REQUIRED');
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return refuse('PRIMARY_DATABASE_URL_INVALID');
  }
  if (!POSTGRES_PROTOCOLS.has(parsed.protocol)) {
    return refuse('PRIMARY_DATABASE_URL_PROTOCOL_INVALID');
  }
  if (parsed.hash) return refuse('PRIMARY_DATABASE_URL_OPTION_UNSUPPORTED');
  if (!parsed.hostname || parsed.searchParams.has('host')) {
    return refuse('PRIMARY_DATABASE_LOCAL_SOCKET_UNSUPPORTED');
  }
  const username = decoded(parsed.username, 'PRIMARY_DATABASE_USER_INVALID');
  const databaseName = decoded(
    parsed.pathname.replace(/^\//u, ''),
    'PRIMARY_DATABASE_NAME_INVALID'
  );
  const hostname = normalizedHost(parsed.hostname);
  const port = parsed.port ? Number(parsed.port) : 5432;
  const { tlsMode, channelBinding } = exactTlsOptions(parsed);
  if (!ROLE_IDENTIFIER.test(username)) return refuse('PRIMARY_DATABASE_USER_INVALID');
  if (!safeExactText(hostname)) return refuse('PRIMARY_DATABASE_HOST_INVALID');
  if (!safeExactText(databaseName, 63) || databaseName.includes('/')) {
    return refuse('PRIMARY_DATABASE_NAME_INVALID');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return refuse('PRIMARY_DATABASE_URL_INVALID');
  }
  return { username, hostname, port, databaseName, tlsMode, channelBinding };
}

function assertRoleTopology(roles: RuntimeDatabaseRoleTopology): void {
  const values = ROLE_TOPOLOGY_KEYS.map((key) => roles[key]);
  if (
    !exactOwnKeys(roles, ROLE_TOPOLOGY_KEYS) ||
    values.some((role) => typeof role !== 'string' || !ROLE_IDENTIFIER.test(role))
  ) {
    return refuse('ROLE_TOPOLOGY_INVALID');
  }
  if (new Set(values).size !== values.length) return refuse('ROLE_TOPOLOGY_INVALID');
}

export function runtimeDatabaseRoleTopologyDigest(roles: RuntimeDatabaseRoleTopology): string {
  assertRoleTopology(roles);
  return sha256(
    [
      'hustlexp-runtime-database-role-topology-v1',
      ...ROLE_TOPOLOGY_KEYS.map((key) => `${key}=${roles[key]}`),
    ].join('\n')
  );
}

function normalizedExpectedTarget(
  target: RuntimeDatabaseExpectedTarget
): RuntimeDatabaseExpectedTarget {
  if (!exactOwnKeys(target, EXPECTED_TARGET_KEYS)) return refuse('EXPECTED_TARGET_INVALID');
  if (
    typeof target.environment !== 'string' ||
    typeof target.databaseName !== 'string' ||
    typeof target.hostname !== 'string' ||
    typeof target.port !== 'number' ||
    typeof target.serverAddress !== 'string' ||
    typeof target.tlsMode !== 'string' ||
    typeof target.channelBinding !== 'string'
  ) {
    return refuse('EXPECTED_TARGET_INVALID');
  }
  const hostname = normalizedHost(target.hostname);
  const serverAddress = normalizedHost(target.serverAddress);
  if (
    !RUNTIME_ENVIRONMENTS.has(target.environment) ||
    !safeExactText(target.databaseName, 63) ||
    target.databaseName.includes('/') ||
    !safeExactText(hostname) ||
    !safeExactText(serverAddress) ||
    !Number.isInteger(target.port) ||
    target.port < 1 ||
    target.port > 65_535 ||
    !['disable', 'verify-full'].includes(target.tlsMode) ||
    !['require', 'disabled'].includes(target.channelBinding) ||
    (target.tlsMode === 'disable' && target.channelBinding !== 'disabled') ||
    (target.tlsMode === 'verify-full' && target.channelBinding !== 'require') ||
    (target.environment !== 'local' &&
      (target.tlsMode !== 'verify-full' || target.channelBinding !== 'require'))
  ) {
    return refuse('EXPECTED_TARGET_INVALID');
  }
  return Object.freeze({
    environment: target.environment,
    databaseName: target.databaseName,
    hostname,
    port: target.port,
    serverAddress,
    tlsMode: target.tlsMode,
    channelBinding: target.channelBinding,
  });
}

export function runtimeDatabaseTargetDigest(target: RuntimeDatabaseTargetBinding): string {
  if (
    !RUNTIME_DATABASE_AUTHORITY_COMPONENTS.includes(target.component) ||
    !ROLE_IDENTIFIER.test(target.serviceLogin) ||
    !nonzeroDigest(target.roleTopologyDigest)
  ) {
    return refuse('EXPECTED_TARGET_INVALID');
  }
  const normalized = normalizedExpectedTarget({
    environment: target.environment,
    databaseName: target.databaseName,
    hostname: target.hostname,
    port: target.port,
    serverAddress: target.serverAddress,
    tlsMode: target.tlsMode,
    channelBinding: target.channelBinding,
  });
  return sha256(
    [
      'hustlexp-runtime-database-target-v3',
      `component=${target.component}`,
      `environment=${normalized.environment}`,
      `service_login=${target.serviceLogin}`,
      `role_topology=${target.roleTopologyDigest}`,
      `database=${normalized.databaseName}`,
      `hostname=${normalized.hostname}`,
      `port=${normalized.port}`,
      `server_address=${normalized.serverAddress}`,
      `tls_mode=${normalized.tlsMode}`,
      `channel_binding=${normalized.channelBinding}`,
    ].join('\n')
  );
}

function assertReleasePins(pins: RuntimeDatabaseReleasePins): void {
  if (
    !exactOwnKeys(pins, RELEASE_PIN_KEYS) ||
    RELEASE_PIN_KEYS.some((key) => typeof pins[key] !== 'string') ||
    !nonzeroDigest(pins.manifestDigest) ||
    !KEY_IDENTIFIER.test(pins.signerKeyId) ||
    !nonzeroDigest(pins.signerKeyFingerprint) ||
    !nonzeroRevision(pins.revision) ||
    !nonzeroDigest(pins.artifactDigest)
  ) {
    return refuse('RELEASE_PIN_INVALID');
  }
}

export function runtimeDatabaseBuildProofDigest(
  build: Omit<RuntimeDatabaseCanonicalBuildProof, 'identityDigest'>
): string {
  return sha256(
    [
      'hustlexp-runtime-database-build-proof-v1',
      `manifest=${build.releaseManifestDigest}`,
      `environment=${build.environment}`,
      `component=${build.component}`,
      `revision=${build.revision}`,
      `artifact=${build.artifactDigest}`,
      `database_target=${build.databaseTargetDigest}`,
    ].join('\n')
  );
}

function copyAndVerifyReleaseProof(
  prepared: PreparedAuthorityInput,
  proof: RuntimeDatabaseCanonicalReleaseProof
): Readonly<RuntimeDatabaseCanonicalReleaseProof> {
  if (
    typeof proof !== 'object' ||
    proof === null ||
    !exactOwnKeys(proof, RELEASE_PROOF_KEYS) ||
    typeof proof.build !== 'object' ||
    proof.build === null ||
    !exactOwnKeys(proof.build, BUILD_PROOF_KEYS)
  ) {
    return refuse('RELEASE_PROOF_INVALID');
  }
  const buildInput = proof.build;
  const build = Object.freeze({
    identityDigest: buildInput.identityDigest,
    releaseManifestDigest: buildInput.releaseManifestDigest,
    environment: buildInput.environment,
    component: buildInput.component,
    revision: buildInput.revision,
    artifactDigest: buildInput.artifactDigest,
    databaseTargetDigest: buildInput.databaseTargetDigest,
  });
  const copied = Object.freeze({
    schemaVersion: proof.schemaVersion,
    signatureAlgorithm: proof.signatureAlgorithm,
    canonicalManifestDigest: proof.canonicalManifestDigest,
    manifestDigest: proof.manifestDigest,
    signerKeyId: proof.signerKeyId,
    signerKeyFingerprint: proof.signerKeyFingerprint,
    environment: proof.environment,
    component: proof.component,
    revision: proof.revision,
    artifactDigest: proof.artifactDigest,
    databaseTargetDigest: proof.databaseTargetDigest,
    build,
  });
  const expectedComponent = RELEASE_COMPONENT[prepared.component];
  if (
    copied.schemaVersion !== 1 ||
    copied.signatureAlgorithm !== 'ed25519' ||
    !nonzeroDigest(copied.canonicalManifestDigest) ||
    !nonzeroDigest(copied.manifestDigest) ||
    !KEY_IDENTIFIER.test(copied.signerKeyId) ||
    !nonzeroDigest(copied.signerKeyFingerprint) ||
    !nonzeroRevision(copied.revision) ||
    !nonzeroDigest(copied.artifactDigest) ||
    !nonzeroDigest(copied.databaseTargetDigest)
  ) {
    return refuse('RELEASE_PROOF_INVALID');
  }
  if (
    copied.canonicalManifestDigest !== copied.manifestDigest ||
    copied.manifestDigest !== prepared.releasePins.manifestDigest
  ) {
    return refuse('RELEASE_MANIFEST_DIGEST_MISMATCH');
  }
  if (
    copied.signerKeyId !== prepared.releasePins.signerKeyId ||
    copied.signerKeyFingerprint !== prepared.releasePins.signerKeyFingerprint
  ) {
    return refuse('RELEASE_SIGNER_MISMATCH');
  }
  if (copied.environment !== prepared.target.environment) {
    return refuse('RELEASE_ENVIRONMENT_MISMATCH');
  }
  if (copied.component !== expectedComponent) return refuse('RELEASE_COMPONENT_MISMATCH');
  if (copied.revision !== prepared.releasePins.revision) {
    return refuse('RELEASE_REVISION_MISMATCH');
  }
  if (copied.artifactDigest !== prepared.releasePins.artifactDigest) {
    return refuse('RELEASE_ARTIFACT_DIGEST_MISMATCH');
  }
  if (copied.databaseTargetDigest !== prepared.targetDigest) {
    return refuse('RELEASE_DATABASE_TARGET_MISMATCH');
  }
  const canonicalBuild = runtimeDatabaseBuildProofDigest({
    releaseManifestDigest: build.releaseManifestDigest,
    environment: build.environment,
    component: build.component,
    revision: build.revision,
    artifactDigest: build.artifactDigest,
    databaseTargetDigest: build.databaseTargetDigest,
  });
  if (
    build.identityDigest !== canonicalBuild ||
    build.releaseManifestDigest !== copied.manifestDigest ||
    build.environment !== copied.environment ||
    build.component !== copied.component ||
    build.revision !== copied.revision ||
    build.artifactDigest !== copied.artifactDigest ||
    build.databaseTargetDigest !== prepared.targetDigest
  ) {
    return refuse('BUILD_PROOF_MISMATCH');
  }
  return copied;
}

function prepareInput(input: RuntimeDatabaseAuthorityInput): PreparedAuthorityInput {
  if (!exactOwnKeys(input, AUTHORITY_INPUT_REQUIRED_KEYS, ['replicaDatabaseUrl'])) {
    return refuse('EXPECTED_TARGET_INVALID');
  }

  // Snapshot each caller-owned top-level field exactly once before any
  // validation or await. A getter/Proxy must not be able to validate one URL,
  // component, or digest and supply another to the connector or release proof.
  const component = input.component;
  const primaryDatabaseUrl = input.primaryDatabaseUrl;
  const replicaDatabaseUrl = input.replicaDatabaseUrl;
  const expectedTargetInput = input.expectedTarget;
  const expectedTargetDigest = input.expectedTargetDigest;
  const roleTopologyInput = input.roleTopology;
  const releasePinsInput = input.releasePins;

  if (typeof replicaDatabaseUrl === 'string' && replicaDatabaseUrl.trim()) {
    return refuse('REPLICA_DATABASE_CONFIGURED');
  }
  if (
    replicaDatabaseUrl !== undefined &&
    replicaDatabaseUrl !== null &&
    typeof replicaDatabaseUrl !== 'string'
  ) {
    return refuse('REPLICA_DATABASE_CONFIGURED');
  }
  if (!RUNTIME_DATABASE_AUTHORITY_COMPONENTS.includes(component)) {
    return refuse('EXPECTED_TARGET_INVALID');
  }
  if (typeof primaryDatabaseUrl !== 'string') return refuse('PRIMARY_DATABASE_URL_INVALID');
  if (typeof expectedTargetDigest !== 'string') return refuse('TARGET_DIGEST_INVALID');

  if (!exactOwnKeys(roleTopologyInput, ROLE_TOPOLOGY_KEYS)) {
    return refuse('ROLE_TOPOLOGY_INVALID');
  }
  if (!exactOwnKeys(expectedTargetInput, EXPECTED_TARGET_KEYS)) {
    return refuse('EXPECTED_TARGET_INVALID');
  }
  if (!exactOwnKeys(releasePinsInput, RELEASE_PIN_KEYS)) {
    return refuse('RELEASE_PIN_INVALID');
  }

  const roleTopology = Object.freeze({
    migrationRole: roleTopologyInput.migrationRole,
    apiRole: roleTopologyInput.apiRole,
    workerRole: roleTopologyInput.workerRole,
    attesterRole: roleTopologyInput.attesterRole,
    commandOwnerRole: roleTopologyInput.commandOwnerRole,
    assertionOwnerRole: roleTopologyInput.assertionOwnerRole,
    financeOwnerRole: roleTopologyInput.financeOwnerRole,
    telemetryOwnerRole: roleTopologyInput.telemetryOwnerRole,
  });
  assertRoleTopology(roleTopology);
  const roleTopologyDigest = runtimeDatabaseRoleTopologyDigest(roleTopology);
  const expected = normalizedExpectedTarget({
    environment: expectedTargetInput.environment,
    databaseName: expectedTargetInput.databaseName,
    hostname: expectedTargetInput.hostname,
    port: expectedTargetInput.port,
    serverAddress: expectedTargetInput.serverAddress,
    tlsMode: expectedTargetInput.tlsMode,
    channelBinding: expectedTargetInput.channelBinding,
  });
  const releasePins = Object.freeze({
    manifestDigest: releasePinsInput.manifestDigest,
    signerKeyId: releasePinsInput.signerKeyId,
    signerKeyFingerprint: releasePinsInput.signerKeyFingerprint,
    revision: releasePinsInput.revision,
    artifactDigest: releasePinsInput.artifactDigest,
  });
  assertReleasePins(releasePins);
  const configured = parsePrimaryDatabaseUrl(primaryDatabaseUrl);
  const serviceLogin = roleTopology[COMPONENT_ROLE[component]];
  if (configured.username !== serviceLogin) {
    return refuse('CONFIGURED_DATABASE_USER_MISMATCH');
  }
  if (configured.hostname !== expected.hostname) {
    return refuse('CONFIGURED_DATABASE_HOST_MISMATCH');
  }
  if (configured.port !== expected.port) return refuse('CONFIGURED_DATABASE_PORT_MISMATCH');
  if (configured.databaseName !== expected.databaseName) {
    return refuse('CONFIGURED_DATABASE_NAME_MISMATCH');
  }
  if (configured.tlsMode !== expected.tlsMode) {
    return refuse('CONFIGURED_DATABASE_TLS_MISMATCH');
  }
  if (configured.channelBinding !== expected.channelBinding) {
    return refuse('CONFIGURED_DATABASE_TLS_MISMATCH');
  }
  const target = Object.freeze({
    ...expected,
    component,
    serviceLogin,
    roleTopologyDigest,
  });
  const targetDigest = runtimeDatabaseTargetDigest(target);
  if (!nonzeroDigest(expectedTargetDigest)) return refuse('TARGET_DIGEST_INVALID');
  if (expectedTargetDigest !== targetDigest) return refuse('TARGET_DIGEST_MISMATCH');
  return Object.freeze({
    component,
    primaryDatabaseUrl,
    target,
    targetDigest,
    roleTopology,
    roleTopologyDigest,
    releasePins,
    connectionBindingDigest: runtimeDatabaseConnectionBindingDigest(primaryDatabaseUrl),
  });
}

function bindingToken(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function assertSessionBinding(
  prepared: PreparedAuthorityInput,
  adapter: RuntimeDatabaseAuthorityAdapter,
  session: RuntimeDatabaseAuthoritySession
): void {
  if (
    !bindingToken(adapter.adapterBinding) ||
    !bindingToken(adapter.poolBinding) ||
    !bindingToken(session.sessionBinding) ||
    session.adapterBinding !== adapter.adapterBinding ||
    session.poolBinding !== adapter.poolBinding ||
    session.adapterBindingDigest !== adapter.adapterBindingDigest ||
    session.poolBindingDigest !== adapter.poolBindingDigest ||
    !nonzeroDigest(adapter.adapterBindingDigest) ||
    !nonzeroDigest(adapter.poolBindingDigest) ||
    !nonzeroDigest(session.sessionBindingDigest) ||
    session.connectionBindingDigest !== prepared.connectionBindingDigest ||
    session.targetDigest !== prepared.targetDigest
  ) {
    return refuse('DATABASE_SESSION_BINDING_MISMATCH');
  }
}

function sessionStatus(session: RuntimeDatabaseAuthoritySession): RuntimeDatabaseTransactionStatus {
  try {
    return session.transactionStatus();
  } catch {
    return refuse('DATABASE_SESSION_STATUS_UNAVAILABLE');
  }
}

function transactionQueryFailureIsAmbiguous(session: RuntimeDatabaseAuthoritySession): boolean {
  let status: RuntimeDatabaseTransactionStatus;
  try {
    status = sessionStatus(session);
  } catch {
    return true;
  }
  return status !== 'IN_TRANSACTION' && status !== 'FAILED_TRANSACTION';
}

function canonicalTimestamp(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) return refuse('LIVE_ATTESTED_AT_INVALID');
  return parsed.toISOString();
}

async function assertTransactionState(query: RuntimeDatabaseAuthorityQuery): Promise<void> {
  let result: { rows: RuntimeDatabaseTransactionStateRow[]; rowCount: number };
  try {
    result = await query<RuntimeDatabaseTransactionStateRow>(
      RUNTIME_DATABASE_TRANSACTION_STATE_SQL
    );
  } catch {
    return refuse('TRANSACTION_STATE_READ_FAILED');
  }
  if (
    result.rowCount !== 1 ||
    result.rows.length !== 1 ||
    result.rows[0]?.transaction_isolation !== 'repeatable read' ||
    result.rows[0]?.transaction_read_only !== 'on'
  ) {
    return refuse('TRANSACTION_STATE_MISMATCH');
  }
}

async function readLiveIdentity(
  query: RuntimeDatabaseAuthorityQuery,
  target: RuntimeDatabaseTargetBinding
): Promise<Readonly<RuntimeDatabaseObservedIdentity>> {
  let result: { rows: RuntimeDatabaseIdentityRow[]; rowCount: number };
  try {
    result = await query<RuntimeDatabaseIdentityRow>(RUNTIME_DATABASE_IDENTITY_SQL);
  } catch {
    return refuse('LIVE_IDENTITY_READ_FAILED');
  }
  if (result.rowCount !== 1 || result.rows.length !== 1) {
    return refuse('LIVE_IDENTITY_ROW_COUNT_INVALID');
  }
  const row = result.rows[0]!;
  const serverAddress = normalizedHost(String(row.server_address ?? ''));
  const serverPort = Number(row.server_port);
  if (row.database_name !== target.databaseName) return refuse('LIVE_DATABASE_NAME_MISMATCH');
  if (row.current_user !== target.serviceLogin) return refuse('LIVE_CURRENT_USER_MISMATCH');
  if (row.session_user !== target.serviceLogin) return refuse('LIVE_SESSION_USER_MISMATCH');
  if (serverAddress !== target.serverAddress) return refuse('LIVE_SERVER_ADDRESS_MISMATCH');
  if (!Number.isInteger(serverPort) || serverPort !== target.port) {
    return refuse('LIVE_SERVER_PORT_MISMATCH');
  }
  return Object.freeze({
    databaseName: row.database_name,
    currentUser: row.current_user,
    sessionUser: row.session_user,
    serverAddress,
    serverPort,
    attestedAt: canonicalTimestamp(row.attested_at),
  });
}

function workOrderRoleEnvironment(
  roles: Readonly<RuntimeDatabaseRoleTopology>
): Readonly<Record<string, string>> {
  return Object.freeze({
    HX_WORK_ORDER_MIGRATION_DATABASE_ROLE: roles.migrationRole,
    HX_WORK_ORDER_API_DATABASE_ROLE: roles.apiRole,
    HX_WORK_ORDER_WORKER_DATABASE_ROLE: roles.workerRole,
    HX_WORK_ORDER_ATTESTER_DATABASE_ROLE: roles.attesterRole,
    HX_WORK_ORDER_COMMAND_OWNER_DATABASE_ROLE: roles.commandOwnerRole,
    HX_WORK_ORDER_ASSERTION_OWNER_DATABASE_ROLE: roles.assertionOwnerRole,
    HX_FINANCE_COMMAND_OWNER_DATABASE_ROLE: roles.financeOwnerRole,
    HX_TELEMETRY_OWNER_DATABASE_ROLE: roles.telemetryOwnerRole,
  });
}

function workOrderAuthorityBindingDigest(
  binding: Omit<RuntimeDatabaseWorkOrderAuthorityBinding, 'bindingDigest'>
): string {
  return sha256(
    [
      'hustlexp-runtime-work-order-authority-v1',
      `session_role=${binding.sessionDatabaseRole}`,
      `target_authority_id=${binding.targetAuthorityId}`,
      `authority_version=${binding.authorityVersion}`,
      `database=${binding.targetDatabaseName}`,
      `environment=${binding.environment}`,
      `release_manifest=${binding.releaseManifestSha256}`,
      `ordinal146=${binding.ordinal146SqlSha256}`,
      `v12=${binding.v12SqlSha256}`,
      `seal=${binding.sealSqlSha256}`,
      `v13=${binding.v13SqlSha256}`,
      `operations=${binding.fakeFinancialOperationsRelation}`,
      `events=${binding.fakeFinancialOperationEventsRelation}`,
    ].join('\n')
  );
}

async function readCanonicalWorkOrderAuthority(
  query: RuntimeDatabaseAuthorityQuery,
  prepared: PreparedAuthorityInput,
  releaseProof: Readonly<RuntimeDatabaseCanonicalReleaseProof>
): Promise<Readonly<RuntimeDatabaseWorkOrderAuthorityBinding>> {
  let result: { rows: RuntimeDatabaseWorkOrderAuthorityRow[]; rowCount: number };
  try {
    result = await query<RuntimeDatabaseWorkOrderAuthorityRow>(
      RUNTIME_DATABASE_WORK_ORDER_AUTHORITY_SQL
    );
  } catch {
    return refuse('WORK_ORDER_RUNTIME_AUTHORITY_READ_FAILED');
  }
  if (result.rowCount !== 1 || result.rows.length !== 1) {
    return refuse('WORK_ORDER_RUNTIME_AUTHORITY_INVALID');
  }
  const row = result.rows[0]!;
  const authorityVersion = row.authority_version;
  if (
    !exactOwnKeys(row, RUNTIME_DATABASE_WORK_ORDER_AUTHORITY_ROW_KEYS) ||
    typeof row.session_database_role !== 'string' ||
    typeof row.target_authority_id !== 'string' ||
    !UUID.test(row.target_authority_id) ||
    typeof authorityVersion !== 'number' ||
    !Number.isSafeInteger(authorityVersion) ||
    authorityVersion < 1 ||
    row.session_database_role !== prepared.target.serviceLogin ||
    row.target_database_name !== prepared.target.databaseName ||
    row.environment !== prepared.target.environment ||
    row.release_manifest_sha256 !== releaseProof.manifestDigest ||
    row.ordinal146_sql_sha256 !== WORK_ORDER_ORDINAL146_SQL_SHA256 ||
    row.v12_sql_sha256 !== WORK_ORDER_FAKE_FINANCIAL_V12_SQL_SHA256 ||
    row.seal_sql_sha256 !== WORK_ORDER_BOOTSTRAP_SEAL_SQL_SHA256 ||
    row.v13_sql_sha256 !== FAKE_FINANCIAL_OUTBOX_V13_SQL_SHA256 ||
    row.fake_financial_operations_relation !== 'public.hxos_fake_financial_operations_v1' ||
    row.fake_financial_operation_events_relation !==
      'public.hxos_fake_financial_operation_events_v1'
  ) {
    return refuse('WORK_ORDER_RUNTIME_AUTHORITY_DRIFT');
  }
  const withoutDigest = Object.freeze({
    sessionDatabaseRole: row.session_database_role,
    targetAuthorityId: row.target_authority_id,
    authorityVersion,
    targetDatabaseName: row.target_database_name,
    environment: prepared.target.environment,
    releaseManifestSha256: row.release_manifest_sha256,
    ordinal146SqlSha256: row.ordinal146_sql_sha256,
    v12SqlSha256: row.v12_sql_sha256,
    sealSqlSha256: row.seal_sql_sha256,
    v13SqlSha256: row.v13_sql_sha256,
    fakeFinancialOperationsRelation: 'public.hxos_fake_financial_operations_v1' as const,
    fakeFinancialOperationEventsRelation: 'public.hxos_fake_financial_operation_events_v1' as const,
  });
  return Object.freeze({
    ...withoutDigest,
    bindingDigest: workOrderAuthorityBindingDigest(withoutDigest),
  });
}

function testOnlyWorkOrderAuthorityBinding(
  prepared: PreparedAuthorityInput,
  releaseProof: RuntimeDatabaseCanonicalReleaseProof
): Readonly<RuntimeDatabaseWorkOrderAuthorityBinding> {
  const withoutDigest = Object.freeze({
    sessionDatabaseRole: prepared.target.serviceLogin,
    targetAuthorityId: '11111111-1111-4111-8111-111111111111',
    authorityVersion: 1,
    targetDatabaseName: prepared.target.databaseName,
    environment: prepared.target.environment,
    releaseManifestSha256: releaseProof.manifestDigest,
    ordinal146SqlSha256: WORK_ORDER_ORDINAL146_SQL_SHA256,
    v12SqlSha256: WORK_ORDER_FAKE_FINANCIAL_V12_SQL_SHA256,
    sealSqlSha256: WORK_ORDER_BOOTSTRAP_SEAL_SQL_SHA256,
    v13SqlSha256: FAKE_FINANCIAL_OUTBOX_V13_SQL_SHA256,
    fakeFinancialOperationsRelation: 'public.hxos_fake_financial_operations_v1' as const,
    fakeFinancialOperationEventsRelation: 'public.hxos_fake_financial_operation_events_v1' as const,
  });
  return Object.freeze({
    ...withoutDigest,
    bindingDigest: workOrderAuthorityBindingDigest(withoutDigest),
  });
}

const RUNTIME_DATABASE_VERIFIER_SQL = new Set([
  RUNTIME_DATABASE_IDENTITY_SQL,
  RUNTIME_DATABASE_TRANSACTION_STATE_SQL,
]);

function verifierSqlAllowed(sql: string): boolean {
  return RUNTIME_DATABASE_VERIFIER_SQL.has(sql);
}

async function runVerifierPhase(
  session: RuntimeDatabaseAuthoritySession,
  verifier: RuntimeDatabaseAuthorityVerifier,
  baseContext: Omit<RuntimeDatabaseAuthorityVerifierContext, 'query'>,
  failureCode: 'ROLE_TOPOLOGY_VERIFICATION_FAILED' | 'WORK_ORDER_TARGET_TIP_VERIFICATION_FAILED'
): Promise<void> {
  let phaseOpen = true;
  let protocolViolation = false;
  let queryFailure = false;
  let queue: Promise<void> = Promise.resolve();
  const verifierQueriesSeen = new Set<string>();
  const verifierQuery: RuntimeDatabaseAuthorityQuery = <
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(
    sql: string,
    values?: readonly unknown[]
  ): Promise<{ rows: Row[]; rowCount: number }> => {
    if (
      !phaseOpen ||
      !verifierSqlAllowed(sql) ||
      (values !== undefined && values.length > 0) ||
      verifierQueriesSeen.has(sql)
    ) {
      protocolViolation = true;
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    verifierQueriesSeen.add(sql);
    const copiedValues = values ? Object.freeze([...values]) : undefined;
    let resolveResult: (value: { rows: Row[]; rowCount: number }) => void = () => undefined;
    const result = new Promise<{ rows: Row[]; rowCount: number }>((resolve) => {
      resolveResult = resolve;
    });
    queue = queue.then(async () => {
      try {
        resolveResult(await session.query<Row>(sql, copiedValues));
      } catch {
        queryFailure = true;
        resolveResult({ rows: [], rowCount: 0 });
      }
    });
    return result;
  };
  let verdict: RuntimeDatabaseAuthorityVerifierVerdict | null = null;
  try {
    verdict = await verifier(Object.freeze({ ...baseContext, query: verifierQuery }));
  } catch {
    // Normalize below without exposing verifier details.
  }
  phaseOpen = false;
  await queue;
  if (protocolViolation) return refuse('VERIFIER_QUERY_PROTOCOL_VIOLATION');
  if (queryFailure || verdict?.status !== 'READY') return refuse(failureCode);
}

function authorityError(
  error: unknown,
  fallback: RuntimeDatabaseAuthorityFailureCode
): RuntimeDatabaseAuthorityError {
  return error instanceof RuntimeDatabaseAuthorityError
    ? error
    : new RuntimeDatabaseAuthorityError(fallback);
}

async function destroySession(
  session: RuntimeDatabaseAuthoritySession
): Promise<RuntimeDatabaseAuthorityError | null> {
  try {
    await session.destroy();
    return null;
  } catch {
    return new RuntimeDatabaseAuthorityError('DATABASE_SESSION_DESTROY_FAILED');
  }
}

async function cleanupFailedSession(
  session: RuntimeDatabaseAuthoritySession,
  query: RuntimeDatabaseAuthorityQuery,
  transactionOpen: boolean,
  ambiguous: boolean,
  failure: RuntimeDatabaseAuthorityError
): Promise<RuntimeDatabaseAuthorityError> {
  if (ambiguous) return (await destroySession(session)) ?? failure;
  if (transactionOpen) {
    try {
      await query('ROLLBACK');
    } catch {
      return (
        (await destroySession(session)) ??
        new RuntimeDatabaseAuthorityError('SNAPSHOT_ROLLBACK_AMBIGUOUS')
      );
    }
    let rolledBackStatus: RuntimeDatabaseTransactionStatus;
    try {
      rolledBackStatus = sessionStatus(session);
    } catch {
      return (
        (await destroySession(session)) ??
        new RuntimeDatabaseAuthorityError('SNAPSHOT_ROLLBACK_AMBIGUOUS')
      );
    }
    if (rolledBackStatus !== 'IDLE') {
      return (
        (await destroySession(session)) ??
        new RuntimeDatabaseAuthorityError('SNAPSHOT_ROLLBACK_AMBIGUOUS')
      );
    }
  }
  try {
    await session.release();
    return failure;
  } catch {
    return (
      (await destroySession(session)) ??
      new RuntimeDatabaseAuthorityError('DATABASE_SESSION_RELEASE_FAILED')
    );
  }
}

function compositeAuthorityDigest(
  prepared: PreparedAuthorityInput,
  proof: RuntimeDatabaseCanonicalReleaseProof,
  workOrderAuthority: RuntimeDatabaseWorkOrderAuthorityBinding
): string {
  return sha256(
    [
      'hustlexp-runtime-database-authority-v3',
      `target=${prepared.targetDigest}`,
      `role_topology=${prepared.roleTopologyDigest}`,
      `manifest=${proof.manifestDigest}`,
      `signer_key_id=${proof.signerKeyId}`,
      `signer_fingerprint=${proof.signerKeyFingerprint}`,
      `environment=${proof.environment}`,
      `component=${prepared.component}`,
      `release_component=${proof.component}`,
      `revision=${proof.revision}`,
      `artifact=${proof.artifactDigest}`,
      `build=${proof.build.identityDigest}`,
      `work_order_target=${workOrderAuthority.bindingDigest}`,
    ].join('\n')
  );
}

function issueCapability(binding: CapabilityBinding): RuntimeDatabaseAuthorityCapability {
  const capability = Object.freeze({}) as RuntimeDatabaseAuthorityCapability;
  capabilities.set(capability, Object.freeze(binding));
  return capability;
}

export function runtimeDatabaseAuthorityHealth(
  capability: RuntimeDatabaseAuthorityCapability
): RuntimeDatabaseAuthorityHealth {
  const binding = capabilities.get(capability as object);
  if (
    !binding ||
    binding.adapter.adapterBinding !== binding.adapterBinding ||
    binding.adapter.poolBinding !== binding.poolBinding ||
    binding.adapter.adapterBindingDigest !== binding.adapterBindingDigest ||
    binding.adapter.poolBindingDigest !== binding.poolBindingDigest
  ) {
    return refuse('DATABASE_AUTHORITY_EVALUATION_FAILED');
  }
  return binding.health;
}

export function assertRuntimeDatabaseAuthorityCapabilityFor(
  capability: RuntimeDatabaseAuthorityCapability,
  adapter: RuntimeDatabaseAuthorityAdapter
): RuntimeDatabaseAuthorityHealth {
  const binding = capabilities.get(capability as object);
  if (
    !binding ||
    binding.adapter !== adapter ||
    binding.adapterBinding !== adapter.adapterBinding ||
    binding.poolBinding !== adapter.poolBinding ||
    binding.adapterBindingDigest !== adapter.adapterBindingDigest ||
    binding.poolBindingDigest !== adapter.poolBindingDigest
  ) {
    return refuse('DATABASE_SESSION_BINDING_MISMATCH');
  }
  return binding.health;
}

export function runtimeDatabaseWorkOrderAuthorityBinding(
  capability: RuntimeDatabaseAuthorityCapability,
  adapter: RuntimeDatabaseAuthorityAdapter
): RuntimeDatabaseWorkOrderAuthorityBinding {
  assertRuntimeDatabaseAuthorityCapabilityFor(capability, adapter);
  const binding = capabilities.get(capability as object);
  if (!binding) return refuse('DATABASE_SESSION_BINDING_MISMATCH');
  return binding.workOrderAuthority;
}

async function attestRuntimeDatabaseAuthorityKernel(
  input: RuntimeDatabaseAuthorityInput,
  adapter: RuntimeDatabaseAuthorityAdapter,
  verifiers: RuntimeDatabaseAuthorityVerifiers | RuntimeDatabaseReleaseAuthorityVerifier,
  canonicalWorkOrderAuthority: boolean
): Promise<RuntimeDatabaseAuthorityCapability> {
  const prepared = prepareInput(input);
  const releaseRequest = Object.freeze({
    component: prepared.component,
    releaseComponent: RELEASE_COMPONENT[prepared.component],
    environment: prepared.target.environment,
    databaseTargetDigest: prepared.targetDigest,
    pins: prepared.releasePins,
  });
  let releaseProof: Readonly<RuntimeDatabaseCanonicalReleaseProof>;
  try {
    releaseProof = copyAndVerifyReleaseProof(
      prepared,
      await verifiers.verifyReleaseAuthority(releaseRequest)
    );
  } catch (error) {
    if (error instanceof RuntimeDatabaseAuthorityError) throw error;
    return refuse('RELEASE_AUTHORITY_VERIFICATION_FAILED');
  }

  let session: RuntimeDatabaseAuthoritySession;
  try {
    session = await adapter.connect(
      prepared.primaryDatabaseUrl,
      prepared.target,
      prepared.connectionBindingDigest
    );
  } catch {
    return refuse('DATABASE_SESSION_UNAVAILABLE');
  }
  const query: RuntimeDatabaseAuthorityQuery = <
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(
    sql: string,
    values?: readonly unknown[]
  ) => session.query<Row>(sql, values);

  let transactionOpen = false;
  let ambiguous = false;
  let failure: RuntimeDatabaseAuthorityError | null = null;
  let observed: Readonly<RuntimeDatabaseObservedIdentity> | null = null;
  let workOrderAuthority: Readonly<RuntimeDatabaseWorkOrderAuthorityBinding> | null = null;
  try {
    try {
      assertSessionBinding(prepared, adapter, session);
      if (sessionStatus(session) !== 'IDLE') return refuse('DATABASE_SESSION_NOT_FRESH');
    } catch (error) {
      ambiguous = true;
      throw error;
    }
    try {
      await query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      transactionOpen = true;
    } catch {
      ambiguous = true;
      return refuse('SNAPSHOT_BEGIN_AMBIGUOUS');
    }
    try {
      if (sessionStatus(session) !== 'IN_TRANSACTION') {
        return refuse('SNAPSHOT_BEGIN_AMBIGUOUS');
      }
    } catch (error) {
      ambiguous = true;
      throw error;
    }
    if (canonicalWorkOrderAuthority) {
      try {
        await query('SET LOCAL search_path = pg_catalog');
      } catch (error) {
        ambiguous = transactionQueryFailureIsAmbiguous(session);
        throw error;
      }
      try {
        await query(RUNTIME_DATABASE_WORK_ORDER_TARGET_LOCK_SQL);
      } catch {
        ambiguous = transactionQueryFailureIsAmbiguous(session);
        return refuse('WORK_ORDER_TARGET_LOCK_FAILED');
      }
      let report;
      try {
        const workOrderQuery: QueryFn = <Row = Record<string, unknown>>(
          sql: string,
          values?: unknown[]
        ) =>
          query<Row & Record<string, unknown>>(sql, values) as Promise<{
            rows: Row[];
            rowCount: number;
          }>;
        report = await verifyWorkOrderCommandAuthorityInCurrentSnapshot(
          workOrderQuery,
          workOrderRoleEnvironment(prepared.roleTopology),
          COMPONENT_VERIFIER_ROLE[prepared.component]
        );
      } catch {
        ambiguous = transactionQueryFailureIsAmbiguous(session);
        return refuse('ROLE_TOPOLOGY_VERIFICATION_FAILED');
      }
      if (report.status !== 'READY') return refuse('ROLE_TOPOLOGY_VERIFICATION_FAILED');
      try {
        await assertTransactionState(query);
      } catch (error) {
        ambiguous = transactionQueryFailureIsAmbiguous(session);
        throw error;
      }
      try {
        observed = await readLiveIdentity(query, prepared.target);
      } catch (error) {
        ambiguous = true;
        throw error;
      }
      try {
        workOrderAuthority = await readCanonicalWorkOrderAuthority(query, prepared, releaseProof);
      } catch (error) {
        ambiguous = transactionQueryFailureIsAmbiguous(session);
        throw error;
      }
    } else {
      const testVerifiers = verifiers as RuntimeDatabaseAuthorityVerifiers;
      try {
        await assertTransactionState(query);
      } catch (error) {
        ambiguous = true;
        throw error;
      }
      try {
        observed = await readLiveIdentity(query, prepared.target);
      } catch (error) {
        ambiguous = true;
        throw error;
      }
      const context = Object.freeze({
        component: prepared.component,
        roleTopology: prepared.roleTopology,
        expectedServiceLogin: prepared.target.serviceLogin,
        target: prepared.target,
        targetDigest: prepared.targetDigest,
        releaseManifestDigest: releaseProof.manifestDigest,
        observed,
      });
      await runVerifierPhase(
        session,
        testVerifiers.verifyEightRoleTopology,
        context,
        'ROLE_TOPOLOGY_VERIFICATION_FAILED'
      );
      try {
        if (sessionStatus(session) !== 'IN_TRANSACTION') {
          return refuse('TRANSACTION_STATE_MISMATCH');
        }
      } catch (error) {
        ambiguous = true;
        throw error;
      }
      try {
        await assertTransactionState(query);
      } catch (error) {
        ambiguous = true;
        throw error;
      }
      await runVerifierPhase(
        session,
        testVerifiers.verifyWorkOrderTargetTip,
        context,
        'WORK_ORDER_TARGET_TIP_VERIFICATION_FAILED'
      );
      workOrderAuthority = testOnlyWorkOrderAuthorityBinding(prepared, releaseProof);
    }
    try {
      if (sessionStatus(session) !== 'IN_TRANSACTION') {
        return refuse('TRANSACTION_STATE_MISMATCH');
      }
    } catch (error) {
      ambiguous = true;
      throw error;
    }
    try {
      await assertTransactionState(query);
    } catch (error) {
      ambiguous = true;
      throw error;
    }
    try {
      await query('COMMIT');
      transactionOpen = false;
    } catch {
      ambiguous = true;
      return refuse('SNAPSHOT_COMMIT_AMBIGUOUS');
    }
    try {
      if (sessionStatus(session) !== 'IDLE') {
        return refuse('SNAPSHOT_COMMIT_AMBIGUOUS');
      }
    } catch (error) {
      ambiguous = true;
      throw error;
    }
  } catch (error) {
    failure = authorityError(error, 'DATABASE_AUTHORITY_EVALUATION_FAILED');
  }

  if (failure) {
    throw await cleanupFailedSession(session, query, transactionOpen, ambiguous, failure);
  }
  if (!observed || !workOrderAuthority) {
    throw await cleanupFailedSession(
      session,
      query,
      transactionOpen,
      true,
      new RuntimeDatabaseAuthorityError('DATABASE_AUTHORITY_EVALUATION_FAILED')
    );
  }
  try {
    await session.release();
  } catch {
    const destroyFailure = await destroySession(session);
    throw destroyFailure ?? new RuntimeDatabaseAuthorityError('DATABASE_SESSION_RELEASE_FAILED');
  }
  // A pool fault or reconnect can invalidate the adapter while release awaits.
  // Rebind synchronously before issuing the capability; no event-loop turn may
  // separate this check from the WeakMap binding below.
  assertSessionBinding(prepared, adapter, session);

  const health = Object.freeze({
    component: prepared.component,
    environment: releaseProof.environment,
    authorityDigest: compositeAuthorityDigest(prepared, releaseProof, workOrderAuthority),
    databaseTargetDigest: prepared.targetDigest,
    roleTopologyDigest: prepared.roleTopologyDigest,
    manifestDigest: releaseProof.manifestDigest,
    revision: releaseProof.revision,
    artifactDigest: releaseProof.artifactDigest,
    workOrderTargetAuthorityId: workOrderAuthority.targetAuthorityId,
    workOrderTargetAuthorityVersion: workOrderAuthority.authorityVersion,
    workOrderTargetDigest: workOrderAuthority.bindingDigest,
    workOrderSealDigest: workOrderAuthority.sealSqlSha256,
    attestedAt: observed.attestedAt,
  });
  return issueCapability({
    adapter,
    adapterBinding: adapter.adapterBinding,
    poolBinding: adapter.poolBinding,
    adapterBindingDigest: adapter.adapterBindingDigest,
    poolBindingDigest: adapter.poolBindingDigest,
    sessionBinding: session.sessionBinding,
    sessionBindingDigest: session.sessionBindingDigest,
    connectionBindingDigest: session.connectionBindingDigest,
    targetDigest: prepared.targetDigest,
    workOrderAuthority,
    health,
  });
}

export async function attestRuntimeDatabaseAuthority(
  input: RuntimeDatabaseAuthorityInput,
  adapter: RuntimeDatabaseAuthorityAdapter,
  verifier: RuntimeDatabaseReleaseAuthorityVerifier
): Promise<RuntimeDatabaseAuthorityCapability> {
  return attestRuntimeDatabaseAuthorityKernel(input, adapter, verifier, true);
}

/**
 * Transport/error-path kernel for focused Vitest coverage only. Application
 * source must never import this function; production authority always invokes
 * the canonical Work Order catalog and target verifier above.
 */
export async function attestRuntimeDatabaseAuthorityKernelForTest(
  input: RuntimeDatabaseAuthorityInput,
  adapter: RuntimeDatabaseAuthorityAdapter,
  verifiers: RuntimeDatabaseAuthorityVerifiers
): Promise<RuntimeDatabaseAuthorityCapability> {
  if (process.env.NODE_ENV !== 'test' || process.env.VITEST !== 'true') {
    return refuse('TEST_ONLY_AUTHORITY_KERNEL_FORBIDDEN');
  }
  return attestRuntimeDatabaseAuthorityKernel(input, adapter, verifiers, false);
}
