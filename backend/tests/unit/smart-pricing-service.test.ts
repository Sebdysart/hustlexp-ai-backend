// backend/tests/unit/smart-pricing-service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/services/MatchmakerAIService.js', () => ({
  MatchmakerAIService: {
    suggestPrice: vi.fn(),
  },
}));

vi.mock('../../src/services/DynamicPricingService.js', () => ({
  DynamicPricingService: {
    calculatePrice: vi.fn(),
  },
}));

import { SmartPricingService } from '../../src/services/SmartPricingService.js';
import { MatchmakerAIService } from '../../src/services/MatchmakerAIService.js';
import { DynamicPricingService } from '../../src/services/DynamicPricingService.js';

const mockMatchmaker = vi.mocked(MatchmakerAIService);
const mockDynamic = vi.mocked(DynamicPricingService);

const makeSuggestResult = (overrides = {}) => ({
  success: true as const,
  data: {
    suggested_price_cents: 6000,
    range_low_cents: 4500,
    range_high_cents: 9000,
    reasoning: 'Standard physical labor task',
    confidence: 0.82,
    ...overrides,
  },
});

const makeDynamicResult = (overrides = {}) => ({
  success: true as const,
  data: {
    final_price_cents: 6600,
    surge_multiplier: 1.1,
    surge_reason: 'High demand in your area.',
    urgency_premium_cents: 0,
    worker_modifier_cents: 0,
    breakdown: { base: 6000, surge: 600 },
    ...overrides,
  },
});

describe('SmartPricingService.getSmartPrice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns combined pricing on success', async () => {
    mockMatchmaker.suggestPrice.mockResolvedValueOnce(makeSuggestResult() as any);
    mockDynamic.calculatePrice.mockResolvedValueOnce(makeDynamicResult() as any);

    const result = await SmartPricingService.getSmartPrice({
      title: 'Help me move furniture',
      description: 'Need help moving a couch upstairs',
      category: 'moving',
      mode: 'STANDARD',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.recommended_price_cents).toBe(6600);
    expect(result.data.base_suggestion_cents).toBe(6000);
    expect(result.data.surge_multiplier).toBe(1.1);
    expect(result.data.summary).toContain('Standard physical labor task');
  });

  it('includes surge reason in summary', async () => {
    mockMatchmaker.suggestPrice.mockResolvedValueOnce(makeSuggestResult() as any);
    mockDynamic.calculatePrice.mockResolvedValueOnce(makeDynamicResult() as any);

    const result = await SmartPricingService.getSmartPrice({ title: 'Delivery run', mode: 'LIVE' });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.summary).toContain('High demand in your area.');
  });

  it('includes ASAP premium message in summary when urgency_premium_cents > 0', async () => {
    mockMatchmaker.suggestPrice.mockResolvedValueOnce(makeSuggestResult() as any);
    mockDynamic.calculatePrice.mockResolvedValueOnce(
      makeDynamicResult({ urgency_premium_cents: 500, surge_reason: null }) as any
    );

    const result = await SmartPricingService.getSmartPrice({
      title: 'Urgent errand',
      mode: 'LIVE',
      isASAP: true,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.summary).toContain('ASAP/Live premium applied.');
  });

  it('includes worker modifier message in summary when worker_modifier_cents != 0', async () => {
    mockMatchmaker.suggestPrice.mockResolvedValueOnce(makeSuggestResult() as any);
    mockDynamic.calculatePrice.mockResolvedValueOnce(
      makeDynamicResult({ worker_modifier_cents: -200, surge_reason: null }) as any
    );

    const WORKER_ID = 'w-111-222-333';
    const result = await SmartPricingService.getSmartPrice({
      title: 'Window cleaning',
      mode: 'STANDARD',
      workerId: WORKER_ID,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.summary).toContain('Worker rate modifier applied.');
  });

  it('enforces minimum of $5 (500 cents) on final price', async () => {
    mockMatchmaker.suggestPrice.mockResolvedValueOnce(makeSuggestResult() as any);
    mockDynamic.calculatePrice.mockResolvedValueOnce(
      makeDynamicResult({ final_price_cents: 200 }) as any
    );

    const result = await SmartPricingService.getSmartPrice({ title: 'Tiny task', mode: 'STANDARD' });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.recommended_price_cents).toBe(500);
  });

  it('returns failure when suggestPrice fails', async () => {
    const errorResult = { success: false as const, error: { code: 'AI_ERROR', message: 'Model unavailable' } };
    mockMatchmaker.suggestPrice.mockResolvedValueOnce(errorResult as any);

    const result = await SmartPricingService.getSmartPrice({ title: 'Some task', mode: 'STANDARD' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('AI_ERROR');
    expect(mockDynamic.calculatePrice).not.toHaveBeenCalled();
  });

  it('returns failure when calculatePrice fails', async () => {
    mockMatchmaker.suggestPrice.mockResolvedValueOnce(makeSuggestResult() as any);
    const errorResult = { success: false as const, error: { code: 'SURGE_ERROR', message: 'Surge calculation failed' } };
    mockDynamic.calculatePrice.mockResolvedValueOnce(errorResult as any);

    const result = await SmartPricingService.getSmartPrice({ title: 'Some task', mode: 'LIVE' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SURGE_ERROR');
  });

  it('returns SMART_PRICING_ERROR when an exception is thrown', async () => {
    mockMatchmaker.suggestPrice.mockRejectedValueOnce(new Error('Network timeout'));

    const result = await SmartPricingService.getSmartPrice({ title: 'Some task', mode: 'STANDARD' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SMART_PRICING_ERROR');
    expect(result.error.message).toContain('Network timeout');
  });

  it('uses STANDARD mode when mode is not provided', async () => {
    mockMatchmaker.suggestPrice.mockResolvedValueOnce(makeSuggestResult() as any);
    mockDynamic.calculatePrice.mockResolvedValueOnce(makeDynamicResult() as any);

    await SmartPricingService.getSmartPrice({ title: 'Some task' } as any);

    expect(mockDynamic.calculatePrice).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'STANDARD' })
    );
  });

  it('passes all optional parameters to DynamicPricingService', async () => {
    mockMatchmaker.suggestPrice.mockResolvedValueOnce(makeSuggestResult() as any);
    mockDynamic.calculatePrice.mockResolvedValueOnce(makeDynamicResult() as any);

    await SmartPricingService.getSmartPrice({
      title: 'Lawn mowing',
      description: 'Front and back yard',
      category: 'outdoor',
      location: 'Chicago, IL',
      locationLat: 41.8781,
      locationLng: -87.6298,
      mode: 'LIVE',
      isASAP: true,
      workerId: 'worker-abc',
    });

    expect(mockDynamic.calculatePrice).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'outdoor',
        locationLat: 41.8781,
        locationLng: -87.6298,
        mode: 'LIVE',
        isASAP: true,
        workerId: 'worker-abc',
      })
    );
  });
});
