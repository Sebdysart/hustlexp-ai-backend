import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { db, type QueryFn } from '../db.js';
import { logger } from '../logger.js';
import { NotificationService } from './NotificationService.js';
import { controlledTestQuotePaymentEnabled } from './ControlledTestQuotePaymentService.js';
import { newPaymentCreationFailure } from './NewPaymentCreationGuard.js';

type Assessment = {
  id: string; task_draft_id: string; business_organization_id: string;
  poster_user_id: string; assessment_fee_cents: number | null; status: string;
};
type Payment = {
  id: string; assessment_request_id: string; task_draft_id: string;
  business_organization_id: string; poster_user_id: string;
  provider: string; provider_payment_id: string; provider_merchant_id: string;
  amount_cents: number; currency: string; status: string;
};
type Intent = {
  id: string; assessment_payment_id: string; assessment_request_id: string;
  task_draft_id: string; business_organization_id: string; poster_user_id: string;
  amount_cents: number; currency: string; client_secret_hash: string; status: string;
};

const log = logger.child({ service: 'AssessmentPaymentService' });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const reference = (assessmentId: string) => `assessment_local_test_${digest(assessmentId).slice(0, 32)}`;

function requireControlledPayment(): void {
  if (process.env.PAYMENT_PROVIDER !== 'local_test') {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Assessment payment is unavailable for the configured provider.' });
  }
  if (!controlledTestQuotePaymentEnabled()) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Controlled assessment payment is disabled or incomplete.' });
  }
}

async function ownedAssessment(query: QueryFn, assessmentId: string, posterId: string, lock = false): Promise<Assessment> {
  const result = await query<Assessment>(
    `SELECT a.id,a.task_draft_id,a.business_organization_id,d.poster_user_id,
            a.assessment_fee_cents,a.status
     FROM business_assessment_requests a
     JOIN task_drafts d ON d.id=a.task_draft_id
     WHERE a.id=$1 AND d.poster_user_id=$2 ${lock ? 'FOR UPDATE OF a' : ''}`,
    [assessmentId, posterId],
  );
  if (!result.rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'Assessment request was not found.' });
  return result.rows[0];
}

function assertPayable(assessment: Assessment): number {
  if (assessment.status !== 'AWAITING_CUSTOMER') {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This assessment is not awaiting customer action.' });
  }
  const amount = assessment.assessment_fee_cents;
  if (!amount || amount <= 0) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This assessment does not require payment.' });
  }
  return amount;
}

