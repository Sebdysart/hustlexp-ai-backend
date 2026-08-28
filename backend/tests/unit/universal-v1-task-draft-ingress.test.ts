import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../src/db', () => ({
  db: { query: mocks.query, transaction: mocks.transaction },
}));
vi.mock('../../src/logger', () => ({
  logger: { child: () => ({ info: mocks.info, warn: mocks.warn, error: vi.fn(), debug: vi.fn() }) },
}));
vi.mock('../../src/auth/firebase', () => ({ firebaseAuth: { verifyIdToken: vi.fn() } }));

import {
  submitUniversalV1TaskDraft,
  webTaskDraftsRouter,
} from '../../src/routers/web/taskDrafts';
import {
  evaluateUniversalV1TaskDraftRouting,
  sanitizeTaskDraftAnswers,
  sanitizeTaskDraftText,
  taskDraftCardTokenHash,
  taskDraftMutationIdempotencyKey,
  universalTaskDraftRequestHash,
  UNIVERSAL_V1_ROUTING_OUTCOMES,
} from '../../src/services/UniversalV1TaskDraftIngress';

const SUBMISSION = '11111111-2222-4333-8444-555555555555';
const DRAFT = '22222222-3333-4444-8555-666666666666';
const ROUTE = '33333333-4444-4555-8666-777777777777';
const LEAD_SUBMISSION = '44444444-5555-4666-8777-888888888888';
const TOKEN = 'c0136ae07479454a856ad30e56e23ec89eafdcac3e16fd1b3205c5df6a9d08d9';

function caller() {
  return webTaskDraftsRouter.createCaller({ user: null, firebaseUid: null, ip: '203.0.113.12' });
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    action: 'create' as const,
    submission_id: SUBMISSION,
    expected_version: 0,
    card_token: TOKEN,
    raw_input: 'Assemble a six drawer dresser',
    category: 'furniture_assembly' as const,
    answers: {},
    zip: '98052',
    photo_count: 0,
    consent_version: 'v1' as const,
    turnstile_token: 'turnstile-token',
    client_ts: Date.now(),
    ...overrides,
  };
}

function routeRow(version: number, outcome = 'MANUAL_SOURCING') {
  return {
    id: ROUTE,
    decision_version: version,
    outcome,
    reason_codes: ['SCOPE_OR_SUPPLY_REVIEW_REQUIRED'],
    policy_version: 'universal-v1-intake-1.1.0',
    evidence: { request_sha256: 'not-used' },
    idempotency_key: `taskdraft:${SUBMISSION}:v${version}`,
  };
}

function routingInput(overrides: Record<string, unknown> = {}) {
  return {
    category: 'other' as const,
    rawInput: 'Unusual local project',
    answers: {},
    safetyEvidence: '',
    serverRiskFlags: [] as string[],
    scopeEvidenceComplete: false,
    nowMs: Date.parse('2026-08-26T00:01:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(async (fn: (query: typeof mocks.query) => Promise<unknown>) => fn(mocks.query));
  process.env.NODE_ENV = 'test';
  process.env.TURNSTILE_SECRET_KEY = 'test-secret';
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, action: 'task' }),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TURNSTILE_SECRET_KEY;
});

