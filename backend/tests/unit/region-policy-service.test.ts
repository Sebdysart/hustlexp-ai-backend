import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

import { db } from '../../src/db';
import {
  evaluateTaskAgainstRegionPolicy,
  resolveRegionPolicy,
  type RegionPolicyRow,
} from '../../src/services/RegionPolicyService';

const POLICY: RegionPolicyRow = {
  id: '11111111-1111-4111-8111-111111111111',
  region_code: 'US-WA',
  version: 'us-wa-launch-2026-07-18-v1',
  policy_hash: 'a'.repeat(64),
  production_enabled: false,
  effective_from: '2026-07-18T00:00:00.000Z',
  effective_until: null,
  policy_document: {
    schemaVersion: 'hxos-region-policy-v1',
    categories: {
      moving: {
        allowedRiskLevels: ['LOW', 'MEDIUM'],
        credentials: { licenseRequired: false, insuranceRequired: false, backgroundCheckRequired: true },
        evidence: { proofRequired: true, minPhotos: 1, maxPhotos: 5, gpsRequired: false },
      },
      yard: {
        allowedRiskLevels: ['LOW'],
        credentials: { licenseRequired: false, insuranceRequired: false, backgroundCheckRequired: false },
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
    financial: { currency: 'usd', minimumCustomerCents: 5000, minimumPayoutCents: 4000, minimumMarginCents: 500 },
    safety: {
      incidentIntakeRequired: true,
      timedCheckinRiskLevels: ['MEDIUM', 'HIGH', 'IN_HOME'],
      checkinIntervalsMinutes: [15, 30, 60],
      locationRetentionDays: 30,
      alternateEmergencyActionRequired: true,
    },
  },
};

const TASK = {
  regionCode: 'US-WA',
  automationClassification: 'CONTROLLED_TEST' as const,
  category: 'moving',
  riskLevel: 'MEDIUM' as const,
  requiresProof: true,
  customerTotalCents: 7000,
  payoutCents: 6000,
  marginCents: 1000,
};

describe('RegionPolicyService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('binds every consequential policy domain into one immutable task snapshot', () => {
    const result = evaluateTaskAgainstRegionPolicy(POLICY, TASK);
    expect(result).toEqual({
      allowed: true,
      reasons: [],
      snapshot: expect.objectContaining({
        policyId: POLICY.id,
        policyVersion: POLICY.version,
        policyHash: POLICY.policy_hash,
        regionCode: 'US-WA',
        locationState: 'WA',
        licenseRequired: false,
        insuranceRequired: false,
        backgroundCheckRequired: true,
        proofRequired: true,
        proofMinPhotos: 1,
        proofMaxPhotos: 5,
        proofGpsRequired: false,
        recordingAllowed: false,
        recordingStandaloneConsentRequired: true,
        screeningStandaloneConsentRequired: true,
        screeningReportAccessRequired: true,
        screeningDisputeAndAppealRequired: true,
        screeningAdverseActionNoticeRequired: true,
        safetyIncidentIntakeRequired: true,
        safetyTimedCheckinRequired: true,
        safetyCheckinIntervalsMinutes: [15, 30, 60],
        safetyLocationRetentionDays: 30,
        safetyAlternateEmergencyActionRequired: true,
        currency: 'usd',
      }),
    });
  });

  it.each([
    ['test-only policy used for production', { automationClassification: 'PRODUCTION' as const }, 'production_policy_not_approved'],
    ['wrong region binding', { regionCode: 'US-OR' }, 'region_policy_mismatch'],
    ['unsupported category', { category: 'electrical' }, 'category_not_allowed'],
    ['unsupported risk', { riskLevel: 'HIGH' as const }, 'risk_level_not_allowed'],
    ['proof disabled against policy', { requiresProof: false }, 'proof_required'],
    ['customer price below floor', { customerTotalCents: 4999 }, 'customer_total_below_region_floor'],
    ['payout below floor', { payoutCents: 3999 }, 'payout_below_region_floor'],
    ['margin below floor', { marginCents: 499 }, 'margin_below_region_floor'],
  ])('fails closed for %s', (_label, overrides, expectedReason) => {
    const result = evaluateTaskAgainstRegionPolicy(POLICY, { ...TASK, ...overrides });
    expect(result.allowed).toBe(false);
    expect(result.snapshot).toBeNull();
    expect(result.reasons).toContain(expectedReason);
  });

  it('rejects malformed policy documents instead of inventing defaults', () => {
    const malformed = { ...POLICY, policy_document: { ...POLICY.policy_document, safety: null } as never };
    expect(evaluateTaskAgainstRegionPolicy(malformed, TASK)).toEqual({
      allowed: false,
      reasons: ['region_policy_invalid'],
      snapshot: null,
    });
  });

  it('resolves one effective active policy with database-clock boundaries', async () => {
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [POLICY], rowCount: 1 } as never);
    await expect(resolveRegionPolicy('US-WA')).resolves.toEqual(POLICY);
    const [sql, values] = vi.mocked(db.query).mock.calls[0];
    expect(sql).toContain("policy_state = 'ACTIVE'");
    expect(sql).toContain('clock_timestamp()');
    expect(values).toEqual(['US-WA']);
  });

  it('returns null when no effective policy exists', async () => {
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    await expect(resolveRegionPolicy('US-WA')).resolves.toBeNull();
  });
});
