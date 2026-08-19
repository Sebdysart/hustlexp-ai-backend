/**
 * Ops Router
 *
 * Replaces Supabase edge functions:
 *   task-admin, task-quote-admin, supply-admin (hustler roster + skills)
 *   plus Command-center read joins and liquidity snapshot.
 *
 * Browser-facing procedures use operationsAdminProcedure (Firebase + can_manage_operations).
 * listEngineTasks remains service-key gated for engine-bridge-admin only.
 */

import { z } from 'zod';
import { router, publicProcedure, operationsAdminProcedure } from '../../trpc.js';
import { db } from '../../db.js';
import { logger } from '../../logger.js';
import { TRPCError } from '@trpc/server';
import crypto from 'crypto';
import { AutomationLifecycleService } from '../../services/AutomationLifecycleService.js';
import { getOpsLiquidityPayload } from '../../services/OpsLiquidityService.js';
import { assertEngineOpsServiceKey, OpsAuthError } from './opsServiceKey.js';

const log = logger.child({ router: 'web.ops' });

function mapOpsAuth(error: unknown): never {
  if (error instanceof OpsAuthError) {
    throw new TRPCError({ code: 'FORBIDDEN', message: error.message });
  }
  throw error;
}

/** Display-safe task_draft columns — never select card_token_hash / ip_hash. */
const TASK_DRAFT_SAFE_COLS = `
  id, submission_id, category, title, raw_input, scope_summary, structured,
  est_price_min_cents, est_price_max_cents, photo_count, zip, region, status,
  source, lead_id, poster_user_id, quote_id, quote_send_ready_at,
  created_at, updated_at, claimed_at
`.replace(/\s+/g, ' ').trim();

const UpsertHustlerSchema = z.object({
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
});

type UpsertHustlerInput = z.infer<typeof UpsertHustlerSchema>;

function hustlerValues(input: UpsertHustlerInput): unknown[] {
  return [
    input.name, input.phone ?? null, input.email ?? null, input.home_zip ?? null,
    input.radius_miles ?? null, input.vehicle, input.max_lift_lbs ?? null,
    input.status, input.available, input.availability_note ?? null,
    input.notes ?? null, input.skills,
  ];
}

async function recordOpsAudit(input: {
  actorUserId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  meta?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.query(
      `INSERT INTO ops_action_audit (actor_user_id, actor_label, action, target_type, target_id, meta)
       VALUES ($1, 'ops', $2, $3, $4, $5::jsonb)`,
      [
        input.actorUserId ?? null,
        input.action,
        input.targetType,
        input.targetId ?? null,
        JSON.stringify(input.meta ?? {}),
      ],
    );
  } catch (error) {
    // Table may not exist until migration applies — never fail the operator action.
    log.warn({ err: error, action: input.action }, 'ops_action_audit write skipped');
  }
}

function quoteEligibilityError(code: 'not_eligible' | 'already_linked' | 'not_found', message: string): never {
  throw new TRPCError({ code: 'CONFLICT', message: `${code}:${message}` });
}

