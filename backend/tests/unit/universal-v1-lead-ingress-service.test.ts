import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { QueryFn } from '../../src/db.js';
import {
  submitUniversalV1Lead,
  universalV1LeadIngressSchema,
  type LeadIngressDependencies,
  type UniversalV1LeadIngressInput,
} from '../../src/services/UniversalV1LeadIngressService.js';

const SUBMISSION_ID = '11111111-1111-4111-8111-111111111111';
const LEAD_ID = '22222222-2222-4222-8222-222222222222';
const DRAFT_TOKEN = 'c0136ae07479454a856ad30e56e23ec89eafdcac3e16fd1b3205c5df6a9d08d9';
const CORRELATION_ID = '33333333-3333-4333-8333-333333333333';

function input(overrides: Partial<UniversalV1LeadIngressInput> = {}): UniversalV1LeadIngressInput {
  return {
    submission_id: SUBMISSION_ID,
    lead_type: 'poster',
    email: 'Person@Example.com',
    name: '  Person Example  ',
    phone: '+1 (206) 555-0100',
    region: ' Bellevue ',
    zip: '98004',
    answers: { task: 'yard cleanup', email: 'private@example.com' },
    utm: { source: 'website' },
    consent_version: 'v1',
    turnstile_token: 'turnstile-token',
    client_ts: 1_800_000_000_000,
    ...overrides,
  };
}

function environment(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'test',
    HX_ENVIRONMENT: 'test',
    TURNSTILE_SECRET_KEY: 'turnstile-secret',
    TURNSTILE_ALLOW_TEST_BYPASS: 'false',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    LEAD_PRIVACY_HASH_SALT: 'unit-test-lead-privacy-salt-v1',
    LEAD_RATE_LIMIT_PER_IP_TYPE_HOUR: '10',
    ...overrides,
  };
}

