import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbQuery = vi.hoisted(() => vi.fn());
const dbTransaction = vi.hoisted(() => vi.fn(
  async (callback: (query: typeof dbQuery) => Promise<unknown>) => callback(dbQuery),
));
const payoutDestination = vi.hoisted(() => vi.fn());

vi.mock('../../src/db.js', () => ({
  db: { query: dbQuery, transaction: dbTransaction },
}));

vi.mock('../../src/config.js', () => ({
  config: { stripe: { platformFeePercent: 15 } },
}));

vi.mock('../../src/logger.js', () => {
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: () => log };
  return { escrowLogger: log, workerLogger: log };
});

vi.mock('../../src/services/StripeService.js', () => ({
  StripeService: {
    createTransferReversal: vi.fn(),
    createRefund: vi.fn(),
  },
}));

vi.mock('../../src/services/TaskPayoutDestinationService.js', () => ({
  loadCurrentTaskPayoutDestination: payoutDestination,
}));

vi.mock('../../src/services/XPService.js', () => ({
  XPService: { clawbackXP: vi.fn() },
}));

vi.mock('../../src/services/EscrowRefundTransaction.js', () => ({
  prepareRefund: vi.fn(),
  terminalizeRefund: vi.fn(),
}));

vi.mock('../../src/services/EscrowServiceShared.js', () => ({
  logEscrowEvent: vi.fn(),
}));

import { handleRefundRequest } from '../../src/jobs/EscrowActionRefund.js';
import {
  persistExactFullTransferReversalWitness,
  refundEscrow,
  requireExactFullTransferReversal,
} from '../../src/services/EscrowRefundService.js';
import type {
  ExactFullTransferReversalBinding,
  TransferReversalEvidence,
} from '../../src/services/EscrowRefundService.js';
import { prepareRefund, terminalizeRefund } from '../../src/services/EscrowRefundTransaction.js';
import { StripeService } from '../../src/services/StripeService.js';

const ESCROW_ID = '00000000-0000-4000-8000-000000000001';
const TASK_ID = '10000000-0000-4000-8000-000000000001';
const DISPUTE_ID = '20000000-0000-4000-8000-000000000001';
const WORKER_ID = '30000000-0000-4000-8000-000000000001';
const TRANSFER_ID = 'tr_exact_reversal';
const PAYMENT_INTENT_ID = 'pi_exact_reversal';
const DESTINATION_ID = 'acct_exact_reversal';

function binding(
  overrides: Partial<ExactFullTransferReversalBinding> = {},
): ExactFullTransferReversalBinding {
  return {
    escrowId: ESCROW_ID,
    canonicalState: 'LOCKED_DISPUTE',
    taskId: TASK_ID,
    workerId: WORKER_ID,
    payoutRecipientUserId: WORKER_ID,
    destinationAccountId: DESTINATION_ID,
    stripePaymentIntentId: PAYMENT_INTENT_ID,
    transferId: TRANSFER_ID,
    escrowAmountCents: 10_000,
    platformFeeCents: 1_500,
    insuranceContributionCents: 200,
    transferAmountCents: 8_300,
    ...overrides,
  };
}

function exactEvidence(
  expected = binding(),
  overrides: Partial<TransferReversalEvidence['transferWitness']> = {},
  reversal: Pick<TransferReversalEvidence, 'reversalId' | 'reversalAmountCents'> = {
    reversalId: 'trr_exact_reversal',
    reversalAmountCents: expected.transferAmountCents,
  },
): TransferReversalEvidence {
  return {
    ...reversal,
    transferWitness: {
      provider: 'STRIPE',
      transferId: expected.transferId,
      amountCents: expected.transferAmountCents,
      currency: 'usd',
      destinationAccountId: expected.destinationAccountId,
      reversed: true,
      amountReversedCents: expected.transferAmountCents,
      escrowId: expected.escrowId,
      taskId: expected.taskId,
      payoutRecipientUserId: expected.payoutRecipientUserId,
      ...overrides,
    },
  };
}

