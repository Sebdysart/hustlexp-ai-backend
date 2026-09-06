import { createHash } from 'node:crypto';

import {
  assertRuntimeDatabaseAuthorityCapabilityFor,
  RUNTIME_DATABASE_WORK_ORDER_AUTHORITY_SQL,
  RUNTIME_DATABASE_WORK_ORDER_AUTHORITY_ROW_KEYS,
  runtimeDatabaseConnectionBindingDigest,
  runtimeDatabaseTargetDigest,
  runtimeDatabaseWorkOrderAuthorityBinding,
  type RuntimeDatabaseAuthorityAdapter,
  type RuntimeDatabaseAuthorityCapability,
  type RuntimeDatabaseAuthorityHealth,
  type RuntimeDatabaseAuthoritySession,
  type RuntimeDatabaseTargetBinding,
  type RuntimeDatabaseTransactionStatus,
  type RuntimeDatabaseWorkOrderAuthorityBinding,
} from './runtime-database-authority.js';

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const ZERO_SHA256_DIGEST = /^sha256:0{64}$/u;

export const RUNTIME_DATABASE_DATA_PLANE_SEARCH_PATH_SQL =
  'SET LOCAL search_path=pg_catalog,public';
export const RUNTIME_DATABASE_DATA_PLANE_TARGET_BARRIER_LOCK_SQL =
  'LOCK TABLE public.hxos_universal_v1_work_order_target_activation_barrier_v1 IN ACCESS SHARE MODE';

const BEGIN_READ_WRITE = 'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE';
const BEGIN_READ_ONLY = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
const BEGIN_SERIALIZABLE = 'BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE';

type BeginStatement = typeof BEGIN_READ_WRITE | typeof BEGIN_READ_ONLY | typeof BEGIN_SERIALIZABLE;
type TransactionPhase =
  | 'ACQUIRED'
  | 'BEGIN_ATTEMPTED'
  | 'ACTIVE'
  | 'COMMIT_ATTEMPTED'
  | 'COMMITTED';

export type RuntimeDatabaseDataPlaneFailureCode =
  | 'OPTIONS_INVALID'
  | 'DATA_PLANE_INVALID'
  | 'DATA_PLANE_CLOSED'
  | 'AUTHORITY_CAPABILITY_INVALID'
  | 'TARGET_BINDING_MISMATCH'
  | 'REPLICA_DATABASE_CONFIGURED'
  | 'ADAPTER_STATE_INVALID'
  | 'APPLICATION_CALLBACK_INVALID'
  | 'APPLICATION_SQL_EMPTY'
  | 'APPLICATION_SQL_INVALID'
  | 'APPLICATION_SQL_MULTISTATEMENT_FORBIDDEN'
  | 'APPLICATION_SQL_TRANSACTION_CONTROL_FORBIDDEN'
  | 'APPLICATION_QUERY_CONCURRENT'
  | 'APPLICATION_QUERY_NOT_AWAITED'
  | 'DATABASE_SESSION_UNAVAILABLE'
  | 'DATABASE_SESSION_APPLICATION_QUERY_UNAVAILABLE'
  | 'DATABASE_SESSION_BINDING_MISMATCH'
  | 'DATABASE_SESSION_NOT_FRESH'
  | 'TRANSACTION_BEGIN_AMBIGUOUS'
  | 'TRANSACTION_STATUS_MISMATCH'
  | 'LIVE_TARGET_VERIFICATION_FAILED'
  | 'LIVE_TARGET_BLOCKED'
  | 'TRANSACTION_COMMIT_AMBIGUOUS'
  | 'DATABASE_SESSION_RELEASE_FAILED';

export class RuntimeDatabaseDataPlaneError extends Error {
  constructor(readonly code: RuntimeDatabaseDataPlaneFailureCode) {
    super(`RUNTIME_DATABASE_DATA_PLANE_REFUSED:${code}`);
    this.name = 'RuntimeDatabaseDataPlaneError';
  }
}

export interface RuntimeDatabaseDataPlaneQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: Row[];
  readonly rowCount: number;
}

export interface RuntimeDatabaseDataPlaneQuery {
  <Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[]
  ): Promise<RuntimeDatabaseDataPlaneQueryResult<Row>>;
}

export interface RuntimeDatabaseDataPlanePoolStats {
  readonly totalConnections: number;
  readonly idleConnections: number;
  readonly waitingRequests: number;
  readonly maxConnections: number;
  readonly utilizationPercent: number;
  readonly replicaConnections: null;
  readonly replicaIdle: null;
  readonly replicaConfigured: false;
}

/** The runtime adapter surface deliberately exposes no Pool or physical client. */
export interface RuntimeDatabaseDataPlaneAdapter extends RuntimeDatabaseAuthorityAdapter {
  stats(): RuntimeDatabaseDataPlanePoolStats;
  close(): Promise<void>;
}

