/**
 * Tutorial Router Unit Tests
 *
 * Tests tRPC procedures:
 * - getScenarios (protected, query)
 * - submitAnswers (protected, mutation)
 * - scanEquipment (protected, mutation)
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

vi.mock('../../src/services/TutorialQuestService', () => ({
  TutorialQuestService: {
    getScenarios: vi.fn(),
    submitAnswers: vi.fn(),
    scanEquipment: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { tutorialRouter } from '../../src/routers/tutorial';
import { TutorialQuestService } from '../../src/services/TutorialQuestService';

const mockService = vi.mocked(TutorialQuestService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCaller(userId = 'test-uid') {
  return tutorialRouter.createCaller({
    user: { id: userId } as any,
    firebaseUid: 'fb-uid',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tutorial.getScenarios', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns available scenarios', async () => {
    const scenarios = [
      { id: 'scenario-1', title: 'Risky task', description: 'Client asks to skip safety' },
      { id: 'scenario-2', title: 'Underpayment', description: 'Client offers too little' },
    ];
    mockService.getScenarios.mockResolvedValueOnce(scenarios as any);

    const result = await makeCaller().getScenarios();

    expect(result).toEqual(scenarios);
    expect(mockService.getScenarios).toHaveBeenCalledOnce();
  });
});

describe('tutorial.submitAnswers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('submits answers and returns score', async () => {
    const scoreResult = { score: 4, total: 5, passed: true };
    mockService.submitAnswers.mockResolvedValueOnce(scoreResult as any);

    const result = await makeCaller().submitAnswers({
      answers: [
        { scenarioId: 'scenario-1', action: 'flag_risk' },
        { scenarioId: 'scenario-2', action: 'decline_task' },
      ],
    });

    expect(result).toEqual(scoreResult);
    expect(mockService.submitAnswers).toHaveBeenCalledWith('test-uid', [
      { scenarioId: 'scenario-1', action: 'flag_risk' },
      { scenarioId: 'scenario-2', action: 'decline_task' },
    ]);
  });

  it('rejects invalid action value', async () => {
    await expect(
      makeCaller().submitAnswers({
        answers: [{ scenarioId: 'scenario-1', action: 'invalid_action' as any }],
      })
    ).rejects.toThrow();
  });

  it('rejects empty answers array', async () => {
    await expect(
      makeCaller().submitAnswers({ answers: [] })
    ).rejects.toThrow();
  });

  it('accepts all valid action types', async () => {
    mockService.submitAnswers.mockResolvedValueOnce({ score: 4, total: 4 } as any);

    const result = await makeCaller().submitAnswers({
      answers: [
        { scenarioId: 's1', action: 'flag_risk' },
        { scenarioId: 's2', action: 'decline_task' },
        { scenarioId: 's3', action: 'request_details' },
        { scenarioId: 's4', action: 'accept_task' },
      ],
    });

    expect(result).toBeDefined();
  });
});

describe('tutorial.scanEquipment', () => {
  beforeEach(() => vi.clearAllMocks());

  it('scans equipment from photo URL', async () => {
    const scanResult = { equipment: ['drill', 'safety glasses'], confidence: 0.85 };
    mockService.scanEquipment.mockResolvedValueOnce(scanResult as any);

    const result = await makeCaller().scanEquipment({
      photoUrl: 'https://example.com/equipment.jpg',
    });

    expect(result).toEqual(scanResult);
    expect(mockService.scanEquipment).toHaveBeenCalledWith('https://example.com/equipment.jpg');
  });

  it('rejects invalid URL', async () => {
    await expect(
      makeCaller().scanEquipment({ photoUrl: 'not-a-url' })
    ).rejects.toThrow();
  });
});