describe('exact full transfer reversal evidence', () => {
  it.each([
    ['wrong transfer metadata', { taskId: 'task_wrong' }],
    ['wrong destination', { destinationAccountId: 'acct_wrong' }],
    ['wrong amount', { amountCents: 8_299 }],
    ['partial reversal', { reversed: false, amountReversedCents: 4_150 }],
    ['wrong recipient', { payoutRecipientUserId: 'worker_wrong' }],
  ])('rejects %s before poster refund', (_name, witnessOverride) => {
    expect(() => requireExactFullTransferReversal(
      binding(),
      exactEvidence(binding(), witnessOverride),
    )).toThrow(/not exactly and fully reversed/);
  });

  it('accepts resource_already_exists only through an exact current full-reversal readback', () => {
    const current = binding();
    expect(requireExactFullTransferReversal(
      current,
      exactEvidence(current, {}, { reversalId: null, reversalAmountCents: null }),
    )).toMatchObject({ transferId: TRANSFER_ID, reversed: true, amountReversedCents: 8_300 });
  });

  it('rejects a partial new reversal even when the retrieved transfer is fully reversed', () => {
    const current = binding();
    expect(() => requireExactFullTransferReversal(
      current,
      exactEvidence(current, {}, { reversalId: 'trr_partial', reversalAmountCents: 4_150 }),
    )).toThrow(/not exactly and fully reversed/);
  });

  it('accepts one exact immutable conflict readback and rejects a stale conflicting event', async () => {
    const current = binding();
    let expectedMetadata: Record<string, unknown> = {};
    const exactConflictQuery = vi.fn(async (sql: string, params: unknown[]) => {
      if (/INSERT INTO escrow_events/.test(sql)) {
        expectedMetadata = JSON.parse(String(params[1])) as Record<string, unknown>;
        return { rows: [], rowCount: 0 };
      }
      return { rows: [{ metadata: expectedMetadata }], rowCount: 1 };
    });
    await expect(persistExactFullTransferReversalWitness(
      exactConflictQuery,
      current,
    )).resolves.toBeUndefined();

    const conflictingQuery = vi.fn(async (sql: string, params: unknown[]) => {
      if (/INSERT INTO escrow_events/.test(sql)) {
        expectedMetadata = JSON.parse(String(params[1])) as Record<string, unknown>;
        return { rows: [], rowCount: 0 };
      }
      return {
        rows: [{ metadata: { ...expectedMetadata, destination_account_id: 'acct_stale' } }],
        rowCount: 1,
      };
    });
    await expect(persistExactFullTransferReversalWitness(
      conflictingQuery,
      current,
    )).rejects.toThrow(/witness conflicts/);
  });
});

