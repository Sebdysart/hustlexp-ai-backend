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
import { notifyPaymentReleased } from '../../src/lib/task-lifecycle-notifications';
import { db } from '../../src/db';
import { ErrorCodes } from '../../src/types';

const TASK_ID = '550e8400-e29b-41d4-a716-446655440000';
const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440002';
const lifecycle = vi.mocked(AutomationLifecycleService);
const tasks = vi.mocked(TaskService);
const completion = vi.mocked(VerifiedPosterCompletionService);
const rating = vi.mocked(VerifiedPosterRatingService);
const identityLink = vi.mocked(HustlerIdentityLinkService);
const escrows = vi.mocked(EscrowService);
const localPayout = vi.mocked(LocalCertificationPayoutProvider);
const mockNotifyPaymentReleased = vi.mocked(notifyPaymentReleased);
const mockDb = vi.mocked(db);

function seedPlatformAdmin() {
  mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
}

function caller(isAdmin = true) {
  return automationRouter.createCaller({
    user: {
      id: ADMIN_ID,
      email: 'ops@hustlexp.com',
      full_name: 'Ops',
      default_mode: 'poster',
      account_status: 'ACTIVE',
      is_admin: isAdmin,
    } as any,
    firebaseUid: 'firebase-ops',
  });
}

function bridgeCaller() {
  return automationRouter.createCaller({
    user: null,
    firebaseUid: null,
    engineBridgeAuthorized: true,
    engineBridgeActorId: ADMIN_ID,
    ip: null,
  });
}

