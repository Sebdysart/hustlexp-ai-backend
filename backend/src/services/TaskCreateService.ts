import { db, getErrorMessage, isInvariantViolation } from '../db.js';
import { xpForPriceCents } from '../lib/money.js';
import { writeToOutbox } from '../lib/outbox-helpers.js';
import { taskLogger } from '../logger.js';
import type { ServiceError, ServiceResult, Task } from '../types.js';
import { ErrorCodes } from '../types.js';
import { PlanService } from './PlanService.js';
import { ScoperAIService } from './ScoperAIService.js';
import { deriveRoughArea, redactPrivateLocation } from './TaskLocationService.js';
import { buildTaskCreateRequestHash, type CreateTaskParams } from './TaskServiceShared.js';

const log = taskLogger.child({ service: 'TaskCreateService' });
type Query = Parameters<Parameters<typeof db.transaction>[0]>[0];
type CreateOutcome =
  | { kind: 'created'; task: Task }
  | { kind: 'replay'; task: Task }
  | { kind: 'conflict'; existingTaskId: string };

class CreateFailure extends Error {
  constructor(readonly serviceError: ServiceError) {
    super(serviceError.message);
  }
}

function fail(code: string, message: string, details?: Record<string, unknown>): never {
  throw new CreateFailure({ code, message, details });
}

function validateDispatchExpiry(params: CreateTaskParams): void {
  if (params.dispatchExpiresAt && params.deadline && params.dispatchExpiresAt > params.deadline) {
    fail(ErrorCodes.INVALID_STATE, 'Dispatch expiry cannot be later than the task deadline');
  }
}

async function resolvePrice(params: CreateTaskParams): Promise<{ price: number; xp: number }> {
  let price = params.price;
  let xp: number | undefined;
  if (!price) {
    const scoped = await ScoperAIService.analyzeTaskScope({
      description: params.description,
      category: params.category,
    });
    if (scoped.success && scoped.data) {
      price = scoped.data.suggested_price_cents;
      xp = scoped.data.suggested_xp;
      log.info({ priceCents: price, xp, difficulty: scoped.data.difficulty }, 'Scoper AI proposal accepted');
    } else {
      price = params.mode === 'LIVE' ? 1500 : 500;
    }
  }
  if (!Number.isInteger(price) || price <= 0) {
    fail(ErrorCodes.INVALID_STATE, 'Price must be a positive integer (cents)');
  }
  validatePriceFloor(params.mode ?? 'STANDARD', price);
  return { price, xp: xp || xpForPriceCents(price) };
}

function validatePriceFloor(mode: 'STANDARD' | 'LIVE', price: number): void {
  if (mode === 'STANDARD' && price < 500) {
    fail('PRICE_TOO_LOW', 'Standard tasks require minimum price of $5.00 (500 cents)');
  }
  if (mode === 'LIVE' && price < 1500) {
    fail(ErrorCodes.LIVE_2_VIOLATION, 'Live tasks require minimum price of $15.00 (1500 cents)');
  }
}

async function assertPlan(params: CreateTaskParams): Promise<void> {
  const riskLevel = params.riskLevel || 'LOW';
  const result = await PlanService.canCreateTaskWithRisk(params.posterId, riskLevel);
  if (!result.allowed) {
    fail('PLAN_REQUIRED', result.reason || 'Premium plan required for this risk level', {
      requiredPlan: result.requiredPlan,
      riskLevel,
    });
  }
}

async function instantModeAllowed(params: CreateTaskParams): Promise<boolean> {
  if (!params.instantMode) return false;
  const { InstantModeKillSwitch } = await import('./InstantModeKillSwitch.js');
  const flags = InstantModeKillSwitch.checkFlags({ taskId: undefined, operation: 'create' });
  if (!flags.instantModeEnabled) {
    log.info({ posterId: params.posterId, taskTitle: params.title }, 'Instant Mode disabled; using OPEN');
    return false;
  }
  await assertInstantRate(params.posterId);
  await assertInstantCompleteness(params);
  return true;
}

async function assertInstantRate(posterId: string): Promise<void> {
  const { InstantRateLimiter } = await import('./InstantRateLimiter.js');
  const result = await InstantRateLimiter.checkPostLimit(posterId);
  if (!result.allowed) {
    fail(ErrorCodes.RATE_LIMIT_EXCEEDED, result.reason || 'Rate limit exceeded for Instant posts', {
      retryAfter: result.retryAfter,
    });
  }
}

async function assertInstantCompleteness(params: CreateTaskParams): Promise<void> {
  const { InstantTaskGate } = await import('./InstantTaskGate.js');
  const result = await InstantTaskGate.check({
    title: params.title,
    description: params.description,
    location: params.location,
    requirements: params.requirements,
    deadline: params.deadline,
    category: params.category,
  });
  if (!result.instantEligible) {
    fail(ErrorCodes.INSTANT_TASK_INCOMPLETE, 'Instant Mode requires a few more details', {
      blockReason: result.blockReason,
      questions: result.questions,
    });
  }
}

async function existingOutcome(
  query: Query,
  params: CreateTaskParams,
  requestHash: string | null
): Promise<CreateOutcome | null> {
  if (!params.clientIdempotencyKey || !requestHash) return null;
  await query(`SELECT pg_advisory_xact_lock(hashtext('task-create'), hashtext($1))`, [
    `${params.posterId}:${params.clientIdempotencyKey}`,
  ]);
  const result = await query<Task & { request_hash: string }>(
    `SELECT t.*, r.request_hash FROM task_create_requests r JOIN tasks t ON t.id = r.task_id
     WHERE r.poster_id = $1 AND r.idempotency_key = $2`,
    [params.posterId, params.clientIdempotencyKey]
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.request_hash !== requestHash) return { kind: 'conflict', existingTaskId: row.id };
  const { request_hash: _hash, ...task } = row;
  void _hash;
  return { kind: 'replay', task };
}

