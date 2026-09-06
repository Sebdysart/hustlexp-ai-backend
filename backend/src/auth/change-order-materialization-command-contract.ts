import { z } from 'zod';
import { ChangeOrderHistoryPayloadSchema } from './change-order-history-command-contract.js';
import { FinancialProgressUuidSchema as uuid } from './financial-progress-command-contract.js';

const version = z.number().int().nonnegative().max(2_147_483_647);
const positiveVersion = version.refine((value) => value > 0);
const key = z.string().regex(/^[A-Za-z0-9:_-]{16,96}$/u);
const digest = z
  .string()
  .regex(/^[a-f0-9]{64}$/u)
  .refine((value) => value !== '0'.repeat(64));
const epoch = z.number().int().safe().nonnegative();

export const ChangeOrderKindPayloadSchema = z.object({ proposal_id: uuid }).strict();
export const ChangeOrderKindResultSchema = z
  .enum(['SCOPE_ONLY', 'PRICE_AND_SCOPE', 'SCHEDULE_AND_SCOPE'])
  .nullable();
export const PrepareChangeOrderPayloadSchema = ChangeOrderHistoryPayloadSchema.extend({
  client_timestamp_epoch_ms: epoch,
}).strict();
export const FinalizeChangeOrderPayloadSchema = PrepareChangeOrderPayloadSchema.extend({
  phase_request_sha256: digest,
  adjustment_event_id: uuid,
}).strict();
export type PrepareChangeOrderPayload = z.infer<typeof PrepareChangeOrderPayloadSchema>;
export type FinalizeChangeOrderPayload = z.infer<typeof FinalizeChangeOrderPayloadSchema>;

export const MaterializedChangeOrderResultSchema = z
  .object({
    amendment_id: uuid,
    amendment_version: positiveVersion,
    proposal_id: uuid,
    scope_version_id: uuid,
    scope_version: positiveVersion,
    adjustment_event_id: uuid.nullable(),
    provider_kind: z.literal('FAKE').nullable(),
    replayed: z.boolean(),
    payment_creation_performed: z.literal(false),
    hard_assignment_created: z.literal(false),
  })
  .strict()
  .refine((result) => (result.adjustment_event_id === null) === (result.provider_kind === null));
export const PreparedChangeOrderPhaseSchema = z
  .object({
    completed: z.literal(false),
    idempotencyKey: key,
    requestSha256: digest,
    context: z
      .object({
        proposalId: uuid,
        workOrderId: uuid,
        taskId: uuid,
        taskDraftId: uuid,
        eligibilityDecisionId: uuid,
        scopeVersionId: uuid,
        scopeVersion: positiveVersion,
        customerTotalCents: z.number().int().safe().positive(),
        currency: z.string().regex(/^[A-Z]{3}$/u),
        predecessorEventId: uuid,
        predecessorOperationId: uuid,
        expectedFinancialVersion: version,
        adjustmentOperationId: uuid,
        occurredAt: z.string().datetime({ offset: true }),
      })
      .strict(),
  })
  .strict();
export const ChangeOrderMaterializationPhaseSchema = z.discriminatedUnion('completed', [
  PreparedChangeOrderPhaseSchema,
  z.object({ completed: z.literal(true), result: MaterializedChangeOrderResultSchema }).strict(),
]);

export function changeOrderResultMatchesInput(
  result: z.infer<typeof MaterializedChangeOrderResultSchema>,
  payload: PrepareChangeOrderPayload
): boolean {
  return (
    result.proposal_id === payload.proposal_id &&
    result.scope_version === payload.expected_scope_version + 1 &&
    result.amendment_version === payload.expected_amendment_version + 1
  );
}
