import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import {
  applyEngineAutomationMigration,
  authorizeEngineAutomationMigrationPlanOnConnectedClient,
  backfillLegacyTaskLocations,
  ensureConstitutionalBaseline,
  loadMigrationSql,
  productionMigrationRuntime,
} from '../dist/backend/src/jobs/engine-automation-migration.js';
import { REQUIRED_MIGRATION_FILES } from '../dist/backend/src/jobs/engine-automation-migration-files.js';
import { engineMigrationArtifactDigest } from '../dist/backend/src/jobs/engine-migration-manifest.js';
import {
  assertMigrationExecutionAuthorized,
  completeMigrationExecutionSession,
} from '../dist/backend/src/jobs/migration-execution-authority.js';
import { assertTaskLocationCryptoConfigured } from '../dist/backend/src/services/TaskLocationCrypto.js';
import { validatePreparationPolicy } from './prepare-test-databases.mjs';

const { Client } = pg;

export const MIGRATION_VERIFICATION_DATABASES = Object.freeze({
  fresh: 'hx_ci_fresh_test',
  upgrade: 'hx_ci_upgrade_test',
});
const MIGRATION_VERIFICATION_DATABASE_SET = new Set(
  Object.values(MIGRATION_VERIFICATION_DATABASES)
);
const MIGRATION_VERIFICATION_DATABASE_ROLE = 'hx_ci_runner';
const MIGRATION_VERIFICATION_DATABASE_PORT = '5432';
const MIGRATION_VERIFICATION_DATABASE_HOSTS = new Set(['127.0.0.1', '[::1]']);

const TASK_DRAFT_CLAIM_UPGRADE_IDS = Object.freeze({
  canonicalUnclaimed: 'f3000000-0000-4000-8000-000000000001',
  sameOwnerUnclassified: 'f3000000-0000-4000-8000-000000000003',
  otherOwnerUnclassified: 'f3000000-0000-4000-8000-000000000005',
  legacyUnclaimed: 'f3000000-0000-4000-8000-000000000007',
  sourceProfile: 'f6000000-0000-4000-8000-000000000001',
});
const TASK_DRAFT_CLAIM_UPGRADE_DRAFT_IDS = Object.freeze([
  TASK_DRAFT_CLAIM_UPGRADE_IDS.canonicalUnclaimed,
  TASK_DRAFT_CLAIM_UPGRADE_IDS.sameOwnerUnclassified,
  TASK_DRAFT_CLAIM_UPGRADE_IDS.otherOwnerUnclassified,
  TASK_DRAFT_CLAIM_UPGRADE_IDS.legacyUnclaimed,
]);
const TASK_DRAFT_CLAIM_REPAIR_GAP_ID = 'f3000000-0000-4000-8000-000000000009';
const LEGACY_ESCROW_CONTAINMENT_MIGRATION = '20260923_legacy_escrow_insert_containment_v1';
const COMPLETION_NOTICE_MIGRATION = '20261004_universal_v1_completion_notice_dispatch_v1';
const OCCURRENCE_ACCESS_AUDIT_MIGRATION = '20261005_universal_v1_occurrence_access_audit_v1';
const PARTIAL_COMPLETION_RECEIPT_ID = 'b9000000-0000-4000-8000-000000000001';
const PARTIAL_COMPLETION_RECEIPT_UPGRADE_ERROR =
  'HXUV1-NOTICE-UPGRADE-1: partial legacy completion delivery audit rows require separate reviewed repair before migration 138';
const LEGACY_ESCROW_CONTAINMENT_MESSAGE =
  'HXUV1-ESCROW-1: new legacy escrow creation is retired; only recovery transitions on pre-existing rows remain available';
const LEGACY_ESCROW_UPGRADE_FIXTURE = Object.freeze({
  id: 'b8000000-0000-4000-8000-000000000001',
  taskId: 'b2000000-0000-4000-8000-000000000001',
  paymentIntentId: 'pi_hx_legacy_upgrade_containment',
  refundId: 're_hx_legacy_upgrade_containment',
});
const OCCURRENCE_ACCESS_AUDIT_FIXTURE = Object.freeze({
  actorId: 'ec000000-0000-4000-8000-000000000001',
  taskDraftId: 'ec000000-0000-4000-8000-000000000002',
  submissionId: 'ec000000-0000-4000-8000-000000000003',
  auditDigest: 'a'.repeat(64),
  purpose: 'Certify exact Universal V1 Operations occurrence evidence.',
});

export function validateMigrationVerificationPolicy(env = process.env) {
  return validatePreparationPolicy(env);
}

function assertMigrationVerificationAuthority(env, adminDatabaseUrl) {
  const errors = validateMigrationVerificationPolicy(env);
  if (adminDatabaseUrl !== env.DATABASE_URL?.trim()) {
    errors.push('Recreate authority must match the exact admin DATABASE_URL');
  }
  if (errors.length > 0) {
    throw new Error(`Refusing migration verification database recreation: ${errors.join('; ')}`);
  }
}

