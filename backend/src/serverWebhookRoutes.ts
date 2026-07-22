import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { logger } from './logger.js';
import type { HustleApp } from './serverTypes.js';

type CheckrPayload = {
  type: string;
  data?: { object?: { id?: string; result?: string } };
};

function signatureMatches(provided: string, rawBody: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const providedBuffer = Buffer.from(provided, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  const length = Math.max(providedBuffer.length, expectedBuffer.length);
  const paddedProvided = Buffer.alloc(length);
  const paddedExpected = Buffer.alloc(length);
  providedBuffer.copy(paddedProvided);
  expectedBuffer.copy(paddedExpected);
  return timingSafeEqual(paddedProvided, paddedExpected);
}

async function stripeWebhook(context: Context) {
  const signature = context.req.header('stripe-signature');
  const rawBody = await context.req.text();
  if (!signature) return context.json({ error: 'Missing stripe-signature header' }, 400);
  const { StripeWebhookService } = await import('./services/StripeWebhookService.js');
  const result = await StripeWebhookService.processWebhook(rawBody, signature);
  if (!result.success) {
    const verificationCodes = [
      'WEBHOOK_VERIFICATION_FAILED',
      'WEBHOOK_SECRET_MISSING',
      'STRIPE_NOT_CONFIGURED',
    ];
    if (verificationCodes.includes(result.error?.code || '')) {
      return context.json({ error: result.error?.message }, 400);
    }
    return context.json({ error: 'Webhook processing failed' }, 500);
  }
  return context.json({
    received: true,
    eventId: result.stripeEventId,
    stored: result.stripeEventId !== undefined,
  }, 200);
}

async function verifiedCheckrPayload(context: Context): Promise<CheckrPayload | Response> {
  const secret = process.env.CHECKR_WEBHOOK_SECRET;
  if (!secret) {
    logger.warn('CHECKR_WEBHOOK_SECRET is not configured — rejecting Checkr webhook');
    return context.json(
      { error: 'Service Unavailable', message: 'Webhook secret not configured' },
      503,
    );
  }
  const rawBody = await context.req.text().catch(() => null);
  if (rawBody === null) return context.json({ error: 'Invalid webhook payload' }, 400);
  const signature = context.req.header('X-Checkr-Signature');
  if (!signature) return context.json({ error: 'Missing signature header' }, 401);
  if (!signatureMatches(signature, rawBody, secret)) {
    logger.warn({ sigLength: signature.length }, 'Checkr webhook signature verification failed');
    return context.json({ error: 'Invalid signature' }, 401);
  }
  try {
    const payload = JSON.parse(rawBody) as CheckrPayload;
    if (!payload?.type) return context.json({ error: 'Invalid webhook payload' }, 400);
    return payload;
  } catch {
    return context.json({ error: 'Invalid JSON payload' }, 400);
  }
}

async function processCheckrPayload(context: Context, payload: CheckrPayload) {
  const statuses: Record<string, 'CLEAR' | 'CONSIDER'> = {
    'report.completed': 'CLEAR',
    'report.suspended': 'CONSIDER',
    'report.disputed': 'CONSIDER',
  };
  const status = statuses[payload.type];
  if (!status) return context.json({ received: true, processed: true }, 200);
  const reportId = payload.data?.object?.id;
  if (!reportId) {
    logger.warn({ type: payload.type }, 'Checkr webhook missing report ID — skipping status update');
    return context.json({ received: true, processed: false, reason: 'missing report id' }, 200);
  }
  const { updateBackgroundCheckStatus } = await import('./services/BackgroundCheckService.js');
  await updateBackgroundCheckStatus(reportId, status, payload.data?.object?.result);
  return context.json({ received: true, processed: true }, 200);
}

async function checkrWebhook(context: Context) {
  const payload = await verifiedCheckrPayload(context);
  if (payload instanceof Response) return payload;
  try {
    return await processCheckrPayload(context, payload);
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      'Checkr webhook processing failed',
    );
    return context.json({ error: 'Webhook processing failed' }, 500);
  }
}

export function registerWebhookRoutes(app: HustleApp): void {
  app.post('/webhooks/stripe', stripeWebhook);
  app.post('/webhooks/checkr', checkrWebhook);
}
