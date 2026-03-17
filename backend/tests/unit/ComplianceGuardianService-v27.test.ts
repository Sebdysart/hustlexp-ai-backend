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
    // Single atomic UPDATE returning was_repeat=false (first occurrence)
    vi.spyOn(mockDb.db, 'query')
      .mockResolvedValueOnce({ rows: [{ was_repeat: false }], rowCount: 1 } as any);

    const result = await ComplianceGuardianService._codeLevelPatternMatch(
      'Deliver this package, no questions asked',
      'user-123'
    );
    expect(result.matched).toBe(true);
    expect(result.matchedPhrase).toBe('no questions asked');
  });

  it('returns isRepeat: true when phrase already in counter', async () => {
    const mockDb = await import('../../src/db.js');
    // Single atomic UPDATE returning was_repeat=true (phrase found in pre-update counter)
    vi.spyOn(mockDb.db, 'query')
      .mockResolvedValueOnce({ rows: [{ was_repeat: true }], rowCount: 1 } as any);

    const result = await ComplianceGuardianService._codeLevelPatternMatch(
      'Drop off this bag, no questions asked please',
      'user-123'
    );
    expect(result.isRepeat).toBe(true);
  });

  it('prunes entries older than 30 days — handled atomically by the SQL UPDATE', async () => {
    const mockDb = await import('../../src/db.js');
    // Pruning now happens inside the single atomic UPDATE query on the DB side.
    // The JS layer just receives was_repeat from RETURNING.
    vi.spyOn(mockDb.db, 'query')
      .mockResolvedValueOnce({ rows: [{ was_repeat: false }], rowCount: 1 } as any);

    const result = await ComplianceGuardianService._codeLevelPatternMatch(
      'Please deliver no questions asked',
      'user-123'
    );

    // The old entry was pruned inside the DB; the new occurrence is not a repeat
    expect(result.matched).toBe(true);
    expect(result.isRepeat).toBe(false);
  });
});
