import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import pg from 'pg';
import { describe, expect, it } from 'vitest';

const enabled = process.env.HX_ALLOW_TASK_DRAFT_INGRESS_PG === '1';
const describePg = enabled ? describe : describe.skip;
const databaseUrl = process.env.LOCAL_TEST_DB_URL ?? '';
const migration = readFileSync(
  resolve(
    process.cwd(),
    'backend/database/migrations/20260929_universal_v1_double_entry_ledger_v1.sql'
  ),
  'utf8'
);

interface TerminalFixture {
  reconciliationFactId: string;
  reconciliationBridgeId: string;
  terminalPath: 'SETTLED' | 'FULL_REFUND';
}

function assertDisposableDatabase(value: string): URL {
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
      'Double-entry ledger proof may run only from the exact disposable system database identity'
    );
  }
  return parsed;
}

function exactIdentifier(value: string): string {
  if (!/^hx_ci_ledger_[a-f0-9]{24}$/u.test(value)) {
    throw new Error('Refusing an unrecognized disposable ledger database identifier');
  }
  return `"${value}"`;
}

function deterministicUuid(seed: string): string {
  const hexadecimal = createHash('sha256').update(seed).digest('hex').slice(0, 32).split('');
  hexadecimal[12] = '4';
  hexadecimal[16] = ((Number.parseInt(hexadecimal[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const value = hexadecimal.join('');
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20, 32),
  ].join('-');
}

async function installCanonicalStubs(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE public.tasks (
      id UUID PRIMARY KEY,
      automation_classification TEXT NOT NULL
    );
    CREATE TABLE public.task_work_orders (
      id UUID PRIMARY KEY,
      task_id UUID NOT NULL
    );
    CREATE TABLE public.task_financial_security_events (
      id UUID PRIMARY KEY,
      task_draft_id UUID,
      task_id UUID,
      eligibility_decision_id UUID,
      scope_version_id UUID,
      event_kind TEXT,
      status TEXT,
      operation_id TEXT,
      expected_version INTEGER,
      provider_kind TEXT,
      amount_cents BIGINT,
      currency CHAR(3),
      predecessor_event_id UUID,
      completion_fact_id UUID,
      occurred_at TIMESTAMPTZ
    );
    CREATE TABLE public.task_reconciliation_facts (
      id UUID PRIMARY KEY,
      work_order_id UUID,
      reconciliation_version INTEGER,
      expected_version INTEGER,
      recorded_by UUID,
      ledger_state TEXT,
      reconciliation_state TEXT,
      mismatch_codes TEXT[],
      currency CHAR(3),
      customer_ledger_amount_cents BIGINT,
      provider_ledger_amount_cents BIGINT,
      void_event_id UUID,
      capture_event_id UUID,
      refund_event_id UUID,
      reversal_event_id UUID,
      settlement_event_id UUID,
      funding_event_id UUID,
      provider_release_event_id UUID,
      payout_event_id UUID,
      bank_settlement_event_id UUID,
      void_state TEXT,
      capture_state TEXT,
      refund_state TEXT,
      reversal_state TEXT,
      settlement_state TEXT,
      funding_state TEXT,
      provider_release_state TEXT,
      payout_state TEXT,
      bank_settlement_state TEXT
    );
  `);
}

async function installFakeAuthorityStubs(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE public.universal_v1_fake_terminal_lifecycle_intents (
      terminal_intent_id UUID PRIMARY KEY,
      terminal_path TEXT NOT NULL,
      work_order_id UUID NOT NULL,
      task_draft_id UUID NOT NULL,
      task_id UUID NOT NULL,
      scope_version_id UUID NOT NULL,
      eligibility_decision_id UUID NOT NULL,
      starting_financial_event_id UUID NOT NULL,
      starting_financial_version BIGINT NOT NULL,
      starting_reconciliation_version INTEGER NOT NULL,
      completion_fact_id UUID NOT NULL,
      customer_amount_cents BIGINT NOT NULL,
      provider_amount_cents BIGINT NOT NULL,
      currency CHAR(3) NOT NULL,
      idempotency_key TEXT NOT NULL,
      requested_by UUID NOT NULL,
      authority_context_sha256 CHAR(64) NOT NULL
    );
    CREATE TABLE public.universal_v1_fake_reconciliation_bridges (
      reconciliation_bridge_id UUID PRIMARY KEY,
      reconciliation_fact_id UUID NOT NULL UNIQUE,
      terminal_intent_id UUID NOT NULL UNIQUE,
      terminal_lifecycle_event_id UUID NOT NULL,
      provider_state TEXT NOT NULL,
      reconciliation_version INTEGER NOT NULL,
      reconciliation_identity_sha256 CHAR(64) NOT NULL,
      authority_chain_sha256 CHAR(64) NOT NULL
    );
  `);
}

async function materializeTerminalFixture(
  pool: pg.Pool,
  terminalPath: 'SETTLED' | 'FULL_REFUND'
): Promise<TerminalFixture> {
  const taskId = randomUUID();
  const taskDraftId = randomUUID();
  const workOrderId = randomUUID();
  const eligibilityDecisionId = randomUUID();
  const scopeVersionId = randomUUID();
  const requestedBy = randomUUID();
  const completionFactId = randomUUID();
  const startingEventId = randomUUID();
  const terminalIntentId = randomUUID();
  const reconciliationFactId = randomUUID();
  const reconciliationBridgeId = randomUUID();
  const idempotencyKey = `ledger-terminal-${randomUUID()}`;
  const startingFinancialVersion = 3;
  const customerAmountCents = 10_000;
  const providerAmountCents = 8_000;
  const eventPlan =
    terminalPath === 'SETTLED'
      ? [
          ['capture', 'CAPTURED', customerAmountCents],
          ['settle', 'SETTLEMENT_OBSERVED', customerAmountCents],
          ['fund', 'FUNDING_OBSERVED', customerAmountCents],
          ['provider-release', 'PROVIDER_RELEASED', providerAmountCents],
          ['payout', 'PAYOUT_OBSERVED', providerAmountCents],
          ['bank-settlement', 'BANK_SETTLEMENT_OBSERVED', providerAmountCents],
        ]
      : [
          ['capture', 'CAPTURED', customerAmountCents],
          ['full-refund', 'REFUNDED', customerAmountCents],
        ];

  await pool.query(
    `INSERT INTO public.tasks(id, automation_classification)
     VALUES ($1, 'CONTROLLED_TEST')`,
    [taskId]
  );
  await pool.query(
    `INSERT INTO public.task_work_orders(id, task_id) VALUES ($1, $2)`,
    [workOrderId, taskId]
  );
  await pool.query(
    `INSERT INTO public.task_financial_security_events (
       id, task_draft_id, task_id, eligibility_decision_id, scope_version_id,
       event_kind, status, operation_id, expected_version, provider_kind,
       amount_cents, currency, predecessor_event_id, completion_fact_id, occurred_at
     ) VALUES (
       $1, $2, $3, $4, $5, 'SECURED', 'SUCCEEDED', $6, $7, 'FAKE',
       $8, 'USD', NULL, NULL, TIMESTAMPTZ '2026-09-29T00:00:00Z'
     )`,
    [
      startingEventId,
      taskDraftId,
      taskId,
      eligibilityDecisionId,
      scopeVersionId,
      randomUUID(),
      startingFinancialVersion,
      customerAmountCents,
    ]
  );

  const eventIds: string[] = [];
  let predecessorEventId = startingEventId;
  for (const [index, step] of eventPlan.entries()) {
    const [operationLabel, eventKind, amountCents] = step as [string, string, number];
    const eventId = randomUUID();
    eventIds.push(eventId);
    await pool.query(
      `INSERT INTO public.task_financial_security_events (
         id, task_draft_id, task_id, eligibility_decision_id, scope_version_id,
         event_kind, status, operation_id, expected_version, provider_kind,
         amount_cents, currency, predecessor_event_id, completion_fact_id, occurred_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 'SUCCEEDED', $7, $8, 'FAKE',
         $9, 'USD', $10, $11, $12
       )`,
      [
        eventId,
        taskDraftId,
        taskId,
        eligibilityDecisionId,
        scopeVersionId,
        eventKind,
        deterministicUuid(`${idempotencyKey}:${operationLabel}`),
        startingFinancialVersion + index + 1,
        amountCents,
        predecessorEventId,
        index === 0 ? completionFactId : null,
        new Date(Date.UTC(2026, 8, 29, 0, index + 1)),
      ]
    );
    predecessorEventId = eventId;
  }

  await pool.query(
    `INSERT INTO public.universal_v1_fake_terminal_lifecycle_intents (
       terminal_intent_id, terminal_path, work_order_id, task_draft_id, task_id,
       scope_version_id, eligibility_decision_id, starting_financial_event_id,
       starting_financial_version, starting_reconciliation_version,
       completion_fact_id, customer_amount_cents, provider_amount_cents,
       currency, idempotency_key, requested_by, authority_context_sha256
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, 0, $10, $11, $12,
       'USD', $13, $14, $15
     )`,
    [
      terminalIntentId,
      terminalPath,
      workOrderId,
      taskDraftId,
      taskId,
      scopeVersionId,
      eligibilityDecisionId,
      startingEventId,
      startingFinancialVersion,
      completionFactId,
      customerAmountCents,
      providerAmountCents,
      idempotencyKey,
      requestedBy,
      'a'.repeat(64),
    ]
  );

  const captureEventId = eventIds[0];
  const refundEventId = terminalPath === 'FULL_REFUND' ? eventIds[1] : null;
  const settlementEventId = terminalPath === 'SETTLED' ? eventIds[1] : null;
  const fundingEventId = terminalPath === 'SETTLED' ? eventIds[2] : null;
  const providerReleaseEventId = terminalPath === 'SETTLED' ? eventIds[3] : null;
  const payoutEventId = terminalPath === 'SETTLED' ? eventIds[4] : null;
  const bankSettlementEventId = terminalPath === 'SETTLED' ? eventIds[5] : null;
  const terminalLifecycleEventId = eventIds.at(-1);
  if (!captureEventId || !terminalLifecycleEventId) {
    throw new Error('Terminal event fixture was not constructed');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO public.task_reconciliation_facts (
         id, work_order_id, reconciliation_version, expected_version, recorded_by,
         ledger_state, reconciliation_state, mismatch_codes, currency,
         customer_ledger_amount_cents, provider_ledger_amount_cents,
         void_event_id, capture_event_id, refund_event_id, reversal_event_id,
         settlement_event_id, funding_event_id, provider_release_event_id,
         payout_event_id, bank_settlement_event_id,
         void_state, capture_state, refund_state, reversal_state,
         settlement_state, funding_state, provider_release_state,
         payout_state, bank_settlement_state
       ) VALUES (
         $1, $2, 1, 0, $3, 'MATCHED', $4, ARRAY[]::TEXT[], 'USD', $5, $6,
         NULL, $7, $8, NULL, $9, $10, $11, $12, $13,
         'NOT_APPLICABLE', 'CAPTURED', $14, 'NOT_APPLICABLE',
         $15, $16, $17, $18, $19
       )`,
      [
        reconciliationFactId,
        workOrderId,
        requestedBy,
        terminalPath === 'SETTLED' ? 'MATCHED' : 'CLOSED',
        terminalPath === 'SETTLED' ? customerAmountCents : 0,
        terminalPath === 'SETTLED' ? providerAmountCents : 0,
        captureEventId,
        refundEventId,
        settlementEventId,
        fundingEventId,
        providerReleaseEventId,
        payoutEventId,
        bankSettlementEventId,
        terminalPath === 'SETTLED' ? 'NOT_APPLICABLE' : 'REFUNDED',
        terminalPath === 'SETTLED' ? 'SETTLED' : 'NOT_APPLICABLE',
        terminalPath === 'SETTLED' ? 'FUNDED' : 'NOT_APPLICABLE',
        terminalPath === 'SETTLED' ? 'RELEASED' : 'NOT_APPLICABLE',
        terminalPath === 'SETTLED' ? 'PAID' : 'NOT_APPLICABLE',
        terminalPath === 'SETTLED' ? 'SETTLED' : 'NOT_APPLICABLE',
      ]
    );
    await client.query(
      `INSERT INTO public.universal_v1_fake_reconciliation_bridges (
         reconciliation_bridge_id, reconciliation_fact_id, terminal_intent_id,
         terminal_lifecycle_event_id, provider_state, reconciliation_version,
         reconciliation_identity_sha256, authority_chain_sha256
       ) VALUES ($1, $2, $3, $4, 'MATCHED', 1, $5, $6)`,
      [
        reconciliationBridgeId,
        reconciliationFactId,
        terminalIntentId,
        terminalLifecycleEventId,
        'b'.repeat(64),
        'c'.repeat(64),
      ]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return { reconciliationFactId, reconciliationBridgeId, terminalPath };
}

describePg('Universal V1 double-entry ledger PostgreSQL authority', () => {
  it(
    'installs before fake fixtures and certifies exact balanced SETTLED and FULL_REFUND paths',
    async () => {
      const sourceUrl = assertDisposableDatabase(databaseUrl);
      const proofDatabaseName = `hx_ci_ledger_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
      const quotedProofDatabase = exactIdentifier(proofDatabaseName);
      const adminUrl = new URL(sourceUrl);
      adminUrl.pathname = '/postgres';
      const proofUrl = new URL(sourceUrl);
      proofUrl.pathname = `/${proofDatabaseName}`;
      const adminPool = new pg.Pool({ connectionString: adminUrl.toString(), max: 1 });
      let proofPool: pg.Pool | null = null;
      let databaseCreated = false;

      try {
        await adminPool.query(`CREATE DATABASE ${quotedProofDatabase}`);
        databaseCreated = true;
        proofPool = new pg.Pool({ connectionString: proofUrl.toString(), max: 2 });
        await installCanonicalStubs(proofPool);

        await proofPool.query(migration);
        const engineOrder = await proofPool.query<{
          fake_bridge: string | null;
          fake_intent: string | null;
          accounts: string;
          ledger_table: string | null;
          required_trigger: string | null;
        }>(
          `SELECT to_regclass('public.universal_v1_fake_reconciliation_bridges')::TEXT
                    AS fake_bridge,
                  to_regclass('public.universal_v1_fake_terminal_lifecycle_intents')::TEXT
                    AS fake_intent,
                  (SELECT count(*)::TEXT FROM public.universal_v1_ledger_accounts_v1)
                    AS accounts,
                  to_regclass('public.universal_v1_ledger_transactions_v1')::TEXT
                    AS ledger_table,
                  (SELECT trigger.tgname
                     FROM pg_trigger trigger
                    WHERE trigger.tgrelid = 'public.task_reconciliation_facts'::regclass
                      AND trigger.tgname = 'zz_universal_v1_double_entry_ledger_required_v1')
                    AS required_trigger`
        );
        expect(engineOrder.rows[0]).toEqual({
          fake_bridge: null,
          fake_intent: null,
          accounts: '7',
          ledger_table: 'universal_v1_ledger_transactions_v1',
          required_trigger: 'zz_universal_v1_double_entry_ledger_required_v1',
        });

        await proofPool.query(migration);
        await expect(
          proofPool.query('SELECT count(*)::INTEGER AS count FROM universal_v1_ledger_accounts_v1')
        ).resolves.toMatchObject({ rows: [{ count: 7 }] });

        await installFakeAuthorityStubs(proofPool);
        const settled = await materializeTerminalFixture(proofPool, 'SETTLED');
        const fullRefund = await materializeTerminalFixture(proofPool, 'FULL_REFUND');

        const certifications = await proofPool.query<{
          terminal_path: 'SETTLED' | 'FULL_REFUND';
          certified_transaction_count: number;
          certified_posting_count: number;
          debit_total_cents: string;
          credit_total_cents: string;
          currency: string;
        }>(
          `SELECT terminal_path, certified_transaction_count,
                  certified_posting_count, debit_total_cents::TEXT,
                  credit_total_cents::TEXT, currency
             FROM public.universal_v1_ledger_certifications_v1
            ORDER BY terminal_path`
        );
        expect(certifications.rows).toEqual([
          {
            terminal_path: 'FULL_REFUND',
            certified_transaction_count: 2,
            certified_posting_count: 4,
            debit_total_cents: '20000',
            credit_total_cents: '20000',
            currency: 'USD',
          },
          {
            terminal_path: 'SETTLED',
            certified_transaction_count: 6,
            certified_posting_count: 13,
            debit_total_cents: '54000',
            credit_total_cents: '54000',
            currency: 'USD',
          },
        ]);

        const pathCounts = await proofPool.query<{
          terminal_path: string;
          transactions: number;
          postings: number;
          unbalanced_transactions: number;
        }>(
          `WITH transaction_balance AS (
             SELECT transaction.terminal_path,
                    transaction.ledger_transaction_id,
                    sum(posting.amount_cents)
                      FILTER (WHERE posting.posting_side = 'DEBIT') AS debits,
                    sum(posting.amount_cents)
                      FILTER (WHERE posting.posting_side = 'CREDIT') AS credits,
                    count(posting.ledger_posting_id)::INTEGER AS postings
               FROM public.universal_v1_ledger_transactions_v1 transaction
               JOIN public.universal_v1_ledger_postings_v1 posting
                 USING (ledger_transaction_id)
              GROUP BY transaction.terminal_path, transaction.ledger_transaction_id
           )
           SELECT terminal_path,
                  count(*)::INTEGER AS transactions,
                  sum(postings)::INTEGER AS postings,
                  count(*) FILTER (WHERE debits IS DISTINCT FROM credits)::INTEGER
                    AS unbalanced_transactions
             FROM transaction_balance
            GROUP BY terminal_path
            ORDER BY terminal_path`
        );
        expect(pathCounts.rows).toEqual([
          {
            terminal_path: 'FULL_REFUND',
            transactions: 2,
            postings: 4,
            unbalanced_transactions: 0,
          },
          {
            terminal_path: 'SETTLED',
            transactions: 6,
            postings: 13,
            unbalanced_transactions: 0,
          },
        ]);
        await expect(
          proofPool.query(
            `SELECT posting.amount_cents::TEXT AS amount_cents
               FROM public.universal_v1_ledger_postings_v1 posting
               JOIN public.universal_v1_ledger_transactions_v1 transaction
                 USING (ledger_transaction_id)
              WHERE transaction.reconciliation_fact_id = $1
                AND transaction.transaction_kind = 'FUNDING'
                AND posting.account_code = 'SUSPENSE_UNALLOCATED'
                AND posting.posting_side = 'CREDIT'`,
            [settled.reconciliationFactId]
          )
        ).resolves.toMatchObject({ rows: [{ amount_cents: '2000' }] });

        const replaySnapshotSql = `SELECT
          (SELECT count(*)::INTEGER FROM public.universal_v1_ledger_transactions_v1)
            AS transactions,
          (SELECT count(*)::INTEGER FROM public.universal_v1_ledger_postings_v1)
            AS postings,
          (SELECT count(*)::INTEGER FROM public.universal_v1_ledger_certifications_v1)
            AS certifications,
          (SELECT encode(
             digest(string_agg(certification_identity_sha256, '' ORDER BY terminal_path), 'sha256'),
             'hex'
           ) FROM public.universal_v1_ledger_certifications_v1) AS certification_digest`;
        const beforeReplay = await proofPool.query<{
          transactions: number;
          postings: number;
          certifications: number;
          certification_digest: string;
        }>(replaySnapshotSql);
        for (const fixture of [settled, fullRefund]) {
          await expect(
            proofPool.query<{ materialized: boolean }>(
              `SELECT public.materialize_universal_v1_double_entry_ledger_v1($1)
                        AS materialized`,
              [fixture.reconciliationFactId]
            )
          ).resolves.toMatchObject({ rows: [{ materialized: true }] });
        }
        const afterReplay = await proofPool.query(replaySnapshotSql);
        expect(afterReplay.rows).toEqual(beforeReplay.rows);

        await expect(
          proofPool.query(
            `UPDATE public.universal_v1_ledger_transactions_v1
                SET event_amount_cents = event_amount_cents + 1
              WHERE reconciliation_fact_id = $1`,
            [settled.reconciliationFactId]
          )
        ).rejects.toMatchObject({
          code: 'P0001',
          message: expect.stringContaining('HXUV1-LEDGER-60'),
        });
        await expect(
          proofPool.query(
            `INSERT INTO public.universal_v1_ledger_postings_v1 (
               ledger_posting_id, ledger_transaction_id, transaction_kind,
               posting_ordinal, posting_side, account_code, amount_cents,
               currency, posting_identity_sha256, recorded_at
             )
             SELECT gen_random_uuid(), transaction.ledger_transaction_id,
                    transaction.transaction_kind, 3, 'CREDIT',
                    'SUSPENSE_UNALLOCATED', 1, transaction.currency,
                    repeat('d', 64), transaction.recorded_at
               FROM public.universal_v1_ledger_transactions_v1 transaction
              WHERE transaction.reconciliation_fact_id = $1
                AND transaction.transaction_kind = 'CAPTURE'`,
            [settled.reconciliationFactId]
          )
        ).rejects.toMatchObject({
          code: 'P0001',
          message: expect.stringContaining('HXUV1-LEDGER-22'),
        });
        await expect(
          proofPool.query(
            `INSERT INTO public.universal_v1_ledger_certifications_v1 (
               ledger_certification_id, reconciliation_bridge_id, terminal_intent_id,
               reconciliation_fact_id, work_order_id, terminal_path, currency,
               certified_transaction_count, certified_posting_count,
               debit_total_cents, credit_total_cents, ledger_sha256,
               certification_identity_sha256
             )
             SELECT gen_random_uuid(), certification.reconciliation_bridge_id,
                    certification.terminal_intent_id, certification.reconciliation_fact_id,
                    certification.work_order_id, certification.terminal_path,
                    certification.currency, certification.certified_transaction_count,
                    certification.certified_posting_count,
                    certification.debit_total_cents + 1,
                    certification.credit_total_cents + 1,
                    certification.ledger_sha256,
                    certification.certification_identity_sha256
               FROM public.universal_v1_ledger_certifications_v1 certification
              WHERE certification.reconciliation_bridge_id = $1`,
            [settled.reconciliationBridgeId]
          )
        ).rejects.toMatchObject({
          code: 'P0001',
          message: expect.stringContaining('HXUV1-LEDGER-37'),
        });

        await expect(
          proofPool.query(
            `SELECT count(*)::INTEGER AS count
               FROM public.universal_v1_ledger_certifications_v1`
          )
        ).resolves.toMatchObject({ rows: [{ count: 2 }] });
      } finally {
        try {
          if (proofPool) await proofPool.end();
        } finally {
          try {
            if (databaseCreated) {
              await adminPool.query(`DROP DATABASE ${quotedProofDatabase}`);
            }
          } finally {
            await adminPool.end();
          }
        }
      }
    },
    60_000
  );
});
