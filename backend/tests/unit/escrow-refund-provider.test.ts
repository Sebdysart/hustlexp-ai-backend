import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, createRefund, getEscrowRefund } = vi.hoisted(() => ({
  query: vi.fn(),
  createRefund: vi.fn(),
  getEscrowRefund: vi.fn(),
}));
vi.mock('../../src/db', () => ({ db: { query } }));
vi.mock('../../src/services/StripeService', () => ({ StripeService: { createRefund, getEscrowRefund } }));

import { confirmEscrowRefund } from '../../src/services/EscrowRefundProvider';

const input = {
  escrowId: 'escrow-1',
  paymentIntentId: 'pi-1',
  amount: 2500,
  idempotencyKeySuffix: 'svc_refund',
  checkpointType: 'full_refund_pending',
};

beforeEach(() => {
  vi.resetAllMocks();
  let checkpoint: { stripe_refund_id: string } | null = null;
  query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes('INSERT INTO escrow_events')) {
      checkpoint = JSON.parse(String(params[1]));
      return { rows: [], rowCount: 1 };
    }
    return { rows: checkpoint ? [{ metadata: checkpoint }] : [], rowCount: checkpoint ? 1 : 0 };
  });
});

describe('escrow refund provider confirmation', () => {
  it('does not finalize a pending refund and recovers the same identity after provider success', async () => {
    createRefund.mockResolvedValue({ success: true, data: { refundId: 're-1', amount: 2500, status: 'pending' } });
    await expect(confirmEscrowRefund(input)).rejects.toThrow('REFUND_NOT_SUCCEEDED');
    getEscrowRefund.mockResolvedValue({ success: true, data: {
      refundId: 're-1', amount: 2500, status: 'succeeded', paymentIntentId: 'pi-1', escrowId: 'escrow-1',
    } });
    await expect(confirmEscrowRefund(input)).resolves.toBe('re-1');
    expect(createRefund).toHaveBeenCalledTimes(1);
  });

  it('fails closed on failed status, wrong amount or mismatched provider binding', async () => {
    createRefund.mockResolvedValue({ success: true, data: { refundId: 're-1', amount: 2500, status: 'failed' } });
    await expect(confirmEscrowRefund(input)).rejects.toThrow('REFUND_NOT_SUCCEEDED');
    getEscrowRefund.mockResolvedValue({ success: true, data: {
      refundId: 're-1', amount: 2499, status: 'succeeded', paymentIntentId: 'pi-1', escrowId: 'escrow-1',
    } });
    await expect(confirmEscrowRefund(input)).rejects.toThrow('REFUND_BINDING_MISMATCH');
    getEscrowRefund.mockResolvedValue({ success: true, data: {
      refundId: 're-1', amount: 2500, status: 'succeeded', paymentIntentId: 'pi-other', escrowId: 'escrow-1',
    } });
    await expect(confirmEscrowRefund(input)).rejects.toThrow('REFUND_BINDING_MISMATCH');
  });

  it('does not issue a replacement refund when verification is unavailable', async () => {
    query.mockResolvedValue({ rows: [{ metadata: { stripe_refund_id: 're-existing' } }], rowCount: 1 });
    getEscrowRefund.mockResolvedValue({ success: false, error: { code: 'STRIPE_ERROR' } });
    await expect(confirmEscrowRefund(input)).rejects.toThrow('REFUND_VERIFICATION_UNAVAILABLE');
    expect(createRefund).not.toHaveBeenCalled();
  });
});
