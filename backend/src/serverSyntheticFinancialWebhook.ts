import type { Context } from 'hono';
import { fakeFinancialWebhookKeyIdSchema } from './services/payment/FakeFinancialWebhookAuthentication.js';

import { assertNonproductionFakeFinanceAuthorized } from './services/payment/NonproductionFinancialAuthorization.js';
import { ProviderEventInboxError } from './services/payment/ProviderEventInbox.js';
import {
  authenticateAndRecordSyntheticFinancialWebhook,
  SyntheticFinancialWebhookIngressError,
} from './services/payment/SyntheticFinancialWebhookInbox.js';
import {
  SYNTHETIC_FINANCIAL_WEBHOOK_MAX_BODY_BYTES,
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
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > SYNTHETIC_FINANCIAL_WEBHOOK_MAX_BODY_BYTES
  ) {
    return context.json({ error: 'Payload too large' }, 413);
  }
  const signature = context.req.header('x-hustlexp-fake-finance-signature')?.trim().toLowerCase();
  if (!signature) return context.json({ error: 'Missing signature' }, 401);
  const keyId = context.req.header('x-hustlexp-fake-finance-key-id');
  if (!fakeFinancialWebhookKeyIdSchema.safeParse(keyId).success)
    return context.json({ error: 'Invalid signature' }, 401);

  const reader = context.req.raw.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  if (reader) {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytesRead += next.value.byteLength;
        if (bytesRead > SYNTHETIC_FINANCIAL_WEBHOOK_MAX_BODY_BYTES) {
          await reader.cancel();
          return context.json({ error: 'Payload too large' }, 413);
        }
        chunks.push(next.value);
      }
    } catch {
      return context.json({ error: 'Invalid synthetic webhook payload' }, 400);
    } finally {
      reader.releaseLock();
    }
  }
  const rawBytes = Buffer.concat(chunks, bytesRead);
  const rawBody = rawBytes.toString('utf8');
  if (!Buffer.from(rawBody, 'utf8').equals(rawBytes))
    return context.json({ error: 'Invalid synthetic webhook payload' }, 400);
  if (Buffer.byteLength(rawBody, 'utf8') > SYNTHETIC_FINANCIAL_WEBHOOK_MAX_BODY_BYTES) {
    return context.json({ error: 'Payload too large' }, 413);
  }
  const ingressIdempotencyHeader = context.req.header('x-hustlexp-ingress-idempotency-key');

  try {
    const authenticated = await authenticateAndRecordSyntheticFinancialWebhook({
      keyId: keyId!,
      rawBody,
      signature,
      ingressIdempotencyKey: ingressIdempotencyHeader,
    });
    const { observation, receipt } = authenticated;
    return context.json(
      {
        received: true,
        queued: true,
        providerKind: 'FAKE',
        operationId: observation.operationId,
        observationId: receipt.observationId,
        receiptId: receipt.receiptId,
        observationReplayed: receipt.observationReplayed,
        idempotencyReplayed: receipt.idempotencyReplayed,
      },
      202
    );
  } catch (error) {
    if (error instanceof SyntheticFinancialWebhookIngressError) {
      return context.json(
        {
          error:
            error.reason === 'INGRESS_IDEMPOTENCY_KEY_INVALID'
              ? 'Invalid ingress idempotency key'
              : 'Invalid synthetic webhook payload',
        },
        400
      );
    }
    if (error instanceof SyntheticFinancialAuthorityError) {
      if (error.reason === 'WEBHOOK_SECRET_UNAVAILABLE') {
        return context.json({ error: 'Synthetic webhook unavailable' }, 503);
      }
      if (error.reason === 'WEBHOOK_PAYLOAD_TOO_LARGE') {
        return context.json({ error: 'Payload too large' }, 413);
      }
      if (error.reason === 'WEBHOOK_HMAC_INVALID') {
        return context.json({ error: 'Invalid signature' }, 401);
      }
      return context.json({ error: 'Synthetic provider observation refused' }, 422);
    }
    if (error instanceof ProviderEventInboxError) {
      if (error.reason === 'RAW_PAYLOAD_INVALID' || error.reason === 'IDEMPOTENCY_KEY_INVALID')
        return context.json({ error: 'Invalid synthetic webhook payload' }, 400);
      if (error.reason === 'PERSISTENCE_INCOMPLETE') {
        return context.json({ error: 'Synthetic webhook temporarily unavailable' }, 503);
      }
      if (error.reason === 'EVENT_CONFLICT' || error.reason === 'IDEMPOTENCY_CONFLICT') {
        return context.json({ error: 'Synthetic webhook evidence conflict' }, 409);
      }
      return context.json({ error: 'Synthetic provider observation refused' }, 422);
    }
    return context.json({ error: 'Synthetic webhook temporarily unavailable' }, 503);
  }
}
