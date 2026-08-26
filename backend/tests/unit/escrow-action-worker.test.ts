/**
 * escrow-action-worker.test.ts
 *
 * Unit tests for processEscrowActionJob.
 *
 * Key invariants verified:
 *  1. Platform fee is deducted before transferring to worker (P0 revenue bug fix).
 *  2. The FOR UPDATE SELECT runs inside db.transaction() (critical-section lock fix).
 *  3. Stripe calls happen OUTSIDE the transaction (cannot be rolled back).
 *  4. The version-checked UPDATE runs inside a second db.transaction() call.
 *  5. Idempotency paths (stripe_transfer_id / stripe_refund_id already set) skip Stripe.
 *  6. Invalid state (not LOCKED_DISPUTE) is rejected inside the transaction.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  enableControlledStripePaymentTestCohortV7,
  HOSTILE_PAYMENT_CREATION_ENVIRONMENTS_V7,
  stubPaymentCreationEnvironmentV7,
} from '../helpers/payment-underwriting-v7';

const {
  payoutDestination,
  persistRefundWitness,
  reconcilePartialRefund,
  releaseReconcile,
  markOutboxProcessed,
} = vi.hoisted(() => ({
  payoutDestination:vi.fn(),
  persistRefundWitness:vi.fn(),
  reconcilePartialRefund:vi.fn(),
  releaseReconcile:vi.fn(),
  markOutboxProcessed:vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports that trigger the module
// ---------------------------------------------------------------------------

// db mock: expose both `query` and `transaction` so we can assert on both.
// transaction() default impl just calls the callback with db.query, letting
// individual tests override it to simulate the real two-connection behaviour.
vi.mock('../../src/db', () => {
  const queryFn = vi.fn();
  const transactionFn = vi.fn(async (fn: (q: typeof queryFn) => Promise<unknown>) => fn(queryFn));
  return {
    db: {
      query: queryFn,
      transaction: transactionFn,
    },
  };
});

vi.mock('../../src/services/StripeService.js', () => ({
  StripeService: {
    createTransfer: vi.fn(),
    createRefund: vi.fn(),
    readRefundWitness: vi.fn(),
    readTransferWitness: vi.fn(),
  },
}));

vi.mock('../../src/services/TaskPayoutDestinationService.js', () => ({
  loadCurrentTaskPayoutDestination: payoutDestination,
}));

vi.mock('../../src/services/EscrowPartialRefundReconciliationService.js', () => ({
  reconcilePartialRefundPostTerminal: reconcilePartialRefund,
}));

vi.mock('../../src/services/EscrowReleaseReconciliationService.js', () => ({
  EscrowReleaseReconciliationService: { reconcile: releaseReconcile },
}));

vi.mock('../../src/jobs/outbox-worker.js', () => ({
  markOutboxEventProcessed: markOutboxProcessed,
}));

vi.mock('../../src/services/EscrowRefundProviderWitness.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/EscrowRefundProviderWitness.js')>();
  return { ...actual, persistExactSucceededRefundWitness:persistRefundWitness };
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

vi.mock('../../src/services/TaskService.js', () => ({
  TaskService: {
    updateStatus: vi.fn(),
    advanceProgress: vi.fn().mockResolvedValue({ success: true, data: {} }),
  },
}));

vi.mock('../../src/config.js', () => ({
  config: {
    stripe: { platformFeePercent: 15 },
    queue: { hmacSecret: 'test-hmac-secret-for-unit-tests' },
  },
}));

vi.mock('../../src/services/AdminNotificationHelper.js', () => ({
  notifyAdmins: vi.fn(),
}));

// RevenueService is mocked so logEvent never issues a real db.query call.
// This prevents mockResolvedValueOnce queue leakage between tests (vi.clearAllMocks
// clears call counts but NOT queued once-values — mocking the module entirely
// isolates db.query from revenue ledger writes).
vi.mock('../../src/services/RevenueService.js', () => ({
  RevenueService: { logEvent: vi.fn().mockResolvedValue({ success: true, data: { id: 'rev_mock_id' } }) },
}));

// F-12 FIX: handleReleaseRequest now calls SelfInsurancePoolService.recordContribution.
// Mock it to prevent db.transaction from being called a 3rd time (which would overwrite
// the T2 updateSql capture in transaction-structure tests).
vi.mock('../../src/services/SelfInsurancePoolService.js', () => ({
  SelfInsurancePoolService: {
    recordContribution: vi.fn().mockResolvedValue({ success: true, data: undefined }),
    fileClaim: vi.fn(),
    getPoolStatus: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after vi.mock declarations)
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { StripeService } from '../../src/services/StripeService.js';
import { processEscrowActionJob } from '../../src/jobs/escrow-action-worker.js';
import { handlePartialRefundRequest } from '../../src/jobs/EscrowActionPartialRefund.js';
import { handleRefundRequest } from '../../src/jobs/EscrowActionRefund.js';
import { handleReleaseRequest } from '../../src/jobs/EscrowActionRelease.js';
import { outboxTransportJobId } from '../../src/jobs/OutboxIdentity.js';
import { signJobPayload } from '../../src/jobs/queues.js';
import { notifyAdmins } from '../../src/services/AdminNotificationHelper.js';
import { RevenueService } from '../../src/services/RevenueService.js';
import { SelfInsurancePoolService } from '../../src/services/SelfInsurancePoolService.js';
import { EscrowReleaseReconciliationService } from '../../src/services/EscrowReleaseReconciliationService.js';
import { TaskService } from '../../src/services/TaskService.js';
import type { Job } from 'bullmq';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeJob(name: string, payload: object): Job<{ payload: object }> {
  const escrowId = (payload as { escrow_id?: unknown }).escrow_id;
  const suppliedKey = (payload as { _outbox_key?: unknown })._outbox_key;
  const outboxKey = typeof suppliedKey === 'string'
    ? suppliedKey
    : typeof escrowId === 'string'
      ? `${name}:${escrowId}:1`
      : `${name}:invalid:1`;
  const { _sig: _priorSignature, ...unsigned } = payload as Record<string, unknown>;
  const signed = { ...unsigned, _outbox_key: outboxKey };
  const priorWasValid = typeof _priorSignature === 'string'
    && _priorSignature === signJobPayload(unsigned);
  return {
    name,
    id: outboxTransportJobId(outboxKey),
    data: {
      payload: {
        ...signed,
        _sig: priorWasValid ? signJobPayload(signed) : _priorSignature,
      },
    },
  } as unknown as Job<{ payload: object }>;
}

function makeSignedPayload(fields: Record<string, unknown>): Record<string, unknown> {
  const sig = signJobPayload(fields);
  return { ...fields, _sig: sig };
}

const ESCROW_ID = '00000000-0000-0000-0000-000000000001';
const TASK_ID = '10000000-0000-0000-0000-000000000001';
const WORKER_ID = 'worker-001';
const STRIPE_CONNECT_ID = 'acct_test_123';
const ESCROW_VERSION = 1;
const DISPUTE_ID = '20000000-0000-0000-0000-000000000001';

beforeEach(() => {
  enableControlledStripePaymentTestCohortV7();
  vi.mocked(db.query).mockReset();
  persistRefundWitness.mockReset().mockResolvedValue(undefined);
  reconcilePartialRefund.mockReset().mockResolvedValue({ binding: {}, provider: {} });
  releaseReconcile.mockReset().mockResolvedValue({ success: true, data: {} });
  markOutboxProcessed.mockReset().mockResolvedValue({
    idempotency_key: `escrow.partial_refund_requested:${ESCROW_ID}:1`,
    status: 'processed',
    attempts: 1,
  });
  payoutDestination.mockImplementation(async (query, binding) => {
    const result=await query('SELECT stripe_connect_id FROM users WHERE id = $1',[binding.payoutRecipientUserId]);
    const stripeConnectId=result.rows[0]?.stripe_connect_id ?? null;
    return stripeConnectId
      ? { ready:true,stripeConnectId,reason:'READY' }
      : { ready:false,stripeConnectId:null,reason:'PAYOUT_ACCOUNT_NOT_READY' };
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Standard locked-dispute escrow row returned by the FOR UPDATE SELECT */
function makeEscrowRow(overrides: Partial<{
  stripe_transfer_id: string | null;
  stripe_refund_id: string | null;
  amount: number;
  state: string;
}> = {}) {
  return {
    id: ESCROW_ID,
    task_id: TASK_ID,
    state: overrides.state ?? 'LOCKED_DISPUTE',
    version: ESCROW_VERSION,
    amount: overrides.amount ?? 10_000,
    platform_fee_cents: null,
    stripe_payment_intent_id: 'pi_test',
    stripe_transfer_id: overrides.stripe_transfer_id ?? null,
    stripe_refund_id: overrides.stripe_refund_id ?? null,
    refund_amount: null,
    release_amount: null,
  };
}

