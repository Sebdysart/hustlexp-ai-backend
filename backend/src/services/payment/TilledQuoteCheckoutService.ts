import { TRPCError } from '@trpc/server';
import { db } from '../../db.js';
import { logger } from '../../logger.js';
import { isBusinessQuoteProviderVerified } from '../BusinessQuoteActivationService.js';
import { buildManualTaskPolicyInput } from '../ManualTaskPolicy.js';
import { newPaymentCreationFailure, paymentCreationErrorCause } from '../NewPaymentCreationGuard.js';
import { lockQuoteAddressForPayment } from '../QuoteServiceAddressService.js';
import { finalizePaidQuote } from '../QuotePaymentFinalizationService.js';
import { evaluateTaskAgainstRegionPolicy, resolveRegionPolicy } from '../RegionPolicyService.js';
import { TilledApiError, type TilledPaymentIntent } from './TilledClient.js';
import { loadTilledConfig, TilledConfigurationError } from './TilledConfig.js';
import { resolveTilledMerchantAccount } from './TilledMerchantAccountService.js';
import { TilledQuotePaymentProvider, tilledClient, validateTilledIntentBinding } from './TilledQuotePaymentProvider.js';

interface CheckoutQuote {
  quote_id: string;
  task_draft_id: string;
  quote_status: string;
  quote_environment: string | null;
  quote_is_test: boolean;
  selected_quote_id: string | null;
  business_organization_id: string | null;
  total_cents: number;
  hustler_payout_cents: number;
  expires_at: Date;
  arrival_window_start: Date | null;
  arrival_window_end: Date | null;
  scheduled_service_date: string | null;
  arrival_start_date: string | null;
  arrival_end_date: string | null;
  dispatch_expires_at: Date | null;
  category: string;
  region_code: string | null;
  region_policy_id: string | null;
  region_policy_version: string | null;
  region_policy_hash: string | null;
  region_policy_snapshot: Record<string, unknown> | null;
  validated_risk_level: 'LOW' | 'MEDIUM' | 'HIGH' | 'IN_HOME' | null;
}

interface CheckoutPayment {
  id: string;
  quote_id: string;
  quote_version_id: string;
  task_id: string | null;
  provider: string;
  provider_payment_id: string;
  provider_merchant_id: string | null;
  business_organization_id: string | null;
  amount_cents: number;
  platform_fee_cents: number | null;
  provider_environment: string | null;
  provider_status: string | null;
  intent_creation_state: string | null;
  status: string;
}

export interface TilledCheckoutResult {
  finalized: false;
  provider: 'tilled';
  environment: 'sandbox' | 'production';
  localPaymentId: string;
  providerPaymentIntentId: string;
  clientSecret: string;
  merchantAccountId: string;
  publishableKey: string;
  status: string;
  amountCents: number;
}

export interface TilledFinalizedCheckoutResult {
  finalized: true;
  taskId: string;
  replayed: true;
}

function blocked(message: string, cause?: { applicationCode: 'PAYMENT_CREATION_FROZEN' }): never {
  throw new TRPCError({ code: 'PRECONDITION_FAILED', message, ...(cause ? { cause } : {}) });
}

function sanitizedDiagnostic(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let result = value.slice(0, 4_000);
  for (const secret of [process.env.TILLED_SECRET_KEY, process.env.TILLED_WEBHOOK_SECRET]) {
    if (secret) result = result.replaceAll(secret, '[REDACTED]');
  }
  return result.replace(/(?:client_secret|tilled-api-key|authorization)\s*[:=]\s*[^\s,;]+/gi,
    '[REDACTED]');
}

