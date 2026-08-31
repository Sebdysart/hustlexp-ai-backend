import crypto from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db, type QueryFn } from '../../db.js';
import { logger } from '../../logger.js';
import { protectedProcedure, publicProcedure, router } from '../../trpc.js';
import type { User } from '../../types.js';
import {
  buildUniversalV1TaskDraftRouteContext,
  evaluateUniversalV1TaskDraftRouting,
  isPlausiblyRandomTaskDraftCardToken,
  sanitizeTaskDraftAnswers,
  sanitizeTaskDraftText,
  taskDraftCardTokenHash,
  taskDraftMutationIdempotencyKey,
  UNIVERSAL_V1_WORK_CATEGORY_CODES,
  universalTaskDraftRequestHash,
  type TaskDraftCategory,
  type TaskDraftRoutingDecision,
  type UniversalV1TaskDraftRouteContext,
  type UniversalV1RoutingOutcome,
} from '../../services/UniversalV1TaskDraftIngress.js';
import { resolveUniversalV1ServiceCell } from '../../services/UniversalV1TaskDraftRouteContext.js';
import {
  parseUniversalV1TaskDraft,
  type UniversalV1TaskDraftParse,
} from '../../services/UniversalV1TaskDraftParser.js';
import {
  claimUniversalV1TaskDraft,
  UniversalV1TaskDraftClaimSchema,
} from '../../services/UniversalV1TaskDraftClaim.js';

const log = logger.child({ router: 'web.taskDrafts' });
const MAX_CREATE_PER_IP_HOUR = 20;
type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;

const AnswerValue = z.union([
  z.string().max(2_000),
  z.array(z.string().max(120)).max(24),
  z.boolean(),
  z.number().finite(),
]);

export const UniversalV1TaskDraftIngressSchema = z.object({
  action: z.enum(['create', 'update', 'link_contact']),
  submission_id: z.string().uuid(),
  expected_version: z.number().int().min(0).max(10_000),
  card_token: z.string().regex(/^[0-9a-f]{64}$/iu)
    .refine(isPlausiblyRandomTaskDraftCardToken, 'card token is an obvious low-entropy placeholder'),
  raw_input: z.string().trim().min(1).max(4_000),
  category: z.enum([
    'moving',
    'furniture_assembly',
    'errands',
    'yard',
    'tech',
    'cleaning',
    'handyman',
    'other',
  ]).default('other'),
  answers: z.record(z.string().max(60), AnswerValue)
    .refine((answers) => Object.keys(answers).length <= 24, 'too many answer fields')
    .default({}),
  zip: z.string().regex(/^\d{5}(?:-\d{4})?$/u).optional(),
  region: z.string().trim().max(80).optional(),
  photo_count: z.number().int().min(0).max(20).default(0),
  lead_submission_id: z.string().uuid().optional(),
  consent_version: z.literal('v1'),
  turnstile_token: z.string().min(10).max(2_048).optional(),
  company_url: z.string().max(254).optional(),
  client_ts: z.number().int().positive(),
}).strict().superRefine((value, ctx) => {
  if (value.action === 'create') {
    if (value.expected_version !== 0) {
      ctx.addIssue({ code: 'custom', path: ['expected_version'], message: 'create expects version 0' });
    }
    if (!value.turnstile_token) {
      ctx.addIssue({ code: 'custom', path: ['turnstile_token'], message: 'Turnstile is required for create' });
    }
  } else if (value.expected_version < 1) {
    ctx.addIssue({ code: 'custom', path: ['expected_version'], message: 'mutation expects a durable version' });
  }
  if (value.action === 'link_contact' && !value.lead_submission_id) {
    ctx.addIssue({
      code: 'custom', path: ['lead_submission_id'], message: 'lead submission id is required',
    });
  }
});

export type TaskDraftIngressInput = z.infer<typeof UniversalV1TaskDraftIngressSchema>;

export interface UniversalV1TaskDraftIngressContext {
  ip: string | null;
}

export interface TaskDraftIngressDependencies {
  env: Environment;
  fetch: typeof globalThis.fetch;
  now: () => number;
  randomUuid: () => string;
  transaction: typeof db.transaction;
}

interface HumanVerificationResult {
  success?: unknown;
  action?: unknown;
  hostname?: unknown;
  metadata?: { result_with_testing_key?: unknown };
}

interface DraftRow {
  id: string;
  card_token_hash: string;
  status: string;
  category: TaskDraftCategory;
  zip: string | null;
  lead_id: string | null;
  active_routing_decision_id: string | null;
  decision_version: number | null;
  outcome: UniversalV1RoutingOutcome | null;
  reason_codes: string[] | null;
  policy_version: string | null;
  category_snapshot: string | null;
  service_cell_snapshot: string | null;
  service_cell_authority_id: string | null;
  evidence: Record<string, unknown> | null;
  idempotency_key: string | null;
}

interface RoutingRow {
  id: string;
  decision_version: number;
  outcome: UniversalV1RoutingOutcome;
  reason_codes: string[];
  policy_version: string;
  category_snapshot: string;
  service_cell_snapshot: string | null;
  service_cell_authority_id: string | null;
  evidence: Record<string, unknown>;
  idempotency_key: string;
}

