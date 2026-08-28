/**
 * AI Router Unit Tests
 *
 * Tests all protected procedures:
 * - submitCalibration (mutation)
 * - getInferenceResult (query)
 * - confirmRole (mutation)
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

vi.mock('../../src/services/OnboardingAIService', () => ({
  OnboardingAIService: {
    submitCalibration: vi.fn(),
    getInferenceResult: vi.fn(),
    confirmRole: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { aiRouter } from '../../src/routers/ai';
import { OnboardingAIService } from '../../src/services/OnboardingAIService';

const mockDb = vi.mocked(db);
const mockAI = vi.mocked(OnboardingAIService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID1 = '00000000-0000-0000-0000-000000000001';

function makeCaller() {
  return aiRouter.createCaller({
    user: { id: UUID1, email: 'user@test.com', full_name: 'User', firebase_uid: 'fb-1', default_mode: 'worker' } as any,
    firebaseUid: 'fb-1',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ai router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // submitCalibration
  // =========================================================================
  describe('submitCalibration', () => {
    it('submits calibration and returns data on success', async () => {
      const data = { inferenceId: 'inf-1', status: 'processing' };
      mockAI.submitCalibration.mockResolvedValue({ success: true, data } as any);

      const caller = makeCaller();
      const result = await caller.submitCalibration({
        calibrationPrompt: 'I am a freelancer who does home repairs',
      });

      expect(result).toEqual(data);
      expect(mockAI.submitCalibration).toHaveBeenCalledWith({
        userId: UUID1,
        calibrationPrompt: 'I am a freelancer who does home repairs',
        onboardingVersion: '1.0.0',
      });
    });

    it('passes custom onboarding version', async () => {
      mockAI.submitCalibration.mockResolvedValue({ success: true, data: {} } as any);

      const caller = makeCaller();
      await caller.submitCalibration({
        calibrationPrompt: 'test prompt',
        onboardingVersion: '2.0.0',
      });

      expect(mockAI.submitCalibration).toHaveBeenCalledWith(
        expect.objectContaining({ onboardingVersion: '2.0.0' }),
      );
    });

    it('throws on service failure', async () => {
      mockAI.submitCalibration.mockResolvedValue({
        success: false,
        error: { code: 'AI_ERROR', message: 'Inference failed' },
      } as any);

      const caller = makeCaller();
      await expect(caller.submitCalibration({
        calibrationPrompt: 'test',
      })).rejects.toThrow('Inference failed');
    });
  });

  // =========================================================================
  // getInferenceResult
  // =========================================================================
  describe('getInferenceResult', () => {
    it('returns inference result on success', async () => {
      const data = { inferredMode: 'worker', confidence: 0.85 };
      mockAI.getInferenceResult.mockResolvedValue({ success: true, data } as any);

      const caller = makeCaller();
      const result = await caller.getInferenceResult();

      expect(result).toEqual(data);
      expect(mockAI.getInferenceResult).toHaveBeenCalledWith(UUID1);
    });

    it('throws on service failure', async () => {
      mockAI.getInferenceResult.mockResolvedValue({
        success: false,
        error: { code: 'NOT_FOUND', message: 'No inference found' },
      } as any);

      const caller = makeCaller();
      await expect(caller.getInferenceResult()).rejects.toThrow('No inference found');
    });
  });

  // =========================================================================
  // confirmRole
  // =========================================================================
  describe('confirmRole', () => {
    it('confirms role on success', async () => {
      const data = { confirmed: true, mode: 'worker' };
      // Guard: no prior task history
      mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as any);
      mockAI.confirmRole.mockResolvedValue({ success: true, data } as any);

      const caller = makeCaller();
      const result = await caller.confirmRole({
        confirmedMode: 'worker',
        overrideAI: false,
      });

      expect(result).toEqual(data);
      expect(mockAI.confirmRole).toHaveBeenCalledWith({
        userId: UUID1,
        confirmedMode: 'worker',
        overrideAI: false,
      });
    });

    it('allows AI override', async () => {
      // Guard: no prior task history
      mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as any);
      mockAI.confirmRole.mockResolvedValue({ success: true, data: { confirmed: true } } as any);

      const caller = makeCaller();
      await caller.confirmRole({ confirmedMode: 'poster', overrideAI: true });

      expect(mockAI.confirmRole).toHaveBeenCalledWith(
        expect.objectContaining({ overrideAI: true }),
      );
    });

    it('throws BAD_REQUEST on service failure', async () => {
      // Guard: no prior task history
      mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as any);
      mockAI.confirmRole.mockResolvedValue({
        success: false,
        error: { code: 'BAD_REQUEST', message: 'Invalid mode' },
      } as any);

      const caller = makeCaller();
      await expect(caller.confirmRole({
        confirmedMode: 'worker',
      })).rejects.toThrow('Invalid mode');
    });

    it('throws PRECONDITION_FAILED when user has prior task history', async () => {
      // Guard: user has task history
      mockDb.query.mockResolvedValueOnce({ rows: [{ count: '3' }], rowCount: 1 } as any);

      const caller = makeCaller();
      await expect(caller.confirmRole({
        confirmedMode: 'poster',
      })).rejects.toThrow('Role cannot be changed after completing tasks.');
    });
  });
});
