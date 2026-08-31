export const DISPOSABLE_LOAD_TEST_DATABASES = Object.freeze([
  'hx_ci_system_test',
  'hx_concurrency_test',
]);
export const DISPOSABLE_LOAD_TEST_ROLE = 'hx_ci_runner';

type Environment = Record<string, string | undefined>;

export interface DisposableLoadTestAuthority {
  databaseName: string;
  databaseRole: string;
  host: '127.0.0.1' | 'localhost';
  port: number;
}

export function assertDisposableLoadTestAuthority(
  databaseUrl: string,
  env: Environment = process.env,
): DisposableLoadTestAuthority {
  if (env.HX_ALLOW_DESTRUCTIVE_LOAD_TEST !== 'true') {
    throw new Error('DESTRUCTIVE_LOAD_TEST_EXPLICIT_AUTHORITY_REQUIRED');
  }
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('DESTRUCTIVE_LOAD_TEST_DATABASE_URL_INVALID');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('DESTRUCTIVE_LOAD_TEST_POSTGRESQL_REQUIRED');
  }
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('DESTRUCTIVE_LOAD_TEST_LOOPBACK_REQUIRED');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('DESTRUCTIVE_LOAD_TEST_URL_OPTIONS_FORBIDDEN');
  }
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  const databaseRole = decodeURIComponent(parsed.username);
  const port = Number(parsed.port || '5432');
  if (!DISPOSABLE_LOAD_TEST_DATABASES.includes(databaseName)) {
    throw new Error('DESTRUCTIVE_LOAD_TEST_DATABASE_NOT_ALLOWLISTED');
  }
  if (databaseRole !== DISPOSABLE_LOAD_TEST_ROLE) {
    throw new Error('DESTRUCTIVE_LOAD_TEST_ROLE_NOT_ALLOWLISTED');
  }
  if (!parsed.password || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('DESTRUCTIVE_LOAD_TEST_CONNECTION_IDENTITY_INCOMPLETE');
  }
  return {
    databaseName,
    databaseRole,
    host: parsed.hostname,
    port,
  };
}

export function assertDisposableLoadTestReadback(
  expected: DisposableLoadTestAuthority,
  actual: { database_name?: unknown; database_role?: unknown },
): void {
  if (
    actual.database_name !== expected.databaseName
    || actual.database_role !== expected.databaseRole
  ) {
    throw new Error('DESTRUCTIVE_LOAD_TEST_DATABASE_READBACK_MISMATCH');
  }
}