function databaseUrl(adminDatabaseUrl, name) {
  const url = new URL(adminDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function refuseMigrationExecutionTarget(reason) {
  throw new Error(`Refusing migration verification execution target: ${reason}`);
}

/**
 * Produce the complete local-only authority tuple for an engine-write target.
 * The recreate-only admin database is deliberately absent from the allowlist.
 */
export function migrationVerificationExecutionEnvironment(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return refuseMigrationExecutionTarget('DATABASE_URL_INVALID');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    return refuseMigrationExecutionTarget('DATABASE_URL_PROTOCOL_INVALID');
  }
  const databaseName = parsed.pathname.replace(/^\//u, '');
  if (!MIGRATION_VERIFICATION_DATABASE_SET.has(databaseName)) {
    return refuseMigrationExecutionTarget('DATABASE_NAME_NOT_ALLOWLISTED');
  }
  if (parsed.username !== MIGRATION_VERIFICATION_DATABASE_ROLE) {
    return refuseMigrationExecutionTarget('DATABASE_ROLE_NOT_ALLOWLISTED');
  }
  if (!MIGRATION_VERIFICATION_DATABASE_HOSTS.has(parsed.hostname)) {
    return refuseMigrationExecutionTarget('DATABASE_HOST_NOT_ALLOWLISTED');
  }
  if (
    (parsed.port || MIGRATION_VERIFICATION_DATABASE_PORT) !== MIGRATION_VERIFICATION_DATABASE_PORT
  ) {
    return refuseMigrationExecutionTarget('DATABASE_PORT_NOT_ALLOWLISTED');
  }
  if (parsed.search || parsed.hash) {
    return refuseMigrationExecutionTarget('DATABASE_URL_MUST_BE_EXACT');
  }
  return Object.freeze({
    NODE_ENV: 'test',
    HX_ENVIRONMENT: 'local',
    SERVICE_ROLE: 'migration',
    HX_ALLOW_CI_DB_RECREATE: 'true',
    HXOS_LOCAL_TEST_DATABASE_NAME: databaseName,
    HXOS_LOCAL_TEST_DATABASE_ROLE: MIGRATION_VERIFICATION_DATABASE_ROLE,
  });
}

async function authorizeCanonicalMigrationPlan(client, runtime, url) {
  assert.equal(runtime.databaseUrl, url, 'runtime must bind the exact authorized database URL');
  const authority = assertMigrationExecutionAuthorized({
    env: migrationVerificationExecutionEnvironment(url),
    migrationArtifactDigest: await engineMigrationArtifactDigest(),
    databaseUrl: url,
  });
  return authorizeEngineAutomationMigrationPlanOnConnectedClient(client, runtime, authority);
}

async function finishCanonicalMigrationPlan(client, plan) {
  const backfilledLocationCount = await backfillLegacyTaskLocations(client, plan.session);
  assert.ok(Number.isInteger(backfilledLocationCount) && backfilledLocationCount >= 0);
  const receipt = completeMigrationExecutionSession(plan.session, client);
  assert.equal(
    receipt.operationCount,
    plan.migrations.length + (plan.baseline ? 1 : 0) + 1,
    'migration receipt must cover baseline, every migration, and location backfill exactly once'
  );
  return receipt;
}

async function consumeCanonicalMigrationPlan(client, runtime, url, expectedStatus) {
  const plan = await authorizeCanonicalMigrationPlan(client, runtime, url);
  assert.ok(plan.baseline, 'canonical engine plan must include the constitutional baseline');
  await ensureConstitutionalBaseline(client, plan.baseline, plan.session);
  const outcomes = [];
  for (const migration of plan.migrations) {
    const outcome = await applyEngineAutomationMigration(
      client,
      migration.sql,
      migration.sourcePath,
      plan.session,
      migration.name
    );
    assert.equal(outcome.status, expectedStatus);
    outcomes.push(outcome);
  }
  await finishCanonicalMigrationPlan(client, plan);
  return outcomes;
}

async function runCanonicalMigrationPlan(url, expectedStatus) {
  const runtime = productionMigrationRuntime();
  runtime.databaseUrl = url;
  const client = runtime.createClient(url);
  await client.connect();
  try {
    return await consumeCanonicalMigrationPlan(client, runtime, url, expectedStatus);
  } finally {
    await client.end();
  }
}

function executableSql(sql) {
  return sql
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('\\'))
    .join('\n');
}

async function recreateDatabase(adminDatabaseUrl, name, authorityEnv) {
  assertMigrationVerificationAuthority(authorityEnv, adminDatabaseUrl);
  if (!MIGRATION_VERIFICATION_DATABASE_SET.has(name)) {
    throw new Error(`Unsafe migration verification database name: ${name}`);
  }
  const client = new Client({ connectionString: adminDatabaseUrl });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${name}`);
  } finally {
    await client.end();
  }
}

async function assertExactRegistry(url) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query('SELECT name FROM applied_migrations ORDER BY name');
    assert.deepEqual(
      result.rows.map((row) => row.name),
      REQUIRED_MIGRATION_FILES.map((entry) => entry.name).sort(),
      'database migration ledger must equal the exact runtime registry'
    );
  } finally {
    await client.end();
  }
}

async function seedPartialCompletionReceipt(client) {
  await client.query("SET session_replication_role = 'replica'");
  try {
    await client.query(
      `
      INSERT INTO public.task_completion_delivery_events(
        id,
        task_id,
        provider_delivery_id,
        channel,
        delivered_at,
        recorded_by,
        work_order_id,
        expected_completion_fact_id,
        expected_completion_version,
        expected_execution_version,
        provider_kind,
        provider_service_identity,
        idempotency_key,
        request_sha256,
        provider_callback_at,
        authenticated_at,
        policy_version
      ) VALUES (
        $1,
        'b9000000-0000-4000-8000-000000000002',
        'smtp_sink:partial-upgrade-receipt',
        'EMAIL',
        TIMESTAMPTZ '2026-08-30 21:00:00+00',
        'b9000000-0000-4000-8000-000000000003',
        'b9000000-0000-4000-8000-000000000004',
        'b9000000-0000-4000-8000-000000000005',
        1,
        1,
        'SYNTHETIC_SINK',
        NULL,
        'completion-delivery:partial-upgrade',
        repeat('a', 64),
        TIMESTAMPTZ '2026-08-30 21:00:00+00',
        TIMESTAMPTZ '2026-08-30 21:00:00+00',
        'universal-v1-completion-delivery-receipt-1.0.0'
      )
    `,
      [PARTIAL_COMPLETION_RECEIPT_ID]
    );
  } finally {
    await client.query("SET session_replication_role = 'origin'");
  }
}

async function partialCompletionReceiptSnapshot(client) {
  const result = await client.query(
    `
    SELECT to_jsonb(delivery) AS row
    FROM public.task_completion_delivery_events delivery
    WHERE delivery.id = $1
  `,
    [PARTIAL_COMPLETION_RECEIPT_ID]
  );
  return result.rows.map((row) => row.row);
}

async function removePartialCompletionReceipt(client) {
  await client.query("SET session_replication_role = 'replica'");
  try {
    await client.query('DELETE FROM public.task_completion_delivery_events WHERE id = $1', [
      PARTIAL_COMPLETION_RECEIPT_ID,
    ]);
  } finally {
    await client.query("SET session_replication_role = 'origin'");
  }
}

async function taskDraftClaimUpgradeSnapshot(client) {
  const [drafts, batches, receipts, profiles, audits, canonicalIdentity, consequentialState] =
    await Promise.all([
      client.query(
        `
      SELECT COALESCE(jsonb_agg(to_jsonb(draft) ORDER BY draft.id), '[]'::jsonb) AS rows
      FROM task_drafts draft
      WHERE draft.id = ANY($1::uuid[])
    `,
        [TASK_DRAFT_CLAIM_UPGRADE_DRAFT_IDS]
      ),
      client.query(`
      SELECT COALESCE(jsonb_agg(to_jsonb(batch) ORDER BY batch.id), '[]'::jsonb) AS rows
      FROM task_draft_legacy_import_batches batch
      WHERE batch.id = 'f4000000-0000-4000-8000-000000000001'
    `),
      client.query(`
      SELECT COALESCE(jsonb_agg(to_jsonb(receipt) ORDER BY receipt.id), '[]'::jsonb) AS rows
      FROM task_draft_legacy_import_receipts receipt
      WHERE receipt.id = 'f5000000-0000-4000-8000-000000000001'
    `),
      client.query(`
      SELECT COALESCE(jsonb_agg(to_jsonb(profile) ORDER BY profile.user_id), '[]'::jsonb) AS rows
      FROM hx_task_draft_claim_source.poster_profiles profile
    `),
      client.query(`
      SELECT COALESCE(jsonb_agg(to_jsonb(audit) ORDER BY audit.id), '[]'::jsonb) AS rows
      FROM hx_task_draft_claim_source.audit_log audit
    `),
      client.query(
        `
      SELECT COALESCE(jsonb_agg(to_jsonb(identity) ORDER BY identity.id), '[]'::jsonb) AS rows
      FROM (
        SELECT id, firebase_uid, email, full_name, default_mode
        FROM users
        WHERE lower(email) = 'hx-claim-upgrade-owner@e2e.invalid'
           OR id = $1
      ) identity
    `,
        [TASK_DRAFT_CLAIM_UPGRADE_IDS.sourceProfile]
      ),
      client.query(`
      SELECT
        (SELECT COUNT(*)::integer FROM task_applications) AS express_interests,
        (SELECT COUNT(*)::integer FROM task_reservations) AS reservations,
        (SELECT COUNT(*)::integer FROM task_provider_eligibility_decisions)
          AS payment_eligibility_decisions,
        (SELECT COUNT(*)::integer FROM task_location_access_log) AS private_data_releases,
        (SELECT COUNT(*)::integer FROM task_financial_operations) AS financial_operations,
        (SELECT COUNT(*)::integer FROM task_financial_security_events)
          AS financial_security_events,
        (SELECT COUNT(*)::integer FROM task_work_orders) AS work_orders,
        (SELECT COUNT(*)::integer FROM task_reconciliation_facts) AS reconciliation_facts,
        (SELECT COUNT(*)::integer FROM tasks) AS tasks,
        (SELECT COUNT(*)::integer FROM escrows) AS escrows,
        (SELECT COUNT(*)::integer FROM quote_payments) AS quote_payments,
        (SELECT COUNT(*)::integer FROM stripe_events) AS stripe_events
    `),
    ]);
  return {
    drafts: drafts.rows[0].rows,
    batches: batches.rows[0].rows,
    receipts: receipts.rows[0].rows,
    sourcePosterProfiles: profiles.rows[0].rows,
    sourceAuditLog: audits.rows[0].rows,
    canonicalIdentity: canonicalIdentity.rows[0].rows,
    consequentialState: consequentialState.rows[0],
  };
}

async function taskDraftClaimObservationSnapshot(
  client,
  draftIds = TASK_DRAFT_CLAIM_UPGRADE_DRAFT_IDS
) {
  const result = await client.query(
    `
    SELECT COALESCE(jsonb_agg(to_jsonb(observation) ORDER BY observation.task_draft_id),
                    '[]'::jsonb) AS rows
    FROM task_draft_precontract_claim_observations observation
    WHERE observation.task_draft_id = ANY($1::uuid[])
  `,
    [draftIds]
  );
  return result.rows[0].rows;
}

async function assertTaskDraftClaimUpgradeMatrix(client, baseline) {
  assert.deepEqual(
    await taskDraftClaimUpgradeSnapshot(client),
    baseline,
    'claim migration must not rewrite target rows or source poster/audit evidence'
  );

  const observations = await client.query(
    `
    SELECT task_draft_id::text, observed_status,
           observed_poster_user_id::text,
           to_char(
             observed_claimed_at AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS"Z"'
           ) AS observed_claimed_at,
           ingress_origin, classification
    FROM task_draft_precontract_claim_observations
    WHERE task_draft_id = ANY($1::uuid[])
    ORDER BY task_draft_id
  `,
    [TASK_DRAFT_CLAIM_UPGRADE_DRAFT_IDS]
  );
  assert.deepEqual(observations.rows, [
    {
      task_draft_id: TASK_DRAFT_CLAIM_UPGRADE_IDS.sameOwnerUnclassified,
      observed_status: 'account_claimed',
      observed_poster_user_id: 'f1000000-0000-4000-8000-000000000001',
      observed_claimed_at: '2026-08-20T02:00:00Z',
      ingress_origin: 'UNCLASSIFIED_V0',
      classification: 'PRECONTRACT_UNVERIFIED_NO_CANONICAL_EVENT',
    },
    {
      task_draft_id: TASK_DRAFT_CLAIM_UPGRADE_IDS.otherOwnerUnclassified,
      observed_status: 'account_claimed',
      observed_poster_user_id: 'f1000000-0000-4000-8000-000000000002',
      observed_claimed_at: '2026-08-20T03:00:00Z',
      ingress_origin: 'UNCLASSIFIED_V0',
      classification: 'PRECONTRACT_UNVERIFIED_NO_CANONICAL_EVENT',
    },
  ]);

  const authority = await client.query(
    `
    SELECT
      (SELECT COUNT(*)::integer
       FROM task_draft_account_claim_events event
       WHERE event.task_draft_id = ANY($1::uuid[])) AS canonical_events,
      (SELECT COUNT(*)::integer
       FROM task_draft_precontract_claim_observations observation
       WHERE observation.task_draft_id IN ($2, $3)) AS unclaimed_observations,
      (SELECT COUNT(*)::integer FROM users WHERE id = $4) AS inferred_source_users,
      (SELECT COUNT(*)::integer FROM users
       WHERE lower(email) = 'hx-claim-upgrade-owner@e2e.invalid') AS canonical_email_users
  `,
    [
      TASK_DRAFT_CLAIM_UPGRADE_DRAFT_IDS,
      TASK_DRAFT_CLAIM_UPGRADE_IDS.canonicalUnclaimed,
      TASK_DRAFT_CLAIM_UPGRADE_IDS.legacyUnclaimed,
      TASK_DRAFT_CLAIM_UPGRADE_IDS.sourceProfile,
    ]
  );
  assert.deepEqual(
    authority.rows[0],
    {
      canonical_events: 0,
      unclaimed_observations: 0,
      inferred_source_users: 0,
      canonical_email_users: 1,
    },
    'source identity/audit evidence must never synthesize canonical authority'
  );

  const legacy = await client.query(
    `
    SELECT universal_contract_version, ingress_contract_version,
           ingress_origin, card_token_contract_version,
           legacy_poster_auth_user_id::text, poster_user_id::text,
           lead_id::text, task_id::text, quote_id::text,
           (SELECT COUNT(*)::integer FROM task_routing_decisions route
            WHERE route.task_draft_id = draft.id) AS routes
    FROM task_drafts draft
    WHERE draft.id = $1
  `,
    [TASK_DRAFT_CLAIM_UPGRADE_IDS.legacyUnclaimed]
  );
  assert.deepEqual(
    legacy.rows[0],
    {
      universal_contract_version: 0,
      ingress_contract_version: 0,
      ingress_origin: 'LEGACY_SUPABASE_TASK_DRAFT_PUBLIC',
      card_token_contract_version: 0,
      legacy_poster_auth_user_id: TASK_DRAFT_CLAIM_UPGRADE_IDS.sourceProfile,
      poster_user_id: null,
      lead_id: null,
      task_id: null,
      quote_id: null,
      routes: 0,
    },
    'legacy source owner remains external evidence, never a canonical user link'
  );
}

async function assertTaskDraftClaimObservationImmutability(client, expected) {
  for (const statement of [
    `UPDATE task_draft_precontract_claim_observations
     SET classification = classification
     WHERE task_draft_id = '${TASK_DRAFT_CLAIM_UPGRADE_IDS.sameOwnerUnclassified}'`,
    `DELETE FROM task_draft_precontract_claim_observations
     WHERE task_draft_id = '${TASK_DRAFT_CLAIM_UPGRADE_IDS.sameOwnerUnclassified}'`,
    'TRUNCATE task_draft_precontract_claim_observations',
  ]) {
    await client.query('BEGIN');
    try {
      await assert.rejects(
        client.query(statement),
        (error) =>
          error?.code === 'P0001' &&
          /TaskDraft account-claim evidence is append-only/u.test(error.message)
      );
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
    }
    assert.deepEqual(await taskDraftClaimObservationSnapshot(client), expected);
  }
}

async function assertTaskDraftClaimRepairMatrix(client) {
  const gap = await client.query(
    `
    SELECT draft.status, draft.poster_user_id::text, draft.claimed_at::text,
           draft.ingress_origin,
           observation.observed_status,
           observation.observed_poster_user_id::text,
           observation.observed_claimed_at::text,
           observation.ingress_origin AS observed_ingress_origin,
           observation.classification,
           (SELECT COUNT(*)::integer
            FROM task_draft_account_claim_events event
            WHERE event.task_draft_id = draft.id) AS canonical_events
    FROM task_drafts draft
    LEFT JOIN task_draft_precontract_claim_observations observation
      ON observation.task_draft_id = draft.id
    WHERE draft.id = $1
  `,
    [TASK_DRAFT_CLAIM_REPAIR_GAP_ID]
  );
  assert.deepEqual(
    gap.rows[0],
    {
      status: 'draft',
      poster_user_id: 'f1000000-0000-4000-8000-000000000001',
      claimed_at: null,
      ingress_origin: 'UNCLASSIFIED_V0',
      observed_status: 'draft',
      observed_poster_user_id: 'f1000000-0000-4000-8000-000000000001',
      observed_claimed_at: null,
      observed_ingress_origin: 'UNCLASSIFIED_V0',
      classification: 'PRECONTRACT_UNVERIFIED_NO_CANONICAL_EVENT',
      canonical_events: 0,
    },
    '20260905 must close a poster-only noncanonical observation gap without adoption'
  );
}

async function assertPostRepairClaimLikeInsertRejected(client, values) {
  await client.query('BEGIN');
  try {
    await assert.rejects(
      client.query(
        `
        INSERT INTO task_drafts(
          id, submission_id, card_token_hash, raw_input, structured,
          status, source, utm, poster_user_id, claimed_at,
          universal_contract_version, ingress_contract_version,
          ingress_origin, card_token_contract_version
        ) VALUES ($1, $2, $3, 'Post-repair claim-like insert denial', '{}'::jsonb,
                  $4, 'upgrade_contract_test', '{}'::jsonb, $5, $6,
                  $7, $8, $9, $10)
      `,
        values
      ),
      (error) =>
        error?.code === 'P0001' &&
        /TaskDraft claim requires exact canonical event evidence/u.test(error.message)
    );
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
  }
}

async function assertHardAssignmentAliasContainment(url) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const trigger = await client.query(`
      SELECT pg_get_triggerdef(oid, true) AS definition
      FROM pg_trigger
      WHERE tgrelid = 'tasks'::regclass
        AND tgname = 'universal_hard_assignment_hold'
        AND NOT tgisinternal
    `);
    assert.equal(trigger.rows.length, 1, 'hard-assignment trigger must exist exactly once');
    assert.match(
      trigger.rows[0].definition,
      /BEFORE INSERT OR UPDATE ON tasks/u,
      'hard-assignment trigger must observe every UPDATE, including legacy alias synchronization'
    );
    assert.doesNotMatch(
      trigger.rows[0].definition,
      /UPDATE OF/u,
      'column-scoped UPDATE triggers permit legacy alias synchronization bypasses'
    );

    await client.query('BEGIN');
    await client.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assigned_hustler_id UUID');
    await client.query(`
      CREATE OR REPLACE FUNCTION sync_task_worker_id() RETURNS TRIGGER AS $fn$
      BEGIN
        IF TG_OP = 'UPDATE'
           AND NEW.assigned_hustler_id IS DISTINCT FROM OLD.assigned_hustler_id
           AND NEW.worker_id IS NOT DISTINCT FROM OLD.worker_id THEN
          NEW.worker_id := NEW.assigned_hustler_id;
        END IF;
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_sync_task_worker_id ON tasks');
    await client.query(`
      CREATE TRIGGER trg_sync_task_worker_id
      BEFORE INSERT OR UPDATE ON tasks
      FOR EACH ROW EXECUTE FUNCTION sync_task_worker_id()
    `);
    await client.query(`
      INSERT INTO users(id,email,full_name,default_mode) VALUES
        ('e1000000-0000-4000-8000-000000000001','hx-alias-poster@test.invalid','Alias Poster','poster'),
        ('e1000000-0000-4000-8000-000000000002','hx-alias-worker@test.invalid','Alias Worker','worker')
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION pg_temp.hx_alias_policy_snapshot(
        p region_policies, p_category TEXT, p_risk TEXT
      ) RETURNS JSONB LANGUAGE SQL IMMUTABLE AS $snapshot$
        SELECT jsonb_build_object(
          'policyId', p.id::text,
          'policyVersion', p.version,
          'policyHash', p.policy_hash,
          'regionCode', p.region_code,
          'locationState', split_part(p.region_code, '-', 2),
          'licenseRequired', (p.policy_document#>>ARRAY['categories', p_category, 'credentials', 'licenseRequired'])::BOOLEAN,
          'insuranceRequired', (p.policy_document#>>ARRAY['categories', p_category, 'credentials', 'insuranceRequired'])::BOOLEAN,
          'backgroundCheckRequired', (p.policy_document#>>ARRAY['categories', p_category, 'credentials', 'backgroundCheckRequired'])::BOOLEAN,
          'proofRequired', (p.policy_document#>>ARRAY['categories', p_category, 'evidence', 'proofRequired'])::BOOLEAN,
          'proofMinPhotos', (p.policy_document#>>ARRAY['categories', p_category, 'evidence', 'minPhotos'])::INTEGER,
          'proofMaxPhotos', (p.policy_document#>>ARRAY['categories', p_category, 'evidence', 'maxPhotos'])::INTEGER,
          'proofGpsRequired', (p.policy_document#>>ARRAY['categories', p_category, 'evidence', 'gpsRequired'])::BOOLEAN,
          'recordingAllowed', (p.policy_document#>>'{recording,allowed}')::BOOLEAN,
          'recordingStandaloneConsentRequired', (p.policy_document#>>'{recording,standaloneConsentRequired}')::BOOLEAN,
          'screeningStandaloneConsentRequired', (p.policy_document#>>'{workerRights,standaloneScreeningConsentRequired}')::BOOLEAN,
          'screeningReportAccessRequired', (p.policy_document#>>'{workerRights,reportAccessRequired}')::BOOLEAN,
          'screeningDisputeAndAppealRequired', (p.policy_document#>>'{workerRights,disputeAndAppealRequired}')::BOOLEAN,
          'screeningAdverseActionNoticeRequired', (p.policy_document#>>'{workerRights,adverseActionNoticeRequired}')::BOOLEAN,
          'safetyIncidentIntakeRequired', (p.policy_document#>>'{safety,incidentIntakeRequired}')::BOOLEAN,
          'safetyTimedCheckinRequired', (p.policy_document#>'{safety,timedCheckinRiskLevels}') ? p_risk,
          'safetyCheckinIntervalsMinutes', p.policy_document#>'{safety,checkinIntervalsMinutes}',
          'safetyLocationRetentionDays', (p.policy_document#>>'{safety,locationRetentionDays}')::INTEGER,
          'safetyAlternateEmergencyActionRequired', (p.policy_document#>>'{safety,alternateEmergencyActionRequired}')::BOOLEAN,
          'currency', p.policy_document#>>'{financial,currency}'
        )
      $snapshot$
    `);
    await client.query(`
      INSERT INTO tasks(
        id, poster_id, title, description, price, state, universal_contract_version,
        payment_method, universal_payment_posture,
        hustler_payout_cents, platform_margin_cents, category, risk_level,
        requires_proof, automation_classification, region_code, region_policy_id,
        region_policy_version, region_policy_hash, region_policy_snapshot,
        trade_type, location_state, license_required, insurance_required,
        background_check_required, proof_min_photos, proof_max_photos,
        proof_gps_required, currency
      ) SELECT
        'e2000000-0000-4000-8000-000000000001',
        'e1000000-0000-4000-8000-000000000001',
        'Alias containment fixture', 'No assignment may be created', 5000, 'OPEN', 1,
        'universal_financial_security', 'PAYMENT_CREATION_FROZEN',
        4000, 1000, 'moving', 'LOW', TRUE, 'CONTROLLED_TEST', p.region_code, p.id,
        p.version, p.policy_hash, pg_temp.hx_alias_policy_snapshot(p, 'moving', 'LOW'),
        'moving', split_part(p.region_code, '-', 2),
        (p.policy_document#>>'{categories,moving,credentials,licenseRequired}')::BOOLEAN,
        (p.policy_document#>>'{categories,moving,credentials,insuranceRequired}')::BOOLEAN,
        (p.policy_document#>>'{categories,moving,credentials,backgroundCheckRequired}')::BOOLEAN,
        (p.policy_document#>>'{categories,moving,evidence,minPhotos}')::INTEGER,
        (p.policy_document#>>'{categories,moving,evidence,maxPhotos}')::INTEGER,
        (p.policy_document#>>'{categories,moving,evidence,gpsRequired}')::BOOLEAN,
        p.policy_document#>>'{financial,currency}'
      FROM region_policies p
      WHERE p.region_code='US-WA' AND p.policy_state='ACTIVE'
      ORDER BY p.effective_from DESC, p.created_at DESC
      LIMIT 1
    `);
    await assert.rejects(
      client.query(`
        UPDATE tasks
        SET assigned_hustler_id='e1000000-0000-4000-8000-000000000002'
        WHERE id='e2000000-0000-4000-8000-000000000001'
      `),
      (error) => error?.code === 'P0001' && /hard assignment remains held/u.test(error.message),
      'legacy assigned_hustler_id alias must not bypass the Universal V1 hold'
    );
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
}

async function legacyEscrowSnapshot(client, escrowId) {
  const result = await client.query(
    `
    SELECT id::text, task_id::text, amount, state, refund_amount, release_amount,
           stripe_payment_intent_id, stripe_transfer_id, stripe_refund_id,
           version, funded_at, released_at, refunded_at, created_at, updated_at
    FROM public.escrows
    WHERE id = $1
  `,
    [escrowId]
  );
  assert.equal(result.rows.length, 1, 'historical legacy escrow must exist exactly once');
  return result.rows[0];
}

async function assertLegacyEscrowContainmentCatalog(client) {
  const result = await client.query(`
    SELECT
      relation.relkind,
      pg_catalog.to_regclass('public.escrows')::text AS plural_table,
      pg_catalog.to_regclass('public.escrow')::text AS singular_table,
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_inherits inheritance
        WHERE inheritance.inhparent = relation.oid
           OR inheritance.inhrelid = relation.oid
      ) AS non_inherited,
      namespace.nspname AS function_schema,
      procedure.proname AS function_name,
      procedure.pronargs,
      procedure.prorettype::pg_catalog.regtype::text AS return_type,
      language.lanname AS language,
      procedure.prosecdef AS security_definer,
      procedure.proconfig,
      trigger.tgenabled,
      trigger.tgtype::integer AS trigger_type,
      trigger.tgisinternal,
      trigger.tgfoid = procedure.oid AS trigger_function_matches,
      pg_catalog.pg_get_functiondef(procedure.oid) AS function_definition,
      pg_catalog.pg_get_triggerdef(trigger.oid, true) AS trigger_definition,
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            procedure.proacl,
            pg_catalog.acldefault('f', procedure.proowner)
          )
        ) privilege
        WHERE privilege.grantee = 0
          AND privilege.privilege_type = 'EXECUTE'
      ) AS public_execute_revoked
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace table_namespace
      ON table_namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_trigger trigger
      ON trigger.tgrelid = relation.oid
     AND trigger.tgname = 'legacy_escrow_insert_containment_v1'
    JOIN pg_catalog.pg_proc procedure
      ON procedure.oid = trigger.tgfoid
    JOIN pg_catalog.pg_namespace namespace
      ON namespace.oid = procedure.pronamespace
    JOIN pg_catalog.pg_language language
      ON language.oid = procedure.prolang
    WHERE table_namespace.nspname = 'public'
      AND relation.relname = 'escrows'
      AND NOT trigger.tgisinternal
  `);

  assert.equal(
    result.rows.length,
    1,
    'legacy escrow containment trigger/function identity must exist exactly once'
  );
  const row = result.rows[0];
  assert.deepEqual(
    {
      relkind: row.relkind,
      pluralTable: row.plural_table,
      singularTable: row.singular_table,
      nonInherited: row.non_inherited,
      functionSchema: row.function_schema,
      functionName: row.function_name,
      argumentCount: row.pronargs,
      returnType: row.return_type,
      language: row.language,
      securityDefiner: row.security_definer,
      configuration: row.proconfig,
      enabled: row.tgenabled,
      triggerType: row.trigger_type,
      internal: row.tgisinternal,
      triggerFunctionMatches: row.trigger_function_matches,
      publicExecuteRevoked: row.public_execute_revoked,
    },
    {
      relkind: 'r',
      pluralTable: 'escrows',
      singularTable: null,
      nonInherited: true,
      functionSchema: 'public',
      functionName: 'enforce_legacy_escrow_insert_containment_v1',
      argumentCount: 0,
      returnType: 'trigger',
      language: 'plpgsql',
      securityDefiner: false,
      configuration: ['search_path=pg_catalog, public'],
      enabled: 'A',
      triggerType: 7,
      internal: false,
      triggerFunctionMatches: true,
      publicExecuteRevoked: true,
    },
    'live catalog must expose one insert-only, row-level, always-enabled SECURITY INVOKER containment trigger with a fixed search_path'
  );

  assert.match(
    row.trigger_definition,
    /^CREATE TRIGGER legacy_escrow_insert_containment_v1 BEFORE INSERT ON escrows FOR EACH ROW EXECUTE FUNCTION enforce_legacy_escrow_insert_containment_v1\(\)$/u
  );
  assert.deepEqual(
    [...row.function_definition.matchAll(/hx_ci_[a-z_]+/gu)].map((match) => match[0]).sort(),
    ['hx_ci_invariant_test', 'hx_ci_runner', 'hx_ci_runner', 'hx_ci_system_test'],
    'live function may name only the exact CI role and two isolated exception databases'
  );
  assert.match(row.function_definition, /session_user\s*=\s*'hx_ci_runner'/u);
  assert.match(row.function_definition, /current_user\s*=\s*'hx_ci_runner'/u);
  assert.match(row.function_definition, /current_database\(\)\s+IN/u);
  assert.match(row.function_definition, new RegExp(LEGACY_ESCROW_CONTAINMENT_MESSAGE, 'u'));
  assert.doesNotMatch(
    row.function_definition,
    /(?:current_setting|set_config|hx_ci_fresh_test|hx_ci_upgrade_test|provider_kind|stripe|payment_creation_enabled)/iu,
    'live function must expose no ambient, provider, payment, fresh, or upgrade bypass'
  );
}

async function assertLegacyEscrowInsertDenied(client) {
  const before = await client.query('SELECT COUNT(*)::integer AS count FROM public.escrows');
  await client.query('BEGIN');
  try {
    await client.query(`
      CREATE OR REPLACE FUNCTION pg_temp.hx_legacy_escrow_policy_snapshot(
        p region_policies, p_category TEXT, p_risk TEXT
      ) RETURNS JSONB LANGUAGE SQL IMMUTABLE AS $snapshot$
        SELECT jsonb_build_object(
          'policyId', p.id::text,
          'policyVersion', p.version,
          'policyHash', p.policy_hash,
          'regionCode', p.region_code,
          'locationState', split_part(p.region_code, '-', 2),
          'licenseRequired', (p.policy_document#>>ARRAY['categories', p_category, 'credentials', 'licenseRequired'])::BOOLEAN,
          'insuranceRequired', (p.policy_document#>>ARRAY['categories', p_category, 'credentials', 'insuranceRequired'])::BOOLEAN,
          'backgroundCheckRequired', (p.policy_document#>>ARRAY['categories', p_category, 'credentials', 'backgroundCheckRequired'])::BOOLEAN,
          'proofRequired', (p.policy_document#>>ARRAY['categories', p_category, 'evidence', 'proofRequired'])::BOOLEAN,
          'proofMinPhotos', (p.policy_document#>>ARRAY['categories', p_category, 'evidence', 'minPhotos'])::INTEGER,
          'proofMaxPhotos', (p.policy_document#>>ARRAY['categories', p_category, 'evidence', 'maxPhotos'])::INTEGER,
          'proofGpsRequired', (p.policy_document#>>ARRAY['categories', p_category, 'evidence', 'gpsRequired'])::BOOLEAN,
          'recordingAllowed', (p.policy_document#>>'{recording,allowed}')::BOOLEAN,
          'recordingStandaloneConsentRequired', (p.policy_document#>>'{recording,standaloneConsentRequired}')::BOOLEAN,
          'screeningStandaloneConsentRequired', (p.policy_document#>>'{workerRights,standaloneScreeningConsentRequired}')::BOOLEAN,
          'screeningReportAccessRequired', (p.policy_document#>>'{workerRights,reportAccessRequired}')::BOOLEAN,
          'screeningDisputeAndAppealRequired', (p.policy_document#>>'{workerRights,disputeAndAppealRequired}')::BOOLEAN,
          'screeningAdverseActionNoticeRequired', (p.policy_document#>>'{workerRights,adverseActionNoticeRequired}')::BOOLEAN,
          'safetyIncidentIntakeRequired', (p.policy_document#>>'{safety,incidentIntakeRequired}')::BOOLEAN,
          'safetyTimedCheckinRequired', (p.policy_document#>'{safety,timedCheckinRiskLevels}') ? p_risk,
          'safetyCheckinIntervalsMinutes', p.policy_document#>'{safety,checkinIntervalsMinutes}',
          'safetyLocationRetentionDays', (p.policy_document#>>'{safety,locationRetentionDays}')::INTEGER,
          'safetyAlternateEmergencyActionRequired', (p.policy_document#>>'{safety,alternateEmergencyActionRequired}')::BOOLEAN,
          'currency', p.policy_document#>>'{financial,currency}'
        )
      $snapshot$
    `);
    await client.query(`
      INSERT INTO users(id, email, full_name, default_mode)
      VALUES (
        'ea000000-0000-4000-8000-000000000001',
        'hx-legacy-escrow-denial@e2e.invalid',
        'HX Legacy Escrow Denial',
        'poster'
      )
    `);
    await client.query(`
      INSERT INTO tasks(
        id, poster_id, title, description, price, state, universal_contract_version,
        hustler_payout_cents, platform_margin_cents, category, risk_level,
        requires_proof, automation_classification, region_code, region_policy_id,
        region_policy_version, region_policy_hash, region_policy_snapshot,
        trade_type, location_state, license_required, insurance_required,
        background_check_required, proof_min_photos, proof_max_photos,
        proof_gps_required, currency
      ) SELECT
        'ea000000-0000-4000-8000-000000000002',
        'ea000000-0000-4000-8000-000000000001',
        'Legacy escrow insert denial fixture',
        'Version-zero task proves the escrow containment trigger itself',
        5100, 'OPEN', 0, 4100, 1000, 'moving', 'LOW', TRUE,
        'CONTROLLED_TEST', policy.region_code, policy.id, policy.version,
        policy.policy_hash,
        pg_temp.hx_legacy_escrow_policy_snapshot(policy, 'moving', 'LOW'),
        'moving', split_part(policy.region_code, '-', 2),
        (policy.policy_document#>>'{categories,moving,credentials,licenseRequired}')::BOOLEAN,
        (policy.policy_document#>>'{categories,moving,credentials,insuranceRequired}')::BOOLEAN,
        (policy.policy_document#>>'{categories,moving,credentials,backgroundCheckRequired}')::BOOLEAN,
        (policy.policy_document#>>'{categories,moving,evidence,minPhotos}')::INTEGER,
        (policy.policy_document#>>'{categories,moving,evidence,maxPhotos}')::INTEGER,
        (policy.policy_document#>>'{categories,moving,evidence,gpsRequired}')::BOOLEAN,
        policy.policy_document#>>'{financial,currency}'
      FROM region_policies policy
      WHERE policy.region_code = 'US-WA'
        AND policy.policy_state = 'ACTIVE'
      ORDER BY policy.effective_from DESC, policy.created_at DESC
      LIMIT 1
    `);
    await assert.rejects(
      client.query(`
        INSERT INTO public.escrows(id, task_id, amount, state)
        VALUES (
          'ea000000-0000-4000-8000-000000000003',
          'ea000000-0000-4000-8000-000000000002',
          5100,
          'PENDING'
        )
      `),
      (error) => error?.code === 'P0001' && error?.message === LEGACY_ESCROW_CONTAINMENT_MESSAGE,
      'fresh and upgrade databases must reject new legacy escrow inserts with the exact containment error'
    );
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
  }
  const after = await client.query('SELECT COUNT(*)::integer AS count FROM public.escrows');
  assert.deepEqual(after.rows[0], before.rows[0], 'rejected insert must leave no escrow row');
}

async function assertLegacyEscrowContainment(url, expectedHistoricalEscrow = null) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await assertLegacyEscrowContainmentCatalog(client);
    await assertLegacyEscrowInsertDenied(client);
    if (expectedHistoricalEscrow) {
      assert.deepEqual(
        await legacyEscrowSnapshot(client, LEGACY_ESCROW_UPGRADE_FIXTURE.id),
        expectedHistoricalEscrow,
        'reconnect must preserve the recovered historical escrow exactly'
      );
    }
  } finally {
    await client.end();
  }
}