export interface CreateRuntimeDatabaseDataPlaneOptions {
  readonly primaryDatabaseUrl: string;
  readonly replicaDatabaseUrl?: string | null;
  readonly target: Readonly<RuntimeDatabaseTargetBinding>;
  readonly adapter: RuntimeDatabaseDataPlaneAdapter;
  readonly capability: RuntimeDatabaseAuthorityCapability;
}

declare const RUNTIME_DATABASE_DATA_PLANE_BRAND: unique symbol;
export interface RuntimeDatabaseDataPlane {
  readonly [RUNTIME_DATABASE_DATA_PLANE_BRAND]: true;
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[]
  ): Promise<RuntimeDatabaseDataPlaneQueryResult<Row>>;
  readQuery<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[]
  ): Promise<RuntimeDatabaseDataPlaneQueryResult<Row>>;
  transaction<T>(callback: (query: RuntimeDatabaseDataPlaneQuery) => Promise<T>): Promise<T>;
  /**
   * For trusted, module-owned metadata SQL. Establishes fixed initial settings
   * and a database-enforced read-only snapshot; it is not an arbitrary-SQL sandbox.
   * Callbacks must not invoke set_config or other configuration-changing routines.
   */
  readOnlyAttestationTransaction<T>(
    callback: (query: RuntimeDatabaseDataPlaneQuery) => Promise<T>
  ): Promise<T>;
  serializableTransaction<T>(
    callback: (query: RuntimeDatabaseDataPlaneQuery) => Promise<T>
  ): Promise<T>;
  stats(): RuntimeDatabaseDataPlanePoolStats;
  close(): Promise<void>;
}

interface DataPlaneBinding {
  readonly primaryDatabaseUrl: string;
  readonly connectionBindingDigest: string;
  readonly target: Readonly<RuntimeDatabaseTargetBinding>;
  readonly targetDigest: string;
  readonly adapter: RuntimeDatabaseDataPlaneAdapter;
  readonly capability: RuntimeDatabaseAuthorityCapability;
  readonly authority: Readonly<RuntimeDatabaseAuthorityHealth>;
  readonly workOrderAuthority: Readonly<RuntimeDatabaseWorkOrderAuthorityBinding>;
  closed: boolean;
}

interface RuntimeDatabaseWorkOrderAuthorityRow extends Record<string, unknown> {
  readonly session_database_role: unknown;
  readonly target_authority_id: unknown;
  readonly authority_version: unknown;
  readonly target_database_name: unknown;
  readonly environment: unknown;
  readonly release_manifest_sha256: unknown;
  readonly ordinal146_sql_sha256: unknown;
  readonly v12_sql_sha256: unknown;
  readonly seal_sql_sha256: unknown;
  readonly v13_sql_sha256: unknown;
  readonly fake_financial_operations_relation: unknown;
  readonly fake_financial_operation_events_relation: unknown;
}

const planes = new WeakMap<object, DataPlaneBinding>();

function refuse(code: RuntimeDatabaseDataPlaneFailureCode): never {
  throw new RuntimeDatabaseDataPlaneError(code);
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
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
  const stringKeys = keys as readonly string[];
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => stringKeys.includes(key)) &&
    stringKeys.length <= allowed.size &&
    stringKeys.every((key) => allowed.has(key))
  );
}

