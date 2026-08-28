import { createHash, createHmac, randomUUID } from 'node:crypto';
import { db, type QueryFn } from '../db.js';
import type { ServiceResult } from '../types.js';

export const CONTROLLED_TEST_PROVIDER_CAPABILITY_POLICY_VERSION = 'hxos-local-test-provider-capability-v1';
type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;

interface TaskRow {
  id: string;
  state: string;
  worker_id: string | null;
  category: string;
  rough_location: string | null;
  region_code: string | null;
  automation_classification: string | null;
}

interface WorkerRow {
  id: string;
  default_mode: string;
  account_status: string;
  is_minor: boolean;
  is_banned: boolean | null;
  location_city: string | null;
  location_state: string | null;
}

interface EvidenceRow {
  id: string;
  task_id: string;
  worker_id: string;
  category: string;
  tools: string[];
  service_city: string;
  service_state: string;
  service_radius_miles: number;
  source_hustler_id: string;
  source_policy_version: string;
  source_evidence_hash: string;
  source_expires_at: string | Date;
  request_hash: string;
}

export interface RecordControlledTestProviderCapabilityParams {
  taskId: string;
  workerId: string;
  actorId: string;
  sourceHustlerId: string;
  category: string;
  tools: string[];
  serviceCity: string;
  serviceState: string;
  serviceRadiusMiles: number;
  sourcePolicyVersion: string;
  sourceEvidenceHash: string;
  sourceExpiresAt: string;
  idempotencyKey: string;
}

function failure(code: string, message: string): ServiceResult<never> {
  return { success: false, error: { code, message } };
}

function secret(env: Environment): string {
  return env.HXOS_LOCAL_TEST_PROVIDER_CAPABILITY_SECRET?.trim() ?? '';
}

export function controlledTestProviderCapabilityEnabled(env: Environment = process.env): boolean {
  return env.NODE_ENV !== 'production'
    && env.HXOS_ALLOW_LOCAL_TEST_PROVIDER_CAPABILITY === 'true'
    && env.ENGINE_API_MODE === 'test'
    && env.STRIPE_MODE === 'test'
    && secret(env).length >= 32;
}

function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizedTools(tools: string[]): string[] {
  return [...new Set(tools.map(tool => tool.trim().toLowerCase()).filter(Boolean))].sort();
}

function valid(params: RecordControlledTestProviderCapabilityParams): boolean {
  const tools = normalizedTools(params.tools);
  const sourceExpiry = Date.parse(params.sourceExpiresAt);
  return uuid(params.taskId)
    && uuid(params.workerId)
    && uuid(params.sourceHustlerId)
    && params.actorId.trim().length >= 1
    && params.actorId.length <= 128
    && /^[a-z0-9][a-z0-9_-]{0,99}$/.test(params.category)
    && tools.length >= 1
    && tools.length <= 20
    && tools.every(tool => tool.length <= 100)
    && params.serviceCity.trim().length >= 2
    && params.serviceCity.length <= 100
    && /^[A-Z]{2}$/.test(params.serviceState)
    && Number.isInteger(params.serviceRadiusMiles)
    && params.serviceRadiusMiles >= 1
    && params.serviceRadiusMiles <= 100
    && params.sourcePolicyVersion.trim().length >= 1
    && params.sourcePolicyVersion.length <= 100
    && /^[a-f0-9]{64}$/.test(params.sourceEvidenceHash)
    && Number.isFinite(sourceExpiry)
    && sourceExpiry > Date.now()
    && sourceExpiry <= Date.now() + 4 * 60 * 60 * 1000
    && params.idempotencyKey.length >= 8
    && params.idempotencyKey.length <= 200
    && /^[A-Za-z0-9:_-]+$/.test(params.idempotencyKey);
}

function requestHash(params: RecordControlledTestProviderCapabilityParams): string {
  return createHash('sha256').update(JSON.stringify({
    taskId: params.taskId,
    workerId: params.workerId,
    sourceHustlerId: params.sourceHustlerId,
    category: params.category,
    tools: normalizedTools(params.tools),
    serviceCity: params.serviceCity.trim(),
    serviceState: params.serviceState,
    serviceRadiusMiles: params.serviceRadiusMiles,
    sourcePolicyVersion: params.sourcePolicyVersion,
    sourceEvidenceHash: params.sourceEvidenceHash,
    sourceExpiresAt: new Date(params.sourceExpiresAt).toISOString(),
  })).digest('hex');
}

function attestationHash(hash: string, env: Environment = process.env): string {
  return createHmac('sha256', secret(env)).update(hash).digest('hex');
}

function rowResult(row: EvidenceRow, replayed: boolean) {
  return {
    evidenceId: row.id,
    taskId: row.task_id,
    workerId: row.worker_id,
    category: row.category,
    tools: row.tools,
    serviceCity: row.service_city,
    serviceState: row.service_state,
    serviceRadiusMiles: row.service_radius_miles,
    sourceHustlerId: row.source_hustler_id,
    sourceExpiresAt: new Date(row.source_expires_at).toISOString(),
    isTest: true as const,
    idempotencyReplayed: replayed,
  };
}

