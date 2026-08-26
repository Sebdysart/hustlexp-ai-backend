import { db } from '../db.js';
import type { QueryFn } from '../db.js';
import {
  loadPartialRefundTerminalEvidence,
  lockExactTerminalPartialRefundBinding,
  partialRefundBindingMetadata,
  partialRefundReconciliationError,
  persistPartialRefundTransferRecovery,
} from './EscrowPartialRefundEvidence.js';
import type {
  PartialRefundTerminalEvidence,
} from './EscrowPartialRefundEvidence.js';
import { RevenueService } from './RevenueService.js';
import { SelfInsurancePoolService } from './SelfInsurancePoolService.js';
import { TaskService } from './TaskService.js';
import { XPService } from './XPService.js';

const EFFECT_CHECKPOINT_EVENT = 'partial_refund_effect_checkpoint_v1';
const XP_REASON = 'dispute_lost';

type EffectName = 'INSURANCE' | 'TASK_CLOSED' | 'REVENUE' | 'XP_CLAWBACK';

export interface PartialRefundReplayExpectation {
  escrowId: string;
  taskId?: string;
  disputeId?: string | null;
  refundAmountCents?: number;
  releaseAmountCents?: number;
  workerPercent?: number;
  posterPercent?: number;
}

interface InsuranceRow {
  id: string;
  contribution_cents: number;
  contribution_percentage: number | string;
}

interface RevenueRow {
  id: string;
  event_type: string;
  user_id: string | null;
  task_id: string | null;
  amount_cents: number;
  currency: string;
  gross_amount_cents: number | null;
  platform_fee_cents: number | null;
  net_amount_cents: number | null;
  fee_basis_points: number | null;
  escrow_id: string | null;
  stripe_transfer_id: string | null;
  metadata: unknown;
}

interface XPRow {
  id: string;
  task_id: string;
  base_xp: number;
  effective_xp: number;
  reason: string;
}

function effectIdempotencyKey(
  evidence: PartialRefundTerminalEvidence,
  effect: EffectName,
): string {
  return [
    'partial-refund-effect',
    evidence.binding.escrowId,
    evidence.binding.escrowVersion,
    effect.toLowerCase(),
  ].join(':');
}

function checkpointMetadata(
  evidence: PartialRefundTerminalEvidence,
  effect: EffectName,
  witness: Record<string, unknown>,
): Record<string, unknown> {
  return {
    event_type: EFFECT_CHECKPOINT_EVENT,
    ...partialRefundBindingMetadata(evidence.binding),
    terminal_refund_id: evidence.provider.refundWitness.refundId,
    terminal_transfer_id: evidence.provider.transferWitness.transferId,
    effect,
    effect_status: 'VERIFIED',
    ...witness,
  };
}

async function assertNoCheckpoint(
  query: QueryFn,
  evidence: PartialRefundTerminalEvidence,
  effect: EffectName,
): Promise<void> {
  const key = effectIdempotencyKey(evidence, effect);
  const result = await query<{ metadata: unknown }>(
    `SELECT metadata FROM escrow_events
      WHERE escrow_id=$1 AND idempotency_key=$2
        AND from_state='REFUND_PARTIAL' AND to_state='REFUND_PARTIAL'
        AND actor_id IS NULL AND actor_type='system'`,
    [evidence.binding.escrowId, key],
  );
  if (result.rows.length !== 0) {
    throw partialRefundReconciliationError(
      `partialRefund: ${effect} checkpoint exists without exact authoritative readback for escrow ${evidence.binding.escrowId}`,
    );
  }
}

async function checkpointEffect(
  query: QueryFn,
  evidence: PartialRefundTerminalEvidence,
  effect: EffectName,
  witness: Record<string, unknown>,
): Promise<void> {
  const metadata = checkpointMetadata(evidence, effect, witness);
  const key = effectIdempotencyKey(evidence, effect);
  const exact = await query<{ metadata: unknown }>(
    `WITH attempted AS (
       INSERT INTO escrow_events
         (escrow_id,from_state,to_state,actor_id,actor_type,metadata,idempotency_key)
       VALUES ($1,'REFUND_PARTIAL','REFUND_PARTIAL',NULL,'system',$2::jsonb,$3)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING metadata
     )
     SELECT metadata FROM attempted
     UNION ALL
     SELECT metadata FROM escrow_events
      WHERE escrow_id=$1 AND idempotency_key=$3
        AND from_state='REFUND_PARTIAL' AND to_state='REFUND_PARTIAL'
        AND actor_id IS NULL AND actor_type='system'
        AND metadata::jsonb=$2::jsonb
     LIMIT 1`,
    [evidence.binding.escrowId, JSON.stringify(metadata), key],
  );
  if (exact.rows.length !== 1) {
    throw partialRefundReconciliationError(
      `partialRefund: ${effect} checkpoint conflicts for escrow ${evidence.binding.escrowId}`,
    );
  }
}

