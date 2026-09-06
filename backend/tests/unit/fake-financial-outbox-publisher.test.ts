import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { QueryFn } from '../../src/database-contracts.js';
import {
  FakeFinancialOutboxPublisher,
  PostgresFakeFinancialOutboxRepository,
  type FakeFinancialOutboxClaim,
  type FakeFinancialOutboxDatabase,
} from '../../src/jobs/fake-financial-outbox-publisher.js';

function claim(): FakeFinancialOutboxClaim {
  const commandId = randomUUID();
  const requestId = randomUUID();
  return {
    publish_claim_id: randomUUID(),
    outbox_request_id: requestId,
    command_id: commandId,
    bullmq_job_id: `hx-fake-fin-${commandId.replaceAll('-', '')}-${'a'.repeat(64)}`,
    queue_name: 'synthetic_finance',
    job_name: 'synthetic_finance.command.v13',
    job_payload: {
      version: 1,
      kind: 'UNIVERSAL_V1_FAKE_FINANCIAL_COMMAND',
      outboxRequestId: requestId,
      commandId,
      jobAuthoritySha256: 'a'.repeat(64),
    },
    job_authority_sha256: 'a'.repeat(64),
    claim_number: 1,
    lease_expires_at: new Date(Date.now() + 60_000),
  };
}
function stored(row: FakeFinancialOutboxClaim) {
  return {
    id: row.bullmq_job_id,
    queueName: row.queue_name,
    name: row.job_name,
    data: { ...row.job_payload },
    opts: {
      jobId: row.bullmq_job_id,
      attempts: 64,
      backoff: { type: 'fixed', delay: 5000 },
      removeOnComplete: false,
      removeOnFail: false,
    },
  };
}
function fixture(row: unknown = claim(), failCommit?: 'claim' | 'outcome') {
  const order: string[] = [];
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('hxos_claim_fake_financial_outbox_v13'))
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    return { rows: [{ outcome_id: randomUUID() }], rowCount: 1 };
  });
  let transactions = 0;
  const database: FakeFinancialOutboxDatabase = {
    transaction: async (callback) => {
      const kind = ++transactions === 1 ? 'claim' : 'outcome';
      order.push(`begin:${kind}`);
      try {
        const result = await callback(query as unknown as QueryFn);
        if (failCommit === kind) throw new Error('commit connection lost; confidential detail');
        order.push(`commit:${kind}`);
        return result;
      } catch (error) {
        order.push(`rollback:${kind}`);
        throw error;
      }
    },
  };
  const repository = new PostgresFakeFinancialOutboxRepository(database);
  const publish = vi.fn(async (value: FakeFinancialOutboxClaim) => {
    order.push('redis');
    return stored(value);
  });
  const authorized = vi.fn();
  const publisher = new FakeFinancialOutboxPublisher(repository, { publish }, authorized, {
    publisherId: randomUUID(),
    batchLimit: 1,
  });
  return { order, query, repository, publish, authorized, publisher };
}

