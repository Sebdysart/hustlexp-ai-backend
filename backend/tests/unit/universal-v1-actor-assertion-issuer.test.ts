import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ query: vi.fn(), close: vi.fn(), rawPool: vi.fn() }));
vi.mock('../../src/db', () => ({ db: { query: runtime.query, close: runtime.close } }));
vi.mock('pg', () => ({ default: { Pool: runtime.rawPool } }));
beforeEach(() => {
  vi.resetAllMocks();
});

import {
  PostgresUniversalV1ActorAssertionIssuer,
  UniversalV1ActorAssertionIssuerError,
} from '../../src/services/UniversalV1ActorAssertionIssuer.js';

const role = 'hx_actor_attester_local';
const digest = 'a'.repeat(64);
const now = new Date();
const env = {
  HX_ENVIRONMENT: 'local',
  SERVICE_ROLE: 'attester',
  HX_PAYMENT_CREATION_MODE: 'frozen',
  STRIPE_MODE: 'test',
  ENGINE_API_MODE: 'test',
  HX_EXTERNAL_VALUE: 'false',
  HX_WORK_ORDER_ATTESTER_DATABASE_ROLE: role,
};
const request = {
  opaqueToken: 'b'.repeat(64),
  environment: 'local' as const,
  commandKind: 'EXPRESS_POST_ESTIMATE_INTEREST' as const,
  canonicalRequest: {
    schema_version: 1 as const,
    command_kind: 'EXPRESS_POST_ESTIMATE_INTEREST' as const,
    release_manifest_sha256: `sha256:${'c'.repeat(64)}`,
    target_authority: {
      id: '10000000-0000-4000-8000-000000000099',
      version: 1,
      database: 'hx_ci_actor_attester',
      environment: 'local' as const,
      release: `sha256:${'c'.repeat(64)}`,
    },
    authentication_requirements: {
      mfa_required: false as const,
      step_up_required: false as const,
      max_auth_age_seconds: 300 as const,
      max_step_up_age_seconds: null,
    },
    command_payload: {
      task_id: '10000000-0000-4000-8000-000000000001',
      expected_scope_version: 2,
      idempotency_key: 'interest:test:0001',
      client_timestamp_epoch_ms: now.getTime(),
    },
  },
  canonicalRequestSha256: digest,
  authenticationFacts: {
    schema_version: 1 as const,
    verified_subject: 'firebase_subject_00000001',
    issuer: 'https://securetoken.google.com/hustlexp-test',
    audience: 'hustlexp-test',
    release_manifest_sha256: `sha256:${'c'.repeat(64)}`,
    verified_at: now.toISOString(),
    bearer_expires_at: new Date(now.getTime() + 120_000).toISOString(),
    auth_time: new Date(now.getTime() - 10_000).toISOString(),
    revocation_checked_at: now.toISOString(),
    amr: ['password'],
    mfa_verified: false,
    step_up: { satisfied: false, method: null, verified_at: null },
  },
  requestedExpiresAt: new Date(now.getTime() + 55_000),
};

