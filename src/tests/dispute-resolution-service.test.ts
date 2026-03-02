/**
 * DisputeResolutionService — Comprehensive Unit Tests
 *
 * Covers:
 *   - initiateDispute: happy path, invalid state, unauthorized user, existing dispute,
 *     short reason, no hustler assigned
 *   - addEvidence: happy path, wrong phase (INV-DISP-7), unauthorized user
 *   - resolveWithAI: happy path (high confidence), low confidence recommendation,
 *     AI failure fallback (INV-DISP-3), wrong status
 *   - resolveWithJury: happy path, insufficient jurors (INV-DISP-4),
 *     invalid state transition, jury selection
 *   - submitJuryVote: happy path, not a juror, already voted, short reasoning,
 *     all votes tallied → auto jury_decided with majority outcome
 *   - finalizeDispute: poster wins (refund), hustler wins (release), split,
 *     admin override, invalid state, money engine error
 *   - getDispute: returns full dispute, returns null for missing id
 *   - listDisputes: various filter combinations
 *   - getJuryDuties: happy path
 */

// ---------------------------------------------------------------------------
// vi.mock() declarations must be at the top, before any imports
// ---------------------------------------------------------------------------

vi.mock('../db/index.js', () => ({
  sql: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  serviceLogger: {
    child: () => ({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

vi.mock('../ai/router.js', () => ({
  routedGenerate: vi.fn(),
}));

vi.mock('../services/StripeMoneyEngine.js', () => ({
  StripeMoneyEngine: {
    handle: vi.fn(),
    holdForDispute: vi.fn(),
    releaseToWorker: vi.fn(),
    refundToPoster: vi.fn(),
  },
}));

// Mock TaskService — imported by DisputeResolutionService from the same services/ directory
vi.mock('../services/TaskService.js', () => ({
  TaskService: {
    getTask: vi.fn(),
  },
}));

// Mock UserService
vi.mock('../services/UserService.js', () => ({
  UserService: {
    getStripeConnectId: vi.fn(),
  },
}));

// Mock BetaMetricsService
vi.mock('../services/BetaMetricsService.js', () => ({
  BetaMetricsService: {
    disputeOpened: vi.fn(),
    disputeResolved: vi.fn(),
  },
}));

// Mock uuid so we get deterministic IDs
vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-uuid-1234'),
}));

// Mock ulidx
vi.mock('ulidx', () => ({
  ulid: vi.fn(() => 'test-ulid-5678'),
}));

// Mock utils/errors
vi.mock('../utils/errors.js', () => ({
  getErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql, transaction } from '../db/index.js';
import { routedGenerate } from '../ai/router.js';
import { StripeMoneyEngine } from '../services/StripeMoneyEngine.js';
import { TaskService } from '../services/TaskService.js';
import { UserService } from '../services/UserService.js';
import { DisputeResolutionService } from '../services/DisputeResolutionService.js';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const TASK_ID = 'task-abc-123';
const POSTER_ID = 'poster-user-1';
const HUSTLER_ID = 'hustler-user-2';
const DISPUTE_ID = 'test-uuid-1234';
const JUROR_1 = 'juror-user-a';
const JUROR_2 = 'juror-user-b';
const JUROR_3 = 'juror-user-c';

/** A minimal task object returned by TaskService.getTask */
const makeTask = (overrides?: Partial<{
  status: string;
  clientId: string;
  assignedHustlerId: string;
  recommendedPrice: number;
}>) => ({
  id: TASK_ID,
  title: 'Fix the faucet',
  description: 'Replace the kitchen faucet',
  category: 'plumbing',
  status: 'in_progress',
  clientId: POSTER_ID,
  assignedHustlerId: HUSTLER_ID,
  recommendedPrice: 10000, // $100.00 in cents? Actually it's dollars internally; code uses * 100
  ...overrides,
});

/** A dispute DB row returned by sql`` calls */
const makeDisputeRow = (overrides?: Record<string, unknown>) => ({
  id: DISPUTE_ID,
  task_id: TASK_ID,
  initiator_id: POSTER_ID,
  initiator_role: 'poster',
  poster_id: POSTER_ID,
  hustler_id: HUSTLER_ID,
  reason: 'The work was not completed properly',
  status: 'evidence_collection',
  ai_outcome: null,
  ai_confidence: null,
  ai_reasoning: null,
  ai_risk_flags: null,
  ai_split_percent: null,
  jury_member_ids: null,
  jury_outcome: null,
  final_outcome: null,
  refund_amount_cents: null,
  release_amount_cents: null,
  created_at: new Date('2024-01-01T00:00:00Z'),
  updated_at: new Date('2024-01-01T00:00:00Z'),
  finalized_at: null,
  ...overrides,
});

// ---------------------------------------------------------------------------
// beforeEach: reset all mocks
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();

  // By default, transaction() just calls the callback with sql as the tx
  vi.mocked(transaction).mockImplementation(async (fn: any) => fn(sql));
});

// ===========================================================================
// initiateDispute
// ===========================================================================

describe('DisputeResolutionService.initiateDispute', () => {
  it('creates a dispute successfully when poster initiates', async () => {
    vi.mocked(TaskService.getTask).mockResolvedValue(makeTask() as any);

    // existing active dispute check → none found
    vi.mocked(sql).mockResolvedValueOnce([]); // no existing dispute
    // transaction calls: INSERT dispute, INSERT evidence × 1
    vi.mocked(sql).mockResolvedValue([]);
    // escrow money_state_lock query
    vi.mocked(sql).mockResolvedValueOnce([]); // no money state
    // task status update
    vi.mocked(sql).mockResolvedValue([]);

    const result = await DisputeResolutionService.initiateDispute(
      TASK_ID,
      POSTER_ID,
      'The work was not completed properly',
      [{ type: 'text', content: 'The faucet is still leaking' }]
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain('Dispute initiated');
    expect(result.disputeId).toBe(DISPUTE_ID);
    expect(result.resolution?.status).toBe('evidence_collection');
    expect(result.resolution?.initiatorRole).toBe('poster');
    expect(result.resolution?.posterId).toBe(POSTER_ID);
    expect(result.resolution?.hustlerId).toBe(HUSTLER_ID);
  });

  it('creates a dispute successfully when hustler initiates', async () => {
    vi.mocked(TaskService.getTask).mockResolvedValue(makeTask() as any);
    vi.mocked(sql).mockResolvedValueOnce([]); // no existing dispute
    vi.mocked(sql).mockResolvedValue([]);

    const result = await DisputeResolutionService.initiateDispute(
      TASK_ID,
      HUSTLER_ID,
      'The poster is refusing to pay for completed work',
      []
    );

    expect(result.success).toBe(true);
    expect(result.resolution?.initiatorRole).toBe('hustler');
  });

  it('returns error when task is not found', async () => {
    vi.mocked(TaskService.getTask).mockResolvedValue(null as any);

    const result = await DisputeResolutionService.initiateDispute(
      TASK_ID,
      POSTER_ID,
      'Some reason long enough here',
      []
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe('Task not found');
  });

  it('returns error when task status is not disputable (open)', async () => {
    vi.mocked(TaskService.getTask).mockResolvedValue(makeTask({ status: 'open' }) as any);

    const result = await DisputeResolutionService.initiateDispute(
      TASK_ID,
      POSTER_ID,
      'Some reason long enough here',
      []
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain("'open' state cannot be disputed");
  });

  it('returns error when task status is cancelled', async () => {
    vi.mocked(TaskService.getTask).mockResolvedValue(makeTask({ status: 'cancelled' }) as any);

    const result = await DisputeResolutionService.initiateDispute(
      TASK_ID,
      POSTER_ID,
      'Some reason long enough here',
      []
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('cannot be disputed');
  });

  it('INV-DISP-1: returns error when initiator is not a task participant', async () => {
    vi.mocked(TaskService.getTask).mockResolvedValue(makeTask() as any);

    const result = await DisputeResolutionService.initiateDispute(
      TASK_ID,
      'random-user-not-involved',
      'Some reason long enough here',
      []
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe('Only task participants can initiate disputes');
  });

  it('returns error when task has no assigned hustler', async () => {
    vi.mocked(TaskService.getTask).mockResolvedValue(
      makeTask({ assignedHustlerId: null as any }) as any
    );

    const result = await DisputeResolutionService.initiateDispute(
      TASK_ID,
      POSTER_ID,
      'Some reason long enough here',
      []
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe('Cannot dispute a task with no assigned hustler');
  });

  it('INV-DISP-2: returns error when active dispute already exists for the task', async () => {
    vi.mocked(TaskService.getTask).mockResolvedValue(makeTask() as any);
    // Existing active dispute found
    vi.mocked(sql).mockResolvedValueOnce([{ id: 'existing-dispute-id' }]);

    const result = await DisputeResolutionService.initiateDispute(
      TASK_ID,
      POSTER_ID,
      'Some reason long enough here',
      []
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('active dispute already exists');
    expect(result.disputeId).toBe('existing-dispute-id');
  });

  it('returns error when reason is too short (less than 10 chars)', async () => {
    vi.mocked(TaskService.getTask).mockResolvedValue(makeTask() as any);
    vi.mocked(sql).mockResolvedValueOnce([]); // no existing dispute

    const result = await DisputeResolutionService.initiateDispute(
      TASK_ID,
      POSTER_ID,
      'Short',
      []
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('at least 10 characters');
  });

  it('returns error on internal exception', async () => {
    vi.mocked(TaskService.getTask).mockRejectedValue(new Error('DB connection lost'));

    const result = await DisputeResolutionService.initiateDispute(
      TASK_ID,
      POSTER_ID,
      'Some reason long enough here',
      []
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('Internal error');
  });

  it('handles escrow flagging when money state is held', async () => {
    vi.mocked(TaskService.getTask).mockResolvedValue(makeTask() as any);
    vi.mocked(sql).mockResolvedValueOnce([]); // no existing dispute
    // transaction calls
    vi.mocked(sql).mockResolvedValue([]);
    // money_state_lock query — escrow is held
    vi.mocked(sql).mockResolvedValueOnce([
      { current_state: 'held', amount_cents: 10000 },
    ]);
    // UPDATE money_state_lock
    vi.mocked(sql).mockResolvedValueOnce([]);
    // UPDATE tasks
    vi.mocked(sql).mockResolvedValueOnce([]);

    const result = await DisputeResolutionService.initiateDispute(
      TASK_ID,
      POSTER_ID,
      'The work was not completed properly',
      []
    );

    expect(result.success).toBe(true);
  });
});

// ===========================================================================
// addEvidence
// ===========================================================================

describe('DisputeResolutionService.addEvidence', () => {
  it('adds evidence successfully during evidence_collection phase', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeDisputeRow()]); // get dispute
    vi.mocked(sql).mockResolvedValue([]); // insert evidence calls

    const result = await DisputeResolutionService.addEvidence(
      DISPUTE_ID,
      POSTER_ID,
      [
        { type: 'photo', content: 'https://example.com/photo.jpg', description: 'Photo of damage' },
        { type: 'text', content: 'I paid for work that was not done' },
      ]
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain('2 evidence item(s) added');
    expect(result.disputeId).toBe(DISPUTE_ID);
  });

  it('allows hustler to add evidence', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeDisputeRow()]); // get dispute
    vi.mocked(sql).mockResolvedValue([]);

    const result = await DisputeResolutionService.addEvidence(
      DISPUTE_ID,
      HUSTLER_ID,
      [{ type: 'screenshot', content: 'https://example.com/work-completed.png' }]
    );

    expect(result.success).toBe(true);
  });

  it('returns error when dispute is not found', async () => {
    vi.mocked(sql).mockResolvedValueOnce([]); // no dispute

    const result = await DisputeResolutionService.addEvidence(
      'nonexistent-dispute',
      POSTER_ID,
      [{ type: 'text', content: 'some evidence' }]
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe('Dispute not found');
  });

  it('INV-DISP-7: rejects evidence when not in evidence_collection phase', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      makeDisputeRow({ status: 'under_ai_review' }),
    ]);

    const result = await DisputeResolutionService.addEvidence(
      DISPUTE_ID,
      POSTER_ID,
      [{ type: 'text', content: 'late evidence submission' }]
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe('Evidence collection period has closed');
  });

  it('rejects evidence from non-participants', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeDisputeRow()]);

    const result = await DisputeResolutionService.addEvidence(
      DISPUTE_ID,
      'outsider-user',
      [{ type: 'text', content: 'unrelated evidence' }]
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe('Only dispute participants can submit evidence');
  });

  it('returns error on internal exception', async () => {
    vi.mocked(sql).mockRejectedValue(new Error('network error'));

    const result = await DisputeResolutionService.addEvidence(
      DISPUTE_ID,
      POSTER_ID,
      [{ type: 'text', content: 'evidence' }]
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('Internal error');
  });
});

// ===========================================================================
// resolveWithAI
// ===========================================================================

describe('DisputeResolutionService.resolveWithAI', () => {
  const makeAiResult = (outcome: string, confidence: number) => ({
    content: JSON.stringify({
      outcome,
      confidence,
      reasoning: 'The evidence clearly shows the work was incomplete.',
      riskFlags: [],
    }),
  });

  it('returns AI recommendation with high confidence (hustler wins)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeDisputeRow()]); // get dispute
    vi.mocked(sql).mockResolvedValueOnce([]); // update status to under_ai_review
    vi.mocked(TaskService.getTask).mockResolvedValue(makeTask() as any);
    vi.mocked(sql).mockResolvedValueOnce([]); // get evidence
    vi.mocked(routedGenerate).mockResolvedValue(makeAiResult('hustler', 0.92) as any);
    vi.mocked(sql).mockResolvedValueOnce([]); // update with recommendation

    const result = await DisputeResolutionService.resolveWithAI(DISPUTE_ID);

    expect(result.success).toBe(true);
    expect(result.message).toContain('AI analysis complete with recommendation');
    expect(result.resolution?.aiRecommendation?.outcome).toBe('hustler');
    expect(result.resolution?.aiRecommendation?.confidence).toBe(0.92);
    expect(result.resolution?.status).toBe('ai_recommended');
  });

  it('recommends jury review when AI confidence is below threshold (< 0.80)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeDisputeRow()]);
    vi.mocked(sql).mockResolvedValueOnce([]);
    vi.mocked(TaskService.getTask).mockResolvedValue(makeTask() as any);
    vi.mocked(sql).mockResolvedValueOnce([]);
    vi.mocked(routedGenerate).mockResolvedValue(makeAiResult('split', 0.55) as any);
    vi.mocked(sql).mockResolvedValueOnce([]);

    const result = await DisputeResolutionService.resolveWithAI(DISPUTE_ID);

    expect(result.success).toBe(true);
    expect(result.message).toContain('confidence is low');
    expect(result.message).toContain('Jury review recommended');
  });

  it('INV-DISP-3: falls back to split/jury on AI parse failure', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeDisputeRow()]);
    vi.mocked(sql).mockResolvedValueOnce([]);
    vi.mocked(TaskService.getTask).mockResolvedValue(makeTask() as any);
    vi.mocked(sql).mockResolvedValueOnce([]);
    // Return invalid JSON from AI
    vi.mocked(routedGenerate).mockResolvedValue({ content: 'not-valid-json' } as any);
    vi.mocked(sql).mockResolvedValueOnce([]);

    const result = await DisputeResolutionService.resolveWithAI(DISPUTE_ID);

    expect(result.success).toBe(true);
    // The fallback sets confidence=0, so jury is recommended
    expect(result.resolution?.aiRecommendation?.confidence).toBe(0);
    expect(result.resolution?.aiRecommendation?.riskFlags).toContain('ai_analysis_failed');
  });

  it('INV-DISP-3: falls back when AI returns invalid outcome value', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeDisputeRow()]);
    vi.mocked(sql).mockResolvedValueOnce([]);
    vi.mocked(TaskService.getTask).mockResolvedValue(makeTask() as any);
    vi.mocked(sql).mockResolvedValueOnce([]);
    vi.mocked(routedGenerate).mockResolvedValue({
      content: JSON.stringify({ outcome: 'bogus', confidence: 0.95, reasoning: 'test', riskFlags: [] }),
    } as any);
    vi.mocked(sql).mockResolvedValueOnce([]);

    const result = await DisputeResolutionService.resolveWithAI(DISPUTE_ID);

    expect(result.success).toBe(true);
    expect(result.resolution?.aiRecommendation?.riskFlags).toContain('ai_analysis_failed');
  });

  it('returns error when dispute is not found', async () => {
    vi.mocked(sql).mockResolvedValueOnce([]);

    const result = await DisputeResolutionService.resolveWithAI('nonexistent');

    expect(result.success).toBe(false);
    expect(result.message).toBe('Dispute not found');
  });

  it('returns error when dispute status is not evidence_collection', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      makeDisputeRow({ status: 'jury_deliberation' }),
    ]);

    const result = await DisputeResolutionService.resolveWithAI(DISPUTE_ID);

    expect(result.success).toBe(false);
    expect(result.message).toContain("Cannot start AI review in 'jury_deliberation' status");
  });

  it('handles AI split recommendation with split percent', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeDisputeRow()]);
    vi.mocked(sql).mockResolvedValueOnce([]);
    vi.mocked(TaskService.getTask).mockResolvedValue(makeTask() as any);
    vi.mocked(sql).mockResolvedValueOnce([]);
    vi.mocked(routedGenerate).mockResolvedValue({
      content: JSON.stringify({
        outcome: 'split',
        confidence: 0.85,
        reasoning: 'Both parties share responsibility.',
        suggestedSplitPercent: 60,
        riskFlags: ['unclear_scope'],
      }),
    } as any);
    vi.mocked(sql).mockResolvedValueOnce([]);

    const result = await DisputeResolutionService.resolveWithAI(DISPUTE_ID);

    expect(result.success).toBe(true);
    expect(result.resolution?.aiRecommendation?.outcome).toBe('split');
    expect(result.resolution?.aiRecommendation?.suggestedSplitPercent).toBe(60);
  });

  it('returns error on internal exception', async () => {
    vi.mocked(sql).mockRejectedValue(new Error('DB timeout'));

    const result = await DisputeResolutionService.resolveWithAI(DISPUTE_ID);

    expect(result.success).toBe(false);
    expect(result.message).toContain('Internal error');
  });
});

