import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getEscrowById: vi.fn(),
  notifyAdmins: vi.fn(),
}));

vi.mock('../../src/services/EscrowReadService.js', () => ({
  getEscrowById: mocks.getEscrowById,
}));
vi.mock('../../src/services/AdminNotificationHelper.js', () => ({
  notifyAdmins: mocks.notifyAdmins,
}));
vi.mock('../../src/services/EscrowServiceShared.js', () => ({
  isTerminalEscrowState:(state:string) => ['RELEASED','REFUNDED','REFUND_PARTIAL'].includes(state),
}));
vi.mock('../../src/logger.js', () => ({
  escrowLogger: { info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn() },
  logger:{ child:() => ({ info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn() }) },
}));

import { prepareRefund, terminalizeRefund } from '../../src/services/EscrowRefundTransaction';
import type { RefundContext } from '../../src/services/EscrowRefundTypes';

const ESCROW_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';

function context(overrides: Partial<RefundContext> = {}): RefundContext {
  return {
    escrowId:ESCROW_ID,
    taskId:TASK_ID,
    workerId:null,
    taskVersion:4,
    taskState:'OPEN',
    version:7,
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
      claimIdempotencyKey:`refund-provider-create-claim-v1:${ESCROW_ID}:7`,
      providerIdempotencyKey:`hx-refund-claim-v1:${ESCROW_ID}:7`,
      providerReplayDeadline:new Date('2026-08-26T16:00:00.000Z'),
    },
    ...overrides,
  };
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    id:TASK_ID,
    version:4,
    worker_id:null,
    state:'OPEN',
    ...overrides,
  };
}

function locked(overrides: Record<string, unknown> = {}) {
  return {
    id:ESCROW_ID,
    task_id:TASK_ID,
    version:7,
    state:'FUNDED',
    amount:5000,
    platform_fee_cents:500,
    stripe_payment_intent_id:'pi_exact',
    stripe_refund_id:null,
    stripe_transfer_id:null,
    payout_provider:null,
    provider_transfer_id:null,
    provider_transfer_status:null,
    provider_transfer_paid_at:null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getEscrowById.mockResolvedValue({
    success:true,
    data:{ id:ESCROW_ID,state:'FUNDED' },
  });
});

