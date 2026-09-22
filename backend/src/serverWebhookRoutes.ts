import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { logger } from './logger.js';
import type { HustleApp } from './serverTypes.js';

type CheckrPayload = {
  id?: string;
  type: string;
  created_at?: string;
  data?: { object?: { id?: string; result?: string } };
};

export function checkrReportStatus(payload: Pick<CheckrPayload, 'type' | 'data'>):
  'CLEAR' | 'CONSIDER' | 'DISPUTED' | null {
  if (payload.type === 'report.disputed') return 'DISPUTED';
  if (payload.type === 'report.suspended') return 'CONSIDER';
  if (payload.type !== 'report.completed') return null;
  switch (payload.data?.object?.result?.toLowerCase()) {
    case 'clear': return 'CLEAR';
    case 'consider': return 'CONSIDER';
    default: return null;
  }
}

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
  if (!['report.completed', 'report.suspended', 'report.disputed'].includes(payload.type)) {
    return context.json({ received: true, processed: true }, 200);
  }
  const result = payload.data?.object?.result?.toLowerCase();
  const status = checkrReportStatus(payload);
  if (!status) {
    logger.warn({ type: payload.type }, 'Checkr completion has no recognized report result');
    return context.json({ received: true, processed: false, reason: 'unrecognized report result' }, 200);
  }
  const reportId = payload.data?.object?.id;
  if (!reportId) {
    logger.warn({ type: payload.type }, 'Checkr webhook missing report ID — skipping status update');
    return context.json({ received: true, processed: false, reason: 'missing report id' }, 200);
  }
  if (!payload.id || !payload.created_at || !Number.isFinite(Date.parse(payload.created_at))) {
    logger.warn({ type: payload.type, reportId }, 'Checkr webhook missing event identity or time');
    return context.json({ received: true, processed: false, reason: 'missing event identity or time' }, 200);
  }
  const { updateBackgroundCheckStatus } = await import('./services/BackgroundCheckService.js');
  await updateBackgroundCheckStatus(reportId, status,
    { id: payload.id, occurredAt: payload.created_at }, result);
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
  app.post('/webhooks/checkr', checkrWebhook);
  app.post('/webhooks/tilled', async (context) => {
    const rawBody = await context.req.text();
    const { ingestTilledWebhook } = await import('./services/payment/TilledWebhookService.js');
    const result = await ingestTilledWebhook(rawBody, context.req.header('payments-signature'));
    if (!result.accepted) return context.json({ error: 'Webhook rejected' }, result.status);
    return context.json({ received: true, eventId: result.eventId }, 200);
  });
}
