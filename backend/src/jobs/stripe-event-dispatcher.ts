import type { Job } from 'bullmq';
import { db } from '../db.js';
import { processPaymentJob } from './payment-worker.js';
import { isPayoutEventType, processPayoutEventJob } from './payout-event-worker.js';
import { processStripeEventJob } from './stripe-event-worker.js';

const PAYMENT_LIFECYCLE_EVENT_TYPES = new Set([
  'payment_intent.payment_failed',
  'transfer.created',
  'transfer.failed',
  'charge.refunded',
]);

export type StripeEventDestination = 'payout' | 'payment' | 'stripe';

export function stripeEventDestination(type: string): StripeEventDestination {
  if (isPayoutEventType(type)) return 'payout';
  if (PAYMENT_LIFECYCLE_EVENT_TYPES.has(type)) return 'payment';
  return 'stripe';
}

interface SignedStripeJobPayload {
  stripeEventId: string;
  type: string | null;
}

function signedPayload(job: Job): SignedStripeJobPayload {
  const raw = (job.data as Record<string, unknown>).payload;
  if (!raw || typeof raw !== 'object') {
    throw new Error('Missing signed Stripe event payload');
  }
  const payload = raw as Record<string, unknown>;
  if (typeof payload.stripeEventId !== 'string') {
    throw new Error('Signed Stripe event payload is missing stripeEventId');
  }
  return {
    stripeEventId: payload.stripeEventId,
    type: typeof payload.type === 'string' ? payload.type : null,
  };
}

async function storedEventType(stripeEventId: string): Promise<string> {
  const result = await db.query<{ type: string }>(
    'SELECT type FROM stripe_events WHERE stripe_event_id=$1',
    [stripeEventId],
  );
  const type = result.rows[0]?.type;
  if (!type) throw new Error(`Stripe event ${stripeEventId} was not found`);
  return type;
}

export async function processStripeEventDispatchJob(job: Job): Promise<void> {
  const payload = signedPayload(job);
  const type = payload.type ?? await storedEventType(payload.stripeEventId);
  const destination = stripeEventDestination(type);
  if (destination === 'payout') {
    await processPayoutEventJob(job);
    return;
  }
  if (destination === 'payment') {
    // Keep the original signed payload intact. payment-worker accepts the
    // canonical `type` field and verifies the HMAC before touching the DB.
    await processPaymentJob(job as never);
    return;
  }
  const normalized = {
    ...job,
    data: { ...job.data, stripeEventId: payload.stripeEventId, type },
  } as Job;
  await processStripeEventJob(normalized as never);
}
