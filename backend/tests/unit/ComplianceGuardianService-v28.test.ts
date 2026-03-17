import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComplianceGuardianService } from '../../src/services/ComplianceGuardianService.js';

// Mock dependencies
vi.mock('../../src/db.js', () => ({
  db: {
    query: vi.fn().mockResolvedValue({ rows: [{ flagged_phrase_counter: [] }], rowCount: 1 }),
  },
}));

vi.mock('../../src/services/AIClient.js', () => ({
  AIClient: {
    isConfigured: vi.fn().mockReturnValue(false),
    callJSON: vi.fn(),
  },
}));

vi.mock('../../src/lib/pii-scrubber.js', () => ({
  scrubPII: vi.fn((s: string) => s),
}));

vi.mock('../../src/logger.js', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
  aiLogger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
}));

describe('ComplianceResult.ai_signals_computed', () => {
  beforeEach(() => vi.resetAllMocks());

  it('is false when AI not configured', async () => {
    const { AIClient } = await import('../../src/services/AIClient.js');
    vi.mocked(AIClient.isConfigured).mockReturnValue(false);

    const { db } = await import('../../src/db.js');
    vi.mocked(db.query).mockResolvedValue({ rows: [{ flagged_phrase_counter: [] }], rowCount: 1 } as any);

    const result = await ComplianceGuardianService.evaluate({
      description: 'Help me move some boxes',
      userId: 'user-1',
      templateSlug: 'standard_physical',
    });

    expect(result.ai_signals_computed).toBe(false);
  });

  it('is false for clean non-wildcard task even when AI configured', async () => {
    const { AIClient } = await import('../../src/services/AIClient.js');
    vi.mocked(AIClient.isConfigured).mockReturnValue(true);

    const { db } = await import('../../src/db.js');
    vi.mocked(db.query).mockResolvedValue({ rows: [{ flagged_phrase_counter: [] }], rowCount: 1 } as any);

    const result = await ComplianceGuardianService.evaluate({
      description: 'Help me move some boxes',
      userId: 'user-1',
      templateSlug: 'standard_physical',
    });

    // Score is 0 (clean), not wildcard — AI should NOT run
    expect(result.ai_signals_computed).toBe(false);
  });

  it('is true for wildcard task when AI configured — even if heuristic score is 0', async () => {
    const { AIClient } = await import('../../src/services/AIClient.js');
    vi.mocked(AIClient.isConfigured).mockReturnValue(true);
    vi.mocked(AIClient.callJSON).mockResolvedValue({
      data: { score: 0, rules: [], deception_detected: false, is_genuinely_bizarre: true },
      provider: 'test',
    } as any);

    const { db } = await import('../../src/db.js');
    vi.mocked(db.query).mockResolvedValue({ rows: [{ flagged_phrase_counter: [] }], rowCount: 1 } as any);

    const result = await ComplianceGuardianService.evaluate({
      description: "Scatter my grandfather's ashes at a hiking peak",
      userId: 'user-1',
      templateSlug: 'wildcard_bizarre',
    });

    expect(result.ai_signals_computed).toBe(true);
  });

  it('ai_signals_computed=true enables is_genuinely_bizarre to be true for ashes scatter', async () => {
    const { AIClient } = await import('../../src/services/AIClient.js');
    vi.mocked(AIClient.isConfigured).mockReturnValue(true);
    vi.mocked(AIClient.callJSON).mockResolvedValue({
      data: { score: 0, rules: [], deception_detected: false, is_genuinely_bizarre: true },
      provider: 'test',
    } as any);

    const { db } = await import('../../src/db.js');
    vi.mocked(db.query).mockResolvedValue({ rows: [{ flagged_phrase_counter: [] }], rowCount: 1 } as any);

    const result = await ComplianceGuardianService.evaluate({
      description: "Scatter my grandfather's ashes at a hiking peak",
      userId: 'user-1',
      templateSlug: 'wildcard_bizarre',
    });

    expect(result.is_genuinely_bizarre).toBe(true);
    expect(result.deception_detected).toBe(false);
  });

  it('ai_signals_computed=true enables deception_detected for pretend boyfriend', async () => {
    const { AIClient } = await import('../../src/services/AIClient.js');
    vi.mocked(AIClient.isConfigured).mockReturnValue(true);
    vi.mocked(AIClient.callJSON).mockResolvedValue({
      data: { score: 5, rules: [], deception_detected: true, is_genuinely_bizarre: false },
      provider: 'test',
    } as any);

    const { db } = await import('../../src/db.js');
    vi.mocked(db.query).mockResolvedValue({ rows: [{ flagged_phrase_counter: [] }], rowCount: 1 } as any);

    const result = await ComplianceGuardianService.evaluate({
      description: "Pretend to be my boyfriend at my grandma's party",
      userId: 'user-1',
      templateSlug: 'wildcard_bizarre',
    });

    expect(result.deception_detected).toBe(true);
    expect(result.ai_signals_computed).toBe(true);
  });
});

describe('First-occurrence coded phrase bump', () => {
  beforeEach(() => vi.resetAllMocks());

  it('adds coded_phrase_first_occurrence rule on first match', async () => {
    const { AIClient } = await import('../../src/services/AIClient.js');
    vi.mocked(AIClient.isConfigured).mockReturnValue(false);
    const { db } = await import('../../src/db.js');
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ was_repeat: false }], rowCount: 1 } as any); // atomic UPDATE RETURNING

    const result = await ComplianceGuardianService.evaluate({
      description: 'Deliver for a friend please',
      userId: 'user-1',
      templateSlug: 'standard_physical',
    });

    expect(result.triggeredRules).toContain('coded_phrase_first_occurrence');
    expect(result.score).toBeGreaterThanOrEqual(8);
  });

  it('adds cross_task_pattern_repeat rule on repeat match', async () => {
    const { AIClient } = await import('../../src/services/AIClient.js');
    vi.mocked(AIClient.isConfigured).mockReturnValue(false);
    const { db } = await import('../../src/db.js');
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ was_repeat: true }], rowCount: 1 } as any); // atomic UPDATE RETURNING

    const result = await ComplianceGuardianService.evaluate({
      description: 'I need you to deliver for a friend today',
      userId: 'user-1',
      templateSlug: 'standard_physical',
    });

    expect(result.triggeredRules).toContain('cross_task_pattern_repeat');
    expect(result.score).toBeGreaterThanOrEqual(15);
  });
});
