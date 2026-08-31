import { describe, expect, it, vi } from 'vitest';

import type { Database, QueryFn } from '../../src/db.js';
import {
  UniversalV1CompletionDeliveryError,
  universalV1CompletionDeliveryReceiptHash,
} from '../../src/services/UniversalV1CompletionDeliveryContracts.js';
import { PostgresUniversalV1CompletionDeliveryRepository } from '../../src/services/UniversalV1CompletionDeliveryPostgresRepository.js';

const sink = {
  providerKind: 'SYNTHETIC_SINK' as const,
  serviceIdentity: 'hustlexp.synthetic-communications-sink.v1:00000000-0000-4000-8000-000000000011',
  actorUserId: '00000000-0000-4000-8000-000000000011',
};
const command = {
  schema_version: 1 as const,
  event_type: 'COMPLETION_NOTICE_DELIVERED' as const,
  task_id: '00000000-0000-4000-8000-000000000012',
  work_order_id: '00000000-0000-4000-8000-000000000013',
  submitted_completion_fact_id: '00000000-0000-4000-8000-000000000014',
  expected_completion_version: 1,
  expected_execution_version: 4,
  provider_delivery_id: 'sink-delivery:00000001',
  channel: 'EMAIL' as const,
  delivered_at: '2027-01-15T12:00:00.000Z',
  idempotency_key: 'completion-delivery:test-0001',
  client_ts: '2027-01-15T12:00:01.000Z',
};
const requestHash = universalV1CompletionDeliveryReceiptHash(sink, command);
const receiptRow = {
  id: '00000000-0000-4000-8000-000000000015',
  task_id: command.task_id,
  work_order_id: command.work_order_id,
  expected_completion_fact_id: command.submitted_completion_fact_id,
  provider_delivery_id: command.provider_delivery_id,
  channel: command.channel,
  delivered_at: command.delivered_at,
  provider_kind: sink.providerKind,
  provider_service_identity: sink.serviceIdentity,
  request_sha256: requestHash,
};
const contextRow = {
  work_order_id: command.work_order_id,
  task_id: command.task_id,
  completion_fact_id: command.submitted_completion_fact_id,
  completion_version: command.expected_completion_version,
  completion_kind: 'SUBMITTED',
  completion_scope_version_id: '00000000-0000-4000-8000-000000000016',
  execution_version: command.expected_execution_version,
  execution_state: 'COMPLETION_SUBMITTED',
  execution_completion_fact_id: command.submitted_completion_fact_id,
  execution_scope_version_id: '00000000-0000-4000-8000-000000000016',
  execution_contract_version: 1,
  task_work_order_id: command.work_order_id,
  universal_contract_version: 1,
  automation_classification: 'CONTROLLED_TEST',
  universal_payment_posture: 'PAYMENT_CREATION_FROZEN',
  worker_id: null,
  service_actor_valid: true,
};

function repositoryWith(query: ReturnType<typeof vi.fn>) {
  const database = {
    transaction: async <T>(callback: (transactionQuery: QueryFn) => Promise<T>) =>
      callback(query as QueryFn),
  } as Database;
  return new PostgresUniversalV1CompletionDeliveryRepository(database, () =>
    Date.parse(command.client_ts)
  );
}

describe('PostgresUniversalV1CompletionDeliveryRepository', () => {
  it('inserts one immutable receipt and has no task, assignment, or money write', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM task_completion_delivery_events')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM task_work_orders work_order')) {
        return { rows: [contextRow], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO task_completion_delivery_events')) {
        return { rows: [receiptRow], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(repositoryWith(query).record(sink, command)).resolves.toMatchObject({
      delivery_event_id: receiptRow.id,
      idempotency_replayed: false,
      payment_creation_performed: false,
      hard_assignment_created: false,
    });

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements[0]).toBe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    const writes = statements.filter((sql) => /^\s*(?:INSERT|UPDATE|DELETE)\b/u.test(sql));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('INSERT INTO task_completion_delivery_events');
    expect(writes[0]).not.toMatch(/tasks\s+SET|worker_id|task_financial|escrow|payment|payout/iu);
  });

  it('returns an exact replay before rechecking a completion that may already be approved', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM task_completion_delivery_events')) {
        return { rows: [receiptRow], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(repositoryWith(query).record(sink, command)).resolves.toMatchObject({
      delivery_event_id: receiptRow.id,
      idempotency_replayed: true,
    });
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes('FROM task_work_orders work_order'))
    ).toBe(false);
  });

  it('allows an exact replay after the callback freshness window has elapsed', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM task_completion_delivery_events')) {
        return { rows: [receiptRow], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const database = {
      transaction: async <T>(callback: (transactionQuery: QueryFn) => Promise<T>) =>
        callback(query as QueryFn),
    } as Database;
    const repository = new PostgresUniversalV1CompletionDeliveryRepository(
      database,
      () => Date.parse(command.client_ts) + 24 * 60 * 60_000
    );

    await expect(repository.record(sink, command)).resolves.toMatchObject({
      idempotency_replayed: true,
    });
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes('FROM task_work_orders work_order'))
    ).toBe(false);
    expect(
      query.mock.calls.some(([sql]) =>
        /^\s*INSERT INTO task_completion_delivery_events/u.test(String(sql))
      )
    ).toBe(false);
  });

  it('rejects a changed delayed body that reuses a provider delivery ID or idempotency key', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM task_completion_delivery_events')) {
        return { rows: [receiptRow], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const database = {
      transaction: async <T>(callback: (transactionQuery: QueryFn) => Promise<T>) =>
        callback(query as QueryFn),
    } as Database;
    const repository = new PostgresUniversalV1CompletionDeliveryRepository(
      database,
      () => Date.parse(command.client_ts) + 24 * 60 * 60_000
    );

    await expect(repository.record(sink, { ...command, channel: 'SMS' })).rejects.toMatchObject({
      code: 'COMPLETION_DELIVERY_IDEMPOTENCY_CONFLICT',
    } satisfies Partial<UniversalV1CompletionDeliveryError>);
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes('FROM task_work_orders work_order'))
    ).toBe(false);
  });

  it('fails closed on a stale completion or execution version without writing', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM task_completion_delivery_events')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM task_work_orders work_order')) {
        return {
          rows: [{ ...contextRow, execution_version: command.expected_execution_version + 1 }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(repositoryWith(query).record(sink, command)).rejects.toMatchObject({
      code: 'COMPLETION_DELIVERY_VERSION_CONFLICT',
    });
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes('INSERT INTO task_completion_delivery_events')
      )
    ).toBe(false);
  });
});
