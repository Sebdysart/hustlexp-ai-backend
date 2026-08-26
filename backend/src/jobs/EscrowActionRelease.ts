import { config } from '../config.js';
import { db } from '../db.js';
import type { QueryFn } from '../db.js';
import { computeFeeBreakdown } from '../lib/money.js';
import { workerLogger } from '../logger.js';
import { EscrowReleaseReconciliationService } from '../services/EscrowReleaseReconciliationService.js';
import type { StripeTransferWitness } from '../services/EscrowReleaseTypes.js';
import { StripeService } from '../services/StripeService.js';
import { newPaymentCreationFailure } from '../services/NewPaymentCreationGuard.js';
import { loadCurrentTaskPayoutDestination } from '../services/TaskPayoutDestinationService.js';
import { lockEscrowForStripeRestriction, stripeRestrictionCode } from './EscrowActionRestriction.js';
import type {
  EscrowActionInput,
  EscrowActionTerminalProof,
  TaskPayoutRow,
} from './EscrowActionTypes.js';
import { taskPayoutRecipient } from './EscrowActionTypes.js';

const log = workerLogger.child({ worker: 'escrow-action' });

interface ReleaseTask extends TaskPayoutRow {
  state: string;
  version: number;
  price: number;
}

interface ReleaseAuthority {
  id: string;
  taskId: string;
  escrowId: string;
  version: number;
  initiatedBy: string;
  resolvedBy: string;
  task: ReleaseTask;
}

interface LockedEscrow {
  id: string;
  task_id: string;
  state: string;
  version: number;
  amount: number;
  platform_fee_cents: number | null;
  stripe_payment_intent_id: string | null;
  stripe_transfer_id: string | null;
  stripe_refund_id: string | null;
  refund_amount: number | null;
  release_amount: number | null;
  payout_provider: string | null;
  provider_transfer_id: string | null;
  provider_transfer_status: string | null;
  provider_transfer_paid_at: Date | null;
}