function nonzeroDigest(value: string): boolean {
  return SHA256_DIGEST.test(value) && !ZERO_SHA256_DIGEST.test(value);
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
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

function sameWorkOrderAuthorityBinding(
  left: Readonly<RuntimeDatabaseWorkOrderAuthorityBinding>,
  right: Readonly<RuntimeDatabaseWorkOrderAuthorityBinding>
): boolean {
  return (
    left.sessionDatabaseRole === right.sessionDatabaseRole &&
    left.targetAuthorityId === right.targetAuthorityId &&
    left.authorityVersion === right.authorityVersion &&
    left.targetDatabaseName === right.targetDatabaseName &&
    left.environment === right.environment &&
    left.releaseManifestSha256 === right.releaseManifestSha256 &&
    left.ordinal146SqlSha256 === right.ordinal146SqlSha256 &&
    left.v12SqlSha256 === right.v12SqlSha256 &&
    left.sealSqlSha256 === right.sealSqlSha256 &&
    left.v13SqlSha256 === right.v13SqlSha256 &&
    left.fakeFinancialOperationsRelation === right.fakeFinancialOperationsRelation &&
    left.fakeFinancialOperationEventsRelation === right.fakeFinancialOperationEventsRelation &&
    left.bindingDigest === right.bindingDigest
  );
}

function validWorkOrderAuthorityBinding(
  value: Readonly<RuntimeDatabaseWorkOrderAuthorityBinding>
): boolean {
  const withoutDigest = {
    sessionDatabaseRole: value.sessionDatabaseRole,
    targetAuthorityId: value.targetAuthorityId,
    authorityVersion: value.authorityVersion,
    targetDatabaseName: value.targetDatabaseName,
    environment: value.environment,
    releaseManifestSha256: value.releaseManifestSha256,
    ordinal146SqlSha256: value.ordinal146SqlSha256,
    v12SqlSha256: value.v12SqlSha256,
    sealSqlSha256: value.sealSqlSha256,
    v13SqlSha256: value.v13SqlSha256,
    fakeFinancialOperationsRelation: value.fakeFinancialOperationsRelation,
    fakeFinancialOperationEventsRelation: value.fakeFinancialOperationEventsRelation,
  };
  return (
    nonzeroDigest(value.bindingDigest) &&
    workOrderAuthorityBindingDigest(withoutDigest) === value.bindingDigest
  );
}

function snapshotTarget(value: unknown): Readonly<RuntimeDatabaseTargetBinding> {
  const keys = [
    'component',
    'environment',
    'databaseName',
    'hostname',
    'port',
    'serverAddress',
    'tlsMode',
    'channelBinding',
    'serviceLogin',
    'roleTopologyDigest',
  ] as const;
  if (!isObject(value) || !exactOwnKeys(value, keys)) return refuse('TARGET_BINDING_MISMATCH');
  const input = value as RuntimeDatabaseTargetBinding;
  const target = Object.freeze({
    component: input.component,
    environment: input.environment,
    databaseName: input.databaseName,
    hostname: input.hostname,
    port: input.port,
    serverAddress: input.serverAddress,
    tlsMode: input.tlsMode,
    channelBinding: input.channelBinding,
    serviceLogin: input.serviceLogin,
    roleTopologyDigest: input.roleTopologyDigest,
  });
  try {
    runtimeDatabaseTargetDigest(target);
  } catch {
    return refuse('TARGET_BINDING_MISMATCH');
  }
  return target;
}

function snapshotStats(
  adapter: RuntimeDatabaseDataPlaneAdapter
): RuntimeDatabaseDataPlanePoolStats {
  let value: RuntimeDatabaseDataPlanePoolStats;
  try {
    value = adapter.stats();
  } catch {
    return refuse('ADAPTER_STATE_INVALID');
  }
  if (!isObject(value)) return refuse('ADAPTER_STATE_INVALID');
  const numericKeys = [
    'totalConnections',
    'idleConnections',
    'waitingRequests',
    'maxConnections',
    'utilizationPercent',
  ] as const;
  if (
    !exactOwnKeys(value, [
      ...numericKeys,
      'replicaConnections',
      'replicaIdle',
      'replicaConfigured',
    ]) ||
    numericKeys.some((key) => !Number.isInteger(value[key]) || value[key] < 0) ||
    value.maxConnections < 1 ||
    value.totalConnections > value.maxConnections ||
    value.idleConnections > value.totalConnections ||
    value.utilizationPercent !==
      Math.round((value.totalConnections / value.maxConnections) * 100) ||
    value.replicaConnections !== null ||
    value.replicaIdle !== null ||
    value.replicaConfigured !== false
  ) {
    if (
      value.replicaConnections !== null ||
      value.replicaIdle !== null ||
      value.replicaConfigured !== false
    ) {
      return refuse('REPLICA_DATABASE_CONFIGURED');
    }
    return refuse('ADAPTER_STATE_INVALID');
  }
  return Object.freeze({
    totalConnections: value.totalConnections,
    idleConnections: value.idleConnections,
    waitingRequests: value.waitingRequests,
    maxConnections: value.maxConnections,
    utilizationPercent: value.utilizationPercent,
    replicaConnections: null,
    replicaIdle: null,
    replicaConfigured: false,
  });
}

function assertAuthorityBinding(binding: DataPlaneBinding): void {
  if (binding.closed) return refuse('DATA_PLANE_CLOSED');
  let health: RuntimeDatabaseAuthorityHealth;
  let workOrderAuthority: RuntimeDatabaseWorkOrderAuthorityBinding;
  try {
    health = assertRuntimeDatabaseAuthorityCapabilityFor(binding.capability, binding.adapter);
    workOrderAuthority = runtimeDatabaseWorkOrderAuthorityBinding(
      binding.capability,
      binding.adapter
    );
  } catch {
    return refuse('AUTHORITY_CAPABILITY_INVALID');
  }
  if (
    health !== binding.authority ||
    health.databaseTargetDigest !== binding.targetDigest ||
    health.component !== binding.target.component ||
    health.environment !== binding.target.environment ||
    health.roleTopologyDigest !== binding.target.roleTopologyDigest ||
    !sameWorkOrderAuthorityBinding(workOrderAuthority, binding.workOrderAuthority) ||
    !validWorkOrderAuthorityBinding(workOrderAuthority) ||
    health.workOrderTargetAuthorityId !== workOrderAuthority.targetAuthorityId ||
    health.workOrderTargetAuthorityVersion !== workOrderAuthority.authorityVersion ||
    health.workOrderTargetDigest !== workOrderAuthority.bindingDigest ||
    health.workOrderSealDigest !== workOrderAuthority.sealSqlSha256 ||
    runtimeDatabaseTargetDigest(binding.target) !== binding.targetDigest ||
    runtimeDatabaseConnectionBindingDigest(binding.primaryDatabaseUrl) !==
      binding.connectionBindingDigest
  ) {
    return refuse('TARGET_BINDING_MISMATCH');
  }
}

function bindingFor(value: unknown): DataPlaneBinding {
  if (!isObject(value)) return refuse('DATA_PLANE_INVALID');
  const binding = planes.get(value);
  if (!binding) return refuse('DATA_PLANE_INVALID');
  if (binding.closed) return refuse('DATA_PLANE_CLOSED');
  assertAuthorityBinding(binding);
  snapshotStats(binding.adapter);
  return binding;
}

function closingBindingFor(value: unknown): DataPlaneBinding {
  if (!isObject(value)) return refuse('DATA_PLANE_INVALID');
  const binding = planes.get(value);
  if (!binding) return refuse('DATA_PLANE_INVALID');
  if (binding.closed) return refuse('DATA_PLANE_CLOSED');
  return binding;
}

function sessionStatus(session: RuntimeDatabaseAuthoritySession): RuntimeDatabaseTransactionStatus {
  try {
    return session.transactionStatus();
  } catch {
    return 'UNKNOWN';
  }
}

interface RuntimeDatabaseApplicationSession extends RuntimeDatabaseAuthoritySession {
  applicationQuery: NonNullable<RuntimeDatabaseAuthoritySession['applicationQuery']>;
}

function assertSessionBinding(
  binding: DataPlaneBinding,
  session: RuntimeDatabaseAuthoritySession
): asserts session is RuntimeDatabaseApplicationSession {
  if (typeof session.applicationQuery !== 'function') {
    return refuse('DATABASE_SESSION_APPLICATION_QUERY_UNAVAILABLE');
  }
  const adapter = binding.adapter;
  if (
    !isObject(session.adapterBinding) ||
    !isObject(session.poolBinding) ||
    !isObject(session.sessionBinding) ||
    session.adapterBinding !== adapter.adapterBinding ||
    session.poolBinding !== adapter.poolBinding ||
    session.adapterBindingDigest !== adapter.adapterBindingDigest ||
    session.poolBindingDigest !== adapter.poolBindingDigest ||
    !nonzeroDigest(session.sessionBindingDigest) ||
    session.connectionBindingDigest !== binding.connectionBindingDigest ||
    session.targetDigest !== binding.targetDigest
  ) {
    return refuse('DATABASE_SESSION_BINDING_MISMATCH');
  }
}

interface SqlScan {
  readonly masked: string;
  readonly semicolons: readonly number[];
}

function scanApplicationSql(sql: string): SqlScan | null {
  let masked = '';
  const semicolons: number[] = [];
  let index = 0;
  const blank = (count: number): void => {
    masked += ' '.repeat(count);
  };
  while (index < sql.length) {
    const character = sql[index]!;
    const next = sql[index + 1];
    if (character === "'") {
      const start = index++;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") {
            index += 2;
            continue;
          }
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) return null;
      blank(index - start);
      continue;
    }
    if (character === '"') {
      const start = index++;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === '"') {
          if (sql[index + 1] === '"') {
            index += 2;
            continue;
          }
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) return null;
      blank(index - start);
      continue;
    }
    if (character === '-' && next === '-') {
      const start = index;
      index += 2;
      while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') index += 1;
      blank(index - start);
      continue;
    }
    if (character === '/' && next === '*') {
      const start = index;
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql[index] === '/' && sql[index + 1] === '*') {
          depth += 1;
          index += 2;
        } else if (sql[index] === '*' && sql[index + 1] === '/') {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      if (depth !== 0) return null;
      blank(index - start);
      continue;
    }
    // PostgreSQL permits dollar signs inside unquoted identifiers. A quote
    // opener must start a new token; otherwise masking it can hide COMMIT.
    // Conservatively include all non-ASCII code units in identifier continuations.
    if (
      character === '$' &&
      (index === 0 || !/[A-Za-z0-9_$\u0080-\uFFFF]/u.test(sql[index - 1]!))
    ) {
      const delimiter = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(sql.slice(index))?.[0];
      if (delimiter) {
        const start = index;
        index += delimiter.length;
        const end = sql.indexOf(delimiter, index);
        if (end < 0) return null;
        index = end + delimiter.length;
        blank(index - start);
        continue;
      }
    }
    if (character === ';') semicolons.push(index);
    masked += character;
    index += 1;
  }
  return { masked, semicolons };
}