export const webOpsRouter = router({

  // ── Canonical engine lifecycle (E1) — service key only ─────────────────────

  listEngineTasks: publicProcedure
    .input(z.object({
      adminKey: z.string(),
      limit: z.number().int().min(1).max(100).default(20),
      cursor: z.string().max(512).nullish(),
    }))
    .query(async ({ input }) => {
      try {
        assertEngineOpsServiceKey(input.adminKey);
      } catch (error) {
        mapOpsAuth(error);
      }
      const result = await AutomationLifecycleService.listTasks({
        limit: input.limit,
        cursor: input.cursor,
      });
      if (!result.success) {
        throw new TRPCError({
          code: result.error.code === 'INVALID_CURSOR' ? 'BAD_REQUEST' : 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      return { ok: true, ...result.data };
    }),

  // ── Liquidity ──────────────────────────────────────────────────────────────

  getLiquidity: operationsAdminProcedure
    .input(z.object({}).optional())
    .query(async () => {
      const payload = await getOpsLiquidityPayload();
      return { ok: true, ...payload };
    }),

  // ── Task Drafts ─────────────────────────────────────────────────────────────

  listTaskDrafts: operationsAdminProcedure
    .input(z.object({
      status: z.string().optional(),
      category: z.string().optional(),
      limit: z.number().min(1).max(100).default(50),
    }))
    .query(async ({ input }) => {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (input.status) conditions.push(`status = $${params.push(input.status)}`);
      if (input.category) conditions.push(`category = $${params.push(input.category)}`);
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(input.limit);
      const result = await db.query(
        `SELECT ${TASK_DRAFT_SAFE_COLS}
         FROM task_drafts ${where}
         ORDER BY created_at DESC LIMIT $${params.length}`,
        params,
      );
      return { ok: true, drafts: result.rows };
    }),

  getTaskDraft: operationsAdminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input }) => {
      const result = await db.query(
        `SELECT ${TASK_DRAFT_SAFE_COLS.split(',').map((c) => `d.${c.trim()}`).join(', ')},
                q.id as quote_id_linked,
                qv.status as quote_status, qv.total_cents,
                qv.subtotal_cents, qv.service_fee_cents, qv.materials_cents,
                qv.discount_cents, qv.customer_description, qv.version_number as quote_version
         FROM task_drafts d
         LEFT JOIN quotes q ON q.task_draft_id = d.id
         LEFT JOIN quote_versions qv ON qv.id = q.active_version_id
         WHERE d.id = $1`,
        [input.id],
      );
      if (result.rows.length === 0) throw new TRPCError({ code: 'NOT_FOUND' });
      const draft = result.rows[0] as Record<string, unknown>;
      for (const forbidden of ['card_token_hash', 'ip_hash', 'pay_token']) {
        if (forbidden in draft) delete draft[forbidden];
      }
      return { ok: true, draft };
    }),

  // ── Quotes ──────────────────────────────────────────────────────────────────

  createQuote: operationsAdminProcedure
    .input(z.object({
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
    .mutation(async ({ ctx, input }) => {
      const totalCents = input.subtotal_cents + input.service_fee_cents
        + input.materials_cents - input.discount_cents;
      const payToken = crypto.randomBytes(16).toString('hex');

      try {
        const created = await db.transaction(async (tx) => {
          const draft = await tx<{ id: string; title: string | null; quote_id: string | null; status: string }>(
            `SELECT id, title, quote_id, status FROM task_drafts WHERE id = $1 FOR UPDATE`,
            [input.task_draft_id],
          );
          if (draft.rows.length === 0) {
            quoteEligibilityError('not_found', 'Task draft not found');
          }
          const row = draft.rows[0];
          if (row.quote_id) {
            quoteEligibilityError('already_linked', 'Task draft already has a quote');
          }
          if (['abandoned'].includes(row.status)) {
            quoteEligibilityError('not_eligible', `Draft status ${row.status} is not eligible`);
          }

          const quoteResult = await tx<{ id: string }>(
            `INSERT INTO quotes (task_draft_id, title, status)
             VALUES ($1, COALESCE($2, 'Quote'), 'quote_ready')
             RETURNING id`,
            [input.task_draft_id, row.title],
          );
          const quoteId = quoteResult.rows[0].id;

          const versionResult = await tx<{ id: string }>(
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
            ],
          );
          const versionId = versionResult.rows[0].id;

          await tx(
            `UPDATE quotes SET active_version_id = $1, updated_at = now() WHERE id = $2`,
            [versionId, quoteId],
          );
          await tx(
            `UPDATE task_drafts SET quote_id = $1, updated_at = now() WHERE id = $2`,
            [quoteId, input.task_draft_id],
          );

          return { quoteId, versionId };
        });

        await recordOpsAudit({
          actorUserId: ctx.user.id,
          action: 'quote_created',
          targetType: 'quote',
          targetId: created.quoteId,
          meta: { task_draft_id: input.task_draft_id, total_cents: totalCents },
        });

        log.info({ quoteId: created.quoteId, totalCents }, 'Quote created');
        return {
          ok: true,
          quote_id: created.quoteId,
          version_id: created.versionId,
          total_cents: totalCents,
          status: 'quote_ready',
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Quote create failed' });
      }
    }),

  markQuoteSendReady: operationsAdminProcedure
    .input(z.object({ task_draft_id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const quoteId = await db.transaction(async (tx) => {
          const draft = await tx<{ id: string; quote_id: string | null }>(
            `SELECT id, quote_id FROM task_drafts WHERE id = $1 FOR UPDATE`,
            [input.task_draft_id],
          );
          if (draft.rows.length === 0) {
            quoteEligibilityError('not_found', 'Task draft not found');
          }
          if (!draft.rows[0].quote_id) {
            quoteEligibilityError('not_eligible', 'No quote linked to this draft');
          }

          const result = await tx<{ id: string; status: string }>(
            `UPDATE quotes SET status = 'quote_send_ready', updated_at = now()
             WHERE task_draft_id = $1
             RETURNING id, status`,
            [input.task_draft_id],
          );
          if (result.rows.length === 0) {
            quoteEligibilityError('not_found', 'No quote for this draft');
          }

          await tx(
            `UPDATE task_drafts SET quote_send_ready_at = now(), updated_at = now() WHERE id = $1`,
            [input.task_draft_id],
          );
          return result.rows[0].id;
        });

        await recordOpsAudit({
          actorUserId: ctx.user.id,
          action: 'quote_mark_send_ready',
          targetType: 'quote',
          targetId: quoteId,
          meta: { task_draft_id: input.task_draft_id },
        });

        return { ok: true, quote_id: quoteId, status: 'quote_send_ready' };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Mark send ready failed' });
      }
    }),

  listQuotes: operationsAdminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ input }) => {
      const quotes = await db.query(
        `SELECT id, lead_id, title, status, active_version_id, negotiation_status,
                locked_at, created_at, updated_at, task_draft_id
         FROM quotes
         ORDER BY created_at DESC
         LIMIT $1`,
        [input.limit],
      );
      const versionIds = quotes.rows
        .map((q) => (q as { active_version_id?: string }).active_version_id)
        .filter((id): id is string => Boolean(id));
      const versions = versionIds.length
        ? await db.query(
          `SELECT id, quote_id, version_number, status, customer_description,
                  subtotal_cents, service_fee_cents, materials_cents, discount_cents,
                  total_cents, created_at
           FROM quote_versions WHERE id = ANY($1::uuid[])`,
          [versionIds],
        )
        : { rows: [] as Record<string, unknown>[] };
      const byId = new Map(versions.rows.map((v) => [(v as { id: string }).id, v]));
      const out = quotes.rows.map((q) => {
        const row = q as { id: string; active_version_id?: string | null; status: string; created_at?: string };
        return {
          quote: row,
          active_version: row.active_version_id ? byId.get(row.active_version_id) ?? null : null,
        };
      });
      return { ok: true, quotes: out };
    }),

  // ── Hustler roster (redacted) ───────────────────────────────────────────────

  listHustlers: operationsAdminProcedure
    .input(z.object({
      status: z.string().optional(),
      available: z.boolean().optional(),
    }))
    .query(async ({ input }) => {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (input.status) conditions.push(`status = $${params.push(input.status)}`);
      if (input.available !== undefined) conditions.push(`available = $${params.push(input.available)}`);

      const baseWhere = conditions.length
        ? `WHERE lead_type = 'hustler' AND ${conditions.join(' AND ')}`
        : `WHERE lead_type = 'hustler'`;

      // Redacted: no phone, email, or full name — supply-admin parity.
      const result = await db.query(
        `SELECT id,
                LEFT(COALESCE(name, ''), 1) || CASE WHEN length(COALESCE(name,'')) > 1 THEN '.' ELSE '' END AS name_initial,
                home_zip, radius_miles, vehicle, max_lift_lbs, trust_tier, checkr_status,
                status, available, availability_note, completed_jobs, cancel_count, rating_avg,
                response_minutes, skills, user_id, created_at, updated_at,
                available AS hustler_available,
                (status = 'approved' AND available = true) AS can_receive_task_opportunities,
                id AS hustler_id,
                status AS eligibility_status,
                status AS review_status
         FROM leads ${baseWhere}
         ORDER BY created_at DESC`,
        params,
      );
      return { ok: true, hustlers: result.rows, supply: result.rows };
    }),

  upsertHustler: operationsAdminProcedure
    .input(UpsertHustlerSchema)
    .mutation(async ({ ctx, input }) => {
      const id = input.id
        ? await (async () => {
          await db.query(
            `UPDATE leads SET name=$1, phone=$2, email=$3, home_zip=$4, radius_miles=$5,
             vehicle=$6, max_lift_lbs=$7, status=$8, available=$9,
             availability_note=$10, notes=$11, skills=$12::text[], updated_at=now()
             WHERE id=$13 AND lead_type='hustler'`,
            [...hustlerValues(input), input.id],
          );
          return input.id;
        })()
        : (await db.query<{ id: string }>(
          `INSERT INTO leads
            (lead_type, name, phone, email, home_zip, radius_miles, vehicle,
             max_lift_lbs, status, available, availability_note, notes, skills,
             submission_id, consent_version)
           VALUES ('hustler',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::text[],
                   gen_random_uuid(),'v1')
           RETURNING id`,
          hustlerValues(input),
        )).rows[0].id;

      await recordOpsAudit({
        actorUserId: ctx.user.id,
        action: input.id ? 'hustler_updated' : 'hustler_created',
        targetType: 'lead',
        targetId: id,
      });
      return { ok: true, id };
    }),

  // ── Command-center reads ────────────────────────────────────────────────────

  listOpsLeads: operationsAdminProcedure
    .input(z.object({
      status: z.string().optional(),
      leadType: z.string().optional(),
      limit: z.number().min(1).max(200).default(100),
      offset: z.number().min(0).default(0),
    }))
    .query(async ({ input }) => {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (input.status) conditions.push(`status = $${params.push(input.status)}`);
      if (input.leadType) conditions.push(`lead_type = $${params.push(input.leadType)}`);
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(input.limit, input.offset);
      // Display-safe: no phone/email/full name — initials only (matches opsCockpit redactWho).
      const result = await db.query(
        `SELECT id, submission_id, lead_type,
                CASE
                  WHEN name IS NULL OR BTRIM(name) = '' THEN NULL
                  ELSE LEFT(BTRIM(name), 1) || '.'
                END AS name,
                region, zip, status,
                source, created_at, updated_at, status_changed_at
         FROM leads ${where}
         ORDER BY created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      const count = await db.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM leads ${where}`,
        params.slice(0, -2),
      );
      return { ok: true, leads: result.rows, total: parseInt(count.rows[0]?.total ?? '0', 10) };
    }),

  getLeadReport: operationsAdminProcedure
    .input(z.object({ days: z.number().int().min(1).max(90).default(1) }))
    .query(async ({ input }) => {
      const since = await db.query<{
        total: string;
        completed: string;
        qualified_hustlers: string;
        form_submits: string;
      }>(
        `SELECT
           COUNT(*)::text AS total,
           COUNT(*) FILTER (WHERE status IN ('completed','won','converted'))::text AS completed,
           COUNT(*) FILTER (WHERE lead_type = 'hustler' AND status IN ('approved','qualified'))::text AS qualified_hustlers,
           COUNT(*)::text AS form_submits
         FROM leads
         WHERE created_at >= now() - ($1::text || ' days')::interval`,
        [String(input.days)],
      );
      const byStatus = await db.query<{ status: string; count: string }>(
        `SELECT status, COUNT(*)::text AS count FROM leads
         WHERE created_at >= now() - ($1::text || ' days')::interval
         GROUP BY status`,
        [String(input.days)],
      );
      const row = since.rows[0];
      const by_status: Record<string, number> = {};
      for (const s of byStatus.rows) by_status[s.status] = Number(s.count) || 0;
      return {
        ok: true,
        report: {
          leads: {
            total: Number(row?.total ?? 0) || 0,
            completed: Number(row?.completed ?? 0) || 0,
            qualified_hustlers: Number(row?.qualified_hustlers ?? 0) || 0,
            by_status,
          },
          funnel: { form_submits: Number(row?.form_submits ?? 0) || 0 },
        },
      };
    }),

  /** Single Command-center join: funnel pointers + canonical engine tasks (replaces engine-bridge hop). */
  getCommandEngineJoin: operationsAdminProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(100),
      cursor: z.string().max(512).nullish(),
    }))
    .query(async ({ input }) => {
      const engine = await AutomationLifecycleService.listTasks({
        limit: input.limit,
        cursor: input.cursor,
      });
      if (!engine.success) {
        throw new TRPCError({
          code: engine.error.code === 'INVALID_CURSOR' ? 'BAD_REQUEST' : 'INTERNAL_SERVER_ERROR',
          message: engine.error.message,
        });
      }

      const pointers = await db.query(
        `SELECT q.id, q.lead_id, q.title, q.status, q.active_version_id,
                q.created_at, q.updated_at, q.task_draft_id,
                d.id AS draft_id, d.category AS draft_category, d.zip AS draft_zip, d.status AS draft_status
         FROM quotes q
         LEFT JOIN task_drafts d ON d.quote_id = q.id
         ORDER BY q.updated_at DESC NULLS LAST
         LIMIT $1`,
        [input.limit],
      );

      const tasks = engine.data.tasks as Array<Record<string, unknown>>;

      // Railway quotes may not yet store engine_task_id; return engine tasks for KPIs.
      // Pointer rows are context only — never projected as canonical lifecycle truth.
      const rows = pointers.rows.map((pointer) => ({
        pointer,
        engine: null as Record<string, unknown> | null,
        engine_read_blocker: 'ENGINE_TASK_NOT_CREATED',
      }));

      return {
        ok: true,
        engine_read_state: 'CANONICAL_E1',
        engine_next_cursor: engine.data.nextCursor,
        rows,
        engine_orphans: tasks,
        engine_tasks: tasks.map((task) => ({
          engineTaskId: task.engineTaskId,
          lifecycleState: task.lifecycleState ?? null,
          payoutState: task.payoutState ?? null,
          refundState: task.refundState ?? null,
          blockerCode: task.blockerCode ?? null,
        })),
      };
    }),

  // ── Feature flags ────────────────────────────────────────────────────────────

  getPublicFlags: publicProcedure
    .input(z.object({}).optional())
    .query(async () => {
      // API contract always returns `key` (Supabase parity). DB column is `name`;
      // after 20260819_ops_web_hardening, `key` is kept in sync with `name`.
      try {
        const withKey = await db.query<{ key: string; enabled: boolean }>(
          `SELECT COALESCE(key, name) AS key, enabled FROM feature_flags ORDER BY COALESCE(key, name)`,
        );
        return withKey.rows;
      } catch {
        const result = await db.query<{ key: string; enabled: boolean }>(
          `SELECT name AS key, enabled FROM feature_flags ORDER BY name`,
        );
        return result.rows;
      }
    }),

  updateFlag: operationsAdminProcedure
    .input(z.object({
      key: z.string().min(1).max(200),
      enabled: z.boolean(),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        await db.query(
          `INSERT INTO feature_flags (name, key, enabled)
           VALUES ($1, $1, $2)
           ON CONFLICT (name) DO UPDATE SET enabled = $2, key = EXCLUDED.key, updated_at = now()`,
          [input.key, input.enabled],
        );
      } catch {
        await db.query(
          `INSERT INTO feature_flags (name, enabled)
           VALUES ($1, $2)
           ON CONFLICT (name) DO UPDATE SET enabled = $2, updated_at = now()`,
          [input.key, input.enabled],
        );
      }
      await recordOpsAudit({
        actorUserId: ctx.user.id,
        action: 'feature_flag_updated',
        targetType: 'feature_flag',
        targetId: input.key,
        meta: { enabled: input.enabled },
      });
      return { ok: true };
    }),
});
