/**
 * Durable AI provider-attempt authority.
 *
 * Redis owns atomic daily ceilings; PostgreSQL owns append-only attempt facts.
 * There is intentionally no distributed-transaction claim. A failed durable
 * transition leaves the Redis reservation conservative and blocks fallback.
 */

import { createHash } from 'node:crypto';
import { db } from '../db.js';
import {
  abortAIProviderSpendBeforeIO,
  markAIProviderSpendUnknown,
  releaseAIProviderSpend,
  reserveAIProviderSpend,
  settleAIProviderSpend,
  type AIReservationMutation,
  type AIReservationRequest,
  type AIReservationResult,
} from './UserAIBudget.js';

export interface AIProviderAttempt {
  reservation: AIReservationRequest;
  providerKind: string;
  providerModel: string;
}

type TerminalTransition = 'UNKNOWN' | 'SETTLED' | 'RELEASED';

interface LedgerRow {
  operation_id: string;
  attempt_id: string;
  transition: 'RESERVED' | TerminalTransition;
  agent_type: string;
  subject_ref_hash: string;
  provider_kind: string;
  provider_model: string;
  request_fingerprint: string;
  budget_day: string;
  reserved_cents: number;
  actual_cost_cents: number | null;
  detail_code: string | null;
}

function assertAttempt(input: AIProviderAttempt): void {
  for (const [field, value, max] of [
    ['provider_kind', input.providerKind, 128],
    ['provider_model', input.providerModel, 256],
  ] as const) {
    if (!value || value.trim() !== value || value.length > max) {
      throw new Error(`AI_SPEND_LEDGER_INVALID_${field.toUpperCase()}`);
    }
  }
}

function subjectHash(subject: string): string {
  return createHash('sha256').update(subject).digest('hex');
}

function assertCanonicalRow(
  row: LedgerRow | undefined,
  input: AIProviderAttempt,
  transition: 'RESERVED' | TerminalTransition,
  budgetDay: string | undefined,
  actualCostCents: number | null,
  detailCode: string | null,
): void {
  const { reservation } = input;
  if (
    !row
    || row.operation_id !== reservation.operationId
    || row.attempt_id !== reservation.attemptId
    || row.transition !== transition
    || row.agent_type !== reservation.agent
    || row.subject_ref_hash !== subjectHash(reservation.userId)
    || row.provider_kind !== input.providerKind
    || row.provider_model !== input.providerModel
    || row.request_fingerprint !== reservation.fingerprint
    || (budgetDay !== undefined && String(row.budget_day) !== budgetDay)
    || Number(row.reserved_cents) !== reservation.reserveCents
    || (row.actual_cost_cents === null ? null : Number(row.actual_cost_cents)) !== actualCostCents
    || row.detail_code !== detailCode
  ) {
    throw new Error(`AI_SPEND_LEDGER_${transition}_CONFLICT`);
  }
}

async function appendReserved(input: AIProviderAttempt, budgetDay: string): Promise<void> {
  assertAttempt(input);
  if (!/^\d+$/u.test(budgetDay)) throw new Error('AI_SPEND_LEDGER_INVALID_BUDGET_DAY');
  const { reservation } = input;
  const result = await db.query<LedgerRow>(
    `WITH inserted AS (
       INSERT INTO public.ai_spend_attempt_events (
         operation_id, attempt_id, transition, agent_type, subject_ref_hash,
         provider_kind, provider_model, request_fingerprint, budget_day,
         reserved_cents, actual_cost_cents, detail_code
       ) VALUES ($1,$2,'RESERVED',$3,$4,$5,$6,$7,$8,$9,NULL,NULL)
       ON CONFLICT (operation_id, attempt_id, transition) DO NOTHING
       RETURNING operation_id,attempt_id,transition,agent_type,subject_ref_hash,
                 provider_kind,provider_model,request_fingerprint,budget_day,
                 reserved_cents,actual_cost_cents,detail_code
     )
     SELECT * FROM inserted
     UNION ALL
     SELECT operation_id,attempt_id,transition,agent_type,subject_ref_hash,
            provider_kind,provider_model,request_fingerprint,budget_day,
            reserved_cents,actual_cost_cents,detail_code
     FROM public.ai_spend_attempt_events
     WHERE operation_id=$1 AND attempt_id=$2 AND transition='RESERVED'
       AND NOT EXISTS (SELECT 1 FROM inserted)
     LIMIT 1`,
    [
      reservation.operationId,
      reservation.attemptId,
      reservation.agent,
      subjectHash(reservation.userId),
      input.providerKind,
      input.providerModel,
      reservation.fingerprint,
      budgetDay,
      reservation.reserveCents,
    ],
  );
  assertCanonicalRow(result.rows[0], input, 'RESERVED', budgetDay, null, null);
}

