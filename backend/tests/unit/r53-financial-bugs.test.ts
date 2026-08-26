/**
 * R53 Financial Bug Tests
 *
 * F53-6: Tip platform cut must be 0% — verified via RevenueService.logEvent call args
 * F53-7: Self-insurance pool funding path in handlePartialRefundRequest must be reachable
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { enableControlledStripePaymentTestCohortV7 } from '../helpers/payment-underwriting-v7';

const { payoutDestination, reconcilePartialRefund, markPartialOutboxProcessed } = vi.hoisted(() => ({
  payoutDestination: vi.fn(),
  reconcilePartialRefund: vi.fn(),
  markPartialOutboxProcessed: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mocks for F53-6 (TippingService.confirmTip platform cut)
// ---------------------------------------------------------------------------

const { mockPaymentIntentsRetrieve } = vi.hoisted(() => ({
  mockPaymentIntentsRetrieve: vi.fn(),
}));

vi.mock('../../src/db', () => {
  const queryFn = vi.fn();
  return {
    db: {
      query: queryFn,
      transaction: vi.fn(async (fn: (q: typeof queryFn) => Promise<unknown>) => fn(queryFn)),
    },
  };
});

vi.mock('../../src/logger', () => {
  const base = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: () => base };
  return {
    logger: base,
    escrowLogger: base,
    taskLogger: base,
    aiLogger: base,
    stripeLogger: base,
    authLogger: base,
    workerLogger: base,
    dbLogger: base,
  };
});

vi.mock('../../src/config', () => ({
  config: {
    stripe: { secretKey: 'sk_test_fake123', platformFeePercent: 15 },
    queue: { hmacSecret: 'test-hmac-secret-for-unit-tests' },
  },
}));

vi.mock('stripe', () => {
  return {
    default: class MockStripe {
      paymentIntents = {
        create: vi.fn(),
        retrieve: mockPaymentIntentsRetrieve,
        cancel: vi.fn(),
      };
    },
  };
});

vi.mock('../../src/services/RevenueService.js', () => ({
  RevenueService: { logEvent: vi.fn().mockResolvedValue({ success: true, data: { id: 'rev_mock_id' } }) },
}));

vi.mock('../../src/services/StripeService.js', () => ({
  StripeService: {
    createTransfer: vi.fn(),
    createRefund: vi.fn(),
    readTransferWitness: vi.fn(),
  },
}));

vi.mock('../../src/services/SelfInsurancePoolService.js', () => ({
  SelfInsurancePoolService: {
    recordContribution: vi.fn().mockResolvedValue({ success: true }),
    fileClaim: vi.fn(),
    getPoolStatus: vi.fn(),
  },
}));

vi.mock('../../src/services/AdminNotificationHelper.js', () => ({
  notifyAdmins: vi.fn(),
}));

vi.mock('../../src/services/TaskService.js', () => ({
  TaskService: {
    updateStatus: vi.fn(),
    advanceProgress: vi.fn().mockResolvedValue({ success: true, data: {} }),
  },
}));

vi.mock('../../src/services/TaskPayoutDestinationService.js', () => ({
  loadCurrentTaskPayoutDestination: payoutDestination,
}));

vi.mock('../../src/services/EscrowPartialRefundReconciliationService.js', () => ({
  reconcilePartialRefundPostTerminal: reconcilePartialRefund,
}));

vi.mock('../../src/jobs/outbox-worker.js', () => ({
  markOutboxEventProcessed: markPartialOutboxProcessed,
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { TippingService } from '../../src/services/TippingService';
import { RevenueService } from '../../src/services/RevenueService.js';
import { SelfInsurancePoolService } from '../../src/services/SelfInsurancePoolService.js';
import { StripeService } from '../../src/services/StripeService.js';
import { processEscrowActionJob } from '../../src/jobs/escrow-action-worker.js';
import { handlePartialRefundRequest } from '../../src/jobs/EscrowActionPartialRefund.js';
import { outboxTransportJobId } from '../../src/jobs/OutboxIdentity.js';
import { signJobPayload } from '../../src/jobs/queues.js';
import { TaskService } from '../../src/services/TaskService.js';
import {
  partialRefundCheckpointIdempotencyKey,
  partialRefundClaimIdempotencyKey,
  partialRefundTerminalTransitionIdempotencyKey,
  partialRefundTransferCheckpointIdempotencyKey,
  partialRefundTransferClaimIdempotencyKey,
} from '../../src/services/EscrowPartialRefundEvidence.js';
import type { Job } from 'bullmq';

const mockDb = vi.mocked(db);
const mockRevenueService = vi.mocked(RevenueService);
const mockSelfInsurancePool = vi.mocked(SelfInsurancePoolService);
const mockStripeService = vi.mocked(StripeService);
const mockTaskService = vi.mocked(TaskService);

beforeEach(() => {
  vi.resetAllMocks();
  enableControlledStripePaymentTestCohortV7();
  // Re-bind default implementations after resetAllMocks
  mockDb.transaction.mockImplementation(async (fn: (q: typeof mockDb.query) => Promise<unknown>) => fn(mockDb.query));
  mockRevenueService.logEvent.mockResolvedValue({ success: true, data: { id: 'rev_mock_id' } } as any);
  mockSelfInsurancePool.recordContribution.mockResolvedValue({ success: true } as any);
  mockTaskService.advanceProgress.mockResolvedValue({ success: true, data: {} } as any);
  payoutDestination.mockImplementation(async (query,binding) => {
    const result=await query('SELECT stripe_connect_id FROM users WHERE id=$1',[binding.payoutRecipientUserId]);
    const stripeConnectId=result.rows[0]?.stripe_connect_id ?? null;
    return stripeConnectId
      ? { ready:true,stripeConnectId,reason:'READY' }
      : { ready:false,stripeConnectId:null,reason:'PAYOUT_ACCOUNT_NOT_READY' };
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// F53-6: Tip platform cut must be 0%
// ---------------------------------------------------------------------------

describe('F53-6: TippingService.confirmTip — platform cut must be 0%', () => {
  it('logs tip_received with platformFeeCents=0 (platform takes no cut on tips)', async () => {
    // confirmTip path:
    // 1. stripe.paymentIntents.retrieve → succeeded
    // 2. db.query: SELECT amount_cents, task_id FROM tips
    // 3. db.query: UPDATE tips SET status='completed'
    // 4. RevenueService.logEvent (mocked — no db.query)
    // 5. db.query: INSERT notification

    mockPaymentIntentsRetrieve.mockResolvedValueOnce({
      status: 'succeeded',
      amount: 500,
      metadata: { type: 'tip', task_id: 'task-tip-1', worker_id: 'worker-1', poster_id: 'poster-1' },
    });

    const tipRow = {
      id: 'tip-1',
      task_id: 'task-tip-1',
      poster_id: 'poster-1',
      worker_id: 'worker-1',
      amount_cents: 500,
      stripe_payment_intent_id: 'pi_tip_123',
      status: 'completed',
      completed_at: new Date(),
      created_at: new Date(),
    };

    mockDb.query
      // SELECT amount_cents, task_id (TT-02 + Fix 4 cross-check)
      .mockResolvedValueOnce({ rows: [{ amount_cents: 500, task_id: 'task-tip-1' }], rowCount: 1 } as never)
      // UPDATE tips
      .mockResolvedValueOnce({ rows: [tipRow], rowCount: 1 } as never)
      // INSERT notification (best-effort, may or may not run)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const result = await TippingService.confirmTip('tip-1', 'pi_tip_123');

    expect(result.success).toBe(true);

    // Verify RevenueService.logEvent was called with platformFeeCents=0
    expect(mockRevenueService.logEvent).toHaveBeenCalledOnce();
    const logEventCall = mockRevenueService.logEvent.mock.calls[0][0];
    expect(logEventCall.eventType).toBe('tip_received');
    expect(logEventCall.platformFeeCents).toBe(0);
    expect(logEventCall.amountCents).toBe(0); // No platform revenue — 100% to worker
    expect(logEventCall.grossAmountCents).toBe(500);
    expect(logEventCall.netAmountCents).toBe(500);
  });

  it('platform cut percentage is 0% — grossAmountCents equals netAmountCents for tips (F53-6)', async () => {
    const tipAmountCents = 1500; // $15 tip

    mockPaymentIntentsRetrieve.mockResolvedValueOnce({
      status: 'succeeded',
      amount: tipAmountCents,
      metadata: { type: 'tip', task_id: 'task-2', worker_id: 'worker-2', poster_id: 'poster-2' },
    });

    const tipRow = {
      id: 'tip-2',
      task_id: 'task-2',
      poster_id: 'poster-2',
      worker_id: 'worker-2',
      amount_cents: tipAmountCents,
      stripe_payment_intent_id: 'pi_tip_456',
      status: 'completed',
      completed_at: new Date(),
      created_at: new Date(),
    };

    mockDb.query
      .mockResolvedValueOnce({ rows: [{ amount_cents: tipAmountCents, task_id: 'task-2' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [tipRow], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    await TippingService.confirmTip('tip-2', 'pi_tip_456');

    const logEventCall = mockRevenueService.logEvent.mock.calls[0][0];
    // Platform cut = 0%: gross === net, platform fee = 0
    expect(logEventCall.grossAmountCents).toBe(tipAmountCents);
    expect(logEventCall.netAmountCents).toBe(tipAmountCents);
    expect(logEventCall.platformFeeCents).toBe(0);
    // Platform revenue from tips = 0 (not a revenue source for the platform)
    expect(logEventCall.amountCents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F53-7: Self-insurance pool funding path in handlePartialRefundRequest
// ---------------------------------------------------------------------------

function makeJob(name: string, payload: object): Job<{ payload: object }> {
  const escrowId = (payload as { escrow_id?: unknown }).escrow_id;
  const outboxKey = typeof escrowId === 'string'
    ? `${name}:${escrowId}:1`
    : `${name}:invalid:1`;
  const { _sig: _priorSignature, ...unsigned } = payload as Record<string, unknown>;
  const bound = { ...unsigned, _outbox_key: outboxKey };
  return {
    name,
    id: outboxTransportJobId(outboxKey),
    data: { payload: { ...bound, _sig: signJobPayload(bound) } },
  } as unknown as Job<{ payload: object }>;
}

function makeSignedPayload(fields: Record<string, unknown>): Record<string, unknown> {
  const sig = signJobPayload(fields);
  return { ...fields, _sig: sig };
}

const ESCROW_ID = '00000000-0000-0000-0000-000000000099';
const TASK_ID = '10000000-0000-0000-0000-000000000099';
const WORKER_ID = 'worker-f53-7';
const STRIPE_CONNECT_ID = 'acct_f53_7';
const ESCROW_VERSION = 1;

function makeEscrowRow(overrides: Partial<{
  stripe_transfer_id: string | null;
  stripe_refund_id: string | null;
  amount: number;
  state: string;
  platform_fee_cents: number | null;
}> = {}) {
  return {
    id: ESCROW_ID,
    task_id: TASK_ID,
    state: overrides.state ?? 'LOCKED_DISPUTE',
    version: ESCROW_VERSION,
    amount: overrides.amount ?? 10_000,
    platform_fee_cents: overrides.platform_fee_cents ?? null,
    stripe_payment_intent_id: 'pi_test',
    stripe_transfer_id: overrides.stripe_transfer_id ?? null,
    stripe_refund_id: overrides.stripe_refund_id ?? null,
    refund_amount: null,
    release_amount: null,
  };
}

const DISPUTE_ID = '20000000-0000-0000-0000-000000000099';
const POSTER_ID = 'poster-f53';
const REFUND_ID = 're_f53_7';
const TRANSFER_ID = 'tr_f53_7';
const NET_RELEASE_CENTS = 4_980;

const partialTaskRow = {
  worker_id: WORKER_ID,
  payout_recipient_user_id: WORKER_ID,
  provider_organization_id: null,
  provider_assignment_id: null,
  poster_id: POSTER_ID,
};

let canonicalPartialEscrow = makeEscrowRow();
let storedPartialClaim: Record<string, unknown> | null = null;
let storedPartialCheckpoint: Record<string, unknown> | null = null;
let storedPartialTransferClaim: Record<string, unknown> | null = null;
let storedPartialTransferCheckpoint: Record<string, unknown> | null = null;
let storedPartialRecoveries: Array<Record<string, unknown>> = [];
let storedPartialProviderExceptions: Array<Record<string, unknown>> = [];
let storedPartialTerminalTransition: Record<string, unknown> | null = null;
let exactPartialLockReads = 0;
let mutatePartialBeforeT2 = false;
let partialTerminalUpdates = 0;
let failPartialRefundCheckpointWriteOnce = false;
let partialRefundClaimCreatedAt = new Date();
let partialTransferClaimCreatedAt = new Date();
let tamperPartialT2RefundId: string | null = null;

function partialAction(overrides: {
  escrow?: ReturnType<typeof makeEscrowRow>;
  refundAmount?: number;
  releaseAmount?: number;
} = {}) {
  return {
    escrow: overrides.escrow ?? makeEscrowRow(),
    taskId: TASK_ID,
    disputeId: DISPUTE_ID,
    reason: 'authorized exact split',
    refundAmount: overrides.refundAmount ?? 4_000,
    releaseAmount: overrides.releaseAmount ?? 6_000,
  };
}

function installExactPartialWorkerModel(): void {
  mockDb.transaction.mockImplementation(async (fn: any) => fn(mockDb.query));
  payoutDestination.mockResolvedValue({
    ready: true,
    stripeConnectId: STRIPE_CONNECT_ID,
    reason: 'READY',
  });
  mockDb.query.mockImplementation(async (statement: any, params: any[] = []) => {
    const sql = String(statement);
    if (sql.includes('SELECT id, task_id, state, version')) {
      return { rows: [canonicalPartialEscrow], rowCount: 1 } as never;
    }
    if (sql.includes('SELECT worker_id,payout_recipient_user_id')) {
      return { rows: [partialTaskRow], rowCount: 1 } as never;
    }
    if (sql.includes('SELECT version,state,task_id')) {
      exactPartialLockReads += 1;
      const escrow = mutatePartialBeforeT2 && exactPartialLockReads > 2
        ? { ...canonicalPartialEscrow, version: canonicalPartialEscrow.version + 1 }
        : canonicalPartialEscrow;
      return { rows: [escrow], rowCount: 1 } as never;
    }
    if (sql.includes('SELECT id,version,state,task_id')) {
      return {
        rows: [{ id: ESCROW_ID, ...canonicalPartialEscrow }],
        rowCount: 1,
      } as never;
    }
    if (sql.includes('FROM disputes WHERE id=$1 FOR SHARE')) {
      return {
        rows: [{
          state: 'RESOLVED',
          escrow_id: ESCROW_ID,
          task_id: TASK_ID,
          outcome_escrow_action: 'SPLIT',
          outcome_refund_amount: 4_000,
          outcome_release_amount: 6_000,
        }],
        rowCount: 1,
      } as never;
    }
    if (sql.includes('SELECT idempotency_key,metadata')) {
      const t2RefundCheckpoint = storedPartialCheckpoint && tamperPartialT2RefundId
        ? { ...storedPartialCheckpoint, stripe_refund_id: tamperPartialT2RefundId }
        : storedPartialCheckpoint;
      const rows = [
        [partialRefundClaimIdempotencyKey(ESCROW_ID), storedPartialClaim],
        [partialRefundCheckpointIdempotencyKey(ESCROW_ID), t2RefundCheckpoint],
        [partialRefundTransferClaimIdempotencyKey(ESCROW_ID), storedPartialTransferClaim],
        [partialRefundTransferCheckpointIdempotencyKey(ESCROW_ID), storedPartialTransferCheckpoint],
      ].filter((entry) => entry[1] !== null).map(([idempotency_key, metadata]) => ({
        idempotency_key,
        metadata,
      }));
      return { rows, rowCount: rows.length } as never;
    }
    if (sql.includes('INSERT INTO escrow_events')) {
      const metadata = JSON.parse(String(params[1])) as Record<string, unknown>;
      if (metadata.event_type === 'partial_refund_provider_claim_v2') {
        if (storedPartialClaim) return { rows: [], rowCount: 0 } as never;
        storedPartialClaim = metadata;
        return { rows: [{ metadata, created_at: partialRefundClaimCreatedAt }], rowCount: 1 } as never;
      }
      if (metadata.event_type === 'partial_refund_transfer_claim_v1') {
        if (storedPartialTransferClaim) return { rows: [], rowCount: 0 } as never;
        storedPartialTransferClaim = metadata;
        return { rows: [{ metadata, created_at: partialTransferClaimCreatedAt }], rowCount: 1 } as never;
      }
      if (metadata.event_type === 'partial_refund_provider_checkpoint_v3') {
        if (failPartialRefundCheckpointWriteOnce) {
          failPartialRefundCheckpointWriteOnce = false;
          throw new Error('simulated worker crash before refund checkpoint commit');
        }
        if (storedPartialCheckpoint) return { rows: [], rowCount: 0 } as never;
        storedPartialCheckpoint = metadata;
        return { rows: [{ metadata }], rowCount: 1 } as never;
      }
      if (metadata.event_type === 'partial_refund_transfer_checkpoint_v1') {
        if (storedPartialTransferCheckpoint) return { rows: [], rowCount: 0 } as never;
        storedPartialTransferCheckpoint = metadata;
        return { rows: [{ metadata }], rowCount: 1 } as never;
      }
      if (metadata.event_type === 'partial_refund_transfer_recovery_v1') {
        storedPartialRecoveries.push(metadata);
        return { rows: [{ metadata }], rowCount: 1 } as never;
      }
      if (metadata.event_type === 'partial_refund_provider_exception_v1') {
        storedPartialProviderExceptions.push(metadata);
        return { rows: [{ metadata }], rowCount: 1 } as never;
      }
      if (metadata.event_type === 'partial_refund_terminal_transition_v1') {
        if (storedPartialTerminalTransition) return { rows: [], rowCount: 0 } as never;
        storedPartialTerminalTransition = metadata;
        return { rows: [{ metadata }], rowCount: 1 } as never;
      }
    }
    if (sql.includes('WITH pre AS (SELECT state FROM escrows')) {
      canonicalPartialEscrow = {
        ...canonicalPartialEscrow,
        version: canonicalPartialEscrow.version + 1,
      };
      return { rows: [], rowCount: 1 } as never;
    }
    if (sql.includes('SELECT metadata,created_at FROM escrow_events')) {
      const key = String(params[1]);
      if (key.includes('provider-claim')) {
        return storedPartialClaim
          ? { rows: [{ metadata: storedPartialClaim, created_at: partialRefundClaimCreatedAt }], rowCount: 1 } as never
          : { rows: [], rowCount: 0 } as never;
      }
      if (key.includes('transfer-claim')) {
        return storedPartialTransferClaim
          ? { rows: [{ metadata: storedPartialTransferClaim, created_at: partialTransferClaimCreatedAt }], rowCount: 1 } as never
          : { rows: [], rowCount: 0 } as never;
      }
    }
    if (sql.includes('SELECT metadata FROM escrow_events')) {
      const key = String(params[1]);
      if (key.includes('provider-claim')) {
        return storedPartialClaim
          ? { rows: [{ metadata: storedPartialClaim }], rowCount: 1 } as never
          : { rows: [], rowCount: 0 } as never;
      }
      if (key.includes('transfer-checkpoint')) {
        return storedPartialTransferCheckpoint
          ? { rows: [{ metadata: storedPartialTransferCheckpoint }], rowCount: 1 } as never
          : { rows: [], rowCount: 0 } as never;
      }
      if (key.includes('transfer-recovery')) {
        const metadata = storedPartialRecoveries.at(-1);
        return metadata
          ? { rows: [{ metadata }], rowCount: 1 } as never
          : { rows: [], rowCount: 0 } as never;
      }
      if (
        key === partialRefundTerminalTransitionIdempotencyKey(
          ESCROW_ID,
          ESCROW_VERSION + 1,
        )
      ) {
        return storedPartialTerminalTransition
          ? { rows: [{ metadata: storedPartialTerminalTransition }], rowCount: 1 } as never
          : { rows: [], rowCount: 0 } as never;
      }
      return storedPartialCheckpoint
        ? { rows: [{ metadata: storedPartialCheckpoint }], rowCount: 1 } as never
        : { rows: [], rowCount: 0 } as never;
    }
    if (sql.includes("SET state='REFUND_PARTIAL'")) {
      partialTerminalUpdates += 1;
      canonicalPartialEscrow = {
        ...canonicalPartialEscrow,
        state: 'REFUND_PARTIAL',
        version: canonicalPartialEscrow.version + 1,
        stripe_refund_id: REFUND_ID,
        stripe_transfer_id: TRANSFER_ID,
        refund_amount: 4_000,
        release_amount: 6_000,
      };
      return {
        rows: [{ id: ESCROW_ID, state: 'REFUND_PARTIAL' }],
        rowCount: 1,
      } as never;
    }
    throw new Error(`Unexpected exact partial-refund query: ${sql}`);
  });
}

describe('F53-7: exact partial-refund worker settlement and side-effect acknowledgement', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    canonicalPartialEscrow = makeEscrowRow();
    storedPartialClaim = null;
    storedPartialCheckpoint = null;
    storedPartialTransferClaim = null;
    storedPartialTransferCheckpoint = null;
    storedPartialRecoveries = [];
    storedPartialProviderExceptions = [];
    storedPartialTerminalTransition = null;
    exactPartialLockReads = 0;
    mutatePartialBeforeT2 = false;
    partialTerminalUpdates = 0;
    failPartialRefundCheckpointWriteOnce = false;
    partialRefundClaimCreatedAt = new Date();
    partialTransferClaimCreatedAt = new Date();
    tamperPartialT2RefundId = null;
    markPartialOutboxProcessed.mockResolvedValue(undefined);
    installExactPartialWorkerModel();
    mockStripeService.createRefund.mockResolvedValue({
      success: true,
      data: {
        refundId: REFUND_ID,
        amount: 4_000,
        status: 'succeeded',
        currency: 'usd',
        paymentIntentId: 'pi_test',
        chargeId: 'ch_f53_7',
      },
    } as any);
    mockStripeService.createTransfer.mockResolvedValue({
      success: true,
      data: { transferId: TRANSFER_ID },
    } as any);
    mockStripeService.readTransferWitness.mockResolvedValue({
      success: true,
      data: {
        provider: 'STRIPE',
        transferId: TRANSFER_ID,
        amountCents: NET_RELEASE_CENTS,
        currency: 'usd',
        destinationAccountId: STRIPE_CONNECT_ID,
        reversed: false,
        amountReversedCents: 0,
        escrowId: ESCROW_ID,
        taskId: TASK_ID,
        payoutRecipientUserId: WORKER_ID,
      },
    } as any);
    mockSelfInsurancePool.recordContribution.mockResolvedValue({
      success: true,
      data: undefined,
    } as any);
    mockTaskService.advanceProgress.mockResolvedValue({ success: true, data: {} } as any);
    mockRevenueService.logEvent.mockResolvedValue({
      success: true,
      data: { id: 'rev_mock_id' },
    } as any);
    reconcilePartialRefund.mockImplementation(async () => {
      const fail = async (message: string) => {
        storedPartialRecoveries.push({
          event_type: 'partial_refund_transfer_recovery_v1',
          failure_stage: 'POST_TERMINAL_EFFECT_FAILED',
          reconciliation_required: true,
        });
        throw Object.assign(new Error(message), {
          code: 'PARTIAL_REFUND_RECONCILIATION_REQUIRED',
        });
      };
      const insurance = await mockSelfInsurancePool.recordContribution(
        TASK_ID,
        WORKER_ID,
        120,
      );
      if (!insurance.success) return fail(insurance.error.message);
      const progress = await mockTaskService.advanceProgress({
        taskId: TASK_ID,
        to: 'CLOSED',
        actor: { type: 'system' },
      });
      if (!progress.success) return fail(progress.error.message);
      const revenue = await mockRevenueService.logEvent({
        eventType: 'platform_fee',
        userId: POSTER_ID,
        taskId: TASK_ID,
        amountCents: 900,
      } as any);
      if (!revenue.success) return fail(revenue.error.message);
      return { binding: {}, provider: {} };
    });
  });

  it('fails closed before Stripe for a canonical quote split', async () => {
    vi.mocked(db.transaction).mockImplementationOnce(async (fn: any) => {
      const trxQuery = vi.fn().mockResolvedValueOnce({
        rows: [makeEscrowRow({ platform_fee_cents: 2_500 })],
        rowCount: 1,
      });
      return fn(trxQuery);
    });

    const payload = makeSignedPayload({
      escrow_id: ESCROW_ID,
      task_id: TASK_ID,
      dispute_id: DISPUTE_ID,
      reason: 'controlled canonical split dispute',
      refund_amount: 4_000,
      release_amount: 6_000,
    });

    await expect(processEscrowActionJob(makeJob('escrow.partial_refund_requested', payload)))
      .rejects.toThrow('CANONICAL_QUOTE_SPLIT_REQUIRES_RECONCILIATION');
    expect(mockStripeService.createRefund).not.toHaveBeenCalled();
    expect(mockStripeService.createTransfer).not.toHaveBeenCalled();
  });

  it('binds exact processor witnesses, terminalizes once, and records every side effect', async () => {
    await handlePartialRefundRequest(partialAction());

    expect(partialTerminalUpdates).toBe(1);
    expect(mockSelfInsurancePool.recordContribution).toHaveBeenCalledWith(
      TASK_ID,
      WORKER_ID,
      120,
    );
    expect(mockTaskService.advanceProgress).toHaveBeenCalledWith({
      taskId: TASK_ID,
      to: 'CLOSED',
      actor: { type: 'system' },
    });
    expect(mockRevenueService.logEvent).toHaveBeenCalledOnce();
    expect(storedPartialTransferCheckpoint).toMatchObject({
      event_type: 'partial_refund_transfer_checkpoint_v1',
      stripe_transfer_id: TRANSFER_ID,
      transfer_created_in_attempt: true,
    });
  });

  it('rejects a divergent concurrent split before a second Stripe refund', async () => {
    let announceRefundStarted!: () => void;
    const refundStarted = new Promise<void>((resolve) => { announceRefundStarted = resolve; });
    let releaseRefund!: () => void;
    const refundBarrier = new Promise<void>((resolve) => { releaseRefund = resolve; });
    mockStripeService.createRefund.mockImplementationOnce(async () => {
      announceRefundStarted();
      await refundBarrier;
      return {
        success: true,
        data: {
          refundId: REFUND_ID,
          amount: 4_000,
          status: 'succeeded',
          currency: 'usd',
          paymentIntentId: 'pi_test',
          chargeId: 'ch_f53_7',
        },
      } as any;
    });

    const winner = handlePartialRefundRequest(partialAction());
    await refundStarted;
    await expect(handlePartialRefundRequest(partialAction({
      refundAmount: 3_000,
      releaseAmount: 7_000,
    }))).rejects.toMatchObject({
      code: 'PARTIAL_REFUND_RECONCILIATION_REQUIRED',
    });
    expect(mockStripeService.createRefund).toHaveBeenCalledOnce();
    releaseRefund();
    await expect(winner).resolves.toBeUndefined();
  });

  it('replays the exact worker refund request after a crash before its checkpoint', async () => {
    failPartialRefundCheckpointWriteOnce = true;

    await expect(handlePartialRefundRequest(partialAction()))
      .rejects.toMatchObject({ code: 'PARTIAL_REFUND_RECONCILIATION_REQUIRED' });
    expect(storedPartialClaim).toMatchObject({
      event_type: 'partial_refund_provider_claim_v2',
      escrow_id: ESCROW_ID,
    });
    expect(storedPartialCheckpoint).toBeNull();
    expect(mockStripeService.createTransfer).not.toHaveBeenCalled();

    await expect(handlePartialRefundRequest(partialAction())).resolves.toBeUndefined();

    expect(mockStripeService.createRefund).toHaveBeenCalledTimes(2);
    expect(mockStripeService.createRefund.mock.calls[0][0]).toMatchObject({
      paymentIntentId: 'pi_test',
      escrowId: ESCROW_ID,
      amount: 4_000,
      idempotencyKeySuffix: 'partial_refund',
    });
    expect(mockStripeService.createRefund.mock.calls[1][0])
      .toEqual(mockStripeService.createRefund.mock.calls[0][0]);
    expect(storedPartialCheckpoint).toMatchObject({
      stripe_refund_id: REFUND_ID,
      stripe_refund_status: 'succeeded',
    });
    expect(mockStripeService.createTransfer).toHaveBeenCalledOnce();
    expect(partialTerminalUpdates).toBe(1);
  });

  it('records and leaves unacknowledged a transfer restriction after the refund commits', async () => {
    mockStripeService.createTransfer.mockResolvedValueOnce({
      success: false,
      error: { code: 'account_closed', message: 'connected account closed' },
    } as any);
    const payload = makeSignedPayload({
      escrow_id: ESCROW_ID,
      task_id: TASK_ID,
      dispute_id: DISPUTE_ID,
      reason: 'authorized exact split',
      refund_amount: 4_000,
      release_amount: 6_000,
    });
    const job = makeJob('escrow.partial_refund_requested', payload);

    await expect(processEscrowActionJob(job))
      .rejects.toMatchObject({ code: 'PARTIAL_REFUND_RECONCILIATION_REQUIRED' });

    expect(mockStripeService.createRefund).toHaveBeenCalledOnce();
    expect(mockStripeService.createTransfer).toHaveBeenCalledOnce();
    expect(partialTerminalUpdates).toBe(0);
    expect(storedPartialProviderExceptions).toContainEqual(expect.objectContaining({
      event_type: 'partial_refund_provider_exception_v1',
      failure_stage: 'TRANSFER_RESTRICTED_AFTER_REFUND',
      reason_code: 'account_closed',
      stripe_refund_id: REFUND_ID,
      reconciliation_required: true,
    }));
    expect(markPartialOutboxProcessed).not.toHaveBeenCalled();
  });

  it('rejects a tampered refund checkpoint at the action T2 boundary', async () => {
    tamperPartialT2RefundId = 're_attacker_t2';

    await expect(handlePartialRefundRequest(partialAction()))
      .rejects.toMatchObject({ code: 'PARTIAL_REFUND_RECONCILIATION_REQUIRED' });

    expect(mockStripeService.createRefund).toHaveBeenCalledOnce();
    expect(mockStripeService.createTransfer).toHaveBeenCalledOnce();
    expect(partialTerminalUpdates).toBe(0);
    expect(storedPartialTerminalTransition).toBeNull();
    expect(mockSelfInsurancePool.recordContribution).not.toHaveBeenCalled();
  });

  it('rejects a stale current transfer witness without terminalizing or acknowledging effects', async () => {
    const staleEscrow = makeEscrowRow({ stripe_transfer_id: 'tr_stale_f53' });
    canonicalPartialEscrow = staleEscrow;
    mockStripeService.readTransferWitness.mockResolvedValueOnce({
      success: true,
      data: {
        provider: 'STRIPE',
        transferId: 'tr_stale_f53',
        amountCents: NET_RELEASE_CENTS,
        currency: 'usd',
        destinationAccountId: 'acct_rotated',
        reversed: false,
        amountReversedCents: 0,
        escrowId: ESCROW_ID,
        taskId: TASK_ID,
        payoutRecipientUserId: WORKER_ID,
      },
    } as any);

    await expect(handlePartialRefundRequest(partialAction({ escrow: staleEscrow })))
      .rejects.toMatchObject({ code: 'PARTIAL_REFUND_RECONCILIATION_REQUIRED' });
    expect(mockStripeService.createTransfer).not.toHaveBeenCalled();
    expect(partialTerminalUpdates).toBe(0);
    expect(mockSelfInsurancePool.recordContribution).not.toHaveBeenCalled();
    expect(mockTaskService.advanceProgress).not.toHaveBeenCalled();
  });

  it('rejects a Phase-2 version mutation instead of reporting ordinary success', async () => {
    mutatePartialBeforeT2 = true;

    await expect(handlePartialRefundRequest(partialAction()))
      .rejects.toMatchObject({ code: 'PARTIAL_REFUND_RECONCILIATION_REQUIRED' });
    expect(partialTerminalUpdates).toBe(0);
    expect(mockSelfInsurancePool.recordContribution).not.toHaveBeenCalled();
    expect(mockTaskService.advanceProgress).not.toHaveBeenCalled();
    expect(mockRevenueService.logEvent).not.toHaveBeenCalled();
    expect(storedPartialRecoveries).toContainEqual(expect.objectContaining({
      event_type: 'partial_refund_transfer_recovery_v1',
      failure_stage: 'CANONICAL_T2_FAILED',
      reconciliation_required: true,
    }));
  });

  it('does not acknowledge when insurance contribution returns a failure', async () => {
    mockSelfInsurancePool.recordContribution.mockResolvedValueOnce({
      success: false,
      error: { code: 'POOL_FAILED', message: 'pool DB unavailable' },
    } as any);

    await expect(handlePartialRefundRequest(partialAction()))
      .rejects.toMatchObject({ code: 'PARTIAL_REFUND_RECONCILIATION_REQUIRED' });
    expect(partialTerminalUpdates).toBe(1);
    expect(mockTaskService.advanceProgress).not.toHaveBeenCalled();
    expect(mockRevenueService.logEvent).not.toHaveBeenCalled();
    expect(storedPartialRecoveries).toContainEqual(expect.objectContaining({
      failure_stage: 'POST_TERMINAL_EFFECT_FAILED',
    }));
  });

  it('does not acknowledge when canonical task closure fails', async () => {
    mockTaskService.advanceProgress.mockResolvedValueOnce({
      success: false,
      error: { code: 'TASK_CLOSE_FAILED', message: 'task version changed' },
    } as any);

    await expect(handlePartialRefundRequest(partialAction()))
      .rejects.toMatchObject({ code: 'PARTIAL_REFUND_RECONCILIATION_REQUIRED' });
    expect(mockSelfInsurancePool.recordContribution).toHaveBeenCalledOnce();
    expect(mockRevenueService.logEvent).not.toHaveBeenCalled();
    expect(storedPartialRecoveries).toContainEqual(expect.objectContaining({
      failure_stage: 'POST_TERMINAL_EFFECT_FAILED',
    }));
  });

  it('does not acknowledge when the revenue ledger rejects the split', async () => {
    mockRevenueService.logEvent.mockResolvedValueOnce({
      success: false,
      error: { code: 'REVENUE_LOG_FAILED', message: 'ledger unavailable' },
    } as any);

    await expect(handlePartialRefundRequest(partialAction()))
      .rejects.toMatchObject({ code: 'PARTIAL_REFUND_RECONCILIATION_REQUIRED' });
    expect(mockTaskService.advanceProgress).toHaveBeenCalledOnce();
    expect(mockRevenueService.logEvent).toHaveBeenCalledOnce();
    expect(storedPartialRecoveries).toContainEqual(expect.objectContaining({
      failure_stage: 'POST_TERMINAL_EFFECT_FAILED',
    }));
  });

  it('rejects a refund-only payload because SPLIT requires two positive exact legs', async () => {
    await expect(handlePartialRefundRequest(partialAction({
      refundAmount: 10_000,
      releaseAmount: 0,
    }))).rejects.toMatchObject({
      code: 'PARTIAL_REFUND_RECONCILIATION_REQUIRED',
    });
    expect(mockStripeService.createRefund).not.toHaveBeenCalled();
    expect(mockStripeService.createTransfer).not.toHaveBeenCalled();
    expect(mockSelfInsurancePool.recordContribution).not.toHaveBeenCalled();
  });

  it('rejects replay after terminal CAS without repeating provider or economic effects', async () => {
    const action = partialAction();
    await handlePartialRefundRequest(action);

    await expect(handlePartialRefundRequest(action)).rejects.toMatchObject({
      code: 'PARTIAL_REFUND_RECONCILIATION_REQUIRED',
    });
    expect(mockStripeService.createRefund).toHaveBeenCalledOnce();
    expect(mockStripeService.createTransfer).toHaveBeenCalledOnce();
    expect(mockSelfInsurancePool.recordContribution).toHaveBeenCalledOnce();
    expect(mockTaskService.advanceProgress).toHaveBeenCalledOnce();
    expect(mockRevenueService.logEvent).toHaveBeenCalledOnce();
  });
});
