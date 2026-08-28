import type { Context } from 'hono';

import { syntheticWebhookIngressCommandSchema } from './services/payment/SyntheticFinancialCommandSchemas.js';
import { assertNonproductionFakeFinanceAuthorized } from './services/payment/NonproductionFinancialAuthorization.js';
import { createUniversalV1FakeFinancialApplicationService } from './services/payment/UniversalV1FinancialApplicationService.js';
import {
  assertSyntheticFinancialWebhookHmac,
  SYNTHETIC_FINANCIAL_WEBHOOK_MAX_BODY_BYTES,
  syntheticFinancialCommandAuthority,
  SyntheticFinancialAuthorityError,
} from './services/payment/SyntheticFinancialCommandAuthority.js';

/**
 * HMAC-authenticated fake-provider webhook for local, preview, and staging.
 * Production fails the exact manifest gate before any payload is processed.
 */
export async function syntheticFinancialWebhook(context: Context): Promise<Response> {
  try {
    assertNonproductionFakeFinanceAuthorized({ component: 'backend' });
  } catch {
    return context.json({ error: 'Not found' }, 404);
  }

  const declaredLength = Number(context.req.header('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > SYNTHETIC_FINANCIAL_WEBHOOK_MAX_BODY_BYTES) {
    return context.json({ error: 'Payload too large' }, 413);
  }
  const signature = context.req.header('x-hustlexp-fake-finance-signature')?.trim().toLowerCase();
  if (!signature) return context.json({ error: 'Missing signature' }, 401);

  const rawBody = await context.req.text();
  if (Buffer.byteLength(rawBody, 'utf8') > SYNTHETIC_FINANCIAL_WEBHOOK_MAX_BODY_BYTES) {
    return context.json({ error: 'Payload too large' }, 413);
  }
  try {
    assertSyntheticFinancialWebhookHmac(rawBody, signature);
  } catch (error) {
    const unavailable = error instanceof SyntheticFinancialAuthorityError
      && error.reason === 'WEBHOOK_SECRET_UNAVAILABLE';
    return context.json(
      { error: unavailable ? 'Synthetic webhook unavailable' : 'Invalid signature' },
      unavailable ? 503 : 401,
    );
  }

  let input: unknown;
  try {
    input = JSON.parse(rawBody);
  } catch {
    return context.json({ error: 'Invalid JSON payload' }, 400);
  }
  const parsed = syntheticWebhookIngressCommandSchema.safeParse(input);
  if (!parsed.success) return context.json({ error: 'Invalid synthetic webhook payload' }, 400);

  try {
    await syntheticFinancialCommandAuthority.assertWebhookOperationBoundary(
      parsed.data.taskDraftId,
      parsed.data.taskId,
      parsed.data.operationId,
    );
    const result = await createUniversalV1FakeFinancialApplicationService().ingestWebhook({
      providerKind: parsed.data.providerKind,
      operationId: parsed.data.operationId,
      idempotencyKey: parsed.data.idempotencyKey,
      providerExpectedVersion: parsed.data.providerExpectedVersion,
      providerEventReference: parsed.data.providerEventReference,
      scenario: parsed.data.scenario,
      authenticated: true,
    });
    return context.json({
      received: true,
      providerKind: 'FAKE',
      operationId: result.operationId,
      operationVersion: result.version,
      state: result.state,
      idempotencyReplayed: result.idempotencyReplayed,
    }, 200);
  } catch {
    return context.json({ error: 'Synthetic webhook command refused' }, 422);
  }
}
