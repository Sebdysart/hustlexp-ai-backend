/**
 * EligibilityResolverService — Pure Eligibility Logic
 *
 * All functions under test are pure (no DB, no async, no mocks needed).
 * This suite exhaustively covers the eligibility check pipeline used by
 * FeedQueryService (SQL WHERE clause equivalent) and the apply endpoint.
 *
 * Coverage targets:
 *   - checkLocationMatch
 *   - checkRiskClearance
 *   - checkTradeVerified
 *   - checkTrustTier
 *   - checkInsurance
 *   - checkBackgroundCheck
 *   - checkTaskOpen
 *   - isEligible (composite — each failure path)
 *   - isEligibleBoolean
 *   - checkBatchEligibility
 *   - getEligibilityWhereClause
 *   - explainEligibility
 */

import { describe, it, expect } from 'vitest';
import type { CapabilityProfile, VerifiedTrade } from '../services/CapabilityProfileService.js';
import type { TaskRequirements } from '../services/EligibilityResolverService.js';
import {
  checkLocationMatch,
  checkRiskClearance,
  checkTradeVerified,
  checkTrustTier,
  checkInsurance,
  checkBackgroundCheck,
  checkTaskOpen,
  isEligible,
  isEligibleBoolean,
  checkBatchEligibility,
  getEligibilityWhereClause,
  explainEligibility,
} from '../services/EligibilityResolverService.js';

// ============================================================================
// TEST FIXTURES
// ============================================================================