// ===========================================================================
// resolveWithJury
// ===========================================================================

describe('DisputeResolutionService.resolveWithJury', () => {
  const makeJurors = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ id: `juror-user-${String.fromCharCode(97 + i)}` }));

  it('selects jury and starts deliberation when enough eligible jurors exist', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeDisputeRow()]); // get dispute
    vi.mocked(sql).mockResolvedValueOnce(makeJurors(6)); // eligible jurors (> JURY_SIZE * 2 / enough)
    // transaction: update + 3 inserts
    vi.mocked(sql).mockResolvedValue([]);

    const result = await DisputeResolutionService.resolveWithJury(DISPUTE_ID);

    expect(result.success).toBe(true);
    expect(result.message).toContain('Jury of 3 selected');
    expect(result.resolution?.status).toBe('jury_deliberation');
    expect(result.resolution?.juryMembers).toHaveLength(3);
  });

  it('INV-DISP-4: returns error when not enough eligible jurors (fewer than 3)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeDisputeRow()]);
    vi.mocked(sql).mockResolvedValueOnce(makeJurors(2)); // only 2 jurors

    const result = await DisputeResolutionService.resolveWithJury(DISPUTE_ID);

    expect(result.success).toBe(false);
    expect(result.message).toContain('Not enough eligible jurors');
    expect(result.message).toContain('Found 2, need 3');
  });

  it('returns error when dispute is not found', async () => {
    vi.mocked(sql).mockResolvedValueOnce([]);

    const result = await DisputeResolutionService.resolveWithJury('nonexistent');

    expect(result.success).toBe(false);
    expect(result.message).toBe('Dispute not found');
  });

  it('returns error when state transition is invalid (e.g. finalized)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      makeDisputeRow({ status: 'finalized' }),
    ]);

    const result = await DisputeResolutionService.resolveWithJury(DISPUTE_ID);

    expect(result.success).toBe(false);
    expect(result.message).toContain("Cannot start jury selection in 'finalized' status");
  });

  it('allows jury selection from ai_recommended state (low confidence path)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      makeDisputeRow({ status: 'ai_recommended' }),
    ]);
    vi.mocked(sql).mockResolvedValueOnce(makeJurors(6));
    vi.mocked(sql).mockResolvedValue([]);

    const result = await DisputeResolutionService.resolveWithJury(DISPUTE_ID);

    expect(result.success).toBe(true);
    expect(result.resolution?.status).toBe('jury_deliberation');
  });

  it('returns error on internal exception', async () => {
    vi.mocked(sql).mockRejectedValue(new Error('network error'));

    const result = await DisputeResolutionService.resolveWithJury(DISPUTE_ID);

    expect(result.success).toBe(false);
    expect(result.message).toContain('Internal error');
  });
});

