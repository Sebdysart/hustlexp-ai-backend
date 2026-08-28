// backend/tests/unit/outbox-helpers.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/jobs/queues.js', () => ({
  generateIdempotencyKey: (eventType: string, aggregateId: string, version: number = 1) =>
    `${eventType}:${aggregateId}:v${version}`,
}));

vi.mock('../../src/db.js', () => ({
  db: {
    query: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('../../src/logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { db } from '../../src/db.js';
import {
  writeToOutbox,
  writeBatchToOutbox,
  executeWithOutbox,
  type OutboxEventInput,
} from '../../src/lib/outbox-helpers.js';

const mockDb = vi.mocked(db);

const OUTBOX_ID = 'outbox-uuid-0001';

const makeInput = (overrides: Partial<OutboxEventInput> = {}): OutboxEventInput => ({
  eventType: 'escrow.funded',
  aggregateType: 'escrow',
  aggregateId: 'escrow-001',
  payload: { amount: 5000, currency: 'USD' },
  queueName: 'escrow' as any,
  ...overrides,
});

// ============================================================================
// writeToOutbox
// ============================================================================

describe('writeToOutbox', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('inserts a new outbox event and returns id + idempotencyKey', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: OUTBOX_ID }],
      rowCount: 1,
    } as any);

    const result = await writeToOutbox(makeInput());

    expect(result.id).toBe(OUTBOX_ID);
    expect(typeof result.idempotencyKey).toBe('string');
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO outbox_events'),
      expect.arrayContaining(['escrow.funded', 'escrow', 'escrow-001'])
    );
  });

  it('uses provided idempotencyKey when given', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: OUTBOX_ID }],
      rowCount: 1,
    } as any);

    const customKey = 'my-custom-key-123';
    const result = await writeToOutbox(makeInput({ idempotencyKey: customKey }));

    expect(result.idempotencyKey).toBe(customKey);
    // Confirm the custom key was passed to db.query
    const [, params] = (mockDb.query as any).mock.calls[0];
    expect(params).toContain(customKey);
  });

  it('fetches existing row when conflict (rowCount=0)', async () => {
    // INSERT ON CONFLICT returns 0 rows
    mockDb.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      // SELECT existing
      .mockResolvedValueOnce({ rows: [{ id: 'existing-id' }], rowCount: 1 } as any);

    const result = await writeToOutbox(makeInput());

    expect(result.id).toBe('existing-id');
    expect(mockDb.query).toHaveBeenCalledTimes(2);
    // Second call is a SELECT
    const [sql] = (mockDb.query as any).mock.calls[1];
    expect(sql).toContain('SELECT id FROM outbox_events');
  });

  it('throws when conflict and existing row not found', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any) // conflict
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any); // still not found

    await expect(writeToOutbox(makeInput())).rejects.toThrow(
      'Failed to insert outbox event'
    );
  });

  it('uses a custom queryFn when provided', async () => {
    const customQuery = vi.fn().mockResolvedValueOnce({
      rows: [{ id: 'custom-id' }],
      rowCount: 1,
    } as any);

    const result = await writeToOutbox(makeInput(), customQuery as any);

    expect(result.id).toBe('custom-id');
    expect(customQuery).toHaveBeenCalled();
    // db.query should NOT have been called
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('defaults event_version to 1 when not provided', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: OUTBOX_ID }],
      rowCount: 1,
    } as any);

    await writeToOutbox(makeInput());

    const [, params] = (mockDb.query as any).mock.calls[0];
    expect(params[3]).toBe(1); // event_version = 4th param
  });

  it('uses provided eventVersion', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: OUTBOX_ID }],
      rowCount: 1,
    } as any);

    await writeToOutbox(makeInput({ eventVersion: 3 }));

    const [, params] = (mockDb.query as any).mock.calls[0];
    expect(params[3]).toBe(3);
  });
});

// ============================================================================
// writeBatchToOutbox
// ============================================================================

