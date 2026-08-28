import { isIP } from 'node:net';

import type { MigrationClient } from './engine-automation-migration.js';

type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;

const POSTGRES_PROTOCOLS = new Set(['postgres:', 'postgresql:']);
const LOCAL_DATABASE_MARKER = /(?:^|[_-])(?:test|e2e|startup)(?:$|[_-])/iu;
const LOCAL_ROLE_MARKER = /(?:^|[_-])(?:test|e2e|startup|local|ci)(?:$|[_-])/iu;

export interface ExpectedNonproductionDatabaseTarget {
  environment: 'local' | 'preview' | 'staging';
  databaseUrl: string;
  databaseName: string;
  roleName: string;
  hostname: string;
  port: number;
  serverAddress: string | null;
}

export interface ObservedNonproductionDatabaseIdentity {
  databaseName: string;
  roleName: string;
  serverAddress: string;
  serverPort: number;
  schemaName: string;
  searchPath: string;
}

interface DatabaseIdentityRow extends Record<string, unknown> {
  database_name: string;
  role_name: string;
  server_address: string;
  server_port: number | string;
  schema_name: string;
  search_path: string;
  effective_schemas: string[];
}

function refuse(reason: string): never {
  throw new Error(`NONPRODUCTION_DATABASE_TARGET_REFUSED:${reason}`);
}

function requiredBinding(env: Environment, name: string): string {
  const value = env[name]?.trim();
  return value ? value : refuse(`${name}_REQUIRED`);
}

function decoded(value: string, reason: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return refuse(reason);
  }
}

function normalizedHostname(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/gu, '');
}

function normalizedAddress(value: string): string {
  return normalizedHostname(value);
}

function isLoopback(value: string): boolean {
  const normalized = normalizedAddress(value);
  return normalized === '127.0.0.1' || normalized === '::1';
}

