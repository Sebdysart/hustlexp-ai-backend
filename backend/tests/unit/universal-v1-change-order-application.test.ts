import { describe, expect, it, vi } from 'vitest';
import { UniversalV1ChangeOrderApplication } from '../../src/services/UniversalV1ChangeOrderApplication.js';

const id = (n: number) => '10000000-0000-4000-8000-' + String(n).padStart(12, '0');
const now = Date.parse('2026-08-27T12:00:00.000Z'),
  current = new Date(now).toISOString();
const proposal = {
  work_order_id: id(2),
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
  client_ts: current,
};
const decision = {
  proposal_id: id(3),
  expected_proposal_version: 1,
  decision: 'APPROVED' as const,
  reason: 'The exact replacement scope is accepted.',
  idempotency_key: 'change-order:decision:0001',
  client_ts: current,
};
const input = {
  proposal_id: id(3),
  expected_proposal_version: 1,
  expected_scope_version: 1,
  expected_amendment_version: 0,
  expected_execution_version: 1,
  expected_financial_version: 2,
  idempotency_key: 'change-order:finalize:0001',
  client_ts: current,
};
function fixture() {
  const result = {
    amendment_id: id(5),
    amendment_version: 1,
    proposal_id: id(3),
    scope_version_id: id(6),
    scope_version: 2,
    adjustment_event_id: null,
    provider_kind: null,
    replayed: false,
    payment_creation_performed: false as const,
    hard_assignment_created: false as const,
  };
  const materialization = {
    readKind: vi.fn().mockResolvedValue('SCOPE_ONLY'),
    prepare: vi.fn().mockResolvedValue({ completed: true, result }),
    finalize: vi.fn(),
  };
  const commands = { propose: vi.fn(), decide: vi.fn() },
    finance = { requestFinancialEvent: vi.fn() },
    authorizeFinance = vi.fn().mockResolvedValue(finance),
    history = { read: vi.fn() },
    attestation = { issue: vi.fn() };
  const app = new UniversalV1ChangeOrderApplication(
    materialization,
    authorizeFinance,
    () => now,
    commands,
    history
  );
  return {
    app,
    result,
    materialization,
    commands,
    finance,
    authorizeFinance,
    history,
    attestation,
  };
}
describe('UniversalV1ChangeOrderApplication', () => {
  it.each(['propose', 'decide', 'finalize'] as const)(
    'rejects stale %s before authority or finance access',
    async (kind) => {
      const f = fixture(),
        ts = new Date(now - 300_001).toISOString();
      const call =
        kind === 'propose'
          ? f.app.proposeChangeOrder(id(1), { ...proposal, client_ts: ts }, f.attestation)
          : kind === 'decide'
            ? f.app.decideChangeOrder(id(1), { ...decision, client_ts: ts }, f.attestation)
            : f.app.authorizeAndMaterializeFakeChangeOrder(
                id(1),
                { ...input, client_ts: ts },
                f.attestation
              );
      await expect(call).rejects.toMatchObject({ code: 'CHANGE_ORDER_REQUEST_STALE' });
      expect(f.commands.propose).not.toHaveBeenCalled();
      expect(f.commands.decide).not.toHaveBeenCalled();
      expect(f.materialization.readKind).not.toHaveBeenCalled();
      expect(f.materialization.prepare).not.toHaveBeenCalled();
      expect(f.authorizeFinance).not.toHaveBeenCalled();
      expect(f.history.read).not.toHaveBeenCalled();
    }
  );
  it.each(['propose', 'decide', 'finalize'] as const)(
    'requires a request-scoped attestation for %s',
    async (kind) => {
      const f = fixture();
      const call =
        kind === 'propose'
          ? f.app.proposeChangeOrder(id(1), proposal)
          : kind === 'decide'
            ? f.app.decideChangeOrder(id(1), decision)
            : f.app.authorizeAndMaterializeFakeChangeOrder(id(1), input);
      await expect(call).rejects.toMatchObject({ code: 'CHANGE_ORDER_AUTHORITY_REVOKED' });
      expect(f.commands.propose).not.toHaveBeenCalled();
      expect(f.commands.decide).not.toHaveBeenCalled();
      expect(f.materialization.readKind).not.toHaveBeenCalled();
      expect(f.authorizeFinance).not.toHaveBeenCalled();
    }
  );
  it('propagates authenticated actor, normalized proposal and independent decision', async () => {
    const f = fixture();
    await f.app.proposeChangeOrder(
      id(1),
      { ...proposal, observed_scope_summary: '  ' + proposal.observed_scope_summary + '  ' },
      f.attestation
    );
    await f.app.decideChangeOrder(id(1), decision, f.attestation);
    expect(f.commands.propose).toHaveBeenCalledExactlyOnceWith(id(1), proposal, f.attestation);
    expect(f.commands.decide).toHaveBeenCalledExactlyOnceWith(id(1), decision, f.attestation);
  });
  it('materializes scope-only without creating finance or reading price history', async () => {
    const f = fixture();
    expect(await f.app.authorizeAndMaterializeFakeChangeOrder(id(1), input, f.attestation)).toEqual(
      { status: 'MATERIALIZED', ...f.result }
    );
    expect(f.materialization.readKind).toHaveBeenCalledExactlyOnceWith(id(1), id(3), f.attestation);
    expect(f.materialization.prepare).toHaveBeenCalledExactlyOnceWith(id(1), input, f.attestation);
    expect(f.authorizeFinance).not.toHaveBeenCalled();
    expect(f.history.read).not.toHaveBeenCalled();
    expect(f.finance.requestFinancialEvent).not.toHaveBeenCalled();
  });
  it.each([{ completed: false }, { completed: true, result: { adjustment_event_id: id(9) } }])(
    'refuses an incompatible scope-only receipt',
    async (phase) => {
      const f = fixture();
      f.materialization.prepare.mockResolvedValue(phase);
      await expect(
        f.app.authorizeAndMaterializeFakeChangeOrder(id(1), input, f.attestation)
      ).rejects.toMatchObject({ code: 'CHANGE_ORDER_STATE_CONFLICT' });
      expect(f.authorizeFinance).not.toHaveBeenCalled();
    }
  );
  it('refuses an unavailable kind without preparing or authorizing finance', async () => {
    const f = fixture();
    f.materialization.readKind.mockResolvedValue(null);
    await expect(
      f.app.authorizeAndMaterializeFakeChangeOrder(id(1), input, f.attestation)
    ).rejects.toMatchObject({ code: 'CHANGE_ORDER_CONTEXT_UNAVAILABLE' });
    expect(f.materialization.prepare).not.toHaveBeenCalled();
    expect(f.authorizeFinance).not.toHaveBeenCalled();
  });
  it('fails closed on a stored unsupported schedule variant', async () => {
    const f = fixture();
    f.materialization.readKind.mockResolvedValue('SCHEDULE_AND_SCOPE');
    await expect(
      f.app.authorizeAndMaterializeFakeChangeOrder(id(1), input, f.attestation)
    ).rejects.toMatchObject({ code: 'CHANGE_ORDER_SCHEDULE_UNSUPPORTED' });
    expect(f.materialization.prepare).not.toHaveBeenCalled();
    expect(f.authorizeFinance).not.toHaveBeenCalled();
  });
  it('checks the exact fake capability before price preparation or history access', async () => {
    const f = fixture();
    f.materialization.readKind.mockResolvedValue('PRICE_AND_SCOPE');
    f.authorizeFinance.mockRejectedValue(Error('NONPRODUCTION_FAKE_FINANCE_REFUSED'));
    await expect(
      f.app.authorizeAndMaterializeFakeChangeOrder(id(1), input, f.attestation)
    ).rejects.toThrow('NONPRODUCTION_FAKE_FINANCE_REFUSED');
    expect(f.materialization.prepare).not.toHaveBeenCalled();
    expect(f.history.read).not.toHaveBeenCalled();
    expect(f.finance.requestFinancialEvent).not.toHaveBeenCalled();
  });
});
