import { readFile } from 'node:fs/promises';

import pg from 'pg';
import { describe, expect, it } from 'vitest';

import type { Database, QueryFn } from '../../src/db.js';
import {
  FakeFinancialProvider,
  PostgresFakeFinancialOperationRepository,
} from '../../src/services/payment/FakeFinancialProvider.js';
import {
  LegacyFakeFinancialExpiryCompensationWorker,
  PostgresLegacyFakeFinancialExpiryCompensationRepository,
} from '../../src/services/payment/LegacyFakeFinancialExpiryCompensation.js';

const databaseUrl = process.env.LOCAL_TEST_DB_URL ?? '';
const describePg = describe.sequential.skipIf(databaseUrl.length === 0);

const amountless = [
  {
    eventId: 'a7100000-0000-4000-8000-000000000001',
    operationId: 'a7110000-0000-4000-8000-000000000001',
    operationKind: 'AUTHORIZE',
    recordedAt: '2020-01-01T00:00:00.001Z',
  },
  {
    eventId: 'a7200000-0000-4000-8000-000000000001',
    operationId: 'a7210000-0000-4000-8000-000000000001',
    operationKind: 'SECURE',
    recordedAt: '2020-01-01T00:00:00.002Z',
  },
  {
    eventId: 'a7300000-0000-4000-8000-000000000001',
    operationId: 'a7310000-0000-4000-8000-000000000001',
    operationKind: 'ADJUST',
    recordedAt: '2020-01-01T00:00:00.003Z',
  },
] as const;

const outsideRuntimeRange = {
  eventId: 'b7100000-0000-4000-8000-000000000001',
  operationId: 'b7110000-0000-4000-8000-000000000001',
  operationKind: 'AUTHORIZE',
  recordedAt: '2020-01-01T00:00:00.004Z',
  amountCents: '9007199254740992',
  currency: 'usd',
} as const;

const terminalDenied = [...amountless, outsideRuntimeRange] as const;

const valued = {
  eventId: 'f7100000-0000-4000-8000-000000000001',
  operationId: 'f7110000-0000-4000-8000-000000000001',
  operationKind: 'ADJUST',
  recordedAt: '2020-01-01T00:00:01.000Z',
  amountCents: 2_400,
  currency: 'usd',
} as const;

function assertDisposableDatabase(value: string): void {
  const parsed = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== '5432' ||
    parsed.username !== 'hx_ci_runner' ||
    parsed.pathname !== '/hx_ci_system_test' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      'Fake-financial expiry upgrade proof may run only on the exact disposable system database'
    );
  }
}

function clientDatabase(client: pg.Client): Database {
  const query: QueryFn = async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
    const result = await client.query(sql, params);
    return {
      rows: result.rows as T[],
      rowCount: result.rowCount ?? 0,
    };
  };
  let savepointSequence = 0;
  let transactionTail = Promise.resolve();
  const transaction = async <T>(fn: (query: QueryFn) => Promise<T>): Promise<T> => {
    const previous = transactionTail;
    let releaseTransaction: () => void = () => undefined;
    transactionTail = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    await previous;
    savepointSequence += 1;
    const savepoint = `expiry_upgrade_${savepointSequence}`;
    try {
      await client.query(`SAVEPOINT ${savepoint}`);
      const result = await fn(query);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    } finally {
      releaseTransaction();
    }
  };

  return {
    query,
    readQuery: query,
    transaction,
    serializableTransaction: transaction,
    healthCheck: async () => ({ connected: true, schemaVersion: null, latencyMs: 0 }),
    getPool: () => {
      throw new Error('Rollback-only client database does not expose a pool');
    },
    getPoolStats: () => ({
      totalConnections: 1,
      idleConnections: 0,
      waitingRequests: 0,
      maxConnections: 1,
      utilizationPercent: 100,
      replicaConnections: null,
    }),
    close: async () => undefined,
  };
}

