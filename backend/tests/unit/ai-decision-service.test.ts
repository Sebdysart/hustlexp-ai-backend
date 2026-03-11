/**
 * AIDecisionService Unit Tests
 *
 * Tests create, getById, and getByProposalId.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: { child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

import { AIDecisionService } from '../../src/services/AIDecisionService';
import { db } from '../../src/db';

const mockQuery = db.query as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

const baseDecision = {
  id: 'd1',
  proposal_id: 'p1',
  accepted: true,
  reason_codes: ['VALID_CONFIDENCE'],
  final_author: 'system',
  decided_at: new Date(),
};

describe('AIDecisionService.create', () => {
  it('creates a decision for a proposal', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [baseDecision] });

    const result = await AIDecisionService.create({
      proposalId: 'p1',
      accepted: true,
      reasonCodes: ['VALID_CONFIDENCE'],
      finalAuthor: 'system',
    });
    expect(result.success).toBe(true);
    expect(result.data?.accepted).toBe(true);
  });

  it('creates a rejection decision', async () => {
    const rejected = { ...baseDecision, accepted: false, reason_codes: ['LOW_CONFIDENCE'] };
    mockQuery.mockResolvedValueOnce({ rows: [rejected] });

    const result = await AIDecisionService.create({
      proposalId: 'p1',
      accepted: false,
      reasonCodes: ['LOW_CONFIDENCE'],
      finalAuthor: 'admin:usr_123',
    });
    expect(result.success).toBe(true);
    expect(result.data?.accepted).toBe(false);
  });

  it('includes writes when provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...baseDecision, writes: { trust_tier: 2 } }] });

    const result = await AIDecisionService.create({
      proposalId: 'p1',
      accepted: true,
      reasonCodes: ['OK'],
      writes: { trust_tier: 2 },
      finalAuthor: 'system',
    });
    expect(result.success).toBe(true);
    const callArgs = mockQuery.mock.calls[0][1];
    expect(callArgs[3]).toContain('trust_tier');
  });

  it('handles DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('fail'));

    const result = await AIDecisionService.create({
      proposalId: 'p1', accepted: true, reasonCodes: [], finalAuthor: 'system',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });
});

describe('AIDecisionService.getById', () => {
  it('returns decision by ID', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [baseDecision] });

    const result = await AIDecisionService.getById('d1');
    expect(result.success).toBe(true);
    expect(result.data?.id).toBe('d1');
  });

  it('returns NOT_FOUND', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await AIDecisionService.getById('missing');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
  });

  it('handles DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('fail'));

    const result = await AIDecisionService.getById('d1');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });
});

describe('AIDecisionService.getByProposalId', () => {
  it('returns decision by proposal ID', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [baseDecision] });

    const result = await AIDecisionService.getByProposalId('p1');
    expect(result.success).toBe(true);
    expect(result.data?.proposal_id).toBe('p1');
  });

  it('returns null when no decision exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await AIDecisionService.getByProposalId('p_missing');
    expect(result.success).toBe(true);
    expect(result.data).toBeNull();
  });

  it('handles DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('fail'));

    const result = await AIDecisionService.getByProposalId('p1');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });
});
