import { describe, expect, it, vi } from 'vitest';

import { UniversalV1ChangeOrderApplication } from '../../src/services/UniversalV1ChangeOrderApplication.js';
import type { UniversalV1ChangeOrderRepository } from '../../src/services/UniversalV1ChangeOrderPostgresRepository.js';

const ids = {
  actor: '10000000-0000-4000-8000-000000000001',
  workOrder: '10000000-0000-4000-8000-000000000002',
  proposal: '10000000-0000-4000-8000-000000000003',
  approval: '10000000-0000-4000-8000-000000000004',
  amendment: '10000000-0000-4000-8000-000000000005',
  scope: '10000000-0000-4000-8000-000000000006',
};
const nowMs = Date.parse('2026-08-27T12:00:00.000Z');
const currentTimestamp = new Date(nowMs).toISOString();

const proposal = {
  work_order_id: ids.workOrder,
  expected_scope_version: 1,
  expected_amendment_version: 0,
  expected_latest_proposal_version: 0,
  observed_scope_summary: 'The exact execution scope changed after inspection.',
  proposed_scope: {
    title: 'Install the approved replacement faucet',
    description: 'Remove the old faucet and install the approved replacement faucet.',
    requirements: null,
    checklist: ['Shut off water', 'Install replacement', 'Verify no leaks'],
  },
  change_order_kind: 'SCOPE_ONLY' as const,
  idempotency_key: 'change-order:proposal:0001',
  client_ts: currentTimestamp,
};
const decision = {
  proposal_id: ids.proposal,
  expected_proposal_version: 1,
  decision: 'APPROVED' as const,
  reason: 'The exact replacement scope is accepted.',
  idempotency_key: 'change-order:decision:0001',
  client_ts: currentTimestamp,
};
const finalization = {
  proposal_id: ids.proposal,
  expected_proposal_version: 1,
  expected_scope_version: 1,
  expected_amendment_version: 0,
  expected_execution_version: 1,
  expected_financial_version: 2,
  idempotency_key: 'change-order:finalize:0001',
  client_ts: currentTimestamp,
};

function repositoryFixture() {
  return {
    proposeChangeOrder: vi.fn().mockResolvedValue({
      proposal_id: ids.proposal,
      proposal_version: 1,
      change_order_kind: 'SCOPE_ONLY',
      proposer_party: 'CUSTOMER',
      proposed_scope_sha256: 'a'.repeat(64),
      replayed: false,
      payment_creation_performed: false,
      hard_assignment_created: false,
    }),
    decideChangeOrder: vi.fn().mockResolvedValue({
      approval_id: ids.approval,
      proposal_id: ids.proposal,
      proposal_version: 1,
      approver_party: 'CUSTOMER',
      decision: 'APPROVED',
      proposal_status: 'PENDING',
      replayed: false,
      payment_creation_performed: false,
      hard_assignment_created: false,
    }),
    readFinalizationKind: vi.fn().mockResolvedValue('SCOPE_ONLY'),
    authorizeAndMaterializeFakeChangeOrder: vi.fn().mockResolvedValue({
      amendment_id: ids.amendment,
      amendment_version: 1,
      proposal_id: ids.proposal,
      scope_version_id: ids.scope,
      scope_version: 2,
      adjustment_event_id: null,
      provider_kind: null,
      replayed: false,
      payment_creation_performed: false,
      hard_assignment_created: false,
    }),
  } as unknown as UniversalV1ChangeOrderRepository;
}

