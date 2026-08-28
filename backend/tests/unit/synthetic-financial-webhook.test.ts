import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  ingest: vi.fn(),
  query: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  db: { query: mocks.query },
}));

vi.mock('../../src/services/payment/NonproductionFinancialAuthorization.js', () => ({
  assertNonproductionFakeFinanceAuthorized: mocks.authorize,
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
  mocks.query.mockResolvedValue({ rows: [{ authorized: true }], rowCount: 1 });
});

afterEach(() => {
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
    expect(mocks.ingest).toHaveBeenCalledWith({
      providerKind: 'FAKE',
      operationId: payload.operationId,
      idempotencyKey: payload.idempotencyKey,
      providerExpectedVersion: 0,
      providerEventReference: payload.providerEventReference,
      scenario: 'DUPLICATE_WEBHOOK',
      authenticated: true,
    });
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
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
});
