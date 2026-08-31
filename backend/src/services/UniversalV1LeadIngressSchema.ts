import { z } from 'zod';
import { isPlausiblyRandomTaskDraftCardToken } from './UniversalV1TaskDraftIngress.js';

const leadTypes = ['poster', 'hustler', 'business', 'founder'] as const;
const answerValue = z.union([
  z.string().max(2_000),
  z.array(z.string().max(120)).max(24),
  z.boolean(),
  z.number().finite(),
]);

export const universalV1LeadIngressSchema = z.object({
  submission_id: z.string().uuid(),
  lead_type: z.enum(leadTypes),
  email: z.string().email().max(254),
  name: z.string().min(1).max(80),
  phone: z.string().regex(/^\+?[\d\s\-().]{7,24}$/u, 'phone must contain 7–24 valid digits').optional(),
  region: z.string().max(80).optional(),
  zip: z.string().regex(/^\d{5}(-\d{4})?$/u, 'must be a valid US zip').optional(),
  answers: z.record(z.string().max(60), answerValue)
    .refine((answers) => Object.keys(answers).length <= 24, 'too many answer fields')
    .optional(),
  utm: z.object({
    source: z.string().max(80).optional(),
    medium: z.string().max(80).optional(),
    campaign: z.string().max(80).optional(),
    content: z.string().max(80).optional(),
    term: z.string().max(80).optional(),
  }).optional(),
  consent_version: z.literal('v1'),
  turnstile_token: z.string().min(10).max(2_048).optional(),
  draft_submission_id: z.string().uuid().optional(),
  draft_card_token: z.string().regex(/^[0-9a-f]{64}$/iu)
    .refine(isPlausiblyRandomTaskDraftCardToken, 'TaskDraft capability is low entropy')
    .optional(),
  company_url: z.string().max(254).optional(),
  hp_email: z.string().max(254).optional(),
  client_ts: z.number().int().positive(),
}).strict().superRefine((value, context) => {
  const hasTurnstile = Boolean(value.turnstile_token);
  const hasDraftProof = Boolean(value.draft_submission_id && value.draft_card_token);
  if (!hasTurnstile && !hasDraftProof) {
    context.addIssue({
      code: 'custom',
      path: ['turnstile_token'],
      message: 'Turnstile or a canonical TaskDraft capability is required',
    });
  }
  if (hasDraftProof && value.lead_type !== 'poster') {
    context.addIssue({
      code: 'custom',
      path: ['draft_submission_id'],
      message: 'TaskDraft proof is valid only for poster lead capture',
    });
  }
});

export type UniversalV1LeadIngressInput = z.infer<typeof universalV1LeadIngressSchema>;
