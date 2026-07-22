import { createHash } from 'node:crypto';
import { db } from '../db.js';
import { logger } from '../logger.js';
import type { ServiceResult } from '../types.js';
import type { AIObservationContext } from './AIObservabilityPolicy.js';

const log = logger.child({ service: 'AIObservabilityService' });

export type AIObservationReceipt = {
  observationId: string;
  surfaceId: string;
  action: string;
  scopeAffected: string;
  reason: string;
  evidenceClasses: string[];
  expectedBenefit: string;
  uncertainty: string;
  downside: string;
  authorityLevel: string;
  policyVersion: string;
  provider: string;
  modelVersion: string;
  confidenceBand: string;
  controls: Record<string, boolean>;
  outcomeSource: string;
  executionResult: 'GENERATED' | 'CACHED' | 'FAILED';
};

type ObservationRow = {
  id: string;
  surface_id: string;
  affected_object_type: string;
  affected_object_id: string;
  action: string;
  scope_affected: string;
  reason: string;
  evidence_classes: string[];
  expected_benefit: string;
  uncertainty: string;
  downside: string;
  authority_level: string;
  policy_version: string;
  provider: string;
  model_version: string;
  confidence_band: string;
  controls: Record<string, boolean>;
  outcome_source: string;
  execution_result: 'GENERATED' | 'CACHED' | 'FAILED';
  latency_ms: number;
  occurred_at: Date | string;
  recorded_at: Date | string;
};

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

export function aiObservationHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function failure(error: unknown): ServiceResult<never> {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('IDEMPOTENCY_CONFLICT')) {
    return { success: false, error: { code: 'IDEMPOTENCY_CONFLICT', message: 'AI outcome evidence conflicted with an existing event.' } };
  }
  log.error({ err: message }, 'AI observability evidence write failed');
  return { success: false, error: {
    code: 'AI_OBSERVABILITY_REQUIRED',
    message: 'AI output was withheld because its evidence record could not be stored.',
  } };
}

function receipt(row: ObservationRow): AIObservationReceipt {
  return {
    observationId: row.id,
    surfaceId: row.surface_id,
    action: row.action,
    scopeAffected: row.scope_affected,
    reason: row.reason,
    evidenceClasses: row.evidence_classes,
    expectedBenefit: row.expected_benefit,
    uncertainty: row.uncertainty,
    downside: row.downside,
    authorityLevel: row.authority_level,
    policyVersion: row.policy_version,
    provider: row.provider,
    modelVersion: row.model_version,
    confidenceBand: row.confidence_band,
    controls: row.controls,
    outcomeSource: row.outcome_source,
    executionResult: row.execution_result,
  };
}

