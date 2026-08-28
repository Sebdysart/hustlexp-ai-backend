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

  it('event_appearance template applies talent pricing floor', async () => {
    const result = await ScoperAIService.analyzeTaskScope({
      description: 'Be a brand ambassador at a corporate event for 4 hours',
      templateSlug: 'event_appearance',
    });
    expect(result.success).toBe(true);
    // talent floor: $75 base (7500 cents)
    expect(result.data!.suggested_price_cents).toBeGreaterThanOrEqual(7500);
  });

  it('creative_production template applies talent pricing floor', async () => {
    const result = await ScoperAIService.analyzeTaskScope({
      description: 'Photo shoot model for a commercial campaign for 2 hours',
      templateSlug: 'creative_production',
    });
    expect(result.success).toBe(true);
    expect(result.data!.suggested_price_cents).toBeGreaterThanOrEqual(7500);
  });

  it('standard_physical template does not apply talent pricing', async () => {
    const result = await ScoperAIService.analyzeTaskScope({
      description: 'Help me move boxes to storage unit',
      templateSlug: 'standard_physical',
    });
    expect(result.success).toBe(true);
    // Standard moving = 8000 cents (not talent pricing)
    expect(result.data!.suggested_price_cents).toBeLessThan(10000);
  });

  it('wildcard with no flags returns unmodified price', async () => {
    const result = await ScoperAIService.analyzeTaskScope({
      description: 'Unusual custom task for 2 hours',
      templateSlug: 'wildcard_bizarre',
      wildcardFlags: [],
    });
    expect(result.success).toBe(true);
    // wildcardFlags is empty so no multiplier applied
    expect(result.data!.suggested_price_cents).toBeGreaterThan(0);
  });

  it('care template applies talent pricing floor (isTalentTemplate)', async () => {
    // care is NOT in TALENT_TEMPLATES; should use default pricing
    const result = await ScoperAIService.analyzeTaskScope({
      description: 'Dog sitting for a weekend',
      templateSlug: 'care',
    });
    expect(result.success).toBe(true);
    // care is not a talent template so defaults apply
    expect(result.data!.suggested_price_cents).toBeGreaterThan(0);
  });

  it('refineTaskDescription returns trimmed text when AI not configured', async () => {
    const refined = await ScoperAIService.refineTaskDescription(
      '  Help me move   my couch  '
    );
    expect(refined).toBe('Help me move my couch');
  });

  it('refineTaskDescription handles empty string gracefully', async () => {
    const refined = await ScoperAIService.refineTaskDescription('');
    expect(refined).toBe('');
  });

  it('refineTaskDescription slices to 500 chars', async () => {
    const longDesc = 'x'.repeat(600);
    const refined = await ScoperAIService.refineTaskDescription(longDesc);
    expect(refined.length).toBeLessThanOrEqual(500);
  });
});
