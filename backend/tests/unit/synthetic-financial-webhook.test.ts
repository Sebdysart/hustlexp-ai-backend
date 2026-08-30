import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

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

const secret = 'synthetic-webhook-secret-that-is-at-least-32-bytes';
const payload = {
  providerKind: 'FAKE',
  operationId: '00000000-0000-4000-8000-000000000401',
  taskDraftId: '00000000-0000-4000-8000-000000000402',
  taskId: '00000000-0000-4000-8000-000000000403',
  idempotencyKey: 'webhook:synthetic:0001',
  providerExpectedVersion: 0,
  providerEventReference: 'synthetic-provider-event-1',
  scenario: 'DUPLICATE_WEBHOOK',
} as const;

function signature(body: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

function expectedEvidenceSha256(value: string): string {
  return createHash('sha256')
    .update(`HUSTLEXP_SYNTHETIC_WEBHOOK_HMAC_SHA256_V1\0${value}`, 'utf8')
    .digest('hex');
}

function expectedNormalizationIdempotencyKey(
  providerKind: string,
  providerEventReference: string,
): string {
  const digest = createHash('sha256')
    .update(`${providerKind}\0${providerEventReference}`, 'utf8')
    .digest('hex');
  return `provider-event:${digest}`;
}

function app() {
  const instance = new Hono();
  instance.post('/webhooks/fake-financial', syntheticFinancialWebhook);
  return instance;
}

const priorSecret = process.env.HX_FAKE_FINANCIAL_WEBHOOK_SECRET;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.HX_FAKE_FINANCIAL_WEBHOOK_SECRET = secret;
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
  if (priorSecret === undefined) delete process.env.HX_FAKE_FINANCIAL_WEBHOOK_SECRET;
  else process.env.HX_FAKE_FINANCIAL_WEBHOOK_SECRET = priorSecret;
});

