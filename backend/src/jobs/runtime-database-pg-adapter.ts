import { createHash, randomBytes } from 'node:crypto';
import { checkServerIdentity, type PeerCertificate } from 'node:tls';

import pg, { type PoolClient } from 'pg';

import {
  runtimeDatabaseConnectionBindingDigest,
  runtimeDatabaseTargetDigest,
  type RuntimeDatabaseAuthorityAdapter,
  type RuntimeDatabaseAuthoritySession,
  type RuntimeDatabaseTargetBinding,
  type RuntimeDatabaseTransactionStatus,
} from './runtime-database-authority.js';

const { Pool } = pg;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const ZERO_SHA256_DIGEST = /^sha256:0{64}$/u;
const POSTGRES_PROTOCOLS = new Set(['postgres:', 'postgresql:']);
const RUNTIME_DATABASE_PG_APPLICATION_NAME = 'hustlexp-runtime-database-authority';
const RUNTIME_DATABASE_PG_SEARCH_PATH = 'pg_catalog';

export const RUNTIME_DATABASE_PG_STATUS_PROBE_SQL =
  'SELECT pg_catalog.current_database()::text AS database_name';
export const RUNTIME_DATABASE_PG_PHYSICAL_IDENTITY_SQL = `SELECT current_database()::text AS database_name,
       CURRENT_USER::text AS current_user,
       SESSION_USER::text AS session_user,
       COALESCE(pg_catalog.host(pg_catalog.inet_server_addr()), 'local_socket') AS server_address,
       COALESCE(pg_catalog.inet_server_port(), 0)::integer AS server_port,
       pg_catalog.current_setting('search_path')::text AS search_path,
       pg_catalog.current_setting('client_encoding')::text AS client_encoding,
       pg_catalog.current_setting('application_name')::text AS application_name,
       COALESCE((
         SELECT ssl_state.ssl
           FROM pg_catalog.pg_stat_ssl ssl_state
          WHERE ssl_state.pid = pg_catalog.pg_backend_pid()
       ), false) AS tls_active`;

const authenticationMechanisms = new WeakMap<object, string>();

class RuntimeDatabaseAuditedPgClient extends pg.Client {
  _handleAuthSASL(message: unknown): void {
    const baseHandler = (
      pg.Client.prototype as unknown as {
        _handleAuthSASL?: (this: pg.Client, message: unknown) => void;
      }
    )._handleAuthSASL;
    if (typeof baseHandler !== 'function') {
      throw new Error('RUNTIME_DATABASE_PG_SASL_AUDIT_UNAVAILABLE');
    }
    baseHandler.call(this, message);
    const mechanism = (this as unknown as { saslSession?: { mechanism?: unknown } | null })
      .saslSession?.mechanism;
    if (typeof mechanism === 'string') authenticationMechanisms.set(this, mechanism);
  }
}

interface ReadyForQueryMessage {
  readonly status: string;
}

interface PgProtocolConnection {
  on(event: 'readyForQuery', listener: (message: ReadyForQueryMessage) => void): void;
  removeListener(event: 'readyForQuery', listener: (message: ReadyForQueryMessage) => void): void;
  readonly stream?: PgTlsStream;
}

interface PgTlsStream {
  readonly encrypted?: unknown;
  readonly authorized?: unknown;
  readonly authorizationError?: unknown;
  getPeerCertificate?(detailed?: boolean): PeerCertificate;
}

interface PgPoolWithForceRemove {
  _remove(client: PoolClient, callback?: () => void): void;
  _pulseQueue(): void;
}

function assertPgRuntimePrivateContract(): void {
  const clientPrototype = pg.Client.prototype as unknown as {
    readonly _handleAuthSASL?: unknown;
  };
  const poolPrototype = Pool.prototype as unknown as {
    readonly _remove?: unknown;
    readonly _pulseQueue?: unknown;
  };
  if (
    typeof clientPrototype._handleAuthSASL !== 'function' ||
    typeof poolPrototype._remove !== 'function' ||
    typeof poolPrototype._pulseQueue !== 'function'
  ) {
    throw new Error('RUNTIME_DATABASE_PG_PRIVATE_CONTRACT_UNAVAILABLE');
  }
}

