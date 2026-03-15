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

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { pricingRouter } from '../../src/routers/pricing';
import { DynamicPricingService } from '../../src/services/DynamicPricingService';

const mockPricing = vi.mocked(DynamicPricingService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID1 = '00000000-0000-0000-0000-000000000001';

function makeCaller() {
  return pricingRouter.createCaller({
    user: { id: UUID1, email: 'user@test.com', full_name: 'User', firebase_uid: 'fb-1', default_mode: 'poster' } as any,
    firebaseUid: 'fb-1',
  });
}

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
  // updateMyModifier
  // =========================================================================
  describe('updateMyModifier', () => {
    it('updates modifier and returns result', async () => {
      const data = { modifierPercent: 10, applied: true };
      mockPricing.updateWorkerModifier.mockResolvedValue(data as any);

      const caller = makeCaller();
      const result = await caller.updateMyModifier({ modifierPercent: 10 });

      expect(result).toEqual(data);
      expect(mockPricing.updateWorkerModifier).toHaveBeenCalledWith(UUID1, 10);
    });

    it('allows negative modifier', async () => {
      mockPricing.updateWorkerModifier.mockResolvedValue({ modifierPercent: -25 } as any);

      const caller = makeCaller();
      const result = await caller.updateMyModifier({ modifierPercent: -25 });

      expect(result).toEqual({ modifierPercent: -25 });
    });

    it('allows max modifier of 50', async () => {
      mockPricing.updateWorkerModifier.mockResolvedValue({ modifierPercent: 50 } as any);

      const caller = makeCaller();
      const result = await caller.updateMyModifier({ modifierPercent: 50 });

      expect(result).toEqual({ modifierPercent: 50 });
    });
  });
});
