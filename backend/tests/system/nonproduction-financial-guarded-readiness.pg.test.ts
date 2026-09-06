import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuildIdentity } from '../../src/buildIdentity.js';
import type { QueryFn } from '../../src/database-contracts.js';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';
import {
  attestRuntimeDatabaseAuthority,
  runtimeDatabaseRoleTopologyDigest,
  runtimeDatabaseTargetDigest,
} from '../../src/jobs/runtime-database-authority.js';
import {
  createRuntimeDatabaseDataPlane,
  type RuntimeDatabaseDataPlane,
} from '../../src/jobs/runtime-database-data-plane.js';
import { createPgRuntimeDatabaseAuthorityAdapter } from '../../src/jobs/runtime-database-pg-adapter.js';
import {
  composeRuntimeDatabaseReleaseAuthority,
  composeRuntimeDatabaseReleaseAuthorityKernelForTest,
} from '../../src/jobs/runtime-database-release-authority.js';
import { configuredRuntimeDatabaseStartup } from '../../src/jobs/runtime-database-startup-config.js';
import type { WorkOrderCommandRoleNames } from '../../src/jobs/work-order-command-role-authority.js';
import { PINNED_RELEASE_AUTHORITY_PUBLIC_KEYS } from '../../src/releaseAuthorityKeys.js';
import {
  readReleaseManifest,
  releaseManifestDigest,
  releaseManifestSignaturePayload,
  type ReleaseManifestEvidence,
  type ReleaseManifestV2,
} from '../../src/releaseManifest.js';
import {
  productionStartupMigrationRuntime,
  runStartupMigrations,
} from '../../src/serverStartupMigrations.js';
import {
  readNonproductionFinancialBootstrapReadiness,
  type NonproductionFinancialReadinessDatabase,
} from '../../src/services/payment/NonproductionFinancialBootstrapReadiness.js';
import { createUniversalV1DisposableDatabase } from '../helpers/universal-v1-disposable-database.js';
import { createLocalFinancialReadinessAuthority } from '../helpers/universal-v1-local-financial-readiness-fixture.js';
import {
  provisionFinancialReadinessCustody,
  provisionUniversalV1SyntheticRoles,
} from '../helpers/universal-v1-synthetic-role-provisioning.js';

