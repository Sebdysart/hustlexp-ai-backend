// backend/tests/unit/TaskTemplateRegistry.test.ts
import { describe, it, expect } from 'vitest';
import {
  TaskTemplateRegistry,
  getTemplate,
  TEMPLATE_SLUGS,
  type TaskTemplate,
} from '../../src/services/TaskTemplateRegistry.js';

describe('TaskTemplateRegistry', () => {
  it('has exactly 8 templates', () => {
    expect(Object.keys(TaskTemplateRegistry)).toHaveLength(8);
  });

  it('every template has required fields', () => {
    for (const slug of Object.values(TEMPLATE_SLUGS)) {
      const t = TaskTemplateRegistry[slug];
      expect(t.slug).toBe(slug);
      expect(t.defaultRiskTier).toBeGreaterThanOrEqual(0);
      expect(t.defaultRiskTier).toBeLessThanOrEqual(3);
      expect(t.requiredTrustTier).toBeDefined();
      expect(t.completionCriteriaType).toBeDefined();
      expect(t.autoReleaseHours).toBeGreaterThanOrEqual(0);
      expect(t.lateCancelPct).toBeGreaterThanOrEqual(0);
      expect(t.scoperContext).toBeTruthy();
    }
  });

  it('getTemplate returns correct template for known slug', () => {
    const t = getTemplate('content_creator');
    expect(t.slug).toBe('content_creator');
    expect(t.requiresMutualConsent).toBe(true);
  });

  it('getTemplate falls back to wildcard_bizarre for unknown slug', () => {
    const t = getTemplate('totally_unknown_slug');
    expect(t.slug).toBe('wildcard_bizarre');
  });

  it('wildcard_bizarre has deterministic multiplier table', () => {
    const t = getTemplate('wildcard_bizarre');
    expect(t.wildcardMultipliers).toBeDefined();
    expect(t.wildcardMultipliers!.performance_element_flag).toBe(0.20);
  });

  it('applyWildcardMultipliers caps at 50% and clamps to max', async () => {
    const { applyWildcardMultipliers } = await import('../../src/services/TaskTemplateRegistry.js');
    // All 6 flags = 0.85 total, capped at 0.50
    const allFlags = ['private_location_flag','props_required_flag','performance_element_flag','audience_present_flag','costume_or_attire_flag','travel_over_30min_flag'];
    const result = applyWildcardMultipliers(10000, allFlags);
    expect(result).toBe(15000); // 10000 * 1.50 = 15000

    // Clamp to max
    const clamped = applyWildcardMultipliers(40000, allFlags, 50000);
    expect(clamped).toBe(50000); // 40000 * 1.50 = 60000, clamped to 50000
  });

  it('care template has autoReleaseHours of 0 (GPS checkout)', () => {
    const t = getTemplate('care');
    expect(t.autoReleaseHours).toBe(0);
    expect(t.defaultRiskTier).toBe(3);
  });

  it('in_home template is minimum TIER_2', () => {
    const t = getTemplate('in_home');
    expect(t.defaultRiskTier).toBe(2);
    expect(t.requiredTrustTier).toBe('verified');
  });
});
