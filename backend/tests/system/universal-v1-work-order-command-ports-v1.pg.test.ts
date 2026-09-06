import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';
import { CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES } from '../../src/jobs/nonproduction-fake-financial-execution.js';
import type { Database, QueryFn } from '../../src/db.js';
import {
  submitUniversalV1TaskDraft,
  type TaskDraftIngressDependencies,
  type TaskDraftIngressInput,
} from '../../src/routers/web/taskDrafts.js';
import {
  claimUniversalV1TaskDraft,
  type UniversalV1TaskDraftClaimDependencies,
} from '../../src/services/UniversalV1TaskDraftClaim.js';
import type {
  AcceptUniversalV1ProviderEstimate,
  SubmitUniversalV1ProviderEstimate,
} from '../../src/services/UniversalV1EstimateContracts.js';
import { PostgresUniversalV1EstimateRepository } from '../../src/services/UniversalV1EstimatePostgresRepository.js';
import { UniversalV1EstimateService } from '../../src/services/UniversalV1EstimateService.js';
import { UniversalV1WorkOrderApplication } from '../../src/services/UniversalV1WorkOrderApplication.js';
import {
  deterministicUuid,
  PostgresUniversalV1WorkOrderRepository,
} from '../../src/services/UniversalV1WorkOrderPostgresRepository.js';
import { PostgresUniversalV1WorkOrderPublicFactReader } from '../../src/services/UniversalV1WorkOrderPublicFacts.js';
import {
  PostgresUniversalV1FinancialLifecycleRepository,
  UniversalV1FakeFinancialApplicationService,
} from '../../src/services/payment/UniversalV1FinancialApplicationService.js';
import {
  FakeFinancialProvider,
  PostgresFakeFinancialOperationRepository,
} from '../../src/services/payment/FakeFinancialProvider.js';
import { PostgresFinancialProviderCommandJournal } from '../../src/services/payment/FinancialProviderCommandJournal.js';
import {
  DurableFakeFinancialProviderCommandCoordinator,
  PostgresFinancialProviderCommandRecoveryRepository,
} from '../../src/services/payment/FinancialProviderCommandRecovery.js';
import { PostgresUniversalV1PreparedFinancialCommandAuthority } from '../../src/services/payment/PreparedFinancialCommandAuthority.js';
import { executeUniversalV1WorkOrderCompensation } from '../../src/jobs/universal-v1-work-order-compensation-worker.js';
import type {
  UniversalV1ActorAttestationHandle,
  UniversalV1ActorCommand,
} from '../../src/auth/universal-v1-actor-attestation-contracts.js';
import { UNIVERSAL_V1_ACTOR_ATTESTATION_PATH } from '../../src/auth/universal-v1-actor-attestation-contracts.js';
import {
  createUniversalV1ActorAttestationHandle,
  PostgresUniversalV1CanonicalRequestAuthority,
  UniversalV1ActorAttesterClient,
} from '../../src/services/UniversalV1ActorAttesterClient.js';
import { createUniversalV1ActorAttesterApp } from '../../src/services/UniversalV1ActorAttesterService.js';
import { PostgresUniversalV1ActorAssertionIssuer } from '../../src/services/UniversalV1ActorAssertionIssuer.js';
import {
  ensureUniversalV1SyntheticServiceCell,
  SYNTHETIC_SERVICE_CELL_POSTAL_CODE,
  SYNTHETIC_SERVICE_CELL_REGION_CODE,
} from '../helpers/universal-v1-service-cell-authority.js';
import {
  createWorkOrderCommandAuthorityTransaction,
  verifyWorkOrderCommandAuthority,
  WORK_ORDER_AUTHORITY_FUNCTIONS,
  WORK_ORDER_CORE_SHA_TRANSITIVE_DEPENDENCY_FUNCTIONS,
  WORK_ORDER_CORE_SHA_TRANSITIVE_TRIGGER_FUNCTIONS,
  WORK_ORDER_FINANCE_TRIGGER_FUNCTIONS,
  WORK_ORDER_RUNTIME_AUTHORITY_FUNCTION,
  WORK_ORDER_TELEMETRY_ENVIRONMENT_FUNCTION,
  WORK_ORDER_TELEMETRY_FUNCTIONS,
  WORK_ORDER_TARGET_ACTIVATION_FUNCTION,
  WORK_ORDER_TRIGGER_RELATIONS,
  type WorkOrderCommandAuthorityReport,
} from '../../src/jobs/work-order-command-role-authority.js';

const configuredDatabaseUrl = process.env.DATABASE_URL?.trim() ?? '';
const describePg = describe.sequential.skipIf(configuredDatabaseUrl.length === 0);
const suffix = process.pid.toString();
const proofDatabase = `hx_ci_work_order_ports_${suffix}_test`;
const legacyProofDatabase = `hx_ci_work_order_legacy_${suffix}_test`;
const roles = {
  migrationRole: `hx_ci_wo_migration_${suffix}`,
  apiRole: `hx_ci_wo_api_${suffix}`,
  workerRole: `hx_ci_wo_worker_${suffix}`,
  attesterRole: `hx_ci_wo_attester_${suffix}`,
  commandOwnerRole: `hx_ci_wo_command_${suffix}`,
  assertionOwnerRole: `hx_ci_wo_assertion_${suffix}`,
  financeOwnerRole: `hx_ci_wo_finance_${suffix}`,
  telemetryOwnerRole: `hx_ci_wo_telemetry_${suffix}`,
} as const;
const rogueRole = `hx_ci_wo_rogue_${suffix}`;
const passwords = {
  migrationRole: `hx-ci-wo-migration-${suffix}`,
  apiRole: `hx-ci-wo-api-${suffix}`,
  workerRole: `hx-ci-wo-worker-${suffix}`,
  attesterRole: `hx-ci-wo-attester-${suffix}`,
} as const;
const migrationName = '20261014_universal_v1_work_order_command_ports_v1';
// The fake-provider chain remains supplemental. Canonical bootstrap applies
// ordinal146 first, then the exact v1-v11 facts, then the v12 authority
// normalizer, then the exact predecessor-hash seal. A pinned legacy upgrade
// proof covers the historical inverse order without making it normal.
const fakeFinancialV12Migration = CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES.find(
  (entry) =>
    entry.name ===
    '20261015_universal_v1_work_order_fake_financial_authority_hardening_v12'
)!;
const workOrderBootstrapSealMigration = CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES.find(
  (entry) => entry.name === '20261015_universal_v1_work_order_bootstrap_seal_v1'
)!;
const fakeFinancialV12Index = CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES.indexOf(
  fakeFinancialV12Migration
);
const fakeFinancialV1ToV11Migrations = CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES.slice(
  0,
  fakeFinancialV12Index
);
const releaseManifestSha256 = `sha256:${'a'.repeat(64)}`;
const canonicalUserId = 'fb100000-0000-4000-8000-000000000001';
const verifiedSubject = 'firebase:synthetic-work-order-port-1';
const roleAuthorityEnvironment = {
  HX_WORK_ORDER_MIGRATION_DATABASE_ROLE: roles.migrationRole,
  HX_WORK_ORDER_API_DATABASE_ROLE: roles.apiRole,
  HX_WORK_ORDER_WORKER_DATABASE_ROLE: roles.workerRole,
  HX_WORK_ORDER_ATTESTER_DATABASE_ROLE: roles.attesterRole,
  HX_WORK_ORDER_COMMAND_OWNER_DATABASE_ROLE: roles.commandOwnerRole,
  HX_WORK_ORDER_ASSERTION_OWNER_DATABASE_ROLE: roles.assertionOwnerRole,
  HX_FINANCE_COMMAND_OWNER_DATABASE_ROLE: roles.financeOwnerRole,
  HX_TELEMETRY_OWNER_DATABASE_ROLE: roles.telemetryOwnerRole,
};

let adminClient: pg.Client | null = null;
let databaseClient: pg.Client | null = null;
let migrationClient: pg.Client | null = null;
let apiClient: pg.Client | null = null;
let workerClient: pg.Client | null = null;
let attesterClient: pg.Client | null = null;
let migrationSql = '';
let v12MigrationSql = '';
let bootstrapSealMigrationSql = '';
let actorClientTimestamp = '';
let actorRequestSha256 = '';

function safeIdentifier(value: string): string {
  if (!/^hx_ci_[a-z0-9_]+$/u.test(value) || value.length > 63) {
    throw new Error(`Unsafe disposable PostgreSQL identifier: ${value}`);
  }
  return value;
}

function quote(value: string): string {
  return `"${safeIdentifier(value)}"`;
}

function adminDatabaseUrl(): string {
  const parsed = new URL(configuredDatabaseUrl);
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== '5432' ||
    parsed.username !== 'hx_ci_runner' ||
    !/^\/hx_ci_(?:admin|invariant|system)_test$/u.test(parsed.pathname) ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('Work Order port proof requires the exact loopback-only hx_ci_* PG16 runner');
  }
  parsed.pathname = '/hx_ci_admin_test';
  return parsed.toString();
}

function databaseUrlFor(
  databaseName: string,
  username?: string,
  password?: string
): string {
  const parsed = new URL(adminDatabaseUrl());
  parsed.pathname = `/${safeIdentifier(databaseName)}`;
  if (username !== undefined) parsed.username = safeIdentifier(username);
  if (password !== undefined) parsed.password = password;
  return parsed.toString();
}

