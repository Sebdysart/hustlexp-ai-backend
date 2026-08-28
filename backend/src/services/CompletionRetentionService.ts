import { db } from '../db.js';
import { taskLogger } from '../logger.js';
import type { ServiceResult, Task } from '../types.js';
import { ErrorCodes } from '../types.js';
import { TaskCreateService } from './TaskCreateService.js';
import {
  decryptTaskLocation,
  TaskLocationCryptoError,
  type StoredEncryptedTaskLocation,
} from './TaskLocationCrypto.js';

const log = taskLogger.child({ service: 'CompletionRetentionService' });

export interface RebookTaskParams {
  sourceTaskId: string;
  posterId: string;
  clientIdempotencyKey: string;
  scheduledFor?: Date;
}

export interface RebookTaskResult {
  taskId: string;
  sourceTaskId: string;
  preferredWorkerId: string;
  state: string;
  paymentState: 'PENDING';
  requiresNewFunding: true;
  idempotencyReplayed: boolean;
}

interface RebookSource extends StoredEncryptedTaskLocation {
  id: string;
  poster_id: string;
  worker_id: string | null;
  state: string;
  title: string;
  description: string;
  price: number;
  hustler_payout_cents: number | null;
  platform_margin_cents: number | null;
  requirements: string | null;
  rough_location: string | null;
  category: string | null;
  trade_type: string | null;
  requires_proof: boolean;
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH' | 'IN_HOME';
  template_slug: string | null;
  estimated_duration_minutes: number | null;
  required_tools: string[] | null;
  region_code: string | null;
  checklist: unknown;
}

function failure<T>(code: string, message: string): ServiceResult<T> {
  return { success: false, error: { code, message } };
}

async function sourceTask(sourceTaskId: string): Promise<RebookSource | undefined> {
  const result = await db.query<RebookSource>(
    `SELECT t.id, t.poster_id, t.worker_id, t.state, t.title, t.description,
            t.price, t.hustler_payout_cents, t.platform_margin_cents,
            t.requirements, t.rough_location, t.category, t.trade_type,
            t.requires_proof, t.risk_level, t.template_slug,
            t.estimated_duration_minutes, t.required_tools, t.region_code,
            v.location_ciphertext, v.location_nonce, v.location_auth_tag,
            v.location_key_id, s.checklist
       FROM tasks t
       LEFT JOIN task_location_vault v ON v.task_id = t.id
       LEFT JOIN task_scope_versions s ON s.id = t.active_scope_version_id
      WHERE t.id = $1`,
    [sourceTaskId],
  );
  return result.rows[0];
}

function proofSteps(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const steps = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return steps.length > 0 ? steps.slice(0, 12) : undefined;
}

function output(task: Task, source: RebookSource): ServiceResult<RebookTaskResult> {
  return {
    success: true,
    data: {
      taskId: task.id,
      sourceTaskId: source.id,
      preferredWorkerId: source.worker_id!,
      state: task.state,
      paymentState: 'PENDING',
      requiresNewFunding: true,
      idempotencyReplayed: task.idempotency_replayed === true,
    },
  };
}

function sourceValidation(
  source: RebookSource,
  params: RebookTaskParams,
): ServiceResult<RebookTaskResult> | null {
  if (source.poster_id !== params.posterId) {
    return failure(ErrorCodes.FORBIDDEN, 'Only the original Poster can rebook this task');
  }
  if (source.state !== 'COMPLETED' || !source.worker_id) {
    return failure(ErrorCodes.INVALID_STATE, 'Rebooking requires a completed task with a real provider');
  }
  if (!source.region_code || !(source.trade_type || source.category)) {
    return failure('REGION_POLICY_UNAVAILABLE', 'The source task has no reusable region-policy binding');
  }
  if (source.hustler_payout_cents == null || source.platform_margin_cents == null) {
    return failure(ErrorCodes.INVALID_STATE, 'The source task has no reconciled quote economics');
  }
  return null;
}

function optionalValue<T>(value: T | null): T | undefined {
  return value ?? undefined;
}

async function createRebookTask(
  source: RebookSource,
  params: RebookTaskParams,
  exactLocation: string,
) {
  return TaskCreateService.create({
    posterId: params.posterId,
    title: source.title,
    description: source.description,
    price: source.price,
    hustlerPayoutCents: source.hustler_payout_cents!,
    platformMarginCents: source.platform_margin_cents!,
    requirements: optionalValue(source.requirements),
    location: exactLocation,
    roughArea: optionalValue(source.rough_location),
    regionCode: source.region_code!,
    category: source.trade_type || source.category!,
    deadline: params.scheduledFor,
    requiresProof: source.requires_proof,
    riskLevel: source.risk_level,
    mode: 'STANDARD',
    instantMode: false,
    templateSlug: optionalValue(source.template_slug),
    clientIdempotencyKey: `rebook:${source.id}:${params.clientIdempotencyKey}`,
    automationClassification: 'PRODUCTION',
    proofSteps: proofSteps(source.checklist),
    estimatedDurationMinutes: optionalValue(source.estimated_duration_minutes),
    requiredTools: optionalValue(source.required_tools),
    repeatSourceTaskId: source.id,
    preferredWorkerId: source.worker_id!,
    retentionConversion: 'REBOOK',
  });
}

async function rebookInner(params: RebookTaskParams): Promise<ServiceResult<RebookTaskResult>> {
  const source = await sourceTask(params.sourceTaskId);
  if (!source) return failure(ErrorCodes.NOT_FOUND, 'Completed task not found');
  const validation = sourceValidation(source, params);
  if (validation) return validation;
  const exactLocation = decryptTaskLocation(source.id, source);
  const created = await createRebookTask(source, params, exactLocation);
  return created.success ? output(created.data, source) : created;
}

async function rebook(params: RebookTaskParams): Promise<ServiceResult<RebookTaskResult>> {
  try {
    return await rebookInner(params);
  } catch (error) {
    if (error instanceof TaskLocationCryptoError) {
      return failure(error.code, 'The protected service location could not be reused safely');
    }
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'Task rebook failed');
    return failure('DB_ERROR', 'Could not create the rebook task safely');
  }
}

export const CompletionRetentionService = { rebook };