type ApplicationStatementKind =
  | 'REGULAR'
  | 'SAVEPOINT'
  | 'ROLLBACK_TO_SAVEPOINT'
  | 'RELEASE_SAVEPOINT';

function assertApplicationSql(value: unknown, allowSavepoints: boolean): ApplicationStatementKind {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return refuse('APPLICATION_SQL_EMPTY');
  }
  const scan = scanApplicationSql(value);
  if (!scan) return refuse('APPLICATION_SQL_INVALID');
  if (scan.semicolons.length > 1) return refuse('APPLICATION_SQL_MULTISTATEMENT_FORBIDDEN');
  let statement = scan.masked;
  if (scan.semicolons.length === 1) {
    const semicolon = scan.semicolons[0]!;
    if (scan.masked.slice(semicolon + 1).trim().length > 0) {
      return refuse('APPLICATION_SQL_MULTISTATEMENT_FORBIDDEN');
    }
    statement = scan.masked.slice(0, semicolon);
  }
  const normalized = statement.trim().replace(/\s+/gu, ' ').toUpperCase();
  if (!normalized) return refuse('APPLICATION_SQL_EMPTY');
  const savepointKind = /^SAVEPOINT [A-Z_][A-Z0-9_]{0,62}$/u.test(normalized)
    ? 'SAVEPOINT'
    : /^ROLLBACK TO SAVEPOINT [A-Z_][A-Z0-9_]{0,62}$/u.test(normalized)
      ? 'ROLLBACK_TO_SAVEPOINT'
      : /^RELEASE SAVEPOINT [A-Z_][A-Z0-9_]{0,62}$/u.test(normalized)
        ? 'RELEASE_SAVEPOINT'
        : null;
  if (savepointKind) {
    if (!allowSavepoints) return refuse('APPLICATION_SQL_TRANSACTION_CONTROL_FORBIDDEN');
    return savepointKind;
  }
  if (
    /^(?:BEGIN|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|SET|RESET|DISCARD|DEALLOCATE)(?:\s|$)/u.test(
      normalized
    ) ||
    /^(?:START|PREPARE)\s+TRANSACTION(?:\s|$)/u.test(normalized) ||
    /^RELEASE\s+SAVEPOINT(?:\s|$)/u.test(normalized) ||
    /^SET\s+(?:(?:LOCAL|SESSION)\s+)?TRANSACTION(?:\s|$)/u.test(normalized)
  ) {
    return refuse('APPLICATION_SQL_TRANSACTION_CONTROL_FORBIDDEN');
  }
  return 'REGULAR';
}

