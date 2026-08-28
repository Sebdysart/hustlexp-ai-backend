import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/TaskClarificationService', () => ({
  TaskClarificationService: {
    getContext: vi.fn(), ask: vi.fn(), answer: vi.fn(), reviewRevision: vi.fn(),
  },
}));
vi.mock('../../src/db', () => ({ db: { query: vi.fn() } }));
vi.mock('../../src/auth/firebase', () => ({ firebaseAuth: { verifyIdToken: vi.fn() } }));

import { router } from '../../src/trpc';
import { TaskClarificationProcedures } from '../../src/routers/TaskClarificationProcedures';
import { TaskClarificationService } from '../../src/services/TaskClarificationService';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const POSTER_ID = '22222222-2222-4222-8222-222222222222';
const WORKER_ID = '33333333-3333-4333-8333-333333333333';
const QUESTION_ID = '44444444-4444-4444-8444-444444444444';
const REVISION_ID = '55555555-5555-4555-8555-555555555555';
const clarificationRouter = router({ ...TaskClarificationProcedures });
const clarification = vi.mocked(TaskClarificationService);

function caller(mode: 'poster' | 'worker') {
  const id = mode === 'poster' ? POSTER_ID : WORKER_ID;
  return clarificationRouter.createCaller({
    user: {
      id, email: `${mode}@example.com`, full_name: mode,
      default_mode: mode, account_status: 'ACTIVE', is_minor: false,
    } as any,
    firebaseUid: `firebase-${mode}`,
  });
}

describe('task public clarification router contract', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses authenticated viewer identity for the shared public thread', async () => {
    clarification.getContext.mockResolvedValue({
      success: true,
      data: { viewerRole: 'ELIGIBLE_CANDIDATE', task: { id: TASK_ID } as any, questions: [], pendingRevision: null },
    });
    await caller('worker').getClarificationContext({ taskId: TASK_ID });
    expect(clarification.getContext).toHaveBeenCalledWith({ taskId: TASK_ID, viewerId: WORKER_ID });
  });

  it('lets only Hustler mode ask and passes no client-supplied actor identity', async () => {
    clarification.ask.mockResolvedValue({
      success: true,
      data: { id: QUESTION_ID, task_id: TASK_ID, asked_by: WORKER_ID, question_text: 'Is there an elevator?', status: 'OPEN' },
    });
    await caller('worker').askClarification({
      taskId: TASK_ID, question: 'Is there an elevator?', idempotencyKey: 'question-0001',
    });
    expect(clarification.ask).toHaveBeenCalledWith({
      taskId: TASK_ID, workerId: WORKER_ID,
      question: 'Is there an elevator?', idempotencyKey: 'question-0001',
    });
    await expect(caller('poster').askClarification({
      taskId: TASK_ID, question: 'Is there an elevator?', idempotencyKey: 'question-0002',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('requires Poster mode for a material answer and exact reconciled economics', async () => {
    clarification.answer.mockResolvedValue({
      success: true,
      data: { material: true, revision: { id: REVISION_ID, status: 'PENDING_POSTER_APPROVAL' } as any },
    });
    await caller('poster').answerClarification({
      taskId: TASK_ID, questionId: QUESTION_ID,
      answer: 'Disposal is included if this revision is approved.',
      materialRevision: {
        summary: 'Add disposal.', checklist: ['Load items', 'Dispose items'],
        customerTotalCents: 12000, hustlerPayoutCents: 9000, platformMarginCents: 3000,
      },
    });
    expect(clarification.answer).toHaveBeenCalledWith(expect.objectContaining({ posterId: POSTER_ID }));
    await expect(caller('poster').answerClarification({
      taskId: TASK_ID, questionId: QUESTION_ID, answer: 'Bad economics.',
      materialRevision: {
        summary: 'Add disposal.', checklist: ['Dispose items'],
        customerTotalCents: 12000, hustlerPayoutCents: 9000, platformMarginCents: 2000,
      },
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('maps payment reauthorization into a visible precondition failure', async () => {
    clarification.reviewRevision.mockResolvedValue({
      success: false,
      error: { code: 'PAYMENT_REAUTHORIZATION_REQUIRED', message: 'Cancel existing authorization first.' },
    });
    await expect(caller('poster').reviewClarificationRevision({
      taskId: TASK_ID, revisionId: REVISION_ID, decision: 'APPROVED',
      reason: 'The revised scope and total are correct.',
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'Cancel existing authorization first.' });
  });
});
