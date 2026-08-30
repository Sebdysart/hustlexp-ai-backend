import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  reserve: vi.fn(),
  settle: vi.fn(),
  unknown: vi.fn(),
  release: vi.fn(),
  abortBeforeIO: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({ db: { query: mocks.query } }));
vi.mock('../../src/ai/UserAIBudget.js', () => ({
  reserveAIProviderSpend: mocks.reserve,
  settleAIProviderSpend: mocks.settle,
  markAIProviderSpendUnknown: mocks.unknown,
  releaseAIProviderSpend: mocks.release,
  abortAIProviderSpendBeforeIO: mocks.abortBeforeIO,
}));

import {
  markAIProviderAttemptUnknown,
  releaseAIProviderAttempt,
  reserveAIProviderAttempt,
  settleAIProviderAttempt,
  type AIProviderAttempt,
} from '../../src/ai/AISpendAttemptLedger.js';

const attempt: AIProviderAttempt = {
  reservation: {
    agent: 'judge',
    userId: 'user-1',
    operationId: 'operation-1',
    fingerprint: 'fingerprint-1',
    ownerToken: 'owner-1',
    attemptId: '0:groq:0',
    reserveCents: 9,
    agentLimitCents: 50,
  },
  providerKind: 'groq',
  providerModel: 'llama-test',
};

const subjectRefHash = 'c6c289e49e9c05b2145860387b73bcb18df43fb09a1e4a4a9713c76c88bb541b';

function row(transition: 'RESERVED' | 'UNKNOWN' | 'SETTLED' | 'RELEASED', overrides = {}) {
  return {
    operation_id: 'operation-1',
    attempt_id: '0:groq:0',
    transition,
    agent_type: 'judge',
    subject_ref_hash: subjectRefHash,
    provider_kind: 'groq',
    provider_model: 'llama-test',
    request_fingerprint: 'fingerprint-1',
    budget_day: '20700',
    reserved_cents: 9,
    actual_cost_cents: transition === 'SETTLED' ? 3 : null,
    detail_code: transition === 'UNKNOWN'
      ? 'PROVIDER_OUTCOME_UNKNOWN'
      : transition === 'RELEASED' ? 'PROVEN_NO_PROVIDER_IO' : null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reserve.mockResolvedValue({ status: 'reserved', reservedCents: 9, budgetDay: '20700' });
  mocks.release.mockResolvedValue(undefined);
  mocks.abortBeforeIO.mockResolvedValue(undefined);
  mocks.unknown.mockResolvedValue(undefined);
  mocks.settle.mockResolvedValue(undefined);
  mocks.query.mockResolvedValue({ rows: [row('RESERVED')], rowCount: 1 });
});

describe('durable AI spend attempt authority', () => {
  it('commits the exact RESERVED fact after Redis authority and before provider I/O can begin', async () => {
    await expect(reserveAIProviderAttempt(attempt)).resolves.toMatchObject({
      status: 'reserved', budgetDay: '20700',
    });
    expect(mocks.reserve).toHaveBeenCalledWith(attempt.reservation);
    expect(mocks.reserve.mock.invocationCallOrder[0]).toBeLessThan(mocks.query.mock.invocationCallOrder[0]);
    expect(mocks.query.mock.calls[0][1]).toEqual([
      'operation-1', '0:groq:0', 'judge', subjectRefHash, 'groq', 'llama-test',
      'fingerprint-1', '20700', 9,
    ]);
  });

  it('releases a Redis reservation and denies provider authority when RESERVED persistence fails', async () => {
    mocks.query.mockRejectedValueOnce(new Error('postgres unavailable'));
    await expect(reserveAIProviderAttempt(attempt)).rejects.toThrow(
      'AI_SPEND_RESERVED_LEDGER_REQUIRED_RESERVATION_RELEASED',
    );
    expect(mocks.abortBeforeIO).toHaveBeenCalledWith(attempt.reservation);
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('retains the conservative reservation when both durable insert and release fail', async () => {
    mocks.query.mockRejectedValueOnce(new Error('postgres unavailable'));
    mocks.abortBeforeIO.mockRejectedValueOnce(new Error('redis unavailable'));
    await expect(reserveAIProviderAttempt(attempt)).rejects.toThrow(
      'AI_SPEND_RESERVED_LEDGER_REQUIRED_RESERVATION_RETAINED',
    );
  });

  it('persists terminal truth before mutating Redis', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [row('SETTLED')], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [row('UNKNOWN')], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [row('RELEASED')], rowCount: 1 });

    await settleAIProviderAttempt({ ...attempt, actualCostCents: 3, resultJson: '{"ok":true}' });
    await markAIProviderAttemptUnknown(attempt);
    await releaseAIProviderAttempt(attempt);

    expect(mocks.query.mock.invocationCallOrder[0]).toBeLessThan(mocks.settle.mock.invocationCallOrder[0]);
    expect(mocks.query.mock.invocationCallOrder[1]).toBeLessThan(mocks.unknown.mock.invocationCallOrder[0]);
    expect(mocks.query.mock.invocationCallOrder[2]).toBeLessThan(mocks.release.mock.invocationCallOrder[0]);
  });

  it('keeps RESERVED conservative and does not mutate Redis when a post-provider transition fails', async () => {
    mocks.query.mockRejectedValueOnce(new Error('terminal insert failed'));
    await expect(markAIProviderAttemptUnknown(attempt)).rejects.toThrow('terminal insert failed');
    expect(mocks.unknown).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('rejects conflicting idempotent ledger evidence', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [row('RESERVED', { provider_model: 'different' })], rowCount: 1 });
    await expect(reserveAIProviderAttempt(attempt)).rejects.toThrow(
      'AI_SPEND_RESERVED_LEDGER_REQUIRED_RESERVATION_RELEASED',
    );
  });
});