function isPrivateRfc1918(value: string): boolean {
  const octets = normalizedAddress(value).split('.').map(Number);
  if (
    octets.length !== 4
    || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  return octets[0] === 10
    || (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function exactEnvironment(env: Environment): ExpectedNonproductionDatabaseTarget['environment'] {
  const value = env.HX_ENVIRONMENT?.trim().toLowerCase();
  if (value === 'local' || value === 'preview' || value === 'staging') return value;
  return refuse('HX_ENVIRONMENT_INVALID');
}

function parsePort(value: string, reason: string): number {
  if (!/^\d{1,5}$/u.test(value)) return refuse(reason);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return refuse(reason);
  return port;
}

function parseDatabaseUrl(databaseUrl: string): {
  databaseName: string;
  roleName: string;
  hostname: string;
  port: number;
  search: string;
  hash: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return refuse('DATABASE_URL_INVALID');
  }
  if (!POSTGRES_PROTOCOLS.has(parsed.protocol)) return refuse('DATABASE_URL_PROTOCOL_INVALID');

  const databaseName = decoded(parsed.pathname.replace(/^\//u, ''), 'DATABASE_NAME_ENCODING_INVALID');
  const roleName = decoded(parsed.username, 'DATABASE_ROLE_ENCODING_INVALID');
  const hostname = normalizedHostname(parsed.hostname);
  if (!databaseName || databaseName.includes('/')) return refuse('DATABASE_NAME_INVALID');
  if (!roleName) return refuse('DATABASE_ROLE_INVALID');
  if (!hostname) return refuse('DATABASE_HOST_INVALID');

  return {
    databaseName,
    roleName,
    hostname,
    port: parsed.port ? parsePort(parsed.port, 'DATABASE_PORT_INVALID') : 5432,
    search: parsed.search,
    hash: parsed.hash,
  };
}

/**
 * Bind the migration target before hashing artifacts, reading SQL, creating a
 * client, or invoking the canonical migration chain. No connection-string
 * value is included in an error or log.
 */
export function assertConfiguredNonproductionDatabaseTarget(
  env: Environment,
  databaseUrl: string,
): ExpectedNonproductionDatabaseTarget {
  if (!databaseUrl.trim()) return refuse('DATABASE_URL_REQUIRED');
  const environment = exactEnvironment(env);
  const parsed = parseDatabaseUrl(databaseUrl);
  if (parsed.search || parsed.hash) return refuse('DATABASE_URL_MUST_BE_EXACT');

  if (environment === 'local') {
    if (!isLoopback(parsed.hostname) && parsed.hostname !== 'postgres') {
      return refuse('LOCAL_DATABASE_HOST_NOT_ALLOWLISTED');
    }
    const databaseName = requiredBinding(env, 'HXOS_LOCAL_TEST_DATABASE_NAME');
    const roleName = requiredBinding(env, 'HXOS_LOCAL_TEST_DATABASE_ROLE');
    if (!LOCAL_DATABASE_MARKER.test(databaseName)) {
      return refuse('LOCAL_DATABASE_NAME_NOT_ALLOWLISTED');
    }
    if (!LOCAL_ROLE_MARKER.test(roleName)) {
      return refuse('LOCAL_DATABASE_ROLE_NOT_ALLOWLISTED');
    }
    if (parsed.databaseName !== databaseName) return refuse('LOCAL_DATABASE_NAME_MISMATCH');
    if (parsed.roleName !== roleName) return refuse('LOCAL_DATABASE_ROLE_MISMATCH');

    return {
      environment,
      databaseUrl,
      databaseName,
      roleName,
      hostname: parsed.hostname,
      port: parsed.port,
      serverAddress: null,
    };
  }

  const databaseName = requiredBinding(env, 'HX_NONPRODUCTION_DATABASE_NAME');
  const roleName = requiredBinding(env, 'HX_NONPRODUCTION_DATABASE_ROLE');
  const hostname = normalizedHostname(requiredBinding(env, 'HX_NONPRODUCTION_DATABASE_HOST'));
  const port = parsePort(
    requiredBinding(env, 'HX_NONPRODUCTION_DATABASE_PORT'),
    'HX_NONPRODUCTION_DATABASE_PORT_INVALID',
  );
  const configuredAddress = env.HX_NONPRODUCTION_DATABASE_SERVER_ADDRESS?.trim();
  const serverAddress = configuredAddress ? normalizedAddress(configuredAddress) : null;

  if (!hostname.endsWith('.railway.internal') || isLoopback(hostname)) {
    return refuse('NONPRODUCTION_DATABASE_HOST_NOT_RAILWAY_INTERNAL');
  }
  if (serverAddress && (isIP(serverAddress) === 0 || isLoopback(serverAddress))) {
    return refuse('NONPRODUCTION_DATABASE_SERVER_ADDRESS_INVALID');
  }
  if (parsed.databaseName !== databaseName) return refuse('NONPRODUCTION_DATABASE_NAME_MISMATCH');
  if (parsed.roleName !== roleName) return refuse('NONPRODUCTION_DATABASE_ROLE_MISMATCH');
  if (parsed.hostname !== hostname) return refuse('NONPRODUCTION_DATABASE_HOST_MISMATCH');
  if (parsed.port !== port) return refuse('NONPRODUCTION_DATABASE_PORT_MISMATCH');

  return {
    environment,
    databaseUrl,
    databaseName,
    roleName,
    hostname,
    port,
    serverAddress,
  };
}

/** Verify the actual PostgreSQL identity on the exact connected session. */
export async function assertConnectedNonproductionDatabaseTarget(
  client: MigrationClient,
  expected: ExpectedNonproductionDatabaseTarget,
): Promise<ObservedNonproductionDatabaseIdentity> {
  // Pin unqualified canonical and fake-finance objects to public on this exact
  // session. This neutralizes role defaults before any migration statement.
  await client.query("SELECT set_config('search_path', 'public', false)");
  const result = await client.query<DatabaseIdentityRow>(
    `SELECT current_database()::text AS database_name,
            current_user::text AS role_name,
            COALESCE(host(inet_server_addr()), 'local_socket') AS server_address,
            COALESCE(inet_server_port(), 0)::integer AS server_port,
            current_schema()::text AS schema_name,
            current_setting('search_path')::text AS search_path,
            current_schemas(false)::text[] AS effective_schemas`,
  );
  if (result.rows.length !== 1) return refuse('LIVE_IDENTITY_ROW_COUNT_INVALID');

  const row = result.rows[0];
  const serverPort = Number(row?.server_port);
  const serverAddress = normalizedAddress(row?.server_address ?? '');
  if (!row || row.database_name !== expected.databaseName) {
    return refuse('LIVE_DATABASE_NAME_MISMATCH');
  }
  if (row.role_name !== expected.roleName) return refuse('LIVE_DATABASE_ROLE_MISMATCH');
  if (!Number.isInteger(serverPort) || serverPort !== expected.port) {
    return refuse('LIVE_DATABASE_PORT_MISMATCH');
  }
  if (row.schema_name !== 'public') return refuse('LIVE_SCHEMA_NAME_MISMATCH');
  if (row.search_path !== 'public'
      || !Array.isArray(row.effective_schemas)
      || row.effective_schemas.length !== 1
      || row.effective_schemas[0] !== 'public') {
    return refuse('LIVE_SEARCH_PATH_MISMATCH');
  }

  if (expected.environment === 'local') {
    if (
      (expected.hostname === 'postgres' && !isPrivateRfc1918(serverAddress))
      || (expected.hostname !== 'postgres' && !isLoopback(serverAddress))
    ) {
      return refuse('LIVE_LOCAL_DATABASE_ADDRESS_MISMATCH');
    }
  } else {
    if (serverAddress === 'local_socket' || isIP(serverAddress) === 0 || isLoopback(serverAddress)) {
      return refuse('LIVE_NONPRODUCTION_DATABASE_ADDRESS_INVALID');
    }
    if (expected.serverAddress && serverAddress !== expected.serverAddress) {
      return refuse('LIVE_NONPRODUCTION_DATABASE_ADDRESS_MISMATCH');
    }
  }

  return {
    databaseName: row.database_name,
    roleName: row.role_name,
    serverAddress,
    serverPort,
    schemaName: row.schema_name,
    searchPath: row.search_path,
  };
}
