import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FakeProviderEventReplayNormalizer,
  ProviderEventReplayNormalizationError,
  runProviderEventReplayBatch,
  startProviderEventReplayWorker,
  type ProviderEventReplayWorkerDependencies,
} from '../../src/jobs/provider-event-replay-worker.js';
import type {
  ProviderEventProcessingClaim,
  ProviderEventProcessingRepository,
} from '../../src/services/payment/ProviderEventProcessing.js';
import {
  ProviderObservationNormalizationError,
} from '../../src/services/payment/ProviderObservationNormalization.js';

const operationId = '10000000-0000-4000-8000-000000000001';
const observationId = '20000000-0000-4000-8000-000000000002';
const attemptId = '30000000-0000-4000-8000-000000000003';
const leaseToken = '40000000-0000-4000-8000-000000000004';
const providerEventReference = 'provider-event-replay-unit-1';

function rawWebhook() {
  return Buffer.from(JSON.stringify({
    version: 'HX_SYNTHETIC_FINANCIAL_OBSERVATION_V1',
    kind: 'FINANCIAL_OPERATION_OBSERVED',
    providerKind: 'FAKE',
    providerEventReference,
    operationId,
    operationKind: 'AUTHORIZE',
    predecessorProviderVersion: 0,
    observedProviderVersion: 1,
    observedState: 'SUCCEEDED',
    externalReference: 'fake-authorize-10000000',
    amountCents: 12_500,
    currency: 'USD',
    providerOccurredAt: '2026-08-28T20:00:00.000Z',
  }), 'utf8');
}

function claim(overrides: Partial<ProviderEventProcessingClaim> = {}): ProviderEventProcessingClaim {
  const rawPayload = rawWebhook();
  return {
    observationId,
    attemptId,
    attemptNumber: 1,
    retryableFailureCount: 0,
    leaseToken,
    leasedBy: 'provider-event-replay:unit',
    leasedAt: '2026-08-28T20:00:00.000Z',
    leaseExpiresAt: '2026-08-28T20:00:30.000Z',
    providerKind: 'FAKE',
    providerEventReference,
    providerEventKind: 'FINANCIAL_OPERATION_OBSERVED',
    operationId,
    rawPayload,
    rawPayloadSha256: createHash('sha256').update(rawPayload).digest('hex'),
    normalizationIdempotencyKey: `provider-event:${'a'.repeat(64)}`,
    ...overrides,
  };
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    normalizationId: '50000000-0000-4000-8000-000000000005',
    observationId,
    commandId: '60000000-0000-4000-8000-000000000006',
    dispatchAttemptId: '70000000-0000-4000-8000-000000000007',
    outcomeFactId: '80000000-0000-4000-8000-000000000008',
    operationId,
    operationKind: 'AUTHORIZE' as const,
    providerKind: 'FAKE' as const,
    predecessorProviderVersion: 0,
    state: 'SUCCEEDED' as const,
    version: 1,
    amountCents: 12_500,
    currency: 'USD',
    materializationState: 'TERMINAL_CORROBORATED' as const,
    providerOccurredAt: '2026-08-28T20:00:00.000Z',
    normalizedAt: '2026-08-28T20:00:01.000Z',
    followupDueAt: null,
    expiresAt: null,
    idempotencyReplayed: false,
    ...overrides,
  };
}

