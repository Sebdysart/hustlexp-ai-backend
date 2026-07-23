import { createHash, createHmac, randomUUID } from 'node:crypto';
import { db, type QueryFn } from '../db.js';
import type { ServiceResult } from '../types.js';

export const CONTROLLED_TEST_DURATION_POLICY_VERSION = 'price-book-duration-v1';
type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;

interface TaskRow {
  id: string;
  state: string;
  worker_id: string | null;
  automation_classification: string | null;
  estimated_duration_minutes: number | null;
}

interface EvidenceRow {
  id: string;
  task_id: string;
  source_quote_version_id: string;
  duration_min_minutes: number;
  duration_expected_minutes: number;
  duration_max_minutes: number;
  policy_version: string;
  source_evidence_hash: string;
  source_environment: 'TEST';
  request_hash: string;
}

export interface ApplyControlledTestDurationEvidenceParams {
  taskId: string;
  actorId: string;
  sourceQuoteVersionId: string;
  minimumMinutes: number;
  expectedMinutes: number;
  maximumMinutes: number;
  policyVersion: string;
  sourceEvidenceHash: string;
  sourceEnvironment: 'TEST' | 'PRODUCTION';
  idempotencyKey: string;
}

export interface ControlledTestDurationEvidenceResult {
  taskId: string;
  evidenceId: string;
  estimatedDurationMinutes: number;
  minimumMinutes: number;
  maximumMinutes: number;
  policyVersion: string;
  sourceQuoteVersionId: string;
  isTest: true;
  idempotencyReplayed: boolean;
}

function failure(code: string, message: string): ServiceResult<never> {
  return { success: false, error: { code, message } };
}

function secret(env: Environment): string {
  return env.HXOS_LOCAL_TEST_DURATION_EVIDENCE_SECRET?.trim() ?? '';
}

export function controlledTestDurationEvidenceEnabled(env: Environment = process.env): boolean {
  return env.NODE_ENV !== 'production'
    && env.HXOS_ALLOW_LOCAL_TEST_DURATION_EVIDENCE === 'true'
    && env.ENGINE_API_MODE === 'test'
    && env.STRIPE_MODE === 'test'
    && secret(env).length >= 32;
}

function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function valid(params: ApplyControlledTestDurationEvidenceParams): boolean {
  return uuid(params.taskId)
    && uuid(params.sourceQuoteVersionId)
    && params.actorId.trim().length >= 1
    && params.actorId.length <= 128
    && Number.isInteger(params.minimumMinutes)
    && Number.isInteger(params.expectedMinutes)
    && Number.isInteger(params.maximumMinutes)
    && params.minimumMinutes >= 15
    && params.minimumMinutes <= params.expectedMinutes
    && params.expectedMinutes <= params.maximumMinutes
    && params.maximumMinutes <= 1440
    && params.policyVersion === CONTROLLED_TEST_DURATION_POLICY_VERSION
    && /^[a-f0-9]{64}$/.test(params.sourceEvidenceHash)
    && params.sourceEnvironment === 'TEST'
    && params.idempotencyKey.length >= 8
    && params.idempotencyKey.length <= 200
    && /^[A-Za-z0-9:_-]+$/.test(params.idempotencyKey);
}

function requestHash(params: ApplyControlledTestDurationEvidenceParams): string {
  return createHash('sha256').update(JSON.stringify({
    taskId: params.taskId,
    sourceQuoteVersionId: params.sourceQuoteVersionId,
    minimumMinutes: params.minimumMinutes,
    expectedMinutes: params.expectedMinutes,
    maximumMinutes: params.maximumMinutes,
    policyVersion: params.policyVersion,
    sourceEvidenceHash: params.sourceEvidenceHash,
    sourceEnvironment: params.sourceEnvironment,
  })).digest('hex');
}

function attestationHash(hash: string, env: Environment = process.env): string {
  return createHmac('sha256', secret(env)).update(hash).digest('hex');
}

function matches(row: EvidenceRow, params: ApplyControlledTestDurationEvidenceParams, hash: string): boolean {
  return row.request_hash === hash
    && row.task_id === params.taskId
    && row.source_quote_version_id === params.sourceQuoteVersionId
    && row.duration_min_minutes === params.minimumMinutes
    && row.duration_expected_minutes === params.expectedMinutes
    && row.duration_max_minutes === params.maximumMinutes
    && row.policy_version === params.policyVersion
    && row.source_evidence_hash === params.sourceEvidenceHash
    && row.source_environment === 'TEST';
}

function result(row: EvidenceRow, replayed: boolean): ControlledTestDurationEvidenceResult {
  return {
    taskId: row.task_id,
    evidenceId: row.id,
    estimatedDurationMinutes: row.duration_expected_minutes,
    minimumMinutes: row.duration_min_minutes,
    maximumMinutes: row.duration_max_minutes,
    policyVersion: row.policy_version,
    sourceQuoteVersionId: row.source_quote_version_id,
    isTest: true,
    idempotencyReplayed: replayed,
  };
}

