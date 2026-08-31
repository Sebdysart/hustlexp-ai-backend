import { describe, expect, it } from 'vitest';

import {
  syntheticFinancialEventCommandSchema,
  syntheticFinancialJobEnvelopeSchema,
  syntheticReconciliationCommandSchema,
} from '../../src/services/payment/SyntheticFinancialCommandSchemas.js';

const ids = {
  actor: '00000000-0000-4000-8000-000000000401',
  draft: '00000000-0000-4000-8000-000000000402',
  task: '00000000-0000-4000-8000-000000000403',
  eligibility: '00000000-0000-4000-8000-000000000404',
  scope: '00000000-0000-4000-8000-000000000405',
  operation: '00000000-0000-4000-8000-000000000406',
  predecessor: '00000000-0000-4000-8000-000000000407',
  related: '00000000-0000-4000-8000-000000000408',
  workOrder: '00000000-0000-4000-8000-000000000409',
} as const;

const commandBase = {
  providerKind: 'FAKE' as const,
  operationId: ids.operation,
  providerExpectedVersion: 0,
  lifecycleExpectedVersion: 1,
  taskDraftId: ids.draft,
  taskId: ids.task,
  eligibilityDecisionId: ids.eligibility,
  scopeVersionId: ids.scope,
  occurredAt: '2026-08-30T12:00:00.000Z',
};

const boundCommand = {
  ...commandBase,
  idempotencyKey: 'schema:authorize:0001',
  operationKind: 'AUTHORIZE' as const,
  predecessorEventId: ids.predecessor,
  relatedOperationId: ids.related,
  amountCents: 12_500,
  currency: 'usd',
};

const terminalOperationKinds = [
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
] as const;

const reconciliationCommand = syntheticReconciliationCommandSchema.parse({
  providerKind: 'FAKE',
  operationId: ids.operation,
  idempotencyKey: 'schema:reconcile:0001',
  providerExpectedVersion: 0,
  relatedOperationId: ids.related,
  snapshot: {
    workOrderId: ids.workOrder,
    reconciliationVersion: 1,
    voidState: 'NOT_APPLICABLE',
    captureState: 'NOT_APPLICABLE',
    refundState: 'NOT_APPLICABLE',
    reversalState: 'NOT_APPLICABLE',
    settlementState: 'NOT_APPLICABLE',
    fundingState: 'NOT_APPLICABLE',
    providerReleaseState: 'NOT_APPLICABLE',
    payoutState: 'NOT_APPLICABLE',
    bankSettlementState: 'NOT_APPLICABLE',
    ledgerState: 'MATCHED',
    reconciliationState: 'MATCHED',
    mismatchCodes: [],
    customerLedgerAmountCents: 12_500,
    providerLedgerAmountCents: 10_000,
    currency: 'USD',
    expectedVersion: 0,
  },
});

describe('public synthetic financial command schemas', () => {
  it('admits only the pre-WorkOrder preparation, authorization, and secure event lane', () => {
    expect(
      syntheticFinancialEventCommandSchema.safeParse({
        ...commandBase,
        lifecycleExpectedVersion: 0,
        operationKind: 'PREPARE_PAYMENT_METHOD',
        idempotencyKey: 'schema:prepare:0001',
        customerId: 'synthetic-customer',
      }).success
    ).toBe(true);
    expect(syntheticFinancialEventCommandSchema.safeParse(boundCommand).success).toBe(true);
    expect(
      syntheticFinancialEventCommandSchema.safeParse({
        ...boundCommand,
        operationKind: 'SECURE',
        idempotencyKey: 'schema:secure:0001',
        lifecycleExpectedVersion: 2,
      }).success
    ).toBe(true);
  });

  it.each(terminalOperationKinds)('rejects public terminal event kind %s', (operationKind) => {
    expect(
      syntheticFinancialEventCommandSchema.safeParse({
        ...boundCommand,
        operationKind,
        idempotencyKey: `schema:terminal:${operationKind.toLowerCase()}:0001`,
      }).success
    ).toBe(false);
  });

  it.each(terminalOperationKinds)(
    'rejects signed worker envelopes carrying terminal event kind %s',
    (operationKind) => {
      expect(
        syntheticFinancialJobEnvelopeSchema.safeParse({
          version: 1,
          kind: 'FINANCIAL_EVENT',
          actorId: ids.actor,
          command: {
            ...boundCommand,
            operationKind,
            idempotencyKey: `schema:job:${operationKind.toLowerCase()}:0001`,
          },
        }).success
      ).toBe(false);
    }
  );

  it('rejects signed reconciliation job envelopes even when the internal command is valid', () => {
    expect(
      syntheticFinancialJobEnvelopeSchema.safeParse({
        version: 1,
        kind: 'RECONCILIATION',
        actorId: ids.actor,
        command: reconciliationCommand,
      }).success
    ).toBe(false);
  });
});
