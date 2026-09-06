import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';

const configuredDatabaseUrl = process.env.DATABASE_URL?.trim() ?? '';
const describePg = describe.sequential.skipIf(configuredDatabaseUrl.length === 0);
const proofDatabase = `hx_ci_actor_assertion_${process.pid}_test`;
const assertionOwner = `hx_ci_assertion_owner_${process.pid}`;
const commandOwner = `hx_ci_command_owner_${process.pid}`;
const attesterRole = `hx_ci_attester_${process.pid}`;
const runtimeRole = `hx_ci_actor_runtime_${process.pid}`;
const attesterPassword = `hx-ci-attester-${process.pid}-synthetic`;
const runtimePassword = `hx-ci-actor-runtime-${process.pid}-synthetic`;
const migrationName = '20261012_universal_v1_work_order_command_authority_v2';
const migrationFileName = `${migrationName}.sql`;
const canonicalUserId = 'fa100000-0000-4000-8000-000000000001';
const verifiedSubject = 'firebase:synthetic-actor-authority-1';
const releaseManifestSha256 = `sha256:${'a'.repeat(64)}`;

let adminClient: pg.Client | null = null;
let databaseClient: pg.Client | null = null;
let attesterClient: pg.Client | null = null;
let runtimeClient: pg.Client | null = null;
let commandClientA: pg.Client | null = null;
let commandClientB: pg.Client | null = null;
let migrationSql = '';

function safeIdentifier(value: string): string {
  if (!/^hx_ci_[a-z0-9_]+$/u.test(value) || value.length > 63) {
    throw new Error(`Unsafe disposable PostgreSQL identifier: ${value}`);
  }
  return value;
}

function quotedIdentifier(value: string): string {
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
    throw new Error('Actor-assertion proof requires the exact loopback-only hx_ci_* PG16 runner');
  }
  parsed.pathname = '/hx_ci_admin_test';
  return parsed.toString();
}