// ===========================================================================
// submitJuryVote
// ===========================================================================

describe('DisputeResolutionService.submitJuryVote', () => {
  const makeJuryRecord = (overrides?: Record<string, unknown>) => ({
    dispute_id: DISPUTE_ID,
    juror_id: JUROR_1,
    status: 'pending',
    vote: null,
    reasoning: null,
    voted_at: null,
    ...overrides,
  });

  it('records a vote and returns partial count when not all have voted', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeDisputeRow({ status: 'jury_deliberation' })]); // dispute
    vi.mocked(sql).mockResolvedValueOnce([makeJuryRecord()]); // jury record check
    vi.mocked(sql).mockResolvedValueOnce([]); // UPDATE vote
    // vote count — only 1 of 3 voted
    vi.mocked(sql).mockResolvedValueOnce([{ total: 3, voted: 1 }]);

    const result = await DisputeResolutionService.submitJuryVote(
      DISPUTE_ID,
      JUROR_1,
      'hustler',
      'The hustler clearly completed all required tasks as evidenced by the photos.'
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain('1/3 jurors have voted');
  });

  it('auto-decides when all 3 jurors vote and hustler gets 2/3 majority', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeDisputeRow({ status: 'jury_deliberation' })]);
    vi.mocked(sql).mockResolvedValueOnce([makeJuryRecord({ juror_id: JUROR_3 })]);
    vi.mocked(sql).mockResolvedValueOnce([]); // UPDATE vote
    vi.mocked(sql).mockResolvedValueOnce([{ total: 3, voted: 3 }]); // all voted
    // Vote tally: 2 hustler, 1 poster
    vi.mocked(sql).mockResolvedValueOnce([
      { vote: 'hustler', count: 2 },
      { vote: 'poster', count: 1 },
    ]);
    vi.mocked(sql).mockResolvedValueOnce([]); // UPDATE to jury_decided

    const result = await DisputeResolutionService.submitJuryVote(
      DISPUTE_ID,
      JUROR_3,
      'hustler',
      'I reviewed all the evidence and the hustler completed the job satisfactorily.'
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain('Jury decision: hustler');
    expect(result.resolution?.status).toBe('jury_decided');
    expect(result.resolution?.finalOutcome).toBe('hustler');
  });

  it('auto-decides with poster outcome when poster gets 2/3 majority', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeDisputeRow({ status: 'jury_deliberation' })]);
    vi.mocked(sql).mockResolvedValueOnce([makeJuryRecord({ juror_id: JUROR_3 })]);
    vi.mocked(sql).mockResolvedValueOnce([]);
    vi.mocked(sql).mockResolvedValueOnce([{ total: 3, voted: 3 }]);
    vi.mocked(sql).mockResolvedValueOnce([
      { vote: 'poster', count: 3 },
    ]);
    vi.mocked(sql).mockResolvedValueOnce([]);

    const result = await DisputeResolutionService.submitJuryVote(
      DISPUTE_ID,
      JUROR_3,
      'poster',
      'The work was clearly not done to the agreed standard based on evidence.'
    );

    expect(result.success).toBe(true);
    expect(result.resolution?.finalOutcome).toBe('poster');
  });

  it('INV-DISP-5: results in split when votes are tied (1-1-... edge case mapped to no 2/3)', async () => {
    // With JURY_SIZE=3, if 1 poster and 2 hustler votes... actually 2 hustler wins.
    // A tie scenario would require all 3 to vote differently — but vote choices are only poster/hustler.
    // A 1 poster / 1 hustler / ... scenario isn't possible with just 2 options.
    // However the code has: if posterVotes >= 2 → poster, elseif hustlerVotes >= 2 → hustler, else split
    // So we test the "else split" branch: somehow 1 each (only 2 voted total despite voted:3)
    vi.mocked(sql).mockResolvedValueOnce([makeDisputeRow({ status: 'jury_deliberation' })]);
    vi.mocked(sql).mockResolvedValueOnce([makeJuryRecord({ juror_id: JUROR_3 })]);
    vi.mocked(sql).mockResolvedValueOnce([]);
    vi.mocked(sql).mockResolvedValueOnce([{ total: 3, voted: 3 }]);
    // Return counts where neither side has 2: e.g., only 1 each (edge case if a vote got lost)
    vi.mocked(sql).mockResolvedValueOnce([
      { vote: 'poster', count: 1 },
      { vote: 'hustler', count: 1 },
    ]);
    vi.mocked(sql).mockResolvedValueOnce([]);

    const result = await DisputeResolutionService.submitJuryVote(
      DISPUTE_ID,
      JUROR_3,
      'poster',
      'The evidence is ambiguous and I cannot make a clear determination here.'
    );

    expect(result.success).toBe(true);
    expect(result.resolution?.finalOutcome).toBe('split');
  });

  it('returns error when dispute is not found', async () => {
    vi.mocked(sql).mockResolvedValueOnce([]);

    const result = await DisputeResolutionService.submitJuryVote(
      'nonexistent',
      JUROR_1,
      'hustler',
      'Detailed reasoning here that meets the minimum length requirement easily.'
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe('Dispute not found');
  });

  it('returns error when dispute is not in jury_deliberation status', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      makeDisputeRow({ status: 'evidence_collection' }),
    ]);

    const result = await DisputeResolutionService.submitJuryVote(
      DISPUTE_ID,
      JUROR_1,
      'poster',
      'Detailed reasoning about the dispute resolution here.'
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe('Jury deliberation is not active for this dispute');
  });

  it('returns error when user is not a juror for this dispute', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeDisputeRow({ status: 'jury_deliberation' })]);
    vi.mocked(sql).mockResolvedValueOnce([]); // no jury record found

    const result = await DisputeResolutionService.submitJuryVote(
      DISPUTE_ID,
      'random-user',
      'hustler',
      'Detailed reasoning that is long enough to pass validation.'
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe('You are not a juror for this dispute');
  });

  it('returns error when juror has already voted', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeDisputeRow({ status: 'jury_deliberation' })]);
    vi.mocked(sql).mockResolvedValueOnce([
      makeJuryRecord({ status: 'voted', vote: 'hustler' }),
    ]);

    const result = await DisputeResolutionService.submitJuryVote(
      DISPUTE_ID,
      JUROR_1,
      'poster', // trying to change vote
      'Detailed reasoning that is long enough to pass validation.'
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe('You have already voted on this dispute');
  });

  it('returns error when reasoning is too short (less than 20 chars)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeDisputeRow({ status: 'jury_deliberation' })]);
    vi.mocked(sql).mockResolvedValueOnce([makeJuryRecord()]);

    const result = await DisputeResolutionService.submitJuryVote(
      DISPUTE_ID,
      JUROR_1,
      'hustler',
      'Too short'
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('at least 20 characters');
  });

  it('returns error on internal exception', async () => {
    vi.mocked(sql).mockRejectedValue(new Error('DB error'));

    const result = await DisputeResolutionService.submitJuryVote(
      DISPUTE_ID,
      JUROR_1,
      'hustler',
      'Detailed reasoning that is long enough to pass validation.'
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('Internal error');
  });
});