async function safeDestroy(session: RuntimeDatabaseAuthoritySession): Promise<void> {
  try {
    await session.destroy();
  } catch {
    // Cleanup evidence is intentionally unable to replace the operation error.
  }
}

async function releaseAfterIdle(
  session: RuntimeDatabaseAuthoritySession,
  failure?: { readonly error: unknown }
): Promise<void> {
  if (sessionStatus(session) !== 'IDLE') {
    await safeDestroy(session);
    if (failure) throw failure.error;
    return refuse('DATABASE_SESSION_RELEASE_FAILED');
  }
  try {
    await session.release();
  } catch {
    await safeDestroy(session);
    if (failure) throw failure.error;
    return refuse('DATABASE_SESSION_RELEASE_FAILED');
  }
  if (failure) throw failure.error;
}

async function cleanupFailure(
  session: RuntimeDatabaseAuthoritySession,
  phase: TransactionPhase,
  operationError: unknown
): Promise<never> {
  if (phase !== 'ACTIVE') {
    await safeDestroy(session);
    throw operationError;
  }
  const status = sessionStatus(session);
  if (status !== 'IN_TRANSACTION' && status !== 'FAILED_TRANSACTION') {
    await safeDestroy(session);
    throw operationError;
  }
  try {
    await session.query('ROLLBACK');
  } catch {
    await safeDestroy(session);
    throw operationError;
  }
  if (sessionStatus(session) !== 'IDLE') {
    await safeDestroy(session);
    throw operationError;
  }
  await releaseAfterIdle(session, { error: operationError });
  throw operationError;
}

interface GuardedQueryController {
  readonly query: RuntimeDatabaseDataPlaneQuery;
  drain(): Promise<void>;
  settleUnawaited(): Promise<void>;
  deactivate(): void;
}

