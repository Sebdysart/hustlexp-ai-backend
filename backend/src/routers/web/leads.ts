/**
 * Web Leads & Surveys Router
 *
 * Replaces Supabase edge functions: lead-submit, survey-submit
 * Public endpoints — no Firebase auth required, rate-limited via middleware.
 */

import { z } from 'zod';
import {
  heldOperationsAdminProcedure,
  operationsAdminProcedure,
  publicProcedure,
  router,
} from '../../trpc.js';
import { db } from '../../db.js';
import { logger } from '../../logger.js';
import { TRPCError } from '@trpc/server';
import crypto from 'node:crypto';
import {
  submitUniversalV1Lead,
  universalV1LeadIngressSchema,
  type UniversalV1LeadIngressInput,
} from '../../services/UniversalV1LeadIngressService.js';
import type { Context } from '../../trpc-context.js';

const log = logger.child({ router: 'web.leads' });
const LEGACY_MUTATION_HELD_MESSAGE =
  'Legacy lead administration writes are held. Use a separately approved, versioned two-person command path.';

function holdLegacyMutation(): never {
  throw new TRPCError({ code: 'PRECONDITION_FAILED', message: LEGACY_MUTATION_HELD_MESSAGE });
}

// ── Turnstile verification ────────────────────────────────────────────────────

async function verifySurveyTurnstile(token: string, ip?: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) {
    log.warn('TURNSTILE_SECRET_KEY is required for public lead ingress');
    return false;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const data = await res.json() as { success: boolean };
    return data.success === true;
  } catch (error) {
    log.warn({ err: error instanceof Error ? error.message : String(error) }, 'Turnstile verification request failed');
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function hashValue(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// ── Schemas ───────────────────────────────────────────────────────────────────

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
  hp_email: z.string().max(512).optional(),
  client_ts: z.number(),
});

type SurveyInput = z.infer<typeof SurveySchema>;

function assertFreshRequest(clientTs: number): void {
  if (Math.abs(Date.now() - clientTs) > 10 * 60 * 1000) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Request timestamp too far from server time' });
  }
}

async function assertHuman(token: string, ip?: string): Promise<void> {
  if (!await verifySurveyTurnstile(token, ip)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Bot check failed' });
  }
}

async function handleSubmitLead({
  input,
  ctx,
}: {
  input: UniversalV1LeadIngressInput;
  ctx: Context;
}) {
  const result = await submitUniversalV1Lead(input, {
    ip: ctx.ip,
    origin: ctx.origin,
    userAgent: ctx.userAgent,
  });
  if (!result.ok && result.code === 'rate_limited') {
    ctx.responseHeaders?.set('retry-after', String(result.retry_after_seconds));
    throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Lead submission rate limited' });
  }
  if (result.ok) {
    log.info({ leadId: result.lead_id, leadType: input.lead_type, status: result.status }, 'Lead submitted');
  }
  return result;
}

async function persistSurvey(input: SurveyInput, ipHash: string | null, correlationId: string) {
  await db.query(
    `INSERT INTO surveys (
      submission_id, role, email, name, phone, region, country,
      zip_code, intent_tags, raw_payload, utm, consent_version,
      ip_hash, correlation_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10::jsonb,$11::jsonb,$12,$13,$14)
    ON CONFLICT (submission_id) DO UPDATE SET updated_at = now()`,
    [
      input.submission_id, input.role, input.email?.trim().toLowerCase() ?? null,
      input.name?.trim() ?? null, input.phone?.trim() ?? null, input.region ?? null,
      input.country ?? null, input.zip_code ?? null, input.intent_tags,
      JSON.stringify({ role: input.role, free_text: input.free_text }), JSON.stringify(input.utm),
      input.consent_version, ipHash, correlationId,
    ]
  );
}

async function handleSubmitSurvey({ input, ctx }: { input: SurveyInput; ctx: { ip: string | null } }) {
  if (input.hp_email) return { ok: true, submission_id: input.submission_id, role: input.role };
  assertFreshRequest(input.client_ts);
  const ip = ctx.ip ?? undefined;
  await assertHuman(input.turnstile_token, ip);
  const correlationId = crypto.randomUUID();
  await persistSurvey(input, ip ? hashValue(ip) : null, correlationId);
  log.info({ role: input.role }, 'Survey submitted');
  return { ok: true, submission_id: input.submission_id, role: input.role, correlation_id: correlationId };
}

// ── Router ────────────────────────────────────────────────────────────────────

export const webLeadsRouter = router({

  submitLead: publicProcedure
    .input(universalV1LeadIngressSchema)
    .mutation(handleSubmitLead),

  submitSurvey: publicProcedure
    .input(SurveySchema)
    .mutation(handleSubmitSurvey),

  // ── Admin reads ─────────────────────────────────────────────────────────────

  listLeads: operationsAdminProcedure
    .input(z.object({
      status: z.string().optional(),
      leadType: z.string().optional(),
      limit: z.number().min(1).max(200).default(50),
      offset: z.number().min(0).default(0),
    }))
    .query(async ({ input }) => {
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

  updateLead: heldOperationsAdminProcedure
    .input(z.object({
      id: z.string().uuid(),
      status: z.string().optional(),
      notes: z.string().optional(),
      assigned_to: z.string().optional(),
    }))
    .mutation(holdLegacyMutation),

  getSurveyStats: operationsAdminProcedure
    .input(z.object({}))
    .query(async () => {
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
