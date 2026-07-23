import { db } from '../db.js';
import { taskLogger } from '../logger.js';
import type { ServiceError, ServiceResult, Task } from '../types.js';
import { ErrorCodes } from '../types.js';
import { MIN_INSTANT_TIER, MIN_SENSITIVE_INSTANT_TIER } from './InstantTrustConfig.js';
import { PlanService } from './PlanService.js';
import { TaskProgressService } from './TaskProgressService.js';
import { TaskReadService } from './TaskReadService.js';
import { assertTaskMutationEligibility } from './TaskEligibilityPolicy.js';
import type { AcceptTaskParams, TaskRiskLevel } from './TaskServiceShared.js';

const log = taskLogger.child({ service: 'TaskAcceptService' });
type Query = Parameters<Parameters<typeof db.transaction>[0]>[0];
type TaskCandidate = {
  risk_level: TaskRiskLevel;
  instant_mode: boolean;
  sensitive: boolean | null;
  price: number;
  state: string;
  worker_id: string | null;
  poster_id: string;
  trust_tier_required: number | null;
  mutual_consent_required: boolean;
};

class AcceptFailure extends Error {
  constructor(readonly serviceError: ServiceError) {
    super(serviceError.message);
  }
}

function fail(code: string, message: string, details?: Record<string, unknown>): never {
  throw new AcceptFailure({ code, message, details });
}

async function loadTask(query: Query, taskId: string): Promise<TaskCandidate> {
  const result = await query<TaskCandidate>(
    `SELECT risk_level, instant_mode, sensitive, price, state, worker_id, poster_id,
            trust_tier_required, mutual_consent_required
     FROM tasks WHERE id = $1 FOR UPDATE`,
    [taskId]
  );
  if (!result.rows[0]) fail(ErrorCodes.NOT_FOUND, `Task ${taskId} not found`);
  return result.rows[0];
}

function assertBasicState(task: TaskCandidate, workerId: string): void {
  if (task.poster_id === workerId) fail('FORBIDDEN', 'You cannot accept your own task.');
  if (task.mutual_consent_required) {
    fail('CONSENT_REQUIRED', 'This task must be accepted through the consent checklist.');
  }
  if (task.state !== 'MATCHING') {
    fail(
      ErrorCodes.INVALID_STATE,
      `Cannot accept task: current state is ${task.state}, expected MATCHING (instant mode only). Standard tasks require applying via the application workflow.`
    );
  }
  if (task.worker_id !== null) fail(ErrorCodes.INVALID_STATE, 'Task already accepted by another worker');
}

async function assertEligibility(task: TaskCandidate, taskId: string, workerId: string): Promise<void> {
  const { EligibilityGuard } = await import('./EligibilityGuard.js');
  const result = await EligibilityGuard.assertEligibility({
    userId: workerId,
    taskId,
    isInstant: task.instant_mode || false,
  });
  if (!result.allowed) {
    fail(
      String(result.code),
      (result.details?.reason as string) || 'Eligibility check failed',
      result.details
    );
  }
}

async function workerTrustTier(query: Query, workerId: string): Promise<number> {
  const result = await query<{ trust_tier: number }>('SELECT trust_tier FROM users WHERE id = $1', [workerId]);
  if (!result.rows[0]) fail(ErrorCodes.NOT_FOUND, `Worker ${workerId} not found`);
  return result.rows[0].trust_tier;
}

async function assertPosterTrustRequirement(query: Query, task: TaskCandidate, workerId: string): Promise<void> {
  if (task.trust_tier_required == null) return;
  const trustTier = await workerTrustTier(query, workerId);
  if (trustTier < task.trust_tier_required) {
    fail(
      ErrorCodes.INSTANT_TASK_TRUST_INSUFFICIENT,
      `Task requires trust tier ${task.trust_tier_required}. Your tier: ${trustTier}`
    );
  }
}

async function assertInstantFlags(taskId: string): Promise<void> {
  const { InstantModeKillSwitch } = await import('./InstantModeKillSwitch.js');
  const flags = InstantModeKillSwitch.checkFlags({ taskId, operation: 'accept' });
  if (!flags.instantModeEnabled) fail(ErrorCodes.INVALID_STATE, 'Instant Mode is currently disabled');
}

async function assertInstantRate(workerId: string): Promise<void> {
  const { InstantRateLimiter } = await import('./InstantRateLimiter.js');
  const result = await InstantRateLimiter.checkAcceptLimit(workerId);
  if (!result.allowed) {
    fail(ErrorCodes.RATE_LIMIT_EXCEEDED, result.reason || 'Rate limit exceeded for Instant accepts', {
      retryAfter: result.retryAfter,
    });
  }
}

async function assertInstantTrust(query: Query, task: TaskCandidate, workerId: string): Promise<void> {
  const result = await query<{ trust_tier: number; active_trust_hold: boolean }>(
    `SELECT trust_tier,
            COALESCE(trust_hold AND (trust_hold_until IS NULL OR trust_hold_until > NOW()), FALSE) AS active_trust_hold
     FROM users WHERE id = $1`,
    [workerId]
  );
  const worker = result.rows[0];
  if (!worker) fail(ErrorCodes.NOT_FOUND, `Worker ${workerId} not found`);
  if (worker.active_trust_hold) {
    fail(ErrorCodes.INSTANT_TASK_TRUST_INSUFFICIENT, 'Your account is currently on hold');
  }
  const minimum = task.sensitive ? MIN_SENSITIVE_INSTANT_TIER : MIN_INSTANT_TIER;
  if (worker.trust_tier < minimum) {
    fail(ErrorCodes.INSTANT_TASK_TRUST_INSUFFICIENT, 'This task requires a higher trust tier');
  }
}

