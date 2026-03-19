/**
 * OnboardingAIService Unit Tests
 *
 * Covers the LLM response validation layer added to fix the HIGH vulnerability
 * where raw LLM output (unclamped numbers, unchecked enum strings) was written
 * directly to the users table.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
  isInvariantViolation: vi.fn(() => false),
  getErrorMessage: vi.fn((code: string) => code),
}));

vi.mock('../../src/logger', () => ({
  logger: { child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
  aiLogger: { child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

vi.mock('../../src/lib/pii-scrubber', () => ({
  scrubPII: (s: string) => s,
}));

vi.mock('../../src/services/AIEventService', () => ({
  AIEventService: {
    create: vi.fn().mockResolvedValue({ success: true, data: { id: 'evt-1' } }),
  },
}));

vi.mock('../../src/services/AIJobService', () => ({
  AIJobService: {
    create: vi.fn().mockResolvedValue({ success: true, data: { id: 'job-1' } }),
    start: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/services/AIProposalService', () => ({
  AIProposalService: {
    create: vi.fn().mockResolvedValue({ success: true, data: { id: 'prop-1' } }),
  },
}));

vi.mock('../../src/services/AIDecisionService', () => ({
  AIDecisionService: {
    create: vi.fn().mockResolvedValue({ success: true, data: { id: 'dec-1' } }),
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

import { db } from '../../src/db';
import { OnboardingAIService } from '../../src/services/OnboardingAIService';

const mockQuery = db.query as ReturnType<typeof vi.fn>;

/** Build a fake Anthropic API Response that wraps the given JSON content. */
function makeFetchResponse(jsonContent: string, ok = true) {
  const body = {
    content: [{ text: jsonContent }],
  };
  return Promise.resolve({
    ok,
    json: () => Promise.resolve(body),
  } as Response);
}

const baseUserRow = {
  id: 'user-1',
  role_confidence_worker: 0.5,
  role_confidence_poster: 0.5,
  role_certainty_tier: 'WEAK',
};

