import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLE_READINESS_CHECKS,
  auditProductionRoleReadiness,
  databaseClientOptions,
  verifyProductionRoleReadiness,
  verifyWithReadOnlyClient,
} from './verify-production-role-readiness.mjs';

function aggregateQuery(counts = {}, failure) {
  return async (sql) => {
    const check = ROLE_READINESS_CHECKS.find((candidate) => candidate.sql === sql);
    if (!check) throw new Error('unexpected query');
    if (failure?.name === check.name) throw new Error(failure.message);
    return { rows: [{ count: counts[check.name] ?? 1 }] };
  };
}

test('readiness SQL is aggregate-only, read-only, and contains no projected identity data', () => {
  assert.deepEqual(
    ROLE_READINESS_CHECKS.map((check) => check.name),
    ['poster', 'hustler', 'business-client', 'service-business', 'operations']
  );
  for (const check of ROLE_READINESS_CHECKS) {
    assert.match(check.sql, /^SELECT COUNT\(\*\)::int AS count/iu);
    assert.doesNotMatch(check.sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/iu);
    assert.doesNotMatch(check.sql, /SELECT\s+(?:u\.)?(?:email|phone|firebase_uid|full_name)\b/iu);
    assert.doesNotMatch(check.sql, /\bRETURNING\b/iu);
  }
});

test('healthy infrastructure requires at least one ready account for every authenticated role', async () => {
  const report = await verifyProductionRoleReadiness({
    query: aggregateQuery(),
    now: () => new Date('2026-07-22T14:30:00.000Z'),
  });
  assert.equal(report.ok, true);
  assert.equal(report.pass, 5);
  assert.equal(report.fail, 0);
  assert.equal(report.controlled_fixture_evidence_required, true);
  assert.deepEqual(
    report.checks.map((check) => check.ready_accounts),
    [1, 1, 1, 1, 1]
  );
});

test('every absent role fails independently without hiding healthy roles', async () => {
  const report = await auditProductionRoleReadiness({
    query: aggregateQuery({
      poster: 0,
      hustler: 0,
      'business-client': 0,
      'service-business': 0,
      operations: 0,
    }),
  });
  assert.equal(report.ok, false);
  assert.equal(report.pass, 0);
  assert.equal(report.fail, 5);
  assert.ok(report.checks.every((check) => check.ready_accounts === 0));
  assert.ok(report.checks.every((check) => check.error === 'no ready production account'));
});

test('database failure stays local to its role and does not expose connection data', async () => {
  const secret = 'postgresql://user:password@example.test/database';
  const report = await auditProductionRoleReadiness({
    query: aggregateQuery({}, { name: 'operations', message: `connection refused ${secret}` }),
  });
  const failed = report.checks.find((check) => check.name === 'operations');
  assert.equal(report.fail, 1);
  assert.equal(failed?.error, 'role readiness query failed');
  assert.doesNotMatch(JSON.stringify(report), /password|example\.test/iu);
});

test('database client policy requires a PostgreSQL URL and encrypted public transport', () => {
  assert.throws(() => databaseClientOptions({}), /DATABASE_URL or DATABASE_PUBLIC_URL/iu);
  assert.throws(
    () => databaseClientOptions({ DATABASE_PUBLIC_URL: 'https://example.test' }),
    /postgresql URL/iu
  );
  assert.deepEqual(
    databaseClientOptions({
      DATABASE_URL: 'postgresql://user:pass@postgres.railway.internal:5432/db',
    }),
    {
      connectionString: 'postgresql://user:pass@postgres.railway.internal:5432/db',
      ssl: false,
    }
  );
  assert.deepEqual(
    databaseClientOptions({
      DATABASE_PUBLIC_URL: 'postgresql://user:pass@proxy.example.test:5432/db',
    }),
    {
      connectionString: 'postgresql://user:pass@proxy.example.test:5432/db',
      ssl: { rejectUnauthorized: true },
    }
  );
  assert.deepEqual(
    databaseClientOptions({
      DATABASE_PUBLIC_URL: 'postgresql://user:pass@proxy.example.test:5432/db',
      HX_DATABASE_TLS_REJECT_UNAUTHORIZED: 'false',
    }),
    {
      connectionString: 'postgresql://user:pass@proxy.example.test:5432/db',
      ssl: { rejectUnauthorized: false },
    }
  );
});

test('database execution is transactionally read-only and rolls back a failed gate', async () => {
  const healthyCommands = [];
  await verifyWithReadOnlyClient({
    query: async (sql) => {
      healthyCommands.push(sql);
      return { rows: [{ count: 1 }] };
    },
  });
  assert.equal(healthyCommands[0], 'BEGIN READ ONLY');
  assert.equal(healthyCommands.at(-1), 'COMMIT');

  const failedCommands = [];
  await assert.rejects(
    () =>
      verifyWithReadOnlyClient({
        query: async (sql) => {
          failedCommands.push(sql);
          if (sql === ROLE_READINESS_CHECKS[0].sql) return { rows: [{ count: 0 }] };
          return { rows: [{ count: 1 }] };
        },
      }),
    /poster: no ready production account/
  );
  assert.equal(failedCommands[0], 'BEGIN READ ONLY');
  assert.equal(failedCommands.at(-1), 'ROLLBACK');
});
