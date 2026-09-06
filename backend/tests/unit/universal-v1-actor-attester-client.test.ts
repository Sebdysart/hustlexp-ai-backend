import { createHash, createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  actorAttesterResponseSignaturePayload,
  UNIVERSAL_V1_ACTOR_ATTESTATION_PATH,
} from '../../src/auth/universal-v1-actor-attestation-contracts.js';
import {
  createUniversalV1ActorAttestationHandle,
  UniversalV1ActorAttestationClientError,
  UniversalV1ActorAttesterClient,
} from '../../src/services/UniversalV1ActorAttesterClient.js';

const now = new Date('2026-09-01T12:00:00.000Z');
const secret = 'actor-attester-transport-secret-with-at-least-32-characters';
const bearer = 'original.firebase.bearer.not-in-body-or-url';
const canonicalDigest = 'a'.repeat(64);
const assertionToken = 'b'.repeat(64);
const release = `sha256:${'c'.repeat(64)}`;
const targetAuthorityId = '20000000-0000-4000-8000-000000000001';
const nonceBytes = Buffer.from('dd'.repeat(16), 'hex');
const command = {
  commandKind: 'EXPRESS_POST_ESTIMATE_INTEREST',
  commandPayload: {
    task_id: '10000000-0000-4000-8000-000000000001',
    expected_scope_version: 2,
    idempotency_key: 'interest:test:0001',
    client_timestamp_epoch_ms: now.getTime(),
  },
} as const;

function canonicalAuthority(environment: 'local' | 'staging' = 'local') {
  const canonicalRequest = {
    schema_version: 1 as const,
    command_kind: command.commandKind,
    release_manifest_sha256: release,
    target_authority: {
      id: targetAuthorityId,
      version: 1,
      database: 'hx_ci_work_order',
      environment,
      release,
    },
    authentication_requirements: {
      mfa_required: false as const,
      step_up_required: false as const,
      max_auth_age_seconds: 300 as const,
      max_step_up_age_seconds: null,
    },
    command_payload: command.commandPayload,
  };
  return {
    build: vi.fn().mockResolvedValue({
      targetAuthorityId,
      environment,
      releaseManifestSha256: release,
      canonicalRequest,
      canonicalRequestSha256: canonicalDigest,
    }),
  };
}

function env(url = `http://127.0.0.1:3002${UNIVERSAL_V1_ACTOR_ATTESTATION_PATH}`) {
  return {
    HX_ACTOR_ATTESTER_URL: url,
    HX_ACTOR_ATTESTER_TIMEOUT_MS: '100',
    HX_ACTOR_ATTESTER_TRANSPORT_SECRET: secret,
  };
}

function signedResponse(
  requestNonce: string,
  body: string,
  status = 200,
  signatureOverride?: string
): Response {
  const bodySha256 = createHash('sha256').update(body).digest('hex');
  const signature =
    signatureOverride ??
    createHmac('sha256', secret)
      .update(actorAttesterResponseSignaturePayload({ requestNonce, status, bodySha256 }))
      .digest('hex');
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json',
      'x-hx-attester-response-signature': signature,
    },
  });
}

function successBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schema_version: 1,
    command_kind: command.commandKind,
    canonical_request_sha256: canonicalDigest,
    actor_assertion_token: assertionToken,
    assertion_expires_at: new Date(now.getTime() + 55_000).toISOString(),
    ...overrides,
  });
}

function client(fetchImplementation: typeof fetch, environment: 'local' | 'staging' = 'local') {
  return new UniversalV1ActorAttesterClient({
    env: {
      ...env(),
      ...(environment === 'staging'
        ? {
            HX_ACTOR_ATTESTER_URL: `https://attester.railway.internal${UNIVERSAL_V1_ACTOR_ATTESTATION_PATH}`,
            HX_ACTOR_ATTESTER_INTERNAL_HOST: 'attester.railway.internal',
          }
        : {}),
    },
    releaseBinding: () => ({
      environment,
      releaseManifestSha256: release,
      backendRevision: 'd'.repeat(40),
      backendArtifactSha256: `sha256:${'e'.repeat(64)}`,
    }),
    canonicalAuthority: canonicalAuthority(environment),
    fetch: fetchImplementation,
    now: () => now,
    randomBytes: () => nonceBytes,
  });
}

