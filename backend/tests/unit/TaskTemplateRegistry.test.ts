// backend/tests/unit/TaskTemplateRegistry.test.ts
import { describe, it, expect } from 'vitest';
import {
  TaskTemplateRegistry,
  getTemplate,
  TEMPLATE_SLUGS,
  isCareContent,
  isContentReleaseRequired,
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
    expect(t!.slug).toBe('content_creator');
    expect(t!.requiresMutualConsent).toBe(true);
  });

  it('getTemplate returns undefined for unknown slug (FIX 4: no silent wildcard fallback)', () => {
    const t = getTemplate('totally_unknown_slug');
    expect(t).toBeUndefined();
  });

  it('wildcard_bizarre has deterministic multiplier table', () => {
    const t = getTemplate('wildcard_bizarre');
    expect(t!.wildcardMultipliers).toBeDefined();
    expect(t!.wildcardMultipliers!.performance_element_flag).toBe(0.20);
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
    expect(t!.autoReleaseHours).toBe(0);
    expect(t!.defaultRiskTier).toBe(3);
  });

  it('in_home template is minimum TIER_2', () => {
    const t = getTemplate('in_home');
    expect(t!.defaultRiskTier).toBe(2);
    expect(t!.requiredTrustTier).toBe('verified');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isCareContent — unit tests (FIX 2)
// ─────────────────────────────────────────────────────────────────────────────

describe('isCareContent — content-based caregiving detection', () => {
  it('detects "bathe" keyword', () => {
    expect(isCareContent('help me bathe my dog')).toBe(true);
  });

  it('detects "elderly" keyword', () => {
    expect(isCareContent('care for my elderly mother')).toBe(true);
  });

  it('detects "babysit" keyword', () => {
    expect(isCareContent('Need a babysitter for tonight')).toBe(true);
  });

  it('detects "childcare" keyword', () => {
    expect(isCareContent('looking for childcare support')).toBe(true);
  });

  it('detects "infant" keyword', () => {
    expect(isCareContent('watch my infant for 2 hours')).toBe(true);
  });

  it('detects "wheelchair" keyword', () => {
    expect(isCareContent('assist wheelchair user at appointment')).toBe(true);
  });

  it('detects "dementia" keyword', () => {
    expect(isCareContent('companion for dementia patient')).toBe(true);
  });

  it('detects "dog sit" with space', () => {
    expect(isCareContent('dog sit my golden retriever')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isCareContent('BATHE MY ELDERLY PARENT')).toBe(true);
    expect(isCareContent('Babysitter Needed')).toBe(true);
  });

  it('returns false for unrelated tasks', () => {
    expect(isCareContent('move boxes to storage unit')).toBe(false);
    expect(isCareContent('assemble IKEA furniture')).toBe(false);
    expect(isCareContent('deliver packages across town')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isContentReleaseRequired — unit tests (FIX 3)
// ─────────────────────────────────────────────────────────────────────────────

describe('isContentReleaseRequired — content-based content-release detection', () => {
  it('detects "camera" keyword', () => {
    expect(isContentReleaseRequired('appear on camera for my show')).toBe(true);
  });

  it('detects "video" keyword', () => {
    expect(isContentReleaseRequired('be in my video')).toBe(true);
  });

  it('detects "filming" keyword', () => {
    expect(isContentReleaseRequired('filming a short for youtube')).toBe(true);
  });

  it('detects "record" keyword', () => {
    expect(isContentReleaseRequired('help me record this session')).toBe(true);
  });

  it('detects "stream" keyword', () => {
    expect(isContentReleaseRequired('join my live stream tonight')).toBe(true);
  });

  it('detects "youtube" keyword', () => {
    expect(isContentReleaseRequired('appear on my youtube channel')).toBe(true);
  });

  it('detects "tiktok" keyword', () => {
    expect(isContentReleaseRequired('tiktok collaboration')).toBe(true);
  });

  it('detects "channel" keyword', () => {
    expect(isContentReleaseRequired('appear on my channel')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isContentReleaseRequired('APPEAR ON CAMERA FOR MY CHANNEL')).toBe(true);
  });

  it('returns false for unrelated tasks', () => {
    expect(isContentReleaseRequired('move furniture from my apartment')).toBe(false);
    expect(isContentReleaseRequired('clean the kitchen')).toBe(false);
    expect(isContentReleaseRequired('walk my dog for 30 minutes')).toBe(false);
  });
});
