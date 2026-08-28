import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const mocks = vi.hoisted(() => {
  const query = vi.fn();
  return {
    query,
    transaction: vi.fn((fn: (q: typeof query) => Promise<unknown>) => fn(query)),
    invariant: vi.fn(() => false),
    writeToOutbox: vi.fn(),
    eligibility: vi.fn().mockResolvedValue({ allowed: true }),
    mutationEligibility: vi.fn().mockResolvedValue(undefined),
    plan: vi.fn().mockResolvedValue({ allowed: true }),
    progress: vi.fn().mockResolvedValue({ success: true, data: {} }),
    readTask: vi.fn(),
    backgroundCheck: vi.fn().mockResolvedValue(true),
    fraud: vi.fn().mockResolvedValue({ success: true, data: { riskScore: 0.1 } }),
    flags: vi.fn().mockReturnValue({ instantModeEnabled: true }),
    rate: vi.fn().mockResolvedValue({ allowed: true }),
    race: vi.fn(),
    proofReview: vi.fn(),
    ratingSubmit: vi.fn(),
  };
});

vi.mock('../../src/db', () => ({
  db: { query: mocks.query, transaction: mocks.transaction },
  isInvariantViolation: mocks.invariant,
  getErrorMessage: (code: string) => `message:${code}`,
}));
vi.mock('../../src/logger', () => {
  const child = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return { logger: { child }, taskLogger: { child }, aiLogger: { child } };
});
vi.mock('../../src/lib/outbox-helpers', () => ({ writeToOutbox: mocks.writeToOutbox }));
vi.mock('../../src/services/EligibilityGuard', () => ({
  EligibilityGuard: { assertEligibility: mocks.eligibility },
}));
vi.mock('../../src/services/TaskEligibilityPolicy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/TaskEligibilityPolicy')>();
  return { ...actual, assertTaskMutationEligibility: mocks.mutationEligibility };
});
vi.mock('../../src/services/PlanService', () => ({
  PlanService: { canAcceptTaskWithRisk: mocks.plan, canCreateTaskWithRisk: mocks.plan },
}));
vi.mock('../../src/services/ScoperAIService', () => ({
  ScoperAIService: { analyzeTaskScope: vi.fn().mockResolvedValue({ success: false }) },
}));
vi.mock('../../src/services/TaskProgressService', () => ({
  TaskProgressService: { advanceProgress: mocks.progress },
}));
vi.mock('../../src/services/TaskReadService', () => ({
  TaskReadService: { getById: mocks.readTask },
}));
vi.mock('../../src/services/BackgroundCheckService', () => ({
  hasValidBackgroundCheck: mocks.backgroundCheck,
}));
vi.mock('../../src/services/FraudDetectionService', () => ({
  FraudDetectionService: { getRiskAssessment: mocks.fraud },
}));
vi.mock('../../src/services/InstantModeKillSwitch', () => ({
  InstantModeKillSwitch: { checkFlags: mocks.flags },
}));
vi.mock('../../src/services/InstantRateLimiter', () => ({
  InstantRateLimiter: { checkAcceptLimit: mocks.rate },
}));
vi.mock('../../src/services/InstantObservability', () => ({
  InstantObservability: { logAcceptRace: mocks.race },
}));
vi.mock('../../src/services/InstantTrustConfig', () => ({
  MIN_INSTANT_TIER: 2,
  MIN_SENSITIVE_INSTANT_TIER: 3,
}));
vi.mock('../../src/services/ProofService', () => ({
  ProofService: { review: mocks.proofReview },
}));
vi.mock('../../src/services/RatingService', () => ({
  RatingService: { submitRating: mocks.ratingSubmit },
}));

import { DispatchExpiryService, buildDispatchExpiryRequestHash } from '../../src/services/DispatchExpiryService';
import { TaskCompletionService } from '../../src/services/TaskCompletionService';
import { VerifiedPosterCompletionService } from '../../src/services/VerifiedPosterCompletionService';
import { VerifiedPosterRatingService } from '../../src/services/VerifiedPosterRatingService';
import { TaskExecutionService } from '../../src/services/TaskExecutionService';
import { TaskAcceptService } from '../../src/services/TaskAcceptService';
import { TaskAbandonService } from '../../src/services/TaskAbandonService';
import { TaskCloseService } from '../../src/services/TaskCloseService';
import { TaskCreateService } from '../../src/services/TaskCreateService';
import { TaskLocationService, deriveRoughArea } from '../../src/services/TaskLocationService';

const query = mocks.query;
const TASK_ID = '11111111-1111-4111-8111-111111111111';
const POSTER_ID = '22222222-2222-4222-8222-222222222222';
const WORKER_ID = '33333333-3333-4333-8333-333333333333';

function rows(value: unknown[] = [], rowCount = value.length) {
  return { rows: value, rowCount } as never;
}

function expiryTask(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    state: 'OPEN',
    worker_id: null,
    dispatch_expires_at: '2020-01-01T00:00:00.000Z',
    expiration_reason: null,
    refund_state: 'NOT_REQUIRED',
    refund_blocker: null,
    active_reservation: false,
    escrow_state: null,
    stripe_refund_id: null,
    payment_intent_canceled_at: null,
    ...overrides,
  };
}

function completionContext(overrides: Record<string, unknown> = {}) {
  return {
    state: 'PROOF_SUBMITTED',
    poster_id: POSTER_ID,
    payout_ready_at: null,
    completion_message_delivered_at: new Date('2020-01-01T00:00:00.000Z'),
    price: 2_500,
    ...overrides,
  };
}

function acceptTask(overrides: Record<string, unknown> = {}) {
  return {
    risk_level: 'LOW',
    instant_mode: false,
    sensitive: false,
    price: 2_500,
    state: 'MATCHING',
    worker_id: null,
    poster_id: POSTER_ID,
    trust_tier_required: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  query.mockReset();
  mocks.transaction.mockImplementation((fn: (q: typeof query) => Promise<unknown>) => fn(query));
  mocks.invariant.mockReturnValue(false);
  mocks.eligibility.mockResolvedValue({ allowed: true });
  mocks.mutationEligibility.mockResolvedValue(undefined);
  mocks.plan.mockResolvedValue({ allowed: true });
  mocks.progress.mockResolvedValue({ success: true, data: {} });
  mocks.backgroundCheck.mockResolvedValue(true);
  mocks.fraud.mockResolvedValue({ success: true, data: { riskScore: 0.1 } });
  mocks.flags.mockReturnValue({ instantModeEnabled: true });
  mocks.rate.mockResolvedValue({ allowed: true });
  mocks.proofReview.mockResolvedValue({ success: true, data: { state: 'ACCEPTED' } });
  mocks.ratingSubmit.mockResolvedValue({
    success: true,
    data: { id: 'rating-1', task_id: TASK_ID, stars: 5 },
  });
});

