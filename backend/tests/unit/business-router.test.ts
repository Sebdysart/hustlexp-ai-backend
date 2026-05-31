/**
 * Business Router Unit Tests — Roadmap E3
 *
 * Covers backend/src/routers/business.ts (business.submitLead).
 *
 * Invariants under test:
 *   - Happy path: one INSERT, status NEW, requires_review true, safe response.
 *   - Compliance hard_block → BAD_REQUEST, NO row written.
 *   - Compliance soft_flag → inserts, requires_review true, notes persisted.
 *   - Risk flag selected → requires_review true.
 *   - Malformed email → rejected (no insert).
 *   - Non-Eastside ZIP → rejected (no insert).
 *   - Zero recurring task types → rejected (no insert).
 *   - Burst rate limit → TOO_MANY_REQUESTS, no insert, no compliance call.
 *   - ip_hash (sha256) stored; raw IP never stored.
 *   - status can only ever be NEW (no auto-approval path).
 *   - Response carries no lead id and no PII.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must come before any imports that transitively touch these modules
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => {
  const queryFn = vi.fn();
  return {
    db: {
      query: queryFn,
      transaction: vi.fn((fn: (q: typeof queryFn) => Promise<unknown>) => fn(queryFn)),
    },
  };
});

vi.mock('../../src/auth/firebase', () => ({
  firebaseAuth: { verifyIdToken: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/cache/redis', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 10 }),
}));

vi.mock('../../src/services/ComplianceGuardianService', () => ({
  ComplianceGuardianService: { evaluate: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { checkRateLimit } from '../../src/cache/redis';
import { ComplianceGuardianService } from '../../src/services/ComplianceGuardianService';
import { businessRouter } from '../../src/routers/business';

const mockDb = vi.mocked(db);
const mockCheckRateLimit = vi.mocked(checkRateLimit);
const mockCompliance = vi.mocked(ComplianceGuardianService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_IP = '203.0.113.42';
const EXPECTED_IP_HASH = createHash('sha256').update(TEST_IP).digest('hex');

function makePublicCaller(
  headers: Record<string, string> | null = { 'x-forwarded-for': TEST_IP }
) {
  return businessRouter.createCaller({
    user: null,
    firebaseUid: null,
    req: headers ? ({ headers: new Headers(headers) } as Request) : undefined,
  } as any);
}

function complianceResult(tier: 'clean' | 'soft_flag' | 'hard_block', score: number) {
  return {
    score,
    tier,
    triggeredRules: tier === 'clean' ? [] : ['some_rule'],
    notes: {
      score,
      tier,
      triggered_rules: tier === 'clean' ? [] : ['some_rule'],
      suggested_alternative: null,
      admin_review_id: null,
      appeal_status: 'none' as const,
      deception_detected: false,
      is_genuinely_bizarre: false,
      ai_signals_computed: false,
    },
    deception_detected: false,
    is_genuinely_bizarre: false,
    ai_signals_computed: false,
  };
}

const VALID_INPUT = {
  businessName: 'Bellevue Event Co',
  contactName: 'Jane Doe',
  email: 'jane@example.com',
  phone: '4255551234',
  businessType: 'Event venue' as const,
  city: 'Bellevue',
  zip: '98004',
  recurringTaskTypes: ['Event setup'] as Array<
    | 'Event setup'
    | 'Moving help'
    | 'Pickup / dropoff'
    | 'Errands'
    | 'Furniture assembly'
    | 'Cleanup'
    | 'Inventory runs'
    | 'Flexible labor support'
  >,
  expectedFrequency: 'Weekly' as const,
  avgBudgetCents: 8000,
  urgency: 'Normal' as const,
  notes: 'Need help setting up and tearing down weekly events.',
  contactPreference: 'form' as const,
};

/** Pull the single INSERT call's [sql, params]. */
function insertCall() {
  const call = mockDb.query.mock.calls.find((c) => /INSERT INTO business_leads/i.test(String(c[0])));
  expect(call, 'expected an INSERT INTO business_leads call').toBeTruthy();
  return { sql: String(call![0]), params: call![1] as unknown[] };
}

// ===========================================================================
// business.submitLead
// ===========================================================================

