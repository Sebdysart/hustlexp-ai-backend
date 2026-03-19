import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScoperAIService } from '../../src/services/ScoperAIService.js';
import { TEMPLATE_SLUGS } from '../../src/services/TaskTemplateRegistry.js';
import type { ComplianceResult } from '../../src/services/ComplianceGuardianService.js';

// Hoisted mock controls — shared across all describe blocks
const { mockAICall, mockAIIsConfigured } = vi.hoisted(() => ({
  mockAICall: vi.fn(),
  mockAIIsConfigured: vi.fn().mockReturnValue(false),
}));

// Mock AI and DB
vi.mock('../../src/services/AIClient.js', () => ({
  AIClient: {
    isConfigured: mockAIIsConfigured,
    call: mockAICall,
  },
}));
vi.mock('../../src/db.js', () => ({
  db: { query: vi.fn() },
}));

function makeComplianceResult(overrides: Partial<ComplianceResult> = {}): ComplianceResult {
  return {
    score: 5,
    tier: 'clean',
    triggeredRules: [],
    deception_detected: false,
    is_genuinely_bizarre: false,
    ai_signals_computed: true,  // ADD THIS — tests that explicitly test cap behavior need AI to have run
    notes: {
      score: 5,
      tier: 'clean',
      triggered_rules: [],
      suggested_alternative: null,
      admin_review_id: null,
      appeal_status: 'none',
      deception_detected: false,
      is_genuinely_bizarre: false,
      ai_signals_computed: true,  // ADD THIS
    },
    ...overrides,
  };
}

