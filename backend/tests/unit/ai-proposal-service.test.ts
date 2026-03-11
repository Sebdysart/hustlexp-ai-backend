/**
 * AIProposalService Unit Tests
 *
 * Tests create, getById, and getByJobId, including proposal hashing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: { child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

import { AIProposalService } from '../../src/services/AIProposalService';
import { db } from '../../src/db';
import { createHash } from 'crypto';

const mockQuery = db.query as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

const baseProposal = {
  id: 'prop1',
  job_id: 'job1',
  proposal_type: 'role_inference',
  proposal: { roleConfidenceWorker: 0.8, roleConfidencePoster: 0.2 },
  proposal_hash: 'abc123',
  confidence: 0.8,
  certainty_tier: 'STRONG',
  anomaly_flags: [],
  schema_version: '1.0.0',
};

// ============================================================================
// create
// ============================================================================
describe('AIProposalService.create', () => {
  it('creates a proposal with hash', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [baseProposal] });

    const result = await AIProposalService.create({
      jobId: 'job1',
      proposalType: 'role_inference',
      proposal: { roleConfidenceWorker: 0.8 },
      confidence: 0.8,
      certaintyTier: 'STRONG',
      schemaVersion: '1.0.0',
    });

    expect(result.success).toBe(true);
    expect(result.data?.id).toBe('prop1');

    // Verify hash was computed correctly
    const callArgs = mockQuery.mock.calls[0][1];
    const expectedHash = createHash('sha256')
      .update(JSON.stringify({ roleConfidenceWorker: 0.8 }))
      .digest('hex');
    expect(callArgs[3]).toBe(expectedHash);
  });

  it('passes all optional fields', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [baseProposal] });

    await AIProposalService.create({
      jobId: 'job1',
      proposalType: 'scope_analysis',
      proposal: { price: 3000 },
      confidence: 0.9,
      certaintyTier: 'STRONG',
      anomalyFlags: ['unusual_price'],
      schemaVersion: '2.0.0',
    });

    const callArgs = mockQuery.mock.calls[0][1];
    expect(callArgs[0]).toBe('job1');
    expect(callArgs[1]).toBe('scope_analysis');
    expect(callArgs[4]).toBe(0.9);
    expect(callArgs[5]).toBe('STRONG');
    expect(callArgs[6]).toEqual(['unusual_price']);
    expect(callArgs[7]).toBe('2.0.0');
  });

  it('handles DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('insert fail'));

    const result = await AIProposalService.create({
      jobId: 'job1',
      proposalType: 'test',
      proposal: {},
      schemaVersion: '1.0.0',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });

  it('correctly hashes empty proposal', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [baseProposal] });

    await AIProposalService.create({
      jobId: 'job1',
      proposalType: 'test',
      proposal: {},
      schemaVersion: '1.0.0',
    });

    const expectedHash = createHash('sha256').update('{}').digest('hex');
    expect(mockQuery.mock.calls[0][1][3]).toBe(expectedHash);
  });
});

// ============================================================================
// getById
// ============================================================================
describe('AIProposalService.getById', () => {
  it('returns proposal by ID', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [baseProposal] });

    const result = await AIProposalService.getById('prop1');
    expect(result.success).toBe(true);
    expect(result.data?.id).toBe('prop1');
  });

  it('returns NOT_FOUND for missing proposal', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await AIProposalService.getById('missing');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
  });

  it('handles DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('fail'));

    const result = await AIProposalService.getById('prop1');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });
});

// ============================================================================
// getByJobId
// ============================================================================
describe('AIProposalService.getByJobId', () => {
  it('returns proposals by job ID', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [baseProposal, { ...baseProposal, id: 'prop2' }] });

    const result = await AIProposalService.getByJobId('job1');
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
  });

  it('returns empty array when no proposals exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await AIProposalService.getByJobId('job_empty');
    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });

  it('handles DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('fail'));

    const result = await AIProposalService.getByJobId('job1');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });
});
