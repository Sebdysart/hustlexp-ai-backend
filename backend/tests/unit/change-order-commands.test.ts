import { describe, expect, it, vi } from 'vitest';
import type { QueryFn } from '../../src/database-contracts.js';
import { PostgresUniversalV1ChangeOrderCommands } from '../../src/services/UniversalV1ChangeOrderCommands.js';
import {
  ProposeChangeOrderPayloadSchema,
  DecideChangeOrderPayloadSchema,
} from '../../src/auth/change-order-command-contract.js';
import {
  parseUniversalV1ActorCommandPayload,
  UNIVERSAL_V1_ACTOR_ATTESTATION_BODY_LIMIT_BYTES,
} from '../../src/auth/universal-v1-actor-attestation-contracts.js';

const id = (n: number) => '50000000-0000-4000-8000-' + String(n).padStart(12, '0');
const proposed = () => ({
  work_order_id: id(1),
  expected_scope_version: 2,
  expected_amendment_version: 0,
  expected_latest_proposal_version: 0,
  observed_scope_summary: 'Additional debris requires a changed scope.',
  proposed_scope: {
    title: 'Extended cleanup',
    description: 'Remove the additional approved debris load.',
    requirements: null,
    checklist: ['Remove debris'],
  },
  change_order_kind: 'SCOPE_ONLY' as const,
  idempotency_key: 'change:proposal:00001',
  client_ts: new Date().toISOString(),
});
const decided = () => ({
  proposal_id: id(2),
  expected_proposal_version: 1,
  decision: 'APPROVED' as const,
  reason: 'Approve the exact updated scope.',
  idempotency_key: 'change:approval:00001',
  client_ts: new Date().toISOString(),
});
const proposalResult = () => ({
  proposal_id: id(2),
  proposal_version: 1,
  change_order_kind: 'SCOPE_ONLY',
  proposer_party: 'CUSTOMER',
  proposed_scope_sha256: 'a'.repeat(64),
  replayed: false,
  payment_creation_performed: false,
  hard_assignment_created: false,
});
const decisionResult = () => ({
  approval_id: id(3),
  proposal_id: id(2),
  proposal_version: 1,
  approver_party: 'CUSTOMER',
  decision: 'APPROVED',
  proposal_status: 'PENDING',
  replayed: false,
  payment_creation_performed: false,
  hard_assignment_created: false,
});
function fixture(
  kind: 'PROPOSE_FAKE_CHANGE_ORDER' | 'DECIDE_FAKE_CHANGE_ORDER' = 'PROPOSE_FAKE_CHANGE_ORDER'
) {
  const row = {
    result: kind === 'PROPOSE_FAKE_CHANGE_ORDER' ? proposalResult() : decisionResult(),
    actor_user_id: id(8),
    actor_assertion_id: id(9),
    actor_request_sha256: 'b'.repeat(64),
    target_authority_id: id(10),
    command_release_sha256: 'sha256:' + 'c'.repeat(64),
  };
  const issue = vi.fn().mockResolvedValue({
    schema_version: 1,
    command_kind: kind,
    canonical_request_sha256: 'b'.repeat(64),
    actor_assertion_token: 'd'.repeat(64),
    assertion_expires_at: new Date(Date.now() + 60000).toISOString(),
  });
  const query = vi.fn().mockResolvedValue({ rows: [row], rowCount: 1 });
  const transaction = vi.fn(async (callback: (query: QueryFn) => Promise<unknown>) =>
    callback(query as QueryFn)
  );
  const commands = new PostgresUniversalV1ChangeOrderCommands({ transaction } as never);
  return {
    row,
    issue,
    query,
    transaction,
    commands,
    run: () =>
      kind === 'PROPOSE_FAKE_CHANGE_ORDER'
        ? commands.propose(id(8), proposed(), { issue })
        : commands.decide(id(8), decided(), { issue }),
  };
}
describe('authenticated change-order proposal and decision commands', () => {
  it('attests the normalized scope and converts only the public timestamp', async () => {
    const f = fixture(),
      input = proposed();
    expect(await f.commands.propose(id(8), input, { issue: f.issue })).toEqual(proposalResult());
    const { client_ts, ...business } = input;
    const payload = { ...business, client_timestamp_epoch_ms: Date.parse(client_ts) };
    expect(f.issue).toHaveBeenCalledExactlyOnceWith({
      commandKind: 'PROPOSE_FAKE_CHANGE_ORDER',
      commandPayload: payload,
    });
    expect(f.query).toHaveBeenCalledExactlyOnceWith(
      'SELECT * FROM public.hxos_propose_authenticated_change_order_v13($1,$2)',
      ['d'.repeat(64), payload]
    );
    expect(Object.isFrozen(f.issue.mock.calls[0][0].commandPayload.proposed_scope.checklist)).toBe(
      true
    );
  });
  it('keeps an approved decision pending instead of granting materialization', async () => {
    const f = fixture('DECIDE_FAKE_CHANGE_ORDER');
    expect(await f.run()).toEqual(decisionResult());
    expect(f.query.mock.calls[0][0]).toBe(
      'SELECT * FROM public.hxos_decide_authenticated_change_order_v13($1,$2)'
    );
  });
  it('waits for COMMIT and does not retry an ambiguous commit', async () => {
    const f = fixture();
    let commit!: () => void;
    const barrier = new Promise<void>((resolve) => {
      commit = resolve;
    });
    f.transaction.mockImplementation(async (callback) => {
      const result = await callback(f.query as QueryFn);
      await barrier;
      return result;
    });
    let returned = false;
    const pending = f.run().then((result) => {
      returned = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(returned).toBe(false);
    commit();
    expect(await pending).toEqual(proposalResult());
    f.transaction.mockRejectedValueOnce(Error('COMMIT response lost'));
    await expect(f.run()).rejects.toMatchObject({ code: 'CHANGE_ORDER_MATERIALIZATION_FAILED' });
    expect(f.transaction).toHaveBeenCalledTimes(2);
    expect(f.query).toHaveBeenCalledTimes(1);
  });
  it.each(['actor', 'digest', 'version', 'kind', 'payment', 'assignment', 'extra'] as const)(
    'rolls back substituted proposal receipt: %s',
    async (field) => {
      const f = fixture();
      if (field === 'actor') f.row.actor_user_id = id(7);
      if (field === 'digest') f.row.actor_request_sha256 = 'e'.repeat(64);
      if (field === 'version') f.row.result.proposal_version = 3;
      if (field === 'kind') Object.assign(f.row.result, { change_order_kind: 'PRICE_AND_SCOPE' });
      if (field === 'payment') f.row.result.payment_creation_performed = true;
      if (field === 'assignment') f.row.result.hard_assignment_created = true;
      if (field === 'extra') Object.assign(f.row.result, { provider_secret: 'not permitted' });
      await expect(f.run()).rejects.toMatchObject({ code: 'CHANGE_ORDER_MATERIALIZATION_FAILED' });
    }
  );
  it.each(['kind', 'expiry', 'token'] as const)(
    'rejects invalid assertion before writing: %s',
    async (field) => {
      const f = fixture();
      const assertion = await f.issue();
      if (field === 'kind') assertion.command_kind = 'READ_FAKE_CHANGE_ORDER_HISTORY';
      if (field === 'expiry')
        assertion.assertion_expires_at = new Date(Date.now() - 1000).toISOString();
      if (field === 'token') assertion.actor_assertion_token = '0'.repeat(64);
      await expect(f.run()).rejects.toMatchObject({ code: 'CHANGE_ORDER_AUTHORITY_REVOKED' });
      expect(f.transaction).not.toHaveBeenCalled();
    }
  );
  it('rejects approval receipts that imply an unrequested decision or root', async () => {
    for (const alteration of [
      { proposal_id: id(4) },
      { decision: 'REJECTED' },
      { proposal_status: 'APPROVED' },
    ]) {
      const f = fixture('DECIDE_FAKE_CHANGE_ORDER');
      Object.assign(f.row.result, alteration);
      await expect(f.run()).rejects.toMatchObject({ code: 'CHANGE_ORDER_MATERIALIZATION_FAILED' });
    }
  });
  it('retains typed database conflict without exposing database details', async () => {
    const f = fixture();
    f.query.mockRejectedValueOnce(Error('CHANGE_ORDER_VERSION_CONFLICT: private SQL details'));
    await expect(f.run()).rejects.toMatchObject({
      code: 'CHANGE_ORDER_VERSION_CONFLICT',
      message: 'The change-order command was refused.',
    });
  });
  it('closes actor, schedule, caller hash, status and scope-only economics fields', () => {
    const { client_ts, ...business } = proposed();
    const payload = { ...business, client_timestamp_epoch_ms: Date.parse(client_ts) };
    expect(parseUniversalV1ActorCommandPayload('PROPOSE_FAKE_CHANGE_ORDER', payload)).toEqual(
      payload
    );
    for (const extra of [
      { actor_user_id: id(8) },
      { schedule_effect: 'tomorrow' },
      { request_sha256: 'a'.repeat(64) },
      { status: 'APPROVED' },
      { proposed_customer_total_cents: 100 },
    ])
      expect(ProposeChangeOrderPayloadSchema.safeParse({ ...payload, ...extra }).success).toBe(
        false
      );
    expect(
      ProposeChangeOrderPayloadSchema.safeParse({ ...payload, expected_scope_version: 2147483648 })
        .success
    ).toBe(false);
    const { client_ts: decisionTs, ...decision } = decided();
    expect(
      DecideChangeOrderPayloadSchema.safeParse({
        ...decision,
        client_timestamp_epoch_ms: Date.parse(decisionTs),
        approver_role: 'CUSTOMER',
      }).success
    ).toBe(false);
  });
  it('can attest the largest permitted textual proposal within the bounded transport', () => {
    const { client_ts, ...business } = proposed();
    const payload = {
      ...business,
      observed_scope_summary: 's'.repeat(1000),
      proposed_scope: {
        title: 't'.repeat(200),
        description: 'd'.repeat(5000),
        requirements: 'r'.repeat(5000),
        checklist: Array.from({ length: 50 }, () => 'x'.repeat(500)),
      },
      client_timestamp_epoch_ms: Date.parse(client_ts),
    };
    expect(ProposeChangeOrderPayloadSchema.safeParse(payload).success).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify({ canonical_request: { command_payload: payload } })) + 4096
    ).toBeLessThan(UNIVERSAL_V1_ACTOR_ATTESTATION_BODY_LIMIT_BYTES);
  });
});