function turnstile(body: Record<string, unknown> = {}): typeof globalThis.fetch {
  return vi.fn().mockImplementation(async () => new Response(JSON.stringify({
    success: true,
    action: 'lead',
    hostname: 'localhost',
    ...body,
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
}

function dependencies(
  query: QueryFn,
  overrides: Partial<LeadIngressDependencies> = {},
): Partial<LeadIngressDependencies> {
  return {
    env: environment(),
    fetch: turnstile(),
    now: () => 1_800_000_000_000,
    randomUuid: () => CORRELATION_ID,
    query,
    transaction: async (callback) => callback(query),
    ...overrides,
  };
}

function statefulDatabase(options: { rateCount?: number } = {}) {
  let lead: { id: string; submission_id: string; status: string; ingress_request_hash: string } | null = null;
  let emailInserted = false;
  const query = vi.fn(async (sqlValue: string, params: unknown[] = []) => {
    const sql = sqlValue.replace(/\s+/gu, ' ').trim();
    if (sql.includes('FROM task_drafts')) return { rows: [{ id: 'draft-1' }], rowCount: 1 };
    if (sql.includes('FROM leads WHERE submission_id')) {
      return { rows: lead ? [lead] : [], rowCount: lead ? 1 : 0 };
    }
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
    if (sql.includes('COUNT(*)::text AS count')) {
      return {
        rows: [{ count: String(options.rateCount ?? 0), retry_after_seconds: 120 }],
        rowCount: 1,
      };
    }
    if (sql.startsWith('INSERT INTO leads')) {
      lead = {
        id: LEAD_ID,
        submission_id: SUBMISSION_ID,
        status: 'new',
        ingress_request_hash: String(params[13]),
      };
      return { rows: [lead], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO email_outbox')) {
      if (emailInserted) return { rows: [], rowCount: 0 };
      emailInserted = true;
      return { rows: [{ id: '44444444-4444-4444-8444-444444444444' }], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO outbox_events')) return { rows: [], rowCount: 1 };
    throw new Error(`Unexpected query: ${sql}`);
  }) as unknown as QueryFn;
  return { query, getLead: () => lead };
}

describe('Universal V1 lead ingress schema', () => {
  it('matches the strict browser contract and rejects widened legacy shapes', () => {
    expect(universalV1LeadIngressSchema.safeParse(input()).success).toBe(true);
    expect(universalV1LeadIngressSchema.safeParse(input({ name: 'x'.repeat(81) })).success).toBe(false);
    expect(universalV1LeadIngressSchema.safeParse(input({ phone: 'not-a-phone' })).success).toBe(false);
    expect(universalV1LeadIngressSchema.safeParse(input({ zip: '9800' })).success).toBe(false);
    expect(universalV1LeadIngressSchema.safeParse({ ...input(), unexpected: true }).success).toBe(false);
  });

  it('permits TaskDraft proof only for poster contact capture', () => {
    const proof = {
      turnstile_token: undefined,
      draft_submission_id: SUBMISSION_ID,
      draft_card_token: DRAFT_TOKEN,
    };
    expect(universalV1LeadIngressSchema.safeParse(input(proof)).success).toBe(true);
    expect(universalV1LeadIngressSchema.safeParse(input({ ...proof, lead_type: 'hustler' })).success)
      .toBe(false);
  });
});

describe('Universal V1 lead ingress behavior', () => {
  it('rejects honeypots without a success claim or persistence', async () => {
    const database = statefulDatabase();
    const fetch = turnstile();
    await expect(submitUniversalV1Lead(
      input({ company_url: 'bot.example' }),
      { ip: '203.0.113.10' },
      dependencies(database.query, { fetch }),
    )).resolves.toEqual({ ok: false, code: 'rejected', correlation_id: CORRELATION_ID });
    expect(fetch).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });

  it('rejects stale requests before proof or database work', async () => {
    const database = statefulDatabase();
    const fetch = turnstile();
    await expect(submitUniversalV1Lead(
      input({ client_ts: 1_799_999_399_999 }),
      { ip: '203.0.113.10' },
      dependencies(database.query, { fetch }),
    )).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(fetch).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });

  it.each([
    ['failed challenge', { success: false }],
    ['wrong action', { action: 'signup' }],
    ['wrong hostname', { hostname: 'attacker.example' }],
  ])('fails closed for %s Turnstile evidence', async (_label, evidence) => {
    const database = statefulDatabase();
    await expect(submitUniversalV1Lead(
      input(),
      { ip: '203.0.113.10' },
      dependencies(database.query, { fetch: turnstile(evidence) }),
    )).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(database.query).not.toHaveBeenCalled();
  });

  it('allows an explicit Cloudflare test witness only in a named nonproduction environment', async () => {
    const testEvidence = turnstile({ metadata: { result_with_testing_key: true }, hostname: 'test.invalid' });
    const allowed = statefulDatabase();
    await expect(submitUniversalV1Lead(
      input(),
      { ip: '203.0.113.10', userAgent: 'synthetic-browser' },
      dependencies(allowed.query, {
        fetch: testEvidence,
        env: environment({ HX_ENVIRONMENT: 'staging', NODE_ENV: 'production', TURNSTILE_ALLOW_TEST_BYPASS: 'true' }),
      }),
    )).resolves.toMatchObject({ ok: true, status: 'new' });

    const denied = statefulDatabase();
    await expect(submitUniversalV1Lead(
      input(),
      { ip: '203.0.113.10' },
      dependencies(denied.query, {
        fetch: testEvidence,
        env: environment({ HX_ENVIRONMENT: 'production', NODE_ENV: 'production', TURNSTILE_ALLOW_TEST_BYPASS: 'true' }),
      }),
    )).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('uses only an explicitly bounded synthetic verifier in deployed nonproduction', async () => {
    const database = statefulDatabase();
    const fetch = turnstile({
      metadata: { result_with_testing_key: true },
      hostname: 'synthetic.invalid',
    });
    await expect(submitUniversalV1Lead(
      input(),
      { ip: '203.0.113.10' },
      dependencies(database.query, {
        fetch,
        env: environment({
          NODE_ENV: 'production',
          HX_ENVIRONMENT: 'staging',
          HX_HUMAN_VERIFICATION_MODE: 'synthetic',
          HX_HUMAN_VERIFICATION_URL: 'http://synthetic-providers:8080/v1/human-verification/verify',
          HX_HUMAN_VERIFICATION_SECRET: 'synthetic-human-verification-secret',
          TURNSTILE_SECRET_KEY: '',
        }),
      }),
    )).resolves.toMatchObject({ ok: true, status: 'new' });
    expect(fetch).toHaveBeenCalledWith(
      'http://synthetic-providers:8080/v1/human-verification/verify',
      expect.objectContaining({ method: 'POST' }),
    );

    const denied = statefulDatabase();
    const deniedFetch = turnstile({ metadata: { result_with_testing_key: true } });
    await expect(submitUniversalV1Lead(
      input(),
      { ip: '203.0.113.10' },
      dependencies(denied.query, {
        fetch: deniedFetch,
        env: environment({
          NODE_ENV: 'production',
          HX_ENVIRONMENT: 'production',
          HX_HUMAN_VERIFICATION_MODE: 'synthetic',
          HX_HUMAN_VERIFICATION_URL: 'http://synthetic-providers:8080/v1/human-verification/verify',
          HX_HUMAN_VERIFICATION_SECRET: 'synthetic-human-verification-secret',
          TURNSTILE_SECRET_KEY: '',
        }),
      }),
    )).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(deniedFetch).not.toHaveBeenCalled();
  });

  it('writes one normalized lead with salted privacy evidence and a durable email outbox event', async () => {
    const database = statefulDatabase();
    const result = await submitUniversalV1Lead(
      input(),
      { ip: '203.0.113.10', userAgent: 'synthetic-browser', origin: 'http://localhost:5173' },
      dependencies(database.query),
    );
    expect(result).toEqual({
      ok: true,
      submission_id: SUBMISSION_ID,
      lead_id: LEAD_ID,
      status: 'new',
      correlation_id: CORRELATION_ID,
    });
    const calls = (database.query as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const insert = calls.find(([sql]) => String(sql).includes('INSERT INTO leads'));
    const params = insert?.[1] as unknown[];
    expect(params[2]).toBe('person@example.com');
    expect(params[3]).toBe('Person Example');
    expect(params[10]).toMatch(/^[0-9a-f]{64}$/u);
    expect(params[10]).not.toBe('203.0.113.10');
    expect(params[11]).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.parse(String(params[7]))).not.toHaveProperty('email');
    expect(calls.some(([sql]) => String(sql).includes('INSERT INTO email_outbox'))).toBe(true);
    expect(calls.some(([sql]) => String(sql).includes("'email.send_requested'"))).toBe(true);
  });

  it('replays an identical submission without a second row or confirmation and rejects content drift', async () => {
    const database = statefulDatabase();
    const options = dependencies(database.query);
    await expect(submitUniversalV1Lead(input(), { ip: '203.0.113.10' }, options))
      .resolves.toMatchObject({ ok: true, status: 'new' });
    await expect(submitUniversalV1Lead(input(), { ip: '203.0.113.10' }, options))
      .resolves.toMatchObject({ ok: true, status: 'replayed', lead_id: LEAD_ID });
    await expect(submitUniversalV1Lead(
      input({ email: 'different@example.com' }),
      { ip: '203.0.113.10' },
      options,
    )).rejects.toMatchObject({ code: 'CONFLICT' });
    const calls = (database.query as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.filter(([sql]) => String(sql).includes('INSERT INTO leads'))).toHaveLength(1);
    expect(calls.filter(([sql]) => String(sql).includes('INSERT INTO email_outbox'))).toHaveLength(1);
  });

  it('retries only PostgreSQL serialization/deadlock aborts inside the idempotent transaction boundary', async () => {
    const database = statefulDatabase();
    let attempts = 0;
    const transaction: LeadIngressDependencies['transaction'] = async (callback) => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error('serialization retry'), { code: '40001' });
      }
      return callback(database.query);
    };
    await expect(submitUniversalV1Lead(
      input(),
      { ip: '203.0.113.10' },
      dependencies(database.query, { transaction }),
    )).resolves.toMatchObject({ ok: true, status: 'new' });
    expect(attempts).toBe(2);

    const fatalTransaction: LeadIngressDependencies['transaction'] = async () => {
      throw Object.assign(new Error('constraint failure'), { code: '23514' });
    };
    await expect(submitUniversalV1Lead(
      input({ submission_id: '55555555-5555-4555-8555-555555555555' }),
      { ip: '203.0.113.10' },
      dependencies(database.query, { transaction: fatalTransaction }),
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('serializes the IP/type rate window and returns an exact retry witness', async () => {
    const database = statefulDatabase({ rateCount: 10 });
    await expect(submitUniversalV1Lead(
      input(),
      { ip: '203.0.113.10' },
      dependencies(database.query),
    )).resolves.toEqual({
      ok: false,
      code: 'rate_limited',
      retry_after_seconds: 120,
      correlation_id: CORRELATION_ID,
    });
    const calls = (database.query as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some(([sql]) => String(sql).includes('pg_advisory_xact_lock'))).toBe(true);
    expect(calls.some(([sql]) => String(sql).includes('INSERT INTO leads'))).toBe(false);
  });

  it('exchanges a canonical TaskDraft capability without a second Turnstile call', async () => {
    const database = statefulDatabase();
    const fetch = turnstile();
    await expect(submitUniversalV1Lead(
      input({
        turnstile_token: undefined,
        draft_submission_id: SUBMISSION_ID,
        draft_card_token: DRAFT_TOKEN,
      }),
      { ip: '203.0.113.10' },
      dependencies(database.query, { fetch }),
    )).resolves.toMatchObject({ ok: true, status: 'new' });
    expect(fetch).not.toHaveBeenCalled();
    expect((database.query as unknown as ReturnType<typeof vi.fn>).mock.calls
      .some(([sql]) => String(sql).includes('FROM task_drafts'))).toBe(true);
  });

  it('fails closed before hashing when the privacy salt is absent', async () => {
    const database = statefulDatabase();
    await expect(submitUniversalV1Lead(
      input(),
      { ip: '203.0.113.10' },
      dependencies(database.query, { env: environment({ LEAD_PRIVACY_HASH_SALT: '' }) }),
    )).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect((database.query as unknown as ReturnType<typeof vi.fn>).mock.calls
      .some(([sql]) => String(sql).includes('INSERT INTO leads'))).toBe(false);
  });
});

describe('Universal V1 lead ingress migration and worker contract', () => {
  it('is append-only and binds anonymous lead confirmation to the provider-neutral outbox', () => {
    const migration = readFileSync(resolve(
      process.cwd(),
      'backend/database/migrations/20260901_universal_v1_lead_ingress_port.sql',
    ), 'utf8');
    const worker = readFileSync(resolve(process.cwd(), 'backend/src/jobs/email-worker.ts'), 'utf8');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS ingress_request_hash TEXT');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS lead_id UUID');
    expect(migration).toContain('email_outbox_exactly_one_owner');
    expect(migration).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/iu);
    expect(worker).toContain('lead_confirmation');
    expect(worker).toContain('No provider assignment or payment has been created.');
  });
});