async function existingEvidence(
  query: QueryFn,
  params: ApplyControlledTestDurationEvidenceParams,
): Promise<EvidenceRow | undefined> {
  const existing = await query<EvidenceRow>(
    `SELECT id,task_id,source_quote_version_id,duration_min_minutes,
            duration_expected_minutes,duration_max_minutes,policy_version,
            source_evidence_hash,source_environment,request_hash
       FROM hxos_local_test_duration_evidence
      WHERE idempotency_key=$1 OR task_id=$2
      ORDER BY (idempotency_key=$1) DESC,created_at DESC LIMIT 1
      FOR SHARE`,
    [params.idempotencyKey, params.taskId],
  );
  return existing.rows[0];
}

export const ControlledTestDurationEvidenceService = {
  apply: async (
    params: ApplyControlledTestDurationEvidenceParams,
  ): Promise<ServiceResult<ControlledTestDurationEvidenceResult>> => {
    if (!controlledTestDurationEvidenceEnabled()) {
      return failure('LOCAL_TEST_DURATION_DISABLED', 'Controlled TEST duration evidence is disabled.');
    }
    if (!valid(params)) {
      return failure('LOCAL_TEST_DURATION_INVALID', 'Controlled TEST duration evidence is invalid.');
    }
    const hash = requestHash(params);
    try {
      return await db.transaction(async (query) => {
        await query(`SELECT pg_advisory_xact_lock(hashtext('local-test-duration'),hashtext($1))`, [params.taskId]);
        const existing = await existingEvidence(query, params);
        if (existing) {
          return matches(existing, params, hash)
            ? { success: true as const, data: result(existing, true) }
            : failure('LOCAL_TEST_DURATION_IDEMPOTENCY_CONFLICT', 'Duration evidence conflicts with the prior request.');
        }
        const taskResult = await query<TaskRow>(
          `SELECT id,state,worker_id,automation_classification,estimated_duration_minutes
             FROM tasks WHERE id=$1 FOR UPDATE`,
          [params.taskId],
        );
        const task = taskResult.rows[0];
        if (!task) return failure('NOT_FOUND', 'Controlled TEST task was not found.');
        if (task.automation_classification !== 'CONTROLLED_TEST'
          || !['OPEN', 'MATCHING'].includes(task.state)
          || task.worker_id !== null
          || (task.estimated_duration_minutes !== null
            && task.estimated_duration_minutes !== params.expectedMinutes)) {
          return failure('LOCAL_TEST_DURATION_TASK_INELIGIBLE', 'Task cannot accept controlled TEST duration evidence.');
        }
        await query(`SELECT set_config('hustlexp.local_test_duration_enabled','true',true)`);
        const evidenceId = randomUUID();
        const inserted = await query<EvidenceRow>(
          `INSERT INTO hxos_local_test_duration_evidence(
             id,task_id,source_quote_version_id,duration_min_minutes,
             duration_expected_minutes,duration_max_minutes,policy_version,
             source_evidence_hash,source_environment,request_hash,attestation_hash,
             prior_duration_minutes,reason,idempotency_key,actor_id,environment,is_test
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'TEST',$9,$10,$11,
             'LEGACY_ACCEPTED_QUOTE_PRICE_BOOK_SUPPLEMENT',$12,$13,'CONTROLLED_TEST',TRUE)
           RETURNING id,task_id,source_quote_version_id,duration_min_minutes,
             duration_expected_minutes,duration_max_minutes,policy_version,
             source_evidence_hash,source_environment,request_hash`,
          [evidenceId, params.taskId, params.sourceQuoteVersionId, params.minimumMinutes,
            params.expectedMinutes, params.maximumMinutes, params.policyVersion,
            params.sourceEvidenceHash, hash, attestationHash(hash), task.estimated_duration_minutes,
            params.idempotencyKey, params.actorId],
        );
        const row = inserted.rows[0];
        if (!row) return failure('LOCAL_TEST_DURATION_EVIDENCE_FAILED', 'Duration evidence was not recorded.');
        const updated = await query(
          `UPDATE tasks SET estimated_duration_minutes=$2,updated_at=NOW()
            WHERE id=$1 AND state IN ('OPEN','MATCHING') AND worker_id IS NULL
              AND automation_classification='CONTROLLED_TEST'
              AND (estimated_duration_minutes IS NULL OR estimated_duration_minutes=$2)
            RETURNING id,estimated_duration_minutes`,
          [params.taskId, params.expectedMinutes],
        );
        if (!updated.rows[0]) return failure('LOCAL_TEST_DURATION_UPDATE_FAILED', 'Task duration could not be applied.');
        return { success: true as const, data: result(row, false) };
      });
    } catch {
      return failure('DB_ERROR', 'Controlled TEST duration evidence could not be recorded.');
    }
  },
};
