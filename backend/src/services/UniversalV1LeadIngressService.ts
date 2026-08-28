import crypto from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { db, type QueryFn } from '../db.js';
import {
  sanitizeTaskDraftAnswers,
  universalTaskDraftRequestHash,
} from './UniversalV1TaskDraftIngress.js';
import type { UniversalV1LeadIngressInput } from './UniversalV1LeadIngressSchema.js';

export {
  universalV1LeadIngressSchema,
  type UniversalV1LeadIngressInput,
} from './UniversalV1LeadIngressSchema.js';

type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;

export interface UniversalV1LeadIngressContext {
  ip: string | null;
  origin?: string | null;
  userAgent?: string | null;
}

interface TurnstileResult {
  success: boolean;
  action?: string;
  hostname?: string;
  'error-codes'?: string[];
  metadata?: { result_with_testing_key?: boolean };
}

interface LeadRow {
  id: string;
  submission_id: string;
  status: string;
  ingress_request_hash: string | null;
}

export interface LeadIngressDependencies {
  env: Environment;
  fetch: typeof globalThis.fetch;
  now: () => number;
  randomUuid: () => string;
  query: QueryFn;
  transaction: typeof db.serializableTransaction;
}

export type UniversalV1LeadIngressResult =
  | {
    ok: true;
    submission_id: string;
    lead_id: string;
    status: 'new' | 'replayed';
    correlation_id: string;
  }
  | { ok: false; code: 'rejected'; correlation_id: string }
  | { ok: false; code: 'rate_limited'; retry_after_seconds: number; correlation_id: string };

const defaultDependencies: LeadIngressDependencies = {
  env: process.env,
  fetch: globalThis.fetch,
  now: Date.now,
  randomUuid: crypto.randomUUID,
  query: db.query,
  transaction: db.serializableTransaction,
};

function exactPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? '');
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function hashWithSalt(value: string, env: Environment): string {
  const salt = env.LEAD_PRIVACY_HASH_SALT?.trim() ?? '';
  if (salt.length < 16) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Lead privacy hashing is not configured',
    });
  }
  return crypto.createHash('sha256').update(`${salt}:${value}`, 'utf8').digest('hex');
}

function allowedTurnstileHostnames(env: Environment): Set<string> {
  const origins = (env.ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);
  return new Set(origins.flatMap((origin) => {
    try { return [new URL(origin).hostname.toLowerCase()]; } catch { return []; }
  }));
}

function testTurnstileEvidenceAllowed(env: Environment): boolean {
  const environment = env.HX_ENVIRONMENT?.trim().toLowerCase() ?? '';
  const explicitTestEvidence = env.TURNSTILE_ALLOW_TEST_BYPASS === 'true'
    || env.HX_HUMAN_VERIFICATION_MODE === 'synthetic';
  return explicitTestEvidence
    && ['development', 'local', 'test', 'preview', 'staging'].includes(environment);
}

function humanVerificationTarget(env: Environment): { url: string; secret: string } | null {
  if (env.HX_HUMAN_VERIFICATION_MODE === 'synthetic') {
    if (!testTurnstileEvidenceAllowed(env)) return null;
    const secret = env.HX_HUMAN_VERIFICATION_SECRET?.trim() ?? '';
    try {
      const url = new URL(env.HX_HUMAN_VERIFICATION_URL?.trim() ?? '');
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || secret.length < 16) {
        return null;
      }
      return { url: url.toString(), secret };
    } catch {
      return null;
    }
  }
  const secret = env.TURNSTILE_SECRET_KEY?.trim() ?? '';
  return secret
    ? { url: 'https://challenges.cloudflare.com/turnstile/v0/siteverify', secret }
    : null;
}

async function verifyTurnstile(
  token: string,
  ip: string | null,
  dependencies: LeadIngressDependencies,
): Promise<TurnstileResult> {
  const target = humanVerificationTarget(dependencies.env);
  if (!target) return { success: false, 'error-codes': ['invalid-verification-provider'] };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await dependencies.fetch(
      target.url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          secret: target.secret,
          response: token,
          ...(ip ? { remoteip: ip } : {}),
        }),
        signal: controller.signal,
      },
    );
    if (!response.ok) return { success: false, 'error-codes': [`http_${response.status}`] };
    return await response.json() as TurnstileResult;
  } catch (error) {
    return {
      success: false,
      'error-codes': [error instanceof Error ? error.name : 'fetch_error'],
    };
  } finally {
    clearTimeout(timeout);
  }
}