async function assertInstantAcceptance(query: Query, task: TaskCandidate, taskId: string, workerId: string): Promise<void> {
  if (!task.instant_mode) return;
  await assertInstantFlags(taskId);
  await assertInstantRate(workerId);
  await assertInstantTrust(query, task, workerId);
}

async function assertPlan(task: TaskCandidate, workerId: string): Promise<void> {
  const result = await PlanService.canAcceptTaskWithRisk(workerId, task.risk_level);
  if (!result.allowed) {
    fail('PLAN_REQUIRED', result.reason || 'Pro plan required for high-risk tasks', {
      requiredPlan: result.requiredPlan,
      riskLevel: task.risk_level,
    });
  }
}

async function assertFraudRisk(taskId: string, workerId: string): Promise<void> {
  try {
    const { FraudDetectionService } = await import('./FraudDetectionService.js');
    const result = await FraudDetectionService.getRiskAssessment('user', workerId);
    if (result.success && result.data && result.data.riskScore > 0.7) {
      log.warn({ workerId, taskId, riskScore: result.data.riskScore }, 'Task acceptance blocked by fraud risk');
      fail('FRAUD_RISK_HIGH', 'Task acceptance is under review due to account risk assessment');
    }
  } catch (error) {
    if (error instanceof AcceptFailure) throw error;
    log.warn({ workerId, taskId, err: error }, 'Fraud risk check failed, allowing acceptance');
  }
}

async function assertBackgroundCheck(task: TaskCandidate, taskId: string, workerId: string): Promise<void> {
  if (task.price <= 50000) return;
  try {
    const service = await import('./BackgroundCheckService.js');
    if (!await service.hasValidBackgroundCheck(workerId)) {
      log.info({ workerId, taskId, price: task.price }, 'High-value task requires background check');
      fail('BACKGROUND_CHECK_REQUIRED', 'High-value tasks require a completed background check');
    }
  } catch (error) {
    if (error instanceof AcceptFailure) throw error;
    log.warn({ workerId, taskId, err: error }, 'Background check lookup failed, allowing acceptance');
  }
}

async function assertFunded(query: Query, taskId: string): Promise<void> {
  const result = await query<{ state: string }>(
    'SELECT state FROM escrows WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1',
    [taskId]
  );
  if (result.rows[0]?.state !== 'FUNDED') {
    fail(
      ErrorCodes.INVALID_STATE,
      'This task is not funded yet. The poster must complete payment before it can be accepted.'
    );
  }
}

async function recordRace(task: TaskCandidate, taskId: string, workerId: string): Promise<never> {
  const existing = await TaskReadService.getById(taskId);
  if (!existing.success) throw new AcceptFailure(existing.error);
  if (task.instant_mode && existing.data.state === 'ACCEPTED') {
    const { InstantObservability } = await import('./InstantObservability.js');
    InstantObservability.logAcceptRace(taskId, workerId, 'Task already accepted by another hustler');
  }
  fail(ErrorCodes.INVALID_STATE, `Cannot accept task: current state is ${existing.data.state}, expected MATCHING`);
}

async function assignTask(query: Query, task: TaskCandidate, taskId: string, workerId: string): Promise<Task> {
  const result = await query<Task>(
    `UPDATE tasks SET state = 'ACCEPTED', worker_id = $2, accepted_at = NOW()
     WHERE id = $1 AND state = 'MATCHING' AND worker_id IS NULL RETURNING *`,
    [taskId, workerId]
  );
  if (!result.rows[0]) return recordRace(task, taskId, workerId);
  await TaskProgressService.advanceProgress({ taskId, to: 'ACCEPTED', actor: { type: 'system' } });
  return result.rows[0];
}

async function acceptTransaction(query: Query, params: AcceptTaskParams): Promise<ServiceResult<Task>> {
  const task = await loadTask(query, params.taskId);
  assertBasicState(task, params.workerId);
  await assertTaskMutationEligibility(query, params.taskId, params.workerId, {
    requireCurrentOffer: true,
  });
  await assertEligibility(task, params.taskId, params.workerId);
  await assertPosterTrustRequirement(query, task, params.workerId);
  await assertInstantAcceptance(query, task, params.taskId, params.workerId);
  await assertPlan(task, params.workerId);
  await assertFraudRisk(params.taskId, params.workerId);
  await assertBackgroundCheck(task, params.taskId, params.workerId);
  await assertFunded(query, params.taskId);
  const accepted = await assignTask(query, task, params.taskId, params.workerId);
  return { success: true, data: accepted };
}

async function accept(params: AcceptTaskParams): Promise<ServiceResult<Task>> {
  try {
    return await db.transaction((query) => acceptTransaction(query, params));
  } catch (error) {
    if (error instanceof AcceptFailure) return { success: false, error: error.serviceError };
    return { success: false, error: { code: 'DB_ERROR', message: 'A database error occurred. Please try again.' } };
  }
}

export const TaskAcceptService = { accept };
