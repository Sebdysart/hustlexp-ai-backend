import { db } from '../db.js';

import type {
  UniversalV1ActorCommandKind,
  UniversalV1ActorEnvironment,
  UniversalV1CanonicalActorRequest,
} from '../auth/universal-v1-actor-attestation-contracts.js';

const DATABASE_ROLE = /^[a-z_][a-z0-9_]{0,62}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;

export class UniversalV1ActorAssertionIssuerError extends Error {
  constructor(readonly code: string) {
    super(`UNIVERSAL_V1_ACTOR_ASSERTION_ISSUER_REFUSED:${code}`);
    this.name = 'UniversalV1ActorAssertionIssuerError';
  }
}

export interface UniversalV1VerifiedAuthenticationFacts extends Record<string, unknown> {
  readonly schema_version: 1;
  readonly verified_subject: string;
  readonly issuer: string;
  readonly audience: string;
  readonly release_manifest_sha256: string;
  readonly verified_at: string;
  readonly bearer_expires_at: string;
  readonly auth_time: string;
  readonly revocation_checked_at: string;
  readonly amr: readonly string[];
  readonly mfa_verified: boolean;
  readonly step_up: {
    readonly satisfied: boolean;
    readonly method: string | null;
    readonly verified_at: string | null;
  };
}

export interface UniversalV1ActorAssertionIssueRequest {
  readonly opaqueToken: string;
  readonly environment: UniversalV1ActorEnvironment;
  readonly commandKind: UniversalV1ActorCommandKind;
  readonly canonicalRequest: UniversalV1CanonicalActorRequest;
  readonly canonicalRequestSha256: string;
  readonly authenticationFacts: UniversalV1VerifiedAuthenticationFacts;
  readonly requestedExpiresAt: Date;
}

export interface UniversalV1ActorAssertionIssueResult {
  readonly assertionId: string;
  readonly canonicalRequestSha256: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export interface UniversalV1ActorAssertionIssuerReadiness {
  readonly databaseRole: string;
  readonly databaseName: string;
  readonly issuerIdentity: string;
}

export interface UniversalV1ActorAssertionIssuerPort {
  issue(
    request: UniversalV1ActorAssertionIssueRequest
  ): Promise<UniversalV1ActorAssertionIssueResult>;
  readiness(): Promise<UniversalV1ActorAssertionIssuerReadiness>;
}

interface QueryResult<Row> {
  readonly rows: Row[];
  readonly rowCount?: number | null;
}

type Query = <Row>(sql: string, parameters?: readonly unknown[]) => Promise<QueryResult<Row>>;

interface IssuerIdentityRow {
  current_user: string;
  session_user: string;
  canonical_request_sha256: string;
}

interface IssuedRow {
  assertion_id: string;
  issued_at: Date | string;
  expires_at: Date | string;
}

interface ReadinessRow {
  current_user: string;
  session_user: string;
  current_database: string;
  issuer_present: boolean;
  issuer_execute: boolean;
  rolsuper: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
}

function exactAttesterRole(env: Environment): string {
  const role = env.HX_WORK_ORDER_ATTESTER_DATABASE_ROLE?.trim() ?? '';
  if (!DATABASE_ROLE.test(role)) {
    throw new UniversalV1ActorAssertionIssuerError('ATTESTER_DATABASE_ROLE_REQUIRED');
  }
  return role;
}

function validateAttesterRuntime(env: Environment): void {
  const environment = env.HX_ENVIRONMENT?.trim().toLowerCase();
  if (!['local', 'preview', 'staging'].includes(environment ?? '')) {
    throw new UniversalV1ActorAssertionIssuerError('PRODUCTION_OR_UNKNOWN_ENVIRONMENT_DENIED');
  }
  if (env.SERVICE_ROLE?.trim().toLowerCase() !== 'attester') {
    throw new UniversalV1ActorAssertionIssuerError('SERVICE_ROLE_MUST_BE_ATTESTER');
  }
  if (
    env.HX_PAYMENT_CREATION_MODE !== 'frozen' ||
    env.STRIPE_MODE !== 'test' ||
    env.ENGINE_API_MODE !== 'test' ||
    env.HX_EXTERNAL_VALUE === 'true'
  ) {
    throw new UniversalV1ActorAssertionIssuerError('NONPRODUCTION_FREEZE_NOT_PROVEN');
  }
}

function attesterDatabaseUrl(env: Environment): string {
  const raw = env.HX_ACTOR_ATTESTER_DATABASE_URL?.trim() ?? '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UniversalV1ActorAssertionIssuerError('ATTESTER_DATABASE_URL_REQUIRED');
  }
  const expectedRole = exactAttesterRole(env);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    decodeURIComponent(url.username) !== expectedRole ||
    !url.hostname ||
    !url.pathname.slice(1) ||
    url.hash
  ) {
    throw new UniversalV1ActorAssertionIssuerError('ATTESTER_DATABASE_URL_INVALID');
  }
  return raw;
}

function assertNoGeneralDatabaseCredential(env: Environment): void {
  if (env.DATABASE_URL?.trim()) {
    throw new UniversalV1ActorAssertionIssuerError('GENERAL_DATABASE_URL_FORBIDDEN');
  }
}

export class PostgresUniversalV1ActorAssertionIssuer implements UniversalV1ActorAssertionIssuerPort {
  private readonly env: Environment;
  private readonly injectedQuery: Query | null;
  private closed = false;