function acceptedTurnstile(result: TurnstileResult, env: Environment): boolean {
  const isTestKey = result.metadata?.result_with_testing_key === true;
  const allowedHostnames = allowedTurnstileHostnames(env);
  const hostnameOk = isTestKey
    ? testTurnstileEvidenceAllowed(env)
    : !result.hostname || allowedHostnames.has(result.hostname.toLowerCase());
  return result.success && (!result.action || result.action === 'lead') && hostnameOk;
}

function requestHash(input: UniversalV1LeadIngressInput): string {
  return universalTaskDraftRequestHash({
    submissionId: input.submission_id,
    leadType: input.lead_type,
    email: input.email.trim().toLowerCase(),
    name: input.name.trim(),
    phone: input.phone?.trim() ?? null,
    region: input.region?.trim() ?? null,
    zip: input.zip ?? null,
    answers: sanitizeTaskDraftAnswers(input.answers ?? {}),
    utm: input.utm ?? {},
    consentVersion: input.consent_version,
    draftSubmissionId: input.draft_submission_id ?? null,
  });
}

async function assertIngressProof(
  input: UniversalV1LeadIngressInput,
  context: UniversalV1LeadIngressContext,
  dependencies: LeadIngressDependencies,
): Promise<string> {
  if (input.draft_submission_id && input.draft_card_token) {
    const result = await dependencies.query<{ id: string }>(
      `SELECT id FROM task_drafts
        WHERE submission_id = $1
          AND card_token_hash = $2
          AND universal_contract_version = 1
          AND status IN ('anonymous_task_draft', 'contact_captured')
        LIMIT 1`,
      [
        input.draft_submission_id,
        crypto.createHash('sha256').update(input.draft_card_token).digest('hex'),
      ],
    );
    if (!result.rows[0]) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'TaskDraft capability is invalid' });
    }
    return 'draft-proof';
  }
  const result = await verifyTurnstile(input.turnstile_token!, context.ip, dependencies);
  if (!acceptedTurnstile(result, dependencies.env)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Bot check failed' });
  }
  return result.action ?? 'lead';
}

function normalizedLeadValues(input: UniversalV1LeadIngressInput) {
  return {
    email: input.email.trim().toLowerCase(),
    name: input.name.trim(),
    phone: input.phone?.trim() ?? null,
    region: input.region?.trim() || null,
    answers: sanitizeTaskDraftAnswers(input.answers ?? {}),
    utm: input.utm ?? {},
  };
}

function retryableSerializationFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return error.code === '40001' || error.code === '40P01';
}

async function serializableLeadTransaction<T>(
  dependencies: LeadIngressDependencies,
  callback: (query: QueryFn) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await dependencies.transaction(callback);
    } catch (error) {
      if (!retryableSerializationFailure(error) || attempt === 3) throw error;
    }
  }
  throw new Error('Lead transaction retry boundary was exhausted');
}

async function queueConfirmation(
  query: QueryFn,
  row: LeadRow,
  input: UniversalV1LeadIngressInput,
  normalized: ReturnType<typeof normalizedLeadValues>,
): Promise<void> {
  const idempotencyKey = `lead-confirm:${input.submission_id}:v1`;
  const email = await query<{ id: string }>(
    `INSERT INTO email_outbox (
       user_id, lead_id, to_email, template, params_json, status, idempotency_key
     ) VALUES (NULL, $1, $2, 'lead_confirmation', $3::jsonb, 'pending', $4)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      row.id,
      normalized.email,
      JSON.stringify({ leadType: input.lead_type, firstName: normalized.name.split(/\s+/u)[0] }),
      idempotencyKey,
    ],
  );
  if (!email.rows[0]) return;
  await query(
    `INSERT INTO outbox_events (
       event_type, aggregate_type, aggregate_id, event_version,
       idempotency_key, payload, queue_name, status
     ) VALUES ('email.send_requested', 'lead', $1, 1, $2, $3::jsonb, 'user_notifications', 'pending')
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      row.id,
      idempotencyKey,
      JSON.stringify({
        emailId: email.rows[0].id,
        toEmail: normalized.email,
        template: 'lead_confirmation',
        params: { leadType: input.lead_type, firstName: normalized.name.split(/\s+/u)[0] },
      }),
    ],
  );
}

