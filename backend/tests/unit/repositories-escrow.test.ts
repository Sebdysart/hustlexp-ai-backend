/**
 * EscrowRepository Unit Tests
 *
 * Tests all methods of EscrowRepository with mocked db.query.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock DB (must use vi.fn() inline) ──────────────────────────────────────
vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
  default: { query: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(),
  },
}));

import { db } from '../../src/db';
import { EscrowRepository } from '../../src/repositories/EscrowRepository';

const repo = new EscrowRepository();
const mockQuery = vi.mocked(db.query);

const mockEscrow = {
  id: 'escrow-1',
  task_id: 'task-1',
  amount: 10000,
  stripe_payment_intent_id: 'pi_test123',
  state: 'PENDING' as const,
  created_at: new Date(),
  updated_at: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// findByTaskId
// ============================================================================

describe('EscrowRepository.findByTaskId', () => {
  it('returns escrow when found by task id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [mockEscrow], rowCount: 1 });
    const result = await repo.findByTaskId('task-1');
    expect(result).toEqual(mockEscrow);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('WHERE e.task_id = $1'),
      ['task-1']
    );
  });

  it('joins tasks table to include poster_id and worker_id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [mockEscrow], rowCount: 1 });
    await repo.findByTaskId('task-1');
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('JOIN tasks t ON t.id = e.task_id');
    expect(sql).toContain('t.poster_id');
    expect(sql).toContain('t.worker_id');
  });

  it('returns null when task not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await repo.findByTaskId('nonexistent');
    expect(result).toBeNull();
  });

  it('uses transaction context', async () => {
    const txQuery = vi.fn().mockResolvedValueOnce({ rows: [mockEscrow], rowCount: 1 });
    const result = await repo.findByTaskId('task-1', { query: txQuery });
    expect(result).toEqual(mockEscrow);
    expect(txQuery).toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ============================================================================
// findByState
// ============================================================================

describe('EscrowRepository.findByState', () => {
  it('returns escrows in PENDING state', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [mockEscrow], rowCount: 1 });
    const result = await repo.findByState('PENDING');
    expect(result).toEqual([mockEscrow]);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('WHERE state = $1'),
      ['PENDING', 50]
    );
  });

  it('uses default limit of 50', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await repo.findByState('FUNDED');
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[1]).toBe(50);
  });

  it('uses custom limit', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await repo.findByState('RELEASED', 10);
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[1]).toBe(10);
  });

  it('returns empty array when none in state', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await repo.findByState('REFUNDED');
    expect(result).toEqual([]);
  });

  it('orders by created_at DESC', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await repo.findByState('PENDING');
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('ORDER BY created_at DESC');
  });
});

// ============================================================================
// create
// ============================================================================

describe('EscrowRepository.create', () => {
  it('creates escrow with all fields', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [mockEscrow], rowCount: 1 });
    const result = await repo.create({
      id: 'escrow-1',
      task_id: 'task-1',
      amount: 10000,
      stripe_payment_intent_id: 'pi_test123',
    });
    expect(result).toEqual(mockEscrow);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO escrow'),
      ['escrow-1', 'task-1', 10000, 'pi_test123']
    );
  });

  it('creates escrow without stripe_payment_intent_id', async () => {
    const escrowWithoutPi = { ...mockEscrow, stripe_payment_intent_id: null };
    mockQuery.mockResolvedValueOnce({ rows: [escrowWithoutPi], rowCount: 1 });
    await repo.create({ id: 'escrow-2', task_id: 'task-2', amount: 5000 });
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[3]).toBeNull();
  });

  it('inserts with PENDING state', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [mockEscrow], rowCount: 1 });
    await repo.create({ id: 'escrow-1', task_id: 'task-1', amount: 5000 });
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("'PENDING'");
  });

  it('uses transaction context', async () => {
    const txQuery = vi.fn().mockResolvedValueOnce({ rows: [mockEscrow], rowCount: 1 });
    await repo.create({ id: 'escrow-1', task_id: 'task-1', amount: 5000 }, { query: txQuery });
    expect(txQuery).toHaveBeenCalled();
  });
});

// ============================================================================
// updateState
// ============================================================================

describe('EscrowRepository.updateState', () => {
  it('updates escrow state', async () => {
    const funded = { ...mockEscrow, state: 'FUNDED' };
    mockQuery.mockResolvedValueOnce({ rows: [funded], rowCount: 1 });
    const result = await repo.updateState('escrow-1', 'FUNDED');
    expect(result).toEqual(funded);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('SET state = $1, updated_at = NOW()'),
      ['FUNDED', 'escrow-1']
    );
  });

  it('returns null when escrow not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await repo.updateState('nonexistent', 'RELEASED');
    expect(result).toBeNull();
  });
});

// ============================================================================
// markFunded
// ============================================================================

describe('EscrowRepository.markFunded', () => {
  it('marks escrow as funded with stripe payment intent', async () => {
    const funded = { ...mockEscrow, state: 'FUNDED', stripe_payment_intent_id: 'pi_new123' };
    mockQuery.mockResolvedValueOnce({ rows: [funded], rowCount: 1 });
    const result = await repo.markFunded('escrow-1', 'pi_new123');
    expect(result).toEqual(funded);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("state = 'FUNDED'"),
      ['pi_new123', 'escrow-1']
    );
  });

  it('sets funded_at timestamp', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [mockEscrow], rowCount: 1 });
    await repo.markFunded('escrow-1', 'pi_test');
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('funded_at = NOW()');
  });

  it('returns null when escrow not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await repo.markFunded('nonexistent', 'pi_test');
    expect(result).toBeNull();
  });

  it('uses transaction context', async () => {
    const txQuery = vi.fn().mockResolvedValueOnce({ rows: [mockEscrow], rowCount: 1 });
    await repo.markFunded('escrow-1', 'pi_test', { query: txQuery });
    expect(txQuery).toHaveBeenCalled();
  });
});

// ============================================================================
// markReleased
// ============================================================================

describe('EscrowRepository.markReleased', () => {
  it('marks escrow as released with transfer id', async () => {
    const released = { ...mockEscrow, state: 'RELEASED', stripe_transfer_id: 'tr_test123' };
    mockQuery.mockResolvedValueOnce({ rows: [released], rowCount: 1 });
    const result = await repo.markReleased('escrow-1', 'tr_test123');
    expect(result).toEqual(released);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("state = 'RELEASED'"),
      ['tr_test123', 'escrow-1']
    );
  });

  it('marks escrow as released without transfer id (null)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [mockEscrow], rowCount: 1 });
    await repo.markReleased('escrow-1');
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[0]).toBeNull();
  });

  it('sets released_at timestamp', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [mockEscrow], rowCount: 1 });
    await repo.markReleased('escrow-1', 'tr_test');
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('released_at = NOW()');
  });

  it('returns null when escrow not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await repo.markReleased('nonexistent');
    expect(result).toBeNull();
  });
});

// ============================================================================
// lockForDispute
// ============================================================================

describe('EscrowRepository.lockForDispute', () => {
  it('locks escrow for dispute by delegating to updateState', async () => {
    const locked = { ...mockEscrow, state: 'LOCKED_DISPUTE' };
    mockQuery.mockResolvedValueOnce({ rows: [locked], rowCount: 1 });
    const result = await repo.lockForDispute('escrow-1');
    expect(result).toEqual(locked);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('SET state = $1, updated_at = NOW()'),
      ['LOCKED_DISPUTE', 'escrow-1']
    );
  });

  it('returns null when escrow not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await repo.lockForDispute('nonexistent');
    expect(result).toBeNull();
  });

  it('uses transaction context', async () => {
    const txQuery = vi.fn().mockResolvedValueOnce({ rows: [mockEscrow], rowCount: 1 });
    await repo.lockForDispute('escrow-1', { query: txQuery });
    expect(txQuery).toHaveBeenCalled();
  });
});

// ============================================================================
// findByPoster
// ============================================================================

describe('EscrowRepository.findByPoster', () => {
  it('returns escrows for a poster', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [mockEscrow], rowCount: 1 });
    const result = await repo.findByPoster('poster-1');
    expect(result).toEqual([mockEscrow]);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('WHERE t.poster_id = $1'),
      ['poster-1', 50]
    );
  });

  it('joins tasks table for poster query', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await repo.findByPoster('poster-1');
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('JOIN tasks t ON t.id = e.task_id');
  });

  it('uses default limit of 50', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await repo.findByPoster('poster-1');
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[1]).toBe(50);
  });

  it('uses custom limit', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await repo.findByPoster('poster-1', 10);
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[1]).toBe(10);
  });

  it('returns empty array when no escrows found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await repo.findByPoster('poster-1');
    expect(result).toEqual([]);
  });

  it('orders by escrow created_at DESC', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await repo.findByPoster('poster-1');
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('ORDER BY e.created_at DESC');
  });

  it('uses transaction context', async () => {
    const txQuery = vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await repo.findByPoster('poster-1', 50, { query: txQuery });
    expect(txQuery).toHaveBeenCalled();
  });
});

// ============================================================================
// Singleton export
// ============================================================================

describe('escrowRepository singleton', () => {
  it('exports an EscrowRepository instance', async () => {
    const { escrowRepository } = await import('../../src/repositories/EscrowRepository');
    expect(escrowRepository).toBeInstanceOf(EscrowRepository);
  });
});
