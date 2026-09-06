import { z } from 'zod';
import {
  FinancialProgressUuidSchema as uuid,
  PublicFinancialRequestProgressSchema,
} from './financial-progress-command-contract.js';

const operationKind = z.enum(['PREPARE_PAYMENT_METHOD', 'AUTHORIZE', 'SECURE']);
const releaseDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const timestamp = z.string().datetime({ offset: true });

/** Server expectations derived from the current foreground command, never
 * caller-supplied provider facts or a delegation to issue a successor. */
export const FakeFinancialPredecessorPayloadSchema = z
  .object({
    operationKind,
    operationId: uuid,
    taskDraftId: uuid,
    idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{16,128}$/u),
  })
  .strict();
export type FakeFinancialPredecessorPayload = z.infer<typeof FakeFinancialPredecessorPayloadSchema>;

const eventKinds = {
  PREPARE_PAYMENT_METHOD: 'PAYMENT_METHOD_PREPARED',
  AUTHORIZE: 'AUTHORIZED',
  SECURE: 'SECURED',
} as const;

/** Historical committed evidence for backend use only. A later command must
 * independently prove current authority, predecessor version and expiry. */
export const FinancialPredecessorSchema = z
  .object({
    commandId: uuid,
    idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{16,128}$/u),
    preparedCommandId: uuid,
    operationId: uuid,
    operationKind,
    financialEventId: uuid,
    eventKind: z.string(),
    lifecycleExpectedVersion: z.number().int().safe().nonnegative(),
    taskDraftId: uuid,
    taskId: uuid.nullable(),
    scopeVersionId: uuid.nullable(),
    eligibilityDecisionId: uuid.nullable(),
    predecessorEventId: uuid.nullable(),
    amountCents: z.number().int().safe().positive().nullable(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/u)
      .nullable(),
    externalReference: z.string().min(1).max(512).nullable(),
    occurredAt: timestamp,
    expiresAt: timestamp.nullable(),
    sourceTargetAuthorityId: uuid,
    sourceReleaseSha256: releaseDigest,
  })
  .strict()
  .superRefine((value, ctx) => {
    const preparation = value.operationKind === 'PREPARE_PAYMENT_METHOD';
    if (
      value.eventKind !== eventKinds[value.operationKind] ||
      (preparation
        ? value.externalReference === null ||
          value.amountCents !== null ||
          value.currency !== null ||
          value.predecessorEventId !== null
        : value.externalReference !== null ||
          value.amountCents === null ||
          value.currency === null ||
          value.predecessorEventId === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Predecessor operation facts do not agree',
      });
    }
  });
export type FinancialPredecessor = z.infer<typeof FinancialPredecessorSchema>;

export const FinancialPredecessorFactsSchema = z
  .object({
    idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{16,128}$/u),
    progress: PublicFinancialRequestProgressSchema,
    predecessor: FinancialPredecessorSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const { progress, predecessor } = value;
    const usable =
      progress.progressState === 'MATERIALIZED' && progress.financialEvent?.status === 'SUCCEEDED';
    if (
      !operationKind.safeParse(progress.operationKind).success ||
      usable !== (predecessor !== null) ||
      (predecessor !== null &&
        (predecessor.idempotencyKey !== value.idempotencyKey ||
          predecessor.commandId !== progress.commandId ||
          predecessor.operationId !== progress.operationId ||
          predecessor.operationKind !== progress.operationKind ||
          predecessor.taskDraftId !== progress.taskDraftId ||
          predecessor.taskId !== progress.taskId ||
          predecessor.financialEventId !== progress.financialEvent?.id ||
          predecessor.eventKind !== progress.financialEvent?.eventKind))
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Committed predecessor does not match progress',
      });
  });
export type FinancialPredecessorFacts = z.infer<typeof FinancialPredecessorFactsSchema>;

export function financialPredecessorMatchesPayload(
  value: FinancialPredecessorFacts,
  expected: FakeFinancialPredecessorPayload
): boolean {
  return (
    value.idempotencyKey === expected.idempotencyKey &&
    value.progress.operationId === expected.operationId &&
    value.progress.operationKind === expected.operationKind &&
    value.progress.taskDraftId === expected.taskDraftId
  );
}

export function freezeFinancialPredecessorFacts(
  value: FinancialPredecessorFacts
): Readonly<FinancialPredecessorFacts> {
  if (value.predecessor) Object.freeze(value.predecessor);
  if (value.progress.financialEvent) Object.freeze(value.progress.financialEvent);
  Object.freeze(value.progress);
  return Object.freeze(value);
}
