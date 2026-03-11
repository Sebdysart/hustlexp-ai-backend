/**
 * Intent Router Unit Tests
 *
 * Tests tRPC procedures:
 * - analyze (protected, query)
 * - validateChanges (protected, query)
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

vi.mock('../../src/services/IntentParserService', () => ({
  IntentParserService: {
    analyzeIntent: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { intentRouter } from '../../src/routers/intent';
import { IntentParserService } from '../../src/services/IntentParserService';

const mockService = vi.mocked(IntentParserService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCaller() {
  return intentRouter.createCaller({
    user: { id: 'test-uid' } as any,
    firebaseUid: 'fb-uid',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('intent.analyze', () => {
  beforeEach(() => vi.clearAllMocks());

  it('analyzes intent description', async () => {
    const intentData = {
      affectedServices: ['TaskService'],
      affectedRouters: ['task'],
      changeType: 'feature',
    };
    mockService.analyzeIntent.mockResolvedValueOnce({ success: true, data: intentData } as any);

    const result = await makeCaller().analyze({ description: 'Add a new endpoint for task filtering' });

    expect(result).toEqual(intentData);
    expect(mockService.analyzeIntent).toHaveBeenCalledWith('Add a new endpoint for task filtering');
  });

  it('throws when analysis fails', async () => {
    mockService.analyzeIntent.mockResolvedValueOnce({
      success: false,
      error: { message: 'Analysis failed' },
    } as any);

    await expect(
      makeCaller().analyze({ description: 'Some description here' })
    ).rejects.toThrow('Analysis failed');
  });

  it('rejects description shorter than 10 characters', async () => {
    await expect(
      makeCaller().analyze({ description: 'short' })
    ).rejects.toThrow();
  });
});

describe('intent.validateChanges', () => {
  beforeEach(() => vi.clearAllMocks());

  it('validates changes match intent — no mismatches', async () => {
    mockService.analyzeIntent.mockResolvedValueOnce({
      success: true,
      data: {
        affectedServices: ['TaskService'],
        affectedRouters: ['task'],
      },
    } as any);

    const result = await makeCaller().validateChanges({
      description: 'Update task service logic',
      changedFiles: [
        'backend/src/services/TaskService.ts',
        'backend/src/routers/task.ts',
      ],
    });

    expect(result.valid).toBe(true);
    expect(result.mismatches).toHaveLength(0);
  });

  it('detects service mismatch', async () => {
    mockService.analyzeIntent.mockResolvedValueOnce({
      success: true,
      data: {
        affectedServices: ['TaskService', 'EscrowService'],
        affectedRouters: [],
      },
    } as any);

    const result = await makeCaller().validateChanges({
      description: 'Update task and escrow logic',
      changedFiles: ['backend/src/services/TaskService.ts'],
    });

    expect(result.valid).toBe(false);
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]).toContain('EscrowService');
  });

  it('detects router mismatch', async () => {
    mockService.analyzeIntent.mockResolvedValueOnce({
      success: true,
      data: {
        affectedServices: [],
        affectedRouters: ['admin'],
      },
    } as any);

    const result = await makeCaller().validateChanges({
      description: 'Update admin router',
      changedFiles: [],
    });

    expect(result.valid).toBe(false);
    expect(result.mismatches[0]).toContain('admin');
  });

  it('throws when intent analysis fails', async () => {
    mockService.analyzeIntent.mockResolvedValueOnce({ success: false } as any);

    await expect(
      makeCaller().validateChanges({
        description: 'Something',
        changedFiles: [],
      })
    ).rejects.toThrow('Intent analysis failed');
  });
});
