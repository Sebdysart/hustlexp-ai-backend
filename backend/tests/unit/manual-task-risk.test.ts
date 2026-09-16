import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

import {
  deriveManualTaskRisk,
} from '../../src/services/ManualTaskRisk';
import {
  buildManualTaskPolicyInput,
} from '../../src/services/ManualTaskPolicy';
import {
  evaluateTaskAgainstRegionPolicy,
  type RegionPolicyRow,
} from '../../src/services/RegionPolicyService';

const CLEANING_POLICY: RegionPolicyRow = {
  id: '11111111-1111-4111-8111-111111111111',
  region_code: 'US-WA',
  version: 'cleaning-risk-regression-v1',
  policy_hash: 'a'.repeat(64),
  production_enabled: false,
  effective_from: '2026-09-01T00:00:00.000Z',
  effective_until: null,
  policy_document: {
    schemaVersion: 'hxos-region-policy-v1',
    categories: {
      cleaning: {
        allowedRiskLevels: ['LOW', 'MEDIUM'],
        credentials: {
          licenseRequired: false,
          insuranceRequired: false,
          backgroundCheckRequired: false,
        },
        evidence: {
          proofRequired: true,
          minPhotos: 1,
          maxPhotos: 5,
          gpsRequired: false,
        },
      },
    },
    recording: { allowed: false, standaloneConsentRequired: true },
    workerRights: {
      standaloneScreeningConsentRequired: true,
      reportAccessRequired: true,
      disputeAndAppealRequired: true,
      adverseActionNoticeRequired: true,
    },
    financial: {
      currency: 'usd',
      minimumCustomerCents: 5000,
      minimumPayoutCents: 4000,
      minimumMarginCents: 500,
    },
    safety: {
      incidentIntakeRequired: true,
      timedCheckinRiskLevels: ['MEDIUM', 'HIGH', 'IN_HOME'],
      checkinIntervalsMinutes: [15, 30, 60],
      locationRetentionDays: 30,
      alternateEmergencyActionRequired: true,
    },
  },
};

function evaluateCleaning(description: string) {
  const riskLevel = deriveManualTaskRisk(description, { category: 'cleaning' });
  const evaluation = evaluateTaskAgainstRegionPolicy(
    CLEANING_POLICY,
    buildManualTaskPolicyInput({
      regionCode: 'US-WA',
      category: 'cleaning',
      riskLevel,
    }),
    {
      evaluateEconomics: false,
      evaluateProductionGates: false,
    },
  );

  return { riskLevel, evaluation };
}

describe('manual cleaning risk', () => {
  it.each([
    'Clean my two-bedroom apartment.',
    'Deep clean the kitchen and both bathrooms.',
    'Give my home a complete deep clean.',
    'Move-out cleaning for an empty apartment.',
  ])('keeps ordinary indoor cleaning in the permitted MEDIUM lane: %s', (description) => {
    const result = evaluateCleaning(description);

    expect(result.riskLevel).toBe('MEDIUM');
    expect(result.evaluation.allowed).toBe(true);
    expect(result.evaluation.reasons).toEqual([]);
  });

  it.each([
    'Remove mold from the bedroom walls.',
    'Clean up blood and bodily fluids from the floor.',
    'Biohazard cleanup is needed in the basement.',
    'Clean a hazardous chemical spill in the garage.',
  ])('keeps hazardous cleaning HIGH and rejected by cleaning policy: %s', (description) => {
    const result = evaluateCleaning(description);

    expect(result.riskLevel).toBe('HIGH');
    expect(result.evaluation.allowed).toBe(false);
    expect(result.evaluation.reasons).toContain('risk_level_not_allowed');
  });
});
