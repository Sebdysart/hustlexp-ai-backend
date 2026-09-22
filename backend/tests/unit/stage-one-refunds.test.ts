import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), binding: vi.fn(), getEscrow: vi.fn() }));
vi.mock('../../src/db.js', () => ({ db: { query: mocks.query,
  transaction: (fn: (q: typeof mocks.query) => unknown) => fn(mocks.query) } }));
vi.mock('../../src/services/EscrowPaymentBindingService.js', () => ({ loadEscrowPaymentBinding: mocks.binding }));
vi.mock('../../src/services/EscrowReadService.js', () => ({ getEscrowById: mocks.getEscrow }));
import { confirmEscrowRefund, recordManualRefundRequirement } from '../../src/services/EscrowRefundProvider.js';
import { refundEscrow } from '../../src/services/EscrowRefundService.js';
import { partialRefundEscrow } from '../../src/services/EscrowPartialRefundService.js';
import { PlanService } from '../../src/services/PlanService.js';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.query.mockImplementation(async (sql: string) => sql.includes('FOR UPDATE')
    ? { rows: [{ id: 'escrow', task_id: 'task', state: 'FUNDED' }], rowCount: 1 }
    : { rows: [], rowCount: 1 });
  mocks.binding.mockResolvedValue({ provider: 'tilled', status: 'SUCCEEDED' });
  mocks.getEscrow.mockResolvedValue({ success: true, data: { id: 'escrow', state: 'FUNDED' } });
});
describe('refunds without a certified provider adapter', () => {
  it('records a durable manual requirement and never writes REFUNDED or creates a transfer', async () => {
    await recordManualRefundRequirement('escrow', 'full_refund');
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("refund_blocker = 'MANUAL_REFUND_REQUIRED'"), ['task']);
    const sql = mocks.query.mock.calls.map(([s]) => s).join(' ');
    expect(sql).toContain("refund_state = 'BLOCKED'");
    expect(sql).not.toContain("SET state = 'REFUNDED'");
    expect(sql).toContain('ON CONFLICT (idempotency_key)');
  });
  it('does not overwrite an already finalized refund when a delayed request replays', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'escrow', task_id: 'task', state: 'REFUNDED' }], rowCount: 1 });
    await recordManualRefundRequirement('escrow', 'full_refund');
    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.binding).not.toHaveBeenCalled();
  });
  it('fails provider verification closed without reporting a fabricated refund', async () => {
    await expect(confirmEscrowRefund({ escrowId: 'escrow', paymentIntentId: 'pi', amount: 10000,
      idempotencyKeySuffix: 'test', checkpointType: 'refund' })).rejects.toMatchObject({ code: 'MANUAL_REFUND_REQUIRED' });
  });
  it('returns an explicit full-refund error while preserving prior authoritative refunded replay', async () => {
    expect(await refundEscrow({ escrowId: 'escrow' })).toMatchObject({ success: false, error: { code: 'MANUAL_REFUND_REQUIRED' } });
    mocks.getEscrow.mockResolvedValue({ success: true, data: { id: 'escrow', state: 'REFUNDED' } });
    expect(await refundEscrow({ escrowId: 'escrow' })).toMatchObject({ success: true, data: { state: 'REFUNDED' } });
  });
  it('does not terminalize partial refunds and validates percentages before persistence', async () => {
    expect(await partialRefundEscrow({ escrowId: 'escrow', workerPercent: 50, posterPercent: 50 }))
      .toMatchObject({ success: false, error: { code: 'MANUAL_REFUND_REQUIRED' } });
    mocks.query.mockClear();
    expect(await partialRefundEscrow({ escrowId: 'escrow', workerPercent: 101, posterPercent: -1 }))
      .toMatchObject({ success: false, error: { code: 'INVALID_PERCENT' } });
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
describe('disabled paid subscription lane', () => {
  it('never grants a paid plan from missing, incomplete, or historical subscription state', async () => {
    for (const plan of ['premium', 'pro', null]) {
      mocks.query.mockResolvedValue({ rows: [{ plan }], rowCount: 1 });
      expect(await PlanService.getUserPlan('user')).toBe('free');
    }
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
