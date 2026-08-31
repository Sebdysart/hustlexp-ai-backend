import { describe, expect, it, vi } from 'vitest';

import type { Database, QueryFn } from '../../src/db.js';
import {
  FinancialProviderCommandJournalError,
  InMemoryFinancialProviderCommandJournal,
  JournaledFinancialProviderInvoker,
  PostgresFinancialProviderCommandJournal,
  type FinancialProviderCommandJournal,
  type FinancialProviderCommandReceipt,
  type RecordFinancialProviderCommandInput,
} from '../../src/services/payment/FinancialProviderCommandJournal.js';

const now = new Date('2026-08-28T22:00:00.000Z');
const operationId = '11111111-1111-4111-8111-111111111111';

function command(
  overrides: Partial<RecordFinancialProviderCommandInput<Record<string, unknown>>> = {}
): RecordFinancialProviderCommandInput<Record<string, unknown>> {
  return {
    operationKind: 'AUTHORIZE',
    operationId,
    providerKind: 'FAKE',
    idempotencyKey: 'finance-command:unit:0001',
    providerExpectedVersion: 0,
    exactRequest: {
      operationId,
      amountCents: 2_500,
      currency: 'usd',
      paymentMethodReference: 'pm_secret_never_persist_this',
    },
    evidence: {
      taskDraftId: '22222222-2222-4222-8222-222222222222',
      taskId: '33333333-3333-4333-8333-333333333333',
      amountCents: 2_500,
      currency: 'usd',
    },
    ...overrides,
  };
}

