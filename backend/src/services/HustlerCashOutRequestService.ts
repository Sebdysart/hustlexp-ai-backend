import { createHash } from 'node:crypto';
import { db, type QueryFn } from '../db.js';
import type { ServiceResult } from '../types.js';
import { buildCashOutReviewContext, type CashOutReviewContext } from './HustlerCashOutReviewService.js';
import {
  CASH_OUT_ROW_COLUMNS,
  cashOutRecord,
  type CashOutRow,
} from './HustlerWalletData.js';
import { HUSTLER_WALLET_POLICY_VERSION } from './HustlerWalletPolicy.js';
import type {
  CashOutRecord,
  CashOutReview,
  ProviderPayoutEventInput,
  WalletProvider,
} from './HustlerWalletTypes.js';

function requestHash(workerId: string, amountCents: number): string {
  return createHash('sha256')
    .update(`${workerId}|${amountCents}|usd|standard|${HUSTLER_WALLET_POLICY_VERSION}`)
    .digest('hex');
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { code?: string }).code === '23505';
}

async function findIdempotentRequest(
  workerId: string,
  idempotencyKey: string,
): Promise<CashOutRow | null> {
  const result = await db.query<CashOutRow>(
    `SELECT ${CASH_OUT_ROW_COLUMNS}
     FROM worker_cash_out_requests
     WHERE worker_id=$1 AND idempotency_key=$2`,
    [workerId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

async function createInitiatingRequest(input: {
  workerId: string;
  accountId: string;
  destinationId: string;
  destination: NonNullable<CashOutReview['destination']>;
  amountCents: number;
  idempotencyKey: string;
  hash: string;
}): Promise<CashOutRow> {
  const result = await db.query<CashOutRow>(
    `INSERT INTO worker_cash_out_requests (
       worker_id,provider_account_id,provider_destination_id,idempotency_key,request_hash,
       amount_cents,fee_cents,net_cents,currency,method,destination_type,
       destination_last4,destination_label,state,last_transition_source,policy_version
     ) VALUES ($1,$2,$3,$4,$5,$6,0,$6,'usd','STANDARD',$7,$8,$9,'INITIATING','USER_REQUEST',$10)
     RETURNING ${CASH_OUT_ROW_COLUMNS}`,
    [
      input.workerId,
      input.accountId,
      input.destinationId,
      input.idempotencyKey,
      input.hash,
      input.amountCents,
      input.destination.type === 'debit_card' ? 'DEBIT_CARD' : 'BANK_ACCOUNT',
      input.destination.last4,
      input.destination.label,
      HUSTLER_WALLET_POLICY_VERSION,
    ],
  );
  return result.rows[0];
}

function providerFailure(error: unknown): { code: string; message: string } {
  const code = typeof error === 'object'
      && error !== null
      && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'PROVIDER_REQUEST_FAILED';
  return {
    code: code.slice(0, 100),
    message: 'Stripe could not submit this bank payout. No paid state was recorded; verify the destination and try a new cash-out.',
  };
}

async function markProviderFailure(row: CashOutRow, error: unknown): Promise<CashOutRow> {
  const failure = providerFailure(error);
  const result = await db.query<CashOutRow>(
    `UPDATE worker_cash_out_requests
     SET state='FAILED',failure_code=$2,failure_message=$3,
         last_transition_source='PROVIDER_API'
     WHERE id=$1 AND state='INITIATING'
     RETURNING ${CASH_OUT_ROW_COLUMNS}`,
    [row.id, failure.code, failure.message],
  );
  return result.rows[0] ?? row;
}

async function applyProviderResult(
  row: CashOutRow,
  providerResult: Awaited<ReturnType<WalletProvider['createStandardPayout']>>,
): Promise<CashOutRow> {
  const state = providerResult.state.toUpperCase();
  const failureCode = providerResult.state === 'failed'
    ? providerResult.failureCode || 'PROVIDER_REJECTED'
    : null;
  const failureMessage = providerResult.state === 'failed'
    ? providerResult.failureMessage || 'Stripe rejected this bank payout.'
    : null;
  const updated = await db.query<CashOutRow>(
    `UPDATE worker_cash_out_requests
     SET provider_payout_id=$2,state=$3,estimated_arrival_at=$4,
         paid_at=CASE WHEN $3='PAID' THEN NOW() ELSE NULL END,
         failure_code=$5,failure_message=$6,last_transition_source='PROVIDER_API'
     WHERE id=$1 AND state='INITIATING'
     RETURNING ${CASH_OUT_ROW_COLUMNS}`,
    [
      row.id,
      providerResult.providerPayoutId,
      state,
      providerResult.estimatedArrivalAt,
      failureCode,
      failureMessage,
    ],
  );
  return updated.rows[0] ?? row;
}

async function resolveRequest(input: {
  workerId: string;
  amountCents: number;
  idempotencyKey: string;
  context: CashOutReviewContext;
}): Promise<ServiceResult<CashOutRow>> {
  const hash = requestHash(input.workerId, input.amountCents);
  const existing = await findIdempotentRequest(input.workerId, input.idempotencyKey);
  if (existing) {
    if (existing.request_hash !== hash) return {
      success: false,
      error: {
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'That idempotency key was already used for different cash-out terms.',
      },
    };
    return { success: true, data: existing };
  }
  const { context } = input;
  if (!context.review.eligible
      || !context.accountId
      || !context.providerDestinationId
      || !context.review.destination) {
    return {
      success: false,
      error: { code: context.review.eligibilityCode, message: context.review.reason },
    };
  }
  try {
    return {
      success: true,
      data: await createInitiatingRequest({
        workerId: input.workerId,
        accountId: context.accountId,
        destinationId: context.providerDestinationId,
        destination: context.review.destination,
        amountCents: input.amountCents,
        idempotencyKey: input.idempotencyKey,
        hash,
      }),
    };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const replay = await findIdempotentRequest(input.workerId, input.idempotencyKey);
    if (replay?.request_hash === hash) return { success: true, data: replay };
    return {
      success: false,
      error: { code: 'ACTIVE_CASH_OUT', message: 'Another bank payout is already underway.' },
    };
  }
}

async function submitProviderPayout(input: {
  row: CashOutRow;
  workerId: string;
  provider: WalletProvider;
}): Promise<CashOutRecord> {
  try {
    const providerResult = await input.provider.createStandardPayout({
      accountId: input.row.provider_account_id,
      amountCents: input.row.amount_cents,
      destinationId: input.row.provider_destination_id,
      idempotencyKey: `wallet:${input.workerId}:${input.row.idempotency_key}`,
      requestId: input.row.id,
      workerId: input.workerId,
    });
    return cashOutRecord(await applyProviderResult(input.row, providerResult));
  } catch (error) {
    return cashOutRecord(await markProviderFailure(input.row, error));
  }
}

export async function requestHustlerCashOut(
  input: { workerId: string; amountCents: number; idempotencyKey: string },
  provider: WalletProvider,
): Promise<ServiceResult<CashOutRecord>> {
  try {
    const context = await buildCashOutReviewContext(
      input.workerId,
      input.amountCents,
      provider,
    );
    const resolved = await resolveRequest({ ...input, context });
    if (!resolved.success) return resolved;
    if (resolved.data.state !== 'INITIATING') {
      return { success: true, data: cashOutRecord(resolved.data) };
    }
    return {
      success: true,
      data: await submitProviderPayout({
        row: resolved.data,
        workerId: input.workerId,
        provider,
      }),
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'CASH_OUT_REQUEST_FAILED',
        message: error instanceof Error
          ? error.message
          : 'The cash-out request could not be recorded safely.',
      },
    };
  }
}

const LEGAL_PROVIDER_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  INITIATING: new Set(['SUBMITTED', 'PROVIDER_PROCESSING', 'PAID', 'FAILED']),
  SUBMITTED: new Set(['PROVIDER_PROCESSING', 'PAID', 'FAILED']),
  PROVIDER_PROCESSING: new Set(['PAID', 'FAILED']),
  PAID: new Set(['REVERSED']),
  FAILED: new Set(),
  REVERSED: new Set(),
};

interface ProviderSyncRow {
  id: string;
  worker_id: string | null;
  provider_account_id: string | null;
  provider_payout_id: string | null;
  state: string;
  amount_cents: number;
  fee_cents: number;
  net_cents: number;
  currency: string;
}

interface ProviderEventReceiptRow {
  cash_out_request_id: string;
  provider_payout_id: string | null;
  amount_cents: number;
  provider_reported_state: string | null;
}

function requiredProviderIdentity(input: ProviderPayoutEventInput): {
  requestId: string;
  accountId: string;
  providerPayoutId: string;
  stripeEventId: string;
} {
  const requestId = input.requestId?.trim();
  const accountId = input.accountId?.trim();
  const providerPayoutId = input.providerPayoutId.trim();
  const stripeEventId = input.stripeEventId.trim();
  if (!requestId) throw new Error('PAYOUT_EVENT_REQUEST_ID_REQUIRED');
  if (!accountId) throw new Error('PAYOUT_EVENT_ACCOUNT_ID_REQUIRED');
  if (!providerPayoutId) throw new Error('PAYOUT_EVENT_PAYOUT_ID_REQUIRED');
  if (!stripeEventId) throw new Error('PAYOUT_EVENT_ID_REQUIRED');
  return { requestId, accountId, providerPayoutId, stripeEventId };
}

function projectedProviderState(currentState: string, reportedState: string): string {
  // Stripe can report payout.failed after payout.paid. The provider did not
  // un-pay history; HustleXP truthfully projects that late failure as REVERSED.
  if (currentState === 'PAID' && reportedState === 'FAILED') return 'REVERSED';
  return reportedState;
}

function providerPublicReason(
  projectedState: string,
  failureMessage: string | null,
): string | null {
  if (projectedState === 'REVERSED') {
    return 'Stripe reported a late failure after previously marking this payout paid. Verify the returned connected balance before trying again.';
  }
  if (projectedState !== 'FAILED') return null;
  return (failureMessage?.trim() || 'The bank payout failed.').slice(0, 500);
}

function validateProviderReceipt(
  receipt: ProviderEventReceiptRow,
  row: ProviderSyncRow,
  input: ProviderPayoutEventInput,
): void {
  if (receipt.cash_out_request_id !== row.id
      || receipt.provider_payout_id !== input.providerPayoutId
      || Number(receipt.amount_cents) !== input.amountCents
      || receipt.provider_reported_state !== input.state.toUpperCase()) {
    throw new Error('PAYOUT_EVENT_REPLAY_CONFLICT');
  }
}

async function syncProviderPayoutTransaction(
  query: QueryFn,
  input: ProviderPayoutEventInput,
): Promise<{ matched: boolean; workerId: string | null }> {
  const identity = requiredProviderIdentity(input);
  const target = await query<ProviderSyncRow>(
    `SELECT id::text,worker_id,provider_account_id,provider_payout_id,state,
            amount_cents,fee_cents,net_cents,currency
     FROM worker_cash_out_requests
     WHERE id::text=$1
     FOR UPDATE`,
    [identity.requestId],
  );
  const row = target.rows[0];
  if (!row) return { matched: false, workerId: null };
  if (row.currency !== 'usd'
      || !Number.isInteger(input.amountCents)
      || input.amountCents !== Number(row.amount_cents)) {
    throw new Error('PAYOUT_EVENT_AMOUNT_MISMATCH');
  }
  if (row.provider_account_id !== null && row.provider_account_id !== identity.accountId) {
    throw new Error('PAYOUT_EVENT_ACCOUNT_MISMATCH');
  }
  if (row.provider_payout_id !== null && row.provider_payout_id !== identity.providerPayoutId) {
    throw new Error('PAYOUT_EVENT_PAYOUT_ID_MISMATCH');
  }

  const existing = await query<ProviderEventReceiptRow>(
    `SELECT cash_out_request_id::text,provider_payout_id,amount_cents,provider_reported_state
     FROM worker_cash_out_events
     WHERE provider_event_id=$1`,
    [identity.stripeEventId],
  );
  if (existing.rows[0]) {
    validateProviderReceipt(existing.rows[0], row, input);
    return { matched: true, workerId: row.worker_id };
  }

  const reportedState = input.state.toUpperCase();
  const projectedState = projectedProviderState(row.state, reportedState);
  const disposition = row.state === projectedState
    ? 'NO_STATE_CHANGE'
    : LEGAL_PROVIDER_TRANSITIONS[row.state]?.has(projectedState)
      ? 'APPLIED'
      : 'IGNORED_STALE';
  const eventState = disposition === 'APPLIED' ? projectedState : row.state;
  const failureCode = projectedState === 'FAILED' || projectedState === 'REVERSED'
    ? (input.failureCode?.trim() || 'PROVIDER_REJECTED').slice(0, 100)
    : null;
  const failureMessage = providerPublicReason(projectedState, input.failureMessage);

  await query(
    `INSERT INTO worker_cash_out_events (
       cash_out_request_id,worker_id,event_type,source,provider_event_id,
       provider_payout_id,amount_cents,fee_cents,net_cents,currency,public_reason,
       provider_reported_state,disposition
     ) VALUES ($1,$2,$3,'PROVIDER_WEBHOOK',$4,$5,$6,$7,$8,'usd',$9,$10,$11)`,
    [
      row.id,
      row.worker_id,
      eventState,
      identity.stripeEventId,
      identity.providerPayoutId,
      row.amount_cents,
      row.fee_cents,
      row.net_cents,
      failureMessage,
      reportedState,
      disposition,
    ],
  );

  if (disposition !== 'APPLIED') {
    await query(
      `UPDATE worker_cash_out_requests
       SET provider_payout_id=COALESCE(provider_payout_id,$2),
           last_transition_source='PROVIDER_WEBHOOK',last_provider_event_id=$3
       WHERE id=$1`,
      [row.id, identity.providerPayoutId, identity.stripeEventId],
    );
    return { matched: true, workerId: row.worker_id };
  }

  await query(
    `UPDATE worker_cash_out_requests
     SET provider_payout_id=COALESCE(provider_payout_id,$2),state=$3,
         estimated_arrival_at=COALESCE($4,estimated_arrival_at),
         paid_at=CASE WHEN $3='PAID' THEN NOW() ELSE paid_at END,
         failure_code=$5,failure_message=$6,
         last_transition_source='PROVIDER_WEBHOOK',last_provider_event_id=$7
     WHERE id=$1 AND state=$8`,
    [
      row.id,
      identity.providerPayoutId,
      projectedState,
      input.estimatedArrivalAt,
      failureCode,
      failureMessage,
      identity.stripeEventId,
      row.state,
    ],
  );
  return { matched: true, workerId: row.worker_id };
}

export async function syncHustlerProviderPayoutEvent(
  input: ProviderPayoutEventInput,
): Promise<{ matched: boolean; workerId: string | null }> {
  return db.transaction((query) => syncProviderPayoutTransaction(query, input));
}