describe('DispatchExpiryService defensive contracts', () => {
  const params = { engineTaskId: TASK_ID, idempotencyKey: 'expiry-key-0001' };

  it('rejects an idempotency conflict', async () => {
    query.mockResolvedValueOnce(rows()).mockResolvedValueOnce(rows([{
      request_hash: 'different', task_id: TASK_ID, result_code: 'EXPIRED_UNFILLED',
      refund_state: 'NOT_REQUIRED', blocker_code: null,
    }]));
    await expect(DispatchExpiryService.expireUnfilled(params)).resolves.toMatchObject({
      success: false, error: { code: 'IDEMPOTENCY_CONFLICT' },
    });
  });

  it('rejects a task whose dispatch window is still open', async () => {
    query.mockResolvedValueOnce(rows()).mockResolvedValueOnce(rows())
      .mockResolvedValueOnce(rows([expiryTask({ dispatch_expires_at: '2099-01-01T00:00:00.000Z' })]));
    await expect(DispatchExpiryService.expireUnfilled(params)).resolves.toMatchObject({
      success: false, error: { code: 'DISPATCH_NOT_EXPIRED' },
    });
  });

  it('reconciles an already-expired task with a processor refund', async () => {
    query.mockResolvedValueOnce(rows()).mockResolvedValueOnce(rows())
      .mockResolvedValueOnce(rows([expiryTask({
        state: 'EXPIRED', expiration_reason: 'UNFILLED', refund_state: 'PENDING',
        escrow_state: 'REFUNDED', stripe_refund_id: 're_1',
      })]))
      .mockResolvedValueOnce(rows());
    await expect(DispatchExpiryService.expireUnfilled(params)).resolves.toMatchObject({
      success: true,
      data: { refundState: 'REFUNDED', blockerCode: null, idempotencyReplayed: true },
    });
  });

  it.each([
    [undefined, 'NOT_REQUIRED', null],
    [{ id: 'esc-1', state: 'REFUNDED', stripe_payment_intent_id: 'pi_1', stripe_refund_id: null }, 'REFUNDED', null],
    [{ id: 'esc-1', state: 'PENDING', stripe_payment_intent_id: null, stripe_refund_id: null }, 'NOT_REQUIRED', null],
    [{ id: 'esc-1', state: 'RELEASED', stripe_payment_intent_id: 'pi_1', stripe_refund_id: null }, 'BLOCKED', 'BLOCKED_ESCROW_STATE_RELEASED'],
  ])('persists the safe refund plan for escrow=%s', async (escrow, refundState, blockerCode) => {
    query.mockResolvedValueOnce(rows()).mockResolvedValueOnce(rows())
      .mockResolvedValueOnce(rows([expiryTask()]))
      .mockResolvedValueOnce(rows(escrow ? [escrow] : []))
      .mockResolvedValueOnce(rows([{ id: TASK_ID }]))
      .mockResolvedValueOnce(rows()).mockResolvedValueOnce(rows());
    await expect(DispatchExpiryService.expireUnfilled(params)).resolves.toMatchObject({
      success: true, data: { refundState, blockerCode },
    });
  });

  it('queues cancellation instead of blocking an unconfirmed PaymentIntent', async () => {
    query.mockResolvedValueOnce(rows()).mockResolvedValueOnce(rows())
      .mockResolvedValueOnce(rows([expiryTask()]))
      .mockResolvedValueOnce(rows([{
        id: 'esc-1', state: 'PENDING', stripe_payment_intent_id: 'pi_1',
        stripe_refund_id: null, payment_intent_canceled_at: null,
      }]))
      .mockResolvedValueOnce(rows([{ id: TASK_ID }]))
      .mockResolvedValueOnce(rows()).mockResolvedValueOnce(rows());
    await expect(DispatchExpiryService.expireUnfilled(params)).resolves.toMatchObject({
      success: true, data: { refundState: 'PENDING', blockerCode: null },
    });
    expect(mocks.writeToOutbox).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'escrow.refund_requested',
        idempotencyKey: `dispatch-expiry-cancel:${TASK_ID}`,
        payload: expect.objectContaining({ financial_action: 'cancel_pending_payment_intent' }),
      }),
      query,
    );
  });

  it('reconciles a provider-canceled PaymentIntent as no refund required', async () => {
    query.mockResolvedValueOnce(rows()).mockResolvedValueOnce(rows())
      .mockResolvedValueOnce(rows([expiryTask({
        state: 'EXPIRED', expiration_reason: 'UNFILLED', refund_state: 'PENDING',
        escrow_state: 'PENDING', payment_intent_canceled_at: '2026-07-12T00:00:00.000Z',
      })]))
      .mockResolvedValueOnce(rows());
    await expect(DispatchExpiryService.expireUnfilled(params)).resolves.toMatchObject({
      success: true,
      data: { refundState: 'NOT_REQUIRED', blockerCode: null, idempotencyReplayed: true },
    });
  });

  it('fails closed when the funded escrow refund lock loses a race', async () => {
    query.mockResolvedValueOnce(rows()).mockResolvedValueOnce(rows())
      .mockResolvedValueOnce(rows([expiryTask()]))
      .mockResolvedValueOnce(rows([{ id: 'esc-1', state: 'FUNDED', stripe_payment_intent_id: 'pi_1', stripe_refund_id: null }]))
      .mockResolvedValueOnce(rows([], 0));
    await expect(DispatchExpiryService.expireUnfilled(params)).resolves.toMatchObject({
      success: false, error: { code: 'REFUND_LOCK_CONFLICT' },
    });
  });

  it('returns NOT_FOUND when no canonical engine task exists', async () => {
    query.mockResolvedValueOnce(rows()).mockResolvedValueOnce(rows()).mockResolvedValueOnce(rows());
    await expect(DispatchExpiryService.expireUnfilled(params)).resolves.toMatchObject({
      success: false, error: { code: 'NOT_FOUND' },
    });
  });

  it('fails closed when the task update loses a race', async () => {
    query.mockResolvedValueOnce(rows()).mockResolvedValueOnce(rows())
      .mockResolvedValueOnce(rows([expiryTask()])).mockResolvedValueOnce(rows())
      .mockResolvedValueOnce(rows([], 0));
    await expect(DispatchExpiryService.expireUnfilled(params)).resolves.toMatchObject({
      success: false, error: { code: 'EXPIRY_CONFLICT' },
    });
  });

  it('maps transaction exceptions to DB_ERROR', async () => {
    mocks.transaction.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(DispatchExpiryService.expireUnfilled(params)).resolves.toMatchObject({
      success: false, error: { code: 'DB_ERROR' },
    });
  });

  it('counts successful and blocked due-task outcomes', async () => {
    query.mockResolvedValueOnce(rows([{ id: 'task-a' }, { id: 'task-b' }]));
    const spy = vi.spyOn(DispatchExpiryService, 'expireUnfilled')
      .mockResolvedValueOnce({ success: true, data: {
        engineTaskId: 'task-a', lifecycleState: 'EXPIRED_UNFILLED', refundState: 'NOT_REQUIRED',
        blockerCode: null, idempotencyReplayed: false,
      } })
      .mockResolvedValueOnce({ success: false, error: { code: 'TASK_NOT_UNFILLED', message: 'reserved' } });
    await expect(DispatchExpiryService.expireDue({ limit: 2 })).resolves.toMatchObject({
      success: true, data: { inspected: 2, expired: 1, blocked: 1 },
    });
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('maps scheduler query failures to DB_ERROR', async () => {
    query.mockRejectedValueOnce('offline');
    await expect(DispatchExpiryService.expireDue({ limit: 1 })).resolves.toMatchObject({
      success: false, error: { code: 'DB_ERROR' },
    });
  });

  it('keeps the request hash stable across idempotency keys', () => {
    expect(buildDispatchExpiryRequestHash(params)).toBe(buildDispatchExpiryRequestHash({
      ...params, idempotencyKey: 'another-key',
    }));
  });
});