async function record(input: {
  context: AIObservationContext;
  provider: string;
  modelVersion: string;
  executionResult: 'GENERATED' | 'CACHED' | 'FAILED';
  output: string | null;
  latencyMs: number;
  occurredAt?: string;
}): Promise<ServiceResult<AIObservationReceipt>> {
  try {
    const outputHash = input.output === null ? null : aiObservationHash(input.output);
    const result = await db.query<ObservationRow>(
      `INSERT INTO ai_observation_events (
         surface_id,actor_user_id,affected_object_type,affected_object_id,
         action,scope_affected,reason,evidence_classes,expected_benefit,
         uncertainty,downside,authority_level,policy_version,provider,model_version,
         confidence_band,controls,outcome_source,execution_result,output_hash,latency_ms,occurred_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8::JSONB,$9,$10,$11,$12,$13,$14,$15,$16,
         $17::JSONB,$18,$19,$20,$21,$22
       ) RETURNING *`,
      [
        input.context.surfaceId,
        input.context.actorUserId,
        input.context.affectedObjectType,
        input.context.affectedObjectId,
        input.context.action,
        input.context.scopeAffected,
        input.context.reason,
        JSON.stringify(input.context.evidenceClasses),
        input.context.expectedBenefit,
        input.context.uncertainty,
        input.context.downside,
        input.context.authorityLevel,
        input.context.policyVersion,
        input.provider,
        input.modelVersion,
        input.context.confidenceBand,
        JSON.stringify(input.context.controls),
        input.context.outcomeSource,
        input.executionResult,
        outputHash,
        Math.max(0, Math.round(input.latencyMs)),
        input.occurredAt ?? new Date().toISOString(),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('AI_OBSERVATION_INSERT_FAILED');
    return { success: true, data: receipt(row) };
  } catch (error) {
    return failure(error);
  }
}

async function recordOutcome(input: {
  observationId: string;
  outcomeType: string;
  outcomeObjectType: string;
  outcomeObjectId: string;
  realizedResult: Record<string, unknown>;
  sourceTable: string;
  sourceEventId: string;
  measuredAt?: string;
}): Promise<ServiceResult<{ outcomeId: string }>> {
  const payloadHash = aiObservationHash(input);
  try {
    const result = await db.query<{ id: string; payload_hash: string; inserted: boolean }>(
      `WITH inserted AS (
         INSERT INTO ai_observation_outcomes (
           observation_id,outcome_type,outcome_object_type,outcome_object_id,
           realized_result,source_table,source_event_id,payload_hash,measured_at
         ) VALUES ($1,$2,$3,$4,$5::JSONB,$6,$7,$8,$9)
         ON CONFLICT (observation_id,outcome_type,source_event_id) DO NOTHING
         RETURNING id,payload_hash,TRUE AS inserted
       )
       SELECT id,payload_hash,inserted FROM inserted
       UNION ALL
       SELECT id,payload_hash,FALSE AS inserted FROM ai_observation_outcomes
        WHERE observation_id=$1 AND outcome_type=$2 AND source_event_id=$7
       LIMIT 1`,
      [
        input.observationId,
        input.outcomeType,
        input.outcomeObjectType,
        input.outcomeObjectId,
        JSON.stringify(input.realizedResult),
        input.sourceTable,
        input.sourceEventId,
        payloadHash,
        input.measuredAt ?? new Date().toISOString(),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('AI_OBSERVATION_OUTCOME_INSERT_FAILED');
    if (row.inserted === false && row.payload_hash !== payloadHash) throw new Error('IDEMPOTENCY_CONFLICT');
    return { success: true, data: { outcomeId: row.id } };
  } catch (error) {
    return failure(error);
  }
}

async function recordUserResponse(input: {
  observationId: string;
  actorUserId: string;
  action: 'ACCEPTED' | 'EDITED' | 'DISMISSED' | 'SNOOZED' | 'OVERRIDDEN';
  editedFields: string[];
  idempotencyKey: string;
}): Promise<ServiceResult<{ outcomeId: string }>> {
  try {
    const allowed = await db.readQuery<{ id: string }>(
      `SELECT id FROM ai_observation_events
        WHERE id=$1 AND actor_user_id=$2 AND surface_id='AI-SCOPER-PROPOSAL'
          AND execution_result IN ('GENERATED','CACHED')`,
      [input.observationId, input.actorUserId],
    );
    if (!allowed.rows[0]) {
      return { success: false, error: {
        code: 'AI_OBSERVATION_NOT_FOUND',
        message: 'That scope proposal is unavailable or belongs to another user.',
      } };
    }
    return recordOutcome({
      observationId: input.observationId,
      outcomeType: `USER_${input.action}`,
      outcomeObjectType: 'TASK_DRAFT',
      outcomeObjectId: input.observationId,
      realizedResult: {
        userAction: input.action,
        editedFields: [...new Set(input.editedFields)].sort(),
        automaticStateChange: false,
        rankingPenalty: 0,
      },
      sourceTable: 'ai_observation_events',
      sourceEventId: `${input.observationId}:${input.idempotencyKey}`,
    });
  } catch (error) {
    return failure(error);
  }
}

async function list(input: {
  surfaceId?: string;
  executionResult?: 'GENERATED' | 'CACHED' | 'FAILED';
  limit: number;
  offset: number;
}) {
  const result = await db.query<ObservationRow>(
    `SELECT * FROM ai_observation_events
      WHERE ($1::TEXT IS NULL OR surface_id=$1)
        AND ($2::TEXT IS NULL OR execution_result=$2)
      ORDER BY occurred_at DESC,id DESC LIMIT $3 OFFSET $4`,
    [input.surfaceId ?? null, input.executionResult ?? null, input.limit, input.offset],
  );
  return result.rows.map((row) => ({
    ...receipt(row),
    affectedObjectType: row.affected_object_type,
    affectedObjectId: row.affected_object_id,
    latencyMs: row.latency_ms,
    occurredAt: new Date(row.occurred_at).toISOString(),
    recordedAt: new Date(row.recorded_at).toISOString(),
  }));
}

async function getDetail(observationId: string, purpose: string, adminUserId: string) {
  return db.transaction(async (query) => {
    const [event, outcomes] = await Promise.all([
      query<ObservationRow>('SELECT * FROM ai_observation_events WHERE id=$1', [observationId]),
      query(
        `SELECT id,outcome_type,outcome_object_type,outcome_object_id,realized_result,
                source_table,source_event_id,measured_at,recorded_at
           FROM ai_observation_outcomes WHERE observation_id=$1
          ORDER BY measured_at,id`,
        [observationId],
      ),
    ]);
    const row = event.rows[0];
    if (!row) return null;
    await query(
      `INSERT INTO ai_observation_access_log (observation_id,admin_user_id,purpose)
       VALUES ($1,$2,$3)`,
      [observationId, adminUserId, purpose],
    );
    return {
      ...receipt(row),
      affectedObjectType: row.affected_object_type,
      affectedObjectId: row.affected_object_id,
      latencyMs: row.latency_ms,
      occurredAt: new Date(row.occurred_at).toISOString(),
      recordedAt: new Date(row.recorded_at).toISOString(),
      outcomes: outcomes.rows,
      operatorAccessRecorded: true as const,
    };
  });
}

export const AIObservabilityService = {
  record,
  recordOutcome,
  recordUserResponse,
  list,
  getDetail,
};

export default AIObservabilityService;