async function inspectInsurance(
  query: QueryFn,
  evidence: PartialRefundTerminalEvidence,
): Promise<boolean> {
  await lockExactTerminalPartialRefundBinding(query, evidence);
  const binding = evidence.binding;
  if (!binding.workerId) {
    throw partialRefundReconciliationError(
      `partialRefund: insurance effect has no worker for escrow ${binding.escrowId}`,
    );
  }
  if (binding.insuranceContributionCents === 0) {
    await checkpointEffect(query, evidence, 'INSURANCE', {
      effect_applied: false,
      effect_reason: 'ZERO_CONTRIBUTION',
      insurance_contribution_id: null,
    });
    return true;
  }
  const result = await query<InsuranceRow>(
    `SELECT id,contribution_cents,contribution_percentage
       FROM insurance_contributions
      WHERE task_id=$1 AND hustler_id=$2
      FOR SHARE`,
    [binding.taskId, binding.workerId],
  );
  if (result.rows.length === 0) {
    await assertNoCheckpoint(query, evidence, 'INSURANCE');
    return false;
  }
  const row = result.rows[0];
  if (
    result.rows.length !== 1
    || row.contribution_cents !== binding.insuranceContributionCents
    || Number(row.contribution_percentage) !== 2
  ) {
    throw partialRefundReconciliationError(
      `partialRefund: insurance contribution conflicts for escrow ${binding.escrowId}`,
    );
  }
  await checkpointEffect(query, evidence, 'INSURANCE', {
    effect_applied: true,
    insurance_contribution_id: row.id,
    insurance_contribution_cents: row.contribution_cents,
    insurance_contribution_percentage: Number(row.contribution_percentage),
  });
  return true;
}

async function ensureInsurance(evidence: PartialRefundTerminalEvidence): Promise<void> {
  const existing = await db.transaction((query) => inspectInsurance(query, evidence));
  if (existing) return;
  const binding = evidence.binding;
  const result = await SelfInsurancePoolService.recordContribution(
    binding.taskId,
    binding.workerId!,
    binding.insuranceContributionCents,
  );
  if (!result.success) {
    throw partialRefundReconciliationError(
      `partialRefund: insurance contribution failed for escrow ${binding.escrowId}: ${result.error.message}`,
    );
  }
  const verified = await db.transaction((query) => inspectInsurance(query, evidence));
  if (!verified) {
    throw partialRefundReconciliationError(
      `partialRefund: insurance contribution has no exact readback for escrow ${binding.escrowId}`,
    );
  }
}

async function inspectTaskClosed(
  query: QueryFn,
  evidence: PartialRefundTerminalEvidence,
): Promise<boolean> {
  await lockExactTerminalPartialRefundBinding(query, evidence);
  const result = await query<{ progress_state: string }>(
    'SELECT progress_state FROM tasks WHERE id=$1 FOR SHARE',
    [evidence.binding.taskId],
  );
  const state = result.rows[0]?.progress_state;
  if (state !== 'CLOSED') {
    await assertNoCheckpoint(query, evidence, 'TASK_CLOSED');
    return false;
  }
  await checkpointEffect(query, evidence, 'TASK_CLOSED', {
    effect_applied: true,
    task_progress_state: state,
  });
  return true;
}

async function ensureTaskClosed(evidence: PartialRefundTerminalEvidence): Promise<void> {
  const existing = await db.transaction((query) => inspectTaskClosed(query, evidence));
  if (existing) return;
  const result = await TaskService.advanceProgress({
    taskId: evidence.binding.taskId,
    to: 'CLOSED',
    actor: { type: 'system' },
  });
  if (!result.success) {
    throw partialRefundReconciliationError(
      `partialRefund: task closure failed for escrow ${evidence.binding.escrowId}: ${result.error.message}`,
    );
  }
  const verified = await db.transaction((query) => inspectTaskClosed(query, evidence));
  if (!verified) {
    throw partialRefundReconciliationError(
      `partialRefund: task closure has no exact readback for escrow ${evidence.binding.escrowId}`,
    );
  }
}

function metadataRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactRevenueRow(
  row: RevenueRow,
  evidence: PartialRefundTerminalEvidence,
): boolean {
  const binding = evidence.binding;
  const metadata = metadataRecord(row.metadata);
  const expectedUserId = binding.posterId ?? binding.workerId;
  return row.event_type === 'platform_fee'
    && row.user_id === expectedUserId
    && row.task_id === binding.taskId
    && row.amount_cents === binding.splitPlatformFeeCents
    && row.currency === 'usd'
    && row.gross_amount_cents === binding.releaseAmountCents
    && row.platform_fee_cents === binding.splitPlatformFeeCents
    && row.net_amount_cents === binding.netReleaseAmountCents
    && row.fee_basis_points === binding.platformFeeBasisPoints
    && row.escrow_id === binding.escrowId
    && row.stripe_transfer_id === evidence.provider.transferWitness.transferId
    && metadata !== null
    && Object.keys(metadata).length === 1
    && metadata.event === 'escrow_partial_refund';
}

async function ensureRevenue(evidence: PartialRefundTerminalEvidence): Promise<void> {
  await db.transaction(async (query) => {
    await lockExactTerminalPartialRefundBinding(query, evidence);
    const binding = evidence.binding;
    let result = await query<RevenueRow>(
      `SELECT id,event_type,user_id,task_id,amount_cents,currency,
              gross_amount_cents,platform_fee_cents,net_amount_cents,
              fee_basis_points,escrow_id,stripe_transfer_id,metadata
         FROM revenue_ledger
        WHERE escrow_id=$1 AND event_type='platform_fee'
        FOR SHARE`,
      [binding.escrowId],
    );
    if (binding.splitPlatformFeeCents === 0) {
      if (result.rows.length !== 0) {
        throw partialRefundReconciliationError(
          `partialRefund: zero-fee split has a revenue row for escrow ${binding.escrowId}`,
        );
      }
      await checkpointEffect(query, evidence, 'REVENUE', {
        effect_applied: false,
        effect_reason: 'ZERO_PLATFORM_FEE',
        revenue_ledger_id: null,
      });
      return;
    }
    if (result.rows.length === 0) {
      await assertNoCheckpoint(query, evidence, 'REVENUE');
      const logged = await RevenueService.logEvent({
        eventType: 'platform_fee',
        userId: binding.posterId ?? binding.workerId,
        taskId: binding.taskId,
        amountCents: binding.splitPlatformFeeCents,
        grossAmountCents: binding.releaseAmountCents,
        platformFeeCents: binding.splitPlatformFeeCents,
        netAmountCents: binding.netReleaseAmountCents,
        feeBasisPoints: binding.platformFeeBasisPoints,
        escrowId: binding.escrowId,
        stripeTransferId: evidence.provider.transferWitness.transferId,
        metadata: { event: 'escrow_partial_refund' },
      }, query);
      if (!logged.success) {
        throw partialRefundReconciliationError(
          `partialRefund: revenue ledger failed for escrow ${binding.escrowId}: ${logged.error.message}`,
        );
      }
      result = await query<RevenueRow>(
        `SELECT id,event_type,user_id,task_id,amount_cents,currency,
                gross_amount_cents,platform_fee_cents,net_amount_cents,
                fee_basis_points,escrow_id,stripe_transfer_id,metadata
           FROM revenue_ledger
          WHERE escrow_id=$1 AND event_type='platform_fee'
          FOR SHARE`,
        [binding.escrowId],
      );
    }
    if (result.rows.length !== 1 || !exactRevenueRow(result.rows[0], evidence)) {
      throw partialRefundReconciliationError(
        `partialRefund: revenue ledger conflicts for escrow ${binding.escrowId}`,
      );
    }
    const row = result.rows[0];
    await checkpointEffect(query, evidence, 'REVENUE', {
      effect_applied: true,
      revenue_ledger_id: row.id,
      revenue_amount_cents: row.amount_cents,
      revenue_gross_amount_cents: row.gross_amount_cents,
      revenue_net_amount_cents: row.net_amount_cents,
    });
  });
}

