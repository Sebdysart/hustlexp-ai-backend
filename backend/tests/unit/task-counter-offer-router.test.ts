import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/WorkerCounterOfferService', () => ({
  WorkerCounterOfferService: {
    getContext: vi.fn(), submit: vi.fn(), review: vi.fn(), materialize: vi.fn(),
  },
}));
vi.mock('../../src/db', () => ({ db: { query: vi.fn() } }));
vi.mock('../../src/auth/firebase', () => ({ firebaseAuth: { verifyIdToken: vi.fn() } }));

import { router } from '../../src/trpc';
import { TaskCounterOfferProcedures } from '../../src/routers/TaskCounterOfferProcedures';
import { WorkerCounterOfferService } from '../../src/services/WorkerCounterOfferService';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const COUNTER_ID = '22222222-2222-4222-8222-222222222222';
const POSTER_ID = '33333333-3333-4333-8333-333333333333';
const WORKER_ID = '44444444-4444-4444-8444-444444444444';
const counterRouter = router({ ...TaskCounterOfferProcedures });
const service = vi.mocked(WorkerCounterOfferService);

function caller(mode: 'poster' | 'worker') {
  const id = mode === 'poster' ? POSTER_ID : WORKER_ID;
  return counterRouter.createCaller({
    user: {
      id, email: `${mode}@example.com`, full_name: mode,
      default_mode: mode, account_status: 'ACTIVE', is_minor: false,
    } as any,
    firebaseUid: `firebase-${mode}`,
  });
}

function counter(status = 'PENDING_POSTER') {
  return {
    id: COUNTER_ID, taskId: TASK_ID, workerId: WORKER_ID, status,
    currentCustomerTotalCents: 5000, currentPayoutCents: 4000,
    platformMarginCents: 1000, minimumCounterPayoutCents: 4100,
    maximumCounterPayoutCents: 4800, customerMaximumCents: 6250,
    marginFloorBps: 1000, proposedPayoutCents: 4500,
    proposedCustomerTotalCents: 5500, reason: 'Bounded proposal reason.',
    replacementTaskId: null, expiresAt: '2026-07-20T12:00:00.000Z',
    requiresPaymentReauthorization: status !== 'PENDING_POSTER', replayed: false,
  } as any;
}

describe('task worker-counter router contract', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the authenticated viewer identity for counter context', async () => {
    service.getContext.mockResolvedValue({
      success: true,
      data: { viewerRole: 'ELIGIBLE_CANDIDATE', corridor: null, activeCounter: null, counterOffers: [] },
    });
    await caller('worker').getWorkerCounterContext({ taskId: TASK_ID });
    expect(service.getContext).toHaveBeenCalledWith({ taskId: TASK_ID, viewerId: WORKER_ID });
  });

  it('allows only Hustler mode to submit and injects worker identity server-side', async () => {
    service.submit.mockResolvedValue({ success: true, data: counter() });
    await caller('worker').submitWorkerCounter({
      taskId: TASK_ID, proposedPayoutCents: 4500,
      reason: 'The stairs justify this bounded proposal.', idempotencyKey: 'counter-submit-0001',
    });
    expect(service.submit).toHaveBeenCalledWith({
      taskId: TASK_ID, workerId: WORKER_ID, proposedPayoutCents: 4500,
      reason: 'The stairs justify this bounded proposal.', idempotencyKey: 'counter-submit-0001',
    });
    await expect(caller('poster').submitWorkerCounter({
      taskId: TASK_ID, proposedPayoutCents: 4500,
      reason: 'The stairs justify this bounded proposal.', idempotencyKey: 'counter-submit-0002',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('allows only Poster mode to review and maps competing approval to conflict', async () => {
    service.review.mockResolvedValue({
      success: false,
      error: { code: 'COUNTER_ALREADY_AUTHORIZED', message: 'Another counter is already authorized.' },
    });
    await expect(caller('poster').reviewWorkerCounter({
      counterOfferId: COUNTER_ID, decision: 'APPROVED',
      reason: 'I approve these exact economics.', idempotencyKey: 'counter-review-0001',
    })).rejects.toMatchObject({ code: 'CONFLICT', message: 'Another counter is already authorized.' });
    await expect(caller('worker').reviewWorkerCounter({
      counterOfferId: COUNTER_ID, decision: 'REJECTED',
      reason: 'This caller must never review counters.', idempotencyKey: 'counter-review-0002',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('requires Poster mode and a fresh address to materialize', async () => {
    service.materialize.mockResolvedValue({ success: true, data: counter('MATERIALIZED') });
    await caller('poster').materializeWorkerCounter({
      counterOfferId: COUNTER_ID,
      replacementLocation: '202 Fresh Address, Seattle, WA 98101',
      idempotencyKey: 'counter-replace-0001',
    });
    expect(service.materialize).toHaveBeenCalledWith({
      counterOfferId: COUNTER_ID, posterId: POSTER_ID,
      replacementLocation: '202 Fresh Address, Seattle, WA 98101',
      idempotencyKey: 'counter-replace-0001',
    });
    await expect(caller('worker').materializeWorkerCounter({
      counterOfferId: COUNTER_ID,
      replacementLocation: '202 Fresh Address, Seattle, WA 98101',
      idempotencyKey: 'counter-replace-0002',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
