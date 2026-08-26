import { beforeEach,describe,expect,it,vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());

vi.mock('../../src/db.js', () => ({
  db:{ query,transaction:vi.fn(async (callback) => callback(query)) },
}));

import { db } from '../../src/db.js';
import {
  FULL_TRANSFER_REVERSAL_RECONCILIATION_EVENT,
  persistFullTransferReversalReconciliationRequired,
} from '../../src/services/EscrowFullTransferReversalRecovery.js';
import type {
  ExactFullTransferReversalBinding,
  TransferReversalEvidence,
} from '../../src/services/EscrowRefundService.js';

const binding:ExactFullTransferReversalBinding = {
  escrowId:'00000000-0000-0000-0000-000000000001',
  canonicalState:'LOCKED_DISPUTE',
  taskId:'10000000-0000-0000-0000-000000000001',
  workerId:'20000000-0000-0000-0000-000000000001',
  payoutRecipientUserId:'20000000-0000-0000-0000-000000000001',
  destinationAccountId:'acct_exact',
  stripePaymentIntentId:'pi_exact',
  transferId:'tr_exact',
  escrowAmountCents:10_000,
  platformFeeCents:2_000,
  insuranceContributionCents:200,
  transferAmountCents:7_800,
};

const evidence:TransferReversalEvidence = {
  reversalId:'trr_exact',
  reversalAmountCents:7_800,
  transferWitness:{
    provider:'STRIPE',transferId:'tr_exact',amountCents:7_800,currency:'usd',
    destinationAccountId:'acct_exact',reversed:true,amountReversedCents:7_800,
    escrowId:binding.escrowId,taskId:binding.taskId,
    payoutRecipientUserId:binding.payoutRecipientUserId,
  },
};

function observed(overrides:Record<string,unknown> = {}) {
  return {
    id:binding.escrowId,task_id:binding.taskId,state:'REFUNDED',version:9,
    amount:10_000,platform_fee_cents:2_000,stripe_payment_intent_id:'pi_exact',
    stripe_refund_id:'ref_concurrent',stripe_transfer_id:null,
    provider_transfer_status:'reversed',worker_id:binding.workerId,
    payout_recipient_user_id:null,task_price:10_000,...overrides,
  };
}

beforeEach(() => {
  query.mockReset();
  vi.mocked(db.transaction).mockClear();
});

describe('full-transfer reversal post-provider recovery witness', () => {
  it('persists and reads back the original, observed, and provider bindings after canonical drift', async () => {
    query
      .mockResolvedValueOnce({ rows:[observed()],rowCount:1 })
      .mockResolvedValueOnce({ rows:[{ id:'event-recovery' }],rowCount:1 });

    await persistFullTransferReversalReconciliationRequired(binding,evidence);

    expect(db.transaction).toHaveBeenCalledOnce();
    const insert = query.mock.calls[1];
    const metadata = JSON.parse(String(insert[1][2])) as Record<string,unknown>;
    expect(metadata).toMatchObject({
      event_type:FULL_TRANSFER_REVERSAL_RECONCILIATION_EVENT,
      expected_binding:{
        escrow_id:binding.escrowId,canonical_state:'LOCKED_DISPUTE',
        stripe_transfer_id:'tr_exact',transfer_amount_cents:7_800,
      },
      observed_binding:{
        canonical_state:'REFUNDED',version:9,stripe_transfer_id:null,
        stripe_refund_id:'ref_concurrent',provider_transfer_status:'reversed',
      },
      provider_reversal:{
        reversal_id:'trr_exact',reversal_amount_cents:7_800,
        current_transfer_witness:{
          transfer_id:'tr_exact',reversed:true,amount_reversed_cents:7_800,
        },
      },
    });
    expect(String(insert[0])).toContain('metadata::jsonb=$3::jsonb');
    expect(String(insert[1][3])).toContain(':REFUNDED:9');
  });

  it('fails closed when the immutable recovery key cannot be read back exactly', async () => {
    query
      .mockResolvedValueOnce({ rows:[observed({ state:'LOCKED_DISPUTE',version:7 })],rowCount:1 })
      .mockResolvedValueOnce({ rows:[],rowCount:0 });

    await expect(persistFullTransferReversalReconciliationRequired(binding,evidence))
      .rejects.toThrow(/recovery witness conflicts/);
  });
});