function xpReadback(
  rows: XPRow[],
  evidence: PartialRefundTerminalEvidence,
): { complete: boolean; witness?: Record<string, unknown> } {
  const awards = rows.filter((row) => row.base_xp >= 0 && row.effective_xp >= 0 && row.reason !== XP_REASON);
  const debits = rows.filter((row) => row.reason === XP_REASON);
  if (awards.length > 1 || debits.length > 1) {
    throw partialRefundReconciliationError(
      `partialRefund: XP ledger is ambiguous for escrow ${evidence.binding.escrowId}`,
    );
  }
  const award = awards[0];
  const debit = debits[0];
  if (!award) {
    if (debit) {
      throw partialRefundReconciliationError(
        `partialRefund: XP debit has no source award for escrow ${evidence.binding.escrowId}`,
      );
    }
    return {
      complete: true,
      witness: {
        effect_applied: false,
        effect_reason: 'NO_SOURCE_XP_AWARD',
        xp_source_award_id: null,
        xp_clawback_id: null,
      },
    };
  }
  const expectedBase = -Math.round(award.base_xp * evidence.binding.xpClawbackFraction);
  const expectedEffective = -Math.round(
    award.effective_xp * evidence.binding.xpClawbackFraction,
  );
  if (expectedEffective === 0) {
    if (debit) {
      throw partialRefundReconciliationError(
        `partialRefund: zero-XP split has a debit for escrow ${evidence.binding.escrowId}`,
      );
    }
    return {
      complete: true,
      witness: {
        effect_applied: false,
        effect_reason: 'ZERO_XP_CLAWBACK',
        xp_source_award_id: award.id,
        xp_clawback_id: null,
        xp_expected_base: expectedBase,
        xp_expected_effective: expectedEffective,
      },
    };
  }
  if (!debit) return { complete: false };
  if (
    debit.task_id !== evidence.binding.taskId
    || debit.base_xp !== expectedBase
    || debit.effective_xp !== expectedEffective
  ) {
    throw partialRefundReconciliationError(
      `partialRefund: XP clawback conflicts for escrow ${evidence.binding.escrowId}`,
    );
  }
  return {
    complete: true,
    witness: {
      effect_applied: true,
      xp_source_award_id: award.id,
      xp_clawback_id: debit.id,
      xp_clawback_base: debit.base_xp,
      xp_clawback_effective: debit.effective_xp,
    },
  };
}

async function inspectXP(
  query: QueryFn,
  evidence: PartialRefundTerminalEvidence,
): Promise<boolean> {
  await lockExactTerminalPartialRefundBinding(query, evidence);
  const workerId = evidence.binding.workerId;
  if (!workerId) {
    throw partialRefundReconciliationError(
      `partialRefund: XP effect has no worker for escrow ${evidence.binding.escrowId}`,
    );
  }
  const result = await query<XPRow>(
    `SELECT id,task_id,base_xp,effective_xp,reason
       FROM xp_ledger
      WHERE user_id=$1 AND escrow_id=$2
      ORDER BY awarded_at DESC
      FOR SHARE`,
    [workerId, evidence.binding.escrowId],
  );
  const readback = xpReadback(result.rows, evidence);
  if (!readback.complete) {
    await assertNoCheckpoint(query, evidence, 'XP_CLAWBACK');
    return false;
  }
  await checkpointEffect(query, evidence, 'XP_CLAWBACK', readback.witness!);
  return true;
}

async function ensureXP(evidence: PartialRefundTerminalEvidence): Promise<void> {
  const existing = await db.transaction((query) => inspectXP(query, evidence));
  if (existing) return;
  await XPService.clawbackXP(
    evidence.binding.workerId!,
    evidence.binding.escrowId,
    XP_REASON,
    evidence.binding.xpClawbackFraction,
  );
  const verified = await db.transaction((query) => inspectXP(query, evidence));
  if (!verified) {
    throw partialRefundReconciliationError(
      `partialRefund: XP clawback has no exact readback for escrow ${evidence.binding.escrowId}`,
    );
  }
}

