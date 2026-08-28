import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QueryFn } from '../../src/db.js';
import {
  submitUniversalV1Lead,
  type LeadIngressDependencies,
  type UniversalV1LeadIngressInput,
} from '../../src/services/UniversalV1LeadIngressService.js';

const enabled = process.env.HX_ALLOW_LEAD_INGRESS_PG === '1';
const describePg = enabled ? describe : describe.skip;
const databaseUrl = process.env.LOCAL_TEST_DB_URL ?? '';
const now = 1_800_000_000_000;

function assertDisposableDatabase(value: string): void {
  const parsed = new URL(value);
  if (parsed.hostname !== '127.0.0.1'
      || parsed.port !== '5432'
      || parsed.username !== 'hx_ci_runner'
      || parsed.pathname !== '/hx_ci_system_test') {
    throw new Error('Lead ingress concurrency may run only on the exact disposable system database');
  }
}

describePg('Universal V1 lead ingress PostgreSQL concurrency', () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 12 });

  beforeAll(async () => {
    assertDisposableDatabase(databaseUrl);
    await pool.query('SELECT 1');
  });

  afterAll(async () => {
    await pool.end();
  });

  const query: QueryFn = async <Row = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => {
    const result = await pool.query(sql, params);
    return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
  };

  const transaction: LeadIngressDependencies['transaction'] = async (callback) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const transactionQuery: QueryFn = async <Row = Record<string, unknown>>(
        sql: string,
        params?: unknown[],
      ) => {
        const result = await client.query(sql, params);
        return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
      };
      const value = await callback(transactionQuery);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };

  it('persists one lead and one confirmation across concurrent identical requests', async () => {
    const submissionId = randomUUID();
    const input: UniversalV1LeadIngressInput = {
      submission_id: submissionId,
      lead_type: 'business',
      email: `lead-${submissionId}@example.invalid`,
      name: 'Concurrent Trade Business',
      phone: '+1 (206) 555-0100',
      region: 'Seattle',
      zip: '98101',
      answers: { work: 'credentialed plumbing estimate' },
      consent_version: 'v1',
      turnstile_token: 'synthetic-turnstile-token',
      client_ts: now,
    };
    const dependencies: Partial<LeadIngressDependencies> = {
      env: {
        NODE_ENV: 'test',
        HX_ENVIRONMENT: 'test',
        TURNSTILE_SECRET_KEY: 'required-test-turnstile-secret',
        ALLOWED_ORIGINS: 'http://localhost:5173',
        LEAD_PRIVACY_HASH_SALT: 'required-test-lead-privacy-salt-v1',
        LEAD_RATE_LIMIT_PER_IP_TYPE_HOUR: '100',
      },
      fetch: async () => new Response(JSON.stringify({
        success: true,
        action: 'lead',
        hostname: 'localhost',
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
      now: () => now,
      randomUuid: randomUUID,
      query,
      transaction,
    };

    const results = await Promise.all(Array.from({ length: 8 }, () => submitUniversalV1Lead(
      input,
      { ip: '203.0.113.42', userAgent: 'hustlexp-required-test' },
      dependencies,
    )));
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.ok && result.status === 'new')).toHaveLength(1);
    expect(results.filter((result) => result.ok && result.status === 'replayed')).toHaveLength(7);

    const lead = await pool.query<{
      id: string;
      ingress_request_hash: string;
      ingress_contract_version: number;
    }>(
      `SELECT id, ingress_request_hash, ingress_contract_version
         FROM leads WHERE submission_id = $1`,
      [submissionId],
    );
    expect(lead.rows).toHaveLength(1);
    expect(lead.rows[0]).toMatchObject({ ingress_contract_version: 1 });
    expect(lead.rows[0]?.ingress_request_hash).toMatch(/^[0-9a-f]{64}$/u);

    const evidence = await pool.query<{ emails: number; events: number }>(
      `SELECT
         (SELECT COUNT(*)::integer FROM email_outbox WHERE lead_id = $1) AS emails,
         (SELECT COUNT(*)::integer FROM outbox_events
           WHERE aggregate_type = 'lead' AND aggregate_id::text = $1::text) AS events`,
      [lead.rows[0]!.id],
    );
    expect(evidence.rows[0]).toEqual({ emails: 1, events: 1 });
  });
});