async function appendTerminal(
  input: AIProviderAttempt,
  transition: TerminalTransition,
  actualCostCents: number | null,
  detailCode: string | null,
): Promise<void> {
  assertAttempt(input);
  if (detailCode !== null && (!/^[A-Z0-9_:-]+$/u.test(detailCode) || detailCode.length > 128)) {
    throw new Error('AI_SPEND_LEDGER_INVALID_DETAIL_CODE');
  }
  const { reservation } = input;
  const result = await db.query<LedgerRow>(
    `WITH reserved AS (
       SELECT operation_id,attempt_id,agent_type,subject_ref_hash,provider_kind,
              provider_model,request_fingerprint,budget_day,reserved_cents
       FROM public.ai_spend_attempt_events
       WHERE operation_id=$1 AND attempt_id=$2 AND transition='RESERVED'
         AND request_fingerprint=$3
         AND agent_type=$7 AND subject_ref_hash=$8
         AND provider_kind=$9 AND provider_model=$10 AND reserved_cents=$11
     ), inserted AS (
       INSERT INTO public.ai_spend_attempt_events (
         operation_id,attempt_id,transition,agent_type,subject_ref_hash,
         provider_kind,provider_model,request_fingerprint,budget_day,
         reserved_cents,actual_cost_cents,detail_code
       )
       SELECT operation_id,attempt_id,$4,agent_type,subject_ref_hash,
              provider_kind,provider_model,request_fingerprint,budget_day,
              reserved_cents,$5,$6
       FROM reserved
       ON CONFLICT (operation_id, attempt_id, transition) DO NOTHING
       RETURNING operation_id,attempt_id,transition,agent_type,subject_ref_hash,
                 provider_kind,provider_model,request_fingerprint,budget_day,
                 reserved_cents,actual_cost_cents,detail_code
     )
     SELECT * FROM inserted
     UNION ALL
     SELECT operation_id,attempt_id,transition,agent_type,subject_ref_hash,
            provider_kind,provider_model,request_fingerprint,budget_day,
            reserved_cents,actual_cost_cents,detail_code
     FROM public.ai_spend_attempt_events
     WHERE operation_id=$1 AND attempt_id=$2 AND transition=$4
       AND NOT EXISTS (SELECT 1 FROM inserted)
     LIMIT 1`,
    [
      reservation.operationId, reservation.attemptId, reservation.fingerprint,
      transition, actualCostCents, detailCode, reservation.agent,
      subjectHash(reservation.userId), input.providerKind, input.providerModel,
      reservation.reserveCents,
    ],
  );
  assertCanonicalRow(result.rows[0], input, transition, undefined, actualCostCents, detailCode);
}

export async function reserveAIProviderAttempt(input: AIProviderAttempt): Promise<AIReservationResult> {
  const authority = await reserveAIProviderSpend(input.reservation);
  if (authority.status !== 'reserved') return authority;
  try {
    await appendReserved(input, authority.budgetDay);
  } catch (ledgerError) {
    // Provider I/O has not started. Release if possible; if Redis is also
    // unavailable, retaining the reservation is the conservative outcome.
    try {
      await abortAIProviderSpendBeforeIO(input.reservation);
    } catch (releaseError) {
      throw new AggregateError(
        [ledgerError, releaseError],
        'AI_SPEND_RESERVED_LEDGER_REQUIRED_RESERVATION_RETAINED',
      );
    }
    throw new Error('AI_SPEND_RESERVED_LEDGER_REQUIRED_RESERVATION_RELEASED', { cause: ledgerError });
  }
  return authority;
}

export async function settleAIProviderAttempt(
  input: AIProviderAttempt & { actualCostCents: number; resultJson: string },
): Promise<void> {
  await appendTerminal(input, 'SETTLED', input.actualCostCents, null);
  const mutation: AIReservationMutation = {
    ...input.reservation,
    actualCostCents: input.actualCostCents,
    resultJson: input.resultJson,
  };
  await settleAIProviderSpend(mutation);
}

export async function markAIProviderAttemptUnknown(
  input: AIProviderAttempt,
  detailCode = 'PROVIDER_OUTCOME_UNKNOWN',
): Promise<void> {
  await appendTerminal(input, 'UNKNOWN', null, detailCode);
  await markAIProviderSpendUnknown(input.reservation);
}

export async function releaseAIProviderAttempt(
  input: AIProviderAttempt,
  detailCode = 'PROVEN_NO_PROVIDER_IO',
): Promise<void> {
  await appendTerminal(input, 'RELEASED', null, detailCode);
  await releaseAIProviderSpend(input.reservation);
}