describe('Universal V1 deterministic routing', () => {
  it('keeps exactly six reachable Charter outcomes', () => {
    const cases = [
      evaluateUniversalV1TaskDraftRouting({
        ...routingInput({
          category: 'furniture_assembly', rawInput: 'Assemble dresser',
          answers: { scope_confirmed_at: '2026-08-26T00:00:00Z' },
          scopeEvidenceComplete: true,
        }),
      }).outcome,
      evaluateUniversalV1TaskDraftRouting(routingInput({ category: 'yard', rawInput: 'Clean up yard' })).outcome,
      evaluateUniversalV1TaskDraftRouting(routingInput()).outcome,
      evaluateUniversalV1TaskDraftRouting(routingInput({ rawInput: 'Ground-level pressure washing' })).outcome,
      evaluateUniversalV1TaskDraftRouting({
        ...routingInput({
          category: 'cleaning', rawInput: 'Clean apartment',
          answers: { supply_state: 'TEMPORARILY_UNAVAILABLE' },
        }),
      }).outcome,
      evaluateUniversalV1TaskDraftRouting(routingInput({ rawInput: 'There is an active gas leak' })).outcome,
    ];
    expect(cases).toEqual(UNIVERSAL_V1_ROUTING_OUTCOMES);
  });

  it('uses sanitized answer evidence to prevent a hidden licensed-trade scope from becoming a candidate', () => {
    expect(evaluateUniversalV1TaskDraftRouting(routingInput({
      category: 'handyman',
      rawInput: 'Fix a problem',
      answers: { scope_confirmed_at: '2026-08-26T00:00:00Z' },
      safetyEvidence: 'electrical panel wiring',
      scopeEvidenceComplete: true,
    }))).toMatchObject({
      outcome: 'ESTIMATE_REQUIRED',
      reasonCodes: ['CREDENTIALED_TRADE_REVIEW_REQUIRED'],
    });
  });

  it('requires complete server scope evidence and a fresh ISO confirmation for candidacy', () => {
    const base = {
      category: 'furniture_assembly',
      rawInput: 'Assemble dresser',
      answers: { scope_confirmed_at: '2026-08-26T00:00:00Z' },
    };
    expect(evaluateUniversalV1TaskDraftRouting(routingInput(base)).outcome)
      .toBe('MANUAL_SOURCING');
    expect(evaluateUniversalV1TaskDraftRouting(routingInput({
      ...base,
      scopeEvidenceComplete: true,
      answers: { scope_confirmed_at: 'yes' },
    })).outcome).toBe('MANUAL_SOURCING');
    expect(evaluateUniversalV1TaskDraftRouting(routingInput({
      ...base,
      scopeEvidenceComplete: true,
      answers: { scope_confirmed_at: '2026-08-25T00:00:00Z' },
    })).outcome).toBe('MANUAL_SOURCING');
    expect(evaluateUniversalV1TaskDraftRouting(routingInput({
      ...base,
      scopeEvidenceComplete: true,
    })).outcome).toBe('FULFILLMENT_CANDIDATE');
  });

  it('strips contact PII and exact street addresses from draft facts', () => {
    expect(sanitizeTaskDraftText('Assemble at 123 Main Street, call 425-555-0100 a@b.co'))
      .toBe('Assemble at , call');
    expect(sanitizeTaskDraftText('Repair trim at 456 N Main St Apt 2, DOB 01/02/1990'))
      .toBe('Repair trim at , DOB');
    expect(sanitizeTaskDraftAnswers({
      phone: '4255550100', customer_name: 'Person', ssn: '123-45-6789',
      notes: 'email a@b.co then assemble',
    }))
      .toEqual({ notes: 'email then assemble' });
  });

  it('derives one stable idempotency key per expected aggregate version', () => {
    expect(taskDraftMutationIdempotencyKey(SUBMISSION, 0))
      .toBe(taskDraftMutationIdempotencyKey(SUBMISSION, 0));
    expect(taskDraftMutationIdempotencyKey(SUBMISSION, 1))
      .not.toBe(taskDraftMutationIdempotencyKey(SUBMISSION, 0));
  });
});