function databaseUrl(username?: string, password?: string): string {
  const parsed = new URL(adminDatabaseUrl());
  parsed.pathname = `/${safeIdentifier(proofDatabase)}`;
  if (username !== undefined) parsed.username = safeIdentifier(username);
  if (password !== undefined) parsed.password = password;
  return parsed.toString();
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function token(): string {
  return randomBytes(32).toString('hex');
}

interface CanonicalRequest {
  schema_version: 1;
  release_manifest_sha256: string;
  authentication_requirements: {
    mfa_required: boolean;
    step_up_required: boolean;
    max_auth_age_seconds: number;
    max_step_up_age_seconds: number | null;
  };
  command_payload: Record<string, unknown>;
}

function canonicalRequest(
  overrides: Partial<CanonicalRequest['authentication_requirements']> = {},
  payload: Record<string, unknown> = { taskDraftId: 'fa200000-0000-4000-8000-000000000001' },
  release = releaseManifestSha256
): CanonicalRequest {
  return {
    schema_version: 1,
    release_manifest_sha256: release,
    authentication_requirements: {
      mfa_required: false,
      step_up_required: false,
      max_auth_age_seconds: 300,
      max_step_up_age_seconds: null,
      ...overrides,
    },
    command_payload: payload,
  };
}

function authenticationFacts(
  options: {
    release?: string;
    subject?: string;
    mfa?: boolean;
    stepUp?: boolean;
    authAgeMs?: number;
  } = {}
): Record<string, unknown> {
  const now = Date.now();
  const mfa = options.mfa ?? false;
  const stepUp = options.stepUp ?? false;
  const verifiedAt = new Date(now - 100).toISOString();
  return {
    schema_version: 1,
    verified_subject: options.subject ?? verifiedSubject,
    issuer: 'https://securetoken.google.com/hustlexp-synthetic',
    audience: 'hustlexp-synthetic',
    release_manifest_sha256: options.release ?? releaseManifestSha256,
    verified_at: verifiedAt,
    bearer_expires_at: new Date(now + 90_000).toISOString(),
    auth_time: new Date(now - (options.authAgeMs ?? 10_000)).toISOString(),
    revocation_checked_at: new Date(now - 50).toISOString(),
    amr: mfa ? ['password', 'mfa'] : ['password'],
    mfa_verified: mfa,
    step_up: {
      satisfied: stepUp,
      method: stepUp ? 'firebase-reauth' : null,
      verified_at: stepUp ? verifiedAt : null,
    },
  };
}

async function cleanup(): Promise<void> {
  const client = adminClient ?? new pg.Client({ connectionString: adminDatabaseUrl() });
  const ownsClient = adminClient === null;
  if (ownsClient) await client.connect();
  try {
    await client.query(
      `SELECT pg_catalog.pg_terminate_backend(pid)
         FROM pg_catalog.pg_stat_activity
        WHERE datname = $1 AND pid <> pg_catalog.pg_backend_pid()`,
      [proofDatabase]
    );
    await client.query(`DROP DATABASE IF EXISTS ${quotedIdentifier(proofDatabase)}`);
    for (const role of [runtimeRole, attesterRole, commandOwner, assertionOwner]) {
      await client.query(`DROP ROLE IF EXISTS ${quotedIdentifier(role)}`);
    }
  } finally {
    if (ownsClient) await client.end();
  }
}

async function applyRegisteredMigration(
  client: pg.Client,
  registration: { name: string; fileName: string }
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

async function canonicalRequestDigest(request: CanonicalRequest): Promise<string> {
  const result = await databaseClient!.query<{ digest: string }>(
    `SELECT pg_catalog.encode(public.digest($1::JSONB::TEXT, 'sha256'), 'hex') AS digest`,
    [request]
  );
  return result.rows[0]!.digest;
}

async function issueAssertion(options: {
  opaqueToken: string;
  request: CanonicalRequest;
  environment?: string;
  commandKind?: string;
  facts?: Record<string, unknown>;
  requestDigest?: string;
  expiresInMs?: number;
}): Promise<{ assertion_id: string; issued_at: Date; expires_at: Date }> {
  const requestDigest = options.requestDigest ?? (await canonicalRequestDigest(options.request));
  const result = await attesterClient!.query<{
    assertion_id: string;
    issued_at: Date;
    expires_at: Date;
  }>(
    `SELECT *
       FROM public.hxos_issue_universal_v1_actor_assertion_v1(
         $1, $2, $3, $4, $5::JSONB, $6::TIMESTAMPTZ
       )`,
    [
      options.opaqueToken,
      options.environment ?? 'local',
      options.commandKind ?? 'EXPRESS_POST_ESTIMATE_INTEREST',
      requestDigest,
      options.facts ?? authenticationFacts(),
      new Date(Date.now() + (options.expiresInMs ?? 45_000)).toISOString(),
    ]
  );
  return result.rows[0]!;
}

async function consumeAssertion(
  client: pg.Client,
  opaqueToken: string,
  request: CanonicalRequest,
  commandKind = 'EXPRESS_POST_ESTIMATE_INTEREST',
  environment = 'local'
): Promise<{ assertion_id: string; verified_subject: string; resolved_user_id: string }> {
  const result = await client.query<{
    assertion_id: string;
    verified_subject: string;
    resolved_user_id: string;
  }>(
    `SELECT *
       FROM hx_authority.consume_universal_v1_actor_assertion_v1(
         $1, $2, $3::JSONB, $4
       )`,
    [opaqueToken, commandKind, request, environment]
  );
  return result.rows[0]!;
}

async function expectDatabaseRefusal(
  operation: () => Promise<unknown>,
  message: RegExp
): Promise<void> {
  try {
    await operation();
    throw new Error('Expected PostgreSQL to refuse the actor-assertion operation');
  } catch (error) {
    expect((error as Error).message).toMatch(message);
  }
}

describePg('Universal V1 PostgreSQL actor-assertion authority v2', () => {
  beforeAll(async () => {
    safeIdentifier(proofDatabase);
    safeIdentifier(assertionOwner);
    safeIdentifier(commandOwner);
    safeIdentifier(attesterRole);
    safeIdentifier(runtimeRole);
    adminClient = new pg.Client({ connectionString: adminDatabaseUrl() });
    await adminClient.connect();
    await cleanup();

    const version = await adminClient.query<{ server_version_num: string }>(
      `SELECT pg_catalog.current_setting('server_version_num') AS server_version_num`
    );
    expect(Number(version.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(160_000);
    expect(Number(version.rows[0]?.server_version_num)).toBeLessThan(170_000);

    await adminClient.query(
      `CREATE ROLE ${quotedIdentifier(assertionOwner)} NOLOGIN NOSUPERUSER NOCREATEDB
         NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`
    );
    await adminClient.query(
      `CREATE ROLE ${quotedIdentifier(commandOwner)} NOLOGIN NOSUPERUSER NOCREATEDB
         NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`
    );
    await adminClient.query(
      `CREATE ROLE ${quotedIdentifier(attesterRole)} LOGIN PASSWORD '${attesterPassword}'
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`
    );
    await adminClient.query(
      `CREATE ROLE ${quotedIdentifier(runtimeRole)} LOGIN PASSWORD '${runtimePassword}'
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`
    );
    await adminClient.query(
      `CREATE DATABASE ${quotedIdentifier(proofDatabase)} TEMPLATE template0`
    );

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
    for (const registration of REQUIRED_MIGRATION_FILES.slice(0, -2)) {
      await applyRegisteredMigration(databaseClient, registration);
    }

    await databaseClient.query(
      `INSERT INTO public.users(
         id, firebase_uid, email, full_name, default_mode, account_status,
         is_minor, is_banned
       ) VALUES ($1, $2, $3, 'Synthetic actor authority', 'poster', 'ACTIVE', FALSE, FALSE)`,
      [canonicalUserId, verifiedSubject, 'actor-authority@synthetic.invalid']
    );

    const tail = REQUIRED_MIGRATION_FILES[144]!;
    expect(tail).toEqual({ name: migrationName, fileName: migrationFileName });
    await applyRegisteredMigration(databaseClient, tail);
    migrationSql = await readFile(
      new URL(`../../database/migrations/${migrationFileName}`, import.meta.url),
      'utf8'
    );
    await databaseClient.query(migrationSql);
    await databaseClient.query(migrationSql);

    await databaseClient.query(
      `ALTER SCHEMA hx_authority OWNER TO ${quotedIdentifier(assertionOwner)};
       ALTER TABLE hx_authority.universal_v1_actor_assertion_issuance_facts
         OWNER TO ${quotedIdentifier(assertionOwner)};
       ALTER TABLE hx_authority.universal_v1_actor_assertion_consumption_facts
         OWNER TO ${quotedIdentifier(assertionOwner)};
       ALTER FUNCTION hx_authority.reject_universal_v1_actor_assertion_mutation_v2()
         OWNER TO ${quotedIdentifier(assertionOwner)};
       ALTER FUNCTION public.hxos_issue_universal_v1_actor_assertion_v1(
         TEXT, TEXT, TEXT, TEXT, JSONB, TIMESTAMPTZ
       ) OWNER TO ${quotedIdentifier(assertionOwner)};
       ALTER FUNCTION hx_authority.consume_universal_v1_actor_assertion_v1(
         TEXT, TEXT, JSONB, TEXT
       ) OWNER TO ${quotedIdentifier(assertionOwner)}`
    );
    await databaseClient.query(
      `REVOKE ALL ON FUNCTION public.digest(TEXT, TEXT) FROM PUBLIC;
       REVOKE ALL ON FUNCTION public.digest(BYTEA, TEXT) FROM PUBLIC;
       GRANT EXECUTE ON FUNCTION public.digest(TEXT, TEXT)
         TO ${quotedIdentifier(assertionOwner)};
       GRANT EXECUTE ON FUNCTION public.digest(BYTEA, TEXT)
         TO ${quotedIdentifier(assertionOwner)};
       GRANT SELECT(id, firebase_uid, account_status, is_minor, is_banned)
         ON TABLE public.users TO ${quotedIdentifier(assertionOwner)};
       GRANT USAGE ON SCHEMA public TO ${quotedIdentifier(attesterRole)};
       GRANT EXECUTE ON FUNCTION public.hxos_issue_universal_v1_actor_assertion_v1(
         TEXT, TEXT, TEXT, TEXT, JSONB, TIMESTAMPTZ
       ) TO ${quotedIdentifier(attesterRole)};
       GRANT USAGE ON SCHEMA hx_authority TO ${quotedIdentifier(commandOwner)};
       GRANT EXECUTE ON FUNCTION hx_authority.consume_universal_v1_actor_assertion_v1(
         TEXT, TEXT, JSONB, TEXT
       ) TO ${quotedIdentifier(commandOwner)}`
    );
    await databaseClient.query(migrationSql);

    attesterClient = new pg.Client({
      connectionString: databaseUrl(attesterRole, attesterPassword),
    });
    runtimeClient = new pg.Client({
      connectionString: databaseUrl(runtimeRole, runtimePassword),
    });
    commandClientA = new pg.Client({ connectionString: databaseUrl() });
    commandClientB = new pg.Client({ connectionString: databaseUrl() });
    await Promise.all([
      attesterClient.connect(),
      runtimeClient.connect(),
      commandClientA.connect(),
      commandClientB.connect(),
    ]);
    await commandClientA.query(`SET ROLE ${quotedIdentifier(commandOwner)}`);
    await commandClientB.query(`SET ROLE ${quotedIdentifier(commandOwner)}`);
  }, 300_000);

  afterAll(async () => {
    for (const client of [commandClientA, commandClientB, runtimeClient, attesterClient]) {
      await client?.end().catch(() => undefined);
    }
    commandClientA = null;
    commandClientB = null;
    runtimeClient = null;
    attesterClient = null;
    await databaseClient?.end().catch(() => undefined);
    databaseClient = null;
    if (adminClient) {
      await cleanup().catch(() => undefined);
      await adminClient.end().catch(() => undefined);
      adminClient = null;
    }
  }, 60_000);

  it('installs fresh through 145, upgrades 144 with data preserved, and raw-replays twice', async () => {
    const registry = await databaseClient!.query<{
      migrations: number;
      tail_name: string;
      tail_sha256: string;
      preserved_user: boolean;
    }>(
      `SELECT
         (SELECT COUNT(*)::INTEGER FROM public.applied_migrations) AS migrations,
         (SELECT name FROM public.applied_migrations ORDER BY applied_at DESC, name DESC LIMIT 1)
           AS tail_name,
         (SELECT sha256::TEXT FROM public.applied_migrations WHERE name = $1) AS tail_sha256,
         EXISTS(SELECT 1 FROM public.users WHERE id = $2 AND firebase_uid = $3)
           AS preserved_user`,
      [migrationName, canonicalUserId, verifiedSubject]
    );
    expect(registry.rows[0]).toEqual({
      migrations: 145,
      tail_name: migrationName,
      tail_sha256: sha256(migrationSql),
      preserved_user: true,
    });
    const facts = await databaseClient!.query<{ issuance: number; consumption: number }>(
      `SELECT
         (SELECT COUNT(*)::INTEGER
            FROM hx_authority.universal_v1_actor_assertion_issuance_facts) AS issuance,
         (SELECT COUNT(*)::INTEGER
            FROM hx_authority.universal_v1_actor_assertion_consumption_facts) AS consumption`
    );
    expect(facts.rows[0]).toEqual({ issuance: 0, consumption: 0 });
  });

  it('proves exact owner, function attributes, and least-privilege ACL topology', async () => {
    const roles = await adminClient!.query<{
      role_name: string;
      can_login: boolean;
      elevated: boolean;
    }>(
      `SELECT rolname AS role_name,
              rolcanlogin AS can_login,
              (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)
                AS elevated
         FROM pg_catalog.pg_roles
        WHERE rolname = ANY($1::TEXT[])
        ORDER BY rolname`,
      [[assertionOwner, attesterRole, commandOwner, runtimeRole]]
    );
    expect(roles.rows).toEqual(
      [
        { role_name: assertionOwner, can_login: false, elevated: false },
        { role_name: attesterRole, can_login: true, elevated: false },
        { role_name: commandOwner, can_login: false, elevated: false },
        { role_name: runtimeRole, can_login: true, elevated: false },
      ].sort((left, right) => left.role_name.localeCompare(right.role_name))
    );

    const functions = await databaseClient!.query<{
      identity: string;
      owner: string;
      security_definer: boolean;
      volatility: string;
      parallel: string;
      configuration: string[];
    }>(
      `SELECT namespace.nspname || '.' || function.proname ||
                '(' || pg_catalog.pg_get_function_identity_arguments(function.oid) || ')' AS identity,
              owner.rolname AS owner,
              function.prosecdef AS security_definer,
              function.provolatile::TEXT AS volatility,
              function.proparallel::TEXT AS parallel,
              function.proconfig AS configuration
         FROM pg_catalog.pg_proc function
         JOIN pg_catalog.pg_namespace namespace ON namespace.oid = function.pronamespace
         JOIN pg_catalog.pg_roles owner ON owner.oid = function.proowner
        WHERE (namespace.nspname, function.proname) IN (
          ('public', 'hxos_issue_universal_v1_actor_assertion_v1'),
          ('hx_authority', 'consume_universal_v1_actor_assertion_v1')
        )
        ORDER BY identity`
    );
    expect(functions.rows).toHaveLength(2);
    for (const fn of functions.rows) {
      expect(fn).toMatchObject({
        owner: assertionOwner,
        security_definer: true,
        volatility: 'v',
        parallel: 'u',
        configuration: ['search_path=pg_catalog'],
      });
    }

    const acl = await databaseClient!.query<{
      public_issuer: boolean;
      public_consumer: boolean;
      attester_issuer: boolean;
      attester_consumer: boolean;
      command_issuer: boolean;
      command_consumer: boolean;
      runtime_issuer: boolean;
      runtime_consumer: boolean;
      runtime_issuance_table: boolean;
      runtime_consumption_table: boolean;
    }>(
      `SELECT
         EXISTS (
           SELECT 1
             FROM pg_catalog.pg_proc function_state
             CROSS JOIN LATERAL pg_catalog.aclexplode(
               COALESCE(
                 function_state.proacl,
                 pg_catalog.acldefault('f', function_state.proowner)
               )
             ) privilege
            WHERE function_state.oid =
              'public.hxos_issue_universal_v1_actor_assertion_v1(text,text,text,text,jsonb,timestamptz)'::REGPROCEDURE
              AND privilege.grantee = 0
              AND privilege.privilege_type = 'EXECUTE'
         ) AS public_issuer,
         EXISTS (
           SELECT 1
             FROM pg_catalog.pg_proc function_state
             CROSS JOIN LATERAL pg_catalog.aclexplode(
               COALESCE(
                 function_state.proacl,
                 pg_catalog.acldefault('f', function_state.proowner)
               )
             ) privilege
            WHERE function_state.oid =
              'hx_authority.consume_universal_v1_actor_assertion_v1(text,text,jsonb,text)'::REGPROCEDURE
              AND privilege.grantee = 0
              AND privilege.privilege_type = 'EXECUTE'
         ) AS public_consumer,
         pg_catalog.has_function_privilege(
           $1, 'public.hxos_issue_universal_v1_actor_assertion_v1(text,text,text,text,jsonb,timestamptz)', 'EXECUTE'
         ) AS attester_issuer,
         pg_catalog.has_function_privilege(
           $1, 'hx_authority.consume_universal_v1_actor_assertion_v1(text,text,jsonb,text)', 'EXECUTE'
         ) AS attester_consumer,
         pg_catalog.has_function_privilege(
           $2, 'public.hxos_issue_universal_v1_actor_assertion_v1(text,text,text,text,jsonb,timestamptz)', 'EXECUTE'
         ) AS command_issuer,
         pg_catalog.has_function_privilege(
           $2, 'hx_authority.consume_universal_v1_actor_assertion_v1(text,text,jsonb,text)', 'EXECUTE'
         ) AS command_consumer,
         pg_catalog.has_function_privilege(
           $3, 'public.hxos_issue_universal_v1_actor_assertion_v1(text,text,text,text,jsonb,timestamptz)', 'EXECUTE'
         ) AS runtime_issuer,
         pg_catalog.has_function_privilege(
           $3, 'hx_authority.consume_universal_v1_actor_assertion_v1(text,text,jsonb,text)', 'EXECUTE'
         ) AS runtime_consumer,
         pg_catalog.has_table_privilege(
           $3, 'hx_authority.universal_v1_actor_assertion_issuance_facts', 'INSERT,UPDATE,DELETE,TRUNCATE'
         ) AS runtime_issuance_table,
         pg_catalog.has_table_privilege(
           $3, 'hx_authority.universal_v1_actor_assertion_consumption_facts', 'INSERT,UPDATE,DELETE,TRUNCATE'
         ) AS runtime_consumption_table`,
      [attesterRole, commandOwner, runtimeRole]
    );
    expect(acl.rows[0]).toEqual({
      public_issuer: false,
      public_consumer: false,
      attester_issuer: true,
      attester_consumer: false,
      command_issuer: false,
      command_consumer: true,
      runtime_issuer: false,
      runtime_consumer: false,
      runtime_issuance_table: false,
      runtime_consumption_table: false,
    });
  });

  it('fails raw replay closed over incompatible relation shape, constraints, or split ownership', async () => {
    const hostileChanges = [
      {
        sql: `ALTER TABLE hx_authority.universal_v1_actor_assertion_issuance_facts
                ADD COLUMN opaque_token TEXT`,
        expected: /HXUV1-ACTOR-34/u,
      },
      {
        sql: `ALTER TABLE hx_authority.universal_v1_actor_assertion_issuance_facts
                DROP CONSTRAINT universal_v1_actor_assertion_lifetime_v2_chk`,
        expected: /HXUV1-ACTOR-36/u,
      },
      {
        sql: `ALTER TABLE hx_authority.universal_v1_actor_assertion_issuance_facts
                DROP CONSTRAINT universal_v1_actor_assertion_lifetime_v2_chk;
              ALTER TABLE hx_authority.universal_v1_actor_assertion_issuance_facts
                ADD CONSTRAINT universal_v1_actor_assertion_lifetime_v2_chk CHECK (TRUE)`,
        expected: /HXUV1-ACTOR-36/u,
      },
      {
        sql: `ALTER FUNCTION hx_authority.consume_universal_v1_actor_assertion_v1(
                TEXT, TEXT, JSONB, TEXT
              ) OWNER TO ${quotedIdentifier(commandOwner)}`,
        expected: /HXUV1-ACTOR-39/u,
      },
    ];

    for (const hostile of hostileChanges) {
      await databaseClient!.query('BEGIN');
      try {
        await databaseClient!.query(hostile.sql);
        await expectDatabaseRefusal(() => databaseClient!.query(migrationSql), hostile.expected);
      } finally {
        await databaseClient!.query('ROLLBACK');
      }
    }
  });

  it('stores no plaintext token or caller actor UUID and caps database lifetime at sixty seconds', async () => {
    const opaqueToken = token();
    const request = canonicalRequest();
    const issued = await issueAssertion({
      opaqueToken,
      request,
      expiresInMs: 120_000,
    });
    expect(issued.expires_at.getTime() - issued.issued_at.getTime()).toBeLessThanOrEqual(60_000);
    expect(issued.expires_at.getTime()).toBeGreaterThan(issued.issued_at.getTime());

    const stored = await databaseClient!.query<{
      token_sha256: string;
      plaintext_present: boolean;
      caller_actor_columns: number;
    }>(
      `SELECT issuance.token_sha256::TEXT AS token_sha256,
              pg_catalog.to_jsonb(issuance)::TEXT LIKE '%' || $2 || '%' AS plaintext_present,
              (
                SELECT COUNT(*)::INTEGER
                  FROM information_schema.columns
                 WHERE table_schema = 'hx_authority'
                   AND table_name IN (
                     'universal_v1_actor_assertion_issuance_facts',
                     'universal_v1_actor_assertion_consumption_facts'
                   )
                   AND column_name IN ('actor_id', 'actor_uuid', 'caller_actor_id')
              ) AS caller_actor_columns
         FROM hx_authority.universal_v1_actor_assertion_issuance_facts issuance
        WHERE issuance.assertion_id = $1`,
      [issued.assertion_id, opaqueToken]
    );
    expect(stored.rows[0]).toEqual({
      token_sha256: sha256(opaqueToken),
      plaintext_present: false,
      caller_actor_columns: 0,
    });
  });

  it('consumes once, resolves the verified subject in PostgreSQL, and rejects reuse', async () => {
    const opaqueToken = token();
    const request = canonicalRequest();
    const issued = await issueAssertion({ opaqueToken, request });
    expect(await consumeAssertion(commandClientA!, opaqueToken, request)).toEqual({
      assertion_id: issued.assertion_id,
      verified_subject: verifiedSubject,
      resolved_user_id: canonicalUserId,
    });
    await expectDatabaseRefusal(
      () => consumeAssertion(commandClientA!, opaqueToken, request),
      /HXUV1-ACTOR-23/u
    );
  });

  it('allows exactly one concurrent consumption winner', async () => {
    const opaqueToken = token();
    const request = canonicalRequest();
    const issued = await issueAssertion({ opaqueToken, request });
    const outcomes = await Promise.allSettled([
      consumeAssertion(commandClientA!, opaqueToken, request),
      consumeAssertion(commandClientB!, opaqueToken, request),
    ]);
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    const loser = outcomes.find(({ status }) => status === 'rejected');
    expect((loser as PromiseRejectedResult).reason.message).toMatch(/HXUV1-ACTOR-23/u);
    const count = await databaseClient!.query<{ count: number }>(
      `SELECT COUNT(*)::INTEGER AS count
         FROM hx_authority.universal_v1_actor_assertion_consumption_facts
        WHERE assertion_id = $1`,
      [issued.assertion_id]
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  it('fails closed for expired, wrong environment, kind, request hash, and release bindings', async () => {
    const cases: Array<{
      expected: RegExp;
      issue: Parameters<typeof issueAssertion>[0];
      consume: (opaqueToken: string) => Promise<unknown>;
      wait?: boolean;
    }> = [];

    const expiredToken = token();
    const expiredRequest = canonicalRequest();
    cases.push({
      expected: /HXUV1-ACTOR-24/u,
      issue: { opaqueToken: expiredToken, request: expiredRequest, expiresInMs: 500 },
      consume: (value) => consumeAssertion(commandClientA!, value, expiredRequest),
      wait: true,
    });

    const wrongEnvironmentToken = token();
    const wrongEnvironmentRequest = canonicalRequest();
    cases.push({
      expected: /HXUV1-ACTOR-25/u,
      issue: { opaqueToken: wrongEnvironmentToken, request: wrongEnvironmentRequest },
      consume: (value) =>
        consumeAssertion(
          commandClientA!,
          value,
          wrongEnvironmentRequest,
          'EXPRESS_POST_ESTIMATE_INTEREST',
          'staging'
        ),
    });

    const wrongKindToken = token();
    const wrongKindRequest = canonicalRequest();
    cases.push({
      expected: /HXUV1-ACTOR-26/u,
      issue: { opaqueToken: wrongKindToken, request: wrongKindRequest },
      consume: (value) =>
        consumeAssertion(commandClientA!, value, wrongKindRequest, 'PLACE_CONDITIONAL_HOLD'),
    });

    const wrongHashToken = token();
    const wrongHashRequest = canonicalRequest();
    cases.push({
      expected: /HXUV1-ACTOR-28/u,
      issue: {
        opaqueToken: wrongHashToken,
        request: wrongHashRequest,
        requestDigest: 'b'.repeat(64),
      },
      consume: (value) => consumeAssertion(commandClientA!, value, wrongHashRequest),
    });

    const wrongReleaseToken = token();
    const issuedReleaseRequest = canonicalRequest();
    const wrongReleaseRequest = canonicalRequest({}, undefined, `sha256:${'c'.repeat(64)}`);
    cases.push({
      expected: /HXUV1-ACTOR-27/u,
      issue: { opaqueToken: wrongReleaseToken, request: issuedReleaseRequest },
      consume: (value) => consumeAssertion(commandClientA!, value, wrongReleaseRequest),
    });

    for (const refusal of cases) {
      await issueAssertion(refusal.issue);
      if (refusal.wait) await databaseClient!.query('SELECT pg_catalog.pg_sleep(0.7)');
      await expectDatabaseRefusal(
        () => refusal.consume(refusal.issue.opaqueToken),
        refusal.expected
      );
    }
  });

  it('fails closed for missing MFA, missing step-up, stale auth, reserved actor payload, and inactive subject', async () => {
    const mfaToken = token();
    const mfaRequest = canonicalRequest({ mfa_required: true });
    await issueAssertion({ opaqueToken: mfaToken, request: mfaRequest });
    await expectDatabaseRefusal(
      () => consumeAssertion(commandClientA!, mfaToken, mfaRequest),
      /HXUV1-ACTOR-29/u
    );

    const stepUpToken = token();
    const stepUpRequest = canonicalRequest({
      step_up_required: true,
      max_step_up_age_seconds: 120,
    });
    await issueAssertion({ opaqueToken: stepUpToken, request: stepUpRequest });
    await expectDatabaseRefusal(
      () => consumeAssertion(commandClientA!, stepUpToken, stepUpRequest),
      /HXUV1-ACTOR-30/u
    );

    const staleToken = token();
    const staleRequest = canonicalRequest({ max_auth_age_seconds: 30 });
    await issueAssertion({
      opaqueToken: staleToken,
      request: staleRequest,
      facts: authenticationFacts({ authAgeMs: 60_000 }),
    });
    await expectDatabaseRefusal(
      () => consumeAssertion(commandClientA!, staleToken, staleRequest),
      /HXUV1-ACTOR-31/u
    );

    const reservedToken = token();
    const reservedRequest = canonicalRequest({}, { nested: { actor_id: canonicalUserId } });
    await issueAssertion({ opaqueToken: reservedToken, request: reservedRequest });
    await expectDatabaseRefusal(
      () => consumeAssertion(commandClientA!, reservedToken, reservedRequest),
      /HXUV1-ACTOR-19/u
    );

    const inactiveSubject = 'firebase:synthetic-inactive-authority-1';
    await databaseClient!.query(
      `INSERT INTO public.users(
         id, firebase_uid, email, full_name, default_mode, account_status,
         is_minor, is_banned
       ) VALUES (
         'fa100000-0000-4000-8000-000000000002', $1,
         'inactive-actor-authority@synthetic.invalid', 'Inactive synthetic actor',
         'poster', 'SUSPENDED', FALSE, FALSE
       )`,
      [inactiveSubject]
    );
    const inactiveToken = token();
    const inactiveRequest = canonicalRequest();
    await issueAssertion({
      opaqueToken: inactiveToken,
      request: inactiveRequest,
      facts: authenticationFacts({ subject: inactiveSubject }),
    });
    await expectDatabaseRefusal(
      () => consumeAssertion(commandClientA!, inactiveToken, inactiveRequest),
      /HXUV1-ACTOR-32/u
    );
  });

  it('rejects mutation and truncate of both append-only fact relations', async () => {
    await databaseClient!.query(`SET ROLE ${quotedIdentifier(assertionOwner)}`);
    try {
      for (const relation of [
        'universal_v1_actor_assertion_issuance_facts',
        'universal_v1_actor_assertion_consumption_facts',
      ]) {
        await expectDatabaseRefusal(
          () =>
            databaseClient!.query(
              `UPDATE hx_authority.${relation}
                  SET token_sha256 = token_sha256
                WHERE TRUE`
            ),
          /HXUV1-ACTOR-1/u
        );
        await expectDatabaseRefusal(
          () => databaseClient!.query(`DELETE FROM hx_authority.${relation} WHERE TRUE`),
          /HXUV1-ACTOR-1/u
        );
        await expectDatabaseRefusal(
          () => databaseClient!.query(`TRUNCATE TABLE hx_authority.${relation} CASCADE`),
          /HXUV1-ACTOR-1/u
        );
      }
    } finally {
      await databaseClient!.query('RESET ROLE');
    }
  });

  it('leaves ordinary runtime unable to issue, consume, read, or mutate assertion facts', async () => {
    await expectDatabaseRefusal(
      () =>
        runtimeClient!.query(
          `SELECT * FROM public.hxos_issue_universal_v1_actor_assertion_v1(
             $1, 'local', 'EXPRESS_POST_ESTIMATE_INTEREST', $2, '{}'::JSONB,
             pg_catalog.clock_timestamp() + INTERVAL '30 seconds'
           )`,
          [token(), 'd'.repeat(64)]
        ),
      /permission denied/iu
    );
    await expectDatabaseRefusal(
      () =>
        runtimeClient!.query(
          `SELECT * FROM hx_authority.consume_universal_v1_actor_assertion_v1(
             $1, 'EXPRESS_POST_ESTIMATE_INTEREST', '{}'::JSONB, 'local'
           )`,
          [token()]
        ),
      /permission denied/iu
    );
    await expectDatabaseRefusal(
      () =>
        runtimeClient!.query(
          `INSERT INTO hx_authority.universal_v1_actor_assertion_issuance_facts
           DEFAULT VALUES`
        ),
      /permission denied/iu
    );
  });
});
