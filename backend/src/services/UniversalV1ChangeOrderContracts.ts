import { createHash } from 'node:crypto';

import { z } from 'zod';

const uuid = z.string().uuid();
const idempotencyKey = z
  .string()
  .trim()
  .min(16)
  .max(96)
  .regex(/^[A-Za-z0-9:_-]+$/u);
const clientTimestamp = z.string().datetime();
const positiveCents = z.number().int().positive().max(100_000_000);

export const UniversalV1ChangeOrderScopeSchema = z
  .object({
    title: z.string().trim().min(3).max(200),
    description: z.string().trim().min(10).max(5_000),
    requirements: z.string().trim().min(3).max(5_000).nullable().default(null),
    checklist: z.array(z.string().trim().min(1).max(500)).min(1).max(50),
  })
  .strict();

const proposalBase = {
  work_order_id: uuid,
  expected_scope_version: z.number().int().positive(),
  expected_amendment_version: z.number().int().nonnegative(),
  expected_latest_proposal_version: z.number().int().nonnegative(),
  observed_scope_summary: z.string().trim().min(3).max(1_000),
  proposed_scope: UniversalV1ChangeOrderScopeSchema,
  idempotency_key: idempotencyKey,
  client_ts: clientTimestamp,
} as const;

const ScopeOnlyProposalSchema = z
  .object({
    ...proposalBase,
    change_order_kind: z.literal('SCOPE_ONLY'),
  })
  .strict();

const PriceAndScopeProposalSchema = z
  .object({
    ...proposalBase,
    change_order_kind: z.literal('PRICE_AND_SCOPE'),
    proposed_customer_total_cents: positiveCents,
    proposed_provider_payout_cents: positiveCents,
  })
  .strict()
  .superRefine((command, context) => {
    if (command.proposed_provider_payout_cents > command.proposed_customer_total_cents) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proposed_provider_payout_cents'],
        message: 'Provider payout cannot exceed the customer total.',
      });
    }
  });

/**
 * Schedule changes are intentionally absent. The current Work Order amendment
 * schema has no structured schedule authority, so accepting free text would
 * claim a contract transition that cannot be materialized truthfully.
 */
export const ProposeUniversalV1ChangeOrderPublicSchema = z.union([
  ScopeOnlyProposalSchema,
  PriceAndScopeProposalSchema,
]);

export const DecideUniversalV1ChangeOrderPublicSchema = z
  .object({
    proposal_id: uuid,
    expected_proposal_version: z.number().int().positive(),
    decision: z.enum(['APPROVED', 'REJECTED']),
    reason: z.string().trim().min(3).max(1_000),
    idempotency_key: idempotencyKey,
    client_ts: clientTimestamp,
  })
  .strict();

export const AuthorizeAndMaterializeUniversalV1ChangeOrderPublicSchema = z
  .object({
    proposal_id: uuid,
    expected_proposal_version: z.number().int().positive(),
    expected_scope_version: z.number().int().positive(),
    expected_amendment_version: z.number().int().nonnegative(),
    expected_execution_version: z.number().int().positive(),
    expected_financial_version: z.number().int().nonnegative(),
    idempotency_key: idempotencyKey,
    client_ts: clientTimestamp,
  })
  .strict();

export type ProposeUniversalV1ChangeOrderPublic = z.infer<
  typeof ProposeUniversalV1ChangeOrderPublicSchema
>;
export type DecideUniversalV1ChangeOrderPublic = z.infer<
  typeof DecideUniversalV1ChangeOrderPublicSchema
>;
export type AuthorizeAndMaterializeUniversalV1ChangeOrderPublic = z.infer<
  typeof AuthorizeAndMaterializeUniversalV1ChangeOrderPublicSchema
>;

export type UniversalV1ChangeOrderKind = ProposeUniversalV1ChangeOrderPublic['change_order_kind'];
export type UniversalV1ChangeOrderParty = 'CUSTOMER' | 'PROVIDER';

export interface ProposedUniversalV1ChangeOrder {
  readonly proposal_id: string;
  readonly proposal_version: number;
  readonly change_order_kind: UniversalV1ChangeOrderKind;
  readonly proposer_party: UniversalV1ChangeOrderParty;
  readonly proposed_scope_sha256: string;
  readonly replayed: boolean;
  readonly payment_creation_performed: false;
  readonly hard_assignment_created: false;
}

export interface DecidedUniversalV1ChangeOrder {
  readonly approval_id: string;
  readonly proposal_id: string;
  readonly proposal_version: number;
  readonly approver_party: UniversalV1ChangeOrderParty;
  readonly decision: 'APPROVED' | 'REJECTED';
  readonly proposal_status: 'PENDING' | 'REJECTED';
  readonly replayed: boolean;
  readonly payment_creation_performed: false;
  readonly hard_assignment_created: false;
}

export interface MaterializedUniversalV1ChangeOrder {
  readonly amendment_id: string;
  readonly amendment_version: number;
  readonly proposal_id: string;
  readonly scope_version_id: string;
  readonly scope_version: number;
  readonly adjustment_event_id: string | null;
  readonly provider_kind: 'FAKE' | null;
  readonly replayed: boolean;
  readonly payment_creation_performed: false;
  readonly hard_assignment_created: false;
}

export type UniversalV1ChangeOrderErrorCode =
  | 'CHANGE_ORDER_CONTEXT_UNAVAILABLE'
  | 'CHANGE_ORDER_REQUEST_STALE'
  | 'CHANGE_ORDER_VERSION_CONFLICT'
  | 'CHANGE_ORDER_IDEMPOTENCY_CONFLICT'
  | 'CHANGE_ORDER_AUTHORITY_REVOKED'
  | 'CHANGE_ORDER_INDEPENDENT_APPROVAL_REQUIRED'
  | 'CHANGE_ORDER_STATE_CONFLICT'
  | 'CHANGE_ORDER_SCHEDULE_UNSUPPORTED'
  | 'CHANGE_ORDER_SCOPE_HASH_MISMATCH'
  | 'CHANGE_ORDER_FAKE_FINANCE_ONLY'
  | 'CHANGE_ORDER_MATERIALIZATION_FAILED'
  | 'CHANGE_ORDER_HARD_ASSIGNMENT_FORBIDDEN';

export class UniversalV1ChangeOrderError extends Error {
  constructor(
    readonly code: UniversalV1ChangeOrderErrorCode,
    message: string
  ) {
    super(message);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, entry]) => `${JSON.stringify(name)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Stable, recursive command hashing. Scope hashes come from PostgreSQL. */
export function universalV1ChangeOrderCommandHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}
