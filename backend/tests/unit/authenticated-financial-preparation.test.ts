import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../src/db.js';
import type { UniversalV1ActorAttestationHandle } from '../../src/auth/universal-v1-actor-attestation-contracts.js';
import {
  PostgresUniversalV1PreparedFinancialCommandAuthority,
  type PrepareUniversalV1FinancialCommandInput,
} from '../../src/services/payment/PreparedFinancialCommandAuthority.js';

const input: PrepareUniversalV1FinancialCommandInput = {
  operationKind: 'PREPARE_PAYMENT_METHOD',
  operationId: '11111111-1111-4111-8111-111111111111',
  providerKind: 'FAKE',
  idempotencyKey: 'authenticated:prepare:test',
  providerExpectedVersion: 0,
  lifecycleExpectedVersion: 0,
  providerRequestSha256: 'a'.repeat(64),
  taskDraftId: '22222222-2222-4222-8222-222222222222',
  taskId: null,
  eligibilityDecisionId: null,
  scopeVersionId: null,
  changeOrderId: null,
  predecessorEventId: null,
  completionFactId: null,
  relatedOperationId: null,
  amountCents: null,
  currency: null,
  recordedBy: '33333333-3333-4333-8333-333333333333',
};
function fixture() {
  const query = vi.fn(async (..._args: unknown[]) => ({
    rows: [] as Record<string, unknown>[],
    rowCount: 0,
  }));
  const transaction = vi.fn(async (work: (query: unknown) => Promise<unknown>) => work(query));
  const issue = vi.fn(async () => ({
    schema_version: 1,
    command_kind: 'PREPARE_FAKE_FINANCIAL_COMMAND',
    canonical_request_sha256: 'b'.repeat(64),
    actor_assertion_token: 'c'.repeat(64),
    assertion_expires_at: new Date(Date.now() + 60_000).toISOString(),
  }));
  return {
    query,
    transaction,
    issue,
    attestation: { issue } as unknown as UniversalV1ActorAttestationHandle,
    authority: new PostgresUniversalV1PreparedFinancialCommandAuthority({
      query,
      transaction,
    } as unknown as Database),
  };
}
describe('authenticated financial PREPARED submission', () => {
  it('refuses missing request authentication before any database call', async () => {
    const f = fixture();
    await expect(f.authority.prepare(input)).rejects.toThrow('ACTOR_ATTESTATION_REQUIRED');
    expect(f.transaction).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
  });
  it('signs the complete normalized input without a caller actor or generated row id', async () => {
    const f = fixture();
    await expect(f.authority.prepare(input, f.attestation)).rejects.toThrow(
      'PERSISTENCE_INCOMPLETE'
    );
    const { recordedBy: _actor, ...payload } = input;
    expect(f.issue).toHaveBeenCalledExactlyOnceWith({
      commandKind: 'PREPARE_FAKE_FINANCIAL_COMMAND',
      commandPayload: payload,
    });
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.query.mock.calls[0]).toEqual([
      'SELECT * FROM public.hxos_prepare_authenticated_fake_financial_command_v13($1,$2)',
      ['c'.repeat(64), payload],
    ]);
  });
  it('does not start a transaction when the independent attester refuses', async () => {
    const f = fixture();
    f.issue.mockRejectedValueOnce(new Error('ACTOR_REVOKED'));
    await expect(f.authority.prepare(input, f.attestation)).rejects.toThrow('ACTOR_REVOKED');
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it('does not fall back to a legacy table read on malformed attestation', async () => {
    const f = fixture();
    f.issue.mockResolvedValueOnce({ ...(await f.issue()), actor_assertion_token: 'bad' });
    f.issue.mockClear();
    await expect(f.authority.prepare(input, f.attestation)).rejects.toThrow(
      'ACTOR_ATTESTATION_INVALID'
    );
    expect(f.transaction).not.toHaveBeenCalled();
  });
});
function persistedResponse() {
  return {
    prepared_command: {
      prepared_command_id: '44444444-4444-4444-8444-444444444444',
      command_state: 'PREPARED',
      operation_kind: input.operationKind,
      event_kind: 'PAYMENT_METHOD_PREPARED',
      operation_id: input.operationId,
      provider_kind: 'FAKE',
      idempotency_key: input.idempotencyKey,
      provider_expected_version: 0,
      lifecycle_expected_version: 0,
      provider_request_sha256: input.providerRequestSha256,
      task_draft_id: input.taskDraftId,
      task_id: null,
      eligibility_decision_id: null,
      eligibility_decision_version: null,
      eligibility_valid_until: null,
      scope_version_id: null,
      scope_version: null,
      scope_hash: null,
      work_order_id: null,
      work_order_materialization_version: null,
      work_order_execution_contract_version: null,
      change_order_id: null,
      change_order_version: null,
      predecessor_event_id: null,
      predecessor_operation_id: null,
      predecessor_event_kind: null,
      predecessor_status: null,
      predecessor_lifecycle_version: null,
      completion_fact_id: null,
      completion_version: null,
      related_operation_id: null,
      amount_cents: null,
      currency: null,
      recorded_by: input.recordedBy,
      occurred_at: '2026-09-04T00:00:00Z',
      request_identity_sha256: 'd'.repeat(64),
      authority_context_sha256: 'e'.repeat(64),
      prepared_at: '2026-09-04T00:00:00Z',
    } as Record<string, unknown>,
    idempotency_replayed: false,
    actor_request_sha256: 'b'.repeat(64),
    actor_assertion_id: '55555555-5555-4555-8555-555555555555',
    target_authority_id: '66666666-6666-4666-8666-666666666666',
  };
}
describe('authenticated preparation persistence receipt', () => {
  it('returns a validated frozen receipt only after the transaction acknowledges commit', async () => {
    const f = fixture(),
      response = persistedResponse();
    f.query.mockResolvedValueOnce({ rows: [response], rowCount: 1 });
    let committed = false;
    f.transaction.mockImplementationOnce(async (work) => {
      const result = await work(f.query);
      committed = true;
      return result;
    });
    const receipt = await f.authority.prepare(input, f.attestation);
    expect(committed).toBe(true);
    expect(receipt).toMatchObject({
      ...input,
      preparedCommandId: response.prepared_command.prepared_command_id,
      eventKind: 'PAYMENT_METHOD_PREPARED',
      idempotencyReplayed: false,
    });
    expect(Object.isFrozen(receipt)).toBe(true);
  });
  it.each([
    ['prepared_command_id', ''],
    ['event_kind', 'AUTHORIZED'],
    ['event_kind', 'BOGUS'],
    ['scope_hash', 'not-a-hash'],
    ['scope_version_id', 'invalid-uuid'],
    ['scope_version', 0],
    ['scope_version', '1'],
    ['eligibility_decision_version', '1'],
    ['amount_cents', Number.MAX_SAFE_INTEGER + 1],
    ['work_order_execution_contract_version', 2],
    ['request_identity_sha256', '0'.repeat(64)],
    ['predecessor_operation_id', 'invalid-uuid'],
  ])('rejects malformed persistence %s=%s', async (field, value) => {
    const f = fixture(),
      response = persistedResponse();
    response.prepared_command[field as string] = value;
    f.query.mockResolvedValueOnce({ rows: [response], rowCount: 1 });
    await expect(f.authority.prepare(input, f.attestation)).rejects.toThrow(
      'PERSISTENCE_IDENTITY_MISMATCH'
    );
  });
  it('does not return a receipt or retry after an uncertain commit', async () => {
    const f = fixture(),
      response = persistedResponse();
    f.query.mockResolvedValueOnce({ rows: [response], rowCount: 1 });
    f.transaction.mockImplementationOnce(async (work) => {
      await work(f.query);
      throw new Error('COMMIT_ACK_LOST');
    });
    await expect(f.authority.prepare(input, f.attestation)).rejects.toThrow('COMMIT_ACK_LOST');
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.issue).toHaveBeenCalledTimes(1);
  });
});
