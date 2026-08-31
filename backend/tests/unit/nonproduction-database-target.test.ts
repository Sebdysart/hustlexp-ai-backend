import { describe, expect, it, vi } from 'vitest';

import type { MigrationClient } from '../../src/jobs/engine-automation-migration.js';
import {
  assertConfiguredNonproductionDatabaseTarget,
  assertConnectedNonproductionDatabaseTarget,
  type ExpectedNonproductionDatabaseTarget,
} from '../../src/jobs/nonproduction-database-target.js';

const localEnv = {
  HX_ENVIRONMENT: 'local',
  HXOS_LOCAL_TEST_DATABASE_NAME: 'hx_ci_system_test',
  HXOS_LOCAL_TEST_DATABASE_ROLE: 'hx_ci_runner',
};

const stagingEnv = {
  HX_ENVIRONMENT: 'staging',
  HX_NONPRODUCTION_DATABASE_NAME: 'hustlexp_nonprod',
  HX_NONPRODUCTION_DATABASE_ROLE: 'synthetic',
  HX_NONPRODUCTION_DATABASE_HOST: 'postgres.railway.internal',
  HX_NONPRODUCTION_DATABASE_PORT: '5432',
};

const localIdentity = {
  database_name: 'hx_ci_system_test',
  role_name: 'hx_ci_runner',
  server_address: '127.0.0.1',
  server_port: 5432,
  schema_name: 'public',
  search_path: 'public',
  effective_schemas: ['public'],
};

const stagingIdentity = {
  database_name: 'hustlexp_nonprod',
  role_name: 'synthetic',
  server_address: '10.42.0.8',
  server_port: 5432,
  schema_name: 'public',
  search_path: 'public',
  effective_schemas: ['public'],
};

function identityClient(rows: Array<Record<string, unknown>>): MigrationClient {
  return {
    connect: vi.fn(async () => undefined),
    end: vi.fn(async () => undefined),
    query: vi.fn(async () => ({ rows })) as MigrationClient['query'],
  };
}

function configuredStaging(
  env: Record<string, string | undefined> = stagingEnv,
  databaseUrl = 'postgresql://synthetic@postgres.railway.internal/hustlexp_nonprod',
): ExpectedNonproductionDatabaseTarget {
  return assertConfiguredNonproductionDatabaseTarget(env, databaseUrl);
}

describe('configured nonproduction database target', () => {
  it('rejects missing, malformed, non-PostgreSQL, or incomplete URLs', () => {
    for (const databaseUrl of [
      '',
      'not-a-url',
      'https://hx_ci_runner@127.0.0.1/hx_ci_system_test',
      'postgresql://127.0.0.1/hx_ci_system_test',
      'postgresql://hx_ci_runner@127.0.0.1/',
    ]) {
      expect(() => assertConfiguredNonproductionDatabaseTarget(localEnv, databaseUrl)).toThrow(
        'NONPRODUCTION_DATABASE_TARGET_REFUSED',
      );
    }
  });

  it('requires every exact local name and role binding and their allowlisted markers', () => {
    for (const env of [
      { ...localEnv, HXOS_LOCAL_TEST_DATABASE_NAME: undefined },
      { ...localEnv, HXOS_LOCAL_TEST_DATABASE_ROLE: undefined },
      { ...localEnv, HXOS_LOCAL_TEST_DATABASE_NAME: 'hustlexp' },
      { ...localEnv, HXOS_LOCAL_TEST_DATABASE_ROLE: 'postgres' },
    ]) {
      expect(() => assertConfiguredNonproductionDatabaseTarget(
        env,
        'postgresql://hx_ci_runner@127.0.0.1/hx_ci_system_test',
      )).toThrow('NONPRODUCTION_DATABASE_TARGET_REFUSED');
    }
  });

  it('decodes exact username/database bindings and uses PostgreSQL default port', () => {
    expect(assertConfiguredNonproductionDatabaseTarget(
      localEnv,
      'postgresql://hx%5Fci%5Frunner@127.0.0.1/hx%5Fci%5Fsystem%5Ftest',
    )).toEqual(expect.objectContaining({
      databaseName: 'hx_ci_system_test',
      roleName: 'hx_ci_runner',
      hostname: '127.0.0.1',
      port: 5432,
    }));
  });

  it('normalizes the exact IPv6 loopback target', () => {
    expect(assertConfiguredNonproductionDatabaseTarget(
      localEnv,
      'postgresql://hx_ci_runner@[::1]:5432/hx_ci_system_test',
    )).toEqual(expect.objectContaining({ hostname: '::1', port: 5432 }));
  });

  it('requires every preview/staging binding and rejects malformed or mismatched values', () => {
    const cases: Array<[Record<string, string | undefined>, string]> = [
      [{ ...stagingEnv, HX_NONPRODUCTION_DATABASE_NAME: undefined }, 'hustlexp_nonprod'],
      [{ ...stagingEnv, HX_NONPRODUCTION_DATABASE_ROLE: undefined }, 'hustlexp_nonprod'],
      [{ ...stagingEnv, HX_NONPRODUCTION_DATABASE_HOST: undefined }, 'hustlexp_nonprod'],
      [{ ...stagingEnv, HX_NONPRODUCTION_DATABASE_PORT: undefined }, 'hustlexp_nonprod'],
      [{ ...stagingEnv, HX_NONPRODUCTION_DATABASE_PORT: '0' }, 'hustlexp_nonprod'],
      [{ ...stagingEnv, HX_NONPRODUCTION_DATABASE_PORT: 'not-a-port' }, 'hustlexp_nonprod'],
      [{ ...stagingEnv, HX_NONPRODUCTION_DATABASE_HOST: 'db.example.test' }, 'hustlexp_nonprod'],
      [{ ...stagingEnv, HX_NONPRODUCTION_DATABASE_NAME: 'wrong_nonprod' }, 'hustlexp_nonprod'],
      [{ ...stagingEnv, HX_NONPRODUCTION_DATABASE_ROLE: 'wrong_role' }, 'hustlexp_nonprod'],
      [{ ...stagingEnv, HX_NONPRODUCTION_DATABASE_SERVER_ADDRESS: 'not-an-address' }, 'hustlexp_nonprod'],
    ];
    for (const [env, databaseName] of cases) {
      expect(() => assertConfiguredNonproductionDatabaseTarget(
        env,
        `postgresql://synthetic@postgres.railway.internal:5432/${databaseName}`,
      )).toThrow('NONPRODUCTION_DATABASE_TARGET_REFUSED');
    }
    expect(() => assertConfiguredNonproductionDatabaseTarget(
      stagingEnv,
      'postgresql://synthetic@postgres.railway.internal:5432/hustlexp_nonprod?options=-csearch_path%3Devil',
    )).toThrow('NONPRODUCTION_DATABASE_TARGET_REFUSED:DATABASE_URL_MUST_BE_EXACT');
  });

  it('binds an optional exact deployed server address without weakening hostname binding', () => {
    expect(configuredStaging({
      ...stagingEnv,
      HX_NONPRODUCTION_DATABASE_SERVER_ADDRESS: '10.42.0.8',
    })).toEqual(expect.objectContaining({
      hostname: 'postgres.railway.internal',
      serverAddress: '10.42.0.8',
      port: 5432,
    }));
  });
});

