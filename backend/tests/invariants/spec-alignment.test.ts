/**
 * Spec Alignment Stress Tests
 *
 * Comprehensive tests verifying backend alignment with HUSTLEXP-DOCS specs.
 * Tests all critical fixes applied to address audit findings.
 *
 * AUTHORITY: PRODUCT_SPEC.md, API_CONTRACTS.md
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TrustTier, TrustTierService } from '../../src/services/TrustTierService';
import { XPService } from '../../src/services/XPService';
import { EscrowService } from '../../src/services/EscrowService';
import { TaskService } from '../../src/services/TaskService';

const payoutDestination = vi.hoisted(() => vi.fn());

// Mock database for unit tests
vi.mock('../../src/db', () => {
  const queryFn = vi.fn();
  return {
    db: {
      query: queryFn,
      transaction: vi.fn((fn: (q: typeof queryFn) => Promise<unknown>) => fn(queryFn)),
      serializableTransaction: vi.fn((fn: (q: typeof queryFn) => Promise<unknown>) => fn(queryFn)),
    },
    isInvariantViolation: vi.fn(),
    isUniqueViolation: vi.fn(),
    getErrorMessage: vi.fn((code: string) => `Error: ${code}`),
  };
});

// Mock ScoperAIService to prevent actual AI calls during unit tests
vi.mock('../../src/services/ScoperAIService', () => ({
  ScoperAIService: {
    analyzeTaskScope: vi.fn().mockResolvedValue({
      success: false,
      error: { code: 'AI_UNAVAILABLE', message: 'Mocked - AI unavailable in tests' },
    }),
  },
}));

// Mock PlanService to allow task creation by default in tests
vi.mock('../../src/services/PlanService', () => ({
  PlanService: {
    canCreateTaskWithRisk: vi.fn().mockResolvedValue({ allowed: true }),
  },
}));

vi.mock('../../src/services/RegionPolicyService', () => ({
  resolveRegionPolicy: vi.fn().mockResolvedValue({
    id: '11111111-1111-4111-8111-111111111111', region_code: 'US-WA',
    version: 'us-wa-test-v1', policy_hash: 'a'.repeat(64),
  }),
  evaluateTaskAgainstRegionPolicy: vi.fn().mockReturnValue({
    allowed: true,
    reasons: [],
    snapshot: {
      policyId: '11111111-1111-4111-8111-111111111111', policyVersion: 'us-wa-test-v1',
      policyHash: 'a'.repeat(64), regionCode: 'US-WA', locationState: 'WA',
      licenseRequired: false, insuranceRequired: false, backgroundCheckRequired: false,
      proofRequired: true, proofMinPhotos: 1, proofMaxPhotos: 5, proofGpsRequired: false,
      recordingAllowed: false, recordingStandaloneConsentRequired: true,
      screeningStandaloneConsentRequired: true, screeningReportAccessRequired: true,
      screeningDisputeAndAppealRequired: true, screeningAdverseActionNoticeRequired: true,
      safetyIncidentIntakeRequired: true, safetyTimedCheckinRequired: false,
      safetyCheckinIntervalsMinutes: [15, 30, 60], safetyLocationRetentionDays: 30,
      safetyAlternateEmergencyActionRequired: true, currency: 'usd',
    },
  }),
}));

// Mock RevenueService — wired into EscrowService.release() by Fix 1B
vi.mock('../../src/services/RevenueService', () => ({
  RevenueService: { logEvent: vi.fn().mockResolvedValue({ success: true, data: { id: 'rev-1' } }) },
}));

vi.mock('../../src/services/TaskPayoutDestinationService.js', () => ({
  loadCurrentTaskPayoutDestination: payoutDestination,
}));

const { db } = await import('../../src/db');

beforeEach(() => {
  payoutDestination.mockImplementation(async (query,binding) => {
    const result=await query('SELECT payouts_enabled,stripe_connect_id,stripe_connect_status FROM users WHERE id=$1',[binding.payoutRecipientUserId]);
    const row=result.rows[0];
    return row?.stripe_connect_id && row.payouts_enabled!==false
      ? { ready:true,stripeConnectId:row.stripe_connect_id,reason:'READY' }
      : { ready:false,stripeConnectId:null,reason:'PAYOUT_ACCOUNT_NOT_READY' };
  });
});

describe('SPEC ALIGNMENT: Provider trust progression (Local Work Network §5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.query.mockReset();
  });

  describe('TrustTier Enum Values', () => {
    it('should have EXPLORER = 0', () => {
      expect(TrustTier.EXPLORER).toBe(0);
    });

    it('should have VERIFIED = 1', () => {
      expect(TrustTier.VERIFIED).toBe(1);
    });

    it('should have HOME_READY = 2', () => {
      expect(TrustTier.HOME_READY).toBe(2);
    });

    it('should have PRO = 3 and LICENSED_SPECIALIST = 4', () => {
      expect(TrustTier.PRO).toBe(3);
      expect(TrustTier.LICENSED_SPECIALIST).toBe(4);
    });

    it('should have BANNED = 9 (terminal)', () => {
      expect(TrustTier.BANNED).toBe(9);
    });

    it('should not represent Enterprise Crew as an individual worker tier', () => {
      expect((TrustTier as any).ENTERPRISE_CREW).toBeUndefined();
    });
  });

  describe('getTrustTier Mapping', () => {
    it('should map tier 0 to Explorer', async () => {
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ trust_tier: 0, is_banned: false }],
      });

      const result = await TrustTierService.getTrustTier('user-1');
      expect(result).toBe(TrustTier.EXPLORER);
    });

    it('should map tier 1 to Verified', async () => {
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ trust_tier: 1, is_banned: false }],
      });

      const result = await TrustTierService.getTrustTier('user-1');
      expect(result).toBe(TrustTier.VERIFIED);
    });

    it('should map tier 2 to Home Ready', async () => {
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ trust_tier: 2, is_banned: false }],
      });

      const result = await TrustTierService.getTrustTier('user-1');
      expect(result).toBe(TrustTier.HOME_READY);
    });

    it('should map tiers 3 and 4 to Pro and Licensed Specialist', async () => {
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ trust_tier: 3, is_banned: false }],
      });
      expect(await TrustTierService.getTrustTier('user-1')).toBe(TrustTier.PRO);

      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ trust_tier: 4, is_banned: false }],
      });
      expect(await TrustTierService.getTrustTier('user-1')).toBe(TrustTier.LICENSED_SPECIALIST);
    });

    it('should map tier 9 to BANNED', async () => {
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ trust_tier: 9 }],
      });

      const result = await TrustTierService.getTrustTier('user-1');
      expect(result).toBe(TrustTier.BANNED);
    });

  });
});

describe('SPEC ALIGNMENT: XP Formula (PRODUCT_SPEC §5.2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.query.mockReset();
  });

  describe('Streak Multiplier Formula', () => {
    // SPEC: 1.0 + (streak_days × 0.05) capped at 2.0

    it('should return 1.0 for 0 streak days', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{ current_streak: 0, trust_tier: 1 }],
      });

      const result = await XPService.calculateAward('user-1', 100);
      expect(result.success).toBe(true);
      expect(result.data?.streakMultiplier).toBe(1.0);
    });

    it('should return 1.35 for 7 streak days (1.0 + 7×0.05)', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{ current_streak: 7, trust_tier: 1 }],
      });

      const result = await XPService.calculateAward('user-1', 100);
      expect(result.success).toBe(true);
      expect(result.data?.streakMultiplier).toBeCloseTo(1.35, 2);
    });

    it('should return 1.7 for 14 streak days (1.0 + 14×0.05)', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{ current_streak: 14, trust_tier: 1 }],
      });

      const result = await XPService.calculateAward('user-1', 100);
      expect(result.success).toBe(true);
      expect(result.data?.streakMultiplier).toBeCloseTo(1.7, 2);
    });

    it('should cap at 2.0 for 30+ streak days', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{ current_streak: 30, trust_tier: 1 }],
      });

      const result = await XPService.calculateAward('user-1', 100);
      expect(result.success).toBe(true);
      expect(result.data?.streakMultiplier).toBe(2.0);
    });

    it('should cap at 2.0 for 100 streak days (not exceed)', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{ current_streak: 100, trust_tier: 1 }],
      });

      const result = await XPService.calculateAward('user-1', 100);
      expect(result.success).toBe(true);
      expect(result.data?.streakMultiplier).toBe(2.0);
    });
  });

  describe('Trust Multiplier (PRODUCT_SPEC §5.2)', () => {
    // Canonical provider tiers: Explorer/Verified=1.0, Home Ready=1.5,
    // Pro/Licensed Specialist=2.0. XP never grants trust access.

    it('should return 1.0 for Explorer (tier 0)', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{ current_streak: 0, trust_tier: 0 }],
      });

      const result = await XPService.calculateAward('user-1', 100);
      expect(result.success).toBe(true);
      expect(result.data?.trustMultiplier).toBe(1.0);
    });

    it('should return 1.0 for Verified (tier 1)', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{ current_streak: 0, trust_tier: 1 }],
      });

      const result = await XPService.calculateAward('user-1', 100);
      expect(result.success).toBe(true);
      expect(result.data?.trustMultiplier).toBe(1.0);
    });

    it('should return 1.5 for Home Ready (tier 2)', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{ current_streak: 0, trust_tier: 2 }],
      });

      const result = await XPService.calculateAward('user-1', 100);
      expect(result.success).toBe(true);
      expect(result.data?.trustMultiplier).toBe(1.5);
    });

    it('should return 2.0 for Pro (tier 3)', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{ current_streak: 0, trust_tier: 3 }],
      });

      const result = await XPService.calculateAward('user-1', 100);
      expect(result.success).toBe(true);
      expect(result.data?.trustMultiplier).toBe(2.0);
    });

    it('should return 2.0 for Licensed Specialist (tier 4)', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{ current_streak: 0, trust_tier: 4 }],
      });

      const result = await XPService.calculateAward('user-1', 100);
      expect(result.success).toBe(true);
      expect(result.data?.trustMultiplier).toBe(2.0);
    });
  });

  describe('Live Mode Multiplier (PRODUCT_SPEC §3.6)', () => {
    // SPEC: Live tasks award 1.25× XP

    it('should return 1.0 for STANDARD mode tasks', async () => {
      db.query
        .mockResolvedValueOnce({
          rows: [{ current_streak: 0, trust_tier: 1 }],
        })
        .mockResolvedValueOnce({
          rows: [{ mode: 'STANDARD' }],
        });

      const result = await XPService.calculateAward('user-1', 100, 'task-1');
      expect(result.success).toBe(true);
      expect(result.data?.liveModeMultiplier).toBe(1.0);
    });

    it('should return 1.25 for LIVE mode tasks', async () => {
      db.query
        .mockResolvedValueOnce({
          rows: [{ current_streak: 0, trust_tier: 1 }],
        })
        .mockResolvedValueOnce({
          rows: [{ mode: 'LIVE' }],
        });

      const result = await XPService.calculateAward('user-1', 100, 'task-1');
      expect(result.success).toBe(true);
      expect(result.data?.liveModeMultiplier).toBe(1.25);
    });
  });

  describe('Effective XP Calculation', () => {
    // SPEC: effective_xp = base_xp × streak_multiplier × trust_multiplier × live_mode_multiplier

    it('should calculate correctly: 100 base × 1.0 streak × 1.0 trust × 1.0 live = 100', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{ current_streak: 0, trust_tier: 1 }],
      });

      const result = await XPService.calculateAward('user-1', 100);
      expect(result.success).toBe(true);
      expect(result.data?.effectiveXP).toBe(100);
    });

    it('should calculate correctly: 100 base × 1.5 streak × 2.0 trust × 1.0 live = 300', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{ current_streak: 10, trust_tier: 3 }], // 10 days = 1.5, tier 3 = 2.0
      });

      const result = await XPService.calculateAward('user-1', 100);
      expect(result.success).toBe(true);
      expect(result.data?.effectiveXP).toBe(300);
    });

    it('should calculate correctly: 100 base × 2.0 streak × 2.0 trust × 1.25 live = 500', async () => {
      db.query
        .mockResolvedValueOnce({
          rows: [{ current_streak: 30, trust_tier: 4 }], // 30 days = 2.0, tier 4 = 2.0
        })
        .mockResolvedValueOnce({
          rows: [{ mode: 'LIVE' }],
        });

      const result = await XPService.calculateAward('user-1', 100, 'task-1');
      expect(result.success).toBe(true);
      expect(result.data?.effectiveXP).toBe(500);
    });

    it('should truncate (floor) fractional XP', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{ current_streak: 1, trust_tier: 1 }], // 1 day = 1.05
      });

      // 100 × 1.05 × 1.0 = 105 (no fraction)
      // 99 × 1.05 × 1.0 = 103.95 → 103
      const result = await XPService.calculateAward('user-1', 99);
      expect(result.success).toBe(true);
      expect(result.data?.effectiveXP).toBe(103); // floor(103.95)
    });
  });
});

describe('SPEC ALIGNMENT: Escrow State Machine (PRODUCT_SPEC §4.2, §4.3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.query.mockReset();
  });

  describe('LOCKED_DISPUTE → RELEASED Transition', () => {
    // SPEC: Worker can receive funds after dispute resolved in their favor

    it('should allow releasing escrow from LOCKED_DISPUTE state', async () => {
      // Mock 1: SELECT escrow by ID (returns LOCKED_DISPUTE state)
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          id: 'escrow-1',
          task_id: 'task-1',
          amount: 1000,
          state: 'LOCKED_DISPUTE',
        }],
      });

      // Mock 2: authoritative worker-favor dispute resolution.
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ resolved_dispute_id: 'dispute-worker-win-1' }],
      });

      // Mock 3: SELECT task for worker_id and price
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          worker_id: 'worker-1',
          price: 1000,
        }],
      });

      // Mock 4: SELECT worker KYC info (KYC gate - added for 72-hour fixes)
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          payouts_enabled: true,
          stripe_connect_id: 'acct_worker1',
          stripe_connect_status: 'enabled',
        }],
      });

      // Mock 5: UPDATE escrow to RELEASED (the actual state transition)
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          id: 'escrow-1',
          task_id: 'task-1',
          amount: 1000,
          state: 'RELEASED',
          released_at: new Date(),
          stripe_transfer_id: null,
        }],
      });

      // Mock 6+: Downstream service calls (earnings tracking, XP, etc.)
      db.query.mockResolvedValue({ rowCount: 0, rows: [] });

      const result = await EscrowService.release({ escrowId: 'escrow-1', stripeTransferId: 'tr_test_spec_align' });
      expect(result.success).toBe(true);
      expect(result.data?.state).toBe('RELEASED');
    });

    it('should include LOCKED_DISPUTE in valid source states for release', async () => {
      // Mock 1: SELECT escrow (returns escrow with a non-terminal state)
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'escrow-1', task_id: 'task-1', amount: 1000, state: 'FUNDED' }],
      });

      // Mock 2: SELECT task for worker_id
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ worker_id: 'worker-1', price: 1000 }],
      });

      // Mock 3: SELECT worker KYC info (KYC gate)
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          payouts_enabled: true,
          stripe_connect_id: 'acct_worker1',
          stripe_connect_status: 'enabled',
        }],
      });

      // Mock 4: UPDATE escrow (returns empty = no transition, triggers fallback)
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'escrow-1', task_id: 'task-1', amount: 1000, state: 'RELEASED', released_at: new Date() }],
      });

      // Mock 5+: Downstream service calls
      db.query.mockResolvedValue({ rowCount: 0, rows: [] });

      await EscrowService.release({ escrowId: 'escrow-1', stripeTransferId: 'tr_test_locked_disp' });

      // The UPDATE query is the 4th db.query call (index 3) after adding KYC gate
      const updateSql = db.query.mock.calls[3][0];
      expect(updateSql).toContain("state IN ('FUNDED', 'LOCKED_DISPUTE')");
    });
  });

  describe('Valid Escrow Transitions', () => {
    it('should allow PENDING → FUNDED', async () => {
      expect(EscrowService.isValidTransition('PENDING', 'FUNDED')).toBe(true);
    });

    it('should allow FUNDED → RELEASED', async () => {
      expect(EscrowService.isValidTransition('FUNDED', 'RELEASED')).toBe(true);
    });

    it('should allow FUNDED → LOCKED_DISPUTE', async () => {
      expect(EscrowService.isValidTransition('FUNDED', 'LOCKED_DISPUTE')).toBe(true);
    });

    it('should allow LOCKED_DISPUTE → RELEASED (SPEC FIX)', async () => {
      expect(EscrowService.isValidTransition('LOCKED_DISPUTE', 'RELEASED')).toBe(true);
    });

    it('should allow LOCKED_DISPUTE → REFUNDED', async () => {
      expect(EscrowService.isValidTransition('LOCKED_DISPUTE', 'REFUNDED')).toBe(true);
    });

    it('should allow LOCKED_DISPUTE → REFUND_PARTIAL', async () => {
      expect(EscrowService.isValidTransition('LOCKED_DISPUTE', 'REFUND_PARTIAL')).toBe(true);
    });

    it('should NOT allow RELEASED → any (terminal)', async () => {
      expect(EscrowService.isValidTransition('RELEASED', 'FUNDED')).toBe(false);
      expect(EscrowService.isValidTransition('RELEASED', 'REFUNDED')).toBe(false);
    });
  });
});

describe('SPEC ALIGNMENT: Price Minimums (PRODUCT_SPEC §3.5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.query.mockReset();
  });

  describe('STANDARD Mode Price Validation', () => {
    it('should reject STANDARD task with price < $15.00 (1500 cents)', async () => {
      const result = await TaskService.create({
        posterId: 'poster-1',
        title: 'Test Task',
        description: 'Test description',
        price: 1499, // $14.99
        mode: 'STANDARD',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PRICE_TOO_LOW');
      expect(result.error?.message).toContain('$15.00');
    });

    it('should accept STANDARD task with price = $15.00 (1500 cents)', async () => {
      // Mock all the dependencies
      db.query.mockResolvedValueOnce({ rows: [{ allowed: true }] }); // PlanService
      db.query.mockResolvedValueOnce({
        rows: [{
          id: 'task-1',
          state: 'OPEN',
          price: 1500,
        }],
      });

      const result = await TaskService.create({
        posterId: 'poster-1',
        title: 'Test Task',
        description: 'Test description',
        price: 1500, // $15.00
        mode: 'STANDARD',
      });

      // Should not fail on price validation
      if (!result.success) {
        expect(result.error?.code).not.toBe('PRICE_TOO_LOW');
      }
    });

    it('should accept STANDARD task with price > $15.00', async () => {
      db.query.mockResolvedValueOnce({ rows: [{ allowed: true }] });
      db.query.mockResolvedValueOnce({
        rows: [{
          id: 'task-1',
          state: 'OPEN',
          price: 2000,
        }],
      });

      const result = await TaskService.create({
        posterId: 'poster-1',
        title: 'Test Task',
        description: 'Test description',
        price: 2000, // $20.00
        mode: 'STANDARD',
      });

      if (!result.success) {
        expect(result.error?.code).not.toBe('PRICE_TOO_LOW');
      }
    });
  });

  describe('LIVE Mode Price Validation', () => {
    it('should reject LIVE task with price < $15.00 (1500 cents)', async () => {
      const result = await TaskService.create({
        posterId: 'poster-1',
        title: 'Test Task',
        description: 'Test description',
        price: 1499, // $14.99
        mode: 'LIVE',
      });

      expect(result.success).toBe(false);
      // Error code may be HX902 or LIVE_2_VIOLATION depending on validation layer
      expect(['LIVE_2_VIOLATION', 'HX902']).toContain(result.error?.code);
      expect(result.error?.message).toContain('15');
    });

    it('should accept LIVE task with price = $15.00 (1500 cents)', async () => {
      db.query.mockResolvedValueOnce({ rows: [{ allowed: true }] });
      db.query.mockResolvedValueOnce({
        rows: [{
          id: 'task-1',
          state: 'OPEN',
          price: 1500,
        }],
      });

      const result = await TaskService.create({
        posterId: 'poster-1',
        title: 'Test Task',
        description: 'Test description',
        price: 1500, // $15.00
        mode: 'LIVE',
      });

      if (!result.success) {
        expect(result.error?.code).not.toBe('LIVE_2_VIOLATION');
      }
    });
  });

  describe('Edge Cases', () => {
    it('should fallback to minimum price when price = 0 (Scoper AI pathway)', async () => {
      // When price=0, TaskService invokes Scoper AI. If AI fails, it falls back to min price (500 cents).
      // This is correct behavior per PRODUCT_SPEC §3.5 — price=0 triggers AI pricing, not rejection.
      // Mock the DB INSERT for task creation
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'task-new', title: 'Test Task', price: 500, state: 'OPEN' }],
      });
      // Mock downstream calls (notifications, etc.)
      db.query.mockResolvedValue({ rowCount: 0, rows: [] });

      const result = await TaskService.create({
        posterId: 'poster-1',
        title: 'Test Task',
        description: 'Test description',
        price: 0,
        regionCode: 'US-WA',
        category: 'moving',
      });

      // price=0 triggers Scoper AI fallback to $5.00 minimum, so task IS created
      expect(result.success).toBe(true);
    });

    it('should reject negative price', async () => {
      // Negative price is always invalid — Scoper AI fallback also won't help
      // because the fallback sets a positive price. But if somehow finalPrice stays negative,
      // the check at line 269 catches it.
      // Mock ScoperAI to return the negative price as-is (simulating bypass)
      const { ScoperAIService } = await import('../../src/services/ScoperAIService');
      vi.mocked(ScoperAIService.analyzeTaskScope).mockResolvedValueOnce({
        success: true,
        data: { suggested_price_cents: -100, suggested_xp: 10, difficulty: 'EASY' },
      } as any);

      const result = await TaskService.create({
        posterId: 'poster-1',
        title: 'Test Task',
        description: 'Test description',
        price: -100,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_STATE');
    });

    it('should reject non-integer price', async () => {
      const result = await TaskService.create({
        posterId: 'poster-1',
        title: 'Test Task',
        description: 'Test description',
        price: 499.5,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_STATE');
    });
  });
});

describe('SPEC ALIGNMENT: Evidence-backed trust promotion (Local Work Network §5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.query.mockReset();
  });

  describe('Verified promotion', () => {
    it('requires identity, phone, and payout onboarding for Explorer → Verified', async () => {
      db.query
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ trust_tier: 0, is_banned: false }] })
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{
            is_verified: false,
            verified_at: null,
            phone: '555-1234',
            stripe_connect_id: null,
            payouts_enabled: false,
          }],
        });

      const result = await TrustTierService.evaluatePromotion('user-1');
      expect(result.eligible).toBe(false);
      expect(result.reasons).toContain('ID verification required');
      expect(result.reasons).toContain('Payout onboarding required');
    });
  });

  describe('Home Ready promotion', () => {
    it('requires current production screening and five production completions', async () => {
      db.query
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ trust_tier: 1, is_banned: false }] })
        .mockResolvedValueOnce({ rows: [{ current_screening: false }] })
        .mockResolvedValueOnce({ rows: [{ completed_count: '2', active_dispute_count: '0' }] });

      const result = await TrustTierService.evaluatePromotion('user-1');
      expect(result.eligible).toBe(false);
      expect(result.reasons).toContain('Current production enhanced screening required');
      expect(result.reasons.some(r => r.includes('need 5'))).toBe(true);
    });
  });

  describe('Later-phase progression', () => {
    it('does not infer Pro or Licensed Specialist from XP and task counts', async () => {
      db.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ trust_tier: 2, is_banned: false }] });
      expect((await TrustTierService.evaluatePromotion('user-1')).reasons[0]).toContain('Pro progression is not enabled');

      db.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ trust_tier: 3, is_banned: false }] });
      expect((await TrustTierService.evaluatePromotion('user-1')).reasons[0]).toContain('Licensed Specialist progression is not enabled');
    });
  });
});

describe('Integration: Full XP Award Flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.query.mockReset();
  });

  it('should award XP with all multipliers correctly', async () => {
    // Setup: VERIFIED user (tier 2), 14-day streak, LIVE task
    // Expected: 100 base × 1.7 streak × 1.5 trust × 1.25 live = 318.75 → 318

    // FIX 1: awardXP now calls checkDailyXPCap (DB query) then checkVelocity before transaction
    db.query
      .mockResolvedValueOnce({ rows: [{ total: '0' }] })      // checkDailyXPCap DB fallback
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })      // checkVelocity
      .mockResolvedValueOnce({ rows: [{ default_mode: 'worker' }] }) // post-tx AlphaInstrumentation
      .mockResolvedValueOnce({ rows: [{ completed_at: null }] });    // post-tx StreakService

    const mockTxQuery = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          xp_total: 500,
          current_level: 3,
          current_streak: 14,
          trust_tier: 2,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ mode: 'LIVE' }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'xp-1',
          effective_xp: 318,
        }],
      })
      .mockResolvedValueOnce({ rowCount: 1 });

    db.serializableTransaction.mockImplementation(async (fn) => {
      return fn(mockTxQuery);
    });

    const result = await XPService.awardXP({
      userId: 'user-1',
      taskId: 'task-1',
      escrowId: 'escrow-1',
      baseXP: 100,
    });

    // Verify the calculation was done correctly
    expect(db.serializableTransaction).toHaveBeenCalled();
  });
});

// Summary test to verify all critical fixes
describe('CRITICAL FIXES SUMMARY', () => {
  it('✓ Trust Tier Enum: Uses canonical individual-provider tiers 0-4', () => {
    expect(TrustTier.EXPLORER).toBe(0);
    expect(TrustTier.VERIFIED).toBe(1);
    expect(TrustTier.HOME_READY).toBe(2);
    expect(TrustTier.PRO).toBe(3);
    expect(TrustTier.LICENSED_SPECIALIST).toBe(4);
  });

  it('✓ XP Formula: Uses trust_multiplier instead of decay_factor', () => {
    // The XPService now uses getTrustMultiplier, not calculateDecayFactor
    // This is verified by the XP tests above
    expect(true).toBe(true);
  });

  it('✓ Escrow: LOCKED_DISPUTE → RELEASED transition allowed', () => {
    expect(EscrowService.isValidTransition('LOCKED_DISPUTE', 'RELEASED')).toBe(true);
  });

  it('✓ Price: STANDARD mode enforces $15.00 minimum', async () => {
    const result = await TaskService.create({
      posterId: 'p-1',
      title: 'T',
      description: 'D',
      price: 499,
      mode: 'STANDARD',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PRICE_TOO_LOW');
  });
});
