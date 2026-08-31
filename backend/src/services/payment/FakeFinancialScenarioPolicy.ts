import type { FinancialOperationKind } from './FinancialProviderPorts.js';

export const FAKE_FINANCIAL_SCENARIO_VALUES = [
  'SUCCESS',
  'DECLINE',
  'TIMEOUT',
  'DUPLICATE_WEBHOOK',
  'RETRY',
  'REVERSAL',
  'PARTIAL_REFUND',
  'DELAYED_SETTLEMENT',
  'RECONCILIATION_MISMATCH',
  'PROVIDER_ACCOUNT_FAILURE',
] as const;

export type FakeFinancialScenario = (typeof FAKE_FINANCIAL_SCENARIO_VALUES)[number];

const ALL_OPERATION_KINDS = [
  'PREPARE_PAYMENT_METHOD',
  'AUTHORIZE',
  'SECURE',
  'VOID',
  'ADJUST',
  'CAPTURE',
  'REFUND',
  'REVERSAL',
  'ONBOARD_PROVIDER',
  'REFRESH_PROVIDER_ACCOUNT_STATE',
  'SETTLE',
  'FUND',
  'PROVIDER_RELEASE',
  'PAYOUT',
  'OBSERVE_BANK_SETTLEMENT',
  'INGEST_WEBHOOK',
  'RECONCILE',
] as const satisfies readonly FinancialOperationKind[];

const PROVIDER_COMMAND_KINDS = ALL_OPERATION_KINDS.filter(
  (kind) => kind !== 'INGEST_WEBHOOK' && kind !== 'RECONCILE'
);

const FAILURE_OR_RETRY_KINDS = [...PROVIDER_COMMAND_KINDS, 'RECONCILE'] as const;

const allowedOperations = Object.freeze({
  SUCCESS: new Set<FinancialOperationKind>(ALL_OPERATION_KINDS),
  DECLINE: new Set<FinancialOperationKind>(PROVIDER_COMMAND_KINDS),
  TIMEOUT: new Set<FinancialOperationKind>(FAILURE_OR_RETRY_KINDS),
  DUPLICATE_WEBHOOK: new Set<FinancialOperationKind>(['INGEST_WEBHOOK']),
  RETRY: new Set<FinancialOperationKind>(FAILURE_OR_RETRY_KINDS),
  REVERSAL: new Set<FinancialOperationKind>(['REVERSAL']),
  PARTIAL_REFUND: new Set<FinancialOperationKind>(['REFUND']),
  DELAYED_SETTLEMENT: new Set<FinancialOperationKind>([
    'SETTLE',
    'FUND',
    'PROVIDER_RELEASE',
    'PAYOUT',
    'OBSERVE_BANK_SETTLEMENT',
  ]),
  RECONCILIATION_MISMATCH: new Set<FinancialOperationKind>(['RECONCILE']),
  PROVIDER_ACCOUNT_FAILURE: new Set<FinancialOperationKind>([
    'ONBOARD_PROVIDER',
    'REFRESH_PROVIDER_ACCOUNT_STATE',
  ]),
} satisfies Readonly<Record<FakeFinancialScenario, ReadonlySet<FinancialOperationKind>>>);

export function isFakeFinancialScenario(value: unknown): value is FakeFinancialScenario {
  return (
    typeof value === 'string' &&
    (FAKE_FINANCIAL_SCENARIO_VALUES as readonly string[]).includes(value)
  );
}

export function fakeFinancialScenarioSupportsOperation(
  scenario: FakeFinancialScenario,
  operationKind: FinancialOperationKind
): boolean {
  return allowedOperations[scenario].has(operationKind);
}

export function assertFakeFinancialScenarioSupportsOperation(
  scenario: FakeFinancialScenario,
  operationKind: FinancialOperationKind
): void {
  if (!fakeFinancialScenarioSupportsOperation(scenario, operationKind)) {
    throw new Error('FAKE_FINANCIAL_SCENARIO_OPERATION_INVALID');
  }
}
