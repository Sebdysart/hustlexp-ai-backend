import { config } from '../config.js';
import { db } from '../db.js';
import type { QueryFn } from '../db.js';
import { computeFeeBreakdown, clampFeePercent } from '../lib/money.js';
import { workerLogger } from '../logger.js';
import { RevenueService } from '../services/RevenueService.js';
import { SelfInsurancePoolService } from '../services/SelfInsurancePoolService.js';
import { StripeService } from '../services/StripeService.js';
import { loadCurrentTaskPayoutDestination } from '../services/TaskPayoutDestinationService.js';
import { lockEscrowForStripeRestriction, stripeRestrictionCode } from './EscrowActionRestriction.js';
import type { EscrowActionInput, TaskPayoutRow } from './EscrowActionTypes.js';
import { taskPayoutRecipient } from './EscrowActionTypes.js';

const log = workerLogger.child({ worker: 'escrow-action' });

async function loadTask(taskId: string): Promise<TaskPayoutRow> {
  const result = await db.query<TaskPayoutRow>(
    `SELECT worker_id,payout_recipient_user_id,provider_organization_id,
            provider_assignment_id,poster_id FROM tasks WHERE id=$1`,
    [taskId],
  );
  if (!result.rows[0]) throw new Error(`Task ${taskId} not found`);
  if (!result.rows[0].worker_id) throw new Error(`Task ${taskId} has no worker_id`);
  return result.rows[0];
}

async function loadStripeAccount(taskId:string,task:TaskPayoutRow,userId:string):Promise<string> {
  const destination=await loadCurrentTaskPayoutDestination(db.query.bind(db),{
    taskId,workerId:task.worker_id!,payoutRecipientUserId:userId,
  });
  if (!destination.ready || !destination.stripeConnectId) {
    throw new Error(`Payout destination ${userId} is not current (${destination.reason})`);
  }
  return destination.stripeConnectId;
}

async function createTransfer(input: {
  action: EscrowActionInput;
  task: TaskPayoutRow;
  payoutRecipientUserId: string;
  stripeAccountId: string;
  amount: number;
}): Promise<string | null> {
  try {
    const result = await StripeService.createTransfer({
      escrowId: input.action.escrow.id,
      taskId: input.action.taskId,
      workerId: input.payoutRecipientUserId,
      workerStripeAccountId: input.stripeAccountId,
      amount: input.amount,
      description: `Dispute resolution: ${input.action.reason}`,
      idempotencyKeySuffix: 'dispute_release',
    });
    if (!result.success) throw new Error(`Failed to create transfer: ${result.error.message}`);
    return result.data.transferId;
  } catch (error) {
    const code = stripeRestrictionCode(error);
    if (!code) throw error;
    log.error({
      escrowId: input.action.escrow.id,
      workerId: input.task.worker_id,
      payoutRecipientUserId: input.payoutRecipientUserId,
      stripeCode: code,
    }, 'CRITICAL: Stripe account restricted — locking escrow, NOT retrying');
    await lockEscrowForStripeRestriction({
      escrowId: input.action.escrow.id,
      workerId: input.payoutRecipientUserId,
      stripeCode: code,
    });
    return null;
  }
}

async function storeTransfer(query: QueryFn, input: {
  escrowId: string;
  expectedVersion: number;
  transferId: string;
}): Promise<void> {
  const result = await query<{ id: string; version: number; stripe_transfer_id: string | null }>(
    `SELECT id, version, stripe_transfer_id FROM escrows WHERE id = $1 FOR UPDATE NOWAIT`,
    [input.escrowId],
  );
  const locked = result.rows[0];
  if (!locked) throw new Error(`Escrow ${input.escrowId} disappeared during T2 lock — retry`);
  if (locked.stripe_transfer_id) {
    log.info({
      escrowId: input.escrowId,
      existingTransferId: locked.stripe_transfer_id,
      ourTransferId: input.transferId,
    }, 'T2 re-read: transfer_id already set by concurrent worker — skipping UPDATE (idempotent)');
    return;
  }
  if (locked.version !== input.expectedVersion) {
    throw new Error(`Version conflict in T2 for escrow ${input.escrowId} (expected ${input.expectedVersion}, got ${locked.version}) — retry`);
  }
  const updated = await query<{ id: string }>(
    `UPDATE escrows
        SET stripe_transfer_id = $1, version = version + 1
      WHERE id = $2 AND version = $3
      RETURNING id`,
    [input.transferId, input.escrowId, input.expectedVersion],
  );
  if (!updated.rows[0]) {
    throw new Error(`Concurrent version conflict storing transfer ${input.transferId} for escrow ${input.escrowId} — retry`);
  }
}

async function runReleaseEffects(input: {
  action: EscrowActionInput;
  task: TaskPayoutRow;
  transferId: string;
  platformFeeCents: number;
  netPayoutCents: number;
  insuranceContributionCents: number;
}): Promise<void> {
  if (input.platformFeeCents > 0) {
    try {
      await RevenueService.logEvent({
        eventType: 'platform_fee',
        userId: input.task.poster_id!,
        taskId: input.action.taskId,
        amountCents: input.platformFeeCents,
        grossAmountCents: input.action.escrow.amount,
        platformFeeCents: input.platformFeeCents,
        netAmountCents: input.netPayoutCents,
        feeBasisPoints: Math.round(clampFeePercent(config.stripe.platformFeePercent) * 100),
        escrowId: input.action.escrow.id,
        stripeTransferId: input.transferId,
        metadata: { event: 'escrow_dispute_release' },
      });
    } catch (error) {
      log.warn(
        { err: error instanceof Error ? error.message : String(error), escrowId: input.action.escrow.id },
        'handleReleaseRequest: revenue ledger write failed — manual reconciliation required',
      );
    }
  }
  try {
    await SelfInsurancePoolService.recordContribution(
      input.action.taskId,
      input.task.worker_id!,
      input.insuranceContributionCents,
    );
  } catch (error) {
    log.warn(
      { err: error instanceof Error ? error.message : String(error), escrowId: input.action.escrow.id },
      'handleReleaseRequest: self-insurance pool contribution failed — dispute release proceeds',
    );
  }
}

export async function handleReleaseRequest(action: EscrowActionInput): Promise<void> {
  if (action.escrow.stripe_transfer_id) {
    log.info({
      escrowId: action.escrow.id,
      transferId: action.escrow.stripe_transfer_id,
    }, 'Escrow already has transfer_id, idempotent replay');
    return;
  }
  const task = await loadTask(action.taskId);
  const payoutRecipientUserId = taskPayoutRecipient(task)!;
  const stripeAccountId = await loadStripeAccount(action.taskId,task,payoutRecipientUserId);
  const money = computeFeeBreakdown(
    action.escrow.amount,
    config.stripe.platformFeePercent,
    action.escrow.platform_fee_cents,
  );
  const transferId = await createTransfer({
    action,
    task,
    payoutRecipientUserId,
    stripeAccountId,
    amount: money.netPayoutCents,
  });
  if (!transferId) return;
  await db.transaction((query) => storeTransfer(query, {
    escrowId: action.escrow.id,
    expectedVersion: action.escrow.version,
    transferId,
  }));
  log.info({ escrowId: action.escrow.id, transferId }, 'Transfer created for escrow');
  await runReleaseEffects({
    action,
    task,
    transferId,
    platformFeeCents: money.platformFeeCents,
    netPayoutCents: money.netBeforeInsuranceCents,
    insuranceContributionCents: money.insuranceContributionCents,
  });
}
