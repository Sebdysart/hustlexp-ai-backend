import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { db, type QueryFn } from '../../db.js';
import { logger } from '../../logger.js';
import { recordOpsAudit } from '../OpsAuditService.js';
import { TilledApiError, TilledClient, type TilledPaymentIntent, type TilledRefund, type TilledRefundReason } from './TilledClient.js';
import { loadTilledConfig } from './TilledConfig.js';

const log = logger.child({ service: 'TilledQuoteRefundService' });
const heldStatuses = ['RESERVED', 'PROCESSING', 'PENDING', 'UNCERTAIN', 'REQUIRES_ACTION', 'SUCCEEDED'];
const nonterminalStatuses = ['RESERVED', 'PROCESSING', 'PENDING', 'UNCERTAIN', 'REQUIRES_ACTION'];

interface BoundPayment {
  id: string; task_id: string; quote_id: string; quote_version_id: string;
  business_organization_id: string | null; reserved_poster_id: string | null;
  provider: string; status: string; finalization_state: string;
  provider_payment_id: string; provider_merchant_id: string | null;
  provider_environment: string | null; amount_cents: number;
  platform_fee_cents: number | null; currency: string;
  task_poster_id: string; task_business_id: string | null;
  draft_id: string | null;
  quote_total_cents: number | null; quote_payout_cents: number | null;
  legacy_refund_cents: number | null;
}

export interface RefundAttempt {
  id: string; quote_payment_id: string; task_id: string;
  provider_merchant_id: string; provider_environment: string;
  tilled_payment_intent_id: string; amount_cents: number; currency: string;
  tilled_reason: TilledRefundReason; internal_reason: string;
  refund_platform_fee: boolean; expected_platform_fee_refund_cents: number;
  ops_actor_user_id: string; local_attempt_key: string; status: string;
  actor_display_name?: string | null;
  tilled_refund_id: string | null; tilled_charge_id: string | null;
  failure_code: string | null; failure_message: string | null;
  requested_at: Date; updated_at: Date; terminal_at: Date | null;
}

function conflict(message: string): never {
  throw new TRPCError({ code: 'PRECONDITION_FAILED', message });
}

function validPayment(payment: BoundPayment | undefined): payment is BoundPayment {
  return Boolean(payment && payment.provider === 'tilled' && payment.status === 'SUCCEEDED'
    && payment.finalization_state === 'FINALIZED' && payment.task_id && payment.quote_version_id
    && payment.provider_merchant_id && /^acct_[A-Za-z0-9_]+$/.test(payment.provider_merchant_id)
    && /^pi_[A-Za-z0-9_]+$/.test(payment.provider_payment_id)
    && ['sandbox', 'production'].includes(payment.provider_environment ?? '')
    && payment.currency === 'usd' && Number.isSafeInteger(payment.amount_cents)
    && payment.amount_cents > 0 && Number.isSafeInteger(payment.platform_fee_cents)
    && Number(payment.platform_fee_cents) >= 0
    && payment.business_organization_id === payment.task_business_id
    && payment.reserved_poster_id === payment.task_poster_id
    && payment.quote_total_cents === payment.amount_cents
    && payment.quote_payout_cents !== null
    && payment.platform_fee_cents === payment.amount_cents - payment.quote_payout_cents
    && Number(payment.legacy_refund_cents ?? 0) === 0
    && payment.draft_id);
}

async function paymentForTask(query: QueryFn, taskId: string, lock: boolean): Promise<BoundPayment | undefined> {
  const result = await query<BoundPayment>(
    `SELECT payment.*, task.poster_id AS task_poster_id,
            task.business_fulfiller_organization_id AS task_business_id,
            quote.task_draft_id AS draft_id,
            version.total_cents AS quote_total_cents,
            version.hustler_payout_cents AS quote_payout_cents,
            escrow.refund_amount AS legacy_refund_cents
     FROM quote_payments payment
     JOIN tasks task ON task.id = payment.task_id
     JOIN quotes quote ON quote.id = payment.quote_id
     JOIN quote_versions version ON version.id = payment.quote_version_id AND version.quote_id = quote.id
     LEFT JOIN LATERAL (SELECT refund_amount FROM escrows WHERE task_id = task.id
       ORDER BY created_at DESC, id DESC LIMIT 1) escrow ON TRUE
     WHERE payment.task_id = $1 ${lock ? 'FOR UPDATE OF payment' : ''}`,
    [taskId],
  );
  return result.rows[0];
}

