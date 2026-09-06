import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database, QueryFn } from '../../src/db.js';
import { PostgresProviderEventProcessingRepository } from '../../src/services/payment/ProviderEventProcessing.js';
import {
  createFinancialReadinessDatabase,
  type FinancialReadinessDatabase,
} from '../helpers/universal-v1-financial-readiness-database.js';

describe.skipIf(!process.env.DATABASE_URL).sequential('provider-event worker authority', () => {
  let context: FinancialReadinessDatabase;
  beforeAll(async () => {
    context = await createFinancialReadinessDatabase();
  }, 120_000);
  afterAll(async () => {
    await context?.close();
  }, 30_000);

  it('refuses the retained legacy replay repository and normalization through a genuine worker login', async () => {
    const client = context.clients.get('workerRole')!;
    const databaseErrors: unknown[] = [];
    const query: QueryFn = async <Row>(sql: string, parameters?: unknown[]) => {
      try {
        const result = await client.query(sql, parameters);
        return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
      } catch (error) {
        databaseErrors.push(error);
        throw error;
      }
    };
    const database = {
      query,
      transaction: async <T>(work: (query: QueryFn) => Promise<T>): Promise<T> => {
        await client.query('BEGIN');
        try {
          const result = await work(query);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      },
    } as Database;
    await expect(
      new PostgresProviderEventProcessingRepository(database).claimNext(
        'legacy-replay-refusal:' + randomUUID(),
        30_000
      )
    ).rejects.toMatchObject({ reason: 'PERSISTENCE_INCOMPLETE' });
    expect(databaseErrors).toEqual([expect.objectContaining({ code: '42501' })]);
    await expect(
      client.query('SELECT public.normalize_financial_provider_observation_v1($1)', [randomUUID()])
    ).rejects.toMatchObject({ code: '42501' });
    expect((await client.query('SELECT session_user AS role')).rows).toEqual([
      { role: context.roles.workerRole },
    ]);
  });

  it('permits sealed durable discovery only through the worker without granting legacy table access', async () => {
    const sql = 'SELECT * FROM public.hxos_scan_fake_financial_recovery_v13(NULL,1)';
    await expect(context.clients.get('workerRole')!.query(sql)).resolves.toMatchObject({
      rows: [],
    });
    for (const key of ['apiRole', 'attesterRole'] as const) {
      await expect(context.clients.get(key)!.query(sql)).rejects.toMatchObject({ code: '42501' });
    }
    await expect(
      context.clients
        .get('workerRole')!
        .query('SELECT * FROM public.provider_event_processing_state')
    ).rejects.toMatchObject({ code: '42501' });
  });
});
