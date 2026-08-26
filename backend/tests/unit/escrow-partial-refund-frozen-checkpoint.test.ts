import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enableControlledStripePaymentTestCohortV7,
  HOSTILE_PAYMENT_CREATION_ENVIRONMENTS_V7,
  stubPaymentCreationEnvironmentV7,
} from '../helpers/payment-underwriting-v7';

const mockQuery = vi.hoisted(() => vi.fn());
const mockTransaction = vi.hoisted(() => vi.fn());
const payoutDestination = vi.hoisted(() => vi.fn());
const runEffects = vi.hoisted(() => vi.fn());

vi.mock('../../src/db.js', () => ({
  db: { query: mockQuery, transaction: mockTransaction },
}));

vi.mock('../../src/config.js', () => ({
  config: { stripe: { platformFeePercent: 15 } },
}));

vi.mock('../../src/logger.js', () => ({
  escrowLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../src/services/StripeService.js', () => ({
  StripeService: {
    createRefund: vi.fn(),
    createTransfer: vi.fn(),
    readTransferWitness: vi.fn(),
  },
}));

vi.mock('../../src/services/TaskPayoutDestinationService.js', () => ({
  loadCurrentTaskPayoutDestination: payoutDestination,
}));

vi.mock('../../src/services/EscrowPartialRefundReconciliationService.js', () => ({
  reconcilePartialRefundPostTerminal: runEffects,
}));

import { partialRefundEscrow } from '../../src/services/EscrowPartialRefundService.js';
import { terminalizePartialRefund } from '../../src/services/EscrowPartialRefundTransaction.js';
import {
  partialRefundCheckpointMetadata,
  partialRefundClaimIdempotencyKey,
  partialRefundClaimMetadata,
  partialRefundCheckpointIdempotencyKey,
  partialRefundTransferClaimMetadata,
  partialRefundTransferClaimIdempotencyKey,
  partialRefundTransferCheckpointIdempotencyKey,
  partialRefundTransferCheckpointMetadata,
  partialRefundTerminalTransitionIdempotencyKey,
  PARTIAL_REFUND_PROVIDER_REPLAY_WINDOW_MS,
} from '../../src/services/EscrowPartialRefundEvidence.js';
import type {
  PartialRefundBinding,
  PartialRefundProcessorWitness,
} from '../../src/services/EscrowPartialRefundEvidence.js';
import { StripeService } from '../../src/services/StripeService.js';

const ESCROW_ID = '00000000-0000-0000-0000-000000000275';
const TASK_ID = '10000000-0000-0000-0000-000000000275';
const PAYMENT_INTENT_ID = 'pi_partial_frozen_275';
const REFUND_ID = 're_partial_frozen_275';
const TRANSFER_ID = 'tr_partial_frozen_275';
const WORKER_ID = 'worker-275';
const POSTER_ID = 'poster-275';
const DESTINATION_ID = 'acct_partial_275';

function escrowRow(input: {
  version?: number;
  state?: string;
  transferId?: string | null;
  refundId?: string | null;
} = {}) {
  return {
    version: input.version ?? 7,
    state: input.state ?? 'LOCKED_DISPUTE',
    task_id: TASK_ID,
    amount: 5_000,
    platform_fee_cents: null,
    stripe_payment_intent_id: PAYMENT_INTENT_ID,
    stripe_transfer_id: input.transferId ?? null,
    stripe_refund_id: input.refundId ?? null,
    refund_amount: null,
    release_amount: null,
  };
}

const taskRow = {
  worker_id: WORKER_ID,
  payout_recipient_user_id: WORKER_ID,
  provider_organization_id: null,
  provider_assignment_id: null,
  poster_id: POSTER_ID,
};