function guardedApplicationQuery(
  plane: RuntimeDatabaseDataPlane,
  session: RuntimeDatabaseApplicationSession,
  allowSavepoints: boolean
): GuardedQueryController {
  let active = true;
  let inFlight: Promise<void> | null = null;
  const query: RuntimeDatabaseDataPlaneQuery = async <
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(
    sql: string,
    values?: readonly unknown[]
  ): Promise<RuntimeDatabaseDataPlaneQueryResult<Row>> => {
    if (!active) return refuse('TRANSACTION_STATUS_MISMATCH');
    if (inFlight) return refuse('APPLICATION_QUERY_CONCURRENT');
    const statementKind = assertApplicationSql(sql, allowSavepoints);
    bindingFor(plane);
    const beforeStatus = sessionStatus(session);
    if (
      beforeStatus !== 'IN_TRANSACTION' &&
      !(statementKind === 'ROLLBACK_TO_SAVEPOINT' && beforeStatus === 'FAILED_TRANSACTION')
    ) {
      return refuse('TRANSACTION_STATUS_MISMATCH');
    }
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => {
      settle = resolve;
    });
    inFlight = pending;
    try {
      const result = await session.applicationQuery<Row>(sql, values);
      if (
        !Array.isArray(result.rows) ||
        !Number.isInteger(result.rowCount) ||
        result.rowCount < 0
      ) {
        return refuse('TRANSACTION_STATUS_MISMATCH');
      }
      if (sessionStatus(session) !== 'IN_TRANSACTION') {
        return refuse('TRANSACTION_STATUS_MISMATCH');
      }
      return { rows: result.rows, rowCount: result.rowCount };
    } finally {
      inFlight = null;
      settle();
    }
  };
  return {
    query,
    async drain(): Promise<void> {
      await inFlight;
    },
    async settleUnawaited(): Promise<void> {
      const pending = inFlight;
      if (!pending) return;
      await pending;
      return refuse('APPLICATION_QUERY_NOT_AWAITED');
    },
    deactivate(): void {
      active = false;
    },
  };
}

async function internalQuery(
  plane: RuntimeDatabaseDataPlane,
  session: RuntimeDatabaseAuthoritySession,
  sql: string
): Promise<void> {
  bindingFor(plane);
  await session.query(sql);
  if (sessionStatus(session) !== 'IN_TRANSACTION') {
    return refuse('TRANSACTION_STATUS_MISMATCH');
  }
}

async function verifyLiveWorkOrderAuthority(
  plane: RuntimeDatabaseDataPlane,
  binding: DataPlaneBinding,
  session: RuntimeDatabaseAuthoritySession
): Promise<void> {
  let result: RuntimeDatabaseDataPlaneQueryResult<RuntimeDatabaseWorkOrderAuthorityRow>;
  try {
    bindingFor(plane);
    result = await session.query<RuntimeDatabaseWorkOrderAuthorityRow>(
      RUNTIME_DATABASE_WORK_ORDER_AUTHORITY_SQL
    );
  } catch {
    return refuse('LIVE_TARGET_VERIFICATION_FAILED');
  }
  if (sessionStatus(session) !== 'IN_TRANSACTION') {
    return refuse('TRANSACTION_STATUS_MISMATCH');
  }
  if (
    !isObject(result) ||
    !Array.isArray(result.rows) ||
    result.rowCount !== 1 ||
    result.rows.length !== 1 ||
    !isObject(result.rows[0])
  ) {
    return refuse('LIVE_TARGET_BLOCKED');
  }
  const row = result.rows[0]!;
  const expected = binding.workOrderAuthority;
  if (
    !exactOwnKeys(row, RUNTIME_DATABASE_WORK_ORDER_AUTHORITY_ROW_KEYS) ||
    row.session_database_role !== expected.sessionDatabaseRole ||
    row.target_authority_id !== expected.targetAuthorityId ||
    typeof row.authority_version !== 'number' ||
    !Number.isSafeInteger(row.authority_version) ||
    row.authority_version !== expected.authorityVersion ||
    row.target_database_name !== expected.targetDatabaseName ||
    row.environment !== expected.environment ||
    row.release_manifest_sha256 !== expected.releaseManifestSha256 ||
    row.ordinal146_sql_sha256 !== expected.ordinal146SqlSha256 ||
    row.v12_sql_sha256 !== expected.v12SqlSha256 ||
    row.seal_sql_sha256 !== expected.sealSqlSha256 ||
    row.v13_sql_sha256 !== expected.v13SqlSha256 ||
    row.fake_financial_operations_relation !== expected.fakeFinancialOperationsRelation ||
    row.fake_financial_operation_events_relation !==
      expected.fakeFinancialOperationEventsRelation ||
    !validWorkOrderAuthorityBinding(expected)
  ) {
    return refuse('LIVE_TARGET_BLOCKED');
  }
}

