import type { Job } from 'bullmq';
import type Stripe from 'stripe';
import { db } from '../db.js';
import { workerLogger } from '../logger.js';
import { HustlerWalletService } from '../services/HustlerWalletService.js';
import { mapStripePayoutState } from '../services/HustlerWalletProvider.js';
import { NotificationService } from '../services/NotificationService.js';
import { verifyJobSignature } from './queues.js';

const log = workerLogger.child({ worker: 'payout-event' });
const PAYOUT_EVENT_TYPES = new Set([
  'payout.created',
  'payout.updated',
  'payout.paid',
  'payout.failed',
  'payout.canceled',
]);

interface StripePayoutEnvelope {
  account?: string;
  data?: { object?: ProviderPayoutObject };
}

interface ProviderPayoutObject {
  id: string;
  amount: number;
  status: Stripe.Payout['status'];
  arrival_date?: number | null;
  failure_code?: string | null;
  failure_message?: string | null;
  metadata?: Record<string, string>;
}

interface ClaimedPayoutEvent {
  payload_json: StripePayoutEnvelope;
  type: string;
}

interface SignedPayoutJob {
  stripeEventId: string;
  type: string;
}

function verifiedJobPayload(job: Job): SignedPayoutJob {
  const rawPayload = (job.data as Record<string, unknown>).payload;
  if (!rawPayload || typeof rawPayload !== 'object') {
    throw new Error('Missing or invalid job payload — rejecting unsigned job');
  }
  const { _sig, ...payload } = rawPayload as Record<string, unknown>;
  if (typeof _sig !== 'string' || !verifyJobSignature(payload, _sig)) {
    throw new Error('JOB_SIGNATURE_INVALID: Payload signature verification failed');
  }
  if (typeof payload.stripeEventId !== 'string' || typeof payload.type !== 'string') {
    throw new Error('Signed payout job is missing stripeEventId or type');
  }
  return { stripeEventId: payload.stripeEventId, type: payload.type };
}

async function claimEvent(stripeEventId: string): Promise<ClaimedPayoutEvent | null> {
  const claim = await db.query<ClaimedPayoutEvent>(
    `UPDATE stripe_events
     SET claimed_at=NOW(),result='processing',error_message=NULL
     WHERE stripe_event_id=$1 AND claimed_at IS NULL AND processed_at IS NULL
     RETURNING payload_json,type`,
    [stripeEventId],
  );
  return claim.rows[0] ?? null;
}

function providerState(type: string, payout: ProviderPayoutObject) {
  if (type === 'payout.paid') return 'paid' as const;
  if (type === 'payout.failed' || type === 'payout.canceled') return 'failed' as const;
  return mapStripePayoutState(payout.status);
}

function validPayout(event: StripePayoutEnvelope, type: string): ProviderPayoutObject {
  const payout = event.data?.object;
  if (!payout?.id || !Number.isInteger(payout.amount) || payout.amount <= 0) {
    throw new Error(`${type} missing a valid payout object`);
  }
  return payout;
}

async function resolveWorkerId(
  accountId: string | null,
  syncedWorkerId: string | null,
): Promise<string | null> {
  if (syncedWorkerId) return syncedWorkerId;
  if (!accountId) return null;
  const result = await db.query<{ id: string }>(
    'SELECT id FROM users WHERE stripe_connect_id=$1 LIMIT 1',
    [accountId],
  );
  return result.rows[0]?.id ?? null;
}

async function recordFailedPayout(input: {
  payout: ProviderPayoutObject;
  stripeEventId: string;
  workerId: string | null;
  accountId: string | null;
}): Promise<void> {
  await db.query(
    `INSERT INTO revenue_ledger (
       event_type,user_id,amount_cents,currency,gross_amount_cents,
       platform_fee_cents,net_amount_cents,stripe_event_id,metadata
     ) VALUES ('failed_payout',$1,$2,'usd',$2,0,$2,$3,$4::jsonb)
     ON CONFLICT (stripe_event_id) DO NOTHING`,
    [
      input.workerId,
      -Math.abs(input.payout.amount),
      input.stripeEventId,
      JSON.stringify({
        payout_id: input.payout.id,
        connect_account_id: input.accountId,
        failure_code: input.payout.failure_code ?? null,
        failure_message: input.payout.failure_message ?? null,
      }),
    ],
  );
}

