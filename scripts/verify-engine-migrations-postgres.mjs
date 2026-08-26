import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import {
  applyEngineAutomationMigration,
  loadMigrationSql,
  productionMigrationRuntime,
  runEngineAutomationMigration,
} from '../dist/backend/src/jobs/engine-automation-migration.js';
import { REQUIRED_MIGRATION_FILES } from '../dist/backend/src/jobs/engine-automation-migration-files.js';

const { Client } = pg;
const adminDatabaseUrl = process.env.DATABASE_URL?.trim();
if (!adminDatabaseUrl) throw new Error('DATABASE_URL is required');

const databaseNames = {
  fresh: 'hx_ci_fresh_test',
  upgrade: 'hx_ci_upgrade_test',
};

function databaseUrl(name) {
  const url = new URL(adminDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function executableSql(sql) {
  return sql.split(/\r?\n/).filter((line) => !line.startsWith('\\')).join('\n');
}

async function recreateDatabase(client, name) {
  if (!/^hx_ci_[a-z_]+_test$/.test(name)) throw new Error(`Unsafe CI database name: ${name}`);
  await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await client.query(`CREATE DATABASE ${name}`);
}

async function assertExactRegistry(url) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query('SELECT name FROM applied_migrations ORDER BY name');
    assert.deepEqual(
      result.rows.map((row) => row.name),
      REQUIRED_MIGRATION_FILES.map((entry) => entry.name).sort(),
      'database migration ledger must equal the exact runtime registry',
    );
  } finally {
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
}

async function verifyUpgrade(url) {
  const runtime = productionMigrationRuntime();
  runtime.databaseUrl = url;
  const client = runtime.createClient(url);
  await client.connect();
  try {
    const baseline = await readFile(
      path.resolve('backend/database/constitutional-schema.sql'),
      'utf8',
    );
    await client.query(baseline);

    const splitIndex = runtime.migrationSpecs.findIndex(
      (spec) => spec.name === '20260720_offline_action_sync_contract',
    );
    assert.ok(splitIndex > 0, 'upgrade split migration must be registered');

    for (const spec of runtime.migrationSpecs.slice(0, splitIndex)) {
      const migration = await loadMigrationSql(runtime, spec);
      const outcome = await applyEngineAutomationMigration(
        client,
        migration.sql,
        migration.sourcePath,
        spec.name,
      );
      assert.equal(outcome.status, 'applied');
    }

    const seed = executableSql(await readFile(
      path.resolve('backend/tests/integration/upgrade-convergence-seed.pg.sql'),
      'utf8',
    ));
    await client.query(seed);

    for (const spec of runtime.migrationSpecs.slice(splitIndex)) {
      const migration = await loadMigrationSql(runtime, spec);
      const outcome = await applyEngineAutomationMigration(
        client,
        migration.sql,
        migration.sourcePath,
        spec.name,
      );
      assert.equal(outcome.status, 'applied');
    }

    const assertions = executableSql(await readFile(
      path.resolve('backend/tests/integration/upgrade-convergence-assert.pg.sql'),
      'utf8',
    ));
    await client.query(assertions);

    const recoveryContract = executableSql(await readFile(
      path.resolve('backend/tests/integration/quote-payment-recovery-contract.pg.sql'),
      'utf8',
    ));
    await client.query(recoveryContract);

    for (const spec of runtime.migrationSpecs) {
      const migration = await loadMigrationSql(runtime, spec);
      const outcome = await applyEngineAutomationMigration(
        client,
        migration.sql,
        migration.sourcePath,
        spec.name,
      );
      assert.equal(outcome.status, 'already_applied');
    }
  } finally {
    await client.end();
  }
  await assertExactRegistry(url);
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
        id, submission_id, card_token_hash, raw_input, lead_id, poster_user_id
      ) VALUES (
        'd3000000-0000-4000-8000-000000000001',
        'd3000000-0000-4000-8000-000000000002',
        repeat('e', 64),
        'Recovery precision fixture',
        'd2000000-0000-4000-8000-000000000001',
        'd1000000-0000-4000-8000-000000000001'
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
        recoverOrphanPayment: async () => ({
          success: true,
          data: {
            disposition: 'VOIDED',
            providerStatus: 'canceled',
            providerOperationId: 'pi_quote_recovery_precision',
          },
        }),
      },
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

const admin = new Client({ connectionString: adminDatabaseUrl });
await admin.connect();
try {
  await recreateDatabase(admin, databaseNames.fresh);
  await recreateDatabase(admin, databaseNames.upgrade);
} finally {
  await admin.end();
}

await verifyFresh(databaseUrl(databaseNames.fresh));
const upgradeDatabaseUrl = databaseUrl(databaseNames.upgrade);
await verifyUpgrade(upgradeDatabaseUrl);
await verifyRecoveryTimestampPrecision(upgradeDatabaseUrl);
process.stdout.write(
  `HXOS_ENGINE_MIGRATIONS_POSTGRES_OK ${REQUIRED_MIGRATION_FILES.length}\n`,
);
