import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), warn: vi.fn(), info: vi.fn() }));

vi.mock('../../src/db', () => ({
  db: {
    query: mocks.query,
    serializableTransaction: async (callback: (query: typeof mocks.query) => Promise<unknown>) =>
      callback(mocks.query),
  },
}));
vi.mock('../../src/logger', () => ({
  logger: { child: () => ({ warn: mocks.warn, info: mocks.info, error: vi.fn(), debug: vi.fn() }) },
}));
vi.mock('../../src/auth/firebase', () => ({ firebaseAuth: { verifyIdToken: vi.fn() } }));

import { webLeadsRouter } from '../../src/routers/web/leads';

const SUBMISSION_ID = '11111111-1111-4111-8111-111111111111';
const DRAFT_TOKEN = '555c7e16330b8c0d960bca871681cf8cb16a5c6b6d1cb115e7d31664c8b69fb1';

function caller(ip: string | null = '203.0.113.10', responseHeaders = new Headers()) {
  return webLeadsRouter.createCaller({
    user: null,
    firebaseUid: null,
    ip,
    origin: 'https://hustlexp.app',
    userAgent: 'synthetic-browser',
    responseHeaders,
  });
}

function operatorCaller(isAdmin = true) {
  return webLeadsRouter.createCaller({
    user: {
      id: '22222222-2222-4222-8222-222222222222',
      is_admin: isAdmin,
      is_banned: false,
      account_status: 'ACTIVE',
      default_mode: 'poster',
    },
    firebaseUid: 'named-firebase-operator',
    identityAssurance: {
      authenticatedAtSeconds: Math.floor(Date.now() / 1000),
      tokenExpiresAtSeconds: Math.floor(Date.now() / 1000) + 3_600,
      signInProvider: 'password',
      secondFactor: 'phone',
      mfaVerified: true,
    },
    ip: '203.0.113.11',
  } as any);
}

function authorizeOperations(granted = true) {
  mocks.query.mockResolvedValueOnce({
    rows: [{ role: 'support', capability_granted: granted }], rowCount: 1,
  });
}

function leadInput(overrides: Record<string, unknown> = {}) {
  return {
    submission_id: SUBMISSION_ID,
    lead_type: 'poster' as const,
    email: 'Person@Example.com',
    name: '  Person  ',
    phone: '+12065550100',
    region: 'Bellevue',
    zip: '98004',
    answers: { task: 'yard cleanup' },
    consent_version: 'v1' as const,
    turnstile_token: 'turnstile-token',
    client_ts: Date.now(),
    ...overrides,
  };
}