// ===========================================================================
// finalizeDispute
// ===========================================================================

describe('DisputeResolutionService.finalizeDispute', () => {
  const makeMoneyState = (amountCents = 10000) => ({
    current_state: 'held',
    amount_cents: amountCents,
  });

  it('poster wins: triggers refund to poster (full amount)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      makeDisputeRow({ status: 'ai_recommended', ai_outcome: 'poster' }),
    ]);
    vi.mocked(TaskService.getTask).mockResolvedValue(makeTask() as any);
    vi.mocked(sql).mockResolvedValueOnce([makeMoneyState(10000)]); // money state
    vi.mocked(StripeMoneyEngine.handle).mockResolvedValue({} as any);
    vi.mocked(sql).mockResolvedValueOnce([]); // UPDATE dispute to finalized
    vi.mocked(sql).mockResolvedValueOnce([]); // UPDATE legacy disputes table

    const result = await DisputeResolutionService.finalizeDispute(DISPUTE_ID);

    expect(result.success).toBe(true);
    expect(result.message).toContain('Refund');
    expect(result.resolution?.finalOutcome).toBe('poster');
    expect(result.resolution?.refundAmountCents).toBe(10000);
    expect(result.resolution?.releaseAmountCents).toBe(0);
    expect(StripeMoneyEngine.handle).toHaveBeenCalledWith(
      TASK_ID,
      'REFUND_ESCROW',
      expect.objectContaining({ refundAmountCents: 10000 }),
      expect.any(Object)
    );
  });

  it('hustler wins: triggers release payout to hustler (full amount)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      makeDisputeRow({ status: 'ai_recommended', ai_outcome: 'hustler' }),
    ]);
    vi.mocked(TaskService.getTask).mockResolvedValue(makeTask() as any);
    vi.mocked(sql).mockResolvedValueOnce([makeMoneyState(10000)]);
    vi.mocked(UserService.getStripeConnectId).mockResolvedValue('acct_stripe_hustler' as any);
    vi.mocked(StripeMoneyEngine.handle).mockResolvedValue({} as any);
    vi.mocked(sql).mockResolvedValueOnce([]);
    vi.mocked(sql).mockResolvedValueOnce([]);

    const result = await DisputeResolutionService.finalizeDispute(DISPUTE_ID);

    expect(result.success).toBe(true);
    expect(result.message).toContain('Payout');
    expect(result.resolution?.finalOutcome).toBe('hustler');
    expect(result.resolution?.releaseAmountCents).toBe(10000);
    expect(result.resolution?.refundAmountCents).toBe(0);
    expect(StripeMoneyEngine.handle).toHaveBeenCalledWith(
      TASK_ID,
      'RELEASE_PAYOUT',
      expect.objectContaining({
        payoutAmountCents: 10000,
        hustlerStripeAccountId: 'acct_stripe_hustler',
      }),
      expect.any(Object)
    );
  });

  it('split outcome: 50/50 default split distributes amounts correctly', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      makeDisputeRow({ status: 'ai_recommended', ai_outcome: 'split', ai_split_percent: null }),
    ]);
    vi.mocked(TaskService.getTask).mockResolvedValue(makeTask() as any);
    vi.mocked(sql).mockResolvedValueOnce([makeMoneyState(10000)]);
    vi.mocked(StripeMoneyEngine.handle).mockResolvedValue({} as any);
    vi.mocked(sql).mockResolvedValueOnce([]);
    vi.mocked(sql).mockResolvedValueOnce([]);

    const result = await DisputeResolutionService.finalizeDispute(DISPUTE_ID);

    expect(result.success).toBe(true);
    expect(result.message).toContain('Split');
    expect(result.resolution?.finalOutcome).toBe('split');
    // 50% to hustler = 5000, 50% refund = 5000
    expect(result.resolution?.releaseAmountCents).toBe(5000);
    expect(result.resolution?.refundAmountCents).toBe(5000);
  });

  it('split outcome with AI-recommended 60% to hustler', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      makeDisputeRow({ status: 'ai_recommended', ai_outcome: 'split', ai_split_percent: 60 }),
    ]);
    vi.mocked(TaskService.getTask).mockResolvedValue(makeTask() as any);
    vi.mocked(sql).mockResolvedValueOnce([makeMoneyState(10000)]);
    vi.mocked(StripeMoneyEngine.handle).mockResolvedValue({} as any);
    vi.mocked(sql).mockResolvedValueOnce([]);
    vi.mocked(sql).mockResolvedValueOnce([]);

    const result = await DisputeResolutionService.finalizeDispute(DISPUTE_ID);

    expect(result.success).toBe(true);
    // 60% to hustler = 6000 release, 40% refund = 4000
    expect(result.resolution?.releaseAmountCents).toBe(6000);
    expect(result.resolution?.refundAmountCents).toBe(4000);
  });

  it('finalizes from jury_decided state using jury_outcome', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      makeDisputeRow({ status: 'jury_decided', jury_outcome: 'hustler' }),
    ]);
    vi.mocked(TaskService.getTask).mockResolvedValue(makeTask() as any);
    vi.mocked(sql).mockResolvedValueOnce([makeMoneyState(5000)]);
    vi.mocked(UserService.getStripeConnectId).mockResolvedValue('acct_xyz' as any);
    vi.mocked(StripeMoneyEngine.handle).mockResolvedValue({} as any);
    vi.mocked(sql).mockResolvedValueOnce([]);
    vi.mocked(sql).mockResolvedValueOnce([]);

    const result = await DisputeResolutionService.finalizeDispute(DISPUTE_ID);

    expect(result.success).toBe(true);
    expect(result.resolution?.finalOutcome).toBe('hustler');
  });

  it('admin override changes the outcome', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      makeDisputeRow({ status: 'ai_recommended', ai_outcome: 'hustler' }),
    ]);
    vi.mocked(TaskService.getTask).mockResolvedValue(makeTask() as any);
    vi.mocked(sql).mockResolvedValueOnce([makeMoneyState(8000)]);
    vi.mocked(StripeMoneyEngine.handle).mockResolvedValue({} as any);
    vi.mocked(sql).mockResolvedValueOnce([]);
    vi.mocked(sql).mockResolvedValueOnce([]);

    const result = await DisputeResolutionService.finalizeDispute(
      DISPUTE_ID,
      'admin-user-001',
      'poster' // admin overrides to poster wins
    );

    expect(result.success).toBe(true);
    expect(result.resolution?.finalOutcome).toBe('poster');
    expect(result.resolution?.refundAmountCents).toBe(8000);
  });

  it('returns error when dispute is not found', async () => {
    vi.mocked(sql).mockResolvedValueOnce([]);

    const result = await DisputeResolutionService.finalizeDispute(DISPUTE_ID);

    expect(result.success).toBe(false);
    expect(result.message).toBe('Dispute not found');
  });

  it('returns error when state is not finalizable (e.g. evidence_collection)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      makeDisputeRow({ status: 'evidence_collection' }),
    ]);

    const result = await DisputeResolutionService.finalizeDispute(DISPUTE_ID);

    expect(result.success).toBe(false);
    expect(result.message).toContain("Cannot finalize dispute in 'evidence_collection' status");
  });

  it('returns error when task is not found', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      makeDisputeRow({ status: 'ai_recommended', ai_outcome: 'poster' }),
    ]);
    vi.mocked(TaskService.getTask).mockResolvedValue(null as any);

    const result = await DisputeResolutionService.finalizeDispute(DISPUTE_ID);

    expect(result.success).toBe(false);
    expect(result.message).toBe('Associated task not found');
  });

  it('returns failure result when money engine throws (stores outcome but marks error)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      makeDisputeRow({ status: 'ai_recommended', ai_outcome: 'poster' }),
    ]);
    vi.mocked(TaskService.getTask).mockResolvedValue(makeTask() as any);
    vi.mocked(sql).mockResolvedValueOnce([makeMoneyState(10000)]);
    vi.mocked(StripeMoneyEngine.handle).mockRejectedValue(new Error('Stripe API error'));
    vi.mocked(sql).mockResolvedValueOnce([]); // UPDATE with money_engine_error

    const result = await DisputeResolutionService.finalizeDispute(DISPUTE_ID);

    expect(result.success).toBe(false);
    expect(result.message).toContain('money transfer failed');
    expect(result.message).toContain('Admin intervention');
  });

  it('uses task recommendedPrice when no money_state_lock row exists', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      makeDisputeRow({ status: 'ai_recommended', ai_outcome: 'poster' }),
    ]);
    // Task with recommendedPrice = 150 (dollars)
    vi.mocked(TaskService.getTask).mockResolvedValue(makeTask({ recommendedPrice: 150 }) as any);
    vi.mocked(sql).mockResolvedValueOnce([]); // no money_state_lock row
    vi.mocked(StripeMoneyEngine.handle).mockResolvedValue({} as any);
    vi.mocked(sql).mockResolvedValueOnce([]);
    vi.mocked(sql).mockResolvedValueOnce([]);

    const result = await DisputeResolutionService.finalizeDispute(DISPUTE_ID);

    expect(result.success).toBe(true);
    // recommendedPrice * 100 = 150 * 100 = 15000 cents
    expect(result.resolution?.refundAmountCents).toBe(15000);
  });

  it('handles hustler without Stripe Connect ID gracefully (no payout call)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      makeDisputeRow({ status: 'ai_recommended', ai_outcome: 'hustler' }),
    ]);
    vi.mocked(TaskService.getTask).mockResolvedValue(makeTask() as any);
    vi.mocked(sql).mockResolvedValueOnce([makeMoneyState(10000)]);
    // Hustler has no Stripe Connect ID
    vi.mocked(UserService.getStripeConnectId).mockRejectedValue(new Error('No connect account'));
    vi.mocked(sql).mockResolvedValueOnce([]);
    vi.mocked(sql).mockResolvedValueOnce([]);

    const result = await DisputeResolutionService.finalizeDispute(DISPUTE_ID);

    // Even without Stripe ID, the dispute record is finalized
    expect(result.success).toBe(true);
    expect(StripeMoneyEngine.handle).not.toHaveBeenCalled();
  });

  it('returns error on internal exception', async () => {
    vi.mocked(sql).mockRejectedValue(new Error('DB connection lost'));

    const result = await DisputeResolutionService.finalizeDispute(DISPUTE_ID);

    expect(result.success).toBe(false);
    expect(result.message).toContain('Internal error');
  });
});

