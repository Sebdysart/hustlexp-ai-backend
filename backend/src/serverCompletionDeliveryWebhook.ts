import { createHmac, timingSafeEqual } from 'node:crypto';

import type { Context } from 'hono';

import { logger } from './logger.js';
import {
  AuthenticatedCompletionDeliverySinkSchema,
  SYNTHETIC_COMPLETION_DELIVERY_SERVICE_PREFIX,
  UniversalV1CompletionDeliveryReceiptWebhookSchema,
  UniversalV1CompletionDeliveryError,
} from './services/UniversalV1CompletionDeliveryContracts.js';
import {
  UniversalV1CompletionDeliveryApplication,
  type UniversalV1CompletionDeliveryCommandHandler,
} from './services/UniversalV1CompletionDeliveryApplication.js';

type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;

export const COMPLETION_DELIVERY_WEBHOOK_MAX_BODY_BYTES = 16 * 1024;
const HMAC_SIGNATURE = /^[0-9a-f]{64}$/u;

export interface CompletionDeliveryWebhookDependencies {
  env?: Environment;
  application?: UniversalV1CompletionDeliveryCommandHandler;
}

class CompletionDeliveryWebhookAuthenticationError extends Error {
  constructor(readonly unavailable: boolean) {
    super(unavailable ? 'Completion delivery webhook unavailable' : 'Invalid signature');
  }
}

function configuredSink(env: Environment) {
  const actorUserId = env.HX_COMPLETION_DELIVERY_SINK_ACTOR_ID?.trim();
  const parsed = AuthenticatedCompletionDeliverySinkSchema.safeParse({
    providerKind: 'SYNTHETIC_SINK',
    serviceIdentity: actorUserId
      ? `${SYNTHETIC_COMPLETION_DELIVERY_SERVICE_PREFIX}:${actorUserId}`
      : undefined,
    actorUserId,
  });
  if (!parsed.success) throw new CompletionDeliveryWebhookAuthenticationError(true);
  return parsed.data;
}

function assertWebhookHmac(rawBody: Uint8Array, provided: string, env: Environment): void {
  const secret = env.HX_COMPLETION_DELIVERY_WEBHOOK_SECRET?.trim() ?? '';
  if (secret.length < 32) throw new CompletionDeliveryWebhookAuthenticationError(true);
  const normalized = provided.trim().toLowerCase();
  if (!HMAC_SIGNATURE.test(normalized)) {
    throw new CompletionDeliveryWebhookAuthenticationError(false);
  }
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const actual = Buffer.from(normalized, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new CompletionDeliveryWebhookAuthenticationError(false);
  }
}

function refusalStatus(error: UniversalV1CompletionDeliveryError): 409 | 422 {
  return error.code === 'COMPLETION_DELIVERY_IDEMPOTENCY_CONFLICT' ? 409 : 422;
}

/**
 * Dedicated provider-authenticated completion-notice receipt boundary.
 *
 * The HMAC credential grants only this append-only receipt command. It is not
 * an engine bridge, administrator credential, assignment capability, or money
 * capability.
 */
export function createCompletionDeliveryWebhook(
  dependencies: CompletionDeliveryWebhookDependencies = {}
): (context: Context) => Promise<Response> {
  const env = dependencies.env ?? process.env;
  const application = dependencies.application ?? new UniversalV1CompletionDeliveryApplication();

  return async (context: Context): Promise<Response> => {
    const contentType = context.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      return context.json({ error: 'Content-Type must be application/json' }, 415);
    }
    const declaredLength = Number(context.req.header('content-length') ?? '0');
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > COMPLETION_DELIVERY_WEBHOOK_MAX_BODY_BYTES
    ) {
      return context.json({ error: 'Payload too large' }, 413);
    }
    const signature = context.req.header('x-hustlexp-completion-delivery-signature');
    if (!signature) return context.json({ error: 'Missing signature' }, 401);

    const rawBodyBytes = Buffer.from(await context.req.arrayBuffer());
    if (rawBodyBytes.byteLength > COMPLETION_DELIVERY_WEBHOOK_MAX_BODY_BYTES) {
      return context.json({ error: 'Payload too large' }, 413);
    }

    let sink;
    try {
      sink = configuredSink(env);
      assertWebhookHmac(rawBodyBytes, signature, env);
    } catch (error) {
      const unavailable =
        error instanceof CompletionDeliveryWebhookAuthenticationError && error.unavailable;
      return context.json(
        { error: unavailable ? 'Completion delivery webhook unavailable' : 'Invalid signature' },
        unavailable ? 503 : 401
      );
    }

    let rawInput: unknown;
    try {
      rawInput = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBodyBytes));
    } catch {
      return context.json({ error: 'Invalid JSON payload' }, 400);
    }
    const parsed = UniversalV1CompletionDeliveryReceiptWebhookSchema.safeParse(rawInput);
    if (!parsed.success) {
      return context.json({ error: 'Invalid completion delivery receipt payload' }, 400);
    }

    try {
      const result = await application.recordAuthenticatedReceipt(sink, parsed.data);
      return context.json({ received: true, ...result }, 200);
    } catch (error) {
      if (error instanceof UniversalV1CompletionDeliveryError) {
        return context.json(
          { error: 'Completion delivery receipt refused', code: error.code },
          refusalStatus(error)
        );
      }
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Completion delivery receipt processing failed'
      );
      return context.json({ error: 'Completion delivery receipt processing failed' }, 500);
    }
  };
}

export const completionDeliveryWebhook = createCompletionDeliveryWebhook();
