/**
 * completion-release-worker.test.ts
 *
 * TDD (red-first) for the happy-path payout orchestration:
 * task COMPLETED → create Stripe transfer → EscrowService.release (which owns
 * fee/insurance/XP side effects).
 *
 * Invariants under test:
 *  - INV-3/INV-7: release triggered at most once (transfer-id idempotency,
 *    version-checked T2, no Stripe call on replay).
 *  - INV-5: transfer amount = computeFeeBreakdown(...).netPayoutCents (unified module).
 *  - Disputed/non-FUNDED escrows are NEVER auto-released by this path.
 *  - Offline-payment tasks NEVER produce a Stripe transfer.
 *  - HMAC + schema validation identical in strength to dispute jobs.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Job } from 'bullmq';
import {
  enableControlledStripePaymentTestCohortV7,
  HOSTILE_PAYMENT_CREATION_ENVIRONMENTS_V7,
  stubPaymentCreationEnvironmentV7,
} from '../helpers/payment-underwriting-v7';

const payoutDestination = vi.hoisted(() => vi.fn());
const acknowledgeOutbox = vi.hoisted(() => vi.fn());

vi.mock('../../src/db', () => {
  const queryFn = vi.fn();
  const transactionFn = vi.fn(async (fn: (q: typeof queryFn) => Promise<unknown>) => fn(queryFn));
  return { db: { query: queryFn, transaction: transactionFn } };
});

vi.mock('../../src/services/StripeService.js', () => ({
  StripeService: {
    createTransfer: vi.fn(), readTransferWitness: vi.fn(), createTransferReversal: vi.fn(),
  },
}));

vi.mock('../../src/services/EscrowService.js', () => ({
  EscrowService: { release: vi.fn() },
}));

vi.mock('../../src/services/TaskPayoutDestinationService.js', () => ({
  loadCurrentTaskPayoutDestination: payoutDestination,
}));

vi.mock('../../src/jobs/outbox-worker.js', () => ({
  markOutboxEventProcessed: acknowledgeOutbox,
}));

vi.mock('../../src/logger', () => {
  const base = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: () => base };
  return {
    logger: base, escrowLogger: base, taskLogger: base, aiLogger: base,
    stripeLogger: base, authLogger: base, workerLogger: base, dbLogger: base,
  };
});

vi.mock('../../src/config.js', () => ({
  config: {
    stripe: { platformFeePercent: 15 },
    queue: { hmacSecret: 'test-hmac-secret-for-unit-tests' },
  },
}));

vi.mock('../../src/services/AdminNotificationHelper.js', () => ({
  notifyAdmins: vi.fn(),
}));

vi.mock('../../src/lib/task-lifecycle-notifications.js', () => ({
  notifyPaymentReleased: vi.fn().mockResolvedValue(undefined),
}));

import { db } from '../../src/db';
import { StripeService } from '../../src/services/StripeService.js';
import { EscrowService } from '../../src/services/EscrowService.js';
import { notifyAdmins } from '../../src/services/AdminNotificationHelper.js';
import { notifyPaymentReleased } from '../../src/lib/task-lifecycle-notifications.js';
import { outboxTransportJobId } from '../../src/jobs/OutboxIdentity.js';
import { signJobPayload } from '../../src/jobs/queues.js';
import { computeFeeBreakdown } from '../../src/lib/money.js';
import { processCompletionReleaseJob } from '../../src/jobs/completion-release-worker.js';
import { ErrorCodes } from '../../src/types.js';

const dbQuery = db.query as unknown as ReturnType<typeof vi.fn>;
const dbTransaction = db.transaction as unknown as ReturnType<typeof vi.fn>;
const createTransfer = StripeService.createTransfer as unknown as ReturnType<typeof vi.fn>;
const readTransferWitness = StripeService.readTransferWitness as unknown as ReturnType<typeof vi.fn>;
const createTransferReversal = StripeService.createTransferReversal as unknown as ReturnType<typeof vi.fn>;
const escrowRelease = EscrowService.release as unknown as ReturnType<typeof vi.fn>;

const ESCROW_ID = '00000000-0000-0000-0000-0000000000aa';
const TASK_ID = '10000000-0000-0000-0000-0000000000aa';
const WORKER_ID = '20000000-0000-0000-0000-0000000000aa';
const PAYOUT_RECIPIENT_ID = '25000000-0000-0000-0000-0000000000aa';
const POSTER_ID = '30000000-0000-0000-0000-0000000000aa';
const CONNECT_ID = 'acct_completion_test';
const AMOUNT = 10000; // $100.00 in cents
const VERSION = 3;
const OUTBOX_KEY = `completion-release:${TASK_ID}`;

function makeJob(
  payload: object,
  id: string = outboxTransportJobId(OUTBOX_KEY),
): Job<{ payload: object }> {
  return {
    id,
    name: 'escrow.completion_release_requested',
    data: { payload },
  } as unknown as Job<{ payload: object }>;
}
function signed(fields: Record<string, unknown>): Record<string, unknown> {
  return { ...fields, _sig: signJobPayload(fields) };
}
function basePayload(): Record<string, unknown> {
  return {
    escrow_id: ESCROW_ID,
    task_id: TASK_ID,
    reason: 'task_completed',
    _outbox_key: OUTBOX_KEY,
  };
}
function escrowRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: ESCROW_ID, task_id: TASK_ID, state: 'FUNDED', version: VERSION,
    amount: AMOUNT, platform_fee_cents: null, stripe_transfer_id: null, ...over,
  };
}
function taskRow(over: Partial<Record<string, unknown>> = {}) {
  return { state: 'COMPLETED', worker_id: WORKER_ID, payment_method: 'escrow', poster_id: POSTER_ID, ...over };
}
function recoveryMetadata(over: Record<string, unknown> = {}) {
  return {
    reason:'completion_transfer_persistence_conflict',task_id:TASK_ID,provider:'STRIPE',
    provider_transfer_id:'tr_race',provider_transfer_amount_cents:8300,
    provider_currency:'usd',provider_amount_reversed_cents:8300,
    provider_destination_account_id:CONNECT_ID,
    payout_recipient_user_id:WORKER_ID,expected_escrow_version:VERSION,
    persistence_error:`Version conflict in T2 for escrow ${ESCROW_ID} (expected ${VERSION}, got ${VERSION + 1}) — retry`,
    transfer_fully_reversed:true,reconciliation_required:false,...over,
  };
}
function recoveryEventRow(over: Record<string, unknown> = {}) {
  return {
    escrow_id:ESCROW_ID,from_state:'FUNDED',to_state:'FUNDED',actor_id:null,
    actor_type:'system',metadata:recoveryMetadata(),
    idempotency_key:`completion-release-transfer-recovery:${ESCROW_ID}:tr_race:fully-reversed`,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  enableControlledStripePaymentTestCohortV7();
  dbTransaction.mockImplementation(async (fn: (q: typeof dbQuery) => Promise<unknown>) => fn(dbQuery));
  dbQuery.mockResolvedValue({ rows: [{ exact: true }] });
  acknowledgeOutbox.mockResolvedValue({
    idempotency_key: OUTBOX_KEY,
    status: 'processed',
    attempts: 1,
  });
  escrowRelease.mockResolvedValue({ success: true, data: { id: ESCROW_ID, state: 'RELEASED' } });
  readTransferWitness.mockImplementation(async (transferId:string) => ({
    success:true,
    data:{
      provider:'STRIPE',transferId,amountCents:8300,currency:'usd',
      destinationAccountId:CONNECT_ID,reversed:false,amountReversedCents:0,
      escrowId:ESCROW_ID,taskId:TASK_ID,payoutRecipientUserId:WORKER_ID,
    },
  }));
  createTransferReversal.mockImplementation(async (transferId:string) => ({
    success:true,
    data:{
      reversalId:'trr_completion_recovery',reversalAmountCents:8300,
      transferWitness:{
        provider:'STRIPE',transferId,amountCents:8300,currency:'usd',
        destinationAccountId:CONNECT_ID,reversed:true,amountReversedCents:8300,
        escrowId:ESCROW_ID,taskId:TASK_ID,payoutRecipientUserId:WORKER_ID,
      },
    },
  }));
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

describe('processCompletionReleaseJob — D1 production disbursement freeze', () => {
  it.each(HOSTILE_PAYMENT_CREATION_ENVIRONMENTS_V7)(
    'rejects $name after read-only recovery classification and before transfer, release, or notification effects',
    async ({ env }) => {
      stubPaymentCreationEnvironmentV7(env);
      dbQuery
        .mockResolvedValueOnce({ rows: [escrowRow()] })
        .mockResolvedValueOnce({ rows: [taskRow()] });

      await expect(processCompletionReleaseJob(makeJob(signed(basePayload()))))
        .rejects.toMatchObject({ code: 'PAYMENT_CREATION_FROZEN' });

      expect(dbTransaction).toHaveBeenCalledTimes(1);
      expect(dbQuery).toHaveBeenCalledTimes(2);
      const recoveryStatements = dbQuery.mock.calls.map(([sql]) => String(sql).trimStart());
      expect(recoveryStatements).not.toEqual(expect.arrayContaining([
        expect.stringMatching(/^(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i),
      ]));
      expect(createTransfer).not.toHaveBeenCalled();
      expect(payoutDestination).not.toHaveBeenCalled();
      expect(escrowRelease).not.toHaveBeenCalled();
      expect(notifyPaymentReleased).not.toHaveBeenCalled();
    },
  );

  it('converges a durable pre-freeze transfer without creating another disbursement', async () => {
    vi.stubEnv('HX_PAYMENT_CREATION_MODE', 'frozen');
    readTransferWitness.mockResolvedValueOnce({
      success:true,
      data:{
        provider:'STRIPE',transferId:'tr_prior',amountCents:8300,currency:'usd',
        destinationAccountId:CONNECT_ID,reversed:false,amountReversedCents:0,
        escrowId:ESCROW_ID,taskId:TASK_ID,payoutRecipientUserId:WORKER_ID,
      },
    });
    dbQuery
      .mockResolvedValueOnce({ rows: [escrowRow({ stripe_transfer_id: 'tr_prior' })] })
      .mockResolvedValueOnce({ rows: [taskRow()] });

    await processCompletionReleaseJob(makeJob(signed(basePayload())));

    expect(createTransfer).not.toHaveBeenCalled();
    expect(readTransferWitness).toHaveBeenCalledWith('tr_prior');
    expect(payoutDestination).not.toHaveBeenCalled();
    expect(escrowRelease).toHaveBeenCalledWith({
      escrowId: ESCROW_ID,
      stripeTransferId: 'tr_prior',
      stripeTransferWitness: expect.objectContaining({
        provider:'STRIPE',transferId:'tr_prior',escrowId:ESCROW_ID,taskId:TASK_ID,
      }),
    });
    expect(notifyPaymentReleased).toHaveBeenCalledWith(WORKER_ID, TASK_ID, 8300);
  });
});

describe('processCompletionReleaseJob — happy path', () => {
  it('creates transfer for unified net amount and calls EscrowService.release with the transfer id', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [escrowRow()] })          // TX1: escrow FOR UPDATE
      .mockResolvedValueOnce({ rows: [taskRow()] })            // TX1: task
      .mockResolvedValueOnce({ rows: [{ stripe_connect_id: CONNECT_ID }] }) // worker connect
      .mockResolvedValueOnce({ rows: [escrowRow()] })          // TX2: FOR UPDATE NOWAIT re-read
      .mockResolvedValueOnce({ rows: [{ id: ESCROW_ID }], rowCount: 1 });  // TX2: UPDATE
    createTransfer.mockResolvedValue({ success: true, data: { transferId: 'tr_happy_1' } });

    await processCompletionReleaseJob(makeJob(signed(basePayload())));

    const expected = computeFeeBreakdown(AMOUNT, 15);
    expect(createTransfer).toHaveBeenCalledTimes(1);
    const arg = createTransfer.mock.calls[0][0];
    expect(arg.escrowId).toBe(ESCROW_ID);
    expect(arg.workerStripeAccountId).toBe(CONNECT_ID);
    expect(arg.amount).toBe(expected.netPayoutCents);
    expect(arg.amount).toBe(8300); // 10000 - 1500 fee - 200 insurance (gross basis)
    expect(arg.idempotencyKeySuffix).toBe('completion_release');

    expect(escrowRelease).toHaveBeenCalledTimes(1);
    expect(escrowRelease).toHaveBeenCalledWith(
      expect.objectContaining({ escrowId: ESCROW_ID, stripeTransferId: 'tr_happy_1' })
    );
    expect(acknowledgeOutbox).toHaveBeenCalledWith(OUTBOX_KEY);

    // Worker is told they got paid — with the SAME net amount that was transferred
    expect(notifyPaymentReleased).toHaveBeenCalledWith(WORKER_ID, TASK_ID, expected.netPayoutCents);
  });

  it('replay with stripe_transfer_id already set: NO Stripe call, release still invoked with existing id (crash-resume)', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [escrowRow({ stripe_transfer_id: 'tr_prior' })] })
      .mockResolvedValueOnce({ rows: [taskRow()] });

    await processCompletionReleaseJob(makeJob(signed(basePayload())));

    expect(createTransfer).not.toHaveBeenCalled();
    expect(escrowRelease).toHaveBeenCalledWith(
      expect.objectContaining({ escrowId: ESCROW_ID, stripeTransferId: 'tr_prior' })
    );
  });

  it('uses the canonical Price Book margin for a website quote', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [escrowRow({ platform_fee_cents: 2500 })] })
      .mockResolvedValueOnce({ rows: [taskRow()] })
      .mockResolvedValueOnce({ rows: [{ stripe_connect_id: CONNECT_ID }] })
      .mockResolvedValueOnce({ rows: [escrowRow({ platform_fee_cents: 2500 })] })
      .mockResolvedValueOnce({ rows: [{ id: ESCROW_ID }], rowCount: 1 });
    createTransfer.mockResolvedValue({ success: true, data: { transferId: 'tr_quote_economics' } });

    await processCompletionReleaseJob(makeJob(signed(basePayload())));

    expect(createTransfer).toHaveBeenCalledWith(expect.objectContaining({ amount: 7300 }));
    expect(notifyPaymentReleased).toHaveBeenCalledWith(WORKER_ID, TASK_ID, 7300);
  });

  it('routes Service Business funds and financial notice to the authorized provider recipient', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [escrowRow()] })
      .mockResolvedValueOnce({ rows: [taskRow({ payout_recipient_user_id: PAYOUT_RECIPIENT_ID })] })
      .mockResolvedValueOnce({ rows: [{ stripe_connect_id: CONNECT_ID }] })
      .mockResolvedValueOnce({ rows: [escrowRow()] })
      .mockResolvedValueOnce({ rows: [{ id: ESCROW_ID }], rowCount: 1 });
    createTransfer.mockResolvedValue({ success: true, data: { transferId: 'tr_business_recipient' } });

    await processCompletionReleaseJob(makeJob(signed(basePayload())));

    expect(dbQuery.mock.calls[2]?.[1]).toEqual([PAYOUT_RECIPIENT_ID]);
    expect(createTransfer).toHaveBeenCalledWith(expect.objectContaining({
      workerId: PAYOUT_RECIPIENT_ID,
      workerStripeAccountId: CONNECT_ID,
    }));
    const net = computeFeeBreakdown(AMOUNT, 15).netPayoutCents;
    expect(notifyPaymentReleased).toHaveBeenCalledWith(PAYOUT_RECIPIENT_ID, TASK_ID, net);
    expect(notifyPaymentReleased).not.toHaveBeenCalledWith(WORKER_ID, TASK_ID, net);
  });
});

describe('processCompletionReleaseJob — state guards (never release what is not FUNDED)', () => {
  it('missing escrow fails with the canonical corruption error before any money movement', async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    await expect(processCompletionReleaseJob(makeJob(signed(basePayload()))))
      .rejects.toThrow(`Escrow ${ESCROW_ID} not found for completion release`);
    expect(createTransfer).not.toHaveBeenCalled();
    expect(escrowRelease).not.toHaveBeenCalled();
  });

  it('rejects a task/escrow ownership mismatch before reading task or moving money', async () => {
    const otherTaskId = '10000000-0000-0000-0000-0000000000bb';
    dbQuery.mockResolvedValueOnce({ rows: [escrowRow({ task_id: otherTaskId })] });

    await expect(processCompletionReleaseJob(makeJob(signed(basePayload()))))
      .rejects.toThrow(`Completion release task ${TASK_ID} does not own escrow ${ESCROW_ID}`);

    expect(dbQuery).toHaveBeenCalledTimes(1);
    expect(createTransfer).not.toHaveBeenCalled();
    expect(readTransferWitness).not.toHaveBeenCalled();
    expect(escrowRelease).not.toHaveBeenCalled();
  });

  it.each(['RELEASED', 'REFUNDED', 'REFUND_PARTIAL'] as const)(
    'escrow already %s → idempotent no-op (no Stripe, no release)',
    async (state) => {
    dbQuery.mockResolvedValueOnce({ rows: [escrowRow({ state, stripe_transfer_id: 'tr_done' })] });
    await processCompletionReleaseJob(makeJob(signed(basePayload())));
    expect(createTransfer).not.toHaveBeenCalled();
    expect(escrowRelease).not.toHaveBeenCalled();
    expect(notifyAdmins).not.toHaveBeenCalled();
  });

  it('does not ACK bare LOCKED_DISPUTE without an immutable ownership-transfer event', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [escrowRow({ state: 'LOCKED_DISPUTE' })] })
      .mockResolvedValueOnce({ rows: [{ exact: false }] });
    await expect(processCompletionReleaseJob(makeJob(signed(basePayload()))))
      .rejects.toThrow('OUTBOX_TERMINAL_EVIDENCE_MISSING');
    expect(createTransfer).not.toHaveBeenCalled();
    expect(escrowRelease).not.toHaveBeenCalled();
    expect(notifyAdmins).not.toHaveBeenCalled();
    expect(acknowledgeOutbox).not.toHaveBeenCalled();
  });

  it('does not ACK a PENDING escrow merely because the orchestrator returned', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [escrowRow({ state: 'PENDING' })] })
      .mockResolvedValueOnce({ rows: [{ exact: false }] });
    await expect(processCompletionReleaseJob(makeJob(signed(basePayload()))))
      .rejects.toThrow('OUTBOX_TERMINAL_EVIDENCE_MISSING');
    expect(createTransfer).not.toHaveBeenCalled();
    expect(escrowRelease).not.toHaveBeenCalled();
    expect(notifyAdmins).toHaveBeenCalled();
    expect(acknowledgeOutbox).not.toHaveBeenCalled();
  });

  it('task not COMPLETED → throws (data corruption — retry/DLQ), no Stripe call', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [escrowRow()] })
      .mockResolvedValueOnce({ rows: [taskRow({ state: 'DISPUTED' })] });
    await expect(processCompletionReleaseJob(makeJob(signed(basePayload())))).rejects.toThrow(/COMPLETED/);
    expect(createTransfer).not.toHaveBeenCalled();
    expect(escrowRelease).not.toHaveBeenCalled();
  });

  it('missing task fails with the canonical corruption error before any Stripe call', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [escrowRow()] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(processCompletionReleaseJob(makeJob(signed(basePayload()))))
      .rejects.toThrow(`Task ${TASK_ID} not found for completion release`);
    expect(createTransfer).not.toHaveBeenCalled();
    expect(escrowRelease).not.toHaveBeenCalled();
  });
});

describe('processCompletionReleaseJob — payment method + payout-account guards', () => {
  it('does not ACK an offline-payment no-op without terminal escrow evidence', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [escrowRow()] })
      .mockResolvedValueOnce({ rows: [taskRow({ payment_method: 'offline_cash' })] })
      .mockResolvedValueOnce({ rows: [{ exact: false }] });
    await expect(processCompletionReleaseJob(makeJob(signed(basePayload()))))
      .rejects.toThrow('OUTBOX_TERMINAL_EVIDENCE_MISSING');
    expect(createTransfer).not.toHaveBeenCalled();
    expect(escrowRelease).not.toHaveBeenCalled();
    expect(acknowledgeOutbox).not.toHaveBeenCalled();
  });

  it('does not ACK a missing-payout-destination no-op without terminal evidence', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [escrowRow()] })
      .mockResolvedValueOnce({ rows: [taskRow()] })
      .mockResolvedValueOnce({ rows: [{ stripe_connect_id: null }] })
      .mockResolvedValueOnce({ rows: [{ exact: false }] });
    await expect(processCompletionReleaseJob(makeJob(signed(basePayload()))))
      .rejects.toThrow('OUTBOX_TERMINAL_EVIDENCE_MISSING');
    expect(createTransfer).not.toHaveBeenCalled();
    expect(escrowRelease).not.toHaveBeenCalled();
    expect(notifyAdmins).toHaveBeenCalled();
    expect(acknowledgeOutbox).not.toHaveBeenCalled();
  });
});

describe('processCompletionReleaseJob — concurrency + failure semantics', () => {
  it('TX2 version conflict fully reverses and checkpoints the unpersisted transfer', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [escrowRow()] })
      .mockResolvedValueOnce({ rows: [taskRow()] })
      .mockResolvedValueOnce({ rows: [{ stripe_connect_id: CONNECT_ID }] })
      .mockResolvedValueOnce({ rows: [escrowRow({ version: VERSION + 1 })] }) // TX2 re-read: version moved
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // immutable recovery event
      .mockResolvedValueOnce({ rows: [recoveryEventRow()], rowCount: 1 }); // exact readback
    createTransfer.mockResolvedValue({ success: true, data: { transferId: 'tr_race' } });
    await expect(processCompletionReleaseJob(makeJob(signed(basePayload()))))
      .rejects.toThrow(/reversed after persistence conflict/i);
    expect(createTransferReversal).toHaveBeenCalledWith(
      'tr_race',ESCROW_ID,`completion-release-v${VERSION}`,
    );
    const recoveryInsert = dbQuery.mock.calls.find(([sql]) =>
      /INSERT\s+INTO\s+escrow_events/i.test(String(sql)));
    expect(JSON.parse(String((recoveryInsert?.[1] as unknown[] | undefined)?.[2])))
      .toMatchObject({
        provider_transfer_id:'tr_race',transfer_fully_reversed:true,
        reconciliation_required:false,
      });
    expect((recoveryInsert?.[1] as unknown[] | undefined)?.[3]).toBe(
      `completion-release-transfer-recovery:${ESCROW_ID}:tr_race:fully-reversed`,
    );
    expect(dbQuery.mock.calls.some(([sql]) =>
      /SELECT[\s\S]*FROM\s+escrow_events[\s\S]*idempotency_key=\$1/i.test(String(sql))))
      .toBe(true);
    expect(escrowRelease).not.toHaveBeenCalled();
  });

  it('accepts an exact preexisting recovery event after a concurrent/replay collision', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [escrowRow()] })
      .mockResolvedValueOnce({ rows: [taskRow()] })
      .mockResolvedValueOnce({ rows: [{ stripe_connect_id: CONNECT_ID }] })
      .mockResolvedValueOnce({ rows: [escrowRow({ version: VERSION + 1 })] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [recoveryEventRow()], rowCount: 1 });
    createTransfer.mockResolvedValue({ success: true, data: { transferId: 'tr_race' } });
    createTransferReversal.mockResolvedValueOnce({
      success:true,
      data:{
        reversalId:null,reversalAmountCents:null,
        transferWitness:{
          provider:'STRIPE',transferId:'tr_race',amountCents:8300,currency:'usd',
          destinationAccountId:CONNECT_ID,reversed:true,amountReversedCents:8300,
          escrowId:ESCROW_ID,taskId:TASK_ID,payoutRecipientUserId:WORKER_ID,
        },
      },
    });

    await expect(processCompletionReleaseJob(makeJob(signed(basePayload()))))
      .rejects.toThrow(/reversed after persistence conflict/i);
    expect(notifyAdmins).toHaveBeenCalledWith(expect.objectContaining({
      metadata:expect.objectContaining({ transfer_id:'tr_race',transfer_fully_reversed:true }),
    }));
  });

  it.each([
    ['missing', []],
    ['conflicting', [recoveryEventRow({
      metadata:recoveryMetadata({ provider_transfer_amount_cents:8299 }),
    })]],
  ])('fails closed when the recovery event readback is %s', async (_name, eventRows) => {
    dbQuery
      .mockResolvedValueOnce({ rows: [escrowRow()] })
      .mockResolvedValueOnce({ rows: [taskRow()] })
      .mockResolvedValueOnce({ rows: [{ stripe_connect_id: CONNECT_ID }] })
      .mockResolvedValueOnce({ rows: [escrowRow({ version: VERSION + 1 })] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: eventRows, rowCount: eventRows.length });
    createTransfer.mockResolvedValue({ success: true, data: { transferId: 'tr_race' } });

    await expect(processCompletionReleaseJob(makeJob(signed(basePayload()))))
      .rejects.toThrow(/missing or conflicts with exact immutable facts/i);
    expect(notifyAdmins).not.toHaveBeenCalled();
    expect(escrowRelease).not.toHaveBeenCalled();
  });

  it('TX2 re-read shows concurrent transfer_id → skips UPDATE, releases with the EXISTING id (no double-spend)', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [escrowRow()] })
      .mockResolvedValueOnce({ rows: [taskRow()] })
      .mockResolvedValueOnce({ rows: [{ stripe_connect_id: CONNECT_ID }] })
      .mockResolvedValueOnce({ rows: [escrowRow({ stripe_transfer_id: 'tr_winner' })] }); // TX2: another worker won
    createTransfer.mockResolvedValue({ success: true, data: { transferId: 'tr_winner' } }); // Stripe idempotency returns same
    await processCompletionReleaseJob(makeJob(signed(basePayload())));
    expect(escrowRelease).toHaveBeenCalledWith(
      expect.objectContaining({ stripeTransferId: 'tr_winner' })
    );
  });

  it('EscrowService.release failure → throws (BullMQ retry); replay will skip Stripe via transfer-id idempotency', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [escrowRow()] })
      .mockResolvedValueOnce({ rows: [taskRow()] })
      .mockResolvedValueOnce({ rows: [{ stripe_connect_id: CONNECT_ID }] })
      .mockResolvedValueOnce({ rows: [escrowRow()] })
      .mockResolvedValueOnce({ rows: [{ id: ESCROW_ID }], rowCount: 1 });
    createTransfer.mockResolvedValue({ success: true, data: { transferId: 'tr_rel_fail' } });
    escrowRelease.mockResolvedValue({ success: false, error: { code: 'DB_ERROR', message: 'transient' } });
    await expect(processCompletionReleaseJob(makeJob(signed(basePayload())))).rejects.toThrow(/release/i);
  });

  it('release reports terminal RELEASED state on replay → treated as idempotent success (no throw)', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [escrowRow({ stripe_transfer_id: 'tr_prior' })] })
      .mockResolvedValueOnce({ rows: [taskRow()] })
      .mockResolvedValueOnce({ rows: [{
        state: 'RELEASED',
        payout_provider: 'STRIPE',
        provider_transfer_id: 'tr_prior',
        provider_transfer_status: 'submitted',
        stripe_transfer_id: 'tr_prior',
      }] });
    escrowRelease.mockResolvedValue({ success: false, error: { code: ErrorCodes.ESCROW_TERMINAL, message: 'already RELEASED' } });
    await expect(processCompletionReleaseJob(makeJob(signed(basePayload())))).resolves.toBeUndefined();
  });

  it.each([ErrorCodes.INVALID_STATE, ErrorCodes.ESCROW_TERMINAL])(
    'rejects %s when the locked release did not converge on the exact transfer',
    async (code) => {
      dbQuery
        .mockResolvedValueOnce({ rows: [escrowRow({ stripe_transfer_id: 'tr_prior' })] })
        .mockResolvedValueOnce({ rows: [taskRow()] })
        .mockResolvedValueOnce({ rows: [{
          state: 'FUNDED',
          payout_provider: 'STRIPE',
          provider_transfer_id: 'tr_other',
          provider_transfer_status: 'submitted',
          stripe_transfer_id: 'tr_other',
        }] });
      escrowRelease.mockResolvedValue({
        success: false,
        error: { code, message: 'stale release state' },
      });

      await expect(processCompletionReleaseJob(makeJob(signed(basePayload()))))
        .rejects.toThrow(/did not converge|transfer mismatch/i);

      expect(notifyPaymentReleased).not.toHaveBeenCalled();
    },
  );
});

describe('processCompletionReleaseJob — payload defenses (same strength as dispute jobs)', () => {
  it('rejects tampered signature without touching the database', async () => {
    const payload = { ...signed(basePayload()), _sig: 'deadbeef' };
    await expect(processCompletionReleaseJob(makeJob(payload))).rejects.toThrow(/SIGNATURE/);
    expect(dbTransaction).not.toHaveBeenCalled();
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('rejects malformed payload (non-uuid escrow_id) before any work', async () => {
    await expect(
      processCompletionReleaseJob(makeJob(signed({
        escrow_id: 'not-a-uuid',
        task_id: TASK_ID,
        reason: 'x',
        _outbox_key: OUTBOX_KEY,
      })))
    ).rejects.toThrow(/SCHEMA/);
    expect(dbTransaction).not.toHaveBeenCalled();
  });

  it('rejects forged transport, durable-key, and signed-envelope bindings before effects', async () => {
    const valid = signed(basePayload());
    await expect(processCompletionReleaseJob(makeJob(
      valid,
      outboxTransportJobId('completion-release:forged'),
    ))).rejects.toThrow('OUTBOX_IDENTITY_MISMATCH');

    const forgedKeyPayload = {
      ...basePayload(),
      _outbox_key: 'completion-release:10000000-0000-0000-0000-0000000000bb',
    };
    await expect(processCompletionReleaseJob(makeJob(
      signed(forgedKeyPayload),
      outboxTransportJobId(String(forgedKeyPayload._outbox_key)),
    ))).rejects.toThrow('JOB_IDENTITY_INVALID');

    const withoutKey = {
      escrow_id: ESCROW_ID,
      task_id: TASK_ID,
      reason: 'task_completed',
    };
    await expect(processCompletionReleaseJob(makeJob({
      ...basePayload(),
      _sig: signJobPayload(withoutKey),
    }))).rejects.toThrow('JOB_SIGNATURE_INVALID');

    expect(dbTransaction).not.toHaveBeenCalled();
    expect(createTransfer).not.toHaveBeenCalled();
    expect(acknowledgeOutbox).not.toHaveBeenCalled();
  });

  it('throws on ACK failure and terminal-crash replay ACKs without another provider effect', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [escrowRow({ stripe_transfer_id: 'tr_prior' })] })
      .mockResolvedValueOnce({ rows: [taskRow()] })
      .mockResolvedValueOnce({ rows: [{ exact: true }] })
      .mockResolvedValueOnce({ rows: [escrowRow({
        state: 'RELEASED',
        stripe_transfer_id: 'tr_prior',
      })] })
      .mockResolvedValueOnce({ rows: [{ exact: true }] });
    acknowledgeOutbox
      .mockRejectedValueOnce(new Error('ack transaction crashed'))
      .mockResolvedValueOnce({ idempotency_key: OUTBOX_KEY, status: 'processed', attempts: 2 });
    const valid = signed(basePayload());

    await expect(processCompletionReleaseJob(makeJob(valid)))
      .rejects.toThrow('ack transaction crashed');
    await expect(processCompletionReleaseJob(makeJob(valid))).resolves.toBeUndefined();

    expect(createTransfer).not.toHaveBeenCalled();
    expect(escrowRelease).toHaveBeenCalledTimes(1);
    expect(acknowledgeOutbox).toHaveBeenNthCalledWith(1, OUTBOX_KEY);
    expect(acknowledgeOutbox).toHaveBeenNthCalledWith(2, OUTBOX_KEY);
  });

  it('ACKs duplicate terminal deliveries by the same signed durable identity', async () => {
    const terminal = escrowRow({
      state: 'RELEASED',
      stripe_transfer_id: 'tr_done',
    });
    dbQuery
      .mockResolvedValueOnce({ rows: [terminal] })
      .mockResolvedValueOnce({ rows: [{ exact: true }] })
      .mockResolvedValueOnce({ rows: [terminal] })
      .mockResolvedValueOnce({ rows: [{ exact: true }] });
    const valid = signed(basePayload());

    await processCompletionReleaseJob(makeJob(valid));
    await processCompletionReleaseJob(makeJob(valid));

    expect(createTransfer).not.toHaveBeenCalled();
    expect(escrowRelease).not.toHaveBeenCalled();
    expect(acknowledgeOutbox).toHaveBeenCalledTimes(2);
    expect(acknowledgeOutbox).toHaveBeenCalledWith(OUTBOX_KEY);
  });
});
