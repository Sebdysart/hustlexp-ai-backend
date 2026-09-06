import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import pg from 'pg';
import { describe, expect, it } from 'vitest';

import {
  applyEngineAutomationMigration,
  productionMigrationRuntime,
  runEngineAutomationMigration,
} from '../../src/jobs/engine-automation-migration.js';
import {
  assertMigrationExecutionAuthorized,
  authorizeMigrationExecutionPlan,
} from '../../src/jobs/migration-execution-authority.js';

const enabled = process.env.HX_ALLOW_TASK_DRAFT_INGRESS_PG === '1';
const describePg = enabled ? describe : describe.skip;
const databaseUrl = process.env.LOCAL_TEST_DB_URL ?? '';
const containmentName = '20261006_stage1_legacy_authority_containment_v1';
const containmentPath =
  'backend/database/migrations/20261006_stage1_legacy_authority_containment_v1.sql';
const containmentSql = readFileSync(resolve(process.cwd(), containmentPath), 'utf8');
const contaminationSql = readFileSync(
  resolve(process.cwd(), 'backend/tests/fixtures/stage1-main-d42975b-contamination.sql'),
  'utf8'
);
const freshProofDatabaseName = 'hx_ci_fresh_test';
const upgradeProofDatabaseName = 'hx_ci_upgrade_test';

function localMigrationSession(client: object, exactDatabaseUrl: string) {
  const authority = assertMigrationExecutionAuthorized({
    env: {
      HX_ENVIRONMENT: 'local',
      NODE_ENV: 'test',
      HX_ALLOW_CI_DB_RECREATE: 'true',
    },
    migrationArtifactDigest: `sha256:${'a'.repeat(64)}`,
    databaseUrl: exactDatabaseUrl,
  });
  return authorizeMigrationExecutionPlan(authority, {
    databaseUrl: exactDatabaseUrl,
    client,
    migrations: [{
      name: containmentName,
      sql: containmentSql,
      sourcePath: resolve(process.cwd(), containmentPath),
    }],
  });
}

const retiredReceipts = [
  ['20260819_ops_web_hardening', '66ffbbe8ff05748c684fef2df4b500e2371556bfdc4adfc0222b38bebe7bdaa1'],
  ['20260821_ops_business_claim_links', '348ab3f932acdee6fac0f0e7d9fc59d5296614701afc60f379837762f9cf4f79'],
  ['20260821_business_ownership', 'e3b917a40f3ac674edc12d1e1faae44ed09002f07340b810310395bf3c1147d5'],
  ['20260821_business_claim_links_extra', 'a6484cb33c080ef89becb53cc9fb8b193edc51513f32d1f1b6910048c6dc3bb5'],
  ['20260823_business_fulfiller_lifecycle', '7243c0fa649eea1d7812d5e706b1d9e00c1ecea41536e614fb5848f3afd306dc'],
  ['20260823_business_payout_tables', '6896c70249c363d955fdb3674aac56e0e484262484470f6b9de3316c92f04d1b'],
  ['20260824_enforce_controlled_test_business_acceptance', '13bd0ec9d390e2be46fe6f719134a91aa3b5780473b7d68458b2293d9ba72e69'],
  ['20260824_business_controlled_test_acceptance', '05f363a4581b6488aabd7267bfa1091d884b3e2cd4fb192dcff137a646c33729'],
  ['20260824_orchestration_mode', 'a803c82c5d9f66ccfb70712ef9b9064a5d50d7a710bb65fe7561219ababe6f2c'],
  ['20260825_ops_manual_liquidity_bypass', '67e42ae9994ac53d0e1e52ec0ff1e313981b6c1e9338f3098b1048324c6135d5'],
  ['20260825_ops_manual_worker_offer_bypass', '0956440159821c2f9cb6cbd135b6609ff023f4a0329b585321006e0cd24cc731'],
  ['20260826_business_local_test_payout_evidence', '03664c220081a1870a98f32ff724f9612fba21be498d62224017e486da3251a6'],
] as const;

const proofIds = {
  poster: 'e1000000-0000-4000-8000-000000000001',
  worker: 'e1000000-0000-4000-8000-000000000002',
  retiredOrganization: 'e1000000-0000-4000-8000-000000000003',
  contaminatedTask: 'e2000000-0000-4000-8000-000000000001',
  nullClassificationTask: 'e2000000-0000-4000-8000-000000000002',
  payoutEscrow: 'e3000000-0000-4000-8000-000000000001',
  contaminatedQuote: 'e4000000-0000-4000-8000-000000000001',
  payoutDestination: `pd_hxos_test_${'1'.repeat(32)}`,
  payoutTransfer: `tr_hxos_test_${'2'.repeat(32)}`,
} as const;

