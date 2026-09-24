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

describe('create', () => {
    it('should create escrow with valid amount', async () => {
      (db.query as any).mockResolvedValueOnce({ rows: [{ id: 'e1', task_id: 't1', amount: 5000, state: 'PENDING' }], rowCount: 1 });
      const result = await EscrowService.create({ taskId: 't1', amount: 5000 });
      expect(result.success).toBe(true);
      expect(result.data?.state).toBe('PENDING');
    });

    it('should reject non-positive amount', async () => {
      const result = await EscrowService.create({ taskId: 't1', amount: 0 });
      expect(result.success).toBe(false);
    });

    it('should reject non-integer amount', async () => {
      const result = await EscrowService.create({ taskId: 't1', amount: 50.5 });
      expect(result.success).toBe(false);
    });
  });

describe('fund', () => {
    it('should fund PENDING escrow', async () => {
      // fund() is now wrapped in db.transaction():
      //   1st query: SELECT state, version FOR UPDATE → lock row
      //   2nd query: cross-escrow PI dedup check → no conflict
      //   3rd query: UPDATE escrows ... RETURNING *   → funded row
      (db.query as any).mockResolvedValueOnce({ rows: [{ state: 'PENDING', version: 0 }], rowCount: 1 });
      (db.query as any).mockResolvedValueOnce({ rows: [], rowCount: 0 });
      (db.query as any).mockResolvedValueOnce({ rows: [{ id: 'e1', state: 'FUNDED' }], rowCount: 1 });
      const result = await EscrowService.fund({ escrowId: 'e1', providerPaymentId: 'pi_123' });
      expect(result.success).toBe(true);
    });
  });

describe('lockForDispute', () => {
    it('should lock FUNDED escrow for dispute', async () => {
      // FIX 5: lockForDispute now does a window-check query first.
      // Return no rows so the window guard is skipped (no completed_at to check).
      (db.query as any).mockResolvedValueOnce({ rows: [], rowCount: 0 }); // window check
      (db.query as any).mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 }); // dup dispute check
      (db.query as any).mockResolvedValueOnce({ rows: [{ id: 'e1', state: 'LOCKED_DISPUTE' }], rowCount: 1 });
      const result = await EscrowService.lockForDispute('e1');
      expect(result.success).toBe(true);
    });
  });

describe('state machine', () => {
    it('should validate PENDING -> FUNDED transition', () => {
      expect(EscrowService.isValidTransition('PENDING' as any, 'FUNDED' as any)).toBe(true);
    });

    it('should reject RELEASED -> anything transition', () => {
      expect(EscrowService.isValidTransition('RELEASED' as any, 'FUNDED' as any)).toBe(false);
    });

    it('should identify terminal states', () => {
      expect(EscrowService.isTerminalState('RELEASED' as any)).toBe(true);
      expect(EscrowService.isTerminalState('FUNDED' as any)).toBe(false);
    });
  });