function workerAbandonAuthorityRow() {
  return {
    actor_id: WORKER_ID,
    metadata: {
      event_type: 'worker_abandon_refund_authority_v1',
      task_id: TASK_ID,
      worker_id: WORKER_ID,
      reason: null,
      canonical_state: 'LOCKED_DISPUTE',
      canonical_version: ESCROW_VERSION,
    },
    task_state: 'CANCELLED',
    task_worker_id: null,
  };
}

function releaseAuthorityRow(amount = 10_000, overrides: Record<string, unknown> = {}) {
  return {
    id: DISPUTE_ID,
    task_id: TASK_ID,
    escrow_id: ESCROW_ID,
    state: 'RESOLVED',
    version: 2,
    initiated_by: 'poster-001',
    resolved_by: 'admin-001',
    outcome_escrow_action: 'RELEASE',
    outcome_refund_amount: 0,
    outcome_release_amount: amount,
    task_state: 'COMPLETED',
    task_version: 3,
    worker_id: WORKER_ID,
    payout_recipient_user_id: null,
    provider_organization_id: null,
    provider_assignment_id: null,
    poster_id: 'poster-001',
    price: amount,
    ...overrides,
  };
}

function signedReleasePayload(amount = 10_000, overrides: Record<string, unknown> = {}) {
  return makeSignedPayload({
    escrow_id: ESCROW_ID,
    task_id: TASK_ID,
    dispute_id: DISPUTE_ID,
    reason: 'dispute_resolution',
    refund_amount: 0,
    release_amount: amount,
    ...overrides,
  });
}

/**
 * Wire up db.transaction and db.query mocks for a release request.
 *
 * Call sequence expected by processEscrowActionJob + handleReleaseRequest:
 *   transaction #1 — critical-section lock (FOR UPDATE SELECT inside trx)
 *   query #1       — SELECT worker_id FROM tasks
 *   query #2       — SELECT stripe_connect_id FROM users
 *   [Stripe createTransfer call]
 *   transaction #2 — T2: SELECT FOR UPDATE NOWAIT (trxQuery call 1) + UPDATE (trxQuery call 2)
 *
 * Note: RevenueService.logEvent is module-mocked (vi.mock) so it does NOT
 * issue an additional db.query call — no query #3 needed here.
 */
function setupReleaseMocks(escrowAmountCents = 10_000, escrowOverrides = {}, taskOverrides = {}) {
  const dbQuery = vi.mocked(db.query);
  const dbTransaction = vi.mocked(db.transaction);
  const transactionQueries: Array<ReturnType<typeof vi.fn>> = [];

  let txCallIndex = 0;

  dbTransaction.mockImplementation(async (fn) => {
    const callIndex = txCallIndex++;
    if (callIndex === 0) {
      // First transaction: critical-section FOR UPDATE. Return the locked escrow row.
      const trxQuery = vi.fn().mockResolvedValueOnce({
        rows: [makeEscrowRow({ amount: escrowAmountCents, ...escrowOverrides })],
        rowCount: 1,
      });
      transactionQueries.push(trxQuery);
      return fn(trxQuery);
    }
    if (callIndex === 1) {
      const trxQuery = vi.fn().mockResolvedValueOnce({
        rows: [releaseAuthorityRow(escrowAmountCents, taskOverrides)], rowCount: 1,
      });
      transactionQueries.push(trxQuery);
      return fn(trxQuery);
    }
    // Third transaction (T2): full escrow/authority/destination binding then CAS.
    const trxQuery = vi.fn()
      .mockResolvedValueOnce({
        rows: [makeEscrowRow({ amount: escrowAmountCents, ...escrowOverrides })],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [releaseAuthorityRow(escrowAmountCents, taskOverrides)], rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ stripe_connect_id: STRIPE_CONNECT_ID }], rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: ESCROW_ID }] });
    transactionQueries.push(trxQuery);
    return fn(trxQuery);
  });

  dbQuery.mockResolvedValueOnce({
    rows: [{ stripe_connect_id: STRIPE_CONNECT_ID }], rowCount: 1,
  } as never);
  vi.mocked(StripeService.readTransferWitness).mockImplementation(async (transferId) => ({
    success: true,
    data: {
      provider: 'STRIPE', transferId, amountCents: escrowAmountCents
        - Math.round(escrowAmountCents * 0.15) - Math.round(escrowAmountCents * 0.02),
      currency: 'usd', destinationAccountId: STRIPE_CONNECT_ID, reversed: false,
      amountReversedCents: 0, escrowId: ESCROW_ID, taskId: TASK_ID,
      payoutRecipientUserId: (taskOverrides as { payout_recipient_user_id?: string }).payout_recipient_user_id ?? WORKER_ID,
    },
  }));
  return { transactionQueries };
}

/**
 * Wire up db.transaction and db.query mocks for a refund request.
 *
 * Call sequence:
 *   transaction #1 — critical-section lock (FOR UPDATE SELECT)
 *   transaction #2 — version-checked UPDATE escrows (store refund_id)
 */
function setupRefundMocks(
  overrides = {},
  authority: Record<string, unknown> = workerAbandonAuthorityRow(),
) {
  const dbTransaction = vi.mocked(db.transaction);
  let txCallIndex = 0;

  dbTransaction.mockImplementation(async (fn) => {
    const callIndex = txCallIndex++;
    if (callIndex === 0) {
      const trxQuery = vi.fn().mockResolvedValueOnce({
        rows: [makeEscrowRow(overrides)],
        rowCount: 1,
      });
      return fn(trxQuery);
    }
    if (callIndex === 1) {
      // Closed worker-abandon authority, bound to task/origin/version.
      return fn(vi.fn().mockResolvedValueOnce({
        rows:[authority],rowCount:1,
      }));
    }
    if (callIndex === 2) {
      // Fresh idempotency read immediately before the provider call.
      return fn(vi.fn().mockResolvedValueOnce({
        rows:[{ stripe_refund_id:null }],rowCount:1,
      }));
    }
    if (callIndex === 3) {
      // Escrow-scoped provider claim: exact current binding + immutable claim.
      return fn(vi.fn()
        .mockResolvedValueOnce({ rows:[makeEscrowRow(overrides)],rowCount:1 })
        .mockResolvedValueOnce({ rows:[{ id:'refund-claim' }],rowCount:1 }));
    }
    if (callIndex === 4) {
      // Immediate pre-provider full-binding readback.
      return fn(vi.fn().mockResolvedValueOnce({
        rows:[makeEscrowRow(overrides)],rowCount:1,
      }));
    }
    if (callIndex === 5) {
      // Exact provider witness transaction (persistence helper is mocked).
      return fn(vi.fn());
    }
    // Sixth transaction (T2): SELECT FOR UPDATE NOWAIT and the full-binding CAS.
    // The trxQuery is called twice:
    //   1st call: SELECT FOR UPDATE NOWAIT → returns the locked escrow row (for version re-read)
    //   2nd call: UPDATE ... RETURNING id → returns the updated row
    const trxQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [makeEscrowRow(overrides)], rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: ESCROW_ID }] });
    return fn(trxQuery);
  });
  vi.mocked(db.query).mockResolvedValue({ rows:[],rowCount:0 } as never);
}

// ---------------------------------------------------------------------------
// Tests: D1 settlement containment
// ---------------------------------------------------------------------------

