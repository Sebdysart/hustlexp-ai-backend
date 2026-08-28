import { createHash } from 'node:crypto';
import { z } from 'zod';

const uuid = z.string().uuid();
const key = z.string().trim().min(16).max(96).regex(/^[A-Za-z0-9:_-]+$/u);
const clientTs = z.string().datetime();

export const ExpressUniversalV1ProviderInterestPublicSchema = z.object({
  task_id: uuid, expected_scope_version: z.number().int().positive(),
  idempotency_key: key, client_ts: clientTs,
}).strict();
export const PlaceUniversalV1ConditionalHoldPublicSchema = z.object({
  interest_application_id: uuid, expected_eligibility_version: z.number().int().positive(),
  idempotency_key: key, client_ts: clientTs,
}).strict();
export const MaterializeUniversalV1WorkOrderPublicSchema = z.object({
  conditional_hold_id: uuid, expected_eligibility_version: z.number().int().positive(),
  idempotency_key: key, client_ts: clientTs,
}).strict();

export type ExpressInterestPublic = z.infer<typeof ExpressUniversalV1ProviderInterestPublicSchema>;
export type PlaceHoldPublic = z.infer<typeof PlaceUniversalV1ConditionalHoldPublicSchema>;
export type MaterializeWorkOrderPublic = z.infer<typeof MaterializeUniversalV1WorkOrderPublicSchema>;

export interface ProviderInterestContext {
  task_id: string; task_draft_id: string; scope_version_id: string; scope_version: number;
  routing_decision_id: string; provider_user_id: string; provider_organization_id: string | null;
  provider_class: 'GENERAL_SERVICE_PROVIDER' | 'VERIFIED_TRADE_BUSINESS';
  trade_credential_id: string | null; predecessor_eligibility_id: string;
  predecessor_eligibility_version: number; predecessor_valid_until: string;
}
export interface HoldContext extends ProviderInterestContext {
  poster_user_id: string; interest_application_id: string; eligibility_decision_id: string;
  eligibility_version: number; eligibility_valid_until: string;
}
export interface WorkOrderContext extends HoldContext {
  conditional_hold_id: string; hold_reserved_at: string; hold_expires_at: string;
  provider_estimate_submission_id: string; customer_total_cents: number; currency: string;
}

export const commandHash = (value: object): string => createHash('sha256')
  .update(JSON.stringify(value, Object.keys(value).sort())).digest('hex');

export type UniversalV1WorkOrderErrorCode =
  | 'WORK_ORDER_CONTEXT_UNAVAILABLE' | 'WORK_ORDER_VERSION_CONFLICT'
  | 'WORK_ORDER_REQUEST_STALE' | 'WORK_ORDER_IDEMPOTENCY_CONFLICT'
  | 'WORK_ORDER_AUTHORITY_REVOKED' | 'WORK_ORDER_MATERIALIZATION_FAILED'
  | 'WORK_ORDER_HARD_ASSIGNMENT_FORBIDDEN';
export class UniversalV1WorkOrderError extends Error {
  constructor(readonly code: UniversalV1WorkOrderErrorCode, message: string) { super(message); }
}
