import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database, QueryFn } from '../../src/db.js';
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), configure: vi.fn(), digest: vi.fn() }));
vi.mock('../../src/services/payment/NonproductionFinancialAuthorization.js', () => ({
  assertNonproductionFakeFinanceAuthorized: mocks.authorize,
}));
vi.mock('../../src/jobs/runtime-database-startup-config.js', () => ({
  configuredRuntimeDatabaseStartup: mocks.configure,
}));
vi.mock('../../src/releaseManifest.js', () => ({ releaseManifestDigest: mocks.digest }));
import { SealedSyntheticFinancialWebhookInbox } from '../../src/services/payment/SealedSyntheticFinancialWebhookInbox.js';
import {
  fakeFinancialWebhookSignedBytes,
  fakeFinancialWebhookAuthenticationEvidence,
} from '../../src/services/payment/FakeFinancialWebhookAuthentication.js';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const target = {
  keyId: uuid(1),
  targetAuthorityId: uuid(2),
  targetAuthorityVersion: 1,
  targetDatabaseName: 'hx_ci_webhook_test',
  environment: 'local' as const,
  releaseManifestSha256: 'sha256:' + 'b'.repeat(64),
};
const payload = {
  version: 'HX_SYNTHETIC_FINANCIAL_OBSERVATION_V1',
  kind: 'FINANCIAL_OPERATION_OBSERVED',
  providerKind: 'FAKE',
  providerEventReference: 'webhook:unit:1',
  operationId: uuid(3),
  operationKind: 'SETTLE',
  predecessorProviderVersion: 0,
  observedProviderVersion: 1,
  observedState: 'SUCCEEDED',
  externalReference: 'fake-settle:unit',
  amountCents: 12000,
  currency: 'USD',
  providerOccurredAt: '2026-09-05T00:00:00.000Z',
};
const rawBody = JSON.stringify(payload),
  raw = Buffer.from(rawBody),
  signed = fakeFinancialWebhookSignedBytes(target, raw);
