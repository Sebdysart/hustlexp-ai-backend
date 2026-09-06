import { createHash, createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  actorAttesterRequestSignaturePayload,
  UNIVERSAL_V1_ACTOR_ATTESTATION_PATH,
} from '../../src/auth/universal-v1-actor-attestation-contracts.js';
import { UniversalV1BearerVerificationError } from '../../src/auth/universal-v1-bearer-verifier.js';
import { UniversalV1ActorAssertionIssuerError } from '../../src/services/UniversalV1ActorAssertionIssuer.js';
import { createUniversalV1ActorAttesterApp } from '../../src/services/UniversalV1ActorAttesterService.js';

const secret = 'actor-attester-transport-secret-with-at-least-32-characters';
const now = new Date('2026-09-01T12:00:00.000Z');
const bearer = 'original.firebase.bearer.only-in-request-memory';
const digest = 'a'.repeat(64);
const release = `sha256:${'b'.repeat(64)}`;
const backendRevision = 'd'.repeat(40);
const backendArtifactSha256 = `sha256:${'e'.repeat(64)}`;
const nonce = 'c'.repeat(32);
const tokenBytes = Buffer.from('11'.repeat(32), 'hex');
const env = {
  HX_ENVIRONMENT: 'local',
  SERVICE_ROLE: 'attester',
  HX_PAYMENT_CREATION_MODE: 'frozen',
  STRIPE_MODE: 'test',
  ENGINE_API_MODE: 'test',
  HX_EXTERNAL_VALUE: 'false',
  HX_ACTOR_ATTESTER_TRANSPORT_SECRET: secret,
};

function requestBody(environment: 'local' | 'preview' | 'staging' = 'local', hash = digest) {
  return JSON.stringify({
    schema_version: 1,
    environment,
    command_kind: 'EXPRESS_POST_ESTIMATE_INTEREST',
    canonical_request: {
      schema_version: 1,
      command_kind: 'EXPRESS_POST_ESTIMATE_INTEREST',
      release_manifest_sha256: release,
      target_authority: {
        id: '10000000-0000-4000-8000-000000000099',
        version: 1,
        database: 'hx_ci_actor_attester',
        environment,
        release,
      },
      authentication_requirements: {
        mfa_required: false,
        step_up_required: false,
        max_auth_age_seconds: 300,
        max_step_up_age_seconds: null,
      },
      command_payload: {
        task_id: '10000000-0000-4000-8000-000000000001',
        expected_scope_version: 2,
        idempotency_key: 'interest:test:0001',
        client_timestamp_epoch_ms: now.getTime(),
      },
    },
    canonical_request_sha256: hash,
  });
}

function signedHeaders(body: string, environmentNonce = nonce): Record<string, string> {
  const bodySha256 = createHash('sha256').update(body).digest('hex');
  const bearerSha256 = createHash('sha256').update(bearer).digest('hex');
  const signature = createHmac('sha256', secret)
    .update(
      actorAttesterRequestSignaturePayload({
        timestampMs: now.getTime(),
        nonce: environmentNonce,
        bodySha256,
        bearerSha256,
      })
    )
    .digest('hex');
  return {
    authorization: `Bearer ${bearer}`,
    'content-type': 'application/json',
    'x-hx-attester-timestamp-ms': String(now.getTime()),
    'x-hx-attester-nonce': environmentNonce,
    'x-hx-attester-signature': signature,
  };
}

function verifiedBearer() {
  return {
    verifiedSubject: 'firebase_subject_00000001',
    issuer: 'https://securetoken.google.com/hustlexp-test',
    audience: 'hustlexp-test',
    authenticationTime: new Date(now.getTime() - 10_000),
    bearerExpiresAt: new Date(now.getTime() + 120_000),
    verifiedAt: now,
    revocationCheckedAt: now,
    authenticationMethods: ['password'],
    mfaVerified: false,
  } as const;
}

function service(overrides: Record<string, unknown> = {}) {
  const issuer = {
    readiness: vi.fn().mockResolvedValue({
      databaseRole: 'hx_actor_attester_local',
      databaseName: 'hx_ci_actor_attester_test',
      issuerIdentity:
        'public.hxos_issue_universal_v1_actor_assertion_v1(text,text,text,text,jsonb,timestamp with time zone)',
    }),
    issue: vi.fn().mockResolvedValue({
      assertionId: '20000000-0000-4000-8000-000000000001',
      canonicalRequestSha256: digest,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 55_000),
    }),
  };
  const app = createUniversalV1ActorAttesterApp({
    env,
    releaseBinding: () => ({
      environment: 'local',
      releaseManifestSha256: release,
      backendRevision,
      backendArtifactSha256,
    }),
    verifyBearer: vi.fn().mockResolvedValue(verifiedBearer()),
    issuer,
    randomBytes: () => tokenBytes,
    now: () => now,
    ...overrides,
  });
  return { app, issuer };
}

