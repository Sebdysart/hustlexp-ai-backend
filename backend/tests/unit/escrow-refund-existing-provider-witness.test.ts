import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prepareRefund:vi.fn(),
  terminalizeRefund:vi.fn(),
  readRefundWitness:vi.fn(),
  createRefund:vi.fn(),
  persistWitness:vi.fn(),
  logEscrowEvent:vi.fn(),
  clawbackXP:vi.fn(),
  query:vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  db:{
    transaction:vi.fn(async (fn: (query: typeof mocks.query) => Promise<unknown>) => fn(mocks.query)),
  },
}));
vi.mock('../../src/services/EscrowRefundTransaction.js', () => ({
  prepareRefund:mocks.prepareRefund,
  terminalizeRefund:mocks.terminalizeRefund,
}));
vi.mock('../../src/services/StripeService.js', () => ({
  StripeService:{
    readRefundWitness:mocks.readRefundWitness,
    createRefund:mocks.createRefund,
    discoverRefundByClaim:vi.fn(),
    createTransferReversal:vi.fn(),
  },
}));
vi.mock('../../src/services/EscrowRefundProviderWitness.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/EscrowRefundProviderWitness.js')>();
  return { ...actual,persistExactSucceededRefundWitness:mocks.persistWitness };
});
vi.mock('../../src/services/EscrowServiceShared.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/EscrowServiceShared.js')>();
  return { ...actual,logEscrowEvent:mocks.logEscrowEvent };
});
vi.mock('../../src/services/XPService.js', () => ({
  XPService:{ clawbackXP:mocks.clawbackXP },
}));
vi.mock('../../src/logger.js', () => ({
  escrowLogger:{ info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn() },
}));

import { refundEscrow } from '../../src/services/EscrowRefundService';
import type { RefundContext } from '../../src/services/EscrowRefundTypes';

const ESCROW_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';

function refundContext(overrides: Partial<RefundContext> = {}): RefundContext {
  return {
    escrowId:ESCROW_ID,taskId:TASK_ID,workerId:null,version:3,stateBefore:'FUNDED',
    taskVersion:4,taskState:'OPEN',
    platformFeeCents:500,stripePaymentIntentId:'pi_exact',stripeRefundId:'re_existing',
    stripeTransferId:null,payoutProvider:null,providerTransferId:null,
    providerTransferStatus:null,providerTransferPaidAt:null,amount:5000,
    allowedStates:['FUNDED'],
    providerClaim:{
      claimIdempotencyKey:`refund-provider-create-claim-v1:${ESCROW_ID}:3`,
      providerIdempotencyKey:`hx-refund-claim-v1:${ESCROW_ID}:3`,
      providerReplayDeadline:new Date('2026-08-26T16:00:00.000Z'),
    },
    ...overrides,
  };
}

function provider(overrides: Record<string, unknown> = {}) {
  return {
    refundId:'re_existing',amount:5000,status:'succeeded',currency:'usd',
    paymentIntentId:'pi_exact',chargeId:'ch_exact',...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockReset();
  mocks.prepareRefund.mockResolvedValue({ success:true,data:refundContext() });
  mocks.terminalizeRefund.mockResolvedValue({
    success:true,data:{ id:ESCROW_ID,state:'REFUNDED',version:4 },
  });
  mocks.persistWitness.mockResolvedValue(undefined);
  mocks.logEscrowEvent.mockResolvedValue(undefined);
});

describe('refundEscrow existing provider identity', () => {
  it('retrieves and persists the current exact succeeded refund before terminalization', async () => {
    mocks.readRefundWitness.mockResolvedValue({ success:true,data:provider() });

    const result = await refundEscrow({ escrowId:ESCROW_ID });

    expect(result).toMatchObject({ success:true,data:{ state:'REFUNDED' } });
    expect(mocks.readRefundWitness).toHaveBeenCalledWith('re_existing');
    expect(mocks.createRefund).not.toHaveBeenCalled();
    expect(mocks.persistWitness).toHaveBeenCalledWith(mocks.query, expect.objectContaining({
      escrowId:ESCROW_ID,taskId:TASK_ID,refundId:'re_existing',status:'succeeded',
    }));
    expect(mocks.terminalizeRefund).toHaveBeenCalledWith(
      mocks.query,
      expect.objectContaining({ version:3,stripeRefundId:'re_existing' }),
      're_existing',
    );
  });

  it.each([
    ['pending status',{ status:'pending' }],
    ['failed status',{ status:'failed' }],
    ['wrong amount',{ amount:4999 }],
    ['wrong currency',{ currency:'cad' }],
    ['wrong payment intent',{ paymentIntentId:'pi_other' }],
    ['missing charge',{ chargeId:null }],
  ])('refuses %s from current provider readback', async (_name, mismatch) => {
    mocks.readRefundWitness.mockResolvedValue({ success:true,data:provider(mismatch) });

    const result = await refundEscrow({ escrowId:ESCROW_ID });

    expect(result).toMatchObject({
      success:false,error:{ code:'STRIPE_REFUND_EVIDENCE_MISMATCH' },
    });
    expect(mocks.terminalizeRefund).not.toHaveBeenCalled();
  });

  it('fails closed when the current refund cannot be retrieved', async () => {
    mocks.readRefundWitness.mockResolvedValue({
      success:false,error:{ code:'STRIPE_ERROR',message:'provider unavailable' },
    });

    const result = await refundEscrow({ escrowId:ESCROW_ID });

    expect(result).toMatchObject({
      success:false,error:{ code:'STRIPE_REFUND_EVIDENCE_MISMATCH' },
    });
    expect(mocks.terminalizeRefund).not.toHaveBeenCalled();
  });
});
