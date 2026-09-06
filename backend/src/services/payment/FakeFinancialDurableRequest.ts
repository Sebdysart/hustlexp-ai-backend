import { createHash } from 'node:crypto';
import {
  canonicalFinancialProviderRequestJson,
  MAX_CANONICAL_FINANCIAL_REQUEST_BYTES,
} from './FinancialProviderRequestCanonicalization.js';
import {
  fakeFinancialScenarioSupportsOperation,
  isFakeFinancialScenario,
} from './FakeFinancialScenarioPolicy.js';

export const FAKE_FINANCIAL_DURABLE_REQUEST_OPERATIONS = [
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
] as const;
export type FakeFinancialDurableRequestOperation =
  (typeof FAKE_FINANCIAL_DURABLE_REQUEST_OPERATIONS)[number];
export interface FakeFinancialDurableRequest {
  readonly operationKind: FakeFinancialDurableRequestOperation;
  readonly payloadContractVersion: 1;
  readonly canonicalRequestJson: string;
  readonly providerRequestSha256: string;
  readonly request: Readonly<Record<string, string | number>>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9:_-]{16,128}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const extraFields = {
  PREPARE_PAYMENT_METHOD: ['customerId'],
  AUTHORIZE: ['paymentMethodReference'],
  SECURE: ['authorizationOperationId'],
  VOID: [],
  ADJUST: ['scopeVersionId', 'changeOrderId'],
  CAPTURE: [],
  REFUND: ['originalAmountCents'],
  REVERSAL: [],
  SETTLE: [],
  FUND: [],
  PROVIDER_RELEASE: [],
  PAYOUT: ['providerAccountReference'],
  OBSERVE_BANK_SETTLEMENT: [],
} as const satisfies Readonly<Record<FakeFinancialDurableRequestOperation, readonly string[]>>;
function refuse(reason: string): never {
  throw new Error(`FAKE_FINANCIAL_DURABLE_REQUEST_${reason}`);
}
function operationKind(value: unknown): FakeFinancialDurableRequestOperation {
  if (
    typeof value !== 'string' ||
    !(FAKE_FINANCIAL_DURABLE_REQUEST_OPERATIONS as readonly string[]).includes(value)
  )
    return refuse('OPERATION_INVALID');
  return value as FakeFinancialDurableRequestOperation;
}
function integer(value: unknown, minimum: number): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}
function reference(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    !value.includes('\0') &&
    !/[\uD800-\uDFFF]/u.test(value)
  );
}
function validUuid(value: unknown): boolean {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * Shape/byte validation only. PREPARED, actor, target, predecessor, account,
 * terminal SUCCESS and capture-bound refund authority remain database-owned.
 * This object is neither a dispatch admission nor a provider capability.
 */
export function encodeFakeFinancialDurableRequest(
  kind: unknown,
  exactRequest: unknown
): FakeFinancialDurableRequest {
  const operation = operationKind(kind);
  let json: string;
  try {
    json = canonicalFinancialProviderRequestJson(exactRequest);
  } catch {
    return refuse('SHAPE_INVALID');
  }
  const request = JSON.parse(json) as Record<string, unknown>;
  const expectedKeys = [
    'operationId',
    'idempotencyKey',
    'expectedVersion',
    ...extraFields[operation],
  ];
  if (operation !== 'PREPARE_PAYMENT_METHOD')
    expectedKeys.push('amountCents', 'currency', 'relatedOperationId');
  if (Object.hasOwn(request, 'scenario')) expectedKeys.push('scenario');
  if (JSON.stringify(Object.keys(request).sort()) !== JSON.stringify(expectedKeys.sort()))
    return refuse('FIELDS_INVALID');
  if (
    !validUuid(request.operationId) ||
    typeof request.idempotencyKey !== 'string' ||
    !IDEMPOTENCY_KEY.test(request.idempotencyKey) ||
    !integer(request.expectedVersion, 0)
  )
    return refuse('IDENTITY_INVALID');
  if (
    operation !== 'PREPARE_PAYMENT_METHOD' &&
    (!integer(request.amountCents, 1) ||
      typeof request.currency !== 'string' ||
      !/^[a-z]{3}$/u.test(request.currency) ||
      !validUuid(request.relatedOperationId))
  )
    return refuse('MONEY_INVALID');
  for (const field of extraFields[operation]) {
    if (field === 'originalAmountCents') {
      if (
        !integer(request[field], 1) ||
        (request[field] as number) < (request.amountCents as number)
      )
        return refuse('REFUND_INVALID');
    } else if (['authorizationOperationId', 'scopeVersionId', 'changeOrderId'].includes(field)) {
      if (!validUuid(request[field])) return refuse('REFERENCE_INVALID');
    } else if (!reference(request[field])) return refuse('REFERENCE_INVALID');
  }
  if (
    Object.hasOwn(request, 'scenario') &&
    (!isFakeFinancialScenario(request.scenario) ||
      !fakeFinancialScenarioSupportsOperation(request.scenario, operation))
  )
    return refuse('SCENARIO_INVALID');
  return Object.freeze({
    operationKind: operation,
    payloadContractVersion: 1,
    canonicalRequestJson: json,
    providerRequestSha256: createHash('sha256').update(json, 'utf8').digest('hex'),
    request: Object.freeze(request as Record<string, string | number>),
  });
}

/** Exact text is checked before use; JSON.parse alone would hide duplicate keys. */
export function decodeFakeFinancialDurableRequest(
  kind: unknown,
  canonicalText: unknown,
  expectedSha256: unknown
): FakeFinancialDurableRequest {
  if (
    typeof canonicalText !== 'string' ||
    Buffer.byteLength(canonicalText, 'utf8') > MAX_CANONICAL_FINANCIAL_REQUEST_BYTES ||
    typeof expectedSha256 !== 'string' ||
    !SHA256.test(expectedSha256)
  )
    return refuse('EVIDENCE_INVALID');
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonicalText);
  } catch {
    return refuse('JSON_INVALID');
  }
  const result = encodeFakeFinancialDurableRequest(kind, parsed);
  if (
    result.canonicalRequestJson !== canonicalText ||
    result.providerRequestSha256 !== expectedSha256
  )
    return refuse('BYTES_OR_HASH_MISMATCH');
  return result;
}
