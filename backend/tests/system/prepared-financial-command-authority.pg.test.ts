import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';

import type { Database, QueryFn } from '../../src/db.js';
import type { UniversalV1ActorAttestationHandle } from '../../src/auth/universal-v1-actor-attestation-contracts.js';
import {
  createFinancialReadinessDatabase,
  type FinancialReadinessDatabase,
} from '../helpers/universal-v1-financial-readiness-database.js';
import { createClaimedTaskDraftFixture } from '../helpers/universal-v1-claimed-task-draft-fixture.js';
import { createSyntheticActorAttestation } from '../helpers/universal-v1-prepared-work-order-fixture.js';
import {
  canonicalFinancialProviderRequestSha256,
  JournaledFinancialProviderInvoker,
  PostgresFinancialProviderCommandJournal,
} from '../../src/services/payment/FinancialProviderCommandJournal.js';
import {
  PostgresUniversalV1PreparedFinancialCommandAuthority,
  type PrepareUniversalV1FinancialCommandInput,
  type PreparedUniversalV1FinancialCommandReceipt,
} from '../../src/services/payment/PreparedFinancialCommandAuthority.js';

const describePg = describe.skipIf(!process.env.DATABASE_URL).sequential;
let context: FinancialReadinessDatabase;
let db: Database;
let apiDatabase: Database;
let apiPool: pg.Pool;
let attestation: UniversalV1ActorAttestationHandle;
let preparedAuthority: PostgresUniversalV1PreparedFinancialCommandAuthority;
let synchronizePreparations: (() => Promise<void>) | undefined;
const transactionPids = new Set<number>();

