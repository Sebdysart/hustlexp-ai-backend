/**
 * Action Links Router
 *
 * Replaces Supabase edge functions: action-link-public, action-link-admin
 *
 * Public  — /api/action-link?token=<token>  (GET resolve, POST act)
 * Admin   — tRPC procedures gated by OPS_ADMIN_KEY
 */

import { z } from 'zod';
import { router, publicProcedure } from '../../trpc.js';
import { db } from '../../db.js';
import { logger } from '../../logger.js';
import { TRPCError } from '@trpc/server';
import crypto from 'crypto';

const log = logger.child({ router: 'web.actionLinks' });

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString('hex');
  return { raw, hash: hashToken(raw) };
}

function isExpired(expiresAt: Date): boolean {
  return new Date() > expiresAt;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ActionLinkRow {
  id: string;
  link_type: string;
  role: string;
  status: string;
  expires_at: Date;
  allowed_actions: string[];
  metadata: Record<string, unknown>;
}

function buildDisplay(link: ActionLinkRow): Record<string, unknown> {
  const m = link.metadata;
  if (link.role === 'hustler') {
    return {
      headline: (m.title as string) ?? 'Possible HustleXP job',
      greeting: 'Hey —',
      title: m.title,
      summary: m.summary,
      area_label: m.area_label,
      eta_label: m.eta_label,
      payout_label: m.payout_label,
      requirements: m.requirements,
      payment_status: m.payment_status,
      assignment_status: m.assignment_status,
      connect_status: m.connect_status,
      trust_note: 'Do not start until payment is confirmed and HustleXP marks you assigned.',
    };
  }
  return {
    title: m.title,
    summary: m.summary,
    scope_checklist: m.scope_checklist,
    payment_status_label: m.payment_status_label ?? 'Waiting for payment',
    next_step: m.next_step,
    helper_readiness: m.helper_readiness,
    pay_url: m.pay_url,
    trust: m.trust,
  };
}

// ── Router ────────────────────────────────────────────────────────────────────

export const webActionLinksRouter = router({

  // ── Admin: create action link ───────────────────────────────────────────────
  create: publicProcedure
    .input(z.object({
      adminKey: z.string(),
      link_type: z.enum(['hustler_activation', 'poster_scope']),
      lead_id: z.string().uuid().optional(),
      hustler_id: z.string().uuid().optional(),
      task_id: z.string().uuid().optional(),
      quote_id: z.string().uuid().optional(),
      ttl_hours: z.number().min(1).max(720).default(72),
      created_by: z.string().optional(),
      // Metadata fields
      title: z.string().optional(),
      summary: z.string().optional(),
      area_label: z.string().optional(),
      eta_label: z.string().optional(),
      payout_label: z.string().optional(),
      payout_cents: z.number().optional(),
      requirements: z.array(z.string()).optional(),
      payment_status: z.string().optional(),
      assignment_status: z.string().optional(),
      connect_status: z.string().optional(),
      scope_checklist: z.array(z.string()).optional(),
      payment_status_label: z.string().optional(),
      next_step: z.string().optional(),
      helper_readiness: z.string().optional(),
      pay_url: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      if (input.adminKey !== process.env.OPS_ADMIN_KEY) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Invalid admin key' });
      }

      const role = input.link_type === 'hustler_activation' ? 'hustler' : 'poster';
      const allowed = role === 'hustler'
        ? ['available_yes', 'available_tomorrow', 'decline', 'start_payout_setup', 'need_helper', 'need_details']
        : ['confirm_scope', 'accept_quote', 'pay', 'ask_question'];

      const { raw, hash } = generateToken();
      const expiresAt = new Date(Date.now() + input.ttl_hours * 3600 * 1000);

      const metadata: Record<string, unknown> = {};
      const metaFields = ['title','summary','area_label','eta_label','payout_label','payout_cents',
        'requirements','payment_status','assignment_status','connect_status',
        'scope_checklist','payment_status_label','next_step','helper_readiness','pay_url'] as const;
      for (const f of metaFields) {
        if (input[f] !== undefined) metadata[f] = input[f];
      }

      const result = await db.query<{ id: string }>(
        `INSERT INTO action_links
          (link_type, role, lead_id, hustler_id, task_id, quote_id,
           token_hash, allowed_actions, expires_at, metadata, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9,$10::jsonb,$11)
         RETURNING id`,
        [
          input.link_type, role,
          input.lead_id ?? null, input.hustler_id ?? null,
          input.task_id ?? null, input.quote_id ?? null,
          hash, allowed, expiresAt,
          JSON.stringify(metadata),
          input.created_by ?? null,
        ]
      );

      const id = result.rows[0].id;
      const siteUrl = process.env.SITE_URL ?? 'https://hustlexp.app';
      const url = `${siteUrl}/go/${raw}`;

      log.info({ linkId: id, linkType: input.link_type }, 'Action link created');
      return { ok: true, id, token: raw, url };
    }),

  // ── Admin: list links ───────────────────────────────────────────────────────
  list: publicProcedure
    .input(z.object({
      adminKey: z.string(),
      status: z.string().optional(),
      hustler_id: z.string().uuid().optional(),
      limit: z.number().min(1).max(100).default(50),
    }))
    .query(async ({ input }) => {
      if (input.adminKey !== process.env.OPS_ADMIN_KEY) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Invalid admin key' });
      }

      const conditions: string[] = [];
      const params: unknown[] = [];
      if (input.status) conditions.push(`status = $${params.push(input.status)}`);
      if (input.hustler_id) conditions.push(`hustler_id = $${params.push(input.hustler_id)}`);
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(input.limit);

      const result = await db.query(
        `SELECT id, link_type, role, lead_id, hustler_id, task_id,
                allowed_actions, expires_at, status, metadata, created_by,
                created_at, last_opened_at, updated_at
         FROM action_links ${where}
         ORDER BY created_at DESC LIMIT $${params.length}`,
        params
      );

      return { ok: true, links: result.rows };
    }),

  // ── Admin: update status ────────────────────────────────────────────────────
  updateStatus: publicProcedure
    .input(z.object({
      adminKey: z.string(),
      id: z.string().uuid(),
      status: z.enum(['link_created', 'link_sent', 'link_opened', 'action_taken', 'expired']),
    }))
    .mutation(async ({ input }) => {
      if (input.adminKey !== process.env.OPS_ADMIN_KEY) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Invalid admin key' });
      }
      await db.query(
        `UPDATE action_links SET status = $1, updated_at = now() WHERE id = $2`,
        [input.status, input.id]
      );
      return { ok: true };
    }),
});

