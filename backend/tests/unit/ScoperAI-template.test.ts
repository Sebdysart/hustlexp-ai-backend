// backend/tests/unit/ScoperAI-template.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ScoperAIService } from '../../src/services/ScoperAIService.js';

vi.mock('../../src/services/AIClient.js', () => ({
  AIClient: { isConfigured: () => false },
}));

describe('ScoperAI — template-aware pricing', () => {
  it('wildcard with performance_element_flag applies 20% multiplier', async () => {
    const result = await ScoperAIService.analyzeTaskScope({
      description: 'Be a human statue at my art event for 3 hours',
      templateSlug: 'wildcard_bizarre',
      wildcardFlags: ['performance_element_flag'],
    });
    expect(result.success).toBe(true);
    expect(result.data!.suggested_price_cents).toBeGreaterThan(7500);
  });

  it('wildcard with all flags capped at 50% premium', async () => {
    const result = await ScoperAIService.analyzeTaskScope({
      description: 'Wear a costume and perform at a private venue for 4 hours',
      templateSlug: 'wildcard_bizarre',
      wildcardFlags: [
        'private_location_flag',
        'props_required_flag',
        'performance_element_flag',
        'audience_present_flag',
        'costume_or_attire_flag',
        'travel_over_30min_flag',
      ],
    });
    expect(result.success).toBe(true);
    const price = result.data!.suggested_price_cents;
    expect(price).toBeLessThanOrEqual(50000);
  });

  it('template context injected into system prompt for content_creator', async () => {
    const result = await ScoperAIService.analyzeTaskScope({
      description: 'Be a guest on my gaming stream for 2 hours, audience is 50K',
      templateSlug: 'content_creator',
    });
    expect(result.success).toBe(true);
    expect(result.data!.suggested_price_cents).toBeGreaterThan(5000);
  });
});