describe('connected nonproduction database identity', () => {
  it('requires exactly one live identity row', async () => {
    const target = configuredStaging();
    for (const rows of [[], [stagingIdentity, stagingIdentity]]) {
      await expect(assertConnectedNonproductionDatabaseTarget(
        identityClient(rows),
        target,
      )).rejects.toThrow(
        'NONPRODUCTION_DATABASE_TARGET_REFUSED:LIVE_IDENTITY_ROW_COUNT_INVALID',
      );
    }
  });

  it('rejects every live database, role, port, and unpinned address class mismatch', async () => {
    const target = configuredStaging();
    const mismatches: Array<[Record<string, unknown>, string]> = [
      [{ ...stagingIdentity, database_name: 'wrong_nonprod' }, 'LIVE_DATABASE_NAME_MISMATCH'],
      [{ ...stagingIdentity, role_name: 'wrong_role' }, 'LIVE_DATABASE_ROLE_MISMATCH'],
      [{ ...stagingIdentity, server_port: 6432 }, 'LIVE_DATABASE_PORT_MISMATCH'],
      [{ ...stagingIdentity, server_address: 'local_socket' }, 'LIVE_NONPRODUCTION_DATABASE_ADDRESS_INVALID'],
      [{ ...stagingIdentity, server_address: '127.0.0.1' }, 'LIVE_NONPRODUCTION_DATABASE_ADDRESS_INVALID'],
      [{ ...stagingIdentity, server_address: 'not-an-address' }, 'LIVE_NONPRODUCTION_DATABASE_ADDRESS_INVALID'],
    ];
    for (const [row, reason] of mismatches) {
      await expect(assertConnectedNonproductionDatabaseTarget(
        identityClient([row]),
        target,
      )).rejects.toThrow(`NONPRODUCTION_DATABASE_TARGET_REFUSED:${reason}`);
    }
  });

  it('rejects an optional pinned deployed server-address mismatch', async () => {
    const target = configuredStaging({
      ...stagingEnv,
      HX_NONPRODUCTION_DATABASE_SERVER_ADDRESS: '10.42.0.9',
    });
    await expect(assertConnectedNonproductionDatabaseTarget(
      identityClient([stagingIdentity]),
      target,
    )).rejects.toThrow(
      'NONPRODUCTION_DATABASE_TARGET_REFUSED:LIVE_NONPRODUCTION_DATABASE_ADDRESS_MISMATCH',
    );
  });

  it('pins and verifies the exact public schema before migration work', async () => {
    const target = configuredStaging();
    for (const row of [
      { ...stagingIdentity, schema_name: 'synthetic' },
      { ...stagingIdentity, search_path: 'synthetic, public' },
      { ...stagingIdentity, effective_schemas: ['synthetic', 'public'] },
    ]) {
      await expect(assertConnectedNonproductionDatabaseTarget(
        identityClient([row]),
        target,
      )).rejects.toThrow('NONPRODUCTION_DATABASE_TARGET_REFUSED:LIVE_');
    }
    const client = identityClient([stagingIdentity]);
    await expect(assertConnectedNonproductionDatabaseTarget(client, target)).resolves
      .toEqual(expect.objectContaining({ schemaName: 'public', searchPath: 'public' }));
    expect(client.query).toHaveBeenNthCalledWith(
      1,
      "SELECT set_config('search_path', 'public', false)",
    );
  });

  it('accepts IPv6 loopback only for the exact local IPv6 target', async () => {
    const target = assertConfiguredNonproductionDatabaseTarget(
      localEnv,
      'postgresql://hx_ci_runner@[::1]/hx_ci_system_test',
    );
    await expect(assertConnectedNonproductionDatabaseTarget(identityClient([{
      ...localIdentity,
      server_address: '::1',
    }]), target)).resolves.toEqual(expect.objectContaining({
      serverAddress: '::1',
      serverPort: 5432,
    }));
  });
});
