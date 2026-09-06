import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  encodeFakeFinancialDurableRequest,
  decodeFakeFinancialDurableRequest,
  FAKE_FINANCIAL_DURABLE_REQUEST_OPERATIONS,
  type FakeFinancialDurableRequestOperation,
} from '../../src/services/payment/FakeFinancialDurableRequest.js';
import { canonicalFinancialProviderRequestSha256 } from '../../src/services/payment/FinancialProviderCommandJournal.js';
import { canonicalFinancialProviderRequestJson } from '../../src/services/payment/FinancialProviderRequestCanonicalization.js';

const operationId = '10000000-0000-4000-8000-000000000001';
const relatedId = '20000000-0000-4000-8000-000000000002';
function request(kind: FakeFinancialDurableRequestOperation): Record<string, unknown> {
  const common = { operationId, idempotencyKey: 'durable-request:0001', expectedVersion: 0 };
  if (kind === 'PREPARE_PAYMENT_METHOD') return { ...common, customerId: 'synthetic-customer' };
  const money = { ...common, amountCents: 2500, currency: 'usd', relatedOperationId: relatedId };
  switch (kind) {
    case 'AUTHORIZE':
      return { ...money, paymentMethodReference: 'fake_payment_method_0001' };
    case 'SECURE':
      return { ...money, authorizationOperationId: relatedId };
    case 'ADJUST':
      return { ...money, scopeVersionId: relatedId, changeOrderId: operationId };
    case 'REFUND':
      return { ...money, originalAmountCents: 3000 };
    case 'PAYOUT':
      return { ...money, providerAccountReference: 'fake_provider_account_0001' };
    default:
      return money;
  }
}
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