describe('escrow-action handlers — D1 production disbursement freeze', () => {
  const disputeId = '20000000-0000-0000-0000-000000000001';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(StripeService.createRefund).mockResolvedValue({
      success: true,
      data: {
        refundId: 'refund_frozen_recovery',
        amount: 4_000,
        status: 'succeeded',
        currency: 'usd',
        paymentIntentId: 'pi_test',
        chargeId: 'ch_frozen_recovery',
      },
    } as never);
  });

  it.each(HOSTILE_PAYMENT_CREATION_ENVIRONMENTS_V7)(
    'rejects escrow release in $name before database or processor effects',
    async ({ env }) => {
      stubPaymentCreationEnvironmentV7(env);

      await expect(handleReleaseRequest({
        escrow: { ...makeEscrowRow(), platform_fee_cents: null },
        taskId: TASK_ID,
        reason: 'frozen dispute release',
      })).rejects.toMatchObject({ code: 'PAYMENT_CREATION_FROZEN' });

      expect(db.query).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(StripeService.createTransfer).not.toHaveBeenCalled();
      expect(SelfInsurancePoolService.recordContribution).not.toHaveBeenCalled();
    },
  );

  it.each(HOSTILE_PAYMENT_CREATION_ENVIRONMENTS_V7)(
    'blocks every provider leg of an atomic split in $name before claims or terminal writes',
    async ({ env }) => {
      stubPaymentCreationEnvironmentV7(env);
      payoutDestination.mockResolvedValue({
        ready: true,
        stripeConnectId: STRIPE_CONNECT_ID,
        reason: 'READY',
      });
      let claim: Record<string, unknown> | null = null;
      let checkpoint: Record<string, unknown> | null = null;
      vi.mocked(db.transaction).mockImplementation(async (callback) => callback(db.query));
      vi.mocked(db.query).mockImplementation(async (statement: string, params: unknown[] = []) => {
        const sql = String(statement);
        if (sql.includes('SELECT worker_id,payout_recipient_user_id')) {
          return { rows: [{
            worker_id: WORKER_ID,
            payout_recipient_user_id: null,
            provider_organization_id: null,
            provider_assignment_id: null,
            poster_id: 'poster-001',
          }], rowCount: 1 } as never;
        }
        if (sql.includes('SELECT version,state,task_id')) {
          return { rows: [makeEscrowRow()], rowCount: 1 } as never;
        }
        if (sql.includes('FROM disputes')) {
          return { rows: [{
            state: 'RESOLVED',
            escrow_id: ESCROW_ID,
            task_id: TASK_ID,
            outcome_escrow_action: 'SPLIT',
            outcome_refund_amount: 4_000,
            outcome_release_amount: 6_000,
          }], rowCount: 1 } as never;
        }
        if (sql.includes('INSERT INTO escrow_events')) {
          const metadata = JSON.parse(String(params[1])) as Record<string, unknown>;
          if (metadata.event_type === 'partial_refund_provider_claim_v2') {
            claim = metadata;
          } else {
            checkpoint = metadata;
          }
          return { rows: [{ metadata }], rowCount: 1 } as never;
        }
        if (sql.includes('SELECT metadata FROM escrow_events')) {
          return checkpoint
            ? { rows: [{ metadata: checkpoint }], rowCount: 1 } as never
            : { rows: [], rowCount: 0 } as never;
        }
        throw new Error(`Unexpected frozen worker query: ${sql}`);
      });

      await expect(handlePartialRefundRequest({
        escrow: { ...makeEscrowRow({ amount: 10_000 }), platform_fee_cents: null },
        taskId: TASK_ID,
        disputeId,
        reason: 'refund poster; hold provider release for reconciliation',
        refundAmount: 4_000,
        releaseAmount: 6_000,
      })).rejects.toMatchObject({ code: 'PAYMENT_CREATION_FROZEN' });

      expect(StripeService.createRefund).not.toHaveBeenCalled();
      expect(StripeService.createTransfer).not.toHaveBeenCalled();
      expect(SelfInsurancePoolService.recordContribution).not.toHaveBeenCalled();
      expect(TaskService.advanceProgress).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();

      const sql = vi.mocked(db.query).mock.calls.map(([statement]) => statement);
      expect(claim).toBeNull();
      expect(checkpoint).toBeNull();
      expect(sql.some((statement) => /INSERT\s+INTO\s+escrow_events\b/i.test(statement))).toBe(false);
      expect(sql.some((statement) => /UPDATE\s+(?:escrows|tasks)\b/i.test(statement))).toBe(false);
      expect(sql.some((statement) => /FROM\s+tasks\b/i.test(statement))).toBe(true);
    },
  );

  it('blocks released-origin SPLIT before refund, transfer, or database effects', async () => {
    await expect(handlePartialRefundRequest({
      escrow: {
        ...makeEscrowRow({
          amount: 10_000,
          stripe_transfer_id: 'tr_preserved_released_origin',
        }),
        platform_fee_cents: null,
      },
      taskId: TASK_ID,
      disputeId,
      reason: 'released-origin dispute split',
      refundAmount: 4_000,
      releaseAmount: 6_000,
    })).rejects.toMatchObject({ code: 'PARTIAL_REFUND_RECONCILIATION_REQUIRED' });

    expect(db.query).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(StripeService.createRefund).not.toHaveBeenCalled();
    expect(StripeService.createTransfer).not.toHaveBeenCalled();
  });

  it('reconciles a terminal partial-refund replay and acknowledges its exact outbox job', async () => {
    const outboxKey = `escrow.partial_refund_requested:${ESCROW_ID}:1`;
    const terminalEscrow = {
      ...makeEscrowRow(),
      state: 'REFUND_PARTIAL',
      version: ESCROW_VERSION + 1,
      stripe_refund_id: 're_terminal_001',
      stripe_transfer_id: 'tr_terminal_001',
      refund_amount: 4_000,
      release_amount: 6_000,
    };
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback(
      vi.fn().mockResolvedValue({ rows: [terminalEscrow], rowCount: 1 }),
    ));
    const job = makeJob('escrow.partial_refund_requested', makeSignedPayload({
      escrow_id: ESCROW_ID,
      task_id: TASK_ID,
      dispute_id: disputeId,
      reason: 'dispute resolution replay',
      refund_amount: 4_000,
      release_amount: 6_000,
    }));
    Object.assign(job, { id: outboxTransportJobId(outboxKey) });

    await processEscrowActionJob(job as never);

    expect(reconcilePartialRefund).toHaveBeenCalledWith({
      escrowId: ESCROW_ID,
      taskId: TASK_ID,
      disputeId,
      refundAmountCents: 4_000,
      releaseAmountCents: 6_000,
    });
    expect(markOutboxProcessed).toHaveBeenCalledWith(outboxKey);
    expect(StripeService.createRefund).not.toHaveBeenCalled();
    expect(StripeService.createTransfer).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: platform fee deduction
// ---------------------------------------------------------------------------

describe('escrow-action-worker — platform fee deduction (P0 revenue bug)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(StripeService.createTransfer).mockResolvedValue({
      success: true,
      data: { transferId: 'tr_test_abc' },
    } as never);
  });

  it('deducts 15% platform fee before transferring to worker on a $100 escrow', async () => {
    const escrowAmountCents = 10_000; // $100.00
    setupReleaseMocks(escrowAmountCents);

    const job = makeJob('escrow.release_requested',
      signedReleasePayload(escrowAmountCents),
    );

    await processEscrowActionJob(job as never);

    // Worker should receive 85% = 8500 cents, NOT the full 10000 cents
    expect(StripeService.createTransfer).toHaveBeenCalledOnce();
    const transferCall = vi.mocked(StripeService.createTransfer).mock.calls[0][0];
    // AUDIT FIX H3: insurance basis unified on GROSS (F54-2, matches
    // EscrowService.release): 10000 − 1500 fee − round(10000×2%)=200 → 8300.
    // (Old NET basis gave 8330 — the two release paths paid different amounts.)
    expect(transferCall.amount).toBe(8_300);
  });

  it('routes a Service Business dispute release to the provider payee', async () => {
    const payoutRecipientUserId='service-business-payee';
    setupReleaseMocks(10_000,{}, { payout_recipient_user_id:payoutRecipientUserId });

    await processEscrowActionJob(makeJob('escrow.release_requested',
      signedReleasePayload(),
    ) as never);

    expect(vi.mocked(db.query).mock.calls[0]?.[1]).toEqual([payoutRecipientUserId]);
    expect(StripeService.createTransfer).toHaveBeenCalledWith(expect.objectContaining({
      workerId:payoutRecipientUserId,workerStripeAccountId:STRIPE_CONNECT_ID,
    }));
    expect(SelfInsurancePoolService.recordContribution).toHaveBeenCalledWith(
      TASK_ID,WORKER_ID,200,
    );
  });

  it('does NOT transfer the full escrow amount (confirms the bug is fixed)', async () => {
    const escrowAmountCents = 10_000;
    setupReleaseMocks(escrowAmountCents);

    const job = makeJob('escrow.release_requested',
      signedReleasePayload(escrowAmountCents),
    );

    await processEscrowActionJob(job as never);

    const transferCall = vi.mocked(StripeService.createTransfer).mock.calls[0][0];
    // Must NOT be the full amount (that was the bug)
    expect(transferCall.amount).not.toBe(10_000);
  });

  it('rounds platform fee correctly for non-round amounts ($33.33 escrow)', async () => {
    const escrowAmountCents = 3_333; // $33.33
    setupReleaseMocks(escrowAmountCents);

    const job = makeJob('escrow.release_requested',
      signedReleasePayload(escrowAmountCents),
    );

    await processEscrowActionJob(job as never);

    // AUDIT FIX H3 (gross-basis insurance): 15% of 3333 = 499.95 → round 500;
    // insurance = round(3333×2%) = round(66.66) = 67; transfer = 3333−500−67 = 2766.
    const transferCall = vi.mocked(StripeService.createTransfer).mock.calls[0][0];
    expect(transferCall.amount).toBe(2_766);
  });

  it('never creates a second transfer when an existing transfer lacks current provider evidence', async () => {
    const dbTransaction = vi.mocked(db.transaction);
    let index = 0;
    dbTransaction.mockImplementation(async (fn) => {
      const query = index++ === 0
        ? vi.fn().mockResolvedValueOnce({
            rows: [makeEscrowRow({ stripe_transfer_id: 'tr_already_exists' })], rowCount: 1,
          })
        : vi.fn().mockResolvedValueOnce({ rows: [releaseAuthorityRow()], rowCount: 1 });
      return fn(query);
    });
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ stripe_connect_id: STRIPE_CONNECT_ID }], rowCount: 1,
    } as never);
    vi.mocked(StripeService.readTransferWitness).mockResolvedValueOnce({
      success: false,
      error: { code: 'STRIPE_TRANSFER_EVIDENCE_UNAVAILABLE', message: 'provider timeout' },
    });

    const job = makeJob('escrow.release_requested',
      signedReleasePayload(),
    );

    await expect(processEscrowActionJob(job as never)).rejects.toThrow(/provider timeout/);

    expect(StripeService.createTransfer).not.toHaveBeenCalled();
  });

  it('rejects a provider reversal between the first witness read and the T2 canonical CAS', async () => {
    setupReleaseMocks();
    const exact = {
      provider: 'STRIPE' as const,
      transferId: 'tr_test_abc',
      amountCents: 8_300,
      currency: 'usd',
      destinationAccountId: STRIPE_CONNECT_ID,
      reversed: false,
      amountReversedCents: 0,
      escrowId: ESCROW_ID,
      taskId: TASK_ID,
      payoutRecipientUserId: WORKER_ID,
    };
    vi.mocked(StripeService.readTransferWitness)
      .mockResolvedValueOnce({ success: true, data: exact })
      .mockResolvedValueOnce({
        success: true,
        data: { ...exact, reversed: true, amountReversedCents: 8_300 },
      });

    await expect(
      processEscrowActionJob(makeJob('escrow.release_requested', signedReleasePayload()) as never),
    ).rejects.toThrow(/does not match exact canonical payout binding/);

    expect(db.transaction).toHaveBeenCalledTimes(2);
    expect(RevenueService.logEvent).not.toHaveBeenCalled();
    expect(markOutboxProcessed).not.toHaveBeenCalled();
  });

  it('fails the action when the platform-fee service returns success:false', async () => {
    setupReleaseMocks();
    vi.mocked(RevenueService.logEvent).mockResolvedValueOnce({
      success: false,
      error: { code: 'REVENUE_LOG_FAILED', message: 'ledger unavailable' },
    });

    await expect(
      processEscrowActionJob(makeJob('escrow.release_requested', signedReleasePayload()) as never),
    ).rejects.toThrow(/Release revenue write failed: ledger unavailable/);

    expect(SelfInsurancePoolService.recordContribution).not.toHaveBeenCalled();
    expect(markOutboxProcessed).not.toHaveBeenCalled();
  });

  it('fails the action when the insurance service returns success:false', async () => {
    setupReleaseMocks();
    vi.mocked(SelfInsurancePoolService.recordContribution).mockResolvedValueOnce({
      success: false,
      error: { code: 'RECORD_CONTRIBUTION_FAILED', message: 'pool unavailable' },
    });

    await expect(
      processEscrowActionJob(makeJob('escrow.release_requested', signedReleasePayload()) as never),
    ).rejects.toThrow(/Release insurance write failed: pool unavailable/);

    expect(RevenueService.logEvent).toHaveBeenCalledOnce();
    expect(markOutboxProcessed).not.toHaveBeenCalled();
  });
});