/** A local payment and its provider ledger are committed before any confirmation. */
export async function createAssessmentPayment(assessmentId: string, posterId: string) {
  requireControlledPayment();
  let context: { draftId: string; organizationId: string } | undefined;
  try {
  return await db.transaction(async (query) => {
    const assessment = await ownedAssessment(query, assessmentId, posterId, true);
    context = { draftId: assessment.task_draft_id, organizationId: assessment.business_organization_id };
    const existing = await query<Payment>('SELECT * FROM assessment_payments WHERE assessment_request_id=$1 FOR UPDATE', [assessmentId]);
    let payment = existing.rows[0];
    // A confirmed payment remains queryable after the customer schedules the
    // assessment; scheduling must not make an idempotent replay look unpaid.
    if (payment?.status === 'SUCCEEDED' && payment.provider === 'local_test' &&
      payment.poster_user_id === posterId && payment.task_draft_id === assessment.task_draft_id &&
      payment.business_organization_id === assessment.business_organization_id &&
      payment.amount_cents === assessment.assessment_fee_cents && payment.currency === 'USD' &&
      payment.provider_payment_id === reference(assessmentId)) {
      return { paymentIntentId: payment.provider_payment_id, amountCents: payment.amount_cents,
        status: 'SUCCEEDED' as const, testMode: true, clientSecret: null };
    }
    const amount = assertPayable(assessment);
    if (payment && (payment.provider !== 'local_test' || payment.amount_cents !== amount ||
      payment.currency !== 'USD' || payment.poster_user_id !== posterId ||
      payment.business_organization_id !== assessment.business_organization_id ||
      payment.task_draft_id !== assessment.task_draft_id || payment.provider_payment_id !== reference(assessmentId))) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'The existing assessment payment requires support review.' });
    }
    if (payment?.status === 'SUCCEEDED') return { paymentIntentId: payment.provider_payment_id, amountCents: amount, status: 'SUCCEEDED' as const, testMode: true, clientSecret: null };
    if (payment?.status === 'REFUNDED' || payment?.status === 'FAILED') {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'The assessment payment requires support review.' });
    }
    if (!payment) {
      const frozen = newPaymentCreationFailure('assessment');
      if (frozen) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: frozen.error.message });
      const created = await query<Payment>(
        `INSERT INTO assessment_payments
         (assessment_request_id,task_draft_id,business_organization_id,poster_user_id,
          provider,provider_payment_id,provider_merchant_id,amount_cents,currency,status)
         VALUES ($1,$2,$3,$4,'local_test',$5,'local_test',$6,'USD','PENDING') RETURNING *`,
        [assessment.id,assessment.task_draft_id,assessment.business_organization_id,posterId,
          reference(assessmentId),amount],
      );
      payment = created.rows[0];
    }
    const intent = await query<Intent>('SELECT * FROM hxos_local_test_assessment_intents WHERE assessment_payment_id=$1 FOR UPDATE', [payment.id]);
    if (intent.rows[0]?.status === 'succeeded') {
      // Provider confirmation already committed; reconcile without creating another payment.
      return { paymentIntentId: payment.provider_payment_id, amountCents: amount, status: 'PROCESSING' as const, testMode: true, clientSecret: null };
    }
    const secret = randomBytes(32).toString('hex');
    if (intent.rows[0]) {
      await query('UPDATE hxos_local_test_assessment_intents SET client_secret_hash=$2,updated_at=NOW() WHERE id=$1', [payment.provider_payment_id,digest(secret)]);
    } else {
      await query(
        `INSERT INTO hxos_local_test_assessment_intents
         (id,assessment_payment_id,assessment_request_id,task_draft_id,business_organization_id,
          poster_user_id,amount_cents,currency,client_secret_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'USD',$8)`,
        [payment.provider_payment_id,payment.id,assessment.id,assessment.task_draft_id,
          assessment.business_organization_id,posterId,amount,digest(secret)],
      );
      await query(
        `INSERT INTO hxos_local_test_assessment_events (intent_id,event_type,idempotency_key)
         VALUES ($1,'intent_created',$2) ON CONFLICT (idempotency_key) DO NOTHING`,
        [payment.provider_payment_id,`assessment-intent-created:${assessment.id}`],
      );
    }
    return { paymentIntentId: payment.provider_payment_id, amountCents: amount, status: 'PENDING' as const, testMode: true, clientSecret: secret };
  });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    const dbError = error && typeof error === 'object' ? error as { code?: unknown; constraint?: unknown; column?: unknown } : {};
    const safe = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_]{1,128}$/.test(value) ? value : undefined;
    log.error({ action: 'createPaymentIntent', assessmentId, posterId,
      draftId: context?.draftId, organizationId: context?.organizationId,
      provider: process.env.PAYMENT_PROVIDER,
      errorClass: error instanceof Error ? error.constructor.name : typeof error,
      dbCode: safe(dbError.code), dbConstraint: safe(dbError.constraint), dbColumn: safe(dbError.column),
      message: dbError.code === '42703' ? 'Required payment column is missing'
        : dbError.code === '42P01' ? 'Required payment table is missing'
          : dbError.code === '23505' ? 'Payment uniqueness conflict'
            : 'Assessment payment transaction failed',
    }, 'Assessment payment creation failed');
    if (['42P01', '42703'].includes(String(dbError.code))) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Assessment payment is temporarily unavailable. Please contact support.' });
    }
    if (dbError.code === '23505') {
      throw new TRPCError({ code: 'CONFLICT', message: 'Assessment payment is already being prepared. Please retry.' });
    }
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Unable to create the assessment payment. Please try again.' });
  }
}

export async function confirmAssessmentPayment(assessmentId: string, posterId: string, clientSecret: string) {
  requireControlledPayment();
  await db.transaction(async (query) => {
    const assessment = await ownedAssessment(query, assessmentId, posterId, true);
    const payment = (await query<Payment>('SELECT * FROM assessment_payments WHERE assessment_request_id=$1 FOR UPDATE', [assessmentId])).rows[0];
    if (payment?.status === 'SUCCEEDED' && payment.poster_user_id === posterId) return;
    const amount = assertPayable(assessment);
    if (!payment || payment.provider !== 'local_test' || payment.poster_user_id !== posterId ||
      payment.amount_cents !== amount || payment.currency !== 'USD' ||
      payment.provider_payment_id !== reference(assessmentId)) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Assessment payment was not initialized for this customer.' });
    }
    if (payment.status !== 'PENDING') throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Assessment payment requires support review.' });
    const intent = (await query<Intent>('SELECT * FROM hxos_local_test_assessment_intents WHERE id=$1 FOR UPDATE', [payment.provider_payment_id])).rows[0];
    if (!intent || intent.assessment_payment_id !== payment.id || intent.assessment_request_id !== assessment.id ||
      intent.task_draft_id !== assessment.task_draft_id || intent.business_organization_id !== assessment.business_organization_id ||
      intent.poster_user_id !== posterId || intent.amount_cents !== amount || intent.currency !== 'USD') {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Assessment payment verification failed.' });
    }
    if (intent.status === 'succeeded') return;
    const supplied = Buffer.from(digest(clientSecret), 'hex');
    const expected = Buffer.from(intent.client_secret_hash, 'hex');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Assessment payment confirmation was not authorized.' });
    }
    await query("UPDATE hxos_local_test_assessment_intents SET status='succeeded',confirmed_at=NOW(),updated_at=NOW() WHERE id=$1", [intent.id]);
    await query(
      `INSERT INTO hxos_local_test_assessment_events (intent_id,event_type,idempotency_key)
       VALUES ($1,'intent_succeeded',$2) ON CONFLICT (idempotency_key) DO NOTHING`,
      [intent.id,`assessment-intent-succeeded:${assessment.id}`],
    );
  });
  await finalizeAssessmentPayment(assessmentId);
  return assessmentPaymentStatus(assessmentId, posterId);
}

