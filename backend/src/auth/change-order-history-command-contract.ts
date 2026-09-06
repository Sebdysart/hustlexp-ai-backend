import { z } from 'zod';
import {
  FinancialProgressUuidSchema as uuid,
  PublicFinancialRequestProgressSchema as progress,
} from './financial-progress-command-contract.js';

const version = z.number().int().nonnegative().max(2_147_483_647);
const positiveVersion = version.refine((value) => value > 0);
const key = z.string().regex(/^[A-Za-z0-9:_-]{16,96}$/u);
const timestamp = z.string().datetime({ offset: true });
const money = z.number().int().safe().positive();
const currency = z.string().regex(/^[A-Z]{3}$/u);
const digest = z
  .string()
  .regex(/^[a-f0-9]{64}$/u)
  .refine((value) => value !== '0'.repeat(64));

export const ChangeOrderHistoryPayloadSchema = z
  .object({
    proposal_id: uuid,
    expected_proposal_version: positiveVersion,
    expected_scope_version: positiveVersion,
    expected_amendment_version: version,
    expected_execution_version: positiveVersion,
    expected_financial_version: version,
    idempotency_key: key,
  })
  .strict();
export type ChangeOrderHistoryPayload = z.infer<typeof ChangeOrderHistoryPayloadSchema>;

const phase = z
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
        customerTotalCents: money,
        currency,
        predecessorEventId: uuid,
        predecessorOperationId: uuid,
        expectedFinancialVersion: version,
        adjustmentOperationId: uuid,
        occurredAt: timestamp,
      })
      .strict(),
  })
  .strict();
const common = {
  observedAt: timestamp,
  actorUserId: uuid,
  identity: ChangeOrderHistoryPayloadSchema,
  phase,
};
const requestState = z.enum(['NOT_REQUESTED', 'OUTBOX_RECORDED', 'UNADMITTED_HELD']);
const result = z
  .object({
    amendment_id: uuid,
    amendment_version: positiveVersion,
    proposal_id: uuid,
    scope_version_id: uuid,
    scope_version: positiveVersion,
    adjustment_event_id: uuid,
    provider_kind: z.literal('FAKE'),
    replayed: z.literal(true),
    payment_creation_performed: z.literal(false),
    hard_assignment_created: z.literal(false),
  })
  .strict();
const compensation = z
  .object({
    compensationCommandId: uuid,
    adjustmentEventId: uuid,
    reversalOperationId: uuid,
    reversalIdempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{16,128}$/u),
    baseScopeVersionId: uuid,
    lifecycleExpectedVersion: positiveVersion,
    amountCents: money,
    currency,
    requestedBy: uuid,
    createdAt: timestamp,
    semanticLimitation: z.literal('PRIOR_SECURED_STATE_NOT_RESTORED'),
  })
  .strict();

/** Backend-only committed history. Reading it never authorizes a new effect. */
export const ChangeOrderHistorySchema = z
  .discriminatedUnion('state', [
    z
      .object({
        ...common,
        state: z.literal('PREPARED'),
        adjustmentRequestState: requestState,
        adjustmentProgress: progress.nullable(),
        predecessorExpiresAt: timestamp.nullable(),
      })
      .strict(),
    z.object({ ...common, state: z.literal('COMPLETED'), result }).strict(),
    z
      .object({
        ...common,
        state: z.literal('COMPENSATION_CLAIM'),
        compensation,
        reversalRequestState: requestState,
        reversalProgress: progress.nullable(),
      })
      .strict(),
    z
      .object({
        ...common,
        state: z.literal('CANCELLED'),
        terminal: z
          .object({
            terminalFactId: uuid,
            evidenceKind: z.enum(['REVERSAL', 'NO_EFFECT']),
            priorSecuredStateRestored: z.literal(false),
            executionResumeAuthorized: z.literal(false),
            captureResumeAuthorized: z.literal(false),
          })
          .strict(),
      })
      .strict(),
  ])
  .superRefine((history, context) => {
    const identity = history.identity,
      phase = history.phase,
      c = phase.context;
    let invalid =
      phase.idempotencyKey !== identity.idempotency_key ||
      c.proposalId !== identity.proposal_id ||
      c.scopeVersion !== identity.expected_scope_version + 1 ||
      c.expectedFinancialVersion !== identity.expected_financial_version ||
      Date.parse(history.observedAt) < Date.parse(c.occurredAt);
    if (history.state === 'COMPLETED') {
      const r = history.result;
      invalid ||=
        r.proposal_id !== c.proposalId ||
        r.scope_version_id !== c.scopeVersionId ||
        r.scope_version !== c.scopeVersion ||
        r.amendment_version !== identity.expected_amendment_version + 1;
    }
    if (history.state === 'PREPARED') {
      const p = history.adjustmentProgress;
      invalid ||= (history.adjustmentRequestState === 'OUTBOX_RECORDED') !== (p !== null);
      if (p)
        invalid ||=
          p.operationKind !== 'ADJUST' ||
          p.operationId !== c.adjustmentOperationId ||
          p.taskId !== c.taskId ||
          p.taskDraftId !== c.taskDraftId;
    }
    if (history.state === 'COMPENSATION_CLAIM') {
      const claim = history.compensation,
        p = history.reversalProgress;
      invalid ||= (history.reversalRequestState === 'OUTBOX_RECORDED') !== (p !== null);
      invalid ||=
        claim.amountCents !== c.customerTotalCents ||
        claim.currency !== c.currency ||
        claim.requestedBy !== history.actorUserId ||
        claim.lifecycleExpectedVersion !== c.expectedFinancialVersion + 2;
      if (p)
        invalid ||=
          p.operationKind !== 'REVERSAL' ||
          p.operationId !== claim.reversalOperationId ||
          p.taskId !== c.taskId ||
          p.taskDraftId !== c.taskDraftId;
    }
    if (invalid)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Historical change-order bindings disagree',
      });
  });
export type ChangeOrderHistory = z.infer<typeof ChangeOrderHistorySchema>;

export function changeOrderHistoryMatchesPayload(
  history: ChangeOrderHistory,
  payload: ChangeOrderHistoryPayload,
  actor: string
): boolean {
  return (
    history.actorUserId === actor &&
    Object.entries(payload).every(
      ([key, value]) => history.identity[key as keyof ChangeOrderHistoryPayload] === value
    )
  );
}

export function freezeChangeOrderHistory(
  history: ChangeOrderHistory
): Readonly<ChangeOrderHistory> {
  const freeze = (value: unknown): void => {
    if (value !== null && typeof value === 'object') {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  };
  freeze(history);
  return history;
}