// ===========================================================================
// getDispute
// ===========================================================================

describe('DisputeResolutionService.getDispute', () => {
  it('returns full dispute details with evidence and jury votes', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      makeDisputeRow({
        status: 'jury_deliberation',
        jury_member_ids: [JUROR_1, JUROR_2, JUROR_3],
        ai_outcome: 'hustler',
        ai_confidence: 0.85,
        ai_reasoning: 'Work was done.',
        ai_risk_flags: [],
      }),
    ]);

    // Evidence
    vi.mocked(sql).mockResolvedValueOnce([
      {
        id: 'ev-1',
        dispute_id: DISPUTE_ID,
        submitted_by: POSTER_ID,
        evidence_type: 'photo',
        content: 'https://example.com/photo.jpg',
        description: 'Damage photo',
        created_at: '2024-01-01T00:00:00Z',
      },
    ]);

    // Jury votes
    vi.mocked(sql).mockResolvedValueOnce([
      {
        juror_id: JUROR_1,
        vote: 'hustler',
        reasoning: 'Work completed.',
        voted_at: '2024-01-02T00:00:00Z',
      },
    ]);

    const dispute = await DisputeResolutionService.getDispute(DISPUTE_ID);

    expect(dispute).not.toBeNull();
    expect(dispute!.id).toBe(DISPUTE_ID);
    expect(dispute!.taskId).toBe(TASK_ID);
    expect(dispute!.status).toBe('jury_deliberation');
    expect(dispute!.evidence).toHaveLength(1);
    expect(dispute!.evidence[0].evidenceType).toBe('photo');
    expect(dispute!.juryVotes).toHaveLength(1);
    expect(dispute!.juryVotes[0].jurorId).toBe(JUROR_1);
    expect(dispute!.juryVotes[0].vote).toBe('hustler');
    expect(dispute!.aiRecommendation?.outcome).toBe('hustler');
    expect(dispute!.juryMembers).toEqual([JUROR_1, JUROR_2, JUROR_3]);
  });

  it('returns null when dispute is not found', async () => {
    vi.mocked(sql).mockResolvedValueOnce([]);

    const dispute = await DisputeResolutionService.getDispute('nonexistent-id');

    expect(dispute).toBeNull();
  });

  it('returns dispute with no AI recommendation when ai_outcome is null', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeDisputeRow()]);
    vi.mocked(sql).mockResolvedValueOnce([]); // no evidence
    vi.mocked(sql).mockResolvedValueOnce([]); // no jury votes

    const dispute = await DisputeResolutionService.getDispute(DISPUTE_ID);

    expect(dispute!.aiRecommendation).toBeNull();
    expect(dispute!.juryVotes).toHaveLength(0);
    expect(dispute!.evidence).toHaveLength(0);
  });

  it('maps finalized dispute fields correctly', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      makeDisputeRow({
        status: 'finalized',
        final_outcome: 'poster',
        refund_amount_cents: 10000,
        release_amount_cents: 0,
        finalized_at: new Date('2024-01-10T12:00:00Z'),
      }),
    ]);
    vi.mocked(sql).mockResolvedValueOnce([]);
    vi.mocked(sql).mockResolvedValueOnce([]);

    const dispute = await DisputeResolutionService.getDispute(DISPUTE_ID);

    expect(dispute!.status).toBe('finalized');
    expect(dispute!.finalOutcome).toBe('poster');
    expect(dispute!.refundAmountCents).toBe(10000);
    expect(dispute!.releaseAmountCents).toBe(0);
    expect(dispute!.finalizedAt).toBeInstanceOf(Date);
  });
});