describe('TaskCompletionService defensive contracts', () => {
  const unattendedHash = createHash('sha256')
    .update(JSON.stringify({ taskId: TASK_ID, mode: 'UNATTENDED' }))
    .digest('hex');

  it('rejects unattended idempotency conflicts', async () => {
    query.mockResolvedValueOnce(rows()).mockResolvedValueOnce(rows([{ request_hash: 'different', task_id: TASK_ID }]));
    await expect(TaskCompletionService.complete(TASK_ID, undefined, {
      mode: 'UNATTENDED', idempotencyKey: 'completion-1',
    })).resolves.toMatchObject({ success: false, error: { code: 'IDEMPOTENCY_CONFLICT' } });
  });

  it('replays an unattended completion from its witness', async () => {
    query.mockResolvedValueOnce(rows())
      .mockResolvedValueOnce(rows([{ request_hash: unattendedHash, task_id: TASK_ID }]))
      .mockResolvedValueOnce(rows([{ id: TASK_ID, state: 'COMPLETED' }]));
    await expect(TaskCompletionService.complete(TASK_ID, undefined, {
      mode: 'UNATTENDED', idempotencyKey: 'completion-1',
    })).resolves.toMatchObject({
      success: true, data: { id: TASK_ID, completion_idempotency_replayed: true },
    });
  });

  it('requires poster identity for poster-confirmed completion', async () => {
    await expect(TaskCompletionService.complete(TASK_ID, undefined, {
      mode: 'POSTER_CONFIRMED',
    })).resolves.toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
  });

  it('returns NOT_FOUND for a missing completion task', async () => {
    query.mockResolvedValueOnce(rows());
    await expect(TaskCompletionService.complete(TASK_ID, POSTER_ID)).resolves.toMatchObject({
      success: false, error: { code: 'NOT_FOUND' },
    });
  });

  it('replays a previously completed task', async () => {
    query.mockResolvedValueOnce(rows([completionContext({ state: 'COMPLETED', payout_ready_at: new Date() })]))
      .mockResolvedValueOnce(rows([{ id: TASK_ID, state: 'COMPLETED' }]));
    await expect(TaskCompletionService.complete(TASK_ID, POSTER_ID)).resolves.toMatchObject({
      success: true, data: { state: 'COMPLETED' },
    });
  });

  it.each([
    [new Date(), 2_500, 'COMPLETION_WAIT_ACTIVE'],
    [new Date('2020-01-01T00:00:00.000Z'), 50_001, 'COMPLETION_VALUE_CAP'],
  ])('enforces unattended wait and value policy', async (deliveredAt, price, code) => {
    query.mockResolvedValueOnce(rows()).mockResolvedValueOnce(rows())
      .mockResolvedValueOnce(rows([completionContext({ completion_message_delivered_at: deliveredAt, price })]))
      .mockResolvedValueOnce(rows([{ state: 'ACCEPTED' }]))
      .mockResolvedValueOnce(rows([{ state: 'FUNDED' }]));
    await expect(TaskCompletionService.complete(TASK_ID, undefined, {
      mode: 'UNATTENDED', idempotencyKey: 'completion-1',
    })).resolves.toMatchObject({ success: false, error: { code } });
  });

  it('fails closed when the completion update loses a race', async () => {
    query.mockResolvedValueOnce(rows([completionContext()]))
      .mockResolvedValueOnce(rows([{ state: 'ACCEPTED' }]))
      .mockResolvedValueOnce(rows([{ state: 'FUNDED' }]))
      .mockResolvedValueOnce(rows([], 0));
    await expect(TaskCompletionService.complete(TASK_ID, POSTER_ID)).resolves.toMatchObject({
      success: false, error: { code: 'INVALID_STATE' },
    });
  });

  it.each([
    [[], 'NOT_FOUND'],
    [[{ state: 'OPEN' }], 'INVALID_STATE'],
  ])('rejects invalid completion delivery context', async (taskRows, code) => {
    query.mockResolvedValueOnce(rows(taskRows));
    await expect(TaskCompletionService.recordDelivery({
      taskId: TASK_ID, providerDeliveryId: 'provider-1', channel: 'EMAIL',
      deliveredAt: new Date(), actorId: 'system',
    })).resolves.toMatchObject({ success: false, error: { code } });
  });

  it('rejects reuse of a delivery ID for another task', async () => {
    query.mockResolvedValueOnce(rows([{ state: 'PROOF_SUBMITTED' }]))
      .mockResolvedValueOnce(rows([], 0))
      .mockResolvedValueOnce(rows([{ task_id: 'different-task' }]));
    await expect(TaskCompletionService.recordDelivery({
      taskId: TASK_ID, providerDeliveryId: 'provider-1', channel: 'SMS',
      deliveredAt: new Date(), actorId: 'system',
    })).resolves.toMatchObject({ success: false, error: { code: 'IDEMPOTENCY_CONFLICT' } });
  });

  it('replays matching delivery evidence without duplication', async () => {
    query.mockResolvedValueOnce(rows([{ state: 'PROOF_SUBMITTED' }]))
      .mockResolvedValueOnce(rows([], 0))
      .mockResolvedValueOnce(rows([{ task_id: TASK_ID }]))
      .mockResolvedValueOnce(rows()).mockResolvedValueOnce(rows());
    await expect(TaskCompletionService.recordDelivery({
      taskId: TASK_ID, providerDeliveryId: 'provider-1', channel: 'PUSH',
      deliveredAt: new Date(), actorId: 'system',
    })).resolves.toMatchObject({ success: true, data: { idempotencyReplayed: true } });
  });

  it('maps completion and delivery exceptions to DB_ERROR', async () => {
    mocks.transaction.mockRejectedValueOnce(new Error('completion db'));
    await expect(TaskCompletionService.complete(TASK_ID, POSTER_ID)).resolves.toMatchObject({
      success: false, error: { code: 'DB_ERROR' },
    });
    mocks.transaction.mockRejectedValueOnce('delivery db');
    await expect(TaskCompletionService.recordDelivery({
      taskId: TASK_ID, providerDeliveryId: 'provider-1', channel: 'EMAIL',
      deliveredAt: new Date(), actorId: 'system',
    })).resolves.toMatchObject({ success: false, error: { code: 'DB_ERROR' } });
  });

  it('accepts submitted proof before canonical poster-confirmed completion', async () => {
    const complete = vi.spyOn(TaskCompletionService, 'complete').mockResolvedValueOnce({
      success: true, data: { id: TASK_ID, state: 'COMPLETED' } as any,
    });
    query.mockResolvedValueOnce(rows([{
      state: 'PROOF_SUBMITTED', poster_id: POSTER_ID, payout_ready_at: null,
    }])).mockResolvedValueOnce(rows([{ id: 'proof-1', state: 'SUBMITTED' }]))
      .mockResolvedValueOnce(rows()).mockResolvedValueOnce(rows([], 0));
    await expect(VerifiedPosterCompletionService.confirm({
      taskId: TASK_ID, providerConfirmationId: 'SM-confirm-0001', score: 5, actorId: 'bridge',
    })).resolves.toMatchObject({ success: true, data: { state: 'COMPLETED' } });
    expect(mocks.proofReview).toHaveBeenCalledWith(expect.objectContaining({
      proofId: 'proof-1', reviewerId: POSTER_ID, decision: 'ACCEPTED',
    }));
    expect(complete).toHaveBeenCalledWith(TASK_ID, POSTER_ID, expect.objectContaining({
      mode: 'POSTER_CONFIRMED', actorId: 'bridge',
    }));
    complete.mockRestore();
  });

  it('accepts authenticated web completion without inventing a rating', async () => {
    const complete = vi.spyOn(TaskCompletionService, 'complete').mockResolvedValueOnce({
      success: true, data: { id: TASK_ID, state: 'COMPLETED' } as any,
    });
    query.mockResolvedValueOnce(rows([{
      state: 'PROOF_SUBMITTED', poster_id: POSTER_ID, payout_ready_at: null,
    }])).mockResolvedValueOnce(rows([{ id: 'proof-web', state: 'SUBMITTED' }]))
      .mockResolvedValueOnce(rows()).mockResolvedValueOnce(rows([], 0));

    await expect(VerifiedPosterCompletionService.confirm({
      taskId: TASK_ID,
      providerConfirmationId: `web:${TASK_ID}`,
      actorId: POSTER_ID,
      channel: 'WEB',
      expectedPosterId: POSTER_ID,
    })).resolves.toMatchObject({ success: true, data: { state: 'COMPLETED' } });

    expect(mocks.proofReview).toHaveBeenCalledWith(expect.objectContaining({
      proofId: 'proof-web',
      reviewerId: POSTER_ID,
      decision: 'ACCEPTED',
      reason: 'Poster confirmed completion through authenticated self-service',
    }));
    expect(complete).toHaveBeenCalledWith(TASK_ID, POSTER_ID, expect.objectContaining({
      mode: 'POSTER_CONFIRMED', actorId: POSTER_ID,
    }));
    complete.mockRestore();
  });

  it('rejects authenticated web completion from a non-poster identity', async () => {
    query.mockResolvedValueOnce(rows([{
      state: 'PROOF_SUBMITTED', poster_id: POSTER_ID, payout_ready_at: null,
    }]));

    await expect(VerifiedPosterCompletionService.confirm({
      taskId: TASK_ID,
      providerConfirmationId: `web:${TASK_ID}`,
      actorId: WORKER_ID,
      channel: 'WEB',
      expectedPosterId: WORKER_ID,
    })).resolves.toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });

    expect(mocks.proofReview).not.toHaveBeenCalled();
  });

  it('fails closed when verified poster confirmation has no submitted proof', async () => {
    query.mockResolvedValueOnce(rows([{
      state: 'PROOF_SUBMITTED', poster_id: POSTER_ID, payout_ready_at: null,
    }])).mockResolvedValueOnce(rows([{ id: 'proof-1', state: 'REJECTED' }]));
    await expect(VerifiedPosterCompletionService.confirm({
      taskId: TASK_ID, providerConfirmationId: 'SM-confirm-0002', score: 4, actorId: 'bridge',
    })).resolves.toMatchObject({ success: false, error: { code: 'INVALID_STATE' } });
    expect(mocks.proofReview).not.toHaveBeenCalled();
  });

  it('fails closed when verified poster confirmation has no proof row', async () => {
    query.mockResolvedValueOnce(rows([{
      state: 'PROOF_SUBMITTED', poster_id: POSTER_ID, payout_ready_at: null,
    }])).mockResolvedValueOnce(rows());
    await expect(VerifiedPosterCompletionService.confirm({
      taskId: TASK_ID, providerConfirmationId: 'SM-confirm-0004', score: 4, actorId: 'bridge',
    })).resolves.toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
  });

  it('continues from accepted proof and preserves completion failure', async () => {
    const complete = vi.spyOn(TaskCompletionService, 'complete').mockResolvedValueOnce({
      success: false, error: { code: 'PAYOUT_NOT_FUNDED', message: 'not funded' },
    });
    query.mockResolvedValueOnce(rows([{
      state: 'PROOF_SUBMITTED', poster_id: POSTER_ID, payout_ready_at: null,
    }])).mockResolvedValueOnce(rows([{ id: 'proof-1', state: 'ACCEPTED' }]));
    await expect(VerifiedPosterCompletionService.confirm({
      taskId: TASK_ID, providerConfirmationId: 'SM-confirm-0005', score: 5, actorId: 'bridge',
    })).resolves.toMatchObject({ success: false, error: { code: 'PAYOUT_NOT_FUNDED' } });
    complete.mockRestore();
  });

  it('preserves proof rejection and recovers an accepted review race', async () => {
    mocks.proofReview.mockResolvedValueOnce({
      success: false, error: { code: 'JUDGE_REJECTED', message: 'proof rejected' },
    });
    query.mockResolvedValueOnce(rows([{
      state: 'PROOF_SUBMITTED', poster_id: POSTER_ID, payout_ready_at: null,
    }])).mockResolvedValueOnce(rows([{ id: 'proof-1', state: 'SUBMITTED' }]));
    await expect(VerifiedPosterCompletionService.confirm({
      taskId: TASK_ID, providerConfirmationId: 'SM-confirm-0006', score: 4, actorId: 'bridge',
    })).resolves.toMatchObject({ success: false, error: { code: 'JUDGE_REJECTED' } });

    const complete = vi.spyOn(TaskCompletionService, 'complete').mockResolvedValueOnce({
      success: true, data: { id: TASK_ID, state: 'COMPLETED' } as any,
    });
    const { TRPCError } = await import('@trpc/server');
    mocks.proofReview.mockRejectedValueOnce(new TRPCError({ code: 'CONFLICT', message: 'raced' }));
    query.mockResolvedValueOnce(rows([{
      state: 'PROOF_SUBMITTED', poster_id: POSTER_ID, payout_ready_at: null,
    }])).mockResolvedValueOnce(rows([{ id: 'proof-1', state: 'SUBMITTED' }]))
      .mockResolvedValueOnce(rows([{ state: 'ACCEPTED' }]))
      .mockResolvedValueOnce(rows()).mockResolvedValueOnce(rows([], 0));
    await expect(VerifiedPosterCompletionService.confirm({
      taskId: TASK_ID, providerConfirmationId: 'SM-confirm-0007', score: 5, actorId: 'bridge',
    })).resolves.toMatchObject({ success: true });
    complete.mockRestore();
  });

  it('rejects an unresolved proof-review race', async () => {
    const { TRPCError } = await import('@trpc/server');
    mocks.proofReview.mockRejectedValueOnce(new TRPCError({ code: 'CONFLICT', message: 'raced' }));
    query.mockResolvedValueOnce(rows([{
      state: 'PROOF_SUBMITTED', poster_id: POSTER_ID, payout_ready_at: null,
    }])).mockResolvedValueOnce(rows([{ id: 'proof-1', state: 'SUBMITTED' }]))
      .mockResolvedValueOnce(rows([{ state: 'REJECTED' }]));
    await expect(VerifiedPosterCompletionService.confirm({
      taskId: TASK_ID, providerConfirmationId: 'SM-confirm-0008', score: 5, actorId: 'bridge',
    })).resolves.toMatchObject({ success: false, error: { code: 'INVALID_STATE' } });
  });

  it('maps an unexpected proof-review provider failure to DB_ERROR', async () => {
    mocks.proofReview.mockRejectedValueOnce(new Error('judge offline'));
    query.mockResolvedValueOnce(rows([{
      state: 'PROOF_SUBMITTED', poster_id: POSTER_ID, payout_ready_at: null,
    }])).mockResolvedValueOnce(rows([{ id: 'proof-1', state: 'SUBMITTED' }]));
    await expect(VerifiedPosterCompletionService.confirm({
      taskId: TASK_ID, providerConfirmationId: 'SM-confirm-0013', score: 5, actorId: 'bridge',
    })).resolves.toMatchObject({ success: false, error: { code: 'DB_ERROR' } });
  });

  it('replays an already-completed verified poster confirmation', async () => {
    query.mockResolvedValueOnce(rows([{
      state: 'COMPLETED', poster_id: POSTER_ID, payout_ready_at: new Date(),
    }])).mockResolvedValueOnce(rows([{ id: TASK_ID, state: 'COMPLETED' }]))
      .mockResolvedValueOnce(rows([{ task_id: TASK_ID }]));
    await expect(VerifiedPosterCompletionService.confirm({
      taskId: TASK_ID, providerConfirmationId: 'SM-confirm-0003', score: 5, actorId: 'bridge',
    })).resolves.toMatchObject({
      success: true, data: { state: 'COMPLETED', completion_idempotency_replayed: true },
    });
  });

  it('rejects missing and premature completion tasks', async () => {
    query.mockResolvedValueOnce(rows());
    await expect(VerifiedPosterCompletionService.confirm({
      taskId: TASK_ID, providerConfirmationId: 'SM-confirm-0009', score: 5, actorId: 'bridge',
    })).resolves.toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
    query.mockResolvedValueOnce(rows([{
      state: 'ACCEPTED', poster_id: POSTER_ID, payout_ready_at: null,
    }]));
    await expect(VerifiedPosterCompletionService.confirm({
      taskId: TASK_ID, providerConfirmationId: 'SM-confirm-0010', score: 5, actorId: 'bridge',
    })).resolves.toMatchObject({ success: false, error: { code: 'INVALID_STATE' } });
  });

  it('maps evidence reuse conflicts and database errors', async () => {
    query.mockResolvedValueOnce(rows([{
      state: 'COMPLETED', poster_id: POSTER_ID, payout_ready_at: new Date(),
    }])).mockResolvedValueOnce(rows([{ id: TASK_ID, state: 'COMPLETED' }]))
      .mockResolvedValueOnce(rows([{ task_id: 'another-task' }]));
    await expect(VerifiedPosterCompletionService.confirm({
      taskId: TASK_ID, providerConfirmationId: 'SM-confirm-0011', score: 5, actorId: 'bridge',
    })).resolves.toMatchObject({ success: false, error: { code: 'IDEMPOTENCY_CONFLICT' } });
    query.mockRejectedValueOnce(new Error('offline'));
    await expect(VerifiedPosterCompletionService.confirm({
      taskId: TASK_ID, providerConfirmationId: 'SM-confirm-0012', score: 5, actorId: 'bridge',
    })).resolves.toMatchObject({ success: false, error: { code: 'DB_ERROR' } });
  });
});