/** Confirmation is read from the persisted provider ledger, never a browser status. */
export async function finalizeAssessmentPayment(assessmentId: string): Promise<void> {
  await db.transaction(async (query) => {
    const payment = (await query<Payment>('SELECT * FROM assessment_payments WHERE assessment_request_id=$1 FOR UPDATE', [assessmentId])).rows[0];
    if (!payment || payment.status === 'SUCCEEDED' || payment.status === 'REFUNDED') return;
    const intent = (await query<Intent>('SELECT * FROM hxos_local_test_assessment_intents WHERE id=$1 FOR SHARE', [payment.provider_payment_id])).rows[0];
    if (!intent || intent.status !== 'succeeded') return;
    const assessment = (await query<Assessment>(
      `SELECT a.id,a.task_draft_id,a.business_organization_id,d.poster_user_id,
      a.assessment_fee_cents,a.status
       FROM business_assessment_requests a JOIN task_drafts d ON d.id=a.task_draft_id WHERE a.id=$1`,
      [assessmentId],
    )).rows[0];
    if (!assessment || assessment.status !== 'AWAITING_CUSTOMER' ||
      assessment.assessment_fee_cents !== payment.amount_cents ||
      intent.assessment_payment_id !== payment.id || intent.assessment_request_id !== assessmentId ||
      intent.task_draft_id !== payment.task_draft_id || intent.business_organization_id !== payment.business_organization_id ||
      intent.poster_user_id !== payment.poster_user_id || intent.amount_cents !== payment.amount_cents ||
      intent.currency !== payment.currency || payment.currency !== 'USD' ||
      payment.provider !== 'local_test' || payment.provider_payment_id !== reference(assessmentId) ||
      assessment.task_draft_id !== payment.task_draft_id ||
      assessment.business_organization_id !== payment.business_organization_id ||
      assessment.poster_user_id !== payment.poster_user_id) {
      throw new Error('Assessment payment provider/context mismatch; manual review required');
    }
    await query("UPDATE assessment_payments SET status='SUCCEEDED',updated_at=NOW() WHERE id=$1", [payment.id]);
    await NotificationService.createForBusinessInTransaction(query, payment.business_organization_id, {
      type: 'ASSESSMENT_PAID', title: 'Assessment fee paid',
      message: 'The customer paid the onsite assessment fee.', entityType: 'assessment',
      entityId: assessmentId, actionUrl: `/business/claims/${payment.task_draft_id}`,
      dedupeKey: `assessment-paid:${assessmentId}`,
    });
  });
}

export async function assessmentPaymentStatus(assessmentId: string, posterId: string) {
  await ownedAssessment(db.query, assessmentId, posterId);
  const row = (await db.query<Payment & { intent_status: string | null }>(
    `SELECT payment.*,intent.status AS intent_status FROM assessment_payments payment
     LEFT JOIN hxos_local_test_assessment_intents intent ON intent.assessment_payment_id=payment.id
     WHERE payment.assessment_request_id=$1`, [assessmentId],
  )).rows[0];
  const status = row?.status === 'PENDING' && row.intent_status === 'succeeded'
    ? 'PROCESSING' : row?.status ?? 'UNPAID';
  return { status, amountCents: row?.amount_cents ?? null, testMode: row?.provider === 'local_test', paymentIntentId: row?.provider_payment_id ?? null };
}

export async function reconcileAssessmentPayments(limit = 50): Promise<void> {
  const pending = await db.query<{ assessment_request_id: string }>(
    `SELECT payment.assessment_request_id FROM assessment_payments payment
     JOIN hxos_local_test_assessment_intents intent ON intent.assessment_payment_id=payment.id
     WHERE payment.provider='local_test' AND payment.status='PENDING' AND intent.status='succeeded'
     ORDER BY payment.updated_at,payment.id LIMIT $1`, [limit],
  );
  for (const row of pending.rows) {
    try { await finalizeAssessmentPayment(row.assessment_request_id); }
    catch (error) { log.error({ err: error, assessmentRequestId: row.assessment_request_id }, 'Assessment payment reconciliation failed'); }
  }
}