// ===========================================================================
// listDisputes
// ===========================================================================

describe('DisputeResolutionService.listDisputes', () => {
  const makeDisputeListRow = () => ({
    id: DISPUTE_ID,
    task_id: TASK_ID,
    initiator_id: POSTER_ID,
    initiator_role: 'poster',
    poster_id: POSTER_ID,
    hustler_id: HUSTLER_ID,
    reason: 'Work was incomplete',
    status: 'evidence_collection',
    ai_outcome: null,
    ai_confidence: null,
    ai_reasoning: null,
    ai_risk_flags: null,
    ai_split_percent: null,
    jury_member_ids: null,
    final_outcome: null,
    refund_amount_cents: null,
    release_amount_cents: null,
    created_at: new Date('2024-01-01'),
    updated_at: new Date('2024-01-01'),
    finalized_at: null,
  });

  it('returns all disputes when no filters provided', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeDisputeListRow()]);

    const disputes = await DisputeResolutionService.listDisputes();

    expect(disputes).toHaveLength(1);
    expect(disputes[0].id).toBe(DISPUTE_ID);
    expect(disputes[0].evidence).toEqual([]);
    expect(disputes[0].juryVotes).toEqual([]);
  });

  it('filters by status only', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeDisputeListRow()]);

    const disputes = await DisputeResolutionService.listDisputes({ status: 'evidence_collection' });

    expect(disputes).toHaveLength(1);
  });

  it('filters by taskId', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeDisputeListRow()]);

    const disputes = await DisputeResolutionService.listDisputes({ taskId: TASK_ID });

    expect(disputes).toHaveLength(1);
  });

  it('filters by userId', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeDisputeListRow()]);

    const disputes = await DisputeResolutionService.listDisputes({ userId: POSTER_ID });

    expect(disputes).toHaveLength(1);
  });

  it('filters by status and userId combined', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeDisputeListRow()]);

    const disputes = await DisputeResolutionService.listDisputes({
      status: 'evidence_collection',
      userId: POSTER_ID,
    });

    expect(disputes).toHaveLength(1);
  });

  it('returns empty list when no disputes match', async () => {
    vi.mocked(sql).mockResolvedValueOnce([]);

    const disputes = await DisputeResolutionService.listDisputes({ status: 'finalized' });

    expect(disputes).toHaveLength(0);
  });

  it('respects limit parameter', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      ...makeDisputeListRow(),
      id: `dispute-${i}`,
    }));
    vi.mocked(sql).mockResolvedValueOnce(rows);

    const disputes = await DisputeResolutionService.listDisputes({ limit: 5 });

    expect(disputes).toHaveLength(5);
  });

  it('maps AI recommendation when present', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      {
        ...makeDisputeListRow(),
        status: 'ai_recommended',
        ai_outcome: 'hustler',
        ai_confidence: 0.9,
        ai_reasoning: 'Evidence is clear.',
        ai_risk_flags: ['possible_fraud'],
      },
    ]);

    const disputes = await DisputeResolutionService.listDisputes();

    expect(disputes[0].aiRecommendation).not.toBeNull();
    expect(disputes[0].aiRecommendation?.outcome).toBe('hustler');
    expect(disputes[0].aiRecommendation?.confidence).toBe(0.9);
    expect(disputes[0].aiRecommendation?.riskFlags).toContain('possible_fraud');
  });
});

