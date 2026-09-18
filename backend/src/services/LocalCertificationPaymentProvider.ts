import type { StandaloneProductPurchase, ProductPaymentVerification } from './payment/StandaloneProductPaymentProvider.js';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { db, type QueryFn } from '../db.js';
import type { ServiceResult } from '../types.js';

const INTENT_RE = /^pi_hxos_test_[a-f0-9]{32}$/;
type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;

interface PaymentIntentRow {
  id: string;
  task_id: string;
  escrow_id: string;
  poster_id: string;
  amount_cents: number;
  status: 'requires_confirmation' | 'succeeded';
  client_secret_hash: string;
  is_test: boolean;
}

interface CreateIntentParams {
  taskId: string;
  escrowId: string;
  posterId: string;
  amountCents: number;
}

interface ConfirmIntentParams {
  paymentIntentId: string;
  clientSecret: string;
  posterId: string;
}

interface VerifyIntentParams {
  paymentIntentId: string;
  escrowId: string;
  taskId: string;
  posterId: string;
  amountCents: number;
}

function failure(code: string, message: string): ServiceResult<never> {
  return { success: false, error: { code, message } };
}

function secret(env: Environment = process.env): string {
  return env.HXOS_LOCAL_TEST_PAYMENT_SECRET?.trim() ?? '';
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(value: string, env: Environment = process.env): string {
  return createHmac('sha256', secret(env)).update(value).digest('hex');
}

function equalHex(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function localCertificationPaymentEnabled(
  env: Environment = process.env,
): boolean {
  const environmentAllowed =
    env.NODE_ENV !== 'production' ||
    env.HXOS_ALLOW_LOCAL_TEST_PAYMENT_IN_PRODUCTION === 'true';

  return environmentAllowed
    && env.HXOS_ALLOW_LOCAL_TEST_PAYMENT === 'true'
    && env.ENGINE_API_MODE === 'test'
    && env.STRIPE_MODE === 'test'
    && secret(env).length >= 32;
}

export function isLocalCertificationPaymentIntentId(value: string): boolean {
  return INTENT_RE.test(value);
}

function identifiers(escrowId: string): { paymentIntentId: string; clientSecret: string } {
  const paymentIntentId = `pi_hxos_test_${hmac(`intent:${escrowId}`).slice(0, 32)}`;
  return {
    paymentIntentId,
    clientSecret: `${paymentIntentId}_secret_${hmac(`client-secret:${escrowId}`)}`,
  };
}

export const LocalCertificationPaymentProvider = {
  createIntent: async (
    params: CreateIntentParams,
  ): Promise<ServiceResult<{ paymentIntentId: string; clientSecret: string; amount: number }>> => {
    if (!localCertificationPaymentEnabled()) {
      return failure('LOCAL_TEST_PAYMENT_DISABLED', 'Local certification payments are disabled.');
    }
    const { paymentIntentId, clientSecret } = identifiers(params.escrowId);
    try {
      const row = await db.transaction(async (query) => {
        await query(
          `INSERT INTO hxos_local_test_payment_intents
             (id, task_id, escrow_id, poster_id, amount_cents, client_secret_hash)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (escrow_id) DO NOTHING`,
          [paymentIntentId, params.taskId, params.escrowId, params.posterId, params.amountCents, digest(clientSecret)],
        );
        const selected = await query<PaymentIntentRow>(
          `SELECT id, task_id, escrow_id, poster_id, amount_cents, status,
                  client_secret_hash, is_test
           FROM hxos_local_test_payment_intents
           WHERE escrow_id = $1
           FOR UPDATE`,
          [params.escrowId],
        );
        const intent = selected.rows[0];
        if (!intent
            || intent.id !== paymentIntentId
            || intent.task_id !== params.taskId
            || intent.poster_id !== params.posterId
            || intent.amount_cents !== params.amountCents
            || intent.client_secret_hash !== digest(clientSecret)
            || intent.is_test !== true) {
          throw new Error('LOCAL_TEST_PAYMENT_CONFLICT');
        }
        await query(
          `INSERT INTO hxos_local_test_payment_events
             (payment_intent_id, from_status, to_status, event_type, idempotency_key, metadata)
           VALUES ($1, NULL, 'requires_confirmation', 'intent_created', $2, $3::jsonb)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [paymentIntentId, `local-test-payment-created:${paymentIntentId}`, JSON.stringify({
            task_id: params.taskId,
            escrow_id: params.escrowId,
            amount_cents: params.amountCents,
          })],
        );
        return intent;
      });
      return { success: true, data: { paymentIntentId: row.id, clientSecret, amount: row.amount_cents } };
    } catch (error) {
      const code = error instanceof Error && error.message === 'LOCAL_TEST_PAYMENT_CONFLICT'
        ? 'LOCAL_TEST_PAYMENT_CONFLICT' : 'LOCAL_TEST_PAYMENT_FAILED';
      return failure(code, 'Local certification payment intent could not be created.');
    }
  },

  confirmIntent: async (
    params: ConfirmIntentParams,
  ): Promise<ServiceResult<{ paymentIntentId: string; status: 'succeeded'; idempotencyReplayed: boolean }>> => {
    if (!localCertificationPaymentEnabled()) {
      return failure('LOCAL_TEST_PAYMENT_DISABLED', 'Local certification payments are disabled.');
    }
    if (!isLocalCertificationPaymentIntentId(params.paymentIntentId)) {
      return failure('LOCAL_TEST_PAYMENT_INVALID', 'Local certification payment identity is invalid.');
    }
    try {
      return await db.transaction(async (query) => {
        const selected = await query<PaymentIntentRow>(
          `SELECT p.id, p.task_id, p.escrow_id, p.poster_id, p.amount_cents,
                  p.status, p.client_secret_hash, p.is_test
           FROM hxos_local_test_payment_intents p
           JOIN tasks t ON t.id = p.task_id
           WHERE p.id = $1
             AND p.poster_id = $2
             AND t.automation_classification = 'CONTROLLED_TEST'
           FOR UPDATE OF p`,
          [params.paymentIntentId, params.posterId],
        );
        const intent = selected.rows[0];
        if (!intent || intent.is_test !== true) {
          return failure('LOCAL_TEST_PAYMENT_NOT_FOUND', 'Local certification payment was not found.');
        }
        const providedHash = digest(params.clientSecret);
        if (!equalHex(providedHash, intent.client_secret_hash)) {
          return failure('LOCAL_TEST_PAYMENT_SECRET_INVALID', 'Local certification payment secret is invalid.');
        }
        if (intent.status === 'succeeded') {
          return { success: true, data: {
            paymentIntentId: intent.id,
            status: 'succeeded' as const,
            idempotencyReplayed: true,
          } };
        }
        await query(
          `UPDATE hxos_local_test_payment_intents
           SET status = 'succeeded', succeeded_at = NOW()
           WHERE id = $1 AND status = 'requires_confirmation'`,
          [intent.id],
        );
        await query(
          `INSERT INTO hxos_local_test_payment_events
             (payment_intent_id, from_status, to_status, event_type, idempotency_key, metadata)
           VALUES ($1, 'requires_confirmation', 'succeeded', 'intent_succeeded', $2, $3::jsonb)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [intent.id, `local-test-payment-succeeded:${intent.id}`, JSON.stringify({
            task_id: intent.task_id,
            escrow_id: intent.escrow_id,
            amount_cents: intent.amount_cents,
          })],
        );
        return { success: true, data: {
          paymentIntentId: intent.id,
          status: 'succeeded' as const,
          idempotencyReplayed: false,
        } };
      });
    } catch {
      return failure('LOCAL_TEST_PAYMENT_FAILED', 'Local certification payment confirmation failed.');
    }
  },

  verifySucceededIntent: async (
    params: VerifyIntentParams,
  ): Promise<ServiceResult<{ status: 'succeeded'; amountCents: number }>> => {
    if (!localCertificationPaymentEnabled()) {
      return failure('LOCAL_TEST_PAYMENT_DISABLED', 'Local certification payments are disabled.');
    }
    const result = await db.query<PaymentIntentRow>(
      `SELECT p.id, p.task_id, p.escrow_id, p.poster_id, p.amount_cents,
              p.status, p.client_secret_hash, p.is_test
       FROM hxos_local_test_payment_intents p
       JOIN tasks t ON t.id = p.task_id
       WHERE p.id = $1
         AND p.escrow_id = $2
         AND p.task_id = $3
         AND p.poster_id = $4
         AND p.amount_cents = $5
         AND p.status = 'succeeded'
         AND p.is_test IS TRUE
         AND t.automation_classification = 'CONTROLLED_TEST'`,
      [params.paymentIntentId, params.escrowId, params.taskId, params.posterId, params.amountCents],
    );
    if (!result.rows[0]) {
      return failure('LOCAL_TEST_PAYMENT_NOT_SUCCEEDED', 'Local certification payment is not provider-confirmed.');
    }
    return { success: true, data: { status: 'succeeded', amountCents: result.rows[0].amount_cents } };
  },

  /** Standalone controlled product lane. Uses the existing secret/gate, never task or escrow rows. */
  createProductIntent: async (purchase: StandaloneProductPurchase): Promise<{ id: string }> => {
    assertControlledProductEnabled();
    const id = `pi_hxos_product_test_${hmac(`product-intent:${purchase.id}`).slice(0, 32)}`;
    const secretHash = digest(hmac(`product-confirm:${purchase.id}`));
    return db.transaction(async (query) => {
      await query(
        `INSERT INTO hxos_local_test_product_intents
        (id,purchase_id,organization_id,purchaser_user_id,product_code,amount_cents,currency,period_days,client_secret_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (purchase_id) DO NOTHING`,
        [
          id,
          purchase.id,
          purchase.organization_id,
          purchase.purchaser_user_id,
          purchase.product_code,
          purchase.amount_cents,
          purchase.currency,
          purchase.period_days,
          secretHash,
        ]
      );
      const intent = await readProductIntent(query, { ...purchase, provider_payment_id: id });
      if (!equalHex(intent.client_secret_hash, secretHash))
        throw new Error('Controlled product secret mismatch');
      await query(
        `INSERT INTO hxos_local_test_product_events(payment_intent_id,event_type,idempotency_key)
        VALUES($1,'intent_created',$2) ON CONFLICT(idempotency_key) DO NOTHING`,
        [id, `product-created:${id}`]
      );
      return { id };
    });
  },
  confirmProductIntent: async (
    purchase: StandaloneProductPurchase,
    query: QueryFn
  ): Promise<void> => {
    assertControlledProductEnabled();
    const intent = await readProductIntent(query, purchase, true);
    if (!equalHex(intent.client_secret_hash, digest(hmac(`product-confirm:${purchase.id}`))))
      throw new Error('Controlled product secret mismatch');
    if (intent.status === 'succeeded') return;
    if (intent.status !== 'requires_confirmation')
      throw new Error('Controlled product payment is not confirmable');
    await query(
      "UPDATE hxos_local_test_product_intents SET status='succeeded',succeeded_at=NOW() WHERE id=$1",
      [intent.id]
    );
    await query(
      `INSERT INTO hxos_local_test_product_events(payment_intent_id,event_type,idempotency_key)
      VALUES($1,'intent_succeeded',$2) ON CONFLICT(idempotency_key) DO NOTHING`,
      [intent.id, `product-succeeded:${intent.id}`]
    );
  },
  verifyProductIntent: async (
    purchase: StandaloneProductPurchase
  ): Promise<ProductPaymentVerification> => {
    assertControlledProductEnabled();
    const intent = await readProductIntent(db.query.bind(db), purchase);
    if (intent.status === 'succeeded') return { state: 'paid', transactionId: intent.id };
    return { state: intent.status === 'requires_confirmation' ? 'pending' : intent.status };
  },
};

interface ProductIntentRow {
  id: string;
  purchase_id: string;
  organization_id: string;
  purchaser_user_id: string | null;
  product_code: string;
  amount_cents: number;
  currency: string;
  period_days: number;
  is_test: boolean;
  client_secret_hash: string;
  status: 'requires_confirmation' | 'succeeded' | 'failed' | 'canceled';
}
function assertControlledProductEnabled(): void {
  if (
    process.env.PAYMENT_PROVIDER !== 'local_test' ||
    process.env.PROVIDER_OS_TEST_PURCHASE_ENABLED !== 'true' ||
    !localCertificationPaymentEnabled()
  ) {
    throw new Error('Controlled product payments are disabled');
  }
}
async function readProductIntent(
  query: QueryFn,
  p: StandaloneProductPurchase,
  lock = false
): Promise<ProductIntentRow> {
  const result = await query<ProductIntentRow>(
    `SELECT * FROM hxos_local_test_product_intents WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`,
    [p.provider_payment_id]
  );
  const r = result.rows[0];
  if (
    !r ||
    r.purchase_id !== p.id ||
    r.organization_id !== p.organization_id ||
    r.purchaser_user_id !== p.purchaser_user_id ||
    r.product_code !== p.product_code ||
    r.amount_cents !== p.amount_cents ||
    r.currency !== p.currency ||
    r.period_days !== p.period_days ||
    !r.is_test ||
    !p.test_mode
  )
    throw new Error('Controlled product payment binding mismatch');
  return r;
}