async function executeInTransaction<T>(
  plane: RuntimeDatabaseDataPlane,
  beginStatement: BeginStatement,
  allowSavepoints: boolean,
  callback: (query: RuntimeDatabaseDataPlaneQuery) => Promise<T>,
  profile: 'application' | 'attestation' = 'application'
): Promise<T> {
  const binding = bindingFor(plane);
  let session: RuntimeDatabaseAuthoritySession;
  try {
    session = await binding.adapter.connect(
      binding.primaryDatabaseUrl,
      binding.target,
      binding.connectionBindingDigest
    );
  } catch {
    return refuse('DATABASE_SESSION_UNAVAILABLE');
  }

  let phase: TransactionPhase = 'ACQUIRED';
  let controller: GuardedQueryController | null = null;
  let result!: T;
  try {
    assertAuthorityBinding(binding);
    assertSessionBinding(binding, session);
    if (sessionStatus(session) !== 'IDLE') return refuse('DATABASE_SESSION_NOT_FRESH');

    phase = 'BEGIN_ATTEMPTED';
    try {
      await session.query(beginStatement);
    } catch {
      return refuse('TRANSACTION_BEGIN_AMBIGUOUS');
    }
    if (sessionStatus(session) !== 'IN_TRANSACTION') {
      return refuse('TRANSACTION_BEGIN_AMBIGUOUS');
    }
    phase = 'ACTIVE';

    if (profile === 'attestation') {
      for (const statement of [
        'SET LOCAL search_path=pg_catalog',
        "SET LOCAL statement_timeout='1000ms'",
        "SET LOCAL lock_timeout='250ms'",
      ])
        await internalQuery(plane, session, statement);
    } else {
      await internalQuery(plane, session, RUNTIME_DATABASE_DATA_PLANE_SEARCH_PATH_SQL);
    }
    await internalQuery(plane, session, RUNTIME_DATABASE_DATA_PLANE_TARGET_BARRIER_LOCK_SQL);
    await verifyLiveWorkOrderAuthority(plane, binding, session);
    controller = guardedApplicationQuery(plane, session, allowSavepoints);
    if (sessionStatus(session) !== 'IN_TRANSACTION') {
      return refuse('TRANSACTION_STATUS_MISMATCH');
    }

    result = await callback(controller.query);
    await controller.settleUnawaited();
    controller.deactivate();
    if (sessionStatus(session) !== 'IN_TRANSACTION') {
      return refuse('TRANSACTION_STATUS_MISMATCH');
    }
    assertAuthorityBinding(binding);

    phase = 'COMMIT_ATTEMPTED';
    try {
      await session.query('COMMIT');
    } catch {
      return refuse('TRANSACTION_COMMIT_AMBIGUOUS');
    }
    if (sessionStatus(session) !== 'IDLE') {
      return refuse('TRANSACTION_COMMIT_AMBIGUOUS');
    }
    phase = 'COMMITTED';
  } catch (error) {
    controller?.deactivate();
    await controller?.drain();
    return cleanupFailure(session, phase, error);
  }
  await releaseAfterIdle(session);
  return result;
}

const dataPlanePrototype = Object.freeze({
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    this: RuntimeDatabaseDataPlane,
    sql: string,
    values?: readonly unknown[]
  ): Promise<RuntimeDatabaseDataPlaneQueryResult<Row>> {
    bindingFor(this);
    assertApplicationSql(sql, false);
    return executeInTransaction(this, BEGIN_READ_WRITE, false, (query) => query<Row>(sql, values));
  },
  async readQuery<Row extends Record<string, unknown> = Record<string, unknown>>(
    this: RuntimeDatabaseDataPlane,
    sql: string,
    values?: readonly unknown[]
  ): Promise<RuntimeDatabaseDataPlaneQueryResult<Row>> {
    bindingFor(this);
    assertApplicationSql(sql, false);
    return executeInTransaction(this, BEGIN_READ_ONLY, false, (query) => query<Row>(sql, values));
  },
  async transaction<T>(
    this: RuntimeDatabaseDataPlane,
    callback: (query: RuntimeDatabaseDataPlaneQuery) => Promise<T>
  ): Promise<T> {
    bindingFor(this);
    if (typeof callback !== 'function') return refuse('APPLICATION_CALLBACK_INVALID');
    return executeInTransaction(this, BEGIN_READ_WRITE, true, callback);
  },
  async serializableTransaction<T>(
    this: RuntimeDatabaseDataPlane,
    callback: (query: RuntimeDatabaseDataPlaneQuery) => Promise<T>
  ): Promise<T> {
    bindingFor(this);
    if (typeof callback !== 'function') return refuse('APPLICATION_CALLBACK_INVALID');
    return executeInTransaction(this, BEGIN_SERIALIZABLE, true, callback);
  },
  async readOnlyAttestationTransaction<T>(
    this: RuntimeDatabaseDataPlane,
    callback: (query: RuntimeDatabaseDataPlaneQuery) => Promise<T>
  ): Promise<T> {
    bindingFor(this);
    if (typeof callback !== 'function') return refuse('APPLICATION_CALLBACK_INVALID');
    return executeInTransaction(this, BEGIN_READ_ONLY, false, callback, 'attestation');
  },
  stats(this: RuntimeDatabaseDataPlane): RuntimeDatabaseDataPlanePoolStats {
    const binding = bindingFor(this);
    return snapshotStats(binding.adapter);
  },
  async close(this: RuntimeDatabaseDataPlane): Promise<void> {
    // Cleanup authority is the unforgeable plane identity itself. A revoked
    // adapter epoch or malformed stats must never make its pool uncloseable.
    const binding = closingBindingFor(this);
    binding.closed = true;
    await binding.adapter.close();
  },
});