describe('PostgresUniversalV1ActorAssertionIssuer', () => {
  it('uses the installed runtime for every default query and closes only its issuer', async () => {
    runtime.query
      .mockResolvedValueOnce({
        rows: [{ current_user: role, session_user: role, canonical_request_sha256: digest }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            assertion_id: '20000000-0000-4000-8000-000000000001',
            issued_at: now,
            expires_at: request.requestedExpiresAt,
          },
        ],
      });
    const issuer = new PostgresUniversalV1ActorAssertionIssuer({
      env: {
        ...env,
        HX_ACTOR_ATTESTER_DATABASE_URL: `postgresql://${role}:synthetic@127.0.0.1:5432/attester`,
      },
    });
    expect(runtime.query).not.toHaveBeenCalled();
    await expect(issuer.issue(request)).resolves.toMatchObject({ canonicalRequestSha256: digest });
    expect(runtime.query).toHaveBeenCalledTimes(2);
    expect(runtime.rawPool).not.toHaveBeenCalled();
    await issuer.close();
    await expect(issuer.readiness()).rejects.toMatchObject({ code: 'ISSUER_CLOSED' });
    await expect(issuer.issue(request)).rejects.toMatchObject({ code: 'ISSUER_CLOSED' });
    expect(runtime.close).not.toHaveBeenCalled();
    expect(runtime.query).toHaveBeenCalledTimes(2);
  });

  it('fails closed when startup has not installed a database runtime', async () => {
    runtime.query.mockRejectedValueOnce(new Error('DATABASE_RUNTIME_AUTHORITY_NOT_INSTALLED'));
    const issuer = new PostgresUniversalV1ActorAssertionIssuer({
      env: {
        ...env,
        HX_ACTOR_ATTESTER_DATABASE_URL: `postgresql://${role}:synthetic@127.0.0.1:5432/attester`,
      },
    });
    await expect(issuer.readiness()).rejects.toThrow('DATABASE_RUNTIME_AUTHORITY_NOT_INSTALLED');
    expect(runtime.rawPool).not.toHaveBeenCalled();
  });

  it('reports ready only for the exact unelevated attester login and sealed issuer identity', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          current_user: role,
          session_user: role,
          current_database: 'hx_ci_actor_attester_test',
          issuer_present: true,
          issuer_execute: true,
          rolsuper: false,
          rolcreaterole: false,
          rolcreatedb: false,
          rolreplication: false,
          rolbypassrls: false,
        },
      ],
    });
    const issuer = new PostgresUniversalV1ActorAssertionIssuer({ env, query });
    await expect(issuer.readiness()).resolves.toEqual({
      databaseRole: role,
      databaseName: 'hx_ci_actor_attester_test',
      issuerIdentity:
        'public.hxos_issue_universal_v1_actor_assertion_v1(text,text,text,text,jsonb,timestamp with time zone)',
    });
    expect(query.mock.calls[0]![0]).not.toContain(
      'FROM public.hxos_issue_universal_v1_actor_assertion_v1'
    );
    expect(query.mock.calls[0]![0]).toContain('pg_catalog.to_regprocedure');
    expect(query.mock.calls[0]![0]).toContain('CURRENT_USER AS current_user');
    expect(query.mock.calls[0]![0]).toContain('SESSION_USER AS session_user');
    expect(query.mock.calls[0]![0]).not.toContain('pg_catalog.current_user');
    expect(query.mock.calls[0]![0]).not.toContain('pg_catalog.session_user');
  });

  it('attests the exact session identity and core PostgreSQL jsonb SHA before calling only the sealed issuer', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ current_user: role, session_user: role, canonical_request_sha256: digest }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            assertion_id: '20000000-0000-4000-8000-000000000001',
            issued_at: now,
            expires_at: new Date(now.getTime() + 55_000),
          },
        ],
      });
    const issuer = new PostgresUniversalV1ActorAssertionIssuer({ env, query });
    await expect(issuer.issue(request)).resolves.toMatchObject({
      canonicalRequestSha256: digest,
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]![0]).toContain('$1::JSONB::TEXT');
    expect(query.mock.calls[0]![0]).toContain('pg_catalog.sha256');
    expect(query.mock.calls[0]![0]).not.toContain('public.digest');
    expect(query.mock.calls[0]![0]).toContain('CURRENT_USER AS current_user');
    expect(query.mock.calls[0]![0]).toContain('SESSION_USER AS session_user');
    expect(query.mock.calls[0]![0]).not.toContain('pg_catalog.current_user');
    expect(query.mock.calls[0]![0]).not.toContain('pg_catalog.session_user');
    expect(query.mock.calls[1]![0]).toContain('public.hxos_issue_universal_v1_actor_assertion_v1');
    expect(query.mock.calls[1]![1]).toEqual([
      request.opaqueToken,
      request.environment,
      request.commandKind,
      request.canonicalRequestSha256,
      request.authenticationFacts,
      request.requestedExpiresAt.toISOString(),
    ]);
  });

  it.each([
    ['wrong role', 'different_attester', digest, 'ATTESTER_DATABASE_IDENTITY_MISMATCH'],
    ['wrong digest', role, 'd'.repeat(64), 'CANONICAL_REQUEST_SHA256_MISMATCH'],
  ])(
    'rejects %s before the sealed issuer can run',
    async (_name, currentRole, actualDigest, code) => {
      const query = vi.fn().mockResolvedValue({
        rows: [
          {
            current_user: currentRole,
            session_user: currentRole,
            canonical_request_sha256: actualDigest,
          },
        ],
      });
      const issuer = new PostgresUniversalV1ActorAssertionIssuer({ env, query });
      await expect(issuer.issue(request)).rejects.toMatchObject({
        code,
      } satisfies Partial<UniversalV1ActorAssertionIssuerError>);
      expect(query).toHaveBeenCalledTimes(1);
    }
  );

  it('denies a production role even with a syntactically valid attester query dependency', async () => {
    const query = vi.fn();
    const issuer = new PostgresUniversalV1ActorAssertionIssuer({
      env: { ...env, HX_ENVIRONMENT: 'production' },
      query,
    });
    await expect(issuer.issue(request)).rejects.toMatchObject({
      code: 'PRODUCTION_OR_UNKNOWN_ENVIRONMENT_DENIED',
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses to construct the live attester when a general API database credential is present', () => {
    expect(
      () =>
        new PostgresUniversalV1ActorAssertionIssuer({
          env: {
            ...env,
            DATABASE_URL: `postgresql://${role}:secret@localhost:5432/general_api`,
            HX_ACTOR_ATTESTER_DATABASE_URL: `postgresql://${role}:secret@localhost:5432/attester`,
          },
        })
    ).toThrow('GENERAL_DATABASE_URL_FORBIDDEN');
  });
});
