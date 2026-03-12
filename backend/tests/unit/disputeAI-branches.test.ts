/**
 * DisputeAI router branch coverage tests
 *
 * Targets the 6 uncovered branches:
 * - analyzeDispute: success vs failure
 * - generateEvidenceRequest: success vs failure
 * - assessEscalation: success vs failure
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
}));

vi.mock('../../src/services/DisputeAIService', () => ({
  DisputeAIService: {
    analyzeDispute: vi.fn(),
    generateEvidenceRequest: vi.fn(),
    assessEscalation: vi.fn(),
  },
}));

import { DisputeAIService } from '../../src/services/DisputeAIService';
import { disputeAIRouter } from '../../src/routers/disputeAI';
import { db as mockDb } from '../../src/db';

const mockAI = vi.mocked(DisputeAIService);

function makeCaller(userId = 'admin-1') {
  vi.mocked(mockDb).query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
  return disputeAIRouter.createCaller({
    user: {
      id: userId, email: 'a@b.com', full_name: 'Admin',
      role: 'admin', trust_tier: 5, firebase_uid: 'fb-admin',
    } as any,
    firebaseUid: 'fb-admin',
  });
}

beforeEach(() => vi.clearAllMocks());

describe('disputeAI.analyzeDispute', () => {
  it('returns data on success', async () => {
    const data = { summary: 'Analysis', confidence: 0.9 };
    mockAI.analyzeDispute.mockResolvedValueOnce({ success: true, data } as any);

    const result = await makeCaller().analyzeDispute({ disputeId: '550e8400-e29b-41d4-a716-446655440000' });
    expect(result.summary).toBe('Analysis');
  });

  it('throws on failure', async () => {
    mockAI.analyzeDispute.mockResolvedValueOnce({
      success: false,
      error: { message: 'AI unavailable' },
    } as any);

    await expect(
      makeCaller().analyzeDispute({ disputeId: '550e8400-e29b-41d4-a716-446655440000' }),
    ).rejects.toThrow('AI unavailable');
  });
});

describe('disputeAI.generateEvidenceRequest', () => {
  it('returns data on success', async () => {
    const data = { evidenceItems: ['photo', 'receipt'] };
    mockAI.generateEvidenceRequest.mockResolvedValueOnce({ success: true, data } as any);

    const result = await makeCaller().generateEvidenceRequest({ disputeId: '550e8400-e29b-41d4-a716-446655440000' });
    expect(result.evidenceItems).toHaveLength(2);
  });

  it('throws on failure', async () => {
    mockAI.generateEvidenceRequest.mockResolvedValueOnce({
      success: false,
      error: { message: 'Generation failed' },
    } as any);

    await expect(
      makeCaller().generateEvidenceRequest({ disputeId: '550e8400-e29b-41d4-a716-446655440000' }),
    ).rejects.toThrow('Generation failed');
  });
});

describe('disputeAI.assessEscalation', () => {
  it('returns data on success', async () => {
    const data = { shouldEscalate: true, reason: 'High value' };
    mockAI.assessEscalation.mockResolvedValueOnce({ success: true, data } as any);

    const result = await makeCaller().assessEscalation({ disputeId: '550e8400-e29b-41d4-a716-446655440000' });
    expect(result.shouldEscalate).toBe(true);
  });

  it('throws on failure', async () => {
    mockAI.assessEscalation.mockResolvedValueOnce({
      success: false,
      error: { message: 'Assessment failed' },
    } as any);

    await expect(
      makeCaller().assessEscalation({ disputeId: '550e8400-e29b-41d4-a716-446655440000' }),
    ).rejects.toThrow('Assessment failed');
  });
});
