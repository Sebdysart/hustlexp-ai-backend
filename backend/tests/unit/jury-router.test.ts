/**
 * Jury Router Unit Tests
 *
 * Tests tRPC procedures:
 * - submitVote (protected, mutation)
 * - getVoteTally (protected, query)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/auth/firebase', () => ({
  firebaseAuth: { verifyIdToken: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../src/services/JuryPoolService', () => ({
  JuryPoolService: {
    submitVote: vi.fn(),
    getVoteTally: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { juryRouter } from '../../src/routers/jury';
import { JuryPoolService } from '../../src/services/JuryPoolService';

const mockDb = vi.mocked(db);
const mockService = vi.mocked(JuryPoolService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_UUID = '11111111-1111-1111-1111-111111111111';

function makeCaller(userId = 'test-uid') {
  return juryRouter.createCaller({
    user: { id: userId } as any,
    firebaseUid: 'fb-uid',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('jury.submitVote', () => {
  beforeEach(() => vi.clearAllMocks());

  it('submits a vote for worker_complete', async () => {
    const voteResult = { id: 'vote-1', recorded: true };
    mockService.submitVote.mockResolvedValueOnce(voteResult as any);

    const result = await makeCaller().submitVote({
      disputeId: TEST_UUID,
      vote: 'worker_complete',
      confidence: 0.9,
    });

    expect(result).toEqual(voteResult);
    expect(mockService.submitVote).toHaveBeenCalledWith(
      TEST_UUID, 'test-uid', 'worker_complete', 0.9
    );
  });

  it('submits a vote for worker_incomplete', async () => {
    mockService.submitVote.mockResolvedValueOnce({ recorded: true } as any);

    await makeCaller().submitVote({
      disputeId: TEST_UUID,
      vote: 'worker_incomplete',
      confidence: 0.7,
    });

    expect(mockService.submitVote).toHaveBeenCalledWith(
      TEST_UUID, 'test-uid', 'worker_incomplete', 0.7
    );
  });

  it('submits a vote for inconclusive', async () => {
    mockService.submitVote.mockResolvedValueOnce({ recorded: true } as any);

    await makeCaller().submitVote({
      disputeId: TEST_UUID,
      vote: 'inconclusive',
      confidence: 0.5,
    });

    expect(mockService.submitVote).toHaveBeenCalledWith(
      TEST_UUID, 'test-uid', 'inconclusive', 0.5
    );
  });

  it('rejects invalid vote value', async () => {
    await expect(
      makeCaller().submitVote({
        disputeId: TEST_UUID,
        vote: 'invalid' as any,
        confidence: 0.5,
      })
    ).rejects.toThrow();
  });

  it('rejects confidence outside 0-1 range', async () => {
    await expect(
      makeCaller().submitVote({
        disputeId: TEST_UUID,
        vote: 'worker_complete',
        confidence: 1.5,
      })
    ).rejects.toThrow();
  });

  it('rejects unauthenticated users', async () => {
    const caller = juryRouter.createCaller({ user: null, firebaseUid: null } as any);

    await expect(
      caller.submitVote({ disputeId: TEST_UUID, vote: 'worker_complete', confidence: 0.8 })
    ).rejects.toThrow();
  });
});

describe('jury.getVoteTally', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns vote tally for a dispute', async () => {
    const tally = {
      worker_complete: 3,
      worker_incomplete: 1,
      inconclusive: 1,
      total: 5,
    };
    mockDb.query.mockResolvedValueOnce({ rows: [{ poster_id: 'test-uid', worker_id: 'test-uid' }], rowCount: 1 } as any);
    mockService.getVoteTally.mockResolvedValueOnce(tally as any);

    const result = await makeCaller().getVoteTally({ disputeId: TEST_UUID });

    expect(result).toEqual(tally);
    expect(mockService.getVoteTally).toHaveBeenCalledWith(TEST_UUID);
  });
});
