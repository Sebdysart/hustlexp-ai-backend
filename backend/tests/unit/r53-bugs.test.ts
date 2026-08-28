/**
 * R53 Bug Tests — T53-4 and T53-8
 *
 * T53-4: Matchmaker IDOR — explainMatch must verify the requesting user
 *        is a participant (poster or assigned worker) of the task before
 *        returning any task detail.
 *
 * T53-8: Proof review role check gap — ProofService.review() must
 *        verify that the reviewer is the task's poster, not just any
 *        authenticated user.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declare before imports
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => {
  const queryFn = vi.fn();
  return {
    db: {
      query: queryFn,
      transaction: vi.fn((fn: (q: typeof queryFn) => Promise<unknown>) => fn(queryFn)),
    },
    isInvariantViolation: vi.fn(() => false),
    isUniqueViolation: vi.fn(() => false),
    getErrorMessage: vi.fn((code: string) => `Error ${code}`),
  };
});

vi.mock('../../src/auth/firebase', () => ({
  firebaseAuth: { verifyIdToken: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  taskLogger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
}));

vi.mock('../../src/services/MatchmakerAIService', () => ({
  MatchmakerAIService: {
    rankCandidates: vi.fn(),
    explainMatch: vi.fn(),
    suggestPrice: vi.fn(),
  },
}));

// ProofService dependencies
vi.mock('../../src/services/BiometricVerificationService', () => ({
  BiometricVerificationService: { analyzeProofSubmission: vi.fn() },
}));
vi.mock('../../src/services/LogisticsAIService', () => ({
  LogisticsAIService: { validateGPSProof: vi.fn() },
}));
vi.mock('../../src/services/JudgeAIService', () => ({
  JudgeAIService: {
    synthesizeVerdict: vi.fn(),
    logVerdict: vi.fn().mockResolvedValue({ success: true, data: undefined }),
  },
}));
vi.mock('../../src/services/PhotoVerificationService', () => ({
  PhotoVerificationService: { compareBeforeAfter: vi.fn() },
}));

const mockRedisSet = vi.fn().mockResolvedValue('OK');
const mockRedisDel = vi.fn().mockResolvedValue(1);
vi.mock('../../src/cache/redis', () => ({
  getClient: vi.fn(() => ({ set: mockRedisSet, del: mockRedisDel })),
}));

vi.mock('../../src/lib/outbox-helpers', () => ({
  writeToOutbox: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { matchmakerRouter } from '../../src/routers/matchmaker';
import { MatchmakerAIService } from '../../src/services/MatchmakerAIService';
import { ProofService } from '../../src/services/ProofService';

const mockDb = vi.mocked(db);
const mockMatchmaker = vi.mocked(MatchmakerAIService);

// ---------------------------------------------------------------------------
// UUIDs
// ---------------------------------------------------------------------------

const CALLER_UUID = '00000000-0000-0000-0000-000000000001';
const TASK_UUID   = '00000000-0000-0000-0000-000000000002';
const WORKER_UUID = '00000000-0000-0000-0000-000000000003';
const POSTER_UUID = '00000000-0000-0000-0000-000000000004';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMatchmakerCaller(userId = CALLER_UUID) {
  return matchmakerRouter.createCaller({
    user: { id: userId, email: 'user@test.com', full_name: 'User', firebase_uid: 'fb-1' } as any,
    firebaseUid: 'fb-1',
  });
}

// TASK_ROW now includes poster_id and worker_id for T53-4 fix
const TASK_ROW_WITH_PARTICIPANTS = {
  id: TASK_UUID,
  title: 'Fix plumbing',
  description: 'Leaky faucet',
  category: 'home_repair',
  location_text: 'Chicago',
  price: 5000,
  requirements: 'Experience needed',
  poster_id: POSTER_UUID,
  worker_id: WORKER_UUID,
};

const WORKER_PROFILE_ROW = {
  id: WORKER_UUID,
  trust_tier: 2,
  completed_tasks: 5,
  completion_rate: 0.9,
  average_rating: 4.2,
};

function makeProof(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proof-1',
    task_id: TASK_UUID,
    submitter_id: WORKER_UUID,
    state: 'SUBMITTED',
    description: 'Done',
    submitted_at: new Date(),
    reviewed_by: null,
    reviewed_at: null,
    rejection_reason: null,
    created_at: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// beforeEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
  // Restore redis advisory lock defaults
  mockRedisSet.mockResolvedValue('OK');
  mockRedisDel.mockResolvedValue(1);
  // Default: transaction delegates to query fn
  vi.mocked(db.transaction).mockImplementation(
    async (fn: (q: typeof db.query) => Promise<unknown>) => fn(db.query)
  );
});

// ===========================================================================
// T53-4: Matchmaker IDOR — explainMatch ownership check
// ===========================================================================

describe('T53-4: Matchmaker IDOR — explainMatch ownership check', () => {
  it('T53-4: throws FORBIDDEN when the caller is neither poster nor assigned worker', async () => {
    // TASK_ROW has poster_id=POSTER_UUID and worker_id=WORKER_UUID.
    // Caller is CALLER_UUID — a third party with no relation to the task.
    mockDb.query.mockResolvedValueOnce({ rows: [TASK_ROW_WITH_PARTICIPANTS], rowCount: 1 } as any);

    const caller = makeMatchmakerCaller(CALLER_UUID); // not poster, not worker
    await expect(
      caller.explainMatch({ taskId: TASK_UUID, userId: WORKER_UUID })
    ).rejects.toThrow(/forbidden|not authorized|participant/i);
  });

  it('T53-4: allows the assigned worker to call explainMatch for their own task', async () => {
    // Task query — includes participant IDs so ownership check passes
    mockDb.query.mockResolvedValueOnce({ rows: [TASK_ROW_WITH_PARTICIPANTS], rowCount: 1 } as any);
    // Worker profile query
    mockDb.query.mockResolvedValueOnce({ rows: [WORKER_PROFILE_ROW], rowCount: 1 } as any);
    mockMatchmaker.explainMatch.mockResolvedValue({
      success: true,
      data: { summary: 'Good match', factors: [], estimatedEarnings: 4250, estimatedDuration: '1h' },
    } as any);

    const caller = makeMatchmakerCaller(WORKER_UUID); // worker is the caller
    const result = await caller.explainMatch({ taskId: TASK_UUID, userId: WORKER_UUID });
    expect(result).toBeDefined();
    expect(result.summary).toBe('Good match');
  });

  it('T53-4: allows the poster to call explainMatch for their own task', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [TASK_ROW_WITH_PARTICIPANTS], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [WORKER_PROFILE_ROW], rowCount: 1 } as any);
    mockMatchmaker.explainMatch.mockResolvedValue({
      success: true,
      data: { summary: 'Good match', factors: [], estimatedEarnings: 4250, estimatedDuration: '1h' },
    } as any);

    const caller = makeMatchmakerCaller(POSTER_UUID); // poster is the caller
    const result = await caller.explainMatch({ taskId: TASK_UUID, userId: WORKER_UUID });
    expect(result).toBeDefined();
  });

  it('T53-4: throws NOT_FOUND when task does not exist (no participant check possible)', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const caller = makeMatchmakerCaller(CALLER_UUID);
    await expect(
      caller.explainMatch({ taskId: TASK_UUID, userId: WORKER_UUID })
    ).rejects.toThrow('Task not found');
  });
});

// ===========================================================================
// T53-8: Proof review role check — only poster can review
// ===========================================================================

describe('T53-8: Proof review role check — only poster can review', () => {
  it('T53-8: returns FORBIDDEN when reviewer is not the task poster', async () => {
    // Phase 1: proof + photo_url fetch
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        ...makeProof(),
        photo_url: null,
        gps_coordinates: null,
        gps_accuracy_meters: null,
        lidar_depth_map_url: null,
      }],
      rowCount: 1,
    } as any);

    // T53-8 ownership check: task's poster_id is POSTER_UUID, but reviewer is WORKER_UUID
    mockDb.query.mockResolvedValueOnce({
      rows: [{ poster_id: POSTER_UUID }],
      rowCount: 1,
    } as any);

    const result = await ProofService.review({
      proofId: 'proof-1',
      reviewerId: WORKER_UUID, // worker tries to review — NOT the poster
      decision: 'REJECTED',
      reason: 'Bad proof',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FORBIDDEN');
    expect(result.error?.message).toMatch(/not authorized/i);
  });

  it('T53-8: allows REJECTED review when reviewer is the task poster', async () => {
    // Phase 1: proof + photo_url fetch
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        ...makeProof(),
        photo_url: null,
        gps_coordinates: null,
        gps_accuracy_meters: null,
        lidar_depth_map_url: null,
      }],
      rowCount: 1,
    } as any);

    // T53-8 ownership check: poster_id matches reviewer
    mockDb.query.mockResolvedValueOnce({
      rows: [{ poster_id: POSTER_UUID }],
      rowCount: 1,
    } as any);

    // Phase 3 transaction — FOR UPDATE SELECT (state = SUBMITTED, task_id)
    mockDb.query.mockResolvedValueOnce({ rows: [{ state: 'SUBMITTED', task_id: 'task-1' }], rowCount: 1 } as any);
    // Phase 3 transaction — T60-1: SELECT task state (still PROOF_SUBMITTED)
    mockDb.query.mockResolvedValueOnce({ rows: [{ state: 'PROOF_SUBMITTED' }], rowCount: 1 } as any);
    // Phase 3 transaction — UPDATE proof
    mockDb.query.mockResolvedValueOnce({
      rows: [{ ...makeProof(), state: 'REJECTED', reviewed_by: POSTER_UUID }],
      rowCount: 1,
    } as any);

    const result = await ProofService.review({
      proofId: 'proof-1',
      reviewerId: POSTER_UUID,
      decision: 'REJECTED',
      reason: 'Not done correctly',
    });

    expect(result.success).toBe(true);
    expect((result as any).data?.state).toBe('REJECTED');
  });

  it('T53-8: does not call the AI pipeline for non-poster reviewers', async () => {
    // Phase 1: proof fetch
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        ...makeProof(),
        photo_url: 'https://example.com/photo.jpg', // has a photo — would trigger AI if we got past the check
        gps_coordinates: null,
        gps_accuracy_meters: null,
        lidar_depth_map_url: null,
      }],
      rowCount: 1,
    } as any);

    // Ownership check — returns different poster
    mockDb.query.mockResolvedValueOnce({
      rows: [{ poster_id: POSTER_UUID }],
      rowCount: 1,
    } as any);

    await ProofService.review({
      proofId: 'proof-1',
      reviewerId: WORKER_UUID, // unauthorized
      decision: 'ACCEPTED',
    });

    // The Redis advisory lock should NOT have been acquired because we
    // returned FORBIDDEN before Phase 2
    expect(mockRedisSet).not.toHaveBeenCalled();
  });
});
