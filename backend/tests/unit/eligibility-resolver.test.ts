/**
 * EligibilityResolverService Unit Tests
 *
 * PURE function engine — no DB, no side effects.
 * Covers all eligibility check paths (HX200–HX408) and batch helpers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger (EligibilityResolverService has a log.debug call)
vi.mock('../../src/logger', () => {
  const childFn = () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: childFn,
  });
  const mockLogger = {
    child: childFn,
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  };
  return { logger: mockLogger };
});

import {
  isEligible,
  isEligibleForTasks,
  filterEligibleTasks,
  getEligibilityExplanation,
  getRemediationSteps,
  type TaskRequirements,
  type EligibilityContext,
} from '../../src/services/EligibilityResolverService';
import EligibilityResolver from '../../src/services/EligibilityResolverService';
import type { CapabilityProfile } from '../../src/services/CapabilityProfileService';

// ============================================================================
// TEST FIXTURES
// ============================================================================

const FUTURE = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 1000).toISOString();

function makeProfile(overrides: Partial<CapabilityProfile> = {}): CapabilityProfile {
  return {
    userId: 'user-123',
    trustTier: 'B',
    riskClearance: ['low', 'medium'],
    locationState: 'CA',
    locationCity: 'Los Angeles',
    insuranceValid: true,
    insuranceExpiresAt: FUTURE,
    backgroundCheckValid: true,
    backgroundCheckExpiresAt: FUTURE,
    verifiedTrades: [
      {
        trade: 'plumbing',
        state: 'CA',
        expiresAt: FUTURE,
        licenseVerificationId: 'lic-001',
      },
    ],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeContext(overrides: Partial<EligibilityContext> = {}): EligibilityContext {
  return {
    userId: 'user-123',
    capabilityProfile: makeProfile(),
    activeTaskCount: 0,
    hasActiveDispute: false,
    accountAgeDays: 90,
    trustScore: 85,
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskRequirements> = {}): TaskRequirements {
  return {
    trade: 'plumbing',
    state: 'CA',
    riskLevel: 'low',
    insuranceRequired: false,
    backgroundCheckRequired: false,
    ...overrides,
  };
}

// ============================================================================
// HAPPY PATH
// ============================================================================

describe('isEligible — happy path', () => {
  it('returns HX200 when all requirements are met', () => {
    const result = isEligible(makeTask(), makeContext());
    expect(result.eligible).toBe(true);
    expect(result.code).toBe('HX200');
    expect(result.metadata.matchingTrades).toContain('plumbing');
    expect(result.metadata.riskMatch).toBe(true);
    expect(result.metadata.insuranceMatch).toBe(true);
    expect(result.metadata.backgroundCheckMatch).toBe(true);
  });

  it('includes human-readable success reason', () => {
    const result = isEligible(makeTask(), makeContext());
    expect(result.reasons).toContain('All eligibility requirements met');
  });

  it('confidence is high for a passing result', () => {
    const result = isEligible(makeTask(), makeContext());
    expect(result.confidence).toBe('high');
  });
});

// ============================================================================
// HX401 — Active dispute
// ============================================================================

describe('isEligible — HX401 active dispute', () => {
  it('blocks when hasActiveDispute is true', () => {
    const ctx = makeContext({ hasActiveDispute: true });
    const result = isEligible(makeTask(), ctx);
    expect(result.eligible).toBe(false);
    expect(result.code).toBe('HX401');
    expect(result.reasons[0]).toMatch(/dispute/i);
  });

  it('active dispute short-circuits all other checks', () => {
    // Even with no trade, dispute check fires first
    const ctx = makeContext({
      hasActiveDispute: true,
      capabilityProfile: makeProfile({ verifiedTrades: [] }),
    });
    const result = isEligible(makeTask(), ctx);
    expect(result.code).toBe('HX401');
  });
});

// ============================================================================
// HX402 — Task capacity
// ============================================================================

describe('isEligible — HX402 task capacity', () => {
  it('blocks at exactly 5 active tasks', () => {
    const ctx = makeContext({ activeTaskCount: 5 });
    const result = isEligible(makeTask(), ctx);
    expect(result.eligible).toBe(false);
    expect(result.code).toBe('HX402');
    expect(result.reasons[0]).toMatch(/5/);
  });

  it('blocks above 5 active tasks', () => {
    const ctx = makeContext({ activeTaskCount: 10 });
    const result = isEligible(makeTask(), ctx);
    expect(result.code).toBe('HX402');
  });

  it('does NOT block at 4 active tasks', () => {
    const ctx = makeContext({ activeTaskCount: 4 });
    const result = isEligible(makeTask(), ctx);
    expect(result.code).toBe('HX200');
  });
});

// ============================================================================
// HX403 — Trade valid, wrong state
// ============================================================================

describe('isEligible — HX403 trade in wrong state', () => {
  it('blocks when licensed elsewhere but not in task state', () => {
    const profile = makeProfile({
      verifiedTrades: [
        { trade: 'plumbing', state: 'TX', expiresAt: FUTURE, licenseVerificationId: 'lic-tx' },
      ],
    });
    const result = isEligible(makeTask({ state: 'CA' }), makeContext({ capabilityProfile: profile }));
    expect(result.eligible).toBe(false);
    expect(result.code).toBe('HX403');
    expect(result.reasons[0]).toMatch(/CA/i);
  });

  it('distinguishes HX403 from HX404 (has trade elsewhere vs no trade)', () => {
    const profile = makeProfile({
      verifiedTrades: [
        { trade: 'plumbing', state: 'NY', expiresAt: FUTURE, licenseVerificationId: 'lic-ny' },
      ],
    });
    const result = isEligible(makeTask({ state: 'CA' }), makeContext({ capabilityProfile: profile }));
    expect(result.code).toBe('HX403');
  });
});

// ============================================================================
// HX404 — No trade license
// ============================================================================

describe('isEligible — HX404 not licensed for trade', () => {
  it('blocks when user has no plumbing license at all', () => {
    const profile = makeProfile({ verifiedTrades: [] });
    const result = isEligible(makeTask({ trade: 'plumbing' }), makeContext({ capabilityProfile: profile }));
    expect(result.eligible).toBe(false);
    expect(result.code).toBe('HX404');
    expect(result.reasons[0]).toMatch(/plumbing/i);
  });

  it('blocks when user has a different trade', () => {
    const profile = makeProfile({
      verifiedTrades: [
        { trade: 'electrical', state: 'CA', expiresAt: FUTURE, licenseVerificationId: 'lic-elec' },
      ],
    });
    const result = isEligible(makeTask({ trade: 'plumbing' }), makeContext({ capabilityProfile: profile }));
    expect(result.code).toBe('HX404');
  });

  it('blocks when trade license is expired', () => {
    const profile = makeProfile({
      verifiedTrades: [
        { trade: 'plumbing', state: 'CA', expiresAt: PAST, licenseVerificationId: 'lic-expired' },
      ],
    });
    const result = isEligible(makeTask(), makeContext({ capabilityProfile: profile }));
    // Expired license is treated as missing — could be HX403 or HX404 depending
    // on whether user has another matching trade
    expect(result.eligible).toBe(false);
  });

  it('allows when trade has no expiry (null expiresAt)', () => {
    const profile = makeProfile({
      verifiedTrades: [
        { trade: 'plumbing', state: 'CA', expiresAt: null, licenseVerificationId: 'lic-no-exp' },
      ],
    });
    const result = isEligible(makeTask(), makeContext({ capabilityProfile: profile }));
    expect(result.code).toBe('HX200');
  });
});

// ============================================================================
// HX405 — Insufficient risk clearance
// ============================================================================

describe('isEligible — HX405 risk clearance', () => {
  it('blocks when task is high risk but user only has low/medium clearance', () => {
    const profile = makeProfile({ riskClearance: ['low', 'medium'] });
    const result = isEligible(makeTask({ riskLevel: 'high' }), makeContext({ capabilityProfile: profile }));
    expect(result.eligible).toBe(false);
    expect(result.code).toBe('HX405');
    expect(result.reasons[0]).toMatch(/high/i);
  });

  it('blocks for critical risk when user only has high clearance', () => {
    const profile = makeProfile({ riskClearance: ['low', 'medium', 'high'] });
    const result = isEligible(makeTask({ riskLevel: 'critical' }), makeContext({ capabilityProfile: profile }));
    expect(result.code).toBe('HX405');
  });

  it('passes when user has sufficient risk clearance', () => {
    const profile = makeProfile({ riskClearance: ['low', 'medium', 'high', 'critical'] });
    const result = isEligible(makeTask({ riskLevel: 'critical' }), makeContext({ capabilityProfile: profile }));
    expect(result.code).toBe('HX200');
  });

  it('passes when user clearance exactly matches task level', () => {
    const profile = makeProfile({ riskClearance: ['medium'] });
    const result = isEligible(makeTask({ riskLevel: 'medium' }), makeContext({ capabilityProfile: profile }));
    expect(result.code).toBe('HX200');
  });

  it('passes when user has higher clearance than required', () => {
    const profile = makeProfile({ riskClearance: ['high'] });
    const result = isEligible(makeTask({ riskLevel: 'low' }), makeContext({ capabilityProfile: profile }));
    expect(result.code).toBe('HX200');
  });

  it('blocks when riskClearance array is empty', () => {
    const profile = makeProfile({ riskClearance: [] });
    const result = isEligible(makeTask({ riskLevel: 'low' }), makeContext({ capabilityProfile: profile }));
    expect(result.code).toBe('HX405');
  });
});

// ============================================================================
// HX406 — Insurance
// ============================================================================

describe('isEligible — HX406 insurance', () => {
  it('blocks when insurance required but not valid', () => {
    const profile = makeProfile({ insuranceValid: false });
    const result = isEligible(
      makeTask({ insuranceRequired: true }),
      makeContext({ capabilityProfile: profile }),
    );
    expect(result.eligible).toBe(false);
    expect(result.code).toBe('HX406');
    expect(result.reasons[0]).toMatch(/insurance/i);
  });

  it('passes when insurance not required and user has none', () => {
    const profile = makeProfile({ insuranceValid: false });
    const result = isEligible(
      makeTask({ insuranceRequired: false }),
      makeContext({ capabilityProfile: profile }),
    );
    expect(result.code).toBe('HX200');
  });

  it('passes when insurance required and user has it', () => {
    const result = isEligible(
      makeTask({ insuranceRequired: true }),
      makeContext({ capabilityProfile: makeProfile({ insuranceValid: true }) }),
    );
    expect(result.code).toBe('HX200');
  });
});

// ============================================================================
// HX407 — Background check
// ============================================================================

describe('isEligible — HX407 background check', () => {
  it('blocks when background check required but not valid', () => {
    const profile = makeProfile({ backgroundCheckValid: false });
    const result = isEligible(
      makeTask({ backgroundCheckRequired: true }),
      makeContext({ capabilityProfile: profile }),
    );
    expect(result.eligible).toBe(false);
    expect(result.code).toBe('HX407');
    expect(result.reasons[0]).toMatch(/background/i);
  });

  it('passes when background check not required', () => {
    const profile = makeProfile({ backgroundCheckValid: false });
    const result = isEligible(
      makeTask({ backgroundCheckRequired: false }),
      makeContext({ capabilityProfile: profile }),
    );
    expect(result.code).toBe('HX200');
  });

  it('passes when background check required and valid', () => {
    const result = isEligible(
      makeTask({ backgroundCheckRequired: true }),
      makeContext({ capabilityProfile: makeProfile({ backgroundCheckValid: true }) }),
    );
    expect(result.code).toBe('HX200');
  });
});

// ============================================================================
// HX408 — Trust tier
// ============================================================================

describe('isEligible — HX408 trust tier', () => {
  it('blocks when user tier is below required minimum', () => {
    const profile = makeProfile({ trustTier: 'D' });
    const result = isEligible(
      makeTask({ minTrustTier: 'B' }),
      makeContext({ capabilityProfile: profile }),
    );
    expect(result.eligible).toBe(false);
    expect(result.code).toBe('HX408');
    expect(result.reasons[0]).toMatch(/trust tier/i);
  });

  it('blocks C tier when A required', () => {
    const profile = makeProfile({ trustTier: 'C' });
    const result = isEligible(
      makeTask({ minTrustTier: 'A' }),
      makeContext({ capabilityProfile: profile }),
    );
    expect(result.code).toBe('HX408');
  });

  it('passes when user tier exactly meets minimum', () => {
    const profile = makeProfile({ trustTier: 'B' });
    const result = isEligible(
      makeTask({ minTrustTier: 'B' }),
      makeContext({ capabilityProfile: profile }),
    );
    expect(result.code).toBe('HX200');
  });

  it('passes when user tier exceeds minimum', () => {
    const profile = makeProfile({ trustTier: 'A' });
    const result = isEligible(
      makeTask({ minTrustTier: 'C' }),
      makeContext({ capabilityProfile: profile }),
    );
    expect(result.code).toBe('HX200');
  });

  it('passes when no minTrustTier is specified', () => {
    const profile = makeProfile({ trustTier: 'D' }); // worst tier, but no min required
    const result = isEligible(
      makeTask({ minTrustTier: undefined }),
      makeContext({ capabilityProfile: profile }),
    );
    expect(result.code).toBe('HX200');
  });
});

// ============================================================================
// RISK_HIERARCHY constant (via default export)
// ============================================================================

describe('RISK_HIERARCHY', () => {
  it('is ordered low → medium → high → critical', () => {
    expect(EligibilityResolver.RISK_HIERARCHY).toEqual(['low', 'medium', 'high', 'critical']);
  });

  it('low has the smallest index', () => {
    expect(EligibilityResolver.RISK_HIERARCHY.indexOf('low')).toBe(0);
  });

  it('critical has the largest index', () => {
    expect(EligibilityResolver.RISK_HIERARCHY.indexOf('critical')).toBe(3);
  });
});

// ============================================================================
// BATCH OPERATIONS
// ============================================================================

describe('isEligibleForTasks', () => {
  it('returns a map keyed by trade:state', () => {
    const tasks: TaskRequirements[] = [
      makeTask({ trade: 'plumbing', state: 'CA' }),
      makeTask({ trade: 'electrical', state: 'CA' }),
    ];
    const map = isEligibleForTasks(tasks, makeContext());
    expect(map.has('plumbing:CA')).toBe(true);
    expect(map.has('electrical:CA')).toBe(true);
  });

  it('returns correct eligibility per task', () => {
    const profile = makeProfile({
      verifiedTrades: [
        { trade: 'plumbing', state: 'CA', expiresAt: FUTURE, licenseVerificationId: 'lic-1' },
      ],
    });
    const ctx = makeContext({ capabilityProfile: profile });
    const tasks: TaskRequirements[] = [
      makeTask({ trade: 'plumbing', state: 'CA' }),
      makeTask({ trade: 'electrical', state: 'CA' }),
    ];
    const map = isEligibleForTasks(tasks, ctx);
    expect(map.get('plumbing:CA')?.eligible).toBe(true);
    expect(map.get('electrical:CA')?.eligible).toBe(false);
  });

  it('handles empty task list', () => {
    const map = isEligibleForTasks([], makeContext());
    expect(map.size).toBe(0);
  });
});

describe('filterEligibleTasks', () => {
  it('returns only eligible tasks', () => {
    const profile = makeProfile({
      verifiedTrades: [
        { trade: 'plumbing', state: 'CA', expiresAt: FUTURE, licenseVerificationId: 'lic-1' },
      ],
    });
    const ctx = makeContext({ capabilityProfile: profile });
    const tasks: TaskRequirements[] = [
      makeTask({ trade: 'plumbing', state: 'CA' }),
      makeTask({ trade: 'electrical', state: 'CA' }),
      makeTask({ trade: 'plumbing', state: 'TX' }), // wrong state
    ];
    const eligible = filterEligibleTasks(tasks, ctx);
    expect(eligible).toHaveLength(1);
    expect(eligible[0].trade).toBe('plumbing');
    expect(eligible[0].state).toBe('CA');
  });

  it('returns empty array when none are eligible', () => {
    const ctx = makeContext({ hasActiveDispute: true });
    const tasks: TaskRequirements[] = [makeTask(), makeTask({ state: 'TX' })];
    const eligible = filterEligibleTasks(tasks, ctx);
    expect(eligible).toHaveLength(0);
  });

  it('returns all tasks when all are eligible', () => {
    const profile = makeProfile({
      riskClearance: ['low', 'medium', 'high', 'critical'],
      insuranceValid: true,
      backgroundCheckValid: true,
      verifiedTrades: [
        { trade: 'plumbing', state: 'CA', expiresAt: FUTURE, licenseVerificationId: 'lic-1' },
        { trade: 'electrical', state: 'CA', expiresAt: FUTURE, licenseVerificationId: 'lic-2' },
      ],
    });
    const ctx = makeContext({ capabilityProfile: profile });
    const tasks: TaskRequirements[] = [
      makeTask({ trade: 'plumbing', riskLevel: 'low' }),
      makeTask({ trade: 'electrical', riskLevel: 'medium' }),
    ];
    const eligible = filterEligibleTasks(tasks, ctx);
    expect(eligible).toHaveLength(2);
  });
});

// ============================================================================
// EXPLANATION HELPERS
// ============================================================================

describe('getEligibilityExplanation', () => {
  it('returns explanation for HX200', () => {
    expect(getEligibilityExplanation('HX200')).toMatch(/eligible/i);
  });

  it('returns explanation for HX401', () => {
    expect(getEligibilityExplanation('HX401')).toMatch(/dispute/i);
  });

  it('returns explanation for HX402', () => {
    expect(getEligibilityExplanation('HX402')).toMatch(/task/i);
  });

  it('returns explanation for HX403', () => {
    expect(getEligibilityExplanation('HX403')).toMatch(/state/i);
  });

  it('returns explanation for HX404', () => {
    expect(getEligibilityExplanation('HX404')).toMatch(/licensed/i);
  });

  it('returns explanation for HX405', () => {
    expect(getEligibilityExplanation('HX405')).toMatch(/risk/i);
  });

  it('returns explanation for HX406', () => {
    expect(getEligibilityExplanation('HX406')).toMatch(/insurance/i);
  });

  it('returns explanation for HX407', () => {
    expect(getEligibilityExplanation('HX407')).toMatch(/background/i);
  });

  it('returns explanation for HX408', () => {
    expect(getEligibilityExplanation('HX408')).toMatch(/trust/i);
  });

  it('returns fallback for unknown code', () => {
    const result = getEligibilityExplanation('HX999');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// REMEDIATION STEPS
// ============================================================================

describe('getRemediationSteps', () => {
  const cases: Array<{ code: string; keyword: RegExp }> = [
    { code: 'HX401', keyword: /dispute/i },
    { code: 'HX402', keyword: /task/i },
    { code: 'HX403', keyword: /license|state/i },
    { code: 'HX404', keyword: /verif|license|certif/i },
    { code: 'HX405', keyword: /training|risk|trust/i },
    { code: 'HX406', keyword: /insurance/i },
    { code: 'HX407', keyword: /background/i },
    { code: 'HX408', keyword: /tier|trust/i },
  ];

  for (const { code, keyword } of cases) {
    it(`returns actionable steps for ${code}`, () => {
      const ctx = makeContext();
      const result = { eligible: false, code, reasons: [], confidence: 'high' as const, metadata: { matchingTrades: [], riskMatch: false, insuranceMatch: false, backgroundCheckMatch: false } };
      const steps = getRemediationSteps(result);
      expect(steps.length).toBeGreaterThan(0);
      expect(steps.some(s => keyword.test(s))).toBe(true);
    });
  }

  it('returns empty array for unknown code', () => {
    const result = { eligible: false, code: 'HX999', reasons: [], confidence: 'high' as const, metadata: { matchingTrades: [], riskMatch: false, insuranceMatch: false, backgroundCheckMatch: false } };
    const steps = getRemediationSteps(result);
    expect(Array.isArray(steps)).toBe(true);
  });
});

// ============================================================================
// METADATA POPULATION
// ============================================================================

describe('metadata fields', () => {
  it('populates matchingTrades on success', () => {
    const result = isEligible(makeTask(), makeContext());
    expect(result.metadata.matchingTrades).toEqual(['plumbing']);
  });

  it('riskMatch is false when risk check fails', () => {
    const profile = makeProfile({ riskClearance: ['low'] });
    const result = isEligible(makeTask({ riskLevel: 'high' }), makeContext({ capabilityProfile: profile }));
    expect(result.metadata.riskMatch).toBe(false);
  });

  it('insuranceMatch is true when insurance not required', () => {
    const result = isEligible(makeTask({ insuranceRequired: false }), makeContext());
    expect(result.metadata.insuranceMatch).toBe(true);
  });

  it('backgroundCheckMatch is false when check required and missing', () => {
    const profile = makeProfile({ backgroundCheckValid: false });
    const result = isEligible(
      makeTask({ backgroundCheckRequired: true }),
      makeContext({ capabilityProfile: profile }),
    );
    expect(result.metadata.backgroundCheckMatch).toBe(false);
  });
});
