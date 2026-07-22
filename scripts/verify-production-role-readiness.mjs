import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ACTIVE_USER = `
  u.account_status = 'ACTIVE'
  AND u.onboarding_completed_at IS NOT NULL
  AND u.is_verified IS TRUE
  AND u.identity_verification_status = 'VERIFIED'
  AND u.identity_verification_environment = 'PRODUCTION'
  AND u.identity_verification_expires_at > NOW()
  AND COALESCE(u.is_minor, TRUE) IS FALSE
  AND COALESCE(u.is_banned, FALSE) IS FALSE`;

export const ROLE_READINESS_CHECKS = Object.freeze([
  Object.freeze({
    name: 'poster',
    sql: `SELECT COUNT(*)::int AS count
FROM users u
WHERE u.default_mode = 'poster'
  AND ${ACTIVE_USER}`,
  }),
  Object.freeze({
    name: 'hustler',
    sql: `SELECT COUNT(*)::int AS count
FROM users u
WHERE u.default_mode = 'worker'
  AND ${ACTIVE_USER}
  AND COALESCE(u.trust_hold, FALSE) IS FALSE
  AND u.payouts_enabled IS TRUE
  AND u.stripe_connect_id IS NOT NULL`,
  }),
  Object.freeze({
    name: 'business-client',
    sql: `SELECT COUNT(*)::int AS count
FROM business_memberships membership
JOIN business_organizations organization ON organization.id = membership.organization_id
JOIN users u ON u.id = membership.user_id
WHERE membership.status = 'ACTIVE'
  AND organization.status = 'ACTIVE'
  AND organization.client_enabled IS TRUE
  AND organization.verification_status = 'VERIFIED'
  AND ${ACTIVE_USER}`,
  }),
  Object.freeze({
    name: 'service-business',
    sql: `SELECT COUNT(*)::int AS count
FROM business_memberships membership
JOIN business_organizations organization ON organization.id = membership.organization_id
JOIN users u ON u.id = membership.user_id
WHERE membership.status = 'ACTIVE'
  AND organization.status = 'ACTIVE'
  AND organization.provider_enabled IS TRUE
  AND organization.verification_status = 'VERIFIED'
  AND organization.payout_status = 'ACTIVE'
  AND ${ACTIVE_USER}`,
  }),
  Object.freeze({
    name: 'operations',
    sql: `SELECT COUNT(*)::int AS count
FROM admin_roles administrator
JOIN users u ON u.id = administrator.user_id
WHERE administrator.can_manage_operations IS TRUE
  AND ${ACTIVE_USER}`,
  }),
]);

function connectionString(env) {
  return (
    env.HX_PRODUCTION_ROLE_DATABASE_URL ||
    env.DATABASE_PUBLIC_URL ||
    env.DATABASE_URL ||
    ''
  ).trim();
}

export function databaseClientOptions(env = process.env) {
  const value = connectionString(env);
  if (!value) throw new Error('DATABASE_URL or DATABASE_PUBLIC_URL is required');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Production role readiness requires a PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('Production role readiness requires a PostgreSQL URL');
  }
  const internal =
    url.hostname.endsWith('.railway.internal') ||
    ['127.0.0.1', '::1', 'localhost'].includes(url.hostname.toLowerCase());
  return {
    connectionString: value,
    ssl: internal
      ? false
      : { rejectUnauthorized: env.HX_DATABASE_TLS_REJECT_UNAUTHORIZED !== 'false' },
  };
}

function readyCount(result) {
  const count = Number(result?.rows?.[0]?.count);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('invalid aggregate result');
  return count;
}

export async function auditProductionRoleReadiness({ query, now = () => new Date() } = {}) {
  if (typeof query !== 'function') throw new Error('A parameterized query function is required');
  const report = {
    schema_version: 1,
    generated_at: now().toISOString(),
    evidence_boundary:
      'Aggregate infrastructure readiness only; controlled revision-bound fixture and journey evidence is still required.',
    controlled_fixture_evidence_required: true,
    checks: [],
  };

  for (const check of ROLE_READINESS_CHECKS) {
    try {
      const count = readyCount(await query(check.sql));
      report.checks.push({
        name: check.name,
        pass: count > 0,
        ready_accounts: count,
        ...(count > 0 ? {} : { error: 'no ready production account' }),
      });
    } catch {
      report.checks.push({
        name: check.name,
        pass: false,
        error: 'role readiness query failed',
      });
    }
  }

  report.pass = report.checks.filter((check) => check.pass).length;
  report.fail = report.checks.length - report.pass;
  report.ok = report.fail === 0;
  return report;
}

export async function verifyProductionRoleReadiness(options) {
  const report = await auditProductionRoleReadiness(options);
  if (!report.ok) {
    const error = new Error(
      report.checks
        .filter((check) => !check.pass)
        .map((check) => `${check.name}: ${check.error}`)
        .join('\n')
    );
    error.report = report;
    throw error;
  }
  return report;
}

export async function verifyWithReadOnlyClient(client) {
  if (typeof client?.query !== 'function') throw new Error('A database client is required');
  await client.query('BEGIN READ ONLY');
  try {
    const report = await verifyProductionRoleReadiness({ query: (sql) => client.query(sql) });
    await client.query('COMMIT');
    return report;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function run() {
  const { Client } = await import('pg');
  const client = new Client(databaseClientOptions());
  await client.connect();
  try {
    return await verifyWithReadOnlyClient(client);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await run(), null, 2));
  } catch (error) {
    if (error?.report) console.error(JSON.stringify(error.report, null, 2));
    else console.error('[production-role-readiness] verification failed');
    process.exitCode = 1;
  }
}
