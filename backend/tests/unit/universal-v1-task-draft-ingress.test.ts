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
  buildUniversalV1TaskDraftRouteContext,
  evaluateUniversalV1TaskDraftRouting,
  sanitizeTaskDraftAnswers,
  sanitizeTaskDraftText,
  taskDraftCardTokenHash,
  taskDraftMutationIdempotencyKey,
  universalTaskDraftRequestHash,
  UNIVERSAL_V1_ROUTING_OUTCOMES,
  type UniversalV1TaskDraftRouteContext,
} from '../../src/services/UniversalV1TaskDraftIngress';

const SUBMISSION = '11111111-2222-4333-8444-555555555555';
const DRAFT = '22222222-3333-4444-8555-666666666666';
const ROUTE = '33333333-4444-4555-8666-777777777777';
const RELATIONSHIP_ORIGIN = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
const RELATIONSHIP_ORIGIN_SHA = 'b'.repeat(64);
const SERVICE_CELL = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
const SERVICE_CELL_2 = '88888888-9999-4aaa-8bbb-cccccccccccc';
const LEAD_SUBMISSION = '44444444-5555-4666-8777-888888888888';
const TOKEN = 'c0136ae07479454a856ad30e56e23ec89eafdcac3e16fd1b3205c5df6a9d08d9';
const SERVICE_CELL_SHA = 'a'.repeat(64);

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
    policy_version: 'universal-v1-intake-1.2.0',
    category_snapshot: 'furniture_assembly',
    service_cell_snapshot: 'US-XQ',
    service_cell_authority_id: SERVICE_CELL,
    evidence: {
      request_sha256: 'not-used',
      relationship_origin_contract_version: 1,
      relationship_origin_id: RELATIONSHIP_ORIGIN,
      relationship_origin_kind: 'MARKETPLACE',
      relationship_origin_policy_version: 1,
      relationship_origin_version: 1,
      relationship_origin_routing_state: 'ROUTING_READY',
      relationship_origin_evidence_digest: RELATIONSHIP_ORIGIN_SHA,
    },
    idempotency_key: `taskdraft:${SUBMISSION}:v${version}`,
  };
}

function activeRouteContext(
  overrides: Partial<UniversalV1TaskDraftRouteContext> = {},
): UniversalV1TaskDraftRouteContext {
  return {
    workCategoryCode: 'furniture_assembly' as const,
    regionCode: 'US-XQ',
    roughLocation: 'Synthetic XQ service area',
    riskLevel: 'LOW' as const,
    requiresProof: true as const,
    finalAvailabilityConfirmationRequired: true as const,
    postalCode: '98052',
    serviceCellAuthorityId: SERVICE_CELL,
    serviceCellAuthorityVersion: 1,
    serviceCellAuthorityEnvironment: 'local' as const,
    serviceCellAuthorityKind: 'SYNTHETIC_FIXTURE' as const,
    serviceCellEvidenceSha256: SERVICE_CELL_SHA,
    serviceCellAvailability: 'ACTIVE' as const,
    blockerCodes: [] as string[],
    ...overrides,
  };
}

function serviceCellRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SERVICE_CELL,
    postal_code: '98052',
    region_code: 'US-XQ',
    rough_location: 'Synthetic XQ service area',
    routing_availability: 'ACTIVE',
    authority_environment: 'local',
    authority_kind: 'SYNTHETIC_FIXTURE',
    authority_version: 1,
    evidence_sha256: SERVICE_CELL_SHA,
    ...overrides,
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
    routeContext: activeRouteContext({ workCategoryCode: 'other' }),
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
    const routeContext = buildUniversalV1TaskDraftRouteContext({
      category: 'handyman',
      rawInput: 'Fix a problem',
      safetyEvidence: 'electrical panel wiring',
      serverRiskFlags: ['Electrical'],
      serviceCell: {
        postalCode: '98052',
        authority: {
          id: SERVICE_CELL,
          postalCode: '98052',
          regionCode: 'US-XQ',
          roughLocation: 'Synthetic XQ service area',
          availability: 'ACTIVE',
          environment: 'local',
          authorityKind: 'SYNTHETIC_FIXTURE',
          authorityVersion: 1,
          evidenceSha256: SERVICE_CELL_SHA,
        },
        blockerCodes: [],
      },
    });
    expect(evaluateUniversalV1TaskDraftRouting(routingInput({
      category: 'handyman',
      rawInput: 'Fix a problem',
      answers: { scope_confirmed_at: '2026-08-26T00:00:00Z' },
      safetyEvidence: 'electrical panel wiring',
      serverRiskFlags: ['Electrical'],
      scopeEvidenceComplete: true,
      routeContext,
    }))).toMatchObject({
      outcome: 'ESTIMATE_REQUIRED',
      reasonCodes: ['CREDENTIALED_TRADE_REVIEW_REQUIRED'],
      routeContext: {
        workCategoryCode: 'electrical',
        regionCode: 'US-XQ',
        riskLevel: 'MEDIUM',
        requiresProof: true,
      },
    });
  });

  it('does not let a client RED label turn credentialed trade demand into a prohibited decline', () => {
    const routeContext = buildUniversalV1TaskDraftRouteContext({
      category: 'handyman',
      rawInput: 'Replace an electrical panel',
      safetyEvidence: 'licensed electrical panel work',
      serverRiskFlags: ['Electrical'],
      serviceCell: {
        postalCode: '98052',
        authority: {
          id: SERVICE_CELL,
          postalCode: '98052',
          regionCode: 'US-XQ',
          roughLocation: 'Synthetic XQ service area',
          availability: 'ACTIVE',
          environment: 'local',
          authorityKind: 'SYNTHETIC_FIXTURE',
          authorityVersion: 1,
          evidenceSha256: SERVICE_CELL_SHA,
        },
        blockerCodes: [],
      },
    });
    expect(evaluateUniversalV1TaskDraftRouting(routingInput({
      category: 'handyman',
      rawInput: 'Replace an electrical panel',
      answers: { risk_level: 'RED' },
      safetyEvidence: 'licensed electrical panel work',
      serverRiskFlags: ['Electrical'],
      routeContext,
    }))).toMatchObject({
      outcome: 'ESTIMATE_REQUIRED',
      reasonCodes: ['CREDENTIALED_TRADE_REVIEW_REQUIRED'],
      routeContext: { workCategoryCode: 'electrical' },
    });
  });

  it('holds an unexplained client RED label for review without treating it as prohibited proof', () => {
    expect(evaluateUniversalV1TaskDraftRouting(routingInput({
      category: 'furniture_assembly',
      rawInput: 'Assemble a dresser',
      answers: {
        risk_level: 'RED',
        scope_confirmed_at: '2026-08-26T00:00:00Z',
      },
      scopeEvidenceComplete: true,
    }))).toMatchObject({
      outcome: 'MANUAL_SOURCING',
      reasonCodes: ['CLIENT_RISK_REVIEW_REQUIRED'],
    });
  });

  it.each([
    ['furniture_assembly', 'Assemble a sealed-box dresser', [], 'LOW'],
    ['furniture_assembly', 'Assemble a dresser in my apartment', [], 'HIGH'],
    ['cleaning', 'Complete the approved cleaning checklist', [], 'HIGH'],
    ['handyman', 'Repair a loose cabinet hinge', [], 'HIGH'],
    ['other', 'Repair a cabinet inside my apartment', [], 'HIGH'],
    ['other', 'Babysit my toddler for the afternoon', [], 'IN_HOME'],
    ['yard', 'Trim ground-level shrubs', [], 'LOW'],
    ['moving', 'Move several boxes to the curb', [], 'LOW'],
    ['moving', 'Move several boxes inside my apartment', [], 'HIGH'],
    ['moving', 'Move heavy boxes down stairs', ['Heavy items (2+ people)'], 'MEDIUM'],
    ['handyman', 'Licensed plumbing estimate for a shutoff valve', [], 'MEDIUM'],
    ['handyman', 'Licensed plumbing repair inside my home', [], 'HIGH'],
    ['yard', 'Trim a tall tree', ['Height / ladder work'], 'HIGH'],
  ] as const)(
    'uses the existing risk contract for %s scope %s',
    (category, rawInput, serverRiskFlags, expectedRiskLevel) => {
      const context = buildUniversalV1TaskDraftRouteContext({
        category,
        rawInput,
        safetyEvidence: '',
        serverRiskFlags,
        serviceCell: {
          postalCode: '98052',
          authority: {
            id: SERVICE_CELL,
            postalCode: '98052',
            regionCode: 'US-XQ',
            roughLocation: 'Synthetic XQ service area',
            availability: 'ACTIVE',
            environment: 'local',
            authorityKind: 'SYNTHETIC_FIXTURE',
            authorityVersion: 1,
            evidenceSha256: SERVICE_CELL_SHA,
          },
          blockerCodes: [],
        },
      });
      expect(context.riskLevel).toBe(expectedRiskLevel);
    },
  );

  it('fails mixed trades and unresolved service cells closed without transaction candidacy', () => {
    const ambiguous = buildUniversalV1TaskDraftRouteContext({
      category: 'handyman',
      rawInput: 'Repair plumbing and an electrical panel',
      safetyEvidence: '',
      serverRiskFlags: ['Electrical', 'Plumbing / water'],
      serviceCell: {
        postalCode: '98052',
        authority: null,
        blockerCodes: ['SERVICE_CELL_AUTHORITY_UNRESOLVED'],
      },
    });
    expect(ambiguous).toMatchObject({
      workCategoryCode: 'other',
      serviceCellAvailability: 'UNRESOLVED',
      blockerCodes: [
        'SERVICE_CELL_AUTHORITY_UNRESOLVED',
        'AMBIGUOUS_CREDENTIALED_TRADE_SCOPE',
      ],
    });
    expect(evaluateUniversalV1TaskDraftRouting(routingInput({
      category: 'handyman',
      rawInput: 'Repair plumbing and an electrical panel',
      serverRiskFlags: ['Electrical', 'Plumbing / water'],
      routeContext: ambiguous,
    }))).toMatchObject({
      outcome: 'MANUAL_SOURCING',
      reasonCodes: [
        'AMBIGUOUS_CREDENTIALED_TRADE_SCOPE',
        'SERVICE_CELL_AUTHORITY_UNRESOLVED',
      ],
    });

    const unresolved = activeRouteContext({
      regionCode: null,
      roughLocation: null,
      serviceCellAuthorityId: null,
      serviceCellAuthorityVersion: null,
      serviceCellAuthorityEnvironment: null,
      serviceCellAuthorityKind: null,
      serviceCellEvidenceSha256: null,
      serviceCellAvailability: 'UNRESOLVED',
      blockerCodes: ['SERVICE_CELL_AUTHORITY_UNRESOLVED'],
    });
    expect(evaluateUniversalV1TaskDraftRouting(routingInput({
      category: 'furniture_assembly',
      rawInput: 'Assemble dresser',
      answers: { scope_confirmed_at: '2026-08-26T00:00:00Z' },
      scopeEvidenceComplete: true,
      routeContext: unresolved,
    }))).toMatchObject({
      outcome: 'MANUAL_SOURCING',
      reasonCodes: ['SERVICE_CELL_AUTHORITY_UNRESOLVED'],
    });
    expect(evaluateUniversalV1TaskDraftRouting(routingInput({
      rawInput: 'There is an active gas leak',
      routeContext: unresolved,
    }))).toMatchObject({
      outcome: 'DECLINE',
      reasonCodes: [
        'EMERGENCY_SERVICE_NOT_OFFERED',
        'SERVICE_CELL_AUTHORITY_UNRESOLVED',
      ],
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
    expect(mocks.query.mock.calls.map(([statement]) => String(statement)).join('\n'))
      .not.toContain('universal_v1_service_cell_authorities');
  });

  it('creates one versioned draft and route without money or assignment SQL', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // aggregate advisory lock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // idempotency replay
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // existing draft
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // advisory lock
      .mockResolvedValueOnce({ rows: [{ total: '0' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [serviceCellRow()], rowCount: 1 })
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
      relationship_origin: {
        id: RELATIONSHIP_ORIGIN,
        kind: 'MARKETPLACE',
        policy_version: 1,
        origin_version: 1,
        routing_state: 'ROUTING_READY',
        evidence_digest: RELATIONSHIP_ORIGIN_SHA,
      },
      parse: {
        title: 'Assemble a six drawer dresser',
        category: 'furniture_assembly',
        est_price_min_cents: 6000,
        est_price_max_cents: 20000,
      },
    });
    const createArguments = mocks.query.mock.calls[6]?.[1] as unknown[];
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
    expect(createArguments[11]).toBe('Synthetic XQ service area');
    const routeArguments = mocks.query.mock.calls[7]?.[1] as unknown[];
    expect(routeArguments.slice(6, 9)).toEqual([
      'furniture_assembly',
      'US-XQ',
      SERVICE_CELL,
    ]);
    expect(JSON.parse(String(routeArguments[9]))).toMatchObject({
      route_context_contract_version: 1,
      work_category_code: 'furniture_assembly',
      region_code: 'US-XQ',
      rough_location: 'Synthetic XQ service area',
      requires_proof: true,
      final_availability_confirmation_required: true,
      service_cell_authority_id: SERVICE_CELL,
      service_cell_availability: 'ACTIVE',
      payment_creation_frozen: true,
      hard_assignment_created: false,
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
      .mockResolvedValueOnce({ rows: [serviceCellRow()], rowCount: 1 })
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

  it('re-resolves server route authority for a new update version', async () => {
    const existing = {
      id: DRAFT,
      card_token_hash: taskDraftCardTokenHash(TOKEN),
      status: 'anonymous_task_draft',
      category: 'handyman',
      zip: '98052',
      lead_id: null,
      active_routing_decision_id: ROUTE,
      decision_version: 1,
      outcome: 'MANUAL_SOURCING',
      reason_codes: ['SCOPE_OR_SUPPLY_REVIEW_REQUIRED'],
      policy_version: 'universal-v1-intake-1.1.0',
      category_snapshot: 'handyman',
      service_cell_snapshot: '98052',
      service_cell_authority_id: null,
      evidence: {},
      idempotency_key: `taskdraft:${SUBMISSION}:v1`,
    };
    mocks.query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [existing], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [serviceCellRow({
          id: SERVICE_CELL_2,
          rough_location: 'Synthetic XQ updated service area',
          authority_version: 2,
        })],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ status: 'anonymous_task_draft' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          ...routeRow(2, 'ESTIMATE_REQUIRED'),
          category_snapshot: 'plumbing',
          service_cell_authority_id: SERVICE_CELL_2,
        }],
        rowCount: 1,
      });

    await expect(caller().submit(input({
      action: 'update',
      expected_version: 1,
      category: 'handyman',
      raw_input: 'Licensed plumbing estimate for a shutoff valve',
      region: 'client supplied region is not authority',
      turnstile_token: undefined,
    }))).resolves.toMatchObject({
      ok: true,
      version: 2,
      routing: { outcome: 'ESTIMATE_REQUIRED' },
    });

    expect(String(mocks.query.mock.calls[3]?.[0])).toContain(
      'universal_v1_service_cell_authorities',
    );
    expect((mocks.query.mock.calls[4]?.[1] as unknown[])[10])
      .toBe('Synthetic XQ updated service area');
    expect((mocks.query.mock.calls[5]?.[1] as unknown[]).slice(6, 9)).toEqual([
      'plumbing',
      'US-XQ',
      SERVICE_CELL_2,
    ]);
  });

  it('updates by exact version and links only an existing canonical lead', async () => {
    const existing = {
      id: DRAFT,
      card_token_hash: taskDraftCardTokenHash(TOKEN),
      status: 'anonymous_task_draft',
      category: 'handyman',
      zip: '98052',
      lead_id: null,
      active_routing_decision_id: ROUTE,
      decision_version: 1,
      outcome: 'ESTIMATE_REQUIRED',
      reason_codes: ['CREDENTIALED_TRADE_REVIEW_REQUIRED'],
      policy_version: 'universal-v1-intake-1.2.0',
      category_snapshot: 'plumbing',
      service_cell_snapshot: 'US-XQ',
      service_cell_authority_id: SERVICE_CELL,
      evidence: {
        route_context_contract_version: 1,
        work_category_code: 'plumbing',
        region_code: 'US-XQ',
        rough_location: 'Synthetic XQ service area',
        risk_level: 'MEDIUM',
        requires_proof: true,
        final_availability_confirmation_required: true,
        postal_code: '98052',
        service_cell_authority_id: SERVICE_CELL,
        service_cell_authority_version: 1,
        service_cell_authority_environment: 'local',
        service_cell_authority_kind: 'SYNTHETIC_FIXTURE',
        service_cell_evidence_sha256: SERVICE_CELL_SHA,
        service_cell_availability: 'ACTIVE',
        routing_blocker_codes: [],
      },
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
    expect((mocks.query.mock.calls[5]?.[1] as unknown[]).slice(3, 9)).toEqual([
      'ESTIMATE_REQUIRED', ['CREDENTIALED_TRADE_REVIEW_REQUIRED'],
      'universal-v1-intake-1.2.0', 'plumbing', 'US-XQ', SERVICE_CELL,
    ]);
    const linkEvidence = JSON.parse(
      String((mocks.query.mock.calls[5]?.[1] as unknown[])[9]),
    ) as Record<string, unknown>;
    expect(linkEvidence).toMatchObject({
      ingress_action: 'link_contact',
      work_category_code: 'plumbing',
      region_code: 'US-XQ',
      service_cell_authority_id: SERVICE_CELL,
    });
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
