import { config } from '../config.js';
import { db } from '../db.js';
import type { QueryFn } from '../db.js';
import {
  clampFeePercent,
  computeInsuranceContributionCents,
  computePlatformFeeCents,
} from '../lib/money.js';
import { workerLogger } from '../logger.js';
import { RevenueService } from '../services/RevenueService.js';
import { SelfInsurancePoolService } from '../services/SelfInsurancePoolService.js';
import { StripeService } from '../services/StripeService.js';
import { loadCurrentTaskPayoutDestination } from '../services/TaskPayoutDestinationService.js';
import { TaskService } from '../services/TaskService.js';
import { lockEscrowForStripeRestriction, stripeRestrictionCode } from './EscrowActionRestriction.js';
import type { EscrowActionInput, TaskPayoutRow } from './EscrowActionTypes.js';
import { taskPayoutRecipient } from './EscrowActionTypes.js';

const log = workerLogger.child({ worker: 'escrow-action' });

interface SplitMoney {
  refundAmount: number;
  releaseAmount: number;
  netReleaseCents: number;
  platformFeeCents: number;
  insuranceContributionCents: number;
}

interface SplitProviderResult {
  refundId: string | null;
  transferId: string | null;
  restricted: boolean;
}

function splitMoney(action: EscrowActionInput): SplitMoney {
  if (action.escrow.platform_fee_cents != null) {
    throw new Error('CANONICAL_QUOTE_SPLIT_REQUIRES_RECONCILIATION: partial dispute payout is fail-closed');
  }
  const refundAmount = Math.round(action.refundAmount ?? 0);
  const releaseAmount = Math.round(action.releaseAmount ?? 0);
  const feePercent = clampFeePercent(config.stripe.platformFeePercent);
  const beforeInsurance = releaseAmount - computePlatformFeeCents(releaseAmount, feePercent);
  const rawFee = releaseAmount - beforeInsurance;
  const residual = action.escrow.amount - refundAmount - beforeInsurance - rawFee;
  const platformFeeCents = rawFee + residual;
  if (refundAmount + beforeInsurance + platformFeeCents !== action.escrow.amount) {
    throw new Error(
      `SPLIT amounts ${refundAmount} + ${beforeInsurance} + fee ${platformFeeCents} !== escrow ${action.escrow.amount}`,
    );
  }
  const insuranceContributionCents = computeInsuranceContributionCents(releaseAmount);
  return {
    refundAmount,
    releaseAmount,
    netReleaseCents: beforeInsurance - insuranceContributionCents,
    platformFeeCents,
    insuranceContributionCents,
  };
}

async function loadTask(taskId: string): Promise<TaskPayoutRow> {
  const result = await db.query<TaskPayoutRow>(
    `SELECT worker_id,payout_recipient_user_id,provider_organization_id,
            provider_assignment_id,poster_id FROM tasks WHERE id=$1`,
    [taskId],
  );
  if (!result.rows[0]) throw new Error(`Task ${taskId} not found`);
  return result.rows[0];
}

function checkpointRefundId(metadata: string): string | null {
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    return typeof parsed.stripe_refund_id === 'string' ? parsed.stripe_refund_id : null;
  } catch {
    return null;
  }
}