function dependencies(
  claimValue: ProviderEventProcessingClaim,
  normalize: ReturnType<typeof vi.fn>,
): {
  value: ProviderEventReplayWorkerDependencies;
  repository: {
    claimNext: ReturnType<typeof vi.fn>;
    completeSuccess: ReturnType<typeof vi.fn>;
    completeRetryableFailure: ReturnType<typeof vi.fn>;
    completeTerminalFailure: ReturnType<typeof vi.fn>;
  };
  assertAuthorized: ReturnType<typeof vi.fn>;
} {
  const repository = {
    claimNext: vi.fn()
      .mockResolvedValueOnce(claimValue)
      .mockResolvedValue(null),
    completeSuccess: vi.fn().mockResolvedValue({ outcomeKind: 'SUCCEEDED' }),
    completeRetryableFailure: vi.fn().mockResolvedValue({ outcomeKind: 'RETRYABLE_FAILED' }),
    completeTerminalFailure: vi.fn().mockResolvedValue({ outcomeKind: 'TERMINAL_FAILED' }),
  };
  const assertAuthorized = vi.fn();
  return {
    repository,
    assertAuthorized,
    value: {
      repository: repository as unknown as ProviderEventProcessingRepository,
      normalizer: { normalize },
      assertAuthorized,
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('provider-event replay worker', () => {
  it('normalizes one claim with its provider-event identity and appends success', async () => {
    const normalize = vi.fn().mockResolvedValue(result());
    const runtime = dependencies(claim(), normalize);

    await expect(runProviderEventReplayBatch({
      workerId: 'provider-event-replay:unit',
      batchSize: 2,
    }, runtime.value)).resolves.toEqual({
      claimed: 1,
      succeeded: 1,
      retryableFailed: 0,
      terminalFailed: 0,
    });
    expect(runtime.assertAuthorized).toHaveBeenCalledTimes(1);
    expect(runtime.repository.claimNext).toHaveBeenCalledWith(
      'provider-event-replay:unit',
      30_000,
    );
    expect(runtime.repository.completeSuccess).toHaveBeenCalledWith({
      observationId,
      attemptId,
      leaseToken,
      result: {
        operationId,
        version: 1,
        state: 'SUCCEEDED',
        idempotencyReplayed: false,
      },
    });
  });

  it('records unknown failures as retryable without leaking an error message', async () => {
    const normalize = vi.fn().mockRejectedValue(new Error('database host and secret detail'));
    const runtime = dependencies(claim(), normalize);

    await expect(runProviderEventReplayBatch({
      workerId: 'provider-event-replay:retry',
      batchSize: 1,
      baseRetryDelayMs: 1_000,
    }, runtime.value)).resolves.toMatchObject({ retryableFailed: 1 });
    expect(runtime.repository.completeRetryableFailure).toHaveBeenCalledWith({
      observationId,
      attemptId,
      leaseToken,
      detailCode: 'NORMALIZATION_TEMPORARILY_UNAVAILABLE',
      retryDelayMs: 1_000,
    });
    expect(JSON.stringify(runtime.repository.completeRetryableFailure.mock.calls))
      .not.toContain('database host');
  });

  it('records permanent binding failures and exhausted retries as terminal', async () => {
    const permanent = dependencies(
      claim(),
      vi.fn().mockRejectedValue(
        new ProviderEventReplayNormalizationError('OBSERVATION_BINDING_MISMATCH', false),
      ),
    );
    await runProviderEventReplayBatch({
      workerId: 'provider-event-replay:terminal',
      batchSize: 1,
    }, permanent.value);
    expect(permanent.repository.completeTerminalFailure).toHaveBeenCalledWith(
      expect.objectContaining({ detailCode: 'OBSERVATION_BINDING_MISMATCH' }),
    );

    const exhausted = dependencies(
      claim({ retryableFailureCount: 7 }),
      vi.fn().mockRejectedValue(new Error('temporary')),
    );
    await runProviderEventReplayBatch({
      workerId: 'provider-event-replay:exhausted',
      batchSize: 1,
      maxRetryableFailures: 8,
    }, exhausted.value);
    expect(exhausted.repository.completeTerminalFailure).toHaveBeenCalledWith(
      expect.objectContaining({ detailCode: 'NORMALIZATION_TEMPORARILY_UNAVAILABLE' }),
    );
    expect(exhausted.repository.completeRetryableFailure).not.toHaveBeenCalled();
  });

  it('validates exact raw evidence and normalizes without provider dispatch', async () => {
    const assertAuthorized = vi.fn();
    const normalizeAuthenticatedObservation = vi.fn().mockResolvedValue(result());
    const normalizer = new FakeProviderEventReplayNormalizer(
      assertAuthorized,
      { normalizeAuthenticatedObservation },
    );
    const exactClaim = claim();

    await expect(normalizer.normalize(exactClaim)).resolves.toMatchObject({
      operationKind: 'AUTHORIZE',
      providerKind: 'FAKE',
    });
    expect(assertAuthorized).toHaveBeenCalledTimes(1);
    expect(normalizeAuthenticatedObservation).toHaveBeenCalledWith(observationId);

    const tampered = claim({ rawPayloadSha256: '0'.repeat(64) });
    await expect(normalizer.normalize(tampered)).rejects.toEqual(
      new ProviderEventReplayNormalizationError('RAW_PAYLOAD_DIGEST_MISMATCH', false),
    );
    expect(normalizeAuthenticatedObservation).toHaveBeenCalledTimes(1);
  });

  it('treats database causal-authority refusal as terminal without provider dispatch', async () => {
    const normalizeAuthenticatedObservation = vi.fn().mockRejectedValue(
      new ProviderObservationNormalizationError('AUTHORITY_REFUSED'),
    );
    const normalizer = new FakeProviderEventReplayNormalizer(
      vi.fn(),
      { normalizeAuthenticatedObservation },
    );

    await expect(normalizer.normalize(claim())).rejects.toEqual(
      new ProviderEventReplayNormalizationError('OBSERVATION_AUTHORITY_REFUSED', false),
    );
    expect(normalizeAuthenticatedObservation).toHaveBeenCalledTimes(1);
  });

  it('refuses scheduling before creating a timer when the nonproduction gate fails', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const runtime = dependencies(claim(), vi.fn());
    runtime.assertAuthorized.mockImplementation(() => {
      throw new Error('NONPRODUCTION_FAKE_FINANCE_REFUSED:PRODUCTION');
    });

    expect(() => startProviderEventReplayWorker(5_000, {}, runtime.value)).toThrow(
      'NONPRODUCTION_FAKE_FINANCE_REFUSED:PRODUCTION',
    );
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(runtime.repository.claimNext).not.toHaveBeenCalled();
  });

  it('waits for the in-flight lease before reporting a stopped worker', async () => {
    let settle: ((value: ReturnType<typeof result>) => void) | undefined;
    const normalize = vi.fn(() => new Promise<ReturnType<typeof result>>((resolve) => {
      settle = resolve;
    }));
    const runtime = dependencies(claim(), normalize);
    const handle = startProviderEventReplayWorker(5_000, {
      workerId: 'provider-event-replay:drain',
      batchSize: 1,
    }, runtime.value);

    await vi.waitFor(() => expect(handle.health().inFlight).toBe(true));
    let stopped = false;
    const stopping = handle.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    settle?.(result());
    await stopping;
    expect(handle.health()).toEqual({
      status: 'stopped',
      inFlight: false,
      consecutiveFailures: 0,
      lastFailureCode: null,
    });
  });

  it('surfaces a degraded health state after an unhandled batch failure', async () => {
    const runtime = dependencies(claim(), vi.fn());
    runtime.repository.claimNext.mockRejectedValueOnce(new Error('database unavailable'));
    const handle = startProviderEventReplayWorker(5_000, {
      workerId: 'provider-event-replay:degraded',
      batchSize: 1,
    }, runtime.value);

    await vi.waitFor(() => expect(handle.health()).toMatchObject({
      status: 'degraded',
      inFlight: false,
      consecutiveFailures: 1,
      lastFailureCode: 'BATCH_FAILED',
    }));
    await handle.stop();
  });
});