const calibrationParams = {
  userId: 'user-1',
  calibrationPrompt: 'I want to earn money by doing tasks',
  onboardingVersion: '1.0.0',
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: db.query returns a user row so submitCalibration can finish
  mockQuery.mockResolvedValue({ rows: [baseUserRow] });
  // Default: no ANTHROPIC_API_KEY so the fetch branch is skipped
  delete process.env.ANTHROPIC_API_KEY;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OnboardingAIService.submitCalibration — LLM response validation', () => {
  it('uses default balanced inference when ANTHROPIC_API_KEY is absent', async () => {
    const result = await OnboardingAIService.submitCalibration(calibrationParams);

    expect(result.success).toBe(true);
    if (!result.success) return;
    // Default inference set before the fetch call
    expect(result.data.roleConfidenceWorker).toBe(0.5);
    expect(result.data.roleConfidencePoster).toBe(0.5);
    expect(result.data.certaintyTier).toBe('WEAK');
  });

  it('accepts a valid LLM response and stores the values', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    global.fetch = vi.fn().mockImplementation(() =>
      makeFetchResponse(JSON.stringify({ worker: 0.8, poster: 0.2, certainty: 'STRONG' }))
    );

    const result = await OnboardingAIService.submitCalibration(calibrationParams);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.roleConfidenceWorker).toBe(0.8);
    expect(result.data.roleConfidencePoster).toBe(0.2);
    expect(result.data.certaintyTier).toBe('STRONG');

    // Verify the values actually written to DB are the validated ones
    const dbCall = mockQuery.mock.calls[0][1] as unknown[];
    expect(dbCall[0]).toBe(0.8);
    expect(dbCall[1]).toBe(0.2);
    expect(dbCall[2]).toBe('STRONG');
  });

  it('rejects out-of-range worker value (999) and falls back to default inference', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    global.fetch = vi.fn().mockImplementation(() =>
      makeFetchResponse(JSON.stringify({ worker: 999, poster: -500, certainty: 'MODERATE' }))
    );

    const result = await OnboardingAIService.submitCalibration(calibrationParams);

    expect(result.success).toBe(true);
    if (!result.success) return;
    // Should fall back to the default values set before the API call
    expect(result.data.roleConfidenceWorker).toBe(0.5);
    expect(result.data.roleConfidencePoster).toBe(0.5);
    expect(result.data.certaintyTier).toBe('WEAK');

    // Confirm the DB write used the safe defaults, not the malicious values
    const dbCall = mockQuery.mock.calls[0][1] as unknown[];
    expect(dbCall[0]).not.toBe(999);
    expect(dbCall[1]).not.toBe(-500);
    expect(dbCall[0]).toBe(0.5);
    expect(dbCall[1]).toBe(0.5);
  });

  it('rejects invalid certainty tier string (EVIL_STRING) and falls back to default inference', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    global.fetch = vi.fn().mockImplementation(() =>
      makeFetchResponse(JSON.stringify({ worker: 0.7, poster: 0.3, certainty: 'EVIL_STRING' }))
    );

    const result = await OnboardingAIService.submitCalibration(calibrationParams);

    expect(result.success).toBe(true);
    if (!result.success) return;
    // certainty is invalid → entire object fails validation → default inference used
    expect(result.data.certaintyTier).toBe('WEAK');
    expect(['STRONG', 'MODERATE', 'WEAK']).toContain(result.data.certaintyTier);

    // DB must never receive 'EVIL_STRING'
    const dbCall = mockQuery.mock.calls[0][1] as unknown[];
    expect(dbCall[2]).not.toBe('EVIL_STRING');
  });

  it('falls back to default inference when Anthropic API returns non-ok status', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    global.fetch = vi.fn().mockImplementation(() =>
      makeFetchResponse('', false /* ok=false */)
    );

    const result = await OnboardingAIService.submitCalibration(calibrationParams);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.roleConfidenceWorker).toBe(0.5);
    expect(result.data.roleConfidencePoster).toBe(0.5);
  });

  it('falls back to default inference when Anthropic response contains no JSON', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    global.fetch = vi.fn().mockImplementation(() =>
      makeFetchResponse('Sorry, I cannot help with that.')
    );

    const result = await OnboardingAIService.submitCalibration(calibrationParams);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.roleConfidenceWorker).toBe(0.5);
  });

  it('falls back to default inference when fetch throws', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    global.fetch = vi.fn().mockRejectedValue(new Error('Network timeout'));

    const result = await OnboardingAIService.submitCalibration(calibrationParams);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.roleConfidenceWorker).toBe(0.5);
  });
});

describe('OnboardingAIService.getInferenceResult', () => {
  it('returns null when user has no inference yet', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ role_confidence_worker: null, role_confidence_poster: null, role_certainty_tier: null, inconsistency_flags: [] }],
    });

    const result = await OnboardingAIService.getInferenceResult('user-1');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toBeNull();
  });

  it('returns inference data when present', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        role_confidence_worker: 0.9,
        role_confidence_poster: 0.1,
        role_certainty_tier: 'STRONG',
        inconsistency_flags: [],
      }],
    });

    const result = await OnboardingAIService.getInferenceResult('user-1');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data?.roleConfidenceWorker).toBe(0.9);
    expect(result.data?.certaintyTier).toBe('STRONG');
  });
});

describe('OnboardingAIService.confirmRole', () => {
  it('updates user default_mode to worker', async () => {
    const userRow = { id: 'user-1', default_mode: 'worker', role_was_overridden: false };
    mockQuery.mockResolvedValueOnce({ rows: [userRow] });

    const result = await OnboardingAIService.confirmRole({
      userId: 'user-1',
      confirmedMode: 'worker',
    });

    expect(result.success).toBe(true);
    const dbCall = mockQuery.mock.calls[0][1] as unknown[];
    expect(dbCall[0]).toBe('worker');
    expect(dbCall[1]).toBe(false); // overrideAI defaults to false
  });

  it('returns NOT_FOUND when user does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await OnboardingAIService.confirmRole({
      userId: 'ghost-user',
      confirmedMode: 'poster',
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });
});
