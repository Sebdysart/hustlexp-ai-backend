/**
 * BatchQuest Router Unit Tests
 *
 * Tests tRPC procedures:
 * - getSuggestions (protected, query)
 * - buildRoute (protected, query)
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

vi.mock('../../src/services/BatchQuestingService', () => ({
  BatchQuestingService: {
    getSuggestions: vi.fn(),
    buildRoute: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { batchQuestRouter } from '../../src/routers/batchQuest';
import { BatchQuestingService } from '../../src/services/BatchQuestingService';

const mockService = vi.mocked(BatchQuestingService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_UUID = '11111111-1111-1111-1111-111111111111';
const TEST_UUID_2 = '22222222-2222-2222-2222-222222222222';

function makeCaller(userId = 'test-uid') {
  return batchQuestRouter.createCaller({
    user: { id: userId } as any,
    firebaseUid: 'fb-uid',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('batchQuest.getSuggestions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns nearby task suggestions', async () => {
    const suggestions = [{ taskId: TEST_UUID_2, distanceMeters: 500, title: 'Clean house' }];
    mockService.getSuggestions.mockResolvedValueOnce(suggestions as any);

    const result = await makeCaller().getSuggestions({ currentTaskId: TEST_UUID });

    expect(result).toEqual(suggestions);
    expect(mockService.getSuggestions).toHaveBeenCalledWith({
      currentTaskId: TEST_UUID,
      workerId: 'test-uid',
      maxResults: undefined,
      maxDistanceMeters: undefined,
    });
  });

  it('passes optional maxResults and maxDistanceMeters', async () => {
    mockService.getSuggestions.mockResolvedValueOnce([] as any);

    await makeCaller().getSuggestions({
      currentTaskId: TEST_UUID,
      maxResults: 5,
      maxDistanceMeters: 10000,
    });

    expect(mockService.getSuggestions).toHaveBeenCalledWith({
      currentTaskId: TEST_UUID,
      workerId: 'test-uid',
      maxResults: 5,
      maxDistanceMeters: 10000,
    });
  });

  it('rejects maxResults above 10', async () => {
    await expect(
      makeCaller().getSuggestions({ currentTaskId: TEST_UUID, maxResults: 11 })
    ).rejects.toThrow();
  });

  it('rejects maxDistanceMeters below 500', async () => {
    await expect(
      makeCaller().getSuggestions({ currentTaskId: TEST_UUID, maxDistanceMeters: 100 })
    ).rejects.toThrow();
  });
});

describe('batchQuest.buildRoute', () => {
  beforeEach(() => vi.clearAllMocks());

  it('builds route for task IDs', async () => {
    const route = {
      taskIds: [TEST_UUID, TEST_UUID_2],
      totalDistanceMeters: 5000,
      estimatedMinutes: 30,
    };
    mockService.buildRoute.mockResolvedValueOnce(route as any);

    const result = await makeCaller().buildRoute({ taskIds: [TEST_UUID, TEST_UUID_2] });

    expect(result).toEqual(route);
    expect(mockService.buildRoute).toHaveBeenCalledWith([TEST_UUID, TEST_UUID_2]);
  });

  it('rejects empty task IDs array', async () => {
    await expect(
      makeCaller().buildRoute({ taskIds: [] })
    ).rejects.toThrow();
  });
});
