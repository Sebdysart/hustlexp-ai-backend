import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prepareRefund:vi.fn(),
  terminalizeRefund:vi.fn(),
  readRefundWitness:vi.fn(),
  createRefund:vi.fn(),
  discoverRefundByClaim:vi.fn(),
  persistWitness:vi.fn(),
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
    discoverRefundByClaim:mocks.discoverRefundByClaim,
    createTransferReversal:vi.fn(),
  },
}));
vi.mock('../../src/services/EscrowRefundProviderWitness.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/EscrowRefundProviderWitness.js')>();
  return { ...actual,persistExactSucceededRefundWitness:mocks.persistWitness };
});
vi.mock('../../src/logger.js', () => ({
  escrowLogger:{ info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn() },
}));

import { refundEscrow } from '../../src/services/EscrowRefundService';
import type { RefundContext } from '../../src/services/EscrowRefundTypes';
import {
  persistRefundProviderFailure,
  persistRefundProviderResolution,
  prepareRefundProviderClaim,
  refundProviderCreateAllowed,
} from '../../src/services/EscrowRefundProviderClaim';

const ESCROW_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const CLAIM_KEY = `refund-provider-create-claim-v1:${ESCROW_ID}:3`;
const PROVIDER_KEY = `hx-refund-claim-v1:${ESCROW_ID}:3`;

function refundContext(overrides: Partial<RefundContext> = {}): RefundContext {
  return {
    escrowId:ESCROW_ID,
    taskId:TASK_ID,
    workerId:null,
    taskVersion:4,
    taskState:'OPEN',
    version:3,
    stateBefore:'FUNDED',
    platformFeeCents:500,
    stripePaymentIntentId:'pi_exact',
    stripeRefundId:null,
    stripeTransferId:null,
    payoutProvider:null,
    providerTransferId:null,
    providerTransferStatus:null,
    providerTransferPaidAt:null,
    amount:5000,
    allowedStates:['FUNDED'],
    providerClaim:{
      claimIdempotencyKey:CLAIM_KEY,
      providerIdempotencyKey:PROVIDER_KEY,
      providerReplayDeadline:new Date('2026-08-26T16:00:00.000Z'),
    },
    ...overrides,
  };
}

function provider(overrides: Record<string, unknown> = {}) {
  return {
    refundId:'re_exact',
    amount:5000,
    status:'succeeded',
    currency:'usd',
    paymentIntentId:'pi_exact',
    chargeId:'ch_exact',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockReset();
  mocks.query.mockImplementation(async (sql: unknown) => (
    String(sql).includes('AS allowed')
      ? { rows:[{ allowed:true }],rowCount:1 }
      : { rows:[{ exact:true }],rowCount:1 }
  ));
  mocks.prepareRefund.mockResolvedValue({ success:true,data:refundContext() });
  mocks.terminalizeRefund.mockResolvedValue({
    success:true,data:{ id:ESCROW_ID,state:'REFUNDED',version:4 },
  });
  mocks.persistWitness.mockResolvedValue(undefined);
  mocks.createRefund.mockResolvedValue({ success:true,data:provider() });
  mocks.discoverRefundByClaim.mockResolvedValue({ success:true,data:provider() });
});