function binding(input: {
  workerPercent?: number;
  transferId?: string | null;
  refundId?: string | null;
} = {}): PartialRefundBinding {
  const workerPercent = input.workerPercent ?? 60;
  const releaseAmount = Math.round(5_000 * workerPercent / 100);
  const refundAmount = 5_000 - releaseAmount;
  const fee = Math.round(releaseAmount * 0.15);
  const insurance = Math.round(releaseAmount * 0.02);
  return {
    escrowId: ESCROW_ID,
    escrowVersion: 7,
    taskId: TASK_ID,
    disputeId: null,
    escrowAmountCents: 5_000,
    canonicalPlatformFeeCents: null,
    paymentIntentId: PAYMENT_INTENT_ID,
    existingTransferId: input.transferId ?? null,
    existingRefundId: input.refundId ?? null,
    refundAmountCents: refundAmount,
    releaseAmountCents: releaseAmount,
    splitPlatformFeeCents: fee,
    platformFeeBasisPoints: 1_500,
    insuranceContributionCents: insurance,
    netReleaseAmountCents: releaseAmount - fee - insurance,
    xpClawbackFraction: refundAmount / 5_000,
    workerId: WORKER_ID,
    payoutRecipientUserId: WORKER_ID,
    providerOrganizationId: null,
    providerAssignmentId: null,
    posterId: POSTER_ID,
    destinationAccountId: DESTINATION_ID,
    payoutDestinationError: null,
  };
}

function refundWitness(
  targetBinding: PartialRefundBinding,
  overrides: Partial<PartialRefundProcessorWitness> = {},
): PartialRefundProcessorWitness {
  return {
    refundId: REFUND_ID,
    amount: targetBinding.refundAmountCents,
    status: 'succeeded',
    currency: 'usd',
    paymentIntentId: PAYMENT_INTENT_ID,
    chargeId: 'ch_partial_frozen_275',
    ...overrides,
  };
}

let canonicalEscrow = escrowRow();
let storedClaim: Record<string, unknown> | null = null;
let storedCheckpoint: Record<string, unknown> | null = null;
let storedTransferClaim: Record<string, unknown> | null = null;
let storedTransferCheckpoint: Record<string, unknown> | null = null;
let storedTransferRecovery: Record<string, unknown> | null = null;
let storedTerminalTransition: Record<string, unknown> | null = null;
let exactEscrowReadCount = 0;
let mutateBeforeT2 = false;
let terminalUpdateCount = 0;
let failRefundCheckpointWriteOnce = false;
let failTransferCheckpointWriteOnce = false;
let refundClaimCreatedAt = new Date();
let transferClaimCreatedAt = new Date();

