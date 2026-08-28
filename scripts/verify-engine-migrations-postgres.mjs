import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import {
  applyEngineAutomationMigration,
  loadMigrationSql,
  productionMigrationRuntime,
  runEngineAutomationMigration,
} from '../dist/backend/src/jobs/engine-automation-migration.js';
import { REQUIRED_MIGRATION_FILES } from '../dist/backend/src/jobs/engine-automation-migration-files.js';
import { validatePreparationPolicy } from './prepare-test-databases.mjs';

const { Client } = pg;

export const MIGRATION_VERIFICATION_DATABASES = Object.freeze({
  fresh: 'hx_ci_fresh_test',
  upgrade: 'hx_ci_upgrade_test',
});
const MIGRATION_VERIFICATION_DATABASE_SET = new Set(
  Object.values(MIGRATION_VERIFICATION_DATABASES)
);

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

async function verifyFresh(url) {
  process.env.DATABASE_URL = url;
  const first = await runEngineAutomationMigration();
  assert.equal(first.length, REQUIRED_MIGRATION_FILES.length);
  assert.ok(first.every((outcome) => outcome.status === 'applied'));
  const replay = await runEngineAutomationMigration();
  assert.ok(replay.every((outcome) => outcome.status === 'already_applied'));
  await assertExactRegistry(url);
  await assertHardAssignmentAliasContainment(url);
}

async function verifyUpgrade(url) {
  const runtime = productionMigrationRuntime();
  runtime.databaseUrl = url;
  const client = runtime.createClient(url);
  await client.connect();
  try {
    const baseline = await readFile(
      path.resolve('backend/database/constitutional-schema.sql'),
      'utf8'
    );
    await client.query(baseline);

    const splitIndex = runtime.migrationSpecs.findIndex(
      (spec) => spec.name === '20260720_offline_action_sync_contract'
    );
    assert.ok(splitIndex > 0, 'upgrade split migration must be registered');

    for (const spec of runtime.migrationSpecs.slice(0, splitIndex)) {
      const migration = await loadMigrationSql(runtime, spec);
      const outcome = await applyEngineAutomationMigration(
        client,
        migration.sql,
        migration.sourcePath,
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
    for (const spec of runtime.migrationSpecs.slice(splitIndex)) {
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
      const migration = await loadMigrationSql(runtime, spec);
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
        try {
          await client.query(claimUpgradeSeed);
          await client.query(
            'SET CONSTRAINTS task_draft_legacy_import_receipt_presence_guard IMMEDIATE'
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
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
          applyEngineAutomationMigration(client, migration.sql, migration.sourcePath, spec.name),
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
      const outcome = await applyEngineAutomationMigration(
        client,
        migration.sql,
        migration.sourcePath,
        spec.name
      );
      assert.equal(outcome.status, 'applied');
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

    const assertions = executableSql(
      await readFile(
        path.resolve('backend/tests/integration/upgrade-convergence-assert.pg.sql'),
        'utf8'
      )
    );
    await client.query(assertions);

    const recoveryContract = executableSql(
      await readFile(
        path.resolve('backend/tests/integration/quote-payment-recovery-contract.pg.sql'),
        'utf8'
      )
    );
    await client.query(recoveryContract);

    for (const spec of runtime.migrationSpecs) {
      const migration = await loadMigrationSql(runtime, spec);
      const outcome = await applyEngineAutomationMigration(
        client,
        migration.sql,
        migration.sourcePath,
        spec.name
      );
      assert.equal(outcome.status, 'already_applied');
    }
  } finally {
    await client.end();
  }
  await assertExactRegistry(url);
  await assertHardAssignmentAliasContainment(url);
}

async function verifyRecoveryTimestampPrecision(url) {
  const fixtureClient = new Client({ connectionString: url });
  await fixtureClient.connect();
  try {
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

  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = 'test';
  process.env.HX_PAYMENT_CREATION_MODE = 'frozen';
  const [{ recoverOrphanQuotePayment }, { db }] = await Promise.all([
    import('../dist/backend/src/services/QuotePaymentRecoveryService.js'),
    import('../dist/backend/src/db.js'),
  ]);
  try {
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
      }
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
    const evidence = await db.query(`
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
    await db.close();
  }
}

export async function main(env = process.env) {
  const adminDatabaseUrl = env.DATABASE_URL?.trim();
  assertMigrationVerificationAuthority(env, adminDatabaseUrl);
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