// ===========================================================================
// getJuryDuties
// ===========================================================================

describe('DisputeResolutionService.getJuryDuties', () => {
  it('returns pending jury assignments for a user', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      {
        dispute_id: DISPUTE_ID,
        assigned_at: '2024-01-05T00:00:00Z',
        jury_deliberation_deadline: '2024-01-07T00:00:00Z',
      },
      {
        dispute_id: 'dispute-2',
        assigned_at: '2024-01-06T00:00:00Z',
        jury_deliberation_deadline: '2024-01-08T00:00:00Z',
      },
    ]);

    const duties = await DisputeResolutionService.getJuryDuties(JUROR_1);

    expect(duties).toHaveLength(2);
    expect(duties[0].disputeId).toBe(DISPUTE_ID);
    expect(duties[0].assignedAt).toBeInstanceOf(Date);
    expect(duties[0].deadline).toBeInstanceOf(Date);
    expect(duties[1].disputeId).toBe('dispute-2');
  });

  it('returns empty array when user has no jury duties', async () => {
    vi.mocked(sql).mockResolvedValueOnce([]);

    const duties = await DisputeResolutionService.getJuryDuties('user-with-no-duties');

    expect(duties).toHaveLength(0);
  });

  it('handles null jury deliberation deadline', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      {
        dispute_id: DISPUTE_ID,
        assigned_at: '2024-01-05T00:00:00Z',
        jury_deliberation_deadline: null,
      },
    ]);

    const duties = await DisputeResolutionService.getJuryDuties(JUROR_1);

    expect(duties[0].deadline).toBeNull();
  });
});

