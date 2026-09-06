import { describe, expect, it, vi } from 'vitest';

import type { Database, QueryFn } from '../../src/db.js';
import { UniversalV1StandardizedQuotePostgresRepository } from '../../src/services/UniversalV1StandardizedQuotePostgresRepository.js';

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const DRAFT_ID = '22222222-2222-4222-8222-222222222222';
const ACCEPTANCE_ID = '33333333-3333-4333-8333-333333333333';
const REQUEST_SHA256 = 'a'.repeat(64);

function databaseError(code: '40001' | '40P01'): Error & { code: string } {
  return Object.assign(new Error(`synthetic database conflict ${code}`), { code });
}

function emptyCurrentStateQuery(): QueryFn {
  return vi.fn(async <Row = Record<string, unknown>>(sql: string) => {
    if (sql.includes('FROM public.task_drafts draft') && sql.includes('JOIN public.users actor')) {
      return { rows: [{}] as Row[], rowCount: 1 };
    }
    if (
      sql.includes('SELECT quote.*') &&
      sql.includes('FROM public.task_draft_standardized_quote_versions quote')
    ) {
      return { rows: [] as Row[], rowCount: 0 };
    }
    throw new Error(`Unexpected standardized-quote retry SQL: ${sql}`);
  });
}

describe('Universal V1 standardized quote repository serialization retries', () => {
  it.each([
    [
      'missing routing',
      {},
      'Readiness routing projection was missing or was not a PostgreSQL boolean.',
    ],
    [
      'null routing',
      { routing_current: null },
      'Readiness routing projection was missing or was not a PostgreSQL boolean.',
    ],
    [
      'missing chain head',
      { routing_current: true },
      'Readiness chain-head projection was missing or was not a PostgreSQL boolean.',
    ],
    [
      'missing expiry',
      { routing_current: true, readiness_chain_head: true },
      'Readiness expiry projection was missing or was not a PostgreSQL boolean.',
    ],
  ])('fails closed when readiness current-state projection is %s', async (
    _label,
    drift,
    expectedMessage
  ) => {
    const query: QueryFn = vi.fn(async <Row = Record<string, unknown>>() => ({
      rows: [
        {
          request_sha256: REQUEST_SHA256,
          readiness_version: 1,
          ...drift,
        },
      ] as unknown as Row[],
      rowCount: 1,
    }));
    const repository = new UniversalV1StandardizedQuotePostgresRepository({
      query,
      serializableTransaction: vi.fn(),
    } as unknown as Database);

    await expect(
      repository.findFakePaymentMethodReplay(
        ACTOR_ID,
        {
          taskDraftId: DRAFT_ID,
          acceptanceFactId: ACCEPTANCE_ID,
          expectedQuoteVersion: 1,
          expectedReadinessVersion: 0,
          idempotencyKey: 'readiness-projection-drift',
          clientTs: 1_800_000_000_000,
        },
        REQUEST_SHA256
      )
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: expectedMessage,
    });
  });

  it('retries one serialization failure and one deadlock before succeeding', async () => {
    const query = emptyCurrentStateQuery();
    let attempts = 0;
    const serializableTransaction = vi.fn(
      async <T>(operation: (transactionQuery: QueryFn) => Promise<T>): Promise<T> => {
        attempts += 1;
        if (attempts === 1) throw databaseError('40001');
        if (attempts === 2) throw databaseError('40P01');
        return operation(query);
      }
    );
    const repository = new UniversalV1StandardizedQuotePostgresRepository({
      query,
      serializableTransaction,
    } as unknown as Database);

    await expect(repository.getCurrent(ACTOR_ID, { taskDraftId: DRAFT_ID })).resolves.toEqual({
      quote: null,
      acceptance: null,
      readiness: null,
      routingCurrent: false,
      acceptanceOpen: false,
      priceLocked: false,
      fakePaymentMethodReady: false,
      actionableState: 'PREPARE_QUOTE_OR_REVIEW_ROUTE',
    });
    expect(serializableTransaction).toHaveBeenCalledTimes(3);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('stops after three serialization failures and returns a bounded conflict', async () => {
    const query = emptyCurrentStateQuery();
    const serializableTransaction = vi.fn(async () => {
      throw databaseError('40001');
    });
    const repository = new UniversalV1StandardizedQuotePostgresRepository({
      query,
      serializableTransaction,
    } as unknown as Database);

    await expect(
      repository.getCurrent(ACTOR_ID, { taskDraftId: DRAFT_ID })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'The standardized quote lifecycle changed concurrently; retry the exact command.',
    });
    expect(serializableTransaction).toHaveBeenCalledTimes(3);
    expect(query).not.toHaveBeenCalled();
  });
});
