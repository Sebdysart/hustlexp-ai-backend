import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import pg from 'pg';
import { describe, expect, it } from 'vitest';

const enabled = process.env.HX_ALLOW_TASK_DRAFT_INGRESS_PG === '1';
const describePg = enabled ? describe : describe.skip;
const databaseUrl = process.env.LOCAL_TEST_DB_URL ?? '';
const engine = readFileSync(
  resolve(
    process.cwd(),
    'backend/database/migrations/20261002_universal_v1_dispute_recovery_v1.sql',
  ),
  'utf8',
);
const fakeFixture = readFileSync(
  resolve(
    process.cwd(),
    'backend/database/migrations/20261002_universal_v1_dispute_fake_release_gate_v8.sql',
  ),
  'utf8',
);

function assertDisposableDatabase(value: string): URL {
  const parsed = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol)
    || parsed.hostname !== '127.0.0.1'
    || parsed.port !== '5432'
    || parsed.username !== 'hx_ci_runner'
    || parsed.pathname !== '/hx_ci_system_test'
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(
      'Dispute/recovery proof may run only from the exact disposable system database identity',
    );
  }
  return parsed;
}

function exactIdentifier(value: string): string {
  if (!/^hx_ci_dispute_[a-f0-9]{24}$/u.test(value)) {
    throw new Error('Refusing an unrecognized disposable dispute database identifier');
  }
  return `"${value}"`;
}

