import { z } from 'zod';

const version = z.number().int().safe().nonnegative();
const uuid = z.string().uuid();
/** Complete human preparation intent. Identity and release come from attestation. */
export const FakeFinancialPreparationPayloadSchema = z
  .object({
    operationKind: z.enum([
      'PREPARE_PAYMENT_METHOD',
      'AUTHORIZE',
      'SECURE',
      'VOID',
      'ADJUST',
      'CAPTURE',
      'REFUND',
      'REVERSAL',
      'SETTLE',
      'FUND',
      'PROVIDER_RELEASE',
      'PAYOUT',
      'OBSERVE_BANK_SETTLEMENT',
    ]),
    operationId: uuid,
    providerKind: z.literal('FAKE'),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{16,128}$/u),
    providerExpectedVersion: version,
    lifecycleExpectedVersion: version,
    providerRequestSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .refine((value) => value !== '0'.repeat(64)),
    taskDraftId: uuid,
    taskId: uuid.nullable(),
    eligibilityDecisionId: uuid.nullable(),
    scopeVersionId: uuid.nullable(),
    changeOrderId: uuid.nullable(),
    predecessorEventId: uuid.nullable(),
    completionFactId: uuid.nullable(),
    relatedOperationId: uuid.nullable(),
    amountCents: z.number().int().safe().positive().nullable(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/u)
      .nullable(),
  })
  .strict();