function installDatabaseModel(): void {
  mockTransaction.mockImplementation(
    async (callback: (query: typeof mockQuery) => Promise<unknown>) => {
      const snapshot = {
        canonicalEscrow: { ...canonicalEscrow },
        storedClaim,
        storedCheckpoint,
        storedTransferClaim,
        storedTransferCheckpoint,
        storedTransferRecovery,
        storedTerminalTransition,
        terminalUpdateCount,
      };
      try {
        return await callback(mockQuery);
      } catch (error) {
        canonicalEscrow = snapshot.canonicalEscrow;
        storedClaim = snapshot.storedClaim;
        storedCheckpoint = snapshot.storedCheckpoint;
        storedTransferClaim = snapshot.storedTransferClaim;
        storedTransferCheckpoint = snapshot.storedTransferCheckpoint;
        storedTransferRecovery = snapshot.storedTransferRecovery;
        storedTerminalTransition = snapshot.storedTerminalTransition;
        terminalUpdateCount = snapshot.terminalUpdateCount;
        throw error;
      }
    },
  );
  mockQuery.mockImplementation(async (statement: string, params: unknown[] = []) => {
    const sql = String(statement);
    if (sql.includes('SELECT version, state, task_id')) {
      return { rows: [canonicalEscrow], rowCount: 1 };
    }
    if (sql.includes('SELECT version,state,task_id')) {
      exactEscrowReadCount += 1;
      if (mutateBeforeT2 && exactEscrowReadCount > 2) {
        return { rows: [{ ...canonicalEscrow, version: canonicalEscrow.version + 1 }], rowCount: 1 };
      }
      return { rows: [canonicalEscrow], rowCount: 1 };
    }
    if (sql.includes('SELECT id,version,state,task_id')) {
      return { rows: [{ id: ESCROW_ID, ...canonicalEscrow }], rowCount: 1 };
    }
    if (sql.includes('SELECT t.worker_id')) {
      return { rows: [taskRow], rowCount: 1 };
    }
    if (sql.includes('SELECT worker_id,payout_recipient_user_id')) {
      return { rows: [taskRow], rowCount: 1 };
    }
    if (sql.includes('SELECT idempotency_key,metadata')) {
      const rows = [
        [partialRefundClaimIdempotencyKey(ESCROW_ID), storedClaim],
        [partialRefundCheckpointIdempotencyKey(ESCROW_ID), storedCheckpoint],
        [partialRefundTransferClaimIdempotencyKey(ESCROW_ID), storedTransferClaim],
        [partialRefundTransferCheckpointIdempotencyKey(ESCROW_ID), storedTransferCheckpoint],
      ].filter((entry) => entry[1] !== null).map(([idempotency_key, metadata]) => ({
        idempotency_key,
        metadata,
      }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('INSERT INTO escrow_events')) {
      const metadata = JSON.parse(String(params[1])) as Record<string, unknown>;
      if (metadata.event_type === 'partial_refund_provider_claim_v2') {
        if (storedClaim) return { rows: [], rowCount: 0 };
        storedClaim = metadata;
        return { rows: [{ metadata, created_at: refundClaimCreatedAt }], rowCount: 1 };
      }
      if (metadata.event_type === 'partial_refund_transfer_claim_v1') {
        if (storedTransferClaim) return { rows: [], rowCount: 0 };
        storedTransferClaim = metadata;
        return { rows: [{ metadata, created_at: transferClaimCreatedAt }], rowCount: 1 };
      }
      if (metadata.event_type === 'partial_refund_provider_checkpoint_v3') {
        if (failRefundCheckpointWriteOnce) {
          failRefundCheckpointWriteOnce = false;
          throw new Error('simulated crash after refund success before checkpoint commit');
        }
        if (storedCheckpoint) return { rows: [], rowCount: 0 };
        storedCheckpoint = metadata;
        return { rows: [{ metadata }], rowCount: 1 };
      }
      if (metadata.event_type === 'partial_refund_transfer_checkpoint_v1') {
        if (failTransferCheckpointWriteOnce) {
          failTransferCheckpointWriteOnce = false;
          throw new Error('simulated crash after transfer success before checkpoint commit');
        }
        if (storedTransferCheckpoint) return { rows: [], rowCount: 0 };
        storedTransferCheckpoint = metadata;
        return { rows: [{ metadata }], rowCount: 1 };
      }
      if (metadata.event_type === 'partial_refund_transfer_recovery_v1') {
        if (storedTransferRecovery) return { rows: [], rowCount: 0 };
        storedTransferRecovery = metadata;
        return { rows: [{ metadata }], rowCount: 1 };
      }
      if (metadata.event_type === 'partial_refund_terminal_transition_v1') {
        if (storedTerminalTransition) return { rows: [], rowCount: 0 };
        storedTerminalTransition = metadata;
        return { rows: [{ metadata }], rowCount: 1 };
      }
    }
    if (sql.includes('SELECT metadata,created_at FROM escrow_events')) {
      if (params[1] === partialRefundClaimIdempotencyKey(ESCROW_ID)) {
        return storedClaim
          ? { rows: [{ metadata: storedClaim, created_at: refundClaimCreatedAt }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (String(params[1]).includes('transfer-claim')) {
        return storedTransferClaim
          ? { rows: [{ metadata: storedTransferClaim, created_at: transferClaimCreatedAt }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
    }
    if (sql.includes('SELECT metadata FROM escrow_events')) {
      if (params[1] === partialRefundClaimIdempotencyKey(ESCROW_ID)) {
        return storedClaim
          ? { rows: [{ metadata: storedClaim }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (params[1] === partialRefundCheckpointIdempotencyKey(ESCROW_ID)) {
        return storedCheckpoint
          ? { rows: [{ metadata: storedCheckpoint }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (String(params[1]).includes('transfer-checkpoint')) {
        return storedTransferCheckpoint
          ? { rows: [{ metadata: storedTransferCheckpoint }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (String(params[1]).includes('transfer-recovery')) {
        return storedTransferRecovery
          ? { rows: [{ metadata: storedTransferRecovery }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (
        params[1] === partialRefundTerminalTransitionIdempotencyKey(
          ESCROW_ID,
          binding().escrowVersion + 1,
        )
      ) {
        return storedTerminalTransition
          ? { rows: [{ metadata: storedTerminalTransition }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
    }
    if (sql.includes("SET state='REFUND_PARTIAL'")) {
      terminalUpdateCount += 1;
      canonicalEscrow = {
        ...canonicalEscrow,
        state: 'REFUND_PARTIAL',
        version: canonicalEscrow.version + 1,
        stripe_transfer_id: TRANSFER_ID,
        stripe_refund_id: REFUND_ID,
        refund_amount: 2_000,
        release_amount: 3_000,
      };
      return {
        rows: [{
          id: ESCROW_ID,
          task_id: TASK_ID,
          state: 'REFUND_PARTIAL',
          version: canonicalEscrow.version,
          amount: 5_000,
          created_at: new Date(),
          updated_at: new Date(),
        }],
        rowCount: 1,
      };
    }
    throw new Error(`Unexpected partial-refund query: ${sql}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  runEffects.mockReset().mockResolvedValue(null);
  enableControlledStripePaymentTestCohortV7();
  canonicalEscrow = escrowRow();
  storedClaim = null;
  storedCheckpoint = null;
  storedTransferClaim = null;
  storedTransferCheckpoint = null;
  storedTransferRecovery = null;
  storedTerminalTransition = null;
  exactEscrowReadCount = 0;
  mutateBeforeT2 = false;
  terminalUpdateCount = 0;
  failRefundCheckpointWriteOnce = false;
  failTransferCheckpointWriteOnce = false;
  refundClaimCreatedAt = new Date();
  transferClaimCreatedAt = new Date();
  payoutDestination.mockResolvedValue({
    ready: true,
    stripeConnectId: DESTINATION_ID,
    reason: 'READY',
  });
  installDatabaseModel();
  const target = binding();
  vi.mocked(StripeService.createRefund).mockResolvedValue({
    success: true,
    data: refundWitness(target),
  });
  vi.mocked(StripeService.createTransfer).mockResolvedValue({
    success: true,
    data: { transferId: TRANSFER_ID, amount: target.netReleaseAmountCents },
  });
  vi.mocked(StripeService.readTransferWitness).mockResolvedValue({
    success: true,
    data: {
      provider: 'STRIPE',
      transferId: TRANSFER_ID,
      amountCents: target.netReleaseAmountCents,
      currency: 'usd',
      destinationAccountId: DESTINATION_ID,
      reversed: false,
      amountReversedCents: 0,
      escrowId: ESCROW_ID,
      taskId: TASK_ID,
      payoutRecipientUserId: WORKER_ID,
    },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('EscrowService.partialRefund — exact provider claim and evidence', () => {
  it.each(HOSTILE_PAYMENT_CREATION_ENVIRONMENTS_V7)(
    'blocks both provider legs before claim or checkpoint creation in $name',
    async ({ env }) => {
      stubPaymentCreationEnvironmentV7(env);
      const result = await partialRefundEscrow({
        escrowId: ESCROW_ID,
        workerPercent: 60,
        posterPercent: 40,
      });

      expect(result).toMatchObject({
        success: false,
        error: { code: 'PAYMENT_CREATION_FROZEN' },
      });
      expect(StripeService.createRefund).not.toHaveBeenCalled();
      expect(StripeService.createTransfer).not.toHaveBeenCalled();
      expect(terminalUpdateCount).toBe(0);
      expect(storedClaim).toBeNull();
      expect(storedCheckpoint).toBeNull();
      expect(mockQuery.mock.calls.some(([, params]) =>
        params?.[2] === partialRefundClaimIdempotencyKey(ESCROW_ID))).toBe(false);
    },
  );

  it('reuses one exact checkpoint without a second processor refund', async () => {
    const target = binding();
    storedClaim = partialRefundClaimMetadata(target);
    storedCheckpoint = partialRefundCheckpointMetadata(target, refundWitness(target));

    const result = await partialRefundEscrow({
      escrowId: ESCROW_ID,
      workerPercent: 60,
      posterPercent: 40,
    });

    expect(result).toMatchObject({ success: true });
    expect(StripeService.createRefund).not.toHaveBeenCalled();
    expect(StripeService.createTransfer).toHaveBeenCalledOnce();
  });

  it('replays the same deterministic refund after a crash before checkpoint commit', async () => {
    failRefundCheckpointWriteOnce = true;

    const first = await partialRefundEscrow({
      escrowId: ESCROW_ID,
      workerPercent: 60,
      posterPercent: 40,
    });
    expect(first).toMatchObject({
      success: false,
      error: { code: 'PARTIAL_REFUND_RECONCILIATION_REQUIRED' },
    });
    expect(storedClaim).toEqual(partialRefundClaimMetadata(binding()));
    expect(storedCheckpoint).toBeNull();
    expect(StripeService.createTransfer).not.toHaveBeenCalled();

    const replay = await partialRefundEscrow({
      escrowId: ESCROW_ID,
      workerPercent: 60,
      posterPercent: 40,
    });

    expect(replay).toMatchObject({ success: true });
    expect(StripeService.createRefund).toHaveBeenCalledTimes(2);
    expect(vi.mocked(StripeService.createRefund).mock.calls[0][0]).toMatchObject({
      paymentIntentId: PAYMENT_INTENT_ID,
      escrowId: ESCROW_ID,
      amount: 2_000,
      idempotencyKeySuffix: 'partial_refund',
    });
    expect(vi.mocked(StripeService.createRefund).mock.calls[1][0])
      .toEqual(vi.mocked(StripeService.createRefund).mock.calls[0][0]);
    expect(storedCheckpoint).toMatchObject({
      stripe_refund_id: REFUND_ID,
      stripe_refund_status: 'succeeded',
    });
    expect(StripeService.createTransfer).toHaveBeenCalledOnce();
    expect(terminalUpdateCount).toBe(1);
  });

  it('fails closed instead of replaying a refund claim after the provider window expires', async () => {
    storedClaim = partialRefundClaimMetadata(binding());
    refundClaimCreatedAt = new Date(
      Date.now() - PARTIAL_REFUND_PROVIDER_REPLAY_WINDOW_MS - 1,
    );

    const result = await partialRefundEscrow({
      escrowId: ESCROW_ID,
      workerPercent: 60,
      posterPercent: 40,
    });

    expect(result).toMatchObject({
      success: false,
      error: { code: 'PARTIAL_REFUND_RECONCILIATION_REQUIRED' },
    });
    expect(StripeService.createRefund).not.toHaveBeenCalled();
    expect(StripeService.createTransfer).not.toHaveBeenCalled();
    expect(terminalUpdateCount).toBe(0);
  });

  it('replays the exact transfer after a crash before its checkpoint, without duplicating T2', async () => {
    failTransferCheckpointWriteOnce = true;

    const first = await partialRefundEscrow({
      escrowId: ESCROW_ID,
      workerPercent: 60,
      posterPercent: 40,
    });
    expect(first).toMatchObject({
      success: false,
      error: { code: 'PARTIAL_REFUND_RECONCILIATION_REQUIRED' },
    });
    expect(storedTransferClaim).toEqual(partialRefundTransferClaimMetadata(binding()));
    expect(storedTransferCheckpoint).toBeNull();
    expect(terminalUpdateCount).toBe(0);

    const replay = await partialRefundEscrow({
      escrowId: ESCROW_ID,
      workerPercent: 60,
      posterPercent: 40,
    });

    expect(replay).toMatchObject({ success: true });
    expect(StripeService.createRefund).toHaveBeenCalledOnce();
    expect(StripeService.createTransfer).toHaveBeenCalledTimes(2);
    expect(vi.mocked(StripeService.createTransfer).mock.calls[0][0]).toMatchObject({
      escrowId: ESCROW_ID,
      amount: binding().netReleaseAmountCents,
      idempotencyKeySuffix: 'partial_refund_transfer',
    });
    expect(vi.mocked(StripeService.createTransfer).mock.calls[1][0])
      .toEqual(vi.mocked(StripeService.createTransfer).mock.calls[0][0]);
    expect(storedTransferCheckpoint).toMatchObject({ stripe_transfer_id: TRANSFER_ID });
    expect(terminalUpdateCount).toBe(1);
  });

  it('fails closed instead of replaying a transfer claim after the provider window expires', async () => {
    const target = binding();
    storedClaim = partialRefundClaimMetadata(target);
    storedCheckpoint = partialRefundCheckpointMetadata(target, refundWitness(target));
    storedTransferClaim = partialRefundTransferClaimMetadata(target);
    transferClaimCreatedAt = new Date(
      Date.now() - PARTIAL_REFUND_PROVIDER_REPLAY_WINDOW_MS - 1,
    );

    const result = await partialRefundEscrow({
      escrowId: ESCROW_ID,
      workerPercent: 60,
      posterPercent: 40,
    });

    expect(result).toMatchObject({
      success: false,
      error: { code: 'PARTIAL_REFUND_RECONCILIATION_REQUIRED' },
    });
    expect(StripeService.createRefund).not.toHaveBeenCalled();
    expect(StripeService.createTransfer).not.toHaveBeenCalled();
    expect(terminalUpdateCount).toBe(0);
  });

  it('rejects a conflicting checkpoint before any processor call', async () => {
    const target = binding();
    storedClaim = partialRefundClaimMetadata(target);
    storedCheckpoint = {
      ...partialRefundCheckpointMetadata(target, refundWitness(target)),
      poster_refund_amount_cents: target.refundAmountCents - 1,
    };

    const result = await partialRefundEscrow({
      escrowId: ESCROW_ID,
      workerPercent: 60,
      posterPercent: 40,
    });

    expect(result).toMatchObject({
      success: false,
      error: { code: 'PARTIAL_REFUND_RECONCILIATION_REQUIRED' },
    });
    expect(StripeService.createRefund).not.toHaveBeenCalled();
    expect(StripeService.createTransfer).not.toHaveBeenCalled();
  });

  it('rejects arbitrary caller provider IDs at the direct T2 boundary', async () => {
    const target = binding();
    const currentTransfer = {
      provider: 'STRIPE' as const,
      transferId: TRANSFER_ID,
      amountCents: target.netReleaseAmountCents,
      currency: 'usd',
      destinationAccountId: DESTINATION_ID,
      reversed: false,
      amountReversedCents: 0,
      escrowId: ESCROW_ID,
      taskId: TASK_ID,
      payoutRecipientUserId: WORKER_ID,
    };
    storedClaim = partialRefundClaimMetadata(target);
    storedCheckpoint = partialRefundCheckpointMetadata(target, refundWitness(target));
    storedTransferClaim = partialRefundTransferClaimMetadata(target);
    storedTransferCheckpoint = partialRefundTransferCheckpointMetadata({
      binding: target,
      witness: currentTransfer,
      transferCreated: true,
    });

    await expect(terminalizePartialRefund(mockQuery, target, {
      refundId: 're_attacker_supplied',
      transferId: TRANSFER_ID,
      transferWitness: currentTransfer,
      transferCreated: true,
    })).rejects.toMatchObject({ code: 'PARTIAL_REFUND_RECONCILIATION_REQUIRED' });

    expect(terminalUpdateCount).toBe(0);
    expect(storedTerminalTransition).toBeNull();
  });

  it('rolls back T2 when an orphaned conflicting terminal transition event exists', async () => {
    storedTerminalTransition = {
      event_type: 'partial_refund_terminal_transition_v1',
      escrow_id: ESCROW_ID,
      stripe_refund_id: 're_conflicting',
    };

    const result = await partialRefundEscrow({
      escrowId: ESCROW_ID,
      workerPercent: 60,
      posterPercent: 40,
    });

    expect(result).toMatchObject({
      success: false,
      error: { code: 'PARTIAL_REFUND_RECONCILIATION_REQUIRED' },
    });
    expect(terminalUpdateCount).toBe(0);
    expect(canonicalEscrow.state).toBe('LOCKED_DISPUTE');
    expect(storedTerminalTransition).toMatchObject({ stripe_refund_id: 're_conflicting' });
  });

  it('serializes divergent splits before Stripe so only the claim winner refunds', async () => {
    let announceRefundStarted!: () => void;
    const refundStarted = new Promise<void>((resolve) => { announceRefundStarted = resolve; });
    let releaseRefund!: () => void;
    const refundBarrier = new Promise<void>((resolve) => { releaseRefund = resolve; });
    vi.mocked(StripeService.createRefund).mockImplementationOnce(async () => {
      announceRefundStarted();
      await refundBarrier;
      const target = binding();
      return { success: true, data: refundWitness(target) };
    });

    const winner = partialRefundEscrow({
      escrowId: ESCROW_ID,
      workerPercent: 60,
      posterPercent: 40,
    });
    await refundStarted;
    const loser = await partialRefundEscrow({
      escrowId: ESCROW_ID,
      workerPercent: 70,
      posterPercent: 30,
    });

    expect(loser).toMatchObject({
      success: false,
      error: { code: 'PARTIAL_REFUND_RECONCILIATION_REQUIRED' },
    });
    expect(StripeService.createRefund).toHaveBeenCalledOnce();
    releaseRefund();
    await expect(winner).resolves.toMatchObject({ success: true });
  });

  it('rejects an inexact refund response without checkpointing or terminalizing', async () => {
    const target = binding();
    vi.mocked(StripeService.createRefund).mockResolvedValueOnce({
      success: true,
      data: refundWitness(target, { currency: 'eur' }),
    });

    const result = await partialRefundEscrow({
      escrowId: ESCROW_ID,
      workerPercent: 60,
      posterPercent: 40,
    });

    expect(result).toMatchObject({
      success: false,
      error: { code: 'PARTIAL_REFUND_RECONCILIATION_REQUIRED' },
    });
    expect(storedCheckpoint).toBeNull();
    expect(StripeService.createTransfer).not.toHaveBeenCalled();
    expect(terminalUpdateCount).toBe(0);
  });

  it('rejects a canonical transfer whose fresh provider witness is stale', async () => {
    const target = binding({ transferId: TRANSFER_ID, refundId: REFUND_ID });
    canonicalEscrow = escrowRow({ transferId: TRANSFER_ID, refundId: REFUND_ID });
    storedClaim = partialRefundClaimMetadata(target);
    storedCheckpoint = partialRefundCheckpointMetadata(target, refundWitness(target));
    vi.mocked(StripeService.readTransferWitness).mockResolvedValueOnce({
      success: true,
      data: {
        provider: 'STRIPE',
        transferId: TRANSFER_ID,
        amountCents: target.netReleaseAmountCents + 1,
        currency: 'usd',
        destinationAccountId: DESTINATION_ID,
        reversed: false,
        amountReversedCents: 0,
        escrowId: ESCROW_ID,
        taskId: TASK_ID,
        payoutRecipientUserId: WORKER_ID,
      },
    });

    const result = await partialRefundEscrow({
      escrowId: ESCROW_ID,
      workerPercent: 60,
      posterPercent: 40,
    });

    expect(result).toMatchObject({
      success: false,
      error: { code: 'PARTIAL_REFUND_RECONCILIATION_REQUIRED' },
    });
    expect(StripeService.createRefund).not.toHaveBeenCalled();
    expect(StripeService.createTransfer).not.toHaveBeenCalled();
    expect(terminalUpdateCount).toBe(0);
  });

  it('accepts a canonical transfer only after a fresh exact witness', async () => {
    const target = binding({ transferId: TRANSFER_ID, refundId: REFUND_ID });
    canonicalEscrow = escrowRow({ transferId: TRANSFER_ID, refundId: REFUND_ID });
    storedClaim = partialRefundClaimMetadata(target);
    storedCheckpoint = partialRefundCheckpointMetadata(target, refundWitness(target));
    vi.mocked(StripeService.readTransferWitness).mockResolvedValueOnce({
      success: true,
      data: {
        provider: 'STRIPE',
        transferId: TRANSFER_ID,
        amountCents: target.netReleaseAmountCents,
        currency: 'usd',
        destinationAccountId: DESTINATION_ID,
        reversed: false,
        amountReversedCents: 0,
        escrowId: ESCROW_ID,
        taskId: TASK_ID,
        payoutRecipientUserId: WORKER_ID,
      },
    });

    const result = await partialRefundEscrow({
      escrowId: ESCROW_ID,
      workerPercent: 60,
      posterPercent: 40,
    });

    expect(result).toMatchObject({ success: true, data: { state: 'REFUND_PARTIAL' } });
    expect(StripeService.readTransferWitness).toHaveBeenCalledWith(TRANSFER_ID);
    expect(storedTransferCheckpoint).toMatchObject({
      event_type: 'partial_refund_transfer_checkpoint_v1',
      stripe_transfer_id: TRANSFER_ID,
      transfer_created_in_attempt: false,
    });
    expect(terminalUpdateCount).toBe(1);
  });

  it('classifies a Phase-1/T2 version change as reconciliation, never success', async () => {
    mutateBeforeT2 = true;

    const result = await partialRefundEscrow({
      escrowId: ESCROW_ID,
      workerPercent: 60,
      posterPercent: 40,
    });

    expect(result).toMatchObject({
      success: false,
      error: { code: 'PARTIAL_REFUND_RECONCILIATION_REQUIRED' },
    });
    expect(StripeService.createRefund).toHaveBeenCalledOnce();
    expect(StripeService.createTransfer).toHaveBeenCalledOnce();
    expect(StripeService.readTransferWitness).toHaveBeenCalledOnce();
    expect(terminalUpdateCount).toBe(0);
    expect(runEffects).toHaveBeenCalledOnce();
    expect(storedTransferCheckpoint).toMatchObject({
      event_type: 'partial_refund_transfer_checkpoint_v1',
      transfer_created_in_attempt: true,
    });
    expect(storedTransferRecovery).toMatchObject({
      event_type: 'partial_refund_transfer_recovery_v1',
      failure_stage: 'CANONICAL_T2_FAILED',
      reconciliation_required: true,
    });
  });

  it('refuses success when exact post-terminal reconciliation fails', async () => {
    runEffects
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('revenue ledger unavailable'));

    const result = await partialRefundEscrow({
      escrowId: ESCROW_ID,
      workerPercent: 60,
      posterPercent: 40,
    });

    expect(result).toMatchObject({
      success: false,
      error: { code: 'PARTIAL_REFUND_RECONCILIATION_REQUIRED' },
    });
    expect(terminalUpdateCount).toBe(1);
    expect(storedTransferCheckpoint).toMatchObject({
      event_type: 'partial_refund_transfer_checkpoint_v1',
      transfer_created_in_attempt: true,
    });
    expect(runEffects).toHaveBeenCalledTimes(2);
  });
});
