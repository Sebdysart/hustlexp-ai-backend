import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComplianceGuardianService, FLAGGED_PATTERNS } from '../../src/services/ComplianceGuardianService.js';

vi.mock('../../src/services/AIClient.js', () => ({
  AIClient: {
    isConfigured: () => false,
    callJSON: vi.fn(),
  },
}));

vi.mock('../../src/db.js', () => ({
  db: { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
}));

describe('FLAGGED_PATTERNS', () => {
  it('contains exactly 12 patterns', () => {
    expect(FLAGGED_PATTERNS).toHaveLength(12);
  });

  it('all patterns are lowercase normalized', () => {
    for (const p of FLAGGED_PATTERNS) {
      expect(p).toBe(p.toLowerCase().trim());
    }
  });

  it('includes "no questions asked"', () => {
    expect(FLAGGED_PATTERNS).toContain('no questions asked');
  });
});

describe('_normalizeDescription', () => {
  it('lowercases and strips punctuation', () => {
    const result = ComplianceGuardianService._normalizeDescription('No Questions Asked!');
    expect(result).toBe('no questions asked');
  });

  it('collapses multiple spaces', () => {
    const result = ComplianceGuardianService._normalizeDescription('deliver  for  a  friend');
    expect(result).toBe('deliver for a friend');
  });

  it('strips apostrophes', () => {
    const result = ComplianceGuardianService._normalizeDescription("don't ask questions");
    expect(result).toBe('dont ask questions');
  });
});

describe('_codeLevelPatternMatch', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns matched: false for clean description', async () => {
    const mockDb = await import('../../src/db.js');
    vi.spyOn(mockDb.db, 'query').mockResolvedValue({ rows: [{ flagged_phrase_counter: [] }], rowCount: 0 } as any);

    const result = await ComplianceGuardianService._codeLevelPatternMatch(
      'Help me move some boxes to my new apartment',
      'user-123'
    );
    expect(result.matched).toBe(false);
    expect(result.isRepeat).toBe(false);
  });

  it('returns matched: true for flagged phrase', async () => {
    const mockDb = await import('../../src/db.js');
    vi.spyOn(mockDb.db, 'query')
      .mockResolvedValueOnce({ rows: [{ flagged_phrase_counter: [] }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    const result = await ComplianceGuardianService._codeLevelPatternMatch(
      'Deliver this package, no questions asked',
      'user-123'
    );
    expect(result.matched).toBe(true);
    expect(result.matchedPhrase).toBe('no questions asked');
  });

  it('returns isRepeat: true when phrase already in counter', async () => {
    const mockDb = await import('../../src/db.js');
    const recentEntry = {
      phrase: 'no questions asked',
      matched_at: new Date().toISOString(),
    };
    vi.spyOn(mockDb.db, 'query')
      .mockResolvedValueOnce({ rows: [{ flagged_phrase_counter: [recentEntry] }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    const result = await ComplianceGuardianService._codeLevelPatternMatch(
      'Drop off this bag, no questions asked please',
      'user-123'
    );
    expect(result.isRepeat).toBe(true);
  });

  it('prunes entries older than 30 days', async () => {
    const mockDb = await import('../../src/db.js');
    const oldEntry = {
      phrase: 'no questions asked',
      matched_at: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
    };
    let savedCounter: unknown;
    vi.spyOn(mockDb.db, 'query')
      .mockResolvedValueOnce({ rows: [{ flagged_phrase_counter: [oldEntry] }], rowCount: 1 } as any)
      .mockImplementationOnce(async (_sql: string, params: unknown[]) => {
        savedCounter = JSON.parse(params[0] as string);
        return { rows: [], rowCount: 1 };
      });

    await ComplianceGuardianService._codeLevelPatternMatch(
      'Please deliver no questions asked',
      'user-123'
    );

    // Old entry pruned, only new entry saved
    expect((savedCounter as any[]).length).toBe(1);
    expect((savedCounter as any[])[0].matched_at).not.toBe(oldEntry.matched_at);
  });
});