describe('VerifiedPosterRatingService defensive contracts', () => {
  const params = {
    taskId: TASK_ID, providerReviewId: 'SM-review-0001', score: 5 as const, actorId: 'bridge',
  };

  it('records a verified poster rating in the canonical rating system', async () => {
    query.mockResolvedValueOnce(rows())
      .mockResolvedValueOnce(rows([{ state: 'COMPLETED', poster_id: POSTER_ID, worker_id: WORKER_ID }]))
      .mockResolvedValueOnce(rows())
      .mockResolvedValueOnce(rows());
    await expect(VerifiedPosterRatingService.record(params)).resolves.toMatchObject({
      success: true,
      data: { ratingId: 'rating-1', taskId: TASK_ID, score: 5, idempotencyReplayed: false },
    });
    expect(mocks.ratingSubmit).toHaveBeenCalledWith({
      taskId: TASK_ID, raterId: POSTER_ID, stars: 5, tags: ['verified_messaging'],
    });
  });

  it('replays an existing task rating without creating a duplicate', async () => {
    query.mockResolvedValueOnce(rows([{ task_id: TASK_ID }]))
      .mockResolvedValueOnce(rows([{ state: 'COMPLETED', poster_id: POSTER_ID, worker_id: WORKER_ID }]))
      .mockResolvedValueOnce(rows([{ id: 'rating-existing', task_id: TASK_ID, stars: 4 }]));
    await expect(VerifiedPosterRatingService.record({ ...params, score: 4 })).resolves.toMatchObject({
      success: true, data: { ratingId: 'rating-existing', score: 4, idempotencyReplayed: true },
    });
    expect(mocks.ratingSubmit).not.toHaveBeenCalled();
  });

  it('fails closed for reused provider IDs and premature tasks', async () => {
    query.mockResolvedValueOnce(rows([{ task_id: 'different-task' }]));
    await expect(VerifiedPosterRatingService.record(params)).resolves.toMatchObject({
      success: false, error: { code: 'IDEMPOTENCY_CONFLICT' },
    });
    query.mockResolvedValueOnce(rows())
      .mockResolvedValueOnce(rows([{ state: 'PROOF_SUBMITTED', poster_id: POSTER_ID, worker_id: WORKER_ID }]));
    await expect(VerifiedPosterRatingService.record(params)).resolves.toMatchObject({
      success: false, error: { code: 'INVALID_STATE' },
    });
  });

  it('fails closed when a provider retries the same review ID with a different score', async () => {
    query.mockResolvedValueOnce(rows([{ task_id: TASK_ID, score: '4' }]));
    await expect(VerifiedPosterRatingService.record(params)).resolves.toMatchObject({
      success: false, error: { code: 'IDEMPOTENCY_CONFLICT' },
    });
    expect(mocks.ratingSubmit).not.toHaveBeenCalled();
  });

  it('preserves rating service failures and maps database exceptions', async () => {
    mocks.ratingSubmit.mockResolvedValueOnce({
      success: false, error: { code: 'RATING_BLOCKED', message: 'blocked' },
    });
    query.mockResolvedValueOnce(rows())
      .mockResolvedValueOnce(rows([{ state: 'COMPLETED', poster_id: POSTER_ID, worker_id: WORKER_ID }]))
      .mockResolvedValueOnce(rows());
    await expect(VerifiedPosterRatingService.record(params)).resolves.toMatchObject({
      success: false, error: { code: 'RATING_BLOCKED' },
    });
    query.mockRejectedValueOnce(new Error('offline'));
    await expect(VerifiedPosterRatingService.record(params)).resolves.toMatchObject({
      success: false, error: { code: 'DB_ERROR' },
    });
  });

  it('returns NOT_FOUND when the canonical task is missing', async () => {
    query.mockResolvedValueOnce(rows()).mockResolvedValueOnce(rows());
    await expect(VerifiedPosterRatingService.record(params)).resolves.toMatchObject({
      success: false, error: { code: 'NOT_FOUND' },
    });
  });
});