describe('exact durable fake financial requests', () => {
  it.each(FAKE_FINANCIAL_DURABLE_REQUEST_OPERATIONS)(
    'round trips the exact %s request with the established journal hash',
    (kind) => {
      const input = request(kind);
      const encoded = encodeFakeFinancialDurableRequest(kind, input);
      expect(encoded.providerRequestSha256).toBe(canonicalFinancialProviderRequestSha256(input));
      expect(
        decodeFakeFinancialDurableRequest(
          kind,
          encoded.canonicalRequestJson,
          encoded.providerRequestSha256
        )
      ).toEqual(encoded);
      expect(Object.isFrozen(encoded)).toBe(true);
      expect(Object.isFrozen(encoded.request)).toBe(true);
      input.idempotencyKey = 'changed-after-encoding';
      expect(encoded.request.idempotencyKey).toBe('durable-request:0001');
    }
  );
  it('preserves the established exact bytes and scenario absence independently of adapter defaults', () => {
    const expected =
      '{"customerId":"synthetic-customer","expectedVersion":0,"idempotencyKey":"durable-request:0001","operationId":"10000000-0000-4000-8000-000000000001"}';
    const omitted = encodeFakeFinancialDurableRequest(
      'PREPARE_PAYMENT_METHOD',
      request('PREPARE_PAYMENT_METHOD')
    );
    expect(omitted.canonicalRequestJson).toBe(expected);
    expect(omitted.providerRequestSha256).toBe(digest(expected));
    const success = encodeFakeFinancialDurableRequest('PREPARE_PAYMENT_METHOD', {
      ...request('PREPARE_PAYMENT_METHOD'),
      scenario: 'SUCCESS',
    });
    expect(success.providerRequestSha256).not.toBe(omitted.providerRequestSha256);
    expect(Object.hasOwn(omitted.request, 'scenario')).toBe(false);
    expect(success.request.scenario).toBe('SUCCESS');
  });
  it.each([
    ['extra actor authority', { actorId: operationId }],
    ['provider result', { state: 'SUCCEEDED' }],
    ['arbitrary metadata', { metadata: {} }],
    ['null reference', { paymentMethodReference: null }],
    ['PostgreSQL-incompatible NUL reference', { paymentMethodReference: 'fake\0reference' }],
    ['noninteger amount', { amountCents: 1.5 }],
    ['unsafe integer', { amountCents: Number.MAX_SAFE_INTEGER + 1 }],
    ['negative version', { expectedVersion: -1 }],
    ['uppercase currency', { currency: 'USD' }],
    ['foreign scenario', { scenario: 'DUPLICATE_WEBHOOK' }],
    ['null scenario', { scenario: null }],
    ['wrong related ID', { relatedOperationId: 'synthetic-reference' }],
  ])('rejects %s', (_label, patch) => {
    expect(() =>
      encodeFakeFinancialDurableRequest('AUTHORIZE', { ...request('AUTHORIZE'), ...patch })
    ).toThrow('FAKE_FINANCIAL_DURABLE_REQUEST_');
  });
  it.each(['ONBOARD_PROVIDER', 'REFRESH_PROVIDER_ACCOUNT_STATE', 'INGEST_WEBHOOK', 'RECONCILE'])(
    'keeps %s outside this lifecycle lane',
    (kind) => {
      expect(() => encodeFakeFinancialDurableRequest(kind, request('AUTHORIZE'))).toThrow(
        'OPERATION_INVALID'
      );
    }
  );
  it('requires the refund original amount and preserves its exact value for later capture-authority checks', () => {
    expect(
      encodeFakeFinancialDurableRequest('REFUND', request('REFUND')).request.originalAmountCents
    ).toBe(3000);
    expect(() =>
      encodeFakeFinancialDurableRequest('REFUND', {
        ...request('REFUND'),
        originalAmountCents: 2499,
      })
    ).toThrow('REFUND_INVALID');
  });
  it.each(['REVERSAL', 'PARTIAL_REFUND', 'DELAYED_SETTLEMENT'])(
    'rejects operation-incompatible scenario %s',
    (scenario) => {
      expect(() =>
        encodeFakeFinancialDurableRequest('AUTHORIZE', { ...request('AUTHORIZE'), scenario })
      ).toThrow('SCENARIO_INVALID');
    }
  );
  it.each(['duplicate', 'spacing', 'order', 'escape', 'negative-zero'] as const)(
    'rejects %s bytes even if JSON.parse would erase the distinction',
    (variant) => {
      const encoded = encodeFakeFinancialDurableRequest(
        'PREPARE_PAYMENT_METHOD',
        request('PREPARE_PAYMENT_METHOD')
      );
      let text = encoded.canonicalRequestJson;
      if (variant === 'duplicate') text = text.replace('{', '{"customerId":"wrong",');
      if (variant === 'spacing') text = text.replace(':', ': ');
      if (variant === 'order') text = JSON.stringify(request('PREPARE_PAYMENT_METHOD'));
      if (variant === 'escape')
        text = text.replace('synthetic-customer', '\\u0073ynthetic-customer');
      if (variant === 'negative-zero')
        text = text.replace('"expectedVersion":0', '"expectedVersion":-0');
      expect(() =>
        decodeFakeFinancialDurableRequest('PREPARE_PAYMENT_METHOD', text, digest(text))
      ).toThrow('BYTES_OR_HASH_MISMATCH');
    }
  );
  it('rejects altered hashes and oversized UTF-8 input before dispatch', () => {
    const encoded = encodeFakeFinancialDurableRequest('AUTHORIZE', request('AUTHORIZE'));
    expect(() =>
      decodeFakeFinancialDurableRequest('AUTHORIZE', encoded.canonicalRequestJson, 'f'.repeat(64))
    ).toThrow('BYTES_OR_HASH_MISMATCH');
    expect(() =>
      decodeFakeFinancialDurableRequest('AUTHORIZE', '😀'.repeat(17000), 'f'.repeat(64))
    ).toThrow('EVIDENCE_INVALID');
  });
  it('does not execute accessors or admit non-JSON object identities', () => {
    const input = request('AUTHORIZE');
    let invoked = false;
    Object.defineProperty(input, 'paymentMethodReference', {
      enumerable: true,
      get: () => {
        invoked = true;
        return 'secret';
      },
    });
    expect(() => encodeFakeFinancialDurableRequest('AUTHORIZE', input)).toThrow('SHAPE_INVALID');
    expect(invoked).toBe(false);
    expect(() => encodeFakeFinancialDurableRequest('AUTHORIZE', new Date())).toThrow(
      'SHAPE_INVALID'
    );
  });
  it('keeps the general journal encoder byte compatible for nested non-lifecycle requests', () => {
    const input = { z: undefined, b: { c: -0, a: [true, null, 'x'] }, a: 1 };
    const expected = '{"a":1,"b":{"a":[true,null,"x"],"c":0}}';
    expect(canonicalFinancialProviderRequestJson(input)).toBe(expected);
    expect(canonicalFinancialProviderRequestSha256(input)).toBe(digest(expected));
  });
});
