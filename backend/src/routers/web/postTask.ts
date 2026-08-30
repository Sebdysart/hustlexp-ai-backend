import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import crypto from 'node:crypto';
import { router, posterProcedure } from '../../trpc.js';
import { db } from '../../db.js';

const PostTaskSchema = z.object({
  lead: z.object({
    submission_id: z.string().uuid(),
    lead_type: z.enum(['poster', 'hustler', 'business', 'founder']),
    email: z.string().email().max(254),
    name: z.string().max(200).optional(),
    phone: z.string().max(30).optional(),
    region: z.string().max(100).optional(),
    zip: z.string().max(20).optional(),
    answers: z.record(z.unknown()).default({}),
    utm: z.record(z.unknown()).default({}),
    consent_version: z.literal('v1'),
    ip_hash: z.string().optional(),
  }),

  task: z.object({
    category: z.string().trim().min(1).max(100),
    title: z.string().trim().min(1).max(255),
    raw_input: z.string().optional(),
    scope_summary: z.string().optional(),
    structured: z.record(z.unknown()).default({}),
    est_price_min_cents: z.number().int().nonnegative().optional(),
    est_price_max_cents: z.number().int().nonnegative().optional(),
    photo_count: z.number().int().nonnegative().default(0),
    zip: z.string().max(20).optional(),
    region: z.string().max(100).optional(),
    source: z.string().default('website'),
    utm: z.record(z.unknown()).default({}),
    ip_hash: z.string().optional(),
  }),
});

type PostTaskInput = z.infer<typeof PostTaskSchema>;

function generateCardToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

async function handlePostTask({
    input,
    ctx,
    }: {
    input: PostTaskInput;
    ctx: {
        user: {
        id: string;
        };
    };
    }) {
    const posterUserId = ctx.user.id;
    const correlationId = crypto.randomUUID();
    try {  
        const result = await db.transaction(async (query) => {
            // 1. Replay check.
            const existing = await query<{
            lead_id: string | null;
            draft_id: string;
            quote_id: string | null;
            }>(
            `SELECT
                td.lead_id,
                td.id AS draft_id,
                td.quote_id
            FROM task_drafts td
            WHERE td.submission_id = $1
                AND td.poster_user_id = $2
            LIMIT 1`,
            [input.lead.submission_id, posterUserId],
            );

            if (existing.rows[0]) {
            return {
                leadId: existing.rows[0].lead_id,
                taskDraftId: existing.rows[0].draft_id,
                quoteId: existing.rows[0].quote_id,
                replayed: true,
            };
            }

            // 2. Create lead.
            const lead = await query<{ id: string }>(
            `INSERT INTO leads (
                submission_id,
                lead_type,
                email,
                name,
                phone,
                region,
                zip,
                answers,
                utm,
                consent_version,
                source,
                ip_hash,
                correlation_id
            )
            VALUES (
                $1, $2, $3, $4, $5, $6, $7,
                $8::jsonb, $9::jsonb, $10, 'website', $11, $12
            )
            RETURNING id`,
            [
                input.lead.submission_id,
                input.lead.lead_type,
                input.lead.email.trim().toLowerCase(),
                input.lead.name?.trim() ?? null,
                input.lead.phone?.trim() ?? null,
                input.lead.region ?? null,
                input.lead.zip ?? null,
                JSON.stringify(input.lead.answers),
                JSON.stringify(input.lead.utm),
                input.lead.consent_version,
                input.lead.ip_hash ?? null,
                correlationId,
            ],
            );

            const leadId = lead.rows[0]?.id;

            if (!leadId) {
            throw new TRPCError({
                code: 'INTERNAL_SERVER_ERROR',
                message: 'Failed to create lead',
            });
            }

            // 3. Create task draft linked to lead.
            const { raw: cardToken, hash: cardTokenHash } = generateCardToken();
            const draft = await query<{
                id: string;
                quote_id: string | null;
                }>(
                `INSERT INTO task_drafts (
                    submission_id,
                    card_token_hash,
                    category,
                    title,
                    raw_input,
                    scope_summary,
                    structured,
                    est_price_min_cents,
                    est_price_max_cents,
                    photo_count,
                    zip,
                    region,
                    status,
                    source,
                    utm,
                    ip_hash,
                    lead_id,
                    poster_user_id
                )
                VALUES (
                    $1, $2, $3, $4, $5, $6, $7::jsonb,
                    $8, $9, $10, $11, $12,
                    'draft', $13, $14::jsonb, $15, $16, $17
                )
                RETURNING id, quote_id`,
                [
                    input.lead.submission_id,
                    cardTokenHash,
                    input.task.category,
                    input.task.title,
                    input.task.raw_input ?? null,
                    input.task.scope_summary ?? null,
                    JSON.stringify(input.task.structured),
                    input.task.est_price_min_cents ?? null,
                    input.task.est_price_max_cents ?? null,
                    input.task.photo_count,
                    input.task.zip ?? null,
                    input.task.region ?? null,
                    input.task.source,
                    JSON.stringify(input.task.utm),
                    input.task.ip_hash ?? null,
                    leadId,
                    posterUserId,
                ],
            );

            const taskDraftId = draft.rows[0]?.id;

            if (!taskDraftId) {
            throw new TRPCError({
                code: 'INTERNAL_SERVER_ERROR',
                message: 'Failed to create task draft',
            });
            }
            
            return {
                leadId,
                taskDraftId,
                quoteId: draft.rows[0]?.quote_id ?? null,
                cardToken,
                replayed: false,
            };
        });
        /* const quote = await QuoteGenerationService.generateForDraft(
        result.taskDraftId,
        {
            executionEnvironment: 'TEST',
            record: true,
        },
        ); */
        return {
            ok: true,
            ...result,
            correlation_id: correlationId,
        };
        } catch (error) {
            console.error('[webPostTask.start] DB/transaction failure:', error);
            throw error;
        }
}

export const webPostTaskRouter = router({
  start: posterProcedure
    .input(PostTaskSchema)
    .mutation(handlePostTask),
});

export type WebPostTaskRouter = typeof webPostTaskRouter;
