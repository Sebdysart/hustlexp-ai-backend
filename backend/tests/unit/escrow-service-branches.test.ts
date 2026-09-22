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
    state: 'FUNDED',
    provider_payment_id: 'pi_test',
    provider_transfer_id: null,
    funded_at: new Date(),
    released_at: null,
    refunded_at: null,
    created_at: new Date(),
    poster_id: 'poster-1',
    worker_id: 'worker-1',
    ...overrides,
  };
}

describe('EscrowService.getByTaskId', () => {
  it('returns NOT_FOUND when no escrow exists for task', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await EscrowService.getByTaskId('task-no-escrow');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
    expect(result.error?.message).toContain('task-no-escrow');
  });

  it('returns the escrow when found', async () => {
    const escrow = makeEscrow({ task_id: 'task-1' });
    mockQuery.mockResolvedValueOnce({ rows: [escrow], rowCount: 1 } as never);

    const result = await EscrowService.getByTaskId('task-1');

    expect(result.success).toBe(true);
    expect(result.data?.task_id).toBe('task-1');
  });

  it('returns DB_ERROR when query throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection timeout') as never);

    const result = await EscrowService.getByTaskId('task-1');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });
});

describe('EscrowService.lockForDispute — rowCount=0', () => {
  it('returns INVALID_STATE when escrow is not FUNDED (e.g. PENDING)', async () => {
    // Window check — no rows (skips time gate)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    // dup dispute check
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never);
    // UPDATE rowCount=0
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    // getById → PENDING
    mockQuery.mockResolvedValueOnce({ rows: [makeEscrow({ state: 'PENDING' })], rowCount: 1 } as never);

    const result = await EscrowService.lockForDispute('esc-1');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_STATE');
    expect(result.error?.message).toContain('expected FUNDED');
  });

  it('returns getById error when getById fails', async () => {
    // Window check — no rows (skips time gate)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    // dup dispute check
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never);
    // UPDATE rowCount=0
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    // getById DB error
    mockQuery.mockRejectedValueOnce(new Error('db error') as never);

    const result = await EscrowService.lockForDispute('esc-1');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });
});
