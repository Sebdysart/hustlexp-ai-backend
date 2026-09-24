import crypto from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { config } from '../config.js';
import { db, type QueryFn } from '../db.js';
import { AnalyticsService } from './AnalyticsService.js';
import { ComplianceGuardianService } from './ComplianceGuardianService.js';
import { deriveManualTaskRisk } from './ManualTaskRisk.js';
import { buildManualTaskPolicyInput } from './ManualTaskPolicy.js';
import {
  evaluateTaskAgainstRegionPolicy,
  resolveRegionPolicy,
} from './RegionPolicyService.js';
import { optionalCausalitySchema } from './analytics/contract.js';
import { buildTaskScopeSummary } from './taskIntake/buildScopeSummary.js';
import { TASK_CATEGORIES } from './taskIntake/definitions.js';
import { sanitizeIntakeAnswers } from './taskIntake/sanitizeIntakeAnswers.js';
import type { IntakeAnswers, IntakeProfile, TaskCategory } from './taskIntake/types.js';
import { validateTaskIntake } from './taskIntake/validateIntake.js';

export const CanonicalTaskDraftInputSchema = z.object({
  analytics: optionalCausalitySchema,
  lead: z.object({
    submission_id: z.string().uuid(),
    lead_type: z.enum(['poster', 'hustler', 'business', 'founder']),
    email: z.string().email().max(254).optional(),
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
    category: z.enum(TASK_CATEGORIES),
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

export type CanonicalTaskDraftInput = z.infer<typeof CanonicalTaskDraftInputSchema>;

const SecondaryIntentsSchema = z.array(z.enum(TASK_CATEGORIES)).max(5).default([]);
const IntakeProfileSchema = z.enum(['cleaning_indoor', 'cleaning_surface', 'auto_repair', 'auto_cleaning']);
const IntakeProfileSourceSchema = z.enum(['resolver', 'user']);

export interface CanonicalTaskDraftResult {
  leadId: string | null;
  taskDraftId: string;
  quoteId: string | null;
  cardToken?: string;
  replayed: boolean;
  correlation_id: string;
}

function generateCardToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString('hex');
  return { raw, hash: crypto.createHash('sha256').update(raw).digest('hex') };
}

export async function createCanonicalTaskDraftInTransaction(
  query: QueryFn,
  params: {
    input: CanonicalTaskDraftInput;
    posterUserId: string | null;
    actorUserId: string;
    source?: string;
    correlationId?: string;
  },
): Promise<CanonicalTaskDraftResult> {
  const { input, posterUserId, actorUserId } = params;
  const correlationId = params.correlationId ?? crypto.randomUUID();

  const existing = await query<{ lead_id: string | null; draft_id: string; quote_id: string | null }>(
    `SELECT td.lead_id, td.id AS draft_id, td.quote_id
       FROM task_drafts td
      WHERE td.submission_id = $1
        AND td.poster_user_id IS NOT DISTINCT FROM $2
      LIMIT 1`,
    [input.lead.submission_id, posterUserId],
  );
  if (existing.rows[0]) {
    return {
      leadId: existing.rows[0].lead_id,
      taskDraftId: existing.rows[0].draft_id,
      quoteId: existing.rows[0].quote_id,
      replayed: true,
      correlation_id: correlationId,
    };
  }

  const category = input.task.category as TaskCategory;
  const structured = input.task.structured && typeof input.task.structured === 'object'
    && !Array.isArray(input.task.structured)
    ? input.task.structured as Record<string, unknown>
    : {};
  const rawAnswers = structured.answers;
  const unsanitizedAnswers: IntakeAnswers = rawAnswers && typeof rawAnswers === 'object'
    && !Array.isArray(rawAnswers) ? rawAnswers as IntakeAnswers : {};
  const secondaryIntents = SecondaryIntentsSchema.parse(structured.secondary_intents ?? [])
    .filter((intent, index, all) => intent !== category && intent !== 'other' && all.indexOf(intent) === index);
  const parsedProfile = IntakeProfileSchema.safeParse(structured.intake_profile);
  if (structured.intake_profile !== undefined && !parsedProfile.success) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Task intake contains an invalid intake profile.' });
  }
  const intakeProfile = parsedProfile.data as IntakeProfile | undefined;
  const parsedProfileSource = IntakeProfileSourceSchema.safeParse(structured.intake_profile_source);
  if (structured.intake_profile_source !== undefined && !parsedProfileSource.success) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Task intake contains an invalid profile source.' });
  }
  const answers = sanitizeIntakeAnswers(category, unsanitizedAnswers, secondaryIntents, intakeProfile ?? null);
  const intakeValidation = validateTaskIntake(category, answers, secondaryIntents, intakeProfile ?? null);
  if (!intakeValidation.readyForDraft) {
    const missing = intakeValidation.missingRequired;
    const invalid = intakeValidation.invalidAnswers ?? [];
    const prefix = missing.length
      ? 'Task intake is incomplete.'
      : `Task intake contains invalid details: ${invalid.join(', ')}.`;
    const detail = missing.length && invalid.length ? ` Invalid details: ${invalid.join(', ')}.` : '';
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: missing.length
        ? `${prefix} Missing required details: ${missing.join(', ')}.${detail}`
        : prefix,
    });
  }

  const lead = await query<{ id: string }>(
    `INSERT INTO leads
       (submission_id, lead_type, email, name, phone, region, zip, answers, utm,
        consent_version, source, ip_hash, correlation_id, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14)
     RETURNING id`,
    [
      input.lead.submission_id,
      input.lead.lead_type,
      input.lead.email?.trim().toLowerCase() ?? null,
      input.lead.name?.trim() ?? null,
      input.lead.phone?.trim() ?? null,
      input.lead.region ?? null,
      input.lead.zip ?? null,
      JSON.stringify(input.lead.answers),
      JSON.stringify(input.lead.utm),
      input.lead.consent_version,
      params.source ?? input.task.source,
      input.lead.ip_hash ?? null,
      correlationId,
      posterUserId,
    ],
  );
  const leadId = lead.rows[0]?.id;
  if (!leadId) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create lead' });

  const taskText = input.task.raw_input?.trim()
    || input.task.scope_summary?.trim()
    || input.task.title.trim();
  const canonicalScopeSummary = buildTaskScopeSummary(
    category, taskText, answers, secondaryIntents, intakeProfile,
  );
  const canonicalStructured = {
    ...structured,
    intake_profile: intakeProfile,
    intake_profile_source: intakeProfile ? parsedProfileSource.data ?? 'resolver' : undefined,
    secondary_intents: secondaryIntents,
    answers: { ...answers, scope_policy_version: 'task_scope_v2' },
    missing_questions: intakeValidation.missingRequired,
    recommended_missing: intakeValidation.missingRecommended,
    scope_quality: intakeValidation.quality,
    scope_confirmed: true,
    intake_spec_version: 'intake_questions_2026_09',
    category_rules_version: 'category_rules_v1',
  };

  const validatedRiskLevel = deriveManualTaskRisk(taskText, { category });
  const complianceResult = await ComplianceGuardianService.evaluate({
    description: taskText,
    userId: actorUserId,
    templateSlug: 'standard_physical',
  });
  if (complianceResult.tier === 'hard_block') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'This task cannot be posted under HustleXP safety policy.',
    });
  }

  const regionCode = config.launchRegionCode;
  const regionPolicy = await resolveRegionPolicy(regionCode);
  if (!regionPolicy) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Task posting is temporarily unavailable in this service region.',
    });
  }
  const regionEvaluation = evaluateTaskAgainstRegionPolicy(
    regionPolicy,
    buildManualTaskPolicyInput({
      regionCode,
      category: input.task.category,
      riskLevel: validatedRiskLevel,
    }),
    { evaluateEconomics: false, evaluateProductionGates: false },
  );
  if (!regionEvaluation.allowed) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'This task cannot currently be posted under HustleXP service policy.',
    });
  }

  const { raw: cardToken, hash: cardTokenHash } = generateCardToken();
  const draft = await query<{ id: string; quote_id: string | null }>(
    `INSERT INTO task_drafts (
       submission_id, card_token_hash, category, title, raw_input, scope_summary,
       structured, est_price_min_cents, est_price_max_cents, photo_count, zip,
       region, validated_risk_level, compliance_result, region_code,
       region_policy_id, region_policy_version, region_policy_hash,
       region_policy_snapshot, status, source, utm, ip_hash, lead_id, poster_user_id
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,
       $17,$18,$19::jsonb,'draft',$20,$21::jsonb,$22,$23,$24
     ) RETURNING id, quote_id`,
    [
      input.lead.submission_id,
      cardTokenHash,
      input.task.category,
      input.task.title,
      input.task.raw_input ?? null,
      canonicalScopeSummary,
      JSON.stringify(canonicalStructured),
      input.task.est_price_min_cents ?? null,
      input.task.est_price_max_cents ?? null,
      input.task.photo_count,
      input.task.zip ?? null,
      input.task.region ?? null,
      validatedRiskLevel,
      JSON.stringify(complianceResult),
      regionCode,
      regionEvaluation.snapshot?.policyId,
      regionEvaluation.snapshot?.policyVersion,
      regionEvaluation.snapshot?.policyHash,
      JSON.stringify(regionEvaluation.snapshot),
      params.source ?? input.task.source,
      JSON.stringify(input.task.utm),
      input.task.ip_hash ?? null,
      leadId,
      posterUserId,
    ],
  );
  const taskDraftId = draft.rows[0]?.id;
  if (!taskDraftId) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create task draft' });
  }
  return {
    leadId,
    taskDraftId,
    quoteId: draft.rows[0]?.quote_id ?? null,
    cardToken,
    replayed: false,
    correlation_id: correlationId,
  };
}

export async function createCanonicalTaskDraft(params: {
  input: CanonicalTaskDraftInput;
  posterUserId: string;
  actorUserId: string;
}): Promise<CanonicalTaskDraftResult> {
  const correlationId = crypto.randomUUID();
  const result = await db.transaction((query) => createCanonicalTaskDraftInTransaction(query, {
    ...params,
    correlationId,
  }));
  if (!result.replayed) {
    void AnalyticsService.track({
      event_name: 'task_draft_created',
      deduplication_key: result.taskDraftId,
      user_id: params.posterUserId,
      ...params.input.analytics,
      correlation_id: params.input.analytics?.correlation_id || correlationId,
      task_draft_id: result.taskDraftId,
      category: params.input.task.category,
      intake_profile: typeof params.input.task.structured.intake_profile === 'string'
        ? params.input.task.structured.intake_profile
        : undefined,
      outcome: 'committed',
      properties: { intake_attempt_id: params.input.analytics?.intake_attempt_id },
    });
  }
  return result;
}

