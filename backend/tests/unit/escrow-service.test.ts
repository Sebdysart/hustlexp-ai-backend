// Completion/refund provider behavior is covered by completion-release-worker and stage-one-refunds.
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../src/services/NotificationRequestService.js', () => ({ enqueueNotificationRequest: vi.fn() }));
vi.mock('../../src/db', () => { const query=vi.fn(); return { db: { query, transaction: vi.fn((fn) => fn(query)), serializableTransaction: vi.fn((fn) => fn(query)) }, isInvariantViolation: vi.fn(() => false), isUniqueViolation: vi.fn(() => false), getErrorMessage: vi.fn((code: string) => `Error: ${code}`) }; });
vi.mock('../../src/logger', () => ({ escrowLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }));
vi.mock('../../src/config', () => ({ config: { payments: { platformFeePercent: 15 } } }));
import { db, isInvariantViolation, isUniqueViolation, getErrorMessage } from '../../src/db';
import { EscrowService } from '../../src/services/EscrowService';
const mockDb=vi.mocked(db); const mockQuery=vi.mocked(db.query);
const mockIsInvariantViolation=vi.mocked(isInvariantViolation); const mockIsInvariant=mockIsInvariantViolation;
const mockIsUniqueViolation=vi.mocked(isUniqueViolation); const mockGetErrorMessage=vi.mocked(getErrorMessage);
beforeEach(() => { vi.clearAllMocks(); mockQuery.mockReset(); mockIsInvariantViolation.mockReturnValue(false); mockIsUniqueViolation.mockReturnValue(false); });
function makeEscrow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'esc-1',
    task_id: 'task-1',
    amount: 5000,
    state: 'PENDING',
    provider_payment_id: null,
    provider_transfer_id: null,
    funded_at: null,
    released_at: null,
    refunded_at: null,
    created_at: new Date(),
    ...overrides,
  };
}

describe('getById', () => {
    it('returns escrow when found', async () => {
      const escrow = makeEscrow();
      mockDb.query.mockResolvedValueOnce({ rows: [escrow], rowCount: 1 } as never);

      const result = await EscrowService.getById('esc-1');
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.id).toBe('esc-1');
    });

    it('returns NOT_FOUND when escrow missing', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await EscrowService.getById('esc-missing');
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('NOT_FOUND');
    });

    it('returns DB_ERROR on query failure', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('connection timeout'));

      const result = await EscrowService.getById('esc-1');
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('DB_ERROR');
    });
  });

describe('create', () => {
    it('creates escrow with valid amount', async () => {
      const escrow = makeEscrow({ amount: 5000 });
      mockDb.query.mockResolvedValueOnce({ rows: [escrow], rowCount: 1 } as never);

      const result = await EscrowService.create({ taskId: 'task-1', amount: 5000 });
      expect(result.success).toBe(true);
    });

    it('rejects zero amount', async () => {
      const result = await EscrowService.create({ taskId: 'task-1', amount: 0 });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.message).toContain('positive integer');
    });

    it('rejects negative amount', async () => {
      const result = await EscrowService.create({ taskId: 'task-1', amount: -100 });
      expect(result.success).toBe(false);
    });

    it('rejects float amount', async () => {
      const result = await EscrowService.create({ taskId: 'task-1', amount: 49.99 });
      expect(result.success).toBe(false);
    });

    it('returns DUPLICATE on unique violation', async () => {
      const err = Object.assign(new Error('dup'), { code: '23505' });
      mockDb.query.mockRejectedValueOnce(err);
      mockIsUniqueViolation.mockReturnValueOnce(true);

      const result = await EscrowService.create({ taskId: 'task-1', amount: 5000 });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('DUPLICATE');
    });
  });