describe('ScoperAI wildcard multiplier — deception override', () => {
  it('zeros wildcard premium when deception_detected is true', async () => {
    const complianceResult = makeComplianceResult({ deception_detected: true, is_genuinely_bizarre: true });

    const result = await ScoperAIService.analyzeTaskScope({
      description: 'Pretend to be my boyfriend at my grandma\'s birthday party',
      templateSlug: TEMPLATE_SLUGS.WILDCARD_BIZARRE,
      wildcardFlags: ['performance_element_flag', 'audience_present_flag', 'costume_or_attire_flag'],
      complianceResult,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // With deception override, price should equal or be close to base (no multiplier applied)
    // Base heuristic for wildcard_bizarre is $75 (talent floor)
    // Multipliers would push it higher, but deception override zeros them
    // So final price should be <= base price (7500 cents)
    expect(result.data.suggested_price_cents).toBeLessThanOrEqual(8000); // base ≈ $75
  });
});

describe('ScoperAI wildcard multiplier — genuine bizarre cap', () => {
  it('caps premium at 1.1x when is_genuinely_bizarre is false', async () => {
    const complianceResult = makeComplianceResult({ deception_detected: false, is_genuinely_bizarre: false });

    const result = await ScoperAIService.analyzeTaskScope({
      description: 'Help me clean my house — it is a ceremonial one-off for our family',
      templateSlug: TEMPLATE_SLUGS.WILDCARD_BIZARRE,
      wildcardFlags: ['performance_element_flag', 'audience_present_flag', 'private_location_flag'],
      complianceResult,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Base is ~7500 cents. Multipliers: 0.20 + 0.10 + 0.15 = 0.45x = $108.75
    // Cap at 1.1x = $82.50 (8250 cents)
    // Final should be <= 8250
    expect(result.data.suggested_price_cents).toBeLessThanOrEqual(8250);
  });

  it('does NOT cap when is_genuinely_bizarre is true', async () => {
    const complianceResult = makeComplianceResult({ deception_detected: false, is_genuinely_bizarre: true });

    const result = await ScoperAIService.analyzeTaskScope({
      description: 'Scatter my grandfather\'s ashes at the summit of Mount Rainier',
      templateSlug: TEMPLATE_SLUGS.WILDCARD_BIZARRE,
      wildcardFlags: ['travel_over_30min_flag', 'performance_element_flag'],
      complianceResult,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // travel_over_30min (0.20) + performance_element (0.20) = 0.40x premium on base ~7500
    // = 7500 * 1.40 = 10500. NOT capped.
    expect(result.data.suggested_price_cents).toBeGreaterThan(8250);
  });
});

describe('ScoperAI wildcard multiplier — no complianceResult', () => {
  it('applies full multipliers when no complianceResult provided (backward compat)', async () => {
    const result = await ScoperAIService.analyzeTaskScope({
      description: 'Serenade someone at a restaurant',
      templateSlug: TEMPLATE_SLUGS.WILDCARD_BIZARRE,
      wildcardFlags: ['performance_element_flag', 'audience_present_flag'],
      // no complianceResult
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    // Base 7500 + 0.30x = 9750, uncapped
    expect(result.data.suggested_price_cents).toBeGreaterThan(7500);
  });
});

describe('ScoperAI wildcard multiplier — deception override requires AI confirmation', () => {
  it('does NOT zero multipliers when deception_detected=true but ai_signals_computed=false', async () => {
    const complianceResult = makeComplianceResult({
      deception_detected: true,
      ai_signals_computed: false, // AI didn't run — heuristic path only
      is_genuinely_bizarre: false,
    });

    const result = await ScoperAIService.analyzeTaskScope({
      description: 'Pretend to be my girlfriend',
      templateSlug: TEMPLATE_SLUGS.WILDCARD_BIZARRE,
      wildcardFlags: ['performance_element_flag', 'audience_present_flag'],
      complianceResult,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Without ai_signals_computed, deception override should NOT fire.
    // Base ~7500, multipliers 0.30x → ~9750. Should be > base 7500.
    expect(result.data.suggested_price_cents).toBeGreaterThan(7500);
  });
});

describe('ScoperAI wildcard multiplier — no AI signals (ai_signals_computed=false)', () => {
  it('does NOT cap when ai_signals_computed is false even if is_genuinely_bizarre is false', async () => {
    const complianceResult = makeComplianceResult({
      ai_signals_computed: false,  // AI didn't run
      is_genuinely_bizarre: false,  // default false — should NOT trigger cap
    });

    const result = await ScoperAIService.analyzeTaskScope({
      description: 'Scatter my grandfather\'s ashes at a hiking peak',
      templateSlug: TEMPLATE_SLUGS.WILDCARD_BIZARRE,
      wildcardFlags: ['travel_over_30min_flag', 'performance_element_flag'],
      complianceResult,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Without AI signals, cap should NOT apply. travel+performance = 0.40x on base ~7500
    // = 7500 * 1.40 = 10500. Should be > 1.1x cap of 8250.
    expect(result.data.suggested_price_cents).toBeGreaterThan(8250);
  });
});

// ---------------------------------------------------------------------------
// refineTaskDescription — input length cap (security fix)
// ---------------------------------------------------------------------------

describe('ScoperAI refineTaskDescription — input length cap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('truncates a 5000-char description to 2000 chars before sending to AI', async () => {
    // Enable AI for this test
    mockAIIsConfigured.mockReturnValue(true);
    mockAICall.mockResolvedValue({ content: 'Cleaned description' });

    const longDescription = 'a'.repeat(5000);
    await ScoperAIService.refineTaskDescription(longDescription);

    expect(mockAICall).toHaveBeenCalledTimes(1);
    const callArg = mockAICall.mock.calls[0][0] as { prompt: string };
    // prompt is scrubPII(truncatedInput); scrubPII should be a no-op on 'a' chars
    expect(callArg.prompt.length).toBeLessThanOrEqual(2000);
  });

  it('passes short descriptions through without truncation', async () => {
    mockAIIsConfigured.mockReturnValue(true);
    mockAICall.mockResolvedValue({ content: 'Short cleaned' });

    const shortDescription = 'Fix my leaky faucet ASAP';
    await ScoperAIService.refineTaskDescription(shortDescription);

    expect(mockAICall).toHaveBeenCalledTimes(1);
    const callArg = mockAICall.mock.calls[0][0] as { prompt: string };
    expect(callArg.prompt).toContain('Fix my leaky faucet ASAP');
  });

  it('falls back to basic cleanup when AI is not configured', async () => {
    mockAIIsConfigured.mockReturnValue(false);

    const description = '  hello   world  ';
    const result = await ScoperAIService.refineTaskDescription(description);

    expect(mockAICall).not.toHaveBeenCalled();
    expect(result).toBe('hello world');
  });
});
