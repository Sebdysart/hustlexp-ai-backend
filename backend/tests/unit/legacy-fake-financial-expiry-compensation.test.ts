import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { Database } from '../../src/db.js';
import {
  FakeFinancialProvider,
  InMemoryFakeFinancialOperationRepository,
} from '../../src/services/payment/FakeFinancialProvider.js';
import {
  LegacyFakeFinancialExpiryCompensationWorker,
  PostgresLegacyFakeFinancialExpiryCompensationRepository,
  type LegacyFakeFinancialExpiryCompensationCandidate,
  type LegacyFakeFinancialExpiryCompensationRepository,
} from '../../src/services/payment/LegacyFakeFinancialExpiryCompensation.js';

const ids = {
  sourceEvent: '00000000-0000-4000-8000-000000009001',
  sourceOperation: '00000000-0000-4000-8000-000000009002',
  command: '00000000-0000-4000-8000-000000009003',
  attempt: '00000000-0000-4000-8000-000000009004',
  outcome: '00000000-0000-4000-8000-000000009005',
} as const;

function compensationOperationId(sourceEventId: string): string {
  const digest = createHash('sha256')
    .update(`hustlexp:legacy-fake-expiry-compensation:v9:${sourceEventId}`, 'utf8')
    .digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

class MemoryCompensationRepository implements LegacyFakeFinancialExpiryCompensationRepository {
  readonly calls: string[] = [];
  completed = false;
  failRecordOnce = false;
  private failed = false;

  constructor(private readonly candidate: LegacyFakeFinancialExpiryCompensationCandidate) {}

  async findRequired(): Promise<readonly LegacyFakeFinancialExpiryCompensationCandidate[]> {
    this.calls.push('find');
    return this.completed ? [] : [this.candidate];
  }

  async prepareCommand(sourceEventId: string, providerRequestSha256: string) {
    this.calls.push('prepare');
    return {
      commandId: ids.command,
      sourceEventId,
      compensationOperationId: compensationOperationId(sourceEventId),
      compensationOperationKind:
        this.candidate.sourceOperationKind === 'ADJUST' ? ('REVERSAL' as const) : ('VOID' as const),
      compensationIdempotencyKey: `legacy-expiry-compensation:v9:${sourceEventId}`,
      amountCents: this.candidate.amountCents,
      currency: this.candidate.currency,
      providerRequestSha256,
      idempotencyReplayed: this.calls.filter((call) => call === 'prepare').length > 1,
    };
  }

  async recordDispatchAttempt(commandId: string) {
    this.calls.push('attempt');
    return {
      dispatchAttemptId: ids.attempt,
      commandId,
      idempotencyReplayed: this.calls.filter((call) => call === 'attempt').length > 1,
    };
  }

  async recordCompensation(
    sourceEventId: string,
    compensationEventId: string,
    commandId: string,
    dispatchAttemptId: string
  ) {
    this.calls.push('record');
    if (this.failRecordOnce && !this.failed) {
      this.failed = true;
      throw new Error('SIMULATED_POST_PROVIDER_CRASH');
    }
    this.completed = true;
    const operationKind =
      this.candidate.sourceOperationKind === 'ADJUST' ? ('REVERSAL' as const) : ('VOID' as const);
    return {
      sourceEventId,
      compensationEventId,
      compensationOperationId: compensationOperationId(sourceEventId),
      compensationOperationKind: operationKind,
      compensationProviderState:
        operationKind === 'REVERSAL' ? ('REVERSED' as const) : ('VOIDED' as const),
      commandId,
      dispatchAttemptId,
      outcomeFactId: ids.outcome,
      idempotencyReplayed: this.failed,
    };
  }
}

function fixture(sourceOperationKind: 'AUTHORIZE' | 'SECURE' | 'ADJUST' = 'AUTHORIZE') {
  const candidate = {
    sourceEventId: ids.sourceEvent,
    sourceOperationId: ids.sourceOperation,
    sourceOperationKind,
    amountCents: 12_500,
    currency: 'usd',
  } as const;
  const repository = new MemoryCompensationRepository(candidate);
  const fakeEvents = new InMemoryFakeFinancialOperationRepository(
    () => new Date('2030-01-01T00:00:00.000Z')
  );
  const authorize = vi.fn();
  const worker = new LegacyFakeFinancialExpiryCompensationWorker(
    repository,
    new FakeFinancialProvider(fakeEvents),
    fakeEvents,
    authorize
  );
  return { authorize, fakeEvents, repository, worker };
}

describe('LegacyFakeFinancialExpiryCompensationWorker', () => {
  it.each([
    ['AUTHORIZE', 'VOID', 'VOIDED'],
    ['SECURE', 'VOID', 'VOIDED'],
    ['ADJUST', 'REVERSAL', 'REVERSED'],
  ] as const)(
    'seals command and attempt before exact %s compensation',
    async (sourceKind, expectedKind, expectedState) => {
      const { authorize, fakeEvents, repository, worker } = fixture(sourceKind);

      await expect(worker.runOnce()).resolves.toEqual({
        attempted: 1,
        compensated: 1,
        replayed: 0,
      });
      expect(repository.calls).toEqual(['find', 'prepare', 'attempt', 'record']);
      expect(fakeEvents.events()).toHaveLength(1);
      expect(fakeEvents.events()[0]).toMatchObject({
        operationKind: expectedKind,
        state: expectedState,
        relatedOperationId: ids.sourceOperation,
        expiresAt: null,
      });
      await expect(worker.runOnce()).resolves.toEqual({
        attempted: 0,
        compensated: 0,
        replayed: 0,
      });
      expect(fakeEvents.events()).toHaveLength(1);
      expect(authorize).toHaveBeenCalledTimes(3);
    }
  );

  it('replays one provider event after a crash between provider commit and terminal bridge', async () => {
    const { fakeEvents, repository, worker } = fixture('ADJUST');
    repository.failRecordOnce = true;

    const error = await worker.runOnce().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'SIMULATED_POST_PROVIDER_CRASH' }),
    ]);
    expect(fakeEvents.events()).toHaveLength(1);
    await expect(worker.runOnce()).resolves.toEqual({
      attempted: 1,
      compensated: 0,
      replayed: 1,
    });
    expect(fakeEvents.events()).toHaveLength(1);
    expect(repository.completed).toBe(true);
  });

  it('fails closed before repository or provider I/O when nonproduction authority is absent', async () => {
    const { fakeEvents, repository } = fixture();
    const worker = new LegacyFakeFinancialExpiryCompensationWorker(
      repository,
      new FakeFinancialProvider(fakeEvents),
      fakeEvents,
      () => {
        throw new Error('CAPABILITY_DENIED');
      }
    );

    await expect(worker.runOnce()).rejects.toThrow('CAPABILITY_DENIED');
    expect(repository.calls).toEqual([]);
    expect(fakeEvents.events()).toEqual([]);
  });

  it('finishes the bounded deterministic page before surfacing one poison candidate', async () => {
    const poison = new Error('PERSISTENT_POISON_CANDIDATE');
    const candidates = [
      {
        sourceEventId: ids.sourceEvent,
        sourceOperationId: ids.sourceOperation,
        sourceOperationKind: 'AUTHORIZE',
        amountCents: 12_500,
        currency: 'usd',
      },
      {
        sourceEventId: '00000000-0000-4000-8000-000000009011',
        sourceOperationId: '00000000-0000-4000-8000-000000009012',
        sourceOperationKind: 'ADJUST',
        amountCents: 13_500,
        currency: 'usd',
      },
    ] as const;
    const safeCommandId = '00000000-0000-4000-8000-000000009013';
    const safeAttemptId = '00000000-0000-4000-8000-000000009014';
    const safeOutcomeId = '00000000-0000-4000-8000-000000009015';
    const calls: string[] = [];
    const repository: LegacyFakeFinancialExpiryCompensationRepository = {
      findRequired: vi.fn(async (limit: number) => {
        calls.push(`find:${limit}`);
        return candidates;
      }),
      prepareCommand: vi.fn(async (sourceEventId: string, providerRequestSha256: string) => {
        calls.push(`prepare:${sourceEventId}`);
        if (sourceEventId === candidates[0].sourceEventId) throw poison;
        return {
          commandId: safeCommandId,
          sourceEventId,
          compensationOperationId: compensationOperationId(sourceEventId),
          compensationOperationKind: 'REVERSAL',
          compensationIdempotencyKey: `legacy-expiry-compensation:v9:${sourceEventId}`,
          amountCents: candidates[1].amountCents,
          currency: candidates[1].currency,
          providerRequestSha256,
          idempotencyReplayed: false,
        };
      }),
      recordDispatchAttempt: vi.fn(async (commandId: string) => {
        calls.push(`attempt:${commandId}`);
        return {
          dispatchAttemptId: safeAttemptId,
          commandId,
          idempotencyReplayed: false,
        };
      }),
      recordCompensation: vi.fn(
        async (
          sourceEventId: string,
          compensationEventId: string,
          commandId: string,
          dispatchAttemptId: string
        ) => {
          calls.push(`record:${sourceEventId}`);
          return {
            sourceEventId,
            compensationEventId,
            compensationOperationId: compensationOperationId(sourceEventId),
            compensationOperationKind: 'REVERSAL',
            compensationProviderState: 'REVERSED',
            commandId,
            dispatchAttemptId,
            outcomeFactId: safeOutcomeId,
            idempotencyReplayed: false,
          };
        }
      ),
    };
    const fakeEvents = new InMemoryFakeFinancialOperationRepository(
      () => new Date('2030-01-01T00:00:00.000Z')
    );
    const authorize = vi.fn();
    const worker = new LegacyFakeFinancialExpiryCompensationWorker(
      repository,
      new FakeFinancialProvider(fakeEvents),
      fakeEvents,
      authorize
    );

    const error = await worker.runOnce(1).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toBe(
      'LEGACY_FAKE_EXPIRY_COMPENSATION_BATCH_INCOMPLETE'
    );
    expect((error as AggregateError).errors).toEqual([poison]);
    expect(calls).toEqual([
      'find:2',
      `prepare:${candidates[0].sourceEventId}`,
      `prepare:${candidates[1].sourceEventId}`,
      `attempt:${safeCommandId}`,
      `record:${candidates[1].sourceEventId}`,
    ]);
    expect(fakeEvents.events()).toHaveLength(1);
    expect(fakeEvents.events()[0]).toMatchObject({
      operationKind: 'REVERSAL',
      state: 'REVERSED',
      relatedOperationId: candidates[1].sourceOperationId,
    });
    expect(authorize).toHaveBeenCalledTimes(3);
  });

  it('filters unusable rows before the deterministic bounded candidate page', async () => {
    let querySql = '';
    let queryValues: readonly unknown[] = [];
    const database = {
      query: vi.fn(async (sql: string, values: readonly unknown[]) => {
        querySql = sql;
        queryValues = values;
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as Database;
    const repository = new PostgresLegacyFakeFinancialExpiryCompensationRepository(database);

    await expect(repository.findRequired(7)).resolves.toEqual([]);

    expect(queryValues).toEqual([7]);
    for (const predicate of [
      "raw.state = 'SUCCEEDED'",
      "raw.operation_kind IN ('AUTHORIZE', 'SECURE', 'ADJUST')",
      'raw.expires_at IS NULL',
      'raw.amount_cents IS NOT NULL',
      'raw.amount_cents > 0',
      'raw.amount_cents <= 9007199254740991',
      'raw.currency IS NOT NULL',
      "raw.currency ~ '^[a-z]{3}$'",
    ]) {
      expect(querySql.indexOf(predicate)).toBeGreaterThan(-1);
      expect(querySql.indexOf(predicate)).toBeLessThan(querySql.indexOf('ORDER BY'));
    }
    expect(querySql).toContain(
      'ORDER BY disposition.classified_at, disposition.fake_operation_event_id'
    );
    expect(querySql.trimEnd().endsWith('LIMIT $1')).toBe(true);
  });
});