describe('terminalizeRefund exact T1/T2 binding', () => {
  it('locks and snapshots the task aggregate before provider work', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows:[locked()],rowCount:1 })
      .mockResolvedValueOnce({ rows:[task()],rowCount:1 })
      .mockResolvedValueOnce({
        rows:[{
          claim_idempotency_key:`refund-provider-create-claim-v1:${ESCROW_ID}:7`,
          provider_idempotency_key:`hx-refund-claim-v1:${ESCROW_ID}:7`,
          provider_replay_deadline:new Date('2026-08-26T16:00:00.000Z'),
          exact:true,
        }],
        rowCount:1,
      });

    const result = await prepareRefund(query as never, ESCROW_ID, false);

    expect(result).toMatchObject({
      success:true,
      data:{
        taskVersion:4,
        taskState:'OPEN',
        workerId:null,
        providerClaim:{
          claimIdempotencyKey:`refund-provider-create-claim-v1:${ESCROW_ID}:7`,
        },
      },
    });
    expect(String(query.mock.calls[1][0])).toContain('FROM tasks WHERE id = $1 FOR UPDATE');
    expect(String(query.mock.calls[2][0])).toContain("'refund_provider_create_claim_v1'");
  });

  it('terminalizes only the exact Phase-1 version and immutable succeeded-refund witness', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows:[locked()],rowCount:1 })
      .mockResolvedValueOnce({ rows:[task()],rowCount:1 })
      .mockResolvedValueOnce({ rows:[{ exact:true }],rowCount:1 })
      .mockResolvedValueOnce({ rows:[{}],rowCount:1 })
      .mockResolvedValueOnce({
        rows:[{
          id:ESCROW_ID,state:'REFUNDED',version:8,stripe_refund_id:'re_exact',
          refund_transition_event_exact:true,
        }],
        rowCount:1,
      });

    const result = await terminalizeRefund(query as never, context(), 're_exact');

    expect(result).toMatchObject({ success:true,data:{ state:'REFUNDED',version:8 } });
    const [resolutionSql,resolutionParams] = query.mock.calls[2] as [string,unknown[]];
    expect(resolutionSql).toContain("'REFUNDED'");
    expect(resolutionParams[3]).toBe(
      `refund-provider-claim-resolved-v1:${ESCROW_ID}:7:re_exact`,
    );
    expect(String(query.mock.calls[3][0])).toContain('hustlexp.refund_terminal_authority');
    const [sql,params] = query.mock.calls[4] as [string,unknown[]];
    expect(sql).toContain("event.metadata->>'event_type'='exact_succeeded_refund_witness_v1'");
    expect(sql).toContain('AND version=$2');
    expect(sql).toContain('AND task_id=$5');
    expect(sql).toContain('provider_transfer_paid_at IS NOT DISTINCT FROM $14');
    expect(sql).toContain('task.id=$5 AND task.version=$15 AND task.state=$16');
    expect(sql).toContain("'event_type','escrow_refunded_transition_v1'");
    expect(sql).toContain("'refund_provider_create_claim_v1'");
    expect(sql).toContain('refund-provider-claim-resolved-v1:');
    expect(sql).toContain('event.metadata=desired.event_metadata');
    expect(params[1]).toBe(7);
    expect(params[2]).toBe('re_exact');
    expect(params.slice(14,17)).toEqual([4,'OPEN',null]);
    expect(params[17]).toBe(`refund-provider-create-claim-v1:${ESCROW_ID}:7`);
  });

  it.each([
    ['version drift',{ version:8 }],
    ['amount drift',{ amount:5001 }],
    ['payment-intent drift',{ stripe_payment_intent_id:'pi_other' }],
    ['transfer drift',{ stripe_transfer_id:'tr_other' }],
    ['provider-status drift',{ provider_transfer_status:'submitted' }],
  ])('persists exact reconciliation evidence and refuses %s', async (_name, drift) => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows:[locked(drift)],rowCount:1 })
      .mockResolvedValueOnce({ rows:[task()],rowCount:1 })
      .mockResolvedValueOnce({ rows:[{ exact:true }],rowCount:1 });

    const result = await terminalizeRefund(query as never, context(), 're_exact');

    expect(result).toMatchObject({ success:false,error:{ code:'INVALID_STATE' } });
    expect(query).toHaveBeenCalledTimes(3);
    const [recoverySql,recoveryParams] = query.mock.calls[2] as [string,unknown[]];
    expect(recoverySql).toContain('INSERT INTO escrow_events');
    expect(JSON.parse(String(recoveryParams[3]))).toMatchObject({
      event_type:'refund_canonical_reconciliation_required_v1',
      reconciliation_required:true,
    });
    expect(recoveryParams[2]).toBe(
      `refund-canonical-reconciliation-required-v1:${ESCROW_ID}:re_exact:7`,
    );
  });

  it.each([
    ['task version drift',{ version:5 }],
    ['task assignment drift',{ state:'ACCEPTED',worker_id:'33333333-3333-4333-8333-333333333333',version:5 }],
  ])('persists recovery evidence and refuses %s', async (_name, drift) => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows:[locked()],rowCount:1 })
      .mockResolvedValueOnce({ rows:[task(drift)],rowCount:1 })
      .mockResolvedValueOnce({ rows:[{ exact:true }],rowCount:1 });

    const result = await terminalizeRefund(query as never, context(), 're_exact');

    expect(result).toMatchObject({
      success:false,
      error:{ code:'INVALID_STATE',message:expect.stringContaining('task assignment changed') },
    });
    const metadata = JSON.parse(String(query.mock.calls[2][1][3]));
    expect(metadata).toMatchObject({
      expected:{ task_version:4,task_state:'OPEN',worker_id:null },
      observed:{ task_version:drift.version },
      reconciliation_required:true,
    });
  });

  it('fails closed when immutable recovery evidence conflicts', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows:[locked({ version:8 })],rowCount:1 })
      .mockResolvedValueOnce({ rows:[task()],rowCount:1 })
      .mockResolvedValueOnce({ rows:[{ exact:false }],rowCount:1 });

    await expect(terminalizeRefund(query as never, context(), 're_exact'))
      .rejects.toThrow(/recovery evidence conflicts/);
  });

  it('accepts an already-refunded retry only with the exact refund and transition witnesses', async () => {
    const terminal = locked({
      state:'REFUNDED',
      version:8,
      stripe_refund_id:'re_exact',
    });
    const query = vi.fn()
      .mockResolvedValueOnce({ rows:[terminal],rowCount:1 })
      .mockResolvedValueOnce({ rows:[task()],rowCount:1 })
      .mockResolvedValueOnce({ rows:[{ exact:true }],rowCount:1 });
    mocks.getEscrowById.mockResolvedValueOnce({
      success:true,
      data:{ id:ESCROW_ID,state:'REFUNDED',version:8,stripe_refund_id:'re_exact' },
    });

    const result = await terminalizeRefund(query as never, context(), 're_exact');

    expect(result).toMatchObject({
      success:true,
      data:{ state:'REFUNDED',stripe_refund_id:'re_exact' },
    });
    const [witnessSql,witnessParams] = query.mock.calls[2] as [string,unknown[]];
    expect(witnessSql).toContain("event.metadata->>'refund_id'=$3");
    expect(witnessSql).toContain("event.to_state='REFUNDED'");
    expect(witnessSql).not.toContain('refund_canonical_reconciliation_required_v1');
    expect(witnessParams[2]).toBe('re_exact');
    expect(witnessParams[6]).toBe(`escrow-refunded-transition-v1:${ESCROW_ID}:8`);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('refuses an already-refunded row carrying a different provider refund identity', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows:[locked({ state:'REFUNDED',version:8,stripe_refund_id:'re_other' })],
        rowCount:1,
      })
      .mockResolvedValueOnce({ rows:[task()],rowCount:1 })
      .mockResolvedValueOnce({ rows:[{ exact:true }],rowCount:1 });
    mocks.getEscrowById.mockResolvedValueOnce({
      success:true,
      data:{ id:ESCROW_ID,state:'REFUNDED',version:8,stripe_refund_id:'re_other' },
    });

    const result = await terminalizeRefund(query as never, context(), 're_exact');

    expect(result).toMatchObject({
      success:false,
      error:{ code:'REFUND_RECONCILIATION_REQUIRED' },
    });
    expect(query).toHaveBeenCalledTimes(3);
    expect(mocks.getEscrowById).not.toHaveBeenCalled();
  });

  it('refuses an already-refunded retry when its immutable witnesses are missing', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows:[locked({ state:'REFUNDED',version:8,stripe_refund_id:'re_exact' })],
        rowCount:1,
      })
      .mockResolvedValueOnce({ rows:[task()],rowCount:1 })
      .mockResolvedValueOnce({ rows:[{ exact:false }],rowCount:1 })
      .mockResolvedValueOnce({ rows:[{ exact:true }],rowCount:1 });

    const result = await terminalizeRefund(query as never, context(), 're_exact');

    expect(result).toMatchObject({
      success:false,
      error:{ code:'REFUND_RECONCILIATION_REQUIRED' },
    });
    expect(mocks.getEscrowById).not.toHaveBeenCalled();
    expect(JSON.parse(String(query.mock.calls[3][1][3]))).toMatchObject({
      event_type:'refund_canonical_reconciliation_required_v1',
      reconciliation_required:true,
    });
  });
});
