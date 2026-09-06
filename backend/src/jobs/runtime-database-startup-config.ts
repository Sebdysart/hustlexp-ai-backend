import {
  runtimeDatabaseRoleTopologyDigest,
  runtimeDatabaseTargetDigest,
  type RuntimeDatabaseAuthorityComponent,
  type RuntimeDatabaseExpectedTarget,
  type RuntimeDatabaseRoleTopology,
  type RuntimeDatabaseTargetBinding,
} from './runtime-database-authority.js';
import type { PgRuntimeDatabasePoolTuning } from './runtime-database-pg-adapter.js';
import { configuredWorkOrderCommandRoles } from './work-order-command-role-authority.js';

type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;

const SAFE_TEXT = /^[\u0021-\u007e]+$/u;

export interface ConfiguredRuntimeDatabaseStartup {
  readonly component: RuntimeDatabaseAuthorityComponent;
  readonly primaryDatabaseUrl: string;
  readonly replicaDatabaseUrl: null;
  readonly roleTopology: Readonly<RuntimeDatabaseRoleTopology>;
  readonly expectedTarget: Readonly<RuntimeDatabaseExpectedTarget>;
  readonly target: Readonly<RuntimeDatabaseTargetBinding>;
  readonly targetDigest: string;
  readonly poolConfig: Readonly<PgRuntimeDatabasePoolTuning>;
}

function refuse(reason: string): never {
  throw new Error(`RUNTIME_DATABASE_STARTUP_CONFIG_REFUSED:${reason}`);
}

function required(env: Environment, name: string, maximumLength = 255): string {
  const value = env[name]?.trim() ?? '';
  if (!value || value.length > maximumLength || !SAFE_TEXT.test(value)) {
    return refuse(`${name}_REQUIRED`);
  }
  return value;
}

function exactInteger(
  env: Environment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = env[name]?.trim() || String(fallback);
  if (!/^\d+$/u.test(raw)) return refuse(`${name}_INVALID`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return refuse(`${name}_INVALID`);
  }
  return value;
}

function exactEnvironment(env: Environment): RuntimeDatabaseExpectedTarget['environment'] {
  const value = required(env, 'HX_ENVIRONMENT', 16).toLowerCase();
  if (value === 'local' || value === 'preview' || value === 'staging' || value === 'production') {
    return value;
  }
  return refuse('HX_ENVIRONMENT_INVALID');
}

function exactServiceRole(env: Environment, component: RuntimeDatabaseAuthorityComponent): void {
  const role = required(env, 'SERVICE_ROLE', 16).toLowerCase();
  if (role !== component) return refuse('SERVICE_ROLE_COMPONENT_MISMATCH');
}

function componentDatabaseUrl(
  env: Environment,
  component: RuntimeDatabaseAuthorityComponent
): string {
  const general = env.DATABASE_URL?.trim() ?? '';
  const attester = env.HX_ACTOR_ATTESTER_DATABASE_URL?.trim() ?? '';
  if (component === 'attester') {
    if (general) return refuse('ATTESTER_GENERAL_DATABASE_URL_FORBIDDEN');
    return required(env, 'HX_ACTOR_ATTESTER_DATABASE_URL', 8_192);
  }
  if (attester) return refuse('GENERAL_SERVICE_ATTESTER_DATABASE_URL_FORBIDDEN');
  return required(env, 'DATABASE_URL', 8_192);
}