describe('webTaskDrafts canonical PostgreSQL ingress', () => {
  it('returns a neutral rejected envelope for the honeypot without touching providers or SQL', async () => {
    await expect(caller().submit(input({ company_url: 'bot.example' }))).resolves.toMatchObject({
      ok: false,
      code: 'rejected',
      correlation_id: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('fails closed before persistence when Turnstile is missing or rejected', async () => {
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
    delete process.env.TURNSTILE_SECRET_KEY;
    await expect(caller().submit(input())).rejects.toMatchObject({ code: 'FORBIDDEN' });

    process.env.TURNSTILE_SECRET_KEY = 'test-secret';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: false }) }));
    await expect(caller().submit(input())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const sql = mocks.query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).not.toContain('INSERT INTO task_drafts');
  });

  it('fails closed while recent legacy rate-limit rows cannot be correlated safely', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ total: '0', unresolved_legacy_recent: '1' }],
        rowCount: 1,
      });

    await expect(caller().submit(input())).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    const sql = mocks.query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('LEGACY_SHA256_IP_SUFFIX_V1');
    expect(sql).not.toContain('INSERT INTO task_drafts');
  });

  it('replays an exact create without consuming Turnstile a second time', async () => {
    const request = input();
    const requestHash = universalTaskDraftRequestHash({
      action: request.action,
      submission_id: request.submission_id,
      expected_version: request.expected_version,
      raw_input: request.raw_input,
      category: request.category,
      answers: request.answers,
      zip: request.zip,
      region: null,
      photo_count: request.photo_count,
      lead_submission_id: null,
      consent_version: request.consent_version,
    });
    mocks.query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{
        ...routeRow(1), task_draft_id: DRAFT, status: 'anonymous_task_draft',
        submission_id: SUBMISSION, card_token_hash: taskDraftCardTokenHash(TOKEN),
        evidence: { request_sha256: requestHash, draft_status: 'anonymous_task_draft' },
      }], rowCount: 1 });

    await expect(caller().submit(request)).resolves.toMatchObject({
      replayed: true, draft_id: DRAFT, status: 'anonymous_task_draft', version: 1,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('creates one versioned draft and route without money or assignment SQL', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // aggregate advisory lock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // idempotency replay
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // existing draft
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // advisory lock
      .mockResolvedValueOnce({ rows: [{ total: '0' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: DRAFT, status: 'anonymous_task_draft' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [routeRow(1)], rowCount: 1 });

    const result = await caller().submit(input());
    expect(result).toMatchObject({
      ok: true,
      draft_id: DRAFT,
      version: 1,
      payment_creation_frozen: true,
      hard_assignment_created: false,
      routing: { outcome: 'MANUAL_SOURCING', decision_version: 1 },
      parse: {
        title: 'Assemble a six drawer dresser',
        category: 'furniture_assembly',
        est_price_min_cents: 6000,
        est_price_max_cents: 20000,
      },
    });
    const createArguments = mocks.query.mock.calls[5]?.[1] as unknown[];
    const structured = JSON.parse(String(createArguments[6])) as Record<string, unknown>;
    expect(structured).toMatchObject({
      missing_questions: expect.arrayContaining([
        'What item(s) — brand / model?',
        'New in box?',
        'Preferred day / time?',
      ]),
      risk_flags: [],
      estimate_display_only: true,
      scope_policy_version: 'task_scope_v1',
      financial_effects: 'FROZEN',
    });
    const sql = mocks.query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('INSERT INTO task_drafts');
    expect(sql).toContain('INSERT INTO task_routing_decisions');
    expect(sql).not.toMatch(/INSERT INTO (?:tasks|escrows|payments|work_orders)/iu);
  });

  it('uses task-scoped synthetic human verification only in an explicit nonproduction environment', async () => {
    const now = 1_800_000_000_000;
    const request = input({
      client_ts: now,
      turnstile_token: 'synthetic-task-verification-token',
    });
    const providerFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      action: 'task',
      hostname: 'synthetic.invalid',
      metadata: { result_with_testing_key: true },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    mocks.query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ total: '0' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: DRAFT, status: 'anonymous_task_draft' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [routeRow(1)], rowCount: 1 });

    await expect(submitUniversalV1TaskDraft(request, { ip: '203.0.113.12' }, {
      env: {
        NODE_ENV: 'production',
        HX_ENVIRONMENT: 'staging',
        HX_HUMAN_VERIFICATION_MODE: 'synthetic',
        HX_HUMAN_VERIFICATION_URL: 'http://synthetic-providers:8080/v1/human-verification/verify',
        HX_HUMAN_VERIFICATION_SECRET: 'synthetic-human-verification-secret',
        PUBLIC_INGRESS_IP_HASH_SALT: 'synthetic-task-draft-ip-salt',
      },
      fetch: providerFetch as typeof fetch,
      now: () => now,
      randomUuid: () => '55555555-6666-4777-8888-999999999999',
      transaction: mocks.transaction,
    })).resolves.toMatchObject({ ok: true, version: 1 });
    const [url, init] = providerFetch.mock.calls[0]!;
    expect(String(url)).toBe('http://synthetic-providers:8080/v1/human-verification/verify');
    expect(String(init?.body)).toContain('expected_action=task');
    expect(String(init?.body)).toContain('response=synthetic-task-verification-token');
    expect(String(init?.body)).toContain('remoteip=203.0.113.12');
  });

  it('fails closed on synthetic action mismatch and refuses synthetic verification in production', async () => {
    const now = 1_800_000_000_000;
    const request = input({ client_ts: now, turnstile_token: 'synthetic-task-verification-token' });
    const nonproductionEnv = {
      NODE_ENV: 'production',
      HX_ENVIRONMENT: 'staging',
      HX_HUMAN_VERIFICATION_MODE: 'synthetic',
      HX_HUMAN_VERIFICATION_URL: 'http://synthetic-providers:8080/v1/human-verification/verify',
      HX_HUMAN_VERIFICATION_SECRET: 'synthetic-human-verification-secret',
      PUBLIC_INGRESS_IP_HASH_SALT: 'synthetic-task-draft-ip-salt',
    };
    const wrongActionFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      action: 'lead',
      metadata: { result_with_testing_key: true },
    }), { status: 200 }));
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(submitUniversalV1TaskDraft(request, { ip: '203.0.113.12' }, {
      env: nonproductionEnv,
      fetch: wrongActionFetch as typeof fetch,
      now: () => now,
      transaction: mocks.transaction,
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async (
      fn: (query: typeof mocks.query) => Promise<unknown>,
    ) => fn(mocks.query));
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const shouldNotFetch = vi.fn();
    await expect(submitUniversalV1TaskDraft(request, { ip: '203.0.113.12' }, {
      env: { ...nonproductionEnv, HX_ENVIRONMENT: 'production' },
      fetch: shouldNotFetch as typeof fetch,
      now: () => now,
      transaction: mocks.transaction,
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(shouldNotFetch).not.toHaveBeenCalled();
  });

  it('updates by exact version and links only an existing canonical lead', async () => {
    const existing = {
      id: DRAFT,
      card_token_hash: taskDraftCardTokenHash(TOKEN),
      status: 'anonymous_task_draft',
      category: 'furniture_assembly',
      zip: '98052',
      lead_id: null,
      active_routing_decision_id: ROUTE,
      decision_version: 1,
      outcome: 'MANUAL_SOURCING',
      reason_codes: ['SCOPE_OR_SUPPLY_REVIEW_REQUIRED'],
      policy_version: 'universal-v1-intake-1.1.0',
      evidence: {},
      idempotency_key: `taskdraft:${SUBMISSION}:v1`,
    };
    mocks.query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [existing], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'lead-internal' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ status: 'contact_captured' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [routeRow(2)], rowCount: 1 });
    const result = await caller().submit(input({
      action: 'link_contact',
      expected_version: 1,
      lead_submission_id: LEAD_SUBMISSION,
      turnstile_token: undefined,
    }));
    expect(result).toMatchObject({ status: 'contact_captured', version: 2 });
    expect(mocks.query.mock.calls[3]?.[1]).toEqual([LEAD_SUBMISSION, SUBMISSION]);
    expect(String(mocks.query.mock.calls[3]?.[0])).toContain("lead_type = 'poster'");
    expect(String(mocks.query.mock.calls[3]?.[0])).toContain('task_draft_submission_id');
    expect((mocks.query.mock.calls[5]?.[1] as unknown[]).slice(3, 8)).toEqual([
      'MANUAL_SOURCING', ['SCOPE_OR_SUPPLY_REVIEW_REQUIRED'],
      'universal-v1-intake-1.1.0', 'furniture_assembly', '98052',
    ]);
  });

  it('rejects stale optimistic versions without mutation', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{
        id: DRAFT,
        card_token_hash: taskDraftCardTokenHash(TOKEN),
        status: 'anonymous_task_draft', category: 'furniture_assembly', zip: '98052',
        lead_id: null, active_routing_decision_id: ROUTE,
        decision_version: 3, outcome: 'MANUAL_SOURCING', reason_codes: ['X'],
        policy_version: 'v', evidence: {}, idempotency_key: 'prior',
      }], rowCount: 1 });
    await expect(caller().submit(input({
      action: 'update', expected_version: 1, turnstile_token: undefined,
    }))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mocks.query).toHaveBeenCalledTimes(3);
  });

  it('rejects obvious low-entropy client capabilities before Turnstile or SQL', async () => {
    await expect(caller().submit(input({ card_token: 'a'.repeat(64) })))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller().submit(input({ card_token: '0123456789abcdef'.repeat(4) })))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