interface ReleasedOrigin {
  originalEscrowVersion: number;
  originalReleaseFromState: string;
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function exactJson(value: unknown, expected: Record<string, unknown>): boolean {
  const actual = jsonRecord(value);
  if (!actual) return false;
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();
  return expectedKeys.length === actualKeys.length
    && expectedKeys.every((key, index) => key === actualKeys[index] && Object.is(actual[key], expected[key]));
}

function actionBindingMatches(current: LockedEscrow, action: EscrowActionInput): boolean {
  return current.id === action.escrow.id
    && current.task_id === action.taskId
    && current.state === action.escrow.state
    && current.version === action.escrow.version
    && Number(current.amount) === action.escrow.amount
    && current.platform_fee_cents === action.escrow.platform_fee_cents
    && current.stripe_payment_intent_id === action.escrow.stripe_payment_intent_id
    && current.stripe_transfer_id === action.escrow.stripe_transfer_id
    && current.stripe_refund_id === action.escrow.stripe_refund_id
    && current.refund_amount === action.escrow.refund_amount
    && current.release_amount === action.escrow.release_amount
    && current.payout_provider === action.escrow.payout_provider
    && current.provider_transfer_id === action.escrow.provider_transfer_id
    && current.provider_transfer_status === action.escrow.provider_transfer_status
    && (
      current.provider_transfer_paid_at === null
        ? action.escrow.provider_transfer_paid_at === null
        : action.escrow.provider_transfer_paid_at !== null
          && new Date(current.provider_transfer_paid_at).getTime()
            === new Date(action.escrow.provider_transfer_paid_at).getTime()
    );
}

async function loadLockedEscrow(query: QueryFn, escrowId: string): Promise<LockedEscrow> {
  const result = await query<LockedEscrow>(
    `SELECT id,task_id,state,version,amount,platform_fee_cents,
            stripe_payment_intent_id,stripe_transfer_id,stripe_refund_id,
            refund_amount,release_amount,payout_provider,provider_transfer_id,
            provider_transfer_status,provider_transfer_paid_at
       FROM escrows WHERE id=$1 FOR UPDATE`,
    [escrowId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Escrow ${escrowId} disappeared during release`);
  return row;
}

async function loadReleaseAuthority(query: QueryFn, action: EscrowActionInput): Promise<ReleaseAuthority> {
  if (
    action.reason !== 'dispute_resolution'
    || !action.disputeId
    || action.refundAmount !== 0
    || action.releaseAmount !== action.escrow.amount
    || !Number.isSafeInteger(action.escrow.amount)
    || action.escrow.amount <= 0
  ) {
    throw new Error('RELEASE_AUTHORITY_REQUIRED: expected exact resolved-dispute full release');
  }
  const result = await query<{
    id: string; task_id: string; escrow_id: string; state: string; version: number;
    initiated_by: string; resolved_by: string | null; outcome_escrow_action: string | null;
    outcome_refund_amount: number | null; outcome_release_amount: number | null;
    task_state: string; task_version: number; worker_id: string | null;
    payout_recipient_user_id: string | null; provider_organization_id: string | null;
    provider_assignment_id: string | null; poster_id: string | null; price: number;
  }>(
    `SELECT dispute.id,dispute.task_id,dispute.escrow_id,dispute.state,
            dispute.version,dispute.initiated_by,dispute.resolved_by,
            dispute.outcome_escrow_action,dispute.outcome_refund_amount,
            dispute.outcome_release_amount,task.state AS task_state,
            task.version AS task_version,task.worker_id,task.payout_recipient_user_id,
            task.provider_organization_id,task.provider_assignment_id,task.poster_id,task.price
       FROM disputes dispute JOIN tasks task ON task.id=dispute.task_id
      WHERE dispute.id=$1 FOR SHARE OF dispute,task`,
    [action.disputeId],
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 || !row || row.id !== action.disputeId
    || row.task_id !== action.taskId || row.escrow_id !== action.escrow.id
    || row.state !== 'RESOLVED' || !Number.isSafeInteger(row.version) || !row.resolved_by
    || row.outcome_escrow_action !== 'RELEASE' || Number(row.outcome_refund_amount) !== 0
    || Number(row.outcome_release_amount) !== action.escrow.amount
    || row.task_state !== 'COMPLETED' || !Number.isSafeInteger(row.task_version)
    || !row.worker_id || Number(row.price) !== action.escrow.amount
  ) {
    throw new Error(`RELEASE_AUTHORITY_REQUIRED: dispute ${action.disputeId} is not exact`);
  }
  return {
    id: row.id, taskId: row.task_id, escrowId: row.escrow_id, version: row.version,
    initiatedBy: row.initiated_by, resolvedBy: row.resolved_by,
    task: {
      state: row.task_state, version: row.task_version, price: row.price,
      worker_id: row.worker_id, payout_recipient_user_id: row.payout_recipient_user_id,
      provider_organization_id: row.provider_organization_id,
      provider_assignment_id: row.provider_assignment_id, poster_id: row.poster_id,
    },
  };
}

async function loadStripeAccount(query: QueryFn, action: EscrowActionInput, task: ReleaseTask, payee: string): Promise<string> {
  const destination = await loadCurrentTaskPayoutDestination(query, {
    taskId: action.taskId, workerId: task.worker_id!, payoutRecipientUserId: payee,
  });
  if (!destination.ready || !destination.stripeConnectId) {
    throw new Error(`Payout destination ${payee} is not current (${destination.reason})`);
  }
  return destination.stripeConnectId;
}

function transferWitnessExact(input: {
  witness: StripeTransferWitness; action: EscrowActionInput; payee: string;
  destination: string; transferId: string; amount: number;
}): boolean {
  const w = input.witness;
  return w.provider === 'STRIPE' && w.transferId === input.transferId
    && w.escrowId === input.action.escrow.id && w.taskId === input.action.taskId
    && w.payoutRecipientUserId === input.payee && w.destinationAccountId === input.destination
    && w.amountCents === input.amount && w.currency === 'usd'
    && w.reversed === false && w.amountReversedCents === 0;
}

async function readExactWitness(input: {
  action: EscrowActionInput; payee: string; destination: string; transferId: string; amount: number;
}): Promise<StripeTransferWitness> {
  const result = await StripeService.readTransferWitness(input.transferId);
  if (!result.success) throw new Error(`Release transfer witness unavailable: ${result.error.message}`);
  if (!transferWitnessExact({ ...input, witness: result.data })) {
    throw new Error(`Release transfer ${input.transferId} does not match exact canonical payout binding`);
  }
  return result.data;
}

async function createTransfer(input: {
  action: EscrowActionInput; task: ReleaseTask; payee: string; destination: string; amount: number;
}): Promise<string | null> {
  try {
    const result = await StripeService.createTransfer({
      escrowId: input.action.escrow.id,
      taskId: input.action.taskId,
      workerId: input.payee,
      workerStripeAccountId: input.destination,
      amount: input.amount,
      description: `Dispute resolution: ${input.action.reason}`,
      idempotencyKeySuffix: 'dispute_release',
    });
    if (!result.success) throw new Error(`Failed to create transfer: ${result.error.message}`);
    return result.data.transferId;
  } catch (error) {
    const code = stripeRestrictionCode(error);
    if (!code) throw error;
    await lockEscrowForStripeRestriction({
      escrowId: input.action.escrow.id,
      workerId: input.payee,
      stripeCode: code,
    });
    return null;
  }
}

async function terminalizeFirstRelease(input: {
  action: EscrowActionInput;
  authority: ReleaseAuthority;
  transferId: string;
  witness: StripeTransferWitness;
  payee: string;
  destination: string;
  amount: number;
  platformFeeCents: number;
}): Promise<EscrowActionTerminalProof> {
  await db.transaction(async (query) => {
    const current = await loadLockedEscrow(query, input.action.escrow.id);
    if (!actionBindingMatches(current, input.action) || current.state !== 'LOCKED_DISPUTE') {
      throw new Error(`Release binding changed during terminal T2 for escrow ${input.action.escrow.id}`);
    }
    if (current.stripe_transfer_id && current.stripe_transfer_id !== input.transferId) {
      throw new Error(`Transfer conflict for escrow ${input.action.escrow.id}`);
    }
    const authority = await loadReleaseAuthority(query, input.action);
    if (
      authority.version !== input.authority.version
      || authority.resolvedBy !== input.authority.resolvedBy
      || authority.task.version !== input.authority.task.version
      || taskPayoutRecipient(authority.task) !== input.payee
    ) {
      throw new Error(`Release authority changed during terminal T2 for escrow ${input.action.escrow.id}`);
    }
    const destination = await loadStripeAccount(query, input.action, authority.task, input.payee);
    if (
      destination !== input.destination
      || !transferWitnessExact({
        witness: input.witness,
        action: input.action,
        payee: input.payee,
        destination,
        transferId: input.transferId,
        amount: input.amount,
      })
    ) {
      throw new Error(`Release provider binding changed during terminal T2 for escrow ${input.action.escrow.id}`);
    }
    const origin = await loadReleasedOrigin(query, input.action, authority, input.transferId);
    if (origin) {
      throw new Error(`First release for escrow ${input.action.escrow.id} has released-origin history`);
    }
    const metadata = {
      event_type: 'dispute_first_release_authority_v1',
      dispute_id: authority.id,
      dispute_version: authority.version,
      resolved_by: authority.resolvedBy,
      task_id: input.action.taskId,
      task_version: authority.task.version,
      escrow_id: input.action.escrow.id,
      canonical_state_before: 'LOCKED_DISPUTE',
      canonical_version_before: input.action.escrow.version,
      transfer_id: input.transferId,
      payout_recipient_user_id: input.payee,
      destination_account_id: input.destination,
      transfer_amount_cents: input.amount,
      platform_fee_cents: input.platformFeeCents,
      currency: 'usd',
      provider_status: 'not_reversed',
      provider_state_after: 'submitted',
    };
    const idempotencyKey = [
      'dispute-first-release-authority-v1',
      input.action.escrow.id,
      authority.id,
      authority.version,
      input.action.escrow.version,
      input.transferId,
    ].join(':');
    await ensureExactSystemEvent({
      query,
      escrowId: input.action.escrow.id,
      fromState: 'LOCKED_DISPUTE',
      toState: 'RELEASED',
      metadata,
      idempotencyKey,
    });
    await query(
      `SELECT set_config('hustlexp.dispute_first_release_authority',$1,true)`,
      [input.action.escrow.id],
    );
    const updated = await query<{ version: number }>(
      `UPDATE escrows
          SET state='RELEASED',stripe_transfer_id=$1,payout_provider='STRIPE',
              provider_transfer_id=$1,provider_transfer_status='submitted',
              provider_transfer_paid_at=NULL,platform_fee_cents=$2,
              released_at=NOW(),version=version+1,updated_at=NOW()
        WHERE id=$3 AND task_id=$4 AND state='LOCKED_DISPUTE' AND version=$5
          AND amount=$6 AND platform_fee_cents IS NOT DISTINCT FROM $7
          AND stripe_payment_intent_id IS NOT DISTINCT FROM $8
          AND stripe_transfer_id IS NOT DISTINCT FROM $9
          AND stripe_refund_id IS NOT DISTINCT FROM $10
          AND refund_amount IS NOT DISTINCT FROM $11
          AND release_amount IS NOT DISTINCT FROM $12
          AND payout_provider IS NOT DISTINCT FROM $13
          AND provider_transfer_id IS NOT DISTINCT FROM $14
          AND provider_transfer_status IS NOT DISTINCT FROM $15
          AND provider_transfer_paid_at IS NOT DISTINCT FROM $16
        RETURNING version`,
      [
        input.transferId,
        input.platformFeeCents,
        input.action.escrow.id,
        input.action.taskId,
        input.action.escrow.version,
        input.action.escrow.amount,
        input.action.escrow.platform_fee_cents,
        input.action.escrow.stripe_payment_intent_id,
        input.action.escrow.stripe_transfer_id,
        input.action.escrow.stripe_refund_id,
        input.action.escrow.refund_amount,
        input.action.escrow.release_amount,
        input.action.escrow.payout_provider,
        input.action.escrow.provider_transfer_id,
        input.action.escrow.provider_transfer_status,
        input.action.escrow.provider_transfer_paid_at,
      ],
    );
    if (updated.rowCount !== 1) {
      throw new Error(`First-release terminal CAS failed for escrow ${input.action.escrow.id}`);
    }
  });
  const reconciled = await EscrowReleaseReconciliationService.reconcile({
    escrowId: input.action.escrow.id,
    expectedStripeTransferId: input.transferId,
    fromState: 'LOCKED_DISPUTE',
  });
  if (!reconciled.success) {
    throw new Error(`First-release reconciliation failed: ${reconciled.error.message}`);
  }
  return {
    escrowId: input.action.escrow.id,
    taskId: input.action.taskId,
    terminalState: 'RELEASED',
    providerOperationId: input.transferId,
    evidence: 'EXACT_RELEASE_RECONCILED_V1',
  };
}

async function loadReleasedOrigin(
  query: QueryFn,
  action: EscrowActionInput,
  authority: ReleaseAuthority,
  transferId: string,
): Promise<ReleasedOrigin | null> {
  const origins = await query<{ metadata: unknown; actor_id: string | null; actor_type: string; idempotency_key: string }>(
    `SELECT metadata,actor_id,actor_type,idempotency_key FROM escrow_events
      WHERE escrow_id=$1 AND from_state='RELEASED' AND to_state='LOCKED_DISPUTE'
        AND actor_id IS NULL AND actor_type='system'
        AND metadata::jsonb->>'event_type'='dispute_locked_after_release'
      ORDER BY created_at DESC LIMIT 2`,
    [action.escrow.id],
  );
  if (origins.rows.length === 0) return null;
  const originalVersion = action.escrow.version - 1;
  if (
    origins.rows.length !== 1
    || origins.rows[0].idempotency_key !== `released-dispute-origin-v1:${action.escrow.id}:${originalVersion}`
    || !exactJson(origins.rows[0].metadata, {
      event_type: 'dispute_locked_after_release',
      task_id: action.taskId,
      initiated_by: authority.initiatedBy,
      original_transfer_id: transferId,
      escrow_version: originalVersion,
    })
  ) {
    throw new Error(`Released-dispute origin for escrow ${action.escrow.id} is not exact`);
  }
  const releases = await query<{ from_state: string; to_state: string; actor_id: string | null; actor_type: string; metadata: unknown }>(
    `SELECT from_state,to_state,actor_id,actor_type,metadata FROM escrow_events
      WHERE idempotency_key=$1 LIMIT 2`,
    [`escrow.released:${action.escrow.id}`],
  );
  const release = releases.rows[0];
  if (
    releases.rows.length !== 1 || !release
    || !['FUNDED', 'LOCKED_DISPUTE'].includes(release.from_state)
    || release.to_state !== 'RELEASED' || release.actor_id !== null || release.actor_type !== 'system'
    || !exactJson(release.metadata, {
      payout_provider: 'STRIPE',
      payout_recipient_user_id: taskPayoutRecipient(authority.task),
      provider_transfer_id: transferId,
      provider_transfer_status: 'submitted',
    })
  ) {
    throw new Error(`Original release event for escrow ${action.escrow.id} is not exact`);
  }
  return { originalEscrowVersion: originalVersion, originalReleaseFromState: release.from_state };
}

async function ensureExactSystemEvent(input: {
  query: QueryFn; escrowId: string; fromState: string; toState: string;
  metadata: Record<string, unknown>; idempotencyKey: string;
}): Promise<void> {
  const result = await input.query(
    `WITH attempted AS (
       INSERT INTO escrow_events
         (escrow_id,from_state,to_state,actor_id,actor_type,metadata,idempotency_key)
       VALUES ($1,$2,$3,NULL,'system',$4::jsonb,$5)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id)
     SELECT id FROM attempted UNION ALL
     SELECT id FROM escrow_events WHERE escrow_id=$1 AND from_state=$2 AND to_state=$3
       AND actor_id IS NULL AND actor_type='system' AND metadata::jsonb=$4::jsonb
       AND idempotency_key=$5 LIMIT 1`,
    [input.escrowId, input.fromState, input.toState, JSON.stringify(input.metadata), input.idempotencyKey],
  );
  if (result.rowCount !== 1) throw new Error(`Release authority event ${input.idempotencyKey} conflicts`);
}

async function restoreReleasedDispute(input: {
  action: EscrowActionInput; authority: ReleaseAuthority; origin: ReleasedOrigin;
  transferId: string; witness: StripeTransferWitness; payee: string; destination: string; amount: number;
}): Promise<EscrowActionTerminalProof> {
  await db.transaction(async (query) => {
    const current = await loadLockedEscrow(query, input.action.escrow.id);
    if (
      !actionBindingMatches(current, input.action) || current.state !== 'LOCKED_DISPUTE'
      || current.platform_fee_cents === null
      || !Number.isSafeInteger(current.platform_fee_cents)
      || current.platform_fee_cents < 0
      || current.platform_fee_cents > current.amount
      || current.stripe_transfer_id !== input.transferId || current.payout_provider !== 'STRIPE'
      || current.provider_transfer_id !== input.transferId
      || !['submitted', 'processing', 'paid'].includes(current.provider_transfer_status ?? '')
    ) {
      throw new Error(`Released-dispute restore lacks exact preserved transfer facts`);
    }
    const authority = await loadReleaseAuthority(query, input.action);
    if (
      authority.version !== input.authority.version
      || authority.task.version !== input.authority.task.version
      || authority.resolvedBy !== input.authority.resolvedBy
      || taskPayoutRecipient(authority.task) !== input.payee
    ) {
      throw new Error('Released-dispute authority changed during restore');
    }
    const origin = await loadReleasedOrigin(query, input.action, authority, input.transferId);
    if (
      !origin || origin.originalEscrowVersion !== input.origin.originalEscrowVersion
      || origin.originalReleaseFromState !== input.origin.originalReleaseFromState
    ) {
      throw new Error('Released-dispute origin changed during restore');
    }
    const destination = await loadStripeAccount(query, input.action, authority.task, input.payee);
    if (
      destination !== input.destination
      || !transferWitnessExact({
        witness: input.witness, action: input.action, payee: input.payee,
        destination, transferId: input.transferId, amount: input.amount,
      })
    ) {
      throw new Error('Released-dispute provider binding changed during restore');
    }
    const metadata = {
      event_type: 'dispute_release_restore_authority_v1',
      dispute_id: authority.id,
      dispute_version: authority.version,
      resolved_by: authority.resolvedBy,
      task_id: input.action.taskId,
      task_version: authority.task.version,
      escrow_id: input.action.escrow.id,
      canonical_state_before: 'LOCKED_DISPUTE',
      canonical_version_before: input.action.escrow.version,
      original_transfer_id: input.transferId,
      payout_recipient_user_id: input.payee,
      destination_account_id: input.destination,
      transfer_amount_cents: input.amount,
      currency: 'usd',
      provider_status: 'not_reversed',
    };
    const key = [
      'dispute-release-restore-authority-v1', input.action.escrow.id, authority.id,
      authority.version, input.action.escrow.version,
    ].join(':');
    await ensureExactSystemEvent({
      query, escrowId: input.action.escrow.id, fromState: 'LOCKED_DISPUTE', toState: 'RELEASED',
      metadata, idempotencyKey: key,
    });
    await query(
      `SELECT set_config('hustlexp.dispute_release_restore_authority',$1,true)`,
      [input.action.escrow.id],
    );
    const updated = await query<{ version: number }>(
      `UPDATE escrows SET state='RELEASED',version=version+1,updated_at=NOW()
        WHERE id=$1 AND task_id=$2 AND state='LOCKED_DISPUTE' AND version=$3
          AND amount=$4 AND platform_fee_cents IS NOT DISTINCT FROM $5
          AND stripe_payment_intent_id IS NOT DISTINCT FROM $6 AND stripe_transfer_id=$7
          AND stripe_refund_id IS NOT DISTINCT FROM $8
          AND refund_amount IS NOT DISTINCT FROM $9 AND release_amount IS NOT DISTINCT FROM $10
          AND payout_provider='STRIPE' AND provider_transfer_id=$7 AND provider_transfer_status=$11
        RETURNING version`,
      [
        input.action.escrow.id, input.action.taskId, input.action.escrow.version,
        input.action.escrow.amount, input.action.escrow.platform_fee_cents,
        input.action.escrow.stripe_payment_intent_id, input.transferId,
        input.action.escrow.stripe_refund_id, input.action.escrow.refund_amount,
        input.action.escrow.release_amount, current.provider_transfer_status,
      ],
    );
    if (updated.rowCount !== 1) throw new Error(`Released-dispute restore CAS failed`);
  });
  const reconciled = await EscrowReleaseReconciliationService.reconcile({
    escrowId: input.action.escrow.id,
    expectedStripeTransferId: input.transferId,
    fromState: input.origin.originalReleaseFromState,
  });
  if (!reconciled.success) throw new Error(`Released-dispute reconciliation failed: ${reconciled.error.message}`);
  return {
    escrowId: input.action.escrow.id,
    taskId: input.action.taskId,
    terminalState: 'RELEASED',
    providerOperationId: input.transferId,
    evidence: 'EXACT_RELEASE_RECONCILED_V1',
  };
}

async function reconcileReleasedReplay(input: {
  action: EscrowActionInput; authority: ReleaseAuthority; transferId: string;
  payee: string; destination: string; amount: number;
}): Promise<EscrowActionTerminalProof> {
  await readExactWitness(input);
  const origin = await db.transaction((query) => loadReleasedOrigin(
    query, input.action, input.authority, input.transferId,
  ));
  // Re-read immediately before reconciliation. The first read cannot authorize
  // success if the provider reverses the transfer while origin evidence loads.
  await readExactWitness(input);
  const reconciled = await EscrowReleaseReconciliationService.reconcile({
    escrowId: input.action.escrow.id,
    expectedStripeTransferId: input.transferId,
    fromState: origin?.originalReleaseFromState ?? 'LOCKED_DISPUTE',
  });
  if (!reconciled.success) throw new Error(`Released replay reconciliation failed: ${reconciled.error.message}`);
  return {
    escrowId: input.action.escrow.id,
    taskId: input.action.taskId,
    terminalState: 'RELEASED',
    providerOperationId: input.transferId,
    evidence: 'EXACT_RELEASE_RECONCILED_V1',
  };
}

export async function handleReleaseRequest(
  action: EscrowActionInput,
): Promise<EscrowActionTerminalProof> {
  if (!action.escrow.stripe_transfer_id) {
    const frozen = newPaymentCreationFailure('settlement_transfer');
    if (frozen) throw Object.assign(new Error(frozen.error.message), { code: frozen.error.code });
  }
  const authority = await db.transaction((query) => loadReleaseAuthority(query, action));
  const payee = taskPayoutRecipient(authority.task)!;
  const destination = await loadStripeAccount(db.query.bind(db), action, authority.task, payee);
  const money = computeFeeBreakdown(
    action.escrow.amount, config.stripe.platformFeePercent, action.escrow.platform_fee_cents,
  );

  if (action.escrow.state === 'RELEASED') {
    if (!action.escrow.stripe_transfer_id) throw new Error('Released escrow lacks canonical transfer');
    return reconcileReleasedReplay({
      action, authority, transferId: action.escrow.stripe_transfer_id,
      payee, destination, amount: money.netPayoutCents,
    });
  }

  if (action.escrow.stripe_transfer_id) {
    const transferId = action.escrow.stripe_transfer_id;
    await readExactWitness({ action, payee, destination, transferId, amount: money.netPayoutCents });
    const origin = await db.transaction((query) => loadReleasedOrigin(query, action, authority, transferId));
    const witness = await readExactWitness({
      action, payee, destination, transferId, amount: money.netPayoutCents,
    });
    if (origin) {
      return restoreReleasedDispute({
        action, authority, origin, transferId, witness, payee, destination, amount: money.netPayoutCents,
      });
    }
    return terminalizeFirstRelease({
      action,
      authority,
      transferId,
      witness,
      payee,
      destination,
      amount: money.netPayoutCents,
      platformFeeCents: money.platformFeeCents,
    });
  }

  const transferId = await createTransfer({
    action, task: authority.task, payee, destination, amount: money.netPayoutCents,
  });
  if (!transferId) {
    throw new Error(
      `RELEASE_RESTRICTION_RECONCILIATION_REQUIRED: escrow ${action.escrow.id} remains nonterminal`,
    );
  }
  await readExactWitness({ action, payee, destination, transferId, amount: money.netPayoutCents });
  const witness = await readExactWitness({
    action, payee, destination, transferId, amount: money.netPayoutCents,
  });
  const proof = await terminalizeFirstRelease({
    action,
    authority,
    transferId,
    witness,
    payee,
    destination,
    amount: money.netPayoutCents,
    platformFeeCents: money.platformFeeCents,
  });
  log.info({ escrowId: action.escrow.id, transferId }, 'Transfer and canonical RELEASED state converged');
  return proof;
}