function matches(row: EvidenceRow, params: RecordControlledTestProviderCapabilityParams, hash: string): boolean {
  return row.request_hash === hash
    && row.task_id === params.taskId
    && row.worker_id === params.workerId
    && row.category === params.category
    && row.source_hustler_id === params.sourceHustlerId
    && row.source_policy_version === params.sourcePolicyVersion
    && row.source_evidence_hash === params.sourceEvidenceHash
    && new Date(row.source_expires_at).toISOString() === new Date(params.sourceExpiresAt).toISOString();
}

async function existing(
  query: QueryFn,
  params: RecordControlledTestProviderCapabilityParams,
): Promise<EvidenceRow | undefined> {
  const found = await query<EvidenceRow>(
    `SELECT id,task_id,worker_id,category,tools,service_city,service_state,
            service_radius_miles,source_hustler_id,source_policy_version,
            source_evidence_hash,source_expires_at,request_hash
       FROM hxos_local_test_provider_capability_evidence
      WHERE idempotency_key=$1
      LIMIT 1 FOR SHARE`,
    [params.idempotencyKey],
  );
  return found.rows[0];
}

export const ControlledTestProviderCapabilityService = {
  record: async (params: RecordControlledTestProviderCapabilityParams) => {
    if (!controlledTestProviderCapabilityEnabled()) {
      return failure('LOCAL_TEST_PROVIDER_CAPABILITY_DISABLED', 'Controlled TEST provider capability is disabled.');
    }
    if (!valid(params)) {
      return failure('LOCAL_TEST_PROVIDER_CAPABILITY_INVALID', 'Controlled TEST provider capability evidence is invalid.');
    }
    const hash = requestHash(params);
    try {
      return await db.transaction(async (query) => {
        await query(`SELECT pg_advisory_xact_lock(hashtext('local-test-provider-capability'),hashtext($1))`, [params.taskId]);
        const replay = await existing(query, params);
        if (replay) {
          return matches(replay, params, hash)
            ? { success: true as const, data: rowResult(replay, true) }
            : failure('LOCAL_TEST_PROVIDER_CAPABILITY_IDEMPOTENCY_CONFLICT', 'Provider capability conflicts with prior evidence.');
        }
        const taskResult = await query<TaskRow>(
          `SELECT id,state,worker_id,category,rough_location,region_code,automation_classification
             FROM tasks WHERE id=$1 FOR UPDATE`,
          [params.taskId],
        );
        const task = taskResult.rows[0];
        if (!task) return failure('NOT_FOUND', 'Controlled TEST task was not found.');
        const taskAreaMatches = task.rough_location?.toLowerCase().includes(params.serviceCity.trim().toLowerCase()) === true;
        if (task.automation_classification !== 'CONTROLLED_TEST'
          || !['OPEN', 'MATCHING'].includes(task.state)
          || task.worker_id !== null
          || task.category !== params.category
          || task.region_code !== `US-${params.serviceState}`
          || !taskAreaMatches) {
          return failure('LOCAL_TEST_PROVIDER_CAPABILITY_TASK_CONFLICT', 'Provider capability does not match the controlled task.');
        }
        const workerResult = await query<WorkerRow>(
          `SELECT worker.id,worker.default_mode,worker.account_status,worker.is_minor,worker.is_banned,
                  profile.location_city,profile.location_state
             FROM users worker JOIN capability_profiles profile ON profile.user_id=worker.id
            WHERE worker.id=$1 FOR UPDATE OF worker`,
          [params.workerId],
        );
        const worker = workerResult.rows[0];
        if (!worker
          || worker.default_mode !== 'worker'
          || worker.account_status !== 'ACTIVE'
          || worker.is_minor
          || worker.is_banned === true
          || worker.location_city?.toLowerCase() !== params.serviceCity.trim().toLowerCase()
          || worker.location_state !== params.serviceState) {
          return failure('LOCAL_TEST_PROVIDER_CAPABILITY_WORKER_CONFLICT', 'Provider profile does not match source capability evidence.');
        }
        await query(`SELECT set_config('hustlexp.local_test_provider_capability_enabled', 'true', true)`);
        const evidenceId = randomUUID();
        const inserted = await query<EvidenceRow>(
          `INSERT INTO hxos_local_test_provider_capability_evidence(
             id,task_id,worker_id,source_hustler_id,category,tools,service_city,
             service_state,service_radius_miles,source_policy_version,source_evidence_hash,source_expires_at,
             request_hash,attestation_hash,idempotency_key,actor_id,environment,is_test,expires_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
             'CONTROLLED_TEST',TRUE,$12)
           RETURNING id,task_id,worker_id,category,tools,service_city,service_state,
             service_radius_miles,source_hustler_id,source_policy_version,
             source_evidence_hash,source_expires_at,request_hash`,
          [evidenceId, params.taskId, params.workerId, params.sourceHustlerId, params.category,
            normalizedTools(params.tools), params.serviceCity.trim(), params.serviceState,
            params.serviceRadiusMiles, params.sourcePolicyVersion, params.sourceEvidenceHash,
            new Date(params.sourceExpiresAt).toISOString(), hash, attestationHash(hash),
            params.idempotencyKey, params.actorId],
        );
        if (!inserted.rows[0]) {
          return failure('LOCAL_TEST_PROVIDER_CAPABILITY_FAILED', 'Provider capability evidence was not recorded.');
        }
        return { success: true as const, data: rowResult(inserted.rows[0], false) };
      });
    } catch {
      return failure('DB_ERROR', 'Controlled TEST provider capability could not be recorded.');
    }
  },
};