interface RoutingSnapshot {
  categorySnapshot: string;
  serviceCellSnapshot: string | null;
  serviceCellAuthorityId: string | null;
  routeContext: UniversalV1TaskDraftRouteContext | null;
}

export interface UniversalV1TaskDraftRelationshipOrigin {
  id: string;
  kind: 'MARKETPLACE' | 'PROVIDER_OS' | 'BRING_YOUR_OWN_PROVIDER';
  policy_version: 1;
  origin_version: number;
  routing_state: 'ROUTING_READY';
  evidence_digest: string;
}

export interface UniversalTaskDraftIngressSuccess {
  ok: true;
  submission_id: string;
  draft_id: string;
  status: string;
  version: number;
  replayed: boolean;
  card_token?: string;
  routing: {
    outcome: UniversalV1RoutingOutcome;
    decision_version: number;
    reason_codes: string[];
    policy_version: string;
    context?: UniversalV1TaskDraftRouteContext;
  };
  parse?: TaskDraftParseSummary;
  relationship_origin?: UniversalV1TaskDraftRelationshipOrigin;
  payment_creation_frozen: true;
  hard_assignment_created: false;
  correlation_id: string;
}

type TaskDraftParseSummary = Pick<
  UniversalV1TaskDraftParse,
  | 'title'
  | 'category'
  | 'scope_summary'
  | 'est_price_min_cents'
  | 'est_price_max_cents'
  | 'missing_questions'
>;

export interface UniversalTaskDraftIngressRejected {
  ok: false;
  code: 'rejected';
  correlation_id: string;
}

export type UniversalTaskDraftIngressResult =
  | UniversalTaskDraftIngressSuccess
  | UniversalTaskDraftIngressRejected;

function fail(code: TRPCError['code'], message: string): never {
  throw new TRPCError({ code, message });
}

function assertFresh(clientTimestamp: number, now: number): void {
  if (Math.abs(now - clientTimestamp) > 10 * 60 * 1_000) {
    fail('BAD_REQUEST', 'Request timestamp too far from server time');
  }
}

function testHumanVerificationAllowed(env: Environment): boolean {
  const environment = env.HX_ENVIRONMENT?.trim().toLowerCase() ?? '';
  const explicitTestEvidence = env.TURNSTILE_ALLOW_TEST_BYPASS === 'true'
    || env.HX_HUMAN_VERIFICATION_MODE === 'synthetic';
  return explicitTestEvidence
    && ['development', 'local', 'test', 'preview', 'staging'].includes(environment);
}

function humanVerificationTarget(
  env: Environment,
): { url: string; secret: string; synthetic: boolean } | null {
  if (env.HX_HUMAN_VERIFICATION_MODE === 'synthetic') {
    if (!testHumanVerificationAllowed(env)) return null;
    const secret = env.HX_HUMAN_VERIFICATION_SECRET?.trim() ?? '';
    try {
      const url = new URL(env.HX_HUMAN_VERIFICATION_URL?.trim() ?? '');
      if (!['http:', 'https:'].includes(url.protocol)
          || url.username
          || url.password
          || secret.length < 16) {
        return null;
      }
      return { url: url.toString(), secret, synthetic: true };
    } catch {
      return null;
    }
  }
  const secret = env.TURNSTILE_SECRET_KEY?.trim() ?? '';
  return secret
    ? {
      url: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      secret,
      synthetic: false,
    }
    : null;
}

