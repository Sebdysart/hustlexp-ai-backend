import { describe, expect, it } from 'vitest';

import {
  InMemoryUniversalV1PreparedFinancialCommandAuthority,
  PreparedFinancialCommandAuthorityError,
  type PrepareUniversalV1FinancialCommandInput,
} from '../../src/services/payment/PreparedFinancialCommandAuthority.js';

const ids = {
  operation: '11111111-1111-4111-8111-111111111111',
  otherOperation: '22222222-2222-4222-8222-222222222222',
  taskDraft: '33333333-3333-4333-8333-333333333333',
  otherDraft: '44444444-4444-4444-8444-444444444444',
  actor: '55555555-5555-4555-8555-555555555555',
} as const;

function preparation(
  overrides: Partial<PrepareUniversalV1FinancialCommandInput> = {}
): PrepareUniversalV1FinancialCommandInput {
  return {
    operationKind: 'PREPARE_PAYMENT_METHOD',
    operationId: ids.operation,
    providerKind: 'FAKE',
    idempotencyKey: 'prepared-finance:unit:0001',
    providerExpectedVersion: 0,
    lifecycleExpectedVersion: 0,
    providerRequestSha256: 'a'.repeat(64),
    taskDraftId: ids.taskDraft,
    taskId: null,
    eligibilityDecisionId: null,
    scopeVersionId: null,
    changeOrderId: null,
    predecessorEventId: null,
    completionFactId: null,
    relatedOperationId: null,
    amountCents: null,
    currency: null,
    recordedBy: ids.actor,
    ...overrides,
  };
}

describe('Universal V1 prepared financial command authority', () => {
  it('returns one DB-timed PREPARED receipt and reloads only an exact immutable replay', async () => {
    const authority = new InMemoryUniversalV1PreparedFinancialCommandAuthority(
      () => new Date('2026-08-28T23:01:00.000Z')
    );
    const first = await authority.prepare(preparation());

    expect(first).toMatchObject({
      commandState: 'PREPARED',
      eventKind: 'PAYMENT_METHOD_PREPARED',
      operationId: ids.operation,
      providerKind: 'FAKE',
      lifecycleExpectedVersion: 0,
      providerRequestSha256: 'a'.repeat(64),
      occurredAt: '2026-08-28T23:01:00.000Z',
      idempotencyReplayed: false,
    });
    expect(first.requestIdentitySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.authorityContextSha256).toMatch(/^[a-f0-9]{64}$/u);
    await expect(authority.prepare(preparation())).resolves.toEqual({
      ...first,
      idempotencyReplayed: true,
    });
  });

  it('rejects changed context under the same idempotency identity', async () => {
    const authority = new InMemoryUniversalV1PreparedFinancialCommandAuthority();
    await authority.prepare(preparation());

    await expect(
      authority.prepare(
        preparation({
          taskDraftId: ids.otherDraft,
        })
      )
    ).rejects.toEqual(new PreparedFinancialCommandAuthorityError('IDEMPOTENCY_CONFLICT'));
  });

  it('rejects another command for an occupied lifecycle or operation version', async () => {
    const authority = new InMemoryUniversalV1PreparedFinancialCommandAuthority();
    await authority.prepare(preparation());

    await expect(
      authority.prepare(
        preparation({
          operationId: ids.otherOperation,
          idempotencyKey: 'prepared-finance:unit:0002',
        })
      )
    ).rejects.toEqual(new PreparedFinancialCommandAuthorityError('LIFECYCLE_VERSION_CONFLICT'));
    await expect(
      authority.prepare(
        preparation({
          taskDraftId: ids.otherDraft,
          idempotencyKey: 'prepared-finance:unit:0003',
        })
      )
    ).rejects.toEqual(new PreparedFinancialCommandAuthorityError('OPERATION_VERSION_CONFLICT'));
  });

  it('keeps approved-provider and malformed lifecycle contexts sealed', async () => {
    const authority = new InMemoryUniversalV1PreparedFinancialCommandAuthority();
    await expect(
      authority.prepare(preparation({ providerKind: 'APPROVED_PROVIDER' }))
    ).rejects.toEqual(new PreparedFinancialCommandAuthorityError('APPROVED_PROVIDER_REFUSED'));
    await expect(
      authority.prepare(preparation({ lifecycleExpectedVersion: 1 }))
    ).rejects.toEqual(new PreparedFinancialCommandAuthorityError('BINDING_INVALID'));
  });
});
