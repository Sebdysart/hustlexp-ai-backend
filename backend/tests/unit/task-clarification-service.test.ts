import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock('../../src/db', () => ({ db: { query: mocks.query, transaction: mocks.transaction } }));
vi.mock('../../src/logger', () => ({
  logger: { child: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
  taskLogger: { child: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
}));

import { TaskClarificationService } from '../../src/services/TaskClarificationService';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const POSTER_ID = '22222222-2222-4222-8222-222222222222';
const WORKER_ID = '33333333-3333-4333-8333-333333333333';
const QUESTION_ID = '44444444-4444-4444-8444-444444444444';
const REVISION_ID = '55555555-5555-4555-8555-555555555555';

function result(rows: unknown[] = []) { return { rows }; }

describe('TaskClarificationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async (callback: (query: typeof mocks.query) => unknown) => callback(mocks.query));
  });

  it('lets only an actively eligible candidate ask one idempotent public-safe question', async () => {
    mocks.query
      .mockResolvedValueOnce(result([{}]))
      .mockResolvedValueOnce(result([{ id: TASK_ID, poster_id: POSTER_ID, state: 'MATCHING' }]))
      .mockResolvedValueOnce(result([{ id: 'offer-1' }]))
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([{
        id: QUESTION_ID, task_id: TASK_ID, asked_by: WORKER_ID,
        question_text: 'Is there an elevator?', status: 'OPEN',
      }]))
      .mockResolvedValueOnce(result([]));

    const response = await TaskClarificationService.ask({
      taskId: TASK_ID, workerId: WORKER_ID,
      question: ' Is there an elevator? ', idempotencyKey: 'question-0001',
    });

    expect(response).toMatchObject({ success: true, data: { id: QUESTION_ID, status: 'OPEN' } });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('worker_offer_decisions'))).toBe(true);
    expect(mocks.query.mock.calls.some(([sql, values]) =>
      String(sql).includes('INSERT INTO task_public_questions') && values?.includes('Is there an elevator?'))).toBe(true);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("clarification_state = 'QUESTION_OPEN'"))).toBe(true);
  });

  it('rejects a candidate without a fresh matching decision before writing a question', async () => {
    mocks.query
      .mockResolvedValueOnce(result([{}]))
      .mockResolvedValueOnce(result([{ id: TASK_ID, poster_id: POSTER_ID, state: 'MATCHING' }]))
      .mockResolvedValueOnce(result([]));

    const response = await TaskClarificationService.ask({
      taskId: TASK_ID, workerId: WORKER_ID,
      question: 'Is there an elevator?', idempotencyKey: 'question-0002',
    });

    expect(response).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO task_public_questions'))).toBe(false);
  });

  it('stores a material answer as a proposal without mutating scope or money', async () => {
    mocks.query
      .mockResolvedValueOnce(result([{}]))
      .mockResolvedValueOnce(result([{
        id: TASK_ID, poster_id: POSTER_ID, state: 'MATCHING',
        active_scope_version_id: 'scope-v1', price: 10000,
      }]))
      .mockResolvedValueOnce(result([{
        id: QUESTION_ID, task_id: TASK_ID, status: 'OPEN',
      }]))
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([{
        id: REVISION_ID, task_id: TASK_ID, source_question_id: QUESTION_ID,
        status: 'PENDING_POSTER_APPROVAL', proposed_customer_total_cents: 12000,
      }]))
      .mockResolvedValueOnce(result([]));

    const response = await TaskClarificationService.answer({
      taskId: TASK_ID, questionId: QUESTION_ID, posterId: POSTER_ID,
      answer: 'Disposal is included if the scope and total are approved.',
      materialRevision: {
        summary: 'Add disposal to haul-away.',
        checklist: ['Load removed items', 'Dispose at an approved facility'],
        customerTotalCents: 12000, hustlerPayoutCents: 9000, platformMarginCents: 3000,
      },
    });

    expect(response).toMatchObject({
      success: true, data: { material: true, revision: { id: REVISION_ID, status: 'PENDING_POSTER_APPROVAL' } },
    });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE tasks SET price'))).toBe(false);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("clarification_state = 'REVISION_PENDING'"))).toBe(true);
    const answerWrite = mocks.query.mock.calls.findIndex(([sql]) => String(sql).includes('UPDATE task_public_questions'));
    const revisionWrite = mocks.query.mock.calls.findIndex(([sql]) => String(sql).includes('INSERT INTO task_clarification_revisions'));
    expect(answerWrite).toBeLessThan(revisionWrite);
  });

  it('approves a material revision only with an untouched pending escrow and creates a new scope version', async () => {
    mocks.query
      .mockResolvedValueOnce(result([{}]))
      .mockResolvedValueOnce(result([{
        id: TASK_ID, poster_id: POSTER_ID, state: 'MATCHING', active_scope_version_id: 'scope-v1',
        title: 'Haul items', description: 'Remove boxed items.', requirements: null,
      }]))
      .mockResolvedValueOnce(result([{
        id: REVISION_ID, task_id: TASK_ID, status: 'PENDING_POSTER_APPROVAL',
        base_scope_version_id: 'scope-v1', proposed_scope_summary: 'Add disposal.',
        proposed_checklist: ['Load removed items', 'Dispose at an approved facility'],
        proposed_customer_total_cents: 12000, proposed_hustler_payout_cents: 9000,
        proposed_platform_margin_cents: 3000,
      }]))
      .mockResolvedValueOnce(result([{ version: 1 }]))
      .mockResolvedValueOnce(result([{ id: 'escrow-1', state: 'PENDING', stripe_payment_intent_id: null }]))
      .mockResolvedValueOnce(result([{ id: 'scope-v2', version: 2, scope_hash: 'a'.repeat(64) }]))
      .mockResolvedValueOnce(result([{ id: REVISION_ID, status: 'APPROVED' }]))
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([]));

    const response = await TaskClarificationService.reviewRevision({
      taskId: TASK_ID, revisionId: REVISION_ID, posterId: POSTER_ID,
      decision: 'APPROVED', reason: 'The revised scope and total are correct.',
    });

    expect(response).toMatchObject({ success: true, data: { status: 'APPROVED', requiresPaymentReauthorization: true } });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO task_scope_versions'))).toBe(true);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("UPDATE escrows") && String(sql).includes("state = 'PENDING'"))).toBe(true);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE tasks') && String(sql).includes('active_scope_version_id'))).toBe(true);
    const revisionApproval = mocks.query.mock.calls.findIndex(([sql]) =>
      String(sql).includes('UPDATE task_clarification_revisions') && String(sql).includes("status = 'APPROVED'"));
    const taskMutation = mocks.query.mock.calls.findIndex(([sql]) =>
      String(sql).includes('UPDATE tasks') && String(sql).includes('active_scope_version_id'));
    expect(revisionApproval).toBeGreaterThan(-1);
    expect(revisionApproval).toBeLessThan(taskMutation);
  });

  it('refuses to approve repricing against a funded or provider-bound escrow', async () => {
    mocks.query
      .mockResolvedValueOnce(result([{}]))
      .mockResolvedValueOnce(result([{
        id: TASK_ID, poster_id: POSTER_ID, state: 'MATCHING', active_scope_version_id: 'scope-v1',
        title: 'Haul items', description: 'Remove boxed items.', requirements: null,
      }]))
      .mockResolvedValueOnce(result([{
        id: REVISION_ID, task_id: TASK_ID, status: 'PENDING_POSTER_APPROVAL',
        base_scope_version_id: 'scope-v1', proposed_scope_summary: 'Add disposal.',
        proposed_checklist: ['Load removed items', 'Dispose at an approved facility'],
        proposed_customer_total_cents: 12000, proposed_hustler_payout_cents: 9000,
        proposed_platform_margin_cents: 3000,
      }]))
      .mockResolvedValueOnce(result([{ version: 1 }]))
      .mockResolvedValueOnce(result([{
        id: 'escrow-1', state: 'FUNDED', stripe_payment_intent_id: 'pi_existing',
      }]));

    const response = await TaskClarificationService.reviewRevision({
      taskId: TASK_ID, revisionId: REVISION_ID, posterId: POSTER_ID,
      decision: 'APPROVED', reason: 'The revised scope and total are correct.',
    });

    expect(response).toMatchObject({ success: false, error: { code: 'PAYMENT_REAUTHORIZATION_REQUIRED' } });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE tasks'))).toBe(false);
  });
});