const expectedContainmentTriggers = [
  ['feature_flags', 'stage1_feature_flag_key_writer_containment'],
  ['ops_action_audit', 'stage1_retired_relation_row_containment'],
  ['ops_action_audit', 'stage1_retired_relation_truncate_containment'],
  ['ops_business_claim_links', 'stage1_retired_relation_row_containment'],
  ['ops_business_claim_links', 'stage1_retired_relation_truncate_containment'],
  [
    'hxos_local_test_business_payout_destinations',
    'stage1_retired_relation_row_containment',
  ],
  [
    'hxos_local_test_business_payout_destinations',
    'stage1_retired_relation_truncate_containment',
  ],
  [
    'hxos_local_test_business_payout_transfers',
    'stage1_retired_relation_row_containment',
  ],
  [
    'hxos_local_test_business_payout_transfers',
    'stage1_retired_relation_truncate_containment',
  ],
  ['quotes', 'stage1_quote_authority_containment'],
  ['quotes', 'stage1_quote_authority_delete_containment'],
  ['quotes', 'stage1_quote_evidence_truncate_containment'],
  ['tasks', 'stage1_task_authority_containment'],
  ['tasks', 'stage1_task_evidence_truncate_containment'],
  ['escrows', 'escrow_payout_provider_evidence_gate'],
] as const;

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
      'Stage-1 containment proof may run only from the exact disposable system database identity'
    );
  }
  return parsed;
}

function exactIdentifier(value: string): string {
  if (value !== freshProofDatabaseName && value !== upgradeProofDatabaseName) {
    throw new Error('Refusing an unrecognized disposable Stage-1 containment database identifier');
  }
  return `"${value}"`;
}

async function containmentSnapshot(pool: pg.Pool): Promise<unknown> {
  const result = await pool.query<{ snapshot: unknown }>(
    `SELECT jsonb_build_object(
       'triggers', (
         SELECT coalesce(
           jsonb_agg(
             jsonb_build_object(
               'relation', relation.relname,
               'name', trigger.tgname,
               'enabled', trigger.tgenabled,
               'function_oid', trigger.tgfoid::text,
               'function_name', trigger.tgfoid::regprocedure::text,
               'definition', pg_get_triggerdef(trigger.oid)
             ) ORDER BY relation.relname, trigger.tgname
           ),
           '[]'::jsonb
         )
         FROM pg_trigger trigger
         JOIN pg_class relation ON relation.oid=trigger.tgrelid
         JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
         WHERE namespace.nspname='public'
           AND trigger.tgname = ANY($1::text[])
       ),
       'constraints', (
         SELECT coalesce(
           jsonb_agg(
             jsonb_build_object(
               'name', constraint_row.conname,
               'validated', constraint_row.convalidated,
               'definition', pg_get_constraintdef(constraint_row.oid)
             ) ORDER BY constraint_row.conname
           ),
           '[]'::jsonb
         )
         FROM pg_constraint constraint_row
         WHERE constraint_row.conrelid='public.tasks'::regclass
           AND constraint_row.conname = ANY($2::text[])
       ),
       'functions', (
         SELECT coalesce(
           jsonb_agg(
             jsonb_build_object(
               'name', procedure.proname,
               'definition', pg_get_functiondef(procedure.oid)
             ) ORDER BY procedure.proname
           ),
           '[]'::jsonb
         )
         FROM pg_proc procedure
         JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
         WHERE namespace.nspname='public'
           AND procedure.proname = ANY($3::text[])
       ),
       'retired_relation_counts', (
         SELECT jsonb_object_agg(relation_name, row_count ORDER BY relation_name)
         FROM (
           SELECT 'ops_action_audit' AS relation_name,
                  count(*)::integer AS row_count FROM public.ops_action_audit
           UNION ALL
           SELECT 'ops_business_claim_links', count(*)::integer
             FROM public.ops_business_claim_links
           UNION ALL
           SELECT 'hxos_local_test_business_payout_destinations', count(*)::integer
             FROM public.hxos_local_test_business_payout_destinations
           UNION ALL
           SELECT 'hxos_local_test_business_payout_transfers', count(*)::integer
             FROM public.hxos_local_test_business_payout_transfers
         ) counts
       ),
       'incident_evidence', (
         SELECT jsonb_agg(
           jsonb_build_object('id', id, 'meta', meta) ORDER BY id
         )
         FROM public.ops_action_audit
         WHERE id='00000000-0000-4000-8000-000000000140'
       ),
       'retired_receipts', (
         SELECT jsonb_agg(
           jsonb_build_object(
             'name', name,
             'sha256', btrim(sha256),
             'applied_at', applied_at
           ) ORDER BY name
         )
         FROM public.applied_migrations
         WHERE name = ANY($4::text[])
       ),
       'task_evidence', (
         SELECT to_jsonb(task_evidence)
         FROM (
           SELECT id, business_fulfiller_organization_id, orchestration_mode
           FROM public.tasks WHERE id=$5::uuid
         ) task_evidence
       ),
       'quote_evidence', (
         SELECT to_jsonb(quote_evidence)
         FROM (
           SELECT id, business_organization_id, business_location_id,
                  provider_service_profile_id, claimed_by_user_id
           FROM public.quotes WHERE id=$6::uuid
         ) quote_evidence
       ),
       'feature_evidence', (
         SELECT to_jsonb(feature_evidence)
         FROM (
           SELECT name, key FROM public.feature_flags ORDER BY name LIMIT 1
         ) feature_evidence
       ),
       'payout_evidence', (
         SELECT to_jsonb(payout_evidence)
         FROM (
           SELECT id, task_id, escrow_id, worker_id, status, paid_at, is_test
           FROM public.hxos_local_test_payout_transfers
           WHERE id=$7
         ) payout_evidence
       )
     ) AS snapshot`,
    [
      [...new Set(expectedContainmentTriggers.map(([, name]) => name))],
      [
        'tasks_orchestration_mode_contained_check',
        'tasks_business_fulfiller_contained_check',
      ],
      [
        'prevent_stage1_feature_flag_key_writer_v1',
        'prevent_stage1_retired_relation_write_v1',
        'prevent_stage1_quote_authority_write_v1',
        'prevent_stage1_task_authority_write_v1',
        'prevent_stage1_core_evidence_truncate_v1',
      ],
      retiredReceipts.map(([name]) => name),
      proofIds.contaminatedTask,
      proofIds.contaminatedQuote,
      proofIds.payoutTransfer,
    ]
  );
  return result.rows[0]?.snapshot;
}