async function assertOccurrenceAccessAuditCatalog(client) {
  const relation = await client.query(`
    SELECT relation.relkind,
           pg_catalog.obj_description(relation.oid, 'pg_class') AS comment
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = 'universal_v1_occurrence_access_audit'
  `);
  assert.deepEqual(
    relation.rows,
    [
      {
        relkind: 'r',
        comment:
          'Append-only purpose-bound digest evidence for each returned named-operator Universal V1 Operations occurrence projection; grants no command or effect authority.',
      },
    ],
    'migration 139 must install exactly one ordinary purpose-bound audit table'
  );

  const columns = await client.query(`
    SELECT attribute.attname AS name,
           pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS type,
           attribute.attnotnull AS not_null,
           pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid)
             AS default_expression
    FROM pg_catalog.pg_attribute attribute
    LEFT JOIN pg_catalog.pg_attrdef default_value
      ON default_value.adrelid = attribute.attrelid
     AND default_value.adnum = attribute.attnum
    WHERE attribute.attrelid =
            'public.universal_v1_occurrence_access_audit'::pg_catalog.regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
    ORDER BY attribute.attnum
  `);
  assert.deepEqual(
    columns.rows.map(({ name, type, not_null: notNull }) => ({ name, type, notNull })),
    [
      { name: 'id', type: 'uuid', notNull: true },
      { name: 'task_draft_id', type: 'uuid', notNull: true },
      { name: 'projection_perspective', type: 'text', notNull: true },
      { name: 'projection_contract_version', type: 'smallint', notNull: true },
      { name: 'actor_id', type: 'uuid', notNull: true },
      { name: 'actor_role', type: 'text', notNull: true },
      { name: 'purpose', type: 'text', notNull: true },
      { name: 'projection_sha256', type: 'character(64)', notNull: true },
      { name: 'observed_at', type: 'timestamp with time zone', notNull: true },
    ],
    'migration 139 column order, types, and nullability must remain exact'
  );
  const defaults = Object.fromEntries(
    columns.rows.map((column) => [column.name, column.default_expression])
  );
  assert.match(defaults.id, /gen_random_uuid\(\)/u);
  assert.equal(defaults.task_draft_id, null);
  assert.match(defaults.projection_perspective, /'OPERATIONS'::text/u);
  assert.match(defaults.projection_contract_version, /^1(?:::smallint)?$/u);
  assert.equal(defaults.actor_id, null);
  assert.equal(defaults.actor_role, null);
  assert.equal(defaults.purpose, null);
  assert.equal(defaults.projection_sha256, null);
  assert.match(defaults.observed_at, /clock_timestamp\(\)/u);

  const constraints = await client.query(`
    SELECT catalog_constraint.contype AS type,
           catalog_constraint.convalidated AS validated,
           catalog_constraint.condeferrable AS deferrable,
           pg_catalog.pg_get_constraintdef(catalog_constraint.oid, true) AS definition
    FROM pg_catalog.pg_constraint catalog_constraint
    WHERE catalog_constraint.conrelid =
            'public.universal_v1_occurrence_access_audit'::pg_catalog.regclass
    ORDER BY catalog_constraint.contype, catalog_constraint.conname
  `);
  assert.equal(constraints.rows.length, 8, 'migration 139 must expose eight table constraints');
  assert.deepEqual(
    constraints.rows.reduce((counts, constraint) => {
      counts[constraint.type] = (counts[constraint.type] ?? 0) + 1;
      return counts;
    }, {}),
    { c: 5, f: 2, p: 1 },
    'migration 139 must expose one primary key, two restrictive FKs, and five checks'
  );
  assert.ok(
    constraints.rows.every((constraint) => constraint.validated && !constraint.deferrable),
    'every migration-139 constraint must be validated and non-deferrable'
  );
  const constraintDefinitions = constraints.rows
    .map((constraint) => constraint.definition)
    .join('\n');
  assert.match(constraintDefinitions, /PRIMARY KEY \(id\)/u);
  assert.match(
    constraintDefinitions,
    /FOREIGN KEY \(task_draft_id\) REFERENCES (?:public\.)?task_drafts\(id\) ON DELETE RESTRICT/u
  );
  assert.match(
    constraintDefinitions,
    /FOREIGN KEY \(actor_id\) REFERENCES (?:public\.)?users\(id\) ON DELETE RESTRICT/u
  );
  for (const requiredCheck of [
    /projection_perspective[\s\S]*OPERATIONS/u,
    /projection_contract_version[\s\S]*= 1/u,
    /actor_role[\s\S]*admin[\s\S]*support[\s\S]*finance[\s\S]*moderator[\s\S]*founder/u,
    /purpose[\s\S]*btrim\(purpose\)[\s\S]*char_length\(purpose\)[\s\S]*10[\s\S]*500/u,
    /projection_sha256[\s\S]*\[a-f0-9\][\s\S]*repeat\('0'::text, 64\)/u,
  ]) {
    assert.match(constraintDefinitions, requiredCheck);
  }

  const indexes = await client.query(`
    SELECT indexname, indexdef
    FROM pg_catalog.pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'universal_v1_occurrence_access_audit'
    ORDER BY indexname
  `);
  assert.deepEqual(
    indexes.rows.map((index) => index.indexname),
    [
      'universal_v1_occurrence_access_actor_time',
      'universal_v1_occurrence_access_audit_pkey',
      'universal_v1_occurrence_access_task_time',
    ],
    'migration 139 must expose only its primary, actor-time, and TaskDraft-time indexes'
  );
  const indexDefinitions = Object.fromEntries(
    indexes.rows.map((index) => [index.indexname, index.indexdef])
  );
  assert.match(indexDefinitions.universal_v1_occurrence_access_audit_pkey, /UNIQUE[\s\S]*\(id\)$/u);
  assert.match(
    indexDefinitions.universal_v1_occurrence_access_actor_time,
    /\(actor_id, observed_at, id\)$/u
  );
  assert.match(
    indexDefinitions.universal_v1_occurrence_access_task_time,
    /\(task_draft_id, observed_at, id\)$/u
  );

  const triggers = await client.query(`
    SELECT trigger.tgname AS trigger_name,
           trigger.tgenabled AS enabled,
           trigger.tgtype::integer AS trigger_type,
           procedure.proname AS function_name,
           procedure.prosecdef AS security_definer,
           procedure.proconfig AS configuration,
           pg_catalog.pg_get_triggerdef(trigger.oid, true) AS trigger_definition,
           pg_catalog.pg_get_functiondef(procedure.oid) AS function_definition
    FROM pg_catalog.pg_trigger trigger
    JOIN pg_catalog.pg_proc procedure ON procedure.oid = trigger.tgfoid
    WHERE trigger.tgrelid =
            'public.universal_v1_occurrence_access_audit'::pg_catalog.regclass
      AND NOT trigger.tgisinternal
    ORDER BY trigger.tgname
  `);
  assert.deepEqual(
    triggers.rows.map((trigger) => ({
      triggerName: trigger.trigger_name,
      enabled: trigger.enabled,
      triggerType: trigger.trigger_type,
      functionName: trigger.function_name,
      securityDefiner: trigger.security_definer,
      configuration: trigger.configuration,
    })),
    [
      {
        triggerName: 'universal_v1_occurrence_access_insert_guard',
        enabled: 'O',
        triggerType: 7,
        functionName: 'enforce_universal_v1_occurrence_access_audit_v1',
        securityDefiner: true,
        configuration: ['search_path=pg_catalog, public'],
      },
      {
        triggerName: 'universal_v1_occurrence_access_no_mutation',
        enabled: 'O',
        triggerType: 27,
        functionName: 'prevent_universal_v1_occurrence_access_mutation_v1',
        securityDefiner: false,
        configuration: ['search_path=pg_catalog'],
      },
      {
        triggerName: 'universal_v1_occurrence_access_no_truncate',
        enabled: 'O',
        triggerType: 34,
        functionName: 'prevent_universal_v1_occurrence_access_mutation_v1',
        securityDefiner: false,
        configuration: ['search_path=pg_catalog'],
      },
    ],
    'migration 139 must expose one SECURITY DEFINER insert guard and immutable row/statement guards'
  );
  const insertGuard = triggers.rows.find(
    (trigger) => trigger.trigger_name === 'universal_v1_occurrence_access_insert_guard'
  );
  assert.match(insertGuard.trigger_definition, /BEFORE INSERT[\s\S]*FOR EACH ROW/u);
  assert.match(
    insertGuard.function_definition,
    /assert_universal_v1_ops_case_operator_v1\([\s\S]*NEW\.actor_id,[\s\S]*FALSE/u
  );
  assert.match(insertGuard.function_definition, /NEW\.actor_role IS DISTINCT FROM v_current_role/u);
  assert.match(insertGuard.function_definition, /NEW\.observed_at := clock_timestamp\(\)/u);
  const mutationGuard = triggers.rows.find(
    (trigger) => trigger.trigger_name === 'universal_v1_occurrence_access_no_mutation'
  );
  assert.match(mutationGuard.trigger_definition, /BEFORE DELETE OR UPDATE[\s\S]*FOR EACH ROW/u);
  assert.match(mutationGuard.function_definition, /HXUVOA3/u);
  const truncateGuard = triggers.rows.find(
    (trigger) => trigger.trigger_name === 'universal_v1_occurrence_access_no_truncate'
  );
  assert.match(truncateGuard.trigger_definition, /BEFORE TRUNCATE[\s\S]*FOR EACH STATEMENT/u);

  const acl = await client.query(`
    SELECT
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class relation
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
        ) privilege
        LEFT JOIN pg_catalog.pg_roles role ON role.oid = privilege.grantee
        WHERE relation.oid =
                'public.universal_v1_occurrence_access_audit'::pg_catalog.regclass
          AND (privilege.grantee = 0 OR role.rolname IN ('anon', 'authenticated'))
      ) AS table_ambient_access_revoked,
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc procedure
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
        ) privilege
        LEFT JOIN pg_catalog.pg_roles role ON role.oid = privilege.grantee
        WHERE procedure.oid IN (
          'public.enforce_universal_v1_occurrence_access_audit_v1()'::pg_catalog.regprocedure,
          'public.prevent_universal_v1_occurrence_access_mutation_v1()'::pg_catalog.regprocedure
        )
          AND (privilege.grantee = 0 OR role.rolname IN ('anon', 'authenticated'))
      ) AS function_ambient_access_revoked
  `);
  assert.deepEqual(acl.rows[0], {
    table_ambient_access_revoked: true,
    function_ambient_access_revoked: true,
  });
}

async function assertRejectsWithinOccurrenceSavepoint(
  client,
  statement,
  values,
  predicate,
  message
) {
  await client.query('SAVEPOINT occurrence_access_guard_check');
  try {
    await assert.rejects(client.query(statement, values), predicate, message);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT occurrence_access_guard_check');
    await client.query('RELEASE SAVEPOINT occurrence_access_guard_check');
  }
}

async function occurrenceAccessAuditSnapshot(client) {
  const result = await client.query(
    `
    SELECT to_jsonb(audit) AS row
    FROM public.universal_v1_occurrence_access_audit audit
    WHERE audit.task_draft_id = $1
    ORDER BY audit.id
  `,
    [OCCURRENCE_ACCESS_AUDIT_FIXTURE.taskDraftId]
  );
  return result.rows.map((row) => row.row);
}

async function assertOccurrenceAccessAudit(url, exactMigrationSql) {
  assert.equal(typeof exactMigrationSql, 'string', 'registered migration-139 SQL must be loaded');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await assertOccurrenceAccessAuditCatalog(client);
    const ledgerBeforeRawReplay = await client.query(
      'SELECT name, sha256, applied_at FROM applied_migrations WHERE name = $1',
      [OCCURRENCE_ACCESS_AUDIT_MIGRATION]
    );
    assert.equal(ledgerBeforeRawReplay.rows.length, 1);

    await client.query('BEGIN');
    await client.query(
      `
      INSERT INTO public.users(
        id, email, full_name, default_mode, account_status, is_minor, is_banned
      )
      VALUES ($1, 'hx-occurrence-verifier@e2e.invalid',
              'HX Occurrence Verifier', 'poster', 'ACTIVE', FALSE, FALSE)
    `,
      [OCCURRENCE_ACCESS_AUDIT_FIXTURE.actorId]
    );
    await client.query(
      `
      INSERT INTO public.admin_roles(user_id, role, can_manage_operations)
      VALUES ($1, 'support', TRUE)
    `,
      [OCCURRENCE_ACCESS_AUDIT_FIXTURE.actorId]
    );
    await client.query(
      `
      INSERT INTO public.task_drafts(
        id, submission_id, card_token_hash, raw_input, universal_contract_version
      ) VALUES ($1, $2,
                encode(public.digest(
                  'hx-occurrence-audit-verifier:' || current_database(), 'sha256'
                ), 'hex'),
                'Synthetic migration-139 PostgreSQL verifier fixture', 1)
    `,
      [OCCURRENCE_ACCESS_AUDIT_FIXTURE.taskDraftId, OCCURRENCE_ACCESS_AUDIT_FIXTURE.submissionId]
    );
    const inserted = await client.query(
      `
      INSERT INTO public.universal_v1_occurrence_access_audit(
        task_draft_id, actor_id, actor_role, purpose,
        projection_sha256, observed_at
      ) VALUES ($1, $2, 'support', $3, $4,
                TIMESTAMPTZ '2000-01-01 00:00:00+00')
      RETURNING actor_role, purpose, projection_sha256,
                observed_at > TIMESTAMPTZ '2020-01-01 00:00:00+00' AS database_observed
    `,
      [
        OCCURRENCE_ACCESS_AUDIT_FIXTURE.taskDraftId,
        OCCURRENCE_ACCESS_AUDIT_FIXTURE.actorId,
        OCCURRENCE_ACCESS_AUDIT_FIXTURE.purpose,
        OCCURRENCE_ACCESS_AUDIT_FIXTURE.auditDigest,
      ]
    );
    assert.deepEqual(inserted.rows[0], {
      actor_role: 'support',
      purpose: OCCURRENCE_ACCESS_AUDIT_FIXTURE.purpose,
      projection_sha256: OCCURRENCE_ACCESS_AUDIT_FIXTURE.auditDigest,
      database_observed: true,
    });
    const immutableBeforeReplay = await occurrenceAccessAuditSnapshot(client);
    assert.equal(immutableBeforeReplay.length, 1);

    for (let rawReplayNumber = 1; rawReplayNumber <= 2; rawReplayNumber += 1) {
      await client.query(exactMigrationSql);
      await assertOccurrenceAccessAuditCatalog(client);
      assert.deepEqual(
        await occurrenceAccessAuditSnapshot(client),
        immutableBeforeReplay,
        `raw migration-139 replay ${rawReplayNumber} must preserve exact audit evidence`
      );
      assert.deepEqual(
        (
          await client.query(
            'SELECT name, sha256, applied_at FROM applied_migrations WHERE name = $1',
            [OCCURRENCE_ACCESS_AUDIT_MIGRATION]
          )
        ).rows,
        ledgerBeforeRawReplay.rows,
        `raw migration-139 replay ${rawReplayNumber} must not rewrite its registered receipt`
      );
    }

    await assertRejectsWithinOccurrenceSavepoint(
      client,
      `INSERT INTO public.universal_v1_occurrence_access_audit(
         task_draft_id, actor_id, actor_role, purpose, projection_sha256
       ) VALUES ($1, $2, 'admin', $3, $4)`,
      [
        OCCURRENCE_ACCESS_AUDIT_FIXTURE.taskDraftId,
        OCCURRENCE_ACCESS_AUDIT_FIXTURE.actorId,
        'Reject forged current-role evidence.',
        OCCURRENCE_ACCESS_AUDIT_FIXTURE.auditDigest,
      ],
      (error) => error?.code === 'P0001' && /HXUVOA1/u.test(error.message),
      'migration 139 must reject actor-role forgery'
    );

    await client.query(
      'UPDATE public.admin_roles SET can_manage_operations = FALSE WHERE user_id = $1',
      [OCCURRENCE_ACCESS_AUDIT_FIXTURE.actorId]
    );
    await assertRejectsWithinOccurrenceSavepoint(
      client,
      `INSERT INTO public.universal_v1_occurrence_access_audit(
         task_draft_id, actor_id, actor_role, purpose, projection_sha256
       ) VALUES ($1, $2, 'support', $3, $4)`,
      [
        OCCURRENCE_ACCESS_AUDIT_FIXTURE.taskDraftId,
        OCCURRENCE_ACCESS_AUDIT_FIXTURE.actorId,
        'Reject evidence after current authority revocation.',
        OCCURRENCE_ACCESS_AUDIT_FIXTURE.auditDigest,
      ],
      (error) => error?.code === 'P0001' && /HXUOC1/u.test(error.message),
      'migration 139 must recheck current named-operator authority'
    );
    await client.query(
      'UPDATE public.admin_roles SET can_manage_operations = TRUE WHERE user_id = $1',
      [OCCURRENCE_ACCESS_AUDIT_FIXTURE.actorId]
    );

    for (const statement of [
      `UPDATE public.universal_v1_occurrence_access_audit
       SET purpose = 'Mutation is forbidden by append-only evidence.'
       WHERE task_draft_id = $1`,
      `DELETE FROM public.universal_v1_occurrence_access_audit
       WHERE task_draft_id = $1`,
      'TRUNCATE TABLE public.universal_v1_occurrence_access_audit',
    ]) {
      await assertRejectsWithinOccurrenceSavepoint(
        client,
        statement,
        statement.startsWith('TRUNCATE') ? [] : [OCCURRENCE_ACCESS_AUDIT_FIXTURE.taskDraftId],
        (error) => error?.code === 'P0001' && /HXUVOA3/u.test(error.message),
        'migration 139 must reject update, delete, and truncate'
      );
      assert.deepEqual(await occurrenceAccessAuditSnapshot(client), immutableBeforeReplay);
    }
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
}

async function loadRegisteredMigration(name) {
  const runtime = productionMigrationRuntime();
  const spec = runtime.migrationSpecs.find((candidate) => candidate.name === name);
  assert.ok(spec, `${name} must be present in the exact runtime registry`);
  return loadMigrationSql(runtime, spec);
}

async function verifyFresh(url) {
  const first = await runCanonicalMigrationPlan(url, 'applied');
  assert.equal(first.length, REQUIRED_MIGRATION_FILES.length);
  const replay = await runCanonicalMigrationPlan(url, 'already_applied');
  assert.equal(replay.length, REQUIRED_MIGRATION_FILES.length);
  await assertExactRegistry(url);
  await assertHardAssignmentAliasContainment(url);
  await assertLegacyEscrowContainment(url);
  const occurrenceAccessAudit = await loadRegisteredMigration(OCCURRENCE_ACCESS_AUDIT_MIGRATION);
  await assertOccurrenceAccessAudit(url, occurrenceAccessAudit.sql);
}

async function verifyUpgrade(url) {
  const runtime = productionMigrationRuntime();
  runtime.databaseUrl = url;
  const client = runtime.createClient(url);
  let recoveredHistoricalLegacyEscrow = null;
  let occurrenceAccessAuditSql = null;
  await client.connect();
  try {
    const plan = await authorizeCanonicalMigrationPlan(client, runtime, url);
    assert.ok(plan.baseline, 'upgrade plan must include the constitutional baseline');
    await ensureConstitutionalBaseline(client, plan.baseline, plan.session);

    const splitIndex = runtime.migrationSpecs.findIndex(
      (spec) => spec.name === '20260720_offline_action_sync_contract'
    );
    assert.ok(splitIndex > 0, 'upgrade split migration must be registered');

    for (let index = 0; index < splitIndex; index += 1) {
      const spec = runtime.migrationSpecs[index];
      const migration = plan.migrations[index];
      assert.equal(migration.name, spec.name, 'authorized pre-split plan order must be exact');
      const outcome = await applyEngineAutomationMigration(
        client,
        migration.sql,
        migration.sourcePath,
        plan.session,
        spec.name
      );
      assert.equal(outcome.status, 'applied');
    }

    const seed = executableSql(
      await readFile(
        path.resolve('backend/tests/integration/upgrade-convergence-seed.pg.sql'),
        'utf8'
      )
    );
    await client.query(seed);

    let legacyLeadCountBeforePort = null;
    let taskDraftClaimUpgradeBaseline = null;
    let taskDraftClaimUpgradeObservations = null;
    let historicalLegacyEscrowBeforeContainment = null;
    let completionNoticeRawReplayProven = false;
    let completionEraUpgradeAssertionsProven = false;
    for (let index = splitIndex; index < runtime.migrationSpecs.length; index += 1) {
      const spec = runtime.migrationSpecs[index];
      const migration = plan.migrations[index];
      assert.equal(migration.name, spec.name, 'authorized tail plan order must be exact');
      if (spec.name === '20260901_universal_v1_lead_ingress_port') {
        const before = await client.query('SELECT COUNT(*)::integer AS count FROM leads');
        legacyLeadCountBeforePort = before.rows[0].count;
        await client.query(`
          INSERT INTO leads(
            id, submission_id, lead_type, email, name, status, source, consent_version
          ) VALUES (
            'b6000000-0000-4000-8000-000000000001',
            'b6000000-0000-4000-8000-000000000002',
            'poster', 'hxupgrade-lead@e2e.invalid', 'HX Upgrade Lead',
            'new', 'legacy_supabase_lead_submit', 'v1'
          )
        `);
      }
      if (spec.name === OCCURRENCE_ACCESS_AUDIT_MIGRATION) {
        occurrenceAccessAuditSql = migration.sql;
        const completionEraAssertions = executableSql(
          await readFile(
            path.resolve('backend/tests/integration/upgrade-convergence-assert.pg.sql'),
            'utf8'
          )
        );
        await client.query(completionEraAssertions);
        completionEraUpgradeAssertionsProven = true;
      }
      if (spec.name === LEGACY_ESCROW_CONTAINMENT_MIGRATION) {
        await client.query(
          `
          INSERT INTO public.escrows(
            id, task_id, amount, state, stripe_payment_intent_id, funded_at
          ) VALUES ($1, $2, 7500, 'FUNDED', $3, TIMESTAMPTZ '2026-08-22 00:00:00+00')
        `,
          [
            LEGACY_ESCROW_UPGRADE_FIXTURE.id,
            LEGACY_ESCROW_UPGRADE_FIXTURE.taskId,
            LEGACY_ESCROW_UPGRADE_FIXTURE.paymentIntentId,
          ]
        );
        historicalLegacyEscrowBeforeContainment = await legacyEscrowSnapshot(
          client,
          LEGACY_ESCROW_UPGRADE_FIXTURE.id
        );
      }
      if (spec.name === '20260903_universal_v1_task_draft_account_claim') {
        const claimUpgradeSeed = executableSql(
          await readFile(
            path.resolve(
              'backend/tests/integration/universal-v1-task-draft-claim-upgrade-seed.pg.sql'
            ),
            'utf8'
          )
        );
        await client.query('BEGIN');
        let transactionStarted = true;
        try {
          await client.query(claimUpgradeSeed);
          await client.query(
            'SET CONSTRAINTS task_draft_legacy_import_receipt_presence_guard IMMEDIATE'
          );
          transactionStarted = false;
          await client.query('COMMIT');
        } catch (error) {
          if (transactionStarted) {
            await client.query('ROLLBACK').catch(() => undefined);
          }
          throw error;
        }
        taskDraftClaimUpgradeBaseline = await taskDraftClaimUpgradeSnapshot(client);
        await client.query(`
          INSERT INTO users(id, email, full_name, default_mode)
          VALUES (
            'b7000000-0000-4000-8000-000000000001',
            'hxupgrade-orphan-claim@e2e.invalid',
            'HX Upgrade Orphan Claim',
            'poster'
          );
          INSERT INTO leads(id, submission_id, lead_type, email, user_id)
          VALUES (
            'b7000000-0000-4000-8000-000000000002',
            'b7000000-0000-4000-8000-000000000003',
            'poster',
            'hxupgrade-orphan-claim@e2e.invalid',
            'b7000000-0000-4000-8000-000000000001'
          );
          INSERT INTO task_drafts(
            id, submission_id, card_token_hash, raw_input, structured,
            status, source, utm, lead_id, poster_user_id, claimed_at,
            universal_contract_version, ingress_contract_version,
            ingress_origin, card_token_contract_version
          ) VALUES (
            'b7000000-0000-4000-8000-000000000004',
            'b7000000-0000-4000-8000-000000000005',
            repeat('7', 64),
            'Precontract orphan claim must not be synthesized',
            '{}'::jsonb,
            'account_claimed',
            'upgrade_contract_test',
            '{}'::jsonb,
            'b7000000-0000-4000-8000-000000000002',
            'b7000000-0000-4000-8000-000000000001',
            clock_timestamp(),
            1, 1, 'BACKEND_POSTGRESQL', 1
          );
        `);
        await assert.rejects(
          applyEngineAutomationMigration(
            client,
            migration.sql,
            migration.sourcePath,
            plan.session,
            spec.name
          ),
          /HXUV1-TD-CLAIM-4/u,
          'upgrade must refuse a canonical orphan claim instead of synthesizing evidence'
        );
        const refused = await client.query(
          `
          SELECT
            to_regclass('public.task_draft_account_claim_events') AS event_table,
            to_regclass('public.task_draft_precontract_claim_observations')
              AS observation_table,
            (SELECT COUNT(*)::integer FROM applied_migrations WHERE name = $1) AS ledger_rows
        `,
          [spec.name]
        );
        assert.deepEqual(refused.rows[0], {
          event_table: null,
          observation_table: null,
          ledger_rows: 0,
        });
        assert.deepEqual(
          await taskDraftClaimUpgradeSnapshot(client),
          taskDraftClaimUpgradeBaseline,
          'refused canonical orphan adoption must preserve every source and target fixture row'
        );
        await client.query(`
          DELETE FROM task_drafts
          WHERE id = 'b7000000-0000-4000-8000-000000000004';
        `);
      }
      if (spec.name === COMPLETION_NOTICE_MIGRATION) {
        await seedPartialCompletionReceipt(client);
        const partialReceiptBeforeRefusal = await partialCompletionReceiptSnapshot(client);
        assert.equal(
          partialReceiptBeforeRefusal.length,
          1,
          'migration-121 nullable CHECK must admit the controlled partial audit fixture'
        );
        await assert.rejects(
          applyEngineAutomationMigration(
            client,
            migration.sql,
            migration.sourcePath,
            plan.session,
            spec.name
          ),
          (error) =>
            error?.code === 'P0001' && error?.message === PARTIAL_COMPLETION_RECEIPT_UPGRADE_ERROR,
          'migration 138 must refuse partial legacy completion-receipt audit truth by name'
        );
        const refused = await client.query(
          `
          SELECT
            to_regclass('public.task_completion_notice_requests') AS notice_table,
            EXISTS (
              SELECT 1
              FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = 'email_outbox'
                AND column_name = 'task_completion_notice_request_id'
            ) AS email_binding_column,
            (SELECT COUNT(*)::integer FROM applied_migrations WHERE name = $1) AS ledger_rows
        `,
          [spec.name]
        );
        assert.deepEqual(refused.rows[0], {
          notice_table: null,
          email_binding_column: false,
          ledger_rows: 0,
        });
        assert.deepEqual(
          await partialCompletionReceiptSnapshot(client),
          partialReceiptBeforeRefusal,
          'controlled migration refusal must preserve the malformed historical row byte-for-byte'
        );
        await removePartialCompletionReceipt(client);
        assert.deepEqual(await partialCompletionReceiptSnapshot(client), []);
      }
      const outcome = await applyEngineAutomationMigration(
        client,
        migration.sql,
        migration.sourcePath,
        plan.session,
        spec.name
      );
      assert.equal(outcome.status, 'applied');
      if (spec.name === COMPLETION_NOTICE_MIGRATION) {
        const ledgerBeforeRawReplay = await client.query(
          'SELECT name, sha256, applied_at FROM applied_migrations WHERE name = $1',
          [spec.name]
        );
        assert.equal(ledgerBeforeRawReplay.rows.length, 1);
        await client.query(migration.sql);
        const ledgerAfterRawReplay = await client.query(
          'SELECT name, sha256, applied_at FROM applied_migrations WHERE name = $1',
          [spec.name]
        );
        assert.deepEqual(
          ledgerAfterRawReplay.rows,
          ledgerBeforeRawReplay.rows,
          'raw migration-138 replay must not rewrite the registered migration receipt'
        );
        const replayCatalog = await client.query(`
          SELECT
            to_regclass('public.task_completion_notice_requests') IS NOT NULL AS notice_table,
            EXISTS (
              SELECT 1 FROM pg_constraint
              WHERE conname = 'task_completion_delivery_universal_v1_shape_check'
                AND conrelid = 'public.task_completion_delivery_events'::regclass
                AND convalidated
            ) AS receipt_shape_validated,
            EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = 'users'
                AND column_name = 'do_not_email'
            ) AS recipient_opt_out_column
        `);
        assert.deepEqual(replayCatalog.rows[0], {
          notice_table: true,
          receipt_shape_validated: true,
          recipient_opt_out_column: true,
        });
        completionNoticeRawReplayProven = true;
      }
      if (spec.name === LEGACY_ESCROW_CONTAINMENT_MIGRATION) {
        assert.ok(
          historicalLegacyEscrowBeforeContainment,
          'historical legacy escrow baseline must be captured before containment'
        );
        assert.deepEqual(
          await legacyEscrowSnapshot(client, LEGACY_ESCROW_UPGRADE_FIXTURE.id),
          historicalLegacyEscrowBeforeContainment,
          'containment migration must preserve the pre-existing legacy escrow byte-for-byte'
        );
        await assertLegacyEscrowContainmentCatalog(client);
        await assertLegacyEscrowInsertDenied(client);

        const recovery = await client.query(
          `
          UPDATE public.escrows
          SET state = 'REFUNDED',
              refund_amount = amount,
              stripe_refund_id = $2,
              refunded_at = TIMESTAMPTZ '2026-08-22 01:00:00+00',
              updated_at = TIMESTAMPTZ '2026-08-22 01:00:00+00',
              version = version + 1
          WHERE id = $1
          RETURNING state, refund_amount, stripe_refund_id, version, refunded_at
        `,
          [LEGACY_ESCROW_UPGRADE_FIXTURE.id, LEGACY_ESCROW_UPGRADE_FIXTURE.refundId]
        );
        assert.deepEqual(
          recovery.rows[0],
          {
            state: 'REFUNDED',
            refund_amount: 7500,
            stripe_refund_id: LEGACY_ESCROW_UPGRADE_FIXTURE.refundId,
            version: historicalLegacyEscrowBeforeContainment.version + 1,
            refunded_at: new Date('2026-08-22T01:00:00.000Z'),
          },
          'negative UPDATE-based refund recovery must remain possible for a historical escrow'
        );
        recoveredHistoricalLegacyEscrow = await legacyEscrowSnapshot(
          client,
          LEGACY_ESCROW_UPGRADE_FIXTURE.id
        );

        // Re-run the raw migration, not only its ledger short-circuit, to prove
        // trigger replacement preserves recovered history and stays fail-closed.
        await client.query(migration.sql);
        await assertLegacyEscrowContainmentCatalog(client);
        await assertLegacyEscrowInsertDenied(client);
        assert.deepEqual(
          await legacyEscrowSnapshot(client, LEGACY_ESCROW_UPGRADE_FIXTURE.id),
          recoveredHistoricalLegacyEscrow,
          'raw containment replay must preserve the recovered historical escrow exactly'
        );
      }
      if (spec.name === '20260903_universal_v1_task_draft_account_claim') {
        assert.ok(taskDraftClaimUpgradeBaseline, 'claim upgrade baseline must be captured');
        await assertTaskDraftClaimUpgradeMatrix(client, taskDraftClaimUpgradeBaseline);
        taskDraftClaimUpgradeObservations = await taskDraftClaimObservationSnapshot(client);
        assert.equal(taskDraftClaimUpgradeObservations.length, 2);

        // Execute the raw SQL a second time, not only the migration-ledger
        // short-circuit, so ON CONFLICT and trigger recreation idempotency are
        // proven against the exact precontract observations.
        await client.query(migration.sql);
        await assertTaskDraftClaimUpgradeMatrix(client, taskDraftClaimUpgradeBaseline);
        assert.deepEqual(
          await taskDraftClaimObservationSnapshot(client),
          taskDraftClaimUpgradeObservations,
          'raw 20260903 rerun must preserve observation ids and observed_at timestamps'
        );
        await assertTaskDraftClaimObservationImmutability(
          client,
          taskDraftClaimUpgradeObservations
        );
      }
      if (spec.name === '20260901_universal_v1_lead_ingress_port') {
        const evidence = await client.query(`
          SELECT
            (SELECT COUNT(*)::integer FROM leads) AS lead_count,
            ingress_contract_version,
            ingress_request_hash,
            execution_environment,
            turnstile_action,
            (SELECT convalidated FROM pg_constraint
              WHERE conname = 'email_outbox_exactly_one_owner'
                AND conrelid = 'email_outbox'::regclass) AS owner_constraint_validated
          FROM leads
          WHERE id = 'b6000000-0000-4000-8000-000000000001'
        `);
        assert.deepEqual(
          evidence.rows[0],
          {
            lead_count: legacyLeadCountBeforePort + 1,
            ingress_contract_version: 0,
            ingress_request_hash: null,
            execution_environment: null,
            turnstile_action: null,
            owner_constraint_validated: true,
          },
          'legacy lead count and version-0 semantics must survive the append-only port'
        );
      }
      if (spec.name === '20260904_canonical_user_email_identity') {
        await client.query(`
          INSERT INTO task_drafts(
            id, submission_id, card_token_hash, raw_input, structured,
            status, source, utm, poster_user_id,
            universal_contract_version, ingress_contract_version,
            ingress_origin, card_token_contract_version
          ) VALUES (
            '${TASK_DRAFT_CLAIM_REPAIR_GAP_ID}',
            'f3000000-0000-4000-8000-00000000000a',
            encode(digest('hx-upgrade-poster-only-gap-token', 'sha256'), 'hex'),
            'Poster-only version-zero gap before 20260905', '{}'::jsonb,
            'draft', 'upgrade_contract_test', '{}'::jsonb,
            'f1000000-0000-4000-8000-000000000001',
            0, 0, 'UNCLASSIFIED_V0', 0
          )
        `);
        const gapBeforeRepair = await client.query(
          `
          SELECT COUNT(*)::integer AS observations
          FROM task_draft_precontract_claim_observations
          WHERE task_draft_id = $1
        `,
          [TASK_DRAFT_CLAIM_REPAIR_GAP_ID]
        );
        assert.deepEqual(gapBeforeRepair.rows[0], { observations: 0 });
      }
      if (spec.name === '20260905_universal_v1_task_draft_legacy_claim_import_repair') {
        assert.ok(taskDraftClaimUpgradeBaseline, 'claim upgrade baseline must remain available');
        assert.ok(taskDraftClaimUpgradeObservations, 'claim observations must remain available');
        await assertTaskDraftClaimUpgradeMatrix(client, taskDraftClaimUpgradeBaseline);
        await assertTaskDraftClaimRepairMatrix(client);
        assert.deepEqual(
          await taskDraftClaimObservationSnapshot(client),
          taskDraftClaimUpgradeObservations,
          '20260905 must not replace or retimestamp existing observations'
        );

        const repairObservationIds = [
          ...TASK_DRAFT_CLAIM_UPGRADE_DRAFT_IDS,
          TASK_DRAFT_CLAIM_REPAIR_GAP_ID,
        ];
        const repairObservations = await taskDraftClaimObservationSnapshot(
          client,
          repairObservationIds
        );
        assert.equal(repairObservations.length, 3);
        await client.query(migration.sql);
        await assertTaskDraftClaimUpgradeMatrix(client, taskDraftClaimUpgradeBaseline);
        await assertTaskDraftClaimRepairMatrix(client);
        assert.deepEqual(
          await taskDraftClaimObservationSnapshot(client, repairObservationIds),
          repairObservations,
          'raw 20260905 rerun must preserve every immutable observation'
        );

        await assertPostRepairClaimLikeInsertRejected(client, [
          'f7000000-0000-4000-8000-000000000001',
          'f7000000-0000-4000-8000-000000000002',
          '0'.repeat(64),
          'draft',
          'f1000000-0000-4000-8000-000000000001',
          null,
          0,
          0,
          'UNCLASSIFIED_V0',
          0,
        ]);
        await assertPostRepairClaimLikeInsertRejected(client, [
          'f7000000-0000-4000-8000-000000000003',
          'f7000000-0000-4000-8000-000000000004',
          '1'.repeat(64),
          'draft',
          'f1000000-0000-4000-8000-000000000001',
          null,
          1,
          1,
          'BACKEND_POSTGRESQL',
          1,
        ]);
        await assertPostRepairClaimLikeInsertRejected(client, [
          'f7000000-0000-4000-8000-000000000005',
          'f7000000-0000-4000-8000-000000000006',
          '2'.repeat(64),
          'draft',
          'f1000000-0000-4000-8000-000000000001',
          null,
          0,
          0,
          'LEGACY_SUPABASE_TASK_DRAFT_PUBLIC',
          0,
        ]);
      }
    }

    await finishCanonicalMigrationPlan(client, plan);

    const recoveryContract = executableSql(
      await readFile(
        path.resolve('backend/tests/integration/quote-payment-recovery-contract.pg.sql'),
        'utf8'
      )
    );
    await client.query(recoveryContract);
    assert.ok(
      recoveredHistoricalLegacyEscrow,
      'upgrade must exercise legacy escrow recovery before ledger replay'
    );
    assert.equal(
      completionNoticeRawReplayProven,
      true,
      'upgrade must execute the exact migration-138 SQL a second time'
    );
    assert.equal(
      completionEraUpgradeAssertionsProven,
      true,
      'upgrade must prove the frozen 138-migration convergence snapshot immediately before 139'
    );
  } finally {
    await client.end();
  }
  const replay = await runCanonicalMigrationPlan(url, 'already_applied');
  assert.equal(replay.length, REQUIRED_MIGRATION_FILES.length);
  await assertExactRegistry(url);
  await assertHardAssignmentAliasContainment(url);
  await assertLegacyEscrowContainment(url, recoveredHistoricalLegacyEscrow);
  await assertOccurrenceAccessAudit(url, occurrenceAccessAuditSql);
}

async function verifyRecoveryTimestampPrecision(url) {
  const runtime = productionMigrationRuntime();
  runtime.databaseUrl = url;
  const fixtureClient = runtime.createClient(url);
  await fixtureClient.connect();
  try {
    const replay = await consumeCanonicalMigrationPlan(
      fixtureClient,
      runtime,
      url,
      'already_applied'
    );
    assert.equal(replay.length, REQUIRED_MIGRATION_FILES.length);
    await fixtureClient.query(`
      INSERT INTO users(id, email, full_name, default_mode)
      VALUES (
        'd1000000-0000-4000-8000-000000000001',
        'hx-recovery-precision@e2e.invalid',
        'HX Recovery Precision',
        'poster'
      );

      INSERT INTO leads(id, submission_id, lead_type, email, user_id)
      VALUES (
        'd2000000-0000-4000-8000-000000000001',
        'd2000000-0000-4000-8000-000000000002',
        'poster',
        'hx-recovery-precision@e2e.invalid',
        'd1000000-0000-4000-8000-000000000001'
      );

      INSERT INTO task_drafts(
        id, submission_id, card_token_hash, raw_input, lead_id
      ) VALUES (
        'd3000000-0000-4000-8000-000000000001',
        'd3000000-0000-4000-8000-000000000002',
        repeat('e', 64),
        'Recovery precision fixture',
        'd2000000-0000-4000-8000-000000000001'
      );

      INSERT INTO quotes(id, lead_id, task_draft_id, title, status)
      VALUES (
        'd4000000-0000-4000-8000-000000000001',
        'd2000000-0000-4000-8000-000000000001',
        'd3000000-0000-4000-8000-000000000001',
        'Recovery precision quote',
        'quote_ready'
      );

      INSERT INTO quote_versions(
        id, quote_id, version_number, customer_description, total_cents, pay_token
      ) VALUES (
        'd5000000-0000-4000-8000-000000000001',
        'd4000000-0000-4000-8000-000000000001',
        1,
        'Recovery precision quote version',
        12500,
        repeat('f', 32)
      );

      UPDATE quotes
      SET active_version_id = 'd5000000-0000-4000-8000-000000000001'
      WHERE id = 'd4000000-0000-4000-8000-000000000001';

      INSERT INTO quote_payments(
        id, quote_id, quote_version_id, provider, provider_payment_id,
        amount_cents, status, updated_at
      ) VALUES (
        'd6000000-0000-4000-8000-000000000001',
        'd4000000-0000-4000-8000-000000000001',
        'd5000000-0000-4000-8000-000000000001',
        'stripe',
        'pi_quote_recovery_precision',
        12500,
        'PENDING',
        TIMESTAMPTZ '2026-08-23 00:00:00.123456+00'
      );
    `);
  } finally {
    await fixtureClient.end();
  }

  const previousPaymentCreationMode = process.env.HX_PAYMENT_CREATION_MODE;
  process.env.HX_PAYMENT_CREATION_MODE = 'frozen';
  const recoveryClient = runtime.createClient(url);
  try {
    await recoveryClient.connect();
    const { recoverOrphanQuotePayment } =
      await import('../dist/backend/src/services/QuotePaymentRecoveryService.js');
    // This standalone verifier owns a connection to its allowlisted fixture
    // database. It must not install or bypass the application's attested runtime.
    const database = {
      query: (sql, params) => recoveryClient.query(sql, params),
      async transaction(work) {
        await recoveryClient.query('BEGIN');
        try {
          const value = await work(database.query);
          await recoveryClient.query('COMMIT');
          return value;
        } catch (error) {
          await recoveryClient.query('ROLLBACK');
          throw error;
        }
      },
    };
    const result = await recoverOrphanQuotePayment(
      {
        quoteId: 'd4000000-0000-4000-8000-000000000001',
        quoteVersionId: 'd5000000-0000-4000-8000-000000000001',
        posterId: 'd1000000-0000-4000-8000-000000000001',
        paymentIntentId: 'pi_quote_recovery_precision',
        reasonCode: 'UNDERWRITING_CONTAINMENT',
      },
      {
        persistedProvider: 'stripe',
        recoverOrphanPayment: async () => ({
          success: true,
          data: {
            disposition: 'VOIDED',
            providerStatus: 'canceled',
            providerOperationId: 'pi_quote_recovery_precision',
          },
        }),
      },
      database
    );
    assert.deepEqual(result, {
      success: true,
      data: {
        quoteId: 'd4000000-0000-4000-8000-000000000001',
        quoteVersionId: 'd5000000-0000-4000-8000-000000000001',
        paymentIntentId: 'pi_quote_recovery_precision',
        status: 'FAILED',
        recoveryAction: 'VOIDED',
        replayed: false,
      },
    });
    const evidence = await database.query(`
      SELECT payment.status,
             operation.operation_state,
             operation.expected_payment_updated_at =
               TIMESTAMPTZ '2026-08-23 00:00:00.123456+00' AS witness_exact,
             EXISTS (
               SELECT 1
               FROM quote_payment_recovery_events event
               WHERE event.recovery_operation_id = operation.id
                 AND event.event_type = 'COMPLETED'
             ) AS completed_event
      FROM quote_payments payment
      JOIN quote_payment_recovery_operations operation
        ON operation.quote_payment_id = payment.id
      WHERE payment.id = 'd6000000-0000-4000-8000-000000000001'
    `);
    assert.deepEqual(evidence.rows[0], {
      status: 'FAILED',
      operation_state: 'COMPLETED',
      witness_exact: true,
      completed_event: true,
    });
  } finally {
    if (previousPaymentCreationMode === undefined) delete process.env.HX_PAYMENT_CREATION_MODE;
    else process.env.HX_PAYMENT_CREATION_MODE = previousPaymentCreationMode;
    await recoveryClient.end();
  }
}

export async function main(env = process.env) {
  const adminDatabaseUrl = env.DATABASE_URL?.trim();
  assertMigrationVerificationAuthority(env, adminDatabaseUrl);
  assertTaskLocationCryptoConfigured();
  const authorityEnv = Object.freeze({
    NODE_ENV: env.NODE_ENV,
    HX_ALLOW_CI_DB_RECREATE: env.HX_ALLOW_CI_DB_RECREATE,
    DATABASE_URL: adminDatabaseUrl,
  });

  await recreateDatabase(adminDatabaseUrl, MIGRATION_VERIFICATION_DATABASES.fresh, authorityEnv);
  await recreateDatabase(adminDatabaseUrl, MIGRATION_VERIFICATION_DATABASES.upgrade, authorityEnv);

  await verifyFresh(databaseUrl(adminDatabaseUrl, MIGRATION_VERIFICATION_DATABASES.fresh));
  const upgradeDatabaseUrl = databaseUrl(
    adminDatabaseUrl,
    MIGRATION_VERIFICATION_DATABASES.upgrade
  );
  await verifyUpgrade(upgradeDatabaseUrl);
  await verifyRecoveryTimestampPrecision(upgradeDatabaseUrl);
  process.stdout.write(`HXOS_ENGINE_MIGRATIONS_POSTGRES_OK ${REQUIRED_MIGRATION_FILES.length}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
