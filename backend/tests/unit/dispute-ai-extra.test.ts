/**
 * DisputeAIService Extra Unit Tests
 *
 * Covers paths NOT already in dispute-ai.test.ts:
 * - analyzeDispute with AIClient configured + successful AI response
 * - analyzeDispute with AIClient configured but AI fails -> falls back to deterministic
 * - analyzeDispute with AI returning bad fault_assessment sum (normalization path)
 * - analyzeDispute with AI returning SPLIT but no split_ratio (default 50/50 path)
 * - analyzeDispute with AI returning SPLIT with bad ratio sum (normalization)
 * - analyzeDispute with AI returning confidence > 1 or < 0 (clamping)
 * - generateEvidenceRequest with AIClient configured + successful AI response
 * - generateEvidenceRequest with AI returning empty arrays (fallback triggered)
 * - generateEvidenceRequest with AI failing (fallback)
 * - assessEscalation: default escalate path (medium-value with evidence, both parties good history)
 * - assessEscalation: db error
 * - deterministicEvidenceRequest: "damage" keyword
 * - deterministicEvidenceRequest: "incomplete" keyword
 * - deterministicAnalysis: RELEASE path when poster has evidence (counter-evidence present)
 * - gatherDisputeContext: posterHistory row missing (defaults to 0)
 * - gatherDisputeContext: workerHistory row missing (defaults to 0)
 * - logDisputeProposal failure (non-fatal, logged as warning)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => ({ db: { query: vi.fn() } }));

// vi.hoisted() is required because vi.mock() is hoisted above variable declarations
const { mockIsConfigured, mockCallJSON } = vi.hoisted(() => ({
  mockIsConfigured: vi.fn().mockReturnValue(false),
  mockCallJSON: vi.fn(),
}));
vi.mock('../../src/services/AIClient', () => ({
  AIClient: { isConfigured: mockIsConfigured, callJSON: mockCallJSON },
}));
vi.mock('../../src/lib/pii-scrubber', () => ({ scrubPII: (s: string) => s }));
vi.mock('../../src/lib/ai-response-schemas', () => ({
  DisputeAnalysisSchema: {},
  EvidenceRequestSchema: {},
}));
vi.mock('../../src/logger', () => {
  const child = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return { aiLogger: { child }, logger: { child } };
});

import { DisputeAIService } from '../../src/services/DisputeAIService';
import { db } from '../../src/db';

// ============================================================================
// FACTORIES
// ============================================================================
function makeDispute(overrides = {}) {
  return {
    id: 'dispute-1', task_id: 'task-1', escrow_id: 'escrow-1',
    poster_id: 'poster-1', worker_id: 'worker-1',
    initiated_by: 'poster-1', reason: 'quality issue',
    description: 'Work was incomplete', state: 'OPEN',
    ...overrides,
  };
}
function makeTask(overrides = {}) {
  return {
    id: 'task-1', title: 'Clean gutters', description: 'Clean all gutters',
    price: 8000, state: 'COMPLETED',
    completed_at: new Date('2025-01-10'),
    proof_submitted_at: new Date('2025-01-10'),
    ...overrides,
  };
}
function makeEscrow(overrides = {}) {
  return { id: 'escrow-1', amount: 8000, state: 'HELD', ...overrides };
}
function makeEvidence(uploaderId: string, overrides = {}) {
  return {
    id: 'ev-1', dispute_id: 'dispute-1', uploader_user_id: uploaderId,
    content_type: 'image', created_at: new Date(), ...overrides,
  };
}

// Helper to mock all gatherDisputeContext queries + logDisputeProposal query
// Correct order: dispute, task, escrow, evidence, posterHistory, workerHistory, logProposal
function mockContextQueries(opts: {
  dispute?: any; task?: any; escrow?: any; evidence?: any[];
  posterHistory?: any; workerHistory?: any; logFails?: boolean;
} = {}) {
  const dispute = opts.dispute ?? makeDispute();
  const task = opts.task ?? makeTask();
  const escrow = opts.escrow ?? makeEscrow();
  const evidence = opts.evidence ?? [];
  const posterHistory = opts.posterHistory ?? { total_disputes: '0', total_tasks: '5', trust_tier: 2 };
  const workerHistory = opts.workerHistory ?? { total_disputes: '0', total_tasks: '10', trust_tier: 3 };

  // gatherDisputeContext: 6 queries in order
  (db.query as any)
    .mockResolvedValueOnce({ rows: [dispute] })     // Q1: dispute
    .mockResolvedValueOnce({ rows: [task] })         // Q2: task
    .mockResolvedValueOnce({ rows: [escrow] })       // Q3: escrow
    .mockResolvedValueOnce({ rows: evidence })       // Q4: evidence
    .mockResolvedValueOnce({ rows: [posterHistory] }) // Q5: posterHistory
    .mockResolvedValueOnce({ rows: [workerHistory] }); // Q6: workerHistory

  // Q7: logDisputeProposal (non-fatal)
  if (opts.logFails) {
    (db.query as any).mockRejectedValueOnce(new Error('log fail'));
  } else {
    (db.query as any).mockResolvedValueOnce({ rows: [] });
  }
}

beforeEach(() => {
  // Use resetAllMocks to also clear mockResolvedValueOnce queues (clearAllMocks doesn't do this)
  vi.resetAllMocks();
  mockIsConfigured.mockReturnValue(false);
});

// ============================================================================
// analyzeDispute — AI path
// ============================================================================
describe('DisputeAIService.analyzeDispute — AI path', () => {
  it('uses AI analysis when AIClient is configured', async () => {
    mockIsConfigured.mockReturnValue(true);

    const aiAnalysis = {
      summary: 'AI-generated summary',
      fault_assessment: { poster_fault_score: 0.3, worker_fault_score: 0.5, unclear_score: 0.2 },
      recommended_action: 'RELEASE' as const,
      reasoning: 'Worker completed the task',
      confidence: 0.85,
      precedent_signals: ['completed_with_proof'],
      escalation_recommended: false,
    };

    mockCallJSON.mockResolvedValueOnce({ data: aiAnalysis, provider: 'deepseek' });
    mockContextQueries({});

    const result = await DisputeAIService.analyzeDispute('dispute-1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.summary).toBe('AI-generated summary');
      expect(result.data.recommended_action).toBe('RELEASE');
      expect(result.data.confidence).toBe(0.85);
    }
  });

  it('normalizes fault_assessment when scores do not sum to 1.0', async () => {
    mockIsConfigured.mockReturnValue(true);

    const aiAnalysis = {
      summary: 'Test',
      // scores sum to 0.9, not 1.0 — should be normalized
      fault_assessment: { poster_fault_score: 0.4, worker_fault_score: 0.3, unclear_score: 0.2 },
      recommended_action: 'REFUND' as const,
      reasoning: 'Test',
      confidence: 0.7,
      precedent_signals: [],
      escalation_recommended: false,
    };

    mockCallJSON.mockResolvedValueOnce({ data: aiAnalysis, provider: 'deepseek' });
    mockContextQueries({});

    const result = await DisputeAIService.analyzeDispute('dispute-1');
    expect(result.success).toBe(true);
    if (result.success) {
      const fa = result.data.fault_assessment;
      const sum = fa.poster_fault_score + fa.worker_fault_score + fa.unclear_score;
      // After normalization, should sum to approximately 1.0
      expect(Math.abs(sum - 1.0)).toBeLessThan(0.05);
    }
  });

  it('defaults split_ratio to 50/50 when AI returns SPLIT but no split_ratio', async () => {
    mockIsConfigured.mockReturnValue(true);

    const aiAnalysis = {
      summary: 'Split decision',
      fault_assessment: { poster_fault_score: 0.33, worker_fault_score: 0.33, unclear_score: 0.34 },
      recommended_action: 'SPLIT' as const,
      split_ratio: undefined, // missing — should default to 50/50
      reasoning: 'Unclear',
      confidence: 0.5,
      precedent_signals: [],
      escalation_recommended: true,
    };

    mockCallJSON.mockResolvedValueOnce({ data: aiAnalysis, provider: 'deepseek' });
    mockContextQueries({});

    const result = await DisputeAIService.analyzeDispute('dispute-1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.split_ratio).toEqual({ worker_pct: 50, poster_pct: 50 });
    }
  });

  it('normalizes split_ratio when worker_pct + poster_pct != 100', async () => {
    mockIsConfigured.mockReturnValue(true);

    const aiAnalysis = {
      summary: 'Split decision',
      fault_assessment: { poster_fault_score: 0.4, worker_fault_score: 0.4, unclear_score: 0.2 },
      recommended_action: 'SPLIT' as const,
      split_ratio: { worker_pct: 60, poster_pct: 60 }, // sum = 120, not 100
      reasoning: 'Both fault',
      confidence: 0.6,
      precedent_signals: [],
      escalation_recommended: false,
    };

    mockCallJSON.mockResolvedValueOnce({ data: aiAnalysis, provider: 'deepseek' });
    mockContextQueries({});

    const result = await DisputeAIService.analyzeDispute('dispute-1');
    expect(result.success).toBe(true);
    if (result.success) {
      const { worker_pct, poster_pct } = result.data.split_ratio!;
      expect(worker_pct + poster_pct).toBe(100);
    }
  });

  it('clamps confidence to [0, 1] range', async () => {
    mockIsConfigured.mockReturnValue(true);

    const aiAnalysis = {
      summary: 'Test',
      fault_assessment: { poster_fault_score: 0.5, worker_fault_score: 0.3, unclear_score: 0.2 },
      recommended_action: 'RELEASE' as const,
      reasoning: 'Test',
      confidence: 1.5, // > 1 — should be clamped to 1
      precedent_signals: [],
      escalation_recommended: false,
    };

    mockCallJSON.mockResolvedValueOnce({ data: aiAnalysis, provider: 'deepseek' });
    mockContextQueries({});

    const result = await DisputeAIService.analyzeDispute('dispute-1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.confidence).toBeLessThanOrEqual(1.0);
      expect(result.data.confidence).toBeGreaterThanOrEqual(0.0);
    }
  });

  it('falls back to deterministic analysis when AI call fails', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockCallJSON.mockRejectedValueOnce(new Error('AI API timeout'));
    mockContextQueries({
      task: makeTask({ state: 'COMPLETED', proof_submitted_at: new Date() }),
      escrow: makeEscrow({ amount: 4000 }),
      evidence: [], // no counter-evidence -> RELEASE
    });

    const result = await DisputeAIService.analyzeDispute('dispute-1');
    expect(result.success).toBe(true);
    if (result.success) {
      // deterministic fallback for COMPLETED + no counter-evidence + low value
      expect(result.data.recommended_action).toBe('RELEASE');
    }
  });
});

// ============================================================================
// analyzeDispute — deterministic paths not in existing tests
// ============================================================================
describe('DisputeAIService.analyzeDispute — deterministic edge cases', () => {
  it('uses SPLIT default when COMPLETED with proof but has poster counter-evidence', async () => {
    mockContextQueries({
      task: makeTask({ state: 'COMPLETED', proof_submitted_at: new Date() }),
      escrow: makeEscrow({ amount: 4000 }), // low value
      evidence: [makeEvidence('poster-1')], // poster has counter-evidence -> does not trigger RELEASE
    });

    const result = await DisputeAIService.analyzeDispute('dispute-1');
    expect(result.success).toBe(true);
    if (result.success) {
      // Should NOT be RELEASE because poster has counter-evidence
      // Falls through to REFUND or SPLIT depending on other conditions
      expect(['REFUND', 'SPLIT']).toContain(result.data.recommended_action);
    }
  });

  it('returns non-fatal success when logDisputeProposal DB INSERT fails', async () => {
    // Context queries succeed, but 7th query (logDisputeProposal) fails
    mockContextQueries({ logFails: true });

    const result = await DisputeAIService.analyzeDispute('dispute-1');
    // Should still succeed — log failure is non-fatal
    expect(result.success).toBe(true);
  });

  it('handles missing posterHistory row (defaults to 0/0/1)', async () => {
    // Return empty row for poster history
    (db.query as any)
      .mockResolvedValueOnce({ rows: [makeDispute()] })
      .mockResolvedValueOnce({ rows: [makeTask()] })
      .mockResolvedValueOnce({ rows: [makeEscrow({ amount: 8000 })] })
      .mockResolvedValueOnce({ rows: [] })  // evidence
      .mockResolvedValueOnce({ rows: [] })  // posterHistory: empty -> defaults
      .mockResolvedValueOnce({ rows: [{ total_disputes: '0', total_tasks: '5', trust_tier: 2 }] })
      .mockResolvedValueOnce({ rows: [] }); // log

    const result = await DisputeAIService.analyzeDispute('dispute-1');
    expect(result.success).toBe(true);
  });

  it('handles missing workerHistory row (defaults to 0/0/1)', async () => {
    (db.query as any)
      .mockResolvedValueOnce({ rows: [makeDispute()] })
      .mockResolvedValueOnce({ rows: [makeTask()] })
      .mockResolvedValueOnce({ rows: [makeEscrow({ amount: 8000 })] })
      .mockResolvedValueOnce({ rows: [] })  // evidence
      .mockResolvedValueOnce({ rows: [{ total_disputes: '0', total_tasks: '5', trust_tier: 2 }] })
      .mockResolvedValueOnce({ rows: [] })  // workerHistory: empty -> defaults
      .mockResolvedValueOnce({ rows: [] }); // log

    const result = await DisputeAIService.analyzeDispute('dispute-1');
    expect(result.success).toBe(true);
    // With trust_tier defaulting to 1 -> escalation recommended
    if (result.success) {
      expect(result.data.escalation_recommended).toBe(true);
    }
  });
});

// ============================================================================
// generateEvidenceRequest — AI path
// ============================================================================
describe('DisputeAIService.generateEvidenceRequest — AI path', () => {
  it('uses AI questions when AIClient is configured', async () => {
    mockIsConfigured.mockReturnValue(true);

    const aiEvidenceRequest = {
      poster_questions: ['What specifically was wrong?', 'When did you notice the problem?'],
      worker_questions: ['What steps did you take to complete the task?', 'Did you face any obstacles?'],
    };

    mockCallJSON.mockResolvedValueOnce({ data: aiEvidenceRequest, provider: 'groq' });
    mockContextQueries({});

    const result = await DisputeAIService.generateEvidenceRequest('dispute-1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.poster_questions).toHaveLength(2);
      expect(result.data.worker_questions).toHaveLength(2);
    }
  });

  it('falls back to deterministic when AI returns empty poster_questions', async () => {
    mockIsConfigured.mockReturnValue(true);

    // AI returns empty array -> should throw error and fall back
    mockCallJSON.mockResolvedValueOnce({
      data: { poster_questions: [], worker_questions: ['question1'] },
      provider: 'groq',
    });
    mockContextQueries({});

    const result = await DisputeAIService.generateEvidenceRequest('dispute-1');
    expect(result.success).toBe(true);
    if (result.success) {
      // Fallback provides non-empty questions
      expect(result.data.poster_questions.length).toBeGreaterThan(0);
    }
  });

  it('falls back to deterministic when AI returns empty worker_questions', async () => {
    mockIsConfigured.mockReturnValue(true);

    mockCallJSON.mockResolvedValueOnce({
      data: { poster_questions: ['q1'], worker_questions: [] },
      provider: 'groq',
    });
    mockContextQueries({});

    const result = await DisputeAIService.generateEvidenceRequest('dispute-1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.worker_questions.length).toBeGreaterThan(0);
    }
  });

  it('falls back to deterministic when AI callJSON throws', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockCallJSON.mockRejectedValueOnce(new Error('Groq timeout'));
    mockContextQueries({ dispute: makeDispute({ reason: 'damage to property' }) });

    const result = await DisputeAIService.generateEvidenceRequest('dispute-1');
    expect(result.success).toBe(true);
    // damage keyword adds extra questions
    if (result.success) {
      expect(result.data.poster_questions.some((q: string) => /photo|damage|repair/i.test(q))).toBe(true);
    }
  });

  it('adds damage-specific questions when reason contains "damage"', async () => {
    mockContextQueries({ dispute: makeDispute({ reason: 'damage to item during task' }) });

    const result = await DisputeAIService.generateEvidenceRequest('dispute-1');
    expect(result.success).toBe(true);
    if (result.success) {
      const allQuestions = [...result.data.poster_questions, ...result.data.worker_questions];
      expect(allQuestions.some((q: string) => /damage|broken|fragile/i.test(q))).toBe(true);
    }
  });

  it('adds incomplete-specific questions when reason contains "incomplete"', async () => {
    mockContextQueries({ dispute: makeDispute({ reason: 'task was incomplete and not done' }) });

    const result = await DisputeAIService.generateEvidenceRequest('dispute-1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.poster_questions.length).toBeGreaterThanOrEqual(4);
    }
  });
});

// ============================================================================
// assessEscalation — additional deterministic paths
// ============================================================================
describe('DisputeAIService.assessEscalation — additional paths', () => {
  it('escalates by default for moderate-value dispute with both parties good history', async () => {
    // Amount between LOW_VALUE ($50) and HIGH_VALUE ($200), good histories, has evidence
    mockContextQueries({
      escrow: makeEscrow({ amount: 10000 }), // $100 — between thresholds
      evidence: [makeEvidence('poster-1'), makeEvidence('worker-1')],
      posterHistory: { total_disputes: '1', total_tasks: '10', trust_tier: 3 },
      workerHistory: { total_disputes: '1', total_tasks: '20', trust_tier: 3 },
    });

    const result = await DisputeAIService.assessEscalation('dispute-1');
    expect(result.success).toBe(true);
    if (result.success) {
      // Default escalate for moderate value
      expect(result.data.shouldEscalate).toBe(true);
      expect(result.data.urgency).toBe('medium');
    }
  });

  it('escalates when worker has high dispute history (> 3)', async () => {
    mockContextQueries({
      escrow: makeEscrow({ amount: 5000 }),
      posterHistory: { total_disputes: '0', total_tasks: '10', trust_tier: 3 },
      workerHistory: { total_disputes: '5', total_tasks: '20', trust_tier: 3 }, // 5 > 3
    });

    const result = await DisputeAIService.assessEscalation('dispute-1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.shouldEscalate).toBe(true);
      expect(result.data.reason).toContain('dispute history');
    }
  });

  it('escalates when worker has low trust tier (tier 1)', async () => {
    mockContextQueries({
      escrow: makeEscrow({ amount: 5000 }),
      posterHistory: { total_disputes: '0', total_tasks: '10', trust_tier: 2 },
      workerHistory: { total_disputes: '1', total_tasks: '5', trust_tier: 1 }, // tier 1 -> escalate
    });

    const result = await DisputeAIService.assessEscalation('dispute-1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.shouldEscalate).toBe(true);
      expect(result.data.reason).toContain('trust tier');
    }
  });

  it('returns error when gatherDisputeContext db throws', async () => {
    (db.query as any).mockRejectedValueOnce(new Error('DB down'));

    const result = await DisputeAIService.assessEscalation('dispute-1');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(['ESCALATION_ASSESSMENT_FAILED', 'DB_ERROR']).toContain(result.error.code);
    }
  });
});

// ============================================================================
// generateEvidenceRequest — NOT_FOUND for task and escrow
// ============================================================================
describe('DisputeAIService.generateEvidenceRequest — context failures', () => {
  it('returns NOT_FOUND when task for dispute is not found', async () => {
    (db.query as any)
      .mockResolvedValueOnce({ rows: [makeDispute()] }) // dispute found
      .mockResolvedValueOnce({ rows: [] });             // task NOT found
    const result = await DisputeAIService.generateEvidenceRequest('d1');
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('returns NOT_FOUND when escrow for dispute is not found', async () => {
    (db.query as any)
      .mockResolvedValueOnce({ rows: [makeDispute()] })
      .mockResolvedValueOnce({ rows: [makeTask()] })
      .mockResolvedValueOnce({ rows: [] }); // escrow NOT found
    const result = await DisputeAIService.generateEvidenceRequest('d1');
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
  });
});
