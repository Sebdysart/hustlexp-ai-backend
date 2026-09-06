import { z } from 'zod';
import {
  FinancialProgressUuidSchema as uuid,
  PublicFinancialRequestProgressSchema,
} from './financial-progress-command-contract.js';

const digest = z
  .string()
  .regex(/^[a-f0-9]{64}$/u)
  .refine((value) => value !== '0'.repeat(64));
const release = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const timestamp = z.string().datetime({ offset: true });
const version = z.number().int().positive().max(2_147_483_647);
const key = z.string().regex(/^[A-Za-z0-9:_-]{16,96}$/u);

export const WorkOrderHistoryPayloadSchema = z
  .object({
    conditional_hold_id: uuid,
    expected_eligibility_version: version,
    idempotency_key: key,
  })
  .strict();
export type WorkOrderHistoryPayload = z.infer<typeof WorkOrderHistoryPayloadSchema>;

const context = z
  .object({
    task_id: uuid,
    task_draft_id: uuid,
    scope_version_id: uuid,
    scope_version: version,
    routing_decision_id: uuid,
    provider_user_id: uuid,
    provider_organization_id: uuid.nullable(),
    provider_class: z.enum(['GENERAL_SERVICE_PROVIDER', 'VERIFIED_TRADE_BUSINESS']),
    trade_credential_id: uuid.nullable(),
    predecessor_eligibility_id: uuid,
    predecessor_eligibility_version: version,
    predecessor_valid_until: timestamp,
    poster_user_id: uuid,
    interest_application_id: uuid,
    eligibility_decision_id: uuid,
    eligibility_version: version,
    eligibility_valid_until: timestamp,
    conditional_hold_id: uuid,
    hold_reserved_at: timestamp,
    hold_expires_at: timestamp,
    provider_estimate_submission_id: uuid,
    customer_total_cents: z.number().int().safe().positive(),
    currency: z.string().regex(/^[A-Z]{3}$/u),
  })
  .strict();
const phase = z
  .object({
    completed: z.literal(false),
    context,
    idempotencyKey: key,
    requestSha256: digest,
    occurredAt: timestamp,
  })
  .strict();
const source = z
  .object({
    targetAuthorityId: uuid,
    releaseSha256: release,
    canonicalRequestSha256: digest,
    preparationExecutionId: uuid,
  })
  .strict();
const result = z
  .object({
    work_order_id: uuid,
    financial_security_event_id: uuid,
    replayed: z.literal(true),
    hard_assignment_created: z.literal(false),
    payment_creation_performed: z.literal(false),
  })
  .strict();
const compensation = z
  .object({
    compensation_command_id: uuid,
    work_order_idempotency_key: key,
    task_draft_id: uuid,
    task_id: uuid,
    scope_version_id: uuid,
    eligibility_decision_id: uuid,
    secured_event_id: uuid,
    secured_operation_id: uuid,
    void_operation_id: uuid,
    void_idempotency_key: z.string().regex(/^[A-Za-z0-9:_-]{16,128}$/u),
    amount_cents: z.number().int().safe().positive(),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    requested_by: uuid,
    created_at: timestamp,
    reason_code: z.enum(['FINALIZATION_FAILED', 'RECOVERY_TIMEOUT']),
  })
  .strict();

/** Backend-only historical facts; neither a new preparation nor authority to
 * execute a successor. A compensation claim stays terminal for Work Order creation. */
export const WorkOrderHistorySchema = z
  .discriminatedUnion('state', [
    z.object({ state: z.literal('PREPARED'), observedAt: timestamp, phase, source }).strict(),
    z
      .object({ state: z.literal('COMPLETED'), observedAt: timestamp, phase, source, result })
      .strict(),
    z
      .object({
        state: z.literal('COMPENSATION_CLAIM'),
        observedAt: timestamp,
        phase,
        source,
        compensation,
        voidProgress: PublicFinancialRequestProgressSchema.nullable(),
      })
      .strict(),
  ])
  .superRefine((history, ctx) => {
    const p = history.phase,
      c = p.context;
    let invalid =
      p.occurredAt !== c.hold_reserved_at ||
      c.predecessor_eligibility_id !== c.eligibility_decision_id ||
      c.predecessor_eligibility_version !== c.eligibility_version ||
      c.predecessor_valid_until !== c.eligibility_valid_until;
    if (history.state === 'COMPENSATION_CLAIM') {
      const claim = history.compensation,
        progress = history.voidProgress;
      invalid ||=
        claim.work_order_idempotency_key !== p.idempotencyKey ||
        claim.task_draft_id !== c.task_draft_id ||
        claim.task_id !== c.task_id ||
        claim.scope_version_id !== c.scope_version_id ||
        claim.eligibility_decision_id !== c.eligibility_decision_id ||
        claim.requested_by !== c.poster_user_id ||
        claim.amount_cents !== c.customer_total_cents ||
        claim.currency !== c.currency;
      if (progress !== null)
        invalid ||=
          progress.operationKind !== 'VOID' ||
          progress.operationId !== claim.void_operation_id ||
          progress.taskDraftId !== claim.task_draft_id ||
          progress.taskId !== claim.task_id ||
          (progress.financialEvent !== null && progress.financialEvent.eventKind !== 'VOIDED');
    }
    if (invalid)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Historical Work Order bindings disagree',
      });
  });
export type WorkOrderHistory = z.infer<typeof WorkOrderHistorySchema>;

export function workOrderHistoryMatchesPayload(
  history: WorkOrderHistory,
  payload: WorkOrderHistoryPayload,
  actor: string
): boolean {
  return (
    history.phase.idempotencyKey === payload.idempotency_key &&
    history.phase.context.conditional_hold_id === payload.conditional_hold_id &&
    history.phase.context.eligibility_version === payload.expected_eligibility_version &&
    history.phase.context.poster_user_id === actor
  );
}

export function freezeWorkOrderHistory(history: WorkOrderHistory): Readonly<WorkOrderHistory> {
  Object.freeze(history.phase.context);
  Object.freeze(history.phase);
  Object.freeze(history.source);
  if (history.state === 'COMPLETED') Object.freeze(history.result);
  if (history.state === 'COMPENSATION_CLAIM') {
    Object.freeze(history.compensation);
    if (history.voidProgress?.financialEvent) Object.freeze(history.voidProgress.financialEvent);
    if (history.voidProgress) Object.freeze(history.voidProgress);
  }
  return Object.freeze(history);
}
