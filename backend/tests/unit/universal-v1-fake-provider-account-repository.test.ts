import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { Database, QueryFn } from '../../src/db.js';
import {
  PostgresUniversalV1FakeProviderAccountRepository,
  UniversalV1FakeProviderAccountRepositoryError,
  type MaterializeUniversalV1FakeProviderAccountFactInput,
} from '../../src/services/payment/UniversalV1FakeProviderAccountRepository.js';

const ids = {
  provider: '11111111-1111-4111-8111-111111111111',
  organization: '22222222-2222-4222-8222-222222222222',
  actor: '33333333-3333-4333-8333-333333333333',
  fact: '44444444-4444-4444-8444-444444444444',
  priorFact: '55555555-5555-4555-8555-555555555555',
  onboardCommand: '61111111-1111-4111-8111-111111111111',
  onboardAttempt: '62222222-2222-4222-8222-222222222222',
  onboardOutcome: '63333333-3333-4333-8333-333333333333',
  onboardEvent: '64444444-4444-4444-8444-444444444444',
  refreshCommand: '71111111-1111-4111-8111-111111111111',
  refreshAttempt: '72222222-2222-4222-8222-222222222222',
  refreshOutcome: '73333333-3333-4333-8333-333333333333',
  refreshEvent: '74444444-4444-4444-8444-444444444444',
} as const;

const accountReference = 'fake_onboard_provider_0123456789abcdef01234567';
const accountReferenceSha256 = createHash('sha256').update(accountReference, 'utf8').digest('hex');
const requirementsDueSha256 = createHash('sha256').update('NONE', 'utf8').digest('hex');

function input(
  overrides: Partial<MaterializeUniversalV1FakeProviderAccountFactInput> = {}
): MaterializeUniversalV1FakeProviderAccountFactInput {
  return {
    providerSubject: { kind: 'ORGANIZATION', organizationId: ids.organization },
    recordedBy: ids.actor,
    onboard: {
      commandId: ids.onboardCommand,
      dispatchAttemptId: ids.onboardAttempt,
      outcomeFactId: ids.onboardOutcome,
      fakeOperationEventId: ids.onboardEvent,
    },
    refresh: {
      commandId: ids.refreshCommand,
      dispatchAttemptId: ids.refreshAttempt,
      outcomeFactId: ids.refreshOutcome,
      fakeOperationEventId: ids.refreshEvent,
    },
    ...overrides,
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    provider_account_fact_id: ids.fact,
    provider_subject_kind: 'ORGANIZATION',
    provider_user_id: null,
    provider_organization_id: ids.organization,
    account_version: 2,
    supersedes_fact_id: ids.priorFact,
    onboard_command_id: ids.onboardCommand,
    onboard_dispatch_attempt_id: ids.onboardAttempt,
    onboard_outcome_fact_id: ids.onboardOutcome,
    onboard_fake_event_id: ids.onboardEvent,
    refresh_command_id: ids.refreshCommand,
    refresh_dispatch_attempt_id: ids.refreshAttempt,
    refresh_outcome_fact_id: ids.refreshOutcome,
    refresh_fake_event_id: ids.refreshEvent,
    provider_account_reference_sha256: accountReferenceSha256,
    account_state: 'ENABLED',
    charges_enabled: true,
    payouts_enabled: true,
    requirements_due_sha256: requirementsDueSha256,
    recorded_by: ids.actor,
    recorded_at: new Date('2026-08-29T20:00:00.000Z'),
    materialized_at: new Date('2026-08-29T20:00:00.000Z'),
    provider_account_reference: accountReference,
    ...overrides,
  };
}

function databaseWithTransaction(query: QueryFn): Database {
  return {
    serializableTransaction: vi.fn(<T>(callback: (transactionQuery: QueryFn) => Promise<T>) =>
      callback(query)
    ),
  } as unknown as Database;
}

