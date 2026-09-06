import { z } from 'zod';
import { FakeFinancialPreparationPayloadSchema } from './financial-preparation-command-contract.js';

export const FinancialProgressUuidSchema = z
  .string()
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
export const FakeFinancialProgressPayloadSchema = z
  .object({ commandId: FinancialProgressUuidSchema })
  .strict();
const operationEvent = {
  PREPARE_PAYMENT_METHOD: 'PAYMENT_METHOD_PREPARED',
  AUTHORIZE: 'AUTHORIZED',
  SECURE: 'SECURED',
  VOID: 'VOIDED',
  ADJUST: 'ADJUSTMENT_AUTHORIZED',
  CAPTURE: 'CAPTURED',
  REFUND: 'REFUNDED',
  REVERSAL: 'REVERSED',
  SETTLE: 'SETTLEMENT_OBSERVED',
  FUND: 'FUNDING_OBSERVED',
  PROVIDER_RELEASE: 'PROVIDER_RELEASED',
  PAYOUT: 'PAYOUT_OBSERVED',
  OBSERVE_BANK_SETTLEMENT: 'BANK_SETTLEMENT_OBSERVED',
} as const;

/** A snapshot of committed facts. MATERIALIZED includes declined/failed results;
 * PUBLISHED records historical confirmation and does not attest current Redis. */
export const PublicFinancialRequestProgressSchema = z
  .object({
    commandId: FinancialProgressUuidSchema,
    operationId: FinancialProgressUuidSchema,
    operationKind: FakeFinancialPreparationPayloadSchema.shape.operationKind,
    taskDraftId: FinancialProgressUuidSchema,
    taskId: FinancialProgressUuidSchema.nullable(),
    requestedAt: z.string().datetime({ offset: true }),
    observedAt: z.string().datetime({ offset: true }),
    requestState: z.literal('REQUESTED'),
    progressState: z.enum([
      'REQUESTED',
      'PUBLISHED',
      'PROCESSING',
      'RECOVERY_REQUIRED',
      'MATERIALIZED',
    ]),
    financialEvent: z
      .object({
        id: FinancialProgressUuidSchema,
        eventKind: z.string(),
        status: z.enum(['SUCCEEDED', 'DECLINED', 'FAILED']),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .refine(
    (value) =>
      (value.progressState === 'MATERIALIZED') === (value.financialEvent !== null) &&
      (value.financialEvent === null ||
        value.financialEvent.eventKind === operationEvent[value.operationKind]) &&
      Date.parse(value.observedAt) >= Date.parse(value.requestedAt)
  );
export type PublicFinancialRequestProgress = z.infer<typeof PublicFinancialRequestProgressSchema>;
