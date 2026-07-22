import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../src/db.js', () => ({ db: { query: mocks.query } }));

import { getPrivateIdentityVerificationStatus } from '../../src/services/PrivateIdentityVerificationService.js';

const userId = '85000000-0000-4000-8000-000000000001';

beforeEach(() => vi.clearAllMocks());

describe('private identity verification status', () => {
  it('returns only privacy-minimized attributable production status', async () => {
    mocks.query.mockResolvedValue({ rows: [{
      identity_verification_status: 'VERIFIED',
      is_verified: true,
      identity_verification_environment: 'PRODUCTION',
      identity_verification_policy_version: 'hxos-private-identity-v1',
      verified_at: '2026-07-21T10:00:00.000Z',
      identity_verification_expires_at: '2027-07-21T10:00:00.000Z',
      provider: 'external_provider',
      provider_environment: 'PRODUCTION',
      is_test: false,
      case_status: 'VERIFIED',
      consent_revoked_at: null,
    }], rowCount: 1 });

    const status = await getPrivateIdentityVerificationStatus(userId, new Date('2026-07-21T12:00:00.000Z'));
    expect(status).toMatchObject({ success: true, data: {
      status: 'VERIFIED', verified: true, environment: 'PRODUCTION', testOnly: false,
      canAcceptProductionWork: true, providerLabel: 'Private identity provider', nextAction: 'NONE',
    } });
    expect(JSON.stringify(status)).not.toMatch(/provider_case|evidence_hash|document_url|selfie_url|raw_payload/i);
  });

  it('never presents controlled TEST evidence as production work authority', async () => {
    mocks.query.mockResolvedValue({ rows: [{
      identity_verification_status: 'VERIFIED', is_verified: true,
      identity_verification_environment: 'CONTROLLED_TEST',
      identity_verification_policy_version: 'hxos-private-identity-local-test-v1',
      verified_at: '2026-07-21T10:00:00.000Z',
      identity_verification_expires_at: '2026-10-21T10:00:00.000Z',
      provider: 'local_certification_identity', provider_environment: 'CONTROLLED_TEST',
      is_test: true, case_status: 'VERIFIED', consent_revoked_at: null,
    }], rowCount: 1 });

    await expect(getPrivateIdentityVerificationStatus(userId, new Date('2026-07-21T12:00:00.000Z')))
      .resolves.toMatchObject({ success: true, data: {
        verified: true, testOnly: true, canAcceptProductionWork: false,
        providerLabel: 'HustleXP controlled TEST',
      } });
  });

  it('fails expired or revoked evidence closed without leaking provider internals', async () => {
    for (const row of [
      {
        identity_verification_status: 'VERIFIED', is_verified: true,
        identity_verification_environment: 'PRODUCTION',
        identity_verification_policy_version: 'hxos-private-identity-v1',
        verified_at: '2026-01-01T00:00:00.000Z',
        identity_verification_expires_at: '2026-07-20T00:00:00.000Z',
        provider: 'external_provider', provider_environment: 'PRODUCTION',
        is_test: false, case_status: 'VERIFIED', consent_revoked_at: null,
      },
      {
        identity_verification_status: 'VERIFIED', is_verified: true,
        identity_verification_environment: 'PRODUCTION',
        identity_verification_policy_version: 'hxos-private-identity-v1',
        verified_at: '2026-01-01T00:00:00.000Z',
        identity_verification_expires_at: '2027-01-01T00:00:00.000Z',
        provider: 'external_provider', provider_environment: 'PRODUCTION',
        is_test: false, case_status: 'VERIFIED', consent_revoked_at: '2026-07-20T00:00:00.000Z',
      },
    ]) {
      mocks.query.mockResolvedValueOnce({ rows: [row], rowCount: 1 });
      const status = await getPrivateIdentityVerificationStatus(userId, new Date('2026-07-21T00:00:00.000Z'));
      expect(status).toMatchObject({ success: true, data: { verified: false, canAcceptProductionWork: false } });
    }
  });

  it('returns a safe unavailable error when persistence fails', async () => {
    mocks.query.mockRejectedValue(new Error('secret database detail'));
    await expect(getPrivateIdentityVerificationStatus(userId)).resolves.toEqual({
      success: false,
      error: { code: 'DB_ERROR', message: 'Identity verification status is temporarily unavailable.' },
    });
  });
});
