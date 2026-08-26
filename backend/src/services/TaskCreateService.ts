import { randomUUID } from 'node:crypto';
import { db, getErrorMessage, isInvariantViolation } from '../db.js';
import { xpForPriceCents } from '../lib/money.js';
import { writeToOutbox } from '../lib/outbox-helpers.js';
import { taskLogger } from '../logger.js';
import type { ServiceError, ServiceResult, Task } from '../types.js';
import { ErrorCodes } from '../types.js';
import { PlanService } from './PlanService.js';
import {
  evaluateTaskAgainstRegionPolicy,
  resolveRegionPolicy,
  type RegionPolicyTaskSnapshot,
} from './RegionPolicyService.js';
import { ScoperAIService } from './ScoperAIService.js';
import { deriveRoughArea, redactPrivateLocation } from './TaskLocationService.js';
import { TaskLocationCryptoError } from './TaskLocationCrypto.js';
import {
  deriveTaskTemplatePolicy,
  type EffectiveTaskTemplatePolicy,
} from './TaskTemplatePolicy.js';
import {
  insertCanonicalTask,
  insertTaskDependents,
  type TaskInitialScope,
} from './TaskCreatePersistence.js';
import {
  buildScopeChecklist,
  buildTaskCreateRequestHash,
  buildTaskScopeHash,
  type CreateTaskParams,
} from './TaskServiceShared.js';

const log = taskLogger.child({ service: 'TaskCreateService' });
type Query = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type TaskCreateQuery = Query;
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

function validateQuoteEconomics(params: CreateTaskParams): void {
  const hasPayout = params.hustlerPayoutCents !== undefined;
  const hasMargin = params.platformMarginCents !== undefined;
  if (hasPayout !== hasMargin) {
    fail(ErrorCodes.INVALID_STATE, 'Quoted payout and margin must be provided together');
  }
  if (!hasPayout) return;
  const payout = params.hustlerPayoutCents!;
  const margin = params.platformMarginCents!;
  if (!Number.isInteger(payout) || payout <= 0 || !Number.isInteger(margin) || margin < 0) {
    fail(ErrorCodes.INVALID_STATE, 'Quoted payout and margin must be valid integer cents');
  }
  if (payout + margin !== params.price) {
    fail(ErrorCodes.INVALID_STATE, 'Quoted payout and margin must reconcile to the task price');
  }
}

function materializeTemplatePolicy(params: CreateTaskParams): {
  params: CreateTaskParams;
  policy: EffectiveTaskTemplatePolicy;
} {
  const policy = deriveTaskTemplatePolicy({
    description: params.description,
    templateSlug: params.templateSlug,
    riskLevel: params.riskLevel,
    insideHome: params.insideHome,
    peoplePresent: params.peoplePresent,
    petsPresent: params.petsPresent,
    wildcardFlags: params.wildcardFlags,
    complianceResult: {
      ai_signals_computed: params.complianceAiSignalsComputed ?? false,
      deception_detected: params.complianceDeceptionDetected ?? false,
      is_genuinely_bizarre: params.complianceGenuinelyBizarre ?? false,
    },
  });
  return {
    policy,
    params: {
      ...params,
      requestedRiskLevel: params.requestedRiskLevel ?? params.riskLevel,
      riskLevel: policy.riskLevel,
      trustTierRequired: policy.requiredWorkerTrustTier,
      completionCriteria: { type: policy.completionCriteriaType },
      contentRelease: policy.contentReleaseRequired,
      mutualConsentRequired: policy.mutualConsentRequired,
      cancellationWindowHours: policy.cancellationWindowHours,
      lateCancelPct: policy.lateCancelPct,
      cancellationPolicyVersion: policy.cancellationPolicyVersion,
      licensedContentRequired: policy.licensedContent,
    },
  };
}