async function persistLead(
  input: UniversalV1LeadIngressInput,
  context: UniversalV1LeadIngressContext,
  turnstileAction: string,
  correlationId: string,
  dependencies: LeadIngressDependencies,
): Promise<UniversalV1LeadIngressResult> {
  const normalized = normalizedLeadValues(input);
  const ingressRequestHash = requestHash(input);
  const ipHash = context.ip ? hashWithSalt(context.ip, dependencies.env) : null;
  const userAgentHash = context.userAgent
    ? hashWithSalt(context.userAgent, dependencies.env)
    : null;
  const limit = exactPositiveInteger(dependencies.env.LEAD_RATE_LIMIT_PER_IP_TYPE_HOUR, 10);
  return serializableLeadTransaction(dependencies, async (query) => {
    const existing = await query<LeadRow>(
      `SELECT id, submission_id, status, ingress_request_hash
         FROM leads WHERE submission_id = $1 FOR UPDATE`,
      [input.submission_id],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].ingress_request_hash
        && existing.rows[0].ingress_request_hash !== ingressRequestHash) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Submission identity was already used for different lead content',
        });
      }
      return {
        ok: true,
        submission_id: input.submission_id,
        lead_id: existing.rows[0].id,
        status: 'replayed',
        correlation_id: correlationId,
      };
    }
    if (ipHash) {
      await query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `lead-ingress:${input.lead_type}:${ipHash}`,
      ]);
      const rate = await query<{ count: string; retry_after_seconds: number | string }>(
        `SELECT COUNT(*)::text AS count,
                GREATEST(1, CEIL(EXTRACT(EPOCH FROM (
                  MIN(created_at) + INTERVAL '1 hour' - clock_timestamp()
                ))))::integer AS retry_after_seconds
           FROM leads
          WHERE ip_hash = $1 AND lead_type = $2
            AND created_at > clock_timestamp() - INTERVAL '1 hour'`,
        [ipHash, input.lead_type],
      );
      if (Number(rate.rows[0]?.count ?? 0) >= limit) {
        return {
          ok: false,
          code: 'rate_limited',
          retry_after_seconds: Math.max(1, Number(rate.rows[0]?.retry_after_seconds ?? 3_600)),
          correlation_id: correlationId,
        };
      }
    }
    const inserted = await query<LeadRow>(
      `INSERT INTO leads (
         submission_id, lead_type, email, name, phone, region, zip,
         answers, utm, consent_version, ip_hash, user_agent_hash,
         correlation_id, ingress_request_hash, ingress_contract_version,
         execution_environment, turnstile_action
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,1,$15,$16)
       RETURNING id, submission_id, status, ingress_request_hash`,
      [
        input.submission_id,
        input.lead_type,
        normalized.email,
        normalized.name,
        normalized.phone,
        normalized.region,
        input.zip ?? null,
        JSON.stringify({
          ...normalized.answers,
          ...(input.draft_submission_id
            ? { task_draft_submission_id: input.draft_submission_id }
            : {}),
        }),
        JSON.stringify(normalized.utm),
        input.consent_version,
        ipHash,
        userAgentHash,
        correlationId,
        ingressRequestHash,
        dependencies.env.HX_ENVIRONMENT?.trim().toLowerCase()
          || dependencies.env.NODE_ENV?.trim().toLowerCase()
          || 'development',
        turnstileAction,
      ],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error('Lead insert did not return a durable row');
    await queueConfirmation(query, row, input, normalized);
    return {
      ok: true,
      submission_id: input.submission_id,
      lead_id: row.id,
      status: 'new',
      correlation_id: correlationId,
    };
  });
}

export async function submitUniversalV1Lead(
  input: UniversalV1LeadIngressInput,
  context: UniversalV1LeadIngressContext,
  overrides: Partial<LeadIngressDependencies> = {},
): Promise<UniversalV1LeadIngressResult> {
  const dependencies = {
    ...defaultDependencies,
    env: process.env,
    fetch: globalThis.fetch,
    ...overrides,
  };
  const correlationId = dependencies.randomUuid();
  if (input.company_url?.trim() || input.hp_email?.trim()) {
    return { ok: false, code: 'rejected', correlation_id: correlationId };
  }
  if (Math.abs(dependencies.now() - input.client_ts) > 10 * 60 * 1_000) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Request timestamp too far from server time' });
  }
  const turnstileAction = await assertIngressProof(input, context, dependencies);
  return persistLead(input, context, turnstileAction, correlationId, dependencies);
}