describe('UniversalV1ChangeOrderApplication', () => {
  it.each([
    ['propose', new Date(nowMs - 5 * 60_000 - 1).toISOString()],
    ['decide', new Date(nowMs + 5 * 60_000 + 1).toISOString()],
    ['finalize', new Date(nowMs - 5 * 60_000 - 1).toISOString()],
  ] as const)(
    'rejects a stale %s request before repository or finance access',
    async (kind, ts) => {
      const repository = repositoryFixture();
      const authorizeFinance = vi.fn();
      const application = new UniversalV1ChangeOrderApplication(
        repository,
        authorizeFinance,
        () => nowMs
      );
      const invocation =
        kind === 'propose'
          ? application.proposeChangeOrder(ids.actor, { ...proposal, client_ts: ts })
          : kind === 'decide'
            ? application.decideChangeOrder(ids.actor, { ...decision, client_ts: ts })
            : application.authorizeAndMaterializeFakeChangeOrder(ids.actor, {
                ...finalization,
                client_ts: ts,
              });
      await expect(invocation).rejects.toMatchObject({ code: 'CHANGE_ORDER_REQUEST_STALE' });
      expect(repository.proposeChangeOrder).not.toHaveBeenCalled();
      expect(repository.decideChangeOrder).not.toHaveBeenCalled();
      expect(repository.readFinalizationKind).not.toHaveBeenCalled();
      expect(repository.authorizeAndMaterializeFakeChangeOrder).not.toHaveBeenCalled();
      expect(authorizeFinance).not.toHaveBeenCalled();
    }
  );

  it('injects the authenticated actor and delegates normalized proposal and decision commands', async () => {
    const repository = repositoryFixture();
    const application = new UniversalV1ChangeOrderApplication(repository, vi.fn(), () => nowMs);
    await application.proposeChangeOrder(ids.actor, {
      ...proposal,
      observed_scope_summary: '  The exact execution scope changed after inspection.  ',
    });
    await application.decideChangeOrder(ids.actor, decision);
    expect(repository.proposeChangeOrder).toHaveBeenCalledWith(
      ids.actor,
      expect.objectContaining({
        observed_scope_summary: 'The exact execution scope changed after inspection.',
      })
    );
    expect(repository.decideChangeOrder).toHaveBeenCalledWith(ids.actor, decision);
  });

  it('materializes scope-only without authorizing or passing a finance factory', async () => {
    const repository = repositoryFixture();
    const authorizeFinance = vi.fn();
    const application = new UniversalV1ChangeOrderApplication(
      repository,
      authorizeFinance,
      () => nowMs
    );
    const result = await application.authorizeAndMaterializeFakeChangeOrder(
      ids.actor,
      finalization
    );
    expect(repository.readFinalizationKind).toHaveBeenCalledWith(ids.actor, ids.proposal);
    expect(authorizeFinance).not.toHaveBeenCalled();
    expect(repository.authorizeAndMaterializeFakeChangeOrder).toHaveBeenCalledWith(
      ids.actor,
      finalization,
      undefined
    );
    expect(result).toMatchObject({
      payment_creation_performed: false,
      hard_assignment_created: false,
    });
  });

  it('authorizes fake finance exactly once before delegating a price amendment', async () => {
    const repository = repositoryFixture();
    vi.mocked(repository.readFinalizationKind).mockResolvedValue('PRICE_AND_SCOPE');
    const financeFactory = vi.fn();
    const authorizeFinance = vi.fn().mockReturnValue(financeFactory);
    const application = new UniversalV1ChangeOrderApplication(
      repository,
      authorizeFinance,
      () => nowMs
    );
    await application.authorizeAndMaterializeFakeChangeOrder(ids.actor, finalization);
    expect(authorizeFinance).toHaveBeenCalledOnce();
    expect(repository.authorizeAndMaterializeFakeChangeOrder).toHaveBeenCalledWith(
      ids.actor,
      finalization,
      financeFactory
    );
  });

  it('fails closed when a stored schedule-only variant reaches the boundary', async () => {
    const repository = repositoryFixture();
    vi.mocked(repository.readFinalizationKind).mockResolvedValue('SCHEDULE_AND_SCOPE');
    const authorizeFinance = vi.fn();
    const application = new UniversalV1ChangeOrderApplication(
      repository,
      authorizeFinance,
      () => nowMs
    );
    await expect(
      application.authorizeAndMaterializeFakeChangeOrder(ids.actor, finalization)
    ).rejects.toMatchObject({ code: 'CHANGE_ORDER_SCHEDULE_UNSUPPORTED' });
    expect(authorizeFinance).not.toHaveBeenCalled();
    expect(repository.authorizeAndMaterializeFakeChangeOrder).not.toHaveBeenCalled();
  });
});
