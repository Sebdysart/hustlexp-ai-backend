import { z } from 'zod';

export const analyticsRangeSchema = z.object({
  days: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30),
  start: z.string().datetime().optional(), end: z.string().datetime().optional(),
  includeInternal: z.boolean().default(false), build: z.string().max(80).optional(),
}).strict().refine((v) => Boolean(v.start) === Boolean(v.end), 'Supply both start and end')
  .refine((v) => !v.start || (Date.parse(v.start) < Date.now() && Date.parse(v.end!) > Date.parse(v.start) && Date.parse(v.end!) - Date.parse(v.start) <= 90 * 86400000), 'Range must be 1–90 days and start before now');

// V1 product telemetry. Server-only names cannot be submitted by a browser.
export const BEHAVIOR_EVENTS = [
  'page_viewed', 'signup_started', 'task_intake_started', 'task_category_resolved',
  'task_intake_question_viewed', 'task_intake_question_answered', 'task_intake_question_skipped',
  'task_intake_completed', 'task_preview_viewed', 'quote_viewed', 'quote_approval_clicked',
  'checkout_started', 'business_signup_started', 'proposal_viewed', 'claim_opened', 'quote_started',
  'provider_os_opened', 'client_task_viewed', 'support_opened', 'validation_failed',
  'action_request_failed', 'upload_failed', 'draft_recovered', 'flow_exited', 'cta_click',
  'flow_error_observed',
  'lead_form_started', 'task_scope_started', 'adaptive_questions_completed', 'task_scope_confirmed',
] as const;
export const BUSINESS_EVENTS = [
  'signup_completed', 'task_draft_created', 'quote_created', 'quote_approval_requested', 'quote_approved',
  'payment_requested', 'payment_succeeded', 'payment_failed', 'task_started', 'task_proof_submitted',
  'task_completed', 'business_onboarding_completed', 'quote_submitted', 'client_invite_created',
  'client_onboarded', 'provider_os_quote_submitted', 'support_thread_created', 'support_reply_sent',
] as const;
export type ProductEventName = typeof BEHAVIOR_EVENTS[number] | typeof BUSINESS_EVENTS[number];
const code = z.string().max(100).regex(/^[a-zA-Z0-9_:./-]+$/);
const uuid = z.string().uuid();
export const attributionSchema = z.object({
  utm_source: code.optional(), utm_medium: code.optional(), utm_campaign: code.optional(),
  utm_content: code.optional(), utm_term: code.optional(),
}).strict();
export const causalitySchema = z.object({
  session_id: uuid, anonymous_id: uuid.optional(), correlation_id: uuid.optional(),
  causation_id: uuid.optional(), action_attempt_id: uuid.optional(), intake_attempt_id: uuid.optional(),
}).strict();
// Optional telemetry must never make a valid business request invalid.
export const optionalCausalitySchema = z.unknown().optional().transform((value) => {
  const result = causalitySchema.safeParse(value);
  return result.success ? result.data : undefined;
});
// Deliberately no arbitrary text/answer/message/body property. Unknown keys are rejected.
export const productPropertiesSchema = z.object({
  intake_attempt_id: uuid.optional(), question_key: code.optional(),
  question_importance: z.enum(['required', 'recommended', 'optional']).optional(),
  required: z.boolean().optional(), step: z.number().int().min(0).max(100).optional(),
  edited: z.boolean().optional(), answered: z.boolean().optional(), skipped: z.boolean().optional(),
  duration_ms: z.number().nonnegative().max(86400000).optional(), retry_count: z.number().int().min(0).max(100).optional(),
  thread_id: uuid.optional(), message_id: uuid.optional(), resolution_source: z.enum(['manual', 'classifier', 'profile']).optional(),
  cta: code.optional(), location: code.optional(), lead_type: code.optional(), risk: code.optional(),
  first_touch: attributionSchema.optional(),
}).strict();
export const behaviorEventSchema = z.object({
  id: uuid, event_name: z.enum(BEHAVIOR_EVENTS), event_version: z.literal(1),
  occurred_at: z.string().datetime(), anonymous_id: uuid, session_id: uuid,
  correlation_id: uuid.optional(), causation_id: uuid.optional(), action_attempt_id: uuid.optional(),
  task_draft_id: uuid.optional(), task_id: uuid.optional(), quote_id: uuid.optional(), proposal_id: uuid.optional(),
  business_organization_id: uuid.optional(), category: code.optional(), intake_profile: code.optional(),
  route: z.string().max(160).optional(), referrer: z.string().max(160).optional(),
  device_type: z.enum(['mobile', 'tablet', 'desktop']).optional(),
  browser: z.enum(['chrome', 'safari', 'firefox', 'edge', 'other']).optional(),
  viewport_width: z.number().int().min(0).max(10000).optional(),
  build_id: z.string().max(80).regex(/^[a-zA-Z0-9._-]+$/).optional(),
  attribution: attributionSchema.optional(),
  reason_code: z.enum(['validation_failed', 'payment_failed', 'expired', 'user_cancelled', 'not_authorized', 'unsupported', 'unknown']).optional(),
  properties: productPropertiesSchema.default({}),
}).strict().refine((event) => Buffer.byteLength(JSON.stringify(event)) <= 4096, 'Event exceeds 4 KB');
export type BehaviorEvent = z.infer<typeof behaviorEventSchema>;

// Only known route shapes are stored. Unknown paths, all queries, fragments and tokens are discarded.
const staticRoutes = new Set(['/', '/earn', '/auth-debug', '/get-help', '/task-preview', '/dashboard', '/sign-in', '/auth/callback',
  '/onboarding/account', '/support', '/support/new', '/business/signup', '/business/dashboard',
  '/business/proposals', '/business/onboarding/company', '/business/onboarding/location', '/business/onboarding/services',
  '/ops', '/ops/analytics', '/ops/drafts', '/ops/tasks', '/ops/posters', '/ops/businesses', '/ops/support', '/test/stax']);
export function sanitizeAnalyticsRoute(value?: string): string | null {
  if (!value) return null;
  const path = value.split(/[?#]/)[0];
  if (staticRoutes.has(path)) return path;
  if (/^\/claim\/[^/]+\/?$/.test(path)) return '/claim/:token';
  if (/^\/dashboard\/drafts\/[^/]+\/quote\/?$/.test(path)) return '/dashboard/drafts/:id/quote';
  const match = path.match(/^(\/(?:dashboard\/(?:drafts|tasks)|task\/status|business\/(?:tasks|claims|proposals)|ops\/(?:drafts|tasks|posters|businesses|support)|support))\/[^/]+\/?$/);
  return match ? `${match[1]}/:id` : '/:unknown';
}

export function sanitizeAnalyticsReferrer(value?: string): string | null {
  if (!value) return null;
  if (value.startsWith('/') && !value.startsWith('//')) return sanitizeAnalyticsRoute(value);
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.origin.slice(0, 160) : null;
  } catch { return null; }
}
