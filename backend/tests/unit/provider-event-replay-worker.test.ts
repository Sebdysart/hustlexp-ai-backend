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
import { SyntheticFinancialAuthorityError } from '../../src/services/payment/SyntheticFinancialCommandAuthority.js';

const operationId = '10000000-0000-4000-8000-000000000001';
const observationId = '20000000-0000-4000-8000-000000000002';
const attemptId = '30000000-0000-4000-8000-000000000003';
const leaseToken = '40000000-0000-4000-8000-000000000004';
const providerEventReference = 'provider-event-replay-unit-1';

function rawWebhook() {
  return Buffer.from(JSON.stringify({
    providerKind: 'FAKE',
    operationId,
    idempotencyKey: 'provider-event-ingress:unit-0001',
    providerExpectedVersion: 0,
    providerEventReference,
    taskDraftId: '50000000-0000-4000-8000-000000000005',
    taskId: '60000000-0000-4000-8000-000000000006',
    scenario: 'DUPLICATE_WEBHOOK',
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
    providerEventKind: 'financial_operation.observed',
    operationId,
    rawPayload,
    rawPayloadSha256: createHash('sha256').update(rawPayload).digest('hex'),
    normalizationIdempotencyKey: `provider-event:${'a'.repeat(64)}`,
    ...overrides,
  };
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    operationId,
    operationKind: 'INGEST_WEBHOOK' as const,
    providerKind: 'FAKE' as const,
    state: 'ACCEPTED' as const,
    version: 1,
    amountCents: null,
    currency: null,
    externalReference: providerEventReference,
    idempotencyReplayed: false,
    retryable: false,
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
        state: 'ACCEPTED',
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

  it('validates exact raw evidence before invoking the fake application service', async () => {
    const assertAuthorized = vi.fn();
    const assertWebhookOperationBoundary = vi.fn().mockResolvedValue(undefined);
    const ingestWebhook = vi.fn().mockResolvedValue(result());
    const normalizer = new FakeProviderEventReplayNormalizer(
      assertAuthorized,
      () => ({ ingestWebhook }) as never,
      assertWebhookOperationBoundary,
    );
    const exactClaim = claim();

    await expect(normalizer.normalize(exactClaim)).resolves.toMatchObject({
      operationKind: 'INGEST_WEBHOOK',
      providerKind: 'FAKE',
    });
    expect(assertAuthorized).toHaveBeenCalledTimes(1);
    expect(assertWebhookOperationBoundary).toHaveBeenCalledWith(
      '50000000-0000-4000-8000-000000000005',
      '60000000-0000-4000-8000-000000000006',
      operationId,
    );
    expect(ingestWebhook).toHaveBeenCalledWith({
      providerKind: 'FAKE',
      operationId,
      idempotencyKey: exactClaim.normalizationIdempotencyKey,
      providerExpectedVersion: 0,
      providerEventReference,
      scenario: 'DUPLICATE_WEBHOOK',
      authenticated: true,
    });

    const tampered = claim({ rawPayloadSha256: '0'.repeat(64) });
    await expect(normalizer.normalize(tampered)).rejects.toEqual(
      new ProviderEventReplayNormalizationError('RAW_PAYLOAD_DIGEST_MISMATCH', false),
    );
    expect(ingestWebhook).toHaveBeenCalledTimes(1);
  });

  it('rechecks the controlled-test operation boundary before replay normalization', async () => {
    const ingestWebhook = vi.fn().mockResolvedValue(result());
    const assertWebhookOperationBoundary = vi.fn().mockRejectedValue(
      new SyntheticFinancialAuthorityError('WEBHOOK_OPERATION_OR_SYNTHETIC_BOUNDARY'),
    );
    const normalizer = new FakeProviderEventReplayNormalizer(
      vi.fn(),
      () => ({ ingestWebhook }) as never,
      assertWebhookOperationBoundary,
    );

    await expect(normalizer.normalize(claim())).rejects.toEqual(
      new ProviderEventReplayNormalizationError('WEBHOOK_OPERATION_BOUNDARY_REFUSED', false),
    );
    expect(assertWebhookOperationBoundary).toHaveBeenCalledTimes(1);
    expect(ingestWebhook).not.toHaveBeenCalled();
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
});
