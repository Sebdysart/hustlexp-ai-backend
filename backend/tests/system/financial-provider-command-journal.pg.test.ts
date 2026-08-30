import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { db, hasDb } from '../../src/db.js';
import {
  JournaledFinancialProviderInvoker,
  PostgresFinancialProviderCommandJournal,
  type RecordFinancialProviderCommandInput,
} from '../../src/services/payment/FinancialProviderCommandJournal.js';

const describePg = describe.sequential.skipIf(!hasDb);

function command(
  overrides: Partial<RecordFinancialProviderCommandInput<Record<string, unknown>>> = {}
): RecordFinancialProviderCommandInput<Record<string, unknown>> {
  const operationId = randomUUID();
  return {
    operationKind: 'ONBOARD_PROVIDER',
    operationId,
    providerKind: 'FAKE',
    idempotencyKey: `finance-command:${randomUUID()}`,
    providerExpectedVersion: 0,
    exactRequest: {
      operationId,
      expectedVersion: 0,
      amountCents: 4_200,
      currency: 'usd',
      paymentMethodReference: `pm_secret_${randomUUID()}`,
    },
    evidence: {
      taskDraftId: randomUUID(),
      taskId: randomUUID(),
      amountCents: 4_200,
      currency: 'usd',
    },
    ...overrides,
  };
}

describePg('financial provider command journal PostgreSQL authority', () => {
  const journal = new PostgresFinancialProviderCommandJournal(db);

  it('commits the immutable request before entering the adapter callback', async () => {
    const input = command();
    const result = await new JournaledFinancialProviderInvoker(journal).invokeAfterCommit(
      input,
      async (_exactRequest, receipt) => {
        const visible = await db.query<{ count: number }>(
          `SELECT COUNT(*)::integer AS count
             FROM public.financial_provider_command_journal
            WHERE command_id=$1 AND command_state='REQUESTED'`,
          [receipt.commandId]
        );
        expect(visible.rows[0]?.count).toBe(1);
        return 'adapter-entered-after-commit';
      }
    );

    expect(result.result).toBe('adapter-entered-after-commit');
    expect(result.command.idempotencyReplayed).toBe(false);
  });

  it('allows exact replay, rejects changed same-key input, and permits the next version', async () => {
    const input = command();
    const first = await journal.recordRequested(input);
    const replay = await journal.recordRequested(input);
    expect(replay).toEqual({ ...first, idempotencyReplayed: true });

    await expect(
      journal.recordRequested({
        ...input,
        exactRequest: { ...input.exactRequest, amountCents: 4_201 },
      })
    ).rejects.toThrow('FINANCIAL_PROVIDER_COMMAND_JOURNAL_IDEMPOTENCY_CONFLICT');
    await expect(
      journal.recordRequested({
        ...input,
        idempotencyKey: `finance-command:${randomUUID()}`,
      })
    ).rejects.toThrow('FINANCIAL_PROVIDER_COMMAND_JOURNAL_OPERATION_VERSION_CONFLICT');

    const nextVersion = await journal.recordRequested({
      ...input,
      idempotencyKey: `finance-command:${randomUUID()}`,
      providerExpectedVersion: 1,
      exactRequest: { ...input.exactRequest, expectedVersion: 1 },
    });
    expect(nextVersion).toMatchObject({
      operationId: input.operationId,
      providerExpectedVersion: 1,
      idempotencyReplayed: false,
    });
  });

  it('never persists the raw request and denies UPDATE, DELETE, and TRUNCATE', async () => {
    const secret = `pm_secret_${randomUUID()}`;
    const input = command({
      exactRequest: {
        operationId: randomUUID(),
        paymentMethodReference: secret,
        providerAccountReference: `acct_secret_${randomUUID()}`,
      },
    });
    const receipt = await journal.recordRequested(input);
    const stored = await db.query<{ serialized: string }>(
      `SELECT to_jsonb(command)::text AS serialized
         FROM public.financial_provider_command_journal command
        WHERE command_id=$1`,
      [receipt.commandId]
    );
    expect(stored.rows[0]?.serialized).not.toContain(secret);
    expect(stored.rows[0]?.serialized).not.toContain('paymentMethodReference');
    expect(stored.rows[0]?.serialized).not.toContain('providerAccountReference');

    await expect(
      db.query(
        `UPDATE public.financial_provider_command_journal
          SET command_state='REQUESTED'
        WHERE command_id=$1`,
        [receipt.commandId]
      )
    ).rejects.toThrow(/append-only/iu);
    await expect(
      db.query('DELETE FROM public.financial_provider_command_journal WHERE command_id=$1', [
        receipt.commandId,
      ])
    ).rejects.toThrow(/append-only/iu);
    await expect(
      db.query('TRUNCATE TABLE public.financial_provider_command_journal')
    ).rejects.toThrow();
    await expect(
      db.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
           FROM public.financial_provider_command_journal
          WHERE command_id=$1`,
        [receipt.commandId]
      )
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it('rejects an APPROVED_PROVIDER row without actor and verified release evidence in SQL', async () => {
    await expect(
      db.query(
        `INSERT INTO public.financial_provider_command_journal (
         operation_kind, operation_id, provider_kind, idempotency_key,
         provider_expected_version, request_sha256, command_identity_sha256
       ) VALUES ('ONBOARD_PROVIDER',$1,'APPROVED_PROVIDER',$2,0,$3,$4)`,
        [randomUUID(), `finance-command:${randomUUID()}`, 'a'.repeat(64), 'b'.repeat(64)]
      )
    ).rejects.toMatchObject({ code: '23514' });
  });
});
