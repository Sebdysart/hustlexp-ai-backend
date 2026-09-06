import { createHash } from 'node:crypto';

import {
  syntheticFinancialObservationSchema,
  type SyntheticFinancialObservation,
} from './SyntheticFinancialCommandSchemas.js';
import { SyntheticFinancialAuthorityError } from './SyntheticFinancialCommandAuthority.js';
import { ProviderEventInboxError, type ProviderEventInboxReceipt } from './ProviderEventInbox.js';
import { SealedSyntheticFinancialWebhookInbox } from './SealedSyntheticFinancialWebhookInbox.js';
import { fakeFinancialWebhookKeyIdSchema } from './FakeFinancialWebhookAuthentication.js';

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
  readonly keyId: string;
  readonly rawBody: string;
  readonly signature: string;
  readonly ingressIdempotencyKey?: string;
}

export interface AuthenticatedSyntheticFinancialWebhook {
  readonly observation: SyntheticFinancialObservation;
  readonly receipt: ProviderEventInboxReceipt;
  readonly normalizationIdempotencyKey: string;
}

const providerEventInbox = new SealedSyntheticFinancialWebhookInbox();

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function syntheticFinancialWebhookNormalizationIdempotencyKey(
  providerKind: string,
  providerEventReference: string
): string {
  return `provider-event:${sha256(`${providerKind}\0${providerEventReference}`)}`;
}

export function parseSyntheticFinancialObservation(rawBody: string): SyntheticFinancialObservation {
  let input: unknown;
  try {
    input = JSON.parse(rawBody);
  } catch {
    throw new SyntheticFinancialWebhookIngressError('PAYLOAD_INVALID');
  }
  const parsed = syntheticFinancialObservationSchema.safeParse(input);
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
  input: AuthenticateAndRecordSyntheticFinancialWebhookInput
): Promise<AuthenticatedSyntheticFinancialWebhook> {
  if (
    !fakeFinancialWebhookKeyIdSchema.safeParse(input.keyId).success ||
    !/^[a-f0-9]{64}$/u.test(input.signature)
  ) {
    throw new SyntheticFinancialAuthorityError('WEBHOOK_HMAC_INVALID');
  }
  const observation = parseSyntheticFinancialObservation(input.rawBody);
  const normalizationIdempotencyKey = syntheticFinancialWebhookNormalizationIdempotencyKey(
    observation.providerKind,
    observation.providerEventReference
  );
  const ingressIdempotencyKey = input.ingressIdempotencyKey ?? normalizationIdempotencyKey;
  if (!INGRESS_IDEMPOTENCY_KEY.test(ingressIdempotencyKey)) {
    throw new SyntheticFinancialWebhookIngressError('INGRESS_IDEMPOTENCY_KEY_INVALID');
  }

  let receipt: ProviderEventInboxReceipt;
  try {
    receipt = await providerEventInbox.record({
      keyId: input.keyId,
      rawBody: input.rawBody,
      signature: input.signature,
      ingressIdempotencyKey,
    });
  } catch (error) {
    if (
      error instanceof ProviderEventInboxError ||
      error instanceof SyntheticFinancialAuthorityError
    )
      throw error;
    throw new ProviderEventInboxError('PERSISTENCE_INCOMPLETE');
  }

  return Object.freeze({
    observation: Object.freeze(observation),
    receipt,
    normalizationIdempotencyKey,
  });
}