describe('TaskExecutionService defensive contracts', () => {
  it('rejects a missing or wrong-worker task start', async () => {
    query.mockResolvedValueOnce(rows());
    await expect(TaskExecutionService.startWork(TASK_ID, WORKER_ID)).resolves.toMatchObject({
      success: false, error: { code: 'NOT_FOUND' },
    });
    query.mockResolvedValueOnce(rows([{ worker_id: 'another', state: 'ACCEPTED', started_at: null, progress_state: 'ACCEPTED', active_reservation: true }]));
    await expect(TaskExecutionService.startWork(TASK_ID, WORKER_ID)).resolves.toMatchObject({
      success: false, error: { code: 'FORBIDDEN' },
    });
  });

  it('replays a task already in progress', async () => {
    query.mockResolvedValueOnce(rows([{ worker_id: WORKER_ID, state: 'ACCEPTED', started_at: new Date(), progress_state: 'WORKING', active_reservation: true }]))
      .mockResolvedValueOnce(rows([{ id: TASK_ID, progress_state: 'WORKING' }]));
    await expect(TaskExecutionService.startWork(TASK_ID, WORKER_ID)).resolves.toMatchObject({
      success: true, data: { progress_state: 'WORKING' },
    });
    expect(mocks.writeToOutbox).not.toHaveBeenCalled();
  });

  it('emits one transactional user-facing progress event on first start', async () => {
    query.mockResolvedValueOnce(rows([{
      worker_id: WORKER_ID,
      state: 'ACCEPTED',
      started_at: null,
      progress_state: 'TRAVELING',
      active_reservation: true,
      scope_change_pending: false,
    }])).mockResolvedValueOnce(rows([{
      id: TASK_ID,
      progress_state: 'WORKING',
      progress_updated_at: new Date('2026-07-20T21:55:00.000Z'),
    }])).mockResolvedValueOnce(rows([], 1));

    await expect(TaskExecutionService.startWork(TASK_ID, WORKER_ID)).resolves.toMatchObject({
      success: true, data: { progress_state: 'WORKING' },
    });
    expect(mocks.writeToOutbox).toHaveBeenCalledOnce();
    expect(mocks.writeToOutbox).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'task.progress_updated',
      aggregateId: TASK_ID,
      idempotencyKey: `task.progress_updated:${TASK_ID}:TRAVELING:WORKING`,
      payload: expect.objectContaining({
        from: 'TRAVELING',
        to: 'WORKING',
        actor: { type: 'worker', userId: WORKER_ID },
      }),
    }), query);
  });

  it('fails closed when task start loses a race and on DB errors', async () => {
    query.mockResolvedValueOnce(rows([{ worker_id: WORKER_ID, state: 'ACCEPTED', started_at: null, progress_state: 'ACCEPTED', active_reservation: true }]))
      .mockResolvedValueOnce(rows([], 0));
    await expect(TaskExecutionService.startWork(TASK_ID, WORKER_ID)).resolves.toMatchObject({
      success: false, error: { code: 'INVALID_STATE' },
    });
    mocks.transaction.mockRejectedValueOnce(new Error('start db'));
    await expect(TaskExecutionService.startWork(TASK_ID, WORKER_ID)).resolves.toMatchObject({
      success: false, error: { code: 'DB_ERROR' },
    });
  });

  it('replays submitted proof and rejects proof-update races', async () => {
    query.mockResolvedValueOnce(rows([{ state: 'PROOF_SUBMITTED', started_at: new Date(), progress_state: 'WORKING' }]))
      .mockResolvedValueOnce(rows([{ id: TASK_ID, state: 'PROOF_SUBMITTED' }]));
    await expect(TaskExecutionService.submitProof(TASK_ID)).resolves.toMatchObject({
      success: true, data: { state: 'PROOF_SUBMITTED' },
    });
    query.mockResolvedValueOnce(rows([{ state: 'ACCEPTED', started_at: new Date(), progress_state: 'WORKING' }]))
      .mockResolvedValueOnce(rows([], 0));
    await expect(TaskExecutionService.submitProof(TASK_ID)).resolves.toMatchObject({
      success: false, error: { code: 'INVALID_STATE' },
    });
  });

  it('covers submit-proof, reject-proof, and dispute DB failures', async () => {
    for (const action of [
      () => TaskExecutionService.submitProof(TASK_ID),
      () => TaskExecutionService.rejectProof(TASK_ID, 'bad proof'),
      () => TaskExecutionService.openDispute(TASK_ID),
    ]) {
      mocks.transaction.mockRejectedValueOnce(new Error('db'));
      await expect(action()).resolves.toMatchObject({ success: false, error: { code: 'DB_ERROR' } });
    }
  });

  it.each([
    ['rejectProof', 'bad proof'],
    ['openDispute', undefined],
  ] as const)('rejects missing tasks and update races in %s', async (method, reason) => {
    const call = () => method === 'rejectProof'
      ? TaskExecutionService.rejectProof(TASK_ID, reason!)
      : TaskExecutionService.openDispute(TASK_ID);
    query.mockResolvedValueOnce(rows());
    await expect(call()).resolves.toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
    query.mockResolvedValueOnce(rows([{ state: 'PROOF_SUBMITTED' }])).mockResolvedValueOnce(rows([], 0));
    await expect(call()).resolves.toMatchObject({ success: false, error: { code: 'INVALID_STATE' } });
  });
});