async function notifyTerminalState(
  workerId: string | null,
  state: 'paid' | 'failed',
  payoutId: string,
  stripeEventId: string,
): Promise<void> {
  if (!workerId) return;
  const notification = await NotificationService.createNotification({
    userId: workerId,
    category: state === 'paid' ? 'payment_released' : 'payout_failed',
    title: state === 'paid' ? 'Bank Payout Paid' : 'Bank Payout Failed',
    body: state === 'paid'
      ? 'Stripe marked your bank payout paid. Open your wallet for the provider-backed receipt.'
      : 'Your bank payout failed. Stripe returns failed payout funds to the connected balance; update the destination before trying again.',
    deepLink: `app://wallet/${payoutId}`,
    objectRef: { type: 'payout', id: payoutId },
    dedupeKey: `stripe:${stripeEventId}:payout_${state}`,
    metadata: { payoutId, stripeEventId, eventVersion: 1 },
    channels: ['in_app', 'push'],
    priority: state === 'failed' ? 'CRITICAL' : 'HIGH',
  });
  if (!notification.success) throw new Error(notification.error.message);
}

function payoutEventInput(input: {
  claimed: ClaimedPayoutEvent;
  payout: ProviderPayoutObject;
  stripeEventId: string;
  accountId: string | null;
}) {
  return {
    stripeEventId: input.stripeEventId,
    providerPayoutId: input.payout.id,
    state: providerState(input.claimed.type, input.payout),
    amountCents: input.payout.amount,
    accountId: input.accountId,
    requestId: input.payout.metadata?.wallet_request_id ?? null,
    estimatedArrivalAt: input.payout.arrival_date
      ? new Date(input.payout.arrival_date * 1000).toISOString()
      : null,
    failureCode: input.payout.failure_code ?? null,
    failureMessage: input.payout.failure_message ?? null,
  };
}

async function handleTerminalPayout(input: {
  payout: ProviderPayoutObject;
  stripeEventId: string;
  accountId: string | null;
  workerId: string | null;
  state: ReturnType<typeof providerState>;
}): Promise<void> {
  if (input.state !== 'paid' && input.state !== 'failed') return;
  const workerId = await resolveWorkerId(input.accountId, input.workerId);
  if (input.state === 'failed') {
    await recordFailedPayout({
      payout: input.payout,
      stripeEventId: input.stripeEventId,
      workerId,
      accountId: input.accountId,
    });
  }
  await notifyTerminalState(workerId, input.state, input.payout.id, input.stripeEventId);
}

async function handlePayout(
  claimed: ClaimedPayoutEvent,
  stripeEventId: string,
): Promise<void> {
  if (!PAYOUT_EVENT_TYPES.has(claimed.type)) {
    throw new Error(`Unsupported payout event type: ${claimed.type}`);
  }
  const payout = validPayout(claimed.payload_json, claimed.type);
  const accountId = claimed.payload_json.account
    ?? payout.metadata?.connect_account_id
    ?? null;
  const eventInput = payoutEventInput({ claimed, payout, stripeEventId, accountId });
  const synced = await HustlerWalletService.syncProviderPayoutEvent(eventInput);
  await handleTerminalPayout({
    payout,
    stripeEventId,
    accountId,
    workerId: synced.workerId,
    state: eventInput.state,
  });
}

async function markSuccess(stripeEventId: string): Promise<void> {
  await db.query(
    `UPDATE stripe_events SET result='success',processed_at=NOW()
     WHERE stripe_event_id=$1`,
    [stripeEventId],
  );
}

async function releaseFailedClaim(stripeEventId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : 'Unknown error';
  await db.query(
    `UPDATE stripe_events
     SET result='failed',claimed_at=NULL,error_message=$2
     WHERE stripe_event_id=$1`,
    [stripeEventId, message],
  );
}

export async function processPayoutEventJob(job: Job): Promise<void> {
  const { stripeEventId } = verifiedJobPayload(job);
  const claimed = await claimEvent(stripeEventId);
  if (!claimed) {
    log.info({ stripeEventId }, 'Payout event already processed, skipping');
    return;
  }
  try {
    await handlePayout(claimed, stripeEventId);
    await markSuccess(stripeEventId);
  } catch (error) {
    await releaseFailedClaim(stripeEventId, error);
    log.error({ stripeEventId, err: error }, 'Payout event failed; claim released for retry');
    throw error;
  }
}

export function isPayoutEventType(type: string): boolean {
  return PAYOUT_EVENT_TYPES.has(type);
}