function databaseUrl(username?: string, password?: string): string {
  return databaseUrlFor(proofDatabase, username, password);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function token(): string {
  return randomBytes(32).toString('hex');
}

async function cleanup(): Promise<void> {
  const client = adminClient ?? new pg.Client({ connectionString: adminDatabaseUrl() });
  const ownsClient = adminClient === null;
  if (ownsClient) await client.connect();
  try {
    for (const databaseName of [proofDatabase, legacyProofDatabase]) {
      await client.query(
        `SELECT pg_catalog.pg_terminate_backend(pid)
           FROM pg_catalog.pg_stat_activity
          WHERE datname = $1 AND pid <> pg_catalog.pg_backend_pid()`,
        [databaseName]
      );
      await client.query(`DROP DATABASE IF EXISTS ${quote(databaseName)}`);
    }
    for (const role of Object.values(roles)) {
      await client.query(`DROP ROLE IF EXISTS ${quote(role)}`);
    }
    await client.query(`DROP ROLE IF EXISTS ${quote(rogueRole)}`);
  } finally {
    if (ownsClient) await client.end();
  }
}

async function applyRegisteredMigration(
  client: pg.Client,
  registration: { readonly name: string; readonly fileName: string }
): Promise<void> {
  const sql = await readFile(
    new URL(`../../database/migrations/${registration.fileName}`, import.meta.url),
    'utf8'
  );
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query(`INSERT INTO public.applied_migrations(name, sha256) VALUES ($1, $2)`, [
      registration.name,
      sha256(sql),
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function applySupplementalMigration(
  client: pg.Client,
  registration: {
    readonly name: string;
    readonly fileName: string;
    readonly evidenceTable: string;
  }
): Promise<string> {
  const sql = await readFile(
    new URL(`../../database/migrations/${registration.fileName}`, import.meta.url),
    'utf8'
  );
  const migrationSha256 = sha256(sql);
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query(
      `INSERT INTO public.${registration.evidenceTable}(
         migration_name, migration_sql_sha256
       ) VALUES ($1, $2)`,
      [registration.name, migrationSha256]
    );
    await client.query(`INSERT INTO public.applied_migrations(name, sha256) VALUES ($1, $2)`, [
      registration.name,
      migrationSha256,
    ]);
    await client.query('COMMIT');
    return sql;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function migrationTriggerCatalog(client: pg.Client): Promise<{
  trigger_count: number;
  trigger_catalog_sha256: string;
}> {
  const result = await client.query<{
    trigger_count: number;
    trigger_catalog_sha256: string;
  }>(
    `WITH trigger_rows AS (
       SELECT pg_catalog.format('%I.%I', relation_namespace.nspname, relation_state.relname)
                || '|' || trigger_state.tgname
                || '|' || pg_catalog.format(
                     '%I.%I(%s)', function_namespace.nspname, function_state.proname,
                     pg_catalog.oidvectortypes(function_state.proargtypes)
                   )
                || '|' || pg_catalog.pg_get_triggerdef(trigger_state.oid, false)
                || '|' || trigger_state.tgenabled::TEXT
                || '|' || function_state.prolang::pg_catalog.regproc::TEXT
                || '|' || function_state.prokind::TEXT
                || '|' || function_state.prorettype::pg_catalog.regtype::TEXT
                || '|' || function_state.prosecdef::TEXT
                || '|' || function_state.proisstrict::TEXT
                || '|' || function_state.proleakproof::TEXT
                || '|' || function_state.provolatile::TEXT
                || '|' || function_state.proparallel::TEXT
                || '|' || function_state.prosrc AS line
         FROM pg_catalog.pg_trigger trigger_state
         JOIN pg_catalog.pg_class relation_state
           ON relation_state.oid = trigger_state.tgrelid
         JOIN pg_catalog.pg_namespace relation_namespace
           ON relation_namespace.oid = relation_state.relnamespace
         JOIN pg_catalog.pg_proc function_state
           ON function_state.oid = trigger_state.tgfoid
         JOIN pg_catalog.pg_namespace function_namespace
           ON function_namespace.oid = function_state.pronamespace
        WHERE trigger_state.tgisinternal IS FALSE
          AND pg_catalog.format('%I.%I', relation_namespace.nspname, relation_state.relname)
                = ANY($1::TEXT[])
     )
     SELECT pg_catalog.count(*)::INTEGER AS trigger_count,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
              COALESCE(pg_catalog.string_agg(line, E'\\n' ORDER BY line), ''),
              'UTF8'
            )), 'hex') AS trigger_catalog_sha256
       FROM trigger_rows`,
    [[...WORK_ORDER_TRIGGER_RELATIONS]]
  );
  return result.rows[0]!;
}

async function migrationFunctionCatalog(client: pg.Client): Promise<readonly unknown[]> {
  const result = await client.query(
    `WITH target_functions AS (
       SELECT pg_catalog.to_regprocedure(identity)::OID AS function_oid
         FROM pg_catalog.unnest($1::TEXT[]) identity
       UNION
       SELECT DISTINCT trigger_state.tgfoid
         FROM pg_catalog.pg_trigger trigger_state
         JOIN pg_catalog.pg_class relation_state
           ON relation_state.oid = trigger_state.tgrelid
         JOIN pg_catalog.pg_namespace namespace_state
           ON namespace_state.oid = relation_state.relnamespace
        WHERE trigger_state.tgisinternal IS FALSE
          AND pg_catalog.format('%I.%I', namespace_state.nspname, relation_state.relname)
                = ANY($2::TEXT[])
     )
     SELECT pg_catalog.format(
              '%I.%I(%s)', namespace_state.nspname, function_state.proname,
              pg_catalog.oidvectortypes(function_state.proargtypes)
            ) AS function_identity,
            owner.rolname AS owner_role,
            function_state.prolang::pg_catalog.regproc::TEXT AS language,
            function_state.prokind::TEXT AS kind,
            function_state.prorettype::pg_catalog.regtype::TEXT AS return_type,
            function_state.prosecdef AS security_definer,
            function_state.proisstrict AS is_strict,
            function_state.proleakproof AS leakproof,
            function_state.provolatile::TEXT AS volatility,
            function_state.proparallel::TEXT AS parallel_safety,
            COALESCE(function_state.proconfig, ARRAY[]::TEXT[]) AS configuration,
            COALESCE(function_state.proacl::TEXT, '') AS acl,
            pg_catalog.pg_get_functiondef(function_state.oid) AS definition
       FROM target_functions target
       JOIN pg_catalog.pg_proc function_state ON function_state.oid = target.function_oid
       JOIN pg_catalog.pg_namespace namespace_state
         ON namespace_state.oid = function_state.pronamespace
       JOIN pg_catalog.pg_roles owner ON owner.oid = function_state.proowner
      ORDER BY function_identity`,
    [[...WORK_ORDER_AUTHORITY_FUNCTIONS], [...WORK_ORDER_TRIGGER_RELATIONS]]
  );
  return result.rows;
}

async function refusal(operation: () => Promise<unknown>, expected: RegExp): Promise<void> {
  try {
    await operation();
    throw new Error('Expected PostgreSQL refusal');
  } catch (error) {
    expect((error as Error).message).toMatch(expected);
  }
}

async function transactionalRefusal(
  client: pg.Client,
  begin: 'BEGIN ISOLATION LEVEL SERIALIZABLE' | 'BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY',
  operation: () => Promise<unknown>,
  expected: RegExp
): Promise<void> {
  await client.query(begin);
  try {
    await refusal(operation, expected);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
  }
}

async function serializableResult<Row extends pg.QueryResultRow>(
  client: pg.Client,
  operation: () => Promise<pg.QueryResult<Row>>
): Promise<pg.QueryResult<Row>> {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  let committed = false;
  try {
    const result = await operation();
    await client.query('COMMIT');
    committed = true;
    return result;
  } finally {
    if (!committed) await client.query('ROLLBACK').catch(() => undefined);
  }
}

function authFacts(subject = verifiedSubject): Record<string, unknown> {
  const now = Date.now();
  return {
    schema_version: 1,
    verified_subject: subject,
    issuer: 'https://securetoken.google.com/hustlexp-synthetic',
    audience: 'hustlexp-synthetic',
    release_manifest_sha256: releaseManifestSha256,
    verified_at: new Date(now - 100).toISOString(),
    bearer_expires_at: new Date(now + 50_000).toISOString(),
    auth_time: new Date(now - 10_000).toISOString(),
    revocation_checked_at: new Date(now - 50).toISOString(),
    amr: ['password'],
    mfa_verified: false,
    step_up: { satisfied: false, method: null, verified_at: null },
  };
}

function clientDatabase(client: pg.Client): Database {
  const query: QueryFn = async <Row = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ) => {
    const result = await client.query(sql, params);
    return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
  };
  const transaction = async <T>(
    isolation: '' | ' ISOLATION LEVEL SERIALIZABLE',
    callback: (query: QueryFn) => Promise<T>
  ): Promise<T> => {
    await client.query(`BEGIN${isolation}`);
    try {
      const result = await callback(query);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  };
  return {
    query,
    readQuery: query,
    transaction: (callback) => transaction('', callback),
    serializableTransaction: (callback) =>
      transaction(' ISOLATION LEVEL SERIALIZABLE', callback),
    healthCheck: async () => ({ connected: true, schemaVersion: null, latencyMs: 0 }),
    getPool: () => {
      throw new Error('Disposable client has no pool');
    },
    getPoolStats: () => ({
      totalConnections: 1,
      idleConnections: 0,
      waitingRequests: 0,
      maxConnections: 1,
      utilizationPercent: 100,
      replicaConnections: null,
    }),
    close: async () => undefined,
  };
}

interface AcceptedWorkOrderLane {
  readonly posterUserId: string;
  readonly providerUserId: string;
  readonly draftId: string;
  readonly taskId: string;
  readonly scopeVersion: number;
  readonly scopeVersionId: string;
}

describePg('Universal V1 PostgreSQL Work Order command ports v1', () => {
  function superDatabase(): Database {
    if (!databaseClient) throw new Error('Disposable owner database is unavailable');
    return clientDatabase(databaseClient);
  }

  function exactApiDatabase(client: pg.Client | null = apiClient): Database {
    if (!client) throw new Error('Disposable exact API database is unavailable');
    return clientDatabase(client);
  }

  function authorityTransaction(client: pg.Client) {
    const database = clientDatabase(client);
    return createWorkOrderCommandAuthorityTransaction(async () => ({
      query: database.query,
      release: () => undefined,
    }));
  }

  function fakeFinance(): UniversalV1FakeFinancialApplicationService {
    const database = superDatabase();
    const events = new PostgresFakeFinancialOperationRepository(database);
    return new UniversalV1FakeFinancialApplicationService(
      new FakeFinancialProvider(events),
      new PostgresUniversalV1FinancialLifecycleRepository(database),
      { assertAuthorized: () => undefined },
      new PostgresFinancialProviderCommandJournal(database),
      new PostgresUniversalV1PreparedFinancialCommandAuthority(database),
      new DurableFakeFinancialProviderCommandCoordinator(
        new PostgresFinancialProviderCommandRecoveryRepository(database),
        events,
        { leaseOwnerId: randomUUID() }
      )
    );
  }

  async function actorAttestation(
    actorUserId: string
  ): Promise<UniversalV1ActorAttestationHandle> {
    const identity = await databaseClient!.query<{ firebase_uid: string }>(
      `SELECT firebase_uid FROM public.users WHERE id = $1`,
      [actorUserId]
    );
    const subject = identity.rows[0]?.firebase_uid;
    if (!subject) throw new Error('Exact actor fixture has no canonical subject');
    return Object.freeze({
      issue: async (command: UniversalV1ActorCommand) => {
        const canonical = await databaseClient!.query<{ actor_request_sha256: string }>(
          `SELECT actor_request_sha256
             FROM hx_authority.build_universal_v1_work_order_command_request_v1(
               $1, $2::JSONB
             )`,
          [command.commandKind, JSON.stringify(command.commandPayload)]
        );
        const opaqueToken = token();
        const digest = canonical.rows[0]!.actor_request_sha256;
        const expiry = new Date(Date.now() + 45_000);
        await attesterClient!.query(
          `SELECT * FROM public.hxos_issue_universal_v1_actor_assertion_v1(
             $1, 'local', $2, $3, $4::JSONB, $5
           )`,
          [opaqueToken, command.commandKind, digest, JSON.stringify(authFacts(subject)), expiry]
        );
        return {
          schema_version: 1 as const,
          command_kind: command.commandKind,
          canonical_request_sha256: digest,
          actor_assertion_token: opaqueToken,
          assertion_expires_at: expiry.toISOString(),
        };
      },
    });
  }

  async function realActorAttestation(
    actorUserId: string
  ): Promise<UniversalV1ActorAttestationHandle> {
    const identity = await databaseClient!.query<{ firebase_uid: string }>(
      `SELECT firebase_uid FROM public.users WHERE id = $1`,
      [actorUserId]
    );
    const subject = identity.rows[0]?.firebase_uid;
    if (!subject) throw new Error('Exact actor fixture has no canonical subject');

    const clock = new Date();
    const transportSecret = 'work-order-real-attester-transport-secret-v1';
    const bearer = `real.firebase.bearer.${subject}`;
    const releaseBinding = () => ({
      environment: 'local' as const,
      releaseManifestSha256,
      backendRevision: 'c'.repeat(40),
      backendArtifactSha256: `sha256:${'d'.repeat(64)}`,
    });
    const attesterEnvironment = {
      HX_ENVIRONMENT: 'local',
      SERVICE_ROLE: 'attester',
      HX_PAYMENT_CREATION_MODE: 'frozen',
      STRIPE_MODE: 'test',
      ENGINE_API_MODE: 'test',
      HX_EXTERNAL_VALUE: 'false',
      HX_ACTOR_ATTESTER_TRANSPORT_SECRET: transportSecret,
      HX_WORK_ORDER_ATTESTER_DATABASE_ROLE: roles.attesterRole,
    };
    const issuer = new PostgresUniversalV1ActorAssertionIssuer({
      env: attesterEnvironment,
      query: async <Row>(sql: string, parameters?: readonly unknown[]) => {
        const result = await attesterClient!.query(sql, [...(parameters ?? [])]);
        return { rows: result.rows as Row[], rowCount: result.rowCount };
      },
    });
    const app = createUniversalV1ActorAttesterApp({
      env: attesterEnvironment,
      releaseBinding,
      verifyBearer: async (candidate) => {
        if (candidate !== bearer) throw new Error('Unexpected exact actor bearer');
        return {
          verifiedSubject: subject,
          issuer: 'https://securetoken.google.com/hustlexp-work-order-test',
          audience: 'hustlexp-work-order-test',
          authenticationTime: new Date(clock.getTime() - 10_000),
          bearerExpiresAt: new Date(clock.getTime() + 120_000),
          verifiedAt: clock,
          revocationCheckedAt: clock,
          authenticationMethods: ['password'],
          mfaVerified: false,
        };
      },
      issuer,
      now: () => clock,
    });
    const client = new UniversalV1ActorAttesterClient({
      env: {
        HX_ACTOR_ATTESTER_URL:
          `http://127.0.0.1:3002${UNIVERSAL_V1_ACTOR_ATTESTATION_PATH}`,
        HX_ACTOR_ATTESTER_TIMEOUT_MS: '2000',
        HX_ACTOR_ATTESTER_TRANSPORT_SECRET: transportSecret,
      },
      releaseBinding,
      canonicalAuthority: new PostgresUniversalV1CanonicalRequestAuthority(
        exactApiDatabase().query
      ),
      fetch: async (input, init) => app.fetch(new Request(input, init)),
      now: () => clock,
    });
    return createUniversalV1ActorAttestationHandle(bearer, client);
  }

  async function insertUser(mode: 'poster' | 'worker'): Promise<string> {
    const id = randomUUID();
    await databaseClient!.query(
      `INSERT INTO public.users(
         id, firebase_uid, email, full_name, default_mode, date_of_birth,
         account_status, is_minor, is_banned
       ) VALUES ($1, $2, $3, 'Work Order exact-role fixture', $4,
         DATE '1990-01-01', 'ACTIVE', FALSE, FALSE)`,
      [id, `firebase:${id}`, `${id}@synthetic.invalid`, mode]
    );
    return id;
  }

  async function acceptedWorkOrderLane(label: string): Promise<AcceptedWorkOrderLane> {
    const database = superDatabase();
    const fixtureNow = Date.now();
    await ensureUniversalV1SyntheticServiceCell(databaseClient!);
    const policyDocument = {
      schemaVersion: 'hxos-region-policy-v1',
      categories: {
        yard: {
          allowedRiskLevels: ['LOW', 'MEDIUM'],
          credentials: {
            licenseRequired: false,
            insuranceRequired: false,
            backgroundCheckRequired: false,
          },
          evidence: { proofRequired: true, minPhotos: 1, maxPhotos: 5, gpsRequired: false },
        },
      },
      recording: { allowed: false, standaloneConsentRequired: true },
      workerRights: {
        standaloneScreeningConsentRequired: true,
        reportAccessRequired: true,
        disputeAndAppealRequired: true,
        adverseActionNoticeRequired: true,
      },
      financial: {
        currency: 'usd',
        minimumCustomerCents: 5_000,
        minimumPayoutCents: 4_000,
        minimumMarginCents: 500,
      },
      safety: {
        incidentIntakeRequired: true,
        timedCheckinRiskLevels: ['MEDIUM'],
        checkinIntervalsMinutes: [15, 30, 60],
        locationRetentionDays: 30,
        alternateEmergencyActionRequired: true,
      },
    };
    await databaseClient!.query(
      `WITH policy AS (SELECT $1::JSONB AS document)
       INSERT INTO public.region_policies(
         region_code, version, policy_state, production_enabled, approval_state,
         effective_from, policy_document, policy_hash
       )
       SELECT $2, 'universal-v1-work-order-exact-role-v1', 'ACTIVE', FALSE,
              'COUNSEL_APPROVAL_REQUIRED', pg_catalog.clock_timestamp() - INTERVAL '1 day',
              document, pg_catalog.encode(public.digest(document::TEXT, 'sha256'), 'hex')
         FROM policy
       ON CONFLICT (region_code, version) DO NOTHING`,
      [JSON.stringify(policyDocument), SYNTHETIC_SERVICE_CELL_REGION_CODE]
    );

    const submissionId = randomUUID();
    const cardToken = token();
    const ingressTransaction = <T>(callback: (query: QueryFn) => Promise<T>) =>
      database.transaction(callback);
    const ingressDependencies: Partial<TaskDraftIngressDependencies> = {
      env: {
        NODE_ENV: 'test',
        HX_ENVIRONMENT: 'test',
        HX_HUMAN_VERIFICATION_MODE: 'synthetic',
        HX_HUMAN_VERIFICATION_URL: 'http://127.0.0.1/verify',
        HX_HUMAN_VERIFICATION_SECRET: 'exact-role-fixture-secret-v1',
        PUBLIC_INGRESS_IP_HASH_SALT: 'exact-role-fixture-salt-v1',
        TASK_DRAFT_RATE_LIMIT_PER_IP_HOUR: '1000',
        ALLOWED_ORIGINS: 'http://localhost:5173',
      },
      fetch: async () =>
        new Response(
          JSON.stringify({
            success: true,
            action: 'task',
            hostname: 'synthetic.invalid',
            metadata: { result_with_testing_key: true },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ),
      now: () => fixtureNow,
      randomUuid: randomUUID,
      transaction: ingressTransaction,
    };
    const create: TaskDraftIngressInput = {
      action: 'create',
      submission_id: submissionId,
      expected_version: 0,
      card_token: cardToken,
      raw_input: `Trim shrubs and weed two garden beds (${label})`,
      category: 'yard',
      answers: {
        timing: 'Flexible weekday afternoon',
        access: 'Exterior access',
        scope_confirmed_at: new Date(fixtureNow).toISOString(),
      },
      zip: SYNTHETIC_SERVICE_CELL_POSTAL_CODE,
      region: 'Untrusted location hint',
      photo_count: 0,
      consent_version: 'v1',
      turnstile_token: `synthetic-${randomUUID()}`,
      client_ts: fixtureNow,
    };
    const created = await submitUniversalV1TaskDraft(
      create,
      { ip: '203.0.113.77' },
      ingressDependencies
    );
    if (!created.ok) throw new Error('Exact-role TaskDraft create refused');
    const leadSubmissionId = randomUUID();
    await databaseClient!.query(
      `INSERT INTO public.leads(submission_id, lead_type, email, name, answers, source)
       VALUES ($1, 'poster', $2, 'Exact Role Fixture',
               pg_catalog.jsonb_build_object('task_draft_submission_id', $3::TEXT),
               'required_test')`,
      [leadSubmissionId, `${leadSubmissionId}@synthetic.invalid`, submissionId]
    );
    const linked = await submitUniversalV1TaskDraft(
      {
        ...create,
        action: 'link_contact',
        expected_version: created.version,
        raw_input: 'contact link',
        lead_submission_id: leadSubmissionId,
        turnstile_token: undefined,
      },
      { ip: '203.0.113.77' },
      ingressDependencies
    );
    if (!linked.ok) throw new Error('Exact-role TaskDraft contact link refused');
    const posterUserId = await insertUser('poster');
    const claimDependencies: Partial<UniversalV1TaskDraftClaimDependencies> = {
      now: () => fixtureNow,
      randomUuid: randomUUID,
      transaction: ingressTransaction,
    };
    await claimUniversalV1TaskDraft(
      {
        submission_id: submissionId,
        card_token: cardToken,
        expected_version: 0,
        idempotency_key: `claim:${label}:${submissionId}`,
        client_ts: fixtureNow,
      },
      posterUserId,
      claimDependencies
    );
    const initialRoute = await databaseClient!.query<{
      id: string;
      decision_version: number;
    }>(
      `SELECT route.id, route.decision_version
         FROM public.task_drafts draft
         JOIN public.task_routing_decisions route
           ON route.id = draft.active_routing_decision_id
        WHERE draft.id = $1 AND route.outcome = 'ESTIMATE_REQUIRED'`,
      [linked.draft_id]
    );
    const providerUserId = await insertUser('worker');
    await databaseClient!.query(
      `INSERT INTO public.capability_profiles(user_id, trust_tier, provider_class)
       VALUES ($1, 1, 'GENERAL_SERVICE_PROVIDER')`,
      [providerUserId]
    );
    const operatorUserId = await insertUser('poster');
    await databaseClient!.query(
      `INSERT INTO public.admin_roles(user_id, role, can_manage_operations)
       VALUES ($1, 'support', TRUE)`,
      [operatorUserId]
    );
    const eligibilityId = randomUUID();
    const evidence = {
      work_category_code: 'yard',
      region_code: SYNTHETIC_SERVICE_CELL_REGION_CODE,
      risk_level: 'LOW',
      requires_proof: true,
      rough_location: 'Synthetic XQ service area',
    };
    await databaseClient!.query(
      `INSERT INTO public.task_provider_eligibility_decisions(
         id, task_draft_id, routing_decision_id, decision_version,
         provider_user_id, provider_class, profile_eligible, identity_eligible,
         category_eligible, credential_eligible, geography_eligible,
         availability_eligible, restriction_clear, task_eligible,
         processor_payment_eligible, payout_funding_eligible, trust_tier,
         blocker_codes, policy_version, evidence, decided_by, idempotency_key,
         valid_until
       ) VALUES (
         $1, $2, $3, 1, $4, 'GENERAL_SERVICE_PROVIDER',
         TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, FALSE, FALSE,
         'TIER_1', ARRAY[]::TEXT[], 'universal-v1-exact-role-fixture-v1',
         $5::JSONB, $6, $7, pg_catalog.clock_timestamp() + INTERVAL '15 minutes'
       )`,
      [
        eligibilityId,
        linked.draft_id,
        initialRoute.rows[0]!.id,
        providerUserId,
        JSON.stringify(evidence),
        operatorUserId,
        `eligibility:${label}:${eligibilityId}`,
      ]
    );
    const estimates = new UniversalV1EstimateService(
      new PostgresUniversalV1EstimateRepository(database)
    );
    const invitation = await estimates.issueProviderEstimateInvitation({
      eligibility_decision_id: eligibilityId,
      expected_draft_version: initialRoute.rows[0]!.decision_version,
      expected_eligibility_version: 1,
      actor_user_id: operatorUserId,
      idempotency_key: `invitation:${label}:${eligibilityId}`,
    });
    const submission: SubmitUniversalV1ProviderEstimate = {
      task_draft_id: linked.draft_id,
      routing_decision_id: initialRoute.rows[0]!.id,
      expected_draft_version: initialRoute.rows[0]!.decision_version,
      quote_id: invitation.quote_id,
      expected_quote_version: 0,
      provider: {
        actor_user_id: providerUserId,
        provider_user_id: providerUserId,
        provider_organization_id: null,
      },
      scope: {
        title: 'Trim shrubs and weed beds',
        description: 'Trim bounded shrubs and remove weeds from two garden beds.',
        requirements: null,
        checklist: ['Photograph start', 'Trim shrubs', 'Weed beds', 'Capture evidence'],
        work_category_code: 'yard',
        region_code: SYNTHETIC_SERVICE_CELL_REGION_CODE,
        rough_location: 'Synthetic XQ service area',
        risk_level: 'LOW',
        requires_proof: true,
      },
      line_items: [
        {
          description: 'Yard service labor',
          quantity: 1,
          unit_amount_cents: 10_000,
          total_amount_cents: 10_000,
        },
      ],
      customer_total_cents: 10_000,
      provider_payout_cents: 8_000,
      currency: 'USD',
      idempotency_key: `estimate-submit:${label}:${invitation.quote_id}`,
    };
    const submitted = await estimates.submitProviderEstimate(submission);
    const acceptance: AcceptUniversalV1ProviderEstimate = {
      task_draft_id: linked.draft_id,
      provider_estimate_submission_id: submitted.provider_estimate_submission_id,
      quote_id: invitation.quote_id,
      quote_version_id: submitted.quote_version_id,
      poster_user_id: posterUserId,
      actor_user_id: posterUserId,
      expected_draft_version: initialRoute.rows[0]!.decision_version,
      idempotency_key: `estimate-accept:${label}:${linked.draft_id}`,
    };
    const accepted = await estimates.acceptProviderEstimate(acceptance);
    const scope = await databaseClient!.query<{ version: number }>(
      `SELECT version FROM public.task_scope_versions WHERE id = $1`,
      [accepted.scope_version_id]
    );
    return {
      posterUserId,
      providerUserId,
      draftId: linked.draft_id,
      taskId: accepted.task_id,
      scopeVersion: scope.rows[0]!.version,
      scopeVersionId: accepted.scope_version_id,
    };
  }

  async function heldExactRoleLane(label: string) {
    const lane = await acceptedWorkOrderLane(label);
    const facts = new PostgresUniversalV1WorkOrderPublicFactReader(superDatabase().query);
    const repository = new PostgresUniversalV1WorkOrderRepository(exactApiDatabase());
    const application = new UniversalV1WorkOrderApplication(facts, repository, () => fakeFinance());
    const interestInput = {
      task_id: lane.taskId,
      expected_scope_version: lane.scopeVersion,
      idempotency_key: `exact-role:interest:${label}:${randomUUID()}`,
      client_ts: new Date().toISOString(),
    };
    const interest = await application.expressProviderInterest(
      lane.providerUserId,
      interestInput,
      await actorAttestation(lane.providerUserId)
    );
    const holdInput = {
      interest_application_id: interest.interest_application_id,
      expected_eligibility_version: interest.eligibility_version,
      idempotency_key: `exact-role:hold:${label}:${randomUUID()}`,
      client_ts: new Date().toISOString(),
    };
    const hold = await application.placeConditionalHold(
      lane.posterUserId,
      holdInput,
      await actorAttestation(lane.posterUserId)
    );
    const context = await facts.workOrder(lane.posterUserId, hold.conditional_hold_id);
    if (!context) throw new Error('Exact-role held Work Order context is unavailable');
    return { lane, facts, repository, application, interest, interestInput, hold, holdInput, context };
  }

  async function preparedExactRoleLane(label: string) {
    const held = await heldExactRoleLane(label);
    const input = {
      conditional_hold_id: held.hold.conditional_hold_id,
      expected_eligibility_version: held.interest.eligibility_version,
      idempotency_key: `exact-role:work-order:${label}:${randomUUID()}`,
      client_ts: new Date().toISOString(),
    };
    const attestation = await actorAttestation(held.lane.posterUserId);
    const assertion = await attestation.issue({
      commandKind: 'PREPARE_FAKE_WORK_ORDER',
      commandPayload: {
        conditional_hold_id: input.conditional_hold_id,
        expected_eligibility_version: input.expected_eligibility_version,
        idempotency_key: input.idempotency_key,
        client_timestamp_epoch_ms: Date.parse(input.client_ts),
      },
    });
    const phase = await held.repository.prepareMaterialization(
      held.context,
      input.idempotency_key,
      assertion.actor_assertion_token,
      input.client_ts
    );
    if (phase.completed) throw new Error('Exact-role preparation unexpectedly completed');
    return { ...held, input, phase, attestation };
  }

  async function executeExactFakeSecurityChain(
    prepared: Awaited<ReturnType<typeof preparedExactRoleLane>>,
    secureScenario: 'SUCCESS' | 'DECLINE' = 'SUCCESS'
  ) {
    const finance = fakeFinance();
    const live = prepared.phase.context;
    const base = {
      providerKind: 'FAKE' as const,
      providerExpectedVersion: 0,
      taskDraftId: live.task_draft_id,
      taskId: live.task_id,
      eligibilityDecisionId: live.eligibility_decision_id,
      scopeVersionId: live.scope_version_id,
      recordedBy: prepared.lane.posterUserId,
    };
    const paymentMethod = await finance.executeFinancialEvent({
      ...base,
      operationKind: 'PREPARE_PAYMENT_METHOD',
      operationId: deterministicUuid(prepared.input.idempotency_key, 'prepare'),
      idempotencyKey: `${prepared.input.idempotency_key}:prep`,
      lifecycleExpectedVersion: 0,
      customerId: prepared.lane.posterUserId,
      scenario: 'SUCCESS',
      occurredAt: prepared.phase.occurredAt,
    });
    const authorization = await finance.executeFinancialEvent({
      ...base,
      operationKind: 'AUTHORIZE',
      operationId: deterministicUuid(prepared.input.idempotency_key, 'authorize'),
      idempotencyKey: `${prepared.input.idempotency_key}:auth`,
      lifecycleExpectedVersion: 1,
      predecessorEventId: paymentMethod.id,
      relatedOperationId: paymentMethod.operationId,
      amountCents: Number(live.customer_total_cents),
      currency: live.currency.toLowerCase(),
      paymentMethodReference: paymentMethod.externalReference,
      scenario: 'SUCCESS',
      occurredAt: new Date(Date.parse(prepared.phase.occurredAt) + 1).toISOString(),
    });
    const secured = await finance.executeFinancialEvent({
      ...base,
      operationKind: 'SECURE',
      operationId: deterministicUuid(prepared.input.idempotency_key, 'secure'),
      idempotencyKey: `${prepared.input.idempotency_key}:secure`,
      lifecycleExpectedVersion: 2,
      predecessorEventId: authorization.id,
      relatedOperationId: authorization.operationId,
      amountCents: Number(live.customer_total_cents),
      currency: live.currency.toLowerCase(),
      authorizationOperationId: authorization.operationId,
      scenario: secureScenario,
      occurredAt: new Date(Date.parse(prepared.phase.occurredAt) + 2).toISOString(),
    });
    return { finance, paymentMethod, authorization, secured };
  }

  beforeAll(async () => {
    safeIdentifier(proofDatabase);
    Object.values(roles).forEach(safeIdentifier);
    adminClient = new pg.Client({ connectionString: adminDatabaseUrl() });
    await adminClient.connect();
    await cleanup();
    const version = await adminClient.query<{ version: string }>(
      `SELECT pg_catalog.current_setting('server_version_num') AS version`
    );
    expect(Number(version.rows[0]?.version)).toBeGreaterThanOrEqual(160_000);
    expect(Number(version.rows[0]?.version)).toBeLessThan(170_000);

    for (const [key, role] of Object.entries(roles)) {
      const login =
        key.endsWith('Role') &&
        key !== 'commandOwnerRole' &&
        key !== 'assertionOwnerRole' &&
        key !== 'financeOwnerRole' &&
        key !== 'telemetryOwnerRole';
      const password = passwords[key as keyof typeof passwords];
      await adminClient.query(
        `CREATE ROLE ${quote(role)} ${login ? `LOGIN PASSWORD '${password}'` : 'NOLOGIN'}
           NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`
      );
    }
    await adminClient.query(`CREATE DATABASE ${quote(proofDatabase)} TEMPLATE template0`);
    databaseClient = new pg.Client({ connectionString: databaseUrl() });
    await databaseClient.connect();
    const baseline = await readFile(
      new URL('../../database/constitutional-schema.sql', import.meta.url),
      'utf8'
    );
    await databaseClient.query(baseline);
    await databaseClient.query(
      `CREATE TABLE public.applied_migrations (
         name TEXT PRIMARY KEY,
         sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
         applied_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
       )`
    );
    expect(REQUIRED_MIGRATION_FILES).toHaveLength(146);
    const workOrderPortRegistration = REQUIRED_MIGRATION_FILES.at(-1);
    expect(workOrderPortRegistration?.name).toBe(migrationName);
    migrationSql = await readFile(
      new URL(
        '../../database/migrations/20261014_universal_v1_work_order_command_ports_v1.sql',
        import.meta.url
      ),
      'utf8'
    );
    for (const registration of REQUIRED_MIGRATION_FILES) {
      await applyRegisteredMigration(databaseClient, registration);
    }
    // Engine-only ordinal replay is exact and idempotent. Once the fake surface
    // exists, ordinal replay is intentionally rejected and v12 owns convergence.
    await databaseClient.query(migrationSql);
    await databaseClient.query(migrationSql);

    const commandFactsBeforeBootstrap = await databaseClient.query<{
      assertion_consumption_count: number;
      authority_execution_count: number;
      domain_execution_count: number;
      application_count: number;
      request_count: number;
      reservation_count: number;
      work_order_count: number;
      recovery_count: number;
    }>(
      `SELECT
         (SELECT pg_catalog.count(*)::INTEGER
            FROM hx_authority.universal_v1_actor_assertion_consumption_facts)
              AS assertion_consumption_count,
         (SELECT pg_catalog.count(*)::INTEGER
            FROM hx_authority.universal_v1_work_order_command_execution_facts)
              AS authority_execution_count,
         (SELECT pg_catalog.count(*)::INTEGER
            FROM public.task_work_order_execution_facts) AS domain_execution_count,
         (SELECT pg_catalog.count(*)::INTEGER
            FROM public.task_applications) AS application_count,
         (SELECT pg_catalog.count(*)::INTEGER
            FROM public.task_work_order_command_requests) AS request_count,
         (SELECT pg_catalog.count(*)::INTEGER
            FROM public.task_reservations) AS reservation_count,
         (SELECT pg_catalog.count(*)::INTEGER
            FROM public.task_work_orders) AS work_order_count,
         (SELECT pg_catalog.count(*)::INTEGER
            FROM public.universal_v1_work_order_compensation_commands) AS recovery_count`
    );
    const dummyUuid = '00000000-0000-4000-8000-000000000001';
    await transactionalRefusal(
      databaseClient,
      'BEGIN ISOLATION LEVEL SERIALIZABLE',
      () =>
        databaseClient!.query(
          `SELECT * FROM public.hxos_prepare_universal_v1_fake_work_order_v1(
             $1, $2, 1, 'engine-only-prepare-0001', pg_catalog.clock_timestamp()
           )`,
          ['engine-only-assertion', dummyUuid]
        ),
      /HXUV1-WOCMD-SEAL-0: exact post-v12 Work Order bootstrap seal is required/u
    );
    await transactionalRefusal(
      databaseClient,
      'BEGIN ISOLATION LEVEL SERIALIZABLE',
      () =>
        databaseClient!.query(
          `SELECT * FROM public.hxos_materialize_universal_v1_fake_work_order_v1(
             $1, 'engine-only-materialize-0001', $2, $3
           )`,
          ['engine-only-assertion', '1'.repeat(64), dummyUuid]
        ),
      /HXUV1-WOCMD-SEAL-0: exact post-v12 Work Order bootstrap seal is required/u
    );
    await transactionalRefusal(
      databaseClient,
      'BEGIN ISOLATION LEVEL SERIALIZABLE',
      () =>
        databaseClient!.query(
          `SELECT * FROM public.hxos_request_universal_v1_fake_work_order_recovery_v1(
             $1, 'engine-only-recovery-0001', $2, $3
           )`,
          ['engine-only-assertion', '1'.repeat(64), dummyUuid]
        ),
      /HXUV1-WOCMD-SEAL-0: exact post-v12 Work Order bootstrap seal is required/u
    );
    expect(
      (
        await databaseClient.query(
          `SELECT
             (SELECT pg_catalog.count(*)::INTEGER
                FROM hx_authority.universal_v1_actor_assertion_consumption_facts)
                  AS assertion_consumption_count,
             (SELECT pg_catalog.count(*)::INTEGER
                FROM hx_authority.universal_v1_work_order_command_execution_facts)
                  AS authority_execution_count,
             (SELECT pg_catalog.count(*)::INTEGER
                FROM public.task_work_order_execution_facts) AS domain_execution_count,
             (SELECT pg_catalog.count(*)::INTEGER
                FROM public.task_applications) AS application_count,
             (SELECT pg_catalog.count(*)::INTEGER
                FROM public.task_work_order_command_requests) AS request_count,
             (SELECT pg_catalog.count(*)::INTEGER
                FROM public.task_reservations) AS reservation_count,
             (SELECT pg_catalog.count(*)::INTEGER
                FROM public.task_work_orders) AS work_order_count,
             (SELECT pg_catalog.count(*)::INTEGER
                FROM public.universal_v1_work_order_compensation_commands) AS recovery_count`
        )
      ).rows
    ).toEqual(commandFactsBeforeBootstrap.rows);

    await databaseClient.query('BEGIN');
    await databaseClient.query(
      `CREATE TABLE public.hxos_fake_financial_schema_evidence_v1(marker TEXT)`
    );
    await refusal(() => databaseClient!.query(migrationSql), /HXUV1-WOCMD-0B/u);
    await databaseClient.query('ROLLBACK');

    await databaseClient.query('BEGIN');
    await databaseClient.query(
      `CREATE TABLE public.hxos_fake_financial_schema_evidence_v12(marker TEXT)`
    );
    await refusal(() => databaseClient!.query(migrationSql), /HXUV1-WOCMD-0C/u);
    await databaseClient.query('ROLLBACK');

    await databaseClient.query('BEGIN');
    await databaseClient.query(
      `INSERT INTO public.applied_migrations(name, sha256) VALUES ($1, $2)`,
      [fakeFinancialV12Migration.name, 'f'.repeat(64)]
    );
    await refusal(() => databaseClient!.query(migrationSql), /HXUV1-WOCMD-0C/u);
    await databaseClient.query('ROLLBACK');

    for (const registration of fakeFinancialV1ToV11Migrations) {
      await applySupplementalMigration(databaseClient, registration);
    }
    v12MigrationSql = await applySupplementalMigration(
      databaseClient,
      fakeFinancialV12Migration
    );
    await refusal(() => databaseClient!.query(migrationSql), /HXUV1-WOCMD-0C/u);

    // V12 cannot self-pin its own bytes. All command surfaces remain closed
    // until the separately registered exact predecessor-hash seal commits.
    await transactionalRefusal(
      databaseClient,
      'BEGIN ISOLATION LEVEL SERIALIZABLE',
      () =>
        databaseClient!.query(
          `SELECT * FROM public.hxos_prepare_universal_v1_fake_work_order_v1(
             $1, $2, 1, 'v12-only-prepare-0001', pg_catalog.clock_timestamp()
           )`,
          ['v12-only-assertion', dummyUuid]
        ),
      /HXUV1-WOCMD-SEAL-0/u
    );

    // A target created before exact predecessor sealing cannot be laundered
    // into the certified chain. The failed install rolls back every object.
    await databaseClient.query('BEGIN');
    try {
      await databaseClient.query(
        `INSERT INTO hx_authority.universal_v1_work_order_target_authority_facts(
           authority_version, target_database_name, environment,
           release_manifest_sha256, activation_request_sha256
         ) VALUES (1, pg_catalog.current_database(), 'local', $1, $2)`,
        [releaseManifestSha256, 'c'.repeat(64)]
      );
      const sealSql = await readFile(
        new URL(
          `../../database/migrations/${workOrderBootstrapSealMigration.fileName}`,
          import.meta.url
        ),
        'utf8'
      );
      await refusal(() => databaseClient!.query(sealSql), /HXUV1-WOCMD-SEAL-4/u);
    } finally {
      await databaseClient.query('ROLLBACK');
    }
    expect(
      (
        await databaseClient.query(
          `SELECT pg_catalog.count(*)::INTEGER AS target_count,
                  pg_catalog.to_regclass(
                    'public.hxos_work_order_bootstrap_seal_evidence_v1'
                  ) AS seal_relation
             FROM hx_authority.universal_v1_work_order_target_authority_facts`
        )
      ).rows
    ).toEqual([{ target_count: 0, seal_relation: null }]);

    bootstrapSealMigrationSql = await applySupplementalMigration(
      databaseClient,
      workOrderBootstrapSealMigration
    );

    await adminClient.query(`CREATE DATABASE ${quote(legacyProofDatabase)} TEMPLATE template0`);
    const legacyClient = new pg.Client({
      connectionString: databaseUrlFor(legacyProofDatabase),
    });
    await legacyClient.connect();
    try {
      await legacyClient.query(baseline);
      await legacyClient.query(
        `CREATE TABLE public.applied_migrations (
           name TEXT PRIMARY KEY,
           sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
           applied_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
         )`
      );
      for (const registration of REQUIRED_MIGRATION_FILES.slice(0, -1)) {
        await applyRegisteredMigration(legacyClient, registration);
      }
      await refusal(() => legacyClient.query(v12MigrationSql), /HXUV1-WOCMD-V12-0/u);

      await legacyClient.query('BEGIN');
      try {
        await legacyClient.query(migrationSql);
        await legacyClient.query(
          `INSERT INTO public.applied_migrations(name, sha256) VALUES ($1, $2)`,
          [migrationName, sha256(migrationSql)]
        );
        await refusal(() => legacyClient.query(v12MigrationSql), /HXUV1-WOCMD-V12-2/u);
      } finally {
        await legacyClient.query('ROLLBACK');
      }
      expect(
        (
          await legacyClient.query(
            `SELECT pg_catalog.to_regclass(
               'public.hxos_fake_financial_schema_evidence_v12'
             ) AS v12_relation`
          )
        ).rows
      ).toEqual([{ v12_relation: null }]);

      await legacyClient.query('BEGIN');
      try {
        await legacyClient.query(migrationSql);
        await legacyClient.query(
          `INSERT INTO public.applied_migrations(name, sha256) VALUES ($1, $2)`,
          [migrationName, sha256(migrationSql)]
        );
        await legacyClient.query(
          `SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', true)`
        );
        for (const registration of fakeFinancialV1ToV11Migrations.slice(0, 3)) {
          const partialSql = await readFile(
            new URL(`../../database/migrations/${registration.fileName}`, import.meta.url),
            'utf8'
          );
          const partialSha256 = sha256(partialSql);
          await legacyClient.query(partialSql);
          await legacyClient.query(
            `INSERT INTO public.${registration.evidenceTable}(
               migration_name, migration_sql_sha256
             ) VALUES ($1, $2)`,
            [registration.name, partialSha256]
          );
          await legacyClient.query(
            `INSERT INTO public.applied_migrations(name, sha256) VALUES ($1, $2)`,
            [registration.name, partialSha256]
          );
        }
        await refusal(() => legacyClient.query(v12MigrationSql), /HXUV1-WOCMD-V12-2/u);
      } finally {
        await legacyClient.query('ROLLBACK');
      }
      expect(
        (
          await legacyClient.query(
            `SELECT pg_catalog.to_regclass(
               'public.hxos_fake_financial_schema_evidence_v12'
             ) AS v12_relation`
          )
        ).rows
      ).toEqual([{ v12_relation: null }]);

      for (const registration of fakeFinancialV1ToV11Migrations) {
        await applySupplementalMigration(legacyClient, registration);
      }
      await applyRegisteredMigration(legacyClient, workOrderPortRegistration!);

      const legacyPreV12Catalog = await migrationTriggerCatalog(legacyClient);
      const expectLegacyPreV12Unchanged = async () => {
        expect(await migrationTriggerCatalog(legacyClient)).toEqual(legacyPreV12Catalog);
        expect(
          (
            await legacyClient.query(
              `SELECT pg_catalog.to_regclass(
                 'public.hxos_fake_financial_schema_evidence_v12'
               ) AS v12_relation`
            )
          ).rows
        ).toEqual([{ v12_relation: null }]);
      };

      await legacyClient.query('BEGIN');
      await legacyClient.query(
        `UPDATE public.applied_migrations SET sha256 = $2 WHERE name = $1`,
        [migrationName, 'f'.repeat(64)]
      );
      await refusal(() => legacyClient.query(v12MigrationSql), /HXUV1-WOCMD-V12-1/u);
      await legacyClient.query('ROLLBACK');
      await expectLegacyPreV12Unchanged();

      await legacyClient.query('BEGIN');
      await legacyClient.query(
        `ALTER TABLE public.applied_migrations ALTER COLUMN sha256 DROP NOT NULL`
      );
      await legacyClient.query(
        `UPDATE public.applied_migrations SET sha256 = NULL WHERE name = $1`,
        [migrationName]
      );
      await refusal(() => legacyClient.query(v12MigrationSql), /HXUV1-WOCMD-V12-1/u);
      await legacyClient.query('ROLLBACK');
      await expectLegacyPreV12Unchanged();

      await legacyClient.query('BEGIN');
      await legacyClient.query(
        `ALTER TABLE public.applied_migrations DROP CONSTRAINT applied_migrations_pkey`
      );
      await legacyClient.query(
        `INSERT INTO public.applied_migrations(name, sha256) VALUES ($1, $2)`,
        [migrationName, sha256(migrationSql)]
      );
      await refusal(() => legacyClient.query(v12MigrationSql), /HXUV1-WOCMD-V12-1/u);
      await legacyClient.query('ROLLBACK');
      await expectLegacyPreV12Unchanged();

      const v11 = fakeFinancialV1ToV11Migrations.at(-1)!;
      await legacyClient.query('BEGIN');
      await legacyClient.query(
        `UPDATE public.applied_migrations SET sha256 = $2 WHERE name = $1`,
        [v11.name, 'f'.repeat(64)]
      );
      await refusal(() => legacyClient.query(v12MigrationSql), /HXUV1-WOCMD-V12-2/u);
      await legacyClient.query('ROLLBACK');
      await expectLegacyPreV12Unchanged();

      await legacyClient.query('BEGIN');
      await legacyClient.query(
        `ALTER TABLE public.applied_migrations ALTER COLUMN sha256 DROP NOT NULL`
      );
      await legacyClient.query(
        `UPDATE public.applied_migrations SET sha256 = NULL WHERE name = $1`,
        [v11.name]
      );
      await refusal(() => legacyClient.query(v12MigrationSql), /HXUV1-WOCMD-V12-2/u);
      await legacyClient.query('ROLLBACK');
      await expectLegacyPreV12Unchanged();

      await legacyClient.query('BEGIN');
      await legacyClient.query(
        `ALTER TABLE public.applied_migrations DROP CONSTRAINT applied_migrations_pkey`
      );
      await legacyClient.query(
        `INSERT INTO public.applied_migrations(name, sha256) VALUES ($1, $2)`,
        [v11.name, sha256(await readFile(
          new URL(`../../database/migrations/${v11.fileName}`, import.meta.url),
          'utf8'
        ))]
      );
      await refusal(() => legacyClient.query(v12MigrationSql), /HXUV1-WOCMD-V12-2/u);
      await legacyClient.query('ROLLBACK');
      await expectLegacyPreV12Unchanged();

      await legacyClient.query('BEGIN');
      await legacyClient.query(
        `ALTER TABLE public.${v11.evidenceTable} DISABLE TRIGGER USER`
      );
      await legacyClient.query(
        `UPDATE public.${v11.evidenceTable}
            SET migration_sql_sha256 = $2
          WHERE migration_name = $1`,
        [v11.name, 'f'.repeat(64)]
      );
      await refusal(() => legacyClient.query(v12MigrationSql), /HXUV1-WOCMD-V12-2/u);
      await legacyClient.query('ROLLBACK');
      await expectLegacyPreV12Unchanged();

      await legacyClient.query('BEGIN');
      await legacyClient.query(
        `ALTER TABLE public.${v11.evidenceTable} DISABLE TRIGGER USER`
      );
      await legacyClient.query(
        `ALTER TABLE public.${v11.evidenceTable}
           ALTER COLUMN migration_sql_sha256 DROP NOT NULL`
      );
      await legacyClient.query(
        `UPDATE public.${v11.evidenceTable} SET migration_sql_sha256 = NULL`
      );
      await refusal(() => legacyClient.query(v12MigrationSql), /HXUV1-WOCMD-V12-2/u);
      await legacyClient.query('ROLLBACK');
      await expectLegacyPreV12Unchanged();

      await legacyClient.query('BEGIN');
      await legacyClient.query(
        `ALTER TABLE public.${v11.evidenceTable} DISABLE TRIGGER USER`
      );
      await legacyClient.query(`DELETE FROM public.${v11.evidenceTable}`);
      await refusal(() => legacyClient.query(v12MigrationSql), /HXUV1-WOCMD-V12-2/u);
      await legacyClient.query('ROLLBACK');
      await expectLegacyPreV12Unchanged();

      const v11EvidenceConstraint = await legacyClient.query<{ name: string }>(
        `SELECT constraint_state.conname AS name
           FROM pg_catalog.pg_constraint constraint_state
          WHERE constraint_state.conrelid =
                $1::pg_catalog.regclass
            AND constraint_state.contype IN ('p', 'u')
          ORDER BY constraint_state.contype, constraint_state.conname
          LIMIT 1`,
        [`public.${v11.evidenceTable}`]
      );
      expect(v11EvidenceConstraint.rows).toHaveLength(1);
      expect(v11EvidenceConstraint.rows[0]!.name).toMatch(/^[a-z_][a-z0-9_]{0,62}$/u);
      await legacyClient.query('BEGIN');
      await legacyClient.query(
        `ALTER TABLE public.${v11.evidenceTable} DISABLE TRIGGER USER`
      );
      await legacyClient.query(
        `ALTER TABLE public.${v11.evidenceTable}
           DROP CONSTRAINT "${v11EvidenceConstraint.rows[0]!.name}"`
      );
      await legacyClient.query(
        `INSERT INTO public.${v11.evidenceTable}(
           migration_name, migration_sql_sha256
         )
         SELECT migration_name, migration_sql_sha256
           FROM public.${v11.evidenceTable}`
      );
      await refusal(() => legacyClient.query(v12MigrationSql), /HXUV1-WOCMD-V12-2/u);
      await legacyClient.query('ROLLBACK');
      await expectLegacyPreV12Unchanged();

      await legacyClient.query('BEGIN');
      await legacyClient.query(
        `CREATE TABLE public.hxos_fake_financial_schema_evidence_v12(marker TEXT)`
      );
      await refusal(() => legacyClient.query(v12MigrationSql), /already exists/iu);
      await legacyClient.query('ROLLBACK');
      await expectLegacyPreV12Unchanged();

      const driftTrigger = await legacyClient.query<{
        relation_name: string;
        trigger_name: string;
      }>(
        `SELECT relation_state.relname AS relation_name,
                trigger_state.tgname AS trigger_name
           FROM pg_catalog.pg_trigger trigger_state
           JOIN pg_catalog.pg_class relation_state
             ON relation_state.oid = trigger_state.tgrelid
          WHERE trigger_state.tgisinternal IS FALSE
            AND relation_state.oid = 'public.task_drafts'::pg_catalog.regclass
          ORDER BY trigger_state.tgname
          LIMIT 1`
      );
      expect(driftTrigger.rows).toHaveLength(1);
      expect(driftTrigger.rows[0]!.relation_name).toMatch(/^[a-z_][a-z0-9_]{0,62}$/u);
      expect(driftTrigger.rows[0]!.trigger_name).toMatch(/^[a-z_][a-z0-9_]{0,62}$/u);
      await legacyClient.query('BEGIN');
      await legacyClient.query(
        `ALTER TABLE public."${driftTrigger.rows[0]!.relation_name}"
           DISABLE TRIGGER "${driftTrigger.rows[0]!.trigger_name}"`
      );
      await refusal(() => legacyClient.query(v12MigrationSql), /HXUV1-WOCMD-V12-3/u);
      await legacyClient.query('ROLLBACK');
      await expectLegacyPreV12Unchanged();

      const legacyV12Sql = await applySupplementalMigration(
        legacyClient,
        fakeFinancialV12Migration
      );
      expect(sha256(legacyV12Sql)).toBe(sha256(v12MigrationSql));
      await refusal(() => legacyClient.query(migrationSql), /HXUV1-WOCMD-0C/u);

      await transactionalRefusal(
        legacyClient,
        'BEGIN ISOLATION LEVEL SERIALIZABLE',
        () =>
          legacyClient.query(
            `SELECT * FROM public.hxos_claim_universal_v1_work_order_compensation_v2(1, 1)`
          ),
        /HXUV1-WOCMD-SEAL-0/u
      );

      const expectLegacyPreSealUnchanged = async () => {
        expect(
          (
            await legacyClient.query(
              `SELECT pg_catalog.to_regclass(
                 'public.hxos_work_order_bootstrap_seal_evidence_v1'
               ) AS seal_relation,
                      pg_catalog.count(*)::INTEGER AS target_count
                 FROM hx_authority.universal_v1_work_order_target_authority_facts`
            )
          ).rows
        ).toEqual([{ seal_relation: null, target_count: 0 }]);
      };

      await legacyClient.query('BEGIN');
      await legacyClient.query(
        `UPDATE public.applied_migrations SET sha256 = $2 WHERE name = $1`,
        [migrationName, 'f'.repeat(64)]
      );
      await refusal(
        () => legacyClient.query(bootstrapSealMigrationSql),
        /HXUV1-WOCMD-SEAL-2/u
      );
      await legacyClient.query('ROLLBACK');
      await expectLegacyPreSealUnchanged();

      await legacyClient.query('BEGIN');
      await legacyClient.query(
        `ALTER TABLE public.applied_migrations ALTER COLUMN sha256 DROP NOT NULL`
      );
      await legacyClient.query(
        `UPDATE public.applied_migrations SET sha256 = NULL WHERE name = $1`,
        [fakeFinancialV12Migration.name]
      );
      await refusal(
        () => legacyClient.query(bootstrapSealMigrationSql),
        /HXUV1-WOCMD-SEAL-2/u
      );
      await legacyClient.query('ROLLBACK');
      await expectLegacyPreSealUnchanged();

      const v12EvidencePrimaryKey = await legacyClient.query<{ name: string }>(
        `SELECT constraint_state.conname AS name
           FROM pg_catalog.pg_constraint constraint_state
          WHERE constraint_state.conrelid =
                'public.hxos_fake_financial_schema_evidence_v12'::pg_catalog.regclass
            AND constraint_state.contype = 'p'`
      );
      expect(v12EvidencePrimaryKey.rows).toHaveLength(1);
      expect(v12EvidencePrimaryKey.rows[0]!.name).toMatch(/^[a-z_][a-z0-9_]{0,62}$/u);
      await legacyClient.query('BEGIN');
      await legacyClient.query(
        `ALTER TABLE public.hxos_fake_financial_schema_evidence_v12 DISABLE TRIGGER USER`
      );
      await legacyClient.query(
        `ALTER TABLE public.hxos_fake_financial_schema_evidence_v12
           DROP CONSTRAINT "${v12EvidencePrimaryKey.rows[0]!.name}"`
      );
      await legacyClient.query(
        `INSERT INTO public.hxos_fake_financial_schema_evidence_v12
         SELECT * FROM public.hxos_fake_financial_schema_evidence_v12`
      );
      await refusal(
        () => legacyClient.query(bootstrapSealMigrationSql),
        /HXUV1-WOCMD-SEAL-3/u
      );
      await legacyClient.query('ROLLBACK');
      await expectLegacyPreSealUnchanged();

      await legacyClient.query('BEGIN');
      await legacyClient.query(
        `CREATE TABLE public.hxos_work_order_bootstrap_seal_evidence_v1(marker TEXT)`
      );
      await refusal(() => legacyClient.query(bootstrapSealMigrationSql), /already exists/iu);
      await legacyClient.query('ROLLBACK');
      await expectLegacyPreSealUnchanged();

      const legacySealSql = await applySupplementalMigration(
        legacyClient,
        workOrderBootstrapSealMigration
      );
      expect(sha256(legacySealSql)).toBe(sha256(bootstrapSealMigrationSql));

      const [canonicalCatalog, legacyCatalog] = await Promise.all([
        migrationTriggerCatalog(databaseClient),
        migrationTriggerCatalog(legacyClient),
      ]);
      expect(legacyCatalog).toEqual(canonicalCatalog);
      expect(legacyCatalog).toEqual({
        trigger_count: 169,
        trigger_catalog_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
      const [canonicalFunctions, legacyFunctions] = await Promise.all([
        migrationFunctionCatalog(databaseClient),
        migrationFunctionCatalog(legacyClient),
      ]);
      expect(legacyFunctions).toEqual(canonicalFunctions);
      const legacyEvidence = await legacyClient.query(
        `SELECT v12.migration_name,
                pg_catalog.btrim(v12.migration_sql_sha256) AS v12_sha256,
                pg_catalog.btrim(v12.ordinal146_sql_sha256) AS ordinal146_sha256,
                pg_catalog.btrim(applied_v12.sha256) AS applied_v12_sha256,
                pg_catalog.btrim(seal.migration_sql_sha256) AS seal_sha256,
                pg_catalog.btrim(seal.ordinal146_sql_sha256) AS seal_ordinal146_sha256,
                pg_catalog.btrim(seal.v12_sql_sha256) AS seal_v12_sha256,
                pg_catalog.btrim(applied_seal.sha256) AS applied_seal_sha256
           FROM public.hxos_fake_financial_schema_evidence_v12 v12
           JOIN public.applied_migrations applied_v12
             ON applied_v12.name = v12.migration_name
           CROSS JOIN public.hxos_work_order_bootstrap_seal_evidence_v1 seal
           JOIN public.applied_migrations applied_seal
             ON applied_seal.name = seal.migration_name`
      );
      expect(legacyEvidence.rows).toEqual([
        {
          migration_name: fakeFinancialV12Migration.name,
          v12_sha256: sha256(v12MigrationSql),
          ordinal146_sha256: sha256(migrationSql),
          applied_v12_sha256: sha256(v12MigrationSql),
          seal_sha256: sha256(bootstrapSealMigrationSql),
          seal_ordinal146_sha256: sha256(migrationSql),
          seal_v12_sha256: sha256(v12MigrationSql),
          applied_seal_sha256: sha256(bootstrapSealMigrationSql),
        },
      ]);
    } finally {
      await legacyClient.end();
    }

    await databaseClient.query(
      `INSERT INTO public.users(
         id, firebase_uid, email, full_name, default_mode, account_status,
         is_minor, is_banned
       ) VALUES ($1, $2, 'work-order-port@synthetic.invalid',
         'Synthetic Work Order actor', 'poster', 'ACTIVE', FALSE, FALSE)`,
      [canonicalUserId, verifiedSubject]
    );
  }, 300_000);

  afterAll(async () => {
    for (const client of [attesterClient, workerClient, apiClient, migrationClient]) {
      await client?.end().catch(() => undefined);
    }
    await databaseClient?.end().catch(() => undefined);
    if (adminClient) {
      await cleanup().catch(() => undefined);
      await adminClient.end().catch(() => undefined);
    }
  }, 60_000);

  it('fresh-installs exact engine ordinal 146, fake-finance v1-v12, and the bootstrap seal', async () => {
    const result = await databaseClient!.query<{
      count: number;
      tail: string;
      ordinal_digest: string;
      v12_digest: string;
      seal_digest: string;
      evidence_ordinal_digest: string;
      evidence_v12_digest: string;
      evidence_seal_digest: string;
    }>(
      `SELECT (SELECT pg_catalog.count(*)::INTEGER FROM public.applied_migrations) AS count,
              (SELECT name FROM public.applied_migrations
                ORDER BY applied_at DESC, name DESC LIMIT 1) AS tail,
              (SELECT pg_catalog.btrim(sha256) FROM public.applied_migrations
                WHERE name = $1) AS ordinal_digest,
              (SELECT pg_catalog.btrim(sha256) FROM public.applied_migrations
                WHERE name = $2) AS v12_digest,
              (SELECT pg_catalog.btrim(sha256) FROM public.applied_migrations
                WHERE name = $3) AS seal_digest,
              (SELECT pg_catalog.btrim(ordinal146_sql_sha256)
                 FROM public.hxos_fake_financial_schema_evidence_v12)
                   AS evidence_ordinal_digest,
              (SELECT pg_catalog.btrim(migration_sql_sha256)
                 FROM public.hxos_fake_financial_schema_evidence_v12)
                   AS evidence_v12_digest,
              (SELECT pg_catalog.btrim(migration_sql_sha256)
                 FROM public.hxos_work_order_bootstrap_seal_evidence_v1)
                   AS evidence_seal_digest`,
      [migrationName, fakeFinancialV12Migration.name, workOrderBootstrapSealMigration.name]
    );
    expect(result.rows[0]).toEqual({
      count: 146 + CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES.length,
      tail: workOrderBootstrapSealMigration.name,
      ordinal_digest: sha256(migrationSql),
      v12_digest: sha256(v12MigrationSql),
      seal_digest: sha256(bootstrapSealMigrationSql),
      evidence_ordinal_digest: sha256(migrationSql),
      evidence_v12_digest: sha256(v12MigrationSql),
      evidence_seal_digest: sha256(bootstrapSealMigrationSql),
    });
    expect(v12MigrationSql).toContain('HXUV1-WOCMD-V12-4');
    await databaseClient!.query(`SET hustlexp.is_test = 'on'`);
    const preActivationRecord = await databaseClient!.query<{ event_id: string }>(
      `SELECT public.record_major_action_event(
           'intent_scope.pre_activation', 'INTENT_SCOPE', 'A1', 'SYSTEM',
           'system:bootstrap', 'task', 'pre_activation_1', 'UNATTRIBUTED',
           'CREATED', 'SERVER_CONFIRMED', 'TASK_CREATE', 'CANONICAL_ENGINE',
           'task-scope-version-v1', 'APPLIED', NULL, 'NOT_APPLICABLE',
           'NOT_APPLICABLE', 'LOW', 'pre-activation-correlation',
           'pre-activation-causation', 'pre-activation-idempotency', NULL,
           $1, 'SUCCESS', NULL, NULL, 'CREATED', 'NOT_APPLICABLE',
           'NOT_APPLICABLE', TRUE, 'task_scope_versions',
           'pre-activation-source', pg_catalog.clock_timestamp()
         ) AS event_id`,
      ['a'.repeat(64)]
    );
    const preActivationEvent = await databaseClient!.query<{
      environment: string;
      is_test: boolean;
    }>(
      `SELECT environment, is_test
         FROM public.major_action_events
        WHERE id = $1`,
      [preActivationRecord.rows[0]!.event_id]
    );
    expect(preActivationEvent.rows).toEqual([
      { environment: 'PRODUCTION', is_test: false },
    ]);
    await databaseClient!.query(`RESET hustlexp.is_test`);
  });

  it('fails closed for absent, wrong-database, uppercase, and duplicate current target authority', async () => {
    await refusal(
      () =>
        databaseClient!.query(
          `SELECT * FROM hx_authority.read_universal_v1_work_order_target_authority_v1()`
        ),
      /HXUV1-WOCMD-4/u
    );
    await refusal(
      () =>
        databaseClient!.query(
          `INSERT INTO hx_authority.universal_v1_work_order_target_authority_facts(
           authority_version, target_database_name, environment,
           release_manifest_sha256, activation_request_sha256
         ) VALUES (1, 'wrong_database', 'local', $1, $2)`,
          [releaseManifestSha256, '1'.repeat(64)]
        ),
      /HXUV1-WOCMD-2/u
    );
    await databaseClient!.query('BEGIN');
    try {
      await databaseClient!.query(
        `ALTER TABLE hx_authority.universal_v1_work_order_target_authority_facts
           DISABLE TRIGGER universal_v1_work_order_target_activation_guard_v1`
      );
      await databaseClient!.query(
        `INSERT INTO hx_authority.universal_v1_work_order_target_authority_facts(
           authority_version, target_database_name, environment,
           release_manifest_sha256, activation_request_sha256
         ) VALUES (1, 'wrong_database', 'local', $1, $2)`,
        [releaseManifestSha256, '8'.repeat(64)]
      );
      await refusal(
        () =>
          databaseClient!.query(
            `SELECT public.hxos_read_universal_v1_telemetry_environment_v1()`
          ),
        /HXUV1-WOCMD-5/u
      );
    } finally {
      await databaseClient!.query('ROLLBACK');
    }
    const authorityVersionConstraint = await databaseClient!.query<{ name: string }>(
      `SELECT constraint_state.conname AS name
         FROM pg_catalog.pg_constraint constraint_state
        WHERE constraint_state.conrelid =
              'hx_authority.universal_v1_work_order_target_authority_facts'::pg_catalog.regclass
          AND constraint_state.contype = 'u'
          AND pg_catalog.pg_get_constraintdef(constraint_state.oid, false) =
              'UNIQUE (authority_version)'`
    );
    expect(authorityVersionConstraint.rows).toHaveLength(1);
    const authorityVersionConstraintName = authorityVersionConstraint.rows[0]!.name;
    expect(authorityVersionConstraintName).toMatch(/^[a-z_][a-z0-9_]{0,62}$/u);
    await databaseClient!.query('BEGIN');
    try {
      await databaseClient!.query(
        `ALTER TABLE hx_authority.universal_v1_work_order_target_authority_facts
           DISABLE TRIGGER universal_v1_work_order_target_activation_guard_v1`
      );
      await databaseClient!.query(
        `ALTER TABLE hx_authority.universal_v1_work_order_target_authority_facts
           DROP CONSTRAINT "${authorityVersionConstraintName}"`
      );
      await databaseClient!.query(
        `INSERT INTO hx_authority.universal_v1_work_order_target_authority_facts(
           authority_version, target_database_name, environment,
           release_manifest_sha256, activation_request_sha256
         ) VALUES
           (1, pg_catalog.current_database(), 'local', $1, $2),
           (1, pg_catalog.current_database(), 'preview', $1, $3)`,
        [releaseManifestSha256, '9'.repeat(64), 'a'.repeat(64)]
      );
      await refusal(
        () =>
          databaseClient!.query(
            `SELECT public.hxos_read_universal_v1_telemetry_environment_v1()`
          ),
        /HXUV1-WOCMD-5/u
      );
    } finally {
      await databaseClient!.query('ROLLBACK');
    }
    await refusal(
      () =>
        databaseClient!.query(
          `INSERT INTO hx_authority.universal_v1_work_order_target_authority_facts(
           authority_version, target_database_name, environment,
           release_manifest_sha256, activation_request_sha256
         ) VALUES (1, pg_catalog.current_database(), 'local', $1, $2)`,
          [`sha256:${'A'.repeat(64)}`, '2'.repeat(64)]
        ),
      /check constraint/iu
    );
    await refusal(
      () =>
        databaseClient!.query(
          `SELECT * FROM public.hxos_activate_universal_v1_work_order_target_v1(
             'local', $1, NULL, 0
           )`,
          [releaseManifestSha256]
        ),
      /HXUV1-WOCMD-60/u
    );
    const targetRowsBeforeNullEvidence = await databaseClient!.query(
      `SELECT *
         FROM hx_authority.universal_v1_work_order_target_authority_facts
        ORDER BY authority_version`
    );
    for (const evidenceColumn of [
      'ordinal146_sql_sha256',
      'migration_sql_sha256',
    ] as const) {
      await databaseClient!.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      try {
        await databaseClient!.query(
          `ALTER TABLE public.hxos_fake_financial_schema_evidence_v12
             DISABLE TRIGGER USER`
        );
        await databaseClient!.query(
          `ALTER TABLE public.hxos_fake_financial_schema_evidence_v12
             ALTER COLUMN ${evidenceColumn} DROP NOT NULL`
        );
        await databaseClient!.query(
          `UPDATE public.hxos_fake_financial_schema_evidence_v12
              SET ${evidenceColumn} = NULL`
        );
        await refusal(
          () =>
            databaseClient!.query(
              `SELECT * FROM public.hxos_activate_universal_v1_work_order_target_v1(
                 'local', $1, NULL, 0
               )`,
              [releaseManifestSha256]
            ),
          /HXUV1-WOCMD-SEAL-5/u
        );
      } finally {
        await databaseClient!.query('ROLLBACK');
      }
      expect(
        (
          await databaseClient!.query(
            `SELECT *
               FROM hx_authority.universal_v1_work_order_target_authority_facts
              ORDER BY authority_version`
          )
        ).rows
      ).toEqual(targetRowsBeforeNullEvidence.rows);
    }
    const inserted = await serializableResult<{ id: string; replayed: boolean }>(
      databaseClient!,
      () =>
        databaseClient!.query(
          `SELECT target_authority_id AS id, replayed
             FROM public.hxos_activate_universal_v1_work_order_target_v1(
               'local', $1, NULL, 0
             )`,
          [releaseManifestSha256]
        )
    );
    expect(inserted.rows).toEqual([
      { id: expect.any(String), replayed: false },
    ]);
    const activationReplay = await serializableResult<{ id: string; replayed: boolean }>(
      databaseClient!,
      () =>
        databaseClient!.query(
          `SELECT target_authority_id AS id, replayed
             FROM public.hxos_activate_universal_v1_work_order_target_v1(
               'local', $1, NULL, 0
             )`,
          [releaseManifestSha256]
        )
    );
    expect(activationReplay.rows).toEqual([
      { id: inserted.rows[0]!.id, replayed: true },
    ]);
    const targetRowsBeforeInvalidTip = await databaseClient!.query(
      `SELECT *
         FROM hx_authority.universal_v1_work_order_target_authority_facts
        ORDER BY authority_version`
    );
    const authorityFactsBeforeInvalidTip = await databaseClient!.query(
      `SELECT pg_catalog.count(*)::INTEGER AS count
         FROM hx_authority.universal_v1_work_order_command_execution_facts`
    );
    for (const invalidTip of [
      { column: 'target_database_name', mutation: `'wrong_database'` },
      { column: 'environment', mutation: 'NULL' },
      { column: 'release_manifest_sha256', mutation: 'NULL' },
    ] as const) {
      await databaseClient!.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      try {
        await databaseClient!.query(
          `ALTER TABLE hx_authority.universal_v1_work_order_target_authority_facts
             DISABLE TRIGGER universal_v1_work_order_target_no_mutation_v1`
        );
        if (invalidTip.mutation === 'NULL') {
          await databaseClient!.query(
            `ALTER TABLE hx_authority.universal_v1_work_order_target_authority_facts
               ALTER COLUMN ${invalidTip.column} DROP NOT NULL`
          );
        }
        await databaseClient!.query(
          `UPDATE hx_authority.universal_v1_work_order_target_authority_facts
              SET ${invalidTip.column} = ${invalidTip.mutation}
            WHERE target_authority_id = $1`,
          [inserted.rows[0]!.id]
        );
        await refusal(
          () =>
            databaseClient!.query(
              `SELECT * FROM public.hxos_activate_universal_v1_work_order_target_v1(
                 'local', $1, $2, 1
               )`,
              [releaseManifestSha256, inserted.rows[0]!.id]
            ),
          /HXUV1-WOCMD-5/u
        );
      } finally {
        await databaseClient!.query('ROLLBACK');
      }
      expect(
        (
          await databaseClient!.query(
            `SELECT *
               FROM hx_authority.universal_v1_work_order_target_authority_facts
              ORDER BY authority_version`
          )
        ).rows
      ).toEqual(targetRowsBeforeInvalidTip.rows);
    }
    await databaseClient!.query('BEGIN');
    try {
      await databaseClient!.query(
        `ALTER TABLE hx_authority.universal_v1_work_order_target_authority_facts
           DISABLE TRIGGER universal_v1_work_order_target_no_mutation_v1`
      );
      await databaseClient!.query(
        `ALTER TABLE hx_authority.universal_v1_work_order_target_authority_facts
           ALTER COLUMN release_manifest_sha256 DROP NOT NULL`
      );
      await databaseClient!.query(
        `UPDATE hx_authority.universal_v1_work_order_target_authority_facts
            SET release_manifest_sha256 = NULL
          WHERE target_authority_id = $1`,
        [inserted.rows[0]!.id]
      );
      await refusal(
        () =>
          databaseClient!.query(
            `SELECT * FROM public.hxos_claim_universal_v1_work_order_compensation_v2(5, 30)`
          ),
        /HXUV1-WOCMD-5/u
      );
    } finally {
      await databaseClient!.query('ROLLBACK');
    }
    expect(
      (
        await databaseClient!.query(
          `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM hx_authority.universal_v1_work_order_command_execution_facts`
        )
      ).rows
    ).toEqual(authorityFactsBeforeInvalidTip.rows);
    await refusal(
      () =>
        databaseClient!.query(
          `INSERT INTO hx_authority.universal_v1_work_order_target_authority_facts(
           authority_version, supersedes_target_authority_id, target_database_name,
           environment, release_manifest_sha256, activation_request_sha256
         ) VALUES (1, $1, pg_catalog.current_database(), 'local', $2, $3)`,
          [inserted.rows[0]!.id, releaseManifestSha256, '4'.repeat(64)]
        ),
      /target authority must|check constraint|duplicate key/iu
    );
    expect(
      (
        await databaseClient!.query(
          `SELECT environment, release_manifest_sha256
           FROM hx_authority.read_universal_v1_work_order_target_authority_v1()`
        )
      ).rows[0]
    ).toEqual({ environment: 'local', release_manifest_sha256: releaseManifestSha256 });
  });

  it('runs the bounded fake-only worker port with zero effects and immutable audit', async () => {
    const claimed = await databaseClient!.query(
      `SELECT * FROM public.hxos_claim_universal_v1_work_order_compensation_v2(5, 30)`
    );
    expect(claimed.rows).toEqual([]);
    const audit = await databaseClient!.query<{
      command_kind: string;
      service_identity: string;
      result_kind: string;
      hard_assignment_created: boolean;
      payment_creation_performed: boolean;
    }>(
      `SELECT command_kind, service_identity, result_kind,
              hard_assignment_created, payment_creation_performed
         FROM hx_authority.universal_v1_work_order_command_execution_facts`
    );
    expect(audit.rows).toEqual([
      {
        command_kind: 'CLAIM_WORK_ORDER_COMPENSATION',
        service_identity: 'hustlexp.work-order-compensation-worker.v1',
        result_kind: 'WORKER_CLAIMED',
        hard_assignment_created: false,
        payment_creation_performed: false,
      },
    ]);
    for (const command of ['UPDATE', 'DELETE', 'TRUNCATE']) {
      await refusal(
        () =>
          databaseClient!.query(
            command === 'TRUNCATE'
              ? `TRUNCATE hx_authority.universal_v1_work_order_command_execution_facts`
              : command === 'UPDATE'
                ? `UPDATE hx_authority.universal_v1_work_order_command_execution_facts
                   SET result_kind = result_kind WHERE TRUE`
                : `DELETE FROM hx_authority.universal_v1_work_order_command_execution_facts
                  WHERE TRUE`
          ),
        /HXUV1-WOCMD-1/u
      );
    }
  });

  it('provisions exact NOLOGIN owners and least-privilege runtime and telemetry ACLs', async () => {
    const assertionFunctions = [
      'public.hxos_issue_universal_v1_actor_assertion_v1(TEXT,TEXT,TEXT,TEXT,JSONB,TIMESTAMPTZ)',
      'hx_authority.consume_universal_v1_actor_assertion_v1(TEXT,TEXT,JSONB,TEXT)',
      'hx_authority.reject_universal_v1_actor_assertion_mutation_v2()',
    ];
    const commandFunctions = [
      'public.hxos_express_universal_v1_post_estimate_interest_v1(TEXT,UUID,INTEGER,TEXT,TIMESTAMPTZ)',
      'public.hxos_place_universal_v1_conditional_hold_v1(TEXT,UUID,INTEGER,TEXT,TIMESTAMPTZ)',
      'public.hxos_prepare_universal_v1_fake_work_order_v1(TEXT,UUID,INTEGER,TEXT,TIMESTAMPTZ)',
      'public.hxos_materialize_universal_v1_fake_work_order_v1(TEXT,TEXT,TEXT,UUID)',
      'public.hxos_request_universal_v1_fake_work_order_recovery_v1(TEXT,TEXT,TEXT,UUID)',
      'public.hxos_claim_universal_v1_work_order_compensation_v2(INTEGER,INTEGER)',
      'hx_authority.reject_universal_v1_work_order_authority_mutation_v1()',
      'hx_authority.validate_universal_v1_work_order_target_activation_v1()',
      'hx_authority.read_universal_v1_work_order_target_authority_v1()',
      'hx_authority.build_universal_v1_work_order_command_request_v1(TEXT,JSONB)',
      'hx_authority.record_universal_v1_work_order_command_execution_v1(UUID,UUID,TEXT,TEXT,UUID,TEXT,TEXT,UUID,INTEGER,TEXT,JSONB)',
      'hx_authority.assert_universal_v1_work_order_bootstrap_seal_v1()',
      'public.hxos_build_universal_v1_work_order_actor_request_v1(TEXT,JSONB)',
      WORK_ORDER_RUNTIME_AUTHORITY_FUNCTION,
      'public.hxos_universal_v1_sha256_bytes_v1(TEXT,TEXT)',
      'public.hxos_universal_v1_sha256_bytes_v1(BYTEA,TEXT)',
      WORK_ORDER_TELEMETRY_ENVIRONMENT_FUNCTION,
      WORK_ORDER_TARGET_ACTIVATION_FUNCTION,
      ...WORK_ORDER_CORE_SHA_TRANSITIVE_DEPENDENCY_FUNCTIONS.slice(0, 4),
      'public.lock_universal_v1_estimate_authority(UUID,UUID,UUID,UUID,UUID)',
      'public.bind_universal_work_order_to_task()',
      'public.enforce_universal_v1_work_order_execution_genesis()',
    ];
    const dependencyFunctions = [
      'public.claim_universal_v1_work_order_compensations(INTEGER,INTEGER)',
      'public.universal_v1_work_order_operation_id_v1(TEXT,TEXT)',
      'public.universal_v1_invited_provider_authority_is_current(UUID,UUID,TEXT,UUID,TEXT,TEXT)',
      'public.universal_v1_execution_internal_request_sha256(UUID,UUID,TEXT,TEXT,INTEGER,UUID,UUID,UUID,TEXT,TIMESTAMPTZ,TEXT)',
      'public.universal_v1_financial_security_is_current_v1(TIMESTAMPTZ,TIMESTAMPTZ)',
      'public.universal_v1_effective_financial_security_expiry_v1(UUID)',
    ];
    const financeFunctions = [
      'public.require_universal_v1_controlled_fake_lifecycle_bridge()',
      ...WORK_ORDER_CORE_SHA_TRANSITIVE_DEPENDENCY_FUNCTIONS.slice(4),
    ];
    actorClientTimestamp = new Date().toISOString();
    const actorBinding = await databaseClient!.query<{
      actor_request_sha256: string;
    }>(
      `SELECT actor_request_sha256
         FROM hx_authority.build_universal_v1_work_order_command_request_v1(
           'EXPRESS_POST_ESTIMATE_INTEREST',
           pg_catalog.jsonb_build_object(
             'task_id', 'fb200000-0000-4000-8000-000000000001'::UUID,
             'expected_scope_version', 1,
             'idempotency_key', 'work-order:port-actor-proof:0001'::TEXT,
             'client_timestamp_epoch_ms',
               pg_catalog.floor(EXTRACT(EPOCH FROM $1::TIMESTAMPTZ) * 1000)::BIGINT
           )
         )`,
      [actorClientTimestamp]
    );
    actorRequestSha256 = actorBinding.rows[0]!.actor_request_sha256;
    await databaseClient!.query(
      `ALTER SCHEMA public OWNER TO ${quote(roles.migrationRole)};
       ALTER SCHEMA hx_authority OWNER TO ${quote(roles.assertionOwnerRole)};
       ALTER TABLE hx_authority.universal_v1_actor_assertion_issuance_facts OWNER TO ${quote(roles.assertionOwnerRole)};
       ALTER TABLE hx_authority.universal_v1_actor_assertion_consumption_facts OWNER TO ${quote(roles.assertionOwnerRole)};
       ALTER TABLE hx_authority.universal_v1_work_order_target_authority_facts OWNER TO ${quote(roles.commandOwnerRole)};
       ALTER TABLE hx_authority.universal_v1_work_order_command_execution_facts OWNER TO ${quote(roles.commandOwnerRole)};
       ALTER TABLE public.hxos_universal_v1_work_order_target_activation_barrier_v1
         OWNER TO ${quote(roles.commandOwnerRole)};
       ALTER TABLE public.tasks OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.task_drafts OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.task_scope_versions OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.task_routing_decisions OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.universal_v1_service_cell_authorities OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.task_estimate_acceptance_materializations OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.provider_estimate_submissions OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.users OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.admin_roles OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.capability_profiles OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.business_organizations OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.business_memberships OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.business_credentials OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.verified_trades OWNER TO ${quote(roles.migrationRole)};
       ALTER VIEW public.current_verified_trade_qualifications
         OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.hxos_fake_financial_schema_evidence_v12
         OWNER TO ${quote(roles.commandOwnerRole)};
       ALTER TABLE public.hxos_work_order_bootstrap_seal_evidence_v1
         OWNER TO ${quote(roles.commandOwnerRole)};
       ALTER TABLE public.financial_provider_command_journal
         OWNER TO ${quote(roles.financeOwnerRole)};
       ALTER TABLE public.financial_provider_command_outcome_facts
         OWNER TO ${quote(roles.financeOwnerRole)};
       ALTER TABLE public.task_financial_security_events
         OWNER TO ${quote(roles.financeOwnerRole)};
        ALTER TABLE public.universal_v1_fake_financial_lifecycle_bridges
          OWNER TO ${quote(roles.financeOwnerRole)};
        ALTER TABLE public.major_action_class_contracts OWNER TO ${quote(roles.migrationRole)};
        ALTER TABLE public.major_action_events OWNER TO ${quote(roles.migrationRole)};
        ALTER TABLE public.major_action_outcomes OWNER TO ${quote(roles.migrationRole)};
        ALTER TABLE public.recommendations OWNER TO ${quote(roles.migrationRole)};
        ALTER TABLE public.worker_offer_decisions OWNER TO ${quote(roles.migrationRole)};
        ALTER TABLE public.worker_counter_offers OWNER TO ${quote(roles.migrationRole)};
        ALTER TABLE public.task_work_order_command_requests OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.task_provider_eligibility_decisions OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.task_work_orders OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.task_work_order_execution_facts OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.task_reservations OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.task_reservation_requests OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.task_applications OWNER TO ${quote(roles.migrationRole)};
       ALTER TABLE public.universal_v1_work_order_compensation_commands OWNER TO ${quote(roles.migrationRole)}`
    );
    const triggerFunctions = await databaseClient!.query<{
      configuration: string[] | null;
      identity: string;
      owner_role: string;
      security_definer: boolean;
    }>(
      `SELECT DISTINCT pg_catalog.format(
         '%I.%I(%s)', function_namespace.nspname, function_state.proname,
         pg_catalog.oidvectortypes(function_state.proargtypes)
       ) AS identity,
       function_state.proconfig AS configuration,
       function_state.prosecdef AS security_definer,
       owner_role.rolname AS owner_role
         FROM pg_catalog.pg_trigger trigger_state
         JOIN pg_catalog.pg_class relation_state
           ON relation_state.oid = trigger_state.tgrelid
         JOIN pg_catalog.pg_namespace namespace_state
           ON namespace_state.oid = relation_state.relnamespace
         JOIN pg_catalog.pg_proc function_state
           ON function_state.oid = trigger_state.tgfoid
         JOIN pg_catalog.pg_namespace function_namespace
           ON function_namespace.oid = function_state.pronamespace
         JOIN pg_catalog.pg_roles owner_role
           ON owner_role.oid = function_state.proowner
        WHERE trigger_state.tgisinternal IS FALSE
          AND pg_catalog.format('%I.%I', namespace_state.nspname, relation_state.relname)
                = ANY($1::TEXT[])
        ORDER BY identity`,
      [[...WORK_ORDER_TRIGGER_RELATIONS]]
    );
    expect(triggerFunctions.rows).toHaveLength(127);
    expect(
      triggerFunctions.rows.filter((row) => {
        const expectedPath =
          row.identity.startsWith('hx_authority.') ||
          row.identity === 'public.hxos_reject_fake_financial_mutation_v1()' ||
          row.identity === 'public.require_legacy_expiry_terminal_before_outcome_v10()' ||
          row.identity === 'public.serialize_universal_v1_financial_security_task_v12()'
            ? 'search_path=pg_catalog'
            : 'search_path=pg_catalog, public';
        return row.configuration?.length !== 1 || row.configuration[0] !== expectedPath;
      })
    ).toEqual([]);
    expect(
      triggerFunctions.rows.filter(
        (row) => row.security_definer && row.configuration?.[0]?.startsWith('search_path=') !== true
      )
    ).toEqual([]);
    for (const identity of WORK_ORDER_CORE_SHA_TRANSITIVE_TRIGGER_FUNCTIONS) {
      expect(triggerFunctions.rows.some((row) => row.identity === identity)).toBe(true);
    }
    for (const row of triggerFunctions.rows) {
      await databaseClient!.query(
        `ALTER FUNCTION ${row.identity} OWNER TO ${quote(roles.migrationRole)}`
      );
    }
    for (const identity of assertionFunctions) {
      await databaseClient!.query(
        `ALTER FUNCTION ${identity} OWNER TO ${quote(roles.assertionOwnerRole)}`
      );
    }
    for (const identity of commandFunctions) {
      await databaseClient!.query(
        `ALTER FUNCTION ${identity} OWNER TO ${quote(roles.commandOwnerRole)}`
      );
    }
    for (const identity of financeFunctions) {
      await databaseClient!.query(
        `ALTER FUNCTION ${identity} OWNER TO ${quote(roles.financeOwnerRole)}`
      );
    }
    for (const identity of WORK_ORDER_TELEMETRY_FUNCTIONS) {
      await databaseClient!.query(
        `ALTER FUNCTION ${identity} OWNER TO ${quote(roles.telemetryOwnerRole)}`
      );
    }
    for (const identity of dependencyFunctions) {
      await databaseClient!.query(
        `ALTER FUNCTION ${identity} OWNER TO ${quote(roles.migrationRole)}`
      );
    }
    for (const identity of WORK_ORDER_CORE_SHA_TRANSITIVE_DEPENDENCY_FUNCTIONS.slice(0, 4)) {
      await databaseClient!.query(
        `GRANT EXECUTE ON FUNCTION ${identity} TO ${quote(roles.migrationRole)}`
      );
    }
    const sealedTriggerFunctions = await databaseClient!.query<{
      identity: string;
      owner_role: string;
    }>(
      `SELECT DISTINCT pg_catalog.format(
         '%I.%I(%s)', function_namespace.nspname, function_state.proname,
         pg_catalog.oidvectortypes(function_state.proargtypes)
       ) AS identity,
       owner_role.rolname AS owner_role
         FROM pg_catalog.pg_trigger trigger_state
         JOIN pg_catalog.pg_class relation_state
           ON relation_state.oid = trigger_state.tgrelid
         JOIN pg_catalog.pg_namespace namespace_state
           ON namespace_state.oid = relation_state.relnamespace
         JOIN pg_catalog.pg_proc function_state
           ON function_state.oid = trigger_state.tgfoid
         JOIN pg_catalog.pg_namespace function_namespace
           ON function_namespace.oid = function_state.pronamespace
         JOIN pg_catalog.pg_roles owner_role
           ON owner_role.oid = function_state.proowner
        WHERE trigger_state.tgisinternal IS FALSE
          AND function_state.prosecdef IS TRUE
          AND pg_catalog.format('%I.%I', namespace_state.nspname, relation_state.relname)
                = ANY($1::TEXT[])
        ORDER BY identity`,
      [[...WORK_ORDER_TRIGGER_RELATIONS]]
    );
    expect(sealedTriggerFunctions.rows).toEqual([
      {
        identity: 'hx_authority.reject_universal_v1_actor_assertion_mutation_v2()',
        owner_role: roles.assertionOwnerRole,
      },
      {
        identity: 'hx_authority.reject_universal_v1_work_order_authority_mutation_v1()',
        owner_role: roles.commandOwnerRole,
      },
      {
        identity: 'hx_authority.validate_universal_v1_work_order_target_activation_v1()',
        owner_role: roles.commandOwnerRole,
      },
      {
        identity: 'public.bind_universal_work_order_to_task()',
        owner_role: roles.commandOwnerRole,
      },
      {
        identity: 'public.enforce_universal_v1_work_order_execution_genesis()',
        owner_role: roles.commandOwnerRole,
      },
      {
        identity: WORK_ORDER_TELEMETRY_FUNCTIONS[0],
        owner_role: roles.telemetryOwnerRole,
      },
      {
        identity: WORK_ORDER_FINANCE_TRIGGER_FUNCTIONS[0],
        owner_role: roles.financeOwnerRole,
      },
    ]);
    await databaseClient!.query(
      `REVOKE TEMPORARY ON DATABASE ${quote(proofDatabase)} FROM PUBLIC;
       REVOKE CREATE ON SCHEMA public FROM PUBLIC;
       REVOKE CREATE ON SCHEMA hx_authority FROM PUBLIC;
       GRANT USAGE ON SCHEMA public TO ${quote(roles.apiRole)}, ${quote(roles.workerRole)},
          ${quote(roles.attesterRole)}, ${quote(roles.commandOwnerRole)},
          ${quote(roles.assertionOwnerRole)}, ${quote(roles.financeOwnerRole)},
          ${quote(roles.telemetryOwnerRole)};
       GRANT USAGE ON SCHEMA hx_authority TO ${quote(roles.migrationRole)},
         ${quote(roles.commandOwnerRole)};
       GRANT EXECUTE ON FUNCTION public.hxos_universal_v1_sha256_bytes_v1(TEXT,TEXT),
         public.hxos_universal_v1_sha256_bytes_v1(BYTEA,TEXT)
         TO ${quote(roles.migrationRole)}, ${quote(roles.commandOwnerRole)},
           ${quote(roles.financeOwnerRole)}, ${quote(roles.telemetryOwnerRole)};
       GRANT EXECUTE ON FUNCTION ${WORK_ORDER_TELEMETRY_ENVIRONMENT_FUNCTION}
         TO ${quote(roles.telemetryOwnerRole)};
       GRANT EXECUTE ON FUNCTION ${WORK_ORDER_TARGET_ACTIVATION_FUNCTION}
         TO ${quote(roles.migrationRole)};
       GRANT EXECUTE ON FUNCTION ${WORK_ORDER_RUNTIME_AUTHORITY_FUNCTION}
         TO ${quote(roles.migrationRole)}, ${quote(roles.apiRole)},
           ${quote(roles.workerRole)}, ${quote(roles.attesterRole)};
       GRANT SELECT ON TABLE
         public.hxos_universal_v1_work_order_target_activation_barrier_v1
         TO ${quote(roles.migrationRole)}, ${quote(roles.apiRole)},
           ${quote(roles.workerRole)}, ${quote(roles.attesterRole)};
       GRANT SELECT ON TABLE
         public.hxos_fake_financial_schema_evidence_v12,
         public.hxos_work_order_bootstrap_seal_evidence_v1
         TO ${quote(roles.migrationRole)};
       GRANT SELECT(id, firebase_uid, account_status, is_minor, is_banned)
         ON TABLE public.users TO ${quote(roles.assertionOwnerRole)};
       GRANT SELECT(id, universal_contract_version, automation_classification)
          ON TABLE public.tasks TO ${quote(roles.financeOwnerRole)};
        GRANT SELECT ON TABLE
          public.major_action_class_contracts,
          public.recommendations,
          public.worker_offer_decisions,
          public.worker_counter_offers
          TO ${quote(roles.telemetryOwnerRole)};
        GRANT SELECT, INSERT ON TABLE
          public.major_action_events,
          public.major_action_outcomes
          TO ${quote(roles.telemetryOwnerRole)};
       GRANT SELECT ON TABLE
         public.admin_roles,
         public.business_memberships,
         public.business_organizations,
         public.business_credentials,
         public.capability_profiles,
         public.current_verified_trade_qualifications,
         public.financial_provider_command_journal,
         public.financial_provider_command_outcome_facts,
         public.hxos_fake_financial_schema_evidence_v12,
         public.hxos_work_order_bootstrap_seal_evidence_v1,
         public.provider_estimate_submissions,
         public.task_drafts,
         public.task_estimate_acceptance_materializations,
         public.task_financial_security_events,
         public.task_routing_decisions,
         public.task_scope_versions,
         public.tasks,
         public.universal_v1_fake_financial_lifecycle_bridges,
         public.universal_v1_service_cell_authorities,
         public.users,
         public.verified_trades
         TO ${quote(roles.commandOwnerRole)};
       GRANT SELECT, INSERT ON TABLE
         public.task_work_order_command_requests,
         public.task_provider_eligibility_decisions,
         public.task_work_order_execution_facts,
         public.task_reservation_requests,
         public.task_work_orders,
         public.universal_v1_work_order_compensation_commands
         TO ${quote(roles.commandOwnerRole)};
       GRANT SELECT, INSERT ON TABLE
         public.task_reservations,
         public.task_applications
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(work_order_id, updated_at) ON TABLE public.tasks
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(id) ON TABLE public.task_drafts
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(id) ON TABLE public.task_scope_versions
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(id) ON TABLE public.task_routing_decisions
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(id) ON TABLE public.universal_v1_service_cell_authorities
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(id) ON TABLE public.task_estimate_acceptance_materializations
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(id) ON TABLE public.provider_estimate_submissions
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(id) ON TABLE public.users
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(id) ON TABLE public.admin_roles
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(user_id) ON TABLE public.capability_profiles
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(id) ON TABLE public.business_organizations
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(id) ON TABLE public.business_memberships
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(id) ON TABLE public.business_credentials
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(id) ON TABLE public.verified_trades
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(id) ON TABLE public.task_financial_security_events
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(bridge_id) ON TABLE public.universal_v1_fake_financial_lifecycle_bridges
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(idempotency_key) ON TABLE public.task_work_order_command_requests
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(id) ON TABLE public.task_provider_eligibility_decisions
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(id) ON TABLE public.task_work_orders
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(status) ON TABLE public.task_reservations
         TO ${quote(roles.commandOwnerRole)};
       GRANT UPDATE(status) ON TABLE public.task_applications
         TO ${quote(roles.commandOwnerRole)};
       GRANT EXECUTE ON FUNCTION public.claim_universal_v1_work_order_compensations(
         INTEGER,INTEGER
       ) TO ${quote(roles.commandOwnerRole)};
       GRANT EXECUTE ON FUNCTION public.universal_v1_work_order_operation_id_v1(
         TEXT,TEXT
       ) TO ${quote(roles.commandOwnerRole)};
       GRANT EXECUTE ON FUNCTION public.lock_universal_v1_estimate_authority(
         UUID,UUID,UUID,UUID,UUID
       ) TO ${quote(roles.commandOwnerRole)};
       GRANT EXECUTE ON FUNCTION public.universal_v1_invited_provider_authority_is_current(
         UUID,UUID,TEXT,UUID,TEXT,TEXT
       ) TO ${quote(roles.commandOwnerRole)};
       GRANT EXECUTE ON FUNCTION public.universal_v1_execution_internal_request_sha256(
         UUID,UUID,TEXT,TEXT,INTEGER,UUID,UUID,UUID,TEXT,TIMESTAMPTZ,TEXT
       ) TO ${quote(roles.commandOwnerRole)};
       GRANT EXECUTE ON FUNCTION public.universal_v1_financial_security_is_current_v1(
         TIMESTAMPTZ,TIMESTAMPTZ
       ) TO ${quote(roles.commandOwnerRole)};
       GRANT EXECUTE ON FUNCTION public.universal_v1_effective_financial_security_expiry_v1(
         UUID
       ) TO ${quote(roles.commandOwnerRole)};
       GRANT EXECUTE ON FUNCTION public.hxos_issue_universal_v1_actor_assertion_v1(
         TEXT,TEXT,TEXT,TEXT,JSONB,TIMESTAMPTZ
       ) TO ${quote(roles.attesterRole)};
       GRANT EXECUTE ON FUNCTION hx_authority.consume_universal_v1_actor_assertion_v1(
         TEXT,TEXT,JSONB,TEXT
       ) TO ${quote(roles.commandOwnerRole)}`
    );
    for (const identity of commandFunctions.slice(0, 5)) {
      await databaseClient!.query(
        `GRANT EXECUTE ON FUNCTION ${identity} TO ${quote(roles.apiRole)}`
      );
    }
    await databaseClient!.query(
      `GRANT EXECUTE ON FUNCTION public.hxos_build_universal_v1_work_order_actor_request_v1(
         TEXT,JSONB
       ) TO ${quote(roles.apiRole)}`
    );
    await databaseClient!.query(
      `GRANT EXECUTE ON FUNCTION public.hxos_claim_universal_v1_work_order_compensation_v2(
         INTEGER,INTEGER
       ) TO ${quote(roles.workerRole)}`
    );
    for (const ownerRole of [
      roles.migrationRole,
      roles.commandOwnerRole,
      roles.assertionOwnerRole,
      roles.financeOwnerRole,
      roles.telemetryOwnerRole,
    ]) {
      await databaseClient!.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(ownerRole)}
           REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`
      );
    }

    migrationClient = new pg.Client({
      connectionString: databaseUrl(roles.migrationRole, passwords.migrationRole),
    });
    apiClient = new pg.Client({ connectionString: databaseUrl(roles.apiRole, passwords.apiRole) });
    workerClient = new pg.Client({
      connectionString: databaseUrl(roles.workerRole, passwords.workerRole),
    });
    attesterClient = new pg.Client({
      connectionString: databaseUrl(roles.attesterRole, passwords.attesterRole),
    });
    await Promise.all([
      migrationClient.connect(),
      apiClient.connect(),
      workerClient.connect(),
      attesterClient.connect(),
    ]);
    const report: WorkOrderCommandAuthorityReport = await verifyWorkOrderCommandAuthority(
      authorityTransaction(migrationClient),
      roleAuthorityEnvironment
    );
    expect(report).toMatchObject({ status: 'READY', reasons: [], actorBindingProven: true });
    for (const [verifierRole, client] of [
      ['apiRole', apiClient],
      ['workerRole', workerClient],
      ['attesterRole', attesterClient],
    ] as const) {
      const runtimeAuthority = await client.query(
        `SELECT * FROM ${WORK_ORDER_RUNTIME_AUTHORITY_FUNCTION}`
      );
      expect(runtimeAuthority.rows).toEqual([
        expect.objectContaining({
          session_database_role: roles[verifierRole],
          target_database_name: proofDatabase,
          environment: 'local',
          release_manifest_sha256: releaseManifestSha256,
          ordinal146_sql_sha256: sha256(migrationSql),
          v12_sql_sha256: sha256(v12MigrationSql),
          seal_sql_sha256: sha256(bootstrapSealMigrationSql),
          fake_financial_operations_relation:
            'public.hxos_fake_financial_operations_v1',
          fake_financial_operation_events_relation:
            'public.hxos_fake_financial_operation_events_v1',
        }),
      ]);
      await expect(
        verifyWorkOrderCommandAuthority(
          authorityTransaction(client),
          roleAuthorityEnvironment,
          verifierRole
        )
      ).resolves.toMatchObject({
        status: 'READY',
        reasons: [],
        currentRole: roles[verifierRole],
        sessionRole: roles[verifierRole],
      });
    }
    await refusal(
      () =>
        apiClient!.query(
          `SELECT public.hxos_universal_v1_sha256_bytes_v1('api-must-not-hash', 'sha256')`
        ),
      /permission denied/iu
    );
    const sealedEvidenceBeforeTamper = await databaseClient!.query(
      `SELECT 'v12'::TEXT AS evidence_kind, migration_name,
              pg_catalog.btrim(migration_sql_sha256) AS migration_sql_sha256,
              pg_catalog.btrim(ordinal146_sql_sha256) AS ordinal146_sql_sha256,
              NULL::TEXT AS v12_sql_sha256
         FROM public.hxos_fake_financial_schema_evidence_v12
       UNION ALL
       SELECT 'seal', migration_name,
              pg_catalog.btrim(migration_sql_sha256),
              pg_catalog.btrim(ordinal146_sql_sha256),
              pg_catalog.btrim(v12_sql_sha256)
         FROM public.hxos_work_order_bootstrap_seal_evidence_v1
       ORDER BY evidence_kind`
    );
    for (const statement of [
      `UPDATE public.hxos_fake_financial_schema_evidence_v12
          SET migration_sql_sha256 = ${"'f'"} || pg_catalog.repeat('f', 63)`,
      `DELETE FROM public.hxos_fake_financial_schema_evidence_v12`,
      `TRUNCATE public.hxos_fake_financial_schema_evidence_v12`,
      `ALTER TABLE public.hxos_fake_financial_schema_evidence_v12
         DISABLE TRIGGER USER`,
      `ALTER TABLE public.hxos_fake_financial_schema_evidence_v12
         OWNER TO ${quote(roles.migrationRole)}`,
      `UPDATE public.hxos_work_order_bootstrap_seal_evidence_v1
          SET migration_sql_sha256 = ${"'f'"} || pg_catalog.repeat('f', 63)`,
      `DELETE FROM public.hxos_work_order_bootstrap_seal_evidence_v1`,
      `TRUNCATE public.hxos_work_order_bootstrap_seal_evidence_v1`,
      `ALTER TABLE public.hxos_work_order_bootstrap_seal_evidence_v1
         DISABLE TRIGGER USER`,
      `ALTER TABLE public.hxos_work_order_bootstrap_seal_evidence_v1
         OWNER TO ${quote(roles.migrationRole)}`,
    ]) {
      await refusal(() => migrationClient!.query(statement), /must be owner|permission denied/iu);
    }
    expect(
      (
        await databaseClient!.query(
          `SELECT 'v12'::TEXT AS evidence_kind, migration_name,
                  pg_catalog.btrim(migration_sql_sha256) AS migration_sql_sha256,
                  pg_catalog.btrim(ordinal146_sql_sha256) AS ordinal146_sql_sha256,
                  NULL::TEXT AS v12_sql_sha256
             FROM public.hxos_fake_financial_schema_evidence_v12
           UNION ALL
           SELECT 'seal', migration_name,
                  pg_catalog.btrim(migration_sql_sha256),
                  pg_catalog.btrim(ordinal146_sql_sha256),
                  pg_catalog.btrim(v12_sql_sha256)
             FROM public.hxos_work_order_bootstrap_seal_evidence_v1
           ORDER BY evidence_kind`
        )
      ).rows
    ).toEqual(sealedEvidenceBeforeTamper.rows);
    for (const client of [apiClient, workerClient, attesterClient]) {
      await refusal(
        () =>
          client.query(
            `SELECT migration_name FROM public.hxos_fake_financial_schema_evidence_v12`
          ),
        /permission denied/iu
      );
      await refusal(
        () =>
          client.query(
            `SELECT migration_name FROM public.hxos_work_order_bootstrap_seal_evidence_v1`
          ),
        /permission denied/iu
      );
      await refusal(
        () => client.query(`INSERT INTO public.task_work_order_command_requests DEFAULT VALUES`),
        /permission denied/iu
      );
      await refusal(
        () =>
          client.query(
            `SELECT idempotency_key FROM public.task_work_order_command_requests LIMIT 1`
          ),
        /permission denied/iu
      );
      await refusal(
        () => client.query(`SELECT id FROM public.tasks LIMIT 1`),
        /permission denied/iu
      );
      await refusal(
        () => client.query(`SELECT id FROM public.major_action_events LIMIT 1`),
        /permission denied/iu
      );
    }
    const beforeWorkerReplay = await databaseClient!.query<{
      audit_count: number;
      compensation_count: number;
      work_order_count: number;
    }>(
      `SELECT (
                SELECT pg_catalog.count(*)::INTEGER
                  FROM hx_authority.universal_v1_work_order_command_execution_facts
                 WHERE command_kind = 'CLAIM_WORK_ORDER_COMPENSATION'
              ) AS audit_count,
              (
                SELECT pg_catalog.count(*)::INTEGER
                  FROM public.universal_v1_work_order_compensation_commands
              ) AS compensation_count,
              (SELECT pg_catalog.count(*)::INTEGER FROM public.task_work_orders)
                AS work_order_count`
    );
    for (let replay = 0; replay < 2; replay += 1) {
      expect(
        (
          await workerClient!.query(
            `SELECT *
               FROM public.hxos_claim_universal_v1_work_order_compensation_v2(5, 30)`
          )
        ).rows
      ).toEqual([]);
    }
    const afterWorkerReplay = await databaseClient!.query<{
      audit_count: number;
      distinct_request_count: number;
      compensation_count: number;
      work_order_count: number;
      all_no_effect: boolean;
    }>(
      `SELECT (
                SELECT pg_catalog.count(*)::INTEGER
                  FROM hx_authority.universal_v1_work_order_command_execution_facts
                 WHERE command_kind = 'CLAIM_WORK_ORDER_COMPENSATION'
              ) AS audit_count,
              (
                SELECT pg_catalog.count(DISTINCT canonical_request_sha256)::INTEGER
                  FROM hx_authority.universal_v1_work_order_command_execution_facts
                 WHERE command_kind = 'CLAIM_WORK_ORDER_COMPENSATION'
              ) AS distinct_request_count,
              (
                SELECT pg_catalog.count(*)::INTEGER
                  FROM public.universal_v1_work_order_compensation_commands
              ) AS compensation_count,
              (SELECT pg_catalog.count(*)::INTEGER FROM public.task_work_orders)
                AS work_order_count,
              COALESCE((
                SELECT pg_catalog.bool_and(
                         hard_assignment_created IS FALSE
                         AND payment_creation_performed IS FALSE
                       )
                  FROM hx_authority.universal_v1_work_order_command_execution_facts
                 WHERE command_kind = 'CLAIM_WORK_ORDER_COMPENSATION'
              ), FALSE) AS all_no_effect`
    );
    expect(afterWorkerReplay.rows[0]).toEqual({
      audit_count: beforeWorkerReplay.rows[0]!.audit_count + 2,
      distinct_request_count: 1,
      compensation_count: beforeWorkerReplay.rows[0]!.compensation_count,
      work_order_count: beforeWorkerReplay.rows[0]!.work_order_count,
      all_no_effect: true,
    });
  });

  it('proves the separately seeded fake-finance v1-v11 chain without API finance grants', async () => {
    const evidenceRelations = Array.from(
      { length: 11 },
      (_, index) => `public.hxos_fake_financial_schema_evidence_v${index + 1}`
    );
    const bootstrap = await databaseClient!.query<{
      relation_name: string;
      installed: boolean;
    }>(
      `SELECT relation_name,
              pg_catalog.to_regclass(relation_name) IS NOT NULL AS installed
         FROM pg_catalog.unnest($1::TEXT[]) relation_name
        ORDER BY relation_name`,
      [evidenceRelations]
    );
    expect(bootstrap.rows).toHaveLength(11);
    expect(bootstrap.rows.every((row) => row.installed)).toBe(true);
    const v11 = await databaseClient!.query<{ atomic_event_port: boolean; expiry_recovery: boolean }>(
      `SELECT pg_catalog.to_regprocedure(
                'public.hxos_record_fake_financial_security_event_v1(uuid,uuid,text,uuid,text,uuid,uuid,uuid,uuid,uuid)'
              ) IS NOT NULL AS atomic_event_port,
              pg_catalog.to_regclass(
                'public.hxos_fake_financial_legacy_expiry_noncompensable_facts_v10'
              ) IS NOT NULL AS expiry_recovery`
    );
    expect(v11.rows).toEqual([{ atomic_event_port: true, expiry_recovery: true }]);
    await transactionalRefusal(
      apiClient!,
      'BEGIN ISOLATION LEVEL SERIALIZABLE',
      () =>
        apiClient!.query(
          `SELECT public.hxos_record_fake_financial_security_event_v1(
             NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL
           )`
        ),
      /permission denied/iu
    );
  });

  it('allows attestation only through the attester and consumes it inside the human port', async () => {
    const taskId = 'fb200000-0000-4000-8000-000000000001';
    const key = 'work-order:port-actor-proof:0001';
    const opaque = token();
    await attesterClient!.query(
      `SELECT * FROM public.hxos_issue_universal_v1_actor_assertion_v1(
         $1, 'local', 'EXPRESS_POST_ESTIMATE_INTEREST', $2, $3::JSONB,
         pg_catalog.clock_timestamp() + INTERVAL '45 seconds'
       )`,
      [opaque, actorRequestSha256, authFacts()]
    );
    await transactionalRefusal(
      apiClient!,
      'BEGIN ISOLATION LEVEL SERIALIZABLE',
      () =>
        apiClient!.query(
          `SELECT * FROM public.hxos_express_universal_v1_post_estimate_interest_v1(
           $1, $2, 1, $3, $4
         )`,
          [opaque, taskId, key, actorClientTimestamp]
        ),
      /HXUV1-WOCMD-12/u
    );
    await transactionalRefusal(
      apiClient!,
      'BEGIN ISOLATION LEVEL SERIALIZABLE',
      () =>
        apiClient!.query(
          `SELECT * FROM public.hxos_express_universal_v1_post_estimate_interest_v1(
           $1, $2, 1, $3, $4
         )`,
          [token(), taskId, key, actorClientTimestamp]
        ),
      /HXUV1-ACTOR-22/u
    );
    await refusal(
      () =>
        apiClient!.query(
          `SELECT * FROM public.hxos_issue_universal_v1_actor_assertion_v1(
           $1, 'local', 'EXPRESS_POST_ESTIMATE_INTEREST', $2, $3::JSONB,
           pg_catalog.clock_timestamp() + INTERVAL '45 seconds'
         )`,
          [token(), actorRequestSha256, authFacts()]
        ),
      /permission denied/iu
    );
  });

  it('rejects duplicate active canonical subjects before assertion consumption or domain writes', async () => {
    const taskId = 'fb200000-0000-4000-8000-000000000001';
    const key = 'work-order:duplicate-actor:0001';
    const clientTimestamp = new Date().toISOString();
    const binding = await databaseClient!.query<{ actor_request_sha256: string }>(
      `SELECT actor_request_sha256
         FROM hx_authority.build_universal_v1_work_order_command_request_v1(
           'EXPRESS_POST_ESTIMATE_INTEREST',
           pg_catalog.jsonb_build_object(
             'task_id', $1::UUID,
             'expected_scope_version', 1,
             'idempotency_key', $2::TEXT,
             'client_timestamp_epoch_ms',
               pg_catalog.floor(EXTRACT(EPOCH FROM $3::TIMESTAMPTZ) * 1000)::BIGINT
           )
         )`,
      [taskId, key, clientTimestamp]
    );
    const opaque = token();
    await attesterClient!.query(
      `SELECT * FROM public.hxos_issue_universal_v1_actor_assertion_v1(
         $1, 'local', 'EXPRESS_POST_ESTIMATE_INTEREST', $2, $3::JSONB,
         pg_catalog.clock_timestamp() + INTERVAL '45 seconds'
       )`,
      [opaque, binding.rows[0]!.actor_request_sha256, authFacts()]
    );

    const writeSnapshot = async () =>
      (
        await databaseClient!.query(
          `SELECT
             (SELECT pg_catalog.count(*)::INTEGER
                FROM hx_authority.universal_v1_actor_assertion_consumption_facts)
               AS assertion_consumptions,
             (SELECT pg_catalog.count(*)::INTEGER
                FROM hx_authority.universal_v1_work_order_command_execution_facts)
               AS authority_executions,
             (SELECT pg_catalog.count(*)::INTEGER
                FROM public.task_work_order_command_requests) AS requests,
             (SELECT pg_catalog.count(*)::INTEGER
                FROM public.task_provider_eligibility_decisions) AS eligibility,
             (SELECT pg_catalog.count(*)::INTEGER FROM public.task_applications)
               AS applications,
             (SELECT pg_catalog.count(*)::INTEGER FROM public.task_reservations)
               AS reservations,
             (SELECT pg_catalog.count(*)::INTEGER FROM public.task_work_orders)
               AS work_orders,
             (SELECT pg_catalog.count(*)::INTEGER
                FROM public.task_work_order_execution_facts) AS domain_executions,
             (SELECT pg_catalog.count(*)::INTEGER
                FROM public.universal_v1_work_order_compensation_commands)
               AS compensations,
             (SELECT pg_catalog.count(*)::INTEGER
                FROM hx_authority.universal_v1_actor_assertion_consumption_facts
               WHERE token_sha256 = $1) AS matching_assertion_consumptions`,
          [sha256(opaque)]
        )
      ).rows;
    const before = await writeSnapshot();
    const duplicateUserId = randomUUID();
    let transactionOpen = false;
    await databaseClient!.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    transactionOpen = true;
    try {
      const constraint = await databaseClient!.query<{ conname: string }>(
        `SELECT constraint_state.conname
           FROM pg_catalog.pg_constraint constraint_state
          WHERE constraint_state.conrelid = 'public.users'::pg_catalog.regclass
            AND constraint_state.contype = 'u'
            AND constraint_state.conkey = ARRAY[
                  (
                    SELECT attribute_state.attnum
                      FROM pg_catalog.pg_attribute attribute_state
                     WHERE attribute_state.attrelid = constraint_state.conrelid
                       AND attribute_state.attname = 'firebase_uid'
                       AND attribute_state.attisdropped IS FALSE
                  )
                ]::SMALLINT[]`
      );
      expect(constraint.rows).toHaveLength(1);
      const constraintName = constraint.rows[0]!.conname;
      expect(constraintName).toMatch(/^[a-z_][a-z0-9_]*$/u);
      await databaseClient!.query(
        `ALTER TABLE public.users DROP CONSTRAINT "${constraintName}"`
      );
      await databaseClient!.query(
        `INSERT INTO public.users(
           id, firebase_uid, email, full_name, default_mode, account_status,
           is_minor, is_banned
         ) VALUES (
           $1, $2, $3, 'Duplicate active Work Order actor', 'poster', 'ACTIVE',
           FALSE, FALSE
         )`,
        [duplicateUserId, verifiedSubject, `${duplicateUserId}@synthetic.invalid`]
      );
      await databaseClient!.query(`SET LOCAL ROLE ${quote(roles.apiRole)}`);
      await databaseClient!.query('SAVEPOINT duplicate_actor_command');
      await refusal(
        () =>
          databaseClient!.query(
            `SELECT * FROM public.hxos_express_universal_v1_post_estimate_interest_v1(
               $1, $2, 1, $3, $4
             )`,
            [opaque, taskId, key, clientTimestamp]
          ),
        /HXUV1-ACTOR-32/u
      );
      await databaseClient!.query('ROLLBACK TO SAVEPOINT duplicate_actor_command');
      await databaseClient!.query('RESET ROLE');
      expect(await writeSnapshot()).toEqual(before);
    } finally {
      if (transactionOpen) {
        await databaseClient!.query('ROLLBACK').catch(() => undefined);
        transactionOpen = false;
      }
    }
    expect(await writeSnapshot()).toEqual(before);
    expect(
      (
        await databaseClient!.query(
          `SELECT pg_catalog.count(*)::INTEGER AS constraint_count
             FROM pg_catalog.pg_constraint constraint_state
            WHERE constraint_state.conrelid = 'public.users'::pg_catalog.regclass
              AND constraint_state.contype = 'u'
              AND constraint_state.conkey = ARRAY[
                    (
                      SELECT attribute_state.attnum
                        FROM pg_catalog.pg_attribute attribute_state
                       WHERE attribute_state.attrelid = constraint_state.conrelid
                         AND attribute_state.attname = 'firebase_uid'
                         AND attribute_state.attisdropped IS FALSE
                    )
                  ]::SMALLINT[]`
        )
      ).rows
    ).toEqual([{ constraint_count: 1 }]);
  });

  it('requires writable SERIALIZABLE admission and exact millisecond timestamps before any write', async () => {
    const dummyUuid = '00000000-0000-4000-8000-000000000001';
    const now = new Date().toISOString();
    const commandCases = [
      {
        sql: `SELECT * FROM public.hxos_express_universal_v1_post_estimate_interest_v1(
                $1, $2, 1, $3, $4
              )`,
        params: ['isolation-assertion', dummyUuid, 'isolation-interest-0001', now],
      },
      {
        sql: `SELECT * FROM public.hxos_place_universal_v1_conditional_hold_v1(
                $1, $2, 1, $3, $4
              )`,
        params: ['isolation-assertion', dummyUuid, 'isolation-hold-0001', now],
      },
      {
        sql: `SELECT * FROM public.hxos_prepare_universal_v1_fake_work_order_v1(
                $1, $2, 1, $3, $4
              )`,
        params: ['isolation-assertion', dummyUuid, 'isolation-prepare-0001', now],
      },
      {
        sql: `SELECT * FROM public.hxos_materialize_universal_v1_fake_work_order_v1(
                $1, $2, $3, $4
              )`,
        params: ['isolation-assertion', 'isolation-materialize-0001', '1'.repeat(64), dummyUuid],
      },
      {
        sql: `SELECT * FROM public.hxos_request_universal_v1_fake_work_order_recovery_v1(
                $1, $2, $3, $4
              )`,
        params: ['isolation-assertion', 'isolation-recovery-0001', '1'.repeat(64), dummyUuid],
      },
    ] as const;
    const writeSnapshot = async () =>
      (
        await databaseClient!.query(
          `SELECT
             (SELECT pg_catalog.count(*)::INTEGER
                FROM hx_authority.universal_v1_actor_assertion_consumption_facts)
               AS assertion_consumptions,
             (SELECT pg_catalog.count(*)::INTEGER
                FROM hx_authority.universal_v1_work_order_command_execution_facts)
               AS authority_executions,
             (SELECT pg_catalog.count(*)::INTEGER
                FROM public.task_work_order_command_requests) AS requests,
             (SELECT pg_catalog.count(*)::INTEGER
                FROM public.task_provider_eligibility_decisions) AS eligibility,
             (SELECT pg_catalog.count(*)::INTEGER FROM public.task_applications)
               AS applications,
             (SELECT pg_catalog.count(*)::INTEGER FROM public.task_reservations)
               AS reservations,
             (SELECT pg_catalog.count(*)::INTEGER FROM public.task_work_orders)
               AS work_orders,
             (SELECT pg_catalog.count(*)::INTEGER
                FROM public.task_work_order_execution_facts) AS domain_executions,
             (SELECT pg_catalog.count(*)::INTEGER
                FROM public.universal_v1_work_order_compensation_commands)
               AS compensations`
        )
      ).rows;
    const before = await writeSnapshot();

    for (const command of commandCases) {
      await refusal(
        () => apiClient!.query(command.sql, [...command.params]),
        /HXUV1-WOCMD-7/u
      );
      await transactionalRefusal(
        apiClient!,
        'BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY',
        () => apiClient!.query(command.sql, [...command.params]),
        /HXUV1-WOCMD-7/u
      );
    }

    const subMillisecond = now.replace(
      /(\.\d{3})Z$/u,
      (_match, milliseconds: string) => `${milliseconds}456Z`
    );
    for (const [index, command] of commandCases.slice(0, 3).entries()) {
      const changedParams = [...command.params];
      changedParams[3] = subMillisecond;
      await transactionalRefusal(
        apiClient!,
        'BEGIN ISOLATION LEVEL SERIALIZABLE',
        () => apiClient!.query(command.sql, changedParams),
        new RegExp(`HXUV1-WOCMD-${10 + index * 10}`, 'u')
      );
    }

    expect(await writeSnapshot()).toEqual(before);
  });

  it('fails live readback for rogue LOGIN, membership, schema, relation, and grant-option authority', async () => {
    const financeRogueFunction = `hx_ci_wo_finance_function_${suffix}`;
    safeIdentifier(financeRogueFunction);
    await adminClient!.query(
      `CREATE ROLE ${quote(rogueRole)} LOGIN PASSWORD 'hx-ci-rogue-${suffix}'
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`
    );
    const verify = () =>
      verifyWorkOrderCommandAuthority(
        authorityTransaction(migrationClient!),
        roleAuthorityEnvironment
      );
    let originalInterestDefinition: string | null = null;
    let migrationOwnerSentinelCreated = false;
    const expectReady = async () => {
      expect(await verify()).toMatchObject({ status: 'READY', reasons: [] });
    };
    const expectDisabledTriggerBlocked = async (relation: string, trigger: string) => {
      expect(relation).toMatch(/^(?:hx_authority|public)\.[a-z_][a-z0-9_]*$/u);
      expect(trigger).toMatch(/^[a-z_][a-z0-9_]*$/u);
      try {
        await databaseClient!.query(`ALTER TABLE ${relation} DISABLE TRIGGER ${trigger}`);
        expect((await verify()).reasons).toEqual(
          expect.arrayContaining([expect.stringContaining('WORK_ORDER_TRIGGER_CATALOG_MISMATCH:')])
        );
      } finally {
        await databaseClient!.query(`ALTER TABLE ${relation} ENABLE TRIGGER ${trigger}`);
      }
      await expectReady();
    };
    const expectDroppedTriggerBlocked = async (relation: string, trigger: string) => {
      expect(relation).toMatch(/^(?:hx_authority|public)\.[a-z_][a-z0-9_]*$/u);
      expect(trigger).toMatch(/^[a-z_][a-z0-9_]*$/u);
      const catalog = await databaseClient!.query<{ definition: string }>(
        `SELECT pg_catalog.pg_get_triggerdef(trigger_state.oid, false) AS definition
           FROM pg_catalog.pg_trigger trigger_state
          WHERE trigger_state.tgrelid = $1::pg_catalog.regclass
            AND trigger_state.tgname = $2
            AND trigger_state.tgisinternal IS FALSE`,
        [relation, trigger]
      );
      expect(catalog.rows).toHaveLength(1);
      const triggerDefinition = catalog.rows[0]!.definition;
      let dropped = false;
      try {
        await databaseClient!.query(`DROP TRIGGER ${trigger} ON ${relation}`);
        dropped = true;
        expect((await verify()).reasons).toEqual(
          expect.arrayContaining([expect.stringContaining('WORK_ORDER_TRIGGER_CATALOG_MISMATCH:')])
        );
      } finally {
        if (dropped) await databaseClient!.query(triggerDefinition);
      }
      await expectReady();
    };
    try {
      await databaseClient!.query(`SET ROLE ${quote(roles.migrationRole)}`);
      try {
        const setRoleReport = await verifyWorkOrderCommandAuthority(
          authorityTransaction(databaseClient!),
          roleAuthorityEnvironment
        );
        expect(setRoleReport).toMatchObject({
          currentRole: roles.migrationRole,
          sessionRole: 'hx_ci_runner',
        });
        expect(setRoleReport.reasons).toContain(
          'SESSION_ROLE_IS_NOT_CONFIGURED_MIGRATION_ROLE'
        );
      } finally {
        await databaseClient!.query(`RESET ROLE`);
      }

      await databaseClient!.query(
        `GRANT EXECUTE ON FUNCTION public.hxos_express_universal_v1_post_estimate_interest_v1(
           TEXT,UUID,INTEGER,TEXT,TIMESTAMPTZ
         ) TO ${quote(rogueRole)}`
      );
      expect((await verify()).reasons).toEqual(
        expect.arrayContaining([
          expect.stringContaining('FUNCTION_EXECUTE_GRANTEE_SET_MISMATCH:'),
        ])
      );
      await databaseClient!.query(
        `REVOKE EXECUTE ON FUNCTION public.hxos_express_universal_v1_post_estimate_interest_v1(
           TEXT,UUID,INTEGER,TEXT,TIMESTAMPTZ
         ) FROM ${quote(rogueRole)}`
      );

      await adminClient!.query(
        `GRANT ${quote(roles.commandOwnerRole)} TO ${quote(rogueRole)}`
      );
      expect((await verify()).reasons).toEqual(
        expect.arrayContaining([
          `PROTECTED_ROLE_MEMBERSHIP_EDGE:${roles.commandOwnerRole}:${rogueRole}`,
          `UNEXPECTED_LOGIN_ROLE_REACHES_PROTECTED_ROLE:${rogueRole}:${roles.commandOwnerRole}`,
        ])
      );
      await adminClient!.query(
        `REVOKE ${quote(roles.commandOwnerRole)} FROM ${quote(rogueRole)}`
      );

      await databaseClient!.query(`GRANT CREATE ON SCHEMA public TO ${quote(rogueRole)}`);
      expect((await verify()).reasons).toEqual(
        expect.arrayContaining([
          expect.stringContaining('PROTECTED_SCHEMA_CREATE_ACL_MISMATCH:public:'),
        ])
      );
      await databaseClient!.query(`REVOKE CREATE ON SCHEMA public FROM ${quote(rogueRole)}`);

      await databaseClient!.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(roles.financeOwnerRole)}
           GRANT EXECUTE ON FUNCTIONS TO ${quote(rogueRole)}`
      );
      expect((await verify()).reasons).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            `DEFAULT_PRIVILEGE_ACL_MISMATCH:${roles.financeOwnerRole}|GLOBAL|FUNCTION:`
          ),
        ])
      );
      await databaseClient!.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(roles.financeOwnerRole)}
           REVOKE EXECUTE ON FUNCTIONS FROM ${quote(rogueRole)}`
      );

      await databaseClient!.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(roles.commandOwnerRole)}
           IN SCHEMA public GRANT SELECT ON TABLES TO ${quote(rogueRole)}`
      );
      expect((await verify()).reasons).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            `DEFAULT_PRIVILEGE_ACL_MISMATCH:${roles.commandOwnerRole}|public|TABLE:`
          ),
        ])
      );
      await databaseClient!.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(roles.commandOwnerRole)}
           IN SCHEMA public REVOKE SELECT ON TABLES FROM ${quote(rogueRole)}`
      );

      await databaseClient!.query(
        `CREATE FUNCTION public.${quote(financeRogueFunction)}()
         RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
         SET search_path = pg_catalog AS $$ BEGIN RETURN; END $$;
         ALTER FUNCTION public.${quote(financeRogueFunction)}()
           OWNER TO ${quote(roles.financeOwnerRole)}`
      );
      expect((await verify()).reasons).toContain(
        `UNPLANNED_AUTHORITY_OWNER_FUNCTION:${roles.financeOwnerRole}:` +
          `public.${financeRogueFunction}()`
      );
      await databaseClient!.query(`DROP FUNCTION public.${quote(financeRogueFunction)}()`);

      await databaseClient!.query(
        `GRANT SELECT ON TABLE public.task_work_orders TO ${quote(rogueRole)}`
      );
      expect((await verify()).reasons).toContain(
        `UNEXPECTED_RELATION_ACL_GRANT:public.task_work_orders:${rogueRole}|SELECT|*`
      );
      await databaseClient!.query(
        `REVOKE SELECT ON TABLE public.task_work_orders FROM ${quote(rogueRole)}`
      );

      await databaseClient!.query(
        `GRANT SELECT(id) ON TABLE public.task_work_orders TO ${quote(rogueRole)}`
      );
      expect((await verify()).reasons).toContain(
        `UNEXPECTED_RELATION_ACL_GRANT:public.task_work_orders:${rogueRole}|SELECT|id`
      );
      await databaseClient!.query(
        `REVOKE SELECT(id) ON TABLE public.task_work_orders FROM ${quote(rogueRole)}`
      );

      for (const identity of WORK_ORDER_TELEMETRY_FUNCTIONS) {
        await databaseClient!.query(
          `GRANT EXECUTE ON FUNCTION ${identity} TO ${quote(rogueRole)} WITH GRANT OPTION`
        );
        expect((await verify()).reasons).toEqual(
          expect.arrayContaining([
            expect.stringContaining(
              `FUNCTION_EXECUTE_GRANTEE_SET_MISMATCH:${identity}:`
            ),
            expect.stringContaining('|WITH_GRANT_OPTION'),
          ])
        );
        await databaseClient!.query(
          `REVOKE ALL PRIVILEGES ON FUNCTION ${identity} FROM ${quote(rogueRole)}`
        );
        await expectReady();

        await databaseClient!.query(
          `ALTER FUNCTION ${identity} OWNER TO ${quote(rogueRole)}`
        );
        expect((await verify()).reasons).toEqual(
          expect.arrayContaining([
            `FUNCTION_OWNER_MISMATCH:${identity}`,
            expect.stringContaining('AUTHORITY_OWNER_FUNCTION_INVENTORY_MISSING:'),
          ])
        );
        await databaseClient!.query(
          `ALTER FUNCTION ${identity} OWNER TO ${quote(roles.telemetryOwnerRole)};
           REVOKE ALL PRIVILEGES ON FUNCTION ${identity} FROM PUBLIC;
           REVOKE ALL PRIVILEGES ON FUNCTION ${identity} FROM ${quote(rogueRole)}`
        );
        await expectReady();
      }

      await databaseClient!.query(
        `ALTER FUNCTION public.enforce_universal_active_scope_transition() RESET search_path`
      );
      expect((await verify()).reasons).toEqual(
        expect.arrayContaining([expect.stringContaining('WORK_ORDER_TRIGGER_CATALOG_MISMATCH:')])
      );
      await databaseClient!.query(
        `ALTER FUNCTION public.enforce_universal_active_scope_transition()
           SET search_path TO pg_catalog, public`
      );

      expect(
        (
          await adminClient!.query(
            `SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'MIGRATION_OWNER'`
          )
        ).rows
      ).toEqual([]);
      await adminClient!.query(
        `CREATE ROLE "MIGRATION_OWNER" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
           NOINHERIT NOREPLICATION NOBYPASSRLS`
      );
      migrationOwnerSentinelCreated = true;
      await databaseClient!.query(
        `ALTER FUNCTION public.enforce_universal_active_scope_transition()
           OWNER TO "MIGRATION_OWNER"`
      );
      expect((await verify()).reasons).toEqual(
        expect.arrayContaining([
          expect.stringContaining('WORK_ORDER_TRIGGER_CATALOG_MISMATCH:'),
          expect.stringContaining('AUTHORITY_OWNER_FUNCTION_INVENTORY_MISSING:'),
        ])
      );
      await databaseClient!.query(
        `ALTER FUNCTION public.enforce_universal_active_scope_transition()
           OWNER TO ${quote(roles.migrationRole)}`
      );
      await adminClient!.query(`DROP ROLE "MIGRATION_OWNER"`);
      migrationOwnerSentinelCreated = false;
      await expectReady();

      await databaseClient!.query(
        `ALTER TABLE public.tasks DISABLE TRIGGER universal_active_scope_transition_guard`
      );
      expect((await verify()).reasons).toEqual(
        expect.arrayContaining([expect.stringContaining('WORK_ORDER_TRIGGER_CATALOG_MISMATCH:')])
      );
      await databaseClient!.query(
        `ALTER TABLE public.tasks ENABLE REPLICA TRIGGER universal_active_scope_transition_guard`
      );
      expect((await verify()).reasons).toEqual(
        expect.arrayContaining([expect.stringContaining('WORK_ORDER_TRIGGER_CATALOG_MISMATCH:')])
      );
      await databaseClient!.query(
        `ALTER TABLE public.tasks ENABLE ALWAYS TRIGGER universal_active_scope_transition_guard`
      );
      expect((await verify()).reasons).toEqual(
        expect.arrayContaining([expect.stringContaining('WORK_ORDER_TRIGGER_CATALOG_MISMATCH:')])
      );
      await databaseClient!.query(
        `ALTER TABLE public.tasks ENABLE TRIGGER universal_active_scope_transition_guard`
      );
      await expectReady();

      await expectDisabledTriggerBlocked(
        'hx_authority.universal_v1_actor_assertion_issuance_facts',
        'universal_v1_actor_assertion_issuance_no_mutation_v2'
      );
      await expectDroppedTriggerBlocked(
        'hx_authority.universal_v1_actor_assertion_consumption_facts',
        'universal_v1_actor_assertion_consumption_no_truncate_v2'
      );
      await expectDisabledTriggerBlocked(
        'hx_authority.universal_v1_work_order_target_authority_facts',
        'universal_v1_work_order_target_activation_guard_v1'
      );
      await expectDroppedTriggerBlocked(
        'hx_authority.universal_v1_work_order_command_execution_facts',
        'universal_v1_work_order_command_execution_no_truncate_v1'
      );
      await expectDisabledTriggerBlocked(
        'public.provider_estimate_submissions',
        'universal_provider_estimate_guard'
      );
      await expectDroppedTriggerBlocked(
        'public.task_routing_decisions',
        'universal_routing_sequence_guard'
      );
      await expectDisabledTriggerBlocked(
        'public.financial_provider_command_journal',
        'financial_provider_command_no_truncate'
      );
      await expectDroppedTriggerBlocked(
        'public.major_action_events',
        'major_action_events_no_truncate'
      );

      const definitionResult = await databaseClient!.query<{ definition: string }>(
        `SELECT pg_catalog.pg_get_functiondef(
           'public.hxos_express_universal_v1_post_estimate_interest_v1(text,uuid,integer,text,timestamptz)'
             ::pg_catalog.regprocedure
         ) AS definition`
      );
      originalInterestDefinition = definitionResult.rows[0]!.definition;
      const tamperedDefinition = originalInterestDefinition.replace(
        /\nBEGIN\b/u,
        `\nBEGIN\n  RAISE EXCEPTION 'HX exact function catalog tamper proof';`
      );
      expect(tamperedDefinition).not.toBe(originalInterestDefinition);
      await databaseClient!.query(tamperedDefinition);
      expect((await verify()).reasons).toEqual(
        expect.arrayContaining([
          expect.stringContaining('WORK_ORDER_AUTHORITY_FUNCTION_CATALOG_MISMATCH:'),
        ])
      );
      await databaseClient!.query(originalInterestDefinition);
      originalInterestDefinition = null;
      await expectReady();

      await databaseClient!.query(
        `GRANT EXECUTE ON FUNCTION public.hxos_express_universal_v1_post_estimate_interest_v1(
           TEXT,UUID,INTEGER,TEXT,TIMESTAMPTZ
         ) TO ${quote(roles.apiRole)} WITH GRANT OPTION`
      );
      expect((await verify()).reasons).toEqual(
        expect.arrayContaining([
          expect.stringContaining('|WITH_GRANT_OPTION'),
        ])
      );
      await databaseClient!.query(
        `REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION
         public.hxos_express_universal_v1_post_estimate_interest_v1(
           TEXT,UUID,INTEGER,TEXT,TIMESTAMPTZ
         ) FROM ${quote(roles.apiRole)} CASCADE`
      );
      await expectReady();
    } finally {
      if (originalInterestDefinition !== null) {
        await databaseClient!.query(originalInterestDefinition).catch(() => undefined);
      }
      await databaseClient!.query(
        `ALTER FUNCTION public.enforce_universal_active_scope_transition()
           OWNER TO ${quote(roles.migrationRole)}`
      ).catch(() => undefined);
      if (migrationOwnerSentinelCreated) {
        await adminClient!.query(`DROP ROLE IF EXISTS "MIGRATION_OWNER"`).catch(() => undefined);
      }
      await databaseClient!.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(roles.financeOwnerRole)}
           REVOKE EXECUTE ON FUNCTIONS FROM ${quote(rogueRole)};
         ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(roles.commandOwnerRole)}
           IN SCHEMA public REVOKE SELECT ON TABLES FROM ${quote(rogueRole)};
         DROP FUNCTION IF EXISTS public.${quote(financeRogueFunction)}()`
      ).catch(() => undefined);
      await databaseClient!.query(
        `REVOKE ALL PRIVILEGES ON FUNCTION
           public.hxos_express_universal_v1_post_estimate_interest_v1(
             TEXT,UUID,INTEGER,TEXT,TIMESTAMPTZ
           ) FROM ${quote(rogueRole)};
           REVOKE ALL PRIVILEGES ON TABLE public.task_work_orders FROM ${quote(rogueRole)};
           REVOKE SELECT(id) ON TABLE public.task_work_orders FROM ${quote(rogueRole)};
           REVOKE CREATE ON SCHEMA public FROM ${quote(rogueRole)}`
      ).catch(() => undefined);
      for (const identity of WORK_ORDER_TELEMETRY_FUNCTIONS) {
        await databaseClient!.query(
          `ALTER FUNCTION ${identity} OWNER TO ${quote(roles.telemetryOwnerRole)};
           REVOKE ALL PRIVILEGES ON FUNCTION ${identity} FROM PUBLIC;
           REVOKE ALL PRIVILEGES ON FUNCTION ${identity} FROM ${quote(rogueRole)}`
        ).catch(() => undefined);
      }
      await adminClient!.query(
        `REVOKE ${quote(roles.commandOwnerRole)} FROM ${quote(rogueRole)}`
      ).catch(() => undefined);
      await adminClient!.query(`DROP ROLE IF EXISTS ${quote(rogueRole)}`);
    }
  });

  it('runs exact-role interest, hold, full fake v1-v11 materialization, replay, and conflict', async () => {
    // This legacy setting is caller-writable and must have no effect on the
    // sealed target-derived telemetry posture.
    await databaseClient!.query(`SET hustlexp.is_test = 'off'`);
    const lane = await acceptedWorkOrderLane('happy');
    const facts = new PostgresUniversalV1WorkOrderPublicFactReader(superDatabase().query);
    const repository = new PostgresUniversalV1WorkOrderRepository(exactApiDatabase());
    const initialInterestContext = await facts.interest(lane.providerUserId, lane.taskId);
    if (!initialInterestContext) throw new Error('Initial exact-role interest context is missing');
    const application = new UniversalV1WorkOrderApplication(
      facts,
      repository,
      () => fakeFinance()
    );
    const interestTimestamp = new Date().toISOString();
    const interestKey = `exact-role:interest:${randomUUID()}`;
    const interestInput = {
      task_id: lane.taskId,
      expected_scope_version: lane.scopeVersion,
      idempotency_key: interestKey,
      client_ts: interestTimestamp,
    };
    const interest = await application.expressProviderInterest(
      lane.providerUserId,
      interestInput,
      await actorAttestation(lane.providerUserId)
    );
    expect(interest).toMatchObject({ replayed: false, eligibility_version: 2 });
    expect(
      await application.expressProviderInterest(
        lane.providerUserId,
        interestInput,
        await actorAttestation(lane.providerUserId)
      )
    ).toMatchObject({
      interest_application_id: interest.interest_application_id,
      eligibility_decision_id: interest.eligibility_decision_id,
      replayed: true,
    });
    await expect(
      application.expressProviderInterest(
        lane.providerUserId,
        { ...interestInput, client_ts: new Date(Date.parse(interestTimestamp) + 1).toISOString() },
        await actorAttestation(lane.providerUserId)
      )
    ).rejects.toMatchObject({ code: 'WORK_ORDER_IDEMPOTENCY_CONFLICT' });
    const changedScopeVersion = initialInterestContext.scope_version + 1;
    const changedScopeAssertion = await (await actorAttestation(lane.providerUserId)).issue({
      commandKind: 'EXPRESS_POST_ESTIMATE_INTEREST',
      commandPayload: {
        task_id: interestInput.task_id,
        expected_scope_version: changedScopeVersion,
        idempotency_key: interestInput.idempotency_key,
        client_timestamp_epoch_ms: Date.parse(interestInput.client_ts),
      },
    });
    await expect(
      repository.express(
        { ...initialInterestContext, scope_version: changedScopeVersion },
        changedScopeAssertion.actor_assertion_token,
        interestInput.idempotency_key,
        interestInput.client_ts
      )
    ).rejects.toMatchObject({ code: 'WORK_ORDER_IDEMPOTENCY_CONFLICT' });

    const holdTimestamp = new Date().toISOString();
    const holdInput = {
      interest_application_id: interest.interest_application_id,
      expected_eligibility_version: interest.eligibility_version,
      idempotency_key: `exact-role:hold:${randomUUID()}`,
      client_ts: holdTimestamp,
    };
    const initialHoldContext = await facts.hold(
      lane.posterUserId,
      interest.interest_application_id
    );
    if (!initialHoldContext) throw new Error('Initial exact-role hold context is missing');
    const hold = await application.placeConditionalHold(
      lane.posterUserId,
      holdInput,
      await actorAttestation(lane.posterUserId)
    );
    expect(hold.replayed).toBe(false);
    expect(
      await application.placeConditionalHold(
        lane.posterUserId,
        holdInput,
        await actorAttestation(lane.posterUserId)
      )
    ).toMatchObject({ conditional_hold_id: hold.conditional_hold_id, replayed: true });
    await expect(
      application.placeConditionalHold(
        lane.posterUserId,
        { ...holdInput, client_ts: new Date(Date.parse(holdTimestamp) + 1).toISOString() },
        await actorAttestation(lane.posterUserId)
      )
    ).rejects.toMatchObject({ code: 'WORK_ORDER_IDEMPOTENCY_CONFLICT' });
    const changedHoldVersion = initialHoldContext.eligibility_version + 1;
    const changedHoldAssertion = await (await actorAttestation(lane.posterUserId)).issue({
      commandKind: 'PLACE_CONDITIONAL_HOLD',
      commandPayload: {
        interest_application_id: holdInput.interest_application_id,
        expected_eligibility_version: changedHoldVersion,
        idempotency_key: holdInput.idempotency_key,
        client_timestamp_epoch_ms: Date.parse(holdInput.client_ts),
      },
    });
    await expect(
      repository.hold(
        { ...initialHoldContext, eligibility_version: changedHoldVersion },
        changedHoldAssertion.actor_assertion_token,
        holdInput.idempotency_key,
        holdInput.client_ts
      )
    ).rejects.toMatchObject({ code: 'WORK_ORDER_IDEMPOTENCY_CONFLICT' });

    const workOrderInput = {
      conditional_hold_id: hold.conditional_hold_id,
      expected_eligibility_version: interest.eligibility_version,
      idempotency_key: `exact-role:work-order:${randomUUID()}`,
      client_ts: new Date().toISOString(),
    };
    const materialized = await application.secureAndMaterializeFakeWorkOrder(
      lane.posterUserId,
      workOrderInput,
      await actorAttestation(lane.posterUserId)
    );
    expect(materialized).toMatchObject({
      replayed: false,
      hard_assignment_created: false,
      payment_creation_performed: false,
    });
    expect(
      await application.secureAndMaterializeFakeWorkOrder(
        lane.posterUserId,
        workOrderInput,
        await actorAttestation(lane.posterUserId)
      )
    ).toMatchObject({
      work_order_id: materialized.work_order_id,
      financial_security_event_id: materialized.financial_security_event_id,
      replayed: true,
      hard_assignment_created: false,
      payment_creation_performed: false,
    });
    await expect(
      application.secureAndMaterializeFakeWorkOrder(
        lane.posterUserId,
        {
          ...workOrderInput,
          client_ts: new Date(Date.parse(workOrderInput.client_ts) + 1).toISOString(),
        },
        await actorAttestation(lane.posterUserId)
      )
    ).rejects.toMatchObject({ code: 'WORK_ORDER_IDEMPOTENCY_CONFLICT' });

    const completedContext = await new PostgresUniversalV1WorkOrderPublicFactReader(
      superDatabase().query
    ).workOrder(lane.posterUserId, hold.conditional_hold_id);
    if (!completedContext) throw new Error('Completed Work Order replay context is unavailable');
    const changedVersion = completedContext.eligibility_version + 1;
    const changedVersionAssertion = await (await actorAttestation(lane.posterUserId)).issue({
      commandKind: 'PREPARE_FAKE_WORK_ORDER',
      commandPayload: {
        conditional_hold_id: workOrderInput.conditional_hold_id,
        expected_eligibility_version: changedVersion,
        idempotency_key: workOrderInput.idempotency_key,
        client_timestamp_epoch_ms: Date.parse(workOrderInput.client_ts),
      },
    });
    await expect(
      new PostgresUniversalV1WorkOrderRepository(exactApiDatabase()).prepareMaterialization(
        { ...completedContext, eligibility_version: changedVersion },
        workOrderInput.idempotency_key,
        changedVersionAssertion.actor_assertion_token,
        workOrderInput.client_ts
      )
    ).rejects.toMatchObject({ code: 'WORK_ORDER_IDEMPOTENCY_CONFLICT' });

    const operationIds = [
      deterministicUuid(workOrderInput.idempotency_key, 'prepare'),
      deterministicUuid(workOrderInput.idempotency_key, 'authorize'),
      deterministicUuid(workOrderInput.idempotency_key, 'secure'),
    ];
    const evidence = await databaseClient!.query<{
      task_worker_id: string | null;
      task_work_order_id: string;
      canonical_digest_bound: boolean;
      prepared_commands: number;
      journal_commands: number;
      observed_outcomes: number;
      lifecycle_bridges: number;
      lifecycle_events: number;
      execution_facts: number;
      unsafe_execution_facts: number;
      approved_provider_commands: number;
      escrows: number;
      quote_payments: number;
      scope_major_action_events: number;
      scope_major_action_production_events: number;
      scope_major_action_test_events: number;
    }>(
      `SELECT task.worker_id AS task_worker_id,
              task.work_order_id AS task_work_order_id,
              request.canonical_command_request_sha256 IS NOT NULL
                AND request.canonical_command_request_sha256 IS DISTINCT FROM request.request_sha256
                AS canonical_digest_bound,
              (SELECT pg_catalog.count(*)::INTEGER
                 FROM public.universal_v1_prepared_financial_commands prepared
                WHERE prepared.operation_id = ANY($2::UUID[])) AS prepared_commands,
              (SELECT pg_catalog.count(*)::INTEGER
                 FROM public.financial_provider_command_journal command
                WHERE command.operation_id = ANY($2::UUID[])) AS journal_commands,
              (SELECT pg_catalog.count(*)::INTEGER
                 FROM public.financial_provider_command_outcome_facts outcome
                 JOIN public.financial_provider_command_journal command
                   ON command.command_id = outcome.command_id
                WHERE command.operation_id = ANY($2::UUID[])
                  AND outcome.provider_state = 'SUCCEEDED'
                  AND outcome.retryable IS FALSE) AS observed_outcomes,
              (SELECT pg_catalog.count(*)::INTEGER
                 FROM public.universal_v1_fake_financial_lifecycle_bridges bridge
                WHERE bridge.fake_operation_id = ANY($2::UUID[])
                  AND bridge.fake_provider_state = 'SUCCEEDED') AS lifecycle_bridges,
              (SELECT pg_catalog.count(*)::INTEGER
                 FROM public.task_financial_security_events event
                WHERE event.operation_id = ANY($3::TEXT[])
                  AND event.provider_kind = 'FAKE'
                  AND event.status = 'SUCCEEDED') AS lifecycle_events,
              (SELECT pg_catalog.count(*)::INTEGER
                 FROM public.task_work_order_execution_facts execution
                WHERE execution.work_order_id = $4) AS execution_facts,
              (SELECT pg_catalog.count(*)::INTEGER
                 FROM hx_authority.universal_v1_work_order_command_execution_facts execution
                WHERE execution.domain_object_id IN ($1, $4)
                  AND (execution.hard_assignment_created OR execution.payment_creation_performed))
                AS unsafe_execution_facts,
              (SELECT pg_catalog.count(*)::INTEGER
                 FROM public.financial_provider_command_journal command
                WHERE command.operation_id = ANY($2::UUID[])
                  AND command.provider_kind = 'APPROVED_PROVIDER') AS approved_provider_commands,
              (SELECT pg_catalog.count(*)::INTEGER FROM public.escrows escrow
                WHERE escrow.task_id = $1) AS escrows,
              (SELECT pg_catalog.count(*)::INTEGER FROM public.quote_payments payment
                 JOIN public.quotes quote ON quote.id = payment.quote_id
                 WHERE quote.task_draft_id = $5) AS quote_payments,
              (SELECT pg_catalog.count(*)::INTEGER
                 FROM public.major_action_events event
                WHERE event.source_table = 'task_scope_versions'
                  AND event.aggregate_type = 'task'
                  AND event.aggregate_id = $1::TEXT
                  AND event.event_name IN (
                    'intent_scope.recorded',
                    'pricing_quote.scope_priced'
                  )) AS scope_major_action_events
              ,(SELECT pg_catalog.count(*)::INTEGER
                  FROM public.major_action_events event
                 WHERE event.source_table = 'task_scope_versions'
                   AND event.aggregate_type = 'task'
                   AND event.aggregate_id = $1::TEXT
                   AND event.environment = 'PRODUCTION')
                  AS scope_major_action_production_events
              ,(SELECT pg_catalog.count(*)::INTEGER
                  FROM public.major_action_events event
                 WHERE event.source_table = 'task_scope_versions'
                   AND event.aggregate_type = 'task'
                   AND event.aggregate_id = $1::TEXT
                   AND event.environment = 'TEST'
                   AND event.is_test IS TRUE)
                  AS scope_major_action_test_events
         FROM public.tasks task
         JOIN public.task_work_order_command_requests request
           ON request.task_id = task.id AND request.idempotency_key = $6
        WHERE task.id = $1`,
      [
        lane.taskId,
        operationIds,
        operationIds.map(String),
        materialized.work_order_id,
        lane.draftId,
        workOrderInput.idempotency_key,
      ]
    );
    expect(evidence.rows[0]).toEqual({
      task_worker_id: null,
      task_work_order_id: materialized.work_order_id,
      canonical_digest_bound: true,
      prepared_commands: 3,
      journal_commands: 3,
      observed_outcomes: 3,
      lifecycle_bridges: 3,
      lifecycle_events: 3,
      execution_facts: 1,
      unsafe_execution_facts: 0,
      approved_provider_commands: 0,
      escrows: 0,
      quote_payments: 0,
      scope_major_action_events: 2,
      scope_major_action_production_events: 0,
      scope_major_action_test_events: 2,
    });
    await databaseClient!.query(`RESET hustlexp.is_test`);
  });

  it('rejects a real non-SUCCEEDED SECURE provider chain with zero Work Order effects', async () => {
    const prepared = await preparedExactRoleLane('declined-secure');
    const chain = await executeExactFakeSecurityChain(prepared, 'DECLINE');
    expect(chain.secured).toMatchObject({
      eventKind: 'SECURED',
      status: 'DECLINED',
      providerState: 'DECLINED',
      providerKind: 'FAKE',
    });

    const materializeAssertion = await prepared.attestation.issue({
      commandKind: 'MATERIALIZE_FAKE_WORK_ORDER',
      commandPayload: {
        idempotency_key: prepared.phase.idempotencyKey,
        request_sha256: prepared.phase.requestSha256,
        secured_event_id: chain.secured.id,
      },
    });
    await expect(
      prepared.repository.finalizeMaterialization(
        prepared.phase,
        chain.secured.id,
        materializeAssertion.actor_assertion_token
      )
    ).rejects.toMatchObject({ code: 'WORK_ORDER_AUTHORITY_REVOKED' });

    const recoveryAssertion = await prepared.attestation.issue({
      commandKind: 'REQUEST_FAKE_WORK_ORDER_RECOVERY',
      commandPayload: {
        idempotency_key: prepared.phase.idempotencyKey,
        request_sha256: prepared.phase.requestSha256,
        secured_event_id: chain.secured.id,
      },
    });
    await expect(
      prepared.repository.claimMaterializationCompensation(
        prepared.phase,
        chain.secured.id,
        recoveryAssertion.actor_assertion_token
      )
    ).rejects.toMatchObject({ code: 'WORK_ORDER_AUTHORITY_REVOKED' });

    const evidence = await databaseClient!.query<{
      outcome_provider_state: string;
      bridge_provider_state: string;
      lifecycle_status: string;
      event_provider_state: string;
      work_orders: number;
      compensation_commands: number;
      unsafe_effects: number;
    }>(
      `SELECT outcome.provider_state AS outcome_provider_state,
              bridge.fake_provider_state AS bridge_provider_state,
              event.status AS lifecycle_status,
              event.evidence->>'providerState' AS event_provider_state,
              (SELECT pg_catalog.count(*)::INTEGER
                 FROM public.task_work_orders work_order
                WHERE work_order.task_id = $2) AS work_orders,
              (SELECT pg_catalog.count(*)::INTEGER
                 FROM public.universal_v1_work_order_compensation_commands compensation
                WHERE compensation.work_order_idempotency_key = $3) AS compensation_commands,
              (SELECT pg_catalog.count(*)::INTEGER
                 FROM hx_authority.universal_v1_work_order_command_execution_facts execution
                WHERE execution.domain_object_id = $2
                  AND (execution.hard_assignment_created OR execution.payment_creation_performed))
                AS unsafe_effects
         FROM public.universal_v1_fake_financial_lifecycle_bridges bridge
         JOIN public.financial_provider_command_outcome_facts outcome
           ON outcome.outcome_fact_id = bridge.outcome_fact_id
         JOIN public.task_financial_security_events event
           ON event.id = bridge.task_financial_security_event_id
        WHERE bridge.fake_operation_id = $1`,
      [chain.secured.operationId, prepared.lane.taskId, prepared.input.idempotency_key]
    );
    expect(evidence.rows).toEqual([
      {
        outcome_provider_state: 'DECLINED',
        bridge_provider_state: 'DECLINED',
        lifecycle_status: 'DECLINED',
        event_provider_state: 'DECLINED',
        work_orders: 0,
        compensation_commands: 0,
        unsafe_effects: 0,
      },
    ]);
  });

  it('claims and replays one exact fake VOID after post-SECURE eligibility revocation', async () => {
    const prepared = await preparedExactRoleLane('post-secure-recovery');
    const chain = await executeExactFakeSecurityChain(prepared);
    expect(chain.secured).toMatchObject({
      eventKind: 'SECURED',
      status: 'SUCCEEDED',
      providerState: 'SUCCEEDED',
      providerKind: 'FAKE',
    });
    const successor = await databaseClient!.query<{ id: string }>(
      `INSERT INTO public.task_provider_eligibility_decisions(
         task_draft_id,task_id,scope_version_id,interest_application_id,
         routing_decision_id,decision_version,supersedes_decision_id,
         provider_user_id,provider_organization_id,provider_class,
         trade_credential_id,profile_eligible,identity_eligible,
         category_eligible,credential_eligible,geography_eligible,
         availability_eligible,restriction_clear,task_eligible,
         processor_payment_eligible,payout_funding_eligible,trust_tier,
         blocker_codes,policy_version,evidence,decided_by,idempotency_key,
         evaluated_at,valid_until
       )
       SELECT eligibility.task_draft_id,eligibility.task_id,
              eligibility.scope_version_id,eligibility.interest_application_id,
              eligibility.routing_decision_id,eligibility.decision_version + 1,
              eligibility.id,eligibility.provider_user_id,
              eligibility.provider_organization_id,eligibility.provider_class,
              eligibility.trade_credential_id,eligibility.profile_eligible,
              eligibility.identity_eligible,eligibility.category_eligible,
              eligibility.credential_eligible,eligibility.geography_eligible,
              eligibility.availability_eligible,eligibility.restriction_clear,
              eligibility.task_eligible,eligibility.processor_payment_eligible,
              eligibility.payout_funding_eligible,eligibility.trust_tier,
              eligibility.blocker_codes,eligibility.policy_version,
              eligibility.evidence || pg_catalog.jsonb_build_object(
                'exact_role_successor_after_secure', TRUE
              ),eligibility.decided_by,
              eligibility.idempotency_key || ':after-secure',
              pg_catalog.clock_timestamp(),eligibility.valid_until
         FROM public.task_provider_eligibility_decisions eligibility
        WHERE eligibility.id = $1
       RETURNING id`,
      [prepared.phase.context.eligibility_decision_id]
    );
    expect(successor.rows).toHaveLength(1);

    const materializeAssertion = await prepared.attestation.issue({
      commandKind: 'MATERIALIZE_FAKE_WORK_ORDER',
      commandPayload: {
        idempotency_key: prepared.phase.idempotencyKey,
        request_sha256: prepared.phase.requestSha256,
        secured_event_id: chain.secured.id,
      },
    });
    await expect(
      prepared.repository.finalizeMaterialization(
        prepared.phase,
        chain.secured.id,
        materializeAssertion.actor_assertion_token
      )
    ).rejects.toMatchObject({ code: 'WORK_ORDER_AUTHORITY_REVOKED' });

    const recoveryCommand = async () => {
      const assertion = await prepared.attestation.issue({
        commandKind: 'REQUEST_FAKE_WORK_ORDER_RECOVERY',
        commandPayload: {
          idempotency_key: prepared.phase.idempotencyKey,
          request_sha256: prepared.phase.requestSha256,
          secured_event_id: chain.secured.id,
        },
      });
      return prepared.repository.claimMaterializationCompensation(
        prepared.phase,
        chain.secured.id,
        assertion.actor_assertion_token
      );
    };
    const recovery = await recoveryCommand();
    if (recovery.completed) throw new Error('Recovery unexpectedly found a Work Order');
    const recoveryReplay = await recoveryCommand();
    if (recoveryReplay.completed) throw new Error('Recovery replay unexpectedly found a Work Order');
    expect(recoveryReplay.command.compensation_command_id).toBe(
      recovery.command.compensation_command_id
    );

    const voided = await executeUniversalV1WorkOrderCompensation(
      chain.finance,
      recovery.command
    );
    expect(voided).toMatchObject({
      operationId: recovery.command.void_operation_id,
      eventKind: 'VOIDED',
      status: 'SUCCEEDED',
      providerKind: 'FAKE',
      predecessorEventId: chain.secured.id,
      idempotencyReplayed: false,
    });
    expect(
      await executeUniversalV1WorkOrderCompensation(chain.finance, recovery.command)
    ).toMatchObject({
      operationId: recovery.command.void_operation_id,
      eventKind: 'VOIDED',
      status: 'SUCCEEDED',
      providerKind: 'FAKE',
      predecessorEventId: chain.secured.id,
      idempotencyReplayed: true,
    });

    const evidence = await databaseClient!.query<{
      successor_decisions: number;
      compensation_commands: number;
      successful_voids: number;
      work_orders: number;
      task_worker_id: string | null;
      task_work_order_id: string | null;
      unsafe_effects: number;
    }>(
      `SELECT
       (SELECT pg_catalog.count(*)::INTEGER
          FROM public.task_provider_eligibility_decisions eligibility
         WHERE eligibility.id = $1
           AND eligibility.supersedes_decision_id = $2) AS successor_decisions,
       (SELECT pg_catalog.count(*)::INTEGER
          FROM public.universal_v1_work_order_compensation_commands compensation
         WHERE compensation.work_order_idempotency_key = $3
           AND compensation.secured_event_id = $4
           AND compensation.void_operation_id = $5) AS compensation_commands,
       (SELECT pg_catalog.count(*)::INTEGER
          FROM public.task_financial_security_events event
         WHERE event.operation_id = $5::TEXT
           AND event.event_kind = 'VOIDED'
           AND event.status = 'SUCCEEDED'
           AND event.provider_kind = 'FAKE') AS successful_voids,
       (SELECT pg_catalog.count(*)::INTEGER
          FROM public.task_work_orders work_order
         WHERE work_order.task_id = $6) AS work_orders,
       task.worker_id AS task_worker_id,
       task.work_order_id AS task_work_order_id,
       (SELECT pg_catalog.count(*)::INTEGER
          FROM hx_authority.universal_v1_work_order_command_execution_facts execution
         WHERE execution.domain_object_id = $6
           AND (execution.hard_assignment_created OR execution.payment_creation_performed))
         AS unsafe_effects
       FROM public.tasks task WHERE task.id = $6`,
      [
        successor.rows[0]!.id,
        prepared.phase.context.eligibility_decision_id,
        prepared.input.idempotency_key,
        chain.secured.id,
        recovery.command.void_operation_id,
        prepared.lane.taskId,
      ]
    );
    expect(evidence.rows).toEqual([
      {
        successor_decisions: 1,
        compensation_commands: 1,
        successful_voids: 1,
        work_orders: 0,
        task_worker_id: null,
        task_work_order_id: null,
        unsafe_effects: 0,
      },
    ]);
  });

  it('serializes a concurrent provider-capability revoke and leaves zero command writes', async () => {
    const lane = await acceptedWorkOrderLane('concurrent-revoke');
    const input = {
      task_id: lane.taskId,
      expected_scope_version: lane.scopeVersion,
      idempotency_key: `exact-role:concurrent-revoke:${randomUUID()}`,
      client_ts: new Date().toISOString(),
    };
    const assertion = await (await actorAttestation(lane.providerUserId)).issue({
      commandKind: 'EXPRESS_POST_ESTIMATE_INTEREST',
      commandPayload: {
        task_id: input.task_id,
        expected_scope_version: input.expected_scope_version,
        idempotency_key: input.idempotency_key,
        client_timestamp_epoch_ms: Date.parse(input.client_ts),
      },
    });
    let committed = false;
    let apiTransactionOpen = false;
    let pending:
      | Promise<
          | { readonly ok: true; readonly value: pg.QueryResult }
          | { readonly ok: false; readonly error: unknown }
        >
      | null = null;
    await databaseClient!.query('BEGIN');
    try {
      await databaseClient!.query(
        `UPDATE public.capability_profiles
            SET provider_class = 'VERIFIED_TRADE_BUSINESS'
          WHERE user_id = $1`,
        [lane.providerUserId]
      );
      await apiClient!.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      apiTransactionOpen = true;
      pending = apiClient!
        .query(
          `SELECT * FROM public.hxos_express_universal_v1_post_estimate_interest_v1(
             $1, $2, $3, $4, $5
           )`,
          [
            assertion.actor_assertion_token,
            input.task_id,
            input.expected_scope_version,
            input.idempotency_key,
            input.client_ts,
          ]
        )
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error })
        );
      let observedLock = false;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !observedLock) {
        const activity = await databaseClient!.query<{ waiting: boolean }>(
          `SELECT EXISTS(
             SELECT 1 FROM pg_catalog.pg_stat_activity
              WHERE usename = $1
                AND datname = pg_catalog.current_database()
                AND state = 'active'
                AND wait_event_type = 'Lock'
                AND query LIKE '%hxos_express_universal_v1_post_estimate_interest_v1%'
           ) AS waiting`,
          [roles.apiRole]
        );
        observedLock = activity.rows[0]?.waiting === true;
        if (!observedLock) {
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
        }
      }
      expect(observedLock).toBe(true);
      await databaseClient!.query('COMMIT');
      committed = true;
      const result = await pending;
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Concurrent revoke command unexpectedly succeeded');
      const refusalError = result.error as { readonly code?: string; readonly message?: string };
      expect(refusalError.message).toMatch(
        /HXUV1-WOCMD-13|could not serialize access due to concurrent update/u
      );
      if (!refusalError.message?.includes('HXUV1-WOCMD-13')) {
        expect(refusalError.code).toBe('40001');
      }
      const writes = await databaseClient!.query<{
        applications: number;
        successor_eligibility: number;
        command_audits: number;
      }>(
        `SELECT
         (SELECT pg_catalog.count(*)::INTEGER FROM public.task_applications application
           WHERE application.idempotency_key = $1) AS applications,
         (SELECT pg_catalog.count(*)::INTEGER
            FROM public.task_provider_eligibility_decisions eligibility
           WHERE eligibility.idempotency_key = $1) AS successor_eligibility,
         (SELECT pg_catalog.count(*)::INTEGER
            FROM hx_authority.universal_v1_work_order_command_execution_facts execution
           WHERE execution.idempotency_key = $1) AS command_audits`,
        [input.idempotency_key]
      );
      expect(writes.rows).toEqual([
        { applications: 0, successor_eligibility: 0, command_audits: 0 },
      ]);
    } finally {
      if (!committed) await databaseClient!.query('ROLLBACK').catch(() => undefined);
      if (pending) await pending.catch(() => undefined);
      if (apiTransactionOpen) {
        await apiClient!.query('ROLLBACK').catch(() => undefined);
        apiTransactionOpen = false;
      }
      await databaseClient!.query(
        `UPDATE public.capability_profiles
            SET provider_class = 'GENERAL_SERVICE_PROVIDER'
          WHERE user_id = $1`,
        [lane.providerUserId]
      );
    }
  });

  it('activates a post-provision target through the sealed migrator port and rejects an old-tip assertion', async () => {
    const lane = await acceptedWorkOrderLane('target-advance');
    const facts = new PostgresUniversalV1WorkOrderPublicFactReader(superDatabase().query);
    const context = await facts.interest(lane.providerUserId, lane.taskId);
    if (!context) throw new Error('Target-advance interest context is missing');
    const idempotencyKey = `exact-role:target-advance:${randomUUID()}`;
    const clientTimestamp = new Date().toISOString();
    const realAttestation = await realActorAttestation(lane.providerUserId);
    const oldAssertion = await realAttestation.issue({
      commandKind: 'EXPRESS_POST_ESTIMATE_INTEREST',
      commandPayload: {
        task_id: lane.taskId,
        expected_scope_version: lane.scopeVersion,
        idempotency_key: idempotencyKey,
        client_timestamp_epoch_ms: Date.parse(clientTimestamp),
      },
    });
    const beforeRefusal = await databaseClient!.query(
      `SELECT
         (SELECT pg_catalog.count(*)::INTEGER
            FROM hx_authority.universal_v1_actor_assertion_consumption_facts)
              AS assertion_consumptions,
         (SELECT pg_catalog.count(*)::INTEGER
            FROM hx_authority.universal_v1_work_order_command_execution_facts
           WHERE idempotency_key = $1) AS authority_executions,
         (SELECT pg_catalog.count(*)::INTEGER FROM public.task_applications
           WHERE idempotency_key = $1) AS applications,
         (SELECT pg_catalog.count(*)::INTEGER
            FROM public.task_provider_eligibility_decisions
           WHERE idempotency_key = $1) AS eligibility`,
      [idempotencyKey]
    );
    const currentTarget = await databaseClient!.query<{
      authority_version: number;
      target_authority_id: string;
    }>(
      `SELECT target_authority_id, authority_version
         FROM hx_authority.read_universal_v1_work_order_target_authority_v1()`
    );
    expect(currentTarget.rows).toHaveLength(1);
    const targetRowsBeforeAdmissionRefusals = await databaseClient!.query(
      `SELECT target_authority_id, authority_version, supersedes_target_authority_id,
              target_database_name, environment, release_manifest_sha256,
              activation_request_sha256, activated_at
         FROM hx_authority.universal_v1_work_order_target_authority_facts
        ORDER BY authority_version`
    );
    const activationParameters = [
      releaseManifestSha256,
      currentTarget.rows[0]!.target_authority_id,
      currentTarget.rows[0]!.authority_version,
    ] as const;
    await refusal(
      () =>
        migrationClient!.query(
          `SELECT * FROM public.hxos_activate_universal_v1_work_order_target_v1(
             'local', $1, $2, $3
           )`,
          [...activationParameters]
        ),
      /HXUV1-WOCMD-60/u
    );
    await transactionalRefusal(
      migrationClient!,
      'BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY',
      () =>
        migrationClient!.query(
          `SELECT * FROM public.hxos_activate_universal_v1_work_order_target_v1(
             'local', $1, $2, $3
           )`,
          [...activationParameters]
        ),
      /HXUV1-WOCMD-60/u
    );
    expect(
      (
        await databaseClient!.query(
          `SELECT target_authority_id, authority_version, supersedes_target_authority_id,
                  target_database_name, environment, release_manifest_sha256,
                  activation_request_sha256, activated_at
             FROM hx_authority.universal_v1_work_order_target_authority_facts
            ORDER BY authority_version`
        )
      ).rows
    ).toEqual(targetRowsBeforeAdmissionRefusals.rows);

    await refusal(
      () =>
        migrationClient!.query(
          `INSERT INTO hx_authority.universal_v1_work_order_target_authority_facts(
             authority_version, supersedes_target_authority_id, target_database_name,
             environment, release_manifest_sha256, activation_request_sha256
           ) VALUES ($1, $2, pg_catalog.current_database(), 'local', $3, $4)`,
          [
            currentTarget.rows[0]!.authority_version + 1,
            currentTarget.rows[0]!.target_authority_id,
            releaseManifestSha256,
            'b'.repeat(64),
          ]
        ),
      /permission denied/iu
    );

    const activated = await serializableResult<{
      authority_version: number;
      replayed: boolean;
      target_authority_id: string;
    }>(
      migrationClient!,
      () =>
        migrationClient!.query(
          `SELECT target_authority_id, authority_version, replayed
             FROM public.hxos_activate_universal_v1_work_order_target_v1(
               'local', $1, $2, $3
             )`,
          [...activationParameters]
        )
    );
    expect(activated.rows).toEqual([
      {
        target_authority_id: expect.any(String),
        authority_version: currentTarget.rows[0]!.authority_version + 1,
        replayed: false,
      },
    ]);
    const replay = await serializableResult(
      migrationClient!,
      () =>
        migrationClient!.query(
          `SELECT target_authority_id, authority_version, replayed
             FROM public.hxos_activate_universal_v1_work_order_target_v1(
               'local', $1, $2, $3
             )`,
          [...activationParameters]
        )
    );
    expect(replay.rows).toEqual([
      {
        target_authority_id: activated.rows[0]!.target_authority_id,
        authority_version: activated.rows[0]!.authority_version,
        replayed: true,
      },
    ]);
    const targetCountBeforeHistoricalReplay = await databaseClient!.query(
      `SELECT pg_catalog.count(*)::INTEGER AS count
         FROM hx_authority.universal_v1_work_order_target_authority_facts`
    );
    await transactionalRefusal(
      migrationClient!,
      'BEGIN ISOLATION LEVEL SERIALIZABLE',
      () =>
        migrationClient!.query(
          `SELECT * FROM public.hxos_activate_universal_v1_work_order_target_v1(
             'local', $1, NULL, 0
           )`,
          [releaseManifestSha256]
        ),
      /HXUV1-WOCMD-64/u
    );
    expect(
      (
        await databaseClient!.query(
          `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM hx_authority.universal_v1_work_order_target_authority_facts`
        )
      ).rows
    ).toEqual(targetCountBeforeHistoricalReplay.rows);

    await transactionalRefusal(
      apiClient!,
      'BEGIN ISOLATION LEVEL SERIALIZABLE',
      () =>
        apiClient!.query(
          `SELECT * FROM public.hxos_express_universal_v1_post_estimate_interest_v1(
             $1, $2, $3, $4, $5
           )`,
          [
            oldAssertion.actor_assertion_token,
            lane.taskId,
            lane.scopeVersion,
            idempotencyKey,
            clientTimestamp,
          ]
        ),
      /HXUV1-ACTOR-28/u
    );
    expect(
      (
        await databaseClient!.query(
          `SELECT
             (SELECT pg_catalog.count(*)::INTEGER
                FROM hx_authority.universal_v1_actor_assertion_consumption_facts)
                  AS assertion_consumptions,
             (SELECT pg_catalog.count(*)::INTEGER
                FROM hx_authority.universal_v1_work_order_command_execution_facts
               WHERE idempotency_key = $1) AS authority_executions,
             (SELECT pg_catalog.count(*)::INTEGER FROM public.task_applications
               WHERE idempotency_key = $1) AS applications,
             (SELECT pg_catalog.count(*)::INTEGER
                FROM public.task_provider_eligibility_decisions
               WHERE idempotency_key = $1) AS eligibility`,
          [idempotencyKey]
        )
      ).rows
    ).toEqual(beforeRefusal.rows);

    const newAssertion = await realAttestation.issue({
      commandKind: 'EXPRESS_POST_ESTIMATE_INTEREST',
      commandPayload: {
        task_id: lane.taskId,
        expected_scope_version: lane.scopeVersion,
        idempotency_key: idempotencyKey,
        client_timestamp_epoch_ms: Date.parse(clientTimestamp),
      },
    });
    await expect(
      new PostgresUniversalV1WorkOrderRepository(exactApiDatabase()).express(
        context,
        newAssertion.actor_assertion_token,
        idempotencyKey,
        clientTimestamp
      )
    ).resolves.toMatchObject({ replayed: false });
  });

  it('serializes the first runtime snapshot with target activation in both lock schedules', async () => {
    const barrier = 'public.hxos_universal_v1_work_order_target_activation_barrier_v1';
    const migrationPid = Number(
      (await migrationClient!.query<{ pid: number }>('SELECT pg_catalog.pg_backend_pid() AS pid'))
        .rows[0]!.pid
    );
    const apiPid = Number(
      (await apiClient!.query<{ pid: number }>('SELECT pg_catalog.pg_backend_pid() AS pid')).rows[0]!
        .pid
    );
    const observeWaitingRelationLock = async (pid: number, mode: string): Promise<void> => {
      let observed = false;
      const deadline = Date.now() + 5_000;
      while (!observed && Date.now() < deadline) {
        const lock = await databaseClient!.query<{ waiting: boolean }>(
          `SELECT EXISTS(
             SELECT 1
               FROM pg_catalog.pg_locks held
              WHERE held.pid = $1
                AND held.locktype = 'relation'
                AND held.relation = $2::pg_catalog.regclass
                AND held.mode = $3
                AND held.granted IS FALSE
           ) AS waiting`,
          [pid, barrier, mode]
        );
        observed = lock.rows[0]?.waiting === true;
        if (!observed) await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
      expect(observed).toBe(true);
    };
    const currentTarget = async () =>
      (
        await databaseClient!.query<{
          authority_version: number;
          target_authority_id: string;
        }>(
          `SELECT target_authority_id, authority_version
             FROM hx_authority.read_universal_v1_work_order_target_authority_v1()`
        )
      ).rows[0]!;
    const activate = (target: { authority_version: number; target_authority_id: string }) =>
      migrationClient!.query<{
        authority_version: number;
        target_authority_id: string;
      }>(
        `SELECT target_authority_id, authority_version
           FROM public.hxos_activate_universal_v1_work_order_target_v1(
             'local', $1, $2, $3
           )`,
        [releaseManifestSha256, target.target_authority_id, target.authority_version]
      );

    let apiOpen = false;
    let migrationOpen = false;
    let pendingActivation: Promise<pg.QueryResult<{
      authority_version: number;
      target_authority_id: string;
    }>> | null = null;
    let pendingBarrier: Promise<pg.QueryResult> | null = null;
    try {
      // Runtime-first: the verifier/read path owns ACCESS SHARE; activation
      // waits and cannot alter the tip inside that already-authoritative read.
      const initial = await currentTarget();
      await apiClient!.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      apiOpen = true;
      await apiClient!.query(`SET LOCAL search_path = pg_catalog`);
      await apiClient!.query(`LOCK TABLE ${barrier} IN ACCESS SHARE MODE`);
      await migrationClient!.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      migrationOpen = true;
      pendingActivation = activate(initial);
      await observeWaitingRelationLock(migrationPid, 'AccessExclusiveLock');
      const runtimeBeforeActivation = await apiClient!.query<{
        authority_version: number;
        target_authority_id: string;
      }>(`SELECT * FROM ${WORK_ORDER_RUNTIME_AUTHORITY_FUNCTION}`);
      expect(runtimeBeforeActivation.rows).toEqual([
        expect.objectContaining({
          target_authority_id: initial.target_authority_id,
          authority_version: initial.authority_version,
        }),
      ]);
      await apiClient!.query('COMMIT');
      apiOpen = false;
      const firstActivation = await pendingActivation;
      pendingActivation = null;
      await migrationClient!.query('COMMIT');
      migrationOpen = false;
      expect(firstActivation.rows[0]).toMatchObject({
        authority_version: initial.authority_version + 1,
      });

      // Activation-first: the uncommitted target owns ACCESS EXCLUSIVE. The
      // runtime LOCK utility waits without taking its RR snapshot; its first
      // subsequent SELECT must therefore observe the newly committed tip.
      const first = firstActivation.rows[0]!;
      await migrationClient!.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      migrationOpen = true;
      const secondActivation = await activate(first);
      await apiClient!.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      apiOpen = true;
      await apiClient!.query(`SET LOCAL search_path = pg_catalog`);
      pendingBarrier = apiClient!.query(`LOCK TABLE ${barrier} IN ACCESS SHARE MODE`);
      await observeWaitingRelationLock(apiPid, 'AccessShareLock');
      await migrationClient!.query('COMMIT');
      migrationOpen = false;
      await pendingBarrier;
      pendingBarrier = null;
      const runtimeAfterActivation = await apiClient!.query<{
        authority_version: number;
        target_authority_id: string;
      }>(`SELECT * FROM ${WORK_ORDER_RUNTIME_AUTHORITY_FUNCTION}`);
      expect(runtimeAfterActivation.rows).toEqual([
        expect.objectContaining({
          target_authority_id: secondActivation.rows[0]!.target_authority_id,
          authority_version: secondActivation.rows[0]!.authority_version,
        }),
      ]);
      await apiClient!.query('COMMIT');
      apiOpen = false;
    } finally {
      if (pendingActivation) {
        if (apiOpen) {
          await apiClient!.query('ROLLBACK').catch(() => undefined);
          apiOpen = false;
        }
        await pendingActivation.catch(() => undefined);
        pendingActivation = null;
      }
      if (pendingBarrier) {
        if (migrationOpen) {
          await migrationClient!.query('ROLLBACK').catch(() => undefined);
          migrationOpen = false;
        }
        await pendingBarrier.catch(() => undefined);
        pendingBarrier = null;
      }
      if (migrationOpen) await migrationClient!.query('ROLLBACK').catch(() => undefined);
      if (apiOpen) await apiClient!.query('ROLLBACK').catch(() => undefined);
    }
  });
});