function mockLeadPersistence(id = '11111111-2222-4333-8444-555555555555') {
  mocks.query.mockImplementation(async (sqlValue: string, params: unknown[] = []) => {
    const sql = String(sqlValue).replace(/\s+/g, ' ');
    if (sql.includes('FROM task_drafts')) return { rows: [{ id: 'draft-1' }], rowCount: 1 };
    if (sql.includes('FROM leads WHERE submission_id')) return { rows: [], rowCount: 0 };
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
    if (sql.includes('COUNT(*)::text AS count')) {
      return { rows: [{ count: '0', retry_after_seconds: 3600 }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO leads')) {
      return {
        rows: [{
          id,
          submission_id: SUBMISSION_ID,
          status: 'new',
          ingress_request_hash: String(params[13]),
        }],
        rowCount: 1,
      };
    }
    if (sql.includes('INSERT INTO email_outbox')) {
      return { rows: [{ id: '33333333-4444-4555-8666-777777777777' }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO outbox_events')) return { rows: [], rowCount: 1 };
    throw new Error(`Unexpected query: ${sql}`);
  });
}

function surveyInput(overrides: Record<string, unknown> = {}) {
  return {
    submission_id: SUBMISSION_ID,
    role: 'hustler' as const,
    email: 'Worker@Example.com',
    name: ' Worker ',
    phone: ' +12065550101 ',
    intent_tags: ['moving'],
    utm: { source: 'website' },
    consent_version: 'v1' as const,
    turnstile_token: 'token',
    client_ts: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockReset();
  process.env.NODE_ENV = 'test';
  process.env.HX_ENVIRONMENT = 'test';
  process.env.TURNSTILE_SECRET_KEY = 'test-secret';
  process.env.LEAD_PRIVACY_HASH_SALT = 'test-lead-privacy-hash-salt-v1';
  process.env.ALLOWED_ORIGINS = 'https://hustlexp.app';
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, json: async () => ({ success: true, action: 'lead', hostname: 'hustlexp.app' }),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TURNSTILE_SECRET_KEY;
  delete process.env.LEAD_PRIVACY_HASH_SALT;
});

describe('web leads ingress', () => {
  it('neutralizes honeypot poster submissions before persistence', async () => {
    await expect(caller().submitLead(leadInput({ company_url: 'bot' }))).resolves.toMatchObject({
      ok: false, code: 'rejected',
    });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('rejects stale submissions', async () => {
    await expect(caller().submitLead(leadInput({ client_ts: Date.now() - 11 * 60 * 1000 })))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('fails closed when Turnstile rejects or cannot be reached', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'secret';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true, json: async () => ({ success: false }),
    }));
    await expect(caller().submitLead(leadInput())).rejects.toMatchObject({ code: 'FORBIDDEN' });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('network down')));
    await expect(caller().submitLead(leadInput())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('fails closed in every environment when the Turnstile secret is absent', async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    await expect(caller().submitLead(leadInput())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('persists one normalized poster lead and hashes the source IP', async () => {
    mockLeadPersistence();
    const result = await caller().submitLead(leadInput());
    expect(result).toMatchObject({
      ok: true,
      lead_id: '11111111-2222-4333-8444-555555555555',
      status: 'new',
    });
    const insert = mocks.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO leads'));
    const params = insert?.[1] as unknown[];
    expect(params[2]).toBe('person@example.com');
    expect(params[3]).toBe('Person');
    expect(params[4]).toBe('+12065550100');
    expect(params[10]).toMatch(/^[a-f0-9]{64}$/);
    expect(params[10]).not.toBe('203.0.113.10');
    expect(mocks.info).toHaveBeenCalled();
  });

  it('persists without an IP hash when the transport has no address', async () => {
    mockLeadPersistence('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    await expect(caller(null).submitLead(leadInput())).resolves.toMatchObject({
      lead_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    });
    const insert = mocks.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO leads'));
    expect(insert?.[1]?.[10]).toBeNull();
  });

  it('accepts canonical TaskDraft proof for poster contact without a second captcha', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    mockLeadPersistence('bbbbbbbb-cccc-4ddd-8eee-ffffffffffff');
    await expect(caller().submitLead(leadInput({
      turnstile_token: undefined,
      draft_submission_id: SUBMISSION_ID,
      draft_card_token: DRAFT_TOKEN,
    }))).resolves.toMatchObject({ lead_id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(String(mocks.query.mock.calls[0]?.[0])).toContain('universal_contract_version = 1');
    const insert = mocks.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO leads'));
    expect(JSON.parse(String(insert?.[1]?.[7]))).toMatchObject({
      task_draft_submission_id: SUBMISSION_ID,
    });
  });

  it('maps the database-backed rate limit to HTTP authority and an exact retry header', async () => {
    const responseHeaders = new Headers();
    mockLeadPersistence();
    mocks.query.mockImplementation(async (sqlValue: string, params: unknown[] = []) => {
      const sql = String(sqlValue).replace(/\s+/g, ' ');
      if (sql.includes('FROM leads WHERE submission_id')) return { rows: [], rowCount: 0 };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
      if (sql.includes('COUNT(*)::text AS count')) {
        return { rows: [{ count: '10', retry_after_seconds: 75 }], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql} ${JSON.stringify(params)}`);
    });
    await expect(caller('203.0.113.10', responseHeaders).submitLead(leadInput()))
      .rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(responseHeaders.get('retry-after')).toBe('75');
  });
});

describe('web survey ingress', () => {
  it('neutralizes survey honeypots', async () => {
    await expect(caller().submitSurvey(surveyInput({ hp_email: 'bot' }))).resolves.toEqual({
      ok: true, submission_id: SUBMISSION_ID, role: 'hustler',
    });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('persists a normalized survey and returns its correlation witness', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const result = await caller().submitSurvey(surveyInput());
    expect(result).toMatchObject({ ok: true, submission_id: SUBMISSION_ID, role: 'hustler' });
    expect(result.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
    const params = mocks.query.mock.calls[0][1] as unknown[];
    expect(params[2]).toBe('worker@example.com');
    expect(params[3]).toBe('Worker');
    expect(params[4]).toBe('+12065550101');
  });
});

describe('web lead named-operator authority', () => {
  it('filters and counts leads with bounded pagination', async () => {
    authorizeOperations();
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'lead-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ total: '1' }], rowCount: 1 });
    await expect(operatorCaller().listLeads({
      status: 'new', leadType: 'poster', limit: 10, offset: 5,
    })).resolves.toEqual({ ok: true, leads: [{ id: 'lead-1' }], total: 1 });
    expect(String(mocks.query.mock.calls[0][0])).toContain('can_manage_operations');
    expect(mocks.query.mock.calls[1][1]).toEqual(['new', 'poster', 10, 5]);
  });

  it('holds the direct lead mutation after authenticating the named operator', async () => {
    authorizeOperations();
    await expect(operatorCaller().updateLead({
      id: SUBMISSION_ID, status: 'qualified', notes: 'ready', assigned_to: 'automation',
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(String(mocks.query.mock.calls[0][0])).not.toMatch(/UPDATE\s+leads/i);
  });

  it('returns numeric survey health stats', async () => {
    authorizeOperations();
    mocks.query.mockResolvedValueOnce({
      rows: [{ native_1h: '1', native_24h: '2', native_7d: '3', queue_depth: '4' }], rowCount: 1,
    });
    await expect(operatorCaller().getSurveyStats({})).resolves.toMatchObject({
      native_1h: 1, native_24h: 2, native_7d: 3, queue_depth: 4,
    });
  });

  it('rejects anonymous and ordinary authenticated callers before any operations read', async () => {
    await expect(caller().listLeads({})).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(operatorCaller(false).getSurveyStats({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('rejects staff without the scoped operations capability', async () => {
    authorizeOperations(false);
    await expect(operatorCaller().listLeads({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });
});