// ── Public Hono handler (called from server.ts) ───────────────────────────────
// This is a raw handler because action-link-public must be fully unauthenticated.

export async function handleActionLinkGet(token: string): Promise<{
  ok: boolean; link?: object; code?: string;
}> {
  if (!token) return { ok: false, code: 'missing_token' };

  const hash = hashToken(token);
  const result = await db.query<ActionLinkRow>(
    `SELECT id, link_type, role, status, expires_at, allowed_actions, metadata
     FROM action_links WHERE token_hash = $1`,
    [hash]
  );

  if (result.rows.length === 0) return { ok: false, code: 'not_found' };
  const link = result.rows[0];

  if (isExpired(link.expires_at)) {
    await db.query(
      `UPDATE action_links SET status = 'expired', updated_at = now() WHERE id = $1`,
      [link.id]
    );
    return { ok: false, code: 'expired' };
  }

  // Mark opened
  await db.query(
    `UPDATE action_links SET last_opened_at = now(), updated_at = now(),
       status = CASE WHEN status = 'link_created' OR status = 'link_sent'
                     THEN 'link_opened' ELSE status END
     WHERE id = $1`,
    [link.id]
  );

  return {
    ok: true,
    link: {
      link_type: link.link_type,
      role: link.role,
      status: link.status,
      expires_at: link.expires_at,
      allowed_actions: link.allowed_actions,
      display: buildDisplay(link),
    },
  };
}

export async function handleActionLinkPost(token: string, action: string): Promise<{
  ok: boolean; status?: string; code?: string;
}> {
  if (!token || !action) return { ok: false, code: 'missing_params' };

  const hash = hashToken(token);
  const result = await db.query<ActionLinkRow>(
    `SELECT id, link_type, role, status, expires_at, allowed_actions, metadata
     FROM action_links WHERE token_hash = $1`,
    [hash]
  );

  if (result.rows.length === 0) return { ok: false, code: 'not_found' };
  const link = result.rows[0];

  if (isExpired(link.expires_at)) return { ok: false, code: 'expired' };
  if (!link.allowed_actions.includes(action)) return { ok: false, code: 'action_not_allowed' };

  // Record event
  await db.query(
    `INSERT INTO action_link_events (action_link_id, event_type, payload)
     VALUES ($1, $2, $3::jsonb)`,
    [link.id, action, JSON.stringify({ action })]
  );

  await db.query(
    `UPDATE action_links SET status = 'action_taken', updated_at = now() WHERE id = $1`,
    [link.id]
  );

  log.info({ linkId: link.id, action }, 'Action link action taken');
  return { ok: true, status: 'action_taken' };
}