const describePg = describe.skipIf(!process.env.DATABASE_URL).sequential;
describePg('signed test authority through actual financial readiness data plane', () => {
  type Component = 'api' | 'worker';
  const suffix = randomUUID().replaceAll('-', '').slice(0, 20);
  const roles: WorkOrderCommandRoleNames = {
    migrationRole: `hx_ci_${suffix}_migration`,
    apiRole: `hx_ci_${suffix}_api`,
    workerRole: `hx_ci_${suffix}_worker`,
    attesterRole: `hx_ci_${suffix}_attester`,
    commandOwnerRole: `hx_ci_${suffix}_command`,
    assertionOwnerRole: `hx_ci_${suffix}_assertion`,
    financeOwnerRole: `hx_ci_${suffix}_finance`,
    telemetryOwnerRole: `hx_ci_${suffix}_telemetry`,
  };
  const roleEnvironment = {
    HX_WORK_ORDER_MIGRATION_DATABASE_ROLE: roles.migrationRole,
    HX_WORK_ORDER_API_DATABASE_ROLE: roles.apiRole,
    HX_WORK_ORDER_WORKER_DATABASE_ROLE: roles.workerRole,
    HX_WORK_ORDER_ATTESTER_DATABASE_ROLE: roles.attesterRole,
    HX_WORK_ORDER_COMMAND_OWNER_DATABASE_ROLE: roles.commandOwnerRole,
    HX_WORK_ORDER_ASSERTION_OWNER_DATABASE_ROLE: roles.assertionOwnerRole,
    HX_FINANCE_COMMAND_OWNER_DATABASE_ROLE: roles.financeOwnerRole,
    HX_TELEMETRY_OWNER_DATABASE_ROLE: roles.telemetryOwnerRole,
  };
  const password = `synthetic-${randomUUID()}`,
    keyId = `synthetic-readiness-${suffix}`;
  const created: string[] = [];
  let root: pg.Client;
  let fixture: Awaited<ReturnType<typeof createUniversalV1DisposableDatabase>>;
  let manifest: ReleaseManifestV2, release: ReleaseManifestEvidence;
  let directory: string | undefined, manifestPath: string | undefined;
  let expectedTarget: {
    environment: 'local';
    databaseName: string;
    hostname: string;
    port: number;
    serverAddress: string;
    tlsMode: 'disable';
    channelBinding: 'disabled';
  };
  const quote = (name: string) => {
    if (!/^hx_ci_[a-f0-9]{20}_[a-z]+$/u.test(name)) throw Error('EXACT_SYNTHETIC_ROLE_REQUIRED');
    return '"' + name + '"';
  };
  const identityFor = (component: Component): Readonly<BuildIdentity> => {
    const executable = manifest.components[component === 'api' ? 'backend' : 'worker'];
    // Explicit test-vector provenance, never a measured release artifact claim.
    return Object.freeze({
      schema_version: 1,
      service: 'hustlexp-engine',
      revision: executable.revision,
      built_at: manifest.createdAt,
      environment: 'local',
      clean_source: true,
      source: 'signed-synthetic-pg-test-vector',
      artifact_digest: executable.artifactDigest,
      artifact_verified: true,
    });
  };
  const environmentFor = (component: Component) => {
    const url = new URL(fixture.databaseUrl);
    url.username = roles[`${component}Role`];
    url.password = password;
    url.searchParams.set('sslmode', 'disable');
    return {
      ...roleEnvironment,
      HX_ENVIRONMENT: 'local',
      SERVICE_ROLE: component,
      DATABASE_URL: url.toString(),
      HX_RUNTIME_DATABASE_NAME: expectedTarget.databaseName,
      HX_RUNTIME_DATABASE_HOST: expectedTarget.hostname,
      HX_RUNTIME_DATABASE_PORT: String(expectedTarget.port),
      HX_RUNTIME_DATABASE_SERVER_ADDRESS: expectedTarget.serverAddress,
      HX_RUNTIME_DATABASE_TLS_MODE: 'disable',
      HX_RUNTIME_DATABASE_CHANNEL_BINDING: 'disabled',
      DB_POOL_MAX: '1',
      DB_CONNECT_TIMEOUT_MS: '3000',
      HX_PAYMENT_CREATION_MODE: 'frozen',
    };
  };
  beforeAll(async () => {
    const source = new URL(process.env.DATABASE_URL ?? '');
    if (
      !['postgres:', 'postgresql:'].includes(source.protocol) ||
      source.hostname !== '127.0.0.1' ||
      source.port !== '5432' ||
      source.username !== 'hx_ci_runner' ||
      source.search ||
      source.hash ||
      !/^\/hx_ci_(?:admin|invariant|system)_test$/u.test(source.pathname)
    )
      throw Error('EXACT_LOCAL_ADMIN_REQUIRED');
    source.pathname = '/hx_ci_admin_test';
    root = new pg.Client({ connectionString: source.toString() });
    await root.connect();
    for (const [key, name] of Object.entries(roles)) {
      const login = ['migrationRole', 'apiRole', 'workerRole', 'attesterRole'].includes(key);
      await root.query(`CREATE ROLE ${quote(name)} ${login ? `LOGIN PASSWORD '${password}'` : 'NOLOGIN'}
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
      created.push(name);
    }
    fixture = await createUniversalV1DisposableDatabase({
      throughFinancialMigration:
        '20261016_universal_v1_fake_financial_command_outbox_authority_v13',
      bootstrapOwnerRole: roles.commandOwnerRole,
      canonicalMigrationLedger: true,
    });
    const observed = (
      await fixture.pool
        .query(`SELECT current_database() AS database,host(inet_server_addr()) AS address,
      inet_server_port() AS port,current_setting('server_version_num')::integer AS version`)
    ).rows[0];
    if (
      observed.address !== '172.17.0.2' ||
      observed.port !== 5432 ||
      observed.version < 160000 ||
      observed.version >= 170000
    )
      throw Error('EXACT_LOCAL_PG16_REQUIRED');
    expectedTarget = {
      environment: 'local',
      databaseName: observed.database,
      hostname: '127.0.0.1',
      port: 5432,
      serverAddress: observed.address,
      tlsMode: 'disable',
      channelBinding: 'disabled',
    };
    manifest = (await createLocalFinancialReadinessAuthority()).manifest;
    const databaseTargetFor = <C extends 'api' | 'worker' | 'attester'>(component: C) => ({
      component,
      environment: 'local' as const,
      databaseTargetDigest: runtimeDatabaseTargetDigest({
        ...expectedTarget,
        component,
        serviceLogin: roles[`${component}Role`],
        roleTopologyDigest: runtimeDatabaseRoleTopologyDigest(roles),
      }),
    });
    manifest.databaseTargets = {
      api: databaseTargetFor('api'),
      worker: databaseTargetFor('worker'),
      attester: databaseTargetFor('attester'),
    };
    const pair = generateKeyPairSync('ed25519');
    const digest = releaseManifestDigest(manifest);
    const signature = sign(
      null,
      releaseManifestSignaturePayload(digest, manifest.version),
      pair.privateKey
    ).toString('base64');
    directory = await mkdtemp(join(tmpdir(), 'hx-guarded-readiness-'));
    manifestPath = join(directory, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest));
    release = readReleaseManifest(manifestPath, {
      signatureRaw: JSON.stringify({
        version: 1,
        algorithm: 'ed25519',
        keyId,
        manifestDigest: digest,
        signature,
      }),
      signatureSource: 'ephemeral-pg-test-signature',
      trustedPublicKeys: {
        [keyId]: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      },
    });
    expect(release).toMatchObject({
      status: 'valid',
      digest,
      authentication: { status: 'verified', keyId },
    });
    expect(PINNED_RELEASE_AUTHORITY_PUBLIC_KEYS).not.toHaveProperty(keyId);
    await fixture.pool.query(
      `INSERT INTO hx_authority.universal_v1_work_order_target_authority_facts(
      authority_version,target_database_name,environment,release_manifest_sha256,activation_request_sha256)
      VALUES(1,current_database(),'local',$1,$2)`,
      [release.digest, 'c'.repeat(64)]
    );
    await fixture.pool.query(
      `INSERT INTO public.hxos_nonproduction_bootstrap_completion_v1(
      release_manifest_digest,migration_artifact_digest,release_id,release_environment,required_migration_count,
      financial_migration_status,completed_at) VALUES($1,$2,$3,'local',$4,'applied','2026-09-05T00:00:00Z')`,
      [
        release.digest,
        manifest.components.migration.artifactDigest,
        manifest.releaseId,
        REQUIRED_MIGRATION_FILES.length,
      ]
    );
    const admin = await fixture.pool.connect();
    try {
      await provisionUniversalV1SyntheticRoles(admin, expectedTarget.databaseName, roles);
      await provisionFinancialReadinessCustody(admin, roles);
    } finally {
      admin.release();
    }
  }, 120_000);
  afterAll(async () => {
    try {
      if (fixture) await fixture.close();
    } finally {
      try {
        if (root) {
          for (const name of created) await root.query('DROP ROLE ' + quote(name));
        }
      } finally {
        if (root) await root.end();
        if (manifestPath) await unlink(manifestPath);
        if (directory) await rmdir(directory);
      }
    }
  }, 30_000);
  async function openPlane(component: Component) {
    const configured = configuredRuntimeDatabaseStartup(component, environmentFor(component));
    const authority = composeRuntimeDatabaseReleaseAuthorityKernelForTest(
      release,
      component,
      identityFor(component)
    );
    const adapter = createPgRuntimeDatabaseAuthorityAdapter({
      primaryDatabaseUrl: configured.primaryDatabaseUrl,
      target: configured.target,
      poolConfig: configured.poolConfig,
    });
    try {
      const capability = await attestRuntimeDatabaseAuthority(
        {
          component,
          primaryDatabaseUrl: configured.primaryDatabaseUrl,
          replicaDatabaseUrl: configured.replicaDatabaseUrl,
          expectedTarget: configured.expectedTarget,
          expectedTargetDigest: authority.databaseTargetDigest,
          roleTopology: configured.roleTopology,
          releasePins: authority.releasePins,
        },
        adapter,
        authority.verifier
      );
      return createRuntimeDatabaseDataPlane({
        primaryDatabaseUrl: configured.primaryDatabaseUrl,
        target: configured.target,
        adapter,
        capability,
      });
    } catch (error) {
      await adapter.close();
      throw error;
    }
  }
  const databaseFor = (
    plane: RuntimeDatabaseDataPlane
  ): NonproductionFinancialReadinessDatabase => ({
    readOnlyAttestationTransaction: (fn) =>
      plane.readOnlyAttestationTransaction((query) =>
        fn(async <Row>(sql: string, values?: unknown[]) => {
          const result = await query(sql, values);
          return { rows: result.rows as Row[], rowCount: result.rowCount };
        })
      ),
  });
  const readiness = (plane: RuntimeDatabaseDataPlane, component: Component) =>
    readNonproductionFinancialBootstrapReadiness({
      component: component === 'api' ? 'backend' : 'worker',
      environment: 'local',
      env: environmentFor(component),
      release,
      identity: identityFor(component),
      database: databaseFor(plane),
    });
  const log = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  for (const component of ['api', 'worker'] as const) {
    it(
      'runs actual ' +
        component +
        ' startup migration checks and financial readiness through the guarded pool',
      async () => {
        const plane = await openPlane(component);
        try {
          const query: QueryFn = async <Row>(sql: string, params?: unknown[]) => {
            const result = await plane.readQuery(sql, params);
            return { rows: result.rows as Row[], rowCount: result.rowCount };
          };
          await runStartupMigrations(log, productionStartupMigrationRuntime(query));
          expect(await readiness(plane, component)).toMatchObject({
            ready: true,
            status: 'ready',
            releaseManifestDigest: release.digest,
          });
          const identity = await plane.readQuery(
            'SELECT current_user AS role,session_user AS session_role'
          );
          expect(identity.rows).toEqual([
            { role: roles[`${component}Role`], session_role: roles[`${component}Role`] },
          ]);
          await expect(
            plane.query('INSERT INTO public.escrows DEFAULT VALUES')
          ).rejects.toMatchObject({ code: '42501' });
          expect(await readiness(plane, component)).toMatchObject({ ready: true, status: 'ready' });
        } finally {
          await plane.close();
        }
      },
      30_000
    );
    it(
      're-attests ' + component + ' after physical pool shutdown',
      async () => {
        const first = await openPlane(component);
        const oldPid = (await first.readQuery('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        await first.close();
        await expect(first.readQuery('SELECT 1')).rejects.toMatchObject({
          code: 'DATA_PLANE_CLOSED',
        });
        const replacement = await openPlane(component);
        try {
          expect(
            (await replacement.readQuery('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
          ).not.toBe(oldPid);
          expect(await readiness(replacement, component)).toMatchObject({
            ready: true,
            status: 'ready',
          });
        } finally {
          await replacement.close();
        }
      },
      30_000
    );
    it(
      'rejects ' + component + ' custody drift after connection attestation',
      async () => {
        const plane = await openPlane(component);
        try {
          await fixture.pool.query(
            'GRANT SELECT(id) ON public.escrows TO ' + quote(roles[`${component}Role`])
          );
          try {
            expect(await readiness(plane, component)).toMatchObject({
              ready: false,
              status: 'database_authority_violation',
            });
          } finally {
            await fixture.pool.query(
              'REVOKE SELECT(id) ON public.escrows FROM ' + quote(roles[`${component}Role`])
            );
          }
          expect(await readiness(plane, component)).toMatchObject({ ready: true, status: 'ready' });
        } finally {
          await plane.close();
        }
      },
      30_000
    );
  }
  it('refuses the ephemeral test signer at the normal process composition boundary', () => {
    expect(() => composeRuntimeDatabaseReleaseAuthority(release, 'api')).toThrow(
      'SIGNING_AUTHORITY_INVALID'
    );
  });
  it('blocks old API/worker capabilities after target rollover and requires fresh attestation', async () => {
    const planes: RuntimeDatabaseDataPlane[] = [];
    try {
      for (const component of ['api', 'worker'] as const) planes.push(await openPlane(component));
      const previous = (
        await fixture.pool.query(
          'SELECT target_authority_id FROM hx_authority.universal_v1_work_order_target_authority_facts WHERE authority_version=1'
        )
      ).rows[0];
      await fixture.pool.query(
        `INSERT INTO hx_authority.universal_v1_work_order_target_authority_facts(
        authority_version,supersedes_target_authority_id,target_database_name,environment,release_manifest_sha256,activation_request_sha256)
        VALUES(2,$1,current_database(),'local',$2,$3)`,
        [previous.target_authority_id, release.digest, 'd'.repeat(64)]
      );
      for (const [index, component] of (['api', 'worker'] as const).entries()) {
        let entered = false;
        await expect(
          planes[index]!.readOnlyAttestationTransaction(async () => {
            entered = true;
          })
        ).rejects.toMatchObject({ code: 'LIVE_TARGET_BLOCKED' });
        expect(entered).toBe(false);
        expect(await readiness(planes[index]!, component)).toMatchObject({
          ready: false,
          status: 'attestation_unavailable',
        });
        const replacement = await openPlane(component);
        try {
          expect(await readiness(replacement, component)).toMatchObject({
            ready: true,
            status: 'ready',
          });
        } finally {
          await replacement.close();
        }
      }
    } finally {
      for (const plane of planes) await plane.close();
    }
  }, 30_000);
});
