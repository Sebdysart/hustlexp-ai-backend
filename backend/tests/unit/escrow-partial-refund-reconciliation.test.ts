import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.hoisted(() => vi.fn());
const mockTransaction = vi.hoisted(() => vi.fn());
const recordContribution = vi.hoisted(() => vi.fn());
const advanceProgress = vi.hoisted(() => vi.fn());
const logRevenue = vi.hoisted(() => vi.fn());
const clawbackXP = vi.hoisted(() => vi.fn());
const createRefund = vi.hoisted(() => vi.fn());
const createTransfer = vi.hoisted(() => vi.fn());
const readTransferWitness = vi.hoisted(() => vi.fn());

vi.mock('../../src/db.js', () => ({
  db: { query: mockQuery, transaction: mockTransaction },
}));

vi.mock('../../src/logger.js', () => {
  const base = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: () => base,
  };
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

vi.mock('../../src/services/StripeService.js', () => ({
  StripeService: { createRefund, createTransfer, readTransferWitness },
}));

vi.mock('../../src/services/SelfInsurancePoolService.js', () => ({
  SelfInsurancePoolService: { recordContribution },
}));

vi.mock('../../src/services/TaskService.js', () => ({
  TaskService: { advanceProgress },
}));

vi.mock('../../src/services/RevenueService.js', () => ({
  RevenueService: { logEvent: logRevenue },
}));

vi.mock('../../src/services/XPService.js', () => ({
  XPService: { clawbackXP },
}));

vi.mock('../../src/services/TaskPayoutDestinationService.js', () => ({
  loadCurrentTaskPayoutDestination: vi.fn(),
}));

import {
  partialRefundCheckpointIdempotencyKey,
  partialRefundCheckpointMetadata,
  partialRefundClaimIdempotencyKey,
  partialRefundClaimMetadata,
  partialRefundTransferCheckpointIdempotencyKey,
  partialRefundTransferCheckpointMetadata,
  partialRefundTerminalTransitionIdempotencyKey,
  partialRefundTerminalTransitionMetadata,
} from '../../src/services/EscrowPartialRefundEvidence.js';
import type {
  PartialRefundBinding,
  PartialRefundProcessorWitness,
} from '../../src/services/EscrowPartialRefundEvidence.js';
import {
  reconcileDuePartialRefundEffects,
  reconcilePartialRefundPostTerminal,
} from '../../src/services/EscrowPartialRefundReconciliationService.js';
import type { StripeTransferWitness } from '../../src/services/EscrowReleaseTypes.js';

const ESCROW_ID = '00000000-0000-0000-0000-000000000401';
const TASK_ID = '10000000-0000-0000-0000-000000000401';
const DISPUTE_ID = '20000000-0000-0000-0000-000000000401';
const WORKER_ID = '30000000-0000-0000-0000-000000000401';
const POSTER_ID = '40000000-0000-0000-0000-000000000401';
const REFUND_ID = 're_partial_401';
const TRANSFER_ID = 'tr_partial_401';

const binding: PartialRefundBinding = {
  escrowId: ESCROW_ID,
  escrowVersion: 7,
  taskId: TASK_ID,
  disputeId: DISPUTE_ID,
  escrowAmountCents: 10_000,
  canonicalPlatformFeeCents: null,
  paymentIntentId: 'pi_partial_401',
  existingTransferId: null,
  existingRefundId: null,
  refundAmountCents: 4_000,
  releaseAmountCents: 6_000,
  splitPlatformFeeCents: 900,
  platformFeeBasisPoints: 1_500,
  insuranceContributionCents: 120,
  netReleaseAmountCents: 4_980,
  xpClawbackFraction: 0.4,
  workerId: WORKER_ID,
  payoutRecipientUserId: WORKER_ID,
  providerOrganizationId: null,
  providerAssignmentId: null,
  posterId: POSTER_ID,
  destinationAccountId: 'acct_partial_401',
  payoutDestinationError: null,
};

const refundWitness: PartialRefundProcessorWitness = {
  refundId: REFUND_ID,
  amount: 4_000,
  status: 'succeeded',
  currency: 'usd',
  paymentIntentId: binding.paymentIntentId,
  chargeId: 'ch_partial_401',
};

const transferWitness: StripeTransferWitness = {
  provider: 'STRIPE',
  transferId: TRANSFER_ID,
  amountCents: 4_980,
  currency: 'usd',
  destinationAccountId: binding.destinationAccountId!,
  reversed: false,
  amountReversedCents: 0,
  escrowId: ESCROW_ID,
  taskId: TASK_ID,
  payoutRecipientUserId: WORKER_ID,
};

const terminalEscrow = {
  id: ESCROW_ID,
  version: 8,
  state: 'REFUND_PARTIAL',
  task_id: TASK_ID,
  amount: 10_000,
  platform_fee_cents: null,
  stripe_payment_intent_id: binding.paymentIntentId,
  stripe_transfer_id: TRANSFER_ID,
  stripe_refund_id: REFUND_ID,
  refund_amount: 4_000,
  release_amount: 6_000,
};

const taskBinding = {
  worker_id: WORKER_ID,
  payout_recipient_user_id: WORKER_ID,
  provider_organization_id: null,
  provider_assignment_id: null,
  poster_id: POSTER_ID,
};

type EffectName = 'INSURANCE' | 'TASK_CLOSED' | 'REVENUE' | 'XP_CLAWBACK';

let insuranceRow: null | {
  id: string;
  contribution_cents: number;
  contribution_percentage: number;
};
let taskProgress: string;
let revenueRows: Array<Record<string, unknown>>;
let xpRows: Array<{
  id: string;
  task_id: string;
  base_xp: number;
  effective_xp: number;
  reason: string;
}>;
let effectCheckpoints: Map<string, Record<string, unknown>>;
let recoveryEvents: Array<Record<string, unknown>>;
let providerExceptions: Array<Record<string, unknown>>;
let providerFailureSignals: Array<{ stripe_event_id: string; type: string }>;
let dueCandidates: Array<{ id: string; outbox_key: string | null }>;
let failCheckpointFor: EffectName | null;
let checkpointFailureInjected: boolean;

function cloneRows<T>(rows: T[]): T[] {
  return rows.map((row) => ({ ...row }));
}

function installTransactionModel(): void {
  mockTransaction.mockImplementation(async (callback: (query: typeof mockQuery) => Promise<unknown>) => {
    const snapshot = {
      insuranceRow: insuranceRow ? { ...insuranceRow } : null,
      taskProgress,
      revenueRows: cloneRows(revenueRows),
      xpRows: cloneRows(xpRows),
      effectCheckpoints: new Map(effectCheckpoints),
      recoveryEvents: cloneRows(recoveryEvents),
    };
    try {
      return await callback(mockQuery);
    } catch (error) {
      insuranceRow = snapshot.insuranceRow;
      taskProgress = snapshot.taskProgress;
      revenueRows = snapshot.revenueRows;
      xpRows = snapshot.xpRows;
      effectCheckpoints = snapshot.effectCheckpoints;
      recoveryEvents = snapshot.recoveryEvents;
      throw error;
    }
  });
}

function installDatabaseModel(): void {
  mockQuery.mockImplementation(async (statement: string, params: unknown[] = []) => {
    const sql = String(statement);
    if (sql.includes('FROM escrows e') && sql.includes('LEFT JOIN outbox_events')) {
      return { rows: dueCandidates, rowCount: dueCandidates.length };
    }
    if (sql === 'SELECT state,provider_transfer_status FROM escrows WHERE id=$1') {
      return {
        rows: [{ state: terminalEscrow.state, provider_transfer_status: null }],
        rowCount: 1,
      };
    }
    if (sql.includes('WITH attempted AS (') && sql.includes('INSERT INTO escrow_events')) {
      const metadata = JSON.parse(String(params[1])) as Record<string, unknown>;
      const key = String(params[2]);
      const effect = metadata.effect as EffectName;
      if (
        failCheckpointFor === effect
        && !checkpointFailureInjected
      ) {
        checkpointFailureInjected = true;
        throw new Error(`simulated crash before ${effect} checkpoint commit`);
      }
      const existing = effectCheckpoints.get(key);
      if (existing && JSON.stringify(existing) !== JSON.stringify(metadata)) {
        return { rows: [], rowCount: 0 };
      }
      effectCheckpoints.set(key, metadata);
      return { rows: [{ metadata }], rowCount: 1 };
    }
    if (sql.includes('SELECT metadata FROM escrow_events')) {
      const key = String(params[1]);
      if (key === partialRefundClaimIdempotencyKey(ESCROW_ID)) {
        return { rows: [{ metadata: partialRefundClaimMetadata(binding) }], rowCount: 1 };
      }
      if (key === partialRefundCheckpointIdempotencyKey(ESCROW_ID)) {
        return {
          rows: [{ metadata: partialRefundCheckpointMetadata(binding, refundWitness) }],
          rowCount: 1,
        };
      }
      if (key === partialRefundTransferCheckpointIdempotencyKey(ESCROW_ID)) {
        return {
          rows: [{
            metadata: partialRefundTransferCheckpointMetadata({
              binding,
              witness: transferWitness,
              transferCreated: true,
            }),
          }],
          rowCount: 1,
        };
      }
      if (key === partialRefundTerminalTransitionIdempotencyKey(ESCROW_ID, 8)) {
        return {
          rows: [{
            metadata: partialRefundTerminalTransitionMetadata({
              binding,
              provider: {
                refundWitness,
                transferWitness,
                transferCreated: true,
              },
            }),
          }],
          rowCount: 1,
        };
      }
      const metadata = effectCheckpoints.get(key);
      return metadata
        ? { rows: [{ metadata }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes('SELECT id,version,state,task_id')) {
      return { rows: [terminalEscrow], rowCount: 1 };
    }
    if (sql.includes('SELECT worker_id,payout_recipient_user_id')) {
      return { rows: [taskBinding], rowCount: 1 };
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
      };
    }
    if (sql.includes('FROM insurance_contributions')) {
      return insuranceRow
        ? { rows: [insuranceRow], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes('SELECT progress_state FROM tasks')) {
      return { rows: [{ progress_state: taskProgress }], rowCount: 1 };
    }
    if (sql.includes('FROM revenue_ledger')) {
      return { rows: revenueRows, rowCount: revenueRows.length };
    }
    if (sql.includes('FROM xp_ledger')) {
      return { rows: xpRows, rowCount: xpRows.length };
    }
    if (sql.includes("type IN ('transfer.failed','transfer.reversed')")) {
      return { rows: providerFailureSignals, rowCount: providerFailureSignals.length };
    }
    if (sql.includes('INSERT INTO escrow_events')) {
      const metadata = JSON.parse(String(params[1])) as Record<string, unknown>;
      if (metadata.event_type === 'partial_refund_transfer_recovery_v1') {
        recoveryEvents.push(metadata);
        return { rows: [{ metadata }], rowCount: 1 };
      }
      if (metadata.event_type === 'partial_refund_provider_exception_v1') {
        providerExceptions.push(metadata);
        return { rows: [{ metadata }], rowCount: 1 };
      }
    }
    throw new Error(`Unexpected reconciliation query: ${sql}`);
  });
}

function installEffectImplementations(): void {
  recordContribution.mockImplementation(async () => {
    insuranceRow = {
      id: 'insurance-401',
      contribution_cents: binding.insuranceContributionCents,
      contribution_percentage: 2,
    };
    return { success: true, data: undefined };
  });
  advanceProgress.mockImplementation(async () => {
    taskProgress = 'CLOSED';
    return { success: true, data: {} };
  });
  logRevenue.mockImplementation(async (params: Record<string, unknown>) => {
    revenueRows.push({
      id: 'revenue-401',
      event_type: params.eventType,
      user_id: params.userId,
      task_id: params.taskId,
      amount_cents: params.amountCents,
      currency: 'usd',
      gross_amount_cents: params.grossAmountCents,
      platform_fee_cents: params.platformFeeCents,
      net_amount_cents: params.netAmountCents,
      fee_basis_points: params.feeBasisPoints,
      escrow_id: params.escrowId,
      stripe_transfer_id: params.stripeTransferId,
      metadata: params.metadata,
    });
    return { success: true, data: { id: 'revenue-401' } };
  });
  clawbackXP.mockImplementation(async (
    _userId: string,
    _escrowId: string,
    reason: string,
    fraction: number,
  ) => {
    xpRows.push({
      id: 'xp-clawback-401',
      task_id: TASK_ID,
      base_xp: -Math.round(1_000 * fraction),
      effective_xp: -Math.round(800 * fraction),
      reason,
    });
  });
}

const expected = {
  escrowId: ESCROW_ID,
  taskId: TASK_ID,
  disputeId: DISPUTE_ID,
  refundAmountCents: 4_000,
  releaseAmountCents: 6_000,
};

beforeEach(() => {
  vi.resetAllMocks();
  insuranceRow = null;
  taskProgress = 'COMPLETED';
  revenueRows = [];
  xpRows = [{
    id: 'xp-award-401',
    task_id: TASK_ID,
    base_xp: 1_000,
    effective_xp: 800,
    reason: 'task_completed',
  }];
  effectCheckpoints = new Map();
  recoveryEvents = [];
  providerExceptions = [];
  providerFailureSignals = [];
  dueCandidates = [];
  failCheckpointFor = null;
  checkpointFailureInjected = false;
  installTransactionModel();
  installDatabaseModel();
  installEffectImplementations();
  readTransferWitness.mockResolvedValue({ success: true, data: transferWitness });
});

describe('EscrowPartialRefundReconciliationService — exact crash/replay convergence', () => {
  it('applies every effect once, checkpoints exact readback, and replays without provider calls', async () => {
    await reconcilePartialRefundPostTerminal(expected);
    await reconcilePartialRefundPostTerminal(expected);

    expect(recordContribution).toHaveBeenCalledOnce();
    expect(advanceProgress).toHaveBeenCalledOnce();
    expect(logRevenue).toHaveBeenCalledOnce();
    expect(clawbackXP).toHaveBeenCalledOnce();
    expect(effectCheckpoints.size).toBe(4);
    expect(revenueRows).toHaveLength(1);
    expect(xpRows.filter((row) => row.reason === 'dispute_lost')).toHaveLength(1);
    expect(createRefund).not.toHaveBeenCalled();
    expect(createTransfer).not.toHaveBeenCalled();
    expect(readTransferWitness).toHaveBeenCalledTimes(2);
  });

  it.each<EffectName>([
    'INSURANCE',
    'TASK_CLOSED',
    'REVENUE',
    'XP_CLAWBACK',
  ])('recovers a crash after %s application without duplicating committed state', async (effect) => {
    failCheckpointFor = effect;

    await expect(reconcilePartialRefundPostTerminal(expected))
      .rejects.toThrow(`simulated crash before ${effect} checkpoint commit`);
    expect(recoveryEvents).toContainEqual(expect.objectContaining({
      event_type: 'partial_refund_transfer_recovery_v1',
      failure_stage: 'POST_TERMINAL_EFFECT_FAILED',
    }));

    failCheckpointFor = null;
    await reconcilePartialRefundPostTerminal(expected);
    await reconcilePartialRefundPostTerminal(expected);

    expect(effectCheckpoints.size).toBe(4);
    expect(insuranceRow).toMatchObject({ contribution_cents: 120 });
    expect(taskProgress).toBe('CLOSED');
    expect(revenueRows).toHaveLength(1);
    expect(xpRows.filter((row) => row.reason === 'dispute_lost')).toHaveLength(1);
    expect(recordContribution).toHaveBeenCalledOnce();
    expect(advanceProgress).toHaveBeenCalledOnce();
    expect(logRevenue).toHaveBeenCalledTimes(effect === 'REVENUE' ? 2 : 1);
    expect(clawbackXP).toHaveBeenCalledOnce();
  });

  it.each([
    'insurance',
    'task',
    'revenue',
    'xp',
  ] as const)('retries and converges after an explicit %s failure', async (effect) => {
    if (effect === 'insurance') {
      recordContribution.mockResolvedValueOnce({
        success: false,
        error: { code: 'POOL_FAILED', message: 'pool unavailable' },
      });
    } else if (effect === 'task') {
      advanceProgress.mockResolvedValueOnce({
        success: false,
        error: { code: 'TASK_FAILED', message: 'task unavailable' },
      });
    } else if (effect === 'revenue') {
      logRevenue.mockResolvedValueOnce({
        success: false,
        error: { code: 'LEDGER_FAILED', message: 'ledger unavailable' },
      });
    } else {
      clawbackXP.mockRejectedValueOnce(new Error('xp unavailable'));
    }

    await expect(reconcilePartialRefundPostTerminal(expected)).rejects.toBeTruthy();
    await reconcilePartialRefundPostTerminal(expected);

    expect(effectCheckpoints.size).toBe(4);
    expect(revenueRows).toHaveLength(1);
    expect(xpRows.filter((row) => row.reason === 'dispute_lost')).toHaveLength(1);
    expect(createRefund).not.toHaveBeenCalled();
    expect(createTransfer).not.toHaveBeenCalled();
  });

  it('rejects a replay whose settlement amounts do not match immutable evidence', async () => {
    await expect(reconcilePartialRefundPostTerminal({
      ...expected,
      refundAmountCents: 3_999,
      releaseAmountCents: 6_001,
    })).rejects.toMatchObject({ code: 'PARTIAL_REFUND_RECONCILIATION_REQUIRED' });
    expect(recordContribution).not.toHaveBeenCalled();
    expect(effectCheckpoints.size).toBe(0);
  });

  it('fails before economic effects when the current transfer is reversed', async () => {
    readTransferWitness.mockResolvedValueOnce({
      success: true,
      data: {
        ...transferWitness,
        reversed: true,
        amountReversedCents: transferWitness.amountCents,
      },
    });

    await expect(reconcilePartialRefundPostTerminal(expected))
      .rejects.toMatchObject({ code: 'PARTIAL_REFUND_RECONCILIATION_REQUIRED' });
    expect(recordContribution).not.toHaveBeenCalled();
    expect(advanceProgress).not.toHaveBeenCalled();
    expect(logRevenue).not.toHaveBeenCalled();
    expect(clawbackXP).not.toHaveBeenCalled();
    expect(effectCheckpoints.size).toBe(0);
    expect(providerExceptions).toContainEqual(expect.objectContaining({
      failure_stage: 'TERMINAL_TRANSFER_INVALID',
      reason_code: 'current_transfer_witness_mismatch',
    }));
  });

  it('fails before economic effects when current transfer evidence is unavailable', async () => {
    readTransferWitness.mockResolvedValueOnce({
      success: false,
      error: { code: 'STRIPE_UNAVAILABLE', message: 'provider read timed out' },
    });

    await expect(reconcilePartialRefundPostTerminal(expected))
      .rejects.toMatchObject({ code: 'PARTIAL_REFUND_RECONCILIATION_REQUIRED' });
    expect(recordContribution).not.toHaveBeenCalled();
    expect(effectCheckpoints.size).toBe(0);
  });

  it('quarantines a durable transfer.failed signal before economic effects', async () => {
    providerFailureSignals = [{
      stripe_event_id: 'evt_transfer_failed_401',
      type: 'transfer.failed',
    }];

    await expect(reconcilePartialRefundPostTerminal(expected))
      .rejects.toMatchObject({ code: 'PARTIAL_REFUND_RECONCILIATION_REQUIRED' });
    expect(recordContribution).not.toHaveBeenCalled();
    expect(effectCheckpoints.size).toBe(0);
    expect(providerExceptions).toContainEqual(expect.objectContaining({
      event_type: 'partial_refund_provider_exception_v1',
      failure_stage: 'TERMINAL_TRANSFER_INVALID',
      reason_code: 'transfer.failed:evt_transfer_failed_401',
    }));
  });

  it('permanently sweeps a terminal split after finite queue retries are exhausted', async () => {
    const outboxKey = `escrow.partial_refund_requested:${ESCROW_ID}:1`;
    dueCandidates = [{ id: ESCROW_ID, outbox_key: outboxKey }];

    const result = await reconcileDuePartialRefundEffects(500);

    expect(result).toEqual({
      reconciled: [{ escrowId: ESCROW_ID, outboxKey }],
      failed: [],
    });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("WHERE e.state='REFUND_PARTIAL'"),
      ['partial_refund_effect_checkpoint_v1', 100],
    );
    expect(effectCheckpoints.size).toBe(4);
    expect(createRefund).not.toHaveBeenCalled();
    expect(createTransfer).not.toHaveBeenCalled();
  });

  it('keeps a failed permanent-sweep candidate unacknowledged for the next run', async () => {
    dueCandidates = [{ id: ESCROW_ID, outbox_key: `escrow.partial_refund_requested:${ESCROW_ID}:1` }];
    recordContribution.mockResolvedValueOnce({
      success: false,
      error: { code: 'POOL_FAILED', message: 'pool unavailable' },
    });

    const result = await reconcileDuePartialRefundEffects(50);

    expect(result.reconciled).toEqual([]);
    expect(result.failed).toEqual([{
      escrowId: ESCROW_ID,
      error: expect.stringContaining('pool unavailable'),
    }]);
    expect(effectCheckpoints.size).toBe(0);
  });
});
