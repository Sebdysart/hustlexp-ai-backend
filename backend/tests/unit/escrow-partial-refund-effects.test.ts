import { beforeEach, describe, expect, it, vi } from 'vitest';

const reconcile = vi.hoisted(() => vi.fn());

vi.mock('../../src/services/EscrowPartialRefundReconciliationService.js', () => ({
  reconcilePartialRefundPostTerminal: reconcile,
}));

vi.mock('../../src/services/EscrowPartialRefundEvidence.js', () => ({
  partialRefundReconciliationError: (message: string) => Object.assign(new Error(message), {
    code: 'PARTIAL_REFUND_RECONCILIATION_REQUIRED',
    details: { reconciliationRequired: true },
  }),
}));

import { runPartialRefundEffects } from '../../src/services/EscrowPartialRefundEffects.js';

const context = {
  escrowId: '00000000-0000-0000-0000-000000000299',
  escrowVersion: 3,
  escrowState: 'LOCKED_DISPUTE',
  taskId: '10000000-0000-0000-0000-000000000299',
  amount: 10_000,
  canonicalPlatformFeeCents: null,
  stripePaymentIntentId: 'pi_effect_299',
  existingTransferId: null,
  existingRefundId: null,
  existingRefundAmount: null,
  existingReleaseAmount: null,
  workerId: 'worker-299',
  payoutRecipientUserId: 'worker-299',
  providerOrganizationId: null,
  providerAssignmentId: null,
  posterId: 'poster-299',
  payoutStripeConnectId: 'acct_effect_299',
  payoutDestinationError: null,
};

const amounts = {
  workerPercent: 60,
  posterPercent: 40,
  workerCents: 6_000,
  posterCents: 4_000,
  platformFeePercent: 15,
  netWorkerCentsBeforeInsurance: 5_100,
  insuranceContributionCents: 120,
  netWorkerCents: 4_980,
};

const provider = {
  transferId: 'tr_effect_299',
  refundId: 're_effect_299',
  transferWitness: null,
  transferCreated: true,
};

beforeEach(() => {
  vi.resetAllMocks();
  reconcile.mockResolvedValue({ binding: {}, provider: {} });
});

describe('EscrowPartialRefundEffects — terminal reconciler boundary', () => {
  it('delegates the exact settlement identity and percentages', async () => {
    await runPartialRefundEffects({ context, amounts, provider });

    expect(reconcile).toHaveBeenCalledWith({
      escrowId: context.escrowId,
      taskId: context.taskId,
      refundAmountCents: amounts.posterCents,
      releaseAmountCents: amounts.workerCents,
      workerPercent: amounts.workerPercent,
      posterPercent: amounts.posterPercent,
    });
  });

  it('fails closed when the escrow is not terminal', async () => {
    reconcile.mockResolvedValueOnce(null);

    await expect(runPartialRefundEffects({ context, amounts, provider }))
      .rejects.toMatchObject({ code: 'PARTIAL_REFUND_RECONCILIATION_REQUIRED' });
  });

  it('propagates a reconciliation failure without direct fallback effects', async () => {
    reconcile.mockRejectedValueOnce(new Error('effect checkpoint unavailable'));

    await expect(runPartialRefundEffects({ context, amounts, provider }))
      .rejects.toThrow('effect checkpoint unavailable');
    expect(reconcile).toHaveBeenCalledOnce();
  });
});