describe('writeBatchToOutbox', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('processes multiple events and returns all results', async () => {
    // Each INSERT returns 1 row
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: 'id-1' }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{ id: 'id-2' }], rowCount: 1 } as any);

    const inputs = [
      makeInput({ eventType: 'task.created', aggregateId: 'task-001' }),
      makeInput({ eventType: 'task.assigned', aggregateId: 'task-001' }),
    ];

    const results = await writeBatchToOutbox(inputs);

    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('id-1');
    expect(results[1].id).toBe('id-2');
  });

  it('returns empty array for empty inputs', async () => {
    const results = await writeBatchToOutbox([]);
    expect(results).toHaveLength(0);
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('handles conflict on one event (fetches existing)', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: 'id-1' }], rowCount: 1 } as any) // event 1 ok
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)               // event 2 conflict
      .mockResolvedValueOnce({ rows: [{ id: 'existing-2' }], rowCount: 1 } as any); // SELECT existing

    const inputs = [
      makeInput({ eventType: 'task.created', aggregateId: 'task-001' }),
      makeInput({ eventType: 'task.funded', aggregateId: 'task-001' }),
    ];

    const results = await writeBatchToOutbox(inputs);

    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('id-1');
    expect(results[1].id).toBe('existing-2');
  });

  it('throws when conflict and existing row not found in batch', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)  // conflict
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any); // not found

    await expect(writeBatchToOutbox([makeInput()])).rejects.toThrow(
      'Failed to insert outbox event'
    );
  });

  it('uses custom queryFn for all events', async () => {
    const customQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'custom-1' }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{ id: 'custom-2' }], rowCount: 1 } as any);

    const results = await writeBatchToOutbox(
      [
        makeInput({ aggregateId: 'agg-1' }),
        makeInput({ aggregateId: 'agg-2' }),
      ],
      customQuery as any
    );

    expect(results).toHaveLength(2);
    expect(customQuery).toHaveBeenCalledTimes(2);
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});

// ============================================================================
// executeWithOutbox
// ============================================================================

describe('executeWithOutbox', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('executes domain operation and writes single outbox event', async () => {
    const domainResult = { taskId: 'task-001', status: 'created' };
    const outboxResult = { id: OUTBOX_ID, idempotencyKey: 'escrow.funded:escrow-001:v1' };

    // db.transaction invokes the callback with a mock queryFn
    mockDb.transaction.mockImplementation(async (fn: (q: any) => Promise<any>) => {
      const transactionQuery = vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: OUTBOX_ID }], rowCount: 1 } as any);
      return fn(transactionQuery);
    });

    const result = await executeWithOutbox(
      async () => domainResult,
      makeInput()
    );

    expect(result.domainResult).toEqual(domainResult);
    expect((result.outboxResult as typeof outboxResult).id).toBe(OUTBOX_ID);
    expect(mockDb.transaction).toHaveBeenCalled();
  });

  it('executes domain operation and writes batch outbox events', async () => {
    const domainResult = { escrowId: 'escrow-001', funded: true };

    mockDb.transaction.mockImplementation(async (fn: (q: any) => Promise<any>) => {
      const transactionQuery = vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: 'id-1' }], rowCount: 1 } as any)
        .mockResolvedValueOnce({ rows: [{ id: 'id-2' }], rowCount: 1 } as any);
      return fn(transactionQuery);
    });

    const result = await executeWithOutbox(async () => domainResult, [
      makeInput({ eventType: 'escrow.funded', aggregateId: 'escrow-001' }),
      makeInput({ eventType: 'task.updated', aggregateId: 'task-001' }),
    ]);

    expect(result.domainResult).toEqual(domainResult);
    expect(Array.isArray(result.outboxResult)).toBe(true);
    expect((result.outboxResult as any[]).length).toBe(2);
  });

  it('propagates domain operation error (transaction rolls back)', async () => {
    mockDb.transaction.mockImplementation(async (fn: (q: any) => Promise<any>) => {
      const transactionQuery = vi.fn();
      return fn(transactionQuery);
    });

    await expect(
      executeWithOutbox(
        async () => { throw new Error('Domain operation failed'); },
        makeInput()
      )
    ).rejects.toThrow('Domain operation failed');
  });
});