describe('refund callers require fresh exact reversal proof', () => {
  let storedWitness: Record<string, unknown> | null;
  let insertConflicts: boolean;

  beforeEach(() => {
    vi.clearAllMocks();
    storedWitness = null;
    insertConflicts = false;
    payoutDestination.mockResolvedValue({
      ready: true,
      stripeConnectId: DESTINATION_ID,
      reason: 'READY',
    });
    vi.mocked(prepareRefund).mockResolvedValue({
      success: true,
      data: {
        escrowId: ESCROW_ID,
        workerId: WORKER_ID,
        stateBefore: 'RELEASED',
        stripePaymentIntentId: PAYMENT_INTENT_ID,
        stripeRefundId: null,
        stripeTransferId: TRANSFER_ID,
        amount: 10_000,
        allowedStates: ['FUNDED', 'LOCKED_DISPUTE', 'RELEASED'],
      },
    });
    vi.mocked(terminalizeRefund).mockResolvedValue({
      success: true,
      data: { id: ESCROW_ID, state: 'REFUNDED' },
    } as never);
    vi.mocked(StripeService.createTransferReversal).mockResolvedValue({
      success: true,
      data: exactEvidence(binding({ canonicalState: 'RELEASED' }), {}, {
        reversalId: null,
        reversalAmountCents: null,
      }),
    });
    vi.mocked(StripeService.createRefund).mockResolvedValue({
      success: true,
      data: {
        refundId: 're_exact', amount: 10_000, status: 'succeeded', currency: 'usd',
        paymentIntentId: PAYMENT_INTENT_ID, chargeId: 'ch_exact',
      },
    });

    dbQuery.mockImplementation(async (sqlValue: unknown, params: unknown[] = []) => {
      const sql = String(sqlValue);
      if (/SELECT stripe_refund_id FROM escrows/.test(sql)) {
        return { rows: [{ stripe_refund_id: null }], rowCount: 1 };
      }
      if (/SELECT id,\s*task_id,\s*state,\s*version,\s*amount/.test(sql)) {
        return {
          rows: [{
            id: ESCROW_ID,
            task_id: TASK_ID,
            state: 'LOCKED_DISPUTE',
            version: 7,
            amount: 10_000,
            platform_fee_cents: null,
            stripe_payment_intent_id: PAYMENT_INTENT_ID,
            stripe_transfer_id: null,
            stripe_refund_id: null,
          }],
          rowCount: 1,
        };
      }
      if (/SELECT id, task_id, amount, platform_fee_cents, state/.test(sql)) {
        return {
          rows: [{
            id: ESCROW_ID,
            task_id: TASK_ID,
            amount: 10_000,
            platform_fee_cents: null,
            state: 'RELEASED',
            stripe_payment_intent_id: PAYMENT_INTENT_ID,
            stripe_refund_id: null,
            stripe_transfer_id: TRANSFER_ID,
          }],
          rowCount: 1,
        };
      }
      if (/FROM disputes WHERE id/.test(sql)) {
        return {
          rows: [{
            id: DISPUTE_ID,
            task_id: TASK_ID,
            escrow_id: ESCROW_ID,
            state: 'RESOLVED',
            outcome_escrow_action: 'REFUND',
          }],
          rowCount: 1,
        };
      }
      if (/dispute_locked_after_release/.test(sql)) {
        return {
          rows: [{ metadata: {
            event_type: 'dispute_locked_after_release',
            original_transfer_id: TRANSFER_ID,
          } }],
          rowCount: 1,
        };
      }
      if (/SELECT worker_id, payout_recipient_user_id, price/.test(sql)) {
        return {
          rows: [{ worker_id: WORKER_ID, payout_recipient_user_id: null, price: 10_000 }],
          rowCount: 1,
        };
      }
      if (/FROM escrows e\s+LEFT JOIN tasks t/.test(sql)) {
        return {
          rows: [{
            id: ESCROW_ID,
            task_id: TASK_ID,
            state: 'LOCKED_DISPUTE',
            version: 7,
            amount: 10_000,
            platform_fee_cents: null,
            stripe_payment_intent_id: PAYMENT_INTENT_ID,
            stripe_refund_id: null,
            stripe_transfer_id: null,
            provider_transfer_status: 'manual_reconciliation',
            worker_id: WORKER_ID,
            payout_recipient_user_id: null,
            task_price: 10_000,
          }],
          rowCount: 1,
        };
      }
      if (/INSERT INTO escrow_events/.test(sql) && /VALUES \(\$1,\$2,\$2,NULL,'system',\$3::jsonb,\$4\)/.test(sql)) {
        return { rows: [{ id: 'evt_action_refund_claim' }], rowCount: 1 };
      }
      if (/INSERT INTO escrow_events/.test(sql) && /idempotency_key/.test(sql)) {
        const proposed = JSON.parse(String(params[1])) as Record<string, unknown>;
        if (!storedWitness) storedWitness = proposed;
        return insertConflicts
          ? { rows: [], rowCount: 0 }
          : { rows: [{ metadata: proposed }], rowCount: 1 };
      }
      if (/SELECT metadata FROM escrow_events/.test(sql) && /idempotency_key/.test(sql)) {
        return storedWitness
          ? { rows: [{ metadata: storedWitness }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (/SELECT id, version, stripe_refund_id/.test(sql)) {
        return { rows: [{ id: ESCROW_ID, version: 7, stripe_refund_id: null }], rowCount: 1 };
      }
      if (/UPDATE escrows/.test(sql)) {
        return { rows: [{ id: ESCROW_ID }], rowCount: 1 };
      }
      throw new Error(`Unexpected reversal test query: ${sql}`);
    });
  });

  it('does not let a stale legacy reversal event bypass fresh provider readback in the worker', async () => {
    vi.mocked(StripeService.createTransferReversal).mockResolvedValue({
      success: true,
      data: exactEvidence(binding(), {}, { reversalId: null, reversalAmountCents: null }),
    });
    insertConflicts = true;
    storedWitness = {
      event_type: 'transfer_reversed',
      original_transfer_id: TRANSFER_ID,
      reversal_id: 'trr_stale',
    };

    await expect(handleRefundRequest({
      escrow: {
        id: ESCROW_ID,
        state: 'LOCKED_DISPUTE',
        version: 7,
        amount: 10_000,
        platform_fee_cents: null,
        stripe_payment_intent_id: PAYMENT_INTENT_ID,
        stripe_transfer_id: null,
        stripe_refund_id: null,
      },
      taskId: TASK_ID,
      disputeId: DISPUTE_ID,
      reason: 'resolved poster refund',
    })).rejects.toThrow(/witness conflicts/);

    expect(StripeService.createTransferReversal).toHaveBeenCalledOnce();
    expect(StripeService.createRefund).not.toHaveBeenCalled();
  });

  it('rejects an administrative refund before DB or provider effects even with prior reversal evidence', async () => {
    const result = await refundEscrow({ escrowId: ESCROW_ID, adminOverride: true });

    expect(result).toMatchObject({ success: false, error: { code: 'INVALID_STATE' } });
    expect(dbTransaction).not.toHaveBeenCalled();
    expect(prepareRefund).not.toHaveBeenCalled();
    expect(terminalizeRefund).not.toHaveBeenCalled();
    expect(StripeService.createTransferReversal).not.toHaveBeenCalled();
    expect(StripeService.createRefund).not.toHaveBeenCalled();
  });

  it.each([
    ['pending status', { status: 'pending' }],
    ['failed status', { status: 'failed' }],
    ['wrong amount', { amount: 9_999 }],
    ['wrong currency', { currency: 'eur' }],
    ['wrong payment intent', { paymentIntentId: 'pi_other' }],
    ['missing charge binding', { chargeId: null }],
  ])('rejects administrative override before inspecting a hypothetical refund with %s', async (_label, patch) => {
    vi.mocked(StripeService.createRefund).mockResolvedValueOnce({
      success: true,
      data: {
        refundId: 're_unsettled', amount: 10_000, status: 'succeeded', currency: 'usd',
        paymentIntentId: PAYMENT_INTENT_ID, chargeId: 'ch_exact',
        ...patch,
      },
    });

    const result = await refundEscrow({ escrowId: ESCROW_ID, adminOverride: true });

    expect(result).toMatchObject({
      success: false,
      error: { code: 'INVALID_STATE' },
    });
    expect(dbTransaction).not.toHaveBeenCalled();
    expect(prepareRefund).not.toHaveBeenCalled();
    expect(terminalizeRefund).not.toHaveBeenCalled();
    expect(StripeService.createTransferReversal).not.toHaveBeenCalled();
    expect(StripeService.createRefund).not.toHaveBeenCalled();
  });

  it('rejects administrative override without consulting unavailable reversal evidence', async () => {
    vi.mocked(StripeService.createTransferReversal).mockResolvedValue({
      success: false,
      error: { code: 'STRIPE_TRANSFER_REVERSAL_EVIDENCE_UNAVAILABLE', message: 'timeout' },
    });

    const result = await refundEscrow({ escrowId: ESCROW_ID, adminOverride: true });

    expect(result).toMatchObject({ success: false, error: { code: 'INVALID_STATE' } });
    expect(dbTransaction).not.toHaveBeenCalled();
    expect(prepareRefund).not.toHaveBeenCalled();
    expect(StripeService.createTransferReversal).not.toHaveBeenCalled();
    expect(StripeService.createRefund).not.toHaveBeenCalled();
  });
});