describe('synthetic financial webhook', () => {
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

  it('rejects missing and invalid service authentication before parsing the command', async () => {
    const body = JSON.stringify(payload);
    const missing = await app().request('/webhooks/fake-financial', {
      method: 'POST', body,
    });
    expect(missing.status).toBe(401);

    const invalid = await app().request('/webhooks/fake-financial', {
      method: 'POST',
      headers: { 'x-hustlexp-fake-finance-signature': '0'.repeat(64) },
      body,
    });
    expect(invalid.status).toBe(401);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('forces authenticated FAKE webhook ingestion after exact HMAC verification', async () => {
    const body = JSON.stringify(payload);
    const response = await app().request('/webhooks/fake-financial', {
      method: 'POST',
      headers: { 'x-hustlexp-fake-finance-signature': signature(body) },
      body,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      received: true,
      providerKind: 'FAKE',
      operationId: payload.operationId,
      operationVersion: 1,
      state: 'ACCEPTED',
      idempotencyReplayed: false,
    });
    expect(mocks.authorize).toHaveBeenCalledWith({ component: 'backend' });
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM task_financial_operations operation'),
      [payload.taskDraftId, payload.taskId, payload.operationId],
    );
    const expectedSignature = signature(body);
    expect(mocks.recordInbox).toHaveBeenCalledWith({
      providerKind: 'FAKE',
      providerEventReference: payload.providerEventReference,
      providerEventKind: 'financial_operation.observed',
      operationId: payload.operationId,
      ingressIdempotencyKey: payload.idempotencyKey,
      rawPayload: Buffer.from(body, 'utf8'),
      authentication: {
        status: 'VERIFIED',
        scheme: 'HMAC_SHA256',
        evidenceSha256: expectedEvidenceSha256(expectedSignature),
        verifiedAt: expect.any(String),
      },
    });
    expect(JSON.stringify(mocks.recordInbox.mock.calls[0]?.[0])).not.toContain(expectedSignature);
    expect(JSON.stringify(mocks.recordInbox.mock.calls[0]?.[0])).not.toContain(secret);
    expect(mocks.ingest).toHaveBeenCalledWith({
      providerKind: 'FAKE',
      operationId: payload.operationId,
      idempotencyKey: expectedNormalizationIdempotencyKey(
        payload.providerKind,
        payload.providerEventReference,
      ),
      providerExpectedVersion: 0,
      providerEventReference: payload.providerEventReference,
      scenario: 'DUPLICATE_WEBHOOK',
      authenticated: true,
    });
    expect(mocks.recordInbox.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.ingest.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('uses provider event identity for normalization across distinct ingress receipts', async () => {
    const body = JSON.stringify(payload);
    const firstIngressKey = 'webhook:delivery:0001';
    const secondIngressKey = 'webhook:delivery:0002';

    const first = await app().request('/webhooks/fake-financial', {
      method: 'POST',
      headers: {
        'x-hustlexp-fake-finance-signature': signature(body),
        'x-hustlexp-ingress-idempotency-key': firstIngressKey,
      },
      body,
    });
    const second = await app().request('/webhooks/fake-financial', {
      method: 'POST',
      headers: {
        'x-hustlexp-fake-finance-signature': signature(body),
        'x-hustlexp-ingress-idempotency-key': secondIngressKey,
      },
      body,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mocks.recordInbox).toHaveBeenNthCalledWith(1, expect.objectContaining({
      ingressIdempotencyKey: firstIngressKey,
      providerEventReference: payload.providerEventReference,
      rawPayload: Buffer.from(body, 'utf8'),
    }));
    expect(mocks.recordInbox).toHaveBeenNthCalledWith(2, expect.objectContaining({
      ingressIdempotencyKey: secondIngressKey,
      providerEventReference: payload.providerEventReference,
      rawPayload: Buffer.from(body, 'utf8'),
    }));
    const firstNormalizationKey = mocks.ingest.mock.calls[0]?.[0]?.idempotencyKey;
    const secondNormalizationKey = mocks.ingest.mock.calls[1]?.[0]?.idempotencyKey;
    expect(firstNormalizationKey).toBe(expectedNormalizationIdempotencyKey(
      payload.providerKind,
      payload.providerEventReference,
    ));
    expect(secondNormalizationKey).toBe(firstNormalizationKey);
    expect(firstNormalizationKey).not.toBe(firstIngressKey);
    expect(firstNormalizationKey).not.toBe(secondIngressKey);
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
    mocks.ingest
      .mockResolvedValueOnce({
        operationId: payload.operationId,
        version: 1,
        state: 'ACCEPTED',
        idempotencyReplayed: false,
      })
      .mockResolvedValueOnce({
        operationId: payload.operationId,
        version: 1,
        state: 'ACCEPTED',
        idempotencyReplayed: true,
      });

    const first = await app().request('/webhooks/fake-financial', {
      method: 'POST',
      headers: { 'x-hustlexp-fake-finance-signature': signature(body) },
      body,
    });
    vi.setSystemTime(new Date('2026-08-28T20:00:02.000Z'));
    const replay = await app().request('/webhooks/fake-financial', {
      method: 'POST',
      headers: { 'x-hustlexp-fake-finance-signature': signature(body) },
      body,
    });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ idempotencyReplayed: true });
    const firstInbox = mocks.recordInbox.mock.calls[0]?.[0];
    const replayInbox = mocks.recordInbox.mock.calls[1]?.[0];
    expect(replayInbox).toMatchObject({
      ingressIdempotencyKey: firstInbox.ingressIdempotencyKey,
      rawPayload: firstInbox.rawPayload,
      authentication: {
        evidenceSha256: firstInbox.authentication.evidenceSha256,
        verifiedAt: '2026-08-28T20:00:02.000Z',
      },
    });
    expect(firstInbox.authentication.verifiedAt).toBe('2026-08-28T20:00:00.000Z');
  });

  it('rejects an invalid ingress receipt identity before boundary or inbox access', async () => {
    const body = JSON.stringify(payload);
    const response = await app().request('/webhooks/fake-financial', {
      method: 'POST',
      headers: {
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
      headers: { 'x-hustlexp-fake-finance-signature': signature(externalBody) },
      body: externalBody,
    });
    expect(external.status).toBe(400);

    const oversized = 'x'.repeat(17 * 1024);
    const large = await app().request('/webhooks/fake-financial', {
      method: 'POST',
      headers: { 'x-hustlexp-fake-finance-signature': signature(oversized) },
      body: oversized,
    });
    expect(large.status).toBe(413);
    expect(mocks.recordInbox).not.toHaveBeenCalled();
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('rejects a signed webhook whose operation is outside the participant boundary', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const body = JSON.stringify(payload);
    const response = await app().request('/webhooks/fake-financial', {
      method: 'POST',
      headers: { 'x-hustlexp-fake-finance-signature': signature(body) },
      body,
    });
    expect(response.status).toBe(422);
    expect(mocks.recordInbox).toHaveBeenCalledTimes(1);
    expect(mocks.recordInbox.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.query.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('returns retryable unavailability and refuses normalization when inbox persistence fails', async () => {
    mocks.recordInbox.mockRejectedValueOnce(new Error('inbox unavailable'));
    const body = JSON.stringify(payload);
    const response = await app().request('/webhooks/fake-financial', {
      method: 'POST',
      headers: { 'x-hustlexp-fake-finance-signature': signature(body) },
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
      headers: { 'x-hustlexp-fake-finance-signature': signature(body) },
      body,
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Synthetic webhook evidence conflict' });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
});
