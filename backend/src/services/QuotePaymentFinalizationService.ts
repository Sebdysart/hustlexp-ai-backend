import { db } from '../db.js';
import type { ServiceResult } from '../types.js';
import { EscrowService } from './EscrowService.js';
import { TaskCreateService } from './TaskCreateService.js';
import {
  mapQuoteToCreateTaskParams,
  type MapQuoteToTaskParamsInput,
} from './QuoteTaskParamsMapper.js';
import { StaxQuotePaymentProvider } from './payment/StaxQuotePaymentProvider.js';

interface FinalizePaidQuoteInput {
  quoteId: string;
  quoteVersionId: string;
  posterId: string;
  paymentIntentId: string;
}

interface FinalizePaidQuoteResult {
  taskId: string;
  escrowId: string;
  quoteId: string;
  quoteVersionId: string;
  paymentIntentId: string;
  replayed: boolean;
}

interface QuoteRow {
  id: string;
  task_draft_id: string;
  active_version_id: string | null;
  status: string;
  environment: string | null;
  is_test: boolean;

  business_organization_id: string | null;
  business_location_id: string | null;
  provider_service_profile_id: string | null;
  claimed_by_user_id: string | null;
  business_fulfiller_organization_id: string | null;
}

interface QuoteVersionRow {
  id: string;
  quote_id: string;
  status: string;
  total_cents: number;
  hustler_payout_cents: number;
  arrival_window_start: Date;
  arrival_window_end: Date;
  expires_at: Date;
  dispatch_expires_at: Date;
}

interface DraftRow {
  id: string;
  lead_id: string | null;
  category: string;
  title: string | null;
  scope_summary: string | null;
  structured:
    Record<string, unknown> | null;
  zip: string | null;
  region: string | null;
  validated_risk_level:
    | 'LOW'
    | 'MEDIUM'
    | 'HIGH'
    | 'IN_HOME'
    | null;
  compliance_result: Record<string, unknown> | null;
  region_code: string | null;
  region_policy_id: string | null;
  region_policy_version: string | null;
  region_policy_hash: string | null;
  region_policy_snapshot: Record<string, unknown> | null;

  scheduled_service_date:
    string | null;
}

interface LeadRow {
  id: string;
  email: string;
}

interface QuotePaymentRow {
  id: string;
  task_id: string | null;
  provider: string;
  provider_payment_id: string;
  amount_cents: number;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REFUNDED';
  platform_fee_cents: number | null;
  business_organization_id: string | null;
  provider_merchant_id: string | null;
}

function fail<T>(
  code: string,
  message: string,
): ServiceResult<T> {
  return {
    success: false,
    error: { code, message },
  };
}

