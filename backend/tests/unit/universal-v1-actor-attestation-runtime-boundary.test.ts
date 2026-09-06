import { describe, expect, it } from 'vitest';

import { assertApiActorAttesterCredentialIsolation } from '../../src/auth/universal-v1-actor-attestation-runtime-boundary.js';

describe('Universal V1 API/attester runtime boundary', () => {
  it('allows the API to hold only the internal transport configuration', () => {
    expect(() =>
      assertApiActorAttesterCredentialIsolation({
        SERVICE_ROLE: 'api',
        HX_ACTOR_ATTESTER_URL: 'https://actor-attester.railway.internal',
        HX_ACTOR_ATTESTER_TRANSPORT_SECRET: 'internal-transport-secret-reference',
      })
    ).not.toThrow();
  });

  it.each(['HX_ACTOR_ATTESTER_DATABASE_URL', 'HX_WORK_ORDER_ATTESTER_DATABASE_ROLE'] as const)(
    'refuses API startup when %s is present',
    (name) => {
      expect(() =>
        assertApiActorAttesterCredentialIsolation({
          SERVICE_ROLE: 'api',
          [name]: 'attester-only-material',
        })
      ).toThrow(`ATTESTER_DATABASE_CONFIGURATION_PRESENT:${name}`);
    }
  );

  it('refuses to boot the API entrypoint under the attester service role', () => {
    expect(() => assertApiActorAttesterCredentialIsolation({ SERVICE_ROLE: 'attester' })).toThrow(
      'SERVICE_ROLE_ATTESTER_FORBIDDEN'
    );
  });
});
