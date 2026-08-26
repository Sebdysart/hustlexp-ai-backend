/**
 * Web Leads & Surveys Router
 *
 * Replaces Supabase edge functions: lead-submit, survey-submit
 * Public acquisition endpoints only — no administrative reads or writes.
 * Operator workflows are owned by authenticated webOps procedures.
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
    const production = process.env.NODE_ENV === 'production';
    log.warn({ production }, 'TURNSTILE_SECRET_KEY not set');
    return !production;
  }
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
    });
    const data = await res.json() as { success: boolean };
    return data.success === true;
  } catch (error) {
    log.warn({ err: error instanceof Error ? error.message : String(error) }, 'Turnstile verification request failed');
    return false;
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
  company_url: z.string().max(512).optional(),
  hp_email: z.string().max(512).optional(),
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
  hp_email: z.string().max(512).optional(),
  client_ts: z.number(),
});

type LeadInput = z.infer<typeof LeadSchema>;
type SurveyInput = z.infer<typeof SurveySchema>;

function assertFreshRequest(clientTs: number): void {
  if (Math.abs(Date.now() - clientTs) > 10 * 60 * 1000) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Request timestamp too far from server time' });
  }
}

async function assertHuman(token: string, ip?: string): Promise<void> {
  if (!await verifyTurnstile(token, ip)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Bot check failed' });
  }
}

async function persistLead(input: LeadInput, ipHash: string | null, correlationId: string) {
  const result = await db.query<{ id: string; status: string }>(
    `INSERT INTO leads (
      submission_id, lead_type, email, name, phone, region, zip,
      answers, utm, consent_version, ip_hash, correlation_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12)
    ON CONFLICT (submission_id) DO UPDATE SET updated_at = now()
    RETURNING id, status`,
    [
      input.submission_id, input.lead_type, input.email.trim().toLowerCase(),
      input.name?.trim() ?? null, input.phone?.trim() ?? null, input.region ?? null,
      input.zip ?? null, JSON.stringify(input.answers), JSON.stringify(input.utm ?? {}),
      input.consent_version, ipHash, correlationId,
    ]
  );
  return result.rows[0];
}

async function handleSubmitLead({ input, ctx }: { input: LeadInput; ctx: { ip: string | null } }) {
  if (input.company_url || input.hp_email) {
    return { ok: true, submission_id: input.submission_id, status: 'replayed' };
  }
  assertFreshRequest(input.client_ts);
  const ip = ctx.ip ?? undefined;
  await assertHuman(input.turnstile_token, ip);
  const correlationId = crypto.randomUUID();
  const row = await persistLead(input, ip ? hashValue(ip) : null, correlationId);
  log.info({ leadId: row.id, leadType: input.lead_type }, 'Lead submitted');
  return {
    ok: true,
    submission_id: input.submission_id,
    lead_id: row.id,
    status: row.status,
    correlation_id: correlationId,
  };
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
    .input(LeadSchema)
    .mutation(handleSubmitLead),

  submitSurvey: publicProcedure
    .input(SurveySchema)
    .mutation(handleSubmitSurvey),

});
