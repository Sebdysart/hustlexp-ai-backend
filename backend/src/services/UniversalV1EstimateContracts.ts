import { z } from 'zod';

import { universalTaskDraftRequestHash } from './UniversalV1TaskDraftIngress.js';

const uuidSchema = z.string().uuid();
const idempotencyKeySchema = z.string().trim().min(8).max(128)
  .regex(/^[A-Za-z0-9:_-]+$/u);
const positiveCentsSchema = z.number().int().positive().max(100_000_000);

export const UniversalV1EstimateLineItemSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: z.number().int().positive().max(10_000),
  unit_amount_cents: positiveCentsSchema,
  total_amount_cents: positiveCentsSchema,
}).strict().superRefine((item, context) => {
  if (item.quantity * item.unit_amount_cents !== item.total_amount_cents) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'line-item quantity and unit amount must equal its total',
      path: ['total_amount_cents'],
    });
  }
});

export const UniversalV1EstimateScopeSchema = z.object({
  title: z.string().trim().min(3).max(255),
  description: z.string().trim().min(10).max(5_000),
  requirements: z.string().trim().min(1).max(2_000).nullable().default(null),
  checklist: z.array(z.string().trim().min(1).max(500)).min(1).max(50),
  work_category_code: z.string().trim().toLowerCase()
    .regex(/^[a-z][a-z0-9_]{1,63}$/u),
  region_code: z.string().trim().toUpperCase().regex(/^US-[A-Z]{2}$/u),
  rough_location: z.string().trim().min(2).max(120),
  risk_level: z.enum(['LOW', 'MEDIUM', 'HIGH', 'IN_HOME']),
  requires_proof: z.boolean(),
}).strict();

export const UniversalV1ProviderIdentitySchema = z.object({
  actor_user_id: uuidSchema,
  provider_user_id: uuidSchema,
  provider_organization_id: uuidSchema.nullable().default(null),
}).strict();

/**
 * Server-authority command for opening one payment-free provider estimate
 * lane. The caller may identify only the opaque eligibility fact and the two
 * versions it observed. Provider, route, credential, location, validity, and
 * quote identity are resolved or generated inside the PostgreSQL transaction.
 */
export const IssueUniversalV1ProviderEstimateInvitationSchema = z.object({
  eligibility_decision_id: uuidSchema,
  expected_draft_version: z.number().int().positive(),
  expected_eligibility_version: z.number().int().positive(),
  actor_user_id: uuidSchema,
  idempotency_key: idempotencyKeySchema,
}).strict();

export const SubmitUniversalV1ProviderEstimateSchema = z.object({
  task_draft_id: uuidSchema,
  routing_decision_id: uuidSchema,
  expected_draft_version: z.number().int().positive(),
  quote_id: uuidSchema,
  expected_quote_version: z.number().int().nonnegative(),
  provider: UniversalV1ProviderIdentitySchema,
  scope: UniversalV1EstimateScopeSchema,
  line_items: z.array(UniversalV1EstimateLineItemSchema).min(1).max(100),
  customer_total_cents: positiveCentsSchema,
  provider_payout_cents: positiveCentsSchema,
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/u),
  idempotency_key: idempotencyKeySchema,
}).strict().superRefine((command, context) => {
  const lineItemTotal = command.line_items.reduce(
    (sum, item) => sum + item.total_amount_cents,
    0,
  );
  if (!Number.isSafeInteger(lineItemTotal) || lineItemTotal !== command.customer_total_cents) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'line-item totals must equal the customer total',
      path: ['customer_total_cents'],
    });
  }
  if (command.provider_payout_cents > command.customer_total_cents) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'provider payout cannot exceed the customer total',
      path: ['provider_payout_cents'],
    });
  }
});

export const AcceptUniversalV1ProviderEstimateSchema = z.object({
  task_draft_id: uuidSchema,
  provider_estimate_submission_id: uuidSchema,
  quote_id: uuidSchema,
  quote_version_id: uuidSchema,
  poster_user_id: uuidSchema,
  actor_user_id: uuidSchema,
  expected_draft_version: z.number().int().positive(),
  idempotency_key: idempotencyKeySchema,
}).strict().superRefine((command, context) => {
  if (command.actor_user_id !== command.poster_user_id) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'estimate acceptance requires the authenticated Poster identity',
      path: ['actor_user_id'],
    });
  }
});

export type SubmitUniversalV1ProviderEstimate = z.infer<
  typeof SubmitUniversalV1ProviderEstimateSchema
>;
export type IssueUniversalV1ProviderEstimateInvitation = z.infer<
  typeof IssueUniversalV1ProviderEstimateInvitationSchema
>;
export type AcceptUniversalV1ProviderEstimate = z.infer<
  typeof AcceptUniversalV1ProviderEstimateSchema
>;

export interface IssuedUniversalV1ProviderEstimateInvitation {
  readonly invitation_id: string;
  readonly quote_id: string;
  readonly task_draft_id: string;
  readonly routing_decision_id: string;
  readonly eligibility_decision_id: string;
  readonly expected_draft_version: number;
  readonly expected_eligibility_version: number;
  readonly valid_until: string;
  readonly request_sha256: string;
  readonly replayed: boolean;
  readonly payment_creation_performed: false;
  readonly financial_security_event_created: false;
  readonly conditional_hold_created: false;
  readonly hard_assignment_created: false;
  readonly work_order_created: false;
  readonly universal_payment_posture: 'PAYMENT_CREATION_FROZEN';
}

export interface SubmittedUniversalV1ProviderEstimate {
  readonly provider_estimate_submission_id: string;
  readonly quote_id: string;
  readonly quote_version_id: string;
  readonly quote_version: number;
  readonly routing_decision_id: string;
  readonly scope_sha256: string;
  readonly request_sha256: string;
  readonly replayed: boolean;
  readonly payment_creation_performed: false;
  readonly hard_assignment_created: false;
}

export interface AcceptedUniversalV1ProviderEstimate {
  readonly materialization_id: string;
  readonly task_draft_id: string;
  readonly task_id: string;
  readonly scope_version_id: string;
  readonly provider_estimate_submission_id: string;
  readonly prior_routing_decision_id: string;
  readonly resulting_routing_decision_id: string;
  readonly resulting_draft_version: number;
  readonly request_sha256: string;
  readonly replayed: boolean;
  readonly payment_creation_performed: false;
  readonly escrow_created: false;
  readonly hard_assignment_created: false;
  readonly universal_payment_posture: 'PAYMENT_CREATION_FROZEN';
}

export function universalV1EstimateSubmissionRequestSha256(
  command: SubmitUniversalV1ProviderEstimate,
): string {
  return universalTaskDraftRequestHash({
    operation: 'SUBMIT_PROVIDER_ESTIMATE',
    contract_version: 1,
    ...command,
  });
}

export function universalV1EstimateAcceptanceRequestSha256(
  command: AcceptUniversalV1ProviderEstimate,
): string {
  return universalTaskDraftRequestHash({
    operation: 'ACCEPT_PROVIDER_ESTIMATE',
    contract_version: 1,
    ...command,
  });
}