describe('fund', () => {
    it('funds escrow from PENDING state', async () => {
      const funded = makeEscrow({ state: 'FUNDED', funded_at: new Date() });
      // 1st: SELECT FOR UPDATE → lock row with state=PENDING, version=0
      mockDb.query.mockResolvedValueOnce({ rows: [{ state: 'PENDING', version: 0 }], rowCount: 1 } as never);
      // 2nd: cross-escrow PI dedup check → no conflict (happy path)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      // 3rd: UPDATE → funded row
      mockDb.query.mockResolvedValueOnce({ rows: [funded], rowCount: 1 } as never);

      const result = await EscrowService.fund({ escrowId: 'esc-1', providerPaymentId: 'pi_123' });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.state).toBe('FUNDED');
    });

    it('fails when not in PENDING state', async () => {
      // 1st: SELECT FOR UPDATE → row with wrong state
      mockDb.query.mockResolvedValueOnce({ rows: [{ state: 'FUNDED', version: 1 }], rowCount: 1 } as never);
      // 2nd: cross-escrow PI dedup check → no conflict (runs before the state check)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await EscrowService.fund({ escrowId: 'esc-1', providerPaymentId: 'pi_123' });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.message).toContain('expected PENDING');
    });

    it('returns NOT_FOUND when escrow does not exist', async () => {
      // SELECT FOR UPDATE → no rows → early return, no PI dedup check needed
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await EscrowService.fund({ escrowId: 'esc-1', providerPaymentId: 'pi_123' });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('NOT_FOUND');
    });
  });

describe('lockForDispute', () => {
    it('locks from FUNDED state', async () => {
      const locked = makeEscrow({ state: 'LOCKED_DISPUTE' });
      // Window check returns no rows (no completed_at — window guard skipped)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      // Bug 2 fix: existing dispute count check — 0 open disputes
      mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never);
      // UPDATE escrows SET state = 'LOCKED_DISPUTE'
      mockDb.query.mockResolvedValueOnce({ rows: [locked], rowCount: 1 } as never);
      // logEscrowEvent INSERT
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await EscrowService.lockForDispute('esc-1');
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.state).toBe('LOCKED_DISPUTE');
    });

    it('fails when not in FUNDED state', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // window check
        .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never) // Bug 2 fix: existing dispute check
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // UPDATE — 0 rows
        .mockResolvedValueOnce({ rows: [makeEscrow({ state: 'PENDING' })], rowCount: 1 } as never); // getById

      const result = await EscrowService.lockForDispute('esc-1');
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.message).toContain('expected FUNDED');
    });
  });

describe('isTerminalState', () => {
    it('returns true for RELEASED, REFUNDED, REFUND_PARTIAL', () => {
      expect(EscrowService.isTerminalState('RELEASED')).toBe(true);
      expect(EscrowService.isTerminalState('REFUNDED')).toBe(true);
      expect(EscrowService.isTerminalState('REFUND_PARTIAL')).toBe(true);
    });

    it('returns false for PENDING, FUNDED, LOCKED_DISPUTE', () => {
      expect(EscrowService.isTerminalState('PENDING')).toBe(false);
      expect(EscrowService.isTerminalState('FUNDED')).toBe(false);
      expect(EscrowService.isTerminalState('LOCKED_DISPUTE')).toBe(false);
    });
  });

describe('isValidTransition', () => {
    it('allows valid transitions', () => {
      expect(EscrowService.isValidTransition('PENDING', 'FUNDED')).toBe(true);
      expect(EscrowService.isValidTransition('FUNDED', 'RELEASED')).toBe(true);
      expect(EscrowService.isValidTransition('FUNDED', 'LOCKED_DISPUTE')).toBe(true);
      expect(EscrowService.isValidTransition('LOCKED_DISPUTE', 'RELEASED')).toBe(true);
      expect(EscrowService.isValidTransition('LOCKED_DISPUTE', 'REFUND_PARTIAL')).toBe(true);
    });

    it('blocks invalid transitions', () => {
      expect(EscrowService.isValidTransition('RELEASED', 'FUNDED')).toBe(false);
      expect(EscrowService.isValidTransition('PENDING', 'RELEASED')).toBe(false);
      expect(EscrowService.isValidTransition('PENDING', 'LOCKED_DISPUTE')).toBe(false);
    });
  });

describe('getValidTransitions', () => {
    it('returns correct transitions for each state', () => {
      expect(EscrowService.getValidTransitions('PENDING')).toEqual(['FUNDED', 'REFUNDED']);
      expect(EscrowService.getValidTransitions('RELEASED')).toEqual([]);
      expect(EscrowService.getValidTransitions('LOCKED_DISPUTE')).toEqual(['RELEASED', 'REFUNDED', 'REFUND_PARTIAL']);
    });
  });