async function attemptsForPayment(query: QueryFn, paymentId: string): Promise<RefundAttempt[]> {
  const result = await query<RefundAttempt>(
    `SELECT refund.*, actor.full_name AS actor_display_name
     FROM quote_payment_refunds refund LEFT JOIN users actor ON actor.id = refund.ops_actor_user_id
     WHERE refund.quote_payment_id = $1 ORDER BY refund.requested_at DESC, refund.id DESC`,
    [paymentId],
  );
  return result.rows;
}

function totals(payment: BoundPayment, attempts: RefundAttempt[]) {
  const ledgerRefundedCents = attempts.filter((attempt) => attempt.status === 'SUCCEEDED')
    .reduce((sum, attempt) => sum + attempt.amount_cents, 0);
  const confirmedRefundedCents = Math.min(payment.amount_cents,
    ledgerRefundedCents + Number(payment.legacy_refund_cents ?? 0));
  const pendingCents = attempts.filter((attempt) => nonterminalStatuses.includes(attempt.status))
    .reduce((sum, attempt) => sum + attempt.amount_cents, 0);
  return {
    confirmedRefundedCents,
    pendingCents,
    remainingRefundableCents: Math.max(0, payment.amount_cents - confirmedRefundedCents - pendingCents),
    hasNonterminalAttempt: attempts.some((attempt) => nonterminalStatuses.includes(attempt.status)),
  };
}

export async function getQuoteRefundSummary(taskId: string) {
  const payment = await paymentForTask(db.query.bind(db), taskId, false);
  if (!payment) return null;
  const attempts = await attemptsForPayment(db.query.bind(db), payment.id);
  const sum = totals(payment, attempts);
  return {
    quotePaymentId: payment.id,
    originalChargedCents: payment.amount_cents,
    originalPlatformFeeCents: payment.platform_fee_cents ?? 0,
    providerMerchantId: payment.provider_merchant_id,
    paymentStatus: payment.status,
    paymentBindingValid: validPayment(payment),
    ...sum,
    attempts: attempts.slice(0, 100).map((attempt) => ({
      id: attempt.id, status: attempt.status, amountCents: attempt.amount_cents,
      expectedPlatformFeeRefundCents: attempt.expected_platform_fee_refund_cents,
      tilledReason: attempt.tilled_reason, internalReason: attempt.internal_reason,
      actorUserId: attempt.ops_actor_user_id, tilledRefundId: attempt.tilled_refund_id,
      actorDisplayName: attempt.actor_display_name ?? null,
      requestedAt: attempt.requested_at, terminalAt: attempt.terminal_at,
      failureCode: attempt.failure_code,
    })),
  };
}

function validateRefund(refund: TilledRefund, attempt: RefundAttempt): boolean {
  return refund.payment_intent_id === attempt.tilled_payment_intent_id
    && refund.amount === attempt.amount_cents
    && refund.metadata?.hustlexp_refund_attempt_id === attempt.id
    && refund.metadata?.hustlexp_payment_id === attempt.quote_payment_id;
}

function validateFrozenIntent(intent: TilledPaymentIntent, payment: BoundPayment): boolean {
  return intent.id === payment.provider_payment_id
    && intent.account_id === payment.provider_merchant_id
    && intent.amount === payment.amount_cents
    && intent.amount_received === payment.amount_cents
    && intent.currency === payment.currency
    && intent.status === 'succeeded'
    && intent.platform_fee_amount === payment.platform_fee_cents
    && intent.metadata?.hustlexp_payment_id === payment.id
    && intent.metadata?.quote_id === payment.quote_id
    && intent.metadata?.quote_version_id === payment.quote_version_id
    && intent.metadata?.organization_id === payment.business_organization_id
    && intent.metadata?.task_draft_id === payment.draft_id;
}

function localStatus(status: TilledRefund['status']): string {
  switch (status) {
    case 'succeeded': return 'SUCCEEDED';
    case 'failed': return 'FAILED';
    case 'canceled': return 'CANCELED';
    case 'requires_action': return 'REQUIRES_ACTION';
    default: return 'PENDING';
  }
}

function safeFailureMessage(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value.replace(/[\r\n\t]/g, ' ').trim().slice(0, 240);
  return /(?:authorization|client_secret|tilled-api-key|\bsk_[A-Za-z0-9]+|\b\d{13,19}\b)/i.test(cleaned)
    ? null : cleaned;
}

