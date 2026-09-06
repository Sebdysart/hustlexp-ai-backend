import { z } from 'zod';
import { UniversalV1ChangeOrderScopeSchema } from '../services/UniversalV1ChangeOrderContracts.js';

const uuid = z
  .string()
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
const version = z.number().int().nonnegative().max(2147483647);
const key = z.string().regex(/^[A-Za-z0-9:_-]{16,96}$/u);
const timestamp = z.number().int().safe().nonnegative();
const money = z.number().int().positive().max(100_000_000);
const base = {
  work_order_id: uuid,
  expected_scope_version: version.refine((value) => value > 0),
  expected_amendment_version: version,
  expected_latest_proposal_version: version,
  observed_scope_summary: z.string().trim().min(3).max(1000),
  proposed_scope: UniversalV1ChangeOrderScopeSchema,
  idempotency_key: key,
  client_timestamp_epoch_ms: timestamp,
};
export const ProposeChangeOrderPayloadSchema = z.union([
  z.object({ ...base, change_order_kind: z.literal('SCOPE_ONLY') }).strict(),
  z
    .object({
      ...base,
      change_order_kind: z.literal('PRICE_AND_SCOPE'),
      proposed_customer_total_cents: money,
      proposed_provider_payout_cents: money,
    })
    .strict()
    .refine((value) => value.proposed_provider_payout_cents <= value.proposed_customer_total_cents),
]);
export const DecideChangeOrderPayloadSchema = z
  .object({
    proposal_id: uuid,
    expected_proposal_version: version.refine((value) => value > 0),
    decision: z.enum(['APPROVED', 'REJECTED']),
    reason: z.string().trim().min(3).max(1000),
    idempotency_key: key,
    client_timestamp_epoch_ms: timestamp,
  })
  .strict();
export type ProposeChangeOrderPayload = z.infer<typeof ProposeChangeOrderPayloadSchema>;
export type DecideChangeOrderPayload = z.infer<typeof DecideChangeOrderPayloadSchema>;

const safety = {
  replayed: z.boolean(),
  payment_creation_performed: z.literal(false),
  hard_assignment_created: z.literal(false),
};
export const ProposedChangeOrderResultSchema = z
  .object({
    proposal_id: uuid,
    proposal_version: version.refine((value) => value > 0),
    change_order_kind: z.enum(['SCOPE_ONLY', 'PRICE_AND_SCOPE']),
    proposer_party: z.enum(['CUSTOMER', 'PROVIDER']),
    proposed_scope_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    ...safety,
  })
  .strict();
export const DecidedChangeOrderResultSchema = z
  .object({
    approval_id: uuid,
    proposal_id: uuid,
    proposal_version: version.refine((value) => value > 0),
    approver_party: z.enum(['CUSTOMER', 'PROVIDER']),
    decision: z.enum(['APPROVED', 'REJECTED']),
    proposal_status: z.enum(['PENDING', 'REJECTED']),
    ...safety,
  })
  .strict();

/** Only parsed, acyclic JSON command/receipt values cross this boundary. */
export function freezeChangeOrderCommand<Value>(value: Value): Readonly<Value> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeChangeOrderCommand(child);
    Object.freeze(value);
  }
  return value;
}
