import { db } from '../db.js';
import type { ServiceResult } from '../types.js';
import { EscrowService } from './EscrowService.js';
import { TaskCreateService } from './TaskCreateService.js';
import {
  mapQuoteToCreateTaskParams,
  type MapQuoteToTaskParamsInput,
} from './QuoteTaskParamsMapper.js';
import { StripeQuotePaymentProvider } from './payment/StripeQuotePaymentProvider.js';
import { newPaymentCreationFailure } from './NewPaymentCreationGuard.js';

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
  structured: Record<string, unknown> | null;
  zip: string | null;
  region: string | null;
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
}

function fail<T>(code: string, message: string): ServiceResult<T> {
  return {
    success: false,
    error: { code, message },
  };
}

export async function finalizePaidQuote(
  input: FinalizePaidQuoteInput
): Promise<ServiceResult<FinalizePaidQuoteResult>> {
  try {
    const replay = await db.query<{ task_id: string; escrow_id: string }>(
      `
      SELECT qp.task_id, e.id AS escrow_id
      FROM quote_payments qp
      JOIN tasks t ON t.id = qp.task_id
      JOIN escrows e ON e.task_id = qp.task_id
      WHERE qp.quote_id = $1
        AND qp.quote_version_id = $2
        AND qp.provider_payment_id = $3
        AND qp.status = 'SUCCEEDED'
        AND qp.task_id IS NOT NULL
        AND t.poster_id = $4
      ORDER BY e.created_at DESC
      LIMIT 1
      `,
      [input.quoteId, input.quoteVersionId, input.paymentIntentId, input.posterId]
    );
    if (replay.rows[0]) {
      return {
        success: true,
        data: {
          taskId: replay.rows[0].task_id,
          escrowId: replay.rows[0].escrow_id,
          quoteId: input.quoteId,
          quoteVersionId: input.quoteVersionId,
          paymentIntentId: input.paymentIntentId,
          replayed: true,
        },
      };
    }

    const frozen = newPaymentCreationFailure('quote_materialization');
    if (frozen) return frozen;

    /*
     * Step 1:
     * Validate the quote/payment outside the DB transaction.
     *
     * We do not want an external Stripe call while holding DB locks.
     */
    const quoteContext = await db.query<{
      quote_id: string;
      quote_version_id: string;
      poster_email: string;
      lead_email: string;
      total_cents: number;
    }>(
      `
      SELECT
        q.id AS quote_id,
        qv.id AS quote_version_id,
        u.email AS poster_email,
        l.email AS lead_email,
        qv.total_cents
      FROM quotes q
      JOIN quote_versions qv
        ON qv.id = q.active_version_id
       AND qv.quote_id = q.id
      JOIN task_drafts d
        ON d.id = q.task_draft_id
      JOIN leads l
        ON l.id = d.lead_id
      JOIN users u
        ON u.id = $3
      WHERE q.id = $1
        AND qv.id = $2
      LIMIT 1
      `,
      [input.quoteId, input.quoteVersionId, input.posterId]
    );

    const context = quoteContext.rows[0];

    if (!context) {
      return fail('QUOTE_NOT_FOUND', 'Quote or quote version was not found.');
    }

    if (context.poster_email.trim().toLowerCase() !== context.lead_email.trim().toLowerCase()) {
      return fail(
        'QUOTE_POSTER_MISMATCH',
        'This quote does not belong to the authenticated poster.'
      );
    }

    /*
     * Verify that the payment actually belongs to this quote.
     */
    const verified = await StripeQuotePaymentProvider.verifySucceededPayment({
      paymentIntentId: input.paymentIntentId,
      quoteId: input.quoteId,
      quoteVersionId: input.quoteVersionId,
      posterId: input.posterId,
      amountCents: Number(context.total_cents),
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
      const quoteResult = await query<QuoteRow>(
        `
        SELECT
          id,
          task_draft_id,
          active_version_id,
          status,
          environment,
          is_test
        FROM quotes
        WHERE id = $1
        FOR UPDATE
        `,
        [input.quoteId]
      );

      const quote = quoteResult.rows[0];

      if (!quote) {
        throw new Error('QUOTE_NOT_FOUND');
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
        [input.quoteVersionId, input.quoteId]
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
          status
        FROM quote_payments
        WHERE quote_id = $1
          AND quote_version_id = $2
        FOR UPDATE
        `,
        [input.quoteId, input.quoteVersionId]
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
          [existingPayment.task_id]
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

      if (existingPayment && existingPayment.provider_payment_id !== input.paymentIntentId) {
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
          region
        FROM task_drafts
        WHERE id = $1
        FOR UPDATE
        `,
        [quote.task_draft_id]
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
        [draft.lead_id]
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
        [input.posterId]
      );

      const poster = posterResult.rows[0];

      if (!poster) {
        throw new Error('POSTER_NOT_FOUND');
      }

      if (poster.email.trim().toLowerCase() !== lead.email.trim().toLowerCase()) {
        throw new Error('QUOTE_POSTER_MISMATCH');
      }

      /*
       * Persist the payment binding before materialization.
       * If task creation fails, the whole transaction rolls back.
       */
      await query(
        `
        INSERT INTO quote_payments (
          quote_id,
          quote_version_id,
          provider,
          provider_payment_id,
          amount_cents,
          status
        )
        VALUES ($1, $2, 'stripe', $3, $4, 'PENDING')
        ON CONFLICT (quote_id, quote_version_id)
        DO UPDATE SET
          provider_payment_id = EXCLUDED.provider_payment_id,
          amount_cents = EXCLUDED.amount_cents,
          updated_at = NOW()
        `,
        [input.quoteId, input.quoteVersionId, input.paymentIntentId, version.total_cents]
      );

      const taskParamsInput: MapQuoteToTaskParamsInput = {
        posterId: input.posterId,
        draft,
        quoteVersion: version,
        automationClassification: quote.environment === 'TEST' ? 'CONTROLLED_TEST' : 'PRODUCTION',
        clientIdempotencyKey: `quote-finalize:${input.quoteId}:v${input.quoteVersionId}`,
      };

      const taskParams = mapQuoteToCreateTaskParams(taskParamsInput);

      const taskResult = await TaskCreateService.createInTransaction(query, taskParams);

      if (!taskResult.success) {
        throw new Error(`TASK_CREATE_FAILED:${taskResult.error.code}:${taskResult.error.message}`);
      }

      const taskId = taskResult.data.id;

      /*
       * TaskCreateService already created the pending escrow.
       */
      const escrowResult = await query<{ id: string }>(
        `
        SELECT id
        FROM escrows
        WHERE task_id = $1
          AND state = 'PENDING'
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
        `,
        [taskId]
      );

      const escrow = escrowResult.rows[0];

      if (!escrow) {
        throw new Error('PENDING_ESCROW_NOT_CREATED');
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
        [taskId, input.quoteId, input.quoteVersionId, input.paymentIntentId]
      );

      return {
        taskId,
        escrowId: escrow.id,
        replayed: false,
      };
    });

    /*
     * Step 3:
     * Fund the escrow.
     *
     * EscrowService.fund() owns its own transaction. It is idempotent and
     * will safely convert the PENDING escrow created above to FUNDED.
     */
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
      [input.quoteId, input.quoteVersionId, input.paymentIntentId, materialized.taskId]
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
      [input.quoteVersionId, input.quoteId]
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
      [input.quoteId]
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
      QUOTE_NOT_FOUND: ['QUOTE_NOT_FOUND', 'Quote not found.'],
      QUOTE_VERSION_NOT_ACTIVE: [
        'QUOTE_VERSION_NOT_ACTIVE',
        'The requested quote version is not active.',
      ],
      QUOTE_VERSION_NOT_FOUND: ['QUOTE_VERSION_NOT_FOUND', 'Quote version not found.'],
      QUOTE_EXPIRED: ['QUOTE_EXPIRED', 'This quote has expired.'],
      TASK_DRAFT_NOT_FOUND: ['TASK_DRAFT_NOT_FOUND', 'Task draft not found.'],
      TASK_DRAFT_LEAD_MISSING: ['TASK_DRAFT_LEAD_MISSING', 'Task draft is not linked to a lead.'],
      LEAD_NOT_FOUND: ['LEAD_NOT_FOUND', 'Lead not found.'],
      POSTER_NOT_FOUND: ['POSTER_NOT_FOUND', 'Poster not found.'],
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
    };

    const known = errors[message];

    if (known) {
      return fail(known[0], known[1]);
    }

    if (message.startsWith('TASK_CREATE_FAILED:')) {
      const [, code, ...rest] = message.split(':');

      return fail(code || 'TASK_CREATE_FAILED', rest.join(':') || 'Task creation failed.');
    }

    return fail('QUOTE_FINALIZATION_FAILED', 'Unable to finalize the paid quote.');
  }
}