describe('TaskAcceptService defensive contracts', () => {
  const params = { taskId: TASK_ID, workerId: WORKER_ID };

  it('enforces poster trust requirements including missing worker rows', async () => {
    query.mockResolvedValueOnce(rows([acceptTask({ trust_tier_required: 3 })]))
      .mockResolvedValueOnce(rows());
    await expect(TaskAcceptService.accept(params)).resolves.toMatchObject({
      success: false, error: { code: 'NOT_FOUND' },
    });
    query.mockResolvedValueOnce(rows([acceptTask({ trust_tier_required: 3 })]))
      .mockResolvedValueOnce(rows([{ trust_tier: 2 }]));
    await expect(TaskAcceptService.accept(params)).resolves.toMatchObject({
      success: false, error: { code: 'INSTANT_TASK_TRUST_INSUFFICIENT' },
    });
  });

  it('allows a high-value accept when the background-check provider fails', async () => {
    mocks.backgroundCheck.mockRejectedValueOnce(new Error('provider down'));
    query.mockResolvedValueOnce(rows([acceptTask({ price: 50_001 })]))
      .mockResolvedValueOnce(rows([{ state: 'FUNDED' }]))
      .mockResolvedValueOnce(rows([{ id: TASK_ID, state: 'ACCEPTED', worker_id: WORKER_ID }]))
      .mockResolvedValueOnce(rows());
    await expect(TaskAcceptService.accept(params)).resolves.toMatchObject({
      success: true, data: { worker_id: WORKER_ID },
    });
  });

  it('reports the canonical state when assignment loses a race', async () => {
    query.mockResolvedValueOnce(rows([acceptTask({ instant_mode: true })]))
      .mockResolvedValueOnce(rows([{ trust_tier: 3, trust_hold: false }]))
      .mockResolvedValueOnce(rows([{ state: 'FUNDED' }]))
      .mockResolvedValueOnce(rows([], 0));
    mocks.readTask.mockResolvedValueOnce({ success: true, data: { id: TASK_ID, state: 'ACCEPTED' } });
    await expect(TaskAcceptService.accept(params)).resolves.toMatchObject({
      success: false, error: { code: 'INVALID_STATE' },
    });
    expect(mocks.race).toHaveBeenCalledOnce();
  });

  it('preserves a canonical read failure after an assignment race', async () => {
    query.mockResolvedValueOnce(rows([acceptTask()]))
      .mockResolvedValueOnce(rows([{ state: 'FUNDED' }]))
      .mockResolvedValueOnce(rows([], 0));
    mocks.readTask.mockResolvedValueOnce({ success: false, error: { code: 'NOT_FOUND', message: 'gone' } });
    await expect(TaskAcceptService.accept(params)).resolves.toMatchObject({
      success: false, error: { code: 'NOT_FOUND' },
    });
  });

  it('maps unexpected transaction failures to DB_ERROR', async () => {
    mocks.transaction.mockRejectedValueOnce(new Error('db'));
    await expect(TaskAcceptService.accept(params)).resolves.toMatchObject({
      success: false, error: { code: 'DB_ERROR' },
    });
  });
});