function unauthorizedCaller() {
  return automationRouter.createCaller({
    user: null,
    firebaseUid: null,
    engineBridgeAuthorized: false,
    engineBridgeActorId: null,
    ip: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.query.mockResolvedValue({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
});

describe('automation E1/E2/E4 contracts', () => {
  it('lets only an authenticated engine bridge read one decomposed task state', async () => {
    lifecycle.getBridgeTaskState.mockResolvedValueOnce({
      success: true,
      data: {
        engineTaskId: TASK_ID,
        lifecycleState: 'SETTLED',
        taskState: 'COMPLETED',
        progressState: 'COMPLETED',
        workerId: ADMIN_ID,
        automationClassification: 'CONTROLLED_TEST',
        environment: 'TEST',
        isTest: true,
        completedAt: '2026-07-20T20:36:12.000Z',
        completionConfirmedAt: '2026-07-20T20:36:12.000Z',
        payoutReadyAt: '2026-07-20T20:36:12.000Z',
        escrow: {
          id: '550e8400-e29b-41d4-a716-446655440009',
          state: 'RELEASED',
          payoutProvider: 'LOCAL_CERTIFICATION_TEST',
          providerTransferId: 'tr_hxos_test_0123456789abcdef0123456789abcdef',
          providerTransferStatus: 'paid',
          releasedAt: '2026-07-20T20:38:00.000Z',
        },
        reservation: { id: ADMIN_ID, state: 'ACTIVE', hustlerRef: ADMIN_ID },
        proof: { id: ADMIN_ID, state: 'ACCEPTED' },
        payoutState: 'PAID',
        sourceUpdatedAt: '2026-07-20T20:38:00.000Z',
      },
    });

    await expect(bridgeCaller().getBridgeTaskState({ engineTaskId: TASK_ID }))
      .resolves.toMatchObject({ lifecycleState: 'SETTLED', payoutState: 'PAID', isTest: true });
    expect(lifecycle.getBridgeTaskState).toHaveBeenCalledWith(TASK_ID);

    await expect(unauthorizedCaller().getBridgeTaskState({ engineTaskId: TASK_ID }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('fails closed when the bridge task read is inconsistent', async () => {
    lifecycle.getBridgeTaskState.mockResolvedValueOnce({
      success: false, error: { code: 'INCONSISTENT_STATE', message: 'broken evidence' },
    });
    await expect(bridgeCaller().getBridgeTaskState({ engineTaskId: TASK_ID }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('links a capability-proven existing roster identity through the canonical engine', async () => {
    identityLink.link.mockResolvedValueOnce({
      success: true,
      data: { engineHustlerRef: TASK_ID, trustTier: 1, idempotencyReplayed: false },
    });
    const input = {
      engineHustlerRef: TASK_ID,
      phoneE164: '+14255550123',
      providerClaimId: '550e8400-e29b-41d4-a716-446655440004',
    };
    await expect(caller().linkHustlerIdentity(input)).resolves.toEqual({
      engineHustlerRef: TASK_ID, trustTier: 1, idempotencyReplayed: false,
    });
    expect(identityLink.link).toHaveBeenCalledWith(input);
  });

  it('fails closed when canonical identity evidence conflicts', async () => {
    identityLink.link.mockResolvedValueOnce({
      success: false, error: { code: 'IDENTITY_CONFLICT', message: 'conflict' },
    });
    await expect(caller().linkHustlerIdentity({
      engineHustlerRef: TASK_ID,
      phoneE164: '+14255550123',
      providerClaimId: '550e8400-e29b-41d4-a716-446655440004',
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('admin reads a bounded lifecycle page', async () => {
    seedPlatformAdmin();
    lifecycle.listTasks.mockResolvedValueOnce({ success: true, data: { tasks: [], nextCursor: null } });
    await expect(caller().listTasks({ limit: 50 })).resolves.toEqual({ tasks: [], nextCursor: null });
    expect(lifecycle.listTasks).toHaveBeenCalledWith({ limit: 50 });
  });

  it('rejects non-admin lifecycle reads', async () => {
    await expect(caller(false).listTasks({ limit: 20 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(lifecycle.listTasks).not.toHaveBeenCalled();
  });

  it('exposes idempotent unfilled expiry', async () => {
    seedPlatformAdmin();
    lifecycle.expireUnfilled.mockResolvedValueOnce({
      success: true,
      data: {
        engineTaskId: TASK_ID,
        lifecycleState: 'EXPIRED_UNFILLED',
        refundState: 'PENDING',
        blockerCode: null,
        idempotencyReplayed: false,
      },
    });
    const result = await caller().expireUnfilled({
      engineTaskId: TASK_ID,
      idempotencyKey: 'dispatch-expiry-0001',
    });
    expect(result.refundState).toBe('PENDING');
  });

  it('records provider delivery evidence before unattended completion', async () => {
    tasks.recordCompletionDelivery.mockResolvedValueOnce({
      success: true,
      data: { taskId: TASK_ID, providerDeliveryId: 'SM-delivered-1', idempotencyReplayed: false },
    });
    await caller().recordCompletionDelivery({
      engineTaskId: TASK_ID,
      providerDeliveryId: 'SM-delivered-1',
      channel: 'SMS',
      deliveredAt: '2026-07-10T12:00:00.000Z',
    });
    expect(tasks.recordCompletionDelivery).toHaveBeenCalledWith(expect.objectContaining({
      taskId: TASK_ID,
      actorId: ADMIN_ID,
      channel: 'SMS',
    }));
  });

  it('lets the authenticated engine bridge record delivery evidence', async () => {
    tasks.recordCompletionDelivery.mockResolvedValueOnce({
      success: true,
      data: { taskId: TASK_ID, providerDeliveryId: 'SM-delivered-bridge', idempotencyReplayed: false },
    });
    await bridgeCaller().recordCompletionDelivery({
      engineTaskId: TASK_ID,
      providerDeliveryId: 'SM-delivered-bridge',
      channel: 'SMS',
      deliveredAt: '2026-07-10T12:00:00.000Z',
    });
    expect(tasks.recordCompletionDelivery).toHaveBeenCalledWith(expect.objectContaining({
      taskId: TASK_ID,
      actorId: ADMIN_ID,
    }));
  });

  it('returns PAYOUT_READY but never claims payout released', async () => {
    tasks.complete.mockResolvedValueOnce({
      success: true,
      data: { id: TASK_ID, completion_idempotency_replayed: false } as any,
    });
    const result = await caller().completeUnattended({
      engineTaskId: TASK_ID,
      idempotencyKey: 'unattended-complete-0001',
    });
    expect(result).toEqual({
      engineTaskId: TASK_ID,
      lifecycleState: 'PAYOUT_READY',
      payoutState: 'READY',
      idempotencyReplayed: false,
    });
    expect(tasks.complete).toHaveBeenCalledWith(TASK_ID, undefined, {
      mode: 'UNATTENDED',
      idempotencyKey: 'unattended-complete-0001',
      actorId: ADMIN_ID,
    });
  });

  it('lets the authenticated engine bridge invoke policy-bounded unattended completion', async () => {
    tasks.complete.mockResolvedValueOnce({
      success: true,
      data: { id: TASK_ID, completion_idempotency_replayed: true } as any,
    });
    await expect(bridgeCaller().completeUnattended({
      engineTaskId: TASK_ID,
      idempotencyKey: 'unattended-complete-bridge-0001',
    })).resolves.toEqual({
      engineTaskId: TASK_ID,
      lifecycleState: 'PAYOUT_READY',
      payoutState: 'READY',
      idempotencyReplayed: true,
    });
    expect(tasks.complete).toHaveBeenCalledWith(TASK_ID, undefined, {
      mode: 'UNATTENDED',
      idempotencyKey: 'unattended-complete-bridge-0001',
      actorId: ADMIN_ID,
    });
  });

  it('turns a verified poster confirmation into canonical payout-ready state', async () => {
    completion.confirm.mockResolvedValueOnce({
      success: true,
      data: { id: TASK_ID, completion_idempotency_replayed: false } as any,
    });
    await expect(caller().confirmPosterCompletion({
      engineTaskId: TASK_ID,
      providerConfirmationId: 'SM-confirmed-1234',
      score: 5,
    })).resolves.toEqual({
      engineTaskId: TASK_ID,
      lifecycleState: 'PAYOUT_READY',
      payoutState: 'READY',
      idempotencyReplayed: false,
    });
    expect(completion.confirm).toHaveBeenCalledWith({
      taskId: TASK_ID,
      providerConfirmationId: 'SM-confirmed-1234',
      score: 5,
      actorId: ADMIN_ID,
    });
  });

  it('rejects ambiguous scores at the canonical completion boundary', async () => {
    await expect(caller().confirmPosterCompletion({
      engineTaskId: TASK_ID,
      providerConfirmationId: 'SM-confirmed-1234',
      score: 3 as 5,
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(completion.confirm).not.toHaveBeenCalled();
  });

  it('fails closed when canonical completion service rejects the transition', async () => {
    completion.confirm.mockResolvedValueOnce({
      success: false, error: { code: 'INVALID_STATE', message: 'proof missing' },
    });
    await expect(caller().confirmPosterCompletion({
      engineTaskId: TASK_ID,
      providerConfirmationId: 'SM-confirmed-1234',
      score: 5,
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('records a verified poster review in the canonical rating system', async () => {
    rating.record.mockResolvedValueOnce({
      success: true,
      data: {
        taskId: TASK_ID, ratingId: 'rating-1', score: 5, idempotencyReplayed: false,
      },
    });
    await expect(caller().submitPosterRating({
      engineTaskId: TASK_ID, providerReviewId: 'SM-review-1234', score: 5,
    })).resolves.toEqual({
      engineTaskId: TASK_ID, ratingId: 'rating-1', score: 5, idempotencyReplayed: false,
    });
    expect(rating.record).toHaveBeenCalledWith({
      taskId: TASK_ID, providerReviewId: 'SM-review-1234', score: 5, actorId: ADMIN_ID,
    });
  });

  it('validates and fails closed on poster review submissions', async () => {
    await expect(caller().submitPosterRating({
      engineTaskId: TASK_ID, providerReviewId: 'short', score: 5,
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    rating.record.mockResolvedValueOnce({
      success: false, error: { code: 'INVALID_STATE', message: 'not completed' },
    });
    await expect(caller().submitPosterRating({
      engineTaskId: TASK_ID, providerReviewId: 'SM-review-1234', score: 3,
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('records ON MY WAY in the canonical engine progress state', async () => {
    tasks.getById.mockResolvedValueOnce({
      success: true, data: { id: TASK_ID, worker_id: 'worker-1' } as any,
    });
    tasks.advanceProgress.mockResolvedValueOnce({
      success: true, data: { id: TASK_ID, progress_state: 'TRAVELING' } as any,
    });
    await expect(caller().markWorkerTraveling({ engineTaskId: TASK_ID })).resolves.toEqual({
      engineTaskId: TASK_ID, progressState: 'TRAVELING',
    });
    expect(tasks.advanceProgress).toHaveBeenCalledWith({
      taskId: TASK_ID,
      to: 'TRAVELING',
      actor: { type: 'worker', userId: 'worker-1' },
    });
  });

  it('rejects traveling progress without a canonical task or reserved hustler', async () => {
    tasks.getById.mockResolvedValueOnce({
      success: false, error: { code: 'NOT_FOUND', message: 'missing' },
    });
    await expect(caller().markWorkerTraveling({ engineTaskId: TASK_ID }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    tasks.getById.mockResolvedValueOnce({
      success: true, data: { id: TASK_ID, worker_id: null } as any,
    });
    await expect(caller().markWorkerTraveling({ engineTaskId: TASK_ID }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('maps canonical traveling transition failures', async () => {
    tasks.getById.mockResolvedValueOnce({
      success: true, data: { id: TASK_ID, worker_id: 'worker-1' } as any,
    });
    tasks.advanceProgress.mockResolvedValueOnce({
      success: false, error: { code: 'INVALID_STATE', message: 'not accepted' },
    });
    await expect(caller().markWorkerTraveling({ engineTaskId: TASK_ID }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('maps lifecycle read errors without leaking service internals', async () => {
    seedPlatformAdmin();
    lifecycle.listTasks.mockResolvedValueOnce({
      success: false, error: { code: 'INVALID_CURSOR', message: 'bad cursor' },
    });
    await expect(caller().listTasks({ limit: 20, cursor: 'bad' }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('maps idempotency conflicts on expiry', async () => {
    seedPlatformAdmin();
    lifecycle.expireUnfilled.mockResolvedValueOnce({
      success: false, error: { code: 'IDEMPOTENCY_CONFLICT', message: 'different task' },
    });
    await expect(caller().expireUnfilled({
      engineTaskId: TASK_ID, idempotencyKey: 'dispatch-expiry-0001',
    })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('maps expiry scheduler database failures', async () => {
    seedPlatformAdmin();
    lifecycle.expireDue.mockResolvedValueOnce({
      success: false, error: { code: 'DB_ERROR', message: 'offline' },
    });
    await expect(caller().expireDue({ limit: 50 }))
      .rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });

  it('returns a successful bounded expiry scheduler result', async () => {
    seedPlatformAdmin();
    lifecycle.expireDue.mockResolvedValueOnce({
      success: true,
      data: { inspected: 1, expired: 1, blocked: 0, results: [] },
    });
    await expect(caller().expireDue({ limit: 10 })).resolves.toEqual({
      inspected: 1, expired: 1, blocked: 0, results: [],
    });
  });

  it('maps missing completion-delivery tasks', async () => {
    tasks.recordCompletionDelivery.mockResolvedValueOnce({
      success: false, error: { code: 'NOT_FOUND', message: 'missing' },
    });
    await expect(caller().recordCompletionDelivery({
      engineTaskId: TASK_ID,
      providerDeliveryId: 'SM-delivered-1',
      channel: 'SMS',
      deliveredAt: '2026-07-10T12:00:00.000Z',
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('maps unattended completion policy blocks', async () => {
    tasks.complete.mockResolvedValueOnce({
      success: false, error: { code: 'COMPLETION_WAIT_ACTIVE', message: 'wait active' },
    });
    await expect(caller().completeUnattended({
      engineTaskId: TASK_ID, idempotencyKey: 'unattended-complete-0001',
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('notifies the worker only after a fresh local TEST payout reaches escrow release', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        task_id: TASK_ID,
        worker_id: ADMIN_ID,
        automation_classification: 'CONTROLLED_TEST',
        escrow_id: '550e8400-e29b-41d4-a716-446655440009',
      }],
      rowCount: 1,
    } as any);
    localPayout.createPaidTransfer.mockResolvedValueOnce({
      success: true,
      data: {
        transferId: 'tr_hxos_test_0123456789abcdef0123456789abcdef',
        provider: 'LOCAL_CERTIFICATION_TEST',
        status: 'paid',
        amountCents: 9490,
        isTest: true,
        idempotencyReplayed: false,
      },
    });
    escrows.release.mockResolvedValueOnce({
      success: true,
      data: { id: '550e8400-e29b-41d4-a716-446655440009', state: 'RELEASED' } as any,
    });

    await expect(bridgeCaller().settleLocalTestPayout({
      engineTaskId: TASK_ID,
      idempotencyKey: 'settle:test:fresh-0001',
    })).resolves.toMatchObject({
      provider: 'LOCAL_CERTIFICATION_TEST',
      providerStatus: 'paid',
      escrowState: 'RELEASED',
      idempotencyReplayed: false,
    });
    expect(mockNotifyPaymentReleased).toHaveBeenCalledOnce();
    expect(mockNotifyPaymentReleased).toHaveBeenCalledWith(ADMIN_ID, TASK_ID, 9490);
  });

  it('treats a canonical terminal escrow code as successful exact TEST settlement convergence', async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{
          task_id: TASK_ID,
          worker_id: ADMIN_ID,
          automation_classification: 'CONTROLLED_TEST',
          escrow_id: '550e8400-e29b-41d4-a716-446655440009',
        }],
        rowCount: 1,
      } as any)
      .mockResolvedValueOnce({
        rows: [{
          state: 'RELEASED',
          payout_provider: 'LOCAL_CERTIFICATION_TEST',
          provider_transfer_id: 'tr_hxos_test_0123456789abcdef0123456789abcdef',
          provider_transfer_status: 'paid',
        }],
        rowCount: 1,
      } as any);
    localPayout.createPaidTransfer.mockResolvedValueOnce({
      success: true,
      data: {
        transferId: 'tr_hxos_test_0123456789abcdef0123456789abcdef',
        provider: 'LOCAL_CERTIFICATION_TEST',
        status: 'paid',
        amountCents: 9490,
        isTest: true,
        idempotencyReplayed: true,
      },
    });
    escrows.release.mockResolvedValueOnce({
      success: false,
      error: { code: ErrorCodes.ESCROW_TERMINAL, message: 'already released' },
    });

    await expect(bridgeCaller().settleLocalTestPayout({
      engineTaskId: TASK_ID,
      idempotencyKey: 'settle:test:replay-0001',
    })).resolves.toMatchObject({
      transferId: 'tr_hxos_test_0123456789abcdef0123456789abcdef',
      escrowState: 'RELEASED',
      idempotencyReplayed: true,
    });
    expect(mockNotifyPaymentReleased).toHaveBeenCalledOnce();
    expect(mockNotifyPaymentReleased).toHaveBeenCalledWith(ADMIN_ID, TASK_ID, 9490);
  });

  it('fails a terminal TEST settlement replay when exact transfer convergence is absent', async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{
          task_id: TASK_ID,
          worker_id: ADMIN_ID,
          automation_classification: 'CONTROLLED_TEST',
          escrow_id: '550e8400-e29b-41d4-a716-446655440009',
        }],
        rowCount: 1,
      } as any)
      .mockResolvedValueOnce({
        rows: [{
          state: 'RELEASED',
          payout_provider: 'LOCAL_CERTIFICATION_TEST',
          provider_transfer_id: 'tr_hxos_test_ffffffffffffffffffffffffffffffff',
          provider_transfer_status: 'paid',
        }],
        rowCount: 1,
      } as any);
    localPayout.createPaidTransfer.mockResolvedValueOnce({
      success: true,
      data: {
        transferId: 'tr_hxos_test_0123456789abcdef0123456789abcdef',
        provider: 'LOCAL_CERTIFICATION_TEST',
        status: 'paid',
        amountCents: 9490,
        isTest: true,
        idempotencyReplayed: true,
      },
    });
    escrows.release.mockResolvedValueOnce({
      success: false,
      error: { code: ErrorCodes.ESCROW_TERMINAL, message: 'already released' },
    });

    await expect(bridgeCaller().settleLocalTestPayout({
      engineTaskId: TASK_ID,
      idempotencyKey: 'settle:test:replay-0002',
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});
