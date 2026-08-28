import { describe, expect, it } from 'vitest';

import {
  AuthorizeAndMaterializeUniversalV1ChangeOrderPublicSchema,
  DecideUniversalV1ChangeOrderPublicSchema,
  ProposeUniversalV1ChangeOrderPublicSchema,
  universalV1ChangeOrderCommandHash,
} from '../../src/services/UniversalV1ChangeOrderContracts.js';

const workOrderId = '10000000-0000-4000-8000-000000000001';
const proposalId = '10000000-0000-4000-8000-000000000002';
const now = '2026-08-27T12:00:00.000Z';
const scope = {
  title: 'Install a replacement kitchen faucet',
  description: 'Remove the existing faucet and install the approved replacement.',
  requirements: null,
  checklist: ['Shut off water', 'Install faucet', 'Verify no leaks'],
};

const proposalBase = {
  work_order_id: workOrderId,
  expected_scope_version: 1,
  expected_amendment_version: 0,
  expected_latest_proposal_version: 0,
  observed_scope_summary: 'The customer selected a different faucet after inspection.',
  proposed_scope: scope,
  idempotency_key: 'change-order:proposal:0001',
  client_ts: now,
};

describe('Universal V1 change-order public contracts', () => {
  it('accepts only scope-only or price-and-scope proposals', () => {
    expect(
      ProposeUniversalV1ChangeOrderPublicSchema.parse({
        ...proposalBase,
        change_order_kind: 'SCOPE_ONLY',
      })
    ).toMatchObject({ change_order_kind: 'SCOPE_ONLY' });
    expect(
      ProposeUniversalV1ChangeOrderPublicSchema.parse({
        ...proposalBase,
        change_order_kind: 'PRICE_AND_SCOPE',
        proposed_customer_total_cents: 18_000,
        proposed_provider_payout_cents: 14_000,
      })
    ).toMatchObject({ change_order_kind: 'PRICE_AND_SCOPE' });
    expect(
      ProposeUniversalV1ChangeOrderPublicSchema.safeParse({
        ...proposalBase,
        change_order_kind: 'SCHEDULE_AND_SCOPE',
        schedule_effect: 'Move the job to Friday.',
      }).success
    ).toBe(false);
  });

  it('keeps money out of scope-only and requires bounded price economics', () => {
    expect(
      ProposeUniversalV1ChangeOrderPublicSchema.safeParse({
        ...proposalBase,
        change_order_kind: 'SCOPE_ONLY',
        proposed_customer_total_cents: 18_000,
        proposed_provider_payout_cents: 14_000,
      }).success
    ).toBe(false);
    expect(
      ProposeUniversalV1ChangeOrderPublicSchema.safeParse({
        ...proposalBase,
        change_order_kind: 'PRICE_AND_SCOPE',
        proposed_customer_total_cents: 10_000,
        proposed_provider_payout_cents: 11_000,
      }).success
    ).toBe(false);
  });

  it('rejects client-selected authority and generated lifecycle bindings', () => {
    expect(
      ProposeUniversalV1ChangeOrderPublicSchema.safeParse({
        ...proposalBase,
        change_order_kind: 'SCOPE_ONLY',
        proposed_by: proposalId,
      }).success
    ).toBe(false);
    expect(
      DecideUniversalV1ChangeOrderPublicSchema.safeParse({
        proposal_id: proposalId,
        expected_proposal_version: 1,
        decision: 'APPROVED',
        reason: 'The exact replacement scope is accepted.',
        idempotency_key: 'change-order:decision:0001',
        client_ts: now,
        approver_role: 'CUSTOMER',
      }).success
    ).toBe(false);
    expect(
      AuthorizeAndMaterializeUniversalV1ChangeOrderPublicSchema.safeParse({
        proposal_id: proposalId,
        expected_proposal_version: 1,
        expected_scope_version: 1,
        expected_amendment_version: 0,
        expected_execution_version: 1,
        expected_financial_version: 2,
        idempotency_key: 'change-order:finalize:0001',
        client_ts: now,
        adjustment_event_id: proposalId,
      }).success
    ).toBe(false);
  });

  it('normalizes wire strings before they become command facts', () => {
    const parsed = ProposeUniversalV1ChangeOrderPublicSchema.parse({
      ...proposalBase,
      observed_scope_summary: '  Customer approved a different fixture.  ',
      proposed_scope: {
        ...scope,
        title: '  Install the approved replacement faucet  ',
        checklist: ['  Shut off water  ', 'Install faucet', 'Verify no leaks'],
      },
      change_order_kind: 'SCOPE_ONLY',
    });
    expect(parsed.observed_scope_summary).toBe('Customer approved a different fixture.');
    expect(parsed.proposed_scope.title).toBe('Install the approved replacement faucet');
    expect(parsed.proposed_scope.checklist[0]).toBe('Shut off water');
  });

  it('hashes nested facts recursively and independently of object key order', () => {
    const left = {
      proposal: { version: 2, scope: { checklist: ['a', 'b'], title: 'x' } },
      decision: 'APPROVED',
    };
    const right = {
      decision: 'APPROVED',
      proposal: { scope: { title: 'x', checklist: ['a', 'b'] }, version: 2 },
    };
    expect(universalV1ChangeOrderCommandHash(left)).toBe(universalV1ChangeOrderCommandHash(right));
    expect(universalV1ChangeOrderCommandHash(left)).not.toBe(
      universalV1ChangeOrderCommandHash({
        ...left,
        proposal: { ...left.proposal, scope: { ...left.proposal.scope, checklist: ['a', 'c'] } },
      })
    );
  });
});
