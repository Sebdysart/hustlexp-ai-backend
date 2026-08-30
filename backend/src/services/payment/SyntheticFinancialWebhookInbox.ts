import { createHash } from 'node:crypto';

import {
  syntheticWebhookIngressCommandSchema,
  type SyntheticWebhookIngressCommand,
} from './SyntheticFinancialCommandSchemas.js';
import {
  assertSyntheticFinancialWebhookHmac,
} from './SyntheticFinancialCommandAuthority.js';
import {
  PostgresProviderEventInboxRepository,
  ProviderEventInboxError,
  type ProviderEventInboxReceipt,
} from './ProviderEventInbox.js';

const SYNTHETIC_FINANCIAL_PROVIDER_EVENT_KIND = 'financial_operation.observed';
const SYNTHETIC_FINANCIAL_AUTHENTICATION_SCHEME = 'HMAC_SHA256';
const INGRESS_IDEMPOTENCY_KEY = /^[A-Za-z0-9:_-]{16,128}$/u;

export type SyntheticFinancialWebhookIngressErrorReason =
  | 'PAYLOAD_INVALID'
  | 'INGRESS_IDEMPOTENCY_KEY_INVALID';

export class SyntheticFinancialWebhookIngressError extends Error {
  constructor(readonly reason: SyntheticFinancialWebhookIngressErrorReason) {
    super(`SYNTHETIC_FINANCIAL_WEBHOOK_${reason}`);
    this.name = 'SyntheticFinancialWebhookIngressError';
  }
}

export interface AuthenticateAndRecordSyntheticFinancialWebhookInput {
  readonly rawBody: string;
  readonly signature: string;
  readonly ingressIdempotencyKey?: string;
}

export interface AuthenticatedSyntheticFinancialWebhook {
  readonly command: SyntheticWebhookIngressCommand;
  readonly receipt: ProviderEventInboxReceipt;
  readonly normalizationIdempotencyKey: string;
}

const providerEventInbox = new PostgresProviderEventInboxRepository();

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function authenticationEvidenceSha256(signature: string): string {
  return sha256(
    `HUSTLEXP_SYNTHETIC_WEBHOOK_HMAC_SHA256_V1\0${signature.trim().toLowerCase()}`,
  );
}

export function syntheticFinancialWebhookNormalizationIdempotencyKey(
  providerKind: string,
  providerEventReference: string,
): string {
  return `provider-event:${sha256(`${providerKind}\0${providerEventReference}`)}`;
}

function parseSyntheticFinancialWebhook(rawBody: string): SyntheticWebhookIngressCommand {
  let input: unknown;
  try {
    input = JSON.parse(rawBody);
  } catch {
    throw new SyntheticFinancialWebhookIngressError('PAYLOAD_INVALID');
  }
  const parsed = syntheticWebhookIngressCommandSchema.safeParse(input);
  if (!parsed.success) {
    throw new SyntheticFinancialWebhookIngressError('PAYLOAD_INVALID');
  }
  return parsed.data;
}

/**
 * Authenticate, validate, and durably preserve exact signed-body bytes before
 * any participant, operation, lifecycle, normalization, or provider boundary.
 */
export async function authenticateAndRecordSyntheticFinancialWebhook(
  input: AuthenticateAndRecordSyntheticFinancialWebhookInput,
): Promise<AuthenticatedSyntheticFinancialWebhook> {
  assertSyntheticFinancialWebhookHmac(input.rawBody, input.signature);
  const command = parseSyntheticFinancialWebhook(input.rawBody);
  const ingressIdempotencyKey = input.ingressIdempotencyKey ?? command.idempotencyKey;
  if (!INGRESS_IDEMPOTENCY_KEY.test(ingressIdempotencyKey)) {
    throw new SyntheticFinancialWebhookIngressError('INGRESS_IDEMPOTENCY_KEY_INVALID');
  }

  let receipt: ProviderEventInboxReceipt;
  try {
    receipt = await providerEventInbox.recordAuthenticatedEvent({
      providerKind: command.providerKind,
      providerEventReference: command.providerEventReference,
      providerEventKind: SYNTHETIC_FINANCIAL_PROVIDER_EVENT_KIND,
      operationId: command.operationId,
      ingressIdempotencyKey,
      rawPayload: Buffer.from(input.rawBody, 'utf8'),
      authentication: {
        status: 'VERIFIED',
        scheme: SYNTHETIC_FINANCIAL_AUTHENTICATION_SCHEME,
        evidenceSha256: authenticationEvidenceSha256(input.signature),
        verifiedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    if (error instanceof ProviderEventInboxError) throw error;
    throw new ProviderEventInboxError('PERSISTENCE_INCOMPLETE');
  }

  return {
    command,
    receipt,
    normalizationIdempotencyKey: syntheticFinancialWebhookNormalizationIdempotencyKey(
      command.providerKind,
      command.providerEventReference,
    ),
  };
}