async function withDisposableProofDatabase(
  proofDatabaseName: typeof freshProofDatabaseName | typeof upgradeProofDatabaseName,
  run: (pool: pg.Pool, databaseUrl: URL) => Promise<void>
): Promise<void> {
  const sourceUrl = assertDisposableDatabase(databaseUrl);
  const quotedProofDatabase = exactIdentifier(proofDatabaseName);
  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = '/postgres';
  const proofUrl = new URL(sourceUrl);
  proofUrl.pathname = `/${proofDatabaseName}`;
  const adminPool = new pg.Pool({ connectionString: adminUrl.toString(), max: 1 });
  let proofPool: pg.Pool | null = null;
  let databaseCreated = false;

  try {
    await adminPool.query(`DROP DATABASE IF EXISTS ${quotedProofDatabase} WITH (FORCE)`);
    await adminPool.query(`CREATE DATABASE ${quotedProofDatabase}`);
    databaseCreated = true;
    proofPool = new pg.Pool({ connectionString: proofUrl.toString(), max: 2 });
    await run(proofPool, proofUrl);
  } finally {
    if (proofPool) await proofPool.end().catch(() => undefined);
    if (databaseCreated) {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname=$1 AND pid<>pg_backend_pid()`,
        [proofDatabaseName]
      ).catch(() => undefined);
      await adminPool.query(`DROP DATABASE ${quotedProofDatabase}`).catch(() => undefined);
    }
    await adminPool.end().catch(() => undefined);
  }
}

async function legacySyncSentinelSnapshot(pool: pg.Pool): Promise<unknown> {
  const result = await pool.query<{ snapshot: unknown }>(
    `SELECT jsonb_build_object(
       'function_oid', procedure.oid::text,
       'function_definition', pg_get_functiondef(procedure.oid),
       'trigger_oid', trigger.oid::text,
       'trigger_definition', pg_get_triggerdef(trigger.oid),
       'trigger_enabled', trigger.tgenabled
     ) AS snapshot
     FROM pg_proc procedure
     JOIN pg_namespace procedure_namespace
       ON procedure_namespace.oid=procedure.pronamespace
     JOIN pg_trigger trigger
       ON trigger.tgfoid=procedure.oid AND NOT trigger.tgisinternal
     JOIN pg_class relation ON relation.oid=trigger.tgrelid
     JOIN pg_namespace relation_namespace
       ON relation_namespace.oid=relation.relnamespace
     WHERE procedure_namespace.nspname='public'
       AND procedure.proname='sync_feature_flags_key_from_name'
       AND relation_namespace.nspname='public'
       AND relation.relname='feature_flags'
       AND trigger.tgname='trg_feature_flags_sync_key'`
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0]?.snapshot;
}

async function assertPartialSchemaContainmentRollback(options: {
  alterSql: string;
  expectedCode: 'HXUV1S140-5' | 'HXUV1S140-6';
  expectedColumnCountSql: string;
}): Promise<void> {
  await withDisposableProofDatabase(freshProofDatabaseName, async (proofPool, proofUrl) => {
    const runtime = productionMigrationRuntime();
    const containmentMigrationIndex = runtime.migrationSpecs.findIndex(
      ({ name }) => name === containmentName
    );
    expect(containmentMigrationIndex).toBeGreaterThan(0);
    const preContainmentSpecs = runtime.migrationSpecs.slice(0, containmentMigrationIndex);
    const canonical = await runEngineAutomationMigration({
      ...runtime,
      databaseUrl: proofUrl.toString(),
      migrationSpecs: preContainmentSpecs,
    });
    expect(canonical).toHaveLength(preContainmentSpecs.length);
    expect(canonical.every(({ status }) => status === 'applied')).toBe(true);

    await proofPool.query(`
      CREATE OR REPLACE FUNCTION public.sync_feature_flags_key_from_name()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $sentinel$
      BEGIN
        RETURN NEW;
      END;
      $sentinel$;
      DROP TRIGGER IF EXISTS trg_feature_flags_sync_key ON public.feature_flags;
      CREATE TRIGGER trg_feature_flags_sync_key
      BEFORE INSERT ON public.feature_flags
      FOR EACH ROW EXECUTE FUNCTION public.sync_feature_flags_key_from_name();
    `);
    await proofPool.query(options.alterSql);
    const beforeFailure = await legacySyncSentinelSnapshot(proofPool);

    const migrationError = await (async (): Promise<unknown> => {
      const migrationConnection = await proofPool.connect();
      try {
        await applyEngineAutomationMigration(
          migrationConnection as never,
          containmentSql,
          resolve(process.cwd(), containmentPath),
          localMigrationSession(migrationConnection, proofUrl.toString()),
          containmentName
        );
        return undefined;
      } catch (error) {
        return error;
      } finally {
        migrationConnection.release();
      }
    })();
    expect(migrationError).toMatchObject({ code: 'P0001' });
    expect(migrationError).toBeInstanceOf(Error);
    expect((migrationError as Error).message).toContain(options.expectedCode);

    const receipt = await proofPool.query<{ count: number }>(
      `SELECT count(*)::integer AS count
         FROM public.applied_migrations
        WHERE name=$1`,
      [containmentName]
    );
    expect(receipt.rows[0]?.count).toBe(0);
    expect(await legacySyncSentinelSnapshot(proofPool)).toEqual(beforeFailure);

    const rolledBackObjects = await proofPool.query<{
      functions: number;
      triggers: number;
      partial_columns: number;
    }>(
      `SELECT
         (
           SELECT count(*)::integer
             FROM pg_proc procedure
             JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
            WHERE namespace.nspname='public'
              AND procedure.proname = ANY($1::text[])
         ) AS functions,
         (
           SELECT count(*)::integer
             FROM pg_trigger trigger
            WHERE NOT trigger.tgisinternal
              AND trigger.tgname = ANY($2::text[])
         ) AS triggers,
         (${options.expectedColumnCountSql})::integer AS partial_columns`,
      [
        [
          'prevent_stage1_feature_flag_key_writer_v1',
          'prevent_stage1_retired_relation_write_v1',
          'prevent_stage1_quote_authority_write_v1',
          'prevent_stage1_task_authority_write_v1',
          'prevent_stage1_core_evidence_truncate_v1',
        ],
        [
          ...new Set(
            expectedContainmentTriggers
              .map(([, name]) => name)
              .filter((name) => name !== 'escrow_payout_provider_evidence_gate')
          ),
        ],
      ]
    );
    expect(rolledBackObjects.rows[0]).toEqual({
      functions: 0,
      triggers: 0,
      partial_columns: 1,
    });
  });
}

describePg('Stage-1 contaminated-main PostgreSQL upgrade containment', () => {
  it(
    'preserves legacy rows and receipts while making every retired writer and bypass inert',
    async () => {
      const sourceUrl = assertDisposableDatabase(databaseUrl);
      const proofDatabaseName = upgradeProofDatabaseName;
      const quotedProofDatabase = exactIdentifier(proofDatabaseName);
      const adminUrl = new URL(sourceUrl);
      adminUrl.pathname = '/postgres';
      const proofUrl = new URL(sourceUrl);
      proofUrl.pathname = `/${proofDatabaseName}`;
      const adminPool = new pg.Pool({ connectionString: adminUrl.toString(), max: 1 });
      let proofPool: pg.Pool | null = null;
      let databaseCreated = false;

      try {
        await adminPool.query(`DROP DATABASE IF EXISTS ${quotedProofDatabase} WITH (FORCE)`);
        await adminPool.query(`CREATE DATABASE ${quotedProofDatabase}`);
        databaseCreated = true;
        proofPool = new pg.Pool({ connectionString: proofUrl.toString(), max: 2 });

        const runtime = productionMigrationRuntime();
        const containmentMigrationIndex = runtime.migrationSpecs.findIndex(
          ({ name }) => name === containmentName
        );
        const commonMigrationIndex = runtime.migrationSpecs.findIndex(
          ({ name }) => name === '20260819_quote_payments'
        );
        expect(commonMigrationIndex).toBe(102);
        expect(containmentMigrationIndex).toBeGreaterThan(commonMigrationIndex);

        const commonChain = await runEngineAutomationMigration({
          ...runtime,
          databaseUrl: proofUrl.toString(),
          migrationSpecs: runtime.migrationSpecs.slice(0, commonMigrationIndex + 1),
        });
        expect(commonChain).toHaveLength(103);
        expect(commonChain.every(({ status }) => status === 'applied')).toBe(true);

        // Reconstruct the real public-main ordering: the twelve retired Stage-1
        // migrations landed immediately after the last common quote migration.
        await proofPool.query(contaminationSql);
        await proofPool.query(
          `INSERT INTO public.ops_action_audit(
             id, actor_label, action, target_type, target_id, meta
           ) VALUES (
             '00000000-0000-4000-8000-000000000140',
             'legacy-ops', 'MANUAL_STAGE1_ACTION', 'task', 'legacy-task',
             '{"preserve":"incident-evidence"}'::jsonb
           )`
        );
        for (const [name, sha256] of retiredReceipts) {
          await proofPool.query(
            `INSERT INTO public.applied_migrations(name, sha256)
             VALUES ($1, $2)`,
            [name, sha256]
          );
        }

        // Seed representative authority-bearing rows in the Stage-1 era so the
        // complete candidate suffix must converge over populated legacy state.
        // Replica mode mirrors how an owner could otherwise evade ordinary
        // triggers; constraints still receive structurally valid data.
        const seedClient = await proofPool.connect();
        try {
          await seedClient.query('BEGIN');
          await seedClient.query('SET LOCAL session_replication_role = replica');
          await seedClient.query(
            `INSERT INTO public.users(id, email, full_name, default_mode)
             VALUES
               ($1, 'stage1-poster@e2e.invalid', 'Stage1 Poster', 'poster'),
               ($2, 'stage1-worker@e2e.invalid', 'Stage1 Worker', 'worker')`,
            [proofIds.poster, proofIds.worker]
          );
          await seedClient.query(
            `INSERT INTO public.business_organizations(
               id, legal_name, display_name, provider_enabled, client_enabled,
               created_by, creation_idempotency_key
             ) VALUES (
               $1, 'Stage1 Evidence LLC', 'Stage1 Evidence', TRUE, FALSE,
               $2, 'stage1-evidence-organization'
             )`,
            [proofIds.retiredOrganization, proofIds.poster]
          );
          await seedClient.query(
            `INSERT INTO public.tasks(
               id, poster_id, title, description, price, state, progress_state,
               business_fulfiller_organization_id, orchestration_mode,
               automation_classification
             ) VALUES
               ($1, $2, 'Contaminated authority', 'Preserved Stage-1 task', 1000,
                'OPEN', 'POSTED', $3, 'OPS_MANUAL', 'CONTROLLED_TEST'),
               ($4, $2, 'Null classification', 'Payout null-branch probe', 1000,
                'OPEN', 'POSTED', NULL, 'AUTOMATED', 'CONTROLLED_TEST')`,
            [
              proofIds.contaminatedTask,
              proofIds.poster,
              proofIds.retiredOrganization,
              proofIds.nullClassificationTask,
            ]
          );
          await seedClient.query(
            `UPDATE public.tasks SET worker_id=$1 WHERE id=$2`,
            [proofIds.worker, proofIds.nullClassificationTask]
          );
          await seedClient.query(
            `INSERT INTO public.escrows(id, task_id, amount, state)
             VALUES ($1, $2, 1000, 'FUNDED')`,
            [proofIds.payoutEscrow, proofIds.nullClassificationTask]
          );
          await seedClient.query(
            `INSERT INTO public.hxos_local_test_payout_destinations(
               id, worker_id, destination_fingerprint
             ) VALUES ($1, $2, $3)`,
            [proofIds.payoutDestination, proofIds.worker, '3'.repeat(64)]
          );
          await seedClient.query(
            `INSERT INTO public.hxos_local_test_payout_transfers(
               id, task_id, escrow_id, worker_id, destination_id, amount_cents,
               status, idempotency_key, request_hash, processing_at, paid_at
             ) VALUES ($1, $2, $3, $4, $5, 1000, 'paid', $6, $7, NOW(), NOW())`,
            [
              proofIds.payoutTransfer,
              proofIds.nullClassificationTask,
              proofIds.payoutEscrow,
              proofIds.worker,
              proofIds.payoutDestination,
              'stage1-null-classification-transfer',
              '4'.repeat(64),
            ]
          );
          await seedClient.query(
            `INSERT INTO public.quotes(
               id, title, status, business_organization_id
             ) VALUES ($1, 'Contaminated quote', 'draft', $2)`,
            [proofIds.contaminatedQuote, proofIds.retiredOrganization]
          );
          await seedClient.query('COMMIT');
        } catch (error) {
          await seedClient.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          seedClient.release();
        }

        const preContainmentCandidateSpecs = runtime.migrationSpecs.slice(
          commonMigrationIndex + 1,
          containmentMigrationIndex
        );
        const postStage1CandidateChain = await runEngineAutomationMigration({
          ...runtime,
          databaseUrl: proofUrl.toString(),
          migrationSpecs: preContainmentCandidateSpecs,
        });
        expect(postStage1CandidateChain).toHaveLength(preContainmentCandidateSpecs.length);
        expect(
          postStage1CandidateChain.every(({ status }) => status === 'applied')
        ).toBe(true);

        // Exercise SQL three-valued logic against an adversarial legacy drift.
        // The canonical schema is NOT NULL, but a table owner can remove that
        // local invariant; the money gate must still deny rather than treat
        // NULL as a passing predicate.
        const nullDriftClient = await proofPool.connect();
        try {
          await nullDriftClient.query('BEGIN');
          await nullDriftClient.query('SET LOCAL session_replication_role = replica');
          await nullDriftClient.query(
            'ALTER TABLE public.tasks ALTER COLUMN automation_classification DROP NOT NULL'
          );
          await nullDriftClient.query(
            'UPDATE public.tasks SET automation_classification=NULL WHERE id=$1',
            [proofIds.nullClassificationTask]
          );
          await nullDriftClient.query('COMMIT');
        } catch (error) {
          await nullDriftClient.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          nullDriftClient.release();
        }

        const applied = await (async () => {
          const migrationConnection = await proofPool!.connect();
          try {
            return await applyEngineAutomationMigration(
              migrationConnection as never,
              containmentSql,
              resolve(process.cwd(), containmentPath),
              localMigrationSession(migrationConnection, proofUrl.toString()),
              containmentName
            );
          } finally {
            migrationConnection.release();
          }
        })();
        expect(applied.status).toBe('applied');

        const postContainmentSpecs = runtime.migrationSpecs.slice(containmentMigrationIndex + 1);
        const postContainmentChain = await runEngineAutomationMigration({
          ...runtime,
          databaseUrl: proofUrl.toString(),
          migrationSpecs: postContainmentSpecs,
        });
        expect(postContainmentChain).toHaveLength(postContainmentSpecs.length);
        expect(postContainmentChain.every(({ status }) => status === 'applied')).toBe(true);

        const receipts = await proofPool.query<{ name: string; sha256: string }>(
          `SELECT name, btrim(sha256) AS sha256
             FROM public.applied_migrations
            WHERE name = ANY($1::text[])
            ORDER BY name`,
          [retiredReceipts.map(([name]) => name)]
        );
        expect(receipts.rows).toEqual(
          retiredReceipts
            .map(([name, sha256]) => ({ name, sha256 }))
            .sort((left, right) => left.name.localeCompare(right.name))
        );
        await expect(
          proofPool.query(
            `SELECT meta FROM public.ops_action_audit
              WHERE id='00000000-0000-4000-8000-000000000140'`
          )
        ).resolves.toMatchObject({
          rows: [{ meta: { preserve: 'incident-evidence' } }],
        });

        for (const relation of [
          'ops_action_audit',
          'ops_business_claim_links',
          'hxos_local_test_business_payout_destinations',
          'hxos_local_test_business_payout_transfers',
        ]) {
          const posture = await proofPool.query<{
            row_guards: number;
            row_always_guards: number;
            truncate_guards: number;
            truncate_always_guards: number;
            public_writers: boolean;
          }>(
            `SELECT
               count(*) FILTER (
                 WHERE trigger.tgname='stage1_retired_relation_row_containment'
               )::integer AS row_guards,
               count(*) FILTER (
                 WHERE trigger.tgname='stage1_retired_relation_row_containment'
                   AND trigger.tgenabled='A'
               )::integer AS row_always_guards,
               count(*) FILTER (
                 WHERE trigger.tgname='stage1_retired_relation_truncate_containment'
               )::integer AS truncate_guards,
               count(*) FILTER (
                 WHERE trigger.tgname='stage1_retired_relation_truncate_containment'
                   AND trigger.tgenabled='A'
               )::integer AS truncate_always_guards,
               has_table_privilege('public', relation.oid, 'INSERT,UPDATE,DELETE,TRUNCATE')
                 AS public_writers
             FROM pg_class relation
             JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
             LEFT JOIN pg_trigger trigger
               ON trigger.tgrelid=relation.oid AND NOT trigger.tgisinternal
            WHERE namespace.nspname='public' AND relation.relname=$1
            GROUP BY relation.oid`,
            [relation]
          );
          expect(posture.rows[0], relation).toEqual({
            row_guards: 1,
            row_always_guards: 1,
            truncate_guards: 1,
            truncate_always_guards: 1,
            public_writers: false,
          });
        }

        const containmentTriggers = await proofPool.query<{
          relation: string;
          name: string;
          enabled: string;
          function_oid: string;
          function_name: string;
        }>(
          `SELECT relation.relname AS relation,
                  trigger.tgname AS name,
                  trigger.tgenabled AS enabled,
                  trigger.tgfoid::text AS function_oid,
                  trigger.tgfoid::regprocedure::text AS function_name
             FROM pg_trigger trigger
             JOIN pg_class relation ON relation.oid=trigger.tgrelid
             JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
            WHERE namespace.nspname='public'
              AND trigger.tgname = ANY($1::text[])
            ORDER BY relation.relname, trigger.tgname`,
          [[...new Set(expectedContainmentTriggers.map(([, name]) => name))]]
        );
        const expectedTriggerKeys = [...expectedContainmentTriggers]
          .map(([relation, name]) => `${relation}:${name}`)
          .sort();
        expect(
          containmentTriggers.rows
            .map(({ relation, name }) => `${relation}:${name}`)
            .sort()
        ).toEqual(expectedTriggerKeys);
        for (const trigger of containmentTriggers.rows) {
          expect(trigger.enabled, `${trigger.relation}:${trigger.name}`).toBe('A');
          expect(trigger.function_oid, `${trigger.relation}:${trigger.name}`).toMatch(
            /^\d+$/u
          );
          expect(trigger.function_name, `${trigger.relation}:${trigger.name}`).toMatch(
            /^(?:public\.)?(?:prevent_stage1_|enforce_escrow_)/u
          );
        }
        await expect(
          proofPool.query(
            `INSERT INTO public.ops_action_audit(action,target_type)
             VALUES ('forbidden','task')`
          )
        ).rejects.toThrow('retired Stage-1 relation is immutable evidence');
        await expect(
          proofPool.query('TRUNCATE TABLE public.quotes CASCADE')
        ).rejects.toThrow('HXUV1S140-7');
        await expect(
          proofPool.query('TRUNCATE TABLE public.tasks CASCADE')
        ).rejects.toThrow('HXUV1S140-7');

        const restoredTaskTriggers = await proofPool.query<{ definition: string }>(
          `SELECT pg_get_triggerdef(trigger.oid) AS definition
             FROM pg_trigger trigger
             JOIN pg_class relation ON relation.oid=trigger.tgrelid
             JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
            WHERE namespace.nspname='public'
              AND relation.relname='tasks'
              AND trigger.tgname = ANY($1::text[])
            ORDER BY trigger.tgname`,
          [[
            'task_region_policy_accept_insert_gate',
            'task_region_policy_accept_gate',
            'task_worker_eligibility_accept_insert_gate',
            'task_worker_eligibility_accept_gate',
            'controlled_test_provider_capability_accept_guard',
            'controlled_test_offer_accept_guard',
            'task_liquidity_cell_accept_gate',
            'task_worker_offer_accept_gate',
          ]]
        );
        expect(restoredTaskTriggers.rows).toHaveLength(8);
        for (const { definition } of restoredTaskTriggers.rows) {
          expect(definition).not.toContain('OPS_MANUAL');
          expect(definition).not.toContain('business_fulfiller_organization_id');
          expect(definition).not.toContain('orchestration_mode');
        }
        const businessAcceptance = await proofPool.query<{ trigger_exists: boolean; function_exists: boolean }>(
          `SELECT
             EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='controlled_test_business_acceptance_guard')
               AS trigger_exists,
             to_regprocedure('public.enforce_controlled_test_business_acceptance()') IS NOT NULL
               AS function_exists`
        );
        expect(businessAcceptance.rows[0]).toEqual({
          trigger_exists: false,
          function_exists: false,
        });

        const payoutFunction = await proofPool.query<{ definition: string }>(
          `SELECT pg_get_functiondef(
             'public.enforce_escrow_payout_provider_evidence()'::regprocedure
           ) AS definition`
        );
        expect(payoutFunction.rows[0]?.definition).toContain('hxos_local_test_payout_transfers');
        expect(payoutFunction.rows[0]?.definition).not.toContain(
          'hxos_local_test_business_payout'
        );

        await expect(
          proofPool.query(
            `UPDATE public.tasks
                SET business_fulfiller_organization_id=NULL,
                    orchestration_mode='AUTOMATED',
                    title='laundered authority'
              WHERE id=$1`,
            [proofIds.contaminatedTask]
          )
        ).rejects.toThrow('contaminated Stage-1 task is immutable evidence');
        await expect(
          proofPool.query(
            `DELETE FROM public.quotes WHERE id=$1`,
            [proofIds.contaminatedQuote]
          )
        ).rejects.toThrow('contaminated Stage-1 quote is immutable evidence');

        // Each null branch is otherwise fully populated, proving NULL cannot
        // turn a payout predicate into SQL UNKNOWN and silently pass the gate.
        await expect(
          proofPool.query(
            `UPDATE public.escrows
                SET state='RELEASED',
                    payout_provider='LOCAL_CERTIFICATION_TEST',
                    stripe_transfer_id=NULL,
                    provider_transfer_id=$1,
                    provider_transfer_status='paid',
                    provider_transfer_paid_at=NOW()
              WHERE id=$2`,
            [proofIds.payoutTransfer, proofIds.payoutEscrow]
          )
        ).rejects.toThrow('HXLPO8: local TEST escrow release lacks exact paid provider evidence');
        await expect(
          proofPool.query(
            `UPDATE public.escrows
                SET state='RELEASED',
                    payout_provider='STRIPE',
                    stripe_transfer_id='tr_stage1_stripe_null_status',
                    provider_transfer_id='tr_stage1_stripe_null_status',
                    provider_transfer_status=NULL,
                    provider_transfer_paid_at=NULL
              WHERE id=$1`,
            [proofIds.payoutEscrow]
          )
        ).rejects.toThrow('HXLPO9: Stripe escrow release lacks provider transfer identity');
        await expect(
          proofPool.query(
            `UPDATE public.escrows
                SET state='RELEASED',
                    payout_provider='MANUAL_RECONCILIATION',
                    stripe_transfer_id=NULL,
                    provider_transfer_id='manual_stage1_null_status',
                    provider_transfer_status=NULL,
                    provider_transfer_paid_at=NULL
              WHERE id=$1`,
            [proofIds.payoutEscrow]
          )
        ).rejects.toThrow('HXLPO10: manual release must remain visibly unreconciled');

        const expectReplicaAttemptBlocked = async (
          sql: string,
          values: unknown[] | undefined,
          message: string
        ): Promise<void> => {
          const replicaClient = await proofPool!.connect();
          try {
            await replicaClient.query('BEGIN');
            await replicaClient.query('SET LOCAL session_replication_role = replica');
            await expect(replicaClient.query(sql, values)).rejects.toThrow(message);
          } finally {
            await replicaClient.query('ROLLBACK').catch(() => undefined);
            replicaClient.release();
          }
        };

        await expectReplicaAttemptBlocked(
          `UPDATE public.tasks
              SET business_fulfiller_organization_id=NULL,
                  orchestration_mode='AUTOMATED'
            WHERE id=$1`,
          [proofIds.contaminatedTask],
          'contaminated Stage-1 task is immutable evidence'
        );
        await expectReplicaAttemptBlocked(
          'DELETE FROM public.quotes WHERE id=$1',
          [proofIds.contaminatedQuote],
          'contaminated Stage-1 quote is immutable evidence'
        );
        await expectReplicaAttemptBlocked(
          `UPDATE public.feature_flags
              SET key=key || '-replica-bypass'
            WHERE name=(SELECT name FROM public.feature_flags ORDER BY name LIMIT 1)`,
          undefined,
          'retired feature_flags.key writer is contained'
        );
        await expectReplicaAttemptBlocked(
          `INSERT INTO public.ops_action_audit(action, target_type)
           VALUES ('replica-bypass', 'task')`,
          undefined,
          'retired Stage-1 relation is immutable evidence'
        );
        await expectReplicaAttemptBlocked(
          'TRUNCATE TABLE public.ops_action_audit',
          undefined,
          'retired Stage-1 relation is immutable evidence'
        );
        await expectReplicaAttemptBlocked(
          'TRUNCATE TABLE public.quotes CASCADE',
          undefined,
          'HXUV1S140-7'
        );
        await expectReplicaAttemptBlocked(
          'TRUNCATE TABLE public.tasks CASCADE',
          undefined,
          'HXUV1S140-7'
        );
        await expectReplicaAttemptBlocked(
          `UPDATE public.escrows
              SET state='RELEASED',
                  payout_provider='STRIPE',
                  stripe_transfer_id='tr_stage1_replica_null_status',
                  provider_transfer_id='tr_stage1_replica_null_status',
                  provider_transfer_status=NULL
            WHERE id=$1`,
          [proofIds.payoutEscrow],
          'HXLPO9: Stripe escrow release lacks provider transfer identity'
        );

        const beforeRawReplay = await containmentSnapshot(proofPool);
        const rawReplayConnection = await proofPool.connect();
        try {
          await rawReplayConnection.query(containmentSql);
        } finally {
          rawReplayConnection.release();
        }
        const afterRawReplay = await containmentSnapshot(proofPool);
        expect(afterRawReplay).toEqual(beforeRawReplay);

        const replay = await (async () => {
          const replayConnection = await proofPool!.connect();
          try {
            return await applyEngineAutomationMigration(
              replayConnection as never,
              containmentSql,
              resolve(process.cwd(), containmentPath),
              localMigrationSession(replayConnection, proofUrl.toString()),
              containmentName
            );
          } finally {
            replayConnection.release();
          }
        })();
        expect(replay.status).toBe('already_applied');
        const preservedAfterReplay = await proofPool.query<{ count: number }>(
          `SELECT count(*)::integer AS count FROM public.applied_migrations
            WHERE name = ANY($1::text[])`,
          [retiredReceipts.map(([name]) => name)]
        );
        expect(preservedAfterReplay.rows[0]?.count).toBe(12);
      } finally {
        if (proofPool) await proofPool.end().catch(() => undefined);
        if (databaseCreated) {
          await adminPool.query(
            `SELECT pg_terminate_backend(pid)
               FROM pg_stat_activity
              WHERE datname=$1 AND pid<>pg_backend_pid()`,
            [proofDatabaseName]
          ).catch(() => undefined);
          await adminPool.query(`DROP DATABASE ${quotedProofDatabase}`).catch(() => undefined);
        }
        await adminPool.end().catch(() => undefined);
      }
    },
    300_000
  );

  it(
    'rejects a one-column retired quote authority schema atomically',
    async () => {
      await assertPartialSchemaContainmentRollback({
        alterSql:
          'ALTER TABLE public.quotes ADD COLUMN business_organization_id UUID',
        expectedCode: 'HXUV1S140-6',
        expectedColumnCountSql: `
          SELECT count(*)
            FROM information_schema.columns
           WHERE table_schema='public'
             AND table_name='quotes'
             AND column_name IN (
               'business_organization_id',
               'business_location_id',
               'provider_service_profile_id',
               'claimed_by_user_id'
             )
        `,
      });
    },
    300_000
  );

  it(
    'rejects a one-column retired task authority schema atomically',
    async () => {
      await assertPartialSchemaContainmentRollback({
        alterSql:
          'ALTER TABLE public.tasks ADD COLUMN business_fulfiller_organization_id UUID',
        expectedCode: 'HXUV1S140-5',
        expectedColumnCountSql: `
          SELECT count(*)
            FROM information_schema.columns
           WHERE table_schema='public'
             AND table_name='tasks'
             AND column_name IN (
               'business_fulfiller_organization_id',
               'orchestration_mode'
             )
        `,
      });
    },
    300_000
  );
});
