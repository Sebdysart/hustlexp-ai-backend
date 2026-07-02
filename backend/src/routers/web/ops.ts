/**
 * Ops Router
 *
 * Replaces Supabase edge functions:
 *   task-admin, task-quote-admin, supply-admin (hustler roster + skills)
 *
 * All procedures gated by OPS_ADMIN_KEY header/field.
 */

import { z } from 'zod';
import { router, publicProcedure } from '../../trpc.js';
import { db } from '../../db.js';
import { logger } from '../../logger.js';
import { TRPCError } from '@trpc/server';
import crypto from 'crypto';

const log = logger.child({ router: 'web.ops' });

function checkAdminKey(key: string) {
  if (key !== process.env.OPS_ADMIN_KEY) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Invalid admin key' });
  }
}

export const webOpsRouter = router({

  // ── Task Drafts ─────────────────────────────────────────────────────────────

  listTaskDrafts: publicProcedure
    .input(z.object({
      adminKey: z.string(),
      status: z.string().optional(),
      limit: z.number().min(1).max(100).default(50),
    }))
    .query(async ({ input }) => {
      checkAdminKey(input.adminKey);
      const conditions = input.status ? `WHERE status = $1` : '';
      const params = input.status ? [input.status, input.limit] : [input.limit];
      const limitIdx = params.length;

      const result = await db.query(
        `SELECT id, submission_id, category, title, scope_summary,
                est_price_min_cents, est_price_max_cents, photo_count,
                zip, region, status, source, lead_id, poster_user_id,
                claimed_at, quote_id, quote_send_ready_at, created_at, updated_at
         FROM task_drafts ${conditions}
         ORDER BY created_at DESC LIMIT $${limitIdx}`,
        params
      );
      return { ok: true, drafts: result.rows };
    }),

  getTaskDraft: publicProcedure
    .input(z.object({ adminKey: z.string(), id: z.string().uuid() }))
    .query(async ({ input }) => {
      checkAdminKey(input.adminKey);
      const result = await db.query(
        `SELECT d.*, q.id as quote_id_linked,
                qv.status as quote_status, qv.total_cents, qv.payment_link_url
         FROM task_drafts d
         LEFT JOIN quotes q ON q.task_draft_id = d.id
         LEFT JOIN quote_versions qv ON qv.id = q.active_version_id
         WHERE d.id = $1`,
        [input.id]
      );
      if (result.rows.length === 0) throw new TRPCError({ code: 'NOT_FOUND' });
      return { ok: true, draft: result.rows[0] };
    }),

  // ── Quotes ──────────────────────────────────────────────────────────────────

  createQuote: publicProcedure
    .input(z.object({
      adminKey: z.string(),
      task_draft_id: z.string().uuid(),
      customer_description: z.string().min(1),
      subtotal_cents: z.number().min(0),
      service_fee_cents: z.number().min(0).default(0),
      materials_cents: z.number().min(0).default(0),
      discount_cents: z.number().min(0).default(0),
      internal_notes: z.string().optional(),
      minimum_acceptable_price_cents: z.number().optional(),
      hustler_payout_cents: z.number().optional(),
      scope_json: z.record(z.unknown()).default({}),
    }))
    .mutation(async ({ input }) => {
      checkAdminKey(input.adminKey);

      const totalCents = input.subtotal_cents + input.service_fee_cents
        + input.materials_cents - input.discount_cents;
      const payToken = crypto.randomBytes(16).toString('hex');

      const quoteResult = await db.query<{ id: string }>(
        `INSERT INTO quotes (task_draft_id, title, status)
         SELECT $1, COALESCE(title, 'Quote'), 'quote_ready'
         FROM task_drafts WHERE id = $1
         RETURNING id`,
        [input.task_draft_id]
      );

      if (quoteResult.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Task draft not found' });
      }

      const quoteId = quoteResult.rows[0].id;

      const versionResult = await db.query<{ id: string }>(
        `INSERT INTO quote_versions
          (quote_id, version_number, status, customer_description, internal_notes,
           subtotal_cents, service_fee_cents, materials_cents, discount_cents,
           total_cents, minimum_acceptable_price_cents, hustler_payout_cents,
           scope_json, pay_token)
         VALUES ($1, 1, 'draft', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
         RETURNING id`,
        [
          quoteId,
          input.customer_description, input.internal_notes ?? null,
          input.subtotal_cents, input.service_fee_cents,
          input.materials_cents, input.discount_cents, totalCents,
          input.minimum_acceptable_price_cents ?? null,
          input.hustler_payout_cents ?? null,
          JSON.stringify(input.scope_json),
          payToken,
        ]
      );

      const versionId = versionResult.rows[0].id;

      // Set active version + link draft → quote
      await db.query(
        `UPDATE quotes SET active_version_id = $1, updated_at = now() WHERE id = $2`,
        [versionId, quoteId]
      );
      await db.query(
        `UPDATE task_drafts SET quote_id = $1, updated_at = now() WHERE id = $2`,
        [quoteId, input.task_draft_id]
      );

      log.info({ quoteId, totalCents }, 'Quote created');
      return { ok: true, quote_id: quoteId, version_id: versionId, total_cents: totalCents, status: 'quote_ready' };
    }),

  markQuoteSendReady: publicProcedure
    .input(z.object({ adminKey: z.string(), task_draft_id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      checkAdminKey(input.adminKey);

      const result = await db.query<{ id: string }>(
        `UPDATE quotes SET status = 'quote_send_ready', updated_at = now()
         WHERE task_draft_id = $1 RETURNING id`,
        [input.task_draft_id]
      );

      if (result.rows.length === 0) throw new TRPCError({ code: 'NOT_FOUND', message: 'No quote for this draft' });

      await db.query(
        `UPDATE task_drafts SET quote_send_ready_at = now(), updated_at = now() WHERE id = $1`,
        [input.task_draft_id]
      );

      return { ok: true, quote_id: result.rows[0].id, status: 'quote_send_ready' };
    }),

  // ── Hustler roster ──────────────────────────────────────────────────────────

  listHustlers: publicProcedure
    .input(z.object({
      adminKey: z.string(),
      status: z.string().optional(),
      available: z.boolean().optional(),
    }))
    .query(async ({ input }) => {
      checkAdminKey(input.adminKey);

      const conditions: string[] = [];
      const params: unknown[] = [];
      if (input.status) conditions.push(`h.status = $${params.push(input.status)}`);
      if (input.available !== undefined) conditions.push(`h.available = $${params.push(input.available)}`);
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      // leads.skills is a text[] column — no join needed
      const baseWhere = conditions.length
        ? `WHERE lead_type = 'hustler' AND ${conditions.join(' AND ')}`
        : `WHERE lead_type = 'hustler'`;

      const result = await db.query(
        `SELECT id, name, phone, email, home_zip, radius_miles, vehicle,
                max_lift_lbs, trust_tier, checkr_status, status, available,
                availability_note, completed_jobs, cancel_count, rating_avg,
                response_minutes, notes, skills, user_id, created_at, updated_at
         FROM leads ${baseWhere}
         ORDER BY created_at DESC`,
        params
      );
      return { ok: true, hustlers: result.rows };
    }),

  upsertHustler: publicProcedure
    .input(z.object({
      adminKey: z.string(),
      id: z.string().uuid().optional(),
      name: z.string().min(1),
      phone: z.string().optional(),
      email: z.string().email().optional(),
      home_zip: z.string().optional(),
      radius_miles: z.number().optional(),
      vehicle: z.string().default('none'),
      max_lift_lbs: z.number().optional(),
      status: z.string().default('new_applicant'),
      available: z.boolean().default(true),
      availability_note: z.string().optional(),
      notes: z.string().optional(),
      skills: z.array(z.string()).default([]),
    }))
    .mutation(async ({ input }) => {
      checkAdminKey(input.adminKey);

      // skills is a text[] column on leads — update inline, no join table
      let id = input.id;
      if (id) {
        await db.query(
          `UPDATE leads SET name=$1, phone=$2, email=$3, home_zip=$4, radius_miles=$5,
           vehicle=$6, max_lift_lbs=$7, status=$8, available=$9,
           availability_note=$10, notes=$11, skills=$12::text[], updated_at=now()
           WHERE id=$13 AND lead_type='hustler'`,
          [input.name, input.phone ?? null, input.email ?? null, input.home_zip ?? null,
           input.radius_miles ?? null, input.vehicle, input.max_lift_lbs ?? null,
           input.status, input.available, input.availability_note ?? null,
           input.notes ?? null, input.skills, id]
        );
      } else {
        const r = await db.query<{ id: string }>(
          `INSERT INTO leads
            (lead_type, name, phone, email, home_zip, radius_miles, vehicle,
             max_lift_lbs, status, available, availability_note, notes, skills,
             submission_id, consent_version)
           VALUES ('hustler',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::text[],
                   gen_random_uuid(),'v1')
           RETURNING id`,
          [input.name, input.phone ?? null, input.email ?? null, input.home_zip ?? null,
           input.radius_miles ?? null, input.vehicle, input.max_lift_lbs ?? null,
           input.status, input.available, input.availability_note ?? null,
           input.notes ?? null, input.skills]
        );
        id = r.rows[0].id;
      }

      return { ok: true, id };
    }),

  // ── Feature flags ────────────────────────────────────────────────────────────

  getPublicFlags: publicProcedure
    .input(z.object({}).optional())
    .query(async () => {
      const result = await db.query<{ key: string; enabled: boolean }>(
        `SELECT name AS key, enabled FROM feature_flags ORDER BY name`
      );
      return result.rows;
    }),

  updateFlag: publicProcedure
    .input(z.object({
      adminKey: z.string(),
      key: z.string(),
      enabled: z.boolean(),
    }))
    .mutation(async ({ input }) => {
      checkAdminKey(input.adminKey);
      await db.query(
        `INSERT INTO feature_flags (name, enabled)
         VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET enabled = $2`,
        [input.key, input.enabled]
      );
      return { ok: true };
    }),
});