async function forceRemovePoolClient(
  pool: PgPoolWithForceRemove,
  client: PoolClient
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const settleAfterPulse = (): void => {
      try {
        pool._pulseQueue();
        resolve();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    try {
      // pg-pool@3.10.1's private _remove primitive deliberately does not
      // service pending checkouts or an in-progress pool.end(). Its own
      // destruction paths always supply _pulseQueue as the completion
      // callback. Keep that exact invariant here so a maxed pool and a
      // concurrently closing pool cannot deadlock after forced destruction.
      pool._remove(client, settleAfterPulse);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export interface PgRuntimeDatabasePoolTuning {
  readonly max?: number;
  readonly min?: number;
  readonly idleTimeoutMillis?: number | null;
  readonly connectionTimeoutMillis?: number;
  readonly statementTimeoutMillis?: number;
  readonly lockTimeoutMillis?: number;
  readonly idleInTransactionSessionTimeoutMillis?: number;
  readonly maxUses?: number;
  readonly maxLifetimeSeconds?: number;
  readonly allowExitOnIdle?: boolean;
}

export interface PgRuntimeDatabaseAuthorityAdapterOptions {
  readonly primaryDatabaseUrl: string;
  readonly target: Readonly<RuntimeDatabaseTargetBinding>;
  readonly poolConfig?: PgRuntimeDatabasePoolTuning;
}

export interface PgRuntimeDatabaseAuthorityAdapter extends RuntimeDatabaseAuthorityAdapter {
  stats(): {
    readonly totalConnections: number;
    readonly idleConnections: number;
    readonly waitingRequests: number;
    readonly maxConnections: number;
    readonly utilizationPercent: number;
    readonly replicaConnections: null;
    readonly replicaIdle: null;
    readonly replicaConfigured: false;
  };
  close(): Promise<void>;
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function nonceDigest(domain: string): string {
  const nonce = randomBytes(32).toString('hex');
  return sha256(`${domain}\n${nonce}`);
}

function nonzeroDigest(value: string): boolean {
  return SHA256_DIGEST.test(value) && !ZERO_SHA256_DIGEST.test(value);
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

function optionalNonnegativeInteger(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && Number(value) >= 0);
}

function exactPoolTuning(
  input: PgRuntimeDatabasePoolTuning | undefined
): Readonly<PgRuntimeDatabasePoolTuning> {
  if (input === undefined) return Object.freeze({});
  if (
    typeof input !== 'object' ||
    input === null ||
    !exactOwnKeys(
      input,
      [],
      [
        'max',
        'min',
        'idleTimeoutMillis',
        'connectionTimeoutMillis',
        'statementTimeoutMillis',
        'lockTimeoutMillis',
        'idleInTransactionSessionTimeoutMillis',
        'maxUses',
        'maxLifetimeSeconds',
        'allowExitOnIdle',
      ]
    )
  ) {
    throw new Error('RUNTIME_DATABASE_PG_POOL_TUNING_INVALID');
  }
  const max = input.max;
  const min = input.min;
  const idleTimeoutMillis = input.idleTimeoutMillis;
  const connectionTimeoutMillis = input.connectionTimeoutMillis;
  const statementTimeoutMillis = input.statementTimeoutMillis;
  const lockTimeoutMillis = input.lockTimeoutMillis;
  const idleInTransactionSessionTimeoutMillis = input.idleInTransactionSessionTimeoutMillis;
  const maxUses = input.maxUses;
  const maxLifetimeSeconds = input.maxLifetimeSeconds;
  const allowExitOnIdle = input.allowExitOnIdle;
  if (
    (max !== undefined && (!Number.isSafeInteger(max) || max < 1)) ||
    !optionalNonnegativeInteger(min) ||
    (max !== undefined && min !== undefined && min > max) ||
    (idleTimeoutMillis !== null && !optionalNonnegativeInteger(idleTimeoutMillis)) ||
    !optionalNonnegativeInteger(connectionTimeoutMillis) ||
    (statementTimeoutMillis !== undefined &&
      (!Number.isSafeInteger(statementTimeoutMillis) || statementTimeoutMillis < 1)) ||
    (lockTimeoutMillis !== undefined &&
      (!Number.isSafeInteger(lockTimeoutMillis) || lockTimeoutMillis < 1)) ||
    (idleInTransactionSessionTimeoutMillis !== undefined &&
      (!Number.isSafeInteger(idleInTransactionSessionTimeoutMillis) ||
        idleInTransactionSessionTimeoutMillis < 1)) ||
    !optionalNonnegativeInteger(maxUses) ||
    !optionalNonnegativeInteger(maxLifetimeSeconds) ||
    (allowExitOnIdle !== undefined && typeof allowExitOnIdle !== 'boolean')
  ) {
    throw new Error('RUNTIME_DATABASE_PG_POOL_TUNING_INVALID');
  }
  return Object.freeze({
    max,
    min,
    idleTimeoutMillis,
    connectionTimeoutMillis,
    statementTimeoutMillis,
    lockTimeoutMillis,
    idleInTransactionSessionTimeoutMillis,
    maxUses,
    maxLifetimeSeconds,
    allowExitOnIdle,
  });
}

function protocolStatus(status: string): RuntimeDatabaseTransactionStatus {
  if (status === 'I') return 'IDLE';
  if (status === 'T') return 'IN_TRANSACTION';
  if (status === 'E') return 'FAILED_TRANSACTION';
  return 'UNKNOWN';
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function normalizedHost(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, '');
}

function decodedUrlValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error('RUNTIME_DATABASE_PG_PRIMARY_URL_INVALID');
  }
}

interface ExactPgConnectionConfig {
  readonly username: string;
  readonly password: string;
  readonly hostname: string;
  readonly port: number;
  readonly databaseName: string;
  readonly applicationName: string;
  readonly ssl:
    | false
    | {
        readonly rejectUnauthorized: true;
        readonly servername: string;
        readonly minVersion: 'TLSv1.2';
      };
}

function assertSafeTlsProcessEnvironment(target: Readonly<RuntimeDatabaseTargetBinding>): void {
  if (target.tlsMode !== 'verify-full') return;
  if (runtimeDatabasePgAmbientTlsTrustUnsafe(process.env, process.execArgv)) {
    throw new Error('RUNTIME_DATABASE_PG_AMBIENT_TLS_TRUST_FORBIDDEN');
  }
}

export function runtimeDatabasePgAmbientTlsTrustUnsafe(
  environment: Readonly<Record<string, string | undefined>>,
  execArguments: readonly string[]
): boolean {
  const ambientTrustVariables = [
    environment.NODE_EXTRA_CA_CERTS,
    environment.SSL_CERT_FILE,
    environment.SSL_CERT_DIR,
  ];
  const unsafeCaArgument = /^--use-(?:openssl|system)-ca(?:=|$)/u;
  const unsafeNodeOptions = /(?:^|[\s"'])--use-(?:openssl|system)-ca(?==|\s|["']|$)/u;
  return (
    environment.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
    ambientTrustVariables.some((value) => typeof value === 'string' && value.trim().length > 0) ||
    unsafeNodeOptions.test(environment.NODE_OPTIONS ?? '') ||
    execArguments.some((argument) => unsafeCaArgument.test(argument))
  );
}

function validateExactConnectionUrl(
  exactPrimaryDatabaseUrl: string,
  target: Readonly<RuntimeDatabaseTargetBinding>
): Readonly<ExactPgConnectionConfig> {
  let parsed: URL;
  try {
    parsed = new URL(exactPrimaryDatabaseUrl);
  } catch {
    throw new Error('RUNTIME_DATABASE_PG_PRIMARY_URL_INVALID');
  }
  if (!POSTGRES_PROTOCOLS.has(parsed.protocol) || parsed.hash) {
    throw new Error('RUNTIME_DATABASE_PG_PRIMARY_URL_INVALID');
  }
  const allowedQueryKeys = new Set(['sslmode', 'channel_binding', 'application_name']);
  for (const key of parsed.searchParams.keys()) {
    if (!allowedQueryKeys.has(key) || parsed.searchParams.getAll(key).length !== 1) {
      throw new Error('RUNTIME_DATABASE_PG_PRIMARY_URL_INVALID');
    }
  }
  const username = decodedUrlValue(parsed.username);
  const password = decodedUrlValue(parsed.password);
  const databaseName = decodedUrlValue(parsed.pathname.replace(/^\//u, ''));
  const port = parsed.port ? Number(parsed.port) : 5432;
  const sslMode = parsed.searchParams.get('sslmode');
  const channelBinding = parsed.searchParams.get('channel_binding');
  const applicationName =
    parsed.searchParams.get('application_name') ?? RUNTIME_DATABASE_PG_APPLICATION_NAME;
  if (
    username !== target.serviceLogin ||
    password.length === 0 ||
    databaseName !== target.databaseName ||
    normalizedHost(parsed.hostname) !== normalizedHost(target.hostname) ||
    port !== target.port ||
    sslMode !== target.tlsMode ||
    (target.tlsMode !== 'disable' && target.tlsMode !== 'verify-full') ||
    (target.channelBinding === 'require'
      ? channelBinding !== 'require'
      : channelBinding !== null) ||
    (target.channelBinding === 'require' && target.tlsMode !== 'verify-full') ||
    applicationName.length === 0 ||
    applicationName.length > 64
  ) {
    throw new Error('RUNTIME_DATABASE_PG_PRIMARY_URL_TARGET_MISMATCH');
  }
  const hostname = normalizedHost(parsed.hostname);
  return Object.freeze({
    username,
    password,
    hostname,
    port,
    databaseName,
    applicationName,
    ssl:
      target.tlsMode === 'disable'
        ? false
        : Object.freeze({
            rejectUnauthorized: true,
            servername: hostname,
            minVersion: 'TLSv1.2' as const,
          }),
  });
}

interface PgRuntimeIdentityRow extends Record<string, unknown> {
  database_name: string;
  current_user: string;
  session_user: string;
  server_address: string;
  server_port: number | string;
  search_path: string;
  client_encoding: string;
  application_name: string;
  tls_active: boolean;
}

function verifyTlsTransport(
  client: PoolClient,
  target: Readonly<RuntimeDatabaseTargetBinding>
): void {
  const connection = (client as unknown as { readonly connection?: PgProtocolConnection })
    .connection;
  const stream = connection?.stream;
  if (target.tlsMode === 'disable') {
    if (stream?.encrypted === true) throw new Error('RUNTIME_DATABASE_PG_IDENTITY_MISMATCH');
    return;
  }
  assertSafeTlsProcessEnvironment(target);
  if (
    !stream ||
    stream.encrypted !== true ||
    stream.authorized !== true ||
    (stream.authorizationError !== undefined && stream.authorizationError !== null) ||
    typeof stream.getPeerCertificate !== 'function'
  ) {
    throw new Error('RUNTIME_DATABASE_PG_IDENTITY_MISMATCH');
  }
  let certificate: PeerCertificate;
  try {
    certificate = stream.getPeerCertificate(true);
  } catch {
    throw new Error('RUNTIME_DATABASE_PG_IDENTITY_MISMATCH');
  }
  if (
    !certificate ||
    Reflect.ownKeys(certificate).length === 0 ||
    checkServerIdentity(normalizedHost(target.hostname), certificate) !== undefined
  ) {
    throw new Error('RUNTIME_DATABASE_PG_IDENTITY_MISMATCH');
  }
}

async function verifyPhysicalConnectionIdentity(
  client: PoolClient,
  target: Readonly<RuntimeDatabaseTargetBinding>,
  applicationName: string
): Promise<void> {
  verifyTlsTransport(client, target);
  const result = await client.query<PgRuntimeIdentityRow>(
    RUNTIME_DATABASE_PG_PHYSICAL_IDENTITY_SQL
  );
  if (result.rowCount !== 1 || result.rows.length !== 1) {
    throw new Error('RUNTIME_DATABASE_PG_IDENTITY_MISMATCH');
  }
  const row = result.rows[0]!;
  if (
    row.database_name !== target.databaseName ||
    row.current_user !== target.serviceLogin ||
    row.session_user !== target.serviceLogin ||
    normalizedHost(String(row.server_address ?? '')) !== normalizedHost(target.serverAddress) ||
    Number(row.server_port) !== target.port ||
    row.search_path !== RUNTIME_DATABASE_PG_SEARCH_PATH ||
    row.client_encoding !== 'UTF8' ||
    row.application_name !== applicationName ||
    row.tls_active !== (target.tlsMode === 'verify-full') ||
    (target.channelBinding === 'require' &&
      authenticationMechanisms.get(client) !== 'SCRAM-SHA-256-PLUS')
  ) {
    throw new Error('RUNTIME_DATABASE_PG_IDENTITY_MISMATCH');
  }
}

function exactProtocolConnection(client: PoolClient): PgProtocolConnection {
  const connection = (client as unknown as { readonly connection?: PgProtocolConnection })
    .connection;
  if (
    !connection ||
    typeof connection.on !== 'function' ||
    typeof connection.removeListener !== 'function'
  ) {
    throw new Error('RUNTIME_DATABASE_PG_PROTOCOL_STATUS_UNAVAILABLE');
  }
  return connection;
}

/**
 * Create the only supported `pg.Pool` adapter for runtime authority startup.
 *
 * Transaction status is captured from PostgreSQL's ReadyForQuery protocol
 * status byte (I/T/E), not inferred from SQL strings. The first harmless probe
 * occurs after the listener is attached, so a pooled client returned while in
 * a transaction or failed transaction is detected before certification.
 */
export function createPgRuntimeDatabaseAuthorityAdapter(
  options: PgRuntimeDatabaseAuthorityAdapterOptions
): PgRuntimeDatabaseAuthorityAdapter {
  // This adapter intentionally audits protocol/private pool hooks. The exact
  // dependency versions are lockfile-pinned and separately tested; refuse to
  // construct if a substituted driver no longer provides those hooks.
  assertPgRuntimePrivateContract();
  if (
    typeof options !== 'object' ||
    options === null ||
    !exactOwnKeys(options, ['primaryDatabaseUrl', 'target'], ['poolConfig'])
  ) {
    throw new Error('RUNTIME_DATABASE_PG_ADAPTER_OPTIONS_INVALID');
  }
  const exactPrimaryDatabaseUrl = options.primaryDatabaseUrl;
  const targetInput = options.target;
  const poolTuning = exactPoolTuning(options.poolConfig);
  if (typeof exactPrimaryDatabaseUrl !== 'string' || exactPrimaryDatabaseUrl.length === 0) {
    throw new Error('RUNTIME_DATABASE_PG_PRIMARY_URL_REQUIRED');
  }
  if (
    typeof targetInput !== 'object' ||
    targetInput === null ||
    !exactOwnKeys(targetInput, [
      'component',
      'environment',
      'serviceLogin',
      'roleTopologyDigest',
      'databaseName',
      'hostname',
      'port',
      'serverAddress',
      'tlsMode',
      'channelBinding',
    ])
  ) {
    throw new Error('RUNTIME_DATABASE_PG_TARGET_INVALID');
  }
  const exactTarget = Object.freeze({
    component: targetInput.component,
    environment: targetInput.environment,
    serviceLogin: targetInput.serviceLogin,
    roleTopologyDigest: targetInput.roleTopologyDigest,
    databaseName: targetInput.databaseName,
    hostname: targetInput.hostname,
    port: targetInput.port,
    serverAddress: targetInput.serverAddress,
    tlsMode: targetInput.tlsMode,
    channelBinding: targetInput.channelBinding,
  });
  const exactTargetDigest = runtimeDatabaseTargetDigest(exactTarget);
  if (!nonzeroDigest(exactTargetDigest))
    throw new Error('RUNTIME_DATABASE_PG_TARGET_DIGEST_INVALID');
  assertSafeTlsProcessEnvironment(exactTarget);
  const exactConnection = validateExactConnectionUrl(exactPrimaryDatabaseUrl, exactTarget);
  const applicationName = exactConnection.applicationName;
  const maxConnections = poolTuning.max ?? 10;

  const adapterBinding = Object.freeze({});
  const poolBinding = Object.freeze({});
  let authorityEpochDigest = nonceDigest('hustlexp-runtime-database-pg-adapter-v1');
  let faulted = false;
  const invalidateAuthority = (): void => {
    faulted = true;
    authorityEpochDigest = nonceDigest('hustlexp-runtime-database-pg-adapter-fault-v1');
  };
  const pool = new Pool({
    user: exactConnection.username,
    password: exactConnection.password,
    host: exactConnection.hostname,
    port: exactConnection.port,
    database: exactConnection.databaseName,
    ssl: exactConnection.ssl,
    max: poolTuning.max,
    min: poolTuning.min,
    idleTimeoutMillis: poolTuning.idleTimeoutMillis,
    connectionTimeoutMillis: poolTuning.connectionTimeoutMillis ?? 10_000,
    statement_timeout: poolTuning.statementTimeoutMillis ?? 30_000,
    lock_timeout: poolTuning.lockTimeoutMillis ?? 5_000,
    idle_in_transaction_session_timeout:
      poolTuning.idleInTransactionSessionTimeoutMillis ?? 30_000,
    maxUses: poolTuning.maxUses,
    maxLifetimeSeconds: poolTuning.maxLifetimeSeconds,
    allowExitOnIdle: poolTuning.allowExitOnIdle,
    options: `-c search_path=${RUNTIME_DATABASE_PG_SEARCH_PATH}`,
    client_encoding: 'UTF8',
    application_name: applicationName,
    enableChannelBinding: exactTarget.channelBinding === 'require',
    Client: RuntimeDatabaseAuditedPgClient,
    verify: (client, done) => {
      verifyPhysicalConnectionIdentity(client, exactTarget, applicationName).then(
        () => done(),
        () => {
          invalidateAuthority();
          done(new Error('RUNTIME_DATABASE_PG_IDENTITY_MISMATCH'));
        }
      );
    },
  } as ConstructorParameters<typeof Pool>[0] & { enableChannelBinding: boolean });
  const poolInternal = pool as unknown as PgPoolWithForceRemove;
  const poolBindingDigest = nonceDigest('hustlexp-runtime-database-pg-pool-v1');
  let closed = false;
  pool.on('connect', (client) => {
    // pg-pool removes its own idle-client listener before verify and every
    // active checkout. Keep one nonthrowing listener for the physical
    // lifetime so socket faults cannot become unhandled EventEmitter errors
    // and always revoke the adapter epoch.
    client.on('error', () => {
      invalidateAuthority();
    });
  });
  pool.on('error', () => {
    // pg-pool has already removed and closed the affected idle client. Never
    // surface credential-bearing driver errors; invalidate the exact epoch so
    // existing capabilities stop authorizing this pool instance.
    invalidateAuthority();
  });

  return {
    adapterBinding,
    poolBinding,
    get adapterBindingDigest() {
      return authorityEpochDigest;
    },
    poolBindingDigest,
    async connect(
      requestedPrimaryDatabaseUrl: string,
      immutableTarget: Readonly<RuntimeDatabaseTargetBinding>,
      requestedConnectionBindingDigest: string
    ): Promise<RuntimeDatabaseAuthoritySession> {
      if (closed) throw new Error('RUNTIME_DATABASE_PG_POOL_CLOSED');
      if (faulted) throw new Error('RUNTIME_DATABASE_PG_AUTHORITY_EPOCH_INVALID');
      assertSafeTlsProcessEnvironment(exactTarget);
      if (requestedPrimaryDatabaseUrl !== exactPrimaryDatabaseUrl) {
        throw new Error('RUNTIME_DATABASE_PG_PRIMARY_URL_MISMATCH');
      }
      if (runtimeDatabaseTargetDigest(immutableTarget) !== exactTargetDigest) {
        throw new Error('RUNTIME_DATABASE_PG_TARGET_DIGEST_MISMATCH');
      }
      const independentlyComputedConnectionDigest =
        runtimeDatabaseConnectionBindingDigest(exactPrimaryDatabaseUrl);
      if (requestedConnectionBindingDigest !== independentlyComputedConnectionDigest) {
        throw new Error('RUNTIME_DATABASE_PG_CONNECTION_BINDING_MISMATCH');
      }

      const checkoutEpoch = authorityEpochDigest;
      const client = await pool.connect();
      if (closed || faulted || authorityEpochDigest !== checkoutEpoch) {
        await forceRemovePoolClient(poolInternal, client);
        throw new Error('RUNTIME_DATABASE_PG_AUTHORITY_EPOCH_INVALID');
      }
      const sessionAdapterBindingDigest = checkoutEpoch;
      let lifecycle: 'ACTIVE' | 'RELEASE_FAILED' | 'DESTROY_FAILED' | 'RELEASED' = 'ACTIVE';
      let listenerAttached = false;
      let status: RuntimeDatabaseTransactionStatus = 'UNKNOWN';
      let connection: PgProtocolConnection | null = null;
      const observedStatus = (): RuntimeDatabaseTransactionStatus => status;
      const epochCurrent = (): boolean =>
        !closed && !faulted && authorityEpochDigest === sessionAdapterBindingDigest;
      let pendingReady: (() => void) | null = null;
      const onReadyForQuery = (message: ReadyForQueryMessage): void => {
        status = protocolStatus(message.status);
        pendingReady?.();
        pendingReady = null;
      };
      const observeReadyForQuery = async <T>(operation: () => Promise<T>): Promise<T> => {
        if (!epochCurrent()) throw new Error('RUNTIME_DATABASE_PG_AUTHORITY_EPOCH_INVALID');
        if (pendingReady) throw new Error('RUNTIME_DATABASE_PG_CONCURRENT_QUERY_FORBIDDEN');
        status = 'UNKNOWN';
        let resolveReady: (ready: boolean) => void = () => undefined;
        let readyWasObserved = false;
        const ready = new Promise<boolean>((resolve) => {
          resolveReady = resolve;
        });
        const readyCallback = (): void => {
          readyWasObserved = true;
          resolveReady(true);
        };
        pendingReady = readyCallback;

        let result!: T;
        let operationFailed = false;
        let operationError: unknown;
        try {
          result = await operation();
        } catch (error) {
          operationFailed = true;
          operationError = error;
        }
        // Query duration is governed by the exact connection policy. This
        // short timer covers only a missing ReadyForQuery event after pg has
        // already settled the operation promise; long valid catalog reads do
        // not become false startup failures.
        let lagTimer: NodeJS.Timeout | null = null;
        const readyObserved = readyWasObserved
          ? true
          : await Promise.race([
              ready,
              new Promise<boolean>((resolve) => {
                lagTimer = setTimeout(() => resolve(false), 1_000);
              }),
            ]);
        if (lagTimer) clearTimeout(lagTimer);
        if (!readyObserved && pendingReady === readyCallback) pendingReady = null;
        if (!readyObserved) status = 'UNKNOWN';
        if (operationFailed) throw operationError;
        if (!epochCurrent()) throw new Error('RUNTIME_DATABASE_PG_AUTHORITY_EPOCH_INVALID');
        if (status === 'UNKNOWN') {
          throw new Error('RUNTIME_DATABASE_PG_PROTOCOL_STATUS_UNAVAILABLE');
        }
        return result;
      };
      try {
        connection = exactProtocolConnection(client);
        connection.on('readyForQuery', onReadyForQuery);
        listenerAttached = true;
        // pg-pool's `verify` hook runs only when a physical client is new.
        // Re-prove identity, TLS, role, encoding, application name, and the
        // pg_catalog baseline on every checkout before exposing the session.
        try {
          await observeReadyForQuery(() =>
            verifyPhysicalConnectionIdentity(client, exactTarget, applicationName)
          );
        } catch {
          invalidateAuthority();
          throw new Error('RUNTIME_DATABASE_PG_IDENTITY_MISMATCH');
        }
        try {
          await observeReadyForQuery(() => client.query(RUNTIME_DATABASE_PG_STATUS_PROBE_SQL));
        } catch (error) {
          if (errorCode(error) !== '25P02' || observedStatus() !== 'FAILED_TRANSACTION') {
            throw error;
          }
        }
        if (status === 'UNKNOWN') {
          throw new Error('RUNTIME_DATABASE_PG_PROTOCOL_STATUS_UNAVAILABLE');
        }
      } catch (error) {
        try {
          if (listenerAttached) connection?.removeListener('readyForQuery', onReadyForQuery);
        } finally {
          await forceRemovePoolClient(poolInternal, client);
        }
        throw error;
      }
      if (!connection) throw new Error('RUNTIME_DATABASE_PG_PROTOCOL_STATUS_UNAVAILABLE');
      const establishedConnection = connection;

      const sessionBinding = Object.freeze({});
      const sessionBindingDigest = nonceDigest('hustlexp-runtime-database-pg-session-v1');
      const finish = async (destroy: boolean): Promise<void> => {
        if (lifecycle === 'RELEASED') {
          throw new Error('RUNTIME_DATABASE_PG_SESSION_ALREADY_RELEASED');
        }
        if (lifecycle !== 'ACTIVE' && !destroy) {
          throw new Error('RUNTIME_DATABASE_PG_RELEASE_RETRY_REQUIRES_DESTROY');
        }
        if (listenerAttached) {
          establishedConnection.removeListener('readyForQuery', onReadyForQuery);
          listenerAttached = false;
        }
        try {
          if (destroy) await forceRemovePoolClient(poolInternal, client);
          else client.release();
          lifecycle = 'RELEASED';
        } catch (error) {
          lifecycle = destroy ? 'DESTROY_FAILED' : 'RELEASE_FAILED';
          invalidateAuthority();
          throw error;
        }
      };

      return {
        adapterBinding,
        poolBinding,
        sessionBinding,
        adapterBindingDigest: sessionAdapterBindingDigest,
        poolBindingDigest,
        sessionBindingDigest,
        connectionBindingDigest: independentlyComputedConnectionDigest,
        targetDigest: exactTargetDigest,
        transactionStatus: () => (lifecycle === 'ACTIVE' && epochCurrent() ? status : 'UNKNOWN'),
        async query<Row extends Record<string, unknown> = Record<string, unknown>>(
          sql: string,
          values?: readonly unknown[]
        ): Promise<{ rows: Row[]; rowCount: number }> {
          if (lifecycle !== 'ACTIVE') throw new Error('RUNTIME_DATABASE_PG_SESSION_RELEASED');
          if (!epochCurrent()) throw new Error('RUNTIME_DATABASE_PG_AUTHORITY_EPOCH_INVALID');
          const result = await observeReadyForQuery(() =>
            client.query<Row>(sql, values ? [...values] : undefined)
          );
          return { rows: result.rows, rowCount: result.rowCount ?? 0 };
        },
        async applicationQuery<Row extends Record<string, unknown> = Record<string, unknown>>(
          sql: string,
          values?: readonly unknown[]
        ): Promise<{ rows: Row[]; rowCount: number }> {
          if (lifecycle !== 'ACTIVE') throw new Error('RUNTIME_DATABASE_PG_SESSION_RELEASED');
          if (!epochCurrent()) throw new Error('RUNTIME_DATABASE_PG_AUTHORITY_EPOCH_INVALID');
          // `queryMode: extended` forces PostgreSQL's Parse message, which
          // rejects multiple commands before executing any of them. @types/pg
          // 8.21 omits this runtime-supported field, so the narrow cast is
          // confined to this audited adapter boundary.
          const statement = {
            text: sql,
            values: values ? [...values] : [],
            queryMode: 'extended' as const,
          };
          const result = await observeReadyForQuery(() =>
            client.query<Row>(
              statement as unknown as { text: string; values: unknown[] }
            )
          );
          return { rows: result.rows, rowCount: result.rowCount ?? 0 };
        },
        release: async () => {
          // Ordinary pool reuse is allowed only for a protocol-proven idle
          // session. Any dirty or uncertain state is destroyed instead.
          await finish(status !== 'IDLE' || !epochCurrent());
        },
        destroy: async () => finish(true),
      };
    },
    stats() {
      return Object.freeze({
        totalConnections: pool.totalCount,
        idleConnections: pool.idleCount,
        waitingRequests: pool.waitingCount,
        maxConnections,
        utilizationPercent:
          maxConnections === 0 ? 0 : Math.round((pool.totalCount / maxConnections) * 100),
        replicaConnections: null,
        replicaIdle: null,
        replicaConfigured: false as const,
      });
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      invalidateAuthority();
      await pool.end();
    },
  };
}
