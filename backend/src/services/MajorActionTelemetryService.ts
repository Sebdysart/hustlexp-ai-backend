import { createHash } from 'node:crypto';
import { db, type QueryFn } from '../db.js';
import { logger } from '../logger.js';
import type { ServiceResult } from '../types.js';
import type {
  MajorActionOutcomeInput,
  MajorActionRecordInput,
} from './MajorActionTelemetryTypes.js';

const log = logger.child({ service: 'MajorActionTelemetryService' });

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

export function majorActionPayloadHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function failure(error: unknown): ServiceResult<never> {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('HXOBS2') || message.includes('HXOBS4')) {
    return {
      success: false,
      error: {
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'That telemetry key was already used for different evidence.',
      },
    };
  }
  log.error({ err: message }, 'Major-action evidence write failed');
  return {
    success: false,
    error: {
      code: 'MAJOR_ACTION_AUDIT_FAILED',
      message: 'The action could not be recorded safely.',
    },
  };
}

async function recordWithQuery(
  query: QueryFn,
  input: MajorActionRecordInput,
): Promise<ServiceResult<{ eventId: string }>> {
  if (input.experimentApplicable && !input.experimentVariant) {
    return failure(new Error('EXPERIMENT_VARIANT_REQUIRED'));
  }
  const experimentVariant = input.experimentApplicable
    ? input.experimentVariant!
    : 'NOT_APPLICABLE';
  const payloadHash = majorActionPayloadHash({
    schemaVersion: 'hxos-major-action-v1',
    ...input,
    experimentVariant,
  });
  try {
    const result = await query<{ event_id: string }>(
      `SELECT record_major_action_event(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::uuid,$16,$17,
         $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34
       )::text AS event_id`,
      [
        input.eventName,
        input.actionClass,
        input.automationClass,
        input.actorRole,
        input.actorRef,
        input.aggregateType,
        input.aggregateId,
        input.previousLifecycleState,
        input.lifecycleState,
        input.syncState,
        input.entrySurface,
        input.contextSource,
        input.policyVersion,
        input.policyApplicability,
        input.recommendationId ?? null,
        input.modelVersion,
        input.modelApplicability,
        input.riskClass,
        input.correlationId,
        input.causationId,
        input.idempotencyKey,
        input.sourceSequence ?? null,
        payloadHash,
        input.result,
        input.failureReasonCode ?? null,
        input.recoveryActionCode ?? null,
        input.changeReasonCode,
        experimentVariant,
        input.experimentApplicable ? 'APPLIED' : 'NOT_APPLICABLE',
        input.reversible,
        input.sourceTable,
        input.sourceEventId,
        input.occurredAt,
        input.eventVersion ?? 1,
      ],
    );
    const eventId = result.rows[0]?.event_id;
    if (!eventId) throw new Error('MAJOR_ACTION_INSERT_FAILED');
    return { success: true, data: { eventId } };
  } catch (error) {
    return failure(error);
  }
}

async function record(
  input: MajorActionRecordInput,
): Promise<ServiceResult<{ eventId: string }>> {
  return recordWithQuery(db.query, input);
}

async function recordOutcomeWithQuery(
  query: QueryFn,
  input: MajorActionOutcomeInput,
): Promise<ServiceResult<{ outcomeId: string }>> {
  const payloadHash = majorActionPayloadHash({
    schemaVersion: 'hxos-major-action-outcome-v1',
    ...input,
  });
  try {
    const result = await query<{ outcome_id: string }>(
      `SELECT record_major_action_outcome(
         $1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
       )::text AS outcome_id`,
      [
        input.majorActionEventId,
        input.outcomeType,
        input.outcomeObjectType,
        input.outcomeObjectId,
        input.realizedResult,
        input.realizedAmountCents ?? null,
        input.currency ?? null,
        payloadHash,
        input.sourceTable,
        input.sourceEventId,
        input.measuredAt,
      ],
    );
    const outcomeId = result.rows[0]?.outcome_id;
    if (!outcomeId) throw new Error('MAJOR_ACTION_OUTCOME_INSERT_FAILED');
    return { success: true, data: { outcomeId } };
  } catch (error) {
    return failure(error);
  }
}

async function recordOutcome(
  input: MajorActionOutcomeInput,
): Promise<ServiceResult<{ outcomeId: string }>> {
  return recordOutcomeWithQuery(db.query, input);
}

export const MajorActionTelemetryService = {
  record,
  recordWithQuery,
  recordOutcome,
  recordOutcomeWithQuery,
};

export default MajorActionTelemetryService;