function pooledDatabase(pool: pg.Pool): Database {
  const query: QueryFn = async <Row>(sql: string, values?: unknown[]) => {
    const result = await pool.query(sql, values);
    return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
  };
  const transaction = async <T>(
    work: (query: QueryFn) => Promise<T>,
    serializable = false
  ): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query(serializable ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN');
      if (pool === apiPool && synchronizePreparations) {
        const identity = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        transactionPids.add(identity.rows[0]!.pid);
        await synchronizePreparations();
      }
      const result = await work(async <Row>(sql: string, values?: unknown[]) => {
        const reply = await client.query(sql, values);
        return { rows: reply.rows as Row[], rowCount: reply.rowCount ?? 0 };
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
  return {
    query,
    readQuery: query,
    transaction,
    serializableTransaction: <T>(work: (query: QueryFn) => Promise<T>) => transaction(work, true),
  } as Database;
}
let actorId: string = randomUUID();
let taskDraftId: string = randomUUID();
let operationId = randomUUID();
let idempotencyKey = `prepared-finance:${randomUUID()}`;

function exactRequest() {
  return {
    operationId,
    idempotencyKey,
    expectedVersion: 0,
    customerId: actorId,
  };
}

function preparation(
  overrides: Partial<PrepareUniversalV1FinancialCommandInput> = {}
): PrepareUniversalV1FinancialCommandInput {
  return {
    operationKind: 'PREPARE_PAYMENT_METHOD',
    operationId,
    providerKind: 'FAKE',
    idempotencyKey,
    providerExpectedVersion: 0,
    lifecycleExpectedVersion: 0,
    providerRequestSha256: canonicalFinancialProviderRequestSha256(exactRequest()),
    taskDraftId,
    taskId: null,
    eligibilityDecisionId: null,
    scopeVersionId: null,
    changeOrderId: null,
    predecessorEventId: null,
    completionFactId: null,
    relatedOperationId: null,
    amountCents: null,
    currency: null,
    recordedBy: actorId,
    ...overrides,
  };
}

describePg('Universal V1 PREPARED financial command PostgreSQL authority', () => {
  const authority = {
    prepare: (input: PrepareUniversalV1FinancialCommandInput) =>
      preparedAuthority.prepare(input, attestation),
  };
  beforeAll(async () => {
    context = await createFinancialReadinessDatabase();
    apiPool = context.poolForRole('apiRole', 6);
    db = pooledDatabase(context.fixture.pool);
    apiDatabase = pooledDatabase(apiPool);
    preparedAuthority = new PostgresUniversalV1PreparedFinancialCommandAuthority(apiDatabase);
  }, 120_000);
  afterAll(async () => {
    await context?.close();
  }, 30_000);
  beforeEach(async () => {
    synchronizePreparations = undefined;
    transactionPids.clear();
    const owner = await createClaimedTaskDraftFixture(
      db,
      context.fixture.pool,
      'prepared-' + randomUUID()
    );
    actorId = owner.posterUserId;
    taskDraftId = owner.draftId;
    operationId = randomUUID();
    idempotencyKey = 'prepared-finance:' + randomUUID();
    attestation = await createSyntheticActorAttestation(
      context.fixture.pool,
      apiDatabase,
      context.clients.get('attesterRole')!,
      context.roles.attesterRole,
      context.authority.release.digest!,
      actorId
    );
  });

  it('serializes concurrent exact preparation into one committed immutable fact', async () => {
    let entered = 0;
    let unlock!: () => void;
    let fail!: (error: Error) => void;
    const gate = new Promise<void>((resolve, reject) => {
      unlock = resolve;
      fail = reject;
    });
    synchronizePreparations = () => {
      if (++entered === 6) unlock();
      return gate;
    };
    const timeout = setTimeout(
      () => fail(new Error('SIX_CONCURRENT_API_TRANSACTIONS_REQUIRED')),
      10_000
    );
    let attempts: PromiseSettledResult<PreparedUniversalV1FinancialCommandReceipt>[];
    try {
      attempts = await Promise.allSettled(
        Array.from({ length: 6 }, () => authority.prepare(preparation()))
      );
    } finally {
      clearTimeout(timeout);
      synchronizePreparations = undefined;
    }
    expect(entered).toBe(6);
    expect(transactionPids.size).toBe(6);
    const receipts = attempts.flatMap((attempt) =>
      attempt.status === 'fulfilled' ? [attempt.value] : []
    );
    expect(receipts).toHaveLength(6);
    expect(attempts.filter(({ status }) => status === 'rejected')).toHaveLength(0);
    const committed = receipts.filter(({ idempotencyReplayed }) => !idempotencyReplayed);
    const replays = receipts.filter(({ idempotencyReplayed }) => idempotencyReplayed);
    expect(committed).toHaveLength(1);
    expect(replays).toHaveLength(5);
    expect(committed[0]).toMatchObject({
      commandState: 'PREPARED',
      eventKind: 'PAYMENT_METHOD_PREPARED',
      providerKind: 'FAKE',
      lifecycleExpectedVersion: 0,
      taskDraftId,
    });
    expect(committed[0]?.authorityContextSha256).toMatch(/^[a-f0-9]{64}$/u);
    for (const replay of replays) {
      expect(replay).toEqual({ ...committed[0]!, idempotencyReplayed: true });
    }

    const count = await db.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count
         FROM public.universal_v1_prepared_financial_commands
        WHERE idempotency_key=$1`,
      [idempotencyKey]
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  it('replays an exact request and rejects changed-key, changed-context, and occupied lifecycle identities', async () => {
    const committed = await authority.prepare(preparation());
    await expect(authority.prepare(preparation())).resolves.toEqual({
      ...committed,
      idempotencyReplayed: true,
    });
    await expect(
      authority.prepare(preparation({ providerRequestSha256: 'f'.repeat(64) }))
    ).rejects.toThrow('UNIVERSAL_V1_PREPARED_FINANCIAL_COMMAND_IDEMPOTENCY_CONFLICT');
    await expect(
      authority.prepare(preparation({ idempotencyKey: `prepared-finance:${randomUUID()}` }))
    ).rejects.toThrow('UNIVERSAL_V1_PREPARED_FINANCIAL_COMMAND_IDEMPOTENCY_CONFLICT');
    await expect(
      authority.prepare(
        preparation({
          operationId: randomUUID(),
          idempotencyKey: `prepared-finance:${randomUUID()}`,
        })
      )
    ).rejects.toThrow('UNIVERSAL_V1_PREPARED_FINANCIAL_COMMAND_IDEMPOTENCY_CONFLICT');
  });

  it('commits PREPARED and REQUESTED but refuses adapter entry without DISPATCH_ATTEMPTED', async () => {
    const prepared = await authority.prepare(preparation());
    const adapter = vi.fn(async () => 'adapter-entered');
    await expect(
      new JournaledFinancialProviderInvoker(
        new PostgresFinancialProviderCommandJournal(apiDatabase)
      ).invokeAfterCommit(
        {
          operationKind: 'PREPARE_PAYMENT_METHOD',
          operationId,
          providerKind: 'FAKE',
          idempotencyKey,
          providerExpectedVersion: 0,
          exactRequest: exactRequest(),
          evidence: {
            preparedFinancialCommandId: prepared.preparedCommandId,
            preparedAuthoritySha256: prepared.authorityContextSha256,
            taskDraftId,
          },
          actor: { actorId, actorKind: 'PARTICIPANT' },
          // Synthetic release metadata bound to this disposable target; not release certification.
          release: {
            manifestDigest: context.authority.release.digest!,
            releaseId: context.authority.manifest.releaseId,
            revision: context.authority.manifest.components.backend.revision,
            environment: 'local',
            authenticationStatus: 'VERIFIED',
          },
        },
        adapter
      )
    ).rejects.toThrow('FOREGROUND_DISPATCH_COORDINATOR_REQUIRED');
    expect(adapter).not.toHaveBeenCalled();
    const persisted = await context.fixture.pool.query(
      'SELECT count(*)::int AS count FROM public.financial_provider_command_journal WHERE prepared_financial_command_id=$1',
      [prepared.preparedCommandId]
    );
    expect(persisted.rows).toEqual([{ count: 1 }]);

    await expect(
      db.query(
        `INSERT INTO public.financial_provider_command_journal (
           operation_kind, operation_id, provider_kind, idempotency_key,
           provider_expected_version, request_sha256, command_identity_sha256,
           prepared_financial_command_id, prepared_authority_sha256,
           task_draft_id, task_id, work_order_id, related_operation_id,
           amount_cents, currency, recorded_actor_id, recorded_actor_kind
         ) VALUES (
           'PREPARE_PAYMENT_METHOD',$1,'FAKE',$2,0,$3,$4,$5,$6,$7,NULL,NULL,NULL,NULL,NULL,$8,'PARTICIPANT'
         )`,
        [
          operationId,
          `prepared-finance:${randomUUID()}`,
          'f'.repeat(64),
          'b'.repeat(64),
          prepared.preparedCommandId,
          prepared.authorityContextSha256,
          taskDraftId,
          actorId,
        ]
      )
    ).rejects.toThrow(/exact committed PREPARED lifecycle authority/iu);

    await expect(
      db.query(
        `INSERT INTO public.financial_provider_command_journal (
           operation_kind, operation_id, provider_kind, idempotency_key,
           provider_expected_version, request_sha256, command_identity_sha256
         ) VALUES ('PREPARE_PAYMENT_METHOD',$1,'FAKE',$2,0,$3,$4)`,
        [randomUUID(), `prepared-finance:${randomUUID()}`, 'a'.repeat(64), 'b'.repeat(64)]
      )
    ).rejects.toThrow(/exact committed PREPARED lifecycle authority/iu);
  });

  it('owns occurrence time in PostgreSQL rather than accepting caller wall clock', async () => {
    const before = Date.now();
    const prepared = await authority.prepare(preparation());
    const after = Date.now();
    expect(Date.parse(prepared.occurredAt)).toBeGreaterThanOrEqual(before - 1_000);
    expect(Date.parse(prepared.occurredAt)).toBeLessThanOrEqual(after + 1_000);
    expect(prepared.occurredAt).not.toBe('1999-01-01T00:00:00.000Z');
  });

  it('rejects approved-provider preparation and UPDATE, DELETE, and TRUNCATE', async () => {
    await expect(
      authority.prepare(preparation({ providerKind: 'APPROVED_PROVIDER' }))
    ).rejects.toThrow('UNIVERSAL_V1_PREPARED_FINANCIAL_COMMAND_APPROVED_PROVIDER_REFUSED');
    const prepared = await authority.prepare(preparation());
    await expect(
      db.query(
        `UPDATE public.universal_v1_prepared_financial_commands
            SET command_state='PREPARED'
          WHERE prepared_command_id=$1`,
        [prepared.preparedCommandId]
      )
    ).rejects.toThrow(/append-only/iu);
    await expect(
      db.query(
        `DELETE FROM public.universal_v1_prepared_financial_commands
          WHERE prepared_command_id=$1`,
        [prepared.preparedCommandId]
      )
    ).rejects.toThrow(/append-only/iu);
    await expect(
      db.query('TRUNCATE TABLE public.universal_v1_prepared_financial_commands')
    ).rejects.toThrow();
    await expect(
      db.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
           FROM public.universal_v1_prepared_financial_commands
          WHERE prepared_command_id=$1`,
        [prepared.preparedCommandId]
      )
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });
});