describe('immutable generic refund provider claim', () => {
  it('creates the claim from one DB clock before any provider call', async () => {
    const deadline = new Date('2026-08-26T16:00:00.000Z');
    const query = vi.fn().mockResolvedValueOnce({
      rows:[{
        claim_idempotency_key:CLAIM_KEY,
        provider_idempotency_key:PROVIDER_KEY,
        provider_replay_deadline:deadline,
        exact:true,
      }],
      rowCount:1,
    });

    const claim = await prepareRefundProviderClaim(query as never, {
      escrowId:ESCROW_ID,
      taskId:TASK_ID,
      canonicalState:'FUNDED',
      canonicalVersion:3,
      taskVersion:4,
      taskState:'OPEN',
      workerId:null,
      paymentIntentId:'pi_exact',
      existingRefundId:null,
      amountCents:5000,
    });

    expect(claim).toEqual({
      claimIdempotencyKey:CLAIM_KEY,
      providerIdempotencyKey:PROVIDER_KEY,
      providerReplayDeadline:deadline,
    });
    const [sql,params] = query.mock.calls[0] as [string,unknown[]];
    expect(sql).toContain('SELECT transaction_timestamp() AS claimed_at');
    expect(sql).toContain("'provider_replay_deadline',to_jsonb(clock.claimed_at + interval '20 hours')");
    expect(sql).toContain('idempotency_key,created_at');
    expect(sql).toContain('jsonb_object_length(claim.metadata)=16');
    expect(sql).toContain("prior.metadata->>'event_type'='refund_provider_create_claim_v1'");
    expect(sql).toContain("prior.metadata->>'escrow_id'=$1::text");
    expect(sql).toContain('AND prior.idempotency_key<>$11');
    expect(params.slice(0,10)).toEqual([
      ESCROW_ID,TASK_ID,'FUNDED',3,4,'OPEN',null,'pi_exact',null,5000,
    ]);
    expect(params.slice(10)).toEqual([CLAIM_KEY,PROVIDER_KEY]);
  });

  it('rejects an immutable claim-key collision instead of moving the replay window', async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows:[{
        claim_idempotency_key:CLAIM_KEY,
        provider_idempotency_key:PROVIDER_KEY,
        provider_replay_deadline:new Date('2026-08-26T16:00:00.000Z'),
        exact:false,
      }],
      rowCount:1,
    });

    await expect(prepareRefundProviderClaim(query as never, {
      escrowId:ESCROW_ID,
      taskId:TASK_ID,
      canonicalState:'FUNDED',
      canonicalVersion:3,
      taskVersion:4,
      taskState:'OPEN',
      workerId:null,
      paymentIntentId:'pi_exact',
      existingRefundId:null,
      amountCents:5000,
    })).rejects.toMatchObject({ refundCode:'REFUND_PROVIDER_CLAIM_CONFLICT' });
  });

  it('rejects a new-version claim when an older escrow-scoped claim is unresolved', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows:[],rowCount:0 });

    await expect(prepareRefundProviderClaim(query as never, {
      escrowId:ESCROW_ID,
      taskId:TASK_ID,
      canonicalState:'FUNDED',
      canonicalVersion:4,
      taskVersion:5,
      taskState:'OPEN',
      workerId:null,
      paymentIntentId:'pi_exact',
      existingRefundId:null,
      amountCents:5000,
    })).rejects.toMatchObject({ refundCode:'REFUND_PROVIDER_CLAIM_CONFLICT' });

    const [sql,params] = query.mock.calls[0] as [string,unknown[]];
    expect(sql).toContain(
      "'refund-provider-create-claim-v1:' || $1::text || ':%'",
    );
    expect(sql).toContain("prior.metadata->>'event_type'='refund_provider_create_claim_v1'");
    expect(sql).toContain("prior.metadata->>'escrow_id'=$1::text");
    expect(sql).toContain('prior.idempotency_key<>$11');
    expect(params[10]).toBe(`refund-provider-create-claim-v1:${ESCROW_ID}:4`);
  });

  it('authorizes blind create only from the exact unresolved DB-clock claim', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows:[{ allowed:true }],rowCount:1 });

    await expect(refundProviderCreateAllowed(query as never, refundContext())).resolves.toBe(true);

    const [sql,params] = query.mock.calls[0] as [string,unknown[]];
    expect(sql).toContain("transaction_timestamp() < claim.created_at + interval '20 hours'");
    expect(sql).toContain("outcome.metadata->>'event_type'='refund_provider_claim_resolved_v1'");
    expect(sql).toContain("to_jsonb(claim.created_at + interval '20 hours') #>> '{}'");
    expect(params[2]).toBe(CLAIM_KEY);
    expect(params[11]).toBe(PROVIDER_KEY);
  });

  it('persists provider failure as an unresolved append-only outcome', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows:[{ exact:true }],rowCount:1 });

    await persistRefundProviderFailure(query as never, refundContext(), 'STRIPE:timeout');

    const [,params] = query.mock.calls[0] as [string,unknown[]];
    const metadata = JSON.parse(String(params[2]));
    expect(metadata).toEqual({
      event_type:'refund_provider_create_failed_v1',
      claim_idempotency_key:CLAIM_KEY,
      provider:'stripe',
      escrow_id:ESCROW_ID,
      task_id:TASK_ID,
      canonical_version:3,
      payment_intent_id:'pi_exact',
      refund_amount_cents:5000,
      provider_idempotency_key:PROVIDER_KEY,
      provider_error_code:'STRIPE_timeout',
      claim_resolved:false,
    });
    expect(params[3]).toBe(
      `refund-provider-create-failed-v1:${ESCROW_ID}:3:STRIPE_timeout`,
    );
  });

  it('persists the only resolving outcome as exact FUNDED to REFUNDED evidence', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows:[{ exact:true }],rowCount:1 });

    await persistRefundProviderResolution(query as never, refundContext(), 're_exact');

    const [sql,params] = query.mock.calls[0] as [string,unknown[]];
    expect(sql).toContain("VALUES ($1,$2,'REFUNDED',NULL,'system'");
    expect(JSON.parse(String(params[2]))).toMatchObject({
      event_type:'refund_provider_claim_resolved_v1',
      claim_idempotency_key:CLAIM_KEY,
      canonical_state_before:'FUNDED',
      canonical_state_after:'REFUNDED',
      canonical_version_before:3,
      canonical_version_after:4,
      refund_id:'re_exact',
      resolution:'canonical_refunded',
    });
    expect(params[3]).toBe(
      `refund-provider-claim-resolved-v1:${ESCROW_ID}:3:re_exact`,
    );
  });
});