export function createRuntimeDatabaseDataPlane(
  options: CreateRuntimeDatabaseDataPlaneOptions
): RuntimeDatabaseDataPlane {
  const requiredKeys = ['primaryDatabaseUrl', 'target', 'adapter', 'capability'] as const;
  if (!isObject(options) || !exactOwnKeys(options, requiredKeys, ['replicaDatabaseUrl'])) {
    return refuse('OPTIONS_INVALID');
  }
  const primaryDatabaseUrl = options.primaryDatabaseUrl;
  const replicaDatabaseUrl = options.replicaDatabaseUrl;
  const adapter = options.adapter;
  const capability = options.capability;
  if (
    typeof primaryDatabaseUrl !== 'string' ||
    primaryDatabaseUrl.length === 0 ||
    !isObject(adapter) ||
    typeof adapter.connect !== 'function' ||
    typeof adapter.stats !== 'function' ||
    typeof adapter.close !== 'function' ||
    !isObject(capability)
  ) {
    return refuse('OPTIONS_INVALID');
  }
  if (
    (typeof replicaDatabaseUrl === 'string' && replicaDatabaseUrl.trim().length > 0) ||
    (replicaDatabaseUrl !== undefined &&
      replicaDatabaseUrl !== null &&
      typeof replicaDatabaseUrl !== 'string')
  ) {
    return refuse('REPLICA_DATABASE_CONFIGURED');
  }

  const target = snapshotTarget(options.target);
  const targetDigest = runtimeDatabaseTargetDigest(target);
  const connectionBindingDigest = runtimeDatabaseConnectionBindingDigest(primaryDatabaseUrl);
  let authority: RuntimeDatabaseAuthorityHealth;
  let workOrderAuthority: RuntimeDatabaseWorkOrderAuthorityBinding;
  try {
    authority = assertRuntimeDatabaseAuthorityCapabilityFor(capability, adapter);
    workOrderAuthority = runtimeDatabaseWorkOrderAuthorityBinding(capability, adapter);
  } catch {
    return refuse('AUTHORITY_CAPABILITY_INVALID');
  }
  if (
    authority.databaseTargetDigest !== targetDigest ||
    authority.component !== target.component ||
    authority.environment !== target.environment ||
    authority.roleTopologyDigest !== target.roleTopologyDigest ||
    !validWorkOrderAuthorityBinding(workOrderAuthority) ||
    workOrderAuthority.sessionDatabaseRole !== target.serviceLogin ||
    workOrderAuthority.targetDatabaseName !== target.databaseName ||
    workOrderAuthority.environment !== target.environment ||
    authority.workOrderTargetAuthorityId !== workOrderAuthority.targetAuthorityId ||
    authority.workOrderTargetAuthorityVersion !== workOrderAuthority.authorityVersion ||
    authority.workOrderTargetDigest !== workOrderAuthority.bindingDigest ||
    authority.workOrderSealDigest !== workOrderAuthority.sealSqlSha256
  ) {
    return refuse('TARGET_BINDING_MISMATCH');
  }
  snapshotStats(adapter);

  const binding: DataPlaneBinding = {
    primaryDatabaseUrl,
    connectionBindingDigest,
    target,
    targetDigest,
    adapter,
    capability,
    authority,
    workOrderAuthority,
    closed: false,
  };
  const plane = Object.create(dataPlanePrototype) as RuntimeDatabaseDataPlane;
  planes.set(plane as object, binding);
  return Object.freeze(plane);
}

/**
 * Prove that a value is the exact still-live data plane issued by this module.
 *
 * The global application database facade uses this receipt before accepting a
 * runtime installation. A structurally similar object cannot pass because the
 * binding is held only in this module's WeakMap. Reading the receipt also
 * revalidates the adapter epoch, target binding, Work Order seal, and exact pool
 * statistics.
 */
export function runtimeDatabaseDataPlaneAuthorityHealth(
  plane: RuntimeDatabaseDataPlane
): Readonly<RuntimeDatabaseAuthorityHealth> {
  return bindingFor(plane).authority;
}
