import { createHmac } from 'node:crypto';

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createCompletionDeliveryWebhook } from '../../src/serverCompletionDeliveryWebhook.js';
import { UniversalV1CompletionDeliveryError } from '../../src/services/UniversalV1CompletionDeliveryContracts.js';

const secret = 'completion-delivery-webhook-secret-at-least-32-bytes';
const actorUserId = '00000000-0000-4000-8000-000000000011';
const env = {
  HX_COMPLETION_DELIVERY_WEBHOOK_SECRET: secret,
  HX_COMPLETION_DELIVERY_SINK_ACTOR_ID: actorUserId,
};
const serviceIdentity = `hustlexp.synthetic-communications-sink.v1:${actorUserId}`;
const payload = {
  schema_version: 1,
  event_type: 'COMPLETION_NOTICE_DELIVERED',
  task_id: '00000000-0000-4000-8000-000000000012',
  work_order_id: '00000000-0000-4000-8000-000000000013',
  submitted_completion_fact_id: '00000000-0000-4000-8000-000000000014',
  expected_completion_version: 1,
  expected_execution_version: 4,
  provider_delivery_id: 'sink-delivery:00000001',
  channel: 'EMAIL',
  delivered_at: '2027-01-15T12:00:00.000Z',
  idempotency_key: 'completion-delivery:test-0001',
  client_ts: '2027-01-15T12:00:01.000Z',
};

function signature(body: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

function testApp(
  recordAuthenticatedReceipt: ReturnType<typeof vi.fn>,
  environment: Record<string, string | undefined> = env
) {
  const app = new Hono();
  app.post(
    '/webhooks/completion-delivery',
    createCompletionDeliveryWebhook({
      env: environment,
      application: { recordAuthenticatedReceipt },
    })
  );
  return app;
}

describe('completion delivery sink webhook', () => {
  const recordAuthenticatedReceipt = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    recordAuthenticatedReceipt.mockResolvedValue({
      delivery_event_id: '00000000-0000-4000-8000-000000000015',
      task_id: payload.task_id,
      work_order_id: payload.work_order_id,
      submitted_completion_fact_id: payload.submitted_completion_fact_id,
      provider_delivery_id: payload.provider_delivery_id,
      channel: 'EMAIL',
      delivered_at: payload.delivered_at,
      provider_kind: 'SYNTHETIC_SINK',
      provider_service_identity: serviceIdentity,
      idempotency_replayed: false,
      payment_creation_performed: false,
      hard_assignment_created: false,
    });
  });

  it('fails closed when the dedicated credential or service identity is unavailable', async () => {
    const body = JSON.stringify(payload);
    const response = await testApp(recordAuthenticatedReceipt, {}).request(
      '/webhooks/completion-delivery',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hustlexp-completion-delivery-signature': signature(body),
        },
        body,
      }
    );
    expect(response.status).toBe(503);
    expect(recordAuthenticatedReceipt).not.toHaveBeenCalled();
  });

  it('rejects missing or invalid HMAC authentication before executing the command', async () => {
    const body = JSON.stringify(payload);
    const missing = await testApp(recordAuthenticatedReceipt).request(
      '/webhooks/completion-delivery',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body }
    );
    expect(missing.status).toBe(401);

    const invalid = await testApp(recordAuthenticatedReceipt).request(
      '/webhooks/completion-delivery',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hustlexp-completion-delivery-signature': '0'.repeat(64),
        },
        body,
      }
    );
    expect(invalid.status).toBe(401);
    expect(recordAuthenticatedReceipt).not.toHaveBeenCalled();
  });

  it('binds the HMAC to the exact raw request bytes before JSON parsing', async () => {
    const canonicalBody = JSON.stringify(payload);
    const differentlyEncodedBody = `\r\n${canonicalBody}\r\n`;
    const response = await testApp(recordAuthenticatedReceipt).request(
      '/webhooks/completion-delivery',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hustlexp-completion-delivery-signature': signature(canonicalBody),
        },
        body: differentlyEncodedBody,
      }
    );
    expect(response.status).toBe(401);
    expect(recordAuthenticatedReceipt).not.toHaveBeenCalled();
  });

  it('accepts only the strict signed schema and supplies server-owned sink identity', async () => {
    const invalidBody = JSON.stringify({ ...payload, actor_user_id: actorUserId });
    const invalid = await testApp(recordAuthenticatedReceipt).request(
      '/webhooks/completion-delivery',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hustlexp-completion-delivery-signature': signature(invalidBody),
        },
        body: invalidBody,
      }
    );
    expect(invalid.status).toBe(400);

    const body = `\r\n${JSON.stringify(payload)}\r\n`;
    const response = await testApp(recordAuthenticatedReceipt).request(
      '/webhooks/completion-delivery',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hustlexp-completion-delivery-signature': signature(body),
        },
        body,
      }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      received: true,
      idempotency_replayed: false,
      payment_creation_performed: false,
      hard_assignment_created: false,
    });
    expect(recordAuthenticatedReceipt).toHaveBeenCalledWith(
      {
        providerKind: 'SYNTHETIC_SINK',
        serviceIdentity,
        actorUserId,
      },
      payload
    );
  });

  it('returns a conflict for a signed idempotency mismatch', async () => {
    recordAuthenticatedReceipt.mockRejectedValueOnce(
      new UniversalV1CompletionDeliveryError('COMPLETION_DELIVERY_IDEMPOTENCY_CONFLICT', 'conflict')
    );
    const body = JSON.stringify(payload);
    const response = await testApp(recordAuthenticatedReceipt).request(
      '/webhooks/completion-delivery',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hustlexp-completion-delivery-signature': signature(body),
        },
        body,
      }
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'COMPLETION_DELIVERY_IDEMPOTENCY_CONFLICT',
    });
  });
});