async function installCanonicalStubs(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE public.users (
      id UUID PRIMARY KEY,
      full_name TEXT NOT NULL,
      account_status TEXT NOT NULL,
      is_banned BOOLEAN NOT NULL DEFAULT FALSE,
      is_minor BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE TABLE public.admin_roles (
      user_id UUID PRIMARY KEY REFERENCES public.users(id),
      role TEXT NOT NULL,
      can_resolve_disputes BOOLEAN NOT NULL DEFAULT FALSE,
      can_manage_operations BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE TABLE public.business_organizations (id UUID PRIMARY KEY);
    CREATE TABLE public.business_memberships (
      organization_id UUID NOT NULL REFERENCES public.business_organizations(id),
      user_id UUID NOT NULL REFERENCES public.users(id),
      status TEXT NOT NULL,
      role TEXT NOT NULL,
      PRIMARY KEY (organization_id, user_id)
    );
    CREATE TABLE public.task_drafts (
      id UUID PRIMARY KEY,
      task_id UUID,
      universal_contract_version INTEGER NOT NULL,
      active_routing_decision_id UUID
    );
    CREATE TABLE public.tasks (
      id UUID PRIMARY KEY,
      poster_id UUID NOT NULL REFERENCES public.users(id),
      work_order_id UUID,
      version BIGINT NOT NULL,
      universal_contract_version INTEGER NOT NULL
    );
    CREATE TABLE public.task_routing_decisions (
      id UUID PRIMARY KEY,
      task_draft_id UUID NOT NULL REFERENCES public.task_drafts(id),
      decision_version INTEGER NOT NULL,
      outcome TEXT NOT NULL
    );
    CREATE TABLE public.task_work_orders (
      id UUID PRIMARY KEY,
      task_draft_id UUID NOT NULL REFERENCES public.task_drafts(id),
      task_id UUID NOT NULL REFERENCES public.tasks(id),
      provider_user_id UUID REFERENCES public.users(id),
      provider_organization_id UUID REFERENCES public.business_organizations(id),
      materialization_version INTEGER NOT NULL
    );
    CREATE TABLE public.task_completion_facts (
      id UUID PRIMARY KEY,
      work_order_id UUID NOT NULL REFERENCES public.task_work_orders(id),
      task_id UUID NOT NULL REFERENCES public.tasks(id),
      completion_version INTEGER NOT NULL,
      fact_kind TEXT NOT NULL
    );
    CREATE TABLE public.task_work_order_execution_facts (
      id UUID PRIMARY KEY,
      work_order_id UUID NOT NULL REFERENCES public.task_work_orders(id),
      task_id UUID NOT NULL REFERENCES public.tasks(id),
      completion_fact_id UUID REFERENCES public.task_completion_facts(id),
      execution_version INTEGER NOT NULL,
      state TEXT NOT NULL,
      transition_kind TEXT NOT NULL
    );
    CREATE TABLE public.task_reconciliation_facts (
      id UUID PRIMARY KEY,
      work_order_id UUID NOT NULL REFERENCES public.task_work_orders(id),
      reconciliation_state TEXT NOT NULL
    );
    CREATE TABLE public.universal_v1_prepared_financial_commands (
      id UUID PRIMARY KEY,
      task_draft_id UUID,
      task_id UUID,
      work_order_id UUID NOT NULL REFERENCES public.task_work_orders(id),
      operation_kind TEXT NOT NULL
    );
    CREATE TABLE public.financial_provider_command_journal (
      id UUID PRIMARY KEY,
      work_order_id UUID NOT NULL REFERENCES public.task_work_orders(id),
      operation_kind TEXT NOT NULL
    );
    CREATE TABLE public.task_financial_security_events (
      id UUID PRIMARY KEY,
      task_id UUID NOT NULL REFERENCES public.tasks(id),
      event_kind TEXT NOT NULL
    );
    CREATE FUNCTION public.prevent_universal_v1_fact_mutation()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'HX-FACT-IMMUTABLE: canonical fact mutation denied'
        USING ERRCODE = 'P0001';
    END;
    $$;
  `);
}

async function expectHx(
  promise: Promise<unknown>,
  marker: string,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    code: 'P0001',
    message: expect.stringContaining(marker),
  });
}

describePg('Universal V1 dispute/recovery PostgreSQL authority', () => {
  it('proves exact authority, deterministic retries, role boundaries, and closure/release holds', async () => {
    const sourceUrl = assertDisposableDatabase(databaseUrl);
    const proofDatabaseName = `hx_ci_dispute_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
    const quotedProofDatabase = exactIdentifier(proofDatabaseName);
    const adminUrl = new URL(sourceUrl);
    adminUrl.pathname = '/hx_ci_admin_test';
    const proofUrl = new URL(sourceUrl);
    proofUrl.pathname = `/${proofDatabaseName}`;
    const adminPool = new pg.Pool({ connectionString: adminUrl.toString(), max: 1 });
    let proofPool: pg.Pool | null = null;
    let databaseCreated = false;

    try {
      await adminPool.query(`CREATE DATABASE ${quotedProofDatabase}`);
      databaseCreated = true;
      proofPool = new pg.Pool({ connectionString: proofUrl.toString(), max: 5 });
      await installCanonicalStubs(proofPool);

      expect((await proofPool.query(
        "SELECT to_regclass('public.universal_v1_fake_terminal_lifecycle_intents') AS relation",
      )).rows[0]?.relation).toBeNull();
      await proofPool.query(engine);
      await proofPool.query(engine);

      const posture = await proofPool.query<{
        functions: number;
        fixed_search_paths: number;
        public_executors: number;
        public_digest: string | null;
      }>(`
        SELECT count(*)::INTEGER AS functions,
               count(*) FILTER (
                 WHERE routine.proconfig @> ARRAY['search_path=pg_catalog, public']
               )::INTEGER AS fixed_search_paths,
               count(*) FILTER (
                 WHERE has_function_privilege('public', routine.oid, 'EXECUTE')
               )::INTEGER AS public_executors,
               to_regprocedure('public.digest(text,text)')::TEXT AS public_digest
          FROM pg_proc routine
          JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
         WHERE namespace.nspname = 'public'
           AND (
             routine.proname LIKE '%universal_v1_dispute%'
             OR routine.proname = 'record_universal_v1_recovery_approval_v1'
             OR routine.proname = 'universal_v1_has_open_material_dispute_v1'
           )
      `);
      expect(posture.rows[0]).toEqual({
        functions: 13,
        fixed_search_paths: 13,
        public_executors: 0,
        public_digest: 'digest(text,text)',
      });

      const customerId = randomUUID();
      const providerId = randomUUID();
      const operatorAId = randomUUID();
      const operatorBId = randomUUID();
      const unrelatedId = randomUUID();
      const organizationId = randomUUID();
      const draftId = randomUUID();
      const taskId = randomUUID();
      const routeId = randomUUID();
      const workOrderId = randomUUID();
      const completionId = randomUUID();
      const executionId = randomUUID();
      await proofPool.query(
        `INSERT INTO public.users(id, full_name, account_status, is_banned, is_minor)
         SELECT actor_id, actor_name, 'ACTIVE', FALSE, FALSE
         FROM unnest($1::UUID[], $2::TEXT[]) actor(actor_id, actor_name)`,
        [
          [customerId, providerId, operatorAId, operatorBId, unrelatedId],
          ['Customer', 'Provider member', 'Operator A', 'Operator B', 'Unrelated'],
        ],
      );
      await proofPool.query(
        `INSERT INTO public.admin_roles(
           user_id, role, can_resolve_disputes, can_manage_operations
         ) VALUES ($1, 'admin', TRUE, TRUE), ($2, 'support', TRUE, TRUE)`,
        [operatorAId, operatorBId],
      );
      await proofPool.query(
        'INSERT INTO public.business_organizations(id) VALUES ($1)',
        [organizationId],
      );
      await proofPool.query(
        `INSERT INTO public.business_memberships(
           organization_id, user_id, status, role
         ) VALUES ($1, $2, 'ACTIVE', 'CREW')`,
        [organizationId, providerId],
      );
      await proofPool.query(
        `INSERT INTO public.task_drafts(
           id, task_id, universal_contract_version, active_routing_decision_id
         ) VALUES ($1, $2, 1, $3)`,
        [draftId, taskId, routeId],
      );
      await proofPool.query(
        `INSERT INTO public.tasks(
           id, poster_id, work_order_id, version, universal_contract_version
         ) VALUES ($1, $2, $3, 9, 1)`,
        [taskId, customerId, workOrderId],
      );
      await proofPool.query(
        `INSERT INTO public.task_routing_decisions(
           id, task_draft_id, decision_version, outcome
         ) VALUES ($1, $2, 4, 'FULFILLMENT_CANDIDATE')`,
        [routeId, draftId],
      );
      await proofPool.query(
        `INSERT INTO public.task_work_orders(
           id, task_draft_id, task_id, provider_user_id,
           provider_organization_id, materialization_version
         ) VALUES ($1, $2, $3, NULL, $4, 2)`,
        [workOrderId, draftId, taskId, organizationId],
      );
      await proofPool.query(
        `INSERT INTO public.task_completion_facts(
           id, work_order_id, task_id, completion_version, fact_kind
         ) VALUES ($1, $2, $3, 1, 'SUBMITTED')`,
        [completionId, workOrderId, taskId],
      );
      await proofPool.query(
        `INSERT INTO public.task_work_order_execution_facts(
           id, work_order_id, task_id, completion_fact_id,
           execution_version, state, transition_kind
         ) VALUES ($1, $2, $3, $4, 7, 'COMPLETION_SUBMITTED', 'COMPLETION_RECORDED')`,
        [executionId, workOrderId, taskId, completionId],
      );

      const openSql = `SELECT * FROM public.open_universal_v1_dispute_v1(
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
      )`;
      const openKey = 'dispute-open-pg-concurrent-0001';
      const openingDigest = 'a'.repeat(64);
      const openParams = [
        taskId, 9, workOrderId, 2, completionId, 1, 7,
        'QUALITY', openingDigest, customerId, openKey,
      ];
      const concurrentOpen = await Promise.all([
        proofPool.query(openSql, openParams),
        proofPool.query(openSql, openParams),
      ]);
      const opened = concurrentOpen.map((result) => result.rows[0]);
      expect(new Set(opened.map((row) => row.dispute_id)).size).toBe(1);
      expect(opened.map((row) => row.idempotency_replayed).sort()).toEqual([false, true]);
      expect(opened.map((row) => [row.dispute_state, row.dispute_version]))
        .toEqual([['OPEN', 1], ['OPEN', 1]]);
      const disputeId = opened[0]?.dispute_id as string;
      expect((await proofPool.query(
        'SELECT count(*)::INTEGER AS count FROM public.universal_v1_dispute_incidents',
      )).rows[0]?.count).toBe(1);

      await expectHx(
        proofPool.query(openSql, [
          ...openParams.slice(0, 7), 'SCOPE', ...openParams.slice(8),
        ]),
        'HXUDR4',
      );
      await expectHx(
        proofPool.query(openSql, [
          ...openParams.slice(0, 9), unrelatedId, 'dispute-open-pg-unrelated-0001',
        ]),
        'HXUDR1',
      );

      const evidenceSql = `SELECT * FROM public.add_universal_v1_dispute_evidence_v1(
        $1, $2, $3, $4, $5, $6, $7, $8
      )`;
      await expectHx(
        proofPool.query(evidenceSql, [
          disputeId, 1, 'PHOTO', 'b'.repeat(64), 'image/png', 256,
          customerId, openKey,
        ]),
        'HXUDR4',
      );
      const evidenceParams = [
        disputeId, 1, 'PHOTO', 'b'.repeat(64), 'image/png', 256,
        providerId, 'dispute-evidence-pg-0001',
      ];
      const evidenceCreated = (await proofPool.query(
        evidenceSql, evidenceParams,
      )).rows[0];
      expect(evidenceCreated).toMatchObject({
        dispute_state: 'OPEN',
        dispute_version: 2,
        idempotency_replayed: false,
      });

      const reviewResult = (await proofPool.query(
        `SELECT * FROM public.begin_universal_v1_dispute_review_v1(
           $1, 2, $2, $3, $4
         )`,
        [disputeId, 'c'.repeat(64), operatorAId, 'dispute-review-pg-0001'],
      )).rows[0];
      expect(reviewResult).toMatchObject({
        dispute_state: 'UNDER_REVIEW',
        dispute_version: 3,
        idempotency_replayed: false,
      });

      const openReplay = (await proofPool.query(openSql, openParams)).rows[0];
      expect(openReplay).toMatchObject({
        dispute_id: disputeId,
        dispute_state: 'OPEN',
        dispute_version: 1,
        idempotency_replayed: true,
      });
      expect({ ...openReplay, idempotency_replayed: false }).toEqual(opened.find(
        (row) => row.idempotency_replayed === false,
      ));
      const evidenceReplay = (await proofPool.query(
        evidenceSql, evidenceParams,
      )).rows[0];
      expect(evidenceReplay).toMatchObject({
        evidence_fact_id: evidenceCreated.evidence_fact_id,
        dispute_state: 'OPEN',
        dispute_version: 2,
        idempotency_replayed: true,
      });
      expect({ ...evidenceReplay, idempotency_replayed: false }).toEqual(evidenceCreated);

      await expect(proofPool.query(
        'SELECT public.assert_universal_v1_dispute_participant_v1($1, $2)',
        [workOrderId, providerId],
      )).resolves.toMatchObject({ rows: [{ assert_universal_v1_dispute_participant_v1: 'PROVIDER' }] });
      await proofPool.query(
        `UPDATE public.business_memberships SET status = 'REVOKED'
          WHERE organization_id = $1 AND user_id = $2`,
        [organizationId, providerId],
      );
      await expectHx(
        proofPool.query(
          'SELECT public.assert_universal_v1_dispute_participant_v1($1, $2)',
          [workOrderId, providerId],
        ),
        'HXUDR1',
      );
      await expectHx(
        proofPool.query(evidenceSql, evidenceParams),
        'HXUDR1',
      );
      await proofPool.query(
        `UPDATE public.users SET is_minor = TRUE WHERE id = $1`,
        [customerId],
      );
      await expectHx(
        proofPool.query(
          'SELECT public.assert_universal_v1_dispute_participant_v1($1, $2)',
          [workOrderId, customerId],
        ),
        'HXUDR1',
      );
      await expectHx(
        proofPool.query(openSql, openParams),
        'HXUDR1',
      );

      const recoveryResult = (await proofPool.query(
        `SELECT * FROM public.propose_universal_v1_dispute_recovery_v1(
           $1, 3, 'REWORK', $2, $3, $4
         )`,
        [disputeId, 'd'.repeat(64), operatorAId, 'dispute-proposal-pg-0001'],
      )).rows[0];
      expect(recoveryResult).toMatchObject({
        dispute_state: 'RESOLUTION_PROPOSED',
        dispute_version: 4,
        authority_state: 'HELD_TWO_PERSON_DATABASE_CALLER_UNATTESTED',
      });
      await expectHx(
        proofPool.query(
          `SELECT * FROM public.record_universal_v1_recovery_approval_v1(
             $1, 4, $2, $3, $4
           )`,
          [
            recoveryResult.recovery_intent_id,
            'e'.repeat(64),
            operatorAId,
            'dispute-self-approval-pg-0001',
          ],
        ),
        'HXUDR11',
      );
      const approvalSql = `SELECT * FROM public.record_universal_v1_recovery_approval_v1(
        $1, 4, $2, $3, $4
      )`;
      const approvalParams = [
        recoveryResult.recovery_intent_id,
        'f'.repeat(64),
        operatorBId,
        'dispute-approval-pg-concurrent-0001',
      ];
      const concurrentApproval = await Promise.all([
        proofPool.query(approvalSql, approvalParams),
        proofPool.query(approvalSql, approvalParams),
      ]);
      const approvals = concurrentApproval.map((result) => result.rows[0]);
      expect(new Set(approvals.map((row) => row.approval_fact_id)).size).toBe(1);
      expect(approvals.map((row) => row.idempotency_replayed).sort()).toEqual([false, true]);
      expect(approvals.map((row) => [row.dispute_state, row.dispute_version]))
        .toEqual([
          ['RESOLUTION_PROPOSED', 5],
          ['RESOLUTION_PROPOSED', 5],
        ]);

      await proofPool.query(
        'DELETE FROM public.admin_roles WHERE user_id = $1',
        [operatorBId],
      );
      await expectHx(
        proofPool.query(
          `SELECT current_state.opened_by_user_id,
                  public.assert_universal_v1_dispute_operator_v1($2)
             FROM public.universal_v1_dispute_current_v1 current_state
            WHERE current_state.dispute_id = $1`,
          [disputeId, operatorBId],
        ),
        'HXUDR7',
      );

      const latestTimeline = (await proofPool.query(
        `SELECT timeline_event_id FROM public.universal_v1_dispute_timeline_events
          WHERE dispute_id = $1 ORDER BY event_version DESC LIMIT 1`,
        [disputeId],
      )).rows[0];
      await expectHx(
        proofPool.query(
          `INSERT INTO public.universal_v1_dispute_timeline_events(
             dispute_id, event_version, expected_version, supersedes_event_id,
             event_kind, from_state, to_state, actor_user_id, actor_role,
             evidence_sha256, idempotency_key, request_sha256
           ) VALUES (
             $1, 6, 5, $2, 'RESOLVED', 'RESOLUTION_PROPOSED', 'RESOLVED',
             $3, 'NAMED_OPERATOR', $4, $5, $6
           )`,
          [
            disputeId,
            latestTimeline.timeline_event_id,
            operatorBId,
            '1'.repeat(64),
            'dispute-terminal-pg-denied-0001',
            '2'.repeat(64),
          ],
        ),
        'HXUDR8',
      );

      await expectHx(proofPool.query(
        `INSERT INTO public.task_completion_facts(
           id, work_order_id, task_id, completion_version, fact_kind
         ) VALUES ($1, $2, $3, 2, 'APPROVED')`,
        [randomUUID(), workOrderId, taskId],
      ), 'HXUDR9');
      await expectHx(proofPool.query(
        `INSERT INTO public.task_work_order_execution_facts(
           id, work_order_id, task_id, completion_fact_id,
           execution_version, state, transition_kind
         ) VALUES ($1, $2, $3, $4, 8, 'COMPLETED', 'COMPLETION_APPROVED')`,
        [randomUUID(), workOrderId, taskId, completionId],
      ), 'HXUDR9');
      await expectHx(proofPool.query(
        `INSERT INTO public.task_reconciliation_facts(
           id, work_order_id, reconciliation_state
         ) VALUES ($1, $2, 'CLOSED')`,
        [randomUUID(), workOrderId],
      ), 'HXUDR9');
      await expectHx(proofPool.query(
        `INSERT INTO public.universal_v1_prepared_financial_commands(
           id, work_order_id, operation_kind
         ) VALUES ($1, $2, 'PROVIDER_RELEASE')`,
        [randomUUID(), workOrderId],
      ), 'HXUDR9');
      await expectHx(proofPool.query(
        `INSERT INTO public.financial_provider_command_journal(
           id, work_order_id, operation_kind
         ) VALUES ($1, $2, 'PAYOUT')`,
        [randomUUID(), workOrderId],
      ), 'HXUDR9');
      await expectHx(proofPool.query(
        `INSERT INTO public.task_financial_security_events(
           id, task_id, event_kind
         ) VALUES ($1, $2, 'PAYOUT_OBSERVED')`,
        [randomUUID(), taskId],
      ), 'HXUDR9');

      await proofPool.query(`
        CREATE FUNCTION public.hxos_reject_fake_financial_mutation_v1()
        RETURNS TRIGGER LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'HXOS-FAKE-IMMUTABLE: fixture mutation denied'
            USING ERRCODE = 'P0001';
        END;
        $$;
        CREATE TABLE public.hxos_fake_financial_schema_evidence_v7 (
          migration_name TEXT PRIMARY KEY,
          migration_sql_sha256 CHAR(64) NOT NULL
        );
        INSERT INTO public.hxos_fake_financial_schema_evidence_v7
          VALUES ('20260927_universal_v1_change_order_recovery_v1', repeat('7', 64));
        CREATE TABLE public.universal_v1_fake_terminal_lifecycle_intents (
          terminal_intent_id UUID PRIMARY KEY,
          terminal_path TEXT NOT NULL,
          work_order_id UUID NOT NULL
        );
      `);
      await proofPool.query(fakeFixture);
      await proofPool.query(
        `INSERT INTO public.hxos_fake_financial_schema_evidence_v8(
           migration_name, migration_sql_sha256
         ) VALUES (
           '20261002_universal_v1_dispute_fake_release_gate_v8', repeat('8', 64)
         )`,
      );
      await expectHx(proofPool.query(
        `INSERT INTO public.universal_v1_fake_terminal_lifecycle_intents(
           terminal_intent_id, terminal_path, work_order_id
         ) VALUES ($1, 'SETTLED', $2)`,
        [randomUUID(), workOrderId],
      ), 'HXUDR9');
      expect((await proofPool.query(
        `SELECT count(*)::INTEGER AS count
           FROM public.universal_v1_fake_terminal_lifecycle_intents`,
      )).rows[0]?.count).toBe(0);

      await expectHx(proofPool.query(
        `UPDATE public.universal_v1_dispute_incidents
            SET incident_kind = 'SCOPE' WHERE dispute_id = $1`,
        [disputeId],
      ), 'HX-FACT-IMMUTABLE');
      const counts = await proofPool.query(`
        SELECT
          (SELECT count(*)::INTEGER FROM public.universal_v1_dispute_incidents) AS incidents,
          (SELECT count(*)::INTEGER FROM public.universal_v1_dispute_evidence_facts) AS evidence,
          (SELECT count(*)::INTEGER FROM public.universal_v1_dispute_recovery_intents) AS recoveries,
          (SELECT count(*)::INTEGER FROM public.universal_v1_dispute_recovery_approval_facts) AS approvals,
          (SELECT count(*)::INTEGER FROM public.task_completion_facts) AS completions,
          (SELECT count(*)::INTEGER FROM public.task_work_order_execution_facts) AS executions,
          (SELECT count(*)::INTEGER FROM public.task_reconciliation_facts) AS reconciliations,
          (SELECT count(*)::INTEGER FROM public.universal_v1_prepared_financial_commands) AS prepared,
          (SELECT count(*)::INTEGER FROM public.financial_provider_command_journal) AS journal,
          (SELECT count(*)::INTEGER FROM public.task_financial_security_events) AS financial_events
      `);
      expect(counts.rows[0]).toEqual({
        incidents: 1,
        evidence: 1,
        recoveries: 1,
        approvals: 1,
        completions: 1,
        executions: 1,
        reconciliations: 0,
        prepared: 0,
        journal: 0,
        financial_events: 0,
      });
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
  }, 60_000);
});