async function readCheckoutQuote(quoteId: string, quoteVersionId: string, posterId: string): Promise<CheckoutQuote> {
  const result = await db.query<CheckoutQuote>(`
    SELECT q.id AS quote_id, q.task_draft_id, q.status AS quote_status,
      q.environment AS quote_environment, q.is_test AS quote_is_test,
      d.quote_id AS selected_quote_id, q.business_organization_id,
      qv.total_cents, qv.hustler_payout_cents, qv.expires_at,
      qv.arrival_window_start, qv.arrival_window_end, qv.dispatch_expires_at,
      d.scheduled_service_date::text AS scheduled_service_date,
      (qv.arrival_window_start AT TIME ZONE 'America/Los_Angeles')::date::text AS arrival_start_date,
      (qv.arrival_window_end AT TIME ZONE 'America/Los_Angeles')::date::text AS arrival_end_date,
      d.category, d.region_code, d.region_policy_id, d.region_policy_version,
      d.region_policy_hash, d.region_policy_snapshot, d.validated_risk_level
    FROM quotes q
    JOIN quote_versions qv ON qv.id = q.active_version_id AND qv.quote_id = q.id
    JOIN task_drafts d ON d.id = q.task_draft_id
    WHERE q.id = $1 AND qv.id = $2 AND d.poster_user_id = $3
    LIMIT 1`, [quoteId, quoteVersionId, posterId]);
  const quote = result.rows[0];
  if (!quote) throw new TRPCError({ code: 'NOT_FOUND', message: 'Quote not found.' });
  return quote;
}

async function validatePayableQuote(quote: CheckoutQuote): Promise<{ amountCents: number; platformFeeCents: number; organizationId: string }> {
  if (quote.selected_quote_id !== quote.quote_id) blocked('This quote has not been accepted.');
  if (!['quote_ready', 'quote_send_ready'].includes(quote.quote_status)) blocked('This quote is not available for payment.');
  if (quote.expires_at <= new Date()) blocked('This quote has expired.');
  if (!quote.business_organization_id) blocked('This quote has no business provider.');
  if (!await isBusinessQuoteProviderVerified(db.query.bind(db), quote.business_organization_id)) {
    blocked('This business is not currently eligible to accept payment.');
  }
  const amountCents = Number(quote.total_cents);
  const payoutCents = Number(quote.hustler_payout_cents);
  const platformFeeCents = amountCents - payoutCents;
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || !Number.isSafeInteger(payoutCents)
    || payoutCents <= 0 || !Number.isSafeInteger(platformFeeCents) || platformFeeCents < 0) {
    blocked('This quote has invalid payment economics.');
  }
  // Assessment credits have a separate merchant/fee history. First Tilled rail
  // does not guess how to reallocate that already-paid amount.
  const credit = await db.query<{ amount_cents: number }>(`
    SELECT payment.amount_cents FROM business_assessment_requests assessment
    JOIN assessment_payments payment ON payment.assessment_request_id = assessment.id
    LEFT JOIN ops_business_claim_links claim ON claim.id = assessment.claim_link_id
    WHERE (assessment.quote_id = $1 OR (assessment.quote_id IS NULL AND claim.quote_id = $1))
      AND assessment.business_organization_id = $2
      AND assessment.quote_is_net_of_credit = FALSE
      AND assessment.status = 'COMPLETED' AND payment.status = 'SUCCEEDED'
    LIMIT 1`, [quote.quote_id, quote.business_organization_id]);
  if (Number(credit.rows[0]?.amount_cents ?? 0) !== 0) blocked('This quote requires assisted payment because an assessment credit is attached.');
  if (!quote.region_code || !quote.region_policy_id || !quote.region_policy_version || !quote.region_policy_hash
    || !quote.region_policy_snapshot || !quote.validated_risk_level) {
    blocked('This task is missing authoritative service policy validation.');
  }
  const policy = await resolveRegionPolicy(quote.region_code);
  if (!policy || !evaluateTaskAgainstRegionPolicy(policy, buildManualTaskPolicyInput({
    regionCode: quote.region_code,
    category: quote.category,
    riskLevel: quote.validated_risk_level,
    customerTotalCents: amountCents,
    payoutCents,
    platformMarginCents: platformFeeCents,
  }), { evaluateEconomics: true, evaluateProductionGates: false }).allowed) {
    blocked('This quote cannot currently be paid under HustleXP service policy.');
  }
  const start = quote.arrival_window_start?.getTime();
  const end = quote.arrival_window_end?.getTime();
  const dispatchExpiry = quote.dispatch_expires_at?.getTime();
  if (!quote.scheduled_service_date || start === undefined || end === undefined || !Number.isFinite(start)
    || !Number.isFinite(end) || end <= start || !quote.arrival_start_date || !quote.arrival_end_date
    || quote.scheduled_service_date < quote.arrival_start_date || quote.scheduled_service_date > quote.arrival_end_date
    || dispatchExpiry === undefined || !Number.isFinite(dispatchExpiry) || dispatchExpiry > start) {
    blocked('Choose a valid service date before paying.');
  }
  return { amountCents, platformFeeCents, organizationId: quote.business_organization_id };
}