describe('Universal V1 fake provider-account fact repository', () => {
  it('materializes only a provider-scoped evidence bundle and reads DB-derived state', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      if (sql.includes('OR fact.refresh_fake_event_id')) return { rows: [], rowCount: 0 };
      if (sql.includes('ORDER BY fact.account_version DESC')) {
        return {
          rows: [{ provider_account_fact_id: ids.priorFact, account_version: '1' }],
          rowCount: 1,
        };
      }
      if (sql.includes('INSERT INTO public.universal_v1_fake_provider_account_facts')) {
        return { rows: [{ provider_account_fact_id: ids.fact }], rowCount: 1 };
      }
      if (sql.includes('WHERE fact.provider_account_fact_id = $1')) {
        return { rows: [row()], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }) as QueryFn;

    const result = await new PostgresUniversalV1FakeProviderAccountRepository(
      databaseWithTransaction(query)
    ).materializeFromDurableEvidence(input());

    expect(result).toMatchObject({
      providerAccountFactId: ids.fact,
      providerSubject: { kind: 'ORGANIZATION', organizationId: ids.organization },
      accountVersion: 2,
      supersedesFactId: ids.priorFact,
      accountState: 'ENABLED',
      payoutsEnabled: true,
      providerAccountReference: accountReference,
      providerAccountReferenceSha256: accountReferenceSha256,
      idempotencyReplayed: false,
    });
    const insert = calls.find(({ sql }) =>
      sql.includes('INSERT INTO public.universal_v1_fake_provider_account_facts')
    );
    const occupiedRefresh = calls.find(({ sql }) => sql.includes('OR fact.refresh_fake_event_id'));
    expect(occupiedRefresh?.sql).not.toMatch(/(?:WHERE|OR) fact\.onboard_[a-z_]+_id/u);
    expect(occupiedRefresh?.params).toEqual([
      ids.refreshCommand,
      ids.refreshAttempt,
      ids.refreshOutcome,
      ids.refreshEvent,
    ]);
    expect(insert?.sql).not.toMatch(
      /task_draft|task_id|work_order|customer|provider_account_reference_sha256|account_state|payouts_enabled|recorded_at|materialized_at/iu
    );
    expect(insert?.params).toEqual([
      'ORGANIZATION',
      null,
      ids.organization,
      ids.onboardCommand,
      ids.onboardAttempt,
      ids.onboardOutcome,
      ids.onboardEvent,
      ids.refreshCommand,
      ids.refreshAttempt,
      ids.refreshOutcome,
      ids.refreshEvent,
      ids.actor,
    ]);
    expect(JSON.stringify(insert?.params)).not.toContain(accountReference);
  });

  it('returns an exact evidence replay without inserting a second fact', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      if (sql.includes('OR fact.refresh_fake_event_id')) {
        return { rows: [row()], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }) as QueryFn;

    const result = await new PostgresUniversalV1FakeProviderAccountRepository(
      databaseWithTransaction(query)
    ).materializeFromDurableEvidence(input());

    expect(result.idempotencyReplayed).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO'))).toBe(false);
  });

  it('rejects a different actor only for a USER subject before SQL', async () => {
    const database = {
      serializableTransaction: vi.fn(),
    } as unknown as Database;
    const repository = new PostgresUniversalV1FakeProviderAccountRepository(database);

    await expect(
      repository.materializeFromDurableEvidence(
        input({
          providerSubject: { kind: 'USER', userId: ids.provider },
          recordedBy: ids.actor,
        })
      )
    ).rejects.toEqual(new UniversalV1FakeProviderAccountRepositoryError('ACTOR_SUBJECT_MISMATCH'));
    expect(database.serializableTransaction).not.toHaveBeenCalled();
  });

  it('never falls back to an older account and digest-checks the recovered reference', async () => {
    const query = vi.fn(async () => ({
      rows: [row({ account_state: 'RESTRICTED', charges_enabled: false, payouts_enabled: false })],
      rowCount: 1,
    })) as QueryFn;
    const database = { query } as unknown as Database;
    const repository = new PostgresUniversalV1FakeProviderAccountRepository(database);

    await expect(
      repository.findLatestPayoutReady({
        providerSubject: { kind: 'ORGANIZATION', organizationId: ids.organization },
      })
    ).resolves.toBeNull();
    expect(query.mock.calls[0]?.[0]).toContain('ORDER BY fact.account_version DESC');
    expect(query.mock.calls[0]?.[0]).not.toContain("account_state = 'ENABLED'");
    expect(query.mock.calls[0]?.[0]).not.toContain('FOR SHARE');

    query.mockResolvedValueOnce({
      rows: [row({ provider_account_reference_sha256: 'f'.repeat(64) })],
      rowCount: 1,
    });
    await expect(
      repository.findLatestPayoutReady({
        providerSubject: { kind: 'ORGANIZATION', organizationId: ids.organization },
      })
    ).rejects.toEqual(
      new UniversalV1FakeProviderAccountRepositoryError('PERSISTENCE_IDENTITY_MISMATCH')
    );
  });

  it('share-locks the exact latest fact and onboarding event inside terminal-intent SQL', async () => {
    const query = vi.fn(async () => ({ rows: [row()], rowCount: 1 })) as QueryFn;
    const repository = new PostgresUniversalV1FakeProviderAccountRepository(
      {} as unknown as Database
    );

    const result = await repository.findLatestPayoutReadyInTransaction(query, {
      providerSubject: { kind: 'ORGANIZATION', organizationId: ids.organization },
    });

    expect(result).toMatchObject({
      providerAccountFactId: ids.fact,
      accountState: 'ENABLED',
      payoutsEnabled: true,
      providerAccountReference: accountReference,
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain("hashtext('universal-v1-fake-provider-account-v1')");
    expect(query.mock.calls[0]?.[1]).toEqual([`ORGANIZATION:${ids.organization}`]);
    expect(query.mock.calls[1]?.[0]).toContain('FOR SHARE OF fact, onboard_event');
  });

  it('reads only the exact enabled fact pinned by a terminal intent', async () => {
    const query = vi.fn(async () => ({ rows: [row()], rowCount: 1 })) as QueryFn;
    const repository = new PostgresUniversalV1FakeProviderAccountRepository(
      {} as unknown as Database
    );

    await expect(
      repository.findPinnedPayoutReadyInTransaction(query, {
        providerAccountFactId: ids.fact,
        providerSubject: { kind: 'ORGANIZATION', organizationId: ids.organization },
      })
    ).resolves.toMatchObject({ providerAccountFactId: ids.fact, payoutsEnabled: true });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('fact.provider_account_fact_id = $1');
    expect(query.mock.calls[0]?.[0]).not.toContain('ORDER BY fact.account_version');
  });

  it('normalizes trigger and cross-subject uniqueness refusals into the repository contract', async () => {
    const triggerRefusal = Object.assign(
      new Error('HXUV1-FTL-11: exact onboarding evidence required'),
      { code: 'P0001' }
    );
    const triggerDatabase = {
      serializableTransaction: vi.fn().mockRejectedValue(triggerRefusal),
    } as unknown as Database;
    await expect(
      new PostgresUniversalV1FakeProviderAccountRepository(
        triggerDatabase
      ).materializeFromDurableEvidence(input())
    ).rejects.toEqual(new UniversalV1FakeProviderAccountRepositoryError('EVIDENCE_INVALID'));

    const uniquenessRefusal = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'universal_v1_fake_provider_account_facts_refresh_command_id_key',
    });
    const uniquenessDatabase = {
      serializableTransaction: vi.fn().mockRejectedValue(uniquenessRefusal),
    } as unknown as Database;
    await expect(
      new PostgresUniversalV1FakeProviderAccountRepository(
        uniquenessDatabase
      ).materializeFromDurableEvidence(input())
    ).rejects.toEqual(new UniversalV1FakeProviderAccountRepositoryError('EVIDENCE_CONFLICT'));

    const causalRefusal = Object.assign(new Error('HXUV1-FTL-16: refresh preceded onboarding'), {
      code: 'P0001',
    });
    await expect(
      new PostgresUniversalV1FakeProviderAccountRepository({
        serializableTransaction: vi.fn().mockRejectedValue(causalRefusal),
      } as unknown as Database).materializeFromDurableEvidence(input())
    ).rejects.toEqual(new UniversalV1FakeProviderAccountRepositoryError('EVIDENCE_INVALID'));

    const staleObservationRefusal = Object.assign(
      new Error('HXUV1-FTL-19: refresh dispatch preceded latest observation'),
      { code: 'P0001' }
    );
    await expect(
      new PostgresUniversalV1FakeProviderAccountRepository({
        serializableTransaction: vi.fn().mockRejectedValue(staleObservationRefusal),
      } as unknown as Database).materializeFromDurableEvidence(input())
    ).rejects.toEqual(new UniversalV1FakeProviderAccountRepositoryError('EVIDENCE_INVALID'));

    const stateConflict = Object.assign(
      new Error('HXUV1-FTL-18: stale account version/current state'),
      { code: 'P0001' }
    );
    await expect(
      new PostgresUniversalV1FakeProviderAccountRepository({
        serializableTransaction: vi.fn().mockRejectedValue(stateConflict),
      } as unknown as Database).materializeFromDurableEvidence(input())
    ).rejects.toEqual(
      new UniversalV1FakeProviderAccountRepositoryError('PERSISTENCE_IDENTITY_MISMATCH')
    );
  });
});