describe('escrow-action-worker — preserved-transfer dispute release restore', () => {
  beforeEach(() => {
    vi.mocked(StripeService.createTransfer).mockClear();
  });

  function setupRestore(platformFeeCents: number | null = 1_500) {
    const transferId = 'tr_preserved_worker_win';
    const locked = {
      ...makeEscrowRow({ stripe_transfer_id: transferId }),
      version: 5,
      platform_fee_cents: platformFeeCents,
      payout_provider: 'STRIPE',
      provider_transfer_id: transferId,
      provider_transfer_status: 'paid',
    };
    const authority = releaseAuthorityRow(10_000);
    const origin = {
      actor_id: null,
      actor_type: 'system',
      idempotency_key: `released-dispute-origin-v1:${ESCROW_ID}:4`,
      metadata: {
        event_type: 'dispute_locked_after_release',
        task_id: TASK_ID,
        initiated_by: authority.initiated_by,
        original_transfer_id: transferId,
        escrow_version: 4,
      },
    };
    const releaseEvent = {
      from_state: 'FUNDED',
      to_state: 'RELEASED',
      actor_id: null,
      actor_type: 'system',
      metadata: {
        payout_provider: 'STRIPE',
        payout_recipient_user_id: WORKER_ID,
        provider_transfer_id: transferId,
        provider_transfer_status: 'submitted',
      },
    };
    const transactionSql: string[] = [];
    let txIndex = 0;
    vi.mocked(db.transaction).mockImplementation(async (callback) => {
      const index = txIndex++;
      let query: ReturnType<typeof vi.fn>;
      if (index === 0) {
        query = vi.fn().mockResolvedValueOnce({ rows: [locked], rowCount: 1 });
      } else if (index === 1) {
        query = vi.fn().mockResolvedValueOnce({ rows: [authority], rowCount: 1 });
      } else if (index === 2) {
        query = vi.fn()
          .mockResolvedValueOnce({ rows: [origin], rowCount: 1 })
          .mockResolvedValueOnce({ rows: [releaseEvent], rowCount: 1 });
      } else {
        query = vi.fn().mockImplementation(async (sql: string) => {
          transactionSql.push(String(sql));
          const call = query.mock.calls.length;
          if (call === 1) return { rows: [locked], rowCount: 1 };
          if (call === 2) return { rows: [authority], rowCount: 1 };
          if (call === 3) return { rows: [origin], rowCount: 1 };
          if (call === 4) return { rows: [releaseEvent], rowCount: 1 };
          if (call === 5) return { rows: [{ stripe_connect_id: STRIPE_CONNECT_ID }], rowCount: 1 };
          if (call === 6) return { rows: [{ id: 'restore-authority-event' }], rowCount: 1 };
          if (call === 7) return { rows: [{ set_config: ESCROW_ID }], rowCount: 1 };
          if (call === 8) return { rows: [{ version: 6 }], rowCount: 1 };
          throw new Error(`Unexpected restore query ${call}: ${sql}`);
        });
      }
      return callback(query as never);
    });
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ stripe_connect_id: STRIPE_CONNECT_ID }], rowCount: 1,
    } as never);
    vi.mocked(StripeService.readTransferWitness).mockReset().mockResolvedValue({
      success: true,
      data: {
        provider: 'STRIPE', transferId, amountCents: 8_300, currency: 'usd',
        destinationAccountId: STRIPE_CONNECT_ID, reversed: false, amountReversedCents: 0,
        escrowId: ESCROW_ID, taskId: TASK_ID, payoutRecipientUserId: WORKER_ID,
      },
    });
    return { transferId, transactionSql };
  }

  it('restores LOCKED_DISPUTE to RELEASED without creating a second transfer and reconciles exact effects', async () => {
    const setup = setupRestore();
    await processEscrowActionJob(makeJob('escrow.release_requested', signedReleasePayload()) as never);

    expect(StripeService.createTransfer).not.toHaveBeenCalled();
    expect(StripeService.readTransferWitness).toHaveBeenCalledTimes(2);
    expect(setup.transactionSql.some((sql) => sql.includes('dispute_release_restore_authority'))).toBe(true);
    expect(setup.transactionSql.some((sql) => /UPDATE escrows SET state='RELEASED'/.test(sql))).toBe(true);
    expect(EscrowReleaseReconciliationService.reconcile).toHaveBeenCalledWith({
      escrowId: ESCROW_ID,
      expectedStripeTransferId: setup.transferId,
      fromState: 'FUNDED',
    });
    expect(markOutboxProcessed).toHaveBeenCalledWith(`escrow.release_requested:${ESCROW_ID}:1`);
  });

  it('fails before authority-event insertion when canonical platform fee is absent', async () => {
    const setup = setupRestore(null);
    await expect(
      processEscrowActionJob(makeJob('escrow.release_requested', signedReleasePayload()) as never),
    ).rejects.toThrow(/preserved transfer facts/);

    expect(setup.transactionSql.some((sql) => /INSERT INTO escrow_events/.test(sql))).toBe(false);
    expect(EscrowReleaseReconciliationService.reconcile).not.toHaveBeenCalled();
    expect(markOutboxProcessed).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: transaction wrapping (critical-section lock fix)
// ---------------------------------------------------------------------------

describe('escrow-action-worker — FOR UPDATE runs inside db.transaction()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(StripeService.createTransfer).mockResolvedValue({
      success: true,
      data: { transferId: 'tr_test_txn' },
    } as never);
  });

  it('calls db.transaction() at least once before any Stripe call on release_requested', async () => {
    setupReleaseMocks();

    await processEscrowActionJob(makeJob('escrow.release_requested',
      signedReleasePayload(),
    ) as never);

    expect(vi.mocked(db.transaction).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(StripeService.createTransfer).mock.invocationCallOrder[0]);
  });

  it('passes the FOR UPDATE SELECT through the trx callback (not bare db.query)', async () => {
    const setup = setupReleaseMocks();

    await processEscrowActionJob(makeJob('escrow.release_requested',
      signedReleasePayload(),
    ) as never);

    const transactionSql = setup.transactionQueries
      .flatMap((query) => query.mock.calls.map(([sql]) => String(sql)));
    expect(transactionSql.some((sql) => /FROM escrows.*FOR UPDATE/is.test(sql))).toBe(true);
  });

  it('does NOT call bare db.query for the FOR UPDATE SELECT (lock must use trx)', async () => {
    setupReleaseMocks();

    // Track which SQL statements go through db.query vs db.transaction
    const bareQuerySqls: string[] = [];
    vi.mocked(db.query).mockImplementation(async (sql: string, ...args: unknown[]) => {
      bareQuerySqls.push(sql);
      // Provide data for the auxiliary reads that legitimately use db.query
      if (sql.includes('worker_id')) return { rows: [{ worker_id: WORKER_ID }], rowCount: 1 } as never;
      if (sql.includes('stripe_connect_id')) return { rows: [{ stripe_connect_id: STRIPE_CONNECT_ID }], rowCount: 1 } as never;
      return { rows: [], rowCount: 0 } as never;
    });

    await processEscrowActionJob(makeJob('escrow.release_requested',
      signedReleasePayload(),
    ) as never);

    // None of the bare db.query calls should contain FOR UPDATE
    for (const sql of bareQuerySqls) {
      expect(sql).not.toMatch(/FOR UPDATE/i);
    }
  });

  it('version-checked UPDATE runs inside a second db.transaction() call', async () => {
    const setup = setupReleaseMocks();

    await processEscrowActionJob(makeJob('escrow.release_requested',
      signedReleasePayload(),
    ) as never);

    const updateSql = setup.transactionQueries
      .flatMap((query) => query.mock.calls.map(([sql]) => String(sql)))
      .find((sql) => /UPDATE escrows/i.test(sql)) ?? '';
    expect(db.transaction).toHaveBeenCalledTimes(3);
    expect(updateSql).toMatch(/UPDATE escrows/i);
    expect(updateSql).toMatch(/stripe_transfer_id/i);
  });

  it('rejects non-LOCKED_DISPUTE escrow state inside the transaction (no Stripe call)', async () => {
    const dbTransaction = vi.mocked(db.transaction);
    dbTransaction.mockImplementationOnce(async (fn) => {
      const trxQuery = vi.fn().mockResolvedValueOnce({
        rows: [makeEscrowRow({ state: 'FUNDED' })],
        rowCount: 1,
      });
      return fn(trxQuery);
    });

    await expect(
      processEscrowActionJob(makeJob('escrow.release_requested',
        signedReleasePayload(),
      ) as never)
    ).rejects.toThrow('LOCKED_DISPUTE');

    expect(StripeService.createTransfer).not.toHaveBeenCalled();
  });

  it('rejects missing escrow inside the transaction (no Stripe call)', async () => {
    const dbTransaction = vi.mocked(db.transaction);
    dbTransaction.mockImplementationOnce(async (fn) => {
      const trxQuery = vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 });
      return fn(trxQuery);
    });

    await expect(
      processEscrowActionJob(makeJob('escrow.release_requested',
        signedReleasePayload(),
      ) as never)
    ).rejects.toThrow('not found');

    expect(StripeService.createTransfer).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: refund_requested handler