function exactExpectedTarget(env: Environment): RuntimeDatabaseExpectedTarget {
  const tlsMode = required(env, 'HX_RUNTIME_DATABASE_TLS_MODE', 16);
  const channelBinding = required(env, 'HX_RUNTIME_DATABASE_CHANNEL_BINDING', 16);
  if (tlsMode !== 'disable' && tlsMode !== 'verify-full') {
    return refuse('HX_RUNTIME_DATABASE_TLS_MODE_INVALID');
  }
  if (channelBinding !== 'disabled' && channelBinding !== 'require') {
    return refuse('HX_RUNTIME_DATABASE_CHANNEL_BINDING_INVALID');
  }
  return Object.freeze({
    environment: exactEnvironment(env),
    databaseName: required(env, 'HX_RUNTIME_DATABASE_NAME', 63),
    hostname: required(env, 'HX_RUNTIME_DATABASE_HOST', 255).toLowerCase(),
    port: exactInteger(env, 'HX_RUNTIME_DATABASE_PORT', 5_432, 1, 65_535),
    serverAddress: required(env, 'HX_RUNTIME_DATABASE_SERVER_ADDRESS', 255).toLowerCase(),
    tlsMode,
    channelBinding,
  });
}

function exactPoolConfig(env: Environment): Readonly<PgRuntimeDatabasePoolTuning> {
  const max = exactInteger(env, 'DB_POOL_MAX', 20, 1, 1_000);
  const min = exactInteger(env, 'DB_POOL_MIN', 0, 0, max);
  if (env.DB_PGBOUNCER !== undefined && !['', 'false'].includes(env.DB_PGBOUNCER.trim())) {
    return refuse('PGBOUNCER_TRANSACTION_POOLING_FORBIDDEN');
  }
  return Object.freeze({
    max,
    min,
    idleTimeoutMillis: exactInteger(env, 'DB_IDLE_TIMEOUT_MS', 30_000, 1, 120_000),
    connectionTimeoutMillis: exactInteger(
      env,
      'DB_CONNECT_TIMEOUT_MS',
      10_000,
      1,
      120_000
    ),
    statementTimeoutMillis: exactInteger(
      env,
      'DB_STATEMENT_TIMEOUT_MS',
      30_000,
      1,
      300_000
    ),
    lockTimeoutMillis: exactInteger(env, 'DB_LOCK_TIMEOUT_MS', 5_000, 1, 60_000),
    idleInTransactionSessionTimeoutMillis: exactInteger(
      env,
      'DB_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS',
      30_000,
      1,
      300_000
    ),
  });
}

/**
 * Resolve only independently enrolled target facts. The connection string is
 * later parsed again by the authority and PG adapter; it is never used as the
 * source of these expected identity fields.
 */
export function configuredRuntimeDatabaseStartup(
  component: RuntimeDatabaseAuthorityComponent,
  env: Environment = process.env
): ConfiguredRuntimeDatabaseStartup {
  if (!['api', 'worker', 'attester'].includes(component)) {
    return refuse('COMPONENT_INVALID');
  }
  exactServiceRole(env, component);
  if (env.DATABASE_REPLICA_URL?.trim()) return refuse('REPLICA_DATABASE_CONFIGURED');
  const primaryDatabaseUrl = componentDatabaseUrl(env, component);
  const roles = configuredWorkOrderCommandRoles(env);
  const roleTopology = Object.freeze<RuntimeDatabaseRoleTopology>({
    migrationRole: roles.migrationRole,
    apiRole: roles.apiRole,
    workerRole: roles.workerRole,
    attesterRole: roles.attesterRole,
    commandOwnerRole: roles.commandOwnerRole,
    assertionOwnerRole: roles.assertionOwnerRole,
    financeOwnerRole: roles.financeOwnerRole,
    telemetryOwnerRole: roles.telemetryOwnerRole,
  });
  const expectedTarget = exactExpectedTarget(env);
  const serviceLogin =
    component === 'api'
      ? roleTopology.apiRole
      : component === 'worker'
        ? roleTopology.workerRole
        : roleTopology.attesterRole;
  const target = Object.freeze<RuntimeDatabaseTargetBinding>({
    component,
    serviceLogin,
    roleTopologyDigest: runtimeDatabaseRoleTopologyDigest(roleTopology),
    ...expectedTarget,
  });
  return Object.freeze({
    component,
    primaryDatabaseUrl,
    replicaDatabaseUrl: null,
    roleTopology,
    expectedTarget,
    target,
    targetDigest: runtimeDatabaseTargetDigest(target),
    poolConfig: exactPoolConfig(env),
  });
}
