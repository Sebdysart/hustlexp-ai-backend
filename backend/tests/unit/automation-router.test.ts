import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/AutomationLifecycleService', () => ({
  AutomationLifecycleService: {
    getBridgeTaskState: vi.fn(),
    listTasks: vi.fn(),
    expireUnfilled: vi.fn(),
    expireDue: vi.fn(),
  },
}));
vi.mock('../../src/services/TaskService', () => ({
  TaskService: {
    recordCompletionDelivery: vi.fn(),
    complete: vi.fn(),
    getById: vi.fn(),
    advanceProgress: vi.fn(),
  },
}));
vi.mock('../../src/services/VerifiedPosterCompletionService', () => ({
  VerifiedPosterCompletionService: { confirm: vi.fn() },
}));
vi.mock('../../src/services/VerifiedPosterRatingService', () => ({
  VerifiedPosterRatingService: { record: vi.fn() },
}));
vi.mock('../../src/services/HustlerIdentityLinkService', () => ({
  HustlerIdentityLinkService: { link: vi.fn() },
}));
vi.mock('../../src/services/EscrowService', () => ({
  EscrowService: { release: vi.fn() },
}));
vi.mock('../../src/services/LocalCertificationPayoutProvider', () => ({
  LocalCertificationPayoutProvider: { createPaidTransfer: vi.fn() },
}));
vi.mock('../../src/services/LocalCertificationScreeningProvider', () => ({
  LocalCertificationScreeningProvider: { completeClear: vi.fn() },
}));
vi.mock('../../src/services/ControlledTestLiquidityService', () => ({
  ControlledTestLiquidityService: { prepareAndBind: vi.fn() },
}));
vi.mock('../../src/services/ControlledTestDurationEvidenceService', () => ({
  ControlledTestDurationEvidenceService: { apply: vi.fn() },
}));
vi.mock('../../src/services/ControlledTestProviderCapabilityService', () => ({
  ControlledTestProviderCapabilityService: { record: vi.fn() },
}));
vi.mock('../../src/lib/task-lifecycle-notifications', () => ({
  notifyPaymentReleased: vi.fn(),
}));
vi.mock('../../src/db', () => ({ db: { query: vi.fn() } }));
vi.mock('../../src/auth/firebase', () => ({ firebaseAuth: { verifyIdToken: vi.fn() } }));
vi.mock('../../src/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { automationRouter } from '../../src/routers/automation';
import { AutomationLifecycleService } from '../../src/services/AutomationLifecycleService';
import { TaskService } from '../../src/services/TaskService';
import { VerifiedPosterCompletionService } from '../../src/services/VerifiedPosterCompletionService';
import { VerifiedPosterRatingService } from '../../src/services/VerifiedPosterRatingService';
import { HustlerIdentityLinkService } from '../../src/services/HustlerIdentityLinkService';
import { EscrowService } from '../../src/services/EscrowService';
import { LocalCertificationPayoutProvider } from '../../src/services/LocalCertificationPayoutProvider';
import { LocalCertificationScreeningProvider } from '../../src/services/LocalCertificationScreeningProvider';
import { ControlledTestLiquidityService } from '../../src/services/ControlledTestLiquidityService';
import { ControlledTestDurationEvidenceService } from '../../src/services/ControlledTestDurationEvidenceService';
import { ControlledTestProviderCapabilityService } from '../../src/services/ControlledTestProviderCapabilityService';
import { notifyPaymentReleased } from '../../src/lib/task-lifecycle-notifications';
import { db } from '../../src/db';

const TASK_ID = '550e8400-e29b-41d4-a716-446655440000';
const WORKER_ID = '550e8400-e29b-41d4-a716-446655440001';
const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440002';
const EVIDENCE_ID = '550e8400-e29b-41d4-a716-446655440004';
const lifecycle = vi.mocked(AutomationLifecycleService);
const tasks = vi.mocked(TaskService);
const completion = vi.mocked(VerifiedPosterCompletionService);
const rating = vi.mocked(VerifiedPosterRatingService);
const identityLink = vi.mocked(HustlerIdentityLinkService);
const escrows = vi.mocked(EscrowService);
const localPayout = vi.mocked(LocalCertificationPayoutProvider);
const screening = vi.mocked(LocalCertificationScreeningProvider);
const liquidity = vi.mocked(ControlledTestLiquidityService);
const durationEvidence = vi.mocked(ControlledTestDurationEvidenceService);
const providerCapability = vi.mocked(ControlledTestProviderCapabilityService);
const mockNotifyPaymentReleased = vi.mocked(notifyPaymentReleased);
const mockDb = vi.mocked(db);

function platformAdminCaller() {
  return automationRouter.createCaller({
    user: {
      id: ADMIN_ID,
      email: 'ops@hustlexp.com',
      full_name: 'Named Operator',
      default_mode: 'poster',
      account_status: 'ACTIVE',
      is_admin: true,
    } as any,
    firebaseUid: 'firebase-ops',
  });
}

function forgedBridgeCaller() {
  return automationRouter.createCaller({
    user: null,
    firebaseUid: null,
    engineBridgeAuthorized: true,
    engineBridgeActorId: ADMIN_ID,
    ip: null,
  } as any);
}

const mutationCases = [
  {
    route: 'applyControlledTestDurationEvidence',
    input: {
      engineTaskId: TASK_ID,
      sourceQuoteVersionId: EVIDENCE_ID,
      minimumMinutes: 30,
      expectedMinutes: 60,
      maximumMinutes: 90,
      policyVersion: 'price-book-duration-v1',
      sourceEvidenceHash: 'a'.repeat(64),
      sourceEnvironment: 'TEST',
      idempotencyKey: 'duration-evidence-0001',
    },
  },
  {
    route: 'recordControlledTestProviderCapability',
    input: {
      engineTaskId: TASK_ID,
      workerId: WORKER_ID,
      sourceHustlerId: EVIDENCE_ID,
      category: 'furniture_assembly',
      tools: ['drill'],
      serviceCity: 'Bellevue',
      serviceState: 'WA',
      serviceRadiusMiles: 25,
      sourcePolicyVersion: 'provider-capability-v1',
      sourceEvidenceHash: 'b'.repeat(64),
      sourceExpiresAt: '2027-01-01T00:00:00.000Z',
      idempotencyKey: 'provider-capability-0001',
    },
  },
  {
    route: 'linkHustlerIdentity',
    input: {
      engineHustlerRef: WORKER_ID,
      phoneE164: '+14255550123',
      providerClaimId: EVIDENCE_ID,
    },
  },
  {
    route: 'completeLocalTestScreening',
    input: {
      backgroundCheckId: EVIDENCE_ID,
      workerId: WORKER_ID,
      idempotencyKey: 'screening-completion-0001',
    },
  },
  {
    route: 'prepareLocalTestLiquidity',
    input: {
      engineTaskId: TASK_ID,
      workerId: WORKER_ID,
      idempotencyKey: 'liquidity-preparation-0001',
    },
  },
  {
    route: 'settleLocalTestPayout',
    input: { engineTaskId: TASK_ID, idempotencyKey: 'settlement-0001' },
  },
  {
    route: 'expireUnfilled',
    input: { engineTaskId: TASK_ID, idempotencyKey: 'dispatch-expiry-0001' },
  },
  {
    route: 'expireDue',
    input: { limit: 25 },
  },
  {
    route: 'recordCompletionDelivery',
    input: {
      engineTaskId: TASK_ID,
      providerDeliveryId: 'SM-delivered-0001',
      channel: 'SMS',
      deliveredAt: '2026-07-10T12:00:00.000Z',
    },
  },
  {
    route: 'completeUnattended',
    input: { engineTaskId: TASK_ID, idempotencyKey: 'unattended-completion-0001' },
  },
  {
    route: 'confirmPosterCompletion',
    input: {
      engineTaskId: TASK_ID,
      providerConfirmationId: 'SM-confirmed-0001',
      score: 5,
    },
  },
  {
    route: 'markWorkerTraveling',
    input: { engineTaskId: TASK_ID },
  },
  {
    route: 'submitPosterRating',
    input: {
      engineTaskId: TASK_ID,
      providerReviewId: 'SM-review-0001',
      score: 5,
    },
  },
] as const;

function expectNoMutationHandlerInvocation(): void {
  for (const handler of [
    durationEvidence.apply,
    providerCapability.record,
    identityLink.link,
    screening.completeClear,
    liquidity.prepareAndBind,
    localPayout.createPaidTransfer,
    escrows.release,
    lifecycle.expireUnfilled,
    lifecycle.expireDue,
    tasks.recordCompletionDelivery,
    tasks.complete,
    completion.confirm,
    tasks.getById,
    tasks.advanceProgress,
    rating.record,
    mockNotifyPaymentReleased,
  ]) {
    expect(handler).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.query.mockResolvedValue({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
});

describe('automation bridge retirement', () => {
  it('allows a named platform administrator to read one decomposed task state', async () => {
    lifecycle.getBridgeTaskState.mockResolvedValueOnce({
      success: true,
      data: { engineTaskId: TASK_ID, lifecycleState: 'PAYOUT_READY', payoutState: 'READY' },
    } as any);

    await expect(platformAdminCaller().getBridgeTaskState({ engineTaskId: TASK_ID }))
      .resolves.toMatchObject({ engineTaskId: TASK_ID, lifecycleState: 'PAYOUT_READY' });
    expect(lifecycle.getBridgeTaskState).toHaveBeenCalledWith(TASK_ID);
  });

  it('does not allow forged bridge context to read task state', async () => {
    await expect(forgedBridgeCaller().getBridgeTaskState({ engineTaskId: TASK_ID }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(lifecycle.getBridgeTaskState).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('preserves named platform-admin lifecycle listing as read-only compatibility', async () => {
    lifecycle.listTasks.mockResolvedValueOnce({
      success: true,
      data: { tasks: [], nextCursor: null },
    });
    await expect(platformAdminCaller().listTasks({ limit: 20 }))
      .resolves.toEqual({ tasks: [], nextCursor: null });
    expect(lifecycle.listTasks).toHaveBeenCalledWith({ limit: 20 });
  });

  it.each(mutationCases)('terminally holds named platform-admin mutation $route', async ({ route, input }) => {
    const caller = platformAdminCaller() as any;
    await expect(caller[route](input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expectNoMutationHandlerInvocation();
    // The only database access is the fresh named-role check. In particular,
    // settleLocalTestPayout never reaches its task/escrow lookup.
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  it.each(mutationCases)('denies forged bridge context before mutation $route', async ({ route, input }) => {
    const caller = forgedBridgeCaller() as any;
    await expect(caller[route](input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expectNoMutationHandlerInvocation();
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});
