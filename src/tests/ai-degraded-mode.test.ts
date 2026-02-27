/**
 * AI Degraded Mode Tests — Task 13
 *
 * Verifies:
 *  1. isDegradedMode() returns true when AI_DEGRADED_MODE=true
 *  2. handleDegradedRequest() returns the queued payload with a jobId
 *  3. /health/ai reports degradedMode: true when env flag is set
 *  4. areAllCircuitsOpen() triggers degraded mode when all breakers are open
 *  5. Queue helpers work correctly (enqueue / get / dequeue)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// We test the utility modules directly — no HTTP server needed.
// ---------------------------------------------------------------------------

describe('AI degraded mode — env flag', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('isDegradedMode() returns true when AI_DEGRADED_MODE=true', async () => {
    vi.stubEnv('AI_DEGRADED_MODE', 'true');

    // Re-import to pick up stubbed env via the Proxy in src/config/env.ts
    const { isDegradedMode } = await import('../ai/degradedMode.js');
    expect(isDegradedMode()).toBe(true);
  });

  it('isDegradedMode() returns false when AI_DEGRADED_MODE is not set', async () => {
    vi.stubEnv('AI_DEGRADED_MODE', 'false');

    const { isDegradedMode } = await import('../ai/degradedMode.js');
    // Circuits are all CLOSED by default, so false
    expect(isDegradedMode()).toBe(false);
  });
});

describe('AI degraded mode — handleDegradedRequest()', () => {
  it('returns status=queued with a non-empty jobId', async () => {
    const { handleDegradedRequest } = await import('../ai/degradedMode.js');
    const result = handleDegradedRequest('user-123', 'find me a task', 'chat');

    expect(result.status).toBe('queued');
    expect(typeof result.jobId).toBe('string');
    expect(result.jobId.length).toBeGreaterThan(0);
    expect(typeof result.message).toBe('string');
  });

  it('each call produces a unique jobId', async () => {
    const { handleDegradedRequest } = await import('../ai/degradedMode.js');
    const r1 = handleDegradedRequest('user-1', 'msg1', 'chat');
    const r2 = handleDegradedRequest('user-1', 'msg2', 'chat');
    expect(r1.jobId).not.toBe(r2.jobId);
  });
});

describe('AI degraded mode — queue helpers', () => {
  it('enqueueAIRequest stores and retrieves a job', async () => {
    const { enqueueAIRequest, getQueuedJob, dequeueJob } = await import('../ai/degradedMode.js');
    const job = enqueueAIRequest('u-42', 'hello', 'chat');

    expect(job.userId).toBe('u-42');
    expect(job.message).toBe('hello');
    expect(job.mode).toBe('chat');
    expect(job.enqueuedAt).toBeLessThanOrEqual(Date.now());
    expect(job.expiresAt).toBeGreaterThan(job.enqueuedAt);

    const retrieved = getQueuedJob(job.jobId);
    expect(retrieved).toEqual(job);

    dequeueJob(job.jobId);
    expect(getQueuedJob(job.jobId)).toBeUndefined();
  });

  it('getQueueDepth reflects queue size', async () => {
    const { enqueueAIRequest, dequeueJob, getQueueDepth } = await import('../ai/degradedMode.js');
    const before = getQueueDepth();
    const job = enqueueAIRequest('u-depth', 'test', 'chat');
    expect(getQueueDepth()).toBe(before + 1);
    dequeueJob(job.jobId);
    expect(getQueueDepth()).toBe(before);
  });
});

describe('AI degraded mode — circuit breaker integration', () => {
  // Clean up circuit state after each test to prevent bleed between tests
  afterEach(async () => {
    const { resetCircuit } = await import('../utils/reliability.js');
    for (const p of ['openai', 'groq', 'deepseek', 'anthropic']) {
      resetCircuit(p);
    }
  });

  it('areAllCircuitsOpen() returns false when no failures recorded', async () => {
    const { areAllCircuitsOpen } = await import('../utils/reliability.js');
    // Default state — all CLOSED
    expect(areAllCircuitsOpen()).toBe(false);
  });

  it('recordFailure() increments count; resetCircuit() clears state', async () => {
    const { recordFailure, getProviderHealth, resetCircuit } = await import('../utils/reliability.js');

    // Trigger several failures for a test provider that already exists
    for (let i = 0; i < 5; i++) recordFailure('groq');

    const health = getProviderHealth();
    expect(health['groq'].state).toBe('OPEN');
    expect(health['groq'].failures).toBeGreaterThanOrEqual(5);

    resetCircuit('groq');
    const after = getProviderHealth();
    expect(after['groq'].state).toBe('CLOSED');
    expect(after['groq'].failures).toBe(0);
  });

  it('isDegradedMode() returns true when all AI circuit breakers are OPEN', async () => {
    const { recordFailure, resetCircuit } = await import('../utils/reliability.js');
    const { isDegradedMode } = await import('../ai/degradedMode.js');

    // Reset env flag to ensure we're testing the circuit path, not the env path
    const originalVal = process.env.AI_DEGRADED_MODE;
    delete process.env.AI_DEGRADED_MODE;

    // Open all 4 circuits by recording 5 failures each
    const providers = ['openai', 'groq', 'deepseek', 'anthropic'];
    providers.forEach(p => {
      for (let i = 0; i < 5; i++) recordFailure(p);
    });

    expect(isDegradedMode()).toBe(true);

    // Cleanup
    providers.forEach(p => resetCircuit(p));
    if (originalVal !== undefined) process.env.AI_DEGRADED_MODE = originalVal;
  });
});

describe('/health/ai endpoint response shape', () => {
  it('getAllCircuitStates() returns an object keyed by provider name', async () => {
    const { getAllCircuitStates } = await import('../utils/reliability.js');
    const states = getAllCircuitStates();

    expect(typeof states).toBe('object');
    // At minimum the four AI providers must be registered
    for (const provider of ['openai', 'groq', 'deepseek', 'anthropic']) {
      expect(Object.keys(states)).toContain(provider);
      expect(['CLOSED', 'OPEN', 'HALF_OPEN']).toContain(states[provider]);
    }
  });

  it('degradedMode flag reflects AI_DEGRADED_MODE env var via env Proxy', async () => {
    // The env Proxy reads process.env at call time — simulate the check the
    // /health/ai handler performs without spinning up Fastify.
    const original = process.env.AI_DEGRADED_MODE;
    try {
      process.env.AI_DEGRADED_MODE = 'true';
      // The Proxy in src/config/env.ts reads process.env dynamically at access time,
      // so the already-imported module reflects the new value immediately.
      const { env } = await import('../config/env.js');
      expect(env['AI_DEGRADED_MODE']).toBe('true');

      process.env.AI_DEGRADED_MODE = 'false';
      expect(env['AI_DEGRADED_MODE']).toBe('false');
    } finally {
      if (original === undefined) {
        delete process.env.AI_DEGRADED_MODE;
      } else {
        process.env.AI_DEGRADED_MODE = original;
      }
    }
  });
});