async function readPayment(quoteId: string, quoteVersionId: string): Promise<CheckoutPayment | null> {
  const result = await db.query<CheckoutPayment>(`
    SELECT id, quote_id, quote_version_id, task_id, provider, provider_payment_id,
      provider_merchant_id, business_organization_id, amount_cents, platform_fee_cents,
      provider_environment, provider_status, intent_creation_state, status
    FROM quote_payments WHERE quote_id = $1 AND quote_version_id = $2 LIMIT 1`,
    [quoteId, quoteVersionId]);
  return result.rows[0] ?? null;
}

function assertPaymentBinding(payment: CheckoutPayment, organizationId: string, accountId: string,
  environment: string, amountCents: number, platformFeeCents: number): void {
  if (payment.provider !== 'tilled' || payment.business_organization_id !== organizationId
    || payment.provider_merchant_id !== accountId || payment.provider_environment !== environment
    || Number(payment.amount_cents) !== amountCents || Number(payment.platform_fee_cents) !== platformFeeCents
    || !['PENDING', 'SUCCEEDED'].includes(payment.status)) {
    blocked('This quote is already bound to a different payment.');
  }
}

async function bindIntent(payment: CheckoutPayment, intent: TilledPaymentIntent): Promise<void> {
  const result = await db.query(`UPDATE quote_payments SET provider_payment_id = $2,
      provider_status = $3, intent_creation_state = 'BOUND', updated_at = NOW()
    WHERE id = $1 AND provider = 'tilled' AND status = 'PENDING'
      AND intent_creation_state IN ('CREATING', 'RECONCILE_REQUIRED')
    RETURNING id`, [payment.id, intent.id, intent.status]);
  if (!result.rows[0]) blocked('Payment intent could not be bound. Contact support before retrying.');
}