function allowedHumanVerificationHostnames(env: Environment): Set<string> {
  return new Set((env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
    .flatMap((origin) => {
      try { return [new URL(origin).hostname.toLowerCase()]; } catch { return []; }
    }));
}

async function verifyHuman(
  token: string,
  ip: string | null,
  dependencies: TaskDraftIngressDependencies,
): Promise<boolean> {
  const target = humanVerificationTarget(dependencies.env);
  if (!target) {
    log.warn('Human verification is required for public TaskDraft creation');
    return false;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);
  try {
    const body = new URLSearchParams({
      secret: target.secret,
      response: token,
      ...(ip ? { remoteip: ip } : {}),
      ...(target.synthetic ? { expected_action: 'task' } : {}),
    });
    const response = await dependencies.fetch(target.url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const result = await response.json() as HumanVerificationResult;
    const isTestEvidence = result.metadata?.result_with_testing_key === true;
    const hostname = typeof result.hostname === 'string' ? result.hostname.toLowerCase() : null;
    const hostnameAccepted = isTestEvidence
      ? testHumanVerificationAllowed(dependencies.env)
      : !hostname || allowedHumanVerificationHostnames(dependencies.env).has(hostname);
    return result.success === true
      && (result.action === undefined || result.action === 'task')
      && hostnameAccepted;
  } catch (error) {
    log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'Turnstile verification failed closed for TaskDraft creation',
    );
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function ingressIpHash(ip: string | null, env: Environment): string | null {
  if (!ip) return null;
  const salt = env.PUBLIC_INGRESS_IP_HASH_SALT?.trim();
  if (!salt && env.NODE_ENV === 'production') {
    fail('SERVICE_UNAVAILABLE', 'Public ingress privacy configuration is unavailable');
  }
  return crypto.createHmac('sha256', salt || 'hustlexp-nonproduction-ingress')
    .update(ip)
    .digest('hex');
}

function legacyIngressIpHash(ip: string | null, env: Environment): string | null {
  if (!ip) return null;
  const salt = env.TASK_DRAFT_LEGACY_IP_HASH_SALT?.trim();
  return salt ? crypto.createHash('sha256').update(`${ip}${salt}`).digest('hex') : null;
}

function taskDraftParseSummary(parsed: UniversalV1TaskDraftParse): TaskDraftParseSummary {
  return {
    title: parsed.title,
    category: parsed.category,
    scope_summary: parsed.scope_summary,
    est_price_min_cents: parsed.est_price_min_cents,
    est_price_max_cents: parsed.est_price_max_cents,
    missing_questions: [...parsed.missing_questions],
  };
}

function storedTaskDraftParseSummary(evidence: Record<string, unknown> | null): TaskDraftParseSummary | null {
  const value = evidence?.parse_summary;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.title !== 'string'
    || !['moving', 'furniture_assembly', 'errands', 'yard', 'tech', 'cleaning', 'handyman', 'other']
      .includes(String(candidate.category))
    || typeof candidate.scope_summary !== 'string'
    || !Number.isSafeInteger(candidate.est_price_min_cents)
    || !Number.isSafeInteger(candidate.est_price_max_cents)
    || Number(candidate.est_price_min_cents) < 0
    || Number(candidate.est_price_max_cents) < Number(candidate.est_price_min_cents)
    || !Array.isArray(candidate.missing_questions)
    || candidate.missing_questions.some((question) => typeof question !== 'string')
  ) return null;
  return candidate as TaskDraftParseSummary;
}

function taskDraftRouteContextEvidence(
  context: UniversalV1TaskDraftRouteContext,
): Record<string, unknown> {
  return {
    route_context_contract_version: 1,
    work_category_code: context.workCategoryCode,
    region_code: context.regionCode,
    rough_location: context.roughLocation,
    risk_level: context.riskLevel,
    requires_proof: true,
    final_availability_confirmation_required: true,
    postal_code: context.postalCode,
    service_cell_authority_id: context.serviceCellAuthorityId,
    service_cell_authority_version: context.serviceCellAuthorityVersion,
    service_cell_authority_environment: context.serviceCellAuthorityEnvironment,
    service_cell_authority_kind: context.serviceCellAuthorityKind,
    service_cell_evidence_sha256: context.serviceCellEvidenceSha256,
    service_cell_availability: context.serviceCellAvailability,
    routing_blocker_codes: [...context.blockerCodes],
  };
}

function storedTaskDraftRouteContext(
  evidence: Record<string, unknown> | null,
): UniversalV1TaskDraftRouteContext | null {
  if (!evidence || evidence.route_context_contract_version !== 1) return null;
  const workCategoryCode = evidence.work_category_code;
  const regionCode = evidence.region_code;
  const roughLocation = evidence.rough_location;
  const riskLevel = evidence.risk_level;
  const postalCode = evidence.postal_code;
  const authorityId = evidence.service_cell_authority_id;
  const authorityVersion = evidence.service_cell_authority_version;
  const authorityEnvironment = evidence.service_cell_authority_environment;
  const authorityKind = evidence.service_cell_authority_kind;
  const evidenceSha256 = evidence.service_cell_evidence_sha256;
  const availability = evidence.service_cell_availability;
  const blockerCodes = evidence.routing_blocker_codes;
  if (
    typeof workCategoryCode !== 'string'
    || !UNIVERSAL_V1_WORK_CATEGORY_CODES.includes(
      workCategoryCode as (typeof UNIVERSAL_V1_WORK_CATEGORY_CODES)[number],
    )
    || (regionCode !== null && typeof regionCode !== 'string')
    || (roughLocation !== null && typeof roughLocation !== 'string')
    || !['LOW', 'MEDIUM', 'HIGH', 'IN_HOME'].includes(String(riskLevel))
    || evidence.requires_proof !== true
    || evidence.final_availability_confirmation_required !== true
    || (postalCode !== null && typeof postalCode !== 'string')
    || (authorityId !== null && typeof authorityId !== 'string')
    || (authorityVersion !== null && !Number.isSafeInteger(authorityVersion))
    || (authorityEnvironment !== null
      && !['local', 'preview', 'staging', 'production'].includes(String(authorityEnvironment)))
    || (authorityKind !== null
      && !['SYNTHETIC_FIXTURE', 'SIGNED_DATASET'].includes(String(authorityKind)))
    || (evidenceSha256 !== null
      && (typeof evidenceSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(evidenceSha256)))
    || !['ACTIVE', 'WAITLIST', 'UNAVAILABLE', 'UNRESOLVED'].includes(String(availability))
    || !Array.isArray(blockerCodes)
    || blockerCodes.some((code) => typeof code !== 'string')
  ) {
    return null;
  }
  return {
    workCategoryCode: workCategoryCode as UniversalV1TaskDraftRouteContext['workCategoryCode'],
    regionCode: regionCode as string | null,
    roughLocation: roughLocation as string | null,
    riskLevel: riskLevel as UniversalV1TaskDraftRouteContext['riskLevel'],
    requiresProof: true,
    finalAvailabilityConfirmationRequired: true,
    postalCode: postalCode as string | null,
    serviceCellAuthorityId: authorityId as string | null,
    serviceCellAuthorityVersion: authorityVersion as number | null,
    serviceCellAuthorityEnvironment:
      authorityEnvironment as UniversalV1TaskDraftRouteContext['serviceCellAuthorityEnvironment'],
    serviceCellAuthorityKind:
      authorityKind as UniversalV1TaskDraftRouteContext['serviceCellAuthorityKind'],
    serviceCellEvidenceSha256: evidenceSha256 as string | null,
    serviceCellAvailability:
      availability as UniversalV1TaskDraftRouteContext['serviceCellAvailability'],
    blockerCodes: [...blockerCodes] as string[],
  };
}

function storedRelationshipOrigin(
  evidence: Record<string, unknown> | null,
): UniversalV1TaskDraftRelationshipOrigin | null {
  if (!evidence || evidence.relationship_origin_contract_version !== 1) return null;
  const id = evidence.relationship_origin_id;
  const kind = evidence.relationship_origin_kind;
  const policyVersion = evidence.relationship_origin_policy_version;
  const originVersion = evidence.relationship_origin_version;
  const routingState = evidence.relationship_origin_routing_state;
  const evidenceDigest = evidence.relationship_origin_evidence_digest;
  if (
    typeof id !== 'string'
    || !/^[a-f0-9-]{36}$/u.test(id)
    || !['MARKETPLACE', 'PROVIDER_OS', 'BRING_YOUR_OWN_PROVIDER'].includes(String(kind))
    || policyVersion !== 1
    || typeof originVersion !== 'number'
    || !Number.isSafeInteger(originVersion)
    || originVersion < 1
    || routingState !== 'ROUTING_READY'
    || typeof evidenceDigest !== 'string'
    || !/^[a-f0-9]{64}$/u.test(evidenceDigest)
  ) return null;
  return {
    id,
    kind: kind as UniversalV1TaskDraftRelationshipOrigin['kind'],
    policy_version: 1,
    origin_version: originVersion,
    routing_state: 'ROUTING_READY',
    evidence_digest: evidenceDigest,
  };
}

function structuredDraftEvidence(
  answers: Record<string, unknown>,
  parsed: UniversalV1TaskDraftParse,
): Record<string, unknown> {
  return {
    answers,
    missing_questions: [...parsed.missing_questions],
    risk_flags: [...parsed.risk_flags],
    required_skills: [...parsed.required_skills],
    required_tools: [...parsed.required_tools],
    labor_label: parsed.labor_label,
    recommended_hustler_profile: parsed.recommended_hustler_profile,
    estimate_display_only: true,
    scope_parser: 'UNIVERSAL_V1_SERVER',
    scope_policy_version: 'task_scope_v1',
    intake_contract: 'UNIVERSAL_V1',
    financial_effects: 'FROZEN',
  };
}

function semanticRequest(
  input: TaskDraftIngressInput,
  rawInput: string,
  answers: Record<string, unknown>,
): Record<string, unknown> {
  if (input.action === 'link_contact') {
    return {
      action: input.action,
      submission_id: input.submission_id,
      expected_version: input.expected_version,
      lead_submission_id: input.lead_submission_id ?? null,
      consent_version: input.consent_version,
    };
  }
  return {
    action: input.action,
    submission_id: input.submission_id,
    expected_version: input.expected_version,
    raw_input: rawInput,
    category: input.category,
    answers,
    zip: input.zip ?? null,
    region: input.region ?? null,
    photo_count: input.photo_count,
    lead_submission_id: input.lead_submission_id ?? null,
    consent_version: input.consent_version,
  };
}

function draftResponse(
  input: TaskDraftIngressInput,
  draftId: string,
  status: string,
  route: RoutingRow,
  replayed: boolean,
  correlationId: string,
): UniversalTaskDraftIngressSuccess {
  const parse = storedTaskDraftParseSummary(route.evidence);
  const routeContext = storedTaskDraftRouteContext(route.evidence);
  const relationshipOrigin = storedRelationshipOrigin(route.evidence);
  return {
    ok: true,
    submission_id: input.submission_id,
    draft_id: draftId,
    status,
    version: route.decision_version,
    replayed,
    ...(input.action === 'create' ? { card_token: input.card_token } : {}),
    routing: {
      outcome: route.outcome,
      decision_version: route.decision_version,
      reason_codes: route.reason_codes,
      policy_version: route.policy_version,
      ...(routeContext ? { context: routeContext } : {}),
    },
    ...(parse ? { parse } : {}),
    ...(relationshipOrigin ? { relationship_origin: relationshipOrigin } : {}),
    payment_creation_frozen: true,
    hard_assignment_created: false,
    correlation_id: correlationId,
  };
}

async function loadDraftForUpdate(query: QueryFn, submissionId: string): Promise<DraftRow | undefined> {
  const result = await query<DraftRow>(
    `SELECT draft.id, draft.card_token_hash, draft.status, draft.category,
            draft.zip, draft.lead_id,
            draft.active_routing_decision_id,
            route.decision_version, route.outcome, route.reason_codes,
            route.policy_version, route.category_snapshot,
            route.service_cell_snapshot, route.service_cell_authority_id,
            route.evidence, route.idempotency_key
       FROM task_drafts draft
       LEFT JOIN task_routing_decisions route
         ON route.id = draft.active_routing_decision_id
      WHERE draft.submission_id = $1
      FOR UPDATE OF draft`,
    [submissionId],
  );
  return result.rows[0];
}

async function loadIdempotentReplay(
  query: QueryFn,
  idempotencyKey: string,
): Promise<(RoutingRow & {
  task_draft_id: string;
  status: string;
  submission_id: string;
  card_token_hash: string;
}) | undefined> {
  const result = await query<RoutingRow & {
    task_draft_id: string;
    status: string;
    submission_id: string;
    card_token_hash: string;
  }>(
    `SELECT route.id, route.task_draft_id, route.decision_version, route.outcome,
            route.reason_codes, route.policy_version, route.category_snapshot,
            route.service_cell_snapshot, route.service_cell_authority_id,
            route.evidence,
             route.idempotency_key,
             COALESCE(route.evidence->>'draft_status', draft.status) AS status,
             draft.submission_id,
            draft.card_token_hash
       FROM task_routing_decisions route
       JOIN task_drafts draft ON draft.id = route.task_draft_id
      WHERE route.idempotency_key = $1`,
    [idempotencyKey],
  );
  return result.rows[0];
}

function assertReplayMatches(
  replay: RoutingRow & {
    task_draft_id: string;
    status: string;
    submission_id: string;
    card_token_hash: string;
  },
  input: TaskDraftIngressInput,
  requestHash: string,
): void {
  if (
    replay.submission_id !== input.submission_id
    || replay.card_token_hash !== taskDraftCardTokenHash(input.card_token)
  ) {
    fail('FORBIDDEN', 'TaskDraft capability is invalid');
  }
  if (replay.evidence?.request_sha256 !== requestHash) {
    fail('CONFLICT', 'Idempotency key was already used for a different TaskDraft mutation');
  }
}

function preserveRoutingDecision(draft: DraftRow): {
  decision: TaskDraftRoutingDecision;
  snapshot: RoutingSnapshot;
} {
  if (
    !draft.outcome
    || !draft.reason_codes?.length
    || !draft.policy_version
    || !draft.category_snapshot
  ) {
    fail('INTERNAL_SERVER_ERROR', 'TaskDraft has no durable routing authority to preserve');
  }
  return {
    decision: {
      outcome: draft.outcome,
      reasonCodes: [...draft.reason_codes],
      policyVersion: draft.policy_version,
      routeContext: storedTaskDraftRouteContext(draft.evidence),
    },
    snapshot: {
      categorySnapshot: draft.category_snapshot,
      serviceCellSnapshot: draft.service_cell_snapshot,
      serviceCellAuthorityId: draft.service_cell_authority_id,
      routeContext: storedTaskDraftRouteContext(draft.evidence),
    },
  };
}

async function insertRoutingDecision(
  query: QueryFn,
  input: TaskDraftIngressInput,
  draftId: string,
  activeRouteId: string | null,
  decision: TaskDraftRoutingDecision,
  requestHash: string,
  correlationId: string,
  draftStatus: string,
  snapshot: RoutingSnapshot,
  parseSummary: TaskDraftParseSummary | null,
): Promise<RoutingRow> {
  const nextVersion = input.expected_version + 1;
  const idempotencyKey = taskDraftMutationIdempotencyKey(
    input.submission_id,
    input.expected_version,
  );
  const evidence = {
    request_sha256: requestHash,
    ingress_action: input.action,
    correlation_id: correlationId,
    draft_status: draftStatus,
    payment_creation_frozen: true,
    hard_assignment_created: false,
    ...(snapshot.routeContext
      ? taskDraftRouteContextEvidence(snapshot.routeContext)
      : {}),
    ...(parseSummary ? { parse_summary: parseSummary } : {}),
  };
  const result = await query<RoutingRow>(
    `INSERT INTO task_routing_decisions (
       task_draft_id, decision_version, supersedes_decision_id, outcome,
       reason_codes, policy_version, category_snapshot, service_cell_snapshot,
       service_cell_authority_id, decision_authority, evidence, idempotency_key
     ) VALUES ($1,$2,$3,$4,$5::text[],$6,$7,$8,$9,'DETERMINISTIC_POLICY',$10::jsonb,$11)
     RETURNING id, decision_version, outcome, reason_codes, policy_version,
               category_snapshot, service_cell_snapshot,
               service_cell_authority_id, evidence, idempotency_key`,
    [
      draftId,
      nextVersion,
      activeRouteId,
      decision.outcome,
      decision.reasonCodes,
      decision.policyVersion,
      snapshot.categorySnapshot,
      snapshot.serviceCellSnapshot,
      snapshot.serviceCellAuthorityId,
      JSON.stringify(evidence),
      idempotencyKey,
    ],
  );
  const row = result.rows[0];
  if (!row) fail('INTERNAL_SERVER_ERROR', 'TaskDraft routing decision was not persisted');
  return { ...row, evidence: { ...evidence, ...row.evidence } };
}

async function enforceCreateRateLimit(
  query: QueryFn,
  ipHash: string | null,
  legacyIpHash: string | null,
  env: Environment,
): Promise<void> {
  if (!ipHash) return;
  await query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [ipHash]);
  const configured = Number(env.TASK_DRAFT_RATE_LIMIT_PER_IP_HOUR ?? MAX_CREATE_PER_IP_HOUR);
  const limit = Number.isSafeInteger(configured) && configured > 0 ? configured : MAX_CREATE_PER_IP_HOUR;
  const result = await query<{ total: string; unresolved_legacy_recent: string }>(
    `SELECT COUNT(*) FILTER (
              WHERE (ip_hash_scheme = 'HMAC_SHA256_V1' AND ip_hash = $1)
                 OR ($2::text IS NOT NULL
                     AND ip_hash_scheme IN ('LEGACY_SHA256_IP_SUFFIX_V1', 'UNKNOWN_V0')
                     AND ip_hash = $2)
            )::text AS total,
            COUNT(*) FILTER (
              WHERE $2::text IS NULL
                AND ip_hash_scheme IN ('LEGACY_SHA256_IP_SUFFIX_V1', 'UNKNOWN_V0')
            )::text AS unresolved_legacy_recent
       FROM task_drafts
      WHERE created_at >= clock_timestamp() - interval '1 hour'`,
    [ipHash, legacyIpHash],
  );
  if (Number(result.rows[0]?.unresolved_legacy_recent ?? '0') > 0) {
    fail(
      'SERVICE_UNAVAILABLE',
      'TaskDraft rate-limit continuity is awaiting the legacy IP-hash secret reference',
    );
  }
  if (Number(result.rows[0]?.total ?? '0') >= limit) {
    fail('TOO_MANY_REQUESTS', 'TaskDraft create rate limit reached');
  }
}

async function createDraft(
  query: QueryFn,
  input: TaskDraftIngressInput,
  rawInput: string,
  answers: Record<string, unknown>,
  parsed: UniversalV1TaskDraftParse,
  routeContext: UniversalV1TaskDraftRouteContext,
  ipHash: string | null,
): Promise<{ id: string; status: string }> {
  const structured = structuredDraftEvidence(answers, parsed);
  const result = await query<{ id: string; status: string }>(
    `INSERT INTO task_drafts (
       submission_id, card_token_hash, category, title, raw_input,
       scope_summary, structured, est_price_min_cents, est_price_max_cents,
       photo_count, zip, region, status, source, utm, ip_hash,
       universal_contract_version, ingress_contract_version, ingress_origin,
       card_token_contract_version, ip_hash_scheme,
       relationship_origin_contract_version, relationship_origin_kind,
       relationship_origin_policy_version,
       relationship_origin_intake_consent_version
     ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,
               'anonymous_task_draft','get_help_v2',$13::jsonb,$14,1,1,
               'BACKEND_POSTGRESQL',1,$15,1,'MARKETPLACE',1,'v1')
     RETURNING id, status`,
    [
      input.submission_id,
      taskDraftCardTokenHash(input.card_token),
      input.category,
      parsed.title,
      rawInput,
      parsed.scope_summary,
      JSON.stringify(structured),
      parsed.est_price_min_cents,
      parsed.est_price_max_cents,
      input.photo_count,
      input.zip ?? null,
      routeContext.roughLocation,
      JSON.stringify({}),
      ipHash,
      ipHash ? 'HMAC_SHA256_V1' : null,
    ],
  );
  const row = result.rows[0];
  if (!row) fail('INTERNAL_SERVER_ERROR', 'TaskDraft was not persisted');
  return row;
}

async function updateDraft(
  query: QueryFn,
  draft: DraftRow,
  input: TaskDraftIngressInput,
  rawInput: string,
  answers: Record<string, unknown>,
  parsed: UniversalV1TaskDraftParse,
  routeContext: UniversalV1TaskDraftRouteContext,
): Promise<string> {
  if (draft.status !== 'anonymous_task_draft') {
    fail('CONFLICT', 'TaskDraft is no longer mutable through public intake');
  }
  const structured = structuredDraftEvidence(answers, parsed);
  const result = await query<{ status: string }>(
    `UPDATE task_drafts
        SET category = $2, title = $3, raw_input = $4, scope_summary = $5,
            structured = $6::jsonb, est_price_min_cents = $7,
            est_price_max_cents = $8, photo_count = $9,
            zip = COALESCE($10, zip), region = $11,
            relationship_origin_contract_version = 1,
            relationship_origin_kind = 'MARKETPLACE',
            relationship_origin_policy_version = 1,
            relationship_origin_intake_consent_version = 'v1',
            updated_at = clock_timestamp()
      WHERE id = $1 AND status = 'anonymous_task_draft'
      RETURNING status`,
    [
      draft.id,
      input.category,
      parsed.title,
      rawInput,
      parsed.scope_summary,
      JSON.stringify(structured),
      parsed.est_price_min_cents,
      parsed.est_price_max_cents,
      input.photo_count,
      input.zip ?? null,
      routeContext.roughLocation,
    ],
  );
  const status = result.rows[0]?.status;
  if (!status) fail('CONFLICT', 'TaskDraft changed concurrently');
  return status;
}

async function linkContact(
  query: QueryFn,
  draft: DraftRow,
  leadSubmissionId: string,
  draftSubmissionId: string,
): Promise<string> {
  if (draft.status !== 'anonymous_task_draft') {
    fail('CONFLICT', 'TaskDraft contact is already linked or the draft is not mutable');
  }
  const lead = await query<{ id: string }>(
    `SELECT id
       FROM leads
      WHERE submission_id = $1
        AND lead_type = 'poster'
        AND answers->>'task_draft_submission_id' = $2
      LIMIT 1`,
    [leadSubmissionId, draftSubmissionId],
  );
  const leadId = lead.rows[0]?.id;
  if (!leadId) fail('BAD_REQUEST', 'The referenced lead does not exist');
  if (draft.lead_id && draft.lead_id !== leadId) {
    fail('CONFLICT', 'TaskDraft is linked to a different lead');
  }
  const result = await query<{ status: string }>(
    `UPDATE task_drafts
        SET lead_id = $2, status = 'contact_captured',
            relationship_origin_contract_version = 1,
            relationship_origin_kind = 'MARKETPLACE',
            relationship_origin_policy_version = 1,
            relationship_origin_intake_consent_version = 'v1',
            updated_at = clock_timestamp()
      WHERE id = $1 AND status = 'anonymous_task_draft'
      RETURNING status`,
    [draft.id, leadId],
  );
  const status = result.rows[0]?.status;
  if (!status) fail('CONFLICT', 'TaskDraft changed concurrently');
  return status;
}

async function persistTaskDraftMutation(
  input: TaskDraftIngressInput,
  ip: string | null,
  ipHash: string | null,
  legacyIpHash: string | null,
  correlationId: string,
  dependencies: TaskDraftIngressDependencies,
  serverNowMs: number,
): Promise<UniversalTaskDraftIngressSuccess> {
  const rawInput = input.action === 'link_contact' ? '' : sanitizeTaskDraftText(input.raw_input);
  if (input.action !== 'link_contact' && rawInput.length < 3) {
    fail('BAD_REQUEST', 'Task details contained no privacy-safe scope');
  }
  const answers = input.action === 'link_contact' ? {} : sanitizeTaskDraftAnswers(input.answers);
  const parsed = input.action === 'link_contact'
    ? null
    : parseUniversalV1TaskDraft({
      sanitizedRaw: rawInput,
      category: input.category as TaskDraftCategory,
      sanitizedAnswers: answers,
    });
  const requestHash = universalTaskDraftRequestHash(semanticRequest(input, rawInput, answers));
  const idempotencyKey = taskDraftMutationIdempotencyKey(
    input.submission_id,
    input.expected_version,
  );
  return dependencies.transaction(async (query) => {
    // Serialize all mutations for one public aggregate, including concurrent
    // creates before a task_drafts row exists to lock.
    await query('SELECT pg_advisory_xact_lock(hashtextextended($1, 1))', [input.submission_id]);
    const replay = await loadIdempotentReplay(query, idempotencyKey);
    if (replay) {
      assertReplayMatches(replay, input, requestHash);
      return draftResponse(input, replay.task_draft_id, replay.status, replay, true, correlationId);
    }

    const existing = await loadDraftForUpdate(query, input.submission_id);
    if (input.action === 'create') {
      if (existing) fail('CONFLICT', 'TaskDraft submission already exists with different input');
      // Turnstile tokens are single-use. Verify only after the exact replay
      // check, while the aggregate advisory lock serializes concurrent creates.
      // This keeps response-loss retries idempotent without weakening first-write
      // bot protection.
      if (!await verifyHuman(input.turnstile_token!, ip, dependencies)) {
        fail('FORBIDDEN', 'Bot check failed');
      }
      if (!parsed) fail('INTERNAL_SERVER_ERROR', 'TaskDraft scope parser did not run');
      await enforceCreateRateLimit(
        query,
        ipHash,
        legacyIpHash,
        dependencies.env,
      );
      const serviceCell = await resolveUniversalV1ServiceCell(query, {
        postalCode: input.zip,
        env: dependencies.env,
        nowMs: serverNowMs,
      });
      const routeContext = buildUniversalV1TaskDraftRouteContext({
        category: input.category as TaskDraftCategory,
        rawInput,
        safetyEvidence: parsed.safetyEvidence,
        serverRiskFlags: parsed.risk_flags,
        serviceCell,
      });
      const decision = evaluateUniversalV1TaskDraftRouting({
        category: input.category as TaskDraftCategory,
        rawInput,
        answers,
        safetyEvidence: parsed.safetyEvidence,
        serverRiskFlags: parsed.risk_flags,
        scopeEvidenceComplete: parsed.missing_questions.length === 0,
        nowMs: serverNowMs,
        routeContext,
      });
      const created = await createDraft(
        query,
        input,
        rawInput,
        answers,
        parsed,
        routeContext,
        ipHash,
      );
      const route = await insertRoutingDecision(
        query,
        input,
        created.id,
        null,
        decision,
        requestHash,
        correlationId,
        created.status,
        {
          categorySnapshot: routeContext.workCategoryCode,
          serviceCellSnapshot: routeContext.regionCode,
          serviceCellAuthorityId: routeContext.serviceCellAuthorityId,
          routeContext,
        },
        taskDraftParseSummary(parsed),
      );
      return draftResponse(input, created.id, created.status, route, false, correlationId);
    }

    if (!existing) fail('NOT_FOUND', 'TaskDraft not found');
    if (existing.card_token_hash !== taskDraftCardTokenHash(input.card_token)) {
      fail('FORBIDDEN', 'TaskDraft capability is invalid');
    }
    if (!existing.active_routing_decision_id || existing.decision_version !== input.expected_version) {
      fail('CONFLICT', 'TaskDraft version does not match expected_version');
    }

    if (input.action !== 'link_contact' && !parsed) {
      fail('INTERNAL_SERVER_ERROR', 'TaskDraft scope parser did not run');
    }
    let status: string;
    let decision: TaskDraftRoutingDecision;
    let snapshot: RoutingSnapshot;
    let parseSummary: TaskDraftParseSummary | null;
    if (input.action === 'link_contact') {
      status = await linkContact(
        query,
        existing,
        input.lead_submission_id!,
        input.submission_id,
      );
      const preserved = preserveRoutingDecision(existing);
      decision = preserved.decision;
      snapshot = preserved.snapshot;
      parseSummary = storedTaskDraftParseSummary(existing.evidence);
    } else {
      const serviceCell = await resolveUniversalV1ServiceCell(query, {
        postalCode: input.zip ?? existing.zip,
        env: dependencies.env,
        nowMs: serverNowMs,
      });
      const routeContext = buildUniversalV1TaskDraftRouteContext({
        category: input.category as TaskDraftCategory,
        rawInput,
        safetyEvidence: parsed!.safetyEvidence,
        serverRiskFlags: parsed!.risk_flags,
        serviceCell,
      });
      status = await updateDraft(
        query,
        existing,
        input,
        rawInput,
        answers,
        parsed!,
        routeContext,
      );
      decision = evaluateUniversalV1TaskDraftRouting({
        category: input.category as TaskDraftCategory,
        rawInput,
        answers,
        safetyEvidence: parsed!.safetyEvidence,
        serverRiskFlags: parsed!.risk_flags,
        scopeEvidenceComplete: parsed!.missing_questions.length === 0,
        nowMs: serverNowMs,
        routeContext,
      });
      snapshot = {
        categorySnapshot: routeContext.workCategoryCode,
        serviceCellSnapshot: routeContext.regionCode,
        serviceCellAuthorityId: routeContext.serviceCellAuthorityId,
        routeContext,
      };
      parseSummary = taskDraftParseSummary(parsed!);
    }
    const route = await insertRoutingDecision(
      query,
      input,
      existing.id,
      existing.active_routing_decision_id,
      decision,
      requestHash,
      correlationId,
      status,
      snapshot,
      parseSummary,
    );
    return draftResponse(input, existing.id, status, route, false, correlationId);
  });
}

export async function submitUniversalV1TaskDraft(
  input: TaskDraftIngressInput,
  context: UniversalV1TaskDraftIngressContext,
  dependencyOverrides: Partial<TaskDraftIngressDependencies> = {},
): Promise<UniversalTaskDraftIngressResult> {
  const dependencies: TaskDraftIngressDependencies = {
    env: process.env,
    fetch: globalThis.fetch,
    now: Date.now,
    randomUuid: crypto.randomUUID,
    transaction: db.transaction,
    ...dependencyOverrides,
  };
  const correlationId = dependencies.randomUuid();
  if (input.company_url?.trim()) {
    return { ok: false, code: 'rejected', correlation_id: correlationId };
  }
  const serverNowMs = dependencies.now();
  assertFresh(input.client_ts, serverNowMs);
  const result = await persistTaskDraftMutation(
    input,
    context.ip,
    input.action === 'create' ? ingressIpHash(context.ip, dependencies.env) : null,
    input.action === 'create' ? legacyIngressIpHash(context.ip, dependencies.env) : null,
    correlationId,
    dependencies,
    serverNowMs,
  );
  if (result.ok) {
    log.info({
      draftId: result.draft_id,
      action: input.action,
      version: result.version,
      outcome: result.routing.outcome,
      replayed: result.replayed,
    }, 'Universal V1 TaskDraft mutation persisted');
  }
  return result;
}

async function handleTaskDraftIngress({ input, ctx }: {
  input: TaskDraftIngressInput;
  ctx: UniversalV1TaskDraftIngressContext;
}): Promise<UniversalTaskDraftIngressResult> {
  return submitUniversalV1TaskDraft(input, ctx);
}

/**
 * Claiming a public TaskDraft establishes Poster ownership. Authentication
 * alone is insufficient: lazily provisioned identities deliberately remain
 * fail-closed with an unverified age/profile until registration completes.
 */
export function assertUniversalV1TaskDraftClaimActor(user: User): void {
  if (user.is_minor !== false) {
    fail('PRECONDITION_FAILED', 'Complete an adult profile before claiming a TaskDraft');
  }
  if (user.default_mode !== 'poster') {
    fail('FORBIDDEN', 'Poster access required to claim a TaskDraft');
  }
  if (user.account_status !== 'ACTIVE') {
    fail('PRECONDITION_FAILED', 'An active account is required to claim a TaskDraft');
  }
}

export const webTaskDraftsRouter = router({
  submit: publicProcedure
    .input(UniversalV1TaskDraftIngressSchema)
    .mutation(handleTaskDraftIngress),
  claim: protectedProcedure
    .input(UniversalV1TaskDraftClaimSchema)
    .mutation(({ input, ctx }) => {
      assertUniversalV1TaskDraftClaimActor(ctx.user);
      return claimUniversalV1TaskDraft(input, ctx.user.id);
    }),
});

export type WebTaskDraftsRouter = typeof webTaskDraftsRouter;