function publicTaskValues(params: CreateTaskParams, price: number, xp: number, instantMode: boolean): unknown[] {
  const location = deriveRoughArea(params.location, params.roughArea);
  return [
    params.posterId,
    redactPrivateLocation(params.title) ?? params.title,
    redactPrivateLocation(params.description) ?? params.description,
    price,
    xp,
    redactPrivateLocation(params.requirements),
    location,
    params.category,
    params.deadline,
    params.requiresProof ?? true,
    params.riskLevel || 'LOW',
    params.mode ?? 'STANDARD',
    params.liveBroadcastRadiusMiles,
    instantMode,
    params.sensitive ?? false,
    instantMode ? 'MATCHING' : 'OPEN',
    params.templateSlug || null,
    location,
    params.dispatchExpiresAt,
    params.automationClassification ?? 'PRODUCTION',
  ];
}

async function insertTask(
  query: Query,
  params: CreateTaskParams,
  money: { price: number; xp: number },
  instantMode: boolean
): Promise<Task> {
  const result = await query<Task>(
    `INSERT INTO tasks (
      poster_id, title, description, price, xp_reward, requirements, location, category,
      deadline, requires_proof, risk_level, mode, live_broadcast_radius_miles, instant_mode,
      sensitive, state, template_slug, rough_location, dispatch_expires_at,
      automation_classification
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
    RETURNING *`,
    publicTaskValues(params, money.price, money.xp, instantMode)
  );
  return result.rows[0];
}

async function insertCreateWitness(
  query: Query,
  params: CreateTaskParams,
  requestHash: string | null,
  taskId: string
): Promise<void> {
  if (!params.clientIdempotencyKey || !requestHash) return;
  await query(
    `INSERT INTO task_create_requests (poster_id, idempotency_key, request_hash, task_id)
     VALUES ($1, $2, $3, $4)`,
    [params.posterId, params.clientIdempotencyKey, requestHash, taskId]
  );
}

async function insertTaskDependents(
  query: Query,
  params: CreateTaskParams,
  requestHash: string | null,
  task: Task,
  price: number
): Promise<void> {
  if (params.location) {
    await query('INSERT INTO task_location_vault (task_id, exact_location) VALUES ($1, $2)', [task.id, params.location]);
  }
  await query(`INSERT INTO escrows (task_id, amount, state) VALUES ($1, $2, 'PENDING')`, [task.id, price]);
  await insertCreateWitness(query, params, requestHash, task.id);
}

async function persistTask(
  params: CreateTaskParams,
  money: { price: number; xp: number },
  instantMode: boolean
): Promise<CreateOutcome> {
  const requestHash = params.clientIdempotencyKey ? buildTaskCreateRequestHash(params) : null;
  return db.transaction(async (query) => {
    const prior = await existingOutcome(query, params, requestHash);
    if (prior) return prior;
    const task = await insertTask(query, params, money, instantMode);
    await insertTaskDependents(query, params, requestHash, task, money.price);
    return { kind: 'created', task };
  });
}

function materializeOutcome(
  outcome: Exclude<CreateOutcome, { kind: 'created' }>,
  posterId: string,
): ServiceResult<Task> {
  if (outcome.kind === 'conflict') {
    log.warn({ posterId, existingTaskId: outcome.existingTaskId }, 'task.create idempotency conflict');
    return {
      success: false,
      error: {
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'Idempotency key was already used with different task input.',
        details: { existingTaskId: outcome.existingTaskId },
      },
    };
  }
  return { success: true, data: { ...outcome.task, idempotency_replayed: true } };
}

async function startInstantMatching(task: Task, params: CreateTaskParams): Promise<Task> {
  await db.query('UPDATE tasks SET matched_at = NOW() WHERE id = $1', [task.id]);
  const reloaded = await db.query<Task>('SELECT * FROM tasks WHERE id = $1', [task.id]);
  const current = reloaded.rows[0];
  await writeToOutbox({
    eventType: 'task.instant_matching_started',
    aggregateType: 'task',
    aggregateId: current.id,
    eventVersion: 1,
    idempotencyKey: `task.instant_matching_started:${current.id}`,
    payload: {
      taskId: current.id,
      location: deriveRoughArea(params.location, params.roughArea),
      riskLevel: params.riskLevel || 'LOW',
    },
    queueName: 'user_notifications',
  });
  return current;
}

function errorResult(error: unknown): ServiceResult<Task> {
  if (error instanceof CreateFailure) return { success: false, error: error.serviceError };
  if (isInvariantViolation(error)) {
    return {
      success: false,
      error: { code: error.code || 'INVARIANT_VIOLATION', message: getErrorMessage(error.code || '') },
    };
  }
  log.error({ err: error instanceof Error ? error.message : String(error) }, 'Task create DB error');
  return { success: false, error: { code: 'DB_ERROR', message: 'A database error occurred. Please try again.' } };
}

async function create(params: CreateTaskParams): Promise<ServiceResult<Task>> {
  try {
    validateDispatchExpiry(params);
    const money = await resolvePrice(params);
    await assertPlan(params);
    const instantMode = await instantModeAllowed(params);
    const outcome = await persistTask(params, money, instantMode);
    if (outcome.kind !== 'created') return materializeOutcome(outcome, params.posterId);
    const task = instantMode ? await startInstantMatching(outcome.task, params) : outcome.task;
    return { success: true, data: task };
  } catch (error) {
    return errorResult(error);
  }
}

export const TaskCreateService = { create };
