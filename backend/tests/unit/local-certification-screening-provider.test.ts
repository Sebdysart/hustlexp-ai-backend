import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const query = vi.fn();
  const transaction = vi.fn(async (work: (q: typeof query) => unknown) => work(query));
  return { query, transaction, recompute: vi.fn() };
});

vi.mock('../../src/db.js', () => ({
  db: { query: mocks.query, transaction: mocks.transaction },
}));
vi.mock('../../src/services/CapabilityRecomputeService.js', () => ({
  recomputeCapabilityProfile: mocks.recompute,
}));

import {
  isLocalCertificationScreeningReportId,
  LocalCertificationScreeningProvider,
  localCertificationScreeningEnabled,
} from '../../src/services/LocalCertificationScreeningProvider.js';
import {
  LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_HASH,
  LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_VERSION,
  LOCAL_CERTIFICATION_SCREENING_PROVIDER,
} from '../../src/services/WorkerScreeningRightsPolicy.js';

const enabled = {
  NODE_ENV: 'test',
  HXOS_ALLOW_LOCAL_TEST_SCREENING: 'true',
  ENGINE_API_MODE: 'test',
  STRIPE_MODE: 'test',
  HXOS_LOCAL_TEST_SCREENING_SECRET: 's'.repeat(64),
};
const original = { ...process.env };
const workerId = '84000000-0000-4000-8000-000000000002';
const consentId = '84000000-0000-4000-8000-000000000003';
const backgroundCheckId = '84000000-0000-4000-8000-000000000004';

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(process.env, enabled);
  mocks.transaction.mockImplementation(async (work) => work(mocks.query));
  mocks.recompute.mockResolvedValue(undefined);
});

afterEach(() => {
  process.env = { ...original };
});

describe('LocalCertificationScreeningProvider', () => {
  it('is disabled by default and rejects every production-shaped configuration', () => {
    expect(localCertificationScreeningEnabled(enabled)).toBe(true);
    for (const override of [
      { NODE_ENV: 'production' },
      { HXOS_ALLOW_LOCAL_TEST_SCREENING: 'false' },
      { ENGINE_API_MODE: 'live' },
      { STRIPE_MODE: 'live' },
      { HXOS_LOCAL_TEST_SCREENING_SECRET: 'short' },
    ]) {
      expect(localCertificationScreeningEnabled({ ...enabled, ...override })).toBe(false);
    }
  });

  it('uses an identity that cannot be mistaken for an external provider report', () => {
    expect(isLocalCertificationScreeningReportId(`scr_hxos_test_${'a'.repeat(32)}`)).toBe(true);
    expect(isLocalCertificationScreeningReportId(`report_${'a'.repeat(32)}`)).toBe(false);
    expect(isLocalCertificationScreeningReportId('checkr_123')).toBe(false);
  });

  it('creates a consent-bound PENDING TEST report and attributable events atomically', async () => {
    let reportId = '';
    mocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM worker_screening_consents')) {
        return { rows: [{
          id: consentId,
          worker_id: workerId,
          provider: LOCAL_CERTIFICATION_SCREENING_PROVIDER,
          disclosure_version: LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_VERSION,
          disclosure_hash: LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_HASH,
          revoked_at: null,
        }], rowCount: 1 };
      }
      if (sql.includes('FROM hxos_local_test_screening_reports') && sql.includes('idempotency_key')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM background_checks') && sql.includes("status IN ('PENDING'")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO background_checks')) {
        reportId = String(params?.[2]);
        return { rows: [{ id: backgroundCheckId, check_id: reportId, status: 'PENDING' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    const result = await LocalCertificationScreeningProvider.initiate({
      workerId,
      consentId,
      idempotencyKey: 'screening-init-0001',
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        backgroundCheckId,
        provider: LOCAL_CERTIFICATION_SCREENING_PROVIDER,
        status: 'PENDING',
        isTest: true,
        idempotencyReplayed: false,
      },
    });
    if (!result.success) throw new Error(result.error.message);
    expect(isLocalCertificationScreeningReportId(result.data.providerReportId)).toBe(true);
    const statements = mocks.query.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(statements).toContain("set_config('hustlexp.local_test_screening_enabled', 'true', true)");
    expect(statements).toContain('INSERT INTO hxos_local_test_screening_reports');
    expect(statements).toContain("'CHECK_INITIATED'");
  });

  it('fails closed without active provider-matched TEST consent', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM worker_screening_consents')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });

    await expect(LocalCertificationScreeningProvider.initiate({
      workerId,
      consentId,
      idempotencyKey: 'screening-init-0001',
    })).resolves.toMatchObject({
      success: false,
      error: { code: 'LOCAL_TEST_SCREENING_CONSENT_REQUIRED' },
    });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO background_checks'))).toBe(false);
  });

  it('moves the TEST provider report through processing and clear before recomputing capability', async () => {
    const reportId = `scr_hxos_test_${'b'.repeat(32)}`;
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM hxos_local_test_screening_reports report')) {
        return { rows: [{
          id: reportId,
          background_check_id: backgroundCheckId,
          worker_id: workerId,
          consent_id: consentId,
          report_status: 'PENDING',
          check_status: 'PENDING',
          is_test: true,
        }], rowCount: 1 };
      }
      if (sql.includes("SET status = 'CLEAR'")) {
        return { rows: [{ id: backgroundCheckId, status: 'CLEAR' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    const result = await LocalCertificationScreeningProvider.completeClear({
      backgroundCheckId,
      workerId,
      actorId: '84000000-0000-4000-8000-000000000005',
      idempotencyKey: 'screening-clear-0001',
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        backgroundCheckId,
        providerReportId: reportId,
        status: 'CLEAR',
        isTest: true,
        idempotencyReplayed: false,
      },
    });
    const statements = mocks.query.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(statements).toContain("SET status = 'PROCESSING'");
    expect(statements).toContain("SET status = 'CLEAR'");
    expect(statements).toContain("'CHECK_CLEARED'");
    expect(mocks.recompute).toHaveBeenCalledWith(workerId, {
      reason: 'local_test_background_check_cleared',
      sourceVerificationId: backgroundCheckId,
    });
  });
});
