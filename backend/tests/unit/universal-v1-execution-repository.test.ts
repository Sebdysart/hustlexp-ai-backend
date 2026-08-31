import { describe, expect, it, vi } from 'vitest';

import type { Database, QueryFn } from '../../src/db.js';
import {
  type AdvanceUniversalV1WorkOrderExecutionPublic,
  UniversalV1ExecutionError,
} from '../../src/services/UniversalV1ExecutionContracts.js';
import { PostgresUniversalV1ExecutionRepository } from '../../src/services/UniversalV1ExecutionPostgresRepository.js';

const ids = {
  actor: '20000000-0000-4000-8000-000000000001',
  workOrder: '20000000-0000-4000-8000-000000000002',
  task: '20000000-0000-4000-8000-000000000003',
  scope: '20000000-0000-4000-8000-000000000004',
  currentFact: '20000000-0000-4000-8000-000000000005',
  nextFact: '20000000-0000-4000-8000-000000000006',
};

const context = {
  work_order_id: ids.workOrder,
  task_id: ids.task,
  scope_version_id: ids.scope,
  scope_version: 1,
  worker_id: null,
  provider_actor_authorized: true,
  provider_authority_current: true,
  incident_blocked: false,
  scope_change_pending: false,
};

const currentFact = {
  execution_fact_id: ids.currentFact,
  work_order_id: ids.workOrder,
  task_id: ids.task,
  scope_version_id: ids.scope,
  scope_version: 1,
  execution_version: 1,
  state: 'MATERIALIZED',
  transition_kind: 'MATERIALIZED',
  actor_user_id: ids.actor,
  idempotency_key: 'execution:materialized:0001',
  request_sha256: '0'.repeat(64),
  recorded_at: '2026-08-27T17:00:00.000Z',
} as const;

const nextFact = {
  ...currentFact,
  execution_fact_id: ids.nextFact,
  execution_version: 2,
  state: 'ACKNOWLEDGED',
  transition_kind: 'ACKNOWLEDGE',
  idempotency_key: 'execution:advance:0001',
  request_sha256: 'a'.repeat(64),
  recorded_at: '2026-08-27T18:00:00.000Z',
} as const;

function command(
  overrides: Partial<AdvanceUniversalV1WorkOrderExecutionPublic> = {}
): AdvanceUniversalV1WorkOrderExecutionPublic {
  return {
    work_order_id: ids.workOrder,
    action: 'ACKNOWLEDGE',
    expected_execution_version: 1,
    expected_scope_version: 1,
    idempotency_key: 'execution:advance:0001',
    client_ts: '2026-08-27T18:00:00.000Z',
    ...overrides,
  };
}

function databaseFor(query: QueryFn) {
  const serializableTransaction = vi.fn(
    async <T>(callback: (bound: QueryFn) => Promise<T>): Promise<T> => callback(query)
  );
  const database = {
    query,
    readQuery: query,
    transaction: serializableTransaction,
    serializableTransaction,
    healthCheck: vi.fn(),
    getPool: vi.fn(),
    getPoolStats: vi.fn(),
    close: vi.fn(),
  } as unknown as Database;
  return { database, serializableTransaction };
}