function makeProfile(overrides: Partial<CapabilityProfile> = {}): CapabilityProfile {
  return {
    id: 'cp-001',
    userId: 'user-001',
    locationState: 'CA',
    riskClearance: ['low', 'medium'],
    trustTier: 2,
    insuranceValid: false,
    backgroundCheckValid: false,
    licenseVerified: false,
    identityVerified: false,
    stripeAccountId: null,
    stripeOnboardingComplete: false,
    activeTasks: 0,
    completedTasks: 0,
    successRate: 0,
    reputationScore: 0,
    totalEarnings: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as CapabilityProfile;
}

function makeTask(overrides: Partial<TaskRequirements> = {}): TaskRequirements {
  return {
    taskId: 'task-001',
    locationState: 'CA',
    riskLevel: 'low',
    requiredTrade: null,
    requiredTrustTier: 1,
    insuranceRequired: false,
    backgroundCheckRequired: false,
    status: 'OPEN',
    ...overrides,
  };
}

function makeTrades(...tradeNames: string[]): VerifiedTrade[] {
  return tradeNames.map((trade, i) => ({
    id: `vt-${i}`,
    userId: 'user-001',
    trade,
    verifiedAt: new Date(),
    expiresAt: null,
    createdAt: new Date(),
  } as VerifiedTrade));
}

// ============================================================================
// checkLocationMatch
// ============================================================================

describe('checkLocationMatch', () => {
  it('returns true when states match', () => {
    expect(checkLocationMatch('CA', 'CA')).toBe(true);
  });

  it('returns false when states differ', () => {
    expect(checkLocationMatch('CA', 'NY')).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(checkLocationMatch('ca', 'CA')).toBe(false);
  });

  it('returns false for empty vs non-empty', () => {
    expect(checkLocationMatch('', 'CA')).toBe(false);
  });
});

// ============================================================================
// checkRiskClearance
// ============================================================================

describe('checkRiskClearance', () => {
  it('returns true when clearance includes the task risk level', () => {
    expect(checkRiskClearance(['low', 'medium'], 'low')).toBe(true);
    expect(checkRiskClearance(['low', 'medium'], 'medium')).toBe(true);
  });

  it('returns false when task risk exceeds clearance', () => {
    expect(checkRiskClearance(['low'], 'medium')).toBe(false);
    expect(checkRiskClearance(['low', 'medium'], 'high')).toBe(false);
    expect(checkRiskClearance(['low', 'medium', 'high'], 'critical')).toBe(false);
  });

  it('returns true for exact match at highest level', () => {
    expect(checkRiskClearance(['critical'], 'critical')).toBe(true);
  });

  it('returns true for high-clearance user accessing low-risk task', () => {
    expect(checkRiskClearance(['high', 'critical'], 'low')).toBe(true);
  });

  it('returns false for empty clearance array', () => {
    expect(checkRiskClearance([], 'low')).toBe(false);
  });

  it('full clearance allows all risk levels', () => {
    const full: ReturnType<typeof checkRiskClearance>[] = (['low', 'medium', 'high', 'critical'] as const).map(
      level => checkRiskClearance(['low', 'medium', 'high', 'critical'], level)
    );
    expect(full).toEqual([true, true, true, true]);
  });
});

// ============================================================================
// checkTradeVerified
// ============================================================================

describe('checkTradeVerified', () => {
  it('returns true when no trade is required', () => {
    expect(checkTradeVerified([], null)).toBe(true);
    expect(checkTradeVerified(makeTrades('plumbing'), null)).toBe(true);
  });

  it('returns true when user has the required trade', () => {
    expect(checkTradeVerified(makeTrades('plumbing', 'electrical'), 'plumbing')).toBe(true);
  });

  it('returns false when user does not have the required trade', () => {
    expect(checkTradeVerified(makeTrades('plumbing'), 'electrical')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(checkTradeVerified(makeTrades('PLUMBING'), 'plumbing')).toBe(true);
    expect(checkTradeVerified(makeTrades('plumbing'), 'PLUMBING')).toBe(true);
  });

  it('returns false when user has no verified trades but trade is required', () => {
    expect(checkTradeVerified([], 'plumbing')).toBe(false);
  });
});

// ============================================================================
// checkTrustTier
// ============================================================================

describe('checkTrustTier', () => {
  it('returns true when user tier equals required tier', () => {
    expect(checkTrustTier(2, 2)).toBe(true);
  });

  it('returns true when user tier exceeds required tier', () => {
    expect(checkTrustTier(3, 1)).toBe(true);
    expect(checkTrustTier(5, 1)).toBe(true);
  });

  it('returns false when user tier is below required tier', () => {
    expect(checkTrustTier(1, 2)).toBe(false);
    expect(checkTrustTier(2, 3)).toBe(false);
  });

  it('returns true when both are tier 1', () => {
    expect(checkTrustTier(1, 1)).toBe(true);
  });
});

// ============================================================================
// checkInsurance
// ============================================================================

describe('checkInsurance', () => {
  it('returns true when insurance is not required', () => {
    expect(checkInsurance(false, false)).toBe(true);
    expect(checkInsurance(true, false)).toBe(true);
  });

  it('returns true when insurance is required and user has it', () => {
    expect(checkInsurance(true, true)).toBe(true);
  });

  it('returns false when insurance is required but user does not have it', () => {
    expect(checkInsurance(false, true)).toBe(false);
  });
});

// ============================================================================
// checkBackgroundCheck
// ============================================================================

describe('checkBackgroundCheck', () => {
  it('returns true when background check is not required', () => {
    expect(checkBackgroundCheck(false, false)).toBe(true);
    expect(checkBackgroundCheck(true, false)).toBe(true);
  });

  it('returns true when background check is required and user has it', () => {
    expect(checkBackgroundCheck(true, true)).toBe(true);
  });

  it('returns false when background check is required but user does not have it', () => {
    expect(checkBackgroundCheck(false, true)).toBe(false);
  });
});

// ============================================================================
// checkTaskOpen
// ============================================================================

describe('checkTaskOpen', () => {
  it('returns true for OPEN status', () => {
    expect(checkTaskOpen('OPEN')).toBe(true);
  });

  it('returns true for lowercase open status', () => {
    expect(checkTaskOpen('open')).toBe(true);
  });

  it('returns false for non-open statuses', () => {
    expect(checkTaskOpen('CLOSED')).toBe(false);
    expect(checkTaskOpen('COMPLETED')).toBe(false);
    expect(checkTaskOpen('CANCELLED')).toBe(false);
    expect(checkTaskOpen('IN_PROGRESS')).toBe(false);
    expect(checkTaskOpen('')).toBe(false);
  });
});

// ============================================================================
// isEligible — composite
// ============================================================================

describe('isEligible', () => {
  const eligibleProfile = makeProfile({
    locationState: 'CA',
    riskClearance: ['low', 'medium'],
    trustTier: 2,
    insuranceValid: true,
    backgroundCheckValid: true,
  });

  const eligibleTask = makeTask();
  const noTrades: VerifiedTrade[] = [];

  it('returns eligible=true when all checks pass', () => {
    const result = isEligible(eligibleProfile, noTrades, eligibleTask);
    expect(result.eligible).toBe(true);
    expect(result.reasons).toHaveLength(0);
    expect(result.checks.locationMatch).toBe(true);
    expect(result.checks.riskClearance).toBe(true);
    expect(result.checks.tradeVerified).toBe(true);
    expect(result.checks.trustTier).toBe(true);
    expect(result.checks.insurance).toBe(true);
    expect(result.checks.backgroundCheck).toBe(true);
    expect(result.checks.taskOpen).toBe(true);
  });

  it('fails on location mismatch', () => {
    const task = makeTask({ locationState: 'NY' });
    const result = isEligible(eligibleProfile, noTrades, task);
    expect(result.eligible).toBe(false);
    expect(result.checks.locationMatch).toBe(false);
    expect(result.reasons.some(r => r.includes('Location mismatch'))).toBe(true);
  });

  it('fails on insufficient risk clearance', () => {
    const task = makeTask({ riskLevel: 'critical' });
    const result = isEligible(eligibleProfile, noTrades, task);
    expect(result.eligible).toBe(false);
    expect(result.checks.riskClearance).toBe(false);
    expect(result.reasons.some(r => r.includes('risk clearance'))).toBe(true);
  });

  it('fails when required trade not verified', () => {
    const task = makeTask({ requiredTrade: 'plumbing' });
    const result = isEligible(eligibleProfile, noTrades, task);
    expect(result.eligible).toBe(false);
    expect(result.checks.tradeVerified).toBe(false);
    expect(result.reasons.some(r => r.includes('Trade not verified'))).toBe(true);
  });

  it('passes when required trade is verified', () => {
    const task = makeTask({ requiredTrade: 'plumbing' });
    const result = isEligible(eligibleProfile, makeTrades('plumbing'), task);
    expect(result.checks.tradeVerified).toBe(true);
    expect(result.eligible).toBe(true);
  });

  it('fails on insufficient trust tier', () => {
    const task = makeTask({ requiredTrustTier: 5 });
    const result = isEligible(eligibleProfile, noTrades, task);
    expect(result.eligible).toBe(false);
    expect(result.checks.trustTier).toBe(false);
    expect(result.reasons.some(r => r.includes('trust tier'))).toBe(true);
  });

  it('fails on missing insurance', () => {
    const profile = makeProfile({ ...eligibleProfile, insuranceValid: false });
    const task = makeTask({ insuranceRequired: true });
    const result = isEligible(profile, noTrades, task);
    expect(result.eligible).toBe(false);
    expect(result.checks.insurance).toBe(false);
    expect(result.reasons.some(r => r.includes('insurance'))).toBe(true);
  });

  it('fails on missing background check', () => {
    const profile = makeProfile({ ...eligibleProfile, backgroundCheckValid: false });
    const task = makeTask({ backgroundCheckRequired: true });
    const result = isEligible(profile, noTrades, task);
    expect(result.eligible).toBe(false);
    expect(result.checks.backgroundCheck).toBe(false);
    expect(result.reasons.some(r => r.includes('background check'))).toBe(true);
  });

  it('fails on closed task', () => {
    const task = makeTask({ status: 'COMPLETED' });
    const result = isEligible(eligibleProfile, noTrades, task);
    expect(result.eligible).toBe(false);
    expect(result.checks.taskOpen).toBe(false);
    expect(result.reasons.some(r => r.includes('Task not open'))).toBe(true);
  });

  it('accumulates multiple failure reasons', () => {
    const badProfile = makeProfile({
      locationState: 'NY',
      riskClearance: ['low'],
      trustTier: 1,
    });
    const task = makeTask({
      locationState: 'CA',
      riskLevel: 'critical',
      requiredTrustTier: 3,
      insuranceRequired: true,
      backgroundCheckRequired: true,
      status: 'CLOSED',
    });
    const result = isEligible(badProfile, noTrades, task);
    expect(result.eligible).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(1);
  });
});

// ============================================================================
// isEligibleBoolean
// ============================================================================

describe('isEligibleBoolean', () => {
  it('returns true for eligible user', () => {
    const profile = makeProfile({
      locationState: 'CA',
      riskClearance: ['low', 'medium'],
      trustTier: 2,
      insuranceValid: true,
      backgroundCheckValid: true,
    });
    expect(isEligibleBoolean(profile, [], makeTask())).toBe(true);
  });

  it('returns false for ineligible user', () => {
    const profile = makeProfile({ locationState: 'TX' });
    expect(isEligibleBoolean(profile, [], makeTask({ locationState: 'CA' }))).toBe(false);
  });
});

// ============================================================================
// checkBatchEligibility
// ============================================================================

describe('checkBatchEligibility', () => {
  const profile = makeProfile({
    locationState: 'CA',
    riskClearance: ['low', 'medium'],
    trustTier: 2,
    insuranceValid: true,
    backgroundCheckValid: true,
  });

  it('returns a map of taskId to eligibility results', () => {
    const tasks = [
      makeTask({ taskId: 'task-1', locationState: 'CA' }),
      makeTask({ taskId: 'task-2', locationState: 'NY' }),
    ];
    const results = checkBatchEligibility(profile, [], tasks);
    expect(results.size).toBe(2);
    expect(results.get('task-1')?.eligible).toBe(true);
    expect(results.get('task-2')?.eligible).toBe(false);
  });

  it('returns empty map for empty task list', () => {
    const results = checkBatchEligibility(profile, [], []);
    expect(results.size).toBe(0);
  });

  it('handles single task', () => {
    const results = checkBatchEligibility(profile, [], [makeTask({ taskId: 'only' })]);
    expect(results.size).toBe(1);
    expect(results.get('only')?.eligible).toBe(true);
  });
});

// ============================================================================
// getEligibilityWhereClause
// ============================================================================

describe('getEligibilityWhereClause', () => {
  it('returns a SQL string containing the userId', () => {
    const sql = getEligibilityWhereClause('user-xyz');
    expect(typeof sql).toBe('string');
    expect(sql).toContain('user-xyz');
  });

  it('contains location_state condition', () => {
    const sql = getEligibilityWhereClause('u1');
    expect(sql).toContain('location_state');
  });

  it('contains risk_clearance condition', () => {
    const sql = getEligibilityWhereClause('u1');
    expect(sql).toContain('risk_clearance');
  });

  it('contains trust_tier condition', () => {
    const sql = getEligibilityWhereClause('u1');
    expect(sql).toContain('trust_tier');
  });

  it('contains insurance_required condition', () => {
    const sql = getEligibilityWhereClause('u1');
    expect(sql).toContain('insurance_required');
  });

  it("contains state = 'OPEN' condition", () => {
    const sql = getEligibilityWhereClause('u1');
    expect(sql).toContain("'OPEN'");
  });
});

// ============================================================================
// explainEligibility
// ============================================================================

describe('explainEligibility', () => {
  const eligibleProfile = makeProfile({
    locationState: 'CA',
    riskClearance: ['low', 'medium'],
    trustTier: 2,
    insuranceValid: true,
    backgroundCheckValid: true,
  });

  it('returns eligible=true with positive summary for eligible user', () => {
    const result = explainEligibility(eligibleProfile, [], makeTask());
    expect(result.eligible).toBe(true);
    expect(result.summary).toContain('eligible');
    expect(result.requirements).toHaveLength(6);
  });

  it('returns eligible=false with reason in summary for ineligible user', () => {
    const profile = makeProfile({ locationState: 'TX' });
    const result = explainEligibility(profile, [], makeTask({ locationState: 'CA' }));
    expect(result.eligible).toBe(false);
    expect(result.summary).toContain("not eligible");
    expect(result.requirements.find(r => r.name === 'Location')?.met).toBe(false);
  });

  it('all 6 requirement names are present', () => {
    const result = explainEligibility(eligibleProfile, [], makeTask());
    const names = result.requirements.map(r => r.name);
    expect(names).toContain('Location');
    expect(names).toContain('Risk Level');
    expect(names).toContain('Trade Verification');
    expect(names).toContain('Trust Tier');
    expect(names).toContain('Insurance');
    expect(names).toContain('Background Check');
  });

  it('includes actual trade names when trades are verified', () => {
    const result = explainEligibility(
      eligibleProfile,
      makeTrades('plumbing', 'electrical'),
      makeTask()
    );
    const tradReq = result.requirements.find(r => r.name === 'Trade Verification');
    expect(tradReq?.actual).toContain('plumbing');
    expect(tradReq?.actual).toContain('electrical');
  });

  it('shows "None" when no trades verified', () => {
    const result = explainEligibility(eligibleProfile, [], makeTask());
    const tradReq = result.requirements.find(r => r.name === 'Trade Verification');
    expect(tradReq?.actual).toContain('None');
  });

  it('correctly reflects insurance requirement state', () => {
    const taskWithInsurance = makeTask({ insuranceRequired: true });
    const result = explainEligibility(eligibleProfile, [], taskWithInsurance);
    const insReq = result.requirements.find(r => r.name === 'Insurance');
    expect(insReq?.met).toBe(true);
    expect(insReq?.required).toContain('required');
  });
});