// ===========================================================================
// State Machine Transition Tests
// ===========================================================================

describe('State machine: valid transitions', () => {
  it('cannot add evidence after evidence_collection phase (state machine protection)', async () => {
    for (const status of ['under_ai_review', 'ai_recommended', 'jury_deliberation', 'jury_decided', 'finalized'] as const) {
      vi.mocked(sql).mockResolvedValueOnce([makeDisputeRow({ status })]);

      const result = await DisputeResolutionService.addEvidence(
        DISPUTE_ID,
        POSTER_ID,
        [{ type: 'text', content: 'late evidence' }]
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('Evidence collection period has closed');
    }
  });

  it('cannot resolve with AI if not in evidence_collection state', async () => {
    for (const status of ['ai_recommended', 'jury_deliberation', 'finalized'] as const) {
      vi.mocked(sql).mockResolvedValueOnce([makeDisputeRow({ status })]);

      const result = await DisputeResolutionService.resolveWithAI(DISPUTE_ID);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Cannot start AI review');
    }
  });

  it('cannot finalize from open or evidence_collection or under_ai_review', async () => {
    for (const status of ['open', 'evidence_collection', 'under_ai_review', 'jury_selection', 'jury_deliberation'] as const) {
      vi.mocked(sql).mockResolvedValueOnce([makeDisputeRow({ status })]);

      const result = await DisputeResolutionService.finalizeDispute(DISPUTE_ID);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Cannot finalize dispute');
    }
  });

  it('cannot start jury from finalized state', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeDisputeRow({ status: 'finalized' })]);

    const result = await DisputeResolutionService.resolveWithJury(DISPUTE_ID);

    expect(result.success).toBe(false);
    expect(result.message).toContain("Cannot start jury selection in 'finalized' status");
  });
});