// ---------------------------------------------------------------------------

describe('escrow-action-worker — refund_requested handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    persistRefundWitness.mockReset().mockResolvedValue(undefined);
    vi.mocked(StripeService.createRefund).mockImplementation(async (input) => ({
      success: true,
      data: {
        refundId:'refund_test_abc',amount:input.amount,status:'succeeded',currency:'usd',
        paymentIntentId:input.paymentIntentId,chargeId:'ch_refund_test',
      },
    } as never));
    vi.mocked(StripeService.readRefundWitness).mockImplementation(async (refundId) => ({
      success:true,
      data:{
        refundId,amount:10_000,status:'succeeded',currency:'usd',
        paymentIntentId:'pi_test',chargeId:'ch_refund_existing',
      },
    } as never));
  });

  it('creates a full refund via Stripe and stores refund_id via second transaction', async () => {
    setupRefundMocks();

    await processEscrowActionJob(makeJob('escrow.refund_requested',
      makeSignedPayload({ escrow_id: ESCROW_ID, task_id: TASK_ID, reason: 'worker_abandoned' }),
    ) as never);

    expect(StripeService.createRefund).toHaveBeenCalledOnce();
    const refundCall = vi.mocked(StripeService.createRefund).mock.calls[0][0];
    expect(refundCall.amount).toBe(10_000);
    expect(refundCall.paymentIntentId).toBe('pi_test');
  });

  it('acknowledges the signed custom worker-abandon outbox identity only after refund success', async () => {
    const outboxKey = `escrow.refund_on_worker_abandon:${ESCROW_ID}:${TASK_ID}`;
    setupRefundMocks();
    await processEscrowActionJob(makeJob('escrow.refund_requested', makeSignedPayload({
      escrow_id: ESCROW_ID,
      task_id: TASK_ID,
      reason: 'worker_abandoned',
      _outbox_key: outboxKey,
    })) as never);

    expect(StripeService.createRefund).toHaveBeenCalledOnce();
    expect(markOutboxProcessed).toHaveBeenCalledWith(outboxKey);
  });

  it('acknowledges the signed custom dispatch-expiry outbox identity only after refund success', async () => {
    const outboxKey = `dispatch-expiry-refund:${TASK_ID}`;
    setupRefundMocks({}, {
      task_state: 'EXPIRED',
      worker_id: null,
      expiration_reason: 'UNFILLED',
      event_type: 'TASK_EXPIRED_UNFILLED',
      idempotency_key: `dispatch-expiry:${TASK_ID}`,
    });
    await processEscrowActionJob(makeJob('escrow.refund_requested', makeSignedPayload({
      escrow_id: ESCROW_ID,
      task_id: TASK_ID,
      reason: 'dispatch_expired_unfilled',
      _outbox_key: outboxKey,
    })) as never);

    expect(StripeService.createRefund).toHaveBeenCalledOnce();
    expect(markOutboxProcessed).toHaveBeenCalledWith(outboxKey);
  });

  it('rejects a forged BullMQ job ID even when the financial payload signature is valid', async () => {
    const outboxKey = `escrow.refund_on_worker_abandon:${ESCROW_ID}:${TASK_ID}`;
    const job = makeJob('escrow.refund_requested', makeSignedPayload({
      escrow_id: ESCROW_ID,
      task_id: TASK_ID,
      reason: 'worker_abandoned',
      _outbox_key: outboxKey,
    }));
    Object.assign(job, { id: `forged:${ESCROW_ID}` });

    await expect(processEscrowActionJob(job as never)).rejects.toThrow(/OUTBOX_IDENTITY_MISMATCH/);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(StripeService.createRefund).not.toHaveBeenCalled();
    expect(markOutboxProcessed).not.toHaveBeenCalled();
  });

  it('accepts only an exact resolved-dispute full-refund authority', async () => {
    const disputeId='20000000-0000-0000-0000-000000000001';
    setupRefundMocks({}, {
      id:disputeId,task_id:TASK_ID,escrow_id:ESCROW_ID,state:'RESOLVED',
      outcome_escrow_action:'REFUND',outcome_refund_amount:10_000,
      outcome_release_amount:0,task_state:'CANCELLED',
    });

    await processEscrowActionJob(makeJob('escrow.refund_requested',
      makeSignedPayload({
        escrow_id:ESCROW_ID,task_id:TASK_ID,dispute_id:disputeId,
        reason:'dispute_resolution',refund_amount:10_000,release_amount:0,
      }),
    ) as never);

    expect(StripeService.createRefund).toHaveBeenCalledOnce();
    expect(vi.mocked(StripeService.createRefund).mock.calls[0][0].amount).toBe(10_000);
  });

  it('rejects a resolved dispute whose canonical refund amount is not the full escrow', async () => {
    const disputeId='20000000-0000-0000-0000-000000000002';
    const dbTransaction=vi.mocked(db.transaction);
    dbTransaction
      .mockImplementationOnce(async (fn) => fn(vi.fn().mockResolvedValueOnce({
        rows:[makeEscrowRow()],rowCount:1,
      })))
      .mockImplementationOnce(async (fn) => fn(vi.fn().mockResolvedValueOnce({
        rows:[{
          id:disputeId,task_id:TASK_ID,escrow_id:ESCROW_ID,state:'RESOLVED',
          outcome_escrow_action:'REFUND',outcome_refund_amount:9_999,
          outcome_release_amount:1,task_state:'CANCELLED',
        }],rowCount:1,
      })));

    await expect(processEscrowActionJob(makeJob('escrow.refund_requested',
      makeSignedPayload({
        escrow_id:ESCROW_ID,task_id:TASK_ID,dispute_id:disputeId,
        reason:'dispute_resolution',refund_amount:10_000,release_amount:0,
      }),
    ) as never)).rejects.toThrow(/does not exactly authorize a full refund/);

    expect(StripeService.createRefund).not.toHaveBeenCalled();
    expect(StripeService.readRefundWitness).not.toHaveBeenCalled();
  });

  it('rejects a signed narrative origin that is outside the closed refund authority set', async () => {
    const dbTransaction=vi.mocked(db.transaction);
    dbTransaction.mockImplementationOnce(async (fn) => fn(vi.fn().mockResolvedValueOnce({
      rows:[makeEscrowRow()],rowCount:1,
    })));
    dbTransaction.mockImplementationOnce(async (fn) => fn(vi.fn()));

    await expect(processEscrowActionJob(makeJob('escrow.refund_requested',
      makeSignedPayload({ escrow_id:ESCROW_ID,task_id:TASK_ID,reason:'admin said refund' }),
    ) as never)).rejects.toThrow(/unsupported refund origin/);

    expect(StripeService.createRefund).not.toHaveBeenCalled();
    expect(StripeService.readRefundWitness).not.toHaveBeenCalled();
  });

  it('skips Stripe call on idempotent replay (stripe_refund_id already set)', async () => {
    const dbTransaction = vi.mocked(db.transaction);
    dbTransaction.mockImplementationOnce(async (fn) => {
      const trxQuery = vi.fn().mockResolvedValueOnce({
        rows: [makeEscrowRow({ stripe_refund_id: 'refund_already_exists' })],
        rowCount: 1,
      });
      return fn(trxQuery);
    });
    dbTransaction.mockImplementationOnce(async (fn) => fn(vi.fn().mockResolvedValueOnce({
      rows:[workerAbandonAuthorityRow()],rowCount:1,
    })));
    dbTransaction.mockImplementationOnce(async (fn) => fn(vi.fn()));

    await processEscrowActionJob(makeJob('escrow.refund_requested',
      makeSignedPayload({ escrow_id: ESCROW_ID, task_id: TASK_ID, reason: 'worker_abandoned' }),
    ) as never);

    expect(StripeService.createRefund).not.toHaveBeenCalled();
  });

  it('rejects an arbitrary stored refund identity unless current provider evidence matches', async () => {
    const dbTransaction=vi.mocked(db.transaction);
    dbTransaction.mockImplementationOnce(async (fn) => fn(vi.fn().mockResolvedValueOnce({
      rows:[makeEscrowRow({ stripe_refund_id:'refund_untrusted' })],rowCount:1,
    })));
    dbTransaction.mockImplementationOnce(async (fn) => fn(vi.fn().mockResolvedValueOnce({
      rows:[workerAbandonAuthorityRow()],rowCount:1,
    })));
    vi.mocked(StripeService.readRefundWitness).mockResolvedValueOnce({
      success:true,
      data:{
        refundId:'refund_untrusted',amount:10_000,status:'succeeded',currency:'usd',
        paymentIntentId:'pi_attacker',chargeId:'ch_attacker',
      },
    } as never);

    await expect(processEscrowActionJob(makeJob('escrow.refund_requested',
      makeSignedPayload({ escrow_id:ESCROW_ID,task_id:TASK_ID,reason:'worker_abandoned' }),
    ) as never)).rejects.toThrow(/not an exact current succeeded refund/);

    expect(StripeService.createRefund).not.toHaveBeenCalled();
    expect(persistRefundWitness).not.toHaveBeenCalled();
  });

  it('throws when escrow has no stripe_payment_intent_id', async () => {
    const dbTransaction = vi.mocked(db.transaction);
    dbTransaction.mockImplementationOnce(async (fn) => {
      const row = makeEscrowRow();
      row.stripe_payment_intent_id = null;
      const trxQuery = vi.fn().mockResolvedValueOnce({ rows: [row], rowCount: 1 });
      return fn(trxQuery);
    });
    dbTransaction.mockImplementationOnce(async (fn) => fn(vi.fn().mockResolvedValueOnce({
      rows:[workerAbandonAuthorityRow()],rowCount:1,
    })));

    await expect(
      processEscrowActionJob(makeJob('escrow.refund_requested',
        makeSignedPayload({ escrow_id: ESCROW_ID, task_id: TASK_ID, reason: 'worker_abandoned' }),
      ) as never)
    ).rejects.toThrow('stripe_payment_intent_id');
  });

  it('rejects a signed partial amount before any refund provider or authority effect', async () => {
    const dbTransaction=vi.mocked(db.transaction);
    dbTransaction.mockImplementationOnce(async (fn) => fn(vi.fn().mockResolvedValueOnce({
      rows:[makeEscrowRow()],rowCount:1,
    })));

    await expect(processEscrowActionJob(makeJob('escrow.refund_requested',
      makeSignedPayload({
        escrow_id: ESCROW_ID, task_id: TASK_ID,
        reason: 'worker_abandoned', refund_amount: 4_000,
      }),
    ) as never)).rejects.toThrow(/refund amount must exactly equal/);

    expect(StripeService.createRefund).not.toHaveBeenCalled();
    expect(dbTransaction).toHaveBeenCalledTimes(1);
  });

  it('falls back to full escrow amount when refund_amount is absent (BUG H4 — no regression)', async () => {
    setupRefundMocks();

    await processEscrowActionJob(makeJob('escrow.refund_requested',
      makeSignedPayload({ escrow_id: ESCROW_ID, task_id: TASK_ID, reason: 'worker_abandoned' }),
    ) as never);

    expect(StripeService.createRefund).toHaveBeenCalledOnce();
    const refundCall = vi.mocked(StripeService.createRefund).mock.calls[0][0];
    expect(refundCall.amount).toBe(10_000); // full escrow amount
  });

  it.each([
    ['pending status',{ status:'pending' }],
    ['failed status',{ status:'failed' }],
    ['wrong amount',{ amount:9_999 }],
    ['wrong currency',{ currency:'eur' }],
    ['wrong PaymentIntent',{ paymentIntentId:'pi_attacker' }],
    ['missing Charge',{ chargeId:null }],
  ] as const)('rejects %s provider evidence before storing a refund identity', async (_label, override) => {
    setupRefundMocks();
    vi.mocked(StripeService.createRefund).mockResolvedValueOnce({
      success:true,
      data:{
        refundId:'refund_hostile',amount:10_000,status:'succeeded',currency:'usd',
        paymentIntentId:'pi_test',chargeId:'ch_hostile',...override,
      },
    } as never);

    await expect(processEscrowActionJob(makeJob('escrow.refund_requested',
      makeSignedPayload({ escrow_id:ESCROW_ID,task_id:TASK_ID,reason:'worker_abandoned' }),
    ) as never)).rejects.toThrow(/not an exact current succeeded refund/);

    expect(persistRefundWitness).not.toHaveBeenCalled();
    expect(vi.mocked(db.transaction)).toHaveBeenCalledTimes(5);
    const sql = vi.mocked(db.query).mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).not.toMatch(/UPDATE\s+escrows/i);
  });

  it('FOR UPDATE runs inside db.transaction() for refund path (not bare db.query)', async () => {
    let forUpdateSql = '';
    const dbTransaction = vi.mocked(db.transaction);
    let txIdx = 0;

    dbTransaction.mockImplementation(async (fn) => {
      const callIdx = txIdx++;
      if (callIdx === 0) {
        const trxQuery = vi.fn().mockImplementation(async (sql: string) => {
          forUpdateSql = sql;
          return { rows: [makeEscrowRow()], rowCount: 1 };
        });
        return fn(trxQuery);
      }
      if (callIdx === 1) {
        return fn(vi.fn().mockResolvedValueOnce({
          rows:[workerAbandonAuthorityRow()],rowCount:1,
        }));
      }
      if (callIdx === 2) {
        return fn(vi.fn().mockResolvedValueOnce({
          rows:[{ stripe_refund_id:null }],rowCount:1,
        }));
      }
      if (callIdx === 3) {
        return fn(vi.fn()
          .mockResolvedValueOnce({ rows:[makeEscrowRow()],rowCount:1 })
          .mockResolvedValueOnce({ rows:[{ id:'refund-claim' }],rowCount:1 }));
      }
      if (callIdx === 4) {
        return fn(vi.fn().mockResolvedValueOnce({ rows:[makeEscrowRow()],rowCount:1 }));
      }
      if (callIdx === 5) return fn(vi.fn());
      // T2: exact full-binding SELECT FOR UPDATE NOWAIT + guarded UPDATE.
      return fn(vi.fn()
        .mockResolvedValueOnce({ rows:[makeEscrowRow()],rowCount:1 })
        .mockResolvedValueOnce({ rowCount:1,rows:[{ id:ESCROW_ID }] }));
    });
    vi.mocked(db.query).mockResolvedValue({ rows:[],rowCount:0 } as never);

    await processEscrowActionJob(makeJob('escrow.refund_requested',
      makeSignedPayload({ escrow_id: ESCROW_ID, task_id: TASK_ID, reason: 'worker_abandoned' }),
    ) as never);

    expect(forUpdateSql).toMatch(/FOR UPDATE/i);
  });
});