async function seedPreV9RawSuccesses(client: pg.Client): Promise<void> {
  await client.query(
    `ALTER TABLE public.hxos_fake_financial_operations_v1
       DROP CONSTRAINT IF EXISTS hxos_fake_financial_operation_amount_runtime_safe_v10_chk`
  );
  await client.query(
    `ALTER TABLE public.hxos_fake_financial_operation_events_v1
       DROP CONSTRAINT IF EXISTS hxos_fake_financial_event_expiry_v9_chk`
  );
  await client.query(
    `ALTER TABLE public.hxos_fake_financial_operation_events_v1
       DROP CONSTRAINT IF EXISTS hxos_fake_financial_event_amount_runtime_safe_v10_chk`
  );
  await client.query(`SET LOCAL session_replication_role = 'replica'`);
  try {
    for (const [index, source] of [...terminalDenied, valued].entries()) {
      const amountCents = 'amountCents' in source ? source.amountCents : null;
      const currency = 'currency' in source ? source.currency : null;
      const identitySha256 = (index + 1).toString(16).repeat(64);
      const requestSha256 = (index + 5).toString(16).repeat(64);
      const responseSha256 = (index + 9).toString(16).repeat(64);
      const externalReference = `fake_${source.operationKind.toLowerCase()}_${(index + 1)
        .toString(16)
        .repeat(24)}`;
      await client.query(
        `INSERT INTO public.hxos_fake_financial_operations_v1(
           operation_id, operation_kind, identity_sha256, external_reference,
           amount_cents, currency, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          source.operationId,
          source.operationKind,
          identitySha256,
          externalReference,
          amountCents,
          currency,
          source.recordedAt,
        ]
      );
      await client.query(
        `INSERT INTO public.hxos_fake_financial_operation_events_v1(
           event_id, operation_id, operation_kind, event_version, state,
           scenario, amount_cents, currency, external_reference,
           idempotency_key, identity_sha256, request_sha256,
           provider_request_sha256, response_sha256, retryable, metadata,
           recorded_at, expires_at
         ) VALUES (
           $1, $2, $3, 1, 'SUCCEEDED', 'SUCCESS', $4, $5, $6,
           $7, $8, $9, $10, $11, FALSE, '{}'::jsonb, $12, NULL
         )`,
        [
          source.eventId,
          source.operationId,
          source.operationKind,
          amountCents,
          currency,
          externalReference,
          `expiry-upgrade-${source.operationKind.toLowerCase()}-${index}-0001`,
          identitySha256,
          requestSha256,
          requestSha256,
          responseSha256,
          source.recordedAt,
        ]
      );
    }
  } finally {
    await client.query(`SET LOCAL session_replication_role = 'origin'`);
  }
}

describePg('Universal V1 fake-financial expiry recovery upgrade', () => {
  it('terminalizes runtime-unrepresentable security without starving valued compensation and replays once', async () => {
    assertDisposableDatabase(databaseUrl);
    const client = new pg.Client({ connectionString: databaseUrl });
    const v9 = await readFile(
      new URL(
        '../../database/migrations/20261010_universal_v1_fake_financial_expiry_v9.sql',
        import.meta.url
      ),
      'utf8'
    );
    const v10 = await readFile(
      new URL(
        '../../database/migrations/20261011_universal_v1_fake_financial_expiry_recovery_v10.sql',
        import.meta.url
      ),
      'utf8'
    );
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    try {
      const version = await client.query<{ server_version_num: string }>(
        `SELECT current_setting('server_version_num') AS server_version_num`
      );
      expect(Number(version.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(160_000);

      await seedPreV9RawSuccesses(client);
      await client.query(v9);
      await client.query(v10);

      const terminalFacts = await client.query<{
        source_fake_operation_event_id: string;
        source_operation_kind: string;
        reason_code: string;
        positive_use_denied: boolean;
        recovery_terminal: boolean;
        recovery_retryable: boolean;
        authority_sha256: string;
      }>(
        `SELECT source_fake_operation_event_id, source_operation_kind,
                reason_code, positive_use_denied, recovery_terminal,
                recovery_retryable, authority_sha256
           FROM public.hxos_fake_financial_legacy_expiry_noncompensable_facts_v10
          WHERE source_fake_operation_event_id = ANY($1::uuid[])
          ORDER BY source_fake_operation_event_id`,
        [terminalDenied.map((source) => source.eventId)]
      );
      expect(terminalFacts.rows).toHaveLength(4);
      expect(terminalFacts.rows.map((row) => row.source_operation_kind)).toEqual([
        'AUTHORIZE',
        'SECURE',
        'ADJUST',
        'AUTHORIZE',
      ]);
      for (const fact of terminalFacts.rows) {
        expect(fact).toMatchObject({
          positive_use_denied: true,
          recovery_terminal: true,
          recovery_retryable: false,
        });
        expect(fact.reason_code).toBe(
          fact.source_fake_operation_event_id === outsideRuntimeRange.eventId
            ? 'SOURCE_AMOUNT_OUTSIDE_RUNTIME_RANGE'
            : 'SOURCE_AMOUNT_AND_CURRENCY_UNPROVEN'
        );
        expect(fact.authority_sha256).toMatch(/^[0-9a-f]{64}$/u);
      }

      await client.query(v10);
      const replayedBackfill = await client.query<{ terminal_facts: number }>(
        `SELECT COUNT(*)::INTEGER AS terminal_facts
           FROM public.hxos_fake_financial_legacy_expiry_noncompensable_facts_v10
          WHERE source_fake_operation_event_id = ANY($1::uuid[])`,
        [terminalDenied.map((source) => source.eventId)]
      );
      expect(replayedBackfill.rows[0]?.terminal_facts).toBe(4);

      const database = clientDatabase(client);
      const fakeEvents = new PostgresFakeFinancialOperationRepository(database);
      const repository = new PostgresLegacyFakeFinancialExpiryCompensationRepository(database);
      const firstPage = await repository.findRequired(1);
      expect(firstPage).toEqual([
        {
          sourceEventId: valued.eventId,
          sourceOperationId: valued.operationId,
          sourceOperationKind: valued.operationKind,
          amountCents: valued.amountCents,
          currency: valued.currency,
        },
      ]);

      const candidate = firstPage[0]!;
      const replayScope = {
        findRequired: async () => [candidate],
        prepareCommand: (sourceEventId: string, providerRequestSha256: string) =>
          repository.prepareCommand(sourceEventId, providerRequestSha256),
        recordDispatchAttempt: (commandId: string) => repository.recordDispatchAttempt(commandId),
        recordCompensation: (
          sourceEventId: string,
          compensationEventId: string,
          commandId: string,
          dispatchAttemptId: string
        ) =>
          repository.recordCompensation(
            sourceEventId,
            compensationEventId,
            commandId,
            dispatchAttemptId
          ),
      };
      let authorizationChecks = 0;
      const worker = new LegacyFakeFinancialExpiryCompensationWorker(
        replayScope,
        new FakeFinancialProvider(fakeEvents),
        fakeEvents,
        () => {
          authorizationChecks += 1;
        }
      );
      expect(await worker.runOnce(1)).toEqual({ attempted: 1, compensated: 1, replayed: 0 });
      expect(await worker.runOnce(1)).toEqual({ attempted: 1, compensated: 0, replayed: 1 });
      expect(authorizationChecks).toBe(4);
      expect(await repository.findRequired(1)).toEqual([]);

      const closure = await client.query<{
        compensation_operation_kind: string;
        compensation_provider_state: string;
        compensation_commands: number;
        compensation_attempts: number;
        compensation_outcomes: number;
        compensation_receipts: number;
        compensation_events: number;
        terminal_denial_commands: number;
        terminal_denial_receipts: number;
      }>(
        `SELECT compensation.compensation_operation_kind,
                compensation.compensation_provider_state,
                (SELECT COUNT(*)::INTEGER
                   FROM public.hxos_fake_financial_legacy_expiry_compensation_commands_v9 command
                  WHERE command.source_fake_operation_event_id = $1)
                  AS compensation_commands,
                (SELECT COUNT(*)::INTEGER
                   FROM public.hxos_fake_financial_legacy_expiry_compensation_attempts_v9 attempt
                  WHERE attempt.command_id = compensation.compensation_command_id)
                  AS compensation_attempts,
                (SELECT COUNT(*)::INTEGER
                   FROM public.hxos_fake_financial_legacy_expiry_compensation_outcomes_v9 outcome
                  WHERE outcome.command_id = compensation.compensation_command_id)
                  AS compensation_outcomes,
                (SELECT COUNT(*)::INTEGER
                   FROM public.hxos_fake_financial_legacy_expiry_compensations_v9 receipt
                  WHERE receipt.source_fake_operation_event_id = $1)
                  AS compensation_receipts,
                (SELECT COUNT(*)::INTEGER
                   FROM public.hxos_fake_financial_operation_events_v1 event
                  WHERE event.idempotency_key = compensation.compensation_idempotency_key)
                  AS compensation_events,
                (SELECT COUNT(*)::INTEGER
                   FROM public.hxos_fake_financial_legacy_expiry_compensation_commands_v9 command
                  WHERE command.source_fake_operation_event_id = ANY($2::uuid[]))
                  AS terminal_denial_commands,
                (SELECT COUNT(*)::INTEGER
                   FROM public.hxos_fake_financial_legacy_expiry_compensations_v9 receipt
                  WHERE receipt.source_fake_operation_event_id = ANY($2::uuid[]))
                  AS terminal_denial_receipts
           FROM public.hxos_fake_financial_legacy_expiry_compensations_v9 compensation
          WHERE compensation.source_fake_operation_event_id = $1`,
        [valued.eventId, terminalDenied.map((source) => source.eventId)]
      );
      expect(closure.rows[0]).toEqual({
        compensation_operation_kind: 'REVERSAL',
        compensation_provider_state: 'REVERSED',
        compensation_commands: 1,
        compensation_attempts: 1,
        compensation_outcomes: 1,
        compensation_receipts: 1,
        compensation_events: 1,
        terminal_denial_commands: 0,
        terminal_denial_receipts: 0,
      });
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });
});
