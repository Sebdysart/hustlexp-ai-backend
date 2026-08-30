import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db, hasDb } from '../../src/db.js';
import {
  canonicalFinancialProviderRequestSha256,
  JournaledFinancialProviderInvoker,
  PostgresFinancialProviderCommandJournal,
} from '../../src/services/payment/FinancialProviderCommandJournal.js';
import {
  PostgresUniversalV1PreparedFinancialCommandAuthority,
  type PrepareUniversalV1FinancialCommandInput,
} from '../../src/services/payment/PreparedFinancialCommandAuthority.js';

const describePg = describe.sequential.skipIf(!hasDb);
let actorId = randomUUID();
let taskDraftId = randomUUID();
let operationId = randomUUID();
let idempotencyKey = `prepared-finance:${randomUUID()}`;

function exactRequest() {
  return {
    operationId,
    idempotencyKey,
    expectedVersion: 0,
    customerId: 'synthetic-customer',
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
  const authority = new PostgresUniversalV1PreparedFinancialCommandAuthority(db);

  beforeEach(async () => {
    actorId = randomUUID();
    taskDraftId = randomUUID();
    operationId = randomUUID();
    idempotencyKey = `prepared-finance:${randomUUID()}`;
    await db.query(
      `INSERT INTO public.users(id, email, full_name)
       VALUES ($1, $2, 'Prepared Finance System Actor')`,
      [actorId, `prepared-finance-${actorId}@example.invalid`]
    );
    await db.query(
      `INSERT INTO public.task_drafts(
         id, submission_id, card_token_hash, raw_input, universal_contract_version
       ) VALUES ($1, $2, $3, 'Synthetic prepared finance proof', 1)`,
      [taskDraftId, randomUUID(), `prepared-finance-card-${randomUUID()}`]
    );
  });

  it('serializes concurrent exact preparation into one committed immutable fact', async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, () => authority.prepare(preparation()))
    );
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
    await expect(
      authority.prepare(preparation())
    ).resolves.toEqual({ ...committed, idempotencyReplayed: true });
    await expect(
      authority.prepare(preparation({ providerRequestSha256: 'f'.repeat(64) }))
    ).rejects.toThrow('UNIVERSAL_V1_PREPARED_FINANCIAL_COMMAND_IDEMPOTENCY_CONFLICT');
    await expect(
      authority.prepare(
        preparation({ idempotencyKey: `prepared-finance:${randomUUID()}` })
      )
    ).rejects.toThrow('UNIVERSAL_V1_PREPARED_FINANCIAL_COMMAND_OPERATION_VERSION_CONFLICT');
    await expect(
      authority.prepare(
        preparation({
          operationId: randomUUID(),
          idempotencyKey: `prepared-finance:${randomUUID()}`,
        })
      )
    ).rejects.toThrow('UNIVERSAL_V1_PREPARED_FINANCIAL_COMMAND_LIFECYCLE_VERSION_CONFLICT');
  });

  it('commits PREPARED and REQUESTED but refuses adapter entry without DISPATCH_ATTEMPTED', async () => {
    const prepared = await authority.prepare(preparation());
    const adapter = vi.fn(async () => 'adapter-entered');
    await expect(new JournaledFinancialProviderInvoker(
      new PostgresFinancialProviderCommandJournal(db)
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
      },
      adapter
    )).rejects.toThrow('FOREGROUND_DISPATCH_COORDINATOR_REQUIRED');
    expect(adapter).not.toHaveBeenCalled();

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
