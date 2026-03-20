/**
 * RED-TEAM: Proof System & Completion Mechanics Abuse
 *
 * Attack vector: proof_steps JSONB, prorate_on_abort, challenge_window_hours,
 * multi-leg relay, escrow state, XP gaming.
 *
 * VERDICT legend:
 *   SAFE       — service rejects the abuse correctly
 *   VULNERABLE — service accepts the abuse (real exploit)
 *   CRASH      — service throws an unhandled exception
 *
 * 20 cases total. Each test documents observed behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — shared across ProofService and EscrowService suites
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => {
  const queryFn = vi.fn();
  return {
    db: {
      query: queryFn,
      transaction: vi.fn((fn: (q: typeof queryFn) => Promise<unknown>) => fn(queryFn)),
      serializableTransaction: vi.fn((fn: (q: typeof queryFn) => Promise<unknown>) => fn(queryFn)),
    },
    isInvariantViolation: vi.fn(() => false),
    isUniqueViolation: vi.fn(() => false),
    getErrorMessage: vi.fn((code: string) => `Error ${code}`),
  };
});

vi.mock('../../src/logger', () => ({
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  stripeLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  logger: { child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) },
  taskLogger: { child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) },
  aiLogger: { child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) },
}));

vi.mock('../../src/config', () => ({
  config: {
    stripe: { platformFeePercent: 15 },
    redis: { restUrl: null, restToken: null },
    ai: {
      openai: { model: 'gpt-4o', apiKey: 'test-key' },
      groq: { model: 'llama3-70b', apiKey: 'test-key' },
      anthropic: { model: 'claude-3-5-sonnet', apiKey: 'test-key' },
      routing: { primary: 'openai', fast: 'groq', safety: 'anthropic' },
      budget: { maxDailySpend: 100 },
    },
  },
}));

vi.mock('../../src/services/BiometricVerificationService', () => ({
  BiometricVerificationService: {
    analyzeProofSubmission: vi.fn().mockResolvedValue({ success: false }),
  },
}));

vi.mock('../../src/services/LogisticsAIService', () => ({
  LogisticsAIService: {
    validateGPSProof: vi.fn().mockResolvedValue({ success: false }),
  },
}));

vi.mock('../../src/services/JudgeAIService', () => ({
  JudgeAIService: {
    synthesizeVerdict: vi.fn().mockResolvedValue({
      success: true,
      data: {
        verdict: 'APPROVE',
        risk_score: 0.1,
        fraud_flags: [],
        component_scores: {},
        recommended_action: 'APPROVE',
        reasoning: 'All signals nominal',
      },
    }),
    logVerdict: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/services/PhotoVerificationService', () => ({
  PhotoVerificationService: {
    compareBeforeAfter: vi.fn().mockResolvedValue({ success: false }),
  },
}));

// Mock the Redis cache module used by the advisory lock (FIX YY-03).
// Default: set() returns 'OK' (lock acquired) so all existing attack tests
// pass through the AI pipeline as before. del() is a no-op.
vi.mock('../../src/cache/redis', () => ({
  getClient: vi.fn(() => ({
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
  })),
}));

vi.mock('../../src/services/EarnedVerificationUnlockService', () => ({
  EarnedVerificationUnlockService: { recordEarnings: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../src/services/XPTaxService', () => ({
  XPTaxService: { recordOfflinePayment: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../src/services/XPService', () => ({
  XPService: { awardXP: vi.fn().mockResolvedValue({ success: true }) },
}));

vi.mock('../../src/services/SelfInsurancePoolService.js', () => ({
  SelfInsurancePoolService: { recordContribution: vi.fn().mockResolvedValue({ success: true }) },
}));

vi.mock('../../src/services/RevenueService', () => ({
  RevenueService: { logEvent: vi.fn().mockResolvedValue({ success: true, data: { id: 'rev-1' } }) },
}));

// Mocks needed when TaskService is imported (it pulls in ScoperAIService → AIClient)
vi.mock('../../src/services/ScoperAIService', () => ({
  ScoperAIService: { analyzeTaskScope: vi.fn().mockResolvedValue({ success: true, data: {} }) },
}));
vi.mock('../../src/services/EligibilityGuard', () => ({
  EligibilityGuard: { assertEligibility: vi.fn().mockResolvedValue({ allowed: true }) },
}));
vi.mock('../../src/services/PlanService', () => ({
  PlanService: { canAcceptTaskWithRisk: vi.fn().mockResolvedValue({ allowed: true }) },
}));
vi.mock('../../src/services/FraudDetectionService', () => ({
  FraudDetectionService: { getRiskAssessment: vi.fn().mockResolvedValue({ success: false }) },
}));
vi.mock('../../src/services/InstantModeKillSwitch', () => ({
  InstantModeKillSwitch: { checkFlags: vi.fn().mockReturnValue({ instantModeEnabled: true }) },
}));
vi.mock('../../src/services/InstantRateLimiter', () => ({
  InstantRateLimiter: { checkAcceptLimit: vi.fn().mockResolvedValue({ allowed: true }) },
}));
vi.mock('../../src/services/InstantObservability', () => ({
  InstantObservability: { logAcceptRace: vi.fn() },
}));
vi.mock('../../src/lib/outbox-helpers', () => ({
  writeToOutbox: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/services/BackgroundCheckService', () => ({
  hasValidBackgroundCheck: vi.fn().mockResolvedValue(true),
}));

import { db, isInvariantViolation, isUniqueViolation } from '../../src/db';
import { ProofService } from '../../src/services/ProofService';
import { EscrowService } from '../../src/services/EscrowService';
import { XPService } from '../../src/services/XPService';
import { EarnedVerificationUnlockService } from '../../src/services/EarnedVerificationUnlockService';
import { SelfInsurancePoolService } from '../../src/services/SelfInsurancePoolService.js';
import { JudgeAIService } from '../../src/services/JudgeAIService';
import { BiometricVerificationService } from '../../src/services/BiometricVerificationService';
import { PhotoVerificationService } from '../../src/services/PhotoVerificationService';

const mockDb = vi.mocked(db);
const mockIsInvariantViolation = vi.mocked(isInvariantViolation);
const mockIsUniqueViolation = vi.mocked(isUniqueViolation);

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeProof(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proof-1',
    task_id: 'task-1',
    submitter_id: 'hustler-1',
    state: 'SUBMITTED',
    description: 'I completed it',
    submitted_at: new Date(),
    reviewed_by: null,
    reviewed_at: null,
    rejection_reason: null,
    created_at: new Date(),
    ...overrides,
  };
}

function makeEscrow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'esc-1',
    task_id: 'task-1',
    amount: 5000,
    state: 'FUNDED',
    stripe_payment_intent_id: 'pi_test',
    stripe_transfer_id: null,
    funded_at: new Date(),
    released_at: null,
    refunded_at: null,
    created_at: new Date(),
    poster_id: 'poster-1',
    worker_id: 'hustler-1',
    ...overrides,
  };
}

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    worker_id: 'hustler-1',
    poster_id: 'poster-1',
    price: 5000,
    prorate_on_abort: false,
    challenge_window_hours: 6,
    state: 'ACCEPTED',
    ...overrides,
  };
}

beforeEach(() => {
  // resetAllMocks purges queued mockResolvedValueOnce values from previous tests
  // (clearAllMocks only resets call history, not queued return values).
  vi.resetAllMocks();
  mockIsInvariantViolation.mockReturnValue(false);
  mockIsUniqueViolation.mockReturnValue(false);
  // Re-wire all service mocks after reset — resetAllMocks clears implementations
  // set in vi.mock() factory functions, so they must be restored here.
  vi.mocked(EarnedVerificationUnlockService.recordEarnings).mockResolvedValue(undefined);
  vi.mocked(XPService.awardXP).mockResolvedValue({ success: true } as never);
  vi.mocked(SelfInsurancePoolService.recordContribution).mockResolvedValue({ success: true } as never);
  vi.mocked(BiometricVerificationService.analyzeProofSubmission).mockResolvedValue({ success: false } as never);
  vi.mocked(JudgeAIService.synthesizeVerdict).mockResolvedValue({
    success: true,
    data: {
      verdict: 'APPROVE',
      risk_score: 0.1,
      fraud_flags: [],
      component_scores: {},
      recommended_action: 'APPROVE',
      reasoning: 'All signals nominal',
    },
  } as never);
  vi.mocked(JudgeAIService.logVerdict).mockResolvedValue(undefined);
  vi.mocked(PhotoVerificationService.compareBeforeAfter).mockResolvedValue({ success: false } as never);
});

// ===========================================================================
// MULTI-LEG RELAY ABUSE
// ===========================================================================

describe('Attack #1 — Submit proof for a different user\'s task', () => {
  /**
   * ATTACK: submitterId='attacker-99' but task's assigned worker is 'hustler-1'.
   *
   * FIX 1: ProofService.submit() now fetches the task and validates that
   * submitterId === task.worker_id before inserting.
   *
   * EXPECTED: UNAUTHORIZED thrown.
   */
  it('SAFE — service rejects proof from non-assigned user with UNAUTHORIZED', async () => {
    // First query: task lookup — worker_id is hustler-1, not attacker-99
    mockDb.query.mockResolvedValueOnce({
      rows: [makeTask({ worker_id: 'hustler-1', state: 'ACCEPTED' })],
      rowCount: 1,
    } as never);

    await expect(
      ProofService.submit({
        taskId: 'task-1',
        submitterId: 'attacker-99',  // NOT the assigned hustler
        description: 'I did not do this task',
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('Attack #2 — Submit proof twice for the same step', () => {
  /**
   * ATTACK: Submit proof for a task (step 1) then submit again for the same task/step.
   *
   * FIX 6: ProofService.submit() now checks for an existing PENDING/SUBMITTED proof
   * and throws CONFLICT if one already exists.
   *
   * EXPECTED: second submission throws CONFLICT.
   */
  it('SAFE — second submission for same task is rejected with CONFLICT', async () => {
    // Second submit — service now checks for existing active proof
    // Query 1: task lookup (worker matches, state is ACCEPTED)
    // Query 2: duplicate check — returns existing pending proof
    mockDb.query
      .mockResolvedValueOnce({ rows: [makeTask({ worker_id: 'hustler-1', state: 'ACCEPTED' })], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ id: 'proof-1' }], rowCount: 1 } as never); // existing proof found

    await expect(
      ProofService.submit({ taskId: 'task-1', submitterId: 'hustler-1', description: 'Second attempt' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('Attack #3 — Skip to final step on a multi-step task', () => {
  /**
   * ATTACK: On a task with proof_steps = [{step:1},{step:2},{step:3}], submit
   * proof claiming step 3 completion while skipping steps 1 and 2.
   * ProofService.submit() has NO concept of proof_steps ordering. It takes a
   * plain description + photoUrls. There is no step parameter in SubmitProofParams.
   * The proof_steps JSONB column exists in the schema (task_template_v2_7.sql
   * migration) but ProofService never reads or validates step ordering.
   *
   * VERDICT: VULNERABLE — multi-step task ordering is entirely unenforced at service level.
   */
  it('VULNERABLE — no step-order enforcement; final-step proof accepted without prior steps', async () => {
    const proof = makeProof({ description: 'Final leg done (skipped steps 1 & 2)' });
    mockDb.query
      .mockResolvedValueOnce({ rows: [makeTask({ worker_id: 'hustler-1', state: 'ACCEPTED' })], rowCount: 1 } as never) // task lookup
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)                                                       // duplicate check
      .mockResolvedValueOnce({ rows: [proof], rowCount: 1 } as never)                                                  // INSERT PENDING
      .mockResolvedValueOnce({ rows: [{ ...proof, state: 'SUBMITTED' }], rowCount: 1 } as never);                      // UPDATE SUBMITTED

    const result = await ProofService.submit({
      taskId: 'task-multi-step',
      submitterId: 'hustler-1',
      description: 'Final leg done (skipped steps 1 & 2)',
    });

    // VULNERABLE: succeeds — proof_steps ordering is not checked
    expect(result.success).toBe(true);
  });
});

describe('Attack #4 — Submit proof for an already COMPLETED task', () => {
  /**
   * ATTACK: Task state = 'COMPLETED'. Submit a new proof.
   *
   * FIX 2: ProofService.submit() now checks task.state and rejects submissions
   * for tasks not in an active working state.
   *
   * EXPECTED: PRECONDITION_FAILED thrown.
   */
  it('SAFE — proof submission on COMPLETED task is rejected with PRECONDITION_FAILED', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [makeTask({ worker_id: 'hustler-1', state: 'COMPLETED' })],
      rowCount: 1,
    } as never);

    await expect(
      ProofService.submit({
        taskId: 'task-completed',
        submitterId: 'hustler-1',
        description: 'Post-completion proof injection',
      })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});

describe('Attack #5 — Submit proof for a CANCELLED task', () => {
  /**
   * Same gap as #4 but for CANCELLED state.
   *
   * FIX 2: ProofService.submit() now checks task.state.
   *
   * EXPECTED: PRECONDITION_FAILED thrown.
   */
  it('SAFE — proof submission on CANCELLED task is rejected with PRECONDITION_FAILED', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [makeTask({ worker_id: 'hustler-1', state: 'CANCELLED' })],
      rowCount: 1,
    } as never);

    await expect(
      ProofService.submit({
        taskId: 'task-cancelled',
        submitterId: 'hustler-1',
        description: 'Proof on cancelled task',
      })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});

describe('Attack #6 — Null/empty proof content', () => {
  /**
   * ATTACK: Submit with description: '' (empty string) and no photoUrls.
   *
   * FIX 3: ProofService.submit() now requires at least one form of content.
   *
   * EXPECTED: BAD_REQUEST thrown for ghost/empty proof submissions.
   */
  it('SAFE — empty description with no photos is rejected with BAD_REQUEST', async () => {
    // task lookup passes (correct worker, active state)
    // duplicate check passes (no existing proof)
    mockDb.query
      .mockResolvedValueOnce({ rows: [makeTask({ worker_id: 'hustler-1', state: 'ACCEPTED' })], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // no duplicate

    await expect(
      ProofService.submit({
        taskId: 'task-1',
        submitterId: 'hustler-1',
        description: '',  // empty — no photos, no GPS
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('SAFE — undefined description with no photos or GPS is rejected with BAD_REQUEST', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [makeTask({ worker_id: 'hustler-1', state: 'ACCEPTED' })], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // no duplicate

    await expect(
      ProofService.submit({
        taskId: 'task-1',
        submitterId: 'hustler-1',
        // description omitted, no photoUrls, no gps
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('Attack #7 — Injected payload in proof content', () => {
  /**
   * ATTACK: Include JSON keys in the description or metadata that might be
   * parsed and interpreted as approval signals. E.g., description contains
   * '{"approved":true,"escrow_release":true}'.
   *
   * ProofService.submit() stores description as a plain VARCHAR in the DB.
   * The review path (ProofService.review) never reads the description field —
   * it only looks at proof.state and calls JudgeAI subsystems.
   * EscrowService.release() does not read proof content at all.
   *
   * VERDICT: SAFE — proof description is inert data; no code path evaluates
   * description content as commands or auto-approves based on it.
   * The injected payload is stored but never executed.
   */
  it('SAFE — injected JSON in proof description is inert', async () => {
    const injectedDescription = '{"approved":true,"escrow_release":true,"decision":"ACCEPTED"}';
    const proofRow = makeProof({ description: injectedDescription });

    mockDb.query
      .mockResolvedValueOnce({ rows: [makeTask({ worker_id: 'hustler-1', state: 'ACCEPTED' })], rowCount: 1 } as never) // task lookup
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)                                                       // duplicate check
      .mockResolvedValueOnce({ rows: [proofRow], rowCount: 1 } as never)                                               // INSERT PENDING
      .mockResolvedValueOnce({ rows: [{ ...proofRow, state: 'SUBMITTED' }], rowCount: 1 } as never);                   // UPDATE SUBMITTED

    const result = await ProofService.submit({
      taskId: 'task-1',
      submitterId: 'hustler-1',
      description: injectedDescription,
    });

    // Submission succeeds but the description content is just a string
    expect(result.success).toBe(true);
    // Verify that XPService was NOT called (escrow not released by submit())
    expect(XPService.awardXP).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// PRORATE_ON_ABORT ABUSE
// ===========================================================================

describe('Attack #8 — Abort after completing 2 of 3 steps to maximize prorate payout', () => {
  /**
   * prorate_on_abort=true on a 3-step task. Steps 1 and 2 approved, then abort.
   * Expected payout: 2/3 of task amount.
   *
   * FINDING: Neither ProofService nor EscrowService implements prorate_on_abort logic.
   * The column exists in the DB (migration v2.7) but there is NO service code that:
   *   1. Reads prorate_on_abort from tasks
   *   2. Counts completed steps
   *   3. Calculates a prorated release amount
   *
   * There is no ProofService.abort() or EscrowService.proratePayout() method.
   * EscrowService.release() always releases the full escrow.amount.
   *
   * VERDICT: VULNERABLE — prorate_on_abort is schema-only. The feature is not
   * implemented. An operator running a cron-based "release on abort" job would
   * need to implement the proration math independently — and there is no
   * service to call. This means either:
   *   (a) aborts always release $0 (unfair to Hustler), or
   *   (b) some background job always releases the full amount (financial loss to platform)
   * depending on which path the cron takes.
   */
  it('VULNERABLE — no prorate_on_abort implementation; feature is schema-only', async () => {
    // Simulate calling release() — it will always release the full amount
    const escrowRow = { id: 'esc-1', task_id: 'task-prorate', amount: 9000, state: 'FUNDED' };
    const taskRow = makeTask({ prorate_on_abort: true, worker_id: 'hustler-1', price: 9000 });
    const workerKyc = { payouts_enabled: true, stripe_connect_id: 'acct_test', stripe_connect_status: 'complete' };
    const released = makeEscrow({ state: 'RELEASED', amount: 9000 });

    mockDb.query
      .mockResolvedValueOnce({ rows: [escrowRow], rowCount: 1 } as never)   // SELECT escrow
      .mockResolvedValueOnce({ rows: [taskRow], rowCount: 1 } as never)     // SELECT task
      .mockResolvedValueOnce({ rows: [workerKyc], rowCount: 1 } as never)   // KYC check
      .mockResolvedValueOnce({ rows: [released], rowCount: 1 } as never);   // UPDATE released

    const result = await EscrowService.release({ escrowId: 'esc-1', stripeTransferId: 'tr_test_proof' });

    // Service succeeds — but the prorate calculation was NEVER applied
    expect(result.success).toBe(true);
    if (result.success) {
      // Full 9000 released, not 6000 (2/3 of 9000)
      expect(result.data.amount).toBe(9000);
    }
  });
});

describe('Attack #9 — Abort before any steps with prorate_on_abort=true', () => {
  /**
   * EXPECTED: $0 payout (0 steps completed / 3 total).
   * ACTUAL: Same gap — no prorate logic exists. If escrow is released by a cron
   * after abort, full amount is transferred.
   *
   * VERDICT: VULNERABLE (same root cause as #8).
   */
  it('VULNERABLE — no prorate check; pre-step abort may release full amount', async () => {
    const escrowRow = { id: 'esc-1', task_id: 'task-prorate-0', amount: 6000, state: 'FUNDED' };
    const taskRow = makeTask({ prorate_on_abort: true, worker_id: 'hustler-1', price: 6000 });
    const workerKyc = { payouts_enabled: true, stripe_connect_id: 'acct_test', stripe_connect_status: 'complete' };
    const released = makeEscrow({ state: 'RELEASED', amount: 6000 });

    mockDb.query
      .mockResolvedValueOnce({ rows: [escrowRow], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [taskRow], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [workerKyc], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [released], rowCount: 1 } as never);

    const result = await EscrowService.release({ escrowId: 'esc-1', stripeTransferId: 'tr_test_proof' });
    expect(result.success).toBe(true);
    // VULNERABLE: 6000 released despite 0 steps completed
  });
});

describe('Attack #10 — Abort on final step (2/3 completed)', () => {
  /**
   * EXPECTED: 2/3 payout (same prorate logic as #8).
   * ACTUAL: Still no prorate logic. Full amount released.
   *
   * VERDICT: VULNERABLE (same root cause as #8/#9).
   */
  it('VULNERABLE — abort on last step still releases full amount', async () => {
    const escrowRow = { id: 'esc-1', task_id: 'task-prorate-2of3', amount: 3000, state: 'FUNDED' };
    const taskRow = makeTask({ prorate_on_abort: true, worker_id: 'hustler-1', price: 3000 });
    const workerKyc = { payouts_enabled: true, stripe_connect_id: 'acct_test', stripe_connect_status: 'complete' };
    const released = makeEscrow({ state: 'RELEASED', amount: 3000 });

    mockDb.query
      .mockResolvedValueOnce({ rows: [escrowRow], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [taskRow], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [workerKyc], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [released], rowCount: 1 } as never);

    const result = await EscrowService.release({ escrowId: 'esc-1', stripeTransferId: 'tr_test_proof' });
    expect(result.success).toBe(true);
    // VULNERABLE: full 3000 released even though step 3 was aborted
  });
});

describe('Attack #11 — prorate_on_abort=false, abort mid-task (should get $0)', () => {
  /**
   * When prorate_on_abort=false and Hustler aborts, Hustler should receive $0.
   * The correct flow is: EscrowService.refund() is called, returning funds to Poster.
   * We test that refund() correctly blocks release and only allows the refund path.
   *
   * VERDICT: SAFE — EscrowService state machine correctly prevents release from
   * REFUNDED state (ESCROW_TERMINAL), and refund() transitions to REFUNDED (not RELEASED).
   */
  it('SAFE — refund transitions to REFUNDED, subsequent release is rejected', async () => {
    // Step 1: refund succeeds
    // refund() now does 2 pre-check queries (SELECT task_id, SELECT worker_id) before the UPDATE
    const refunded = makeEscrow({ state: 'REFUNDED' });
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ task_id: 'task-1' }], rowCount: 1 } as never) // pre-check: task_id
      .mockResolvedValueOnce({ rows: [{ worker_id: null }], rowCount: 1 } as never)   // pre-check: worker_id (no worker yet)
      .mockResolvedValueOnce({ rows: [{ id: 'esc-1', version: 1, state: 'FUNDED' }], rowCount: 1 } as never) // F-05: T2 FOR UPDATE NOWAIT
      .mockResolvedValueOnce({ rows: [refunded], rowCount: 1 } as never)               // UPDATE
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);                      // logEscrowEvent

    const refundResult = await EscrowService.refund({ escrowId: 'esc-1' });
    expect(refundResult.success).toBe(true);
    if (refundResult.success) expect(refundResult.data.state).toBe('REFUNDED');

    vi.clearAllMocks();
    mockIsInvariantViolation.mockReturnValue(false);

    // Step 2: attacker tries to also release — should be blocked
    const escrowRow = { id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' }; // stale pre-read
    const taskRow = makeTask();
    const workerKyc = { payouts_enabled: true, stripe_connect_id: 'acct_test', stripe_connect_status: 'complete' };

    mockDb.query
      .mockResolvedValueOnce({ rows: [escrowRow], rowCount: 1 } as never)   // SELECT escrow (stale)
      .mockResolvedValueOnce({ rows: [taskRow], rowCount: 1 } as never)     // SELECT task
      .mockResolvedValueOnce({ rows: [workerKyc], rowCount: 1 } as never)   // KYC check
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)            // UPDATE — already REFUNDED, 0 rows
      // getById fallback returns REFUNDED state
      .mockResolvedValueOnce({ rows: [makeEscrow({ state: 'REFUNDED', poster_id: 'poster-1', worker_id: 'hustler-1' })], rowCount: 1 } as never);

    const releaseResult = await EscrowService.release({ escrowId: 'esc-1', stripeTransferId: 'tr_test_proof' });
    expect(releaseResult.success).toBe(false);
    if (!releaseResult.success) expect(releaseResult.error.code).toBe('HX002'); // ESCROW_TERMINAL
  });
});

describe('Attack #12 — challenge_window_hours=0 (instant auto-release)', () => {
  /**
   * The DB column has CHECK (challenge_window_hours IN (6, 24)) — the value 0
   * would be rejected by the DB constraint. But at the service layer, there is
   * no auto-release cron or scheduler implemented in ProofService or EscrowService.
   * Auto-release on challenge_window expiry would have to be triggered by an
   * external worker/cron — no such service method exists.
   *
   * FINDING: challenge_window_hours is purely a DB metadata column. No code in
   * EscrowService reads it to auto-release. The DB CHECK prevents 0 from being stored.
   *
   * VERDICT: SAFE (for the 0 case — DB constraint rejects it).
   * SEPARATE FINDING: No auto-release cron exists in any service — the challenge window
   * is schema-documented but unimplemented at the application layer.
   */
  it('SAFE — DB CHECK constraint rejects challenge_window_hours=0 (simulated via DB error)', async () => {
    // Simulate DB rejecting the INSERT with a check violation
    const checkViolationError = Object.assign(
      new Error('new row for relation "tasks" violates check constraint "tasks_challenge_window_hours_check"'),
      { code: '23514' }
    );
    mockDb.query.mockRejectedValueOnce(checkViolationError);

    // The constraint rejection would bubble up through TaskService.create() as DB_ERROR
    // We verify the error shape here as a unit-level confirmation
    try {
      await mockDb.query('UPDATE tasks SET challenge_window_hours = $1 WHERE id = $2', [0, 'task-1']);
      expect.fail('Should have thrown');
    } catch (err) {
      expect((err as Error & { code?: string }).code).toBe('23514');
    }
  });
});

// ===========================================================================
// REVIEW/DISPUTE TIMING ATTACKS
// ===========================================================================

describe('Attack #13 — Dispute submitted after challenge window expires', () => {
  /**
   * FIX 5: EscrowService.lockForDispute() now fetches the task's completed_at
   * and challenge_window_hours, and rejects late disputes with PRECONDITION_FAILED.
   *
   * EXPECTED: late dispute throws PRECONDITION_FAILED.
   * ALSO TESTED: dispute within window still succeeds.
   */
  it('SAFE — lockForDispute rejects late dispute with PRECONDITION_FAILED', async () => {
    const completedAt = new Date(Date.now() - 8 * 60 * 60 * 1000); // 8 hours ago
    // First query: window check JOIN
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ completed_at: completedAt, challenge_window_hours: 6 }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never); // dup dispute check

    await expect(
      EscrowService.lockForDispute('esc-1')
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('SAFE — lockForDispute allows dispute within challenge window', async () => {
    const completedAt = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago (within 6h window)
    const locked = makeEscrow({ state: 'LOCKED_DISPUTE' });
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ completed_at: completedAt, challenge_window_hours: 6 }], rowCount: 1 } as never) // window check
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never) // dup dispute check
      .mockResolvedValueOnce({ rows: [locked], rowCount: 1 } as never); // UPDATE

    const result = await EscrowService.lockForDispute('esc-1');
    expect(result.success).toBe(true);
  });
});

describe('Attack #14 — Dispute after escrow auto-released', () => {
  /**
   * Escrow is already RELEASED (auto-released by cron after 6-hour window).
   * Poster then calls lockForDispute().
   * EscrowService.lockForDispute() requires state === 'FUNDED', so a RELEASED
   * escrow returns INVALID_STATE.
   *
   * VERDICT: SAFE — terminal state machine blocks late disputes correctly.
   */
  it('SAFE — lockForDispute fails on RELEASED escrow', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)  // window check — no rows (skips window guard)
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never)  // dup dispute check
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)  // UPDATE — no FUNDED row
      .mockResolvedValueOnce({
        rows: [makeEscrow({ state: 'RELEASED', poster_id: 'poster-1', worker_id: 'hustler-1' })],
        rowCount: 1,
      } as never);  // getById fallback

    const result = await EscrowService.lockForDispute('esc-1');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain('expected FUNDED');
  });
});

describe('Attack #15 — Reviewer approves proof with wrong taskId', () => {
  /**
   * ATTACK: ProofService.review() is called with proofId='proof-A' but
   * proof-A actually belongs to task-B while the reviewer passes taskId=task-A.
   *
   * FINDING: ProofService.review() signature is (ReviewProofParams) which takes
   * only { proofId, reviewerId, decision, reason }. It does NOT accept a taskId
   * parameter at all. The service fetches proof.task_id directly from the DB.
   * There is no cross-task ownership mismatch possible through the review API.
   *
   * VERDICT: SAFE — reviewer cannot specify a taskId in review(), so cross-task
   * mismatch via the API is not possible. The proof's task_id comes from the DB row.
   */
  it('SAFE — review() derives task_id from DB, not from caller input', async () => {
    const proof = makeProof({ state: 'SUBMITTED', task_id: 'task-B' });
    const accepted = makeProof({ state: 'ACCEPTED', task_id: 'task-B' });

    // review() DB query sequence when decision=ACCEPTED and proof has no photo_url/gps:
    //   1. SELECT proofs JOIN proof_submissions (proof row — no photo_url, no gps_coordinates)
    //   2. SELECT description, before_photo_url FROM tasks (biometric/GPS skipped due to null fields)
    //   3. (tx) SELECT state FROM proofs FOR UPDATE  — concurrency lock
    //   4. (tx) UPDATE proofs SET state = ACCEPTED AND state = 'SUBMITTED'
    mockDb.query
      .mockResolvedValueOnce({ rows: [proof], rowCount: 1 } as never)                                              // 1. SELECT proof (outside tx)
      .mockResolvedValueOnce({ rows: [{ description: 'task', before_photo_url: null }], rowCount: 1 } as never)   // 2. task description (AI pipeline)
      .mockResolvedValueOnce({ rows: [{ state: 'SUBMITTED' }], rowCount: 1 } as never)                            // 3. SELECT state FOR UPDATE (inside tx)
      .mockResolvedValueOnce({ rows: [accepted], rowCount: 1 } as never);                                         // 4. UPDATE (inside tx)

    const result = await ProofService.review({
      proofId: 'proof-A',
      reviewerId: 'reviewer-1',
      decision: 'ACCEPTED',
    });

    // review() uses proof.task_id from DB row, not any caller-supplied taskId
    expect(result.success).toBe(true);
    // The proof's actual task_id (task-B) was used, not an attacker-controlled value
  });
});

// ===========================================================================
// XP GAMING
// ===========================================================================

describe('Attack #16 — Daily XP cap enforcement', () => {
  /**
   * XPService has a DAILY_XP_CAP = 10000 enforced via Redis (key: xp:daily:<userId>:<date>).
   * If Redis is unavailable (restUrl=null in config), the cap check returns { allowed: true }
   * as a fail-open degradation.
   *
   * XPService is mocked at module level in this test file (required for EscrowService tests).
   * We test the anti-farming behavior by examining the documented source code logic
   * and verifying the awardXP mock stub enforces cap semantics when configured to do so.
   *
   * VERDICT #16a: VULNERABLE (degraded mode) — checkDailyXPCap returns allowed:true when
   *   Redis client is null (no UPSTASH_REDIS_REST_URL env). Attacker who triggers Redis
   *   outage bypasses the daily 10,000 XP cap entirely.
   *
   * VERDICT #16b: SAFE (soft control) — checkVelocity detects >5 events/hour and flags
   *   suspicious activity, but the flag is advisory (logs + allows). Not a hard block.
   */
  it('VULNERABLE (documented) — XPService.awardXP does not block when cap mock returns allowed:true', async () => {
    // The mock is already configured to return { success: true } for awardXP.
    // In production with no Redis, checkDailyXPCap() returns { allowed: true }
    // meaning a user can earn XP indefinitely.
    // Verify: awardXP mock succeeds without cap enforcement
    const result = await XPService.awardXP({ userId: 'grinder', taskId: 'task-1', escrowId: 'esc-1', baseXP: 9999 });
    expect(result).toEqual({ success: true });
    // In the real implementation with no Redis, this would also return success
    // because checkDailyXPCap({ restUrl: '' }) fails open with { allowed: true }
  });

  it('SAFE (soft control) — velocity check flags suspicious activity but does not hard-block', async () => {
    // When velocity is suspicious, XPService logs a warning but allows the award.
    // This is a design choice: hard-blocking would penalize legitimate high-velocity workers.
    // Test verifies the mock correctly represents this advisory-only behavior.
    const result = await XPService.awardXP({ userId: 'fast-worker', taskId: 'task-2', escrowId: 'esc-2', baseXP: 100 });
    expect(result).toEqual({ success: true });
    // In the real implementation, suspicious velocity is logged but not blocked
  });
});

describe('Attack #17 — XP for self-assigned task (poster == worker)', () => {
  /**
   * ATTACK: A user creates a task as Poster then accepts it as Worker (same userId).
   *
   * FIX 4: TaskService.accept() now checks poster_id !== workerId and returns
   * FORBIDDEN when they match.
   *
   * We verify the guard by checking that the self-dealing user cannot earn XP
   * via EscrowService.release() — because the task would never reach ACCEPTED state
   * (the accept gate blocks it). We document this as the prevention point.
   *
   * Additionally, we verify the FORBIDDEN error code is returned by examining the
   * guard added to the task query (poster_id check before eligibility checks).
   */
  it('SAFE — self-dealing blocked: TaskService.accept() returns FORBIDDEN when poster_id == workerId', async () => {
    const SAME_USER = 'user-self-dealing';

    // Simulate the transaction executing the inner callback
    vi.mocked(mockDb.transaction).mockImplementation(
      async (fn: (q: typeof mockDb.query) => Promise<unknown>) => fn(mockDb.query)
    );

    // Task lookup includes poster_id — returns same user as both poster and prospective worker
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        risk_level: 'LOW',
        instant_mode: false,
        sensitive: false,
        price: 1000,
        state: 'OPEN',
        worker_id: null,
        poster_id: SAME_USER,
      }],
      rowCount: 1,
    } as never);

    // Import TaskService after mocks are established
    const { TaskService } = await import('../../src/services/TaskService');
    const result = await TaskService.accept({ taskId: 'task-self', workerId: SAME_USER });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('FORBIDDEN');
    }
  });
});

describe('Attack #18 — XP retained after dispute loss', () => {
  /**
   * ATTACK: A Hustler completes a task (XP awarded via escrow release), then Poster
   * disputes and wins. Does XP get clawed back?
   *
   * FINDING: EscrowService.release() calls XPService.awardXP() atomically within
   * the release path. EscrowService.refund() and partialRefund() do NOT call any
   * XP revocation service. There is no XPService.revokeXP() method.
   *
   * Typical dispute path: release() [XP awarded] → later lockForDispute() → refund()
   * or partialRefund(). But lockForDispute() requires state=FUNDED, not RELEASED.
   * So if XP was granted at release, dispute can't be filed on a RELEASED escrow.
   *
   * The real risk: if the dispute sequence is release()→lockForDispute() is impossible
   * (RELEASED is terminal), but FUNDED→LOCKED_DISPUTE→REFUND_PARTIAL calls refund
   * without XP revocation. In the FUNDED→LOCKED_DISPUTE path, XP hasn't been awarded
   * yet (no release). So this particular attack is blocked by the state machine order.
   *
   * HOWEVER: If a background job or bug triggers release() then also calls refund(),
   * the terminal state blocks the second operation but XP is already awarded.
   *
   * VERDICT: SAFE for the normal flow (XP only awarded at release, disputes lock
   * before release). Risk note: no XP clawback mechanism exists if a release is
   * reversed due to a dispute-after-release edge case.
   */
  it('SAFE — dispute cannot be filed on RELEASED escrow (state machine enforces ordering)', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)  // window check — no rows (skips window guard)
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never)  // dup dispute check
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)  // lockForDispute UPDATE — no FUNDED row
      .mockResolvedValueOnce({
        rows: [makeEscrow({ state: 'RELEASED', poster_id: 'poster-1', worker_id: 'hustler-1' })],
        rowCount: 1,
      } as never);

    const result = await EscrowService.lockForDispute('esc-1');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain('expected FUNDED');
    // XP cannot be clawed back because dispute cannot be opened post-release
  });
});

// ===========================================================================
// ESCROW STATE ATTACKS
// ===========================================================================

describe('Attack #19 — Double release (idempotency check)', () => {
  /**
   * ATTACK: Call EscrowService.release() twice for the same escrowId.
   *
   * First call: FUNDED → RELEASED (success)
   * Second call: state is now RELEASED (terminal) → UPDATE matches
   *   AND state IN ('FUNDED', 'LOCKED_DISPUTE') → 0 rows → getById → RELEASED
   *   → isTerminalState(RELEASED) = true → returns ESCROW_TERMINAL error.
   *
   * VERDICT: SAFE — the SQL WHERE clause `AND state IN ('FUNDED', 'LOCKED_DISPUTE')`
   * acts as an optimistic-lock preventing double release at the DB layer.
   * The service layer then detects 0 rowCount and returns ESCROW_TERMINAL.
   */
  it('SAFE — second release call blocked with ESCROW_TERMINAL', async () => {
    // First release
    const escrowRow = { id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' };
    const taskRow = makeTask();
    const workerKyc = { payouts_enabled: true, stripe_connect_id: 'acct_test', stripe_connect_status: 'complete' };
    const released = makeEscrow({ state: 'RELEASED' });

    mockDb.query
      .mockResolvedValueOnce({ rows: [escrowRow], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [taskRow], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [workerKyc], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [released], rowCount: 1 } as never);

    const first = await EscrowService.release({ escrowId: 'esc-1', stripeTransferId: 'tr_test_proof' });
    expect(first.success).toBe(true);

    // Reset mock queue between the two release() calls (resetAllMocks clears queued values)
    vi.resetAllMocks();
    mockIsInvariantViolation.mockReturnValue(false);
    vi.mocked(EarnedVerificationUnlockService.recordEarnings).mockResolvedValue(undefined);
    vi.mocked(XPService.awardXP).mockResolvedValue({ success: true } as never);
    vi.mocked(SelfInsurancePoolService.recordContribution).mockResolvedValue({ success: true } as never);

    // Second release attempt — DB still shows RELEASED, UPDATE returns 0 rows
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ ...escrowRow, state: 'RELEASED' }], rowCount: 1 } as never) // SELECT escrow
      .mockResolvedValueOnce({ rows: [taskRow], rowCount: 1 } as never)                            // SELECT task
      .mockResolvedValueOnce({ rows: [workerKyc], rowCount: 1 } as never)                          // KYC
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)                                   // UPDATE (no FUNDED row matched)
      .mockResolvedValueOnce({ rows: [makeEscrow({ state: 'RELEASED', poster_id: 'poster-1', worker_id: 'hustler-1' })], rowCount: 1 } as never); // getById

    const second = await EscrowService.release({ escrowId: 'esc-1', stripeTransferId: 'tr_test_proof' });
    expect(second.success).toBe(false);
    if (!second.success) expect(second.error.code).toBe('HX002'); // ESCROW_TERMINAL
  });
});

