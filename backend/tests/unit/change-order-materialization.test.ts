import { describe, expect, it, vi } from 'vitest';
import type { Database, QueryFn } from '../../src/db.js';
import { PostgresUniversalV1ChangeOrderMaterialization } from '../../src/services/UniversalV1ChangeOrderMaterialization.js';
import type { UniversalV1ActorAttestationHandle } from '../../src/auth/universal-v1-actor-attestation-contracts.js';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const now = () => new Date().toISOString();
const actor = id(1),
  key = 'change-order:materialize:unit';
const input = {
  proposal_id: id(2),
  expected_proposal_version: 1,
  expected_scope_version: 1,
  expected_amendment_version: 0,
  expected_execution_version: 1,
  expected_financial_version: 2,
  idempotency_key: key,
  client_ts: now(),
};
const release = {
  manifestDigest: 'sha256:' + 'b'.repeat(64),
  releaseId: 'synthetic.materialize',
  revision: 'c'.repeat(40),
  environment: 'local' as const,
  authenticationStatus: 'VERIFIED' as const,
};
const result = {
  amendment_id: id(3),
  amendment_version: 1,
  proposal_id: id(2),
  scope_version_id: id(4),
  scope_version: 2,
  adjustment_event_id: null,
  provider_kind: null,
  replayed: false,
  payment_creation_performed: false,
  hard_assignment_created: false,
};
const phase = {
  completed: false as const,
  idempotencyKey: key,
  requestSha256: 'd'.repeat(64),
  context: {
    proposalId: id(2),
    workOrderId: id(5),
    taskId: id(6),
    taskDraftId: id(7),
    eligibilityDecisionId: id(8),
    scopeVersionId: id(4),
    scopeVersion: 2,
    customerTotalCents: 23000,
    currency: 'USD',
    predecessorEventId: id(9),
    predecessorOperationId: id(10),
    expectedFinancialVersion: 2,
    adjustmentOperationId: '',
    occurredAt: now(),
  },
};
function fixture(returned: unknown) {
  const query = vi.fn(async (_sql: string, _parameters?: unknown[]) => ({
    rowCount: 1,
    rows: [
      {
        result: returned,
        actor_user_id: actor,
        actor_assertion_id: id(11),
        actor_request_sha256: 'a'.repeat(64),
        target_authority_id: id(12),
        command_release_sha256: release.manifestDigest,
      },
    ],
  }));
  const database = {
    transaction: vi.fn(async (fn: (query: QueryFn) => Promise<unknown>) =>
      fn(query as unknown as QueryFn)
    ),
  } as unknown as Database;
  const issue = vi.fn(async (command: { commandKind: string }) => ({
    schema_version: 1,
    command_kind: command.commandKind,
    actor_assertion_token: 'e'.repeat(64),
    canonical_request_sha256: 'a'.repeat(64),
    assertion_expires_at: new Date(Date.now() + 30000).toISOString(),
  }));
  const attestation = { issue } as unknown as UniversalV1ActorAttestationHandle;
  const authorize = vi.fn(() => release),
    client = new PostgresUniversalV1ChangeOrderMaterialization(database, authorize);
  return { query, database, issue, attestation, authorize, client };
}
describe('authenticated change-order materialization commands', () => {
  it('reads only a freshly attested proposal kind without requesting finance authority', async () => {
    const f = fixture('SCOPE_ONLY');
    await expect(f.client.readKind(actor, id(2), f.attestation)).resolves.toBe('SCOPE_ONLY');
    expect(f.issue).toHaveBeenCalledWith({
      commandKind: 'READ_FAKE_CHANGE_ORDER_KIND',
      commandPayload: { proposal_id: id(2) },
    });
    expect(f.authorize).not.toHaveBeenCalled();
  });
  it('commits a scope-only result without requiring financial capability', async () => {
    const f = fixture({ completed: true, result });
    await expect(f.client.prepare(actor, input, f.attestation)).resolves.toEqual({
      completed: true,
      result,
    });
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.issue.mock.calls[0][0]).toMatchObject({
      commandKind: 'PREPARE_FAKE_CHANGE_ORDER',
      commandPayload: { client_timestamp_epoch_ms: Date.parse(input.client_ts) },
    });
    expect(f.query.mock.calls[0][0]).toBe(
      'SELECT * FROM public.hxos_prepare_authenticated_change_order_v13($1,$2)'
    );
  });
  it('binds prepared price scope and operation identity and checks release before committing', async () => {
    const { deterministicUuid } =
      await import('../../src/services/UniversalV1WorkOrderPostgresRepository.js');
    const prepared = {
      ...phase,
      context: { ...phase.context, adjustmentOperationId: deterministicUuid(key, 'adjust') },
    };
    const f = fixture(prepared);
    const received = await f.client.prepare(actor, input, f.attestation);
    expect(received).toEqual(prepared);
    expect(Object.isFrozen(received)).toBe(true);
    expect(f.authorize).toHaveBeenCalled();
  });
  it('rolls back preparation if financial release authority is unavailable', async () => {
    const { deterministicUuid } =
      await import('../../src/services/UniversalV1WorkOrderPostgresRepository.js');
    const f = fixture({
      ...phase,
      context: { ...phase.context, adjustmentOperationId: deterministicUuid(key, 'adjust') },
    });
    f.authorize.mockImplementation(() => {
      throw Error('release unavailable');
    });
    await expect(f.client.prepare(actor, input, f.attestation)).rejects.toThrow();
  });
  it('rejects a substituted financial release and an invalid prepared version', async () => {
    const f = fixture({ ...phase, context: { ...phase.context, scopeVersion: 9 } });
    await expect(f.client.prepare(actor, input, f.attestation)).rejects.toThrow();
    const g = fixture({
      completed: true,
      result: { ...result, adjustment_event_id: id(13), provider_kind: 'FAKE' },
    });
    g.authorize.mockReturnValue({ ...release, manifestDigest: 'sha256:' + 'c'.repeat(64) });
    await expect(g.client.prepare(actor, input, g.attestation)).rejects.toThrow();
  });
  it('attests fresh finalization time separately from immutable Phase A', async () => {
    const f = fixture({ ...result, adjustment_event_id: id(13), provider_kind: 'FAKE' }),
      fresh = now();
    const received = await f.client.finalize(
      actor,
      input,
      'd'.repeat(64),
      id(13),
      fresh,
      f.attestation
    );
    expect(received.adjustment_event_id).toBe(id(13));
    expect(f.issue.mock.calls[0][0]).toMatchObject({
      commandKind: 'FINALIZE_FAKE_CHANGE_ORDER',
      commandPayload: {
        phase_request_sha256: 'd'.repeat(64),
        adjustment_event_id: id(13),
        client_timestamp_epoch_ms: Date.parse(fresh),
      },
    });
  });
  it('refuses cross-proposal or cross-event finalization receipts', async () => {
    for (const changed of [
      { proposal_id: id(99) },
      { adjustment_event_id: id(99) },
      { scope_version: 5 },
      { amendment_version: 2 },
      { payment_creation_performed: true },
    ]) {
      const f = fixture({
        ...result,
        adjustment_event_id: id(13),
        provider_kind: 'FAKE',
        ...changed,
      });
      await expect(
        f.client.finalize(actor, input, 'd'.repeat(64), id(13), now(), f.attestation)
      ).rejects.toThrow();
    }
  });
  it('does not retry an ambiguous commit', async () => {
    const f = fixture({ completed: true, result });
    vi.mocked(f.database.transaction).mockImplementation(async (fn) => {
      await fn(f.query as unknown as QueryFn);
      throw Error('commit outcome unknown');
    });
    await expect(f.client.prepare(actor, input, f.attestation)).rejects.toThrow();
    expect(f.database.transaction).toHaveBeenCalledTimes(1);
    expect(f.query).toHaveBeenCalledTimes(1);
  });
});