describe('durable fake-financial outbox publisher', () => {
  it('commits a sealed claim before Redis and acknowledges only matching stored-job readback', async () => {
    const f = fixture();
    expect(await f.publisher.runOnce()).toEqual({
      claimed: 1,
      confirmed: 1,
      retryableFailures: 0,
      terminalFailures: 0,
      persistenceErrors: 0,
    });
    expect(f.order).toEqual([
      'begin:claim',
      'commit:claim',
      'redis',
      'begin:outcome',
      'commit:outcome',
    ]);
    expect(f.authorized).toHaveBeenCalledTimes(3);
    const row = f.publish.mock.calls[0]![0];
    expect(f.query.mock.calls[1]).toEqual([
      expect.stringContaining('hxos_record_fake_financial_publish_outcome_v13'),
      [
        row.publish_claim_id,
        'BULLMQ_CONFIRMED',
        row.bullmq_job_id,
        row.job_authority_sha256,
        null,
        null,
      ],
    ]);
    expect(Object.isFrozen(row)).toBe(true);
    expect(Object.isFrozen(row.job_payload)).toBe(true);
  });
  it('never sends a claim whose commit was not acknowledged', async () => {
    const f = fixture(claim(), 'claim');
    await expect(f.publisher.runOnce()).rejects.toThrow('commit connection lost');
    expect(f.publish).not.toHaveBeenCalled();
  });
  it('records uncertain Redis acceptance as a retry and does not expose transport details', async () => {
    const f = fixture();
    f.publish.mockRejectedValueOnce(new Error('redis://secret:password@internal:6379'));
    expect(await f.publisher.runOnce()).toMatchObject({ confirmed: 0, retryableFailures: 1 });
    expect(f.query.mock.calls[1]?.[1]).toEqual([
      expect.any(String),
      'RETRYABLE_FAILURE',
      null,
      null,
      'REDIS_PUBLICATION_UNCONFIRMED',
      5,
    ]);
  });
  it.each(['id', 'queueName', 'name', 'payload', 'extra-payload-field'])(
    'holds a colliding stored job with wrong %s without overwriting it',
    async (mismatch) => {
      const f = fixture();
      f.publish.mockImplementationOnce(async (row) => {
        const observed = stored(row);
        if (mismatch === 'payload') observed.data.commandId = randomUUID();
        else if (mismatch === 'extra-payload-field')
          Object.assign(observed.data, { rawPayload: 'must not propagate' });
        else Object.assign(observed, { [mismatch]: 'wrong' });
        return observed;
      });
      expect(await f.publisher.runOnce()).toMatchObject({ confirmed: 0, terminalFailures: 1 });
      expect(f.query.mock.calls[1]?.[1]).toEqual([
        expect.any(String),
        'TERMINAL_FAILURE',
        null,
        null,
        'REDIS_JOB_IDENTITY_MISMATCH',
        null,
      ]);
    }
  );
  it('does not guess successful persistence or write a competing failure after lost outcome acknowledgement', async () => {
    const f = fixture(claim(), 'outcome');
    expect(await f.publisher.runOnce()).toMatchObject({
      claimed: 1,
      confirmed: 0,
      persistenceErrors: 1,
    });
    expect(f.query).toHaveBeenCalledTimes(2);
    expect(f.publish).toHaveBeenCalledTimes(1);
  });
  it.each([
    { delay: 31_536_000_000 },
    { attempts: 1 },
    { removeOnComplete: true },
    { parent: { id: 'blocked', queue: 'other' } },
    { repeat: { every: 1000 } },
  ])('holds canonical data with tampered stored delivery options: %j', async (tampered) => {
    const f = fixture();
    f.publish.mockImplementationOnce(async (row) => {
      const observed = stored(row);
      Object.assign(observed.opts, tampered);
      return observed;
    });
    expect(await f.publisher.runOnce()).toMatchObject({ confirmed: 0, terminalFailures: 1 });
  });
  it.each(['extra', 'mismatch', 'wrong-queue'])(
    'rejects a malformed database claim (%s) before transport',
    async (variant) => {
      const row = claim();
      if (variant === 'extra') Object.assign(row.job_payload, { customerId: 'private' });
      else if (variant === 'mismatch') row.job_payload.commandId = randomUUID();
      else Object.assign(row, { queue_name: 'critical_payments' });
      const f = fixture(row);
      await expect(f.publisher.runOnce()).rejects.toThrow(/FAKE_FINANCIAL_OUTBOX_CLAIM/u);
      expect(f.publish).not.toHaveBeenCalled();
      expect(f.order).toEqual(['begin:claim', 'rollback:claim']);
    }
  );
  it('refuses fabricated or reused claim acknowledgements', async () => {
    const f = fixture();
    await expect(f.repository.recordOutcome(claim(), { kind: 'BULLMQ_CONFIRMED' })).rejects.toThrow(
      'CLAIM_NOT_ISSUED'
    );
    const issued = (await f.repository.claim(randomUUID(), 60))!;
    await f.repository.recordOutcome(issued, { kind: 'BULLMQ_CONFIRMED' });
    await expect(f.repository.recordOutcome(issued, { kind: 'BULLMQ_CONFIRMED' })).rejects.toThrow(
      'CLAIM_NOT_ISSUED'
    );
  });
  it('rechecks capability after claim before publishing', async () => {
    const f = fixture();
    f.authorized
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('CAPABILITY_DENIED');
      });
    await expect(f.publisher.runOnce()).rejects.toThrow('CAPABILITY_DENIED');
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.query).toHaveBeenCalledTimes(1);
  });
  it('leaves lease recovery to PostgreSQL when shutdown arrives after Redis acceptance', async () => {
    const controller = new AbortController();
    const f = fixture();
    f.publish.mockImplementationOnce(async (row) => {
      controller.abort();
      return stored(row);
    });
    expect(await f.publisher.runOnce(controller.signal)).toMatchObject({
      claimed: 1,
      confirmed: 0,
    });
    expect(f.query).toHaveBeenCalledTimes(1);
  });
  it('does no work when stopped or no eligible durable claim exists', async () => {
    const f = fixture(null);
    const controller = new AbortController();
    controller.abort();
    expect(await f.publisher.runOnce(controller.signal)).toMatchObject({ claimed: 0 });
    expect(f.query).not.toHaveBeenCalled();
    expect(await f.publisher.runOnce()).toMatchObject({ claimed: 0 });
    expect(f.publish).not.toHaveBeenCalled();
  });
});