// This test owns the fake provider key; the application receives only its signature.
const signature = createHmac('sha256', Buffer.alloc(32, 73)).update(signed).digest('hex');
const input = { keyId: target.keyId, rawBody, signature };
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
function receipt() {
  return {
    ...target,
    observationId: uuid(4),
    receiptId: uuid(5),
    providerKind: 'FAKE',
    providerEventReference: payload.providerEventReference,
    providerEventKind: payload.kind,
    operationId: payload.operationId,
    rawPayloadSha256: hash(raw),
    rawPayloadBytes: raw.length,
    ingressIdempotencyKey: 'provider-event:' + hash('FAKE\0' + payload.providerEventReference),
    authenticationScheme: 'HMAC_SHA256_TARGET_V13',
    authenticationEvidenceSha256: fakeFinancialWebhookAuthenticationEvidence(signed, signature),
    authenticatedAt: '2026-09-05T00:00:00.123456+00:00',
    firstReceivedAt: '2026-09-05T00:00:00.123456+00:00',
    receivedAt: '2026-09-05T00:00:00.123456+00:00',
    observationReplayed: false,
    idempotencyReplayed: false,
    signedPayloadSha256: hash(signed),
  };
}
function harness(row: unknown = receipt()) {
  const query = vi.fn().mockResolvedValue({ rows: [{ receipt: row }], rowCount: 1 });
  const transaction = vi.fn(async (work: (q: QueryFn) => Promise<unknown>) => work(query));
  const database = { transaction } as unknown as Database;
  return { query, transaction, port: new SealedSyntheticFinancialWebhookInbox(database) };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.authorize.mockReturnValue({ environment: 'local' });
  mocks.configure.mockReturnValue({
    expectedTarget: { environment: 'local', databaseName: target.targetDatabaseName },
    targetDigest: 'target:1',
  });
  mocks.digest.mockReturnValue(target.releaseManifestSha256);
});
afterEach(() => vi.restoreAllMocks());
describe('sealed fake-provider webhook application port', () => {
  it('forwards only bounded raw signed bytes and returns a frozen receipt after confirmed commit', async () => {
    const h = harness();
    let commitReached = false;
    h.transaction.mockImplementationOnce(async (work) => {
      const value = await work(h.query);
      commitReached = true;
      return value;
    });
    const result = await h.port.record(input);
    expect(commitReached).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(h.query).toHaveBeenCalledExactlyOnceWith(
      'SELECT public.hxos_record_authenticated_fake_financial_webhook_v13($1,$2,$3,$4) AS receipt',
      [target.keyId, raw, signature, null]
    );
    expect(result).toMatchObject({
      operationId: payload.operationId,
      authenticationScheme: 'HMAC_SHA256_TARGET_V13',
    });
    for (const field of [
      'keyId',
      'targetAuthorityId',
      'targetDatabaseName',
      'signedPayloadSha256',
      'environment',
      'releaseManifestSha256',
    ])
      expect(result).not.toHaveProperty(field);
    expect(mocks.authorize).toHaveBeenCalledTimes(2);
    expect(mocks.configure).toHaveBeenCalledWith('api');
  });
  it.each([
    ['rawPayloadSha256', '0'.repeat(64)],
    ['rawPayloadBytes', 1],
    ['operationId', uuid(99)],
    ['keyId', uuid(99)],
    ['providerEventReference', 'another-event'],
    ['ingressIdempotencyKey', 'different:ingress:key'],
    ['environment', 'staging'],
    ['targetDatabaseName', 'wrong_database'],
    ['releaseManifestSha256', 'sha256:' + 'f'.repeat(64)],
    ['targetAuthorityId', uuid(99)],
    ['targetAuthorityVersion', 2],
    ['signedPayloadSha256', '0'.repeat(64)],
    ['authenticationEvidenceSha256', '0'.repeat(64)],
    ['authenticationScheme', 'HMAC_SHA256'],
    ['authenticatedAt', '2026-09-05T00:00:00.123457+00:00'],
    ['firstReceivedAt', '2026-09-05T00:00:00.123457+00:00'],
    ['idempotencyReplayed', true],
    ['forgedVerification', true],
  ])('refuses receipt drift in %s', async (field, value) => {
    const h = harness({ ...receipt(), [field]: value });
    await expect(h.port.record(input)).rejects.toThrow('PERSISTENCE_INCOMPLETE');
    expect(h.query).toHaveBeenCalledTimes(1);
  });
  it('refuses malformed result cardinality', async () => {
    const h = harness();
    h.query.mockResolvedValueOnce({
      rows: [{ receipt: receipt() }, { receipt: receipt() }],
      rowCount: 2,
    });
    await expect(h.port.record(input)).rejects.toThrow('PERSISTENCE_INCOMPLETE');
  });
  it('does not release or automatically retry a receipt when COMMIT acknowledgement is lost', async () => {
    const h = harness();
    h.transaction.mockImplementationOnce(async (work) => {
      await work(h.query);
      throw new Error('uncertain COMMIT with private database detail');
    });
    await expect(h.port.record(input)).rejects.toThrow(
      /^PROVIDER_EVENT_INBOX_PERSISTENCE_INCOMPLETE$/u
    );
    expect(h.transaction).toHaveBeenCalledTimes(1);
  });
  it('refuses authority drift after commit', async () => {
    const h = harness();
    mocks.digest
      .mockReturnValueOnce(target.releaseManifestSha256)
      .mockReturnValueOnce('sha256:' + 'c'.repeat(64));
    await expect(h.port.record(input)).rejects.toThrow('PERSISTENCE_INCOMPLETE');
  });
  it('rejects oversized or malformed UTF-8 text before database access', async () => {
    const h = harness();
    for (const body of ['x'.repeat(16385), '"\uD800"'])
      await expect(h.port.record({ ...input, rawBody: body })).rejects.toThrow(
        'PERSISTENCE_INCOMPLETE'
      );
    expect(h.query).not.toHaveBeenCalled();
  });
  it.each([
    ['SIGNATURE_INVALID', 'WEBHOOK_HMAC_INVALID'],
    ['EVENT_CONFLICT', 'EVENT_CONFLICT'],
    ['IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT'],
    ['PAYLOAD_INVALID', 'RAW_PAYLOAD_INVALID'],
    ['VERIFIER_UNAVAILABLE', 'PERSISTENCE_INCOMPLETE'],
  ])('maps only the exact sealed error %s', async (code, expected) => {
    const h = harness();
    h.query.mockRejectedValueOnce({ code: 'P0001', message: 'HXUV1-FINHOOK-13: ' + code });
    await expect(h.port.record(input)).rejects.toThrow(expected);
  });
  it('redacts arbitrary database messages even if they contain a recognized error suffix', async () => {
    const h = harness();
    h.query.mockRejectedValueOnce({
      code: 'P0001',
      message: 'private payload HXUV1-FINHOOK-13: SIGNATURE_INVALID',
    });
    await expect(h.port.record(input)).rejects.toThrow(
      /^PROVIDER_EVENT_INBOX_PERSISTENCE_INCOMPLETE$/u
    );
  });
});
