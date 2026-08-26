import { randomUUID } from 'crypto';
import type { Job } from 'bullmq';
import { db, type QueryFn } from '../db.js';
import { outboxTransportJobId } from './OutboxIdentity.js';

export const STRIPE_EVENT_INBOX_LEASE_MINUTES = 10;
const CLAIM_TOKEN_PREFIX = 'STRIPE_EVENT_CLAIM:';

export class StripeEventInboxClaimLostError extends Error {
  readonly code = 'STRIPE_EVENT_INBOX_CLAIM_LOST';

  constructor(stripeEventId: string) {
    super(`STRIPE_EVENT_INBOX_CLAIM_LOST: active claim changed for ${stripeEventId}`);
    this.name = 'StripeEventInboxClaimLostError';
  }
}

export function isStripeEventInboxClaimLost(
  error: unknown,
): error is StripeEventInboxClaimLostError {
  return error instanceof StripeEventInboxClaimLostError;
}

export type StripeEventInboxClaim<TPayload> = {
  stripe_event_id: string;
  type: string;
  payload_json: TPayload;
  claimToken: string;
};

export function requireExactStripeEventOutboxKey(
  job: Job,
  signedPayload: Record<string, unknown>,
  stripeEventId: string,
): string {
  const key = signedPayload._outbox_key;
  const canonicalKey = `stripe.event_received:${stripeEventId}`;
  const recoveryPrefix = `stripe.event_received.recovery:${stripeEventId}:`;
  const recoveryGeneration = typeof key === 'string' && key.startsWith(recoveryPrefix)
    ? key.slice(recoveryPrefix.length)
    : '';
  const exactRecoveryKey = /^\d{10,16}$/u.test(recoveryGeneration);
  if (
    typeof key !== 'string'
    || (key !== canonicalKey && !exactRecoveryKey)
    || typeof job.id !== 'string'
    || job.id !== outboxTransportJobId(key)
  ) {
    throw new Error(
      `JOB_IDENTITY_INVALID: Stripe event ${stripeEventId} transport ID does not match its signed outbox identity`,
    );
  }
  return key;
}

/**
 * Claim one Stripe inbox row, or rotate an expired hard-crash lease.
 *
 * `claimed_at` remains database-clock authority. The random token is persisted
 * only while `result='processing'`, and fences every later terminal/release
 * write so a paused pre-recovery worker cannot acknowledge the new claim.
 */
export async function claimStripeEventInbox<TPayload>(
  stripeEventId: string,
): Promise<StripeEventInboxClaim<TPayload> | null> {
  const claimToken = `${CLAIM_TOKEN_PREFIX}${randomUUID()}`;
  const claim = await db.query<{
    stripe_event_id: string;
    type: string;
    payload_json: TPayload;
  }>(
    `UPDATE stripe_events
     SET claimed_at=NOW(),
         result='processing',
         error_message=$2
     WHERE stripe_event_id=$1
       AND processed_at IS NULL
       AND (
         claimed_at IS NULL
         OR (
           result='processing'
           AND claimed_at < NOW() - INTERVAL '1 minute' * $3
         )
       )
     RETURNING stripe_event_id,type,payload_json`,
    [stripeEventId, claimToken, STRIPE_EVENT_INBOX_LEASE_MINUTES],
  );
  const row = claim.rows[0];
  return row ? { ...row, claimToken } : null;
}

type TerminalStripeEventResult = 'success' | 'skipped' | 'failed';

export async function finalizeStripeEventInboxClaim(input: {
  stripeEventId: string;
  claimToken: string;
  result: TerminalStripeEventResult;
  errorMessage?: string | null;
  query?: QueryFn;
}): Promise<void> {
  const query = input.query ?? db.query;
  const updated = await query<{ stripe_event_id: string }>(
    `UPDATE stripe_events
     SET result = '${input.result}',
         processed_at = NOW(),
         error_message = $3
     WHERE stripe_event_id=$1
       AND result = 'processing'
       AND processed_at IS NULL
       AND error_message=$2
     RETURNING stripe_event_id`,
    [
      input.stripeEventId,
      input.claimToken,
      input.errorMessage ?? null,
    ],
  );
  if (updated.rowCount !== 1) {
    throw new StripeEventInboxClaimLostError(input.stripeEventId);
  }
}

/**
 * Release only the caller's exact lease. A stale worker returns false and can
 * never clear or overwrite a newer claim.
 */
export async function releaseStripeEventInboxClaim(input: {
  stripeEventId: string;
  claimToken: string;
  errorMessage: string;
  query?: QueryFn;
}): Promise<boolean> {
  const query = input.query ?? db.query;
  const updated = await query<{ stripe_event_id: string }>(
    `UPDATE stripe_events
     SET result = 'failed',
         claimed_at = NULL,
         error_message=$3
     WHERE stripe_event_id=$1
       AND result = 'processing'
       AND processed_at IS NULL
       AND error_message=$2
     RETURNING stripe_event_id`,
    [input.stripeEventId, input.claimToken, input.errorMessage],
  );
  return updated.rowCount === 1;
}