async function persistResult(attemptId: string, refund: TilledRefund | null,
  fallbackStatus: 'FAILED' | 'UNCERTAIN' | null, failureCode?: string): Promise<RefundAttempt> {
  return db.transaction(async (query) => {
    const identity = await query<{ quote_payment_id: string }>(
      'SELECT quote_payment_id FROM quote_payment_refunds WHERE id = $1', [attemptId]);
    if (!identity.rows[0]) conflict('Refund attempt not found.');
    await query('SELECT id FROM quote_payments WHERE id = $1 FOR UPDATE', [identity.rows[0].quote_payment_id]);
    const locked = await query<RefundAttempt>('SELECT * FROM quote_payment_refunds WHERE id = $1 FOR UPDATE', [attemptId]);
    const attempt = locked.rows[0];
    if (!nonterminalStatuses.includes(attempt.status)) return attempt;
    if (refund && !validateRefund(refund, attempt)) {
      fallbackStatus = 'UNCERTAIN';
      failureCode = 'REFUND_BINDING_MISMATCH';
      refund = null;
    }
    const status = refund ? localStatus(refund.status) : fallbackStatus ?? 'UNCERTAIN';
    const result = await query<RefundAttempt>(
      `UPDATE quote_payment_refunds SET status = $2, tilled_refund_id = COALESCE($3, tilled_refund_id),
         tilled_charge_id = COALESCE($4, tilled_charge_id), failure_code = $5,
         failure_message = $6, updated_at = NOW(),
         terminal_at = CASE WHEN $2 IN ('SUCCEEDED','FAILED','CANCELED') THEN NOW() ELSE NULL END
       WHERE id = $1 RETURNING *`,
      [attemptId, status, refund?.id ?? null, refund?.charge_id ?? null,
        failureCode ?? refund?.failure_code ?? null,
        safeFailureMessage(refund?.failure_message)],
    );
    if (['SUCCEEDED', 'FAILED', 'CANCELED'].includes(status)) {
      await recordOpsAudit({ actorUserId: attempt.ops_actor_user_id, action: 'QUOTE_PAYMENT_REFUND_TERMINAL',
        targetType: 'quote_payment_refund', targetId: attemptId,
        meta: { taskId: attempt.task_id, quotePaymentId: attempt.quote_payment_id,
          amountCents: attempt.amount_cents, status, tilledRefundId: refund?.id ?? attempt.tilled_refund_id,
          failureCode: failureCode ?? refund?.failure_code ?? null },
      }, query, true);
    }
    return result.rows[0];
  });
}