  constructor(options: { readonly env?: Environment; readonly query?: Query } = {}) {
    this.env = options.env ?? process.env;
    this.injectedQuery = options.query ?? null;
    if (!this.injectedQuery) {
      validateAttesterRuntime(this.env);
      assertNoGeneralDatabaseCredential(this.env);
      attesterDatabaseUrl(this.env);
    }
  }

  private query(): Query {
    if (this.closed) throw new UniversalV1ActorAssertionIssuerError('ISSUER_CLOSED');
    validateAttesterRuntime(this.env);
    assertNoGeneralDatabaseCredential(this.env);
    if (this.injectedQuery) return this.injectedQuery;
    // Startup owns the attested pool. Every statement traverses the installed
    // data plane, including its live target and authority checks.
    return async <Row>(sql: string, parameters?: readonly unknown[]) => {
      return db.query<Row>(sql, parameters ? [...parameters] : undefined);
    };
  }

  async readiness(): Promise<UniversalV1ActorAssertionIssuerReadiness> {
    const query = this.query();
    const expectedRole = exactAttesterRole(this.env);
    const result = await query<ReadinessRow>(
      `SELECT
         CURRENT_USER AS current_user,
         SESSION_USER AS session_user,
         pg_catalog.current_database() AS current_database,
         pg_catalog.to_regprocedure(
           'public.hxos_issue_universal_v1_actor_assertion_v1(text,text,text,text,jsonb,timestamp with time zone)'
         ) IS NOT NULL AS issuer_present,
         CASE
           WHEN pg_catalog.to_regprocedure(
             'public.hxos_issue_universal_v1_actor_assertion_v1(text,text,text,text,jsonb,timestamp with time zone)'
           ) IS NULL THEN FALSE
           ELSE pg_catalog.has_function_privilege(
             CURRENT_USER,
             pg_catalog.to_regprocedure(
               'public.hxos_issue_universal_v1_actor_assertion_v1(text,text,text,text,jsonb,timestamp with time zone)'
             ),
             'EXECUTE'
           )
         END AS issuer_execute,
         role.rolsuper,
         role.rolcreaterole,
         role.rolcreatedb,
         role.rolreplication,
         role.rolbypassrls
       FROM pg_catalog.pg_roles role
       WHERE role.rolname = CURRENT_USER`,
      []
    );
    const row = result.rows[0];
    if (
      result.rows.length !== 1 ||
      !row ||
      row.current_user !== expectedRole ||
      row.session_user !== expectedRole ||
      !row.current_database ||
      row.issuer_present !== true ||
      row.issuer_execute !== true ||
      row.rolsuper ||
      row.rolcreaterole ||
      row.rolcreatedb ||
      row.rolreplication ||
      row.rolbypassrls
    ) {
      throw new UniversalV1ActorAssertionIssuerError('ATTESTER_DATABASE_READINESS_HELD');
    }
    return {
      databaseRole: row.current_user,
      databaseName: row.current_database,
      issuerIdentity:
        'public.hxos_issue_universal_v1_actor_assertion_v1(text,text,text,text,jsonb,timestamp with time zone)',
    };
  }

  async issue(
    request: UniversalV1ActorAssertionIssueRequest
  ): Promise<UniversalV1ActorAssertionIssueResult> {
    const query = this.query();
    const expectedRole = exactAttesterRole(this.env);
    const identity = await query<IssuerIdentityRow>(
      `SELECT
         CURRENT_USER AS current_user,
         SESSION_USER AS session_user,
         pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to($1::JSONB::TEXT, 'UTF8')),
           'hex'
         ) AS canonical_request_sha256`,
      [request.canonicalRequest]
    );
    const identityRow = identity.rows[0];
    if (
      !identityRow ||
      identityRow.current_user !== expectedRole ||
      identityRow.session_user !== expectedRole
    ) {
      throw new UniversalV1ActorAssertionIssuerError('ATTESTER_DATABASE_IDENTITY_MISMATCH');
    }
    if (
      !SHA256.test(identityRow.canonical_request_sha256) ||
      identityRow.canonical_request_sha256 !== request.canonicalRequestSha256
    ) {
      throw new UniversalV1ActorAssertionIssuerError('CANONICAL_REQUEST_SHA256_MISMATCH');
    }

    const issued = await query<IssuedRow>(
      `SELECT assertion_id, issued_at, expires_at
         FROM public.hxos_issue_universal_v1_actor_assertion_v1(
           $1::TEXT,
           $2::TEXT,
           $3::TEXT,
           $4::TEXT,
           $5::JSONB,
           $6::TIMESTAMPTZ
         )`,
      [
        request.opaqueToken,
        request.environment,
        request.commandKind,
        request.canonicalRequestSha256,
        request.authenticationFacts,
        request.requestedExpiresAt.toISOString(),
      ]
    );
    const row = issued.rows[0];
    if (!row) {
      throw new UniversalV1ActorAssertionIssuerError('SEALED_ISSUER_RETURNED_NO_ASSERTION');
    }
    const issuedAt = new Date(row.issued_at);
    const expiresAt = new Date(row.expires_at);
    if (
      !Number.isFinite(issuedAt.getTime()) ||
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt <= issuedAt
    ) {
      throw new UniversalV1ActorAssertionIssuerError('SEALED_ISSUER_RESPONSE_INVALID');
    }
    return {
      assertionId: row.assertion_id,
      canonicalRequestSha256: request.canonicalRequestSha256,
      issuedAt,
      expiresAt,
    };
  }

  async close(): Promise<void> {
    // Close this issuer, never a process-owned pool or another installation.
    this.closed = true;
  }
}
