import { db, type QueryFn } from '../db.js';
import { logger } from '../logger.js';
import type { ServiceResult } from '../types.js';
import { recommendationRequestHash } from './RecommendationPolicy.js';
import type {
  RecommendationEventType,
  RecommendationOutcomeType,
  RecommendationRecordInput,
} from './RecommendationTypes.js';

const log = logger.child({ service: 'RecommendationService' });

type RecommendationRow = {
  id: string;
  request_hash: string;
  inserted?: boolean;
};

type RecommendationViewRow = {
  id: string;
  subject_type: string;
  subject_id: string;
  recommendation_class: string;
  source_type: string;
  recommendation_text: string;
  reason: string;
  evidence_classes: string[];
  expected_benefit: string;
  downside: string;
  confidence_band: string;
  model_version: string | null;
  policy_version: string;
  scope_affected: string;
  user_controls: Record<string, boolean>;
  autonomy_level: 'RECOMMEND_ONLY';
  displayed_at: Date;
  expires_at: Date;
  latest_action: RecommendationEventType | null;
  latest_action_at: Date | null;
  outcomes: Array<{
    outcomeType: RecommendationOutcomeType;
    realizedValue: Record<string, unknown>;
    measuredAt: string;
  }>;
};

export type RecommendationView = {
  id: string;
  subjectType: string;
  subjectId: string;
  recommendationClass: string;
  sourceType: string;
  recommendationText: string;
  reason: string;
  evidenceClasses: string[];
  expectedBenefit: string;
  downside: string;
  confidenceBand: string;
  modelVersion: string | null;
  policyVersion: string;
  scopeAffected: string;
  userControls: Record<string, boolean>;
  autonomyLevel: 'RECOMMEND_ONLY';
  displayedAt: string;
  expiresAt: string;
  latestAction: RecommendationEventType | null;
  latestActionAt: string | null;
  outcomes: RecommendationViewRow['outcomes'];
};

function failure(error: unknown): ServiceResult<never> {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('IDEMPOTENCY_CONFLICT')) {
    return { success: false, error: {
      code: 'IDEMPOTENCY_CONFLICT',
      message: 'That recommendation key was already used for different content.',
    } };
  }
  log.error({ err: message }, 'Recommendation evidence write failed');
  return { success: false, error: {
    code: 'RECOMMENDATION_AUDIT_FAILED',
    message: 'The recommendation could not be recorded safely.',
  } };
}