export async function requestQuoteRefund(input: {
  taskId: string; actorUserId: string; fullRemaining: boolean; amountCents?: number;
  tilledReason: TilledRefundReason; internalReason: string;
}): Promise<RefundAttempt> {
  const config = loadTilledConfig();
  const attempt = await db.transaction(async (query) => {
    const payment = await paymentForTask(query, input.taskId, true);
    if (!validPayment(payment) || payment.provider_environment !== config.environment) {
      conflict('A finalized Tilled payment with valid frozen binding is required.');
    }
    const attempts = await attemptsForPayment(query, payment.id);
    const sum = totals(payment, attempts);
    if (sum.hasNonterminalAttempt) conflict('Another refund attempt is still pending reconciliation.');
    const amount = input.fullRemaining ? sum.remainingRefundableCents : input.amountCents;
    if (!Number.isSafeInteger(amount) || !amount || amount <= 0 || amount > sum.remainingRefundableCents) {
      conflict('Refund amount exceeds the remaining refundable charge.');
    }
    const consumedFee = attempts.filter((item) => heldStatuses.includes(item.status))
      .reduce((total, item) => total + item.expected_platform_fee_refund_cents, 0);
    const fee = amount === sum.remainingRefundableCents
      ? Math.max(0, (payment.platform_fee_cents ?? 0) - consumedFee)
      : Math.min(Math.max(0, (payment.platform_fee_cents ?? 0) - consumedFee),
        Math.round((payment.platform_fee_cents ?? 0) * amount / payment.amount_cents));
    const id = randomUUID();
    const inserted = await query<RefundAttempt>(
      `INSERT INTO quote_payment_refunds
       (id, quote_payment_id, task_id, provider_merchant_id, provider_environment,
        tilled_payment_intent_id, amount_cents, currency, tilled_reason, internal_reason,
        refund_platform_fee, expected_platform_fee_refund_cents, ops_actor_user_id, local_attempt_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE,$11,$12,$13) RETURNING *`,
      [id, payment.id, payment.task_id, payment.provider_merchant_id, payment.provider_environment,
        payment.provider_payment_id, amount, payment.currency, input.tilledReason, input.internalReason,
        fee, input.actorUserId, id],
    );
    await recordOpsAudit({ actorUserId: input.actorUserId, action: 'QUOTE_PAYMENT_REFUND_REQUESTED',
      targetType: 'quote_payment_refund', targetId: id,
      meta: { taskId: input.taskId, quotePaymentId: payment.id, amountCents: amount,
        internalReason: input.internalReason, tilledReason: input.tilledReason,
        refundPlatformFee: true, expectedPlatformFeeRefundCents: fee,
        merchantAccountId: payment.provider_merchant_id, paymentIntentId: payment.provider_payment_id },
    }, query, true);
    return inserted.rows[0];
  });

  // The durable reservation and required audit have committed before any processor request.
  await db.query(`UPDATE quote_payment_refunds SET status = 'PROCESSING', updated_at = NOW()
    WHERE id = $1 AND status = 'RESERVED'`, [attempt.id]);
  const client = new TilledClient(config);
  try {
    const payment = await paymentForTask(db.query.bind(db), input.taskId, false);
    const intent = await client.getPaymentIntent(attempt.provider_merchant_id, attempt.tilled_payment_intent_id);
    if (!payment || !validateFrozenIntent(intent, payment)) {
      return persistResult(attempt.id, null, 'UNCERTAIN', 'PAYMENT_BINDING_MISMATCH');
    }
    const refund = await client.createRefund({ accountId: attempt.provider_merchant_id,
      paymentIntentId: attempt.tilled_payment_intent_id, amountCents: attempt.amount_cents,
      reason: attempt.tilled_reason,
      metadata: { hustlexp_refund_attempt_id: attempt.id, hustlexp_payment_id: attempt.quote_payment_id },
    });
    return persistResult(attempt.id, refund, null);
  } catch (error) {
    const definitive = error instanceof TilledApiError && error.details.kind === 'provider_rejected'
      && ![408, 409, 429].includes(error.httpStatus ?? 0);
    log.warn({ attemptId: attempt.id, errorCode: error instanceof TilledApiError ? error.code : 'UNKNOWN',
      definitive }, 'Tilled refund requires status reconciliation');
    return persistResult(attempt.id, null, definitive ? 'FAILED' : 'UNCERTAIN',
      error instanceof TilledApiError ? error.code : 'REFUND_OUTCOME_UNKNOWN');
  }
}

export async function reconcileQuoteRefunds(limit = 25): Promise<{ scanned: number; updated: number }> {
  const due = await db.query<RefundAttempt>(
    `SELECT * FROM quote_payment_refunds
     WHERE status IN ('RESERVED','PROCESSING','PENDING','UNCERTAIN','REQUIRES_ACTION')
       AND updated_at < NOW() - INTERVAL '2 minutes'
     ORDER BY updated_at, id LIMIT $1`, [Math.max(1, Math.min(limit, 100))]);
  let updated = 0;
  for (const attempt of due.rows) {
    try {
      const config = loadTilledConfig();
      if (attempt.provider_environment !== config.environment) continue;
      const client = new TilledClient(config);
      const matches = attempt.tilled_refund_id ? null
        : await client.findRefundsByAttempt(attempt.provider_merchant_id, attempt.id);
      if (matches && matches.length > 1) {
        await persistResult(attempt.id, null, 'UNCERTAIN', 'MULTIPLE_REFUND_MATCHES');
        continue;
      }
      const refund = attempt.tilled_refund_id
        ? await client.getRefund(attempt.provider_merchant_id, attempt.tilled_refund_id)
        : matches?.[0];
      if (!refund) {
        await db.query('UPDATE quote_payment_refunds SET updated_at = NOW() WHERE id = $1 AND status IN (\'RESERVED\',\'PROCESSING\',\'PENDING\',\'UNCERTAIN\',\'REQUIRES_ACTION\')', [attempt.id]);
        continue;
      }
      const payment = await paymentForTask(db.query.bind(db), attempt.task_id, false);
      const intent = await client.getPaymentIntent(attempt.provider_merchant_id, attempt.tilled_payment_intent_id);
      if (!payment || !validateFrozenIntent(intent, payment) || !validateRefund(refund, attempt)) {
        await persistResult(attempt.id, null, 'UNCERTAIN', 'REFUND_BINDING_MISMATCH');
        continue;
      }
      await persistResult(attempt.id, refund, null);
      updated += 1;
    } catch (error) {
      log.warn({ attemptId: attempt.id, errorCode: error instanceof TilledApiError ? error.code : 'UNKNOWN' },
        'Refund reconciliation deferred');
    }
  }
  return { scanned: due.rows.length, updated };
}