describe('EscrowActionRefund provider-success recovery', () => {
  const action={
    escrow:makeEscrowRow(),taskId:TASK_ID,reason:'worker_abandoned',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    persistRefundWitness.mockReset().mockResolvedValue(undefined);
    vi.mocked(db.query).mockResolvedValue({ rows:[],rowCount:0 } as never);
    vi.mocked(StripeService.createRefund).mockResolvedValue({
      success:true,
      data:{
        refundId:'refund_recovery',amount:10_000,status:'succeeded',currency:'usd',
        paymentIntentId:'pi_test',chargeId:'ch_recovery',
      },
    } as never);
  });

  it('rejects same-state version drift immediately before the provider refund', async () => {
    let transactionIndex=0;
    vi.mocked(db.transaction).mockImplementation(async (callback) => {
      const index=transactionIndex++;
      if (index===0) return callback(vi.fn().mockResolvedValueOnce({
        rows:[workerAbandonAuthorityRow()],rowCount:1,
      }));
      if (index===1) return callback(vi.fn().mockResolvedValueOnce({
        rows:[{ stripe_refund_id:null }],rowCount:1,
      }));
      if (index===2) return callback(vi.fn()
        .mockResolvedValueOnce({ rows:[makeEscrowRow()],rowCount:1 })
        .mockResolvedValueOnce({ rows:[{ id:'claim' }],rowCount:1 }));
      return callback(vi.fn().mockResolvedValueOnce({
        rows:[{ ...makeEscrowRow(),version:2 }],rowCount:1,
      }));
    });

    await expect(handleRefundRequest(action)).rejects.toThrow(/changed before refund provider call/);
    expect(StripeService.createRefund).not.toHaveBeenCalled();
  });

  it('persists a separate reconciliation event after provider success and T2 canonical drift', async () => {
    const drifted={ ...makeEscrowRow(),version:2,stripe_transfer_id:'tr_concurrent_release' };
    let transactionIndex=0;
    vi.mocked(db.transaction).mockImplementation(async (callback) => {
      const index=transactionIndex++;
      if (index===0) return callback(vi.fn().mockResolvedValueOnce({
        rows:[workerAbandonAuthorityRow()],rowCount:1,
      }));
      if (index===1) return callback(vi.fn().mockResolvedValueOnce({
        rows:[{ stripe_refund_id:null }],rowCount:1,
      }));
      if (index===2) return callback(vi.fn()
        .mockResolvedValueOnce({ rows:[makeEscrowRow()],rowCount:1 })
        .mockResolvedValueOnce({ rows:[{ id:'claim' }],rowCount:1 }));
      if (index===3) return callback(vi.fn().mockResolvedValueOnce({
        rows:[makeEscrowRow()],rowCount:1,
      }));
      if (index===4) return callback(vi.fn());
      if (index===5) return callback(vi.fn().mockResolvedValueOnce({
        rows:[drifted],rowCount:1,
      }));
      return callback(vi.fn()
        .mockResolvedValueOnce({ rows:[drifted],rowCount:1 })
        .mockResolvedValueOnce({ rows:[{ id:'recovery-event' }],rowCount:1 }));
    });

    await expect(handleRefundRequest(action)).rejects.toThrow(/changed after refund provider success/);

    expect(StripeService.createRefund).toHaveBeenCalledOnce();
    expect(persistRefundWitness).toHaveBeenCalledOnce();
    const recoveryCall=vi.mocked(db.transaction).mock.calls.at(-1);
    expect(recoveryCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: schema & signature validation
// ---------------------------------------------------------------------------

describe('escrow-action-worker — input validation', () => {
  it('rejects malformed payload (missing escrow_id)', async () => {
    const job = makeJob('escrow.release_requested', { task_id: TASK_ID, reason: 'no escrow_id', _sig: 'a'.repeat(64) });
    await expect(processEscrowActionJob(job as never)).rejects.toThrow('JOB_SCHEMA_INVALID');
  });

  it('rejects tampered signature', async () => {
    const payload = makeSignedPayload({ escrow_id: ESCROW_ID, task_id: TASK_ID, reason: 'sig test' });
    payload['_sig'] = 'b'.repeat(64); // wrong sig
    const job = makeJob('escrow.release_requested', payload);
    await expect(processEscrowActionJob(job as never)).rejects.toThrow('JOB_SIGNATURE_INVALID');
  });

  it('rejects unknown event type after successful lock', async () => {
    const dbTransaction = vi.mocked(db.transaction);
    dbTransaction.mockImplementationOnce(async (fn) => {
      const trxQuery = vi.fn().mockResolvedValueOnce({ rows: [makeEscrowRow()], rowCount: 1 });
      return fn(trxQuery);
    });

    const job = makeJob('escrow.unknown_action',
      makeSignedPayload({ escrow_id: ESCROW_ID, task_id: TASK_ID, reason: 'unknown event' }),
    );
    await expect(processEscrowActionJob(job as never)).rejects.toThrow('Unknown escrow action event type');
  });
});

// ---------------------------------------------------------------------------
// INV-11 safety net: a failed Stripe transfer on the dispute-release path must
// NEVER advance the escrow. EscrowService.release() does not call Stripe inline;
// the worker→Stripe transfer happens HERE, and the escrow only gains a
// stripe_transfer_id (T2) AFTER a successful transfer. These tests prove that a
// Stripe failure leaves the escrow in LOCKED_DISPUTE with no transfer_id stored.
// ---------------------------------------------------------------------------
describe('escrow-action-worker — release path: failed Stripe transfer must not advance escrow (INV-11)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(StripeService.createTransfer).mockReset();
  });

  // Wire mocks up to (but not past) the Stripe createTransfer call:
  //   transaction #1 — critical-section FOR UPDATE lock → returns LOCKED_DISPUTE escrow
  //   query #1       — SELECT worker_id, poster_id FROM tasks
  //   query #2       — SELECT stripe_connect_id FROM users
  // Any transaction AFTER #1 (e.g. lockEscrowForStripeRestriction T, or T2) records
  // its (sql, params) into the returned array so we can assert what did/didn't run.
  function setupReleaseUpToStripe(escrowOverrides = {}) {
    const dbQuery = vi.mocked(db.query);
    const dbTransaction = vi.mocked(db.transaction);
    const txCalls: Array<{ sql: string; params: unknown[] }> = [];
    let txCallIndex = 0;

    dbTransaction.mockImplementation(async (fn) => {
      const idx = txCallIndex++;
      if (idx === 0) {
        const trxQuery = vi.fn().mockResolvedValueOnce({
          rows: [makeEscrowRow(escrowOverrides)],
          rowCount: 1,
        });
        return fn(trxQuery);
      }
      if (idx === 1) {
        return fn(vi.fn().mockResolvedValueOnce({
          rows: [releaseAuthorityRow()], rowCount: 1,
        }));
      }
      // Subsequent transactions (T2 store-transfer, or restriction-lock): record SQL.
      const trxQuery = vi.fn((sql: string, params: unknown[]) => {
        txCalls.push({ sql, params });
        return Promise.resolve({ rows: [], rowCount: 1 });
      });
      return fn(trxQuery as never);
    });

    dbQuery.mockResolvedValueOnce({
      rows: [{ stripe_connect_id: STRIPE_CONNECT_ID }], rowCount: 1,
    } as never);

    return txCalls;
  }

  const releaseJob = () =>
    makeJob('escrow.release_requested',
      signedReleasePayload(),
    );

  it('(a) a non-restriction Stripe transfer failure rethrows (BullMQ retry) and never stores a transfer_id', async () => {
    const txCalls = setupReleaseUpToStripe();
    vi.mocked(StripeService.createTransfer).mockRejectedValueOnce(
      Object.assign(new Error('Stripe 500 internal error'), { code: 'api_error' }),
    );

    await expect(processEscrowActionJob(releaseJob() as never)).rejects.toThrow(/Stripe 500 internal error/);

    expect(StripeService.createTransfer).toHaveBeenCalledTimes(1);
    // Only the critical-section lock transaction ran — T2 (store transfer_id) was never reached,
    // so the escrow keeps state=LOCKED_DISPUTE and stripe_transfer_id=null (not advanced/released).
    expect(vi.mocked(db.transaction)).toHaveBeenCalledTimes(2);
    expect(txCalls.some((c) => /stripe_transfer_id\s*=/.test(c.sql))).toBe(false);
  });

  it('(c) a transient network timeout during transfer rethrows for retry and does not store a transfer_id', async () => {
    setupReleaseUpToStripe();
    vi.mocked(StripeService.createTransfer).mockRejectedValueOnce(
      Object.assign(new Error('ETIMEDOUT: connection timed out'), { code: 'ETIMEDOUT' }),
    );

    await expect(processEscrowActionJob(releaseJob() as never)).rejects.toThrow(/ETIMEDOUT/);

    // Transient error is surfaced (rethrown) so BullMQ retries — it is NOT swallowed,
    // and the escrow is not advanced (no T2 transaction).
    expect(vi.mocked(db.transaction)).toHaveBeenCalledTimes(2);
  });

  it('(b) a Stripe account restriction (account_closed) locks the escrow for admin review, does NOT rethrow, and stores no transfer_id', async () => {
    const txCalls = setupReleaseUpToStripe();
    vi.mocked(StripeService.createTransfer).mockRejectedValueOnce(
      Object.assign(new Error('The account is closed'), { code: 'account_closed' }),
    );

    // Must NOT rethrow — a non-retryable restriction means BullMQ should not retry forever.
    await expect(processEscrowActionJob(releaseJob() as never)).resolves.toBeUndefined();

    expect(StripeService.createTransfer).toHaveBeenCalledTimes(1);
    // Three transactions: T1 escrow lock, exact authority, restriction lock.
    expect(vi.mocked(db.transaction)).toHaveBeenCalledTimes(3);

    // The restriction-lock transaction moved the escrow to LOCKED_DISPUTE (recoverable, NOT released)
    // and recorded the reason for admin reconciliation.
    const lockSql = txCalls.find((c) => /LOCKED_DISPUTE/.test(c.sql));
    expect(lockSql).toBeDefined();
    expect(JSON.stringify(lockSql!.params)).toContain('stripe_account_restricted');

    // Crucially: no transfer_id was ever written, so the escrow was not advanced/released.
    expect(txCalls.some((c) => /stripe_transfer_id\s*=/.test(c.sql))).toBe(false);

    // Admins are paged at CRITICAL priority for manual resolution.
    expect(vi.mocked(notifyAdmins)).toHaveBeenCalledWith(
      expect.objectContaining({ priority: 'CRITICAL' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Money conservation + non-negative payout on the release path.
// Proves gross = platformFee + insurance + workerTransfer (no cents lost) and
// that the worker transfer amount is never negative, across round and non-round
// amounts. The transfer amount is captured from the StripeService.createTransfer call.
// ---------------------------------------------------------------------------
describe('escrow-action-worker — release payout math: conservation & non-negativity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(StripeService.createTransfer).mockResolvedValue({
      success: true,
      data: { transferId: 'tr_conservation' },
    } as never);
  });

  it.each([10_000, 3_333, 99, 1])(
    'gross=%i cents: platformFee + insurance + workerTransfer === gross, all non-negative',
    async (gross) => {
      setupReleaseMocks(gross);

      await processEscrowActionJob(
        makeJob('escrow.release_requested',
          signedReleasePayload(gross),
        ) as never,
      );

      // Capture the amount actually sent to the worker via Stripe.
      const transferArg = vi.mocked(StripeService.createTransfer).mock.calls[0][0] as { amount: number };
      const workerTransfer = transferArg.amount;

      // Re-derive the source decomposition via the unified convention
      // (AUDIT FIX H3: 15% fee on gross, 2% insurance on GROSS — F54-2 basis,
      // identical to EscrowService.release; transfer is the exact complement).
      const platformFee = Math.round(gross * 0.15);
      const insurance = Math.round(gross * 0.02);
      const expectedTransfer = gross - platformFee - insurance;

      expect(workerTransfer).toBe(expectedTransfer);          // payout amount pinned
      expect(platformFee + insurance + workerTransfer).toBe(gross); // money conserved, no cents lost
      expect(workerTransfer).toBeGreaterThanOrEqual(0);       // never negative
      expect(platformFee).toBeGreaterThanOrEqual(0);
      expect(insurance).toBeGreaterThanOrEqual(0);
    },
  );
});