function assertReplayExpectation(
  evidence: PartialRefundTerminalEvidence,
  expected: PartialRefundReplayExpectation,
): void {
  const binding = evidence.binding;
  if (
    binding.escrowId !== expected.escrowId
    || (expected.taskId !== undefined && binding.taskId !== expected.taskId)
    || (expected.disputeId !== undefined && binding.disputeId !== expected.disputeId)
    || (expected.refundAmountCents !== undefined
      && binding.refundAmountCents !== expected.refundAmountCents)
    || (expected.releaseAmountCents !== undefined
      && binding.releaseAmountCents !== expected.releaseAmountCents)
  ) {
    throw partialRefundReconciliationError(
      `partialRefund: retry does not match terminal settlement evidence for escrow ${binding.escrowId}`,
    );
  }
  if (expected.workerPercent !== undefined || expected.posterPercent !== undefined) {
    if (
      expected.workerPercent === undefined
      || expected.posterPercent === undefined
      || expected.workerPercent + expected.posterPercent !== 100
      || Math.round(binding.escrowAmountCents * expected.workerPercent / 100)
        !== binding.releaseAmountCents
      || binding.escrowAmountCents
        - Math.round(binding.escrowAmountCents * expected.workerPercent / 100)
        !== binding.refundAmountCents
      || binding.xpClawbackFraction !== expected.posterPercent / 100
    ) {
      throw partialRefundReconciliationError(
        `partialRefund: retry percentages conflict for escrow ${binding.escrowId}`,
      );
    }
  }
}

export async function reconcilePartialRefundPostTerminal(
  expected: PartialRefundReplayExpectation,
): Promise<PartialRefundTerminalEvidence | null> {
  const evidence = await loadPartialRefundTerminalEvidence(expected.escrowId);
  if (!evidence) return null;
  assertReplayExpectation(evidence, expected);
  try {
    await ensureInsurance(evidence);
    await ensureTaskClosed(evidence);
    await ensureRevenue(evidence);
    await ensureXP(evidence);
    return evidence;
  } catch (error) {
    await persistPartialRefundTransferRecovery({
      binding: evidence.binding,
      witness: evidence.provider.transferWitness,
      transferCreated: evidence.provider.transferCreated,
      failureStage: 'POST_TERMINAL_EFFECT_FAILED',
    });
    throw error;
  }
}

export interface PartialRefundReconciliationBatchResult {
  reconciled: Array<{ escrowId: string; outboxKey: string | null }>;
  failed: Array<{ escrowId: string; error: string }>;
}

/**
 * Permanent recovery sweep for terminal partial settlements. BullMQ delivery
 * retries are finite; this query is deliberately driven by canonical terminal
 * state plus missing per-effect checkpoints so the scheduled maintenance job
 * can resume convergence on every run without repeating processor operations.
 */
export async function reconcileDuePartialRefundEffects(
  requestedLimit = 50,
): Promise<PartialRefundReconciliationBatchResult> {
  const limit = Math.max(1, Math.min(100, Math.trunc(requestedLimit) || 50));
  const candidates = await db.query<{ id: string; outbox_key: string | null }>(
    `SELECT e.id,o.idempotency_key AS outbox_key
       FROM escrows e
       LEFT JOIN outbox_events o
         ON o.aggregate_type='escrow'
        AND o.aggregate_id=e.id
        AND o.event_type='escrow.partial_refund_requested'
        AND o.idempotency_key='escrow.partial_refund_requested:' || e.id::text || ':1'
      WHERE e.state='REFUND_PARTIAL'
        AND EXISTS (
          SELECT 1 FROM escrow_events claim
           WHERE claim.escrow_id=e.id
             AND claim.idempotency_key='partial-refund-provider-claim:' || e.id::text
        )
        AND (
          SELECT COUNT(DISTINCT effect.metadata->>'effect')
            FROM escrow_events effect
           WHERE effect.escrow_id=e.id
             AND effect.metadata->>'event_type'=$1
             AND effect.metadata->>'effect' IN
               ('INSURANCE','TASK_CLOSED','REVENUE','XP_CLAWBACK')
        ) < 4
      ORDER BY e.updated_at ASC,e.id ASC
      LIMIT $2`,
    [EFFECT_CHECKPOINT_EVENT, limit],
  );
  const result: PartialRefundReconciliationBatchResult = {
    reconciled: [],
    failed: [],
  };
  for (const candidate of candidates.rows) {
    try {
      const evidence = await reconcilePartialRefundPostTerminal({
        escrowId: candidate.id,
      });
      if (!evidence) {
        throw partialRefundReconciliationError(
          `partialRefund: due escrow ${candidate.id} is no longer terminal`,
        );
      }
      result.reconciled.push({
        escrowId: candidate.id,
        outboxKey: candidate.outbox_key,
      });
    } catch (error) {
      result.failed.push({
        escrowId: candidate.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
