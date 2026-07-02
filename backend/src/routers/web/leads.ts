/**
 * Web Leads & Surveys Router
 *
 * Replaces Supabase edge functions: lead-submit, survey-submit
 * Public endpoints — no Firebase auth required, rate-limited via middleware.
 */

import { z } from 'zod';
import { router, publicProcedure } from '../../trpc.js';
import { db } from '../../db.js';
import { logger } from '../../logger.js';
import { TRPCError } from '@trpc/server';
import crypto from 'crypto';

const log = logger.child({ router: 'web.leads' });

// ── Turnstile verification ────────────────────────────────────────────────────

async function verifyTurnstile(token: string, ip?: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    // No secret configured — skip verification in dev
    log.warn('TURNSTILE_SECRET_KEY not set — skipping bot check');
    return true;
  }
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
    });
    const data = await res.json() as { success: boolean };
    return data.success === true;
  } catch {
    log.warn('Turnstile verification request failed — allowing through');
    return true;
  }
}

function hashValue(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const LeadSchema = z.object({
  submission_id: z.string().uuid(),
  lead_type: z.enum(['poster', 'hustler', 'business', 'founder']),
  email: z.string().email().max(254),
  name: z.string().max(200).optional(),
  phone: z.string().max(30).optional(),
  region: z.string().max(100).optional(),
  zip: z.string().max(20).optional(),
  answers: z.record(z.unknown()).default({}),
  utm: z.record(z.unknown()).optional(),
  consent_version: z.literal('v1'),
  turnstile_token: z.string().min(1),
  // Honeypots — must be empty
  company_url: z.string().max(0).optional(),
  hp_email: z.string().max(0).optional(),
  client_ts: z.number(),
});

const SurveySchema = z.object({
  submission_id: z.string().uuid(),
  role: z.enum(['customer', 'hustler', 'waitlist']),
  email: z.string().email().max(254).optional(),
  name: z.string().max(200).optional(),
  phone: z.string().max(30).optional(),
  region: z.string().max(100).optional(),
  country: z.string().max(100).optional(),
  zip_code: z.string().max(20).optional(),
  intent_tags: z.array(z.string()).default([]),
  free_text: z.string().max(2000).optional(),
  utm: z.record(z.unknown()).default({}),
  consent_version: z.literal('v1'),
  turnstile_token: z.string().min(1),
  hp_email: z.string().max(0).optional(),
  client_ts: z.number(),
});

// ── Router ────────────────────────────────────────────────────────────────────

export const webLeadsRouter = router({

  submitLead: publicProcedure
    .input(LeadSchema)
    .mutation(async ({ input, ctx }) => {
      const ip = (ctx as any).ip as string | undefined;

      // Honeypot check
      if (input.company_url || input.hp_email) {
        // Silent success — bots don't know they failed
        return { ok: true, submission_id: input.submission_id, status: 'replayed' };
      }

      // Clock skew guard (±10 minutes)
      const skewMs = Math.abs(Date.now() - input.client_ts);
      if (skewMs > 10 * 60 * 1000) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Request timestamp too far from server time' });
      }

      // Turnstile
      const valid = await verifyTurnstile(input.turnstile_token, ip);
      if (!valid) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Bot check failed' });
      }

      const correlationId = crypto.randomUUID();
      const ipHash = ip ? hashValue(ip) : null;

      // Idempotent upsert
      const result = await db.query<{ id: string; status: string }>(
        `INSERT INTO leads (
          submission_id, lead_type, email, name, phone, region, zip,
          answers, utm, consent_version, ip_hash, turnstile_action, correlation_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13)
        ON CONFLICT (submission_id) DO UPDATE SET updated_at = now()
        RETURNING id, status`,
        [
          input.submission_id, input.lead_type,
          input.email.trim().toLowerCase(),
          input.name?.trim() ?? null,
          input.phone?.trim() ?? null,
          input.region ?? null,
          input.zip ?? null,
          JSON.stringify(input.answers),
          JSON.stringify(input.utm ?? {}),
          input.consent_version,
          ipHash,
          'lead',
          correlationId,
        ]
      );

      const row = result.rows[0];
      log.info({ leadId: row.id, leadType: input.lead_type }, 'Lead submitted');

      return {
        ok: true,
        submission_id: input.submission_id,
        lead_id: row.id,
        status: row.status,
        correlation_id: correlationId,
      };
    }),

  submitSurvey: publicProcedure
    .input(SurveySchema)
    .mutation(async ({ input, ctx }) => {
      const ip = (ctx as any).ip as string | undefined;

      if (input.hp_email) {
        return { ok: true, submission_id: input.submission_id, role: input.role };
      }

      const skewMs = Math.abs(Date.now() - input.client_ts);
      if (skewMs > 10 * 60 * 1000) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Request timestamp too far from server time' });
      }

      const valid = await verifyTurnstile(input.turnstile_token, ip);
      if (!valid) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Bot check failed' });
      }

      const correlationId = crypto.randomUUID();
      const ipHash = ip ? hashValue(ip) : null;

      await db.query(
        `INSERT INTO surveys (
          submission_id, role, email, name, phone, region, country,
          zip_code, intent_tags, raw_payload, utm, consent_version,
          ip_hash, turnstile_action, correlation_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10::jsonb,$11::jsonb,$12,$13,$14,$15)
        ON CONFLICT (submission_id) DO UPDATE SET updated_at = now()`,
        [
          input.submission_id, input.role,
          input.email?.trim().toLowerCase() ?? null,
          input.name?.trim() ?? null,
          input.phone?.trim() ?? null,
          input.region ?? null,
          input.country ?? null,
          input.zip_code ?? null,
          input.intent_tags,
          JSON.stringify({ role: input.role, free_text: input.free_text }),
          JSON.stringify(input.utm),
          input.consent_version,
          ipHash,
          'survey',
          correlationId,
        ]
      );

      log.info({ role: input.role }, 'Survey submitted');
      return { ok: true, submission_id: input.submission_id, role: input.role, correlation_id: correlationId };
    }),

  // ── Admin reads ─────────────────────────────────────────────────────────────

  listLeads: publicProcedure
    .input(z.object({
      adminKey: z.string(),
      status: z.string().optional(),
      leadType: z.string().optional(),
      limit: z.number().min(1).max(200).default(50),
      offset: z.number().min(0).default(0),
    }))
    .query(async ({ input }) => {
      if (input.adminKey !== process.env.OPS_ADMIN_KEY) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Invalid admin key' });
      }

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (input.status) { conditions.push(`status = $${params.push(input.status)}`); }
      if (input.leadType) { conditions.push(`lead_type = $${params.push(input.leadType)}`); }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(input.limit, input.offset);

      const result = await db.query(
        `SELECT id, submission_id, lead_type, email, name, phone, region, zip,
                answers, utm, status, notes, assigned_to, source,
                created_at, updated_at, status_changed_at
         FROM leads ${where}
         ORDER BY created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );

      const count = await db.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM leads ${where}`,
        params.slice(0, -2)
      );

      return { ok: true, leads: result.rows, total: parseInt(count.rows[0]?.total ?? '0', 10) };
    }),

  updateLead: publicProcedure
    .input(z.object({
      adminKey: z.string(),
      id: z.string().uuid(),
      status: z.string().optional(),
      notes: z.string().optional(),
      assigned_to: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      if (input.adminKey !== process.env.OPS_ADMIN_KEY) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Invalid admin key' });
      }

      const sets: string[] = ['updated_at = now()'];
      const params: unknown[] = [];

      if (input.status !== undefined) {
        sets.push(`status = $${params.push(input.status)}`);
        sets.push(`status_changed_at = now()`);
      }
      if (input.notes !== undefined) sets.push(`notes = $${params.push(input.notes)}`);
      if (input.assigned_to !== undefined) sets.push(`assigned_to = $${params.push(input.assigned_to)}`);

      params.push(input.id);
      await db.query(
        `UPDATE leads SET ${sets.join(', ')} WHERE id = $${params.length}`,
        params
      );

      return { ok: true };
    }),

  getSurveyStats: publicProcedure
    .input(z.object({ adminKey: z.string() }))
    .query(async ({ input }) => {
      if (input.adminKey !== process.env.OPS_ADMIN_KEY) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Invalid admin key' });
      }

      const result = await db.query<{
        native_1h: string; native_24h: string; native_7d: string; queue_depth: string;
      }>(`
        SELECT
          COUNT(*) FILTER (WHERE created_at > now() - interval '1 hour')::text  AS native_1h,
          COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours')::text AS native_24h,
          COUNT(*) FILTER (WHERE created_at > now() - interval '7 days')::text   AS native_7d,
          COUNT(*) FILTER (WHERE status = 'new')::text                           AS queue_depth
        FROM surveys
      `);

      const r = result.rows[0];
      return {
        native_1h:   parseInt(r?.native_1h  ?? '0', 10),
        native_24h:  parseInt(r?.native_24h ?? '0', 10),
        native_7d:   parseInt(r?.native_7d  ?? '0', 10),
        tally_24h:   0,
        queue_depth: parseInt(r?.queue_depth ?? '0', 10),
        fetchedAt:   new Date().toISOString(),
      };
    }),
});