describe('financial provider command journal', () => {
  it('allows exact canonical replay and rejects changed same-key evidence', async () => {
    const journal = new InMemoryFinancialProviderCommandJournal(() => now);
    const first = await journal.recordRequested(command());
    const replay = await journal.recordRequested(
      command({
        exactRequest: {
          paymentMethodReference: 'pm_secret_never_persist_this',
          currency: 'usd',
          amountCents: 2_500,
          operationId,
        },
      })
    );

    expect(first).toMatchObject({ idempotencyReplayed: false, providerExpectedVersion: 0 });
    expect(replay).toEqual({ ...first, idempotencyReplayed: true });
    await expect(
      journal.recordRequested(
        command({
          exactRequest: { ...command().exactRequest, amountCents: 2_501 },
        })
      )
    ).rejects.toEqual(new FinancialProviderCommandJournalError('IDEMPOTENCY_CONFLICT'));
  });

  it('permits explicit version progression but rejects another key for the same operation version', async () => {
    const journal = new InMemoryFinancialProviderCommandJournal(() => now);
    await journal.recordRequested(command());
    await expect(
      journal.recordRequested(
        command({
          idempotencyKey: 'finance-command:unit:0002',
          providerExpectedVersion: 1,
          exactRequest: { ...command().exactRequest, expectedVersion: 1 },
        })
      )
    ).resolves.toMatchObject({ providerExpectedVersion: 1, idempotencyReplayed: false });
    await expect(
      journal.recordRequested(
        command({
          idempotencyKey: 'finance-command:unit:0003',
        })
      )
    ).rejects.toEqual(new FinancialProviderCommandJournalError('OPERATION_VERSION_CONFLICT'));
  });

  it('requires actor and verified exact-release evidence for APPROVED_PROVIDER records', async () => {
    const journal = new InMemoryFinancialProviderCommandJournal(() => now);
    await expect(
      journal.recordRequested(
        command({
          providerKind: 'APPROVED_PROVIDER',
        })
      )
    ).rejects.toEqual(
      new FinancialProviderCommandJournalError('APPROVED_PROVIDER_EVIDENCE_REQUIRED')
    );
    await expect(
      journal.recordRequested(
        command({
          providerKind: 'APPROVED_PROVIDER',
          actor: {
            actorId: '44444444-4444-4444-8444-444444444444',
            actorKind: 'NAMED_OPERATOR',
          },
          release: {
            manifestDigest: `sha256:${'a'.repeat(64)}`,
            releaseId: 'release.unit.0001',
            revision: 'b'.repeat(40),
            environment: 'staging',
            authenticationStatus: 'VERIFIED',
          },
        })
      )
    ).resolves.toMatchObject({ providerKind: 'APPROVED_PROVIDER' });
  });

  it('records lifecycle REQUESTED but refuses adapter entry without foreground DISPATCH_ATTEMPTED', async () => {
    const expected = await new InMemoryFinancialProviderCommandJournal(() => now).recordRequested(
      command()
    );
    let resolveRecord!: (receipt: FinancialProviderCommandReceipt) => void;
    const pendingRecord = new Promise<FinancialProviderCommandReceipt>((resolve) => {
      resolveRecord = resolve;
    });
    const journal: FinancialProviderCommandJournal = {
      recordRequested: vi.fn(() => pendingRecord),
    };
    const adapter = vi.fn(async (request: Record<string, unknown>) => request.amountCents);
    const invocation = new JournaledFinancialProviderInvoker(journal).invokeAfterCommit(
      command(),
      adapter
    );

    await Promise.resolve();
    expect(adapter).not.toHaveBeenCalled();
    resolveRecord(expected);

    await expect(invocation).rejects.toEqual(
      new FinancialProviderCommandJournalError('FOREGROUND_DISPATCH_COORDINATOR_REQUIRED')
    );
    expect(adapter).not.toHaveBeenCalled();
  });

  it('never enters any adapter callback from an exact REQUESTED replay', async () => {
    const journal = new InMemoryFinancialProviderCommandJournal(() => now);
    const invoker = new JournaledFinancialProviderInvoker(journal);
    const adapter = vi.fn(async () => 'adapter-result');
    const onboarding = command({
      operationKind: 'ONBOARD_PROVIDER',
      exactRequest: { operationId, providerId: 'synthetic-provider' },
    });

    await expect(invoker.invokeAfterCommit(onboarding, adapter)).resolves.toMatchObject({
      result: 'adapter-result',
    });
    await expect(invoker.invokeAfterCommit(onboarding, adapter)).rejects.toEqual(
      new FinancialProviderCommandJournalError('REQUEST_REPLAY_ADAPTER_REFUSED')
    );
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it('passes only digests and fixed safe evidence to PostgreSQL', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      if (sql.includes('FROM public.financial_provider_command_journal')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO public.financial_provider_command_journal')) {
        return {
          rows: [
            {
              command_id: '55555555-5555-4555-8555-555555555555',
              operation_kind: 'AUTHORIZE',
              operation_id: operationId,
              provider_kind: 'FAKE',
              idempotency_key: 'finance-command:unit:0001',
              provider_expected_version: 0,
              request_sha256: params?.[5],
              command_identity_sha256: params?.[6],
              recorded_at: now,
            },
          ],
          rowCount: 1,
        };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }) as QueryFn;
    const database = {
      transaction: vi.fn(<T>(callback: (transactionQuery: QueryFn) => Promise<T>) =>
        callback(query)
      ),
    } as unknown as Database;

    await new PostgresFinancialProviderCommandJournal(database).recordRequested(command());

    const serializedPersistenceInputs = JSON.stringify(calls);
    expect(serializedPersistenceInputs).not.toContain('pm_secret_never_persist_this');
    expect(serializedPersistenceInputs).not.toContain('paymentMethodReference');
    const insert = calls.find(({ sql }) =>
      sql.includes('INSERT INTO public.financial_provider_command_journal')
    );
    expect(insert?.params?.[5]).toMatch(/^[0-9a-f]{64}$/u);
    expect(insert?.params?.[6]).toMatch(/^[0-9a-f]{64}$/u);
    expect(insert?.params?.slice(7, 9)).toEqual([null, null]);
    expect(insert?.params?.slice(9, 15)).toEqual([
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      null,
      null,
      2_500,
      'USD',
    ]);
  });
});
