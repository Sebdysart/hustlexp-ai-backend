import { describe, expect, it } from 'vitest';
import {
  canDecideBusinessApproval,
  evaluateBusinessSpend,
  evaluateServiceProfileReadiness,
} from '../../src/services/BusinessOperationsPolicy.js';

const BUDGET = {
  amountCents: 8_000,
  monthSpendCents: 20_000,
  perTaskCapCents: 20_000,
  monthlyCapCents: 100_000,
  autoApproveLimitCents: 10_000,
  poRequired: true,
  poNumber: 'PO-1042',
  costCenterRequired: true,
  costCenter: 'FACILITIES',
};

const READY_PROVIDER = {
  providerEnabled: true,
  verificationStatus: 'VERIFIED' as const,
  payoutStatus: 'ACTIVE' as const,
  coveragePostalCodes: ['98004', '98052'],
  weeklyCapacitySlots: 12,
  eligibleCrewCount: 2,
  pricingMode: 'INSTANT_CORRIDOR' as const,
  corridorMinimumCents: 9_000,
  corridorMaximumCents: 14_000,
  proofChecklist: ['Complete service checklist', 'Upload final proof'],
  credentialRequirementsMet: true,
};

describe('business operations deterministic policy', () => {
  it('auto-approves a compliant request under the policy threshold', () => {
    expect(evaluateBusinessSpend(BUDGET)).toEqual({
      outcome: 'AUTO_APPROVED', projectedMonthSpendCents: 28_000, blockers: [],
    });
  });

  it('escalates a compliant request above the auto-approval threshold', () => {
    expect(evaluateBusinessSpend({ ...BUDGET, amountCents: 12_000 })).toMatchObject({
      outcome: 'PENDING_APPROVAL', projectedMonthSpendCents: 32_000, blockers: [],
    });
  });

  it('hard-blocks task caps, monthly caps, and missing purchase controls', () => {
    expect(evaluateBusinessSpend({ ...BUDGET, amountCents: 25_000 })).toMatchObject({
      outcome: 'BLOCKED', blockers: ['PER_TASK_CAP_EXCEEDED'],
    });
    expect(evaluateBusinessSpend({ ...BUDGET, amountCents: 15_000, monthSpendCents: 90_000 })).toMatchObject({
      outcome: 'BLOCKED', blockers: ['MONTHLY_CAP_EXCEEDED'],
    });
    expect(evaluateBusinessSpend({ ...BUDGET, poNumber: '', costCenter: '' })).toMatchObject({
      outcome: 'BLOCKED', blockers: ['PURCHASE_ORDER_REQUIRED', 'COST_CENTER_REQUIRED'],
    });
  });

  it('requires a separate actor with approval authority', () => {
    expect(canDecideBusinessApproval('approver-1', 'requester-1', 'APPROVER')).toBe(true);
    expect(canDecideBusinessApproval('requester-1', 'requester-1', 'OWNER')).toBe(false);
    expect(canDecideBusinessApproval('viewer-1', 'requester-1', 'VIEWER')).toBe(false);
  });

  it('activates provider supply only when every readiness condition passes', () => {
    expect(evaluateServiceProfileReadiness(READY_PROVIDER)).toEqual({ ready: true, blockers: [] });
  });

  it('enumerates provider blockers without silently weakening the gate', () => {
    expect(evaluateServiceProfileReadiness({
      ...READY_PROVIDER,
      providerEnabled: false,
      verificationStatus: 'PENDING',
      payoutStatus: 'NOT_STARTED',
      coveragePostalCodes: [],
      weeklyCapacitySlots: 0,
      eligibleCrewCount: 0,
      corridorMinimumCents: 15_000,
      corridorMaximumCents: 10_000,
      proofChecklist: [],
      credentialRequirementsMet: false,
    })).toEqual({
      ready: false,
      blockers: [
        'PROVIDER_MODE_DISABLED', 'LEGAL_ENTITY_NOT_VERIFIED', 'PAYOUT_NOT_ACTIVE',
        'COVERAGE_REQUIRED', 'CAPACITY_REQUIRED', 'ELIGIBLE_CREW_REQUIRED',
        'INVALID_PRICE_CORRIDOR', 'PROOF_RECIPE_REQUIRED', 'CREDENTIALS_NOT_MET',
      ],
    });
  });

  it('allows quote-required pricing without inventing a fixed corridor', () => {
    expect(evaluateServiceProfileReadiness({
      ...READY_PROVIDER,
      pricingMode: 'QUOTE_REQUIRED',
      corridorMinimumCents: null,
      corridorMaximumCents: null,
    })).toEqual({ ready: true, blockers: [] });
  });
});
