import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), warn: vi.fn(), info: vi.fn() }));

vi.mock('../../src/db', () => ({ db: { query: mocks.query } }));
vi.mock('../../src/logger', () => ({
  logger: { child: () => ({ warn: mocks.warn, info: mocks.info, error: vi.fn(), debug: vi.fn() }) },
}));
vi.mock('../../src/auth/firebase', () => ({ firebaseAuth: { verifyIdToken: vi.fn() } }));

import { webLeadsRouter } from '../../src/routers/web/leads';

const SUBMISSION_ID = '11111111-1111-4111-8111-111111111111';

function caller(ip: string | null = '203.0.113.10') {
  return webLeadsRouter.createCaller({ user: null, firebaseUid: null, ip });
}

function leadInput(overrides: Record<string, unknown> = {}) {
  return {
    submission_id: SUBMISSION_ID,
    lead_type: 'poster' as const,
    email: 'Person@Example.com',
    name: '  Person  ',
    phone: '  +12065550100  ',
    region: 'Bellevue',
    zip: '98004',
    answers: { task: 'yard cleanup' },
    consent_version: 'v1' as const,
    turnstile_token: 'token',
    client_ts: Date.now(),
    ...overrides,
  };
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
  delete process.env.TURNSTILE_SECRET_KEY;
  process.env.NODE_ENV = 'test';
});

afterEach(() => vi.unstubAllGlobals());

describe('web leads ingress', () => {
  it('neutralizes honeypot poster submissions before persistence', async () => {
    await expect(caller().submitLead(leadInput({ company_url: 'bot' }))).resolves.toEqual({
      ok: true, submission_id: SUBMISSION_ID, status: 'replayed',
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ json: async () => ({ success: false }) }));
    await expect(caller().submitLead(leadInput())).rejects.toMatchObject({ code: 'FORBIDDEN' });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('network down')));
    await expect(caller().submitLead(leadInput())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('fails closed in production when the Turnstile secret is absent', async () => {
    process.env.NODE_ENV = 'production';
    await expect(caller().submitLead(leadInput())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('persists one normalized poster lead and hashes the source IP', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'lead-1', status: 'new' }], rowCount: 1 });
    const result = await caller().submitLead(leadInput());
    expect(result).toMatchObject({ ok: true, lead_id: 'lead-1', status: 'new' });
    const params = mocks.query.mock.calls[0][1] as unknown[];
    expect(params[2]).toBe('person@example.com');
    expect(params[3]).toBe('Person');
    expect(params[4]).toBe('+12065550100');
    expect(params[10]).toMatch(/^[a-f0-9]{64}$/);
    expect(params[10]).not.toBe('203.0.113.10');
    expect(mocks.info).toHaveBeenCalled();
  });

  it('persists without an IP hash when the transport has no address', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'lead-2', status: 'new' }], rowCount: 1 });
    await expect(caller(null).submitLead(leadInput())).resolves.toMatchObject({ lead_id: 'lead-2' });
    expect(mocks.query.mock.calls[0][1][10]).toBeNull();
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

describe('web lead administrative containment', () => {
  it('exports only public acquisition procedures', () => {
    expect(Object.keys(webLeadsRouter._def.procedures).sort()).toEqual([
      'submitLead',
      'submitSurvey',
    ]);
  });
});