async function resolvePrice(
  params: CreateTaskParams,
  policy: EffectiveTaskTemplatePolicy,
): Promise<{ price: number; xp: number }> {
  let price = params.price;
  let xp: number | undefined;
  if (!price) {
    const scoped = await ScoperAIService.analyzeTaskScope({
      userId: params.posterId,
      description: params.description,
      category: params.category,
      authorityContext: 'EXECUTABLE',
      templateSlug: params.templateSlug,
      wildcardFlags: policy.allowedWildcardFlags,
      complianceResult: {
        score: params.illegalRiskScore ?? 0,
        tier: 'clean',
        triggeredRules: [],
        deception_detected: params.complianceDeceptionDetected ?? false,
        is_genuinely_bizarre: params.complianceGenuinelyBizarre ?? false,
        ai_signals_computed: params.complianceAiSignalsComputed ?? false,
        notes: {
          score: params.illegalRiskScore ?? 0,
          tier: 'clean',
          triggered_rules: [],
          suggested_alternative: null,
          admin_review_id: null,
          appeal_status: 'none',
          deception_detected: params.complianceDeceptionDetected ?? false,
          is_genuinely_bizarre: params.complianceGenuinelyBizarre ?? false,
          ai_signals_computed: params.complianceAiSignalsComputed ?? false,
        },
      },
    });
    if (scoped.success && scoped.data) {
      price = scoped.data.suggested_price_cents;
      xp = scoped.data.suggested_xp;
      log.info({ priceCents: price, xp, difficulty: scoped.data.difficulty }, 'Scoper AI proposal accepted');
    } else {
      price = policy.minimumPriceCents;
    }
  }
  if (!Number.isInteger(price) || price <= 0) {
    fail(ErrorCodes.INVALID_STATE, 'Price must be a positive integer (cents)');
  }
  validatePriceFloor(params.mode ?? 'STANDARD', price, policy.minimumPriceCents);
  return { price, xp: xp || xpForPriceCents(price) };
}