describe('PostgresUniversalV1ExecutionRepository', () => {
  it('appends the server-mapped next fact under the fulfillment lock without assignment or finance', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT work_order.id AS work_order_id')) {
        return { rows: [context], rowCount: 1 };
      }
      if (sql.includes('AND fact.actor_user_id = $2')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('ORDER BY fact.execution_version DESC')) {
        return { rows: [currentFact], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO task_work_order_execution_facts')) {
        return { rows: [nextFact], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }) as unknown as QueryFn;
    const fixture = databaseFor(query);
    const repository = new PostgresUniversalV1ExecutionRepository(fixture.database);

    const result = await repository.advanceWorkOrderExecution(
      ids.actor,
      command(),
      nextFact.request_sha256
    );

    expect(fixture.serializableTransaction).toHaveBeenCalledOnce();
    expect(calls[0]).toEqual({
      sql: 'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      params: [`fulfillment:${ids.workOrder}`],
    });
    const allSql = calls.map(({ sql }) => sql).join('\n');
    expect(allSql).toContain('task_work_order_amendments');
    expect(allSql).toContain('business_memberships');
    expect(allSql).toContain('universal_v1_invited_provider_authority_is_current');
    expect(allSql).toContain('work_order.execution_contract_version = 1');
    expect(allSql.indexOf('AND fact.actor_user_id = $2')).toBeLessThan(
      allSql.indexOf('ORDER BY fact.execution_version DESC')
    );

    const mutations = calls.filter(({ sql }) => /^\s*(INSERT|UPDATE|DELETE)\b/iu.test(sql));
    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.sql).toContain('INSERT INTO task_work_order_execution_facts');
    expect(mutations[0]?.params).toEqual([
      ids.workOrder,
      ids.task,
      ids.scope,
      2,
      ids.currentFact,
      'ACKNOWLEDGED',
      'ACKNOWLEDGE',
      ids.actor,
      null,
      'execution:advance:0001',
      nextFact.request_sha256,
      '2026-08-27T18:00:00.000Z',
      'universal-v1-work-order-execution-1.0.0',
    ]);
    expect(allSql).not.toMatch(/(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+)?tasks\b/iu);
    expect(allSql).not.toMatch(
      /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+)?task_financial_(?:operations|security_events)\b/iu
    );
    expect(result).toEqual({
      execution_fact_id: ids.nextFact,
      work_order_id: ids.workOrder,
      task_id: ids.task,
      scope_version_id: ids.scope,
      scope_version: 1,
      execution_version: 2,
      state: 'ACKNOWLEDGED',
      transition_kind: 'ACKNOWLEDGE',
      recorded_at: '2026-08-27T18:00:00.000Z',
      replayed: false,
      hard_assignment_created: false,
      payment_creation_performed: false,
    });
  });

  it('returns an exact actor-bound replay before reading the current state', async () => {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes('SELECT work_order.id AS work_order_id')) {
        return {
          rows: [
            {
              ...context,
              scope_version: 2,
              scope_version_id: '20000000-0000-4000-8000-000000000099',
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('AND fact.actor_user_id = $2')) {
        return { rows: [nextFact], rowCount: 1 };
      }
      if (sql.includes('ORDER BY fact.execution_version DESC')) {
        throw new Error('current state must not be read for an exact replay');
      }
      return { rows: [], rowCount: 0 };
    }) as unknown as QueryFn;
    const repository = new PostgresUniversalV1ExecutionRepository(databaseFor(query).database);

    const result = await repository.advanceWorkOrderExecution(
      ids.actor,
      command(),
      nextFact.request_sha256
    );

    expect(result).toMatchObject({
      execution_fact_id: ids.nextFact,
      execution_version: 2,
      scope_version: 1,
      replayed: true,
      hard_assignment_created: false,
      payment_creation_performed: false,
    });
    expect(calls.some((sql) => sql.includes('ORDER BY fact.execution_version DESC'))).toBe(false);
    expect(calls.some((sql) => sql.includes('INSERT INTO task_work_order_execution_facts'))).toBe(
      false
    );
  });

  it('rejects reuse of an actor-bound idempotency key with a different hash', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT work_order.id AS work_order_id')) {
        return { rows: [context], rowCount: 1 };
      }
      if (sql.includes('AND fact.actor_user_id = $2')) {
        return { rows: [nextFact], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }) as unknown as QueryFn;
    const repository = new PostgresUniversalV1ExecutionRepository(databaseFor(query).database);

    await expect(
      repository.advanceWorkOrderExecution(ids.actor, command(), 'b'.repeat(64))
    ).rejects.toMatchObject<Partial<UniversalV1ExecutionError>>({
      code: 'EXECUTION_IDEMPOTENCY_CONFLICT',
    });
  });

  it('requires both current provider authority and an authorized organization actor', async () => {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes('SELECT work_order.id AS work_order_id')) {
        return {
          rows: [
            {
              ...context,
              provider_actor_authorized: false,
              provider_authority_current: false,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('AND fact.actor_user_id = $2')) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    }) as unknown as QueryFn;
    const repository = new PostgresUniversalV1ExecutionRepository(databaseFor(query).database);

    await expect(
      repository.advanceWorkOrderExecution(ids.actor, command(), nextFact.request_sha256)
    ).rejects.toMatchObject<Partial<UniversalV1ExecutionError>>({
      code: 'EXECUTION_PROVIDER_AUTHORITY_REVOKED',
    });
    expect(calls.some((sql) => sql.includes('ORDER BY fact.execution_version DESC'))).toBe(false);
    expect(calls.some((sql) => sql.includes('INSERT INTO task_work_order_execution_facts'))).toBe(
      false
    );
  });

  it('reads the exact effective-scope state with immutable no-assignment/no-payment facts', async () => {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes('SELECT work_order.id AS work_order_id')) {
        return { rows: [context], rowCount: 1 };
      }
      if (sql.includes('ORDER BY fact.execution_version DESC')) {
        return { rows: [currentFact], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }) as unknown as QueryFn;
    const fixture = databaseFor(query);
    const repository = new PostgresUniversalV1ExecutionRepository(fixture.database);

    const result = await repository.getWorkOrderExecutionState(ids.actor, ids.workOrder);

    expect(fixture.serializableTransaction).toHaveBeenCalledOnce();
    expect(calls.some((sql) => sql.includes('pg_advisory_xact_lock'))).toBe(false);
    expect(result).toMatchObject({
      execution_fact_id: ids.currentFact,
      scope_version_id: ids.scope,
      execution_version: 1,
      state: 'MATERIALIZED',
      hard_assignment_created: false,
      payment_creation_performed: false,
    });
  });
});
