/**
 * Pricing Router Unit Tests
 *
 * Tests all protected procedures:
 * - calculate (query)
 * - updateMyModifier (mutation)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/auth/firebase', () => ({
  firebaseAuth: { verifyIdToken: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  aiLogger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
}));

vi.mock('../../src/services/DynamicPricingService', () => ({
  DynamicPricingService: {
    calculatePrice: vi.fn(),
    updateWorkerModifier: vi.fn(),
  },
}));

vi.mock('../../src/services/SmartPricingService', () => ({
  SmartPricingService: {
    getSmartPrice: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { pricingRouter } from '../../src/routers/pricing';
import { DynamicPricingService } from '../../src/services/DynamicPricingService';
import { SmartPricingService } from '../../src/services/SmartPricingService';

const mockPricing = vi.mocked(DynamicPricingService);
const mockSmartPricing = vi.mocked(SmartPricingService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID1 = '00000000-0000-0000-0000-000000000001';

/** Poster caller — for calculate / getSmartPrice (posterProcedure) */
function makePosterCaller() {
  return pricingRouter.createCaller({
    user: { id: UUID1, email: 'user@test.com', full_name: 'User', firebase_uid: 'fb-1', default_mode: 'poster' } as any,
    firebaseUid: 'fb-1',
  });
}

/** Hustler caller — for updateMyModifier (hustlerProcedure) */
function makeHustlerCaller() {
  return pricingRouter.createCaller({
    user: { id: UUID1, email: 'user@test.com', full_name: 'User', firebase_uid: 'fb-1', default_mode: 'worker' } as any,
    firebaseUid: 'fb-1',
  });
}

// Backwards-compatible alias used by calculate / getSmartPrice tests
function makeCaller() { return makePosterCaller(); }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pricing router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // calculate
  // =========================================================================
  describe('calculate', () => {
    it('returns dynamic price on success', async () => {
      const data = { finalPriceCents: 5500, multiplier: 1.1 };
      mockPricing.calculatePrice.mockResolvedValue(data as any);

      const caller = makeCaller();
      const result = await caller.calculate({
        basePriceCents: 5000,
        mode: 'STANDARD',
      });

      expect(result).toEqual(data);
      expect(mockPricing.calculatePrice).toHaveBeenCalledWith({
        basePriceCents: 5000,
        mode: 'STANDARD',
        category: undefined,
        locationLat: undefined,
        locationLng: undefined,
        isASAP: undefined,
      });
    });

    it('passes all optional params', async () => {
      mockPricing.calculatePrice.mockResolvedValue({ finalPriceCents: 8000 } as any);

      const caller = makeCaller();
      await caller.calculate({
        basePriceCents: 5000,
        mode: 'LIVE',
        category: 'delivery',
        locationLat: 41.8,
        locationLng: -87.6,
        isASAP: true,
      });

      expect(mockPricing.calculatePrice).toHaveBeenCalledWith({
        basePriceCents: 5000,
        mode: 'LIVE',
        category: 'delivery',
        locationLat: 41.8,
        locationLng: -87.6,
        isASAP: true,
      });
    });
  });

  // =========================================================================
  // getSmartPrice
  // =========================================================================
  describe('getSmartPrice', () => {
    it('returns smart price data on success', async () => {
      const data = {
        suggestedPriceCents: 7500,
        minCents: 5000,
        maxCents: 15000,
        confidence: 0.85,
        reasoning: 'Standard physical labor',
      };
      mockSmartPricing.getSmartPrice.mockResolvedValue({ success: true, data } as any);

      const result = await makeCaller().getSmartPrice({
        title: 'Help me move furniture',
        description: 'Need help moving a couch upstairs',
        category: 'moving',
        mode: 'STANDARD',
      });

      expect(result).toEqual(data);
      expect(mockSmartPricing.getSmartPrice).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Help me move furniture' })
      );
    });

    it('passes all optional parameters through', async () => {
      const data = { suggestedPriceCents: 10000, minCents: 7500, maxCents: 15000, confidence: 0.9, reasoning: 'ASAP premium' };
      mockSmartPricing.getSmartPrice.mockResolvedValue({ success: true, data } as any);

      const WORKER_ID = '11111111-1111-1111-1111-111111111111';
      await makeCaller().getSmartPrice({
        title: 'Urgent delivery',
        description: 'ASAP delivery downtown',
        category: 'delivery',
        location: 'Chicago, IL',
        locationLat: 41.8781,
        locationLng: -87.6298,
        mode: 'LIVE',
        isASAP: true,
        workerId: WORKER_ID,
      });

      expect(mockSmartPricing.getSmartPrice).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Urgent delivery',
          mode: 'LIVE',
          isASAP: true,
          workerId: WORKER_ID,
        })
      );
    });

    it('throws INTERNAL_SERVER_ERROR when SmartPricingService fails', async () => {
      mockSmartPricing.getSmartPrice.mockResolvedValue({
        success: false,
        error: { code: 'PRICING_ERROR', message: 'Smart pricing unavailable' },
      } as any);

      await expect(
        makeCaller().getSmartPrice({ title: 'Some task', mode: 'STANDARD' })
      ).rejects.toThrow('Smart pricing unavailable');
    });
  });

  // =========================================================================
  // updateMyModifier
  // =========================================================================
  describe('updateMyModifier', () => {
    it('updates modifier and returns result', async () => {
      const data = { modifierPercent: 10, applied: true };
      mockPricing.updateWorkerModifier.mockResolvedValue(data as any);

      // Bug 4 fix: must use hustler (worker) caller — posterProcedure was wrong
      const caller = makeHustlerCaller();
      const result = await caller.updateMyModifier({ modifierPercent: 10 });

      expect(result).toEqual(data);
      expect(mockPricing.updateWorkerModifier).toHaveBeenCalledWith(UUID1, 10);
    });

    it('allows negative modifier', async () => {
      mockPricing.updateWorkerModifier.mockResolvedValue({ modifierPercent: -25 } as any);

      const caller = makeHustlerCaller();
      const result = await caller.updateMyModifier({ modifierPercent: -25 });

      expect(result).toEqual({ modifierPercent: -25 });
    });

    it('allows max modifier of 50', async () => {
      mockPricing.updateWorkerModifier.mockResolvedValue({ modifierPercent: 50 } as any);

      const caller = makeHustlerCaller();
      const result = await caller.updateMyModifier({ modifierPercent: 50 });

      expect(result).toEqual({ modifierPercent: 50 });
    });

    it('rejects poster caller with FORBIDDEN', async () => {
      const caller = makePosterCaller();
      await expect(
        caller.updateMyModifier({ modifierPercent: 10 })
      ).rejects.toThrow();
    });
  });
});
