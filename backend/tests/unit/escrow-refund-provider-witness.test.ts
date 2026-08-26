import { describe, expect, it, vi } from 'vitest';
import {
  exactSucceededRefundWitness,
  exactSucceededRefundWitnessKey,
  persistExactSucceededRefundWitness,
  type ExactSucceededRefundWitness,
} from '../../src/services/EscrowRefundProviderWitness.js';

const exactProvider = {
  refundId: 're_exact',
  amount: 10_000,
  status: 'succeeded',
  currency: 'usd',
  paymentIntentId: 'pi_exact',
  chargeId: 'ch_exact',
};

const input = {
  escrowId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  taskId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  canonicalState: 'RELEASED',
  paymentIntentId: 'pi_exact',
  expectedAmountCents: 10_000,
};

function exactWitness(): ExactSucceededRefundWitness {
  const witness = exactSucceededRefundWitness({ ...input, provider: exactProvider });
  if (!witness) throw new Error('exact fixture rejected');
  return witness;
}

describe('exact succeeded refund witness', () => {
  it('normalizes only exact current succeeded USD provider evidence', () => {
    expect(exactWitness()).toEqual({
      escrowId: input.escrowId,
      taskId: input.taskId,
      canonicalState: 'RELEASED',
      paymentIntentId: 'pi_exact',
      refundId: 're_exact',
      chargeId: 'ch_exact',
      amountCents: 10_000,
      currency: 'usd',
      status: 'succeeded',
    });
  });

  it.each([
    ['status', { status: 'pending' }],
    ['amount', { amount: 9_999 }],
    ['currency', { currency: 'eur' }],
    ['payment intent', { paymentIntentId: 'pi_other' }],
    ['charge', { chargeId: null }],
  ])('rejects a mismatched %s', async (_label, patch) => {
    expect(exactSucceededRefundWitness({
      ...input,
      provider: { ...exactProvider, ...patch },
    })).toBeNull();
  });

  it('persists and exactly reads back one immutable event', async () => {
    const witness = exactWitness();
    const query = vi.fn().mockImplementation(async (_sql: string, params: unknown[]) => ({
      rows: [{ metadata: JSON.parse(String(params[2])) }],
      rowCount: 1,
    }));

    await persistExactSucceededRefundWitness(query, witness);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('WITH attempted AS');
    expect(params[3]).toBe(exactSucceededRefundWitnessKey(witness));
  });

  it('rejects a conflicting row under the same immutable key', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ metadata: { event_type: 'conflicting' } }],
      rowCount: 1,
    });

    await expect(persistExactSucceededRefundWitness(query, exactWitness()))
      .rejects.toThrow(/witness conflicts/);
  });
});
