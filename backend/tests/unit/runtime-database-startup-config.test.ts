import { describe, expect, it } from 'vitest';

import { configuredRuntimeDatabaseStartup } from '../../src/jobs/runtime-database-startup-config.js';

function exactEnvironment(
  component: 'api' | 'worker' | 'attester' = 'api'
): Record<string, string> {
  const roles = {
    HX_WORK_ORDER_MIGRATION_DATABASE_ROLE: 'hx_migration',
    HX_WORK_ORDER_API_DATABASE_ROLE: 'hx_api',
    HX_WORK_ORDER_WORKER_DATABASE_ROLE: 'hx_worker',
    HX_WORK_ORDER_ATTESTER_DATABASE_ROLE: 'hx_attester',
    HX_WORK_ORDER_COMMAND_OWNER_DATABASE_ROLE: 'hx_command_owner',
    HX_WORK_ORDER_ASSERTION_OWNER_DATABASE_ROLE: 'hx_assertion_owner',
    HX_FINANCE_COMMAND_OWNER_DATABASE_ROLE: 'hx_finance_owner',
    HX_TELEMETRY_OWNER_DATABASE_ROLE: 'hx_telemetry_owner',
  };
  return {
    ...roles,
    SERVICE_ROLE: component,
    HX_ENVIRONMENT: 'local',
    HX_RUNTIME_DATABASE_NAME: 'hx_ci_system_test',
    HX_RUNTIME_DATABASE_HOST: '127.0.0.1',
    HX_RUNTIME_DATABASE_PORT: '5432',
    HX_RUNTIME_DATABASE_SERVER_ADDRESS: '172.17.0.2',
    HX_RUNTIME_DATABASE_TLS_MODE: 'disable',
    HX_RUNTIME_DATABASE_CHANNEL_BINDING: 'disabled',
    ...(component === 'attester'
      ? {
          HX_ACTOR_ATTESTER_DATABASE_URL:
            'postgresql://hx_attester:secret@127.0.0.1:5432/hx_ci_system_test?sslmode=disable',
        }
      : {
          DATABASE_URL: `postgresql://hx_${component}:secret@127.0.0.1:5432/hx_ci_system_test?sslmode=disable`,
        }),
  };
}

describe('runtime database startup configuration', () => {
  it.each(['api', 'worker', 'attester'] as const)(
    'binds the exact %s service login into an independent target digest',
    (component) => {
      const configured = configuredRuntimeDatabaseStartup(component, exactEnvironment(component));
      expect(configured.target.component).toBe(component);
      expect(configured.target.serviceLogin).toBe(`hx_${component}`);
      expect(configured.targetDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(configured.replicaDatabaseUrl).toBeNull();
      expect(configured.poolConfig).toMatchObject({
        max: 20,
        min: 0,
        statementTimeoutMillis: 30_000,
        lockTimeoutMillis: 5_000,
        idleInTransactionSessionTimeoutMillis: 30_000,
      });
    }
  );

  it.each([
    ['wrong process role', { SERVICE_ROLE: 'worker' }, 'SERVICE_ROLE_COMPONENT_MISMATCH'],
    ['replica', { DATABASE_REPLICA_URL: 'postgresql://replica' }, 'REPLICA_DATABASE_CONFIGURED'],
    [
      'attester credential on API',
      { HX_ACTOR_ATTESTER_DATABASE_URL: 'postgresql://attester' },
      'GENERAL_SERVICE_ATTESTER_DATABASE_URL_FORBIDDEN',
    ],
    ['PgBouncer mode', { DB_PGBOUNCER: 'true' }, 'PGBOUNCER_TRANSACTION_POOLING_FORBIDDEN'],
    ['zero statement timeout', { DB_STATEMENT_TIMEOUT_MS: '0' }, 'DB_STATEMENT_TIMEOUT_MS_INVALID'],
    ['missing expected address', { HX_RUNTIME_DATABASE_SERVER_ADDRESS: '' }, 'SERVER_ADDRESS_REQUIRED'],
  ])('refuses %s before constructing a connector', (_label, overrides, reason) => {
    expect(() =>
      configuredRuntimeDatabaseStartup('api', {
        ...exactEnvironment('api'),
        ...overrides,
      })
    ).toThrow(reason);
  });

  it('requires attester credential isolation in both directions', () => {
    expect(() =>
      configuredRuntimeDatabaseStartup('attester', {
        ...exactEnvironment('attester'),
        DATABASE_URL: 'postgresql://hx_api:secret@127.0.0.1:5432/hx_ci_system_test',
      })
    ).toThrow('ATTESTER_GENERAL_DATABASE_URL_FORBIDDEN');
  });
});
