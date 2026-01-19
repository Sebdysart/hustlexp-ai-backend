/**
 * StripeEntitlementProcessor (SKELETON)
 * 
 * Step 9-D - Stripe Integration: Process per-task entitlement purchases
 * 
 * STATUS: Skeleton only - implementation pending approval
 * 
 * Invariants define behavior (S-3, S-4, S-5):
 * - S-3: Entitlements are idempotent (UNIQUE source_event_id)
 * - S-4: Entitlements never outlive payment (expires_at enforcement)
 * - S-5: Entitlements must reference validated Stripe event
 * 
 * @see backend/tests/invariants/stripe-monetization.test.ts
 * @see STEP_9D_STRIPE_INTEGRATION.md
 */

import { db } from '../db';

interface PaymentIntentPayload {
  id: string;
  metadata?: {
    user_id?: string;
    task_id?: string;
    risk_level?: 'MEDIUM' | 'HIGH' | 'IN_HOME';
    entitlement_expires_at?: string; // optional unix timestamp (string)
  };
}

interface StripeEventEnvelope {
  id: string;
  data?: {
    object?: PaymentIntentPayload;
  };
}

/**
 * Process payment_intent.succeeded for per-task entitlement creation
 * 
 * Enforces:
 * - S-3: Idempotency via UNIQUE(source_event_id)
 * - S-4: Expiry enforced via expires_at > NOW() checks
 * - S-5: Entitlements require validated Stripe event
 */
export async function processEntitlementPurchase(
  payload: unknown,
  stripeEventId: string
): Promise<void> {
  const event = payload as StripeEventEnvelope;
  const paymentIntent = (event?.data?.object ?? payload) as PaymentIntentPayload;

  const userId = paymentIntent?.metadata?.user_id;
  const taskId = paymentIntent?.metadata?.task_id;
  const riskLevel = paymentIntent?.metadata?.risk_level;

  if (!userId || !riskLevel) {
    throw new Error('Missing required metadata for entitlement purchase (user_id, risk_level)');
  }

  // S-5: Stripe event must exist and be validated
  const eventCheck = await db.query<{ stripe_event_id: string }>(
    `SELECT stripe_event_id FROM stripe_events WHERE stripe_event_id = $1`,
    [stripeEventId]
  );

  if (eventCheck.rowCount === 0) {
    throw new Error(`Stripe event ${stripeEventId} not found - cannot create entitlement`);
  }

  // Optional explicit expiry timestamp from metadata (unix seconds)
  const expiresAtRaw = paymentIntent?.metadata?.entitlement_expires_at;

  await db.query(
    `
    INSERT INTO plan_entitlements (
      user_id,
      task_id,
      risk_level,
      source_event_id,
      source_payment_intent,
      expires_at
    )
    VALUES (
      $1,
      $2,
      $3,
      $4,
      $5,
      ${expiresAtRaw ? 'to_timestamp($6)' : "NOW() + INTERVAL '24 hours'"}
    )
    ON CONFLICT (source_event_id) DO NOTHING
    `,
    expiresAtRaw
      ? [userId, taskId || null, riskLevel, stripeEventId, paymentIntent.id, Number(expiresAtRaw)]
      : [userId, taskId || null, riskLevel, stripeEventId, paymentIntent.id]
  );
}