describe('remaining task service fail-closed edges', () => {
  it('covers worker-abandon ownership and race failures', async () => {
    query.mockResolvedValueOnce(rows());
    await expect(TaskAbandonService.workerAbandon(TASK_ID, WORKER_ID)).resolves.toMatchObject({
      success: false, error: { code: 'NOT_FOUND' },
    });
    query.mockResolvedValueOnce(rows([{ state: 'ACCEPTED', worker_id: 'other', poster_id: POSTER_ID }]));
    await expect(TaskAbandonService.workerAbandon(TASK_ID, WORKER_ID)).resolves.toMatchObject({
      success: false, error: { code: 'FORBIDDEN' },
    });
    query.mockResolvedValueOnce(rows([{ state: 'ACCEPTED', worker_id: WORKER_ID, poster_id: POSTER_ID }]))
      .mockResolvedValueOnce(rows([], 0));
    await expect(TaskAbandonService.workerAbandon(TASK_ID, WORKER_ID)).resolves.toMatchObject({
      success: false, error: { code: 'INVALID_STATE' },
    });
  });

  it('logs a best-effort abandonment event failure and still requests the refund', async () => {
    query.mockResolvedValueOnce(rows([{ state: 'ACCEPTED', worker_id: WORKER_ID, poster_id: POSTER_ID }]))
      .mockResolvedValueOnce(rows([{ id: TASK_ID, state: 'CANCELLED' }]))
      .mockRejectedValueOnce(new Error('task_events absent'))
      .mockResolvedValueOnce(rows([{ id: 'esc-1' }]));
    mocks.writeToOutbox.mockResolvedValueOnce({ id: 'outbox-1' });
    await expect(TaskAbandonService.workerAbandon(TASK_ID, WORKER_ID, 'schedule conflict'))
      .resolves.toMatchObject({ success: true, data: { state: 'CANCELLED' } });
    expect(mocks.writeToOutbox).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'escrow.refund_requested', aggregateId: 'esc-1' }),
      query,
    );
  });

  it('maps worker-abandon database failures', async () => {
    mocks.transaction.mockRejectedValueOnce('abandon database error');
    await expect(TaskAbandonService.workerAbandon(TASK_ID, WORKER_ID)).resolves.toMatchObject({
      success: false, error: { code: 'DB_ERROR' },
    });
  });

  it('covers cancel missing-task, update-race, and unexpected DB failures', async () => {
    query.mockResolvedValueOnce(rows());
    await expect(TaskCloseService.cancel(TASK_ID, POSTER_ID)).resolves.toMatchObject({
      success: false, error: { code: 'NOT_FOUND' },
    });
    query.mockResolvedValueOnce(rows([{
      state: 'OPEN', poster_id: POSTER_ID, late_cancel_pct: 0,
      cancellation_window_hours: 0, accepted_at: null,
    }])).mockResolvedValueOnce(rows());
    await expect(TaskCloseService.cancel(TASK_ID, POSTER_ID)).resolves.toMatchObject({
      success: false, error: { code: 'INVALID_STATE' },
    });
    mocks.transaction.mockRejectedValueOnce(new Error('cancel database error'));
    await expect(TaskCloseService.cancel(TASK_ID, POSTER_ID)).resolves.toMatchObject({
      success: false, error: { code: 'DB_ERROR' },
    });
  });

  it('rejects dispatch expiry later than the customer deadline', async () => {
    await expect(TaskCreateService.create({
      posterId: POSTER_ID,
      title: 'Yard cleanup',
      description: 'Clean the yard',
      price: 5_000,
      deadline: new Date('2026-07-11T12:00:00.000Z'),
      dispatchExpiresAt: new Date('2026-07-11T13:00:00.000Z'),
    })).resolves.toMatchObject({ success: false, error: { code: 'INVALID_STATE' } });
  });

  it('protects raw GPS pairs before reservation', () => {
    expect(deriveRoughArea('47.61010,-122.20150')).toBe('Location protected until reservation');
  });

  it('fails closed for missing, ineligible, and locationless address-release state', async () => {
    query.mockResolvedValueOnce(rows());
    await expect(TaskLocationService.releaseToReservedWorker({ taskId: TASK_ID, workerId: WORKER_ID }))
      .resolves.toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });

    query.mockResolvedValueOnce(rows([{
      worker_id: WORKER_ID, task_state: 'ACCEPTED', escrow_state: 'FUNDED',
      trust_tier_required: 1, worker_trust_tier: 2, worker_trust_hold: true,
      worker_is_banned: false, worker_account_status: 'ACTIVE', exact_location: '1 Main St',
    }]));
    await expect(TaskLocationService.releaseToReservedWorker({ taskId: TASK_ID, workerId: WORKER_ID }))
      .resolves.toMatchObject({ success: false, error: { code: 'TRUST_TIER_INSUFFICIENT' } });

    query.mockResolvedValueOnce(rows([{
      worker_id: WORKER_ID, task_state: 'ACCEPTED', escrow_state: 'FUNDED',
      trust_tier_required: 1, worker_trust_tier: 2, worker_trust_hold: false,
      worker_is_banned: false, worker_account_status: 'SUSPENDED', exact_location: '1 Main St',
    }]));
    await expect(TaskLocationService.releaseToReservedWorker({ taskId: TASK_ID, workerId: WORKER_ID }))
      .resolves.toMatchObject({ success: false, error: { code: 'TRUST_TIER_INSUFFICIENT' } });

    query.mockResolvedValueOnce(rows([{
      worker_id: WORKER_ID, task_state: 'ACCEPTED', escrow_state: 'FUNDED',
      trust_tier_required: 1, worker_trust_tier: 2, worker_trust_hold: false,
      worker_is_banned: false, worker_account_status: 'ACTIVE', exact_location: null,
    }]));
    await expect(TaskLocationService.releaseToReservedWorker({ taskId: TASK_ID, workerId: WORKER_ID }))
      .resolves.toMatchObject({ success: false, error: { code: 'EXACT_LOCATION_MISSING' } });
  });

  it('maps address-release database failures', async () => {
    mocks.transaction.mockRejectedValueOnce(new Error('location db'));
    await expect(TaskLocationService.releaseToReservedWorker({ taskId: TASK_ID, workerId: WORKER_ID }))
      .resolves.toMatchObject({ success: false, error: { code: 'DB_ERROR' } });
  });
});