function validatePriceFloor(mode: 'STANDARD' | 'LIVE', price: number, policyMinimumCents: number): void {
  const minimum = Math.max(1500, policyMinimumCents);
  if (price < minimum) {
    const code = mode === 'LIVE' ? ErrorCodes.LIVE_2_VIOLATION : 'PRICE_TOO_LOW';
    const formatted = (minimum / 100).toFixed(2);
    fail(code, `This task requires a minimum price of $${formatted} (${minimum} cents)`);
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

async function assertPosterTrustHold(params: CreateTaskParams, query: Query = db.query): Promise<void> {
  if ((params.riskLevel ?? 'LOW') === 'LOW') return;
  const result = await query<{ active_trust_hold: boolean }>(
    `SELECT COALESCE(
       trust_hold AND (trust_hold_until IS NULL OR trust_hold_until > NOW()),
       FALSE
     ) AS active_trust_hold
     FROM users WHERE id = $1`,
    [params.posterId]
  );
  if (result.rows[0]?.active_trust_hold) {
    fail('FORBIDDEN', 'Your account is on an active trust hold and may create LOW risk tasks only.');
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
): Promise<Exclude<CreateOutcome, { kind: 'created' }> | null> {
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

type InitialScope = TaskInitialScope;

function initialScope(params: CreateTaskParams, price: number): InitialScope {
  const title = redactPrivateLocation(params.title) ?? params.title;
  const description = redactPrivateLocation(params.description) ?? params.description;
  const requirements = redactPrivateLocation(params.requirements);
  const checklist = buildScopeChecklist({
    ...params,
    title,
    requirements: requirements ?? undefined,
  });
  return {
    id: randomUUID(),
    checklist,
    hash: buildTaskScopeHash({
      title,
      description,
      requirements,
      checklist,
      customerTotalCents: price,
      hustlerPayoutCents: params.hustlerPayoutCents,
    }),
  };
}

async function persistTask(
  params: CreateTaskParams,
  money: { price: number; xp: number },
  instantMode: boolean,
  regionPolicy: RegionPolicyTaskSnapshot,
): Promise<CreateOutcome> {
  const requestHash = params.clientIdempotencyKey ? buildTaskCreateRequestHash(params) : null;
  return db.transaction(async (query) => {
    const prior = await existingOutcome(query, params, requestHash);
    if (prior) return prior;
    const scope = initialScope(params, money.price);
    const task = await insertCanonicalTask(query, { params, money, instantMode, scope, regionPolicy });
    await insertTaskDependents(query, {
      params, requestHash, task, price: money.price, scope,
    });
    return { kind: 'created', task };
  });
}

interface TaskRegionBinding {
  regionCode: string;
  category: string;
}

function taskRegionBinding(params: CreateTaskParams): TaskRegionBinding {
  const regionCode = params.regionCode?.trim().toUpperCase();
  const category = params.category?.trim();
  if (!regionCode || !category) {
    fail('REGION_POLICY_UNAVAILABLE', 'A region code and category are required to resolve task policy.', {
      regionCode: regionCode ?? null,
      category: category ?? null,
    });
  }
  return { regionCode, category };
}

function taskRegionPolicyInput(
  params: CreateTaskParams,
  customerTotalCents: number,
  binding: TaskRegionBinding,
) {
  return {
    regionCode: binding.regionCode,
    automationClassification: params.automationClassification ?? 'PRODUCTION',
    category: binding.category,
    riskLevel: params.riskLevel ?? 'LOW',
    requiresProof: params.requiresProof ?? true,
    customerTotalCents,
    payoutCents: params.hustlerPayoutCents ?? null,
    marginCents: params.platformMarginCents ?? null,
  };
}

async function resolveTaskRegionPolicy(
  params: CreateTaskParams,
  customerTotalCents: number,
  templatePolicy: EffectiveTaskTemplatePolicy,
): Promise<RegionPolicyTaskSnapshot> {
  const binding = taskRegionBinding(params);
  const policy = await resolveRegionPolicy(binding.regionCode);
  if (!policy) {
    fail('REGION_POLICY_UNAVAILABLE', 'No effective region policy is available for this task.', {
      regionCode: binding.regionCode,
    });
  }
  const evaluation = evaluateTaskAgainstRegionPolicy(
    policy,
    taskRegionPolicyInput(params, customerTotalCents, binding),
  );
  if (!evaluation.allowed) {
    fail('REGION_POLICY_DENIED', 'The task does not meet the effective region policy.', {
      regionCode: binding.regionCode,
      policyVersion: policy.version,
      reasons: evaluation.reasons,
    });
  }
  if (templatePolicy.licensedContent && !evaluation.snapshot.licenseRequired) {
    fail('CATEGORY_POLICY_MISMATCH', 'Licensed work must use a region-approved licensed category.', {
      category: binding.category,
      regionCode: binding.regionCode,
    });
  }
  if (templatePolicy.contentReleaseRequired && !evaluation.snapshot.recordingAllowed) {
    fail('RECORDING_POLICY_DENIED', 'Recorded or creator work is not approved by the effective region policy.', {
      category: binding.category,
      regionCode: binding.regionCode,
    });
  }
  return evaluation.snapshot;
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
  if (error instanceof TaskLocationCryptoError) {
    const message = error.code === 'INVALID_LOCATION'
      ? error.message
      : 'Exact-location protection is unavailable. The task was not created.';
    return { success: false, error: { code: error.code, message } };
  }
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
    const prepared = materializeTemplatePolicy(params);
    validateDispatchExpiry(prepared.params);
    validateQuoteEconomics(prepared.params);
    const money = await resolvePrice(prepared.params, prepared.policy);
    await assertPosterTrustHold(prepared.params);
    const regionPolicy = await resolveTaskRegionPolicy(prepared.params, money.price, prepared.policy);
    await assertPlan(prepared.params);
    const instantMode = await instantModeAllowed(prepared.params);
    const outcome = await persistTask(prepared.params, money, instantMode, regionPolicy);
    if (outcome.kind !== 'created') return materializeOutcome(outcome, prepared.params.posterId);
    const task = instantMode ? await startInstantMatching(outcome.task, prepared.params) : outcome.task;
    return { success: true, data: task };
  } catch (error) {
    return errorResult(error);
  }
}

async function createInTransaction(
  query: TaskCreateQuery,
  params: CreateTaskParams,
): Promise<ServiceResult<Task>> {
  let savepointOpen = false;
  try {
    const prepared = materializeTemplatePolicy(params);
    validateDispatchExpiry(prepared.params);
    validateQuoteEconomics(prepared.params);
    if (prepared.params.instantMode) {
      fail(ErrorCodes.INVALID_STATE, 'Transaction-bound task creation does not allow Instant Mode');
    }
    const money = await resolvePrice(prepared.params, prepared.policy);
    await assertPosterTrustHold(prepared.params, query);
    const regionPolicy = await resolveTaskRegionPolicy(prepared.params, money.price, prepared.policy);
    await assertPlan(prepared.params);
    await query('SAVEPOINT hustlexp_task_create');
    savepointOpen = true;
    const requestHash = prepared.params.clientIdempotencyKey ? buildTaskCreateRequestHash(prepared.params) : null;
    const prior = await existingOutcome(query, prepared.params, requestHash);
    if (prior) {
      await query('RELEASE SAVEPOINT hustlexp_task_create');
      savepointOpen = false;
      return materializeOutcome(prior, prepared.params.posterId);
    }
    const scope = initialScope(prepared.params, money.price);
    const task = await insertCanonicalTask(query, {
      params: prepared.params, money, instantMode: false, scope, regionPolicy,
    });
    await insertTaskDependents(query, {
      params: prepared.params, requestHash, task, price: money.price, scope,
    });
    await query('RELEASE SAVEPOINT hustlexp_task_create');
    savepointOpen = false;
    return { success: true, data: task };
  } catch (error) {
    if (savepointOpen) {
      try {
        await query('ROLLBACK TO SAVEPOINT hustlexp_task_create');
        await query('RELEASE SAVEPOINT hustlexp_task_create');
      } catch (rollbackError) {
        log.error({
          err: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        }, 'transaction-bound task create savepoint rollback failed');
      }
    }
    return errorResult(error);
  }
}
export const TaskCreateService = { create, createInTransaction };