describe('UniversalV1ActorAttesterClient', () => {
  it('places the bearer only in Authorization and binds the body, URL and signed response', async () => {
    const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).not.toContain(bearer);
      expect(String(init?.body)).not.toContain(bearer);
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${bearer}`);
      expect(init?.redirect).toBe('error');
      return signedResponse(nonceBytes.toString('hex'), successBody());
    }) as unknown as typeof fetch;

    await expect(client(fetchImplementation).issue(bearer, command)).resolves.toMatchObject({
      actor_assertion_token: assertionToken,
      canonical_request_sha256: canonicalDigest,
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('retains the original bearer only in a request-scoped closure and can re-attest', async () => {
    const issue = vi.fn().mockResolvedValue({ actor_assertion_token: assertionToken });
    const handle = createUniversalV1ActorAttestationHandle(bearer, { issue } as never);
    expect(JSON.stringify(handle)).not.toContain(bearer);
    expect(Object.values(handle)).not.toContain(bearer);
    await handle.issue(command);
    expect(issue).toHaveBeenCalledWith(bearer, command);
  });

  it('fails closed on timeout', async () => {
    const never = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        })
    ) as unknown as typeof fetch;
    await expect(client(never).issue(bearer, command)).rejects.toMatchObject({
      code: 'ATTESTER_UNAVAILABLE',
    } satisfies Partial<UniversalV1ActorAttestationClientError>);
  });

  it.each([
    ['malformed JSON', '{', 'ATTESTER_RESPONSE_MALFORMED'],
    [
      'wrong command hash',
      successBody({ canonical_request_sha256: 'e'.repeat(64) }),
      'ATTESTER_RESPONSE_BINDING_MISMATCH',
    ],
    [
      'expiry beyond the database 60-second ceiling',
      successBody({ assertion_expires_at: new Date(now.getTime() + 91_000).toISOString() }),
      'ATTESTER_RESPONSE_BINDING_MISMATCH',
    ],
  ])('rejects %s', async (_name, body, code) => {
    const fetchImplementation = vi.fn(async () =>
      signedResponse(nonceBytes.toString('hex'), body)
    ) as unknown as typeof fetch;
    await expect(client(fetchImplementation).issue(bearer, command)).rejects.toMatchObject({
      code,
    });
  });

  it('rejects an unsigned response even when its JSON looks valid', async () => {
    const fetchImplementation = vi.fn(async () =>
      signedResponse(nonceBytes.toString('hex'), successBody(), 200, 'f'.repeat(64))
    ) as unknown as typeof fetch;
    await expect(client(fetchImplementation).issue(bearer, command)).rejects.toMatchObject({
      code: 'ATTESTER_RESPONSE_AUTHENTICATION_FAILED',
    });
  });

  it('will not send a deployed bearer to an arbitrary HTTPS host', async () => {
    const fetchImplementation = vi.fn() as unknown as typeof fetch;
    const deployed = new UniversalV1ActorAttesterClient({
      env: {
        ...env(`https://external.example${UNIVERSAL_V1_ACTOR_ATTESTATION_PATH}`),
        HX_ACTOR_ATTESTER_INTERNAL_HOST: 'external.example',
      },
      releaseBinding: () => ({
        environment: 'staging',
        releaseManifestSha256: release,
        backendRevision: 'd'.repeat(40),
        backendArtifactSha256: `sha256:${'e'.repeat(64)}`,
      }),
      canonicalAuthority: canonicalAuthority('staging'),
      fetch: fetchImplementation,
      now: () => now,
      randomBytes: () => nonceBytes,
    });
    await expect(deployed.issue(bearer, command)).rejects.toMatchObject({
      code: 'DEPLOYED_ATTESTER_NOT_INTERNAL',
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