async function pendingRefundId(action: EscrowActionInput, money: SplitMoney): Promise<string | null> {
  if (money.refundAmount === 0 || action.escrow.stripe_refund_id) return null;
  const result = await db.query<{ metadata: string }>(
    `SELECT metadata FROM escrow_events
      WHERE escrow_id = $1 AND actor_type = 'system'
        AND metadata::jsonb->>'event_type' = 'partial_refund_pending'
        AND metadata::jsonb->>'stripe_refund_id' IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
    [action.escrow.id],
  );
  const refundId = result.rows[0] ? checkpointRefundId(result.rows[0].metadata) : null;
  if (refundId) {
    log.info(
      { escrowId: action.escrow.id, refundId },
      'Found partial_refund_pending checkpoint — reusing existing refund ID, skipping Stripe refund call',
    );
  }
  return refundId;
}

async function resolveRefund(action: EscrowActionInput, money: SplitMoney): Promise<string | null> {
  const checkpointId = await pendingRefundId(action, money);
  const existing = action.escrow.stripe_refund_id ?? checkpointId;
  if (money.refundAmount === 0 || existing) return existing;
  if (!action.escrow.stripe_payment_intent_id) {
    throw new Error(`Escrow ${action.escrow.id} has no stripe_payment_intent_id for refund`);
  }
  const result = await StripeService.createRefund({
    paymentIntentId: action.escrow.stripe_payment_intent_id,
    escrowId: action.escrow.id,
    amount: money.refundAmount,
    reason: 'requested_by_customer',
    idempotencyKeySuffix: 'wkr_partial_refund',
  });
  if (!result.success) throw new Error(`Failed to create refund: ${result.error.message}`);
  const refundId = result.data.refundId;
  await db.query(
    `INSERT INTO escrow_events (escrow_id, from_state, to_state, actor_id, actor_type, metadata)
     VALUES ($1, 'LOCKED_DISPUTE', 'LOCKED_DISPUTE', NULL, 'system', $2)`,
    [action.escrow.id, JSON.stringify({ event_type: 'partial_refund_pending', stripe_refund_id: refundId })],
  );
  log.info({ escrowId: action.escrow.id, refundId }, 'Persisted partial_refund_pending checkpoint');
  return refundId;
}

async function freshTransferId(escrowId: string): Promise<string | null> {
  const result = await db.transaction((query: QueryFn) => query<{ stripe_transfer_id: string | null }>(
    'SELECT stripe_transfer_id FROM escrows WHERE id = $1 FOR UPDATE NOWAIT',
    [escrowId],
  ));
  return result.rows[0]?.stripe_transfer_id ?? null;
}

async function loadPayoutAccount(taskId:string,task:TaskPayoutRow,userId:string|null):Promise<string> {
  if (!userId || !task.worker_id) throw new Error('Payout recipient or fulfiller is missing');
  const destination=await loadCurrentTaskPayoutDestination(db.query.bind(db),{
    taskId,workerId:task.worker_id,payoutRecipientUserId:userId,
  });
  if (!destination.ready || !destination.stripeConnectId) {
    throw new Error(`Payout destination ${userId} is not current (${destination.reason})`);
  }
  return destination.stripeConnectId;
}

async function createSplitTransfer(input: {
  action: EscrowActionInput;
  task: TaskPayoutRow;
  money: SplitMoney;
  payoutRecipientUserId: string;
  stripeAccountId: string;
}): Promise<{ transferId: string | null; restricted: boolean }> {
  try {
    const result = await StripeService.createTransfer({
      escrowId: input.action.escrow.id,
      taskId: input.action.taskId,
      workerId: input.payoutRecipientUserId,
      workerStripeAccountId: input.stripeAccountId,
      amount: input.money.netReleaseCents,
      description: `Dispute resolution: ${input.action.reason}`,
      idempotencyKeySuffix: 'dispute_partial_release',
    });
    if (!result.success) throw new Error(`Failed to create transfer: ${result.error.message}`);
    return { transferId: result.data.transferId, restricted: false };
  } catch (error) {
    const code = stripeRestrictionCode(error);
    if (!code) throw error;
    log.error({
      escrowId: input.action.escrow.id,
      workerId: input.task.worker_id,
      payoutRecipientUserId: input.payoutRecipientUserId,
      stripeCode: code,
    }, 'CRITICAL: Stripe account restricted (partial refund path) — locking escrow, NOT retrying');
    await lockEscrowForStripeRestriction({
      escrowId: input.action.escrow.id,
      workerId: input.payoutRecipientUserId,
      stripeCode: code,
    });
    return { transferId: null, restricted: true };
  }
}

async function resolveTransfer(
  action: EscrowActionInput,
  task: TaskPayoutRow,
  money: SplitMoney,
): Promise<{ transferId: string | null; restricted: boolean }> {
  if (money.releaseAmount === 0) {
    return { transferId: action.escrow.stripe_transfer_id, restricted: false };
  }
  let transferId = action.escrow.stripe_transfer_id;
  if (!transferId) transferId = await freshTransferId(action.escrow.id);
  if (transferId) return { transferId, restricted: false };
  if (!task.worker_id) throw new Error(`Task ${action.taskId} has no worker_id`);
  const payoutRecipientUserId = taskPayoutRecipient(task);
  const stripeAccountId = await loadPayoutAccount(action.taskId,task,payoutRecipientUserId);
  return createSplitTransfer({
    action,
    task,
    money,
    payoutRecipientUserId: payoutRecipientUserId!,
    stripeAccountId,
  });
}

async function recordInsurance(action: EscrowActionInput, task: TaskPayoutRow, money: SplitMoney): Promise<void> {
  if (!task.worker_id || money.insuranceContributionCents === 0) return;
  try {
    await SelfInsurancePoolService.recordContribution(
      action.taskId,
      task.worker_id,
      money.insuranceContributionCents,
    );
  } catch (error) {
    log.warn(
      { err: error instanceof Error ? error.message : String(error), escrowId: action.escrow.id },
      'handlePartialRefundRequest: self-insurance pool contribution failed — SPLIT release proceeds',
    );
  }
}

async function lockPartialTerminalRow(
  query: QueryFn,
  escrowId: string,
): Promise<{ version: number; state: string }> {
  try {
    const result = await query<{ id: string; version: number; state: string }>(
      `SELECT id, version, state FROM escrows WHERE id = $1 FOR UPDATE NOWAIT`,
      [escrowId],
    );
    if (!result.rows[0]) throw new Error(`Escrow ${escrowId} disappeared during T2 partial-refund lock — retry`);
    return result.rows[0];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('55P03') || message.toLowerCase().includes('could not obtain lock')) {
      throw new Error(`Version conflict (lock contention) on partial-refund T2 for escrow ${escrowId} — retry`);
    }
    throw error;
  }
}

async function updatePartialTerminal(query: QueryFn, input: {
  action: EscrowActionInput;
  money: SplitMoney;
  provider: SplitProviderResult;
  version: number;
}): Promise<{ rowCount: number; finalState: string | null }> {
  const updated = await query<{ id: string; state: string }>(
    `UPDATE escrows
        SET state = 'REFUND_PARTIAL', stripe_refund_id = $1, stripe_transfer_id = $2,
            refund_amount = $3, release_amount = $4,
            refunded_at = CASE WHEN $3 > 0 THEN NOW() ELSE refunded_at END,
            released_at = CASE WHEN $4 > 0 THEN NOW() ELSE released_at END,
            version = version + 1
      WHERE id = $5 AND version = $6
        AND ($3 = 0 OR $1 IS NOT NULL)
        AND ($4 = 0 OR $2 IS NOT NULL)`,
    [input.provider.refundId, input.provider.transferId, input.money.refundAmount,
      input.money.releaseAmount, input.action.escrow.id, input.version],
  );
  if ((updated.rowCount ?? 0) > 0) return { rowCount: updated.rowCount ?? 0, finalState: 'REFUND_PARTIAL' };
  const check = await query<{ state: string }>(`SELECT state FROM escrows WHERE id = $1`, [input.action.escrow.id]);
  return { rowCount: 0, finalState: check.rows[0]?.state ?? null };
}

async function terminalize(query: QueryFn, input: {
  action: EscrowActionInput;
  money: SplitMoney;
  provider: SplitProviderResult;
}): Promise<{ rowCount: number; finalState: string | null }> {
  const locked = await lockPartialTerminalRow(query, input.action.escrow.id);
  if (locked.state === 'REFUND_PARTIAL') return { rowCount: 0, finalState: 'REFUND_PARTIAL' };
  if (locked.state !== 'LOCKED_DISPUTE') return { rowCount: 0, finalState: locked.state };
  return updatePartialTerminal(query, { ...input, version: locked.version });
}

async function logSplitRevenue(input: {
  action: EscrowActionInput;
  task: TaskPayoutRow;
  money: SplitMoney;
  transferId: string | null;
}): Promise<void> {
  if (input.money.releaseAmount === 0) return;
  if (!input.task.worker_id) {
    log.warn({
      escrowId: input.action.escrow.id,
      releaseAmount: input.money.releaseAmount,
      stripeTransferId: input.transferId,
    }, 'Skipping revenue ledger entry for SPLIT partial release — task.worker_id is null; reconcile via Stripe transfer ID');
    return;
  }
  try {
    await RevenueService.logEvent({
      eventType: 'platform_fee',
      userId: input.task.poster_id ?? input.task.worker_id,
      taskId: input.action.taskId,
      amountCents: input.money.platformFeeCents,
      grossAmountCents: input.money.releaseAmount,
      platformFeeCents: input.money.platformFeeCents,
      netAmountCents: input.money.netReleaseCents,
      feeBasisPoints: Math.round(clampFeePercent(config.stripe.platformFeePercent) * 100),
      escrowId: input.action.escrow.id,
      stripeTransferId: input.transferId ?? undefined,
      metadata: { event: 'escrow_partial_release' },
    });
  } catch (error) {
    log.error(
      { err: error instanceof Error ? error.message : String(error), escrowId: input.action.escrow.id },
      'Failed to write revenue ledger entry for SPLIT partial release — requires manual reconciliation',
    );
  }
}

function assertProviderEvidence(action: EscrowActionInput, money: SplitMoney, provider: SplitProviderResult): void {
  if (money.refundAmount > 0 && !provider.refundId) {
    throw new Error(`Cannot terminalize SPLIT: refundAmount > 0 (${money.refundAmount}) but refundId is missing for escrow ${action.escrow.id}`);
  }
  if (money.releaseAmount > 0 && !provider.transferId) {
    throw new Error(`Cannot terminalize SPLIT: releaseAmount > 0 (${money.releaseAmount}) but transferId is missing for escrow ${action.escrow.id}`);
  }
}

export async function handlePartialRefundRequest(action: EscrowActionInput): Promise<void> {
  const money = splitMoney(action);
  const task = await loadTask(action.taskId);
  const refundId = await resolveRefund(action, money);
  const transfer = await resolveTransfer(action, task, money);
  if (transfer.restricted) return;
  const provider = { refundId, transferId: transfer.transferId, restricted: false };
  await recordInsurance(action, task, money);
  assertProviderEvidence(action, money, provider);
  const terminal = await db.transaction((query) => terminalize(query, { action, money, provider }));
  if (terminal.rowCount === 0 && terminal.finalState === 'REFUND_PARTIAL') {
    log.info({ escrowId: action.escrow.id }, 'Escrow already in REFUND_PARTIAL, idempotent replay');
    return;
  }
  if (terminal.rowCount === 0) {
    log.warn(
      { escrowId: action.escrow.id, expectedVersion: action.escrow.version },
      'Escrow version conflict on terminalization — retrying',
    );
    throw new Error('Version conflict on escrow terminalization — retrying');
  }
  await TaskService.advanceProgress({ taskId: action.taskId, to: 'CLOSED', actor: { type: 'system' } });
  await logSplitRevenue({ action, task, money, transferId: provider.transferId });
  log.info({
    escrowId: action.escrow.id,
    refundAmount: money.refundAmount,
    releaseAmount: money.releaseAmount,
  }, 'Escrow set to REFUND_PARTIAL');
}
