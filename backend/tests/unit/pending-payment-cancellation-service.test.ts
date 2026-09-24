import { beforeEach, describe, expect, it, vi } from 'vitest';
const record = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/EscrowRefundProvider.js', () => ({ recordManualRefundRequirement: record }));
import { PendingPaymentCancellationService } from '../../src/services/PendingPaymentCancellationService.js';
beforeEach(() => vi.resetAllMocks());
describe('unsupported pending payment cancellation', () => {
  it('durably requests manual resolution instead of claiming cancellation or issuing an undocumented provider call', async () => {
    await PendingPaymentCancellationService.execute({ escrowId: 'escrow', taskId: 'task', reason: 'expired' });
    expect(record).toHaveBeenCalledWith('escrow', 'payment_cancellation', 'expired');
  });
  it('propagates failed durable recording for queue retry', async () => {
    record.mockRejectedValue(new Error('database unavailable'));
    await expect(PendingPaymentCancellationService.execute({ escrowId: 'escrow', taskId: 'task', reason: 'expired' }))
      .rejects.toThrow('database unavailable');
  });
});
