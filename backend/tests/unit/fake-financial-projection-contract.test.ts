import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../src/db.js';
import {
  FakeFinancialProvider,
  InMemoryFakeFinancialOperationRepository,
  PostgresFakeFinancialOperationRepository,
  resultFromExactStoredFakeFinancialOperation,
  type StoredFakeFinancialOperation,
} from '../../src/services/payment/FakeFinancialProvider.js';
import { encodeFakeFinancialDurableRequest } from '../../src/services/payment/FakeFinancialDurableRequest.js';

const now = () => new Date('2026-09-04T01:00:00.123Z');
const terminalMethods = { VOID: 'void', REFUND: 'refund', REVERSAL: 'reverse' } as const;
const delayedMethods = {
  SETTLE: 'settle',
  FUND: 'fund',
  PROVIDER_RELEASE: 'releaseProvider',
  PAYOUT: 'payout',
  OBSERVE_BANK_SETTLEMENT: 'observeBankSettlement',
} as const;
function moneyRequest() {
  return {
    operationId: randomUUID().toUpperCase(),
    idempotencyKey: `projection-test:${randomUUID()}`,
    expectedVersion: 0,
    amountCents: 2500,
    currency: 'usd',
    relatedOperationId: randomUUID(),
  };
}
async function prepare(version: 1 | 2) {
  const request = {
    operationId: randomUUID().toUpperCase(),
    idempotencyKey: `projection-test:${randomUUID()}`,
    expectedVersion: 0,
    customerId: 'synthetic-😀',
  };
  const memory = new InMemoryFakeFinancialOperationRepository(now);
  await new FakeFinancialProvider(memory, version).preparePaymentMethod(request);
  return { request, stored: (await memory.findByIdempotencyKey(request.idempotencyKey))! };
}
function rowFor(stored: StoredFakeFinancialOperation) {
  return {
    event_id: stored.eventId,
    operation_id: stored.operationId,
    operation_kind: stored.operationKind,
    event_version: stored.version,
    state: stored.state,
    scenario: stored.scenario,
    amount_cents: stored.amountCents,
    currency: stored.currency,
    related_operation_id: stored.relatedOperationId,
    external_reference: stored.externalReference,
    idempotency_key: stored.idempotencyKey,
    identity_sha256: stored.identitySha256,
    request_sha256: stored.requestSha256,
    provider_request_sha256: stored.providerRequestSha256,
    response_sha256: stored.responseSha256,
    retryable: stored.retryable,
    metadata: stored.metadata,
    recorded_at: stored.recordedAt,
    expires_at: stored.expiresAt,
    projection_contract_column_present: true,
    projection_contract_version: stored.projectionContractVersion,
  };
}
function repositoryFor(row: Record<string, unknown>) {
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [row], rowCount: 1 }));
  const transaction = vi.fn();
  const repository = new PostgresFakeFinancialOperationRepository({
    query,
    transaction,
  } as unknown as Database);
  return { repository, query, transaction };
}
describe('immutable fake-financial projection contract versions', () => {
  it.each(
    Object.entries(terminalMethods) as [
      keyof typeof terminalMethods,
      (typeof terminalMethods)[keyof typeof terminalMethods],
    ][]
  )('keeps legacy RETRY and corrects version 2 terminal %s', async (kind, method) => {
    const common = {
      ...moneyRequest(),
      scenario: 'RETRY' as const,
      ...(kind === 'REFUND' ? { originalAmountCents: 3000 } : {}),
    };
    const next = {
      ...common,
      expectedVersion: 1,
      idempotencyKey: `projection-next:${randomUUID()}`,
    };
    const events: StoredFakeFinancialOperation[] = [];
    for (const version of [1, 2] as const) {
      const memory = new InMemoryFakeFinancialOperationRepository(now);
      const provider = new FakeFinancialProvider(memory, version);
      expect((await provider[method](common as never)).state).toBe('RETRYABLE_FAILURE');
      const result = await provider[method](next as never);
      expect(result).toMatchObject({
        state:
          version === 1
            ? 'SUCCEEDED'
            : { VOID: 'VOIDED', REFUND: 'REFUNDED', REVERSAL: 'REVERSED' }[kind],
        retryable: false,
        version: 2,
      });
      const stored = (await memory.findByIdempotencyKey(next.idempotencyKey))!;
      const exact = encodeFakeFinancialDurableRequest(kind, next);
      expect(
        resultFromExactStoredFakeFinancialOperation(stored, kind, next, exact.providerRequestSha256)
          .state
      ).toBe(result.state);
      expect(() =>
        resultFromExactStoredFakeFinancialOperation(
          { ...stored, projectionContractVersion: version === 1 ? 2 : 1 },
          kind,
          next,
          exact.providerRequestSha256
        )
      ).toThrow('EXACT_EVENT_IDENTITY_MISMATCH');
      events.push(stored);
    }
    for (const key of ['identitySha256', 'requestSha256', 'providerRequestSha256'] as const)
      expect(events[0]![key]).toBe(events[1]![key]);
    expect(events[0]!.responseSha256).not.toBe(events[1]!.responseSha256);
  });
  it.each(
    Object.entries(delayedMethods) as [
      keyof typeof delayedMethods,
      (typeof delayedMethods)[keyof typeof delayedMethods],
    ][]
  )(
    'makes version 2 delayed %s pending/retryable and preserves legacy verification',
    async (kind, method) => {
      const request = {
        ...moneyRequest(),
        scenario: 'DELAYED_SETTLEMENT' as const,
        ...(kind === 'PAYOUT' ? { providerAccountReference: 'fake_account_001' } : {}),
      };
      const next = {
        ...request,
        expectedVersion: 1,
        idempotencyKey: `projection-next:${randomUUID()}`,
      };
      for (const version of [1, 2] as const) {
        const memory = new InMemoryFakeFinancialOperationRepository(now);
        const provider = new FakeFinancialProvider(memory, version);
        const initial = await provider[method](request as never);
        expect(initial).toMatchObject({ state: 'PENDING', retryable: version === 2 });
        const stored = (await memory.findByIdempotencyKey(request.idempotencyKey))!;
        const exact = encodeFakeFinancialDurableRequest(kind, request);
        expect(
          resultFromExactStoredFakeFinancialOperation(
            stored,
            kind,
            request,
            exact.providerRequestSha256
          ).retryable
        ).toBe(version === 2);
        expect(() =>
          resultFromExactStoredFakeFinancialOperation(
            { ...stored, projectionContractVersion: version === 1 ? 2 : 1 },
            kind,
            request,
            exact.providerRequestSha256
          )
        ).toThrow('EXACT_EVENT_IDENTITY_MISMATCH');
        expect(await provider[method](next as never)).toMatchObject({
          state: 'SUCCEEDED',
          retryable: false,
          version: 2,
        });
      }
    }
  );
  it.each([1, 2] as const)(
    'binds version %s into unchanged success semantics without accepting a relabeled receipt',
    async (version) => {
      const { request, stored } = await prepare(version);
      const exact = encodeFakeFinancialDurableRequest('PREPARE_PAYMENT_METHOD', request);
      expect(
        resultFromExactStoredFakeFinancialOperation(
          stored,
          'PREPARE_PAYMENT_METHOD',
          request,
          exact.providerRequestSha256
        ).state
      ).toBe('SUCCEEDED');
      expect(() =>
        resultFromExactStoredFakeFinancialOperation(
          { ...stored, projectionContractVersion: version === 1 ? 2 : 1 },
          'PREPARE_PAYMENT_METHOD',
          request,
          exact.providerRequestSha256
        )
      ).toThrow('EXACT_EVENT_IDENTITY_MISMATCH');
    }
  );
  it('replays a legacy pending observation after switching the model to contract 2 without rewriting it', async () => {
    const request = { ...moneyRequest(), scenario: 'DELAYED_SETTLEMENT' as const };
    const memory = new InMemoryFakeFinancialOperationRepository(now);
    const original = await new FakeFinancialProvider(memory, 1).settle(request);
    const before = await memory.findByIdempotencyKey(request.idempotencyKey);
    expect(await new FakeFinancialProvider(memory, 2).settle(request)).toEqual({
      ...original,
      idempotencyReplayed: true,
    });
    expect(await memory.findByIdempotencyKey(request.idempotencyKey)).toEqual(before);
    expect(before?.projectionContractVersion).toBe(1);
    expect(memory.events()).toHaveLength(1);
  });
  it('refuses contract 2 at the legacy PostgreSQL writer before any query or transaction', async () => {
    const { request, stored } = await prepare(2);
    const { repository, query, transaction } = repositoryFor(rowFor(stored));
    await expect(
      new FakeFinancialProvider(repository, 2).preparePaymentMethod(request)
    ).rejects.toThrow('LEGACY_WRITER_REQUIRES_CONTRACT_V1');
    expect(query).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });
  it.each([1, 2] as const)(
    'reads explicit numeric contract %s from a versioned PostgreSQL row',
    async (version) => {
      const { request, stored } = await prepare(version);
      const { repository, query } = repositoryFor(rowFor(stored));
      const result = await repository.findByIdempotencyKey(request.idempotencyKey);
      expect(result?.projectionContractVersion).toBe(version);
      expect(query.mock.calls[0]![0]).toContain(
        "to_jsonb(hxos_fake_financial_operation_events_v1) ? 'projection_contract_version'"
      );
    }
  );
  it('maps only an explicit pre-column row to legacy contract 1', async () => {
    const { request, stored } = await prepare(1);
    const row = {
      ...rowFor(stored),
      projection_contract_column_present: false,
      projection_contract_version: null,
    };
    const result = await repositoryFor(row).repository.findByIdempotencyKey(request.idempotencyKey);
    expect(result?.projectionContractVersion).toBe(1);
  });
  it.each([
    [true, null],
    [true, undefined],
    [true, '1'],
    [true, 0],
    [true, 3],
    [true, 1.5],
    [undefined, 1],
    [null, null],
    [false, 1],
    [false, undefined],
  ])('refuses ambiguous or malformed PostgreSQL provenance %s/%s', async (present, version) => {
    const { request, stored } = await prepare(1);
    const row = {
      ...rowFor(stored),
      projection_contract_column_present: present,
      projection_contract_version: version,
    };
    await expect(
      repositoryFor(row).repository.findByIdempotencyKey(request.idempotencyKey)
    ).rejects.toThrow(/PROJECTION_(CONTRACT_VERSION|SCHEMA_PROVENANCE)_INVALID/u);
  });
  it.each([undefined, null, 0, 3, '2'])(
    'refuses unsupported stored contract %s during exact verification',
    async (version) => {
      const { request, stored } = await prepare(1);
      const exact = encodeFakeFinancialDurableRequest('PREPARE_PAYMENT_METHOD', request);
      expect(() =>
        resultFromExactStoredFakeFinancialOperation(
          {
            ...stored,
            projectionContractVersion: version,
          } as unknown as StoredFakeFinancialOperation,
          'PREPARE_PAYMENT_METHOD',
          request,
          exact.providerRequestSha256
        )
      ).toThrow('PROJECTION_CONTRACT_VERSION_INVALID');
    }
  );
});