export async function createOrResumeTilledCheckout(input: {
  quoteId: string; quoteVersionId: string; posterId: string;
}): Promise<TilledCheckoutResult | TilledFinalizedCheckoutResult> {
  let stage = 'load_quote';
  const diagnostic: Record<string, string | undefined> = {
    operation: 'tilled_create_checkout', provider: 'tilled',
    quote_id: input.quoteId, quote_version_id: input.quoteVersionId,
  };
  const mark = (nextStage: string): void => {
    stage = nextStage;
    logger.info({ ...diagnostic, stage }, 'Tilled checkout stage');
  };
  try {
  mark('load_quote');
  const quote = await readCheckoutQuote(input.quoteId, input.quoteVersionId, input.posterId);
  diagnostic.organization_id = quote.business_organization_id ?? undefined;
  mark('load_local_payment');
  const existing = await readPayment(input.quoteId, input.quoteVersionId);
  diagnostic.local_payment_id = existing?.id;
  if (quote.quote_status === 'paid') {
    if (!existing || existing.provider !== 'tilled' || existing.status !== 'SUCCEEDED'
      || !existing.task_id || existing.intent_creation_state !== 'BOUND') {
      blocked('This quote has already been paid. Open the task from your dashboard.');
    }
    // The canonical finalizer validates ownership and downstream replay state.
    // Its completed replay never calls Tilled or creates another payment.
    mark('replay_finalized_payment');
    const completed = await finalizeTilledCheckout(input);
    return { finalized: true, taskId: completed.taskId, replayed: true };
  }
  mark('load_tilled_config');
  const config = loadTilledConfig();
  diagnostic.environment = config.environment;
  if (config.environment === 'sandbox'
    ? quote.quote_environment !== 'TEST' || quote.quote_is_test !== true
    : quote.quote_environment === 'TEST' || quote.quote_is_test === true) {
    blocked('This quote and payment environment do not match.');
  }
  mark('validate_quote');
  const economics = await validatePayableQuote(quote);
  mark('resolve_merchant_account');
  const merchant = await resolveTilledMerchantAccount(economics.organizationId, config.environment, false);
  if (!merchant) blocked('Business payment account is not configured for this environment.');
  diagnostic.provider_account_id = merchant.accountId;
  if ((!existing || existing.intent_creation_state === 'RESERVED')
    && (merchant.status !== 'ACTIVE' || !merchant.chargesEnabled)) {
    blocked('Business payment account is not active for charges.');
  }
  mark('lock_service_address');
  await lockQuoteAddressForPayment(input.quoteId, input.quoteVersionId, input.posterId);
  let payment = existing;
  if (!payment) {
    mark('validate_payment_creation');
    const frozen = newPaymentCreationFailure('escrow_funding');
    if (frozen) blocked(frozen.error.message, paymentCreationErrorCause(frozen.error.code));
    mark('reserve_local_payment');
    await db.query(`INSERT INTO quote_payments (
        quote_id, quote_version_id, provider, provider_payment_id, amount_cents,
        platform_fee_cents, business_organization_id, provider_merchant_id,
        provider_environment, intent_creation_state, status)
      VALUES ($1, $2, 'tilled', 'tilled_reservation:' || $1::text || ':' || $2::text,
        $3, $4, $5, $6, $7, 'RESERVED', 'PENDING')
      ON CONFLICT (quote_id, quote_version_id) DO NOTHING`,
      [input.quoteId, input.quoteVersionId, economics.amountCents, economics.platformFeeCents,
        economics.organizationId, merchant.accountId, config.environment]);
    payment = await readPayment(input.quoteId, input.quoteVersionId);
  }
  if (!payment) blocked('Payment reservation could not be created.');
  diagnostic.local_payment_id = payment.id;
  mark('validate_payment_binding');
  assertPaymentBinding(payment, economics.organizationId, merchant.accountId, config.environment,
    economics.amountCents, economics.platformFeeCents);

  mark('build_payment_intent_request');
  const binding = {
    paymentIntentId: payment.provider_payment_id,
    localPaymentId: payment.id,
    taskDraftId: quote.task_draft_id,
    organizationId: economics.organizationId,
    merchantAccountId: merchant.accountId,
    platformFeeCents: economics.platformFeeCents,
    amountCents: economics.amountCents,
    quoteId: input.quoteId,
    quoteVersionId: input.quoteVersionId,
    posterId: input.posterId,
  };
  const client = tilledClient();
  let intent: TilledPaymentIntent;
  if (payment.intent_creation_state === 'BOUND') {
    mark('retrieve_bound_provider_intent');
    intent = await client.getPaymentIntent(merchant.accountId, payment.provider_payment_id);
  } else if (payment.intent_creation_state === 'RESERVED') {
    mark('validate_payment_creation');
    const frozen = newPaymentCreationFailure('escrow_funding');
    if (frozen) blocked(frozen.error.message, paymentCreationErrorCause(frozen.error.code));
    mark('claim_intent_creation');
    const claimed = await db.query(`UPDATE quote_payments SET intent_creation_state = 'CREATING', updated_at = NOW()
      WHERE id = $1 AND intent_creation_state = 'RESERVED' RETURNING id`, [payment.id]);
    if (!claimed.rows[0]) blocked('Payment creation is already in progress. Please retry shortly.');
    mark('send_tilled_request');
    let created: Awaited<ReturnType<typeof TilledQuotePaymentProvider.createPaymentIntent>>;
    try {
      created = await TilledQuotePaymentProvider.createPaymentIntent(binding);
    } catch (error) {
      // The provider may have accepted the request before a timeout or parse error.
      // Keep this local payment recoverable; never issue a second intent blindly.
      await db.query(`UPDATE quote_payments SET intent_creation_state = 'RECONCILE_REQUIRED', updated_at = NOW()
        WHERE id = $1 AND intent_creation_state = 'CREATING'`, [payment.id]);
      logger.info({ ...diagnostic, stage: 'mark_reconcile_required' },
        'Tilled checkout reserved for reconciliation');
      throw error;
    }
    if (!created.success) {
      await db.query(`UPDATE quote_payments SET intent_creation_state = 'RECONCILE_REQUIRED', updated_at = NOW()
        WHERE id = $1 AND intent_creation_state = 'CREATING'`, [payment.id]);
      blocked(created.error.message);
    }
    mark('retrieve_created_provider_intent');
    intent = await client.getPaymentIntent(merchant.accountId, created.data.paymentIntentId);
    mark('persist_provider_intent');
    await bindIntent(payment, intent);
  } else if (payment.intent_creation_state === 'CREATING' || payment.intent_creation_state === 'RECONCILE_REQUIRED') {
    mark('reconcile_uncertain_provider_intent');
    let found: TilledPaymentIntent[];
    try {
      found = await client.findPaymentIntentsByLocalPaymentId(merchant.accountId, payment.id);
    } catch (error) {
      if (error instanceof TilledApiError) blocked('Payment reconciliation is temporarily unavailable. Please retry later.');
      throw error;
    }
    if (found.length !== 1) blocked('Payment creation requires reconciliation. Contact support before trying again.');
    intent = found[0];
    const recovered = validateTilledIntentBinding(intent, { ...binding, paymentIntentId: intent.id }, false);
    if (!recovered.success) blocked(recovered.error.message);
    mark('persist_provider_intent');
    await bindIntent(payment, intent);
  } else {
    blocked('Payment attempt is not recoverable automatically. Contact support.');
  }

  mark('validate_provider_intent');
  const verified = validateTilledIntentBinding(intent, { ...binding, paymentIntentId: intent.id }, false);
  if (!verified.success || !intent.client_secret) blocked('Payment details could not be verified. Contact support.');
  mark('serialize_checkout_response');
  return {
    finalized: false, provider: 'tilled', environment: config.environment, localPaymentId: payment.id,
    providerPaymentIntentId: intent.id, clientSecret: intent.client_secret,
    merchantAccountId: merchant.accountId, publishableKey: config.publishableKey,
    status: intent.status, amountCents: economics.amountCents,
  };
  } catch (error) {
    const apiError = error instanceof TilledApiError ? error : null;
    const internal = !(error instanceof TRPCError)
      && !(error instanceof TilledConfigurationError) && !apiError;
    const databaseCode = error && typeof error === 'object' && 'code' in error
      && typeof error.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code)
      ? error.code : undefined;
    logger[internal ? 'error' : 'warn']({
      ...diagnostic, stage,
      database_error_code: databaseCode,
      http_status: apiError?.httpStatus,
      provider_error_code: apiError?.code,
      provider_error_type: apiError?.details.providerErrorType,
      provider_error_message: apiError?.details.providerMessage,
      provider_error_kind: apiError?.details.kind,
      correlation_id: apiError?.details.correlationId,
      error_name: error instanceof Error ? error.name : 'unknown',
      error_message: sanitizedDiagnostic(error instanceof Error ? error.message : String(error)),
      ...(internal && error instanceof Error
        ? { error_stack: sanitizedDiagnostic(error.stack) } : {}),
    }, 'Tilled checkout failed');
    throw error;
  }
}

export async function finalizeTilledCheckout(input: { quoteId: string; quoteVersionId: string; posterId: string }) {
  const payment = await readPayment(input.quoteId, input.quoteVersionId);
  if (!payment || payment.provider !== 'tilled' || payment.intent_creation_state !== 'BOUND') {
    blocked('No Tilled payment is bound to this quote.');
  }
  const result = await finalizePaidQuote({
    quoteId: input.quoteId, quoteVersionId: input.quoteVersionId,
    posterId: input.posterId, paymentIntentId: payment.provider_payment_id,
    paymentMode: 'tilled',
  });
  if (!result.success) blocked(result.error.message);
  return result.data;
}
