import { describe, expect, it } from 'vitest';

import {
  FAKE_FINANCIAL_SCENARIO_VALUES,
  fakeFinancialScenarioSupportsOperation,
} from '../../src/services/payment/FakeFinancialScenarioPolicy.js';
import {
  syntheticFinancialEventCommandSchema,
  syntheticProviderAccountStateCommandSchema,
  syntheticProviderOnboardingCommandSchema,
} from '../../src/services/payment/SyntheticFinancialCommandSchemas.js';

const ids = {
  operation: '00000000-0000-4000-8000-000000000101',
  predecessor: '00000000-0000-4000-8000-000000000102',
  related: '00000000-0000-4000-8000-000000000103',
  taskDraft: '00000000-0000-4000-8000-000000000104',
  task: '00000000-0000-4000-8000-000000000105',
  eligibility: '00000000-0000-4000-8000-000000000106',
  scope: '00000000-0000-4000-8000-000000000107',
} as const;

function boundCommand() {
  return {
    providerKind: 'FAKE' as const,
    operationId: ids.operation,
    idempotencyKey: 'policy:financial:event:0001',
    providerExpectedVersion: 0,
    lifecycleExpectedVersion: 0,
    taskDraftId: ids.taskDraft,
    taskId: ids.task,
    eligibilityDecisionId: ids.eligibility,
    scopeVersionId: ids.scope,
    occurredAt: '2026-08-28T00:00:00.000Z',
    operationKind: 'AUTHORIZE' as const,
    predecessorEventId: ids.predecessor,
    relatedOperationId: ids.related,
    amountCents: 12_500,
    currency: 'usd',
  };
}

describe('fake financial scenario policy', () => {
  it('keeps the ten deterministic scenarios explicit and operation-bound', () => {
    expect(new Set(FAKE_FINANCIAL_SCENARIO_VALUES).size).toBe(10);
    expect(fakeFinancialScenarioSupportsOperation('REVERSAL', 'REVERSAL')).toBe(true);
    expect(fakeFinancialScenarioSupportsOperation('REVERSAL', 'CAPTURE')).toBe(false);
    expect(fakeFinancialScenarioSupportsOperation('PARTIAL_REFUND', 'REFUND')).toBe(true);
    expect(fakeFinancialScenarioSupportsOperation('PARTIAL_REFUND', 'AUTHORIZE')).toBe(false);
    expect(fakeFinancialScenarioSupportsOperation('DUPLICATE_WEBHOOK', 'INGEST_WEBHOOK')).toBe(true);
    expect(fakeFinancialScenarioSupportsOperation('DUPLICATE_WEBHOOK', 'PAYOUT')).toBe(false);
    expect(fakeFinancialScenarioSupportsOperation('RECONCILIATION_MISMATCH', 'RECONCILE')).toBe(
      true
    );
    expect(fakeFinancialScenarioSupportsOperation('RECONCILIATION_MISMATCH', 'SETTLE')).toBe(
      false
    );
  });

  it('rejects invalid scenario-operation pairs at the route schema boundary', () => {
    const invalid = syntheticFinancialEventCommandSchema.safeParse({
      ...boundCommand(),
      scenario: 'REVERSAL',
    });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['scenario'],
            message: 'FAKE_FINANCIAL_SCENARIO_OPERATION_INVALID',
          }),
        ])
      );
    }

    const valid = syntheticFinancialEventCommandSchema.safeParse({
      ...boundCommand(),
      scenario: 'DECLINE',
    });
    expect(valid.success).toBe(true);
  });

  it('keeps account failure on account operations while permitting a restricted decline', () => {
    const providerBase = {
      providerKind: 'FAKE' as const,
      operationId: ids.operation,
      idempotencyKey: 'policy:provider:account:0001',
      providerExpectedVersion: 0,
    };
    expect(
      syntheticProviderOnboardingCommandSchema.safeParse({
        ...providerBase,
        scenario: 'PROVIDER_ACCOUNT_FAILURE',
      }).success
    ).toBe(true);
    expect(
      syntheticProviderAccountStateCommandSchema.safeParse({
        ...providerBase,
        scenario: 'DECLINE',
        providerAccountReference: 'fake-provider-account-1',
      }).success
    ).toBe(true);
    expect(
      syntheticProviderAccountStateCommandSchema.safeParse({
        ...providerBase,
        scenario: 'RECONCILIATION_MISMATCH',
        providerAccountReference: 'fake-provider-account-1',
      }).success
    ).toBe(false);
  });
});
