/**
 * Batching Router Unit Tests
 *
 * Tests tRPC procedures:
 * - generateRecommendation (protected, query)
 * - calculateSavings (protected, query)
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

vi.mock('../../src/services/TaskBatchingService', () => ({
  TaskBatchingService: {
    generateRecommendation: vi.fn(),
    calculateSavings: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { batchingRouter } from '../../src/routers/batching';
import { TaskBatchingService } from '../../src/services/TaskBatchingService';

const mockService = vi.mocked(TaskBatchingService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCaller(userId = 'test-uid') {
  return batchingRouter.createCaller({
    user: { id: userId, default_mode: 'worker' } as any,
    firebaseUid: 'fb-uid',
  });
}

const sampleTasks = [
  { id: 'task-1', title: 'Fix sink', price: 5000, location: '123 Main St' },
  { id: 'task-2', title: 'Clean house', price: 3000, location: '456 Oak Ave' },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('batching.generateRecommendation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('generates recommendation for available tasks', async () => {
    const recommendation = {
      batchedTasks: ['task-1', 'task-2'],
      totalEarnings: 8000,
      estimatedTime: 3600,
    };
    mockService.generateRecommendation.mockResolvedValueOnce({
      success: true,
      data: recommendation,
    } as any);

    const result = await makeCaller().generateRecommendation({
      availableTasks: sampleTasks,
    });

    expect(result).toEqual(recommendation);
    expect(mockService.generateRecommendation).toHaveBeenCalledWith(
      'test-uid',
      sampleTasks,
      undefined
    );
  });

  it('passes current location when provided', async () => {
    mockService.generateRecommendation.mockResolvedValueOnce({
      success: true,
      data: { batchedTasks: [] },
    } as any);

    await makeCaller().generateRecommendation({
      availableTasks: sampleTasks,
      currentLocation: { lat: 37.7, lng: -122.4 },
    });

    expect(mockService.generateRecommendation).toHaveBeenCalledWith(
      'test-uid',
      sampleTasks,
      { lat: 37.7, lng: -122.4 }
    );
  });

  it('throws when service fails', async () => {
    mockService.generateRecommendation.mockResolvedValueOnce({
      success: false,
      error: { message: 'Not enough tasks' },
    } as any);

    await expect(
      makeCaller().generateRecommendation({ availableTasks: sampleTasks })
    ).rejects.toThrow('Not enough tasks');
  });

  it('rejects unauthenticated users', async () => {
    const caller = batchingRouter.createCaller({ user: null, firebaseUid: null } as any);

    await expect(
      caller.generateRecommendation({ availableTasks: sampleTasks })
    ).rejects.toThrow();
  });
});

describe('batching.calculateSavings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calculates savings for a set of tasks', async () => {
    const savings = { timeSaved: 1800, distanceSaved: 5.2 };
    mockService.calculateSavings.mockReturnValueOnce(savings as any);

    const result = await makeCaller().calculateSavings({ tasks: sampleTasks });

    expect(result).toEqual(savings);
    expect(mockService.calculateSavings).toHaveBeenCalledWith(sampleTasks);
  });
});