describe('Universal V1 actor attester service', () => {
  it('re-verifies the bearer and issues a distinct 256-bit token without leaking the bearer', async () => {
    const verifyBearer = vi.fn().mockResolvedValue(verifiedBearer());
    const { app, issuer } = service({ verifyBearer });
    const body = requestBody();
    const response = await app.request(UNIVERSAL_V1_ACTOR_ATTESTATION_PATH, {
      method: 'POST',
      headers: signedHeaders(body),
      body,
    });
    const responseText = await response.text();

    expect(response.status).toBe(200);
    expect(verifyBearer).toHaveBeenCalledWith(bearer);
    expect(responseText).not.toContain(bearer);
    expect(responseText).toContain(tokenBytes.toString('hex'));
    const issuance = issuer.issue.mock.calls[0]![0];
    expect(issuance.opaqueToken).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(issuance)).not.toContain(bearer);
    expect(issuance.authenticationFacts).toMatchObject({
      verified_subject: 'firebase_subject_00000001',
      release_manifest_sha256: release,
      step_up: { satisfied: false, method: null, verified_at: null },
    });
  });

  it('returns health without any bearer or assertion-token material', async () => {
    const { app, issuer } = service();
    const response = await app.request('/health');
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(issuer.readiness).toHaveBeenCalledTimes(1);
    expect(text).not.toContain(bearer);
    expect(text).not.toContain(tokenBytes.toString('hex'));
    expect(JSON.parse(text)).toMatchObject({
      status: 'ready',
      release_manifest_sha256: release,
      backend_revision: backendRevision,
      backend_artifact_sha256: backendArtifactSha256,
      database_role: 'hx_actor_attester_local',
      production_effects: 'NONE',
    });
  });

  it('reports held rather than falsely healthy when exact database identity is unproven', async () => {
    const { app } = service({
      issuer: {
        readiness: vi.fn().mockRejectedValue(new Error('role unavailable')),
        issue: vi.fn(),
      },
    });
    const response = await app.request('/health');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: 'held', production_effects: 'NONE' });
  });

  it('rejects a wrong environment before assertion issuance', async () => {
    const { app, issuer } = service();
    const body = requestBody('preview');
    const response = await app.request(UNIVERSAL_V1_ACTOR_ATTESTATION_PATH, {
      method: 'POST',
      headers: signedHeaders(body),
      body,
    });
    expect(response.status).toBe(401);
    expect(issuer.issue).not.toHaveBeenCalled();
  });

  it('rejects a revoked bearer without reflecting it', async () => {
    const { app, issuer } = service({
      verifyBearer: vi
        .fn()
        .mockRejectedValue(new UniversalV1BearerVerificationError('BEARER_REVOKED')),
    });
    const body = requestBody();
    const response = await app.request(UNIVERSAL_V1_ACTOR_ATTESTATION_PATH, {
      method: 'POST',
      headers: signedHeaders(body),
      body,
    });
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(bearer);
    expect(issuer.issue).not.toHaveBeenCalled();
  });

  it('fails closed on a PostgreSQL canonical command-hash mismatch', async () => {
    const { app } = service({
      issuer: {
        readiness: vi.fn(),
        issue: vi
          .fn()
          .mockRejectedValue(
            new UniversalV1ActorAssertionIssuerError('CANONICAL_REQUEST_SHA256_MISMATCH')
          ),
      },
    });
    const body = requestBody();
    const response = await app.request(UNIVERSAL_V1_ACTOR_ATTESTATION_PATH, {
      method: 'POST',
      headers: signedHeaders(body),
      body,
    });
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(tokenBytes.toString('hex'));
  });

  it('denies production even before an HTTP handler can be created', () => {
    expect(() =>
      createUniversalV1ActorAttesterApp({
        env: { ...env, HX_ENVIRONMENT: 'production' },
      })
    ).toThrow('PRODUCTION_OR_UNKNOWN_DENIED');
  });
});