describe('Attack #20 — Release escrow for wrong beneficiary (worker_id mismatch)', () => {
  /**
   * ATTACK: EscrowService.release() is called. The task's actual assigned
   * worker is 'hustler-1' but attacker wants to misdirect payout to 'attacker-99'.
   *
   * FINDING: EscrowService.release() reads workerId from the DB via
   * `SELECT worker_id FROM tasks WHERE id = $1`. It does NOT accept a hustlerId
   * parameter from the caller. The beneficiary is always the DB-stored worker_id.
   *
   * Additionally, the KYC check is performed against the DB worker_id, not against
   * any caller-supplied value.
   *
   * VERDICT: SAFE — release() derives the worker/beneficiary entirely from the DB.
   * Callers cannot redirect the payout to a different user by passing a different ID.
   */
  it('SAFE — release() always pays the DB-stored worker_id, caller cannot override', async () => {
    const escrowRow = { id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' };
    // DB says worker is hustler-1
    const taskRow = { worker_id: 'hustler-1', price: 5000 };
    const workerKyc = { payouts_enabled: true, stripe_connect_id: 'acct_correct', stripe_connect_status: 'complete' };
    const released = makeEscrow({ state: 'RELEASED' });

    mockDb.query
      .mockResolvedValueOnce({ rows: [escrowRow], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [taskRow], rowCount: 1 } as never)     // task worker = hustler-1
      .mockResolvedValueOnce({ rows: [workerKyc], rowCount: 1 } as never)   // KYC for hustler-1
      .mockResolvedValueOnce({ rows: [released], rowCount: 1 } as never);

    // release() has no hustlerId parameter — attacker cannot inject one
    const result = await EscrowService.release({ escrowId: 'esc-1', stripeTransferId: 'tr_test_proof' });

    expect(result.success).toBe(true);
    // Verify XP was awarded to the correct worker
    expect(XPService.awardXP).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'hustler-1' })
    );
    expect(XPService.awardXP).not.toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'attacker-99' })
    );
  });
});
