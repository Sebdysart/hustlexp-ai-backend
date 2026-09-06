import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { AppVariables } from '../../src/serverTypes.js';

vi.mock('../../src/config.js', () => ({
  config: { app: { isDevelopment: true, allowedOrigins: [] } },
}));
vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/middleware/security.js', () => {
  const pass: MiddlewareHandler = async (_context, next) => {
    await next();
  };
  return {
    securityHeaders: pass,
    aiRateLimitMiddleware: () => pass,
    publicIpRateLimitMiddleware: () => pass,
    rateLimitMiddleware: () => pass,
  };
});
vi.mock('../../src/monitoring/http-metrics.js', () => ({
  httpMetricsMiddleware: () => async (_context: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  ingest: vi.fn(),
  recordInbox: vi.fn(),
  query: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  db: { query: mocks.query },
}));

vi.mock('../../src/services/payment/NonproductionFinancialAuthorization.js', () => ({
  assertNonproductionFakeFinanceAuthorized: mocks.authorize,
}));

vi.mock('../../src/services/payment/SealedSyntheticFinancialWebhookInbox.js', () => ({
  SealedSyntheticFinancialWebhookInbox: class {
    record(input: unknown) {
      return mocks.recordInbox(input);
    }
  },
}));

vi.mock('../../src/services/payment/ProviderEventInbox.js', () => ({
  ProviderEventInboxError: class ProviderEventInboxError extends Error {
    constructor(readonly reason: string) {
      super(`PROVIDER_EVENT_INBOX_${reason}`);
    }
  },
  PostgresProviderEventInboxRepository: class {
    recordAuthenticatedEvent(input: unknown) {
      return mocks.recordInbox(input);
    }
  },
}));

vi.mock('../../src/services/payment/UniversalV1FinancialApplicationService.js', () => ({
  createUniversalV1FakeFinancialApplicationService: () => ({ ingestWebhook: mocks.ingest }),
}));

import { syntheticFinancialWebhook } from '../../src/serverSyntheticFinancialWebhook.js';
import { registerCoreMiddleware } from '../../src/serverMiddleware.js';

const secret = 'synthetic-webhook-secret-that-is-at-least-32-bytes';
const payload = {
  version: 'HX_SYNTHETIC_FINANCIAL_OBSERVATION_V1',
  kind: 'FINANCIAL_OPERATION_OBSERVED',
  providerKind: 'FAKE',
  providerEventReference: 'synthetic-provider-event-1',
  operationId: '00000000-0000-4000-8000-000000000401',
  operationKind: 'AUTHORIZE',
  predecessorProviderVersion: 0,
  observedProviderVersion: 1,
  observedState: 'SUCCEEDED',
  externalReference: 'fake-authorize-000401',
  amountCents: 12_500,
  currency: 'USD',
  providerOccurredAt: '2026-08-28T20:00:00.000Z',
} as const;

function signature(body: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

function expectedNormalizationKey(): string {
  return `provider-event:${createHash('sha256')
    .update(`${payload.providerKind}\0${payload.providerEventReference}`, 'utf8')
    .digest('hex')}`;
}

function app(withCoreMiddleware = false) {
  const instance = new Hono<{ Variables: AppVariables }>();
  if (withCoreMiddleware) registerCoreMiddleware(instance);
  instance.post('/webhooks/fake-financial', syntheticFinancialWebhook);
  instance.post('/ordinary', (context) => context.text('accepted'));
  return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ingest.mockResolvedValue({
    operationId: payload.operationId,
    version: 1,
    state: 'ACCEPTED',
    idempotencyReplayed: false,
  });
  mocks.recordInbox.mockResolvedValue({
    observationId: '00000000-0000-4000-8000-000000000404',
    receiptId: '00000000-0000-4000-8000-000000000405',
    observationReplayed: false,
    idempotencyReplayed: false,
  });
  mocks.query.mockResolvedValue({ rows: [{ authorized: true }], rowCount: 1 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('synthetic financial webhook', () => {
  it('rejects a missing key identity and malformed UTF-8 before sealed persistence', async () => {
    const body = JSON.stringify(payload);
    const missing = await app().request('/webhooks/fake-financial', {
      method: 'POST',
      headers: { 'x-hustlexp-fake-finance-signature': signature(body) },
      body,
    });
    expect(missing.status).toBe(401);
    const malformed = await app().request('/webhooks/fake-financial', {
      method: 'POST',
      headers: {
        'x-hustlexp-fake-finance-key-id': payload.operationId,
        'x-hustlexp-fake-finance-signature': signature(body),
      },
      body: new Uint8Array([0xff, 0xfe]),
    });
    expect(malformed.status).toBe(400);
    expect(mocks.recordInbox).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'bounds chunked input before persistence with core middleware enabled: %s',
    async (withCoreMiddleware) => {
      let cancelled = false;
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(8192));
        },
        cancel() {
          cancelled = true;
        },
      });
      const request = new Request('http://localhost/webhooks/fake-financial', {
        method: 'POST',
        headers: {
          'x-hustlexp-fake-finance-key-id': payload.operationId,
          'x-hustlexp-fake-finance-signature': 'a'.repeat(64),
        },
        body,
        duplex: 'half',
      } as RequestInit);
      const response = await app(withCoreMiddleware).fetch(request);
      expect(response.status).toBe(413);
      expect(cancelled).toBe(true);
      // Three 8 KiB chunks detect excess, with at most one stream-prefetched chunk.
      expect(pulls).toBeLessThanOrEqual(4);
      expect(mocks.recordInbox).not.toHaveBeenCalled();
    }
  );

  it('preserves the ordinary request limit alongside the webhook streaming bound', async () => {
    const response = await app(true).request('/ordinary', {
      method: 'POST',
      body: 'x',
      headers: { 'content-length': String(10 * 1024 * 1024 + 1) },
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'Request body too large', maxSize: '10MB' });
  });
  it('is absent when the exact nonproduction manifest gate refuses runtime authority', async () => {
    mocks.authorize.mockImplementationOnce(() => {
      throw new Error('NONPRODUCTION_FAKE_FINANCE_REFUSED:PRODUCTION');
    });
    const response = await app().request('/webhooks/fake-financial', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(404);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('rejects missing and invalid service authentication before parsing the observation', async () => {
    const body = JSON.stringify(payload);
    const missing = await app().request('/webhooks/fake-financial', {
      method: 'POST',
      body,
    });
    expect(missing.status).toBe(401);

    const { SyntheticFinancialAuthorityError } =
      await import('../../src/services/payment/SyntheticFinancialCommandAuthority.js');
    mocks.recordInbox.mockRejectedValueOnce(
      new SyntheticFinancialAuthorityError('WEBHOOK_HMAC_INVALID')
    );
    const invalid = await app().request('/webhooks/fake-financial', {
      method: 'POST',
      headers: {
        'x-hustlexp-fake-finance-key-id': payload.operationId,
        'x-hustlexp-fake-finance-signature': '0'.repeat(64),
      },
      body,
    });
    expect(invalid.status).toBe(401);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('returns durable receipt evidence from the sealed verification port', async () => {
    const body = JSON.stringify(payload);
    const response = await app().request('/webhooks/fake-financial', {
      method: 'POST',
      headers: {
        'x-hustlexp-fake-finance-key-id': payload.operationId,
        'x-hustlexp-fake-finance-signature': signature(body),
      },
      body,
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      received: true,
      queued: true,
      providerKind: 'FAKE',
      operationId: payload.operationId,
      observationId: '00000000-0000-4000-8000-000000000404',
      receiptId: '00000000-0000-4000-8000-000000000405',
      observationReplayed: false,
      idempotencyReplayed: false,
    });
    expect(mocks.authorize).toHaveBeenCalledWith({ component: 'backend' });
    const expectedSignature = signature(body);
    expect(mocks.recordInbox).toHaveBeenCalledWith({
      keyId: payload.operationId,
      rawBody: body,
      signature: expectedSignature,
      ingressIdempotencyKey: expectedNormalizationKey(),
    });
    expect(JSON.stringify(mocks.recordInbox.mock.calls[0]?.[0])).not.toContain(secret);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('uses provider event identity for normalization across distinct ingress receipts', async () => {
    const body = JSON.stringify(payload);
    const firstIngressKey = 'webhook:delivery:0001';
    const secondIngressKey = 'webhook:delivery:0002';

    const first = await app().request('/webhooks/fake-financial', {
      method: 'POST',
      headers: {
        'x-hustlexp-fake-finance-key-id': payload.operationId,
        'x-hustlexp-fake-finance-signature': signature(body),
        'x-hustlexp-ingress-idempotency-key': firstIngressKey,
      },
      body,
    });
    const second = await app().request('/webhooks/fake-financial', {
      method: 'POST',
      headers: {
        'x-hustlexp-fake-finance-key-id': payload.operationId,
        'x-hustlexp-fake-finance-signature': signature(body),
        'x-hustlexp-ingress-idempotency-key': secondIngressKey,
      },
      body,
    });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(mocks.recordInbox).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        ingressIdempotencyKey: firstIngressKey,
        rawBody: body,
      })
    );
    expect(mocks.recordInbox).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        ingressIdempotencyKey: secondIngressKey,
        rawBody: body,
      })
    );
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('returns a successful exact replay when verification happens later', async () => {
    const body = JSON.stringify(payload);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T20:00:00.000Z'));
    mocks.recordInbox
      .mockResolvedValueOnce({
        observationId: '00000000-0000-4000-8000-000000000404',
        receiptId: '00000000-0000-4000-8000-000000000405',
        observationReplayed: false,
        idempotencyReplayed: false,
      })
      .mockResolvedValueOnce({
        observationId: '00000000-0000-4000-8000-000000000404',
        receiptId: '00000000-0000-4000-8000-000000000405',
        observationReplayed: true,
        idempotencyReplayed: true,
      });
    const first = await app().request('/webhooks/fake-financial', {
      method: 'POST',
      headers: {
        'x-hustlexp-fake-finance-key-id': payload.operationId,
        'x-hustlexp-fake-finance-signature': signature(body),
      },
      body,
    });
    vi.setSystemTime(new Date('2026-08-28T20:00:02.000Z'));
    const replay = await app().request('/webhooks/fake-financial', {
      method: 'POST',
      headers: {
        'x-hustlexp-fake-finance-key-id': payload.operationId,
        'x-hustlexp-fake-finance-signature': signature(body),
      },
      body,
    });

    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({ idempotencyReplayed: true });
    const firstInbox = mocks.recordInbox.mock.calls[0]?.[0];
    const replayInbox = mocks.recordInbox.mock.calls[1]?.[0];
    expect(replayInbox).toEqual(firstInbox);
    expect(replayInbox).not.toHaveProperty('authentication');
  });

  it('rejects an invalid ingress receipt identity before boundary or inbox access', async () => {
    const body = JSON.stringify(payload);
    const response = await app().request('/webhooks/fake-financial', {
      method: 'POST',
      headers: {
        'x-hustlexp-fake-finance-key-id': payload.operationId,
        'x-hustlexp-fake-finance-signature': signature(body),
        'x-hustlexp-ingress-idempotency-key': 'too-short',
      },
      body,
    });

    expect(response.status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.recordInbox).not.toHaveBeenCalled();
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('rejects external providers and oversized payloads without provider execution', async () => {
    const externalBody = JSON.stringify({ ...payload, providerKind: 'EXTERNAL' });
    const external = await app().request('/webhooks/fake-financial', {
      method: 'POST',
      headers: {
        'x-hustlexp-fake-finance-key-id': payload.operationId,
        'x-hustlexp-fake-finance-signature': signature(externalBody),
      },
      body: externalBody,
    });
    expect(external.status).toBe(400);

    const oversized = 'x'.repeat(17 * 1024);
    const large = await app().request('/webhooks/fake-financial', {
      method: 'POST',
      headers: {
        'x-hustlexp-fake-finance-key-id': payload.operationId,
        'x-hustlexp-fake-finance-signature': signature(oversized),
      },
      body: oversized,
    });
    expect(large.status).toBe(413);
    expect(mocks.recordInbox).not.toHaveBeenCalled();
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('rejects command-shaped authority and unknown fields before inbox persistence', async () => {
    const commandShaped = JSON.stringify({
      ...payload,
      taskDraftId: '00000000-0000-4000-8000-000000000402',
      taskId: '00000000-0000-4000-8000-000000000403',
      actorId: '00000000-0000-4000-8000-000000000406',
      scenario: 'DUPLICATE_WEBHOOK',
    });
    const response = await app().request('/webhooks/fake-financial', {
      method: 'POST',
      headers: {
        'x-hustlexp-fake-finance-key-id': payload.operationId,
        'x-hustlexp-fake-finance-signature': signature(commandShaped),
      },
      body: commandShaped,
    });

    expect(response.status).toBe(400);
    expect(mocks.recordInbox).not.toHaveBeenCalled();
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('records signed evidence for asynchronous boundary evaluation by the worker', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const body = JSON.stringify(payload);
    const response = await app().request('/webhooks/fake-financial', {
      method: 'POST',
      headers: {
        'x-hustlexp-fake-finance-key-id': payload.operationId,
        'x-hustlexp-fake-finance-signature': signature(body),
      },
      body,
    });
    expect(response.status).toBe(202);
    expect(mocks.recordInbox).toHaveBeenCalledTimes(1);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('returns retryable unavailability and refuses normalization when inbox persistence fails', async () => {
    mocks.recordInbox.mockRejectedValueOnce(new Error('inbox unavailable'));
    const body = JSON.stringify(payload);
    const response = await app().request('/webhooks/fake-financial', {
      method: 'POST',
      headers: {
        'x-hustlexp-fake-finance-key-id': payload.operationId,
        'x-hustlexp-fake-finance-signature': signature(body),
      },
      body,
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'Synthetic webhook temporarily unavailable',
    });
    expect(mocks.recordInbox).toHaveBeenCalledTimes(1);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('returns a permanent conflict without normalization for conflicting durable evidence', async () => {
    const { ProviderEventInboxError } =
      await import('../../src/services/payment/ProviderEventInbox.js');
    mocks.recordInbox.mockRejectedValueOnce(new ProviderEventInboxError('EVENT_CONFLICT'));
    const body = JSON.stringify(payload);
    const response = await app().request('/webhooks/fake-financial', {
      method: 'POST',
      headers: {
        'x-hustlexp-fake-finance-key-id': payload.operationId,
        'x-hustlexp-fake-finance-signature': signature(body),
      },
      body,
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Synthetic webhook evidence conflict' });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
});