describe('business.submitLead', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 10 });
    mockCompliance.evaluate.mockResolvedValue(complianceResult('clean', 5) as any);
    mockDb.query.mockResolvedValue({ rows: [], rowCount: 1 } as any);
  });

  it('happy path: inserts one NEW lead and returns the safe shape (no id, no PII)', async () => {
    const caller = makePublicCaller();
    const result = await caller.submitLead(VALID_INPUT);

    expect(result).toEqual({
      status: 'NEW',
      requiresReview: true,
      message:
        "Thanks — we received your business registration interest. We'll review it before any access is granted. No account created and nothing charged.",
    });
    // Safe output only — must not leak an id or any PII back to the client.
    expect(result).not.toHaveProperty('id');
    expect(JSON.stringify(result)).not.toContain('jane@example.com');
    expect(JSON.stringify(result)).not.toContain('4255551234');

    const { sql, params } = insertCall();
    expect(sql).toMatch(/INSERT INTO business_leads/i);
    // status is hardcoded NEW in SQL, never taken from input.
    expect(sql).toMatch(/'NEW'/);
    expect(sql).toMatch(/'web'/); // source
    expect(params).toContain('Bellevue Event Co');
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  it('compliance hard_block: rejects with BAD_REQUEST and writes NO row', async () => {
    mockCompliance.evaluate.mockResolvedValue(complianceResult('hard_block', 90) as any);

    const caller = makePublicCaller();
    await expect(caller.submitLead(VALID_INPUT)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('legal, reviewable local task demand'),
    });
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('compliance soft_flag: inserts with requires_review true and persists compliance_notes', async () => {
    mockCompliance.evaluate.mockResolvedValue(complianceResult('soft_flag', 40) as any);

    const caller = makePublicCaller();
    const result = await caller.submitLead(VALID_INPUT);
    expect(result.requiresReview).toBe(true);

    const { params } = insertCall();
    // compliance_score ($15) then compliance_notes ($16) then requires_review ($17).
    expect(params).toContain(40);
    const notesParam = params.find(
      (p) => typeof p === 'string' && p.includes('"tier":"soft_flag"')
    );
    expect(notesParam, 'compliance_notes JSON persisted').toBeTruthy();
  });

  it('risk flag selected: forces requires_review true and persists risk_flags', async () => {
    const caller = makePublicCaller();
    const result = await caller.submitLead({
      ...VALID_INPUT,
      riskFlags: { enteringHomes: true },
    } as any);

    expect(result.requiresReview).toBe(true);
    const { params } = insertCall();
    const riskParam = params.find(
      (p) => typeof p === 'string' && p.includes('"enteringHomes":true')
    );
    expect(riskParam, 'risk_flags JSON persisted with selected flag').toBeTruthy();
  });

  it('rejects malformed email (no insert, no compliance call)', async () => {
    const caller = makePublicCaller();
    await expect(
      caller.submitLead({ ...VALID_INPUT, email: 'not-an-email' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.query).not.toHaveBeenCalled();
    expect(mockCompliance.evaluate).not.toHaveBeenCalled();
  });

  it('rejects non-Eastside ZIP (no insert)', async () => {
    const caller = makePublicCaller();
    await expect(
      caller.submitLead({ ...VALID_INPUT, zip: '99999' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects when no recurring task types selected (no insert)', async () => {
    const caller = makePublicCaller();
    await expect(
      caller.submitLead({ ...VALID_INPUT, recurringTaskTypes: [] as any })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('burst rate limit: returns TOO_MANY_REQUESTS, no insert, no compliance call', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });

    const caller = makePublicCaller();
    await expect(caller.submitLead(VALID_INPUT)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(mockCompliance.evaluate).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('stores only the sha256 ip_hash — never the raw IP', async () => {
    const caller = makePublicCaller();
    await caller.submitLead(VALID_INPUT);

    const { params } = insertCall();
    expect(params).toContain(EXPECTED_IP_HASH);
    // Raw IP must not appear in any parameter.
    for (const p of params) {
      expect(String(p)).not.toContain(TEST_IP);
    }
    // Compliance receives the hash, not the raw IP, as ipAddress.
    expect(mockCompliance.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ ipAddress: EXPECTED_IP_HASH })
    );
  });

  it('status can only ever be NEW — no input-driven or auto-approved status', async () => {
    const caller = makePublicCaller();
    // Even if a client tries to smuggle a status field, zod strips it and the
    // SQL hardcodes NEW.
    const result = await caller.submitLead({ ...VALID_INPUT, status: 'APPROVED' } as any);
    expect(result.status).toBe('NEW');

    const { sql, params } = insertCall();
    expect(sql).toMatch(/'NEW'/);
    expect(params).not.toContain('APPROVED');
  });
});