describe('generic refund provider crash recovery', () => {
  it('uses the exact durable key and metadata for every in-window provider create', async () => {
    const result = await refundEscrow({ escrowId:ESCROW_ID });

    expect(result).toMatchObject({ success:true,data:{ state:'REFUNDED' } });
    expect(mocks.createRefund).toHaveBeenCalledWith({
      paymentIntentId:'pi_exact',
      escrowId:ESCROW_ID,
      amount:5000,
      reason:'requested_by_customer',
      idempotencyKeySuffix:'svc_refund',
      providerIdempotencyKey:PROVIDER_KEY,
      refundClaimKey:CLAIM_KEY,
    });
    expect(mocks.discoverRefundByClaim).not.toHaveBeenCalled();
    expect(mocks.persistWitness).toHaveBeenCalledWith(
      mocks.query,
      expect.objectContaining({ refundId:'re_exact',escrowId:ESCROW_ID,taskId:TASK_ID }),
    );
  });

  it('retries a hard post-provider crash with the same provider key', async () => {
    mocks.persistWitness
      .mockRejectedValueOnce(new Error('hard crash before durable witness'))
      .mockResolvedValueOnce(undefined);

    const crashed = await refundEscrow({ escrowId:ESCROW_ID });
    const recovered = await refundEscrow({ escrowId:ESCROW_ID });

    expect(crashed).toMatchObject({ success:false,error:{ code:'DB_ERROR' } });
    expect(recovered).toMatchObject({ success:true,data:{ state:'REFUNDED' } });
    expect(mocks.createRefund).toHaveBeenCalledTimes(2);
    expect(mocks.createRefund.mock.calls[0][0]).toEqual(mocks.createRefund.mock.calls[1][0]);
    expect(mocks.terminalizeRefund).toHaveBeenCalledTimes(1);
  });

  it('discovers exact provider truth after the blind-create window and never creates again', async () => {
    mocks.query.mockImplementation(async (sql: unknown) => (
      String(sql).includes('AS allowed')
        ? { rows:[{ allowed:false }],rowCount:1 }
        : { rows:[{ exact:true }],rowCount:1 }
    ));

    const result = await refundEscrow({ escrowId:ESCROW_ID });

    expect(result).toMatchObject({ success:true,data:{ state:'REFUNDED' } });
    expect(mocks.createRefund).not.toHaveBeenCalled();
    expect(mocks.discoverRefundByClaim).toHaveBeenCalledWith({
      paymentIntentId:'pi_exact',
      escrowId:ESCROW_ID,
      expectedAmountCents:5000,
      refundClaimKey:CLAIM_KEY,
      providerIdempotencyKey:PROVIDER_KEY,
    });
  });

  it.each([
    ['pagination','STRIPE_REFUND_DISCOVERY_PAGINATION'],
    ['ambiguity','STRIPE_REFUND_AMBIGUOUS'],
    ['pending','STRIPE_REFUND_PENDING'],
    ['mismatch','STRIPE_REFUND_DISCOVERY_MISMATCH'],
  ])('fails closed on expired-claim %s and performs zero blind creates', async (_name, code) => {
    mocks.query.mockImplementation(async (sql: unknown) => (
      String(sql).includes('AS allowed')
        ? { rows:[{ allowed:false }],rowCount:1 }
        : { rows:[{ exact:true }],rowCount:1 }
    ));
    mocks.discoverRefundByClaim.mockResolvedValueOnce({
      success:false,error:{ code,message:'ambiguous provider truth' },
    });

    const result = await refundEscrow({ escrowId:ESCROW_ID });

    expect(result).toMatchObject({
      success:false,error:{ code:'STRIPE_REFUND_RECONCILIATION_REQUIRED' },
    });
    expect(mocks.createRefund).not.toHaveBeenCalled();
    expect(mocks.persistWitness).not.toHaveBeenCalled();
    expect(mocks.terminalizeRefund).not.toHaveBeenCalled();
  });

  it('records a provider failure without falsely resolving the claim', async () => {
    mocks.createRefund.mockResolvedValueOnce({
      success:false,error:{ code:'STRIPE_ERROR',message:'connection reset' },
    });

    const result = await refundEscrow({ escrowId:ESCROW_ID });

    expect(result).toMatchObject({ success:false,error:{ code:'STRIPE_REFUND_FAILED' } });
    const failureCall = mocks.query.mock.calls.find((call) => {
      const params = call[1] as unknown[] | undefined;
      if (!params?.[2]) return false;
      try {
        return JSON.parse(String(params[2])).event_type === 'refund_provider_create_failed_v1';
      } catch {
        return false;
      }
    });
    expect(failureCall).toBeDefined();
    expect(JSON.parse(String((failureCall?.[1] as unknown[])[2]))).toMatchObject({
      claim_idempotency_key:CLAIM_KEY,
      provider_error_code:'STRIPE_ERROR',
      claim_resolved:false,
    });
    expect(mocks.terminalizeRefund).not.toHaveBeenCalled();
  });
});
