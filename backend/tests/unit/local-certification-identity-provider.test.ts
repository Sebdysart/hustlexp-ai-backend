import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const query = vi.fn();
  return { query, transaction: vi.fn(async (work: (query: typeof query) => unknown) => work(query)) };
});
vi.mock('../../src/db.js', () => ({ db: { query: mocks.query, transaction: mocks.transaction } }));

import {
  LocalCertificationIdentityProvider,
  localCertificationIdentityEnabled,
} from '../../src/services/LocalCertificationIdentityProvider.js';

const original = { ...process.env };
const enabled = {
  NODE_ENV: 'test', HXOS_ALLOW_LOCAL_TEST_IDENTITY: 'true', ENGINE_API_MODE: 'test',
  STRIPE_MODE: 'test', HXOS_LOCAL_TEST_IDENTITY_SECRET: 'i'.repeat(64),
};
const userId = '85000000-0000-4000-8000-000000000001';
const actorId = '85000000-0000-4000-8000-000000000002';
const consentId = '85000000-0000-4000-8000-000000000003';
const caseId = '85000000-0000-4000-8000-000000000004';

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(process.env, enabled);
  mocks.transaction.mockImplementation(async (work) => work(mocks.query));
});
afterEach(() => { process.env = { ...original }; });

describe('LocalCertificationIdentityProvider', () => {
  it('is impossible to enable in production-shaped environments', () => {
    expect(localCertificationIdentityEnabled(enabled)).toBe(true);
    for (const override of [
      { NODE_ENV: 'production' }, { HXOS_ALLOW_LOCAL_TEST_IDENTITY: 'false' },
      { ENGINE_API_MODE: 'live' }, { STRIPE_MODE: 'live' },
      { HXOS_LOCAL_TEST_IDENTITY_SECRET: 'short' },
    ]) expect(localCertificationIdentityEnabled({ ...enabled, ...override })).toBe(false);
  });

  it('creates consent and one controlled TEST case without identity media', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM identity_verification_consents')) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO identity_verification_consents')) return { rows: [{ id: consentId, disclosure_hash: 'a'.repeat(64) }], rowCount: 1 };
      if (sql.includes('begin_identity_verification_case_v1')) return { rows: [{ case_id: caseId, case_status: 'PENDING', idempotency_replayed: false }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    const response = await LocalCertificationIdentityProvider.prepare({ userId, idempotencyKey: 'identity-prepare-0001' });
    expect(response).toMatchObject({ success: true, data: {
      caseId, status: 'PENDING', environment: 'CONTROLLED_TEST', isTest: true,
    } });
    const statements = mocks.query.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(statements).toContain("set_config('hustlexp.local_test_identity_enabled','true',true)");
    expect(statements).toContain('begin_identity_verification_case_v1');
    expect(statements).not.toMatch(/document_url|selfie|raw_payload|public_url/i);
  });

  it('moves an exact controlled TEST case through processing and verified', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM identity_verification_cases')) return { rows: [{
        id: caseId, user_id: userId, status: 'PENDING',
        provider_case_id: `idv_hxos_test_${'a'.repeat(32)}`,
        request_hash: 'b'.repeat(64), is_test: true,
      }], rowCount: 1 };
      if (sql.includes('record_identity_verification_event_v1') && sql.includes("'VERIFIED'")) {
        return { rows: [{ case_status: 'VERIFIED', identity_verified: true, idempotency_replayed: false }], rowCount: 1 };
      }
      if (sql.includes('record_identity_verification_event_v1')) {
        return { rows: [{ case_status: 'PROCESSING', identity_verified: false, idempotency_replayed: false }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    const response = await LocalCertificationIdentityProvider.completeVerified({
      userId, caseId, actorId, idempotencyKey: 'identity-verified-0001',
    });
    expect(response).toMatchObject({ success: true, data: { status: 'VERIFIED', isTest: true } });
    const statements = mocks.query.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(statements).toContain("'PROCESSING'");
    expect(statements).toContain("'VERIFIED'");
  });

  it('fails closed for invalid input and missing exact case', async () => {
    await expect(LocalCertificationIdentityProvider.prepare({ userId: 'bad', idempotencyKey: 'short' }))
      .resolves.toMatchObject({ success: false, error: { code: 'LOCAL_TEST_IDENTITY_INVALID' } });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM identity_verification_cases')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });
    await expect(LocalCertificationIdentityProvider.completeVerified({
      userId, caseId, actorId, idempotencyKey: 'identity-verified-0001',
    })).resolves.toMatchObject({ success: false, error: { code: 'LOCAL_TEST_IDENTITY_NOT_FOUND' } });
  });
});
