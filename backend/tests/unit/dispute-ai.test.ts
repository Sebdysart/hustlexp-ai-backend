/**
 * DisputeAIService Unit Tests
 *
 * Tests analyzeDispute, generateEvidenceRequest, and assessEscalation
 * using deterministic fallbacks (AIClient.isConfigured() = false).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => ({ db: { query: vi.fn() } }));
vi.mock('../../src/services/AIClient', () => ({
  AIClient: { isConfigured: vi.fn().mockReturnValue(false), callJSON: vi.fn() },
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
// HELPER FACTORIES
// ============================================================================

function makeDispute(overrides = {}) {
  return {
    id: 'dispute-1', task_id: 'task-1', escrow_id: 'escrow-1',
    poster_id: 'poster-1', worker_id: 'worker-1',
    initiated_by: 'poster-1', reason: 'quality issue',
    description: 'Work was not completed properly', state: 'OPEN',
    ...overrides,
  };
}

function makeTask(overrides = {}) {
  return {
    id: 'task-1', title: 'Fix plumbing', description: 'Fix kitchen sink',
    price: 8000, state: 'COMPLETED', completed_at: new Date('2025-01-10'),
    proof_submitted_at: new Date('2025-01-10'), ...overrides,
  };
}

function makeEscrow(overrides = {}) {
  return { id: 'escrow-1', amount: 8000, state: 'HELD', ...overrides };
}

function makeEvidence(uploaderId: string) {
  return {
    id: 'ev-1', dispute_id: 'dispute-1', uploader_user_id: uploaderId,
    content_type: 'image', created_at: new Date(),
  };
}

function mockContextQueries(opts: {
  dispute?: any; task?: any; escrow?: any; evidence?: any[];
  posterHistory?: any; workerHistory?: any;
}) {
  const dispute = opts.dispute || makeDispute();
  const task = opts.task || makeTask();
  const escrow = opts.escrow || makeEscrow();
  const evidence = opts.evidence || [];
  const posterHistory = opts.posterHistory || { total_disputes: '0', total_tasks: '5', trust_tier: 2 };
  const workerHistory = opts.workerHistory || { total_disputes: '0', total_tasks: '10', trust_tier: 3 };

  (db.query as any)
    .mockResolvedValueOnce({ rows: [dispute] })        // Q1: dispute
    .mockResolvedValueOnce({ rows: [task] })           // Q2: task
    .mockResolvedValueOnce({ rows: [escrow] })         // Q3: escrow
    .mockResolvedValueOnce({ rows: evidence })         // Q4: evidence
    .mockResolvedValueOnce({ rows: [posterHistory] })  // Q5: poster history
    .mockResolvedValueOnce({ rows: [workerHistory] })  // Q6: worker history
    .mockResolvedValueOnce({ rows: [] });              // Q7: logDisputeProposal INSERT
}

// ============================================================================
// TESTS
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DisputeAIService.analyzeDispute', () => {
  describe('gatherDisputeContext failures', () => {
    it('returns NOT_FOUND when dispute does not exist', async () => {
      (db.query as any).mockResolvedValueOnce({ rows: [] });
      const result = await DisputeAIService.analyzeDispute('bad-id');
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NOT_FOUND');
    });

    it('returns NOT_FOUND when task does not exist for the dispute', async () => {
      (db.query as any)
        .mockResolvedValueOnce({ rows: [makeDispute()] }) // dispute found
        .mockResolvedValueOnce({ rows: [] });             // task NOT found
      const result = await DisputeAIService.analyzeDispute('d1');
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NOT_FOUND');
    });

    it('returns NOT_FOUND when escrow does not exist', async () => {
      (db.query as any)
        .mockResolvedValueOnce({ rows: [makeDispute()] })
        .mockResolvedValueOnce({ rows: [makeTask()] })
        .mockResolvedValueOnce({ rows: [] }); // escrow NOT found
      const result = await DisputeAIService.analyzeDispute('d1');
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NOT_FOUND');
    });
  });

  describe('deterministic analysis paths', () => {
    it('recommends RELEASE when task COMPLETED with proof and no counter-evidence (low value)', async () => {
      mockContextQueries({
        task: makeTask({ state: 'COMPLETED', proof_submitted_at: new Date() }),
        escrow: makeEscrow({ amount: 4000 }), // < $50
        evidence: [], // no evidence
      });
      const result = await DisputeAIService.analyzeDispute('d1');
      expect(result.success).toBe(true);
      expect(result.data.recommended_action).toBe('RELEASE');
    });

    it('recommends REFUND when poster initiated with evidence, no worker evidence (low value)', async () => {
      const dispute = makeDispute({ initiated_by: 'poster-1', poster_id: 'poster-1' });
      mockContextQueries({
        dispute,
        task: makeTask({ state: 'OPEN', proof_submitted_at: null }), // not completed
        escrow: makeEscrow({ amount: 3000 }), // < $50
        evidence: [makeEvidence('poster-1')], // only poster evidence
      });
      const result = await DisputeAIService.analyzeDispute('d1');
      expect(result.success).toBe(true);
      expect(result.data.recommended_action).toBe('REFUND');
    });

    it('recommends SPLIT and escalation for high-value dispute (> $200)', async () => {
      mockContextQueries({
        escrow: makeEscrow({ amount: 25000 }), // $250 > $200 threshold
      });
      const result = await DisputeAIService.analyzeDispute('d1');
      expect(result.success).toBe(true);
      expect(result.data.recommended_action).toBe('SPLIT');
      expect(result.data.escalation_recommended).toBe(true);
      expect(result.data.split_ratio).toBeDefined();
      expect(result.data.split_ratio!.worker_pct + result.data.split_ratio!.poster_pct).toBe(100);
    });

    it('recommends SPLIT as default when no clear signal', async () => {
      const dispute = makeDispute({ initiated_by: 'worker-1' });
      mockContextQueries({
        dispute,
        task: makeTask({ state: 'OPEN', proof_submitted_at: null }),
        escrow: makeEscrow({ amount: 10000 }), // $100
        evidence: [makeEvidence('poster-1'), makeEvidence('worker-1')], // both parties
      });
      const result = await DisputeAIService.analyzeDispute('d1');
      expect(result.success).toBe(true);
      expect(result.data.recommended_action).toBe('SPLIT');
    });

    it('fault_assessment is provided for all analyses', async () => {
      mockContextQueries({});
      const result = await DisputeAIService.analyzeDispute('d1');
      expect(result.success).toBe(true);
      const fa = result.data.fault_assessment;
      expect(typeof fa.poster_fault_score).toBe('number');
      expect(typeof fa.worker_fault_score).toBe('number');
      expect(typeof fa.unclear_score).toBe('number');
    });

    it('returns error when db throws during context gathering', async () => {
      (db.query as any).mockRejectedValueOnce(new Error('DB crash'));
      const result = await DisputeAIService.analyzeDispute('d1');
      expect(result.success).toBe(false);
      expect(['DISPUTE_ANALYSIS_FAILED', 'DB_ERROR']).toContain(result.error.code);
    });
  });
});

describe('DisputeAIService.generateEvidenceRequest', () => {
  it('generates evidence request with both poster and worker questions', async () => {
    mockContextQueries({});
    const result = await DisputeAIService.generateEvidenceRequest('d1');
    expect(result.success).toBe(true);
    expect(Array.isArray(result.data.poster_questions)).toBe(true);
    expect(result.data.poster_questions.length).toBeGreaterThan(0);
    expect(Array.isArray(result.data.worker_questions)).toBe(true);
    expect(result.data.worker_questions.length).toBeGreaterThan(0);
  });

  it('adds quality-specific questions when reason contains "quality"', async () => {
    mockContextQueries({ dispute: makeDispute({ reason: 'quality issue - incomplete work' }) });
    const result = await DisputeAIService.generateEvidenceRequest('d1');
    expect(result.success).toBe(true);
    // Should have extra quality-specific questions beyond base 3
    expect(result.data.poster_questions.length).toBeGreaterThanOrEqual(4);
  });

  it('adds no-show specific questions when reason contains "no-show"', async () => {
    mockContextQueries({ dispute: makeDispute({ reason: 'no-show worker did not arrive' }) });
    const result = await DisputeAIService.generateEvidenceRequest('d1');
    expect(result.success).toBe(true);
    expect(result.data.poster_questions.some((q: string) => /time|location|arrive/i.test(q))).toBe(true);
  });

  it('returns NOT_FOUND when dispute does not exist', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [] });
    const result = await DisputeAIService.generateEvidenceRequest('bad-id');
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
  });
});

describe('DisputeAIService.assessEscalation', () => {
  it('recommends escalation for high-value dispute (> $200)', async () => {
    mockContextQueries({ escrow: makeEscrow({ amount: 25000 }) });
    const result = await DisputeAIService.assessEscalation('d1');
    expect(result.success).toBe(true);
    expect(result.data.shouldEscalate).toBe(true);
    expect(result.data.urgency).toBe('high');
  });

  it('recommends escalation when parties have high dispute history (> 3)', async () => {
    mockContextQueries({
      escrow: makeEscrow({ amount: 5000 }),
      posterHistory: { total_disputes: '4', total_tasks: '10', trust_tier: 2 }, // 4 > 3
    });
    const result = await DisputeAIService.assessEscalation('d1');
    expect(result.success).toBe(true);
    expect(result.data.shouldEscalate).toBe(true);
    expect(result.data.urgency).toBe('medium');
  });

  it('recommends escalation when trust tier <= 1', async () => {
    mockContextQueries({
      escrow: makeEscrow({ amount: 5000 }),
      posterHistory: { total_disputes: '1', total_tasks: '2', trust_tier: 1 },
    });
    const result = await DisputeAIService.assessEscalation('d1');
    expect(result.success).toBe(true);
    expect(result.data.shouldEscalate).toBe(true);
  });

  it('does NOT escalate when no evidence and recommends evidence request', async () => {
    mockContextQueries({
      escrow: makeEscrow({ amount: 5000 }),
      evidence: [],
      posterHistory: { total_disputes: '0', total_tasks: '5', trust_tier: 2 },
      workerHistory: { total_disputes: '0', total_tasks: '10', trust_tier: 3 },
    });
    const result = await DisputeAIService.assessEscalation('d1');
    expect(result.success).toBe(true);
    expect(result.data.shouldEscalate).toBe(false);
    expect(result.data.urgency).toBe('low');
  });

  it('does NOT escalate for low-value dispute with evidence', async () => {
    mockContextQueries({
      escrow: makeEscrow({ amount: 3000 }), // < $50
      evidence: [makeEvidence('poster-1')],
      posterHistory: { total_disputes: '0', total_tasks: '5', trust_tier: 2 },
      workerHistory: { total_disputes: '0', total_tasks: '10', trust_tier: 3 },
    });
    const result = await DisputeAIService.assessEscalation('d1');
    expect(result.success).toBe(true);
    expect(result.data.shouldEscalate).toBe(false);
  });

  it('returns NOT_FOUND when dispute does not exist for escalation check', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [] });
    const result = await DisputeAIService.assessEscalation('bad-id');
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
  });
});