async function insertRecommendation(
  query: QueryFn,
  input: RecommendationRecordInput,
): Promise<{ recommendationId: string; subjectId: string }> {
  const requestHash = recommendationRequestHash(input);
  const result = await query<RecommendationRow>(
    `WITH inserted AS (
       INSERT INTO recommendations (
         recipient_user_id,subject_type,subject_id,recommendation_class,source_type,
         recommendation_text,reason,evidence_classes,expected_benefit,downside,
         confidence_band,model_version,policy_version,scope_affected,user_controls,
         ai_observation_id,request_hash,idempotency_key,expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19)
       ON CONFLICT (recipient_user_id,idempotency_key) DO NOTHING
       RETURNING id,request_hash,TRUE AS inserted
     )
     SELECT id,request_hash,inserted FROM inserted
     UNION ALL
     SELECT id,request_hash,FALSE AS inserted FROM recommendations
      WHERE recipient_user_id=$1 AND idempotency_key=$18
     LIMIT 1`,
    [
      input.recipientUserId, input.subjectType, input.subjectId,
      input.recommendationClass, input.sourceType, input.recommendationText,
      input.reason, JSON.stringify(input.evidenceClasses), input.expectedBenefit,
      input.downside, input.confidenceBand, input.modelVersion, input.policyVersion,
      input.scopeAffected, JSON.stringify(input.userControls), input.aiObservationId,
      requestHash, input.idempotencyKey, input.expiresAt,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('RECOMMENDATION_INSERT_FAILED');
  if (row.inserted === false && row.request_hash !== requestHash) {
    throw new Error('IDEMPOTENCY_CONFLICT');
  }
  const eventHash = recommendationRequestHash({
    recommendationId: row.id,
    eventType: 'DISPLAYED',
    idempotencyKey: `displayed:${input.idempotencyKey}`,
  });
  await query(
    `INSERT INTO recommendation_events (
       recommendation_id,actor_id,event_type,idempotency_key,request_hash,ranking_penalty
     ) VALUES ($1,$2,'DISPLAYED',$3,$4,0)
     ON CONFLICT (recommendation_id,idempotency_key) DO NOTHING`,
    [row.id, input.recipientUserId, `displayed:${input.idempotencyKey}`, eventHash],
  );
  return { recommendationId: row.id, subjectId: input.subjectId };
}

async function recordDisplayedBatch(
  inputs: RecommendationRecordInput[],
): Promise<ServiceResult<Array<{ recommendationId: string; subjectId: string }>>> {
  if (inputs.length === 0) return { success: true, data: [] };
  try {
    const data = await db.transaction(async (query) => {
      const recorded = [];
      for (const input of inputs) recorded.push(await insertRecommendation(query, input));
      return recorded;
    });
    return { success: true, data };
  } catch (error) {
    return failure(error);
  }
}

async function recordUserEvent(input: {
  actorId: string;
  recommendationId: string;
  eventType: RecommendationEventType;
  idempotencyKey: string;
  publicNote: string | null;
}): Promise<ServiceResult<{ eventId: string; rankingPenalty: 0 }>> {
  const requestHash = recommendationRequestHash(input);
  try {
    const result = await db.query<{
      id: string;
      request_hash: string;
      ranking_penalty: number;
      inserted: boolean;
    }>(
      `WITH target AS (
         SELECT id FROM recommendations
         WHERE id=$1 AND recipient_user_id = $2 AND expires_at > NOW()
       ), inserted AS (
         INSERT INTO recommendation_events (
           recommendation_id,actor_id,event_type,idempotency_key,request_hash,public_note,ranking_penalty
         )
         SELECT id,$2,$3,$4,$5,$6,0 FROM target
         ON CONFLICT (recommendation_id,idempotency_key) DO NOTHING
         RETURNING id,request_hash,ranking_penalty,TRUE AS inserted
       )
       SELECT id,request_hash,ranking_penalty,inserted FROM inserted
       UNION ALL
       SELECT event.id,event.request_hash,event.ranking_penalty,FALSE AS inserted
       FROM recommendation_events event
       JOIN target ON target.id=event.recommendation_id
       WHERE event.idempotency_key=$4
       LIMIT 1`,
      [
        input.recommendationId, input.actorId, input.eventType,
        input.idempotencyKey, requestHash, input.publicNote,
      ],
    );
    const row = result.rows[0];
    if (!row) return { success: false, error: {
      code: 'RECOMMENDATION_NOT_FOUND',
      message: 'That recommendation is unavailable or expired.',
    } };
    if (row.inserted === false && row.request_hash !== requestHash) {
      throw new Error('IDEMPOTENCY_CONFLICT');
    }
    return { success: true, data: { eventId: row.id, rankingPenalty: 0 } };
  } catch (error) {
    return failure(error);
  }
}

async function recordOutcome(input: {
  recommendationId: string;
  outcomeType: RecommendationOutcomeType;
  sourceObjectId: string;
  realizedValue: Record<string, unknown>;
}): Promise<ServiceResult<{ outcomeId: string }>> {
  const requestHash = recommendationRequestHash(input);
  try {
    const result = await db.query<{ id: string; request_hash: string; inserted: boolean }>(
      `WITH inserted AS (
         INSERT INTO recommendation_outcomes (
           recommendation_id,outcome_type,source_object_id,realized_value,request_hash
         ) VALUES ($1,$2,$3,$4::jsonb,$5)
         ON CONFLICT (recommendation_id,outcome_type,source_object_id) DO NOTHING
         RETURNING id,request_hash,TRUE AS inserted
       )
       SELECT id,request_hash,inserted FROM inserted
       UNION ALL
       SELECT id,request_hash,FALSE AS inserted FROM recommendation_outcomes
       WHERE recommendation_id=$1 AND outcome_type=$2 AND source_object_id=$3
       LIMIT 1`,
      [
        input.recommendationId, input.outcomeType, input.sourceObjectId,
        JSON.stringify(input.realizedValue), requestHash,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('RECOMMENDATION_OUTCOME_INSERT_FAILED');
    if (row.inserted === false && row.request_hash !== requestHash) {
      throw new Error('IDEMPOTENCY_CONFLICT');
    }
    return { success: true, data: { outcomeId: row.id } };
  } catch (error) {
    return failure(error);
  }
}

async function recordTaskOutcome(
  query: QueryFn,
  input: {
    taskId: string;
    outcomeType: RecommendationOutcomeType;
    realizedValue: Record<string, unknown>;
  },
): Promise<void> {
  const requestHash = recommendationRequestHash(input);
  await query(
    `INSERT INTO recommendation_outcomes (
       recommendation_id,outcome_type,source_object_id,realized_value,request_hash
     )
     SELECT recommendation.id,$2,$1,$3::jsonb,$4
     FROM recommendations recommendation
     WHERE recommendation.subject_type = 'TASK' AND recommendation.subject_id = $1
     ON CONFLICT (recommendation_id,outcome_type,source_object_id) DO NOTHING`,
    [input.taskId, input.outcomeType, JSON.stringify(input.realizedValue), requestHash],
  );
  const conflicts = await query<{ conflict_count: string }>(
    `SELECT COUNT(*) FILTER (WHERE outcome.request_hash <> $3)::text AS conflict_count
     FROM recommendation_outcomes outcome
     JOIN recommendations recommendation ON recommendation.id=outcome.recommendation_id
     WHERE recommendation.subject_type = 'TASK' AND recommendation.subject_id = $1
       AND outcome.outcome_type=$2 AND outcome.source_object_id=$1`,
    [input.taskId, input.outcomeType, requestHash],
  );
  if (Number(conflicts.rows[0]?.conflict_count ?? 0) > 0) {
    throw new Error('IDEMPOTENCY_CONFLICT');
  }
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function listCurrent(
  recipientUserId: string,
  pagination: { limit: number; offset: number },
): Promise<ServiceResult<RecommendationView[]>> {
  try {
    const result = await db.query<RecommendationViewRow>(
      `SELECT recommendation.id,recommendation.subject_type,recommendation.subject_id,
              recommendation.recommendation_class,recommendation.source_type,
              recommendation.recommendation_text,recommendation.reason,
              recommendation.evidence_classes,recommendation.expected_benefit,
              recommendation.downside,recommendation.confidence_band,
              recommendation.model_version,recommendation.policy_version,
              recommendation.scope_affected,recommendation.user_controls,
              recommendation.autonomy_level,recommendation.displayed_at,
              recommendation.expires_at,
              latest.event_type AS latest_action,latest.created_at AS latest_action_at,
              COALESCE(outcome.items,'[]'::jsonb) AS outcomes
       FROM recommendations recommendation
       LEFT JOIN LATERAL (
         SELECT event_type,created_at FROM recommendation_events
         WHERE recommendation_id=recommendation.id AND event_type <> 'DISPLAYED'
         ORDER BY created_at DESC,id DESC LIMIT 1
       ) latest ON TRUE
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'outcomeType',outcome_type,
           'realizedValue',realized_value,
           'measuredAt',measured_at
         ) ORDER BY measured_at,id) AS items
         FROM recommendation_outcomes WHERE recommendation_id=recommendation.id
       ) outcome ON TRUE
       WHERE recipient_user_id=$1 AND expires_at > NOW()
       ORDER BY displayed_at DESC,id DESC
       LIMIT $2 OFFSET $3`,
      [recipientUserId, pagination.limit, pagination.offset],
    );
    return {
      success: true,
      data: result.rows.map((row) => ({
        id: row.id,
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        recommendationClass: row.recommendation_class,
        sourceType: row.source_type,
        recommendationText: row.recommendation_text,
        reason: row.reason,
        evidenceClasses: row.evidence_classes,
        expectedBenefit: row.expected_benefit,
        downside: row.downside,
        confidenceBand: row.confidence_band,
        modelVersion: row.model_version,
        policyVersion: row.policy_version,
        scopeAffected: row.scope_affected,
        userControls: row.user_controls,
        autonomyLevel: row.autonomy_level,
        displayedAt: iso(row.displayed_at),
        expiresAt: iso(row.expires_at),
        latestAction: row.latest_action,
        latestActionAt: row.latest_action_at ? iso(row.latest_action_at) : null,
        outcomes: row.outcomes,
      })),
    };
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'Recommendation read failed');
    return { success: false, error: {
      code: 'RECOMMENDATION_READ_FAILED',
      message: 'Recommendations are temporarily unavailable.',
    } };
  }
}

export const RecommendationService = {
  recordDisplayedBatch,
  recordUserEvent,
  recordOutcome,
  recordTaskOutcome,
  listCurrent,
};