export async function finalizePaidQuote(
  input: FinalizePaidQuoteInput,
): Promise<ServiceResult<FinalizePaidQuoteResult>> {
  try {
    /*
     * Step 1:
     * Validate the quote/payment outside the DB transaction.
     *
     * We do not want an external Stripe call while holding DB locks.
     */
      const quoteContext = await db.query<{
        quote_id: string;
        quote_version_id: string;
        selected_quote_id: string | null;
        total_cents: number;
        hustler_payout_cents: number;
        business_organization_id: string | null;
        provider_payment_id: string | null;
        payment_amount_cents: number | null;
        provider_merchant_id: string | null;
        payment_platform_fee_cents: number | null;
        assessment_credit_cents: number | null;
      }>(
        `
        SELECT
          q.id AS quote_id,
          qv.id AS quote_version_id,
          d.quote_id AS selected_quote_id,
          qv.total_cents,
          qv.hustler_payout_cents,
          payment.provider_payment_id,
          payment.amount_cents AS payment_amount_cents,
          assessment_payment.amount_cents AS assessment_credit_cents
        FROM quotes q
        JOIN quote_versions qv
          ON qv.id = q.active_version_id
        AND qv.quote_id = q.id
        JOIN task_drafts d
          ON d.id = q.task_draft_id
        LEFT JOIN quote_payments payment
          ON payment.quote_id = q.id
         AND payment.quote_version_id = qv.id
        LEFT JOIN ops_business_claim_links claim
          ON claim.quote_id = q.id
        LEFT JOIN business_assessment_requests assessment
          ON assessment.claim_link_id = claim.id
         AND assessment.status = 'COMPLETED'
        LEFT JOIN assessment_payments assessment_payment
          ON assessment_payment.assessment_request_id = assessment.id
         AND assessment_payment.status = 'SUCCEEDED'
        WHERE q.id = $1
          AND qv.id = $2
          AND d.poster_user_id = $3
        LIMIT 1
        `,
        [input.quoteId, input.quoteVersionId, input.posterId],
      );

    const context = quoteContext.rows[0];

    if (!context) {
      return fail(
        'QUOTE_NOT_FOUND',
        'Quote or quote version was not found.',
      );
    }

    if (context.selected_quote_id !== input.quoteId) {
      return fail(
        'QUOTE_NOT_ACCEPTED',
        'This quote has not been accepted by the poster.',
      );
    }

    if (!context.business_organization_id || !context.provider_payment_id || context.payment_amount_cents === null) {
      return fail('QUOTE_PAYMENT_CONTEXT_MISSING', 'Quote payment binding is incomplete.');
    }
    if (context.provider_payment_id !== input.paymentIntentId) {
      return fail('QUOTE_PAYMENT_ID_MISMATCH', 'The supplied payment does not match the stored quote payment.');
    }
    const assessmentCreditCents = Number(context.assessment_credit_cents ?? 0);
    const quotePaymentAmountCents = Number(context.payment_amount_cents);
        const totalCents = Number(context.total_cents);
    const payoutCents = Number(context.hustler_payout_cents);
    if (!Number.isInteger(payoutCents) || payoutCents < 0) return fail('QUOTE_PAYOUT_INVALID', 'Quote payout is invalid.');
    if (assessmentCreditCents + quotePaymentAmountCents !== totalCents) return fail('QUOTE_PAYMENT_TOTAL_MISMATCH', 'Assessment credit and final payment do not equal the quote total.');

    /*
     * Verify that the payment actually belongs to this quote.
     */
    const verified =
      await StaxQuotePaymentProvider.verifySucceededPayment({
        transactionId: input.paymentIntentId,
        quoteId: input.quoteId,
        quoteVersionId: input.quoteVersionId,
        posterId: input.posterId,
        amountCents: quotePaymentAmountCents,
      });

    if (!verified.success) {
      return {
        success: false,
        error: verified.error,
      };
    }

    /*
     * Step 2:
     * Lock the quote and create/materialize the canonical task.
     */
    const materialized = await db.transaction(async (query) => {
    const quoteResult = await query<
      QuoteRow & { selected_quote_id: string | null }
    >(
      `
      SELECT
        q.id,
        q.task_draft_id,
        q.active_version_id,
        q.status,
        q.environment,
        q.is_test,
        q.business_organization_id,
        q.business_location_id,
        q.provider_service_profile_id,
        q.claimed_by_user_id,
        d.quote_id AS selected_quote_id
      FROM quotes q
      JOIN task_drafts d
        ON d.id = q.task_draft_id
      WHERE q.id = $1
      FOR UPDATE OF q, d
      `,
      [input.quoteId],
    );

	const quote = quoteResult.rows[0];

	if (!quote) {
	  throw new Error('QUOTE_NOT_FOUND');
	}

  if (quote.selected_quote_id !== input.quoteId) {
    throw new Error('QUOTE_NOT_ACCEPTED');
  }

  if (
    quote.status !== 'quote_send_ready' &&
    quote.status !== 'quote_ready'
  ) {
    throw new Error('QUOTE_NOT_PAYABLE');
  }
  
	const hasBusinessClaim = Boolean(quote.business_organization_id);

	if (hasBusinessClaim) {
	  if (
	    !quote.business_location_id ||
	    !quote.provider_service_profile_id
	  ) {
	    throw new Error('BUSINESS_CLAIM_BINDING_INCOMPLETE');
	  }
	}

	if (quote.active_version_id !== input.quoteVersionId) {
	  throw new Error('QUOTE_VERSION_NOT_ACTIVE');
	}

      const versionResult = await query<QuoteVersionRow>(
        `
        SELECT
        id,
        quote_id,
        status,
        total_cents,
        hustler_payout_cents,
        arrival_window_start,
        arrival_window_end,
        expires_at,
        dispatch_expires_at
        FROM quote_versions
        WHERE id = $1
          AND quote_id = $2
        FOR UPDATE
        `,
        [input.quoteVersionId, input.quoteId],
      );

      const version = versionResult.rows[0];

      if (!version) {
        throw new Error('QUOTE_VERSION_NOT_FOUND');
      }

      /*
       * Deterministic replay check.
       *
       * One quote/version can only have one quote_payment row.
       */
      const paymentResult = await query<QuotePaymentRow>(
        `
        SELECT
          id,
          task_id,
          provider,
          provider_payment_id,
          amount_cents,
          platform_fee_cents,
          business_organization_id,
          provider_merchant_id,
          status
        FROM quote_payments
        WHERE quote_id = $1
          AND quote_version_id = $2
        FOR UPDATE
        `,
        [input.quoteId, input.quoteVersionId],
      );

      const existingPayment = paymentResult.rows[0];

      if (existingPayment?.status === 'SUCCEEDED' && existingPayment.task_id) {
        const escrowResult = await query<{ id: string }>(
          `
          SELECT id
          FROM escrows
          WHERE task_id = $1
          ORDER BY created_at DESC
          LIMIT 1
          `,
          [existingPayment.task_id],
        );

        const escrow = escrowResult.rows[0];

        if (!escrow) {
          throw new Error('ESCROW_NOT_FOUND_FOR_REPLAY');
        }

        return {
          taskId: existingPayment.task_id,
          escrowId: escrow.id,
          replayed: true,
        };
      }

      if (
        existingPayment
        && existingPayment.provider_payment_id !== input.paymentIntentId
      ) {
        throw new Error('QUOTE_PAYMENT_IDEMPOTENCY_CONFLICT');
      }

      if (version.expires_at <= new Date()) {
        throw new Error('QUOTE_EXPIRED');
      }

      /*
       * Load the draft used to construct CreateTaskParams.
       */
      const draftResult = await query<DraftRow>(
        `
        SELECT
          id,
          lead_id,
          category,
          title,
          scope_summary,
          structured,
          zip,
          validated_risk_level,
          compliance_result,
          scheduled_service_date::text AS scheduled_service_date,
          region,
          region_code,
          region_policy_id,
          region_policy_version,
          region_policy_hash,
          region_policy_snapshot
        FROM task_drafts
        WHERE id = $1
        FOR UPDATE
        `,
        [quote.task_draft_id],
      );

      const draft = draftResult.rows[0];

      if (!draft) {
        throw new Error('TASK_DRAFT_NOT_FOUND');
      }

      if (!draft.lead_id) {
        throw new Error('TASK_DRAFT_LEAD_MISSING');
      }

      const leadResult = await query<LeadRow>(
        `
        SELECT id, email
        FROM leads
        WHERE id = $1
        LIMIT 1
        `,
        [draft.lead_id],
      );

      const lead = leadResult.rows[0];

      if (!lead) {
        throw new Error('LEAD_NOT_FOUND');
      }

      const posterResult = await query<{ email: string }>(
        `
        SELECT email
        FROM users
        WHERE id = $1
        LIMIT 1
        `,
        [input.posterId],
      );

      const poster = posterResult.rows[0];

      if (!poster) {
        throw new Error('POSTER_NOT_FOUND');
      }

      if (
        poster.email.trim().toLowerCase()
        !== lead.email.trim().toLowerCase()
      ) {
        throw new Error('QUOTE_POSTER_MISMATCH');
      }

      if (!existingPayment) throw new Error('QUOTE_PAYMENT_NOT_FOUND');
      if (existingPayment.provider !== 'stax') throw new Error('QUOTE_PAYMENT_PROVIDER_INVALID');
      if (existingPayment.provider_payment_id !== input.paymentIntentId) throw new Error('QUOTE_PAYMENT_IDEMPOTENCY_CONFLICT');
      if (existingPayment.amount_cents !== quotePaymentAmountCents) throw new Error('QUOTE_PAYMENT_AMOUNT_MISMATCH');
            
      const taskParamsInput: MapQuoteToTaskParamsInput = {
        posterId: input.posterId,
        draft,
        quoteVersion: version,
        automationClassification:
          quote.environment === 'TEST'
            ? 'CONTROLLED_TEST'
            : 'PRODUCTION',
        clientIdempotencyKey: `quote-finalize:${input.quoteId}:v${input.quoteVersionId}`,
        businessOrganizationId: quote.business_organization_id,
        businessLocationId: quote.business_location_id,
        providerServiceProfileId: quote.provider_service_profile_id,
        claimedByUserId: quote.claimed_by_user_id,  
        businessFulfillerOrganizationId: quote.business_organization_id ?? undefined,       
      };

      const taskParams =
        mapQuoteToCreateTaskParams(taskParamsInput);

      const taskResult =
        await TaskCreateService.materializeQuotedTaskInTransaction(
          query,
          taskParams,
        );

      if (!taskResult.success) {
        throw new Error(
          `TASK_CREATE_FAILED:${taskResult.error.code}:${taskResult.error.message}`,
        );
      }

      const taskId = taskResult.data.id;

      /*
       * TaskCreateService already created the pending escrow.
       */
      const escrowResult = await query<{
        id: string;
        state: string;
        amount: number;
      }>(
        `
        SELECT
          id,
          state,
          amount
        FROM escrows
        WHERE task_id = $1
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
        `,
        [taskId],
      );

      const escrow = escrowResult.rows[0];

      if (!escrow) {
        throw new Error('ESCROW_NOT_CREATED');
      }

      /*
       * Bind the quote payment directly to the canonical task.
       */
      await query(
        `
        UPDATE quote_payments
        SET
          task_id = $1,
          updated_at = NOW()
        WHERE quote_id = $2
          AND quote_version_id = $3
          AND provider_payment_id = $4
        `,
        [
          taskId,
          input.quoteId,
          input.quoteVersionId,
          input.paymentIntentId,
        ],
      );
      const draftUpdate = await query<{
        task_id: string;
      }>(
        `
        UPDATE task_drafts
        SET
          task_id = $2,
          updated_at = NOW()
        WHERE id = $1
          AND (
            task_id IS NULL
            OR task_id = $2
          )
        RETURNING task_id
        `,
        [
          draft.id,
          taskId,
        ],
      );

      if (!draftUpdate.rows[0]) {
        throw new Error(
          'Task draft is already linked to a different canonical task.',
        );
      }

      return {
        taskId,
        escrowId: escrow.id,
        replayed: taskResult.replayed === true,
      };
    });

    /*
    * Step 3:
    * Fund the escrow.
    *
    * The task-create transaction may be replayed after a partial finalization.
    * In that case the escrow may already be FUNDED. Resume safely instead of
    * trying to fund it a second time.
    */
    const escrowState = await db.query<{ state: string }>(
      `
      SELECT state
      FROM escrows
      WHERE id = $1
      FOR UPDATE
      `,
      [materialized.escrowId],
    );

    const currentEscrowState = escrowState.rows[0]?.state;

    if (!currentEscrowState) {
      return {
        success: false,
        error: {
          code: 'ESCROW_NOT_FOUND',
          message: 'The task escrow could not be found during payment finalization.',
        },
      };
    }

    if (currentEscrowState === 'PENDING') {
      const funded = await EscrowService.fund({
        escrowId: materialized.escrowId,
        stripePaymentIntentId: input.paymentIntentId,
      });

      if (!funded.success) {
        return {
          success: false,
          error: funded.error,
        };
      }
    } else if (currentEscrowState !== 'FUNDED') {
      return {
        success: false,
        error: {
          code: 'ESCROW_INVALID_STATE',
          message: `Cannot finalize payment with escrow in state '${currentEscrowState}'.`,
        },
      };
    }
    // Business quote payment is the Business's commitment to perform.
    // Once the customer has funded the escrow, move the Business task into execution.
    const accepted = await db.query<{ id: string }>(
      `
      UPDATE tasks
      SET
        state = 'ACCEPTED',
        progress_state = 'ACCEPTED',
        progress_updated_at = NOW(),
        progress_by = NULL,
        accepted_at = COALESCE(accepted_at, NOW()),
        updated_at = NOW()
      WHERE id = $1
        AND state = 'OPEN'
        AND business_fulfiller_organization_id IS NOT NULL
        AND worker_id IS NULL
        AND orchestration_mode = 'OPS_MANUAL'
      RETURNING id
      `,
      [materialized.taskId],
    );

    if ((accepted.rowCount ?? 0) !== 1) {
      const currentTask = await db.query<{ state: string }>(
        `
        SELECT state
        FROM tasks
        WHERE id = $1
        `,
        [materialized.taskId],
      );

      if (currentTask.rows[0]?.state !== 'ACCEPTED') {
        throw new Error('BUSINESS_TASK_ACCEPT_FAILED');
      }
    }

    /*
     * Step 4:
     * Finalize the payment/quote state.
     */
    await db.query(
      `
      UPDATE quote_payments
      SET
        status = 'SUCCEEDED',
        updated_at = NOW()
      WHERE quote_id = $1
        AND quote_version_id = $2
        AND provider_payment_id = $3
        AND task_id = $4
      `,
      [
        input.quoteId,
        input.quoteVersionId,
        input.paymentIntentId,
        materialized.taskId,
      ],
    );

    await db.query(
      `
      UPDATE quote_versions
      SET
        status = 'paid',
        updated_at = NOW()
      WHERE id = $1
        AND quote_id = $2
        AND status = 'draft'
      `,
      [input.quoteVersionId, input.quoteId],
    );

    await db.query(
      `
      UPDATE quotes
      SET
        status = 'paid',
        updated_at = NOW()
      WHERE id = $1
        AND status IN ('quote_ready', 'quote_send_ready')
      `,
      [input.quoteId],
    );

    return {
      success: true,
      data: {
        taskId: materialized.taskId,
        escrowId: materialized.escrowId,
        quoteId: input.quoteId,
        quoteVersionId: input.quoteVersionId,
        paymentIntentId: input.paymentIntentId,
        replayed: materialized.replayed,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    const errors: Record<string, [string, string]> = {
      QUOTE_NOT_FOUND: [
        'QUOTE_NOT_FOUND',
        'Quote not found.',
      ],
      QUOTE_VERSION_NOT_ACTIVE: [
        'QUOTE_VERSION_NOT_ACTIVE',
        'The requested quote version is not active.',
      ],
      QUOTE_VERSION_NOT_FOUND: [
        'QUOTE_VERSION_NOT_FOUND',
        'Quote version not found.',
      ],
      QUOTE_EXPIRED: [
        'QUOTE_EXPIRED',
        'This quote has expired.',
      ],
      TASK_DRAFT_NOT_FOUND: [
        'TASK_DRAFT_NOT_FOUND',
        'Task draft not found.',
      ],
      TASK_DRAFT_LEAD_MISSING: [
        'TASK_DRAFT_LEAD_MISSING',
        'Task draft is not linked to a lead.',
      ],
      LEAD_NOT_FOUND: [
        'LEAD_NOT_FOUND',
        'Lead not found.',
      ],
      POSTER_NOT_FOUND: [
        'POSTER_NOT_FOUND',
        'Poster not found.',
      ],
      QUOTE_POSTER_MISMATCH: [
        'QUOTE_POSTER_MISMATCH',
        'This quote does not belong to the authenticated poster.',
      ],
      PENDING_ESCROW_NOT_CREATED: [
        'PENDING_ESCROW_NOT_CREATED',
        'Task creation did not produce a pending escrow.',
      ],
      ESCROW_NOT_FOUND_FOR_REPLAY: [
        'ESCROW_NOT_FOUND_FOR_REPLAY',
        'The finalized quote has no associated escrow.',
      ],
      QUOTE_PAYMENT_IDEMPOTENCY_CONFLICT: [
        'QUOTE_PAYMENT_IDEMPOTENCY_CONFLICT',
        'This quote is already bound to a different payment.',
      ],
      BUSINESS_CLAIM_BINDING_INCOMPLETE: [
  	'BUSINESS_CLAIM_BINDING_INCOMPLETE',
  	'Business quote is missing its organization, location, or service profile binding.',
      ],
    };

    const known = errors[message];

    if (known) {
      return fail(known[0], known[1]);
    }

    if (message.startsWith('TASK_CREATE_FAILED:')) {
      const [, code, ...rest] = message.split(':');

      return fail(
        code || 'TASK_CREATE_FAILED',
        rest.join(':') || 'Task creation failed.',
      );
    }
    const message1 =
        err instanceof Error
          ? err.message
          : String(err);

      console.error(
        'QUOTE FINALIZATION FAILED:',
        {
          quoteId: input.quoteId,
          quoteVersionId: input.quoteVersionId,
          paymentIntentId: input.paymentIntentId,
          posterId: input.posterId,
          error: message1,
          stack:
            err instanceof Error
              ? err.stack
              : undefined,
        },
      );
    return fail(
      'QUOTE_FINALIZATION_FAILED',
      'Unable to finalize the paid quote.',
    );
  }
}


